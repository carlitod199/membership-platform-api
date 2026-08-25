"use strict";

const express = require("express");

const { asyncHandler, ok, pagination } = require("../../lib/http");
const { validate } = require("../../lib/validate");
const { authorize } = require("../../middleware/authorize");
const { repositoriesFor } = require("../../repositories");
const { ACTIONS, ENTITIES } = require("../../repositories/auditRepository");

const router = express.Router();

/**
 * Audit trail, read-only.
 *
 * An audit table nobody can read is a table nobody trusts. This makes the
 * record reachable from the admin surface without a database client.
 *
 * Read-only by design: there is no create, no edit and no delete. The rows are
 * written by the workflows that make the decisions, inside the same
 * transaction, and an audit log with an edit endpoint is not an audit log.
 *
 * Tenant scoping is the same as everywhere else — the query goes through
 * `req.scope`, so one association cannot read another's decisions.
 */

// GET /admin/audit-logs?entity=booking&page=1&limit=50
router.get(
  "/",
  authorize("settings.view"),
  asyncHandler(async (req, res) => {
    const filters = validate(req.query, {
      entity: { type: "string", enum: Object.values(ENTITIES) },
    });
    const { limit, offset, page } = pagination(req.query);
    const { audit } = repositoriesFor(req);

    const rows = await audit.list({ entity: filters.entity || null, limit, offset });
    ok(res, rows, { page, limit, entity: filters.entity || null });
  })
);

// GET /admin/audit-logs/actions — the vocabulary, so a UI can build a filter
router.get(
  "/actions",
  authorize("settings.view"),
  (req, res) => ok(res, { actions: Object.values(ACTIONS), entities: Object.values(ENTITIES) })
);

module.exports = router;
