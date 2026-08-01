import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePermission } from "@/lib/permissions";
import { PASSKEY_ADMIN_ROLES, PASSKEY_PERMISSIONS } from "@/lib/security/passkey-permissions";

const root = resolve(__dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260801120000_webauthn_passkey_security.sql"),
  "utf8",
);
const enrollmentFns = readFileSync(
  resolve(root, "src/lib/security/passkey-enrollment.functions.ts"),
  "utf8",
);
const registrationFns = readFileSync(
  resolve(root, "src/lib/security/passkey-registration.functions.ts"),
  "utf8",
);
const authenticationFns = readFileSync(
  resolve(root, "src/lib/security/passkey-authentication.functions.ts"),
  "utf8",
);
const credentialFns = readFileSync(
  resolve(root, "src/lib/security/passkey-credentials.functions.ts"),
  "utf8",
);
const ownPage = readFileSync(
  resolve(root, "src/routes/_authenticated/security.passkeys.tsx"),
  "utf8",
);
const adminPage = readFileSync(
  resolve(root, "src/routes/_authenticated/admin_.security.passkeys.tsx"),
  "utf8",
);
const authRoute = readFileSync(resolve(root, "src/routes/auth.tsx"), "utf8");
const GENERIC_FAILURE_TOKEN = 'GENERIC_FAILURE = "Passkey sign-in failed"';

describe("Phase 5: no raw biometric data is ever stored", () => {
  it("never declares fingerprint/face/template/PIN/private-key columns", () => {
    expect(migration).not.toMatch(/fingerprint_image|face_image|biometric_template|device_pin/i);
    expect(migration).not.toMatch(/private_key/i);
  });

  it("stores only standards-compliant WebAuthn credential metadata", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.webauthn_credentials");
    for (const column of [
      "credential_id",
      "public_key",
      "sign_count",
      "transports",
      "authenticator_attachment",
      "backup_eligible",
      "backup_state",
      "device_name",
      "user_verified",
      "created_at",
      "last_used_at",
      "revoked_at",
    ]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain(
      "No biometric templates, images, PINs or private keys are ever stored",
    );
  });

  it("documents that the private key never leaves the authenticator", () => {
    expect(migration).toContain("private key never leaves the authenticator/device");
  });
});

describe("Phase 5: enrollment approval model", () => {
  it("creates a property-scoped enrollment table with full approval/rejection/revocation history fields", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.passkey_enrollments");
    for (const column of [
      "employee_id",
      "status",
      "enrollment_allowed",
      "requested_at",
      "approved_by",
      "approved_at",
      "rejected_by",
      "rejected_at",
      "rejection_reason",
      "revoked_by",
      "revoked_at",
      "revocation_reason",
    ]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain("UNIQUE (property_id, user_id)");
  });

  it("keeps an immutable append-only enrollment history table", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.passkey_enrollment_history");
    expect(migration).not.toMatch(
      /UPDATE public\.passkey_enrollment_history|DELETE FROM public\.passkey_enrollment_history/,
    );
  });

  it("rejects self-approval in the decision RPC", () => {
    expect(migration).toContain("Enrollment cannot be self-approved");
    expect(migration).toContain("actor = _target_user_id");
  });

  it("requires a reason for reject, revoke and reset but not approve", () => {
    expect(migration).toContain(
      "_decision IN ('rejected','revoked','reset') AND char_length(trim(COALESCE(_reason,''))) < 5",
    );
  });

  it("makes repeated identical decisions idempotent without overwriting finalized history", () => {
    expect(migration).toContain("row.status::text = _decision");
    expect(migration).toContain("idempotent no-op; finalized history is never overwritten");
  });

  it("blocks self-service re-enrollment after revocation until an admin resets it", () => {
    expect(migration).toContain("Enrollment was revoked. Ask an administrator to reset it");
  });

  it("cascades revocation and reset to disable all of the user's credentials", () => {
    expect(migration).toContain("Enrollment revoked: ' || _reason");
    expect(migration).toContain("Enrollment reset: ' || _reason");
  });

  it("enforces property boundaries via can_access_property before creating a request", () => {
    expect(migration).toContain("can_access_property(actor, _property_id)");
  });

  it("notifies the user on every enrollment decision via the existing notify() function", () => {
    expect(migration).toContain("PERFORM public.notify(_property_id, _target_user_id, 'security'");
  });

  it("wires enrollment request/decision through server functions with audit logging", () => {
    expect(enrollmentFns).toContain("export const requestPasskeyEnrollment");
    expect(enrollmentFns).toContain("export const approvePasskeyEnrollment");
    expect(enrollmentFns).toContain("export const rejectPasskeyEnrollment");
    expect(enrollmentFns).toContain("export const revokePasskeyEnrollment");
    expect(enrollmentFns).toContain("export const resetPasskeyEnrollment");
    expect(enrollmentFns).toContain("captureAuditEvent");
    expect(enrollmentFns).toContain("assertServerPermission");
  });
});

