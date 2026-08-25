"use strict";

const { ApiError, badRequest, conflict, notFound, forbidden } = require("../lib/errors");
const { isApprover } = require("../middleware/authorize");
const { ACTIONS, ENTITIES } = require("../repositories/auditRepository");

/**
 * Booking workflow.
 *
 * A member's booking request is not authoritative by default. `POST /bookings`
 * writes `status = 'pending'` and only a staff approval moves it to
 * `confirmed`.
 *
 * There are exactly TWO paths that produce a confirmed booking, and both are in
 * this file:
 *
 *   1. `approveBooking()` — a staff member with the permission and an approver
 *      role signs off a pending booking.
 *   2. `requestBooking()` against a facility whose `requires_approval` column is
 *      0 — the tenant has declared that this facility does not need a human in
 *      the loop, so the booking is confirmed at creation.
 *
 * Path 2 is not a shortcut around path 1: it runs the same confirmed-overlap
 * re-check, in a transaction, and notifies the member and writes the same audit
 * record. The difference is who decided, and that is recorded — the audit row
 * has `actor_type = 'member'` and action `booking.auto_confirmed`.
 *
 * Other details that are easy to get wrong and are handled here:
 *
 *   - The conflict check is repeated *at approval time*. The slot was free when
 *     the member asked; between then and the approval another booking may have
 *     been confirmed. Validating only at request time would double-book.
 *     Pending bookings do not block each other for approval purposes — two
 *     members may request the same slot and staff pick one.
 *   - The state change, the member notification and the audit record are one
 *     transaction. A confirmed booking the member was never told about is a
 *     support ticket; an audit trail that disagrees with the data is worse than
 *     none, because it would be trusted.
 *
 * The module is pure domain logic over injected repositories: no Express, no
 * SQL, no clock of its own. That is what makes the workflow tests run without a
 * database.
 */

const STATUS = Object.freeze({
  PENDING: "pending",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
});

