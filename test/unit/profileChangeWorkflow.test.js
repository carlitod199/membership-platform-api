"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const workflow = require("../../src/services/profileChangeWorkflow");

function makeRepositories(seedRequests = [], member = null) {
  const requests = seedRequests.map((r) => ({ ...r }));
  const memberRow = member || {
    id: 7,
    full_name: "John Smith",
    email: "john.smith@example.com",
    mobile: "+1-555-0101",
    city: "Northgate",
  };
  const applied = [];
  const notifications = [];
  let nextId = requests.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  let transactions = 0;

  const requestRepo = {
    rows: requests,
    async findById(id) {
      const row = requests.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async findPendingForMember(memberId) {
      const row = requests.find((r) => r.member_id === memberId && r.status === "pending");
      return row ? { id: row.id } : null;
    },
    async create({ memberId, currentValues, requestedValues, status }) {
      const row = {
        id: nextId++,
        member_id: memberId,
        current_values: currentValues,
        requested_values: requestedValues,
        status,
      };
      requests.push(row);
      return row.id;
    },
    async approve({ id, reviewerId, note }) {
      const row = requests.find((r) => r.id === id && r.status === "pending");
      if (!row) return false;
      Object.assign(row, { status: "approved", reviewed_by: reviewerId, review_note: note });
      return true;
    },
    async reject({ id, reviewerId, note }) {
      const row = requests.find((r) => r.id === id && r.status === "pending");
      if (!row) return false;
      Object.assign(row, { status: "rejected", reviewed_by: reviewerId, review_note: note });
      return true;
    },
  };

  const members = {
    row: memberRow,
    applied,
    async findById(id) {
      return id === memberRow.id ? { ...memberRow } : null;
    },
    async applyChanges({ memberId, values, actorId }) {
      applied.push({ memberId, values, actorId });
      Object.assign(memberRow, values);
      return true;
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

  return {
    requests: requestRepo,
    members,
    notifications: notificationRepo,
    audit: auditRepo,
    get transactionCount() {
      return transactions;
    },
    transaction: async (fn) => {
      transactions += 1;
      return fn({
        requests: requestRepo,
        members,
        notifications: notificationRepo,
        audit: auditRepo,
      });
    },
  };
}

const ALLOWED = ["email", "mobile", "city"];
const POLICY = { booking: ["owner"], profile_change: ["owner", "membership_officer"] };
const OFFICER = { userId: 4, role: "membership_officer" };
const FRONT_DESK = { userId: 2, role: "front_desk" };

const PENDING = {
  id: 1,
  member_id: 7,
  current_values: { email: "john.smith@example.com" },
  requested_values: { email: "john.smith.new@example.com" },
  status: "pending",
};

/* ------------------------------------------------------------------------ */

test("filterEditable keeps only allow-listed fields", () => {
  const filtered = workflow.filterEditable(
    { email: "a@example.com", status: "active", tenant_id: 9, city: "Northgate", blank: "" },
    ALLOWED
  );
  assert.deepEqual(filtered, { email: "a@example.com", city: "Northgate" });
});

test("a change request does not touch the member record", async () => {
  const repositories = makeRepositories();
  const before = { ...repositories.members.row };

  const result = await workflow.requestProfileChange(
    { ...repositories, allowedFields: ALLOWED },
    { memberId: 7, values: { email: "changed@example.com" } }
  );

  assert.equal(result.status, "pending");
  assert.deepEqual(repositories.members.row, before, "member record must be unchanged");
  assert.equal(repositories.members.applied.length, 0);
});

test("the request snapshots the current values", async () => {
  const repositories = makeRepositories();
  await workflow.requestProfileChange(
    { ...repositories, allowedFields: ALLOWED },
    { memberId: 7, values: { email: "changed@example.com", city: "Elsewhere" } }
  );

  const stored = repositories.requests.rows[0];
  assert.deepEqual(stored.current_values, {
    email: "john.smith@example.com",
    city: "Northgate",
  });
  assert.deepEqual(stored.requested_values, {
    email: "changed@example.com",
    city: "Elsewhere",
  });
});

test("a request containing only non-editable fields is refused", async () => {
  const repositories = makeRepositories();
  await assert.rejects(
    () =>
      workflow.requestProfileChange(
        { ...repositories, allowedFields: ALLOWED },
        { memberId: 7, values: { status: "active", membership_number: "NG-9999", tenant_id: 2 } }
      ),
    (error) => error.status === 400
  );
  assert.equal(repositories.requests.rows.length, 0);
});

test("a member may only have one request open at a time", async () => {
  const repositories = makeRepositories([PENDING]);
  await assert.rejects(
    () =>
      workflow.requestProfileChange(
        { ...repositories, allowedFields: ALLOWED },
        { memberId: 7, values: { city: "Elsewhere" } }
      ),
    (error) => error.status === 400 && /awaiting review/.test(error.message)
  );
});

test("approval writes the values into the member record and notifies", async () => {
  const repositories = makeRepositories([PENDING]);

  const result = await workflow.approveProfileChange(
    { ...repositories, policy: POLICY, allowedFields: ALLOWED },
    { requestId: 1, actor: OFFICER }
  );

  assert.equal(result.status, "approved");
  assert.deepEqual(result.applied_fields, ["email"]);
  assert.equal(repositories.members.row.email, "john.smith.new@example.com");
  assert.equal(repositories.transactionCount, 1);
  assert.equal(repositories.notifications.sent.length, 1);
  assert.match(repositories.notifications.sent[0].title, /approved/i);
  assert.equal(repositories.notifications.sent[0].memberId, 7);
});

test("a role that is not an approver cannot apply the change", async () => {
  const repositories = makeRepositories([PENDING]);

  await assert.rejects(
    () =>
      workflow.approveProfileChange(
        { ...repositories, policy: POLICY, allowedFields: ALLOWED },
        { requestId: 1, actor: FRONT_DESK }
      ),
    (error) => error.status === 403
  );

  assert.equal(repositories.members.row.email, "john.smith@example.com");
  assert.equal(repositories.requests.rows[0].status, "pending");
  assert.equal(repositories.notifications.sent.length, 0);
});

test("a field removed from the allow-list after submission is not written", async () => {
  const repositories = makeRepositories([
    { ...PENDING, requested_values: { email: "new@example.com", city: "Elsewhere" } },
  ]);

  const result = await workflow.approveProfileChange(
    { ...repositories, policy: POLICY, allowedFields: ["city"] },
    { requestId: 1, actor: OFFICER }
  );

  assert.deepEqual(result.applied_fields, ["city"]);
  assert.equal(repositories.members.row.city, "Elsewhere");
  assert.equal(repositories.members.row.email, "john.smith@example.com", "email must not be applied");
});

test("a request with nothing left to apply is refused rather than silently approved", async () => {
  const repositories = makeRepositories([PENDING]);
  await assert.rejects(
    () =>
      workflow.approveProfileChange(
        { ...repositories, policy: POLICY, allowedFields: ["city"] },
        { requestId: 1, actor: OFFICER }
      ),
    (error) => error.status === 400
  );
  assert.equal(repositories.requests.rows[0].status, "pending");
});

test("rejection leaves the member record alone and notifies with the reason", async () => {
  const repositories = makeRepositories([PENDING]);

  await workflow.rejectProfileChange(
    { ...repositories, policy: POLICY },
    { requestId: 1, actor: OFFICER, note: "Please bring photo ID to the office" }
  );

  assert.equal(repositories.requests.rows[0].status, "rejected");
  assert.equal(repositories.members.row.email, "john.smith@example.com");
  assert.equal(repositories.notifications.sent[0].body, "Please bring photo ID to the office");
});

test("an already-reviewed request cannot be approved a second time", async () => {
  const repositories = makeRepositories([{ ...PENDING, status: "approved" }]);
  await assert.rejects(
    () =>
      workflow.approveProfileChange(
        { ...repositories, policy: POLICY, allowedFields: ALLOWED },
        { requestId: 1, actor: OFFICER }
      ),
    (error) => error.status === 400 && /already approved/.test(error.message)
  );
});

/* ---------------------------------------------------------------------------
 * audit trail
 * ------------------------------------------------------------------------ */

test("approval audits the actor and the exact before/after values", async () => {
  const repositories = makeRepositories([PENDING]);

  await workflow.approveProfileChange(
    { ...repositories, policy: POLICY, allowedFields: ALLOWED },
    { requestId: 1, actor: OFFICER, note: "ID checked at the desk" }
  );

  assert.equal(repositories.audit.rows.length, 1);
  const entry = repositories.audit.rows[0];
  assert.equal(entry.actorType, "staff");
  assert.equal(entry.actorId, 4);
  assert.equal(entry.action, "profile_change.approved");
  assert.equal(entry.entity, "profile_change_request");
  assert.equal(entry.entityId, 1);
  assert.deepEqual(entry.metadata.before, { email: "john.smith@example.com" });
  assert.deepEqual(entry.metadata.after, { email: "john.smith.new@example.com" });
  assert.deepEqual(entry.metadata.applied_fields, ["email"]);
  assert.equal(entry.metadata.actor_role, "membership_officer");
  assert.equal(entry.metadata.note, "ID checked at the desk");
  assert.equal(entry.metadata.member_id, 7);
});

test("the audit before/after only covers the fields actually applied", async () => {
  const repositories = makeRepositories([
    {
      ...PENDING,
      current_values: { email: "john.smith@example.com", city: "Northgate" },
      requested_values: { email: "new@example.com", city: "Elsewhere" },
    },
  ]);

  await workflow.approveProfileChange(
    { ...repositories, policy: POLICY, allowedFields: ["city"] },
    { requestId: 1, actor: OFFICER }
  );

  const entry = repositories.audit.rows[0];
  assert.deepEqual(entry.metadata.before, { city: "Northgate" });
  assert.deepEqual(entry.metadata.after, { city: "Elsewhere" });
  assert.equal("email" in entry.metadata.after, false, "email was not applied, so it is not audited as applied");
});

test("rejection audits the decision and keeps the declined proposal", async () => {
  const repositories = makeRepositories([PENDING]);

  await workflow.rejectProfileChange(
    { ...repositories, policy: POLICY },
    { requestId: 1, actor: OFFICER, note: "Bring photo ID" }
  );

  const entry = repositories.audit.rows[0];
  assert.equal(entry.action, "profile_change.rejected");
  assert.deepEqual(entry.metadata.after, { status: "rejected" });
  assert.deepEqual(entry.metadata.declined_values, { email: "john.smith.new@example.com" });
  assert.equal(entry.metadata.note, "Bring photo ID");
});

test("a refused approval writes no audit row", async () => {
  const repositories = makeRepositories([PENDING]);
  await assert.rejects(
    () =>
      workflow.approveProfileChange(
        { ...repositories, policy: POLICY, allowedFields: ALLOWED },
        { requestId: 1, actor: FRONT_DESK }
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
  const record = repositories.audit.record.bind(repositories.audit);
  repositories.audit.record = async (entry) => {
    order.push("audit");
    return record(entry);
  };

  await workflow.approveProfileChange(
    { ...repositories, policy: POLICY, allowedFields: ALLOWED },
    { requestId: 1, actor: OFFICER }
  );

  assert.deepEqual(order, ["begin", "audit", "commit"]);
});
