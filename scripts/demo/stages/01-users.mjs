// Stage 1 — demo staff accounts and roles.
//
// Mirrors createManagedAccount (src/lib/users.functions.ts) step for step:
// Auth Admin createUser with email_confirm, then the profiles row, then
// user_roles, then an audit_logs entry. That server function is itself the
// only way an account can be made — it uses the service role for exactly
// these calls — so replicating it here is the canonical path, not a bypass.
//
// Two deliberate demo-only deviations, both reported:
//   * must_change_password is left FALSE. The application would otherwise
//     force a password change on first sign-in, which would derail a live
//     sales demonstration.
//   * Passwords are generated here and written to the local credential file
//     named by DEMO_CREDENTIAL_FILE. They are never committed and never
//     printed.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGIT = "23456789";
const SYMBOL = "!@#$%*_-+=";

function generatePassword() {
  const pool = UPPER + LOWER + DIGIT + SYMBOL;
  const bytes = randomBytes(64);
  let out = [
    UPPER[bytes[0] % UPPER.length],
    LOWER[bytes[1] % LOWER.length],
    DIGIT[bytes[2] % DIGIT.length],
    SYMBOL[bytes[3] % SYMBOL.length],
  ];
  for (let i = 4; i < 16; i++) out.push(pool[bytes[i] % pool.length]);
  // shuffle
  for (let i = out.length - 1; i > 0; i--) {
    const j = bytes[32 + i] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

export const STAFF = [
  { key: "gm", first: "Adjoa", last: "Kyeremateng", identifier: "gm.demo", role: "general_manager", accountType: "admin", department: "Management", title: "General Manager" },
  { key: "hr", first: "Nana Yaa", last: "Boadu", identifier: "hr.demo", role: "hr", accountType: "staff", department: "HR & Admin", title: "HR Manager" },
  { key: "accountant", first: "Selorm", last: "Agbeko", identifier: "accounts.demo", role: "accountant", accountType: "staff", department: "Finance", title: "Financial Accountant" },
  { key: "frontdesk", first: "Efua", last: "Ansah", identifier: "frontdesk.demo", role: "front_desk", accountType: "staff", department: "Front Office", title: "Front Desk Officer" },
  { key: "reservations", first: "Kwabena", last: "Osei", identifier: "reservations.demo", role: "reservations", accountType: "staff", department: "Front Office", title: "Reservations Officer" },
  { key: "cashier", first: "Abena", last: "Nyarko", identifier: "cashier.demo", role: "cashier", accountType: "staff", department: "Front Office", title: "Front Office Cashier" },
  { key: "restaurant", first: "Kojo", last: "Amankwah", identifier: "restaurant.demo", role: "restaurant_manager", accountType: "staff", department: "Restaurant", title: "Restaurant Manager" },
  { key: "waiter", first: "Adwoa", last: "Sarpong", identifier: "waiter.demo", role: "waiter", accountType: "staff", department: "Restaurant", title: "Senior Waiter" },
  { key: "housekeeping", first: "Yaa", last: "Duodu", identifier: "housekeeping.demo", role: "housekeeping_supervisor", accountType: "staff", department: "Housekeeping", title: "Housekeeping Supervisor" },
  { key: "stores", first: "Ibrahim", last: "Seidu", identifier: "stores.demo", role: "storekeeper", accountType: "staff", department: "Stores", title: "Storekeeper" },
];

export async function run({ ctx, admin, service, log }) {
  const domain = process.env.DEMO_ACCOUNTS_EMAIL_DOMAIN ?? "accounts.infinitygrand.invalid";
  const credentialFile = process.env.DEMO_CREDENTIAL_FILE;
  if (!credentialFile) throw new Error("STOP: DEMO_CREDENTIAL_FILE must name a local file for the generated passwords");

  const existingProfiles = await service.select("profiles", "select=id,identifier,identifier_normalized");
  const byIdentifier = new Map(existingProfiles.map((p) => [p.identifier_normalized, p]));

  const created = [];
  const accounts = {};

  for (const person of STAFF) {
    const normalized = person.identifier.toLocaleLowerCase("en-US");
    const already = byIdentifier.get(normalized);
    if (already) {
      accounts[person.key] = { ...person, userId: already.id, email: null, reused: true };
      log(`  · ${person.identifier} already exists — left untouched`);
      continue;
    }
    if (ctx.dryRun) {
      log(`  · would create ${person.identifier} (${person.role})`);
      continue;
    }

    const email = `${normalized.replace(/[^a-z0-9]/g, ".")}@${domain}`;
    const password = generatePassword();
    const user = await service.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: `${person.first} ${person.last}`,
        identifier: person.identifier,
        account_type: person.accountType,
      },
    });
    const userId = user.id;
    try {
      await service.update("profiles", `id=eq.${userId}`, {
        full_name: `${person.first} ${person.last}`,
        identifier: person.identifier,
        account_type: person.accountType,
        department: person.department,
        default_property_id: ctx.propertyId,
        status: "active",
        // Demo deviation: the application's own flow sets this true.
        must_change_password: false,
        created_by: admin.userId,
        approved_at: new Date().toISOString(),
        approved_by: admin.userId,
      });
      await service.insert("user_roles", [
        person.role === "super_admin"
          ? { user_id: userId, role: person.role, property_id: null }
          : { user_id: userId, role: person.role, property_id: ctx.propertyId },
      ]);
      await service.insert("audit_logs", [
        {
          user_id: admin.userId,
          property_id: ctx.propertyId,
          action: "users.created",
          entity: "profiles",
          entity_id: userId,
          meta: { identifier: person.identifier, account_type: person.accountType, role: person.role, seeded: "demo" },
        },
      ]);
    } catch (error) {
      await service.deleteUser(userId);
      throw error;
    }

    accounts[person.key] = { ...person, userId, email, password, reused: false };
    created.push({ ...person, email, password });
    log(`  · created ${person.identifier} (${person.role})`);
  }

  if (created.length) {
    const header = existsSync(credentialFile)
      ? ""
      : `Infinity Grand Hotel — DEMO staff sign-in credentials\nProject: ${ctx.ref}  ·  Host: https://app.infinitytechub.com\nSign in with the identifier, not the email address.\n\n`;
    if (header) writeFileSync(credentialFile, header, { mode: 0o600 });
    appendFileSync(
      credentialFile,
      created
        .map((c) => `${c.title.padEnd(24)} identifier: ${c.identifier.padEnd(20)} password: ${c.password}   (role ${c.role})`)
        .join("\n") + "\n",
    );
    log(`  · ${created.length} password(s) written to the local credential file (not printed, not committed)`);
  }

  return { accounts };
}
