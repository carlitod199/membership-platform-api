"use strict";

/**
 * Booking data access.
 *
 * Every statement carries `:tenant`. That is not a convention the author
 * remembered to follow — the scope refuses to run anything else (see
 * src/data/tenantScope.js). The repository exists so the workflow service in
 * src/services/bookingWorkflow.js can be tested against an in-memory double
 * with the same method names.
 */
function createBookingRepository(scope) {
  return {
    async findById(id) {
      return scope.selectOne(
        `SELECT id, tenant_id, facility_id, member_id, dependent_id, booking_date,
                starts_at, ends_at, notes, status, reviewed_by, reviewed_at, review_note,
                created_at
           FROM bookings
          WHERE id = ? AND tenant_id = :tenant`,
        [id]
      );
    },

    async findByIdForMember(id, memberId) {
      return scope.selectOne(
        `SELECT id, tenant_id, facility_id, member_id, booking_date, starts_at, ends_at, status
           FROM bookings
          WHERE id = ? AND member_id = ? AND tenant_id = :tenant`,
        [id, memberId]
      );
    },

    async listForMember(memberId, { limit = 100, offset = 0 } = {}) {
      return scope.select(
        `SELECT b.id, b.facility_id, f.name AS facility_name, b.booking_date,
                b.starts_at, b.ends_at, b.status, b.notes, b.review_note,
                b.reviewed_at, b.created_at
           FROM bookings b
           JOIN facilities f ON f.id = b.facility_id AND f.tenant_id = :tenant
          WHERE b.member_id = ? AND b.tenant_id = :tenant
          ORDER BY b.booking_date DESC, b.starts_at DESC
          LIMIT ? OFFSET ?`,
        [memberId, limit, offset]
      );
    },

    async listByStatus(status, { limit = 100, offset = 0 } = {}) {
      return scope.select(
        `SELECT b.id, b.facility_id, f.name AS facility_name, b.member_id,
                m.full_name AS member_name, m.membership_number, b.booking_date,
                b.starts_at, b.ends_at, b.notes, b.status, b.created_at
           FROM bookings b
           JOIN facilities f ON f.id = b.facility_id AND f.tenant_id = :tenant
           JOIN members m ON m.id = b.member_id AND m.tenant_id = :tenant
          WHERE b.tenant_id = :tenant AND b.status = ?
          ORDER BY b.booking_date ASC, b.starts_at ASC
          LIMIT ? OFFSET ?`,
        [status, limit, offset]
      );
    },

    /**
     * Any booking on the same facility and date whose interval overlaps
     * [startsAt, endsAt) and whose status is in `statuses`.
     * Half-open comparison, so 10:00-11:00 and 11:00-12:00 do not collide.
     */
    async findOverlapping({ facilityId, bookingDate, startsAt, endsAt, statuses, excludeId = 0 }) {
      const placeholders = statuses.map(() => "?").join(", ");
      return scope.selectOne(
        `SELECT id FROM bookings
          WHERE tenant_id = :tenant
            AND facility_id = ?
            AND booking_date = ?
            AND status IN (${placeholders})
            AND starts_at < ?
            AND ends_at > ?
            AND id <> ?
          LIMIT 1`,
        [facilityId, bookingDate, ...statuses, endsAt, startsAt, excludeId || 0]
      );
    },

    /**
     * `status` is set by the workflow, never by a request. It is 'pending' for
     * a facility that requires approval and 'confirmed' for one that does not
     * — see src/services/bookingWorkflow.js.
     */
    async create(data) {
      const result = await scope.insert("bookings", {
        facility_id: data.facilityId,
        member_id: data.memberId,
        dependent_id: data.dependentId,
        booking_date: data.bookingDate,
        starts_at: data.startsAt,
        ends_at: data.endsAt,
        notes: data.notes,
        status: data.status,
        review_note: data.reviewNote || null,
        reviewed_at: data.status === "confirmed" ? new Date() : null,
      });
      return result.insertId;
    },

    /**
     * The staff approval transition. The `status = 'pending'` predicate makes it
     * idempotent under a double click: the second call changes zero rows.
     */
    async confirm({ id, reviewerId, note }) {
      const result = await scope.execute(
        `UPDATE bookings
            SET status = 'confirmed', reviewed_by = ?, reviewed_at = NOW(), review_note = ?
          WHERE id = ? AND tenant_id = :tenant AND status = 'pending'`,
        [reviewerId, note, id]
      );
      return result.affectedRows > 0;
    },

    async reject({ id, reviewerId, note }) {
      const result = await scope.execute(
        `UPDATE bookings
            SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), review_note = ?
          WHERE id = ? AND tenant_id = :tenant AND status = 'pending'`,
        [reviewerId, note, id]
      );
      return result.affectedRows > 0;
    },

    async cancel({ id, note }) {
      const result = await scope.execute(
        `UPDATE bookings
            SET status = 'cancelled', cancelled_at = NOW(), review_note = ?
          WHERE id = ? AND tenant_id = :tenant AND status IN ('pending', 'confirmed')`,
        [note, id]
      );
      return result.affectedRows > 0;
    },
  };
}

module.exports = { createBookingRepository };
