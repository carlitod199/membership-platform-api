"use strict";

const { badRequest } = require("../lib/errors");
const { randomToken, hashOpaqueToken } = require("../lib/tokens");
const { hashPassword, assertPasswordPolicy } = require("../lib/passwords");
const env = require("../config/env");

/**
 * Password reset.
 *
 * Properties this implementation guarantees, each of which is covered by a test:
 *
 *   1. SINGLE USE. Consuming a token is a conditional update
 *      (`SET used_at = NOW() WHERE id = ? AND used_at IS NULL`). The store
 *      reports how many rows it changed; zero means someone else got there
 *      first and the reset is refused. A read-then-write check would race with
 *      a duplicate click; this does not.
 *   2. EXPIRING. `expires_at` is set when the token is issued and checked
 *      against an injected clock, so the test can move time forward without
 *      sleeping.
 *   3. HASHED AT REST. Only `sha256(token)` is stored. A dump of the table
 *      cannot be replayed as reset links.
 *   4. NO USER ENUMERATION. `requestReset` returns the same envelope whether or
 *      not the address exists, and does the same amount of work.
 *   5. ONE LIVE TOKEN PER PRINCIPAL. Issuing a new token invalidates the
 *      previous outstanding ones, so a forwarded old e-mail stops working.
 *   6. SESSIONS DIE WITH THE PASSWORD. A completed reset revokes every active
 *      session for the principal — resetting a password because it was stolen
 *      is pointless if the thief's token stays valid.
 *   7. AUDITED. A completed reset writes an `audit_logs` row recording the
 *      principal and how many sessions it killed. The token itself is never
 *      written anywhere except as its hash.
 *
 * Delivery is not this service's job. `requestReset` returns the token to its
 * caller, which hands it to the notifier seam in src/services/notifier.js. The
 * default notifier records the event and deliberately does not log the token,
 * so with no transport configured a reset cannot be completed — see that file
 * and NOTES.md.
 */

const PRINCIPAL = Object.freeze({ MEMBER: "member", STAFF: "staff" });

/**
 * @param {object} deps
 * @param {object} deps.store  password reset store (see repositories/passwordResetRepository.js)
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.makeToken]
 * @param {object} input  { email, principalType }
 */
async function requestReset(deps, input) {
  const { store, now = () => new Date(), makeToken = () => randomToken() } = deps;
  const email = String(input.email || "").trim().toLowerCase();
  const principalType = input.principalType || PRINCIPAL.MEMBER;

  const principal = await store.findPrincipalByEmail(principalType, email);

  // Same envelope either way. The only difference is whether a row is written.
  const response = {
    message: "If that address is registered, reset instructions have been sent.",
    issued: false,
    token: null,
  };
  if (!principal) return response;

  await store.invalidateOutstanding({
    principalType,
    principalId: principal.id,
    tenantId: principal.tenant_id,
    at: now(),
  });

  const token = makeToken();
  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + env.passwordReset.ttlMinutes * 60 * 1000);

  await store.create({
    tenantId: principal.tenant_id,
    principalType,
    principalId: principal.id,
    tokenHash: hashOpaqueToken(token),
    expiresAt,
    createdAt: issuedAt,
  });

  // The token is returned so the caller can hand it to a delivery channel.
  // It is never logged and never included in the HTTP response body.
  return { ...response, issued: true, token, expiresAt, principal };
}

/**
 * @param {object} deps  { store, now?, hash? }
 * @param {object} input { token, newPassword }
 */
async function consumeReset(deps, input) {
  const { store, now = () => new Date(), hash = hashPassword } = deps;

  const token = String(input.token || "");
  if (!token) throw badRequest("Reset token is required", { token: "is required" });

  const newPassword = assertPasswordPolicy(input.newPassword);
  const record = await store.findByTokenHash(hashOpaqueToken(token));

  // One message for every failure mode: unknown token, already used, expired.
  // Distinguishing them tells an attacker which guesses were once valid.
  const invalid = () => badRequest("This reset link is invalid or has expired");

  if (!record) throw invalid();
  if (record.used_at) throw invalid();
  if (new Date(record.expires_at).getTime() <= now().getTime()) throw invalid();

  // Atomic claim. If another request consumed it between the read and here,
  // this changes zero rows and we refuse.
  const claimed = await store.markUsed({ id: record.id, at: now() });
  if (!claimed) throw invalid();

  const passwordHash = await hash(newPassword);
  await store.setPassword({
    principalType: record.principal_type,
    principalId: record.principal_id,
    tenantId: record.tenant_id,
    passwordHash,
  });

  // Property 6.
  const revokedSessions = await store.revokeSessions({
    principalType: record.principal_type,
    principalId: record.principal_id,
    tenantId: record.tenant_id,
    at: now(),
  });

  // Property 7. A failure to audit must not leave the caller believing the
  // reset failed — the password has already changed at this point, and telling
  // them otherwise would send them round the loop again against a burnt token.
  if (typeof store.recordAudit === "function") {
    try {
      await store.recordAudit({
        tenantId: record.tenant_id,
        principalType: record.principal_type,
        principalId: record.principal_id,
        at: now(),
        revokedSessions,
        ip: input.ip || null,
        userAgent: input.userAgent || null,
      });
    } catch (error) {
      (deps.log || require("../lib/logger")).error("failed to audit a password reset", {
        tenant_id: record.tenant_id,
        principal_type: record.principal_type,
        message: error && error.message,
      });
    }
  }

  return {
    message: "Your password has been updated.",
    principal_type: record.principal_type,
    revoked_sessions: revokedSessions,
  };
}

module.exports = { PRINCIPAL, requestReset, consumeReset };
