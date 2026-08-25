"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const workflow = require("../../src/services/bookingWorkflow");
const { ApiError } = require("../../src/lib/errors");

/**
 * In-memory repositories with the same method names as the real ones. The
 * workflow module has no other dependency, so these tests exercise the actual
 * production code path for the approval rules.
 */
function makeRepositories(seed = []) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = rows.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  const notifications = [];
  let transactions = 0;

  const bookings = {
    rows,
    async findById(id) {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async findByIdForMember(id, memberId) {
      const row = rows.find((r) => r.id === id && r.member_id === memberId);
      return row ? { ...row } : null;
    },
    async findOverlapping({ facilityId, bookingDate, startsAt, endsAt, statuses, excludeId = 0 }) {
      const hit = rows.find(
        (r) =>
          r.facility_id === facilityId &&
          r.booking_date === bookingDate &&
          statuses.includes(r.status) &&
          r.starts_at < endsAt &&
          r.ends_at > startsAt &&
          r.id !== excludeId
      );
      return hit ? { id: hit.id } : null;
    },
    async create(data) {
      const row = {
        id: nextId++,
        facility_id: data.facilityId,
        member_id: data.memberId,
        dependent_id: data.dependentId,
        booking_date: data.bookingDate,
        starts_at: data.startsAt,
        ends_at: data.endsAt,
        notes: data.notes,
        status: data.status,
      };
      rows.push(row);
      return row.id;
    },
    async confirm({ id, reviewerId, note }) {
      const row = rows.find((r) => r.id === id && r.status === "pending");
      if (!row) return false;
      Object.assign(row, { status: "confirmed", reviewed_by: reviewerId, review_note: note });
      return true;
    },
    async reject({ id, reviewerId, note }) {
      const row = rows.find((r) => r.id === id && r.status === "pending");
      if (!row) return false;
      Object.assign(row, { status: "rejected", reviewed_by: reviewerId, review_note: note });
      return true;
    },
    async cancel({ id, note }) {
      const row = rows.find((r) => r.id === id && ["pending", "confirmed"].includes(r.status));
      if (!row) return false;
      Object.assign(row, { status: "cancelled", review_note: note });
      return true;
    },
  };

  // Facility 1  : requires approval, 30-day advance window (the common case)
  // Facility 7  : requires_approval = 0 -> auto-confirms
  // Facility 99 : closed for maintenance
  // Facility 404: does not exist
  const catalogue = {
    1: { id: 1, name: "Main Hall", slot_minutes: 60, requires_approval: 1, max_advance_days: 30 },
    7: { id: 7, name: "Open Studio", slot_minutes: 60, requires_approval: 0, max_advance_days: 30 },
    99: { id: 99, name: "Closed Room", slot_minutes: 60, requires_approval: 1, max_advance_days: 30 },
  };
  const facilities = {
    catalogue,
    async findActiveById(id) {
      return catalogue[id] ? { ...catalogue[id] } : null;
    },
    async findClosure({ facilityId }) {
      return facilityId === 99 ? { id: 1, reason: "Maintenance" } : null;
    },
  };

  const notificationRepo = {
    sent: notifications,
    async create(notification) {
      notifications.push(notification);
      return notifications.length;
    },
  };

  const auditRows = [];
  const auditRepo = {
    rows: auditRows,
    async record(entry) {
      auditRows.push(entry);
      return auditRows.length;
    },
  };

  const repositories = {
    bookings,
    facilities,
    notifications: notificationRepo,
    audit: auditRepo,
    // A fixed clock so the advance-window tests are not dated.
    now: () => new Date("2026-09-01T12:00:00Z"),
    get transactionCount() {
      return transactions;
    },
    transaction: async (fn) => {
      transactions += 1;
      return fn({
        bookings,
        notifications: notificationRepo,
        facilities,
        audit: auditRepo,
      });
    },
  };
  return repositories;
}

const POLICY = { booking: ["owner", "front_desk"], profile_change: ["owner"] };
const OWNER = { userId: 1, role: "owner" };
const ACCOUNTANT = { userId: 3, role: "accountant" };

const PENDING = {
  id: 1,
  facility_id: 1,
  member_id: 7,
  booking_date: "2026-09-20",
  starts_at: "18:00:00",
  ends_at: "19:00:00",
  status: "pending",
};

/* ------------------------------------------------------------------------ */