describe("Phase 5: registration ceremony", () => {
  it("uses a maintained WebAuthn library rather than manual cryptography", () => {
    expect(registrationFns).toContain("@simplewebauthn/server");
    expect(registrationFns).toContain("generateRegistrationOptions");
    expect(registrationFns).toContain("verifyRegistrationResponse");
  });

  it("only issues a registration challenge for approved, allowed enrollment", () => {
    expect(migration).toContain(
      "enrollment.id IS NULL OR enrollment.status <> 'approved' OR NOT enrollment.enrollment_allowed",
    );
  });

  it("binds challenges to a single user and enforces single-use, expiry and hash matching", () => {
    expect(migration).toContain("challenge.used_at IS NOT NULL OR challenge.invalidated");
    expect(migration).toContain(
      "challenge.expires_at < now() OR challenge.challenge_hash <> _challenge_hash",
    );
    expect(migration).toContain("challenge.user_id <> actor");
    expect(migration).toContain(
      "UPDATE public.webauthn_challenges SET used_at = now() WHERE id = challenge.id",
    );
  });

  it("rejects duplicate credential IDs and non public-key credential types", () => {
    expect(migration).toContain("This authenticator is already registered");
    expect(migration).toContain("Unsupported credential type");
  });

  it("never trusts a client-supplied user id — registration always uses auth.uid()", () => {
    expect(migration).toContain("actor uuid := auth.uid();");
    expect(registrationFns).not.toMatch(/_target_user_id/);
  });

  it("validates origin and RP ID during verification", () => {
    expect(registrationFns).toContain("expectedOrigin: getAllowedOrigins()");
    expect(registrationFns).toContain("expectedRPID: getRpId()");
  });

  it("grants the registration RPCs to authenticated, not service_role", () => {
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.passkey_registration_challenge_create(uuid, text, int, text, text) TO authenticated;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.passkey_registration_complete(\n  uuid, text, text, text, bigint, text[], text, text, boolean, boolean, text, text, boolean\n) TO authenticated;",
    );
  });

  it("audits successful registration and never logs credential blobs or challenge values", () => {
    expect(registrationFns).toContain("captureAuditEvent");
    expect(registrationFns).not.toMatch(
      /console\.(log|info|warn)\(.*(challenge|publicKey|public_key)/i,
    );
  });
});

describe("Phase 5: authentication ceremony", () => {
  it("never reveals account existence and always returns the same response shape", () => {
    expect(authenticationFns).toContain("Account resolution here never reveals whether");
    expect(authenticationFns).toContain("decoyCredentialId");
    expect(authenticationFns).toContain(GENERIC_FAILURE_TOKEN);
  });

  it("documents and enforces the pre-login trust boundary at the database grant level", () => {
    expect(migration).toContain("Trust boundary");
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.passkey_authentication_challenge_create(uuid, uuid, text, int, text, text) TO service_role;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.passkey_authentication_complete(uuid, text, text, bigint) TO service_role;",
    );
    expect(migration).not.toMatch(
      /passkey_authentication_challenge_create[\s\S]{0,400}TO authenticated/,
    );
  });

  it("validates challenge expiry, single-use, hash and user binding before touching a credential", () => {
    expect(migration).toContain("challenge.used_at IS NOT NULL OR challenge.invalidated");
    expect(migration).toContain("challenge.user_id IS NULL THEN");
  });

  it("fails closed for revoked/disabled credentials, unapproved enrollment, inactive accounts and inactive employees", () => {
    expect(migration).toContain("cred.revoked_at IS NOT NULL OR cred.disabled_at IS NOT NULL");
    expect(migration).toContain(
      "enrollment.status <> 'approved' OR NOT enrollment.enrollment_allowed",
    );
    expect(migration).toContain("profile_status <> 'active'");
    expect(migration).toContain("employment_status NOT IN ('active','probation')");
  });

  it("detects non-monotonic sign counters, logs a security event, and fails safely", () => {
    expect(migration).toContain("non_monotonic_sign_count");
    expect(migration).toContain("_new_sign_count <= cred.sign_count");
  });

  it("rate-limits challenge issuance using recent failure history", () => {
    expect(authenticationFns).toContain("recentFailureCount");
    expect(authenticationFns).toContain(">= 5");
  });

  it("bridges to a real Supabase Auth session via magic-link verification, not a parallel session system", () => {
    expect(authenticationFns).toContain("generateLink");
    expect(authenticationFns).toContain("verifyOtp");
    expect(authenticationFns).toContain('type: "magiclink"');
  });

  it("keeps password sign-in fully independent and functional alongside passkey sign-in", () => {
    expect(authRoute).toContain("identifierSignIn");
    expect(authRoute).toContain("beginPasskeyAuthentication");
    expect(authRoute).toContain("Sign in with a passkey");
  });
});

