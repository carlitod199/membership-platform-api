"use strict";

const crypto = require("crypto");
const logger = require("../lib/logger");

/**
 * Attach a request id and a child logger, and log one line per completed
 * request. The request id is echoed in the `X-Request-Id` response header and
 * in every error body, so a user-reported failure can be found in the logs
 * without asking them for a timestamp.
 *
 * Only metadata is logged. Bodies are not, because they carry passwords; the
 * logger would redact them, but not logging them at all is cheaper and safer.
 */
function requestContext(req, res, next) {
  const requestId = req.headers["x-request-id"] || crypto.randomUUID();
  req.id = requestId;
  req.log = logger.child({ request_id: requestId });
  res.setHeader("X-Request-Id", requestId);

  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    req.log[level]("request", {
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      tenant_id: req.tenantId || null,
    });
  });

  next();
}

module.exports = requestContext;
