"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const tenantGuard = require("../../src/middleware/tenantGuard");

function makeRequest(overrides = {}) {
  const logged = [];
  return {
    method: "POST",
    originalUrl: "/api/v1/bookings",
    body: {},
    query: {},
    params: {},
    log: {
      warn: (message, context) => logged.push({ message, context }),
      info: () => {},
      error: () => {},
      debug: () => {},
    },
    logged,
    ...overrides,
  };
}

function run(req) {
  return new Promise((resolve, reject) => {
    tenantGuard(req, {}, (error) => (error ? reject(error) : resolve()));
  });
}

test("a client-supplied tenant_id in the body is removed", async () => {
  const req = makeRequest({ body: { facility_id: 3, tenant_id: 2, notes: "hi" } });
  await run(req);

  assert.equal("tenant_id" in req.body, false);
  assert.deepEqual(req.body, { facility_id: 3, notes: "hi" });
});

test("a client-supplied tenant_id in the query string is removed", async () => {
  const req = makeRequest({ query: { status: "pending", tenant_id: "2" } });
  await run(req);

  assert.equal("tenant_id" in req.query, false);
  assert.deepEqual(req.query, { status: "pending" });
});

test("camelCase, bare and slug variants are removed too", async () => {
  const req = makeRequest({
    body: { tenantId: 2, tenant: 2, tenant_slug: "riverside", keep: 1 },
  });
  await run(req);
  assert.deepEqual(req.body, { keep: 1 });
});

test("route parameters are cleaned as well", async () => {
  const req = makeRequest({ params: { id: "5", tenant_id: "2" } });
  await run(req);
  assert.deepEqual(req.params, { id: "5" });
});

test("dropping a tenant identifier is logged", async () => {
  const req = makeRequest({ body: { tenant_id: 2 }, query: { tenantId: 3 } });
  await run(req);

  assert.equal(req.logged.length, 1);
  assert.match(req.logged[0].message, /tenant identifier ignored/);
  assert.deepEqual(req.logged[0].context.fields, ["body.tenant_id", "query.tenantId"]);
});

test("a clean request is left alone and logs nothing", async () => {
  const req = makeRequest({ body: { facility_id: 3 }, query: { page: "2" } });
  await run(req);

  assert.deepEqual(req.body, { facility_id: 3 });
  assert.deepEqual(req.query, { page: "2" });
  assert.equal(req.logged.length, 0);
});

test("the guard survives a request with no body, query or params", async () => {
  const req = makeRequest({ body: undefined, query: undefined, params: undefined });
  await assert.doesNotReject(() => run(req));
});

test("a query exposed through a getter is still sanitized for later readers", async () => {
  // Reproduces the shape Express uses when req.query is a lazily parsed
  // accessor: reading it twice would otherwise hand back a fresh dirty object.
  const parsed = { status: "pending", tenant_id: "2" };
  const req = makeRequest();
  Object.defineProperty(req, "query", {
    configurable: true,
    enumerable: true,
    get: () => parsed,
  });

  await run(req);

  assert.equal("tenant_id" in req.query, false, "later reads must see the cleaned object");
});