test("a member's booking is created as pending, never confirmed", async () => {
  const repositories = makeRepositories();
  const result = await workflow.requestBooking(repositories, {
    facilityId: 1,
    memberId: 7,
    bookingDate: "2026-09-20",
    startsAt: "18:00:00",
    endsAt: "19:00:00",
  });

  assert.equal(result.status, "pending");
  const stored = await repositories.bookings.findById(result.id);
  assert.equal(stored.status, "pending");
});

test("a caller cannot ask for a confirmed booking", async () => {
  const repositories = makeRepositories();
  const result = await workflow.requestBooking(repositories, {
    facilityId: 1,
    memberId: 7,
    bookingDate: "2026-09-20",
    startsAt: "18:00:00",
    endsAt: "19:00:00",
    // Smuggled through the input object; the workflow sets the status itself.
    status: "confirmed",
  });
  const stored = await repositories.bookings.findById(result.id);
  assert.equal(stored.status, "pending");
});

test("a pending booking stays pending until an approval happens", async () => {
  const repositories = makeRepositories([PENDING]);

  const before = await repositories.bookings.findById(1);
  assert.equal(before.status, "pending");
  assert.equal(repositories.notifications.sent.length, 0);

  await workflow.approveBooking({ ...repositories, policy: POLICY }, { bookingId: 1, actor: OWNER });

  const after = await repositories.bookings.findById(1);
  assert.equal(after.status, "confirmed");
  assert.equal(after.reviewed_by, 1);
});

test("approval notifies the member, in the same transaction", async () => {
  const repositories = makeRepositories([PENDING]);
  await workflow.approveBooking({ ...repositories, policy: POLICY }, { bookingId: 1, actor: OWNER });

  assert.equal(repositories.transactionCount, 1);
  assert.equal(repositories.notifications.sent.length, 1);
  const notification = repositories.notifications.sent[0];
  assert.equal(notification.memberId, 7);
  assert.equal(notification.category, "booking");
  assert.equal(notification.refEntity, "booking");
  assert.equal(notification.refId, 1);
  assert.match(notification.title, /confirmed/i);
});

test("rejection sets the status and notifies with the reason", async () => {
  const repositories = makeRepositories([PENDING]);
  await workflow.rejectBooking(
    { ...repositories, policy: POLICY },
    { bookingId: 1, actor: OWNER, note: "Hall already reserved for maintenance" }
  );

  const after = await repositories.bookings.findById(1);
  assert.equal(after.status, "rejected");
  assert.equal(repositories.notifications.sent[0].body, "Hall already reserved for maintenance");
});

test("a role that is not configured as an approver cannot approve", async () => {
  const repositories = makeRepositories([PENDING]);

  await assert.rejects(
    () =>
      workflow.approveBooking(
        { ...repositories, policy: POLICY },
        { bookingId: 1, actor: ACCOUNTANT }
      ),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 403);
      return true;
    }
  );

  const after = await repositories.bookings.findById(1);
  assert.equal(after.status, "pending", "a refused approval must not change the booking");
  assert.equal(repositories.notifications.sent.length, 0);
});

test("the approver list is configuration, not code", async () => {
  const repositories = makeRepositories([PENDING]);
  // Same actor, a policy that includes their role.
  await workflow.approveBooking(
    { ...repositories, policy: { booking: ["accountant"] } },
    { bookingId: 1, actor: ACCOUNTANT }
  );
  assert.equal((await repositories.bookings.findById(1)).status, "confirmed");
});

test("an empty approver list approves nobody", async () => {
  const repositories = makeRepositories([PENDING]);
  await assert.rejects(
    () => workflow.approveBooking({ ...repositories, policy: { booking: [] } }, { bookingId: 1, actor: OWNER }),
    (error) => error.status === 403
  );
});

test("a booking that is not pending cannot be approved again", async () => {
  const repositories = makeRepositories([{ ...PENDING, status: "confirmed" }]);
  await assert.rejects(
    () => workflow.approveBooking({ ...repositories, policy: POLICY }, { bookingId: 1, actor: OWNER }),
    (error) => error.status === 400 && /not pending/.test(error.message)
  );
});

test("approval is refused when the slot was confirmed for someone else meanwhile", async () => {
  const repositories = makeRepositories([
    PENDING,
    { ...PENDING, id: 2, member_id: 8, status: "confirmed" },
  ]);

  await assert.rejects(
    () => workflow.approveBooking({ ...repositories, policy: POLICY }, { bookingId: 1, actor: OWNER }),
    (error) => error.status === 409
  );

  assert.equal((await repositories.bookings.findById(1)).status, "pending");
  assert.equal(repositories.notifications.sent.length, 0);
});

