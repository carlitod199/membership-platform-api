"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { errorHandler, notFoundHandler } = require("../../src/middleware/errorHandler");
const { badRequest, forbidden, notFound } = require("../../src/lib/errors");
const { TenantScopeError } = require("../../src/data/tenantScope");
const env = require("../../src/config/env");

function makeResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };
const makeRequest = () => ({ id: "req-1", originalUrl: "/api/v1/bookings", method: "GET", log: silentLog });

function handle(error) {
  const res = makeResponse();
  errorHandler(error, makeRequest(), res, () => {});
  return res;
}

test("a known ApiError keeps its status, message and details", () => {
  const res = handle(badRequest("Validation failed", { email: "is required" }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.message, "Validation failed");
  assert.deepEqual(res.body.error.details, { email: "is required" });
  assert.equal(res.body.error.request_id, "req-1");
});

test("403 and 404 pass through unchanged", () => {
  assert.equal(handle(forbidden("nope")).statusCode, 403);
  assert.equal(handle(notFound()).statusCode, 404);
});

test("an unexpected error becomes a bare 500 and never carries a stack", () => {
  const error = new Error("connect ECONNREFUSED 10.0.0.5:3306 while reading users.password_hash");
  error.stack = "Error: secret internals\n  at somewhere";
  const res = handle(error);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.message, "Internal server error");
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes("at somewhere"), "no stack in the response");
  assert.equal(res.body.error.stack, undefined);
});

test("in production the details field is omitted entirely", (t) => {
  const originalProduction = env.isProduction;
  t.after(() => {
    env.isProduction = originalProduction;
  });

  env.isProduction = true;
  const res = handle(new Error("table `members` has no column `secret_column`"));

  assert.equal(res.body.error.details, undefined);
  assert.ok(!JSON.stringify(res.body).includes("secret_column"));
});

test("outside production the message is echoed to save a log round trip", (t) => {
  const originalProduction = env.isProduction;
  t.after(() => {
    env.isProduction = originalProduction;
  });

  env.isProduction = false;
  const res = handle(new Error("something specific"));
  assert.match(res.body.error.details, /something specific/);
});

test("a tenant scope violation is a 500 that tells the client nothing", () => {
  const res = handle(new TenantScopeError("Refusing to run a query with no tenant predicate"));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.message, "Internal server error");
  assert.ok(!JSON.stringify(res.body).includes("tenant predicate"));
});

test("driver errors are translated without echoing the driver text", () => {
  const duplicate = new Error("ER_DUP_ENTRY: Duplicate entry 'x' for key 'uq_users_email'");
  duplicate.code = "ER_DUP_ENTRY";
  const res = handle(duplicate);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.message, "That record already exists");
  assert.ok(!JSON.stringify(res.body).includes("uq_users_email"));
});

test("a database outage becomes a 503, not a 500", () => {
  const down = new Error("connect ECONNREFUSED");
  down.code = "ECONNREFUSED";
  assert.equal(handle(down).statusCode, 503);
});

test("malformed JSON is a 400", () => {
  const parseError = new Error("Unexpected token");
  parseError.type = "entity.parse.failed";
  const res = handle(parseError);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error.message, /valid JSON/);
});

test("an oversized body is a 413", () => {
  const tooLarge = new Error("request entity too large");
  tooLarge.type = "entity.too.large";
  assert.equal(handle(tooLarge).statusCode, 413);
});

test("the 404 handler answers with the standard envelope", () => {
  const res = makeResponse();
  notFoundHandler(makeRequest(), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, "not_found");
  assert.equal(res.body.error.request_id, "req-1");
});
