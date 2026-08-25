"use strict";

const express = require("express");

const { asyncHandler, ok, created } = require("../lib/http");
const { notFound } = require("../lib/errors");
const { requireMember, requirePrimaryMember } = require("../middleware/authenticate");
const { repositoriesFor } = require("../repositories");
const workflow = require("../services/profileChangeWorkflow");
const env = require("../config/env");

const router = express.Router();
router.use(requireMember);

/**
 * Member profile.
 *
 * There is no `PUT /profile`. A member cannot write to their own record — see
 * src/services/profileChangeWorkflow.js for why. The only write available here
 * creates a *request*.
 */

// GET /profile
router.get(
  "/",
  requirePrimaryMember,
  asyncHandler(async (req, res) => {
    const { members } = repositoriesFor(req);
    const member = await members.findById(req.member.memberId);
    if (!member) throw notFound("Member not found");
    ok(res, member);
  })
);

// GET /profile/dependents
router.get(
  "/dependents",
  requirePrimaryMember,
  asyncHandler(async (req, res) => {
    const { members } = repositoriesFor(req);
    ok(res, await members.listDependents(req.member.memberId));
  })
);

// GET /profile/editable-fields — what a change request may contain
router.get("/editable-fields", (req, res) => ok(res, { fields: env.memberEditableFields }));

// POST /profile/change-requests — creates a PENDING request, writes nothing
router.post(
  "/change-requests",
  requirePrimaryMember,
  asyncHandler(async (req, res) => {
    const repositories = repositoriesFor(req);
    const result = await workflow.requestProfileChange(repositories, {
      memberId: req.member.memberId,
      // The whole body is passed deliberately: filterEditable() is an
      // allow-list, so unknown keys are dropped rather than rejected. The
      // tenant guard has already removed any tenant identifier.
      values: req.body,
    });
    created(res, {
      ...result,
      message: "Submitted for review. Your details are unchanged until staff approve it.",
    });
  })
);

// GET /profile/change-requests
router.get(
  "/change-requests",
  requirePrimaryMember,
  asyncHandler(async (req, res) => {
    const { requests } = repositoriesFor(req);
    ok(res, await requests.listForMember(req.member.memberId));
  })
);

module.exports = router;
