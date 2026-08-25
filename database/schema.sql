-- ============================================================================
-- Membership Platform API — schema
-- MySQL 8.0 / MariaDB 10.6+, InnoDB, utf8mb4.
--
-- MULTI-TENANCY MODEL: shared schema, shared tables, discriminator column.
-- Every tenant-owned table carries `tenant_id` as the FIRST column of its
-- primary lookup indexes, so a tenant-scoped query is an index seek rather than
-- a filter over a scan.
--
-- The two tables WITHOUT a tenant_id are deliberate:
--   * `tenants`      — the tenant registry itself
--   * `permissions`  — the global permission catalogue; tenants compose roles
--                      out of it but do not define new permission keys
--
-- Uniqueness that must hold per tenant (membership numbers, role keys, facility
-- names) is enforced by composite UNIQUE keys that lead with tenant_id.
-- Uniqueness that must hold globally (login e-mail, reset token hash) is a
-- plain UNIQUE — see docs/architecture.md for why login identity is global.
-- ============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id            INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  slug          VARCHAR(60)    NOT NULL,
  name          VARCHAR(150)   NOT NULL,
  status        ENUM('active','suspended','closed') NOT NULL DEFAULT 'active',
  timezone      VARCHAR(64)    NOT NULL DEFAULT 'UTC',
  locale        VARCHAR(10)    NOT NULL DEFAULT 'en-US',
  currency      CHAR(3)        NOT NULL DEFAULT 'USD',
  contact_email VARCHAR(190)   NULL,
  created_at    DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tenants_slug (slug),
  KEY idx_tenants_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------------

