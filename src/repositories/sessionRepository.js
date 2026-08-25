"use strict";

/**
 * Auth sessions.
 *
 * A JWT is self-contained and cannot be un-issued, which makes "log out" and
 * "revoke this device" meaningless on their own. One row per issued token, keyed
 * by the token's `jti`, gives the system a revocation list; the auth middleware
 * checks it on every request (configurable via ENFORCE_SESSION_REVOCATION).
 *
 * Cost: one indexed lookup per authenticated request. The alternative — pure
 * stateless JWTs — trades that lookup for tokens that stay valid after a
 * password reset or a stolen device is reported. Discussed in
 * docs/architecture.md.
 */
function createSessionRepository(scope) {
  return {
    async create({ tokenId, principalType, principalId, expiresAt, userAgent, ip }) {
      const result = await scope.insert("auth_sessions", {
        token_id: tokenId,
        principal_type: principalType,
        principal_id: principalId,
        expires_at: expiresAt,
        user_agent: userAgent ? String(userAgent).slice(0, 255) : null,
        ip_address: ip ? String(ip).slice(0, 45) : null,
      });
      return result.insertId;
    },

    async findByTokenId(tokenId) {
      return scope.selectOne(
        `SELECT id, token_id, principal_type, principal_id, revoked_at, expires_at
           FROM auth_sessions
          WHERE tenant_id = :tenant AND token_id = ?
          LIMIT 1`,
        [tokenId]
      );
    },

    async listActive({ principalType, principalId }) {
      return scope.select(
        `SELECT id, token_id, user_agent, ip_address, created_at, last_seen_at, expires_at
           FROM auth_sessions
          WHERE tenant_id = :tenant AND principal_type = ? AND principal_id = ?
            AND revoked_at IS NULL AND expires_at > NOW()
          ORDER BY created_at DESC`,
        [principalType, principalId]
      );
    },

    async revokeByTokenId(tokenId) {
      const result = await scope.execute(
        `UPDATE auth_sessions SET revoked_at = NOW()
          WHERE tenant_id = :tenant AND token_id = ? AND revoked_at IS NULL`,
        [tokenId]
      );
      return result.affectedRows > 0;
    },

    /** Revoke one session by row id, but only if it belongs to this principal. */
    async revokeById({ id, principalType, principalId }) {
      const result = await scope.execute(
        `UPDATE auth_sessions SET revoked_at = NOW()
          WHERE id = ? AND tenant_id = :tenant AND principal_type = ? AND principal_id = ?
            AND revoked_at IS NULL`,
        [id, principalType, principalId]
      );
      return result.affectedRows > 0;
    },

    async revokeAllFor({ principalType, principalId }) {
      const result = await scope.execute(
        `UPDATE auth_sessions SET revoked_at = NOW()
          WHERE tenant_id = :tenant AND principal_type = ? AND principal_id = ?
            AND revoked_at IS NULL`,
        [principalType, principalId]
      );
      return result.affectedRows;
    },
  };
}

module.exports = { createSessionRepository };
