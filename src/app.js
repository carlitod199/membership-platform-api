"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const env = require("./config/env");
const routes = require("./routes");
const requestContext = require("./middleware/requestContext");
const tenantGuard = require("./middleware/tenantGuard");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");

/**
 * Application wiring.
 *
 * The middleware order is the security model, so it is worth reading top to
 * bottom:
 *
 *   1. helmet          — security headers before anything can respond
 *   2. cors            — origin policy
 *   3. requestContext  — request id + child logger, so everything after this
 *                        point logs with a correlation id
 *   4. body parser     — bounded at 256kb
 *   5. tenantGuard     — strip client-supplied tenant identifiers. Runs before
 *                        any route, so no handler can see one even if it looked
 *   6. rate limiters   — on the auth endpoints specifically
 *   7. routes          — authentication happens inside, per route tree
 *   8. notFound/error  — always last
 */

function createApp() {
  const app = express();

  // Behind a reverse proxy, req.ip must come from X-Forwarded-For or the rate
  // limiter buckets every client together. Configurable because it has to match
  // the real topology: the default of one hop is right for a single nginx or
  // load balancer in front, wrong for none and wrong for two. Trusting the
  // whole chain ("true") lets a client spoof its own address and is refused in
  // production by assertProductionSafety().
  app.set("trust proxy", env.trustProxy);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins.includes("*") ? true : env.corsOrigins,
      credentials: false,
      maxAge: 600,
    })
  );

  app.use(requestContext);
  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));
  app.use(tenantGuard);

  // Rate limiting is applied to authentication only. A blanket limiter on a
  // read-heavy API mostly punishes legitimate clients; the endpoints worth
  // protecting are the ones that accept a password or mint a token.
  const authLimiter = rateLimit({
    windowMs: env.rateLimit.windowMs,
    max: env.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    // Bucket by address *and* submitted e-mail, so one noisy office NAT does
    // not lock out every colleague behind it, while credential stuffing against
    // a single account still trips the limit.
    //
    // `ipKeyGenerator` rather than `req.ip`: an IPv6 client is normally handed a
    // whole /64, so keying on the exact address would let an attacker rotate
    // within their own allocation and get a fresh bucket per request. The helper
    // masks IPv6 to its /56 prefix and leaves IPv4 alone.
    keyGenerator: (req) => {
      const email = req.body && typeof req.body.email === "string" ? req.body.email.toLowerCase() : "";
      return `${ipKeyGenerator(req.ip)}|${email}`;
    },
    message: { error: { message: "Too many attempts, please try again later", code: "rate_limited" } },
  });

  app.use(`${env.apiPrefix}/auth/login`, authLimiter);
  app.use(`${env.apiPrefix}/auth/forgot-password`, authLimiter);
  app.use(`${env.apiPrefix}/auth/reset-password`, authLimiter);
  app.use(`${env.apiPrefix}/admin/auth/login`, authLimiter);
  app.use(`${env.apiPrefix}/admin/auth/forgot-password`, authLimiter);
  app.use(`${env.apiPrefix}/admin/auth/reset-password`, authLimiter);

  app.use(env.apiPrefix, routes);

  // Unversioned liveness path, for orchestrators that expect a fixed location.
  app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
module.exports.createApp = createApp;
