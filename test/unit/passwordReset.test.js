"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const passwordReset = require("../../src/services/passwordResetService");
const { hashOpaqueToken } = require("../../src/lib/tokens");
const { fixedClock } = require("../helpers/fakeDb");
const env = require("../../src/config/env");

/**
 * In-memory reset store with the same contract as
 * src/repositories/passwordResetRepository.js — including the conditional
 * update that makes markUsed() atomic.
 */
function makeStore(principals = []) {
  const tokens = [];
  const passwords = [];
  const revocations = [];
  let nextId = 1;

  return {
    tokens,
    passwords,
    revocations,

    async findPrincipalByEmail(principalType, email) {
      const hit = principals.find((p) => p.type === principalType && p.email === email);
      return hit ? { id: hit.id, tenant_id: hit.tenant_id, email: hit.email } : null;
    },

    async invalidateOutstanding({ principalType, principalId, tenantId, at }) {
      for (const token of tokens) {
        if (
          token.principal_type === principalType &&
          token.principal_id === principalId &&
          token.tenant_id === tenantId &&
          !token.used_at
        ) {
          token.used_at = at;
        }
      }
    },

    async create({ tenantId, principalType, principalId, tokenHash, expiresAt, createdAt }) {
      const row = {
        id: nextId++,
        tenant_id: tenantId,
        principal_type: principalType,
        principal_id: principalId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        used_at: null,
        created_at: createdAt,
      };
      tokens.push(row);
      return row.id;
    },

    async findByTokenHash(tokenHash) {
      const row = tokens.find((t) => t.token_hash === tokenHash);
      return row ? { ...row } : null;
    },

    // The conditional update. Mirrors `WHERE id = ? AND used_at IS NULL`.
    async markUsed({ id, at }) {
      const row = tokens.find((t) => t.id === id && t.used_at === null);
      if (!row) return false;
      row.used_at = at;
      return true;
    },

    async setPassword({ principalType, principalId, tenantId, passwordHash }) {
      passwords.push({ principalType, principalId, tenantId, passwordHash });
      return true;
    },

    async revokeSessions({ principalType, principalId, tenantId, at }) {
      revocations.push({ principalType, principalId, tenantId, at });
      return 2;
    },
  };
}

const PRINCIPALS = [
  { type: "member", id: 1, tenant_id: 1, email: "john.smith@example.com" },
  { type: "staff", id: 9, tenant_id: 2, email: "dave.owner@riverside.example.com" },
];

const STRONG_PASSWORD = "correct-horse-battery";

/* ------------------------------------------------------------------------ */

test("requesting a reset stores only the hash of the token", async () => {
  const store = makeStore(PRINCIPALS);
  const result = await passwordReset.requestReset(
    { store },
    { email: "john.smith@example.com", principalType: "member" }
  );

  assert.equal(result.issued, true);
  assert.equal(store.tokens.length, 1);

  const stored = store.tokens[0];
  assert.equal(stored.token_hash, hashOpaqueToken(result.token));
  assert.notEqual(stored.token_hash, result.token, "the raw token must not be stored");
  assert.equal(stored.token_hash.length, 64);
  assert.equal(stored.tenant_id, 1);
});

test("an unknown address produces the same response and writes nothing", async () => {
  const store = makeStore(PRINCIPALS);
  const known = await passwordReset.requestReset(
    { store },
    { email: "john.smith@example.com", principalType: "member" }
  );
  const unknown = await passwordReset.requestReset(
    { store },
    { email: "nobody@example.com", principalType: "member" }
  );

  assert.equal(known.message, unknown.message);
  assert.equal(unknown.issued, false);
  assert.equal(unknown.token, null);
  assert.equal(store.tokens.length, 1, "no row for the unknown address");
});

test("a reset token works exactly once", async () => {
  const store = makeStore(PRINCIPALS);
  const { token } = await passwordReset.requestReset(
    { store },
    { email: "john.smith@example.com", principalType: "member" }
  );

  const first = await passwordReset.consumeReset({ store }, { token, newPassword: STRONG_PASSWORD });
  assert.match(first.message, /updated/i);
  assert.equal(store.passwords.length, 1);

  await assert.rejects(
    () => passwordReset.consumeReset({ store }, { token, newPassword: "another-password-x" }),
    (error) => error.status === 400 && /invalid or has expired/i.test(error.message)
  );
  assert.equal(store.passwords.length, 1, "the second attempt must not change the password again");
});

