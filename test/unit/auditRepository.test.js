"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAuditRepository, ACTIONS, ENTITIES } = require("../../src/repositories/auditRepository");
const { createTenantScope } = require("../../src/data/tenantScope");
const { FakeExecutor, TenantAwareStore } = require("../helpers/fakeDb");

test("an audit row is written through the tenant scope, with the tenant bound by the scope", async () => {
  const executor = new FakeExecutor([{ insertId: 11, affectedRows: 1 }]);
  const audit = createAuditRepository(createTenantScope(4, executor));

  const id = await audit.record({
    actorType: "staff",
    actorId: 2,
    action: ACTIONS.BOOKING_APPROVED,
    entity: ENTITIES.BOOKING,
    entityId: 77,
    metadata: { before: { status: "pending" }, after: { status: "confirmed" } },
    ip: "203.0.113.9",
    userAgent: "curl/8",
  });

  assert.equal(id, 11);
  assert.match(executor.lastCall.sql, /INSERT INTO `audit_logs`/);
  // tenant_id is the first bound parameter and comes from the scope.
  assert.equal(executor.lastCall.params[0], 4);
  assert.ok(executor.lastCall.params.includes("booking.approved"));
  const metadata = executor.lastCall.params.find(
    (p) => typeof p === "string" && p.startsWith("{")
  );
  assert.deepEqual(JSON.parse(metadata).after, { status: "confirmed" });
});

test("a credential-shaped key is refused rather than written into the trail", async () => {
  const audit = createAuditRepository(createTenantScope(1, new FakeExecutor()));

  for (const key of ["password", "new_password", "token", "password_hash", "api_secret"]) {
    await assert.rejects(
      () =>
        audit.record({
          actorType: "staff",
          actorId: 1,
          action: ACTIONS.BOOKING_APPROVED,
          entity: ENTITIES.BOOKING,
          entityId: 1,
          metadata: { [key]: "leaked" },
        }),
      /Refusing to write/,
      `metadata key "${key}" should be refused`
    );
  }
});

test("ordinary before/after metadata is accepted", async () => {
  const executor = new FakeExecutor([{ insertId: 1, affectedRows: 1 }]);
  const audit = createAuditRepository(createTenantScope(1, executor));

  await assert.doesNotReject(() =>
    audit.record({
      actorType: "staff",
      actorId: 1,
      action: ACTIONS.PROFILE_CHANGE_APPROVED,
      entity: ENTITIES.PROFILE_CHANGE_REQUEST,
      entityId: 3,
      metadata: { before: { email: "a@example.com" }, after: { email: "b@example.com" } },
    })
  );
});

test("the repository exposes no way to change or delete a row", () => {
  const audit = createAuditRepository(createTenantScope(1, new FakeExecutor()));
  const methods = Object.keys(audit).filter((k) => typeof audit[k] === "function");
  assert.deepEqual(methods.sort(), ["list", "listForEntity", "record"]);
  for (const forbidden of ["update", "delete", "remove", "purge"]) {
    assert.equal(audit[forbidden], undefined);
  }
});

test("listing is tenant-scoped", async () => {
  const executor = new FakeExecutor([[]]);
  const audit = createAuditRepository(createTenantScope(9, executor));

  await audit.list({ entity: ENTITIES.BOOKING, limit: 25, offset: 50 });

  assert.ok(!executor.lastCall.sql.includes(":tenant"));
  assert.ok(executor.lastCall.params.includes(9));
  assert.ok(executor.lastCall.params.includes("booking"));
  assert.deepEqual(executor.lastCall.params.slice(-2), [25, 50]);
});

test("one tenant cannot read another tenant's audit trail", async () => {
  const store = new TenantAwareStore({
    audit_logs: [
      { id: 1, tenant_id: 1, entity: "booking", action: "booking.approved", metadata: null },
      { id: 2, tenant_id: 2, entity: "booking", action: "booking.approved", metadata: null },
    ],
  });

  const northgate = createTenantScope(1, store);
  const rows = await northgate.select(
    "SELECT id, entity FROM audit_logs WHERE entity = ? AND tenant_id = :tenant",
    ["booking"]
  );
  assert.deepEqual(rows.map((r) => r.id), [1]);
});

test("metadata is parsed back out of the JSON column", async () => {
  const executor = new FakeExecutor([
    [{ id: 1, action: "booking.approved", metadata: '{"before":{"status":"pending"}}' }],
  ]);
  const audit = createAuditRepository(createTenantScope(1, executor));

  const [row] = await audit.list({});
  assert.deepEqual(row.metadata, { before: { status: "pending" } });
});

test("unparseable metadata degrades to null rather than throwing", async () => {
  const executor = new FakeExecutor([[{ id: 1, action: "x", metadata: "{broken" }]]);
  const audit = createAuditRepository(createTenantScope(1, executor));

  const [row] = await audit.list({});
  assert.equal(row.metadata, null);
});

test("the action and entity vocabularies are fixed and namespaced", () => {
  for (const action of Object.values(ACTIONS)) {
    assert.match(action, /^[a-z_]+\.[a-z_]+$/, `action "${action}" is not namespaced`);
  }
  for (const entity of Object.values(ENTITIES)) {
    assert.match(entity, /^[a-z_]+$/);
  }
  assert.equal(new Set(Object.values(ACTIONS)).size, Object.values(ACTIONS).length);
});
