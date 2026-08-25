"use strict";

/**
 * Structured logger with credential redaction.
 *
 * One JSON object per line, so anything downstream (journald, Loki, CloudWatch)
 * can index it without a parser. No dependency — this is ~100 lines and the
 * alternative pulls in a transport stack the service does not need.
 *
 * REDACTION is the reason this file exists rather than console.log. Request
 * bodies and DB rows routinely carry passwords, tokens and hashes; logging them
 * turns the log store into a credential store. `redact()` walks the payload and
 * masks any key whose name looks sensitive, at any depth, plus bearer tokens
 * found inside string values.
 */

const LEVELS = { silent: 100, error: 50, warn: 40, info: 30, debug: 20, trace: 10 };

const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|cookie|hash|credential|api[-_]?key|refresh|jwt|otp|pin|cvv|ssn)/i;
const BEARER_IN_TEXT = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_IN_TEXT = /\beyJ[A-Za-z0-9._-]{16,}/g;

const MASK = "[REDACTED]";
const MAX_DEPTH = 6;

function redactString(value) {
  return value.replace(BEARER_IN_TEXT, (_m, scheme) => `${scheme} ${MASK}`).replace(JWT_IN_TEXT, MASK);
}

/**
 * Return a copy of `value` with sensitive fields masked.
 * Exported so it can be unit-tested directly.
 */
function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth-limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? MASK : redact(item, depth + 1, seen);
  }
  return out;
}

function createLogger(options = {}) {
  const state = {
    level: options.level || "info",
    pretty: Boolean(options.pretty),
    stream: options.stream || process.stdout,
    base: options.base || {},
  };

  function enabled(level) {
    return LEVELS[level] >= LEVELS[state.level] && state.level !== "silent";
  }

  function emit(level, message, context) {
    if (!enabled(level)) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: typeof message === "string" ? redactString(message) : message,
      ...state.base,
      ...(context ? redact(context) : {}),
    };
    const line = state.pretty
      ? `${record.ts} ${level.toUpperCase().padEnd(5)} ${record.msg} ${
          context ? JSON.stringify(redact(context)) : ""
        }`.trimEnd()
      : JSON.stringify(record);
    state.stream.write(`${line}\n`);
  }

  const logger = {
    redact,
    setLevel(level) {
      if (LEVELS[level] === undefined) throw new Error(`Unknown log level: ${level}`);
      state.level = level;
    },
    get level() {
      return state.level;
    },
    /** Derive a logger that stamps every record with extra fields (request id). */
    child(base) {
      return createLogger({ ...state, base: { ...state.base, ...base } });
    },
  };

  for (const level of ["error", "warn", "info", "debug", "trace"]) {
    logger[level] = (message, context) => emit(level, message, context);
  }
  return logger;
}

// Read config lazily-ish: env has no dependency on this module, so a plain
// require here would be fine, but keeping it inline avoids a require cycle when
// env itself needs to warn about something.
const env = require("../config/env");
const rootLogger = createLogger({ level: env.log.level, pretty: env.log.pretty });

module.exports = rootLogger;
module.exports.createLogger = createLogger;
module.exports.redact = redact;
module.exports.LEVELS = LEVELS;
