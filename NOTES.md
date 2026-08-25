# NOTES.md

Working inventory of this repository. Terse and factual. Everything below was
verified by reading the code and running it, not inferred.

Stack: Node.js 18+ (developed and tested on v22.22.2), Express 4, MySQL 8 via
`mysql2/promise`, JWT via `jsonwebtoken`, bcrypt via `bcryptjs`. CommonJS
throughout, matching the codebase this architecture was re-implemented from. No
build step, no ORM, no framework beyond Express.

There is no README on purpose. Read `docs/architecture.md` for the reasoning
behind the design; this file is the inventory.

---

## 1. File map

| Path | Holds |
|---|---|
| `package.json` / `package-lock.json` | Scripts and the eight runtime dependencies, with a committed lockfile. |
| `.env.example` | Every variable the code reads, placeholders only. |
| `.gitignore` | node_modules, `.env`, logs, coverage, editor dirs. `package-lock.json` is deliberately tracked. |
| `LICENSE` | MIT, © 2026 Carlito Daniel. |
| `NOTES.md` | This file. |
| `docs/architecture.md` | Isolation model, auth model, approval workflows, trade-offs, mermaid pipeline diagram. |
| `database/schema.sql` | 20 tables + the permission catalogue insert. |
| `database/seed_demo.sql` | Two fictional tenants and everything under them. |
| `scripts/syntax-check.js` | `node --check` over every `.js` file. `npm run check`. |
| `scripts/create-staff-user.js` | CLI: create/update a staff user. |
| `scripts/create-member-credential.js` | CLI: create/update a member app login. |

### `src/`

| Path | Holds |
|---|---|
| `src/server.js` | Entry point. Config safety check, listener, graceful shutdown, `unhandledRejection`/`uncaughtException` handling. |
| `src/app.js` | Express wiring. Middleware order is the security model; documented in place. |
| `src/routes.js` | Route table. Member surface and `/admin` surface. |
| `src/config/env.js` | **The only file that reads `process.env`.** Typed config + `assertProductionSafety()`. |
| `src/config/db.js` | Lazy MySQL pool, `poolExecutor()` adapter, `closePool()`. |
| `src/data/tenantScope.js` | **The headline module.** `compileTenantSql`, `createTenantScope`, `TenantScopeError`. |
| `src/data/global.js` | The unscoped escape hatch, gated by a fixed purpose allow-list. |
| `src/lib/errors.js` | `ApiError` + `badRequest`/`unauthorized`/`forbidden`/`notFound`/`conflict`/`unprocessable`/`tooManyRequests`. |
| `src/lib/http.js` | `asyncHandler`, `ok`, `created`, `noContent`, `pagination`. |
| `src/lib/logger.js` | Structured JSON logger with credential redaction. No dependency. |
| `src/lib/passwords.js` | bcrypt hash/verify, timing-equalised miss, policy check, `needsRehash`. |
| `src/lib/tokens.js` | JWT sign/verify per scope, opaque token generation, SHA-256 hashing, bearer extraction. |
| `src/lib/validate.js` | Allow-list request validation. No dependency. |
| `src/middleware/tenantGuard.js` | Strips client-supplied tenant identifiers from body/query/params. |
| `src/middleware/authenticate.js` | `requireMember`, `requireStaff`, `requirePrimaryMember`, and the injectable `createAuthenticator`. |
| `src/middleware/authorize.js` | `authorize`, `isApprover`, `requireApprover`. |
| `src/middleware/errorHandler.js` | Centralized error handling + `notFoundHandler`. |
| `src/middleware/requestContext.js` | Request id, child logger, one log line per completed request. |
| `src/modules/health.js` | `/health` (liveness, no DB) and `/health/ready` (readiness, `SELECT 1`). |
| `src/modules/auth.js` | Member login, password reset, `/me`, sessions, logout. |
| `src/modules/profile.js` | Member profile reads and change-request creation. |
| `src/modules/facilities.js` | Facility list and slot availability computation. |
| `src/modules/bookings.js` | Member booking list, request, cancel. |
| `src/modules/invoices.js` | Read-only dues. |
| `src/modules/guestPasses.js` | Guest pass issue/list/revoke. |
| `src/modules/notifications.js` | In-app inbox. |
| `src/modules/admin/index.js` | Staff route tree; applies `requireStaff` per sub-router so login stays reachable. |
| `src/modules/admin/auth.js` | Staff login, password reset, `/me`, logout. |
| `src/modules/admin/bookings.js` | Booking review queue, approve, reject. |
| `src/modules/admin/profileChangeRequests.js` | Change-request queue, approve, reject. |
| `src/modules/admin/members.js` | Member register lookup. |
| `src/modules/admin/roles.js` | RBAC introspection. |
| `src/modules/admin/auditLogs.js` | Read-only audit trail + the action/entity vocabulary. |
| `src/repositories/index.js` | Builds the per-request repository set; `transaction()` rebinds them to the tx connection. |
| `src/repositories/bookingRepository.js` | Bookings. |
| `src/repositories/facilityRepository.js` | Facilities and closures. |
| `src/repositories/memberRepository.js` | Members, dependents, and the only dynamic `SET` clause in the codebase. |
| `src/repositories/notificationRepository.js` | Notifications. |
| `src/repositories/profileChangeRepository.js` | Change requests, with JSON column hydration. |
| `src/repositories/sessionRepository.js` | `auth_sessions`. |
| `src/repositories/auditRepository.js` | `audit_logs`. Append-only: `record`, `list`, `listForEntity` and nothing else. Refuses credential-shaped metadata keys. |
| `src/repositories/credentialRepository.js` | Login lookup. Unscoped by necessity. |
| `src/repositories/passwordResetRepository.js` | Reset tokens. Unscoped by necessity. |
| `src/services/bookingWorkflow.js` | Booking domain logic. No Express, no SQL. |
| `src/services/profileChangeWorkflow.js` | Profile change domain logic. No Express, no SQL. |
| `src/services/passwordResetService.js` | Reset domain logic. Injectable clock and store. |
| `src/services/notifier.js` | Outbound delivery seam. `sendPasswordReset`, a logging default, `setNotifier()`. |

