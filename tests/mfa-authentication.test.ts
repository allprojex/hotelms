import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assuranceLevelFromClaims, requiresMfaForRoles } from "../src/lib/security/mfa-policy";

const read = (path: string) => readFileSync(path, "utf8");
const middleware = read("src/integrations/supabase/auth-middleware.ts");
const functions = read("src/lib/security/mfa.functions.ts");
const route = read("src/routes/mfa.tsx");
const authRoute = read("src/routes/auth.tsx");
const protectedLayout = read("src/routes/_authenticated/route.tsx");
const adminFunctions = read("src/lib/security/passkey-credentials.functions.ts");

describe("role-aware TOTP MFA", () => {
  it.each([
    "super_admin",
    "hotel_owner",
    "general_manager",
    "accountant",
    "housekeeping_supervisor",
  ])("requires MFA for privileged role %s", (role) =>
    expect(requiresMfaForRoles([role])).toBe(true),
  );

  it.each(["front_desk", "reservations", "cashier", "housekeeping", "guest"])(
    "keeps MFA optional for ordinary role %s",
    (role) => expect(requiresMfaForRoles([role])).toBe(false),
  );

  it("uses the JWT assurance claim and fails closed to AAL1", () => {
    expect(assuranceLevelFromClaims({ aal: "aal2" })).toBe("aal2");
    expect(assuranceLevelFromClaims({ aal: "aal1" })).toBe("aal1");
    expect(assuranceLevelFromClaims({})).toBe("aal1");
  });

  it("enforces privileged AAL2 in centralized server middleware", () => {
    // requiresMfa, not requiresMfaForRoles: the middleware now asks the
    // environment-aware policy, which folds the role check together with the
    // deployment-environment exemption (demo only). The aal2 gate below is
    // unchanged — the exemption alters what `mfaRequired` evaluates to, never
    // whether the gate exists. See tests/demo-mfa-exemption.test.ts.
    expect(middleware).toContain("requiresMfa(roles)");
    expect(middleware).toContain('assuranceLevel !== "aal2"');
    expect(middleware).toContain('throw new Error("MFA verification required")');
    expect(middleware).toContain("requireSupabaseAuthAllowMfaChallenge");
  });

  it("forces enrollment without a verified factor and challenge with one", () => {
    expect(functions).toContain(
      'hasVerifiedTotp\n            ? "challenge"\n            : "enroll"',
    );
    expect(route).toContain('factorType: "totp"');
    expect(route).toContain("challengeAndVerify({ factorId, code })");
    expect(route).toContain("/^\\d{6}$/");
  });

  it("blocks manually entered protected routes before AAL2", () => {
    expect(protectedLayout).toContain("getAuthenticationPolicy()");
    expect(protectedLayout).toContain('throw redirect({ to: "/mfa" })');
    expect(functions).toContain(".middleware([requireSupabaseAuth])");
  });

  it("routes both password and passkey success through the same policy gate", () => {
    expect(
      authRoute.match(/routeAfterPrimaryAuthentication\(result\.mustChangePassword\)/g),
    ).toHaveLength(2);
    expect(authRoute).toContain('navigate({ to: "/mfa", replace: true })');
    expect(authRoute).toContain("Password sign-in is always available");
  });

  it("audits MFA outcomes without sending codes or secrets to server functions", () => {
    expect(functions).toContain('"auth.mfa.enrolled"');
    expect(functions).toContain('"auth.mfa.challenge.success"');
    expect(functions).toContain('"auth.mfa.challenge.failure"');
    expect(functions).toContain('"auth.mfa.required"');
    expect(functions).not.toMatch(/code:\s*data|secret:\s*data/);
  });

  it("uses permission-checked Supabase Admin factor deletion for resets", () => {
    expect(adminFunctions).toContain("PASSKEY_PERMISSIONS.userTwoFactorReset");
    expect(adminFunctions).toContain("auth.admin.mfa.listFactors");
    expect(adminFunctions).toContain("auth.admin.mfa.deleteFactor");
    expect(adminFunctions).toContain('action: "auth.mfa.reset"');
  });

  it("preserves generic password errors and account type/status validation", () => {
    const authFunctions = read("src/lib/auth.functions.ts");
    expect(authFunctions).toContain('const INVALID = "Invalid ID or password"');
    expect(authFunctions).toContain("profile.account_type !== data.accountType");
    expect(authFunctions).toContain('profile.status !== "active"');
  });

  it("contains no production Supabase project reference", () => {
    for (const source of [
      middleware,
      functions,
      route,
      authRoute,
      protectedLayout,
      adminFunctions,
    ]) {
      expect(source).not.toContain("texhuavnrdhaohqzlyqw");
    }
  });
});
