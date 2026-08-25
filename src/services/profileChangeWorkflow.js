"use strict";

const { badRequest, notFound, forbidden } = require("../lib/errors");
const { isApprover } = require("../middleware/authorize");
const { ACTIONS, ENTITIES } = require("../repositories/auditRepository");
const env = require("../config/env");

/**
 * Profile change approval workflow.
 *
 * A member cannot edit their own record. `POST /profile/change-requests` writes
 * the *proposed* values into `profile_change_requests` with `status =
 * 'pending'`; the `members` row is untouched until staff approve. That is the
 * whole point: an association's member register is a legal record, and the
 * contact details on it are what dues notices and access rights hang off.
 *
 * Design notes:
 *
 *   - Only fields in `MEMBER_EDITABLE_FIELDS` are ever accepted, and the filter
 *     is applied twice: when the request is created, and again at approval
 *     time. The second filter matters — the allow-list may have shrunk between
 *     submission and approval, and an approver clicking "approve" should not be
 *     able to write a field the configuration no longer permits.
 *   - The request stores a snapshot of the current values alongside the
 *     proposed ones, so the approver sees a before/after and the record is
 *     self-describing in an audit six months later.
 *   - Applying the change, notifying the member and writing the audit record
 *     are one transaction. A member register that changed with no record of who
 *     changed it is exactly the thing an association cannot explain later.
 */

const STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
});

/** Keep only fields the configuration allows a member to change. */
function filterEditable(values, allowed = env.memberEditableFields) {
  const out = {};
  if (!values || typeof values !== "object") return out;
  for (const field of allowed) {
    const value = values[field];
    if (value === undefined || value === null || value === "") continue;
    out[field] = String(value).trim();
  }
  return out;
}

function assertCanReview(actor, policy) {
  if (!actor || !actor.role) throw forbidden("Unknown actor");
  if (!isApprover("profile_change", actor.role, policy)) {
    throw forbidden(
      `Your role (${actor.role}) is not configured to approve profile change requests`
    );
  }
}

/**
 * Create a pending change request.
 * @param {object} deps  { requests, members, allowedFields }
 * @param {object} input { memberId, values }
 */
async function requestProfileChange(deps, input) {
  const { requests, members, allowedFields } = deps;
  const requested = filterEditable(input.values, allowedFields || env.memberEditableFields);

  if (Object.keys(requested).length === 0) {
    throw badRequest("Submit at least one changeable field", {
      fields: `allowed: ${(allowedFields || env.memberEditableFields).join(", ")}`,
    });
  }

  const member = await members.findById(input.memberId);
  if (!member) throw notFound("Member not found");

  const open = await requests.findPendingForMember(input.memberId);
  if (open) {
    throw badRequest("You already have a change request awaiting review", { request_id: open.id });
  }

  const current = {};
  for (const field of Object.keys(requested)) {
    current[field] = member[field] === undefined ? null : member[field];
  }

  const id = await requests.create({
    memberId: input.memberId,
    currentValues: current,
    requestedValues: requested,
    status: STATUS.PENDING,
  });

  return { id, status: STATUS.PENDING, requested_values: requested };
}

/**
 * Approve a pending request and write the values into the member record.
 * @param {object} deps  { requests, members, notifications, audit, transaction, policy, allowedFields }
 * @param {object} input { requestId, actor, note }
 */
async function approveProfileChange(deps, input) {
  const { requests, members, notifications, audit, transaction, policy, allowedFields } = deps;
  const { requestId, actor, note } = input;

  assertCanReview(actor, policy);

  const request = await requests.findById(requestId);
  if (!request) throw notFound("Change request not found");
  if (request.status !== STATUS.PENDING) {
    throw badRequest(`Request is already ${request.status}`);
  }

  // Second filter — see the note at the top of the file.
  const values = filterEditable(request.requested_values, allowedFields || env.memberEditableFields);
  const fields = Object.keys(values);
  if (fields.length === 0) {
    throw badRequest("The request contains no fields that are currently changeable");
  }

  const run = transaction || ((fn) => fn({ requests, members, notifications, audit }));

  // The snapshot taken at submission, narrowed to the fields actually applied.
  const before = {};
  for (const field of fields) {
    before[field] = request.current_values ? request.current_values[field] ?? null : null;
  }

  await run(async (tx) => {
    await tx.members.applyChanges({
      memberId: request.member_id,
      values,
      actorId: actor.userId,
    });
    await tx.requests.approve({ id: request.id, reviewerId: actor.userId, note: note || null });
    await tx.notifications.create({
      memberId: request.member_id,
      category: "profile",
      title: "Profile change approved",
      body: `Your details have been updated: ${fields.join(", ")}.`,
      refEntity: "profile_change_request",
      refId: request.id,
    });
    if (tx.audit) {
      await tx.audit.record({
        actorType: "staff",
        actorId: actor.userId,
        action: ACTIONS.PROFILE_CHANGE_APPROVED,
        entity: ENTITIES.PROFILE_CHANGE_REQUEST,
        entityId: request.id,
        metadata: {
          before,
          after: values,
          applied_fields: fields,
          actor_role: actor.role,
          note: note || null,
          member_id: request.member_id,
        },
      });
    }
  });

  return { id: request.id, status: STATUS.APPROVED, applied_fields: fields };
}

/** Reject a pending request. The member record is not touched. */
async function rejectProfileChange(deps, input) {
  const { requests, notifications, audit, transaction, policy } = deps;
  const { requestId, actor, note } = input;

  assertCanReview(actor, policy);

  const request = await requests.findById(requestId);
  if (!request) throw notFound("Change request not found");
  if (request.status !== STATUS.PENDING) {
    throw badRequest(`Request is already ${request.status}`);
  }

  const reason = note || "Declined by the association staff.";
  const run = transaction || ((fn) => fn({ requests, notifications, audit }));

  await run(async (tx) => {
    await tx.requests.reject({ id: request.id, reviewerId: actor.userId, note: reason });
    await tx.notifications.create({
      memberId: request.member_id,
      category: "profile",
      title: "Profile change declined",
      body: reason,
      refEntity: "profile_change_request",
      refId: request.id,
    });
    if (tx.audit) {
      await tx.audit.record({
        actorType: "staff",
        actorId: actor.userId,
        action: ACTIONS.PROFILE_CHANGE_REJECTED,
        entity: ENTITIES.PROFILE_CHANGE_REQUEST,
        entityId: request.id,
        metadata: {
          before: { status: STATUS.PENDING },
          after: { status: STATUS.REJECTED },
          // Nothing was written to the member record; the proposal is kept so
          // the decision is reviewable.
          declined_values: request.requested_values || {},
          actor_role: actor.role,
          note: reason,
          member_id: request.member_id,
        },
      });
    }
  });

  return { id: request.id, status: STATUS.REJECTED };
}

module.exports = {
  STATUS,
  filterEditable,
  requestProfileChange,
  approveProfileChange,
  rejectProfileChange,
};
