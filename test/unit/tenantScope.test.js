"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  compileTenantSql,
  createTenantScope,
  TenantScopeError,
} = require("../../src/data/tenantScope");
const { FakeExecutor, TenantAwareStore } = require("../helpers/fakeDb");

/**
 * The headline guarantee: a query cannot be written without a tenant predicate,
 * and the tenant value cannot come from the caller.
 */

test("compileTenantSql refuses SQL with no tenant predicate", () => {
  assert.throws(
    () => compileTenantSql("SELECT * FROM bookings WHERE id = ?", [1], 7),
    (error) => error instanceof TenantScopeError && /tenant predicate/i.test(error.message)
  );
});

test("compileTenantSql replaces :tenant with a bound parameter in the right position", () => {
  const compiled = compileTenantSql(
    "SELECT * FROM bookings WHERE id = ? AND tenant_id = :tenant AND status = ?",
    [42, "pending"],
    7
  );
  assert.equal(compiled.sql, "SELECT * FROM bookings WHERE id = ? AND tenant_id = ? AND status = ?");
  assert.deepEqual(compiled.params, [42, 7, "pending"]);
  assert.equal(compiled.tenantRefs, 1);
});

test("compileTenantSql supports several :tenant references (joins)", () => {
  const compiled = compileTenantSql(
    `SELECT b.id FROM bookings b
       JOIN facilities f ON f.id = b.facility_id AND f.tenant_id = :tenant
      WHERE b.tenant_id = :tenant AND b.status = ?`,
    ["pending"],
    3
  );
  assert.equal(compiled.tenantRefs, 2);
  assert.deepEqual(compiled.params, [3, 3, "pending"]);
  assert.equal(compiled.sql.includes(":tenant"), false);
});

test("compileTenantSql ignores ? and :tenant inside string literals", () => {
  const compiled = compileTenantSql(
    "SELECT 'is it ? or :tenant' AS note FROM bookings WHERE tenant_id = :tenant",
    [],
    9
  );
  assert.equal(compiled.params.length, 1);
  assert.equal(compiled.params[0], 9);
  assert.ok(compiled.sql.includes("'is it ? or :tenant'"));
});

test("compileTenantSql rejects a placeholder/parameter count mismatch", () => {
  assert.throws(
    () => compileTenantSql("SELECT * FROM t WHERE tenant_id = :tenant AND a = ? AND b = ?", [1], 1),
    TenantScopeError
  );
  assert.throws(
    () => compileTenantSql("SELECT * FROM t WHERE tenant_id = :tenant AND a = ?", [1, 2], 1),
    TenantScopeError
  );
});

test("a tenant scope cannot be built from a non-positive or non-integer tenant id", () => {
  const executor = new FakeExecutor();
  for (const bad of [0, -1, "1", 1.5, null, undefined, {}]) {
    assert.throws(() => createTenantScope(bad, executor), TenantScopeError, `accepted ${String(bad)}`);
  }
  assert.doesNotThrow(() => createTenantScope(1, executor));
});

test("scope.select injects the scope's tenant id, not anything the caller passes", async () => {
  const executor = new FakeExecutor([[{ id: 1 }]]);
  const scope = createTenantScope(11, executor);

  // The caller tries to smuggle a different tenant in as a parameter.
  await scope.select("SELECT * FROM bookings WHERE tenant_id = :tenant AND member_id = ?", [99]);

  assert.deepEqual(executor.lastCall.params, [11, 99]);
  assert.ok(!executor.lastCall.sql.includes(":tenant"));
});

test("scope.insert sets tenant_id itself", async () => {
  const executor = new FakeExecutor([{ insertId: 5, affectedRows: 1 }]);
  const scope = createTenantScope(4, executor);

  const result = await scope.insert("bookings", { member_id: 2, status: "pending" });

  assert.equal(result.insertId, 5);
  assert.match(executor.lastCall.sql, /INSERT INTO `bookings` \(`tenant_id`, `member_id`, `status`\)/);
  assert.deepEqual(executor.lastCall.params, [4, 2, "pending"]);
});

