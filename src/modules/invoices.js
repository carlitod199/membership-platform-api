"use strict";

const express = require("express");

const { asyncHandler, ok, pagination } = require("../lib/http");
const { requireId } = require("../lib/validate");
const { notFound } = require("../lib/errors");
const { requireMember, requirePrimaryMember } = require("../middleware/authenticate");

const router = express.Router();
router.use(requireMember, requirePrimaryMember);

/**
 * Membership dues.
 *
 * Read-only. This service reports what is owed; it does not take payment.
 * Money movement belongs behind a payment provider integration with its own
 * idempotency, reconciliation and webhook handling, and pretending otherwise in
 * a portfolio repository would be dishonest. See NOTES.md, "Not implemented".
 *
 * Amounts are integer minor units (cents). Storing currency as DECIMAL and
 * reading it into a JS float is how rounding errors get into invoices.
 */

// GET /invoices
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { limit, offset, page } = pagination(req.query);
    const rows = await req.scope.select(
      `SELECT id, reference_period, due_date, amount_cents, discount_cents,
              penalty_cents, total_cents, status, paid_at, currency
         FROM invoices
        WHERE member_id = ? AND tenant_id = :tenant
        ORDER BY due_date DESC
        LIMIT ? OFFSET ?`,
      [req.member.memberId, limit, offset]
    );
    ok(res, rows, { page, limit });
  })
);

// GET /invoices/summary
router.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const summary = await req.scope.selectOne(
      `SELECT
          COALESCE(SUM(CASE WHEN status IN ('open', 'overdue') THEN total_cents ELSE 0 END), 0) AS outstanding_cents,
          SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) AS overdue_count,
          MIN(CASE WHEN status IN ('open', 'overdue') THEN due_date END) AS next_due_date
         FROM invoices
        WHERE member_id = ? AND tenant_id = :tenant`,
      [req.member.memberId]
    );
    const member = await req.scope.selectOne(
      `SELECT billing_status FROM members WHERE id = ? AND tenant_id = :tenant`,
      [req.member.memberId]
    );
    ok(res, {
      outstanding_cents: Number((summary && summary.outstanding_cents) || 0),
      overdue_count: Number((summary && summary.overdue_count) || 0),
      next_due_date: (summary && summary.next_due_date) || null,
      billing_status: member ? member.billing_status : null,
    });
  })
);

// GET /invoices/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = requireId(req.params.id);
    const invoice = await req.scope.selectOne(
      `SELECT id, reference_period, description, due_date, amount_cents, discount_cents,
              penalty_cents, total_cents, status, paid_at, paid_cents, currency, created_at
         FROM invoices
        WHERE id = ? AND member_id = ? AND tenant_id = :tenant`,
      [id, req.member.memberId]
    );
    if (!invoice) throw notFound("Invoice not found");

    const lines = await req.scope.select(
      `SELECT id, description, quantity, unit_price_cents, total_cents
         FROM invoice_lines
        WHERE invoice_id = ? AND tenant_id = :tenant
        ORDER BY id`,
      [invoice.id]
    );
    ok(res, { ...invoice, lines });
  })
);

module.exports = router;
