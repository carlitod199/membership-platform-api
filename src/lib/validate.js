"use strict";

const { badRequest } = require("./errors");

/**
 * Minimal request validation.
 *
 * Deliberately not a schema library. The rule set here covers what the API
 * actually accepts (strings, integers, enums, dates, times, e-mail, booleans)
 * in ~120 lines, with no dependency to keep current. If the surface grew past
 * this, zod or ajv would earn its place; at this size it would not.
 *
 * Two properties that matter more than the feature count:
 *   1. It is *allow-list* based. Only the fields named in the rules end up in
 *      the returned object, so an unexpected key in the body (`tenant_id`,
 *      `role`, `status`) cannot reach a query.
 *   2. It collects every field error before throwing, so a client gets one
 *      round trip instead of one per field.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

const isEmpty = (v) => v === undefined || v === null || v === "";

function coerce(field, value, rule, errors) {
  switch (rule.type) {
    case "int": {
      const n = Number(value);
      if (!Number.isInteger(n)) {
        errors[field] = "must be an integer";
        return undefined;
      }
      if (rule.min !== undefined && n < rule.min) {
        errors[field] = `must be at least ${rule.min}`;
        return undefined;
      }
      if (rule.max !== undefined && n > rule.max) {
        errors[field] = `must be at most ${rule.max}`;
        return undefined;
      }
      return n;
    }
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        errors[field] = "must be a number";
        return undefined;
      }
      return n;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      const s = String(value).toLowerCase();
      if (["1", "true", "yes"].includes(s)) return true;
      if (["0", "false", "no"].includes(s)) return false;
      errors[field] = "must be a boolean";
      return undefined;
    }
    case "email": {
      const s = String(value).trim().toLowerCase();
      if (!EMAIL.test(s) || s.length > 190) {
        errors[field] = "must be a valid e-mail address";
        return undefined;
      }
      return s;
    }
    case "date": {
      const s = String(value).trim();
      if (!DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
        errors[field] = "must be a date in YYYY-MM-DD format";
        return undefined;
      }
      return s;
    }
    case "time": {
      const s = String(value).trim();
      if (!TIME.test(s)) {
        errors[field] = "must be a time in HH:MM format";
        return undefined;
      }
      return s.length === 5 ? `${s}:00` : s;
    }
    case "string":
    default: {
      const s = String(value).trim();
      if (rule.minLength !== undefined && s.length < rule.minLength) {
        errors[field] = `must be at least ${rule.minLength} characters`;
        return undefined;
      }
      if (rule.maxLength !== undefined && s.length > rule.maxLength) {
        errors[field] = `must be at most ${rule.maxLength} characters`;
        return undefined;
      }
      return s;
    }
  }
}

/**
 * @param {object} source  req.body or req.query
 * @param {Record<string, {required?: boolean, type?: string, enum?: any[],
 *          minLength?: number, maxLength?: number, min?: number, max?: number,
 *          default?: any}>} rules
 * @returns {object} only the declared fields
 */
function validate(source, rules) {
  const out = {};
  const errors = {};
  const body = source && typeof source === "object" ? source : {};

  for (const [field, rule] of Object.entries(rules)) {
    const raw = body[field];
    if (isEmpty(raw)) {
      if (rule.required) errors[field] = "is required";
      else if (rule.default !== undefined) out[field] = rule.default;
      continue;
    }
    const value = coerce(field, raw, rule, errors);
    if (value === undefined) continue;
    if (rule.enum && !rule.enum.includes(value)) {
      errors[field] = `must be one of: ${rule.enum.join(", ")}`;
      continue;
    }
    out[field] = value;
  }

  if (Object.keys(errors).length) {
    throw badRequest("Validation failed", errors);
  }
  return out;
}

/** Positive integer from a path parameter, or a 400. */
function requireId(value, name = "id") {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw badRequest("Validation failed", { [name]: "must be a positive integer" });
  }
  return n;
}

module.exports = { validate, requireId, EMAIL, DATE, TIME };
