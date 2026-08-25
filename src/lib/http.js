"use strict";

/**
 * Response and control-flow helpers.
 *
 * Every response body has the same shape: `{ data }` on success, `{ error }` on
 * failure. Clients never have to guess whether a field is at the top level.
 */

/** Wrap an async route so a rejected promise reaches the error handler. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ok = (res, data, meta) => res.json(meta ? { data, meta } : { data });
const created = (res, data) => res.status(201).json({ data });
const noContent = (res) => res.status(204).end();

/** Clamp pagination input to something a database can serve. */
function pagination(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { limit, offset: (page - 1) * limit, page };
}

module.exports = { asyncHandler, ok, created, noContent, pagination };