test("two pending bookings for the same slot do not block each other's approval", async () => {
  const repositories = makeRepositories([PENDING, { ...PENDING, id: 2, member_id: 8 }]);
  await workflow.approveBooking({ ...repositories, policy: POLICY }, { bookingId: 1, actor: OWNER });
  assert.equal((await repositories.bookings.findById(1)).status, "confirmed");
  assert.equal((await repositories.bookings.findById(2)).status, "pending");
});

test("a booking request for an unknown facility is a 404", async () => {
  const repositories = makeRepositories();
  await assert.rejects(
    () =>
      workflow.requestBooking(repositories, {
        facilityId: 404,
        memberId: 7,
        bookingDate: "2026-09-20",
        startsAt: "18:00:00",
        endsAt: "19:00:00",
      }),
    (error) => error.status === 404
  );
});

test("a booking request during a closure is refused", async () => {
  const repositories = makeRepositories();
  await assert.rejects(
    () =>
      workflow.requestBooking(repositories, {
        facilityId: 99,
        memberId: 7,
        bookingDate: "2026-09-20",
        startsAt: "18:00:00",
        endsAt: "19:00:00",
      }),
    (error) => error.status === 409 && /closed/.test(error.message)
  );
});

test("an inverted time range is refused", async () => {
  const repositories = makeRepositories();
  await assert.rejects(
    () =>
      workflow.requestBooking(repositories, {
        facilityId: 1,
        memberId: 7,
        bookingDate: "2026-09-20",
        startsAt: "19:00:00",
        endsAt: "18:00:00",
      }),
    (error) => error.status === 400
  );
});

test("adjacent slots do not count as overlapping", async () => {
  const repositories = makeRepositories([{ ...PENDING, status: "confirmed" }]);
  const result = await workflow.requestBooking(repositories, {
    facilityId: 1,
    memberId: 8,
    bookingDate: "2026-09-20",
    startsAt: "19:00:00",
    endsAt: "20:00:00",
  });
  assert.equal(result.status, "pending");
});

test("a member can cancel their own pending booking", async () => {
  const repositories = makeRepositories([PENDING]);
  const result = await workflow.cancelBooking(repositories, { bookingId: 1, memberId: 7 });
  assert.equal(result.status, "cancelled");
});

test("a member cannot cancel a booking that is not theirs", async () => {
  const repositories = makeRepositories([PENDING]);
  await assert.rejects(
    () => workflow.cancelBooking(repositories, { bookingId: 1, memberId: 999 }),
    (error) => error.status === 404
  );
  assert.equal((await repositories.bookings.findById(1)).status, "pending");
});

/* ---------------------------------------------------------------------------
 * facility.requires_approval
 * ------------------------------------------------------------------------ */

test("a facility that requires approval still produces a pending booking", async () => {
  const repositories = makeRepositories();
  const result = await workflow.requestBooking(repositories, {
    facilityId: 1,
    memberId: 7,
    bookingDate: "2026-09-20",
    startsAt: "18:00:00",
    endsAt: "19:00:00",
  });

  assert.equal(result.status, "pending");
  assert.equal(result.auto_confirmed, false);
  assert.equal(repositories.notifications.sent.length, 0, "nothing to tell the member yet");
  assert.equal(repositories.audit.rows.length, 0);
});