/** Statuses a member is allowed to cancel from. */
const CANCELLABLE = new Set([STATUS.PENDING, STATUS.CONFIRMED]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function assertCanReview(actor, policy) {
  if (!actor || !actor.role) throw forbidden("Unknown actor");
  if (!isApprover("booking", actor.role, policy)) {
    throw forbidden(`Your role (${actor.role}) is not configured to approve booking requests`);
  }
}

/** Whole days from `now` (UTC calendar date) to `bookingDate` (YYYY-MM-DD). */
function daysAhead(bookingDate, now) {
  const target = Date.parse(`${bookingDate}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / MS_PER_DAY);
}

/**
 * Create a booking.
 *
 * Pending by default; confirmed immediately when the facility is configured not
 * to require approval.
 *
 * @param {object} deps
 * @param {object} deps.bookings      booking repository
 * @param {object} deps.facilities    facility repository
 * @param {object} [deps.notifications]
 * @param {object} [deps.audit]
 * @param {Function} [deps.transaction]
 * @param {() => Date} [deps.now]     injectable clock, for the advance-window check
 * @param {object} input  { facilityId, memberId, dependentId, bookingDate, startsAt, endsAt, notes }
 */
async function requestBooking(deps, input) {
  const { bookings, facilities, now = () => new Date() } = deps;

  const facility = await facilities.findActiveById(input.facilityId);
  if (!facility) throw notFound("Facility not found");

  if (input.startsAt >= input.endsAt) {
    throw badRequest("Validation failed", { ends_at: "must be later than starts_at" });
  }

  // How far ahead the tenant lets members book this facility. Without this the
  // column is decoration: it is returned by GET /facilities and a client that
  // respects it is doing the server's job.
  const limit = Number(facility.max_advance_days);
  if (Number.isFinite(limit) && limit > 0) {
    const ahead = daysAhead(input.bookingDate, now());
    if (ahead > limit) {
      throw new ApiError(
        400,
        `This facility can only be booked up to ${limit} days ahead`,
        { booking_date: `is ${ahead} days ahead; the limit is ${limit}` },
        "booking_too_far_ahead"
      );
    }
  }

  const closure = await facilities.findClosure({
    facilityId: input.facilityId,
    bookingDate: input.bookingDate,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
  });
  if (closure) throw conflict("The facility is closed during that period");

  // At request time a pending booking blocks the slot, so the availability view
  // does not offer a slot somebody is already queued for.
  const clash = await bookings.findOverlapping({
    facilityId: input.facilityId,
    bookingDate: input.bookingDate,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    statuses: [STATUS.PENDING, STATUS.CONFIRMED],
  });
  if (clash) throw conflict("That slot is already taken");

  const autoConfirm = !facility.requires_approval;
  if (!autoConfirm) {
    const id = await bookings.create({
      facilityId: input.facilityId,
      memberId: input.memberId,
      dependentId: input.dependentId || null,
      bookingDate: input.bookingDate,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      notes: input.notes || null,
      // Not a parameter. A caller cannot ask for a confirmed booking.
      status: STATUS.PENDING,
    });
    return { id, status: STATUS.PENDING, auto_confirmed: false };
  }

  return createAutoConfirmed(deps, input, facility);
}

/**
 * The `requires_approval = 0` path. Same guarantees as an approval: the
 * confirmed-overlap check, the notification and the audit record all happen
 * inside one transaction.
 */
async function createAutoConfirmed(deps, input, facility) {
  const { bookings, notifications, audit, transaction } = deps;
  const run = transaction || ((fn) => fn({ bookings, notifications, audit }));

  return run(async (tx) => {
    // Re-check inside the transaction against confirmed bookings only. Another
    // auto-confirming request may have landed since the check above.
    const clash = await tx.bookings.findOverlapping({
      facilityId: input.facilityId,
      bookingDate: input.bookingDate,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      statuses: [STATUS.CONFIRMED],
    });
    if (clash) throw conflict("That slot is already taken");

    const id = await tx.bookings.create({
      facilityId: input.facilityId,
      memberId: input.memberId,
      dependentId: input.dependentId || null,
      bookingDate: input.bookingDate,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      notes: input.notes || null,
      status: STATUS.CONFIRMED,
      reviewNote: "Auto-confirmed: this facility does not require approval",
    });

    if (tx.notifications) {
      await tx.notifications.create({
        memberId: input.memberId,
        category: "booking",
        title: "Booking confirmed",
        body: `Your booking for ${input.bookingDate} at ${String(input.startsAt).slice(0, 5)} is confirmed.`,
        refEntity: "booking",
        refId: id,
      });
    }

    if (tx.audit) {
      await tx.audit.record({
        actorType: "member",
        actorId: input.memberId,
        action: ACTIONS.BOOKING_AUTO_CONFIRMED,
        entity: ENTITIES.BOOKING,
        entityId: id,
        metadata: {
          before: { status: null },
          after: { status: STATUS.CONFIRMED },
          reason: "facility.requires_approval = 0",
          facility_id: facility.id,
          facility_name: facility.name,
          booking_date: input.bookingDate,
          starts_at: input.startsAt,
          ends_at: input.endsAt,
        },
      });
    }

    return { id, status: STATUS.CONFIRMED, auto_confirmed: true };
  });
}

/**
 * Approve a pending booking.
 *
 * @param {object} deps  { bookings, notifications, audit, transaction, policy }
 * @param {object} input { bookingId, actor: { userId, role }, note }
 */
async function approveBooking(deps, input) {
  const { bookings, notifications, audit, transaction, policy } = deps;
  const { bookingId, actor, note } = input;

  assertCanReview(actor, policy);

  const booking = await bookings.findById(bookingId);
  if (!booking) throw notFound("Booking not found");
  if (booking.status !== STATUS.PENDING) {
    throw badRequest(`Booking is ${booking.status}, not pending`);
  }

  // Re-check against confirmed bookings only — see the note at the top.
  const clash = await bookings.findOverlapping({
    facilityId: booking.facility_id,
    bookingDate: booking.booking_date,
    startsAt: booking.starts_at,
    endsAt: booking.ends_at,
    statuses: [STATUS.CONFIRMED],
    excludeId: booking.id,
  });
  if (clash) throw conflict("Another booking has already been confirmed for that slot");

  const run = transaction || ((fn) => fn({ bookings, notifications, audit }));

  await run(async (tx) => {
    await tx.bookings.confirm({ id: booking.id, reviewerId: actor.userId, note: note || null });
    await tx.notifications.create({
      memberId: booking.member_id,
      category: "booking",
      title: "Booking confirmed",
      body: `Your booking for ${booking.booking_date} at ${String(booking.starts_at).slice(0, 5)} has been confirmed.`,
      refEntity: "booking",
      refId: booking.id,
    });
    if (tx.audit) {
      await tx.audit.record({
        actorType: "staff",
        actorId: actor.userId,
        action: ACTIONS.BOOKING_APPROVED,
        entity: ENTITIES.BOOKING,
        entityId: booking.id,
        metadata: {
          before: { status: booking.status },
          after: { status: STATUS.CONFIRMED },
          actor_role: actor.role,
          note: note || null,
          member_id: booking.member_id,
          facility_id: booking.facility_id,
          booking_date: booking.booking_date,
        },
      });
    }
  });

  return { id: booking.id, status: STATUS.CONFIRMED };
}

/** Reject a pending booking. */
async function rejectBooking(deps, input) {
  const { bookings, notifications, audit, transaction, policy } = deps;
  const { bookingId, actor, note } = input;

  assertCanReview(actor, policy);

  const booking = await bookings.findById(bookingId);
  if (!booking) throw notFound("Booking not found");
  if (booking.status !== STATUS.PENDING) {
    throw badRequest(`Booking is ${booking.status}, not pending`);
  }

  const run = transaction || ((fn) => fn({ bookings, notifications, audit }));
  const reason = note || "Declined by the association staff.";

  await run(async (tx) => {
    await tx.bookings.reject({ id: booking.id, reviewerId: actor.userId, note: reason });
    await tx.notifications.create({
      memberId: booking.member_id,
      category: "booking",
      title: "Booking declined",
      body: reason,
      refEntity: "booking",
      refId: booking.id,
    });
    if (tx.audit) {
      await tx.audit.record({
        actorType: "staff",
        actorId: actor.userId,
        action: ACTIONS.BOOKING_REJECTED,
        entity: ENTITIES.BOOKING,
        entityId: booking.id,
        metadata: {
          before: { status: booking.status },
          after: { status: STATUS.REJECTED },
          actor_role: actor.role,
          note: reason,
          member_id: booking.member_id,
          facility_id: booking.facility_id,
          booking_date: booking.booking_date,
        },
      });
    }
  });

  return { id: booking.id, status: STATUS.REJECTED };
}

/** Member-initiated cancellation. No approval needed. */
async function cancelBooking({ bookings }, { bookingId, memberId }) {
  const booking = await bookings.findByIdForMember(bookingId, memberId);
  if (!booking) throw notFound("Booking not found");
  if (!CANCELLABLE.has(booking.status)) {
    throw badRequest(`A ${booking.status} booking cannot be cancelled`);
  }
  await bookings.cancel({ id: booking.id, note: "Cancelled by the member" });
  return { id: booking.id, status: STATUS.CANCELLED };
}

module.exports = {
  STATUS,
  CANCELLABLE,
  daysAhead,
  requestBooking,
  approveBooking,
  rejectBooking,
  cancelBooking,
};
