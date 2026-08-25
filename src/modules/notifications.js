"use strict";

const express = require("express");

const { asyncHandler, ok, pagination } = require("../lib/http");
const { requireId } = require("../lib/validate");
const { notFound } = require("../lib/errors");
const { requireMember } = require("../middleware/authenticate");
const { repositoriesFor } = require("../repositories");

const router = express.Router();
router.use(requireMember);

/**
 * The in-app inbox. Available to dependents as well as primary members, so the
 * recipient column is chosen from the token, never from a parameter.
 */
function recipient(req) {
  return req.member.memberId
    ? { column: "member_id", id: req.member.memberId }
    : { column: "dependent_id", id: req.member.dependentId };
}

// GET /notifications
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { limit, offset, page } = pagination(req.query);
    const { notifications } = repositoriesFor(req);
    ok(res, await notifications.listFor(recipient(req), { limit, offset }), { page, limit });
  })
);

// GET /notifications/unread-count
router.get(
  "/unread-count",
  asyncHandler(async (req, res) => {
    const { notifications } = repositoriesFor(req);
    ok(res, { unread: await notifications.unreadCount(recipient(req)) });
  })
);

// PATCH /notifications/:id/read
router.patch(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const { notifications } = repositoriesFor(req);
    const target = recipient(req);
    const updated = await notifications.markRead({ ...target, notificationId: id });
    if (!updated) throw notFound("Notification not found or already read");
    ok(res, { id, read: true });
  })
);

// PATCH /notifications/read-all
router.patch(
  "/read-all",
  asyncHandler(async (req, res) => {
    const { notifications } = repositoriesFor(req);
    const count = await notifications.markAllRead(recipient(req));
    ok(res, { marked: count });
  })
);

module.exports = router;
module.exports.recipient = recipient;
