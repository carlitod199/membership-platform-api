"use strict";

const express = require("express");

const { asyncHandler, ok } = require("../../lib/http");
const { authorize } = require("../../middleware/authorize");
const env = require("../../config/env");

const router = express.Router();

/**
 * RBAC introspection.
 *
 * An admin UI needs to know which permissions exist and which roles hold them
 * in order to render a role editor. Exposing it read-only also makes the
 * authorization model inspectable, which is worth a lot when debugging a
 * "why can't I click this" report.
 */

// GET /admin/roles
router.get(
  "/",
  authorize("settings.view"),
  asyncHandler(async (req, res) => {
    const roles = await req.scope.select(
      `SELECT r.id, r.role_key, r.name, r.description,
              COUNT(rp.permission_id) AS permission_count
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.tenant_id = :tenant
        WHERE r.tenant_id = :tenant
        GROUP BY r.id, r.role_key, r.name, r.description
        ORDER BY r.name`
    );
    const grants = await req.scope.select(
      `SELECT r.role_key, p.permission_key
         FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id AND rp.tenant_id = :tenant
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.tenant_id = :tenant
        ORDER BY r.role_key, p.permission_key`
    );

    const byRole = {};
    for (const grant of grants) {
      (byRole[grant.role_key] = byRole[grant.role_key] || []).push(grant.permission_key);
    }

    ok(res, {
      roles: roles.map((role) => ({ ...role, permissions: byRole[role.role_key] || [] })),
      approval_policy: env.approvals,
    });
  })
);

// GET /admin/permissions — the catalogue, tenant-independent
router.get(
  "/permissions",
  authorize("settings.view"),
  asyncHandler(async (req, res) => {
    // `permissions` is a global catalogue with no tenant_id column, so it is
    // reached through a join that is itself tenant-scoped rather than read
    // directly. The scope still enforces its rule.
    const rows = await req.scope.select(
      `SELECT DISTINCT p.id, p.permission_key, p.description, p.category
         FROM permissions p
         LEFT JOIN role_permissions rp ON rp.permission_id = p.id AND rp.tenant_id = :tenant
        ORDER BY p.category, p.permission_key`
    );
    ok(res, rows);
  })
);

module.exports = router;