test("a facility with requires_approval = 0 confirms the booking immediately", async () => {
  const repositories = makeRepositories();
  const result = await workflow.requestBooking(repositories, {
    facilityId: 7,
    memberId: 7,
    bookingDate: "2026-09-20",
    startsAt: "18:00:00",
    endsAt: "19:00:00",
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.auto_confirmed, true);

  const stored = await repositories.bookings.findById(result.id);
  assert.equal(stored.status, "confirmed");
});

test("the auto-confirm path runs in a transaction and notifies the member", async () => {
  const repositories = makeRepositories();
  await workflow.requestBooking(repositories, {
    facilityId: 7,
    memberId: 7,
    bookingDate: "2026-09-20",
    startsAt: "18:00:00",
    endsAt: "19:00:00",
  });

  assert.equal(repositories.transactionCount, 1);
  assert.equal(repositories.notifications.sent.length, 1);
  assert.equal(repositories.notifications.sent[0].memberId, 7);
  assert.match(repositories.notifications.sent[0].title, /confirmed/i);
});

test("the auto-confirm path still refuses an overlap with a confirmed booking", async () => {
  const repositories = makeRepositories([
    {
      id: 1,
      facility_id: 7,
      member_id: 8,
      booking_date: "2026-09-20",
      starts_at: "18:00:00",
      ends_at: "19:00:00",
      status: "confirmed",
    },
  ]);

  await assert.rejects(
    () =>
      workflow.requestBooking(repositories, {
        facilityId: 7,
        memberId: 7,
        bookingDate: "2026-09-20",
        startsAt: "18:30:00",
        endsAt: "19:30:00",
      }),
    (error) => error.status === 409
  );

  assert.equal(repositories.bookings.rows.length, 1, "no booking row was created");
  assert.equal(repositories.notifications.sent.length, 0);
  assert.equal(repositories.audit.rows.length, 0);
});

test("the auto-confirm overlap check happens inside the transaction", async () => {
  // A confirmed booking that only becomes visible once the transaction opens —
  // the situation a check done solely before the transaction would miss.
  const repositories = makeRepositories();
  const original = repositories.transaction;
  repositories.transaction = async (fn) => {
    repositories.bookings.rows.push({
      id: 99,
      facility_id: 7,
      member_id: 8,
      booking_date: "2026-09-20",
      starts_at: "18:00:00",
      ends_at: "19:00:00",
      status: "confirmed",
    });
    return original(fn);
  };

  await assert.rejects(
    () =>
      workflow.requestBooking(repositories, {
        facilityId: 7,
        memberId: 7,
        bookingDate: "2026-09-20",
        startsAt: "18:00:00",
        endsAt: "19:00:00",
      }),
    (error) => error.status === 409
  );
});

/* ---------------------------------------------------------------------------
 * facility.max_advance_days
 * ------------------------------------------------------------------------ */

test("a booking inside the advance window is accepted (boundary: exactly the limit)", async () => {
  const repositories = makeRepositories(); // clock is 2026-09-01, limit is 30 days
  const result = await workflow.requestBooking(repositories, {
    facilityId: 1,
    memberId: 7,
    bookingDate: "2026-10-01", // exactly 30 days ahead
    startsAt: "10:00:00",
    endsAt: "11:00:00",
  });
  assert.equal(result.status, "pending");
});

test("a booking one day past the advance window is refused", async () => {
  const repositories = makeRepositories();
  await assert.rejects(
    () =>
      workflow.requestBooking(repositories, {
        facilityId: 1,
        memberId: 7,
        bookingDate: "2026-10-02", // 31 days ahead
        startsAt: "10:00:00",
        endsAt: "11:00:00",
      }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "booking_too_far_ahead");
      assert.match(error.message, /30 days ahead/);
      return true;
    }
  );
  assert.equal(repositories.bookings.rows.length, 0);
});

test("the advance window applies to the auto-confirm path too", async () => {
  const repositories = makeRepositories();
  await assert.rejects(
    () =>
      workflow.requestBooking(repositories, {
        facilityId: 7,
        memberId: 7,
        bookingDate: "2026-10-02",
        startsAt: "10:00:00",
        endsAt: "11:00:00",
      }),
    (error) => error.code === "booking_too_far_ahead"
  );
});

test("a facility with no advance limit accepts a far-future booking", async () => {
  const repositories = makeRepositories();
  repositories.facilities.catalogue[1].max_advance_days = 0;
  const result = await workflow.requestBooking(repositories, {
    facilityId: 1,
    memberId: 7,
    bookingDate: "2029-01-01",
    startsAt: "10:00:00",
    endsAt: "11:00:00",
  });
  assert.equal(result.status, "pending");
});

test("daysAhead counts whole UTC calendar days", () => {
  const now = new Date("2026-09-01T23:30:00Z");
  assert.equal(workflow.daysAhead("2026-09-01", now), 0);
  assert.equal(workflow.daysAhead("2026-09-02", now), 1);
  assert.equal(workflow.daysAhead("2026-10-01", now), 30);
});

/* ---------------------------------------------------------------------------
 * audit trail
 * ------------------------------------------------------------------------ */

