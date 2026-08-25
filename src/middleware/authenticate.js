"use strict";

const { SCOPES, verifyToken, bearerFrom } = require("../lib/tokens");
const { unauthorized, forbidden } = require("../lib/errors");
const { createTenantScope } = require("../data/tenantScope");
const { poolExecutor } = require("../config/db");
const env = require("../config/env");

/**
 * Authentication middleware.
 *
 * This is the *only* place a tenant id enters the application. The sequence is
 * fixed and there is no alternative path:
 *
 *   1. read the bearer token;
 *   2. verify signature, issuer, expiry and scope;
 *   3. take `tenant_id` from the verified payload;
 *   4. build a tenant scope from it and attach it to the request;
 *   5. optionally confirm the session has not been revoked.
 *
 * From step 4 onward, `req.scope` is the only database access a handler has.
 * A handler cannot widen it, and it cannot be constructed from request input,
 * because `createTenantScope` takes an integer that only exists here.
 *
 * Everything is injected through `deps` so the middleware is unit-testable
 * without a database or an HTTP server.
 */

function defaultSessionLookup(scope, jti) {
  return scope.selectOne(
    `SELECT id, revoked_at, expires_at
       FROM auth_sessions
      WHERE tenant_id = :tenant AND token_id = ?
      LIMIT 1`,
    [jti]
  );
}

function createAuthenticator(expectedScope, deps = {}) {
  const {
    verify = verifyToken,
    readBearer = bearerFrom,
    buildScope = (tenantId) => createTenantScope(tenantId, poolExecutor()),
    lookupSession = defaultSessionLookup,
    enforceRevocation = () => env.sessions.enforceRevocation,
    loadStaffPermissions = defaultLoadStaffPermissions,
  } = deps;

  return async function authenticate(req, res, next) {
    try {
      const token = readBearer(req);
      if (!token) throw unauthorized("Authentication required");

      const payload = verify(token, expectedScope);

      // (3) tenant identity — from the token, never from the request.
      const tenantId = payload.tenant_id;

      // (4) the request's only database handle.
      req.scope = buildScope(tenantId);
      req.tenantId = tenantId;

      // (5) revocation check. A JWT is otherwise valid until it expires; the
      // session row is what makes "log out this device" mean anything.
      if (enforceRevocation() && payload.jti) {
        const session = await lookupSession(req.scope, payload.jti);
        if (!session) throw unauthorized("Session is no longer valid");
        if (session.revoked_at) throw unauthorized("Session has been revoked");
      }

      if (expectedScope === SCOPES.MEMBER) {
        req.member = {
          credentialId: payload.sub,
          tenantId,
          memberId: payload.member_id || null,
          dependentId: payload.dependent_id || null,
          principal: payload.principal,
          sessionId: payload.jti || null,
        };
      } else {
        req.staff = {
          userId: payload.sub,
          tenantId,
          role: payload.role,
          sessionId: payload.jti || null,
          permissions: await loadStaffPermissions(req.scope, payload.sub),
        };
      }

      if (req.log) {
        req.log = req.log.child({ tenant_id: tenantId, principal: payload.scope });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Load the permission keys granted to a staff user through their role.
 *
 * Read per request rather than baked into the token: a permission revoked by a
 * tenant administrator has to take effect immediately, and a 12-hour token
 * carrying a stale permission set would not allow that. The cost is one indexed
 * join per admin request, which is the right trade for an admin surface.
 */
async function defaultLoadStaffPermissions(scope, userId) {
  const rows = await scope.select(
    `SELECT p.permission_key
       FROM users u
       JOIN role_permissions rp ON rp.role_id = u.role_id AND rp.tenant_id = :tenant
       JOIN permissions p ON p.id = rp.permission_id
      WHERE u.id = ? AND u.tenant_id = :tenant AND u.status = 'active'`,
    [userId]
  );
  return new Set(rows.map((r) => r.permission_key));
}

const requireMember = createAuthenticator(SCOPES.MEMBER);
const requireStaff = createAuthenticator(SCOPES.STAFF);

/**
 * Some member endpoints are for the primary member only — a dependent's token
 * must not read the household's invoices.
 */
function requirePrimaryMember(req, res, next) {
  if (!req.member) return next(unauthorized());
  if (!req.member.memberId) {
    return next(forbidden("This endpoint is available to the primary member only"));
  }
  next();
}

module.exports = {
  createAuthenticator,
  requireMember,
  requireStaff,
  requirePrimaryMember,
  defaultLoadStaffPermissions,
  defaultSessionLookup,
};
