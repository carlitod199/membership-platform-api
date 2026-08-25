"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAuthenticator } = require("../../src/middleware/authenticate");
const { SCOPES, signMemberToken, signStaffToken } = require("../../src/lib/tokens");
const { createTenantScope } = require("../../src/data/tenantScope");
const { FakeExecutor } = require("../helpers/fakeDb");

/**
 * These tests are about one property: the tenant on the request comes from the
 * verified token and from nowhere else.
 */

function makeRequest(token, extra = {}) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: {},
    query: {},
    params: {},
    ...extra,
  };
}

function run(middleware, req) {
  return new Promise((resolve) => {
    middleware(req, {}, (error) => resolve(error || null));
  });
}

const noRevocation = { enforceRevocation: () => false };

test("the tenant scope is built from the token's tenant claim", async () => {
  const middleware = createAuthenticator(SCOPES.MEMBER, {
    ...noRevocation,
    buildScope: (tenantId) => createTenantScope(tenantId, new FakeExecutor()),
  });

  const token = signMemberToken({
    sub: 1,
    tenant_id: 42,
    member_id: 7,
    dependent_id: null,
    principal: "member",
    jti: "s1",
  });
  const req = makeRequest(token);

  assert.equal(await run(middleware, req), null);
  assert.equal(req.tenantId, 42);
  assert.equal(req.scope.tenantId, 42);
  assert.equal(req.member.memberId, 7);
  assert.equal(req.member.sessionId, "s1");
});

test("a tenant_id in the body or query does not influence the scope", async () => {
  const middleware = createAuthenticator(SCOPES.MEMBER, {
    ...noRevocation,
    buildScope: (tenantId) => createTenantScope(tenantId, new FakeExecutor()),
  });

  const token = signMemberToken({
    sub: 1,
    tenant_id: 1,
    member_id: 1,
    dependent_id: null,
    principal: "member",
    jti: "s1",
  });

  // Even without the tenantGuard middleware in front, the values are ignored:
  // the authenticator never reads them.
  const req = makeRequest(token, {
    body: { tenant_id: 999 },
    query: { tenant_id: "999" },
    params: { tenant_id: "999" },
    headers: { authorization: `Bearer ${token}`, "x-tenant-id": "999" },
  });

  await run(middleware, req);
  assert.equal(req.tenantId, 1);
  assert.equal(req.scope.tenantId, 1);
});

test("a missing bearer token is a 401", async () => {
  const middleware = createAuthenticator(SCOPES.MEMBER, noRevocation);
  const error = await run(middleware, makeRequest(null));
  assert.equal(error.status, 401);
});

test("a staff token does not authenticate on the member surface", async () => {
  const middleware = createAuthenticator(SCOPES.MEMBER, {
    ...noRevocation,
    buildScope: (tenantId) => createTenantScope(tenantId, new FakeExecutor()),
  });
  const token = signStaffToken({ sub: 1, tenant_id: 1, role: "owner", jti: "s" });
  const error = await run(middleware, makeRequest(token));
  assert.equal(error.status, 401);
});

test("a revoked session is refused even though the JWT is still valid", async () => {
  const token = signMemberToken({
    sub: 1,
    tenant_id: 1,
    member_id: 1,
    dependent_id: null,
    principal: "member",
    jti: "revoked-session",
  });

  const middleware = createAuthenticator(SCOPES.MEMBER, {
    enforceRevocation: () => true,
    buildScope: (tenantId) => createTenantScope(tenantId, new FakeExecutor()),
    lookupSession: async () => ({ id: 1, revoked_at: "2026-08-25 10:00:00", expires_at: null }),
  });

  const error = await run(middleware, makeRequest(token));
  assert.equal(error.status, 401);
  assert.match(error.message, /revoked/i);
});

test("a session row that no longer exists is refused", async () => {
  const token = signMemberToken({
    sub: 1,
    tenant_id: 1,
    member_id: 1,
    dependent_id: null,
    principal: "member",
    jti: "gone",
  });

  const middleware = createAuthenticator(SCOPES.MEMBER, {
    enforceRevocation: () => true,
    buildScope: (tenantId) => createTenantScope(tenantId, new FakeExecutor()),
    lookupSession: async () => null,
  });

  const error = await run(middleware, makeRequest(token));
  assert.equal(error.status, 401);
});

test("the session lookup is itself tenant-scoped", async () => {
  const executor = new FakeExecutor([[{ id: 1, revoked_at: null }]]);
  const middleware = createAuthenticator(SCOPES.MEMBER, {
    enforceRevocation: () => true,
    buildScope: (tenantId) => createTenantScope(tenantId, executor),
  });

  const token = signMemberToken({
    sub: 1,
    tenant_id: 77,
    member_id: 1,
    dependent_id: null,
    principal: "member",
    jti: "abc",
  });

  assert.equal(await run(middleware, makeRequest(token)), null);
  assert.match(executor.lastCall.sql, /FROM auth_sessions/);
  assert.deepEqual(executor.lastCall.params, [77, "abc"]);
});

test("a staff request carries the role and the loaded permission set", async () => {
  const middleware = createAuthenticator(SCOPES.STAFF, {
    ...noRevocation,
    buildScope: (tenantId) => createTenantScope(tenantId, new FakeExecutor()),
    loadStaffPermissions: async () => new Set(["bookings.approve"]),
  });

  const token = signStaffToken({ sub: 5, tenant_id: 2, role: "front_desk", jti: "s" });
  const req = makeRequest(token);

  assert.equal(await run(middleware, req), null);
  assert.equal(req.staff.role, "front_desk");
  assert.equal(req.staff.tenantId, 2);
  assert.ok(req.staff.permissions.has("bookings.approve"));
  assert.equal(req.member, undefined);
});
