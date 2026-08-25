"use strict";

function createFacilityRepository(scope) {
  return {
    async list() {
      return scope.select(
        `SELECT id, name, kind, description, capacity, opens_at, closes_at,
                slot_minutes, requires_approval, max_advance_days
           FROM facilities
          WHERE tenant_id = :tenant AND is_active = 1 AND deleted_at IS NULL
          ORDER BY name`
      );
    },

    async findActiveById(id) {
      return scope.selectOne(
        `SELECT id, name, kind, capacity, opens_at, closes_at, slot_minutes,
                requires_approval, max_advance_days
           FROM facilities
          WHERE id = ? AND tenant_id = :tenant AND is_active = 1 AND deleted_at IS NULL`,
        [id]
      );
    },

    /** A maintenance/closure window covering any part of the requested slot. */
    async findClosure({ facilityId, bookingDate, startsAt, endsAt }) {
      return scope.selectOne(
        `SELECT id, reason FROM facility_closures
          WHERE tenant_id = :tenant
            AND facility_id = ?
            AND starts_at < ?
            AND ends_at > ?
          LIMIT 1`,
        [facilityId, `${bookingDate} ${endsAt}`, `${bookingDate} ${startsAt}`]
      );
    },

    async listClosuresForDate(facilityId, bookingDate) {
      return scope.select(
        `SELECT starts_at, ends_at, reason FROM facility_closures
          WHERE tenant_id = :tenant AND facility_id = ?
            AND starts_at < ? AND ends_at > ?`,
        [facilityId, `${bookingDate} 23:59:59`, `${bookingDate} 00:00:00`]
      );
    },

    async listBookingsForDate(facilityId, bookingDate) {
      return scope.select(
        `SELECT starts_at, ends_at, status FROM bookings
          WHERE tenant_id = :tenant AND facility_id = ? AND booking_date = ?
            AND status IN ('pending', 'confirmed')`,
        [facilityId, bookingDate]
      );
    },
  };
}

module.exports = { createFacilityRepository };
