"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { validate, requireId } = require("../../src/lib/validate");
const { hashPassword, verifyPassword, assertPasswordPolicy, needsRehash } = require("../../src/lib/passwords");

test("validate() returns only declared fields", () => {
  const output = validate(
    { email: "A@Example.COM ", password: "x", role: "owner", tenant_id: 9 },
    { email: { required: true, type: "email" }, password: { required: true, type: "string" } }
  );
  assert.deepEqual(output, { email: "a@example.com", password: "x" });
});

test("validate() collects every field error at once", () => {
  try {
    validate({}, {
      email: { required: true, type: "email" },
      facility_id: { required: true, type: "int" },
    });
    assert.fail("expected a rejection");
  } catch (error) {
    assert.equal(error.status, 400);
    assert.deepEqual(error.details, { email: "is required", facility_id: "is required" });
  }
});

test("validate() coerces and range-checks integers", () => {
  assert.deepEqual(validate({ n: "42" }, { n: { type: "int" } }), { n: 42 });
  assert.throws(() => validate({ n: "4.5" }, { n: { type: "int" } }), /Validation failed/);
  assert.throws(() => validate({ n: 0 }, { n: { type: "int", min: 1 } }), /Validation failed/);
});

test("validate() checks dates, times and enums", () => {
  assert.deepEqual(validate({ d: "2026-09-20" }, { d: { type: "date" } }), { d: "2026-09-20" });
  assert.throws(() => validate({ d: "20/09/2026" }, { d: { type: "date" } }), /Validation failed/);
  assert.throws(() => validate({ d: "2026-13-45" }, { d: { type: "date" } }), /Validation failed/);

  assert.deepEqual(validate({ t: "18:00" }, { t: { type: "time" } }), { t: "18:00:00" });
  assert.throws(() => validate({ t: "25:00" }, { t: { type: "time" } }), /Validation failed/);

  assert.deepEqual(validate({ s: "pending" }, { s: { enum: ["pending", "confirmed"] } }), { s: "pending" });
  assert.throws(() => validate({ s: "confirmed!" }, { s: { enum: ["pending"] } }), /Validation failed/);
});

test("validate() applies defaults only when the field is absent", () => {
  assert.deepEqual(validate({}, { s: { default: "pending" } }), { s: "pending" });
  assert.deepEqual(validate({ s: "confirmed" }, { s: { default: "pending" } }), { s: "confirmed" });
});

test("requireId() accepts positive integers only", () => {
  assert.equal(requireId("5"), 5);
  for (const bad of ["0", "-1", "abc", "1.5", undefined]) {
    assert.throws(() => requireId(bad), /Validation failed/);
  }
});

test("passwords are hashed with bcrypt, never stored as given", async () => {
  const hash = await hashPassword("correct-horse-battery");
  assert.notEqual(hash, "correct-horse-battery");
  assert.match(hash, /^\$2[aby]\$\d{2}\$/);
  assert.equal(await verifyPassword("correct-horse-battery", hash), true);
  assert.equal(await verifyPassword("wrong-password-here", hash), false);
});

test("the same password hashes differently each time (per-hash salt)", async () => {
  const a = await hashPassword("correct-horse-battery");
  const b = await hashPassword("correct-horse-battery");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("correct-horse-battery", a), true);
  assert.equal(await verifyPassword("correct-horse-battery", b), true);
});

test("verifying against a missing hash returns false without throwing", async () => {
  assert.equal(await verifyPassword("anything", null), false);
  assert.equal(await verifyPassword("anything", undefined), false);
});

test("the password policy enforces a minimum length", () => {
  assert.equal(assertPasswordPolicy("correct-horse-battery"), "correct-horse-battery");
  assert.throws(() => assertPasswordPolicy("short"), /policy/);
  assert.throws(() => assertPasswordPolicy("x".repeat(300)), /policy/);
});

test("needsRehash spots a hash produced with a weaker cost", () => {
  assert.equal(needsRehash("$2a$04$abcdefghijklmnopqrstuv"), true);
  assert.equal(needsRehash("$2a$12$abcdefghijklmnopqrstuv"), false);
  assert.equal(needsRehash("not-a-hash"), true);
  assert.equal(needsRehash(null), true);
});
