"use strict";

const express = require("express");

const { asyncHandler, ok } = require("../lib/http");
const { validate, requireId } = require("../lib/validate");
const { notFound } = require("../lib/errors");
const { requireMember } = require("../middleware/authenticate");
const { repositoriesFor } = require("../repositories");

const router = express.Router();
router.use(requireMember);

const toMinutes = (time) => {
  if (!time) return null;
  const [h, m] = String(time).split(":").map(Number);
  return h * 60 + m;
};
const toTime = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

// GET /facilities
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { facilities } = repositoriesFor(req);
    ok(res, await facilities.list());
  })
);

/**
 * GET /facilities/:id/availability?date=YYYY-MM-DD
 *
 * Slots are computed in the API rather than the database because the rules
 * (opening hours, slot length, closures, pending bookings holding a slot) are
 * business rules that change per tenant, and expressing them as SQL makes them
 * hard to read and harder to test. The three inputs are three indexed reads.
 *
 * A *pending* booking marks the slot unavailable. That is deliberate: showing a
 * slot as free while somebody's request for it is queued produces two requests
 * staff then have to arbitrate.
 */
router.get(
  "/:id/availability",
  asyncHandler(async (req, res) => {
    const facilityId = requireId(req.params.id);
    const { date } = validate(req.query, { date: { required: true, type: "date" } });

    const { facilities } = repositoriesFor(req);
    const facility = await facilities.findActiveById(facilityId);
    if (!facility) throw notFound("Facility not found");

    const opens = toMinutes(facility.opens_at) ?? 6 * 60;
    const closes = toMinutes(facility.closes_at) ?? 22 * 60;
    const slotLength = facility.slot_minutes || 60;

    const [booked, closures] = await Promise.all([
      facilities.listBookingsForDate(facilityId, date),
      facilities.listClosuresForDate(facilityId, date),
    ]);

    const busy = booked.map((b) => [toMinutes(b.starts_at), toMinutes(b.ends_at)]);
    const closed = closures.map((c) => {
      const start = String(c.starts_at).slice(0, 10) === date ? toMinutes(String(c.starts_at).slice(11, 16)) : 0;
      const end = String(c.ends_at).slice(0, 10) === date ? toMinutes(String(c.ends_at).slice(11, 16)) : 24 * 60;
      return [start, end];
    });

    const slots = [];
    for (let start = opens; start + slotLength <= closes; start += slotLength) {
      const end = start + slotLength;
      const free =
        !busy.some(([s, e]) => overlaps(start, end, s, e)) &&
        !closed.some(([s, e]) => overlaps(start, end, s, e));
      slots.push({ starts_at: toTime(start), ends_at: toTime(end), available: free });
    }

    ok(res, {
      facility: { id: facility.id, name: facility.name, requires_approval: Boolean(facility.requires_approval) },
      date,
      slots,
    });
  })
);

module.exports = router;
module.exports.toMinutes = toMinutes;
module.exports.toTime = toTime;
module.exports.overlaps = overlaps;
