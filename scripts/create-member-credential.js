"use strict";

/**
 * Create or update an app login for a member.
 *
 *   node scripts/create-member-credential.js <tenant_slug> <membership_number> <email> <password>
 *
 * The tenant comes from the member row, not from the arguments — the slug is
 * only used to disambiguate the membership number, which is unique per tenant.
 */

const { unscopedQuery, unscopedQueryOne, UNSCOPED_PURPOSES } = require("../src/data/global");
const { hashPassword, assertPasswordPolicy } = require("../src/lib/passwords");
const { closePool } = require("../src/config/db");

async function main() {
  const [, , tenantSlug, membershipNumber, email, password] = process.argv;

  if (!tenantSlug || !membershipNumber || !email || !password) {
    process.stderr.write(
      "Usage: node scripts/create-member-credential.js <tenant_slug> <membership_number> <email> <password>\n"
    );
    process.exit(1);
  }

  assertPasswordPolicy(password);

  const member = await unscopedQueryOne(
    UNSCOPED_PURPOSES.CLI_PROVISIONING,
    `SELECT m.id, m.tenant_id, m.full_name
       FROM members m
       JOIN tenants t ON t.id = m.tenant_id
      WHERE t.slug = ? AND m.membership_number = ? AND m.deleted_at IS NULL
      LIMIT 1`,
    [tenantSlug, membershipNumber]
  );
  if (!member) throw new Error(`No member ${membershipNumber} in tenant "${tenantSlug}"`);

  const hash = await hashPassword(password);
  const existing = await unscopedQueryOne(
    UNSCOPED_PURPOSES.CLI_PROVISIONING,
    "SELECT id, tenant_id, member_id FROM member_credentials WHERE login_email = ? LIMIT 1",
    [email.toLowerCase()]
  );

  if (existing) {
    if (existing.tenant_id !== member.tenant_id) {
      throw new Error(
        `"${email}" already belongs to a different tenant. Login e-mails are unique across the installation.`
      );
    }
    await unscopedQuery(
      UNSCOPED_PURPOSES.CLI_PROVISIONING,
      `UPDATE member_credentials
          SET password_hash = ?, member_id = ?, dependent_id = NULL,
              status = 'active', failed_attempts = 0
        WHERE id = ?`,
      [hash, member.id, existing.id]
    );
    process.stdout.write(`Updated login ${email} (id ${existing.id}) for ${member.full_name}\n`);
  } else {
    const result = await unscopedQuery(
      UNSCOPED_PURPOSES.CLI_PROVISIONING,
      `INSERT INTO member_credentials (tenant_id, member_id, login_email, password_hash, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [member.tenant_id, member.id, email.toLowerCase(), hash]
    );
    process.stdout.write(`Created login ${email} (id ${result.insertId}) for ${member.full_name}\n`);
  }
}

main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
