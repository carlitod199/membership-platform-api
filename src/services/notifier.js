"use strict";

const logger = require("../lib/logger");

/**
 * Outbound notification seam.
 *
 * This service issues password reset tokens but has no way to deliver them.
 * Rather than leave a `// TODO: send an e-mail` in two route handlers, the
 * integration point is this one named module: an interface with a single
 * method, a default implementation, and a setter.
 *
 * WHAT THE DEFAULT DOES — AND DELIBERATELY DOES NOT DO
 * ---------------------------------------------------
 * `createLoggingNotifier()` records that a reset was issued (tenant, principal
 * type, expiry) and **does not log the token**. That is not an oversight. A
 * reset token is a bearer credential; writing it to the log store turns the log
 * store into a credential store, which is the exact thing src/lib/logger.js
 * redacts against. The consequence is stated plainly rather than worked around:
 *
 *   With the default notifier, the password reset flow cannot be completed.
 *   A deployment must call setNotifier() with a real transport.
 *
 * REPLACING IT
 * ------------
 * Implement `sendPasswordReset(message)` and register it once at startup:
 *
 *   const { setNotifier } = require("./services/notifier");
 *   setNotifier({
 *     async sendPasswordReset({ email, token, expiresAt, principalType }) {
 *       await myMailer.send({ to: email, template: "reset", data: { token, expiresAt } });
 *     },
 *   });
 *
 * Nothing else in the codebase changes. The two call sites — the member and
 * staff forgot-password handlers — already go through getNotifier().
 *
 * WHY DELIVERY FAILURES DO NOT FAIL THE REQUEST
 * --------------------------------------------
 * `deliverPasswordReset()` swallows and logs transport errors. If a mail outage
 * turned into a 500 while an unknown address still returned 200, the difference
 * would be a user-enumeration oracle. The generic envelope has to hold whatever
 * the transport does.
 */

/**
 * @typedef {object} PasswordResetMessage
 * @property {string} email          Where to deliver.
 * @property {string} token          The raw reset token. Never log this.
 * @property {Date}   expiresAt      When the token stops working.
 * @property {"member"|"staff"} principalType
 * @property {number} tenantId
 * @property {number} principalId
 */

/**
 * @typedef {object} Notifier
 * @property {(message: PasswordResetMessage) => Promise<void>} sendPasswordReset
 */

/** The shipped default. Records the event; never records the token. */
function createLoggingNotifier(log = logger) {
  return {
    async sendPasswordReset(message) {
      log.info("password reset issued (no transport configured, token not delivered)", {
        tenant_id: message.tenantId,
        principal_type: message.principalType,
        principal_id: message.principalId,
        expires_at: message.expiresAt,
      });
    },
  };
}

let current = createLoggingNotifier();

/** The notifier in force. Call sites use this rather than importing a concrete one. */
function getNotifier() {
  return current;
}

/**
 * Register a transport. Called once at startup, and by tests.
 * @param {Notifier} notifier
 */
function setNotifier(notifier) {
  if (!notifier || typeof notifier.sendPasswordReset !== "function") {
    throw new Error("A notifier must implement sendPasswordReset(message)");
  }
  current = notifier;
  return current;
}

/** Restore the default. Exists so a test can undo setNotifier(). */
function resetNotifier() {
  current = createLoggingNotifier();
  return current;
}

/**
 * Hand a reset message to the active notifier, absorbing transport failures.
 * See "why delivery failures do not fail the request" above.
 */
async function deliverPasswordReset(message, log = logger) {
  try {
    await getNotifier().sendPasswordReset(message);
    return true;
  } catch (error) {
    log.error("password reset delivery failed", {
      tenant_id: message.tenantId,
      principal_type: message.principalType,
      message: error && error.message,
    });
    return false;
  }
}

module.exports = {
  createLoggingNotifier,
  getNotifier,
  setNotifier,
  resetNotifier,
  deliverPasswordReset,
};