test("approval writes an audit row with actor, action and before/after", async () => {
  const repositories = makeRepositories([PENDING]);
  await workflow.approveBooking(
    { ...repositories, policy: POLICY },
    { bookingId: 1, actor: OWNER, note: "Checked with the caretaker" }
  );

  assert.equal(repositories.audit.rows.length, 1);
  const entry = repositories.audit.rows[0];
  assert.equal(entry.actorType, "staff");
  assert.equal(entry.actorId, 1);
  assert.equal(entry.action, "booking.approved");
  assert.equal(entry.entity, "booking");
  assert.equal(entry.entityId, 1);
  assert.deepEqual(entry.metadata.before, { status: "pending" });
  assert.deepEqual(entry.metadata.after, { status: "confirmed" });
  assert.equal(entry.metadata.actor_role, "owner");
  assert.equal(entry.metadata.note, "Checked with the caretaker");
});

test("rejection writes an audit row recording the reason", async () => {
  const repositories = makeRepositories([PENDING]);
  await workflow.rejectBooking(
    { ...repositories, policy: POLICY },
    { bookingId: 1, actor: OWNER, note: "Hall is being repainted" }
  );

  const entry = repositories.audit.rows[0];
  assert.equal(entry.action, "booking.rejected");
  assert.deepEqual(entry.metadata.after, { status: "rejected" });
  assert.equal(entry.metadata.note, "Hall is being repainted");
});

test("the auto-confirm path records who really decided", async () => {
  const repositories = makeRepositories();
  const result = await workflow.requestBooking(repositories, {
    facilityId: 7,
    memberId: 7,
    bookingDate: "2026-09-20",
    startsAt: "18:00:00",
    endsAt: "19:00:00",
  });

  const entry = repositories.audit.rows[0];
  assert.equal(entry.action, "booking.auto_confirmed");
  assert.equal(entry.actorType, "member", "no staff member approved this");
  assert.equal(entry.actorId, 7);
  assert.equal(entry.entityId, result.id);
  assert.match(entry.metadata.reason, /requires_approval/);
});

test("a refused approval writes no audit row", async () => {
  const repositories = makeRepositories([PENDING]);
  await assert.rejects(
    () =>
      workflow.approveBooking(
        { ...repositories, policy: POLICY },
        { bookingId: 1, actor: ACCOUNTANT }
      ),
    (error) => error.status === 403
  );
  assert.equal(repositories.audit.rows.length, 0);
});

test("the audit write happens inside the approval transaction", async () => {
  const repositories = makeRepositories([PENDING]);
  const order = [];
  const original = repositories.transaction;
  repositories.transaction = async (fn) => {
    order.push("begin");
    const result = await original(fn);
    order.push("commit");
    return result;
  };
  const auditRecord = repositories.audit.record.bind(repositories.audit);
  repositories.audit.record = async (entry) => {
    order.push("audit");
    return auditRecord(entry);
  };

  await workflow.approveBooking({ ...repositories, policy: POLICY }, { bookingId: 1, actor: OWNER });

  assert.deepEqual(order, ["begin", "audit", "commit"]);
});

test("the workflow still works when no audit repository is supplied", async () => {
  // Keeps the service usable from a context that has not wired auditing —
  // the tests for the older behaviour construct deps that way.
  const repositories = makeRepositories([PENDING]);
  delete repositories.audit;
  repositories.transaction = async (fn) =>
    fn({ bookings: repositories.bookings, notifications: repositories.notifications });

  await workflow.approveBooking({ ...repositories, policy: POLICY }, { bookingId: 1, actor: OWNER });
  assert.equal((await repositories.bookings.findById(1)).status, "confirmed");
});

test("the auto-confirm result is distinguishable from a pending one", async () => {
  // The route picks its response message from `auto_confirmed`; if the flag
  // were dropped, a confirmed booking would be announced as awaiting review.
  const repositories = makeRepositories();
  const pending = await workflow.requestBooking(repositories, {
    facilityId: 1,
    memberId: 7,
    bookingDate: "2026-09-20",
    startsAt: "18:00:00",
    endsAt: "19:00:00",
  });
  const auto = await workflow.requestBooking(repositories, {
    facilityId: 7,
    memberId: 7,
    bookingDate: "2026-09-20",
    startsAt: "18:00:00",
    endsAt: "19:00:00",
  });

  assert.equal(pending.auto_confirmed, false);
  assert.equal(auto.auto_confirmed, true);
  assert.notEqual(pending.status, auto.status);
});
