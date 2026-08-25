"use strict";

const { unscopedQuery, unscopedQueryOne, UNSCOPED_PURPOSES } = require("../data/global");

/**
 * Login credential lookup — the other unavoidably unscoped path.
 *
 * At login time the client has supplied an e-mail address and nothing else. The
 * tenant is a *result* of the lookup, not an input to it. Accepting a tenant
 * hint from the client here would reintroduce exactly the trust we removed
 * everywhere else, so we do not: the credential row decides which tenant the
 * resulting token is bound to.
 *
 * Consequence, stated plainly: login e-mail addresses are unique across the
 * whole installation, not per tenant. The same person joining two associations
 * needs two addresses. The alternative (tenant selected by subdomain or an
 * explicit tenant field) is discussed in docs/architecture.md; this repository
 * would change shape, the rest of the system would not.
 */
function createCredentialRepository(executor = null) {
  return {
    async findMemberCredential(loginEmail) {
      return unscopedQueryOne(
        UNSCOPED_PURPOSES.RESOLVE_MEMBER_LOGIN,
        `SELECT c.id, c.tenant_id, c.member_id, c.dependent_id, c.login_email,
                c.password_hash, c.status, c.failed_attempts, t.status AS tenant_status
           FROM member_credentials c
           JOIN tenants t ON t.id = c.tenant_id
          WHERE c.login_email = ? AND c.deleted_at IS NULL
          LIMIT 1`,
        [loginEmail],
        executor
      );
    },

    async findStaffUser(email) {
      return unscopedQueryOne(
        UNSCOPED_PURPOSES.RESOLVE_STAFF_LOGIN,
        `SELECT u.id, u.tenant_id, u.role_id, u.full_name, u.email, u.password_hash,
                u.status, u.failed_attempts, r.role_key, t.status AS tenant_status
           FROM users u
           JOIN roles r ON r.id = u.role_id AND r.tenant_id = u.tenant_id
           JOIN tenants t ON t.id = u.tenant_id
          WHERE u.email = ? AND u.deleted_at IS NULL
          LIMIT 1`,
        [email],
        executor
      );
    },

    async recordFailure(table, id) {
      const target = table === "users" ? "users" : "member_credentials";
      await unscopedQuery(
        UNSCOPED_PURPOSES.RECORD_LOGIN_ATTEMPT,
        `UPDATE ${target} SET failed_attempts = failed_attempts + 1 WHERE id = ?`,
        [id],
        executor
      );
    },

    async recordSuccess(table, id) {
      const target = table === "users" ? "users" : "member_credentials";
      await unscopedQuery(
        UNSCOPED_PURPOSES.RECORD_LOGIN_ATTEMPT,
        `UPDATE ${target}
            SET last_login_at = NOW(), failed_attempts = 0,
                status = IF(status = 'pending_activation', 'active', status)
          WHERE id = ?`,
        [id],
        executor
      );
    },
  };
}

module.exports = { createCredentialRepository };
