"use strict";

const { TenantScopeError } = require("../data/tenantScope");
const env = require("../config/env");

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function createMemberRepository(scope) {
  return {
    async findById(id) {
      return scope.selectOne(
        `SELECT m.id, m.tenant_id, m.membership_number, m.full_name, m.email, m.phone,
                m.mobile, m.address_line1, m.address_line2, m.city, m.state, m.postal_code,
                m.status, m.billing_status, m.joined_on, m.photo_path,
                mc.name AS category_name
           FROM members m
           LEFT JOIN membership_categories mc
                  ON mc.id = m.category_id AND mc.tenant_id = :tenant
          WHERE m.id = ? AND m.tenant_id = :tenant AND m.deleted_at IS NULL`,
        [id]
      );
    },

    async findDependentById(id) {
      return scope.selectOne(
        `SELECT id, tenant_id, member_id, full_name, relationship, date_of_birth, status
           FROM dependents
          WHERE id = ? AND tenant_id = :tenant AND deleted_at IS NULL`,
        [id]
      );
    },

    async listDependents(memberId) {
      return scope.select(
        `SELECT id, full_name, relationship, date_of_birth, status,
                TIMESTAMPDIFF(YEAR, date_of_birth, CURDATE()) AS age
           FROM dependents
          WHERE member_id = ? AND tenant_id = :tenant AND deleted_at IS NULL
          ORDER BY full_name`,
        [memberId]
      );
    },

    async listMembers({ search = null, status = null, limit = 50, offset = 0 } = {}) {
      const clauses = [];
      const params = [];
      if (search) {
        clauses.push("(m.full_name LIKE ? OR m.membership_number LIKE ? OR m.email LIKE ?)");
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      if (status) {
        clauses.push("m.status = ?");
        params.push(status);
      }
      const extra = clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
      return scope.select(
        `SELECT m.id, m.membership_number, m.full_name, m.email, m.status, m.billing_status,
                m.joined_on
           FROM members m
          WHERE m.tenant_id = :tenant AND m.deleted_at IS NULL${extra}
          ORDER BY m.full_name
          LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
    },

    /**
     * Write approved profile changes.
     *
     * The column list is built from the caller's keys, so it is validated
     * against the configured allow-list *and* an identifier pattern before it
     * is interpolated. Values stay parameterised. This is the only place in the
     * codebase that builds a SET clause dynamically, and it is why the check is
     * this explicit.
     */
    async applyChanges({ memberId, values, actorId }) {
      const fields = Object.keys(values || {});
      if (fields.length === 0) return false;
      for (const field of fields) {
        if (!IDENTIFIER.test(field) || !env.memberEditableFields.includes(field)) {
          throw new TenantScopeError(`Refusing to update non-allow-listed column: ${field}`);
        }
      }
      const assignments = fields.map((f) => `\`${f}\` = ?`).join(", ");
      const result = await scope.execute(
        `UPDATE members
            SET ${assignments}, updated_by = ?, updated_at = NOW()
          WHERE id = ? AND tenant_id = :tenant AND deleted_at IS NULL`,
        [...fields.map((f) => values[f]), actorId, memberId]
      );
      return result.affectedRows > 0;
    },
  };
}

module.exports = { createMemberRepository, IDENTIFIER };
