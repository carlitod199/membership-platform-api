"use strict";

/**
 * ============================================================================
 * Tenant scope — the one place multi-tenancy is enforced.
 * ============================================================================
 *
 * THE PROBLEM
 * -----------
 * In a shared-schema multi-tenant database every tenant's rows live in the same
 * tables. A single forgotten `AND tenant_id = ?` is a cross-tenant data leak.
 * Code review does not reliably catch a missing WHERE clause, and it only has
 * to be missed once.
 *
 * THE APPROACH TAKEN HERE
 * -----------------------
 * Feature code never receives a database handle. It receives a *tenant scope*:
 * an object bound to exactly one tenant id, obtained from the authenticated
 * token by the auth middleware. The scope refuses to run SQL that does not
 * reference the tenant:
 *
 *   - Every statement must contain the `:tenant` marker at least once.
 *     `compileTenantSql` throws `TenantScopeError` otherwise. There is no flag
 *     to turn this off.
 *   - The value bound to `:tenant` comes from the scope, never from the
 *     caller's parameter array. A caller cannot pass a different tenant id even
 *     by accident, because it is not a parameter they control.
 *   - `insert()` sets `tenant_id` itself and rejects any attempt to supply one.
 *
 * So the failure mode inverts. Previously, forgetting the tenant predicate
 * silently returned other tenants' rows. Now it throws on the first call, in
 * development, with a message naming the file.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is not a SQL parser and does not attempt to prove the predicate is
 * *correct* — `WHERE 1 = 1 OR t.tenant_id = :tenant` would pass the marker
 * check. It removes the overwhelmingly common failure (omission) and leaves the
 * rare, deliberate one (a wrong predicate) to review. The trade-off is
 * discussed in docs/architecture.md.
 *
 * Queries that legitimately have no tenant context — resolving a login e-mail
 * before we know who the user is — must go through `src/data/global.js`, which
 * is deliberately awkward to use and restricted to an allow-list of purposes.
 */

const TENANT_MARKER = ":tenant";
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

class TenantScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "TenantScopeError";
  }
}

const isIdentifierChar = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/**
 * Rewrite `sql` into driver-ready SQL, replacing `:tenant` with `?` and
 * splicing `tenantId` into the parameter list at the matching position.
 *
 * The scan is lexical and skips string literals, backtick-quoted identifiers
 * and comments, so a `?` or the text ":tenant" inside a literal is left alone.
 *
 * @returns {{ sql: string, params: unknown[], tenantRefs: number }}
 */
function compileTenantSql(sql, params, tenantId) {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new TenantScopeError("SQL must be a non-empty string");
  }
  if (!Array.isArray(params)) {
    throw new TenantScopeError("Query parameters must be an array");
  }

  let out = "";
  const finalParams = [];
  let paramIndex = 0;
  let tenantRefs = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // ---- quoted literals and identifiers: copy verbatim -------------------
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "\\" && quote !== "`") {
          out += sql.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          // doubled quote is an escaped quote inside the literal
          if (sql[i + 1] === quote) {
            out += quote + quote;
            i += 2;
            continue;
          }
          out += quote;
          i += 1;
          break;
        }
        out += sql[i];
        i += 1;
      }
      continue;
    }

    // ---- comments: copy verbatim -----------------------------------------
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // ---- caller placeholder ----------------------------------------------
    if (ch === "?") {
      if (paramIndex >= params.length) {
        throw new TenantScopeError(
          `SQL has more '?' placeholders than parameters (${params.length} given)`
        );
      }
      out += "?";
      finalParams.push(params[paramIndex]);
      paramIndex += 1;
      i += 1;
      continue;
    }

    // ---- tenant marker ----------------------------------------------------
    if (sql.startsWith(TENANT_MARKER, i) && !isIdentifierChar(sql[i + TENANT_MARKER.length])) {
      out += "?";
      finalParams.push(tenantId);
      tenantRefs += 1;
      i += TENANT_MARKER.length;
      continue;
    }

    out += ch;
    i += 1;
  }

  if (paramIndex !== params.length) {
    throw new TenantScopeError(
      `SQL has ${paramIndex} '?' placeholders but ${params.length} parameters were given`
    );
  }
  if (tenantRefs === 0) {
    throw new TenantScopeError(
      "Refusing to run a query with no tenant predicate. Every statement must " +
        "reference ':tenant' (e.g. \"WHERE b.tenant_id = :tenant\"). If the " +
        "query genuinely has no tenant context, use src/data/global.js."
    );
  }

  return { sql: out, params: finalParams, tenantRefs };
}

