"use strict";

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { unauthorized } = require("./errors");

/**
 * JWT issuing and verification.
 *
 * Two audiences, deliberately separated:
 *   - `member` tokens authenticate a member (or a dependent) using the app;
 *   - `staff`  tokens authenticate an employee using the /admin surface.
 *
 * The `scope` claim is checked on every request. A member token presented to an
 * admin route is rejected before any handler runs, so a privilege escalation
 * needs a forged signature rather than a route mix-up.
 *
 * Every token carries `tenant_id`. That claim is the *only* source of tenant
 * identity in the system — see src/middleware/authenticate.js.
 */

const SCOPES = Object.freeze({ MEMBER: "member", STAFF: "staff" });

/** Random opaque token, hex-encoded. Used for password reset. */
function randomToken(bytes = env.passwordReset.tokenBytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Hash a bearer-style secret for storage. Reset tokens are high-entropy random
 * values, so a fast SHA-256 is appropriate (unlike passwords, they are not
 * guessable, so there is nothing for a slow KDF to buy). Storing the hash means
 * a database read cannot be replayed as a valid reset link.
 */
function hashOpaqueToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

/** Constant-time comparison for token hashes. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Unique id for a token, stored in auth_sessions so it can be revoked. */
function newSessionId() {
  return crypto.randomUUID();
}

function sign(scope, claims, expiresIn) {
  if (!Number.isInteger(claims.tenant_id) || claims.tenant_id <= 0) {
    // A token without a usable tenant would produce a scope that throws later.
    // Fail here, where the stack trace still points at the login handler.
    throw new Error("Refusing to sign a token without a valid tenant_id claim");
  }
  // `jti` is set through the jwtid option, so it must not also be in the
  // payload — jsonwebtoken rejects the duplicate rather than picking one.
  const { jti, ...rest } = claims;
  return jwt.sign({ ...rest, scope }, env.jwt.secret, {
    expiresIn,
    issuer: env.jwt.issuer,
    jwtid: jti,
  });
}

/**
 * @param {{ sub: number, tenant_id: number, member_id: number|null,
 *           dependent_id: number|null, principal: string, jti: string }} claims
 */
function signMemberToken(claims) {
  return sign(SCOPES.MEMBER, claims, env.jwt.memberExpires);
}

/**
 * @param {{ sub: number, tenant_id: number, role: string, jti: string }} claims
 */
function signStaffToken(claims) {
  return sign(SCOPES.STAFF, claims, env.jwt.staffExpires);
}

/**
 * Verify a token and assert its scope. Throws a 401 ApiError on any failure —
 * expired, wrong signature, wrong issuer, wrong scope — with the same message,
 * so the response does not tell an attacker which check failed.
 */
function verifyToken(token, expectedScope) {
  let payload;
  try {
    payload = jwt.verify(token, env.jwt.secret, { issuer: env.jwt.issuer });
  } catch (error) {
    throw unauthorized("Invalid or expired token");
  }
  if (expectedScope && payload.scope !== expectedScope) {
    throw unauthorized("Invalid or expired token");
  }
  if (!Number.isInteger(payload.tenant_id) || payload.tenant_id <= 0) {
    throw unauthorized("Invalid or expired token");
  }
  return payload;
}

/** Extract a bearer token from the Authorization header, or null. */
function bearerFrom(req) {
  const header = (req && req.headers && req.headers.authorization) || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

module.exports = {
  SCOPES,
  randomToken,
  hashOpaqueToken,
  safeEqual,
  newSessionId,
  signMemberToken,
  signStaffToken,
  verifyToken,
  bearerFrom,
};