### `test/`

| Path | Tests | Needs a database |
|---|---|---|
| `test/helpers/fakeDb.js` | — (`FakeExecutor`, `TenantAwareStore`, `fixedClock`) | no |
| `test/unit/tenantScope.test.js` | 15 | no |
| `test/unit/bookingWorkflow.test.js` | 34 | no |
| `test/unit/tokens.test.js` | 12 | no |
| `test/unit/app.test.js` | 14 | no |
| `test/unit/errorHandler.test.js` | 11 | no |
| `test/unit/passwordReset.test.js` | 16 | no |
| `test/unit/profileChangeWorkflow.test.js` | 16 | no |
| `test/unit/validate.test.js` | 11 | no |
| `test/unit/authorize.test.js` | 9 | no |
| `test/unit/auditRepository.test.js` | 9 | no |
| `test/unit/notifier.test.js` | 6 | no |
| `test/unit/config.test.js` | 6 | no |
| `test/unit/authenticate.test.js` | 8 | no |
| `test/unit/logger.test.js` | 8 | no |
| `test/unit/tenantGuard.test.js` | 8 | no |
| `test/unit/globalQueries.test.js` | 6 | no |
| `test/integration/database.test.js` | 8 | **yes — skipped unless `RUN_DB_TESTS=1`** |

68 `.js` files total, all parsing cleanly under `node --check`.

---

## 2. Endpoints

49 routes. `AUTH` is the token scope required; `PERM` is the permission key
checked by `authorize()`; `POLICY` is the approval workflow checked by
`requireApprover()` against the environment configuration.

Base prefix is `API_PREFIX`, default `/api/v1`.

### Health

| Method | Path | Auth | Perm | Does |
|---|---|---|---|---|
| GET | `/health` | none | — | Liveness, unversioned. Does not touch the database. |
| GET | `/api/v1/health` | none | — | Liveness + uptime. Does not touch the database. |
| GET | `/api/v1/health/ready` | none | — | Readiness. Runs `SELECT 1`; 503 when the database is down. |

### Member authentication

| Method | Path | Auth | Perm | Does |
|---|---|---|---|---|
| POST | `/auth/login` | none | — | Verifies e-mail + password against `member_credentials`, reads `tenant_id` from the row, creates an `auth_sessions` row, returns a member-scope JWT + profile. Rate limited. |
| POST | `/auth/forgot-password` | none | — | Issues a single-use, expiring, hashed reset token. Same response whether or not the address exists. Rate limited. |
| POST | `/auth/reset-password` | none | — | Consumes the token atomically, writes a new bcrypt hash, revokes all sessions for the principal. Rate limited. |
| GET | `/auth/me` | member | — | Current identity (member or dependent) + `tenant_id`. |
| GET | `/auth/sessions` | member | — | Active devices, current one flagged. |
| DELETE | `/auth/sessions/:id` | member | — | Revokes one session, only if it belongs to the caller. 204. |
| POST | `/auth/logout` | member | — | Revokes the token that made the call. |
| POST | `/auth/logout-all` | member | — | Revokes every session for the credential. |

### Member profile

| Method | Path | Auth | Perm | Does |
|---|---|---|---|---|
| GET | `/profile` | member (primary) | — | The member record. |
| GET | `/profile/dependents` | member (primary) | — | Dependents with computed age. |
| GET | `/profile/editable-fields` | member | — | The configured `MEMBER_EDITABLE_FIELDS` list. |
| POST | `/profile/change-requests` | member (primary) | — | Creates a **pending** change request. Writes nothing to `members`. One open request per member. |
| GET | `/profile/change-requests` | member (primary) | — | The member's own requests with status. |

### Facilities and bookings

| Method | Path | Auth | Perm | Does |
|---|---|---|---|---|
| GET | `/facilities` | member | — | Active facilities. |
| GET | `/facilities/:id/availability?date=YYYY-MM-DD` | member | — | Computed slots. Pending and confirmed bookings and closures mark a slot unavailable. |
| GET | `/bookings` | member (primary) | — | The member's bookings, paginated. |
| POST | `/bookings` | member (primary) | — | Creates a booking. `pending` when the facility has `requires_approval = 1`; **confirmed immediately** when it is 0 (still re-checking overlap in a transaction, notifying, and auditing as `booking.auto_confirmed`). Enforces `max_advance_days` — over it returns 400 `booking_too_far_ahead`. Response carries `auto_confirmed`, and the message follows the outcome. |
| PATCH | `/bookings/:id/cancel` | member (primary) | — | Cancels the caller's own pending or confirmed booking. |

### Billing (read-only)

| Method | Path | Auth | Perm | Does |
|---|---|---|---|---|
| GET | `/invoices` | member (primary) | — | The member's invoices, paginated. Amounts in cents. |
| GET | `/invoices/summary` | member (primary) | — | Outstanding total, overdue count, next due date, billing status. |
| GET | `/invoices/:id` | member (primary) | — | One invoice with its lines. |

