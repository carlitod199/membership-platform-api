"use strict";

const { unscopedQuery, unscopedQueryOne, UNSCOPED_PURPOSES } = require("../data/global");

/**
 * Password reset store.
 *
 * This is the one repository that cannot take a tenant scope. A reset link is
 * clicked by someone who is not logged in — there is no token, so there is no
 * tenant, so a scope cannot be built. Every statement here therefore goes
 * through src/data/global.js with a declared purpose, which keeps the set of
 * unscoped queries in the codebase small and enumerable.
 *
 * The tenant is still recorded on every row and carried forward: once a token
 * resolves to a principal we know the tenant, and the subsequent password write
 * is constrained by it.
 *
 * @param {{ execute: Function }} [executor] injectable for tests
 */
function createPasswordResetRepository(executor = null) {
  return {
    /** Resolve a login e-mail to a principal, across all tenants. */
    async findPrincipalByEmail(principalType, email) {
      if (principalType === "staff") {
        return unscopedQueryOne(
          UNSCOPED_PURPOSES.RESOLVE_STAFF_LOGIN,
          `SELECT id, tenant_id, email FROM users
            WHERE email = ? AND status = 'active' AND deleted_at IS NULL
            LIMIT 1`,
          [email],
          executor
        );
      }
      return unscopedQueryOne(
        UNSCOPED_PURPOSES.RESOLVE_MEMBER_LOGIN,
        `SELECT id, tenant_id, login_email AS email FROM member_credentials
          WHERE login_email = ? AND status IN ('active', 'pending_activation') AND deleted_at IS NULL
          LIMIT 1`,
        [email],
        executor
      );
    },

    /** Burn any outstanding tokens so only the newest link works. */
    async invalidateOutstanding({ principalType, principalId, tenantId, at }) {
      await unscopedQuery(
        UNSCOPED_PURPOSES.CONSUME_RESET_TOKEN,
        `UPDATE password_reset_tokens
            SET used_at = ?
          WHERE tenant_id = ? AND principal_type = ? AND principal_id = ? AND used_at IS NULL`,
        [at, tenantId, principalType, principalId],
        executor
      );
    },

    async create({ tenantId, principalType, principalId, tokenHash, expiresAt, createdAt }) {
      const result = await unscopedQuery(
        UNSCOPED_PURPOSES.CONSUME_RESET_TOKEN,
        `INSERT INTO password_reset_tokens
           (tenant_id, principal_type, principal_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tenantId, principalType, principalId, tokenHash, expiresAt, createdAt],
        executor
      );
      return result && result.insertId ? result.insertId : null;
    },

    async findByTokenHash(tokenHash) {
      return unscopedQueryOne(
        UNSCOPED_PURPOSES.RESOLVE_RESET_TOKEN,
        `SELECT id, tenant_id, principal_type, principal_id, expires_at, used_at
           FROM password_reset_tokens
          WHERE token_hash = ?
          LIMIT 1`,
        [tokenHash],
        executor
      );
    },

    /**
     * Atomically claim the token. The `used_at IS NULL` predicate is what makes
     * the token single-use under concurrency: the loser of the race updates
     * zero rows and gets `false`.
     */
    async markUsed({ id, at }) {
      const result = await unscopedQuery(
        UNSCOPED_PURPOSES.CONSUME_RESET_TOKEN,
        `UPDATE password_reset_tokens SET used_at = ?
          WHERE id = ? AND used_at IS NULL`,
        [at, id],
        executor
      );
      return Boolean(result && result.affectedRows > 0);
    },

    async setPassword({ principalType, principalId, tenantId, passwordHash }) {
      const table = principalType === "staff" ? "users" : "member_credentials";
      const result = await unscopedQuery(
        UNSCOPED_PURPOSES.APPLY_RESET_PASSWORD,
        // `table` is chosen from a two-value literal above, never from input.
        `UPDATE ${table}
            SET password_hash = ?, failed_attempts = 0, status = 'active'
          WHERE id = ? AND tenant_id = ?`,
        [passwordHash, principalId, tenantId],
        executor
      );
      return Boolean(result && result.affectedRows > 0);
    },

    /**
     * Audit the completed reset.
     *
     * Not inside a transaction with the password write, unlike every other
     * audit record in this codebase. The reason is stated rather than hidden:
     * this path has no tenant scope and therefore no transaction helper, and
     * the alternative — plumbing a pooled connection through the unscoped
     * layer — would widen the escape hatch for one row. The consequence is a
     * narrow window in which a password change could commit without its audit
     * record. Accepted here; not acceptable for the approval workflows, which
     * do use a transaction.
     */
    async recordAudit({ tenantId, principalType, principalId, at, revokedSessions, ip, userAgent }) {
      const result = await unscopedQuery(
        UNSCOPED_PURPOSES.AUDIT_PASSWORD_RESET,
        `INSERT INTO audit_logs
           (tenant_id, actor_type, actor_id, action, entity, entity_id, metadata,
            ip_address, user_agent, created_at)
         VALUES (?, ?, ?, 'password_reset.completed', 'credential', ?, ?, ?, ?, ?)`,
        [
          tenantId,
          principalType,
          principalId,
          principalId,
          JSON.stringify({
            principal_type: principalType,
            revoked_sessions: revokedSessions === undefined ? null : revokedSessions,
          }),
          ip ? String(ip).slice(0, 45) : null,
          userAgent ? String(userAgent).slice(0, 255) : null,
          at,
        ],
        executor
      );
      return result && result.insertId ? result.insertId : null;
    },

    /** A password change invalidates every session the principal had open. */
    async revokeSessions({ principalType, principalId, tenantId, at }) {
      const result = await unscopedQuery(
        UNSCOPED_PURPOSES.APPLY_RESET_PASSWORD,
        `UPDATE auth_sessions SET revoked_at = ?
          WHERE tenant_id = ? AND principal_type = ? AND principal_id = ? AND revoked_at IS NULL`,
        [at, tenantId, principalType, principalId],
        executor
      );
      return result && result.affectedRows ? result.affectedRows : 0;
    },
  };
}

module.exports = { createPasswordResetRepository };
