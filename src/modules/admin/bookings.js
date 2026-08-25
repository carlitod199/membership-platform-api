"use strict";

const express = require("express");

const { asyncHandler, ok, pagination } = require("../../lib/http");
const { validate, requireId } = require("../../lib/validate");
const { authorize, requireApprover } = require("../../middleware/authorize");
const { repositoriesFor } = require("../../repositories");
const workflow = require("../../services/bookingWorkflow");

const router = express.Router();

/**
 * Booking review queue.
 *
 * Note the two-middleware stack on the approve/reject routes:
 *
 *   authorize("bookings.approve")  — does this user's role hold the permission?
 *                                    (tenant-editable RBAC data)
 *   requireApprover("booking")     — is that role allowed to sign off in this
 *                                    deployment? (operator configuration)
 *
 * The workflow service re-checks the policy itself, so the guarantee does not
 * depend on a route being wired up correctly.
 */

const REVIEWABLE_STATUSES = ["pending", "confirmed", "rejected", "cancelled", "completed"];

// GET /admin/bookings?status=pending
router.get(
  "/",
  authorize("bookings.view"),
  asyncHandler(async (req, res) => {
    const { status } = validate(req.query, {
      status: { type: "string", enum: REVIEWABLE_STATUSES, default: "pending" },
    });
    const { limit, offset, page } = pagination(req.query);
    const { bookings } = repositoriesFor(req);
    ok(res, await bookings.listByStatus(status, { limit, offset }), { page, limit, status });
  })
);

// PATCH /admin/bookings/:id/approve
router.patch(
  "/:id/approve",
  authorize("bookings.approve"),
  requireApprover("booking"),
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const { note } = validate(req.body, { note: { type: "string", maxLength: 255 } });
    const repositories = repositoriesFor(req);

    const result = await workflow.approveBooking(repositories, {
      bookingId: id,
      actor: { userId: req.staff.userId, role: req.staff.role },
      note,
    });

    req.log.info("booking approved", { booking_id: id, actor_id: req.staff.userId });
    ok(res, result);
  })
);

// PATCH /admin/bookings/:id/reject
router.patch(
  "/:id/reject",
  authorize("bookings.approve"),
  requireApprover("booking"),
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const { note } = validate(req.body, { note: { type: "string", maxLength: 255 } });
    const repositories = repositoriesFor(req);

    const result = await workflow.rejectBooking(repositories, {
      bookingId: id,
      actor: { userId: req.staff.userId, role: req.staff.role },
      note,
    });

    req.log.info("booking rejected", { booking_id: id, actor_id: req.staff.userId });
    ok(res, result);
  })
);

module.exports = router;