### Guest passes

| Method | Path | Auth | Perm | Does |
|---|---|---|---|---|
| GET | `/guest-passes` | member (primary) | — | The member's passes, paginated. |
| POST | `/guest-passes` | member (primary) | — | Issues a pass with a 128-bit random code. |
| GET | `/guest-passes/:id` | member (primary) | — | One pass including its code. |
| PATCH | `/guest-passes/:id/revoke` | member (primary) | — | Revokes an unused pass. |

### Notifications

| Method | Path | Auth | Perm | Does |
|---|---|---|---|---|
| GET | `/notifications` | member or dependent | — | Inbox, paginated. Recipient column chosen from the token. |
| GET | `/notifications/unread-count` | member or dependent | — | Unread badge count. |
| PATCH | `/notifications/:id/read` | member or dependent | — | Marks one read. 404 if not the caller's or already read. |
| PATCH | `/notifications/read-all` | member or dependent | — | Marks all read, returns the count. |

### Staff authentication

| Method | Path | Auth | Perm | Does |
|---|---|---|---|---|
| POST | `/admin/auth/login` | none | — | Verifies against `users`, returns a staff-scope JWT carrying `role`. Rate limited. |
| POST | `/admin/auth/forgot-password` | none | — | As the member flow, `principal_type = 'staff'`. Rate limited. |
| POST | `/admin/auth/reset-password` | none | — | As the member flow. Rate limited. |
| GET | `/admin/auth/me` | staff | — | User, role, resolved permission list, and which workflows their role may approve. |
| POST | `/admin/auth/logout` | staff | — | Revokes the current session. |

### Staff — members

| Method | Path | Auth | Perm | Does |
|---|---|---|---|---|
| GET | `/admin/members` | staff | `members.view` | Member register, optional `search` and `status` filters, paginated. |
| GET | `/admin/members/:id` | staff | `members.view` | One member with dependents. |

### Staff — booking approval

| Method | Path | Auth | Perm | Policy | Does |
|---|---|---|---|---|---|
| GET | `/admin/bookings?status=pending` | staff | `bookings.view` | — | The review queue. |
| PATCH | `/admin/bookings/:id/approve` | staff | `bookings.approve` | `booking` | Re-checks overlap against confirmed bookings, then sets `confirmed` and notifies the member **in one transaction**. |
| PATCH | `/admin/bookings/:id/reject` | staff | `bookings.approve` | `booking` | Sets `rejected` and notifies with the reason, in one transaction. |

### Staff — profile change approval

| Method | Path | Auth | Perm | Policy | Does |
|---|---|---|---|---|---|
| GET | `/admin/profile-change-requests?status=pending` | staff | `members.view` | — | The review queue with before/after values. |
| PATCH | `/admin/profile-change-requests/:id/approve` | staff | `members.edit` | `profile_change` | Re-filters against the allow-list, writes the values into `members`, marks approved, notifies — one transaction. |
| PATCH | `/admin/profile-change-requests/:id/reject` | staff | `members.edit` | `profile_change` | Marks rejected and notifies. `members` untouched. |

### Staff — RBAC introspection

| Method | Path | Auth | Perm | Does |
|---|---|---|---|---|
| GET | `/admin/roles` | staff | `settings.view` | Roles with their permission grants + the active approval policy. |
| GET | `/admin/roles/permissions` | staff | `settings.view` | The permission catalogue. |

### Staff — audit trail

| Method | Path | Auth | Perm | Does |
|---|---|---|---|---|
| GET | `/admin/audit-logs?entity=booking` | staff | `settings.view` | The tenant's audit trail, newest first, paginated, optionally filtered by entity type. Read-only — no write verb is routed. |
| GET | `/admin/audit-logs/actions` | staff | `settings.view` | The fixed action and entity vocabularies, for building a filter UI. |

### Response shapes

Success: `{ "data": ... }`, optionally `{ "data": ..., "meta": { page, limit } }`.
Failure: `{ "error": { message, code?, details?, request_id } }`.
Every response carries an `X-Request-Id` header, echoed from the request if
supplied.

---

## 3. Database

20 tables. All InnoDB, `utf8mb4_unicode_ci`. 18 carry `tenant_id`; the two that
do not are noted.

### `tenants` — no `tenant_id` (it *is* the tenant registry)
`id`, `slug` (unique), `name`, `status` (active/suspended/closed), `timezone`,
`locale`, `currency`, `contact_email`, `created_at`, `updated_at`.

### `permissions` — no `tenant_id` (global application contract)
`id`, `permission_key` (unique), `category`, `description`.
Seeded with 10 keys: `members.view`, `members.edit`, `bookings.view`,
`bookings.approve`, `invoices.view`, `invoices.manage`, `facilities.manage`,
`guests.view`, `settings.view`, `settings.manage`.

### `roles`
`id`, `tenant_id`, `role_key`, `name`, `description`, `is_system`, `created_at`.
Unique `(tenant_id, role_key)`.

### `role_permissions`
`tenant_id`, `role_id`, `permission_id`, `granted_at`. PK `(role_id, permission_id)`.
`tenant_id` is denormalised here so the permission lookup can be tenant-scoped
without joining back to `roles`.

### `users` (staff)
`id`, `tenant_id`, `role_id`, `full_name`, `email` (**globally** unique),
`password_hash`, `status`, `failed_attempts`, `last_login_at`, `created_at`,
`updated_at`, `deleted_at`.

