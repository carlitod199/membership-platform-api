"use strict";

const express = require("express");

const { requireStaff } = require("../../middleware/authenticate");

const router = express.Router();

/**
 * The staff surface.
 *
 * Everything below /admin except the login endpoints requires a staff-scope
 * token. `requireStaff` is applied per sub-router rather than once at the top
 * of this file so that /admin/auth/login stays reachable — an auth guard in
 * front of the login route is a classic self-inflicted outage.
 */

router.use("/auth", require("./auth"));
router.use("/members", requireStaff, require("./members"));
router.use("/bookings", requireStaff, require("./bookings"));
router.use("/profile-change-requests", requireStaff, require("./profileChangeRequests"));
router.use("/roles", requireStaff, require("./roles"));
router.use("/audit-logs", requireStaff, require("./auditLogs"));

module.exports = router;
