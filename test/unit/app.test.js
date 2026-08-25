"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const createApp = require("../../src/app");
const env = require("../../src/config/env");
const { signMemberToken } = require("../../src/lib/tokens");

/**
 * Boots the real Express app on an ephemeral port and drives it over HTTP.
 * Only routes that do not touch the database are asserted here — the point is
 * to prove the wiring (middleware order, 404 envelope, auth rejection before
 * any handler runs) rather than the data layer.
 */

let server;
let base;

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("the unversioned liveness probe answers without a database", async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("the versioned liveness probe answers without a database", async () => {
  const response = await fetch(`${base}${env.apiPrefix}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(typeof body.uptime_s, "number");
});

test("an unknown route returns the standard error envelope", async () => {
  const response = await fetch(`${base}${env.apiPrefix}/does-not-exist`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "not_found");
  assert.ok(body.error.request_id);
});

test("every response carries a request id header", async () => {
  const response = await fetch(`${base}/health`);
  assert.ok(response.headers.get("x-request-id"));
});

test("a supplied request id is echoed back for correlation", async () => {
  const response = await fetch(`${base}/health`, { headers: { "x-request-id": "trace-me-123" } });
  assert.equal(response.headers.get("x-request-id"), "trace-me-123");
});

test("helmet's security headers are present and the framework is not advertised", async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(response.headers.get("x-frame-options") || response.headers.get("content-security-policy"));
});

test("a protected route rejects an unauthenticated request before reaching a handler", async () => {
  // No database is configured in the test environment, so a 401 here also
  // proves the auth guard runs before anything tries to query.
  const response = await fetch(`${base}${env.apiPrefix}/profile`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "unauthorized");
});

test("an admin route rejects a member-scope token", async () => {
  const memberToken = signMemberToken({
    sub: 1,
    tenant_id: 1,
    member_id: 1,
    dependent_id: null,
    principal: "member",
    jti: "s1",
  });

  const response = await fetch(`${base}${env.apiPrefix}/admin/members`, {
    headers: { authorization: `Bearer ${memberToken}` },
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.message, "Invalid or expired token");
});

test("a malformed JSON body is a 400, not a 500", async () => {
  const response = await fetch(`${base}${env.apiPrefix}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(response.status, 400);
});

test("validation runs before any database access", async () => {
  // An empty body must be rejected by validate(), which happens before the
  // credential lookup. If this returned a 500 it would mean the handler tried
  // to reach MySQL first.
  const response = await fetch(`${base}${env.apiPrefix}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.deepEqual(body.error.details, { email: "is required", password: "is required" });
});

test("a client-supplied tenant_id does not turn a validation error into success", async () => {
  const response = await fetch(`${base}${env.apiPrefix}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant_id: 2, tenantId: 2 }),
  });
  assert.equal(response.status, 400);
});

test("the audit log endpoint exists and requires a staff token", async () => {
  const response = await fetch(`${base}${env.apiPrefix}/admin/audit-logs`);
  assert.equal(response.status, 401);

  const memberToken = signMemberToken({
    sub: 1,
    tenant_id: 1,
    member_id: 1,
    dependent_id: null,
    principal: "member",
    jti: "s1",
  });
  const asMember = await fetch(`${base}${env.apiPrefix}/admin/audit-logs`, {
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(asMember.status, 401, "a member token must not reach the audit trail");
});

test("the audit log endpoint is read-only", async () => {
  // Asserted structurally rather than over HTTP: `requireStaff` sits in front of
  // the whole /admin tree, so an unauthenticated POST is a 401 before routing
  // ever decides the method is unsupported — which is the right order (a 404
  // would tell an anonymous caller which admin routes exist). So inspect the
  // router: it must declare no write handler at all.
  const auditRouter = require("../../src/modules/admin/auditLogs");
  const methods = new Set();
  for (const layer of auditRouter.stack) {
    if (layer.route) for (const m of Object.keys(layer.route.methods)) methods.add(m);
  }
  assert.deepEqual([...methods], ["get"]);

  // And over HTTP the guard is what answers, not a handler.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${base}${env.apiPrefix}/admin/audit-logs`, { method });
    assert.equal(response.status, 401, `${method} must be stopped by the auth guard`);
  }
});

test("trust proxy is set from configuration, not hardcoded", () => {
  const app = createApp();
  assert.equal(app.get("trust proxy"), env.trustProxy);
});
