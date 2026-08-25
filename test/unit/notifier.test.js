"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createLoggingNotifier,
  getNotifier,
  setNotifier,
  resetNotifier,
  deliverPasswordReset,
} = require("../../src/services/notifier");
const { createLogger } = require("../../src/lib/logger");

function capture() {
  const lines = [];
  return { logger: createLogger({ level: "debug", stream: { write: (l) => lines.push(l) } }), lines };
}

const MESSAGE = {
  email: "john.smith@example.com",
  token: "a".repeat(64),
  expiresAt: new Date("2026-08-25T11:00:00Z"),
  principalType: "member",
  tenantId: 1,
  principalId: 5,
};

test.afterEach(() => resetNotifier());

test("the default notifier records the event but never the token", async () => {
  const { logger, lines } = capture();
  await createLoggingNotifier(logger).sendPasswordReset(MESSAGE);

  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(!line.includes(MESSAGE.token), "the reset token must not reach the log");
  assert.ok(line.includes("password reset issued"));

  const record = JSON.parse(line);
  assert.equal(record.tenant_id, 1);
  assert.equal(record.principal_type, "member");
  assert.equal(record.token, undefined);
});

test("a deployment can replace the notifier and receives the token", async () => {
  const received = [];
  setNotifier({
    async sendPasswordReset(message) {
      received.push(message);
    },
  });

  await deliverPasswordReset(MESSAGE);

  assert.equal(received.length, 1);
  assert.equal(received[0].token, MESSAGE.token);
  assert.equal(received[0].email, "john.smith@example.com");
  assert.equal(received[0].expiresAt, MESSAGE.expiresAt);
});

test("setNotifier rejects anything that does not implement the interface", () => {
  assert.throws(() => setNotifier(null), /sendPasswordReset/);
  assert.throws(() => setNotifier({}), /sendPasswordReset/);
  assert.throws(() => setNotifier({ sendPasswordReset: "not a function" }), /sendPasswordReset/);
});

test("resetNotifier restores the default", async () => {
  setNotifier({ async sendPasswordReset() {} });
  const replaced = getNotifier();
  resetNotifier();
  assert.notEqual(getNotifier(), replaced);
});

test("a transport failure is logged and swallowed, so it cannot become an enumeration oracle", async () => {
  const { logger, lines } = capture();
  setNotifier({
    async sendPasswordReset() {
      throw new Error("SMTP connection refused");
    },
  });

  const delivered = await deliverPasswordReset(MESSAGE, logger);

  assert.equal(delivered, false, "the caller learns delivery failed...");
  // ...but nothing threw, so the route still returns the generic envelope.
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.level, "error");
  assert.match(record.msg, /delivery failed/);
  assert.ok(!lines[0].includes(MESSAGE.token));
});

test("a successful delivery reports true", async () => {
  setNotifier({ async sendPasswordReset() {} });
  assert.equal(await deliverPasswordReset(MESSAGE), true);
});