function assertTenantId(tenantId) {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new TenantScopeError(
      `Invalid tenant id: ${JSON.stringify(tenantId)}. A tenant scope can only ` +
        "be built from a positive integer resolved on the server."
    );
  }
  return tenantId;
}

/**
 * @typedef {object} Executor
 * @property {(sql: string, params: unknown[]) => Promise<[any, any]>} execute
 * @property {() => Promise<{ execute: Function, begin: Function, commit: Function, rollback: Function, release: Function }>} [acquire]
 */

/**
 * Build a tenant scope.
 *
 * @param {number} tenantId  Resolved server-side from the verified JWT. Never
 *                           read from the request body, query or headers.
 * @param {Executor} executor
 */
function createTenantScope(tenantId, executor) {
  assertTenantId(tenantId);
  if (!executor || typeof executor.execute !== "function") {
    throw new TenantScopeError("A tenant scope needs an executor with an execute() method");
  }

  async function run(sql, params = []) {
    const compiled = compileTenantSql(sql, params, tenantId);
    const [result] = await executor.execute(compiled.sql, compiled.params);
    return result;
  }

  const scope = {
    tenantId,

    /** Rows for a SELECT. */
    async select(sql, params = []) {
      const rows = await run(sql, params);
      return Array.isArray(rows) ? rows : [];
    },

    /** First row of a SELECT, or null. */
    async selectOne(sql, params = []) {
      const rows = await scope.select(sql, params);
      return rows.length ? rows[0] : null;
    },

    /** Scalar of the first column of the first row, or null. */
    async selectValue(sql, params = []) {
      const row = await scope.selectOne(sql, params);
      if (!row) return null;
      const keys = Object.keys(row);
      return keys.length ? row[keys[0]] : null;
    },

    /** INSERT/UPDATE/DELETE written by hand. Still requires `:tenant`. */
    async execute(sql, params = []) {
      const result = await run(sql, params);
      return {
        affectedRows: result && result.affectedRows ? result.affectedRows : 0,
        insertId: result && result.insertId ? result.insertId : null,
      };
    },

    /**
     * INSERT with `tenant_id` supplied by the scope.
     * Rejects a caller-provided `tenant_id` loudly rather than overwriting it,
     * because a caller trying to set one is a bug worth surfacing.
     */
    async insert(table, values) {
      if (!IDENTIFIER.test(String(table))) {
        throw new TenantScopeError(`Unsafe table name: ${JSON.stringify(table)}`);
      }
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw new TenantScopeError("insert() needs a plain object of column values");
      }
      if (Object.prototype.hasOwnProperty.call(values, "tenant_id")) {
        throw new TenantScopeError(
          "tenant_id must not be passed to insert(); the scope sets it. " +
            "Receiving one usually means client input reached the data layer."
        );
      }

      const columns = Object.keys(values);
      for (const column of columns) {
        if (!IDENTIFIER.test(column)) {
          throw new TenantScopeError(`Unsafe column name: ${JSON.stringify(column)}`);
        }
      }

      const allColumns = ["tenant_id", ...columns];
      // `tenant_id` is bound through the marker like every other query the
      // scope runs, so the same compile step covers inserts too.
      const placeholders = [TENANT_MARKER, ...columns.map(() => "?")];
      const sql =
        `INSERT INTO \`${table}\` (${allColumns.map((c) => `\`${c}\``).join(", ")}) ` +
        `VALUES (${placeholders.join(", ")})`;
      const result = await run(sql, columns.map((c) => values[c]));
      return {
        insertId: result && result.insertId ? result.insertId : null,
        affectedRows: result && result.affectedRows ? result.affectedRows : 0,
      };
    },

    /**
     * Run `fn` inside a transaction. `fn` receives a tenant scope bound to the
     * same tenant and to the transaction's connection, so nothing inside the
     * transaction can escape the scope either.
     */
    async transaction(fn) {
      if (typeof executor.acquire !== "function") {
        throw new TenantScopeError("This executor does not support transactions");
      }
      const connection = await executor.acquire();
      const txScope = createTenantScope(tenantId, {
        execute: (sql, params) => connection.execute(sql, params),
      });
      try {
        await connection.begin();
        const result = await fn(txScope);
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
        throw error;
      } finally {
        connection.release();
      }
    },
  };

  return scope;
}

module.exports = {
  TENANT_MARKER,
  TenantScopeError,
  compileTenantSql,
  createTenantScope,
  assertTenantId,
};
