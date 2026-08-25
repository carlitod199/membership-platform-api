"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const env = require("../../src/config/env");
const { parseTrustProxy } = require("../../src/config/env");

/**
 * TRUST_PROXY has to match the deployment topology. One hop wrong in either
 * direction breaks the rate limiter, so the parsing is pinned here.
 */

test("TRUST_PROXY defaults to one hop", () => {
  assert.equal(parseTrustProxy(undefined), 1);
  assert.equal(parseTrustProxy(""), 1);
  assert.equal(env.trustProxy, 1, "the shipped default is one proxy in front");
});

test("TRUST_PROXY accepts a hop count", () => {
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("2"), 2);
  assert.equal(parseTrustProxy("0"), 0);
});

test("TRUST_PROXY accepts false for a directly exposed server", () => {
  assert.equal(parseTrustProxy("false"), false);
  assert.equal(parseTrustProxy("FALSE"), false);
});

test("TRUST_PROXY accepts a comma-separated list and Express's named presets", () => {
  assert.deepEqual(parseTrustProxy("127.0.0.1, 10.0.0.0/8"), ["127.0.0.1", "10.0.0.0/8"]);
  assert.equal(parseTrustProxy("loopback"), "loopback");
  assert.deepEqual(parseTrustProxy("loopback,uniquelocal"), ["loopback", "uniquelocal"]);
});

test("TRUST_PROXY=true is parsed but refused in production", (t) => {
  const originalProduction = env.isProduction;
  const originalTrust = env.trustProxy;
  t.after(() => {
    env.isProduction = originalProduction;
    env.trustProxy = originalTrust;
  });

  assert.equal(parseTrustProxy("true"), true);

  env.isProduction = true;
  env.trustProxy = true;
  process.env.JWT_SECRET = "x".repeat(40);
  process.env.DB_PASSWORD = "x";
  const problems = env.assertProductionSafety();
  assert.ok(problems.some((p) => /TRUST_PROXY/.test(p)), problems.join("; "));
  delete process.env.JWT_SECRET;
  delete process.env.DB_PASSWORD;
});

test("the rate limiter key masks an IPv6 client to its prefix", () => {
  const { ipKeyGenerator } = require("express-rate-limit");

  // IPv4 is used as-is.
  assert.equal(ipKeyGenerator("203.0.113.9"), "203.0.113.9");

  // Two addresses inside one IPv6 allocation must collapse to one bucket,
  // otherwise a client rotates within its own /64 for unlimited attempts.
  const a = ipKeyGenerator("2001:db8:abcd:0012::1");
  const b = ipKeyGenerator("2001:db8:abcd:0012::dead:beef");
  assert.equal(a, b);
  assert.notEqual(a, ipKeyGenerator("2001:db9:abcd:0012::1"));
});