### `membership_categories`
`id`, `tenant_id`, `name`, `monthly_fee_cents`, `description`, `is_active`.

### `members`
`id`, `tenant_id`, `category_id`, `membership_number` (unique per tenant),
`full_name`, `email`, `phone`, `mobile`, `address_line1`, `address_line2`,
`city`, `state`, `postal_code`, `country`, `date_of_birth`, `joined_on`,
`status`, `billing_status`, `photo_path`, `notes`, `updated_by`, `created_at`,
`updated_at`, `deleted_at`.

### `dependents`
`id`, `tenant_id`, `member_id`, `full_name`, `relationship`, `date_of_birth`,
`email`, `phone`, `status`, `created_at`, `updated_at`, `deleted_at`.

### `member_credentials`
`id`, `tenant_id`, `member_id`, `dependent_id`, `login_email` (**globally**
unique), `password_hash`, `status`, `failed_attempts`, `last_login_at`,
`created_at`, `updated_at`, `deleted_at`.
CHECK constraint: exactly one of `member_id` / `dependent_id` is non-null.

### `auth_sessions`
`id`, `tenant_id`, `token_id` (the JWT `jti`, unique), `principal_type`,
`principal_id`, `user_agent`, `ip_address`, `created_at`, `last_seen_at`,
`expires_at`, `revoked_at`.

### `password_reset_tokens`
`id`, `tenant_id`, `principal_type`, `principal_id`, `token_hash`
(sha256 hex, **globally** unique), `expires_at`, `used_at`, `created_at`.

### `invoices`
`id`, `tenant_id`, `member_id`, `reference_period` (`YYYY-MM`), `description`,
`due_date`, `amount_cents`, `discount_cents`, `penalty_cents`, `total_cents`,
`paid_cents`, `currency`, `status`, `paid_at`, `created_at`, `updated_at`.
Unique `(tenant_id, member_id, reference_period)`.

### `invoice_lines`
`id`, `tenant_id`, `invoice_id`, `description`, `quantity`, `unit_price_cents`,
`total_cents`.

### `facilities`
`id`, `tenant_id`, `name` (unique per tenant), `kind`, `description`,
`capacity`, `opens_at`, `closes_at`, `slot_minutes`, `requires_approval`,
`max_advance_days`, `image_path`, `is_active`, `created_at`, `updated_at`,
`deleted_at`.
`requires_approval = 0` makes a booking confirm at creation; `max_advance_days`
caps how far ahead a member may book. Both are enforced in
`src/services/bookingWorkflow.js`.

### `facility_closures`
`id`, `tenant_id`, `facility_id`, `starts_at`, `ends_at`, `reason`,
`created_by`, `created_at`.

### `bookings`
`id`, `tenant_id`, `facility_id`, `member_id`, `dependent_id`, `booking_date`,
`starts_at`, `ends_at`, `notes`, `status`
(pending/confirmed/rejected/cancelled/completed), `reviewed_by`, `reviewed_at`,
`review_note`, `cancelled_at`, `created_at`, `updated_at`.
CHECK constraint: `ends_at > starts_at`.

### `profile_change_requests`
`id`, `tenant_id`, `member_id`, `current_values` (JSON), `requested_values`
(JSON), `status` (pending/approved/rejected), `reviewed_by`, `reviewed_at`,
`review_note`, `created_at`, `updated_at`.

### `guest_passes`
`id`, `tenant_id`, `member_id`, `guest_name`, `guest_document`, `guest_phone`,
`visit_date`, `valid_from`, `valid_until`, `notes`, `pass_code` (32 hex chars,
unique), `status`, `used_at`, `revoked_at`, `created_at`, `deleted_at`.

### `notifications`
`id`, `tenant_id`, `member_id`, `dependent_id`, `category`, `title`, `body`,
`ref_entity`, `ref_id`, `read_at`, `created_at`.

### `audit_logs`
`id`, `tenant_id`, `actor_type`, `actor_id`, `action`, `entity`, `entity_id`,
`metadata` (JSON), `ip_address`, `user_agent`, `created_at`.

Written by the approval workflows inside the same transaction as the state
change. Actions currently emitted: `booking.approved`, `booking.rejected`,
`booking.auto_confirmed`, `profile_change.approved`, `profile_change.rejected`,
`password_reset.completed`, `session.revoked`, `session.revoked_all`. Entities:
`booking`, `profile_change_request`, `credential`, `session`. Append-only —
the repository exposes no update or delete and `GET /admin/audit-logs` is
read-only. `record()` refuses metadata keys matching
`password|token|secret|hash|credential`.

### Seed data

Two tenants: **Northgate Association** (id 1, slug `northgate`) and
**Riverside Association** (id 2, slug `riverside`).

Deliberately built so a leak is visible: both tenants have a `John Smith` and a
`Jane Doe`, a facility called `Main Hall`, an invoice for `2026-08`, and a
pending booking on `2026-09-20 18:00`. Every row carries a tag — Northgate rows
say "Northgate", Riverside rows say "Riverside", membership numbers use `NG-`
and `RV-` prefixes. A Northgate token that ever returns a row containing
"Riverside" is a broken isolation, visible at a glance.

Demo passwords (bcrypt cost 12, placeholders for a demo database only):

