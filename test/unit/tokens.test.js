"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const {
  SCOPES,
  signMemberToken,
  signStaffToken,
  verifyToken,
  bearerFrom,
  hashOpaqueToken,
  randomToken,
  safeEqual,
} = require("../../src/lib/tokens");
const env = require("../../src/config/env");
const { ApiError } = require("../../src/lib/errors");

test("a member token carries tenant_id, subject and scope", () => {
  const token = signMemberToken({
    sub: 10,
    tenant_id: 3,
    member_id: 5,
    dependent_id: null,
    principal: "member",
    jti: "session-1",
  });
  const payload = verifyToken(token, SCOPES.MEMBER);

  assert.equal(payload.tenant_id, 3);
  assert.equal(payload.sub, 10);
  assert.equal(payload.member_id, 5);
  assert.equal(payload.scope, "member");
  assert.equal(payload.jti, "session-1");
  assert.equal(payload.iss, env.jwt.issuer);
});

test("a staff token carries the role", () => {
  const token = signStaffToken({ sub: 2, tenant_id: 1, role: "front_desk", jti: "s2" });
  const payload = verifyToken(token, SCOPES.STAFF);
  assert.equal(payload.role, "front_desk");
  assert.equal(payload.scope, "staff");
});

test("refusing to sign a token without a usable tenant claim", () => {
  for (const bad of [undefined, null, 0, -1, "1"]) {
    assert.throws(
      () => signMemberToken({ sub: 1, tenant_id: bad, principal: "member", jti: "x" }),
      /valid tenant_id/
    );
  }
});

test("a member token is rejected on the staff surface and vice versa", () => {
  const memberToken = signMemberToken({
    sub: 1,
    tenant_id: 1,
    member_id: 1,
    dependent_id: null,
    principal: "member",
    jti: "a",
  });
  const staffToken = signStaffToken({ sub: 1, tenant_id: 1, role: "owner", jti: "b" });

  assert.throws(() => verifyToken(memberToken, SCOPES.STAFF), ApiError);
  assert.throws(() => verifyToken(staffToken, SCOPES.MEMBER), ApiError);

  // ...and each is accepted on its own surface.
  assert.equal(verifyToken(memberToken, SCOPES.MEMBER).scope, "member");
  assert.equal(verifyToken(staffToken, SCOPES.STAFF).scope, "staff");
});

test("a token signed with another secret is rejected", () => {
  const forged = jwt.sign(
    { sub: 1, tenant_id: 2, scope: "member", jti: "x" },
    "some-other-secret",
    { issuer: env.jwt.issuer, expiresIn: "1h" }
  );
  assert.throws(() => verifyToken(forged, SCOPES.MEMBER), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    return true;
  });
});

test("a token from another issuer is rejected", () => {
  const foreign = jwt.sign(
    { sub: 1, tenant_id: 2, scope: "member", jti: "x" },
    env.jwt.secret,
    { issuer: "some-other-service", expiresIn: "1h" }
  );
  assert.throws(() => verifyToken(foreign, SCOPES.MEMBER), ApiError);
});

test("an expired token is rejected", () => {
  const expired = jwt.sign(
    { sub: 1, tenant_id: 2, scope: "member", jti: "x" },
    env.jwt.secret,
    { issuer: env.jwt.issuer, expiresIn: -10 }
  );
  assert.throws(() => verifyToken(expired, SCOPES.MEMBER), ApiError);
});

test("a token whose tenant claim was tampered with does not verify", () => {
  const token = signMemberToken({
    sub: 1,
    tenant_id: 1,
    member_id: 1,
    dependent_id: null,
    principal: "member",
    jti: "x",
  });
  const [header, body, signature] = token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  payload.tenant_id = 2;
  const tampered = [
    header,
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    signature,
  ].join(".");

  assert.throws(() => verifyToken(tampered, SCOPES.MEMBER), ApiError);
});

test("a valid signature with no tenant claim is still rejected", () => {
  const noTenant = jwt.sign({ sub: 1, scope: "member", jti: "x" }, env.jwt.secret, {
    issuer: env.jwt.issuer,
    expiresIn: "1h",
  });
  assert.throws(() => verifyToken(noTenant, SCOPES.MEMBER), ApiError);
});

test("every rejection uses the same message, so nothing is disclosed", () => {
  const messages = new Set();
  const cases = [
    jwt.sign({ sub: 1, tenant_id: 1, scope: "member" }, "wrong-secret", { issuer: env.jwt.issuer }),
    jwt.sign({ sub: 1, tenant_id: 1, scope: "staff" }, env.jwt.secret, { issuer: env.jwt.issuer }),
    jwt.sign({ sub: 1, scope: "member" }, env.jwt.secret, { issuer: env.jwt.issuer }),
    "not-a-token",
  ];
  for (const token of cases) {
    try {
      verifyToken(token, SCOPES.MEMBER);
      assert.fail("expected a rejection");
    } catch (error) {
      messages.add(error.message);
    }
  }
  assert.deepEqual([...messages], ["Invalid or expired token"]);
});

test("bearerFrom reads the Authorization header and nothing else", () => {
  assert.equal(bearerFrom({ headers: { authorization: "Bearer abc" } }), "abc");
  assert.equal(bearerFrom({ headers: { authorization: "bearer abc" } }), null);
  assert.equal(bearerFrom({ headers: { authorization: "Basic abc" } }), null);
  assert.equal(bearerFrom({ headers: {} }), null);
  assert.equal(bearerFrom({}), null);
  assert.equal(bearerFrom({ headers: { authorization: "Bearer   " } }), null);
});

test("opaque tokens are random, and only their hash is comparable", () => {
  const a = randomToken(32);
  const b = randomToken(32);
  assert.equal(a.length, 64);
  assert.notEqual(a, b);

  const hash = hashOpaqueToken(a);
  assert.equal(hash.length, 64);
  assert.equal(hash, hashOpaqueToken(a));
  assert.notEqual(hash, hashOpaqueToken(b));
  assert.ok(safeEqual(hash, hashOpaqueToken(a)));
  assert.ok(!safeEqual(hash, hashOpaqueToken(b)));
});
