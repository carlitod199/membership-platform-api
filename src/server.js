"use strict";

const env = require("./config/env");
const logger = require("./lib/logger");
const createApp = require("./app");
const { closePool } = require("./config/db");

/**
 * Process entry point: configuration checks, listener, graceful shutdown.
 */

const problems = env.assertProductionSafety();
if (problems.length) {
  for (const problem of problems) logger.error("configuration error", { problem });
  process.exit(1);
}

const app = createApp();
const server = app.listen(env.port, () => {
  logger.info("api listening", {
    url: `http://localhost:${env.port}${env.apiPrefix}`,
    env: env.nodeEnv,
    node: process.version,
  });
});

/**
 * Graceful shutdown.
 *
 * On SIGTERM (what a container runtime sends first) the sequence is: stop
 * accepting new connections, let in-flight requests finish, close the database
 * pool, exit. A hard timer bounds the wait so a wedged connection cannot hold
 * the process open past the orchestrator's own grace period, and the fallback
 * exit code is non-zero so a forced kill is visible in the logs rather than
 * looking like a clean stop.
 */
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown started", { signal });

  const forceTimer = setTimeout(() => {
    logger.error("shutdown timed out, forcing exit", { timeout_ms: env.shutdownTimeoutMs });
    process.exit(1);
  }, env.shutdownTimeoutMs);
  forceTimer.unref();

  server.close(async (closeError) => {
    if (closeError) logger.error("error closing http server", { message: closeError.message });
    try {
      await closePool();
    } catch (error) {
      logger.error("error closing database pool", { message: error.message });
    }
    clearTimeout(forceTimer);
    logger.info("shutdown complete");
    process.exit(closeError ? 1 : 0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// A rejected promise that nobody handled leaves the process in an unknown
// state. Log it with the stack and shut down rather than continuing to serve
// traffic from a process whose invariants may no longer hold.
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled promise rejection", {
    message: reason && reason.message,
    stack: reason && reason.stack,
  });
  shutdown("unhandledRejection");
});

process.on("uncaughtException", (error) => {
  logger.error("uncaught exception", { message: error.message, stack: error.stack });
  shutdown("uncaughtException");
});

module.exports = server;
