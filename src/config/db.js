"use strict";

const mysql = require("mysql2/promise");
const env = require("./env");
const logger = require("../lib/logger");

/**
 * MySQL connection pool.
 *
 * Created lazily on first use so that importing anything from this codebase —
 * in a unit test, in a CLI script that only needs the crypto helpers — does not
 * open sockets. `npm test` never reaches getPool().
 *
 * Nothing outside src/data/ should import this module. Feature code gets a
 * tenant scope, not a pool.
 */

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: env.db.host,
      port: env.db.port,
      user: env.db.user,
      password: env.db.password,
      database: env.db.database,
      waitForConnections: true,
      connectionLimit: env.db.connectionLimit,
      queueLimit: 0,
      charset: "utf8mb4",
      dateStrings: true,
      timezone: "Z",
      namedPlaceholders: false,
      supportBigNumbers: true,
      bigNumberStrings: false,
    });
    logger.info("database pool created", {
      host: env.db.host,
      database: env.db.database,
      connection_limit: env.db.connectionLimit,
    });
  }
  return pool;
}

/**
 * Executor adapter consumed by createTenantScope(). Keeping this shape narrow
 * (execute + acquire) is what lets the unit tests substitute an in-memory
 * double without a live MySQL.
 */
function poolExecutor(targetPool = null) {
  const resolve = () => targetPool || getPool();
  return {
    execute: (sql, params) => resolve().execute(sql, params),
    async acquire() {
      const connection = await resolve().getConnection();
      return {
        execute: (sql, params) => connection.execute(sql, params),
        begin: () => connection.beginTransaction(),
        commit: () => connection.commit(),
        rollback: () => connection.rollback(),
        release: () => connection.release(),
      };
    },
  };
}

async function closePool() {
  if (pool) {
    const closing = pool;
    pool = null;
    await closing.end();
    logger.info("database pool closed");
  }
}

module.exports = { getPool, poolExecutor, closePool };