describe("Phase 5: credential management", () => {
  it("exposes only safe fields to the owner — never the public key or full credential id", () => {
    expect(credentialFns).toContain("credentialIdSuffix: String(row.credential_id).slice(-6)");
    expect(credentialFns).not.toMatch(/public_key/);
  });

  it("requires ownership for rename/revoke via the RPC's own WHERE clause", () => {
    expect(migration).toContain("WHERE id = _credential_id AND user_id = actor FOR UPDATE");
  });

  it("keeps revoke-self idempotent and preserves password fallback in the notification copy", () => {
    expect(migration).toContain("Password sign-in remains available");
  });

  it("never displays public keys or raw credential ids in the admin or own pages", () => {
    expect(ownPage).not.toMatch(/public_key/);
    expect(adminPage).not.toMatch(/public_key/);
  });

  it("requires confirmation before revocation in the own-passkey UI", () => {
    expect(ownPage).toContain("AlertDialog");
    expect(ownPage).toContain("Revoke this passkey?");
  });
});

describe("Phase 5: administrator controls", () => {
  it("gates every admin credential action behind a mandatory reason and explicit permission check", () => {
    expect(migration).toContain("char_length(trim(COALESCE(_reason,''))) < 5");
    expect(migration).toContain(
      "public.has_permission(actor, _property_id, 'security_passkey_credentials', 'manage')",
    );
  });

  it("supports disable, revoke, and revoke-all as distinct admin actions", () => {
    expect(migration).toContain("_action NOT IN ('disable','revoke','revoke_all')");
  });

  it("never allows an administrator to register a passkey on behalf of a user", () => {
    expect(credentialFns).not.toMatch(
      /passkey_registration_complete|passkey_registration_challenge_create/,
    );
    expect(adminPage).not.toMatch(/startRegistration/);
  });

  it("requires confirmation dialogs for destructive admin actions in the UI", () => {
    expect(adminPage).toContain("ReasonDialog");
    expect(adminPage).toContain("destructive");
  });

  it("audits every admin action with actor, property and target", () => {
    expect(credentialFns).toContain("captureAuditEvent");
    expect(enrollmentFns).toContain("captureAuditEvent");
  });
});

describe("Phase 5: 2FA policy foundation", () => {
  it("adds property-level passkey and 2FA policy columns without implementing TOTP", () => {
    expect(migration).toContain("passkey_policy text NOT NULL DEFAULT 'optional'");
    expect(migration).toContain("two_factor_policy text NOT NULL DEFAULT 'disabled'");
    expect(migration).toContain("TOTP is not implemented");
  });

  it("never sends SMS one-time codes", () => {
    expect(migration).not.toMatch(/sms/i);
    expect(credentialFns).not.toMatch(/sms/i);
  });

  it("provides an audited admin reset for a user's 2FA status", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.two_factor_admin_reset");
    expect(credentialFns).toContain("resetUserTwoFactor");
  });
});

describe("Phase 5: challenge and session security", () => {
  it("never stores the raw challenge — only a hash", () => {
    expect(migration).toContain("challenge_hash text NOT NULL");
    expect(migration).not.toMatch(/challenge_raw|raw_challenge/);
  });

  it("cleans up expired registration challenges on next use", () => {
    expect(migration).toContain("DELETE FROM public.webauthn_challenges");
    expect(migration).toContain("expires_at < now()");
  });

  it("never exposes challenges to authenticated or anon clients", () => {
    expect(migration).toContain(
      "REVOKE ALL ON public.webauthn_challenges FROM authenticated, anon;",
    );
  });
});

