"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { authorize, isApprover, requireApprover } = require("../../src/middleware/authorize");

function run(middleware, req) {
  return new Promise((resolve) => {
    middleware(req, {}, (error) => resolve(error || null));
  });
}

const staff = (role, permissions) => ({
  staff: { userId: 1, tenantId: 1, role, permissions: new Set(permissions) },
});

test("authorize() lets a holder of the permission through", async () => {
  const error = await run(authorize("bookings.approve"), staff("front_desk", ["bookings.approve"]));
  assert.equal(error, null);
});

test("authorize() rejects a staff user without the permission", async () => {
  const error = await run(authorize("bookings.approve"), staff("accountant", ["invoices.view"]));
  assert.equal(error.status, 403);
  assert.match(error.message, /bookings\.approve/);
});

test("authorize() rejects an unauthenticated request with 401, not 403", async () => {
  const error = await run(authorize("bookings.approve"), {});
  assert.equal(error.status, 401);
});

test("authorize() accepts an array of permissions as well as a Set", async () => {
  const req = { staff: { role: "owner", permissions: ["members.view"] } };
  assert.equal(await run(authorize("members.view"), req), null);
  assert.equal((await run(authorize("members.edit"), req)).status, 403);
});

test("authorize() requires a permission key at wiring time", () => {
  assert.throws(() => authorize(), /permission key/);
  assert.throws(() => authorize(""), /permission key/);
});

/* ---------------------------------------------------------------------------
 * The approval policy is configuration, and it is a separate check from RBAC.
 * ------------------------------------------------------------------------ */

test("isApprover() reads the injected policy", () => {
  const policy = { booking: ["owner", "front_desk"], profile_change: ["owner"] };
  assert.equal(isApprover("booking", "front_desk", policy), true);
  assert.equal(isApprover("booking", "accountant", policy), false);
  assert.equal(isApprover("profile_change", "front_desk", policy), false);
  assert.equal(isApprover("profile_change", "owner", policy), true);
});

test("isApprover() is false for an unknown or empty workflow", () => {
  assert.equal(isApprover("nonexistent", "owner", { booking: ["owner"] }), false);
  assert.equal(isApprover("booking", "owner", { booking: [] }), false);
  assert.equal(isApprover("booking", "owner", {}), false);
  assert.equal(isApprover("booking", "owner", null), false);
});

test("requireApprover() blocks a role that RBAC would have allowed", async () => {
  // The user holds the permission, but their role is not an approver in this
  // deployment. Both checks have to pass.
  const req = staff("accountant", ["bookings.approve"]);
  assert.equal(await run(authorize("bookings.approve"), req), null);

  const error = await run(requireApprover("booking"), req);
  assert.equal(error.status, 403);
  assert.match(error.message, /accountant/);
});

test("requireApprover() uses the default configuration when none is injected", async () => {
  // The shipped default includes owner/administrator/front_desk for bookings.
  assert.equal(await run(requireApprover("booking"), staff("owner", [])), null);
  assert.equal((await run(requireApprover("booking"), staff("groundskeeper", []))).status, 403);
});
