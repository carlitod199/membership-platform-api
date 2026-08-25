"use strict";

/**
 * Create or update a staff user.
 *
 *   node scripts/create-staff-user.js <tenant_slug> <role_key> <email> <password> "<Full Name>"
 *
 * Provisioning is a CLI operation rather than an API endpoint because the first
 * user of a new tenant has nobody to authorise them — an HTTP endpoint that can
 * mint an administrator is a bootstrap hole. The password is read as an
 * argument for simplicity; on a shared host, prefer an environment variable so
 * it does not land in shell history.
 */

const { unscopedQuery, unscopedQueryOne, UNSCOPED_PURPOSES } = require("../src/data/global");
const { hashPassword, assertPasswordPolicy } = require("../src/lib/passwords");
const { closePool } = require("../src/config/db");

async function main() {
  const [, , tenantSlug, roleKey, email, password, fullName] = process.argv;

  if (!tenantSlug || !roleKey || !email || !password) {
    process.stderr.write(
      "Usage: node scripts/create-staff-user.js <tenant_slug> <role_key> <email> <password> [\"Full Name\"]\n"
    );
    process.exit(1);
  }

  assertPasswordPolicy(password);

  const tenant = await unscopedQueryOne(
    UNSCOPED_PURPOSES.CLI_PROVISIONING,
    "SELECT id, name FROM tenants WHERE slug = ? LIMIT 1",
    [tenantSlug]
  );
  if (!tenant) throw new Error(`No tenant with slug "${tenantSlug}"`);

  const role = await unscopedQueryOne(
    UNSCOPED_PURPOSES.CLI_PROVISIONING,
    "SELECT id, name FROM roles WHERE tenant_id = ? AND role_key = ? LIMIT 1",
    [tenant.id, roleKey]
  );
  if (!role) throw new Error(`Tenant "${tenantSlug}" has no role "${roleKey}"`);

  const hash = await hashPassword(password);
  const existing = await unscopedQueryOne(
    UNSCOPED_PURPOSES.CLI_PROVISIONING,
    "SELECT id, tenant_id FROM users WHERE email = ? LIMIT 1",
    [email.toLowerCase()]
  );

  if (existing) {
    if (existing.tenant_id !== tenant.id) {
      throw new Error(
        `"${email}" already belongs to a different tenant. Login e-mails are unique across the installation.`
      );
    }
    await unscopedQuery(
      UNSCOPED_PURPOSES.CLI_PROVISIONING,
      `UPDATE users SET password_hash = ?, role_id = ?, status = 'active',
              failed_attempts = 0, full_name = COALESCE(?, full_name)
        WHERE id = ?`,
      [hash, role.id, fullName || null, existing.id]
    );
    process.stdout.write(`Updated staff user ${email} (id ${existing.id}) as ${role.name} in ${tenant.name}\n`);
  } else {
    const result = await unscopedQuery(
      UNSCOPED_PURPOSES.CLI_PROVISIONING,
      `INSERT INTO users (tenant_id, role_id, full_name, email, password_hash, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [tenant.id, role.id, fullName || email, email.toLowerCase(), hash]
    );
    process.stdout.write(`Created staff user ${email} (id ${result.insertId}) as ${role.name} in ${tenant.name}\n`);
  }
}

main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
