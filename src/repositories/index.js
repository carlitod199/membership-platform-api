"use strict";

const { createBookingRepository } = require("./bookingRepository");
const { createFacilityRepository } = require("./facilityRepository");
const { createNotificationRepository } = require("./notificationRepository");
const { createMemberRepository } = require("./memberRepository");
const { createProfileChangeRepository } = require("./profileChangeRepository");
const { createSessionRepository } = require("./sessionRepository");
const { createAuditRepository } = require("./auditRepository");

/**
 * Build the repository set for one request, all bound to the same tenant scope.
 *
 * `transaction(fn)` hands the callback a *fresh* repository set bound to the
 * transaction's connection. A workflow therefore cannot accidentally mix a
 * transactional write with a pooled one, which is the usual way a "notify on
 * approval" step ends up committed while the approval rolls back.
 */
function createRepositories(scope) {
  const repositories = {
    scope,
    bookings: createBookingRepository(scope),
    facilities: createFacilityRepository(scope),
    notifications: createNotificationRepository(scope),
    members: createMemberRepository(scope),
    requests: createProfileChangeRepository(scope),
    sessions: createSessionRepository(scope),
    audit: createAuditRepository(scope),
    transaction: (fn) => scope.transaction((txScope) => fn(createRepositories(txScope))),
  };
  return repositories;
}

/** Convenience for route handlers: repositories for the authenticated request. */
function repositoriesFor(req) {
  if (!req.scope) {
    throw new Error("repositoriesFor() called on an unauthenticated request");
  }
  if (!req._repositories) {
    req._repositories = createRepositories(req.scope);
  }
  return req._repositories;
}

module.exports = { createRepositories, repositoriesFor };
