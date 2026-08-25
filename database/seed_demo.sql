-- ============================================================================
-- Membership Platform API — demo seed
--
-- Entirely fictional data. Two tenants exist so that tenant isolation can be
-- demonstrated rather than asserted:
--
--   tenant 1  Northgate Association
--   tenant 2  Riverside Association
--
-- The seed is built so that a leak is *visible*. Both tenants have:
--   * a member called John Smith and a member called Jane Doe,
--   * a facility with the same name ("Main Hall"),
--   * an invoice for the same period,
--   * a pending booking on the same date and time.
--
-- Northgate's "Studio" (facility 3) is seeded with requires_approval = 0, so it
-- exercises the auto-confirm path; every other facility requires approval.
--
-- Every value that would differ if a query leaked across tenants is tagged:
-- Northgate rows read "Northgate", Riverside rows read "Riverside", and the
-- membership numbers use different prefixes (NG- and RV-). If a Northgate token
-- ever returns a row containing "Riverside", the isolation is broken and it is
-- obvious at a glance.
--
-- Demo passwords (bcrypt cost 12, generated for this file):
--   members : DemoMember2026!
--   staff   : DemoStaff2026!
-- These are published placeholders for a demo database. Never seed them into
-- anything reachable from the internet.
--
-- Usage:
--   mysql -u root -p membership_platform < database/schema.sql
--   mysql -u root -p membership_platform < database/seed_demo.sql
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
INSERT INTO tenants (id, slug, name, status, timezone, locale, currency, contact_email) VALUES
  (1, 'northgate', 'Northgate Association', 'active', 'America/New_York', 'en-US', 'USD', 'office@northgate.example.com'),
  (2, 'riverside', 'Riverside Association', 'active', 'America/Chicago',  'en-US', 'USD', 'office@riverside.example.com');

-- ---------------------------------------------------------------------------
-- Roles (per tenant) and grants
-- ---------------------------------------------------------------------------
INSERT INTO roles (id, tenant_id, role_key, name, description, is_system) VALUES
  (1, 1, 'owner',              'Owner',              'Full access to everything in the tenant', 1),
  (2, 1, 'administrator',      'Administrator',      'Day-to-day administration', 1),
  (3, 1, 'front_desk',         'Front Desk',         'Reception: bookings and guest passes', 1),
  (4, 1, 'membership_officer', 'Membership Officer', 'Member register and profile changes', 1),
  (5, 1, 'accountant',         'Accountant',         'Billing only, no approvals', 1),
  (6, 2, 'owner',              'Owner',              'Full access to everything in the tenant', 1),
  (7, 2, 'administrator',      'Administrator',      'Day-to-day administration', 1),
  (8, 2, 'front_desk',         'Front Desk',         'Reception: bookings and guest passes', 1);

-- Owner and administrator: everything.
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT 1, 1, id FROM permissions;
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT 1, 2, id FROM permissions;
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT 2, 6, id FROM permissions;
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT 2, 7, id FROM permissions;

-- Front desk: bookings, guests, read-only member lookup.
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT 1, 3, id FROM permissions
 WHERE permission_key IN ('bookings.view','bookings.approve','guests.view','members.view');
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT 2, 8, id FROM permissions
 WHERE permission_key IN ('bookings.view','bookings.approve','guests.view','members.view');

-- Membership officer: the member register and profile changes.
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT 1, 4, id FROM permissions
 WHERE permission_key IN ('members.view','members.edit','bookings.view');

-- Accountant: billing and a booking read. Deliberately holds NO approval
-- permission, so it demonstrates a 403 on the approval endpoints.
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT 1, 5, id FROM permissions
 WHERE permission_key IN ('invoices.view','invoices.manage','members.view','bookings.view');

-- ---------------------------------------------------------------------------
-- Staff users — password: DemoStaff2026!
-- ---------------------------------------------------------------------------
INSERT INTO users (id, tenant_id, role_id, full_name, email, password_hash, status) VALUES
  (1, 1, 1, 'Alice Owner',     'alice.owner@northgate.example.com',   '$2a$12$sKVYEKC4iCazRXemP7DsMur0Cdo6VtZVZ7PdfWRHMWMUJOsok3oZ.', 'active'),
  (2, 1, 3, 'Bob Frontdesk',   'bob.frontdesk@northgate.example.com', '$2a$12$sKVYEKC4iCazRXemP7DsMur0Cdo6VtZVZ7PdfWRHMWMUJOsok3oZ.', 'active'),
  (3, 1, 5, 'Carol Accounts',  'carol.accounts@northgate.example.com','$2a$12$sKVYEKC4iCazRXemP7DsMur0Cdo6VtZVZ7PdfWRHMWMUJOsok3oZ.', 'active'),
  (4, 2, 6, 'Dave Owner',      'dave.owner@riverside.example.com',    '$2a$12$sKVYEKC4iCazRXemP7DsMur0Cdo6VtZVZ7PdfWRHMWMUJOsok3oZ.', 'active');

