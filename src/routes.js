"use strict";

const express = require("express");

const router = express.Router();

/**
 * Route table.
 *
 * The split is the security boundary, not an organisational one:
 *
 *   /auth, /profile, /facilities, /bookings, /invoices,
 *   /guest-passes, /notifications          → member-scope tokens
 *   /admin/*                               → staff-scope tokens
 *
 * A member token presented under /admin fails at the token's `scope` claim
 * before any handler is reached, and vice versa. Keeping the two trees separate
 * means no route can accidentally be reachable from both.
 */

router.use("/health", require("./modules/health"));

// Member surface
router.use("/auth", require("./modules/auth"));
router.use("/profile", require("./modules/profile"));
router.use("/facilities", require("./modules/facilities"));
router.use("/bookings", require("./modules/bookings"));
router.use("/invoices", require("./modules/invoices"));
router.use("/guest-passes", require("./modules/guestPasses"));
router.use("/notifications", require("./modules/notifications"));

// Staff surface
router.use("/admin", require("./modules/admin"));

module.exports = router;
