"use strict";

const logger = require("../lib/logger");

/**
 * Strip any client-supplied tenant identifier from the request.
 *
 * The tenant is derived from the verified JWT and nowhere else. This middleware
 * exists because *silently ignoring* an attacker-supplied `tenant_id` is not
 * enough on its own — someone will eventually write
 * `scope.insert("bookings", req.body)` and spread the body straight into a
 * query. Removing the key at the edge means that mistake cannot carry a tenant
 * id even if it happens, and the tenant scope's `insert()` throws if one shows
 * up anyway. Two independent guards, because this is the failure that matters.
 *
 * The request is not rejected: a client that sends `tenant_id` is more often a
 * confused SDK than an attacker, and a 400 here would confirm that the field
 * means something. It is dropped and logged at warn level so it stays visible
 * in monitoring.
 */

const BLOCKED_KEYS = ["tenant_id", "tenantId", "tenant", "tenant_slug"];

/** Delete blocked keys from a plain object. Returns the names removed. */
function stripFrom(container) {
  if (!container || typeof container !== "object") return [];
  const removed = [];
  for (const key of BLOCKED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(container, key)) {
      delete container[key];
      removed.push(key);
    }
  }
  return removed;
}

/**
 * Sanitize `req[prop]` in place.
 *
 * `req.query` can be exposed through a prototype getter that reparses the URL
 * on every access (Express 5, and Express 4 before the query middleware has
 * run), in which case mutating the object we just read would not stick. After
 * removing anything, the sanitized object is pinned onto the request as an own
 * property so later reads see the cleaned version.
 */
function sanitize(req, prop) {
  const container = req[prop];
  if (!container || typeof container !== "object") return [];
  const removed = stripFrom(container);
  if (removed.length) {
    try {
      Object.defineProperty(req, prop, {
        value: container,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch (error) {
      // Non-configurable property: the delete above already applied to the
      // object the rest of the pipeline will read.
    }
  }
  return removed;
}

function tenantGuard(req, res, next) {
  const removed = [
    ...sanitize(req, "body").map((k) => `body.${k}`),
    ...sanitize(req, "query").map((k) => `query.${k}`),
    ...sanitize(req, "params").map((k) => `params.${k}`),
  ];

  if (removed.length) {
    (req.log || logger).warn("client-supplied tenant identifier ignored", {
      path: req.originalUrl || req.url,
      method: req.method,
      fields: removed,
    });
  }
  next();
}

module.exports = tenantGuard;
module.exports.BLOCKED_KEYS = BLOCKED_KEYS;
module.exports.stripFrom = stripFrom;
module.exports.sanitize = sanitize;
