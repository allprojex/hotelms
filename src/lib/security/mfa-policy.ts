import { APP_ENV } from "@/lib/deployment-identity";

export const MFA_REQUIRED_ROLES = [
  "super_admin",
  "hotel_owner",
  "general_manager",
  "accountant",
  "housekeeping_supervisor",
] as const;

export type MfaRequiredRole = (typeof MFA_REQUIRED_ROLES)[number];

/**
 * The one deployment environment that does not enforce MFA.
 *
 * The sales demo hands the same accounts to many prospective clients in
 * succession, so a second factor bound to one person's authenticator device
 * makes the environment unusable for its only purpose. Every other
 * deployment — production above all — keeps the policy.
 */
const MFA_EXEMPT_APP_ENV = "demo";

/**
 * Whether this deployment enforces MFA at all.
 *
 * Deliberately an exact comparison against a value that defaults to
 * "production" when unset (see deployment-identity). Three things follow, and
 * all three are tested:
 *
 *   - an unset APP_ENV enforces MFA, so a misconfigured or partially
 *     configured deployment fails closed rather than open;
 *   - "Demo", "DEMO", "demo-staging" and every other near-miss enforce MFA,
 *     so the exemption cannot be reached by accident;
 *   - production cannot inherit it, because production's APP_ENV is never the
 *     literal "demo".
 *
 * The environment is a parameter rather than a module read, so the decision is
 * testable in both directions without module mocking and no caller is subject
 * to ambient state it cannot see.
 */
export function mfaEnforcedForEnvironment(appEnv: string | undefined): boolean {
  return appEnv !== MFA_EXEMPT_APP_ENV;
}

/** Central policy for roles that supervise people, security, or financial data. */
export function requiresMfaForRoles(roles: readonly string[]): boolean {
  const required = new Set<string>(MFA_REQUIRED_ROLES);
  return roles.some((role) => required.has(role));
}

/**
 * The enforcement decision: must this session, on this deployment, reach aal2?
 *
 * This is what the authentication middleware asks. `requiresMfaForRoles` stays
 * separate and unchanged because it answers a different question — which roles
 * the policy covers — and the security settings screen renders that list
 * regardless of environment.
 */
export function requiresMfa(
  roles: readonly string[],
  appEnv: string | undefined = APP_ENV,
): boolean {
  if (!mfaEnforcedForEnvironment(appEnv)) return false;
  return requiresMfaForRoles(roles);
}

export function assuranceLevelFromClaims(claims: unknown): "aal1" | "aal2" {
  if (claims && typeof claims === "object" && (claims as { aal?: unknown }).aal === "aal2") {
    return "aal2";
  }
  return "aal1";
}
