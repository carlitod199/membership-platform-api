"use strict";

/**
 * Application errors. Anything thrown as an ApiError is a *known* condition
 * with a message safe to show a client. Everything else is a bug and becomes a
 * generic 500 in the error handler.
 */
class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message  Safe for client display. Never interpolate secrets.
   * @param {object} [details] Field-level detail, e.g. { email: "required" }.
   * @param {string} [code]    Stable machine-readable code.
   */
  constructor(status, message, details, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
    this.code = code || null;
    this.expected = true;
  }
}

const badRequest = (message, details) => new ApiError(400, message, details, "bad_request");
const unauthorized = (message = "Authentication required") =>
  new ApiError(401, message, undefined, "unauthorized");
const forbidden = (message = "You do not have permission to do that") =>
  new ApiError(403, message, undefined, "forbidden");
const notFound = (message = "Not found") => new ApiError(404, message, undefined, "not_found");
const conflict = (message, details) => new ApiError(409, message, details, "conflict");

module.exports = {
  ApiError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
};
