"use strict";

const { forbidden, unauthorized } = require("../lib/errors");
const env = require("../config/env");

/**
 * Authorization.
 *
 * Two independent checks, applied in different places on purpose.
 *
 * `authorize(permission)` — data-driven RBAC.
 *   Permissions are rows. A tenant administrator composes roles out of them in
 *   the admin UI, so "who may see the invoice list" is a configuration question
 *   answered without a deploy. Permission keys are dotted and namespaced
 *   (`bookings.approve`, `members.edit`) so they read the same in code, in the
 *   database and in an audit log.
 *
 * `requireApprover(workflow)` — operator-controlled policy.
 *   Which roles may sign off an approval workflow comes from the environment,
 *   not from tenant-editable data. The reason is that RBAC rows are editable by
 *   a tenant administrator, and an approval boundary that the approver can
 *   grant themselves is not a boundary. This check sits *outside* the data a
 *   tenant controls.
 *
 * Approval endpoints carry both. Defence in depth: the RBAC check answers
 * "is this a job function that touches bookings", the policy check answers
 * "does this deployment let that job function sign off".
 */

/** Require a permission key on the authenticated staff user. */
function authorize(permission) {
  if (!permission || typeof permission !== "string") {
    throw new Error("authorize() needs a permission key");
  }
  return function authorizeMiddleware(req, res, next) {
    if (!req.staff) return next(unauthorized());
    const granted = req.staff.permissions;
    const has = granted instanceof Set ? granted.has(permission) : Array.isArray(granted) && granted.includes(permission);
    if (!has) {
      return next(forbidden(`Missing permission: ${permission}`));
    }
    next();
  };
}

/**
 * Is `role` configured as an approver for `workflow`?
 * Pure function, exported for testing and for use inside services that need to
 * re-check the policy at the point of the state change rather than only at the
 * edge.
 */
function isApprover(workflow, role, policy = env.approvals) {
  const roles = policy && policy[workflow];
  if (!Array.isArray(roles) || roles.length === 0) return false;
  return roles.includes(role);
}

/** Middleware form of isApprover(). */
function requireApprover(workflow) {
  return function requireApproverMiddleware(req, res, next) {
    if (!req.staff) return next(unauthorized());
    if (!isApprover(workflow, req.staff.role)) {
      return next(
        forbidden(`Your role (${req.staff.role}) is not configured to approve ${workflow} requests`)
      );
    }
    next();
  };
}

module.exports = { authorize, isApprover, requireApprover };
