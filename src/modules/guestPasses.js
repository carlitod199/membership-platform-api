"use strict";

const express = require("express");

const { asyncHandler, ok, created, pagination } = require("../lib/http");
const { validate, requireId } = require("../lib/validate");
const { notFound, badRequest } = require("../lib/errors");
const { requireMember, requirePrimaryMember } = require("../middleware/authenticate");
const { randomToken } = require("../lib/tokens");

const router = express.Router();
router.use(requireMember, requirePrimaryMember);

/**
 * Guest passes.
 *
 * A member registers a guest ahead of a visit and receives a pass code. The
 * code is a 128-bit random value, not a sequential id, so it cannot be guessed
 * or enumerated from a neighbouring pass.
 *
 * Redeeming a pass at a door is out of scope — that needs a physical access
 * control integration, which is intentionally absent. The pass is issued and
 * tracked here; presenting it is a front-desk procedure.
 */

const PASS_CODE_BYTES = 16;

// GET /guest-passes
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { limit, offset, page } = pagination(req.query);
    const rows = await req.scope.select(
      `SELECT id, guest_name, guest_document, guest_phone, visit_date, valid_from,
              valid_until, status, used_at, created_at
         FROM guest_passes
        WHERE member_id = ? AND tenant_id = :tenant AND deleted_at IS NULL
        ORDER BY visit_date DESC, id DESC
        LIMIT ? OFFSET ?`,
      [req.member.memberId, limit, offset]
    );
    ok(res, rows, { page, limit });
  })
);

// POST /guest-passes
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = validate(req.body, {
      guest_name: { required: true, type: "string", minLength: 2, maxLength: 150 },
      guest_document: { type: "string", maxLength: 40 },
      guest_phone: { type: "string", maxLength: 30 },
      visit_date: { required: true, type: "date" },
      valid_from: { type: "time" },
      valid_until: { type: "time" },
      notes: { type: "string", maxLength: 255 },
    });

    if (input.valid_from && input.valid_until && input.valid_from >= input.valid_until) {
      throw badRequest("Validation failed", { valid_until: "must be later than valid_from" });
    }

    const passCode = randomToken(PASS_CODE_BYTES);
    const result = await req.scope.insert("guest_passes", {
      member_id: req.member.memberId,
      guest_name: input.guest_name,
      guest_document: input.guest_document || null,
      guest_phone: input.guest_phone || null,
      visit_date: input.visit_date,
      valid_from: input.valid_from || null,
      valid_until: input.valid_until || null,
      notes: input.notes || null,
      pass_code: passCode,
      status: "issued",
    });

    created(res, {
      id: result.insertId,
      pass_code: passCode,
      status: "issued",
      visit_date: input.visit_date,
      guest_name: input.guest_name,
    });
  })
);

// GET /guest-passes/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const pass = await req.scope.selectOne(
      `SELECT id, guest_name, guest_document, visit_date, valid_from, valid_until,
              pass_code, status, used_at, notes
         FROM guest_passes
        WHERE id = ? AND member_id = ? AND tenant_id = :tenant AND deleted_at IS NULL`,
      [id, req.member.memberId]
    );
    if (!pass) throw notFound("Guest pass not found");
    ok(res, pass);
  })
);

// PATCH /guest-passes/:id/revoke
router.patch(
  "/:id/revoke",
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const result = await req.scope.execute(
      `UPDATE guest_passes SET status = 'revoked', revoked_at = NOW()
        WHERE id = ? AND member_id = ? AND tenant_id = :tenant AND status = 'issued'`,
      [id, req.member.memberId]
    );
    if (!result.affectedRows) throw notFound("Guest pass not found or already used");
    ok(res, { id, status: "revoked" });
  })
);

module.exports = router;