| Account | E-mail | Password | Tenant |
|---|---|---|---|
| Owner | `alice.owner@northgate.example.com` | `DemoStaff2026!` | Northgate |
| Front desk | `bob.frontdesk@northgate.example.com` | `DemoStaff2026!` | Northgate |
| Accountant (no approval rights) | `carol.accounts@northgate.example.com` | `DemoStaff2026!` | Northgate |
| Owner | `dave.owner@riverside.example.com` | `DemoStaff2026!` | Riverside |
| Member | `john.smith@example.com` | `DemoMember2026!` | Northgate |
| Member | `jane.doe@example.com` | `DemoMember2026!` | Northgate |
| Dependent | `erin.smith@example.com` | `DemoMember2026!` | Northgate |
| Member | `john.smith.riverside@example.com` | `DemoMember2026!` | Riverside |
| Member | `jane.doe.riverside@example.com` | `DemoMember2026!` | Riverside |

Carol the accountant exists specifically to demonstrate a 403: her role holds
`bookings.view` but not `bookings.approve`, and `accountant` is not in
`BOOKING_APPROVER_ROLES`.

Northgate's facility 3 ("Studio") is seeded with `requires_approval = 0` and
`max_advance_days = 7`, so both facility-level rules can be exercised against
the demo data. The seed also inserts two `audit_logs` rows matching the two
already-approved bookings, so the trail is not empty on a fresh install.

---

## 4. Environment variables

Every variable the code reads, all declared in `src/config/env.js`. Nothing else
in `src/` or `scripts/` touches `process.env` — verify with:

```
grep -rn "process\.env" --include="*.js" src/ scripts/ | grep -v src/config/env.js
```
(returns nothing)

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Runtime mode. `production` enables the config safety check and suppresses error detail. |
| `PORT` | `4000` | Listen port. |
| `API_PREFIX` | `/api/v1` | Route prefix. |
| `CORS_ORIGINS` | `*` | Comma-separated. `*` is refused in production. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period before a forced exit during shutdown. |
| `TRUST_PROXY` | `1` | Express `trust proxy`. A hop count, `false`, `true`, or a comma-separated list of addresses/CIDRs/presets. Must match the real topology — see `.env.example`. `true` is refused in production. |
| `DB_HOST` | `127.0.0.1` | |
| `DB_PORT` | `3306` | |
| `DB_USER` | `root` | |
| `DB_PASSWORD` | *(empty)* | Required in production. |
| `DB_NAME` | `membership_platform` | |
| `DB_CONNECTION_LIMIT` | `10` | Pool size. |
| `JWT_SECRET` | dev placeholder | Required in production, min 32 chars. |
| `JWT_ISSUER` | `membership-platform-api` | Checked on verification. |
| `JWT_MEMBER_EXPIRES` | `7d` | |
| `JWT_STAFF_EXPIRES` | `12h` | |
| `ENFORCE_SESSION_REVOCATION` | `true` | Check `auth_sessions` on every authenticated request. |
| `BCRYPT_ROUNDS` | `12` | Cost factor. Min 10 enforced in production. |
| `PASSWORD_MIN_LENGTH` | `10` | |
| `MAX_FAILED_LOGIN_ATTEMPTS` | `10` | Lockout threshold; a password reset clears it. |
| `RESET_TOKEN_BYTES` | `32` | Reset token entropy. |
| `RESET_TOKEN_TTL_MINUTES` | `60` | Reset token lifetime. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `900000` | |
| `AUTH_RATE_LIMIT_MAX` | `20` | Per (ip, e-mail) bucket. |
| `BOOKING_APPROVER_ROLES` | `owner,administrator,front_desk` | Roles that may approve bookings. |
| `PROFILE_CHANGE_APPROVER_ROLES` | `owner,administrator,membership_officer` | Roles that may approve profile changes. |
| `MEMBER_EDITABLE_FIELDS` | `email,phone,mobile,address_line1,address_line2,city,state,postal_code` | The only member columns a change request may touch. |
| `LOG_LEVEL` | `info` (`silent` under the test runner) | |
| `LOG_PRETTY` | `true` in development | Single-line output instead of JSON. |
| `RUN_DB_TESTS` | unset | `1` enables the integration tests. |

`NODE_TEST_CONTEXT` is also read, but it is set by the `node:test` runner
itself, not by an operator, so it is not in `.env.example`. It only silences
logging during `npm test`.

---

## 5. Running it

```bash
npm install
cp .env.example .env          # then edit DB_* and JWT_SECRET

# database
mysql -u root -p -e "CREATE DATABASE membership_platform CHARACTER SET utf8mb4"
mysql -u root -p membership_platform < database/schema.sql
mysql -u root -p membership_platform < database/seed_demo.sql

npm start                     # or: npm run dev  (node --watch)
# API on http://localhost:4000/api/v1
```

Provisioning:

```bash
node scripts/create-staff-user.js northgate owner admin@example.com 'a-long-password' 'Admin Name'
node scripts/create-member-credential.js northgate NG-0001 member@example.com 'a-long-password'
```

Smoke test of the isolation claim:

```bash
NG=$(curl -s localhost:4000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"john.smith@example.com","password":"DemoMember2026!"}' | jq -r .data.token)

curl -s localhost:4000/api/v1/profile -H "authorization: Bearer $NG" | jq .data.membership_number
# "NG-0001"

# Riverside's invoice id 4, asked for with a Northgate token:
curl -s -o /dev/null -w '%{http_code}\n' localhost:4000/api/v1/invoices/4 -H "authorization: Bearer $NG"
# 404

# A tenant_id in the body changes nothing:
curl -s localhost:4000/api/v1/bookings -H "authorization: Bearer $NG" \
  -H 'content-type: application/json' \
  -d '{"tenant_id":2,"facility_id":4,"booking_date":"2026-12-01","starts_at":"10:00","ends_at":"11:00"}'
# 404 Facility not found — facility 4 belongs to Riverside
```

