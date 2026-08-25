"use strict";

const bcrypt = require("bcryptjs");
const env = require("./../config/env");
const { badRequest } = require("./errors");

/**
 * Password hashing.
 *
 * bcrypt via bcryptjs — pure JS, so `npm install` works on any platform without
 * a build toolchain, which matters for a portfolio repo someone will clone.
 * argon2id is the better primitive; the trade-off (native build vs. install
 * friction) is written up in docs/architecture.md. Cost factor is configurable
 * so it can be raised without a code change.
 *
 * Non-negotiables enforced here:
 *   - passwords are never stored, logged or returned;
 *   - verification always runs a bcrypt comparison, even for an unknown user,
 *     so response timing does not disclose whether an account exists.
 */

// A real bcrypt hash of a value nobody can supply. Used to burn the same amount
// of CPU on a miss as on a hit.
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.7dRsNL6Y5jd5cD1nlLcSJvSGSGpOn3O";

function hashPassword(plain) {
  return bcrypt.hash(String(plain), env.password.bcryptRounds);
}

/**
 * @param {string} plain
 * @param {string|null} hash  Pass null when the account was not found.
 * @returns {Promise<boolean>}
 */
async function verifyPassword(plain, hash) {
  if (!hash) {
    await bcrypt.compare(String(plain), DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(String(plain), hash);
}

/**
 * Reject passwords that are trivially weak. Length is the only rule that is
 * worth enforcing server-side without a breach corpus; composition rules push
 * users toward predictable substitutions.
 */
function assertPasswordPolicy(plain) {
  const value = String(plain || "");
  if (value.length < env.password.minLength) {
    throw badRequest("Password does not meet the policy", {
      password: `must be at least ${env.password.minLength} characters`,
    });
  }
  if (value.length > 200) {
    throw badRequest("Password does not meet the policy", { password: "must be at most 200 characters" });
  }
  return value;
}

/** True when the stored hash was produced with a weaker cost than current config. */
function needsRehash(hash) {
  const match = /^\$2[aby]\$(\d{2})\$/.exec(String(hash || ""));
  if (!match) return true;
  return Number(match[1]) < env.password.bcryptRounds;
}

module.exports = { hashPassword, verifyPassword, assertPasswordPolicy, needsRehash };
