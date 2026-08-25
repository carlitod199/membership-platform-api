"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLogger, redact } = require("../../src/lib/logger");

function capture(level = "debug") {
  const lines = [];
  const stream = { write: (line) => lines.push(line) };
  return { logger: createLogger({ level, stream, pretty: false }), lines };
}

test("password-like keys are masked at any depth", () => {
  const output = redact({
    email: "john.smith@example.com",
    password: "hunter2",
    nested: { new_password: "hunter2", password_hash: "$2a$12$abc", safe: "keep" },
    list: [{ token: "abc123" }, { api_key: "k" }],
  });

  assert.equal(output.email, "john.smith@example.com");
  assert.equal(output.password, "[REDACTED]");
  assert.equal(output.nested.new_password, "[REDACTED]");
  assert.equal(output.nested.password_hash, "[REDACTED]");
  assert.equal(output.nested.safe, "keep");
  assert.equal(output.list[0].token, "[REDACTED]");
  assert.equal(output.list[1].api_key, "[REDACTED]");
});

test("authorization headers and JWTs inside strings are masked", () => {
  const jwtLike = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop";
  const output = redact({
    note: `Authorization: Bearer ${jwtLike}`,
    raw: jwtLike,
  });
  assert.ok(!output.note.includes(jwtLike));
  assert.match(output.note, /Bearer \[REDACTED\]/);
  assert.equal(output.raw, "[REDACTED]");
});

test("a credential never reaches the output stream", () => {
  const { logger, lines } = capture();
  logger.info("member login", {
    email: "john.smith@example.com",
    password: "SuperSecret123",
    authorization: "Bearer abcdefghijklmnop",
  });

  const line = lines[0];
  assert.ok(!line.includes("SuperSecret123"));
  assert.ok(!line.includes("abcdefghijklmnop"));
  assert.ok(line.includes("john.smith@example.com"));
});

test("output is one JSON object per line", () => {
  const { logger, lines } = capture();
  logger.warn("something", { tenant_id: 3 });

  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith("\n"));
  const record = JSON.parse(lines[0]);
  assert.equal(record.level, "warn");
  assert.equal(record.msg, "something");
  assert.equal(record.tenant_id, 3);
  assert.ok(record.ts);
});

test("levels filter, and silent emits nothing", () => {
  const { logger, lines } = capture("warn");
  logger.debug("no");
  logger.info("no");
  logger.warn("yes");
  logger.error("yes");
  assert.equal(lines.length, 2);

  const quiet = capture("silent");
  quiet.logger.error("nothing at all");
  assert.equal(quiet.lines.length, 0);
});

test("child loggers stamp every record with their base fields", () => {
  const { logger, lines } = capture();
  const child = logger.child({ request_id: "req-1" });
  child.info("request");
  const record = JSON.parse(lines[0]);
  assert.equal(record.request_id, "req-1");
});

test("circular structures and deep nesting do not throw", () => {
  const circular = { name: "root" };
  circular.self = circular;
  assert.doesNotThrow(() => redact(circular));
  assert.equal(redact(circular).self, "[circular]");

  let deep = { value: "bottom" };
  for (let i = 0; i < 20; i += 1) deep = { child: deep };
  assert.doesNotThrow(() => redact(deep));
});

test("errors are reduced to name and message, not a whole stack", () => {
  const output = redact(new Error("Bearer abcdefghijklmnop leaked"));
  assert.equal(output.name, "Error");
  assert.ok(!output.message.includes("abcdefghijklmnop"));
  assert.equal(output.stack, undefined);
});
