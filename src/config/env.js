"use strict";

require("dotenv").config();

/**
 * Central, typed view of every environment variable the process reads.
 *
 * Rule: no other file in the codebase touches `process.env` directly (the only
 * exceptions are the standalone CLI scripts, which load this module too). That
 * keeps `.env.example` provably complete — grep for `process.env` and you get
 * this file and nothing else.
 */

const bool = (value, fallback) => {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const list = (value, fallback) =>
  String(value === undefined || value === "" ? fallback : value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Express `trust proxy`. Accepts:
 *   - a number  ("1", "2")  — trust that many hops closest to the server
 *   - "false"               — trust nothing; req.ip is the socket address
 *   - "true"                — trust everything (rejected in production; a
 *                             client can then forge its own address)
 *   - a comma-separated list of addresses, CIDRs or the named presets Express
 *     understands ("loopback", "linklocal", "uniquelocal")
 *
 * This has to match the real topology. One hop wrong in either direction breaks
 * the rate limiter: too low and every request behind the proxy shares one
 * bucket; too high and a client can forge X-Forwarded-For for a fresh bucket
 * per request.
 */
const trustProxy = (raw) => {
  const value = String(raw === undefined || raw === "" ? "1" : raw).trim();
  if (value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  const entries = value.split(",").map((s) => s.trim()).filter(Boolean);
  return entries.length === 1 ? entries[0] : entries;
};

const nodeEnv = process.env.NODE_ENV || "development";

// The node:test runner sets NODE_TEST_CONTEXT in every worker it spawns. Using
// it to silence logging means `npm test` is quiet without the test script
// having to set NODE_ENV, which would not be portable across shells.
const underTestRunner = Boolean(process.env.NODE_TEST_CONTEXT);

const env = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  isTest: nodeEnv === "test" || underTestRunner,
  port: int(process.env.PORT, 4000),
  apiPrefix: process.env.API_PREFIX || "/api/v1",
  corsOrigins: list(process.env.CORS_ORIGINS, "*"),
  shutdownTimeoutMs: int(process.env.SHUTDOWN_TIMEOUT_MS, 10000),
  trustProxy: trustProxy(process.env.TRUST_PROXY),

  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "membership_platform",
    connectionLimit: int(process.env.DB_CONNECTION_LIMIT, 10),
  },

  jwt: {
    secret: process.env.JWT_SECRET || "development-only-secret-change-me",
    issuer: process.env.JWT_ISSUER || "membership-platform-api",
    memberExpires: process.env.JWT_MEMBER_EXPIRES || "7d",
    staffExpires: process.env.JWT_STAFF_EXPIRES || "12h",
  },

  password: {
    bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),
    minLength: int(process.env.PASSWORD_MIN_LENGTH, 10),
    maxFailedAttempts: int(process.env.MAX_FAILED_LOGIN_ATTEMPTS, 10),
  },

  passwordReset: {
    tokenBytes: int(process.env.RESET_TOKEN_BYTES, 32),
    ttlMinutes: int(process.env.RESET_TOKEN_TTL_MINUTES, 60),
  },

  rateLimit: {
    windowMs: int(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    max: int(process.env.AUTH_RATE_LIMIT_MAX, 20),
  },

  /**
   * Approval policy. Which staff role *keys* may sign off each workflow.
   * Deliberately an operator-controlled deployment setting rather than a
   * hardcoded list — see docs/architecture.md, "Approval workflows".
   */
  approvals: {
    booking: list(process.env.BOOKING_APPROVER_ROLES, "owner,administrator,front_desk"),
    profile_change: list(process.env.PROFILE_CHANGE_APPROVER_ROLES, "owner,administrator,membership_officer"),
  },

  /** Fields a member is allowed to request a change to. Anything else is dropped. */
  memberEditableFields: list(
    process.env.MEMBER_EDITABLE_FIELDS,
    "email,phone,mobile,address_line1,address_line2,city,state,postal_code"
  ),

  log: {
    level: process.env.LOG_LEVEL || (nodeEnv === "test" || underTestRunner ? "silent" : "info"),
    pretty: bool(process.env.LOG_PRETTY, nodeEnv === "development"),
  },

  sessions: {
    /** Check the auth_sessions table on every authenticated request. */
    enforceRevocation: bool(process.env.ENFORCE_SESSION_REVOCATION, true),
  },
};

/**
 * Fail fast in production on anything that would be a security hole.
 * Called from server.js, not at import time, so tests can import env freely.
 */
function assertProductionSafety() {
  const problems = [];
  if (env.isProduction) {
    if (!process.env.JWT_SECRET) problems.push("JWT_SECRET must be set in production");
    else if (process.env.JWT_SECRET.length < 32) problems.push("JWT_SECRET must be at least 32 characters");
    if (!process.env.DB_PASSWORD) problems.push("DB_PASSWORD must be set in production");
    if (env.corsOrigins.includes("*")) problems.push("CORS_ORIGINS must not be '*' in production");
    if (env.password.bcryptRounds < 10) problems.push("BCRYPT_ROUNDS must be >= 10");
    if (env.trustProxy === true) {
      problems.push(
        "TRUST_PROXY must not be 'true' in production: trusting every hop lets a " +
          "client forge X-Forwarded-For and bypass the rate limiter"
      );
    }
  }
  return problems;
}

module.exports = env;
module.exports.assertProductionSafety = assertProductionSafety;
module.exports.parseTrustProxy = trustProxy;
