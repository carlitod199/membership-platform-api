"use strict";

/**
 * Member notifications.
 *
 * Written by the approval workflows inside the same transaction as the state
 * change, so a member is never left unaware of a decision that has already
 * taken effect. Delivery to a device is a separate concern — this table is the
 * durable record and the in-app inbox; see NOTES.md, "Not implemented".
 */
function createNotificationRepository(scope) {
  return {
    async create({ memberId, dependentId = null, category, title, body, refEntity = null, refId = null }) {
      const result = await scope.insert("notifications", {
        member_id: memberId || null,
        dependent_id: dependentId,
        category,
        title,
        body,
        ref_entity: refEntity,
        ref_id: refId,
      });
      return result.insertId;
    },

    async listFor({ column, id }, { limit = 50, offset = 0 } = {}) {
      // `column` is chosen by the caller from a fixed pair, never from input.
      const target = column === "dependent_id" ? "dependent_id" : "member_id";
      return scope.select(
        `SELECT id, category, title, body, ref_entity, ref_id, read_at, created_at
           FROM notifications
          WHERE tenant_id = :tenant AND ${target} = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?`,
        [id, limit, offset]
      );
    },

    async unreadCount({ column, id }) {
      const target = column === "dependent_id" ? "dependent_id" : "member_id";
      const value = await scope.selectValue(
        `SELECT COUNT(*) AS unread FROM notifications
          WHERE tenant_id = :tenant AND ${target} = ? AND read_at IS NULL`,
        [id]
      );
      return Number(value || 0);
    },

    async markRead({ column, id, notificationId }) {
      const target = column === "dependent_id" ? "dependent_id" : "member_id";
      const result = await scope.execute(
        `UPDATE notifications SET read_at = NOW()
          WHERE id = ? AND tenant_id = :tenant AND ${target} = ? AND read_at IS NULL`,
        [notificationId, id]
      );
      return result.affectedRows > 0;
    },

    async markAllRead({ column, id }) {
      const target = column === "dependent_id" ? "dependent_id" : "member_id";
      const result = await scope.execute(
        `UPDATE notifications SET read_at = NOW()
          WHERE tenant_id = :tenant AND ${target} = ? AND read_at IS NULL`,
        [id]
      );
      return result.affectedRows;
    },
  };
}

module.exports = { createNotificationRepository };
