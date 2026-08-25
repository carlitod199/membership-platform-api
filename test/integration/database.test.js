"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * Integration tests — these need a live MySQL loaded with database/schema.sql
 * and database/seed_demo.sql.
 *
 * They are SKIPPED unless RUN_DB_TESTS=1 is set, so `npm test` passes on a
 * clean clone with no database. That is a deliberate trade: the rules that
 * matter most (tenant scoping, token handling, workflow transitions) are proved
 * by the unit tests against the real production modules, and what remains here
 * is what only a real database can answer — that the schema matches the SQL the
 * repositories emit.
 *
 *   mysql -u root -p -e "CREATE DATABASE membership_platform_test"
 *   mysql -u root -p membership_platform_test < database/schema.sql
 *   mysql -u root -p membership_platform_test < database/seed_demo.sql
 *   RUN_DB_TESTS=1 DB_NAME=membership_platform_test npm test
 */

const ENABLED = process.env.RUN_DB_TESTS === "1";
const skip = ENABLED ? false : "set RUN_DB_TESTS=1 and point DB_* at a seeded database";

test("tenant isolation holds against a real database", { skip }, async (t) => {
  const { createTenantScope } = require("../../src/data/tenantScope");
  const { poolExecutor, closePool } = require("../../src/config/db");
  t.after(() => closePool());

  const northgate = createTenantScope(1, poolExecutor());
  const riverside = createTenantScope(2, poolExecutor());

  const sql = "SELECT id, notes FROM bookings WHERE id = ? AND tenant_id = :tenant";

  // Seeded: booking 1 belongs to Northgate, booking 3 to Riverside.
  const own = await northgate.selectOne(sql, [1]);
  assert.match(own.notes, /Northgate/);

  const foreign = await northgate.selectOne(sql, [3]);
  assert.equal(foreign, null, "tenant 1 must not read tenant 2's booking");

  const theirs = await riverside.selectOne(sql, [3]);
  assert.match(theirs.notes, /Riverside/);
});

test("no tenant-owned row leaks into a listing", { skip }, async (t) => {
  const { createTenantScope } = require("../../src/data/tenantScope");
  const { poolExecutor, closePool } = require("../../src/config/db");
  t.after(() => closePool());

  const scope = createTenantScope(1, poolExecutor());
  for (const table of ["members", "bookings", "invoices", "guest_passes", "notifications"]) {
    const rows = await scope.select(
      `SELECT tenant_id FROM \`${table}\` WHERE tenant_id = :tenant LIMIT 500`
    );
    assert.ok(rows.length > 0, `${table} has no seeded rows for tenant 1`);
    assert.ok(rows.every((r) => Number(r.tenant_id) === 1), `${table} leaked another tenant`);
  }
});

test("the demo credentials in the seed verify against bcrypt", { skip }, async (t) => {
  const { unscopedQueryOne, UNSCOPED_PURPOSES } = require("../../src/data/global");
  const { verifyPassword } = require("../../src/lib/passwords");
  const { closePool } = require("../../src/config/db");
  t.after(() => closePool());

  const credential = await unscopedQueryOne(
    UNSCOPED_PURPOSES.RESOLVE_MEMBER_LOGIN,
    "SELECT password_hash FROM member_credentials WHERE login_email = ?",
    ["john.smith@example.com"]
  );
  assert.ok(credential, "seed not loaded");
  assert.equal(await verifyPassword("DemoMember2026!", credential.password_hash), true);
});

test("every repository statement the schema must satisfy actually parses", { skip }, async (t) => {
  // Runs one representative query per repository against the real schema, which
  // is the check the in-memory doubles cannot make: column names, join keys and
  // the LIMIT ? OFFSET ? prepared-statement form.
  const { createTenantScope } = require("../../src/data/tenantScope");
  const { poolExecutor, closePool } = require("../../src/config/db");
  const { createRepositories } = require("../../src/repositories");
  t.after(() => closePool());

  const repositories = createRepositories(createTenantScope(1, poolExecutor()));

  await repositories.bookings.listByStatus("pending", { limit: 10, offset: 0 });
  await repositories.bookings.listForMember(1, { limit: 10, offset: 0 });
  await repositories.bookings.findOverlapping({
    facilityId: 1,
    bookingDate: "2026-09-20",
    startsAt: "18:00:00",
    endsAt: "19:00:00",
    statuses: ["pending", "confirmed"],
  });
  await repositories.facilities.list();
  await repositories.facilities.listBookingsForDate(1, "2026-09-20");
  await repositories.facilities.listClosuresForDate(1, "2026-09-14");
  await repositories.members.listMembers({ search: "Smith", limit: 10, offset: 0 });
  await repositories.members.listDependents(1);
  await repositories.requests.listByStatus("pending", { limit: 10, offset: 0 });
  await repositories.notifications.listFor({ column: "member_id", id: 1 }, { limit: 10, offset: 0 });
  await repositories.notifications.unreadCount({ column: "member_id", id: 1 });
  await repositories.sessions.listActive({ principalType: "member", principalId: 1 });
  await repositories.audit.list({ entity: "booking", limit: 10, offset: 0 });
  await repositories.audit.listForEntity("booking", 2, { limit: 10 });

  assert.ok(true, "all representative statements executed");
});