-- ---------------------------------------------------------------------------
-- Membership categories
-- ---------------------------------------------------------------------------
INSERT INTO membership_categories (id, tenant_id, name, monthly_fee_cents, description) VALUES
  (1, 1, 'Northgate Full',      12000, 'Full membership, Northgate'),
  (2, 1, 'Northgate Associate',  7500, 'Associate membership, Northgate'),
  (3, 2, 'Riverside Full',      13500, 'Full membership, Riverside'),
  (4, 2, 'Riverside Associate',  8000, 'Associate membership, Riverside');

-- ---------------------------------------------------------------------------
-- Members — same names in both tenants, on purpose.
-- ---------------------------------------------------------------------------
INSERT INTO members
  (id, tenant_id, category_id, membership_number, full_name, email, phone, mobile,
   address_line1, city, state, postal_code, date_of_birth, joined_on, status, billing_status, notes)
VALUES
  (1, 1, 1, 'NG-0001', 'John Smith', 'john.smith@example.com', '+1-555-0100', '+1-555-0101',
   '10 Northgate Row', 'Northgate', 'NY', '10001', '1985-04-12', '2019-03-01', 'active', 'current',
   'Northgate member record'),
  (2, 1, 2, 'NG-0002', 'Jane Doe', 'jane.doe@example.com', '+1-555-0102', '+1-555-0103',
   '22 Northgate Row', 'Northgate', 'NY', '10001', '1990-09-30', '2021-07-15', 'active', 'overdue',
   'Northgate member record'),
  (3, 2, 3, 'RV-0001', 'John Smith', 'john.smith.riverside@example.com', '+1-555-0200', '+1-555-0201',
   '5 Riverside Walk', 'Riverside', 'IL', '60601', '1978-01-20', '2015-11-02', 'active', 'current',
   'Riverside member record'),
  (4, 2, 4, 'RV-0002', 'Jane Doe', 'jane.doe.riverside@example.com', '+1-555-0202', '+1-555-0203',
   '9 Riverside Walk', 'Riverside', 'IL', '60601', '1992-06-06', '2022-02-20', 'active', 'current',
   'Riverside member record');

INSERT INTO dependents (id, tenant_id, member_id, full_name, relationship, date_of_birth, status) VALUES
  (1, 1, 1, 'Sam Smith',    'child',  '2012-05-04', 'active'),
  (2, 1, 1, 'Erin Smith',   'spouse', '1986-11-11', 'active'),
  (3, 2, 3, 'Riley Smith',  'child',  '2010-08-19', 'active');

-- ---------------------------------------------------------------------------
-- Member app credentials — password: DemoMember2026!
--
-- Login e-mails are globally unique, so the Riverside namesakes use distinct
-- addresses. That constraint is a real consequence of the login model and is
-- documented in docs/architecture.md rather than hidden.
-- ---------------------------------------------------------------------------
INSERT INTO member_credentials
  (id, tenant_id, member_id, dependent_id, login_email, password_hash, status)
VALUES
  (1, 1, 1,    NULL, 'john.smith@example.com',           '$2a$12$8CrLWnDuHWFMJ/9HlLNRle0qDQrcoYsBeXd5Ne7YfyQ6hkkJj4NR6', 'active'),
  (2, 1, 2,    NULL, 'jane.doe@example.com',             '$2a$12$8CrLWnDuHWFMJ/9HlLNRle0qDQrcoYsBeXd5Ne7YfyQ6hkkJj4NR6', 'active'),
  (3, 1, NULL, 2,    'erin.smith@example.com',           '$2a$12$8CrLWnDuHWFMJ/9HlLNRle0qDQrcoYsBeXd5Ne7YfyQ6hkkJj4NR6', 'active'),
  (4, 2, 3,    NULL, 'john.smith.riverside@example.com', '$2a$12$8CrLWnDuHWFMJ/9HlLNRle0qDQrcoYsBeXd5Ne7YfyQ6hkkJj4NR6', 'active'),
  (5, 2, 4,    NULL, 'jane.doe.riverside@example.com',   '$2a$12$8CrLWnDuHWFMJ/9HlLNRle0qDQrcoYsBeXd5Ne7YfyQ6hkkJj4NR6', 'active');

