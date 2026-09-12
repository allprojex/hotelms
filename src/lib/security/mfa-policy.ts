export const MFA_REQUIRED_ROLES = [
  "super_admin",
  "hotel_owner",
  "general_manager",
  "accountant",
  "housekeeping_supervisor",
] as const;

export type MfaRequiredRole = (typeof MFA_REQUIRED_ROLES)[number];

/** Central policy for roles that supervise people, security, or financial data. */
export function requiresMfaForRoles(roles: readonly string[]): boolean {
  const required = new Set<string>(MFA_REQUIRED_ROLES);
  return roles.some((role) => required.has(role));
}

export function assuranceLevelFromClaims(claims: unknown): "aal1" | "aal2" {
  if (claims && typeof claims === "object" && (claims as { aal?: unknown }).aal === "aal2") {
    return "aal2";
  }
  return "aal1";
}