test("two simultaneous uses of the same token: only one wins", async () => {
  const store = makeStore(PRINCIPALS);
  const { token } = await passwordReset.requestReset(
    { store },
    { email: "john.smith@example.com", principalType: "member" }
  );

  const results = await Promise.allSettled([
    passwordReset.consumeReset({ store }, { token, newPassword: STRONG_PASSWORD }),
    passwordReset.consumeReset({ store }, { token, newPassword: "second-attempt-pw" }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.equal(fulfilled.length, 1);
  assert.equal(store.passwords.length, 1);
});

test("a reset token expires", async () => {
  const store = makeStore(PRINCIPALS);
  const clock = fixedClock("2026-08-25T10:00:00Z");

  const { token, expiresAt } = await passwordReset.requestReset(
    { store, now: clock.now },
    { email: "john.smith@example.com", principalType: "member" }
  );

  assert.equal(
    new Date(expiresAt).getTime() - new Date("2026-08-25T10:00:00Z").getTime(),
    env.passwordReset.ttlMinutes * 60 * 1000
  );

  // Just before expiry: still valid.
  clock.advanceMinutes(env.passwordReset.ttlMinutes - 1);
  const store2 = makeStore(PRINCIPALS);
  await assert.doesNotReject(async () => {
    const clock2 = fixedClock("2026-08-25T10:00:00Z");
    const issued = await passwordReset.requestReset(
      { store: store2, now: clock2.now },
      { email: "john.smith@example.com", principalType: "member" }
    );
    clock2.advanceMinutes(env.passwordReset.ttlMinutes - 1);
    return passwordReset.consumeReset(
      { store: store2, now: clock2.now },
      { token: issued.token, newPassword: STRONG_PASSWORD }
    );
  });

  // Past expiry: refused.
  clock.advanceMinutes(2);
  await assert.rejects(
    () => passwordReset.consumeReset({ store, now: clock.now }, { token, newPassword: STRONG_PASSWORD }),
    (error) => error.status === 400 && /invalid or has expired/i.test(error.message)
  );
  assert.equal(store.passwords.length, 0);
});

test("issuing a new token invalidates the previous one", async () => {
  const store = makeStore(PRINCIPALS);
  const first = await passwordReset.requestReset(
    { store },
    { email: "john.smith@example.com", principalType: "member" }
  );
  const second = await passwordReset.requestReset(
    { store },
    { email: "john.smith@example.com", principalType: "member" }
  );

  await assert.rejects(
    () => passwordReset.consumeReset({ store }, { token: first.token, newPassword: STRONG_PASSWORD }),
    (error) => error.status === 400
  );
  await assert.doesNotReject(() =>
    passwordReset.consumeReset({ store }, { token: second.token, newPassword: STRONG_PASSWORD })
  );
});

test("an unknown token is refused with the same message as an expired one", async () => {
  const store = makeStore(PRINCIPALS);
  const messages = new Set();

  const { token } = await passwordReset.requestReset(
    { store },
    { email: "john.smith@example.com", principalType: "member" }
  );
  await passwordReset.consumeReset({ store }, { token, newPassword: STRONG_PASSWORD });

  for (const candidate of ["completely-made-up-token", token]) {
    try {
      await passwordReset.consumeReset({ store }, { token: candidate, newPassword: STRONG_PASSWORD });
      assert.fail("expected a rejection");
    } catch (error) {
      messages.add(error.message);
    }
  }
  assert.equal(messages.size, 1);
});

test("the new password must satisfy the length policy", async () => {
  const store = makeStore(PRINCIPALS);
  const { token } = await passwordReset.requestReset(
    { store },
    { email: "john.smith@example.com", principalType: "member" }
  );

  await assert.rejects(
    () => passwordReset.consumeReset({ store }, { token, newPassword: "short" }),
    (error) => error.status === 400 && Boolean(error.details && error.details.password)
  );
  assert.equal(store.tokens[0].used_at, null, "a policy failure must not burn the token");
});

test("the stored password is a bcrypt hash, not the plaintext", async () => {
  const store = makeStore(PRINCIPALS);
  const { token } = await passwordReset.requestReset(
    { store },
    { email: "john.smith@example.com", principalType: "member" }
  );
  await passwordReset.consumeReset({ store }, { token, newPassword: STRONG_PASSWORD });

  const written = store.passwords[0].passwordHash;
  assert.notEqual(written, STRONG_PASSWORD);
  assert.match(written, /^\$2[aby]\$\d{2}\$/);
});

test("a completed reset revokes the principal's sessions", async () => {
  const store = makeStore(PRINCIPALS);
  const { token } = await passwordReset.requestReset(
    { store },
    { email: "dave.owner@riverside.example.com", principalType: "staff" }
  );
  await passwordReset.consumeReset({ store }, { token, newPassword: STRONG_PASSWORD });

  assert.equal(store.revocations.length, 1);
  assert.equal(store.revocations[0].principalType, "staff");
  assert.equal(store.revocations[0].principalId, 9);
  assert.equal(store.revocations[0].tenantId, 2);
});

test("the tenant travels with the token, so the password write stays scoped", async () => {
  const store = makeStore(PRINCIPALS);
  const { token } = await passwordReset.requestReset(
    { store },
    { email: "dave.owner@riverside.example.com", principalType: "staff" }
  );
  await passwordReset.consumeReset({ store }, { token, newPassword: STRONG_PASSWORD });

  assert.equal(store.passwords[0].tenantId, 2);
  assert.equal(store.passwords[0].principalId, 9);
});

/* ---------------------------------------------------------------------------
 * audit trail
 * ------------------------------------------------------------------------ */

test("a completed reset writes an audit row without the token", async () => {
  const store = makeStore(PRINCIPALS);
  const audited = [];
  store.recordAudit = async (entry) => {
    audited.push(entry);
    return 1;
  };

  const { token } = await passwordReset.requestReset(
    { store },
    { email: "john.smith@example.com", principalType: "member" }
  );
  await passwordReset.consumeReset(
    { store },
    { token, newPassword: STRONG_PASSWORD, ip: "203.0.113.9", userAgent: "curl/8" }
  );

  assert.equal(audited.length, 1);
  const entry = audited[0];
  assert.equal(entry.tenantId, 1);
  assert.equal(entry.principalType, "member");
  assert.equal(entry.principalId, 1);
  assert.equal(entry.ip, "203.0.113.9");
  assert.equal(entry.revokedSessions, 2);

  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes(token), "the reset token must not reach the audit trail");
  assert.ok(!serialized.includes(STRONG_PASSWORD), "the new password must not reach it either");
});

test("a failed reset writes no audit row", async () => {
  const store = makeStore(PRINCIPALS);
  const audited = [];
  store.recordAudit = async (entry) => audited.push(entry);

  await assert.rejects(
    () => passwordReset.consumeReset({ store }, { token: "made-up", newPassword: STRONG_PASSWORD }),
    (error) => error.status === 400
  );
  assert.equal(audited.length, 0);
});

test("an audit failure does not fail the reset — the password has already changed", async () => {
  const store = makeStore(PRINCIPALS);
  const logged = [];
  store.recordAudit = async () => {
    throw new Error("audit table unavailable");
  };

  const { token } = await passwordReset.requestReset(
    { store },
    { email: "john.smith@example.com", principalType: "member" }
  );

  const result = await passwordReset.consumeReset(
    {
      store,
      log: { error: (message, context) => logged.push({ message, context }), info() {}, warn() {}, debug() {} },
    },
    { token, newPassword: STRONG_PASSWORD }
  );

  assert.match(result.message, /updated/i);
  assert.equal(store.passwords.length, 1, "the password write stands");
  assert.equal(logged.length, 1);
  assert.match(logged[0].message, /failed to audit/);
});

test("the service still works against a store with no recordAudit method", async () => {
  const store = makeStore(PRINCIPALS);
  delete store.recordAudit;
  const { token } = await passwordReset.requestReset(
    { store },
    { email: "john.smith@example.com", principalType: "member" }
  );
  await assert.doesNotReject(() =>
    passwordReset.consumeReset({ store }, { token, newPassword: STRONG_PASSWORD })
  );
});

test("the reset result reports how many sessions it killed", async () => {
  const store = makeStore(PRINCIPALS);
  const { token } = await passwordReset.requestReset(
    { store },
    { email: "john.smith@example.com", principalType: "member" }
  );
  const result = await passwordReset.consumeReset({ store }, { token, newPassword: STRONG_PASSWORD });
  assert.equal(result.revoked_sessions, 2);
});