-- ---------------------------------------------------------------------------
-- Facilities — same name in both tenants.
-- ---------------------------------------------------------------------------
INSERT INTO facilities
  (id, tenant_id, name, kind, description, capacity, opens_at, closes_at, slot_minutes,
   requires_approval, max_advance_days)
VALUES
  (1, 1, 'Main Hall',      'hall',   'Northgate main hall',      120, '08:00:00', '22:00:00', 60, 1,  60),
  (2, 1, 'Meeting Room A', 'room',   'Northgate meeting room',    12, '08:00:00', '20:00:00', 60, 1,  30),
  -- requires_approval = 0: bookings here confirm immediately. max_advance_days
  -- is short so the advance-window rule is easy to trip in a demo.
  (3, 1, 'Studio',         'studio', 'Northgate activity studio', 25, '06:00:00', '21:00:00', 60, 0,   7),
  (4, 2, 'Main Hall',      'hall',   'Riverside main hall',       80, '09:00:00', '23:00:00', 60, 1,  90),
  (5, 2, 'Lakeside Room',  'room',   'Riverside meeting room',    20, '09:00:00', '19:00:00', 60, 1,  30);

INSERT INTO facility_closures (id, tenant_id, facility_id, starts_at, ends_at, reason) VALUES
  (1, 1, 1, '2026-09-14 08:00:00', '2026-09-14 13:00:00', 'Northgate floor maintenance'),
  (2, 2, 4, '2026-09-14 09:00:00', '2026-09-14 12:00:00', 'Riverside deep clean');

-- ---------------------------------------------------------------------------
-- Bookings — a pending one in each tenant, same facility name, same slot.
--
-- Booking 1 (Northgate) and booking 3 (Riverside) are the isolation probe: a
-- Northgate staff token listing pending bookings must return booking 1 and
-- never booking 3.
-- ---------------------------------------------------------------------------
INSERT INTO bookings
  (id, tenant_id, facility_id, member_id, dependent_id, booking_date, starts_at, ends_at, notes, status)
VALUES
  (1, 1, 1, 1, NULL, '2026-09-20', '18:00:00', '19:00:00', 'Northgate family gathering',  'pending'),
  (2, 1, 2, 2, NULL, '2026-09-21', '10:00:00', '11:00:00', 'Northgate committee meeting', 'confirmed'),
  (3, 2, 4, 3, NULL, '2026-09-20', '18:00:00', '19:00:00', 'Riverside birthday party',    'pending'),
  (4, 2, 5, 4, NULL, '2026-09-22', '14:00:00', '15:00:00', 'Riverside book club',         'confirmed');

UPDATE bookings SET reviewed_by = 1, reviewed_at = '2026-08-01 09:00:00', review_note = 'Approved by Northgate staff' WHERE id = 2;
UPDATE bookings SET reviewed_by = 4, reviewed_at = '2026-08-01 09:05:00', review_note = 'Approved by Riverside staff' WHERE id = 4;

-- ---------------------------------------------------------------------------
-- Profile change requests — one pending in each tenant.
-- ---------------------------------------------------------------------------
INSERT INTO profile_change_requests
  (id, tenant_id, member_id, current_values, requested_values, status)
VALUES
  (1, 1, 1,
   JSON_OBJECT('email', 'john.smith@example.com', 'mobile', '+1-555-0101'),
   JSON_OBJECT('email', 'john.smith.new@example.com', 'mobile', '+1-555-0999'),
   'pending'),
  (2, 2, 3,
   JSON_OBJECT('city', 'Riverside', 'postal_code', '60601'),
   JSON_OBJECT('city', 'Riverside Heights', 'postal_code', '60602'),
   'pending');

-- ---------------------------------------------------------------------------
-- Invoices — same reference period in both tenants.
-- ---------------------------------------------------------------------------
INSERT INTO invoices
  (id, tenant_id, member_id, reference_period, description, due_date,
   amount_cents, discount_cents, penalty_cents, total_cents, paid_cents, status, paid_at)