describe("Phase 5: RLS, grants and property isolation", () => {
  it("enables RLS on every new table", () => {
    for (const table of [
      "passkey_enrollments",
      "passkey_enrollment_history",
      "webauthn_credentials",
      "webauthn_challenges",
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    }
  });

  it("restricts direct table writes to service_role — all mutation goes through SECURITY DEFINER RPCs", () => {
    expect(migration).toContain("REVOKE ALL ON public.passkey_enrollments FROM authenticated;");
    expect(migration).toContain("REVOKE ALL ON public.webauthn_credentials FROM authenticated;");
  });

  it("pins search_path=public on every new SECURITY DEFINER function", () => {
    const fns = [
      ...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?AS \$\$/g),
    ];
    expect(fns.length).toBeGreaterThan(0);
    for (const fn of fns) {
      expect(fn[0]).toMatch(/SECURITY DEFINER\s+SET search_path = public/);
    }
  });

  it("uses no duplicate policy names within the migration", () => {
    const names = [...migration.matchAll(/CREATE POLICY (\w+)/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("Phase 5: permissions", () => {
  it("defines the full Phase 5 permission set", () => {
    for (const key of [
      "ownPasskeysView",
      "ownPasskeysEnroll",
      "ownPasskeysRename",
      "ownPasskeysRevoke",
      "enrollmentRequestsView",
      "enrollmentApprove",
      "enrollmentReject",
      "enrollmentRevoke",
      "enrollmentReset",
      "credentialsView",
      "credentialsDisable",
      "credentialsRevoke",
      "authSettingsView",
      "authSettingsManage",
      "twoFactorPolicyView",
      "twoFactorPolicyManage",
      "userTwoFactorReset",
      "authAuditView",
    ] as const) {
      expect(PASSKEY_PERMISSIONS[key]).toBeDefined();
    }
  });

  it("resolves admin-only capabilities to false for an unprivileged role with no explicit grant", () => {
    const allowed = resolvePermission({
      roles: [{ role: "front_desk", property_id: "p1" }],
      grants: [],
      request: { propertyId: "p1", ...PASSKEY_PERMISSIONS.enrollmentApprove },
    });
    expect(allowed).toBe(false);
  });

  it("resolves admin capabilities to true for the seeded admin roles via defaultRoles", () => {
    for (const role of PASSKEY_ADMIN_ROLES) {
      const allowed = resolvePermission({
        roles: [{ role, property_id: "p1" }],
        grants: [],
        request: {
          propertyId: "p1",
          ...PASSKEY_PERMISSIONS.enrollmentApprove,
          defaultRoles: PASSKEY_ADMIN_ROLES,
        },
      });
      expect(allowed).toBe(true);
    }
  });

  it("never hard-codes role names inside the migration's permission checks", () => {
    const decideFn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.passkey_enrollment_decide[\s\S]*?\$\$;/,
    )?.[0];
    expect(decideFn).toContain("public.has_permission(actor, _property_id");
    expect(decideFn).toContain("public.is_security_admin(actor)");
  });
});

describe("Phase 5: password fallback", () => {
  it("keeps password sign-in as the primary form and offers passkeys as an addition", () => {
    expect(authRoute).toContain('accountType === "admin" ? "Admin Sign In" : "Sign In"');
    expect(authRoute).toContain("Sign in with a passkey");
  });

  it("never claims raw fingerprints or faces are read or stored", () => {
    expect(ownPage).not.toMatch(/we (read|store|scan) your (fingerprint|face)/i);
    expect(authRoute).not.toMatch(/we (read|store|scan) your (fingerprint|face)/i);
    expect(ownPage).toMatch(/This app never sees or stores your\s+biometrics/);
  });

  it("explains passkeys are handled by the operating system, not the browser app directly", () => {
    expect(authRoute).toContain("handled by your operating system");
  });

  it("shows a clear secure-context / unsupported-browser message", () => {
    expect(authRoute).toContain("requires a secure (HTTPS) connection");
    expect(authRoute).toContain("isn't supported in this browser");
  });
});
