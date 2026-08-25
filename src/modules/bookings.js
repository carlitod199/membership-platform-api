"use strict";

const express = require("express");

const { asyncHandler, ok, created, pagination } = require("../lib/http");
const { validate, requireId } = require("../lib/validate");
const { requireMember, requirePrimaryMember } = require("../middleware/authenticate");
const { repositoriesFor } = require("../repositories");
const workflow = require("../services/bookingWorkflow");

const router = express.Router();
router.use(requireMember, requirePrimaryMember);

/**
 * Member bookings.
 *
 * `POST /bookings` cannot produce a confirmed booking. The status is set by the
 * workflow service, not by the request, and the only transition to `confirmed`
 * lives behind `PATCH /admin/bookings/:id/approve`.
 */

// GET /bookings
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { limit, offset, page } = pagination(req.query);
    const { bookings } = repositoriesFor(req);
    const rows = await bookings.listForMember(req.member.memberId, { limit, offset });
    ok(res, rows, { page, limit });
  })
);

// POST /bookings — always created as pending
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = validate(req.body, {
      facility_id: { required: true, type: "int", min: 1 },
      booking_date: { required: true, type: "date" },
      starts_at: { required: true, type: "time" },
      ends_at: { required: true, type: "time" },
      notes: { type: "string", maxLength: 255 },
    });

    const repositories = repositoriesFor(req);
    const result = await workflow.requestBooking(repositories, {
      facilityId: input.facility_id,
      memberId: req.member.memberId,
      dependentId: req.member.dependentId,
      bookingDate: input.booking_date,
      startsAt: input.starts_at,
      endsAt: input.ends_at,
      notes: input.notes,
    });

    // The message has to follow the outcome, not the endpoint. A facility with
    // requires_approval = 0 confirms here and now; telling that member to await
    // review would be false.
    created(res, {
      ...result,
      message: result.auto_confirmed
        ? "Booking confirmed. This facility does not require staff approval."
        : "Booking requested. It is pending review by the association staff.",
    });
  })
);

// PATCH /bookings/:id/cancel
router.patch(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const repositories = repositoriesFor(req);
    const result = await workflow.cancelBooking(repositories, {
      bookingId: id,
      memberId: req.member.memberId,
    });
    ok(res, result);
  })
);

module.exports = router;
