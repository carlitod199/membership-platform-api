"use strict";

const express = require("express");

const { asyncHandler } = require("../lib/http");
const { unscopedQuery, UNSCOPED_PURPOSES } = require("../data/global");

const router = express.Router();
const startedAt = Date.now();

/**
 * Health checks.
 *
 * Two endpoints, because a load balancer and an operator want different things:
 *
 *   GET /health   — liveness. Answers without touching the database, so a
 *                   database outage does not cause the orchestrator to kill
 *                   otherwise healthy processes and make the outage worse.
 *   GET /health/ready — readiness. Actually runs `SELECT 1`. Returns 503 when
 *                   the database is unreachable, which is the correct signal to
 *                   stop routing traffic here.
 */

router.get("/", (req, res) => {
  res.json({
    status: "ok",
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    ts: new Date().toISOString(),
  });
});

router.get(
  "/ready",
  asyncHandler(async (req, res) => {
    try {
      await unscopedQuery(UNSCOPED_PURPOSES.HEALTH_CHECK, "SELECT 1 AS ok", []);
      res.json({ status: "ready", database: "up", ts: new Date().toISOString() });
    } catch (error) {
      req.log.error("readiness check failed", { message: error.message });
      res.status(503).json({ status: "unavailable", database: "down", ts: new Date().toISOString() });
    }
  })
);

module.exports = router;