The facility rules and the audit trail, same session. Outputs below were
observed against the seeded database, not written from the code:

```bash
# facility 3 (Studio) allows 7 days' notice; ask for 90:
curl -s localhost:4000/api/v1/bookings -H "authorization: Bearer $NG" \
  -H 'content-type: application/json' \
  -d '{"facility_id":3,"booking_date":"2026-11-23","starts_at":"09:00","ends_at":"10:00"}'
# {"error":{"message":"This facility can only be booked up to 7 days ahead",
#           "code":"booking_too_far_ahead",
#           "details":{"booking_date":"is 90 days ahead; the limit is 7"}, ...}}

# facility 3 has requires_approval = 0 — confirmed on the spot:
#   {"data":{"id":9,"status":"confirmed","auto_confirmed":true,
#            "message":"Booking confirmed. This facility does not require staff approval."}}

# facility 1 requires approval — pending:
#   {"data":{"id":10,"status":"pending","auto_confirmed":false, ...}}

# Carol the accountant holds bookings.view but not bookings.approve:
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH \
  localhost:4000/api/v1/admin/bookings/10/approve -H "authorization: Bearer $CAROL"
# 403

# Alice the owner approves, and the trail records it:
curl -s "localhost:4000/api/v1/admin/audit-logs?entity=booking&limit=1" \
  -H "authorization: Bearer $ALICE"
# {"data":[{"id":8,"actor_type":"staff","actor_id":1,"actor_name":"Alice Owner",
#           "action":"booking.approved","entity":"booking","entity_id":10,
#           "metadata":{"before":{"status":"pending"},"after":{"status":"confirmed"},
#                       "actor_role":"owner","note":"e2e","member_id":1,
#                       "facility_id":1,"booking_date":"2026-08-30"}, ...}]}
```

Scripts:

| Command | Does |
|---|---|
| `npm start` | Runs the server. |
| `npm run dev` | `node --watch`. |
| `npm test` | Unit tests + integration tests (the latter skip without a database). |
| `npm run check` | `node --check` over every `.js` file. |
| `npm run create-staff-user` | CLI provisioning. |
| `npm run create-member-credential` | CLI provisioning. |

---

## 6. Test results

Observed output, Node v22.22.2. Both runs below are real: the first with no
database (the default), the second against a live MariaDB 10.11 loaded from
`database/schema.sql` + `database/seed_demo.sql`.

```
$ npm run check
68/68 JavaScript files parsed cleanly

$ npm test
> node --test test/unit/*.test.js test/integration/*.test.js

1..197
# tests 197
# suites 0
# pass 189
# fail 0
# cancelled 0
# skipped 8
# todo 0
# duration_ms 9525.265295
```

With a database, the 8 integration tests run instead of skipping:

```
$ RUN_DB_TESTS=1 DB_HOST=127.0.0.1 DB_USER=membership_app \
    DB_PASSWORD=... DB_NAME=membership_platform_test npm test

1..197
# tests 197
# suites 0
# pass 197
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10108.936716
```

Per file:

| File | tests | pass | fail | skipped |
|---|---|---|---|---|
| `test/unit/app.test.js` | 14 | 14 | 0 | 0 |
| `test/unit/auditRepository.test.js` | 9 | 9 | 0 | 0 |
| `test/unit/authenticate.test.js` | 8 | 8 | 0 | 0 |
| `test/unit/authorize.test.js` | 9 | 9 | 0 | 0 |
| `test/unit/bookingWorkflow.test.js` | 34 | 34 | 0 | 0 |
| `test/unit/config.test.js` | 6 | 6 | 0 | 0 |
| `test/unit/errorHandler.test.js` | 11 | 11 | 0 | 0 |
| `test/unit/globalQueries.test.js` | 6 | 6 | 0 | 0 |
| `test/unit/logger.test.js` | 8 | 8 | 0 | 0 |
| `test/unit/notifier.test.js` | 6 | 6 | 0 | 0 |
| `test/unit/passwordReset.test.js` | 16 | 16 | 0 | 0 |
| `test/unit/profileChangeWorkflow.test.js` | 16 | 16 | 0 | 0 |
| `test/unit/tenantGuard.test.js` | 8 | 8 | 0 | 0 |
| `test/unit/tenantScope.test.js` | 15 | 15 | 0 | 0 |
| `test/unit/tokens.test.js` | 12 | 12 | 0 | 0 |
| `test/unit/validate.test.js` | 11 | 11 | 0 | 0 |
| `test/integration/database.test.js` | 8 | 8 | 0 | 0 *(skipped without `RUN_DB_TESTS=1`)* |

The 8 integration tests in `test/integration/database.test.js` are skipped by
default so a clean clone passes with no database. To run them:

```bash
mysql -u root -p -e "CREATE DATABASE membership_platform_test CHARACTER SET utf8mb4"
mysql -u root -p membership_platform_test < database/schema.sql
mysql -u root -p membership_platform_test < database/seed_demo.sql
RUN_DB_TESTS=1 DB_NAME=membership_platform_test npm test
```

They cover what only a real database can answer: that the schema matches the SQL
the repositories emit, that cross-tenant reads return nothing against real rows,
that the seeded bcrypt hashes verify, that an approval writes its audit row in
the same transaction, that the `requires_approval = 0` facility auto-confirms,
that `max_advance_days` is enforced against seeded data, and that the audit trail
is tenant-isolated.