test("an approval moves a booking from pending to confirmed end to end", { skip }, async (t) => {
  const { createTenantScope } = require("../../src/data/tenantScope");
  const { poolExecutor, closePool } = require("../../src/config/db");
  const { createRepositories } = require("../../src/repositories");
  const workflow = require("../../src/services/bookingWorkflow");
  t.after(() => closePool());

  const repositories = createRepositories(createTenantScope(1, poolExecutor()));

  // Create a fresh pending booking so the test does not depend on seed state.
  // Facility 1 requires approval and allows 60 days' notice; book inside that
  // window rather than on a fixed date, so the test does not expire.
  const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const created = await workflow.requestBooking(repositories, {
    facilityId: 1,
    memberId: 1,
    bookingDate: soon,
    startsAt: "09:00:00",
    endsAt: "10:00:00",
    notes: "integration test",
  });
  assert.equal(created.status, "pending");
  assert.equal(created.auto_confirmed, false);

  await workflow.approveBooking(
    { ...repositories, policy: { booking: ["owner"] } },
    { bookingId: created.id, actor: { userId: 1, role: "owner" } }
  );

  const after = await repositories.bookings.findById(created.id);
  assert.equal(after.status, "confirmed");

  // The approval must have left an audit row, in the same transaction.
  const trail = await repositories.audit.listForEntity("booking", created.id);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].action, "booking.approved");
  assert.equal(trail[0].actor_id, 1);
  assert.equal(trail[0].metadata.before.status, "pending");
  assert.equal(trail[0].metadata.after.status, "confirmed");

  await repositories.scope.execute(
    "DELETE FROM audit_logs WHERE tenant_id = :tenant AND entity = 'booking' AND entity_id = ?",
    [created.id]
  );
  await repositories.scope.execute(
    "DELETE FROM notifications WHERE tenant_id = :tenant AND ref_entity = 'booking' AND ref_id = ?",
    [created.id]
  );
  await repositories.scope.execute("DELETE FROM bookings WHERE tenant_id = :tenant AND id = ?", [
    created.id,
  ]);
});

test("a facility with requires_approval = 0 confirms on creation", { skip }, async (t) => {
  const { createTenantScope } = require("../../src/data/tenantScope");
  const { poolExecutor, closePool } = require("../../src/config/db");
  const { createRepositories } = require("../../src/repositories");
  const workflow = require("../../src/services/bookingWorkflow");
  t.after(() => closePool());

  const repositories = createRepositories(createTenantScope(1, poolExecutor()));

  // Facility 3 (Northgate Studio) is seeded with requires_approval = 0 and a
  // 7-day advance window, so book inside it.
  const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const created = await workflow.requestBooking(repositories, {
    facilityId: 3,
    memberId: 1,
    bookingDate: soon,
    startsAt: "07:00:00",
    endsAt: "08:00:00",
    notes: "integration test: auto-confirm",
  });

  assert.equal(created.status, "confirmed");
  assert.equal(created.auto_confirmed, true);

  const stored = await repositories.bookings.findById(created.id);
  assert.equal(stored.status, "confirmed");
  assert.equal(stored.reviewed_by, null, "nobody approved it");

  const trail = await repositories.audit.listForEntity("booking", created.id);
  assert.equal(trail[0].action, "booking.auto_confirmed");
  assert.equal(trail[0].actor_type, "member");

  await repositories.scope.execute(
    "DELETE FROM audit_logs WHERE tenant_id = :tenant AND entity = 'booking' AND entity_id = ?",
    [created.id]
  );
  await repositories.scope.execute(
    "DELETE FROM notifications WHERE tenant_id = :tenant AND ref_entity = 'booking' AND ref_id = ?",
    [created.id]
  );
  await repositories.scope.execute("DELETE FROM bookings WHERE tenant_id = :tenant AND id = ?", [
    created.id,
  ]);
});

test("max_advance_days is enforced against the seeded facility", { skip }, async (t) => {
  const { createTenantScope } = require("../../src/data/tenantScope");
  const { poolExecutor, closePool } = require("../../src/config/db");
  const { createRepositories } = require("../../src/repositories");
  const workflow = require("../../src/services/bookingWorkflow");
  t.after(() => closePool());

  const repositories = createRepositories(createTenantScope(1, poolExecutor()));
  // Facility 3 allows 7 days; ask for 30.
  const tooFar = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  await assert.rejects(
    () =>
      workflow.requestBooking(repositories, {
        facilityId: 3,
        memberId: 1,
        bookingDate: tooFar,
        startsAt: "07:00:00",
        endsAt: "08:00:00",
      }),
    (error) => error.code === "booking_too_far_ahead"
  );
});

test("the seeded audit trail is tenant-isolated", { skip }, async (t) => {
  const { createTenantScope } = require("../../src/data/tenantScope");
  const { poolExecutor, closePool } = require("../../src/config/db");
  const { createRepositories } = require("../../src/repositories");
  t.after(() => closePool());

  const northgate = createRepositories(createTenantScope(1, poolExecutor()));
  const riverside = createRepositories(createTenantScope(2, poolExecutor()));

  const theirs = await northgate.audit.listForEntity("booking", 4); // a Riverside booking
  assert.equal(theirs.length, 0, "tenant 1 must not see tenant 2's audit rows");

  const ours = await riverside.audit.listForEntity("booking", 4);
  assert.equal(ours.length, 1);
  assert.equal(ours[0].action, "booking.approved");
});