-- Global catalogue. Not tenant-owned: a permission key is part of the
-- application's contract, and letting tenants invent keys would mean the code
-- could not reference them.
CREATE TABLE permissions (
  id             SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  permission_key VARCHAR(80)       NOT NULL,
  category       VARCHAR(40)       NOT NULL,
  description    VARCHAR(255)      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_permissions_key (permission_key),
  KEY idx_permissions_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Roles are per tenant: two associations can both have a "Front Desk" role with
-- different grants.
CREATE TABLE roles (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tenant_id   INT UNSIGNED  NOT NULL,
  role_key    VARCHAR(60)   NOT NULL,
  name        VARCHAR(80)   NOT NULL,
  description VARCHAR(255)  NULL,
  is_system   TINYINT(1)    NOT NULL DEFAULT 0,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_tenant_key (tenant_id, role_key),
  CONSTRAINT fk_roles_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- tenant_id is denormalised onto the join table on purpose: it lets the
-- permission lookup be scoped without an extra join back to `roles`, and it
-- keeps the table consistent with the tenant-scope rule that every statement
-- names a tenant.
CREATE TABLE role_permissions (
  tenant_id     INT UNSIGNED      NOT NULL,
  role_id       INT UNSIGNED      NOT NULL,
  permission_id SMALLINT UNSIGNED NOT NULL,
  granted_at    DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id, permission_id),
  KEY idx_role_permissions_tenant (tenant_id, role_id),
  CONSTRAINT fk_role_permissions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Staff users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       INT UNSIGNED NOT NULL,
  role_id         INT UNSIGNED NOT NULL,
  full_name       VARCHAR(150) NOT NULL,
  email           VARCHAR(190) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  status          ENUM('active','suspended','inactive') NOT NULL DEFAULT 'active',
  failed_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_login_at   DATETIME     NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      DATETIME     NULL,
  PRIMARY KEY (id),
  -- Global, not per tenant: the login form asks for an e-mail and nothing else,
  -- so the address has to identify one account across the installation.
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_tenant_status (tenant_id, status),
  KEY idx_users_tenant_role (tenant_id, role_id),
  CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------
CREATE TABLE membership_categories (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       INT UNSIGNED NOT NULL,
  name            VARCHAR(80)  NOT NULL,
  monthly_fee_cents INT UNSIGNED NOT NULL DEFAULT 0,
  description     VARCHAR(255) NULL,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_tenant_name (tenant_id, name),
  CONSTRAINT fk_categories_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE members (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id         INT UNSIGNED NOT NULL,
  category_id       INT UNSIGNED NULL,
  membership_number VARCHAR(30)  NOT NULL,
  full_name         VARCHAR(150) NOT NULL,
  email             VARCHAR(190) NULL,
  phone             VARCHAR(30)  NULL,
  mobile            VARCHAR(30)  NULL,
  address_line1     VARCHAR(150) NULL,
  address_line2     VARCHAR(150) NULL,
  city              VARCHAR(80)  NULL,
  state             VARCHAR(80)  NULL,
  postal_code       VARCHAR(20)  NULL,
  country           CHAR(2)      NOT NULL DEFAULT 'US',
  date_of_birth     DATE         NULL,
  joined_on         DATE         NULL,
  status            ENUM('active','suspended','inactive') NOT NULL DEFAULT 'active',
  billing_status    ENUM('current','overdue','in_arrears') NOT NULL DEFAULT 'current',
  photo_path        VARCHAR(255) NULL,
  notes             TEXT         NULL,
  updated_by        INT UNSIGNED NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at        DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_members_tenant_number (tenant_id, membership_number),
  KEY idx_members_tenant_status (tenant_id, status),
  KEY idx_members_tenant_name (tenant_id, full_name),
  KEY idx_members_tenant_billing (tenant_id, billing_status),
  CONSTRAINT fk_members_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_members_category FOREIGN KEY (category_id) REFERENCES membership_categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_members_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dependents (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     INT UNSIGNED NOT NULL,
  member_id     INT UNSIGNED NOT NULL,
  full_name     VARCHAR(150) NOT NULL,
  relationship  ENUM('spouse','child','parent','other') NOT NULL DEFAULT 'other',
  date_of_birth DATE         NULL,
  email         VARCHAR(190) NULL,
  phone         VARCHAR(30)  NULL,
  status        ENUM('active','suspended','inactive') NOT NULL DEFAULT 'active',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    DATETIME     NULL,
  PRIMARY KEY (id),
  KEY idx_dependents_tenant_member (tenant_id, member_id),
  CONSTRAINT fk_dependents_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_dependents_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Member app credentials
-- ---------------------------------------------------------------------------
-- Separate from `members` because a login is not a person: a member may have
-- none (front-desk only), and a dependent may have one of their own. The CHECK
-- keeps a credential attached to exactly one of the two.
CREATE TABLE member_credentials (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       INT UNSIGNED NOT NULL,
  member_id       INT UNSIGNED NULL,
  dependent_id    INT UNSIGNED NULL,
  login_email     VARCHAR(190) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  status          ENUM('active','pending_activation','suspended','inactive') NOT NULL DEFAULT 'pending_activation',
  failed_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_login_at   DATETIME     NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_credentials_login (login_email),
  KEY idx_credentials_tenant_member (tenant_id, member_id),
  KEY idx_credentials_tenant_dependent (tenant_id, dependent_id),
  CONSTRAINT chk_credentials_owner CHECK (
    (member_id IS NOT NULL AND dependent_id IS NULL) OR
    (member_id IS NULL AND dependent_id IS NOT NULL)
  ),
  CONSTRAINT fk_credentials_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_credentials_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE,
  CONSTRAINT fk_credentials_dependent FOREIGN KEY (dependent_id) REFERENCES dependents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Sessions and password reset
-- ---------------------------------------------------------------------------
-- One row per issued JWT. This is what makes logout and device revocation real:
-- without it a token stays valid until it expires no matter what the user does.
CREATE TABLE auth_sessions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id      INT UNSIGNED    NOT NULL,
  token_id       CHAR(36)        NOT NULL COMMENT 'JWT jti claim',
  principal_type ENUM('member','staff') NOT NULL,
  principal_id   INT UNSIGNED    NOT NULL,
  user_agent     VARCHAR(255)    NULL,
  ip_address     VARCHAR(45)     NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at   DATETIME        NULL,
  expires_at     DATETIME        NOT NULL,
  revoked_at     DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token (token_id),
  -- The hot path: the auth middleware looks a session up by (tenant, jti).
  KEY idx_sessions_tenant_token (tenant_id, token_id),
  KEY idx_sessions_principal (tenant_id, principal_type, principal_id, revoked_at),
  -- Supports the cleanup job that deletes expired rows.
  KEY idx_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Only the SHA-256 of the token is stored, so a copy of this table cannot be
-- replayed as working reset links.
CREATE TABLE password_reset_tokens (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id      INT UNSIGNED    NOT NULL,
  principal_type ENUM('member','staff') NOT NULL,
  principal_id   INT UNSIGNED    NOT NULL,
  token_hash     CHAR(64)        NOT NULL COMMENT 'sha256(token) hex',
  expires_at     DATETIME        NOT NULL,
  used_at        DATETIME        NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Global unique: the reset link carries only the token, so it must resolve
  -- to exactly one row without a tenant to narrow by.
  UNIQUE KEY uq_reset_token_hash (token_hash),
  KEY idx_reset_principal (tenant_id, principal_type, principal_id, used_at),
  KEY idx_reset_expiry (expires_at),
  CONSTRAINT fk_reset_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Billing
-- ---------------------------------------------------------------------------
-- Money is stored in integer minor units. DECIMAL read into a JS number is how
-- a cent goes missing.
CREATE TABLE invoices (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id        INT UNSIGNED    NOT NULL,
  member_id        INT UNSIGNED    NOT NULL,
  reference_period CHAR(7)         NOT NULL COMMENT 'YYYY-MM',
  description      VARCHAR(190)    NULL,
  due_date         DATE            NOT NULL,
  amount_cents     INT UNSIGNED    NOT NULL DEFAULT 0,
  discount_cents   INT UNSIGNED    NOT NULL DEFAULT 0,
  penalty_cents    INT UNSIGNED    NOT NULL DEFAULT 0,
  total_cents      INT UNSIGNED    NOT NULL DEFAULT 0,
  paid_cents       INT UNSIGNED    NOT NULL DEFAULT 0,
  currency         CHAR(3)         NOT NULL DEFAULT 'USD',
  status           ENUM('draft','open','paid','overdue','void') NOT NULL DEFAULT 'open',
  paid_at          DATETIME        NULL,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoices_member_period (tenant_id, member_id, reference_period),
  KEY idx_invoices_tenant_status (tenant_id, status, due_date),
  KEY idx_invoices_tenant_member (tenant_id, member_id, due_date),
  CONSTRAINT fk_invoices_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_invoices_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE invoice_lines (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id        INT UNSIGNED    NOT NULL,
  invoice_id       BIGINT UNSIGNED NOT NULL,
  description      VARCHAR(190)    NOT NULL,
  quantity         SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  unit_price_cents INT UNSIGNED    NOT NULL DEFAULT 0,
  total_cents      INT UNSIGNED    NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_invoice_lines_tenant_invoice (tenant_id, invoice_id),
  CONSTRAINT fk_invoice_lines_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_invoice_lines_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Facilities and bookings
-- ---------------------------------------------------------------------------
CREATE TABLE facilities (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id        INT UNSIGNED NOT NULL,
  name             VARCHAR(120) NOT NULL,
  kind             ENUM('room','hall','court','pool','studio','other') NOT NULL DEFAULT 'other',
  description      VARCHAR(255) NULL,
  capacity         SMALLINT UNSIGNED NULL,
  opens_at         TIME         NOT NULL DEFAULT '06:00:00',
  closes_at        TIME         NOT NULL DEFAULT '22:00:00',
  slot_minutes     SMALLINT UNSIGNED NOT NULL DEFAULT 60,
  requires_approval TINYINT(1)  NOT NULL DEFAULT 1,
  max_advance_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  image_path       VARCHAR(255) NULL,
  is_active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at       DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_facilities_tenant_name (tenant_id, name),
  KEY idx_facilities_tenant_active (tenant_id, is_active),
  CONSTRAINT fk_facilities_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE facility_closures (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   INT UNSIGNED NOT NULL,
  facility_id INT UNSIGNED NOT NULL,
  starts_at   DATETIME     NOT NULL,
  ends_at     DATETIME     NOT NULL,
  reason      VARCHAR(190) NULL,
  created_by  INT UNSIGNED NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_closures_tenant_facility (tenant_id, facility_id, starts_at, ends_at),
  CONSTRAINT fk_closures_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_closures_facility FOREIGN KEY (facility_id) REFERENCES facilities (id) ON DELETE CASCADE,
  CONSTRAINT fk_closures_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `status` starts at 'pending' and there is no application path that inserts
-- anything else. Only the approval endpoint writes 'confirmed'.
CREATE TABLE bookings (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id    INT UNSIGNED    NOT NULL,
  facility_id  INT UNSIGNED    NOT NULL,
  member_id    INT UNSIGNED    NOT NULL,
  dependent_id INT UNSIGNED    NULL,
  booking_date DATE            NOT NULL,
  starts_at    TIME            NOT NULL,
  ends_at      TIME            NOT NULL,
  notes        VARCHAR(255)    NULL,
  status       ENUM('pending','confirmed','rejected','cancelled','completed') NOT NULL DEFAULT 'pending',
  reviewed_by  INT UNSIGNED    NULL,
  reviewed_at  DATETIME        NULL,
  review_note  VARCHAR(255)    NULL,
  cancelled_at DATETIME        NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The overlap check reads (tenant, facility, date, status) — this index
  -- covers its leading columns.
  KEY idx_bookings_slot (tenant_id, facility_id, booking_date, status),
  KEY idx_bookings_tenant_member (tenant_id, member_id, booking_date),
  -- The staff review queue: pending bookings, oldest first.
  KEY idx_bookings_tenant_status (tenant_id, status, booking_date),
  CONSTRAINT fk_bookings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_bookings_facility FOREIGN KEY (facility_id) REFERENCES facilities (id) ON DELETE CASCADE,
  CONSTRAINT fk_bookings_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE,
  CONSTRAINT fk_bookings_dependent FOREIGN KEY (dependent_id) REFERENCES dependents (id) ON DELETE SET NULL,
  CONSTRAINT fk_bookings_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_bookings_interval CHECK (ends_at > starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Profile change requests
-- ---------------------------------------------------------------------------
-- The proposed values live here until staff approve; `members` is untouched
-- while status = 'pending'. `current_values` is a snapshot taken at submission
-- so the record explains itself later.
CREATE TABLE profile_change_requests (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id        INT UNSIGNED    NOT NULL,
  member_id        INT UNSIGNED    NOT NULL,
  current_values   JSON            NOT NULL,
  requested_values JSON            NOT NULL,
  status           ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewed_by      INT UNSIGNED    NULL,
  reviewed_at      DATETIME        NULL,
  review_note      VARCHAR(255)    NULL,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_change_requests_tenant_status (tenant_id, status, created_at),
  KEY idx_change_requests_tenant_member (tenant_id, member_id, status),
  CONSTRAINT fk_change_requests_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_change_requests_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE,
  CONSTRAINT fk_change_requests_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Guest passes
-- ---------------------------------------------------------------------------
CREATE TABLE guest_passes (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id      INT UNSIGNED    NOT NULL,
  member_id      INT UNSIGNED    NOT NULL,
  guest_name     VARCHAR(150)    NOT NULL,
  guest_document VARCHAR(40)     NULL,
  guest_phone    VARCHAR(30)     NULL,
  visit_date     DATE            NOT NULL,
  valid_from     TIME            NULL,
  valid_until    TIME            NULL,
  notes          VARCHAR(255)    NULL,
  pass_code      CHAR(32)        NOT NULL COMMENT '128-bit random, hex',
  status         ENUM('issued','used','revoked','expired') NOT NULL DEFAULT 'issued',
  used_at        DATETIME        NULL,
  revoked_at     DATETIME        NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at     DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_guest_passes_code (pass_code),
  KEY idx_guest_passes_tenant_member (tenant_id, member_id, visit_date),
  KEY idx_guest_passes_tenant_date (tenant_id, visit_date, status),
  CONSTRAINT fk_guest_passes_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_guest_passes_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id    INT UNSIGNED    NOT NULL,
  member_id    INT UNSIGNED    NULL,
  dependent_id INT UNSIGNED    NULL,
  category     ENUM('booking','profile','billing','general') NOT NULL DEFAULT 'general',
  title        VARCHAR(150)    NOT NULL,
  body         VARCHAR(500)    NOT NULL,
  ref_entity   VARCHAR(60)     NULL,
  ref_id       BIGINT UNSIGNED NULL,
  read_at      DATETIME        NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The inbox query is (tenant, recipient, created_at DESC); the unread badge
  -- reuses the same index with read_at as a filter.
  KEY idx_notifications_member (tenant_id, member_id, read_at, created_at),
  KEY idx_notifications_dependent (tenant_id, dependent_id, read_at, created_at),
  CONSTRAINT fk_notifications_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_member FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_dependent FOREIGN KEY (dependent_id) REFERENCES dependents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
-- Approvals are decisions someone is accountable for. This table is append-only
-- by convention; nothing in the application updates or deletes from it.
CREATE TABLE audit_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   INT UNSIGNED    NOT NULL,
  actor_type  ENUM('member','staff','system') NOT NULL,
  actor_id    INT UNSIGNED    NULL,
  action      VARCHAR(60)     NOT NULL,
  entity      VARCHAR(60)     NOT NULL,
  entity_id   BIGINT UNSIGNED NULL,
  metadata    JSON            NULL,
  ip_address  VARCHAR(45)     NULL,
  user_agent  VARCHAR(255)    NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_tenant_entity (tenant_id, entity, entity_id),
  KEY idx_audit_tenant_created (tenant_id, created_at),
  CONSTRAINT fk_audit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Permission catalogue (application contract, not tenant data)
-- ---------------------------------------------------------------------------
INSERT INTO permissions (permission_key, category, description) VALUES
  ('members.view',      'members',  'View the member register'),
  ('members.edit',      'members',  'Approve and apply member record changes'),
  ('bookings.view',     'bookings', 'View the booking queue'),
  ('bookings.approve',  'bookings', 'Approve or reject booking requests'),
  ('invoices.view',     'billing',  'View member invoices'),
  ('invoices.manage',   'billing',  'Issue, void and settle invoices'),
  ('facilities.manage', 'bookings', 'Create and edit facilities and closures'),
  ('guests.view',       'guests',   'View issued guest passes'),
  ('settings.view',     'settings', 'View roles, permissions and configuration'),
  ('settings.manage',   'settings', 'Edit roles and permission grants');