**They have been run, and they pass.** Against MariaDB 10.11:
`database/schema.sql` creates all 20 tables from a clean database,
`database/seed_demo.sql` loads on top of it, and all 8 tests pass. The
`LIMIT ? OFFSET ?` prepared-statement form, the JSON columns in `audit_logs` and
`profile_change_requests`, and every join key in the repositories are therefore
executed rather than merely read. Verified on MariaDB only — not on MySQL 8,
which the schema also targets.

### What the passing tests actually prove

- A token from tenant A cannot read tenant B's data — `tenantScope.test.js`,
  "a scope for tenant A cannot read tenant B's rows" and "listing through a
  scope returns only that tenant's rows", against a store that genuinely filters
  on the tenant parameter.
- A client-supplied `tenant_id` in body or query is ignored — `tenantGuard.test.js`
  (8 tests, including the Express getter case) and `authenticate.test.js`
  ("a tenant_id in the body or query does not influence the scope").
- A query with no tenant predicate cannot be executed at all — `tenantScope.test.js`.
- A pending booking is not confirmed without an approval, and a non-approver
  role cannot confirm it — `bookingWorkflow.test.js` (33 tests).
- `requires_approval = 0` auto-confirms, and that path still refuses an overlap
  with a confirmed booking — including one that only appears once the
  transaction has opened — `bookingWorkflow.test.js`.
- `max_advance_days` is enforced at the boundary: exactly the limit is accepted,
  one day past returns 400 `booking_too_far_ahead` — `bookingWorkflow.test.js`.
- Every approval, rejection and auto-confirmation writes an audit row with
  actor, action and before/after, *inside* the transaction (asserted by ordering
  begin → audit → commit), and a refused approval writes none —
  `bookingWorkflow.test.js`, `profileChangeWorkflow.test.js`.
- The audit trail cannot be made to hold a credential, and exposes no update or
  delete — `auditRepository.test.js`.
- The notifier default never logs the reset token, a transport failure is
  swallowed so it cannot become an enumeration oracle, and a deployment can
  replace it — `notifier.test.js`.
- `TRUST_PROXY` parses to the right Express value in each accepted form, `true`
  is refused in production, and the rate-limit key collapses two addresses in one
  IPv6 /64 to a single bucket — `config.test.js`.
- Password reset tokens are single-use (including under concurrent use) and
  expire — `passwordReset.test.js` (11 tests).
- Passwords are bcrypt-hashed with a per-hash salt and never stored as given —
  `validate.test.js`.
- Stack traces never reach a client, and never in production even in `details` —
  `errorHandler.test.js`.
- Credentials never reach the log stream — `logger.test.js`.

### Bugs the tests caught during development

1. `signMemberToken`/`signStaffToken` passed `jti` both in the payload and as
   the `jwtid` option; `jsonwebtoken` rejects the duplicate. Every token issue
   would have thrown at runtime. Caught by `tokens.test.js`, fixed in
   `src/lib/tokens.js`.
2. `POST /bookings` returned a hardcoded "pending review by the association
   staff" message. Once `requires_approval = 0` began auto-confirming, that
   message contradicted the `status: "confirmed"` in the same body. Caught by an
   end-to-end HTTP run against the live database; fixed in
   `src/modules/bookings.js`, pinned by a test on the `auto_confirmed` flag.
3. An integration test booked facility 3 on a fixed far-future date. Enforcing
   `max_advance_days` (7 days on that facility) and `requires_approval = 0`
   turned an assumption the test had been silently relying on into a failure.
   Exactly the point of enforcing the columns; the test now uses a facility that
   requires approval and a relative date.

---

## 7. Not implemented

Stated plainly. None of the following is stubbed to look present.

- **E-mail / SMS transport.** There is a defined seam —
  `src/services/notifier.js`, wired at both forgot-password call sites — but no
  transport behind it. The shipped default records that a reset was issued and
  deliberately does not log the token, so **the password reset flow cannot be
  completed as shipped**. A deployment calls `setNotifier()` with a real
  transport; nothing else changes. This is an unimplemented interface rather
  than a missing one, which is why it is first in this list rather than hidden
  in the code.
- **Push notifications.** `notifications` is the durable record and the in-app
  inbox. Nothing pushes to a device. There is no device/token registration
  table, and the notifier seam covers password reset only.
- **Payments.** Invoices are read-only. No provider integration, no webhook
  handler, no reconciliation, no payment-status transitions beyond what the seed
  sets.
- **Physical access control.** Guest passes are issued and tracked but never
  redeemed — there is no door/turnstile integration and no
  `POST /guest-passes/:code/redeem`.
- **Role and permission editing.** `/admin/roles` is read-only. Roles are seeded
  or edited in SQL. There is no `POST /admin/roles` or grant/revoke endpoint,
  despite `settings.manage` existing in the catalogue.
- **Facility and closure management.** `facilities.manage` exists as a
  permission but there are no write endpoints for facilities or closures. They
  are seeded. (The two behavioural columns, `requires_approval` and
  `max_advance_days`, *are* enforced — they just cannot be edited over HTTP.)
- **Member and dependent creation.** No `POST /admin/members`. The register is
  seeded or managed elsewhere; this API reads it and applies approved changes.
