"use strict";

const express = require("express");

const { asyncHandler, ok, pagination } = require("../../lib/http");
const { validate, requireId } = require("../../lib/validate");
const { authorize, requireApprover } = require("../../middleware/authorize");
const { repositoriesFor } = require("../../repositories");
const workflow = require("../../services/profileChangeWorkflow");

const router = express.Router();

// GET /admin/profile-change-requests?status=pending
router.get(
  "/",
  authorize("members.view"),
  asyncHandler(async (req, res) => {
    const { status } = validate(req.query, {
      status: { type: "string", enum: ["pending", "approved", "rejected"], default: "pending" },
    });
    const { limit, offset, page } = pagination(req.query);
    const { requests } = repositoriesFor(req);
    ok(res, await requests.listByStatus(status, { limit, offset }), { page, limit, status });
  })
);

// PATCH /admin/profile-change-requests/:id/approve
router.patch(
  "/:id/approve",
  authorize("members.edit"),
  requireApprover("profile_change"),
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const { note } = validate(req.body, { note: { type: "string", maxLength: 255 } });
    const repositories = repositoriesFor(req);

    const result = await workflow.approveProfileChange(repositories, {
      requestId: id,
      actor: { userId: req.staff.userId, role: req.staff.role },
      note,
    });

    req.log.info("profile change approved", {
      request_id: id,
      actor_id: req.staff.userId,
      fields: result.applied_fields,
    });
    ok(res, result);
  })
);

// PATCH /admin/profile-change-requests/:id/reject
router.patch(
  "/:id/reject",
  authorize("members.edit"),
  requireApprover("profile_change"),
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const { note } = validate(req.body, { note: { type: "string", maxLength: 255 } });
    const repositories = repositoriesFor(req);

    const result = await workflow.rejectProfileChange(repositories, {
      requestId: id,
      actor: { userId: req.staff.userId, role: req.staff.role },
      note,
    });

    req.log.info("profile change rejected", { request_id: id, actor_id: req.staff.userId });
    ok(res, result);
  })
);

module.exports = router;
