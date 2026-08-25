"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  unscopedQuery,
  unscopedQueryOne,
  assertPurpose,
  UNSCOPED_PURPOSES,
  UnscopedQueryError,
} = require("../../src/data/global");

/**
 * The escape hatch has to stay small and enumerable, otherwise the tenant scope
 * is theatre. These tests pin that.
 */

test("every unscoped query must declare a known purpose", () => {
  assert.doesNotThrow(() => assertPurpose(UNSCOPED_PURPOSES.RESOLVE_MEMBER_LOGIN));
  assert.throws(() => assertPurpose("whatever_i_feel_like"), UnscopedQueryError);
  assert.throws(() => assertPurpose(undefined), UnscopedQueryError);
});

test("the allow-list is short, and every entry is a login or reset concern", () => {
  // The escape hatch only stays meaningful while it stays small. If this bound
  // needs raising, that is a design conversation, not a test edit.
  const purposes = Object.values(UNSCOPED_PURPOSES);
  assert.ok(purposes.length <= 10, `unscoped purposes have grown to ${purposes.length}`);
  for (const purpose of purposes) {
    assert.match(purpose, /login|reset|password|health|cli|token|audit/, `unexpected purpose: ${purpose}`);
  }
});

test("the audit purpose exists only because the reset path has no tenant scope", () => {
  // Every other audit write in the codebase goes through the tenant scope. This
  // one cannot: the caller is not logged in. Pinning it here means adding a
  // second unscoped audit write is a deliberate act.
  assert.equal(UNSCOPED_PURPOSES.AUDIT_PASSWORD_RESET, "audit_password_reset");
  const auditPurposes = Object.values(UNSCOPED_PURPOSES).filter((p) => p.includes("audit"));
  assert.deepEqual(auditPurposes, ["audit_password_reset"]);
});

test("a declared purpose runs the query through the injected executor", async () => {
  const calls = [];
  const executor = {
    async execute(sql, params) {
      calls.push({ sql, params });
      return [[{ id: 1, tenant_id: 4 }], []];
    },
  };

  const row = await unscopedQueryOne(
    UNSCOPED_PURPOSES.RESOLVE_MEMBER_LOGIN,
    "SELECT id, tenant_id FROM member_credentials WHERE login_email = ?",
    ["john.smith@example.com"],
    executor
  );

  assert.deepEqual(row, { id: 1, tenant_id: 4 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ["john.smith@example.com"]);
});

test("an undeclared purpose is refused before the query runs", async () => {
  let ran = false;
  const executor = {
    async execute() {
      ran = true;
      return [[], []];
    },
  };

  await assert.rejects(
    () => unscopedQuery("read_all_tenants", "SELECT * FROM members", [], executor),
    UnscopedQueryError
  );
  assert.equal(ran, false, "the executor must not be reached");
});

test("unscopedQueryOne returns null rather than undefined on an empty result", async () => {
  const executor = { async execute() { return [[], []]; } };
  const row = await unscopedQueryOne(
    UNSCOPED_PURPOSES.RESOLVE_RESET_TOKEN,
    "SELECT 1",
    [],
    executor
  );
  assert.equal(row, null);
});
