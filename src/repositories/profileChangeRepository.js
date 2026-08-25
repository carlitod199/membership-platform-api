"use strict";

/** Parse a JSON column that MySQL may hand back as a string or as an object. */
function parseJson(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value) || {};
  } catch (error) {
    return {};
  }
}

function hydrate(row) {
  if (!row) return row;
  return {
    ...row,
    current_values: parseJson(row.current_values),
    requested_values: parseJson(row.requested_values),
  };
}

function createProfileChangeRepository(scope) {
  return {
    async findById(id) {
      const row = await scope.selectOne(
        `SELECT id, tenant_id, member_id, current_values, requested_values, status,
                reviewed_by, reviewed_at, review_note, created_at
           FROM profile_change_requests
          WHERE id = ? AND tenant_id = :tenant`,
        [id]
      );
      return hydrate(row);
    },

    async findPendingForMember(memberId) {
      const row = await scope.selectOne(
        `SELECT id, created_at FROM profile_change_requests
          WHERE member_id = ? AND tenant_id = :tenant AND status = 'pending'
          LIMIT 1`,
        [memberId]
      );
      return row;
    },

    async listForMember(memberId) {
      const rows = await scope.select(
        `SELECT id, current_values, requested_values, status, review_note,
                reviewed_at, created_at
           FROM profile_change_requests
          WHERE member_id = ? AND tenant_id = :tenant
          ORDER BY created_at DESC
          LIMIT 100`,
        [memberId]
      );
      return rows.map(hydrate);
    },

    async listByStatus(status, { limit = 100, offset = 0 } = {}) {
      const rows = await scope.select(
        `SELECT r.id, r.member_id, m.full_name AS member_name, m.membership_number,
                r.current_values, r.requested_values, r.status, r.created_at
           FROM profile_change_requests r
           JOIN members m ON m.id = r.member_id AND m.tenant_id = :tenant
          WHERE r.tenant_id = :tenant AND r.status = ?
          ORDER BY r.created_at ASC
          LIMIT ? OFFSET ?`,
        [status, limit, offset]
      );
      return rows.map(hydrate);
    },

    async create({ memberId, currentValues, requestedValues, status }) {
      const result = await scope.insert("profile_change_requests", {
        member_id: memberId,
        current_values: JSON.stringify(currentValues || {}),
        requested_values: JSON.stringify(requestedValues || {}),
        status,
      });
      return result.insertId;
    },

    async approve({ id, reviewerId, note }) {
      const result = await scope.execute(
        `UPDATE profile_change_requests
            SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(), review_note = ?
          WHERE id = ? AND tenant_id = :tenant AND status = 'pending'`,
        [reviewerId, note, id]
      );
      return result.affectedRows > 0;
    },

    async reject({ id, reviewerId, note }) {
      const result = await scope.execute(
        `UPDATE profile_change_requests
            SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), review_note = ?
          WHERE id = ? AND tenant_id = :tenant AND status = 'pending'`,
        [reviewerId, note, id]
      );
      return result.affectedRows > 0;
    },
  };
}

module.exports = { createProfileChangeRepository, parseJson };
