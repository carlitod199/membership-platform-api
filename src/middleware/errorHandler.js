"use strict";

const { ApiError } = require("../lib/errors");
const { TenantScopeError } = require("../data/tenantScope");
const { UnscopedQueryError } = require("../data/global");
const logger = require("../lib/logger");
const env = require("../config/env");

/**
 * Centralized error handling.
 *
 * Rules:
 *   - a known ApiError becomes its own status and message;
 *   - a driver error is translated to the closest HTTP meaning without echoing
 *     the driver's text (which contains table and column names);
 *   - anything else is a bug: it is logged in full server-side and answered
 *     with a bare 500. Stack traces never cross the wire in production, and the
 *     `details` field is populated only outside production.
 *   - every response carries the request id, so "500, request 4f3a…" is enough
 *     to find the full stack in the logs.
 */

const DRIVER_ERRORS = {
  ER_DUP_ENTRY: [409, "That record already exists"],
  ER_NO_REFERENCED_ROW: [400, "Referenced record does not exist"],
  ER_NO_REFERENCED_ROW_2: [400, "Referenced record does not exist"],
  ER_ROW_IS_REFERENCED: [409, "That record is still referenced by other data"],
  ER_ROW_IS_REFERENCED_2: [409, "That record is still referenced by other data"],
  ER_DATA_TOO_LONG: [400, "A submitted value is too long"],
  ER_LOCK_WAIT_TIMEOUT: [503, "The database is busy, please retry"],
  ER_LOCK_DEADLOCK: [503, "The database is busy, please retry"],
  ECONNREFUSED: [503, "Service temporarily unavailable"],
  PROTOCOL_CONNECTION_LOST: [503, "Service temporarily unavailable"],
};

function notFoundHandler(req, res) {
  res.status(404).json({
    error: { message: "Route not found", code: "not_found", request_id: req.id || null },
  });
}

// eslint-disable-next-line no-unused-vars -- Express identifies the error
// handler by its four-argument signature; `next` must stay in the list.
function errorHandler(err, req, res, next) {
  const log = req.log || logger;
  const requestId = req.id || null;

  if (err instanceof ApiError) {
    // Expected. Log at warn so a spike of 401s is still visible, but do not
    // record a stack for something that is not a defect.
    log.warn("request rejected", {
      status: err.status,
      code: err.code,
      message: err.message,
      path: req.originalUrl || req.url,
    });
    return res.status(err.status).json({
      error: {
        message: err.message,
        code: err.code || undefined,
        details: err.details || undefined,
        request_id: requestId,
      },
    });
  }

  // A tenant-scope violation is a programming error with security weight.
  // Log it loudly; tell the client nothing.
  if (err instanceof TenantScopeError || err instanceof UnscopedQueryError) {
    log.error("data access guard tripped", {
      guard: err.name,
      message: err.message,
      path: req.originalUrl || req.url,
      stack: err.stack,
    });
    return res.status(500).json({
      error: { message: "Internal server error", code: "internal_error", request_id: requestId },
    });
  }

  const mapped = err && (DRIVER_ERRORS[err.code] || DRIVER_ERRORS[err.errno]);
  if (mapped) {
    const [status, message] = mapped;
    log.error("database error", { code: err.code, status, path: req.originalUrl || req.url });
    return res.status(status).json({
      error: { message, code: "database_error", request_id: requestId },
    });
  }

  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({
      error: { message: "Request body is not valid JSON", code: "bad_request", request_id: requestId },
    });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({
      error: { message: "Request body is too large", code: "payload_too_large", request_id: requestId },
    });
  }

  log.error("unhandled error", {
    message: err && err.message,
    name: err && err.name,
    stack: err && err.stack,
    path: req.originalUrl || req.url,
  });

  res.status(500).json({
    error: {
      message: "Internal server error",
      code: "internal_error",
      request_id: requestId,
      // Never in production. Development only, to save a log round trip.
      details: env.isProduction ? undefined : String((err && err.message) || err),
    },
  });
}

module.exports = { notFoundHandler, errorHandler, DRIVER_ERRORS };