VALUES
  (1, 1, 1, '2026-07', 'Northgate dues July 2026',   '2026-07-10', 12000, 0,    0,   12000, 12000, 'paid',    '2026-07-08 10:12:00'),
  (2, 1, 1, '2026-08', 'Northgate dues August 2026', '2026-08-10', 12000, 0,    0,   12000, 0,     'open',    NULL),
  (3, 1, 2, '2026-08', 'Northgate dues August 2026', '2026-08-10',  7500, 0,  750,    8250, 0,     'overdue', NULL),
  (4, 2, 3, '2026-08', 'Riverside dues August 2026', '2026-08-05', 13500, 1000,  0,   12500, 0,    'open',    NULL),
  (5, 2, 4, '2026-08', 'Riverside dues August 2026', '2026-08-05',  8000, 0,    0,    8000, 8000,  'paid',    '2026-08-02 08:30:00');

INSERT INTO invoice_lines (tenant_id, invoice_id, description, quantity, unit_price_cents, total_cents) VALUES
  (1, 2, 'Northgate monthly dues', 1, 12000, 12000),
  (1, 3, 'Northgate monthly dues', 1,  7500,  7500),
  (1, 3, 'Northgate late fee',     1,   750,   750),
  (2, 4, 'Riverside monthly dues', 1, 13500, 13500),
  (2, 4, 'Riverside loyalty discount', 1, 0, 0);

-- ---------------------------------------------------------------------------
-- Guest passes
-- ---------------------------------------------------------------------------
INSERT INTO guest_passes
  (id, tenant_id, member_id, guest_name, guest_document, visit_date, valid_from, valid_until, pass_code, status)
VALUES
  (1, 1, 1, 'Peter Guest',  'ID-NG-1001', '2026-09-20', '17:00:00', '23:00:00', '4f1c2ba97de84a1b9d0c53e6ab77120e', 'issued'),
  (2, 2, 3, 'Nina Visitor', 'ID-RV-2001', '2026-09-20', '17:00:00', '23:00:00', 'c93a70b8154e42d7ae5fbb01d2e6a934', 'issued');

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
INSERT INTO notifications (tenant_id, member_id, dependent_id, category, title, body, ref_entity, ref_id) VALUES
  (1, 1, NULL, 'booking', 'Booking confirmed', 'Your Northgate booking for 2026-09-21 at 10:00 has been confirmed.', 'booking', 2),
  (1, 2, NULL, 'billing', 'Invoice overdue',   'Your Northgate August invoice is overdue.',                          'invoice', 3),
  (2, 3, NULL, 'booking', 'Booking confirmed', 'Your Riverside booking for 2026-09-22 at 14:00 has been confirmed.', 'booking', 4);

-- ---------------------------------------------------------------------------
-- Audit trail
--
-- Rows matching the two already-approved bookings above, so the trail is not
-- empty on a fresh install and GET /admin/audit-logs returns something. Written
-- by hand here; at runtime these rows are produced by the approval workflows
-- inside the same transaction as the state change.
-- ---------------------------------------------------------------------------
INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, entity, entity_id, metadata, ip_address, created_at) VALUES
  (1, 'staff', 1, 'booking.approved', 'booking', 2,
   JSON_OBJECT('before', JSON_OBJECT('status', 'pending'),
               'after',  JSON_OBJECT('status', 'confirmed'),
               'actor_role', 'owner', 'member_id', 2, 'facility_id', 2),
   '198.51.100.10', '2026-08-01 09:00:00'),
  (2, 'staff', 4, 'booking.approved', 'booking', 4,
   JSON_OBJECT('before', JSON_OBJECT('status', 'pending'),
               'after',  JSON_OBJECT('status', 'confirmed'),
               'actor_role', 'owner', 'member_id', 4, 'facility_id', 5),
   '198.51.100.20', '2026-08-01 09:05:00');

-- ---------------------------------------------------------------------------
-- Isolation probe
--
-- Run this after seeding. Both queries must return exactly the rows tagged with
-- their own tenant, and the second column must never contain the other
-- association's name.
--
--   SELECT id, notes FROM bookings WHERE tenant_id = 1;   -- Northgate only
--   SELECT id, notes FROM bookings WHERE tenant_id = 2;   -- Riverside only
--
-- Over HTTP, the same probe:
--   1. log in as john.smith@example.com           (tenant 1)
--   2. GET /api/v1/profile  -> membership_number must start with NG-
--   3. log in as john.smith.riverside@example.com (tenant 2)
--   4. GET /api/v1/profile  -> membership_number must start with RV-
--   5. present the tenant-1 token and try to read a tenant-2 id, e.g.
--      GET /api/v1/invoices/4  -> must be 404, not 200
-- ---------------------------------------------------------------------------
