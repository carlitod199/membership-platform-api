"use strict";

/**
 * In-memory test doubles.
 *
 * These stand in for MySQL so the test suite proves the *rules* — tenant
 * scoping, token handling, workflow transitions — without needing a live
 * database. What they deliberately do NOT do is interpret SQL: `FakeExecutor`
 * records statements and replays canned results. Anything that depends on MySQL
 * actually executing the SQL (index behaviour, the CHECK constraints, JSON
 * column round-trips) is covered by the integration tests instead, which skip
 * unless a database is configured. See NOTES.md.
 */

/**
 * Records every (sql, params) pair the tenant scope compiles, and returns
 * queued results. Lets a test assert on the *compiled* SQL — which is where the
 * tenant predicate ends up — rather than on the SQL the caller wrote.
 */
class FakeExecutor {
  constructor(results = []) {
    this.calls = [];
    this.results = [...results];
    this.released = 0;
  }

  queue(result) {
    this.results.push(result);
    return this;
  }

  async execute(sql, params) {
    this.calls.push({ sql, params });
    const next = this.results.shift();
    return [next === undefined ? [] : next, []];
  }

  async acquire() {
    const self = this;
    return {
      execute: (sql, params) => self.execute(sql, params),
      begin: async () => {
        self.calls.push({ sql: "BEGIN", params: [] });
      },
      commit: async () => {
        self.calls.push({ sql: "COMMIT", params: [] });
      },
      rollback: async () => {
        self.calls.push({ sql: "ROLLBACK", params: [] });
      },
      release: () => {
        self.released += 1;
      },
    };
  }

  get lastCall() {
    return this.calls[this.calls.length - 1];
  }
}

/**
 * A tiny row store that DOES understand tenancy — enough to prove that two
 * scopes over the same data see different rows. Used by the cross-tenant tests.
 */
class TenantAwareStore {
  constructor(tables = {}) {
    this.tables = {};
    for (const [name, rows] of Object.entries(tables)) {
      this.tables[name] = rows.map((r) => ({ ...r }));
    }
  }

  /**
   * Understands exactly one query shape:
   *   SELECT ... FROM <table> WHERE <col> = ? AND tenant_id = ?  (any order)
   * The point is not to be a database. It is to make the tenant parameter
   * actually filter, so a missing predicate produces a visibly wrong answer.
   */
  async execute(sql, params) {
    const fromMatch = /FROM\s+`?([a-z_][a-z0-9_]*)`?/i.exec(sql);
    if (!fromMatch) return [[], []];
    const rows = this.tables[fromMatch[1]] || [];

    // Pull "col = ?" comparisons in order and pair them with params.
    const conditions = [];
    const re = /(?:\b\w+\.)?`?([a-z_][a-z0-9_]*)`?\s*=\s*\?/gi;
    let match;
    while ((match = re.exec(sql)) !== null) conditions.push(match[1]);

    const filtered = rows.filter((row) =>
      conditions.every((column, index) => {
        const expected = params[index];
        // eslint-disable-next-line eqeqeq -- loose compare mirrors MySQL's
        // string/number coercion on comparison.
        return row[column] == expected;
      })
    );
    return [filtered, []];
  }
}

/** Deterministic clock for expiry tests. */
function fixedClock(startIso) {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advanceMinutes(minutes) {
      current += minutes * 60 * 1000;
      return this;
    },
  };
}

module.exports = { FakeExecutor, TenantAwareStore, fixedClock };