- **Invoice issuing.** No `invoices.manage` endpoints despite the permission.
- **Audit coverage is partial by design, and the gaps are listed rather than
  implied.** Written: booking approve/reject/auto-confirm, profile change
  approve/reject, completed password reset, session revocations. Not written:
  logins (successful or failed), member-initiated booking cancellation, guest
  pass issue/revoke, notification reads. Those are activity, not decisions
  somebody is accountable for; adding them is a call to `audit.record()` each,
  and the vocabulary in `ACTIONS` would need extending.
- **Audit retention and export.** Rows accumulate forever. No archival, no
  CSV/JSON export endpoint, no retention policy.
- **Session cleanup job.** `auth_sessions` and `password_reset_tokens` accumulate
  expired rows forever. `idx_sessions_expiry` and `idx_reset_expiry` exist to
  support a cleanup job that does not exist yet; a cron `DELETE` is needed.
- **`auth_sessions.last_seen_at` is read but never written.** It is projected by
  `GET /auth/sessions` and will always be null. Writing it properly needs a
  throttled update to avoid a write on every authenticated request.
- **Eight schema columns are never touched by application code.** Verified by
  scanning `database/schema.sql` against `src/` and `scripts/`:
  `tenants.locale`, `tenants.contact_email`, `roles.is_system`,
  `role_permissions.granted_at`, `membership_categories.monthly_fee_cents`,
  `members.country`, `facilities.image_path`, `facility_closures.created_by`.
  These are stored reference data with no API projection rather than
  behavioural flags that are ignored — unlike `requires_approval` and
  `max_advance_days`, which were in this list and are now enforced. They are
  listed anyway so the count is not left for a reviewer to discover.
- **Refresh tokens.** A member token lives 7 days and then the user logs in
  again. No refresh/rotation flow.
- **Rate limiting is per process, in memory.** `express-rate-limit`'s default
  store. Behind more than one instance the effective limit multiplies by the
  instance count. A shared store (Redis) is needed for a real deployment. The
  key is now correct for IPv6; the store is still not shared.
- **No OpenAPI/Swagger document.** The endpoint table in §2 is the contract.
- **No linter or formatter config.** `npm run check` parses; it does not lint.
  No ESLint, no Prettier.
- **No CI configuration.**
- **No Docker or compose file.**
- **No structured migration tool.** `database/schema.sql` is a single create
  script, not a versioned migration set. A second release would need one.

## 8. Known weaknesses a reviewer should press on

- `compileTenantSql` checks that a statement *mentions* `:tenant`, not that the
  predicate is meaningful. `WHERE 1=1 OR tenant_id = :tenant` passes. Discussed
  in `docs/architecture.md` §2; the honest summary is that it eliminates
  omission, not malice or carelessness.
- **The integration tests pass on MariaDB 10.11 only.** The schema targets
  "MySQL 8.0 / MariaDB 10.6+" but has only been executed against the latter.
  MariaDB implements `JSON` as a `LONGTEXT` with a check constraint rather than
  a native type, so the `audit_logs.metadata` and
  `profile_change_requests.*_values` round-trips are proven on the more
  forgiving of the two engines. MySQL 8 would return those columns as parsed
  objects rather than strings; the repositories handle both (`parseJson` and
  `safeParse` accept either), but that branch is untested.
- **Coverage is by count, not by measurement.** 197 tests with no coverage tool
  configured. Nothing reports which branches are unexercised; the claims in §6
  are about what the tests assert, not about a percentage.
- Login e-mails are globally unique, not per tenant. The same person cannot use
  one address at two associations. This is a direct consequence of refusing a
  client-supplied tenant hint at login and is documented, but it is a real
  product constraint.
- The session revocation check adds one indexed query to every authenticated
  request. It is the right default for this data, but it is a real cost and the
  flag to disable it is easy to flip without thinking.
- The password-reset audit row is written **outside** a transaction, unlike every
  other audit write. The reasoning is in `docs/architecture.md` §4 — that path
  has no tenant scope — but the consequence is real: a password change can
  commit without its audit row if the audit insert fails. The service logs that
  and continues, because failing the request after the password has already
  changed would be worse.
- Soft deletes are still hand-written per query rather than enforced by the
  scope compiler. This is now a documented decision with three stated reasons
  (`docs/architecture.md` §5, "considered and rejected"), not an oversight — but
  a reviewer may weigh those reasons differently, and the failure mode it leaves
  open is real: a forgotten `deleted_at IS NULL` shows a member a record their
  own tenant deleted.
- The in-memory `TenantAwareStore` used by the isolation tests understands a
  narrow query shape. It proves the tenant parameter filters; it does not prove
  MySQL will behave identically on a complex join.
- `memberRepository.applyChanges()` interpolates column names into a `SET`
  clause. It is guarded by an identifier regex *and* the configured allow-list,
  and it is the only such place in the codebase — but it is the one function to
  read carefully.
- The rate-limit store is in-memory, so the corrected IPv6 key only helps within
  a single process. Two instances means twice the effective limit.
- `TRUST_PROXY` is configurable and defaults to `1`, but nothing validates it
  against the actual deployment. A wrong value fails silently — the limiter just
  buckets incorrectly — and only shows up as either mass lockouts or no limiting
  at all.
- Approval audit rows carry no `ip_address` or `user_agent`. The columns exist
  and are populated for session revocations and password resets, but the two
  approval workflows are pure domain functions with no access to the request, so
  they record actor id and role only. Passing request metadata down would mean
  threading it through the service signature; it was not done.
- `audit_logs.metadata` is JSON with no schema. It is written by six call sites
  with roughly consistent shapes (`before`/`after`/`actor_role`/`note`) and read
  by humans. Nothing enforces that consistency; a seventh writer could diverge.
