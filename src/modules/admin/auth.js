"use strict";

const express = require("express");

const { asyncHandler, ok } = require("../../lib/http");
const { validate } = require("../../lib/validate");
const { unauthorized } = require("../../lib/errors");
const { verifyPassword } = require("../../lib/passwords");
const { signStaffToken, newSessionId } = require("../../lib/tokens");
const { requireStaff } = require("../../middleware/authenticate");
const { createTenantScope } = require("../../data/tenantScope");
const { poolExecutor } = require("../../config/db");
const { createRepositories, repositoriesFor } = require("../../repositories");
const { ACTIONS, ENTITIES } = require("../../repositories/auditRepository");
const { createCredentialRepository } = require("../../repositories/credentialRepository");
const { createPasswordResetRepository } = require("../../repositories/passwordResetRepository");
const passwordReset = require("../../services/passwordResetService");
const { deliverPasswordReset } = require("../../services/notifier");
const env = require("../../config/env");
const logger = require("../../lib/logger");

const router = express.Router();

const STAFF_EXPIRY_MS = 12 * 60 * 60 * 1000;

/**
 * Staff authentication.
 *
 * Separate from the member login on purpose. Same mechanics, different token
 * scope, different expiry (12h vs 7d), different route tree. A single "login"
 * endpoint that branches on the account type it happens to find is how a member
 * ends up holding a token that a `/admin` route accepts.
 */

// POST /admin/auth/login
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const input = validate(req.body, {
      email: { required: true, type: "email" },
      password: { required: true, type: "string", maxLength: 200 },
    });

    const credentials = createCredentialRepository();
    const user = await credentials.findStaffUser(input.email);
    const passwordOk = await verifyPassword(input.password, user ? user.password_hash : null);

    if (!user || !passwordOk) {
      if (user) await credentials.recordFailure("users", user.id);
      throw unauthorized("Invalid e-mail or password");
    }
    if (user.status !== "active" || user.tenant_status !== "active") {
      throw unauthorized("This account is not available");
    }
    if (user.failed_attempts >= env.password.maxFailedAttempts) {
      throw unauthorized("This account is locked. Contact an administrator.");
    }

    const tenantId = user.tenant_id;
    const scope = createTenantScope(tenantId, poolExecutor());
    const repositories = createRepositories(scope);

    const sessionId = newSessionId();
    const token = signStaffToken({
      sub: user.id,
      tenant_id: tenantId,
      role: user.role_key,
      jti: sessionId,
    });

    await repositories.sessions.create({
      tokenId: sessionId,
      principalType: "staff",
      principalId: user.id,
      expiresAt: new Date(Date.now() + STAFF_EXPIRY_MS),
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    await credentials.recordSuccess("users", user.id);

    logger.info("staff login", { tenant_id: tenantId, user_id: user.id, role: user.role_key });

    ok(res, {
      token,
      expires_in: env.jwt.staffExpires,
      user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role_key },
    });
  })
);

// POST /admin/auth/forgot-password
router.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const input = validate(req.body, { email: { required: true, type: "email" } });
    const result = await passwordReset.requestReset(
      { store: createPasswordResetRepository() },
      { email: input.email, principalType: passwordReset.PRINCIPAL.STAFF }
    );
    if (result.issued) {
      await deliverPasswordReset(
        {
          email: result.principal.email,
          token: result.token,
          expiresAt: result.expiresAt,
          principalType: passwordReset.PRINCIPAL.STAFF,
          tenantId: result.principal.tenant_id,
          principalId: result.principal.id,
        },
        req.log || logger
      );
    }
    ok(res, { message: result.message });
  })
);

// POST /admin/auth/reset-password
router.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    const input = validate(req.body, {
      token: { required: true, type: "string", maxLength: 200 },
      new_password: { required: true, type: "string", maxLength: 200 },
    });
    const result = await passwordReset.consumeReset(
      { store: createPasswordResetRepository(), log: req.log || logger },
      {
        token: input.token,
        newPassword: input.new_password,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      }
    );
    ok(res, { message: result.message });
  })
);

// GET /admin/auth/me
router.get(
  "/me",
  requireStaff,
  asyncHandler(async (req, res) => {
    const user = await req.scope.selectOne(
      `SELECT u.id, u.full_name, u.email, u.status, r.role_key, r.name AS role_name
         FROM users u
         JOIN roles r ON r.id = u.role_id AND r.tenant_id = :tenant
        WHERE u.id = ? AND u.tenant_id = :tenant`,
      [req.staff.userId]
    );
    ok(res, {
      user,
      tenant_id: req.staff.tenantId,
      permissions: Array.from(req.staff.permissions).sort(),
      may_approve: {
        booking: env.approvals.booking.includes(req.staff.role),
        profile_change: env.approvals.profile_change.includes(req.staff.role),
      },
    });
  })
);

// POST /admin/auth/logout
router.post(
  "/logout",
  requireStaff,
  asyncHandler(async (req, res) => {
    const { sessions, audit } = repositoriesFor(req);
    if (req.staff.sessionId) {
      await sessions.revokeByTokenId(req.staff.sessionId);
      await audit.record({
        actorType: "staff",
        actorId: req.staff.userId,
        action: ACTIONS.SESSION_REVOKED,
        entity: ENTITIES.SESSION,
        entityId: null,
        metadata: { revoked_by: "staff", scope: "current_session", role: req.staff.role },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
    }
    ok(res, { message: "Signed out." });
  })
);

module.exports = router;
