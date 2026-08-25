"use strict";

/**
 * Unscoped queries — the deliberate escape hatch.
 *
 * A handful of operations genuinely run before a tenant is known:
 *
 *   - resolving a login e-mail to a credential row (we cannot scope by tenant
 *     until we know who is logging in);
 *   - resolving a password-reset token hash to its owner;
 *   - the health check's `SELECT 1`.
 *
 * Rather than let those be written as ordinary queries — which would defeat the
 * point of the tenant scope — they go through this module, which:
 *
 *   1. requires a named purpose from a fixed allow-list, so every unscoped
 *      query in the codebase is enumerable by reading this file;
 *   2. logs at debug level with the purpose attached;
 *   3. is named `unscopedQuery` so it stands out in review and in grep.
 *
 * Adding a new unscoped query requires editing UNSCOPED_PURPOSES here. That is
 * intentional friction.
 */

const { getPool } = require("../config/db");
const logger = require("../lib/logger");

const UNSCOPED_PURPOSES = Object.freeze({
  /** Find the member credential for a login e-mail, across all tenants. */
  RESOLVE_MEMBER_LOGIN: "resolve_member_login",
  /** Find the staff user for a login e-mail, across all tenants. */
  RESOLVE_STAFF_LOGIN: "resolve_staff_login",
  /** Find a password reset token by its hash. Tokens are globally unique. */
  RESOLVE_RESET_TOKEN: "resolve_reset_token",
  /** Consume a password reset token (single-use update guarded by used_at). */
  CONSUME_RESET_TOKEN: "consume_reset_token",
  /** Write the new password hash for a principal identified by a reset token. */
  APPLY_RESET_PASSWORD: "apply_reset_password",
  /** Record a login attempt outcome on the credential row. */
  RECORD_LOGIN_ATTEMPT: "record_login_attempt",
  /**
   * Write the audit row for a completed password reset. Unscoped for the same
   * reason as the rest of this flow: the caller is not logged in, so there is
   * no tenant scope to write through. The tenant comes from the token record.
   */
  AUDIT_PASSWORD_RESET: "audit_password_reset",
  /** Liveness probe. */
  HEALTH_CHECK: "health_check",
  /** CLI provisioning scripts (never reachable over HTTP). */
  CLI_PROVISIONING: "cli_provisioning",
});

const ALLOWED = new Set(Object.values(UNSCOPED_PURPOSES));

class UnscopedQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnscopedQueryError";
  }
}

function assertPurpose(purpose) {
  if (!ALLOWED.has(purpose)) {
    throw new UnscopedQueryError(
      `Unknown unscoped-query purpose ${JSON.stringify(purpose)}. Unscoped ` +
        "queries must be declared in UNSCOPED_PURPOSES in src/data/global.js. " +
        "If this query has a tenant, use the request's tenant scope instead."
    );
  }
}

/**
 * @param {string} purpose  One of UNSCOPED_PURPOSES.
 * @param {string} sql      Parameterised SQL.
 * @param {unknown[]} params
 * @param {{ execute: Function }} [executor]  Injectable for tests.
 */
async function unscopedQuery(purpose, sql, params = [], executor = null) {
  assertPurpose(purpose);
  logger.debug("unscoped query", { purpose });
  const target = executor || getPool();
  const [rows] = await target.execute(sql, params);
  return rows;
}

async function unscopedQueryOne(purpose, sql, params = [], executor = null) {
  const rows = await unscopedQuery(purpose, sql, params, executor);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

module.exports = {
  UNSCOPED_PURPOSES,
  UnscopedQueryError,
  unscopedQuery,
  unscopedQueryOne,
  assertPurpose,
};
