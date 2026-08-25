"use strict";

/**
 * Audit log.
 *
 * Approvals are decisions someone is accountable for. Six months later the
 * question is not "what does this booking say now" but "who confirmed it, when,
 * and what did the record look like before". That is what this table answers.
 *
 * Two rules the writers follow:
 *
 *   1. An audit row is written inside the same transaction as the state change
 *      it describes. An approval that committed without its audit row, or an
 *      audit row for an approval that rolled back, are both worse than no audit
 *      trail at all, because they would be trusted.
 *   2. `metadata` carries the before/after the workflow already had in hand. It
 *      is JSON rather than columns because the shape differs per action and
 *      because nothing queries inside it — it is read by a human looking at one
 *      row.
 *
 * The table is append-only by convention: this repository exposes no update and
 * no delete, and nothing else in the codebase writes to `audit_logs`.
 */

const ACTIONS = Object.freeze({
  BOOKING_APPROVED: "booking.approved",
  BOOKING_REJECTED: "booking.rejected",
  BOOKING_AUTO_CONFIRMED: "booking.auto_confirmed",
  PROFILE_CHANGE_APPROVED: "profile_change.approved",
  PROFILE_CHANGE_REJECTED: "profile_change.rejected",
  PASSWORD_RESET_COMPLETED: "password_reset.completed",
  SESSION_REVOKED: "session.revoked",
  SESSIONS_REVOKED_ALL: "session.revoked_all",
});

const ENTITIES = Object.freeze({
  BOOKING: "booking",
  PROFILE_CHANGE_REQUEST: "profile_change_request",
  CREDENTIAL: "credential",
  SESSION: "session",
});

/** JSON that is safe to store: never a password, hash or token. */
const FORBIDDEN_METADATA = /(password|token|secret|hash|credential)/i;

function assertSafeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return;
  for (const key of Object.keys(metadata)) {
    if (FORBIDDEN_METADATA.test(key)) {
      throw new Error(`Refusing to write "${key}" into an audit record`);
    }
  }
}

function createAuditRepository(scope) {
  return {
    ACTIONS,
    ENTITIES,

    /**
     * @param {object} entry
     * @param {"member"|"staff"|"system"} entry.actorType
     * @param {number|null} entry.actorId
     * @param {string} entry.action    one of ACTIONS
     * @param {string} entry.entity    one of ENTITIES
     * @param {number|null} entry.entityId
     * @param {object} [entry.metadata] before/after and any decision context
     * @param {string} [entry.ip]
     * @param {string} [entry.userAgent]
     */
    async record(entry) {
      assertSafeMetadata(entry.metadata);
      const result = await scope.insert("audit_logs", {
        actor_type: entry.actorType,
        actor_id: entry.actorId === undefined ? null : entry.actorId,
        action: entry.action,
        entity: entry.entity,
        entity_id: entry.entityId === undefined ? null : entry.entityId,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
        ip_address: entry.ip ? String(entry.ip).slice(0, 45) : null,
        user_agent: entry.userAgent ? String(entry.userAgent).slice(0, 255) : null,
      });
      return result.insertId;
    },

    /** Newest first, optionally narrowed to one entity type. */
    async list({ entity = null, limit = 50, offset = 0 } = {}) {
      const filter = entity ? " AND a.entity = ?" : "";
      const params = entity ? [entity] : [];
      const rows = await scope.select(
        `SELECT a.id, a.actor_type, a.actor_id, u.full_name AS actor_name,
                a.action, a.entity, a.entity_id, a.metadata, a.ip_address, a.created_at
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_id
                            AND u.tenant_id = :tenant
                            AND a.actor_type = 'staff'
          WHERE a.tenant_id = :tenant${filter}
          ORDER BY a.id DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      return rows.map((row) => ({
        ...row,
        metadata: typeof row.metadata === "string" ? safeParse(row.metadata) : row.metadata,
      }));
    },

    /** Everything recorded about one entity, oldest first — its history. */
    async listForEntity(entity, entityId, { limit = 100 } = {}) {
      const rows = await scope.select(
        `SELECT id, actor_type, actor_id, action, entity, entity_id, metadata, created_at
           FROM audit_logs
          WHERE tenant_id = :tenant AND entity = ? AND entity_id = ?
          ORDER BY id ASC
          LIMIT ?`,
        [entity, entityId, limit]
      );
      return rows.map((row) => ({
        ...row,
        metadata: typeof row.metadata === "string" ? safeParse(row.metadata) : row.metadata,
      }));
    },
  };
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

module.exports = { createAuditRepository, ACTIONS, ENTITIES };
