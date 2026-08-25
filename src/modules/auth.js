"use strict";

const express = require("express");

const { asyncHandler, ok, noContent } = require("../lib/http");
const { validate, requireId } = require("../lib/validate");
const { unauthorized, notFound } = require("../lib/errors");
const { verifyPassword } = require("../lib/passwords");
const { signMemberToken, newSessionId } = require("../lib/tokens");
const { requireMember } = require("../middleware/authenticate");
const { createTenantScope } = require("../data/tenantScope");
const { poolExecutor } = require("../config/db");
const { createRepositories, repositoriesFor } = require("../repositories");
const { createCredentialRepository } = require("../repositories/credentialRepository");
const { createPasswordResetRepository } = require("../repositories/passwordResetRepository");
const passwordReset = require("../services/passwordResetService");
const { deliverPasswordReset } = require("../services/notifier");
const { ACTIONS, ENTITIES } = require("../repositories/auditRepository");
const env = require("../config/env");
const logger = require("../lib/logger");

const router = express.Router();

const MEMBER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Member authentication.
 *
 * The login handler is the hinge of the whole tenancy model: it is the moment
 * an anonymous request acquires a tenant. Note the order — the credential row
 * is found first, its `tenant_id` is read from the row, and only then is a
 * scope built. At no point does the client get to say which tenant it is in.
 */

async function loadIdentity(scope, { memberId, dependentId }) {
  const repositories = createRepositories(scope);
  if (memberId) {
    const member = await repositories.members.findById(memberId);
    if (!member) return null;
    return {
      principal: "member",
      id: member.id,
      membership_number: member.membership_number,
      full_name: member.full_name,
      email: member.email,
      category: member.category_name,
      status: member.status,
      billing_status: member.billing_status,
    };
  }
  const dependent = await repositories.members.findDependentById(dependentId);
  if (!dependent) return null;
  return {
    principal: "dependent",
    id: dependent.id,
    member_id: dependent.member_id,
    full_name: dependent.full_name,
    relationship: dependent.relationship,
    status: dependent.status,
  };
}

// POST /auth/login
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const input = validate(req.body, {
      email: { required: true, type: "email" },
      password: { required: true, type: "string", maxLength: 200 },
    });

    const credentials = createCredentialRepository();
    const credential = await credentials.findMemberCredential(input.email);

    // Always run the comparison, even on a miss — verifyPassword() burns the
    // same CPU against a dummy hash so timing does not disclose the account.
    const passwordOk = await verifyPassword(input.password, credential ? credential.password_hash : null);

    if (!credential || !passwordOk) {
      if (credential) await credentials.recordFailure("member_credentials", credential.id);
      throw unauthorized("Invalid e-mail or password");
    }
    if (credential.tenant_status !== "active") throw unauthorized("This account is not available");
    if (credential.status === "suspended") throw unauthorized("This account has been suspended");
    if (credential.status === "inactive") throw unauthorized("This account is inactive");
    if (credential.failed_attempts >= env.password.maxFailedAttempts) {
      throw unauthorized("This account is locked. Use the password reset to unlock it.");
    }

    // Tenant identity is established here, from the stored row.
    const tenantId = credential.tenant_id;
    const scope = createTenantScope(tenantId, poolExecutor());
    const repositories = createRepositories(scope);

    const identity = await loadIdentity(scope, {
      memberId: credential.member_id,
      dependentId: credential.dependent_id,
    });
    if (!identity) throw unauthorized("Invalid e-mail or password");

    const sessionId = newSessionId();
    const token = signMemberToken({
      sub: credential.id,
      tenant_id: tenantId,
      member_id: credential.member_id || null,
      dependent_id: credential.dependent_id || null,
      principal: identity.principal,
      jti: sessionId,
    });

    await repositories.sessions.create({
      tokenId: sessionId,
      principalType: "member",
      principalId: credential.id,
      expiresAt: new Date(Date.now() + MEMBER_EXPIRY_MS),
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    await credentials.recordSuccess("member_credentials", credential.id);

    logger.info("member login", { tenant_id: tenantId, credential_id: credential.id });
    ok(res, { token, expires_in: env.jwt.memberExpires, profile: identity });
  })
);

// POST /auth/forgot-password
router.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const input = validate(req.body, { email: { required: true, type: "email" } });

    const result = await passwordReset.requestReset(
      { store: createPasswordResetRepository() },
      { email: input.email, principalType: passwordReset.PRINCIPAL.MEMBER }
    );

    // The token is never returned over HTTP. It goes to the notifier seam,
    // which a deployment replaces with a real transport; the shipped default
    // records the event without the token. See src/services/notifier.js.
    if (result.issued) {
      await deliverPasswordReset(
        {
          email: result.principal.email,
          token: result.token,
          expiresAt: result.expiresAt,
          principalType: passwordReset.PRINCIPAL.MEMBER,
          tenantId: result.principal.tenant_id,
          principalId: result.principal.id,
        },
        req.log || logger
      );
    }

    ok(res, { message: result.message });
  })
);

// POST /auth/reset-password
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

// GET /auth/me
router.get(
  "/me",
  requireMember,
  asyncHandler(async (req, res) => {
    const identity = await loadIdentity(req.scope, {
      memberId: req.member.memberId,
      dependentId: req.member.dependentId,
    });
    if (!identity) throw notFound("Profile not found");
    ok(res, { profile: identity, tenant_id: req.member.tenantId });
  })
);

// GET /auth/sessions — devices currently holding a valid token
router.get(
  "/sessions",
  requireMember,
  asyncHandler(async (req, res) => {
    const { sessions } = repositoriesFor(req);
    const rows = await sessions.listActive({
      principalType: "member",
      principalId: req.member.credentialId,
    });
    ok(
      res,
      rows.map((row) => ({ ...row, current: row.token_id === req.member.sessionId }))
    );
  })
);

// DELETE /auth/sessions/:id — revoke one device
router.delete(
  "/sessions/:id",
  requireMember,
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const { sessions, audit } = repositoriesFor(req);
    const revoked = await sessions.revokeById({
      id,
      principalType: "member",
      principalId: req.member.credentialId,
    });
    if (!revoked) throw notFound("Session not found");
    await audit.record({
      actorType: "member",
      actorId: req.member.credentialId,
      action: ACTIONS.SESSION_REVOKED,
      entity: ENTITIES.SESSION,
      entityId: id,
      metadata: { revoked_by: "member", scope: "single_device" },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    noContent(res);
  })
);

// POST /auth/logout — revoke the token used to make this call
router.post(
  "/logout",
  requireMember,
  asyncHandler(async (req, res) => {
    const { sessions } = repositoriesFor(req);
    if (req.member.sessionId) await sessions.revokeByTokenId(req.member.sessionId);
    ok(res, { message: "Signed out." });
  })
);

// POST /auth/logout-all — revoke every session for this credential
router.post(
  "/logout-all",
  requireMember,
  asyncHandler(async (req, res) => {
    const { sessions, audit } = repositoriesFor(req);
    const count = await sessions.revokeAllFor({
      principalType: "member",
      principalId: req.member.credentialId,
    });
    await audit.record({
      actorType: "member",
      actorId: req.member.credentialId,
      action: ACTIONS.SESSIONS_REVOKED_ALL,
      entity: ENTITIES.CREDENTIAL,
      entityId: req.member.credentialId,
      metadata: { revoked_sessions: count, scope: "all_devices" },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    ok(res, { message: "Signed out everywhere.", revoked: count });
  })
);

module.exports = router;
module.exports.loadIdentity = loadIdentity;