test("scope.insert refuses a caller-supplied tenant_id", async () => {
  const scope = createTenantScope(4, new FakeExecutor());
  await assert.rejects(
    () => scope.insert("bookings", { tenant_id: 9, member_id: 2 }),
    (error) => error instanceof TenantScopeError && /must not be passed/i.test(error.message)
  );
});

test("scope.insert refuses unsafe table and column names", async () => {
  const scope = createTenantScope(4, new FakeExecutor());
  await assert.rejects(() => scope.insert("bookings; DROP TABLE users", { a: 1 }), TenantScopeError);
  await assert.rejects(() => scope.insert("bookings", { "a` = 1, `b": 1 }), TenantScopeError);
});

test("scope.execute also requires the tenant marker", async () => {
  const scope = createTenantScope(4, new FakeExecutor([{ affectedRows: 1 }]));
  await assert.rejects(
    () => scope.execute("UPDATE bookings SET status = 'confirmed' WHERE id = ?", [1]),
    TenantScopeError
  );
});

test("scope.transaction hands the callback a scope bound to the same tenant", async () => {
  const executor = new FakeExecutor([{ affectedRows: 1 }, { affectedRows: 1 }]);
  const scope = createTenantScope(6, executor);

  await scope.transaction(async (tx) => {
    assert.equal(tx.tenantId, 6);
    await tx.execute("UPDATE bookings SET status = 'confirmed' WHERE id = ? AND tenant_id = :tenant", [1]);
  });

  const statements = executor.calls.map((c) => c.sql);
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements[statements.length - 1], "COMMIT");
  assert.equal(executor.released, 1);
});

test("scope.transaction rolls back and releases on failure", async () => {
  const executor = new FakeExecutor();
  const scope = createTenantScope(6, executor);

  await assert.rejects(
    () =>
      scope.transaction(async () => {
        throw new Error("boom");
      }),
    /boom/
  );

  assert.ok(executor.calls.some((c) => c.sql === "ROLLBACK"));
  assert.ok(!executor.calls.some((c) => c.sql === "COMMIT"));
  assert.equal(executor.released, 1);
});

/* ---------------------------------------------------------------------------
 * Cross-tenant isolation, against a store that actually filters.
 * ------------------------------------------------------------------------ */

test("a scope for tenant A cannot read tenant B's rows", async () => {
  const store = new TenantAwareStore({
    invoices: [
      { id: 1, tenant_id: 1, member_id: 1, description: "Northgate dues" },
      { id: 2, tenant_id: 2, member_id: 3, description: "Riverside dues" },
    ],
  });

  const northgate = createTenantScope(1, store);
  const riverside = createTenantScope(2, store);

  const sql = "SELECT id, description FROM invoices WHERE id = ? AND tenant_id = :tenant";

  const own = await northgate.selectOne(sql, [1]);
  assert.equal(own.description, "Northgate dues");

  // The same id, asked for by the other tenant's scope.
  const foreign = await northgate.selectOne(sql, [2]);
  assert.equal(foreign, null, "tenant 1 must not see tenant 2's invoice");

  const theirs = await riverside.selectOne(sql, [2]);
  assert.equal(theirs.description, "Riverside dues");

  const crossed = await riverside.selectOne(sql, [1]);
  assert.equal(crossed, null, "tenant 2 must not see tenant 1's invoice");
});

test("listing through a scope returns only that tenant's rows", async () => {
  const store = new TenantAwareStore({
    bookings: [
      { id: 1, tenant_id: 1, status: "pending", notes: "Northgate" },
      { id: 2, tenant_id: 2, status: "pending", notes: "Riverside" },
      { id: 3, tenant_id: 1, status: "pending", notes: "Northgate" },
    ],
  });

  const rows = await createTenantScope(1, store).select(
    "SELECT id, notes FROM bookings WHERE status = ? AND tenant_id = :tenant",
    ["pending"]
  );

  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.notes === "Northgate"));
});
