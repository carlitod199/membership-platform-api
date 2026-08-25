"use strict";

const express = require("express");

const { asyncHandler, ok, pagination } = require("../../lib/http");
const { validate, requireId } = require("../../lib/validate");
const { notFound } = require("../../lib/errors");
const { authorize } = require("../../middleware/authorize");
const { repositoriesFor } = require("../../repositories");

const router = express.Router();

// GET /admin/members
router.get(
  "/",
  authorize("members.view"),
  asyncHandler(async (req, res) => {
    const filters = validate(req.query, {
      search: { type: "string", maxLength: 100 },
      status: { type: "string", enum: ["active", "suspended", "inactive"] },
    });
    const { limit, offset, page } = pagination(req.query);
    const { members } = repositoriesFor(req);
    const rows = await members.listMembers({
      search: filters.search || null,
      status: filters.status || null,
      limit,
      offset,
    });
    ok(res, rows, { page, limit });
  })
);

// GET /admin/members/:id
router.get(
  "/:id",
  authorize("members.view"),
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const { members } = repositoriesFor(req);
    const member = await members.findById(id);
    if (!member) throw notFound("Member not found");
    const dependents = await members.listDependents(member.id);
    ok(res, { ...member, dependents });
  })
);

module.exports = router;
