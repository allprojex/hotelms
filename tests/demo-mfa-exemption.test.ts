import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MFA_REQUIRED_ROLES,
  assuranceLevelFromClaims,
  mfaEnforcedForEnvironment,
  requiresMfa,
  requiresMfaForRoles,
} from "../src/lib/security/mfa-policy";

const PRIVILEGED = [...MFA_REQUIRED_ROLES];
const ORDINARY = ["front_desk", "cashier", "housekeeping", "storekeeper", "waiter", "hr_manager"];

/**
 * The two route guards and the server middleware all consume the same derived
 * values, so the tests below reproduce that derivation once, here, exactly as
 * mfa.functions.ts computes it. `assertDerivationStillMatchesSource` then
 * pins it to the real source so this helper cannot silently drift away from
 * the code it stands in for.
 */
function authenticationPolicy(roles: readonly string[], appEnv: string | undefined, aal: "aal1" | "aal2") {
  const required = requiresMfa(roles, appEnv);
  const hasVerifiedTotp = false;
  return {
    required,
    assuranceLevel: aal,
    next: !required ? "complete" : aal === "aal2" ? "complete" : hasVerifiedTotp ? "challenge" : "enroll",
  } as const;
}

/** What `_authenticated/route.tsx` does with that policy. */
function redirectsToMfa(policy: ReturnType<typeof authenticationPolicy>) {
  return policy.required && policy.assuranceLevel !== "aal2";
}

/** What the server middleware does with it. */
function middlewareRejects(roles: readonly string[], appEnv: string | undefined, aal: "aal1" | "aal2") {
  const allowAal1 = false;
  return !allowAal1 && requiresMfa(roles, appEnv) && aal !== "aal2";
}

describe("1-2. demo: a privileged user at aal1 is allowed straight in", () => {
  it("super_admin at aal1 is allowed", () => {
    expect(requiresMfa(["super_admin"], "demo")).toBe(false);
    expect(middlewareRejects(["super_admin"], "demo", "aal1")).toBe(false);
  });

  it.each(PRIVILEGED)("privileged role %s at aal1 is allowed", (role) => {
    expect(requiresMfa([role], "demo")).toBe(false);
    expect(middlewareRejects([role], "demo", "aal1")).toBe(false);
  });

  it("a user holding several privileged roles at once is still allowed", () => {
    expect(requiresMfa(PRIVILEGED, "demo")).toBe(false);
    expect(middlewareRejects(PRIVILEGED, "demo", "aal1")).toBe(false);
  });
});

describe("3. demo: nothing redirects to /mfa", () => {
  it.each(PRIVILEGED)("%s lands on the dashboard, not /mfa", (role) => {
    const policy = authenticationPolicy([role], "demo", "aal1");
    expect(policy.required).toBe(false);
    expect(policy.next).toBe("complete");
    expect(redirectsToMfa(policy)).toBe(false);
  });

  it("never asks for enrolment, so no QR code can be produced", () => {
    for (const role of PRIVILEGED) {
      expect(authenticationPolicy([role], "demo", "aal1").next).not.toBe("enroll");
      expect(authenticationPolicy([role], "demo", "aal1").next).not.toBe("challenge");
    }
  });
});

describe("4-5. every other environment keeps the existing policy exactly", () => {
  it.each(PRIVILEGED)("production: %s at aal1 still requires MFA", (role) => {
    expect(requiresMfa([role], "production")).toBe(true);
    expect(middlewareRejects([role], "production", "aal1")).toBe(true);
    expect(redirectsToMfa(authenticationPolicy([role], "production", "aal1"))).toBe(true);
    expect(authenticationPolicy([role], "production", "aal1").next).toBe("enroll");
  });

  it.each(PRIVILEGED)("production: %s at aal2 is allowed", (role) => {
    expect(middlewareRejects([role], "production", "aal2")).toBe(false);
    expect(redirectsToMfa(authenticationPolicy([role], "production", "aal2"))).toBe(false);
    expect(authenticationPolicy([role], "production", "aal2").next).toBe("complete");
  });
});

describe("6. production cannot inherit the exemption", () => {
  it("an UNSET environment enforces MFA — the exemption fails closed", () => {
    expect(mfaEnforcedForEnvironment(undefined)).toBe(true);
    expect(requiresMfa(["super_admin"], undefined)).toBe(true);
    expect(middlewareRejects(["super_admin"], undefined, "aal1")).toBe(true);
  });

  it("an empty environment enforces MFA", () => {
    expect(requiresMfa(["super_admin"], "")).toBe(true);
  });

  it("the module default resolves to production when APP_ENV is not set", async () => {
    // deployment-identity defaults APP_ENV to "production"; this pins that the
    // default argument of requiresMfa cannot silently become permissive.
    const identity = await import("../src/lib/deployment-identity");
    expect(identity.APP_ENV).toBe("production");
    expect(identity.IS_DEMO).toBe(false);
    expect(requiresMfa(["super_admin"])).toBe(true);
  });
});

describe("7. the environment must be exactly \"demo\"", () => {
  const nearMisses = [
    "Demo",
    "DEMO",
    "dEmO",
    " demo",
    "demo ",
    "demo-staging",
    "staging-demo",
    "demonstration",
    "prod-demo",
    "production",
    "staging",
    "qa",
    "test",
    "development",
  ];

  it.each(nearMisses)("%j does NOT grant the exemption", (value) => {
    expect(mfaEnforcedForEnvironment(value)).toBe(true);
    expect(requiresMfa(["super_admin"], value)).toBe(true);
  });

  it("only the exact literal grants it", () => {
    expect(mfaEnforcedForEnvironment("demo")).toBe(false);
    expect(requiresMfa(["super_admin"], "demo")).toBe(false);
  });
});

describe("ordinary operational users are unaffected in every environment", () => {
  it.each(ORDINARY)("%s never required MFA and still does not, on production", (role) => {
    expect(requiresMfa([role], "production")).toBe(false);
    expect(middlewareRejects([role], "production", "aal1")).toBe(false);
    expect(authenticationPolicy([role], "production", "aal1").next).toBe("complete");
  });

  it.each(ORDINARY)("%s is allowed on demo too", (role) => {
    expect(requiresMfa([role], "demo")).toBe(false);
    expect(redirectsToMfa(authenticationPolicy([role], "demo", "aal1"))).toBe(false);
  });

  it("hr_manager is not a privileged role under this policy", () => {
    // Listed explicitly because the brief names an HR Manager demo account:
    // it was never in MFA_REQUIRED_ROLES, so its behaviour does not change.
    expect(MFA_REQUIRED_ROLES).not.toContain("hr_manager");
    expect(requiresMfaForRoles(["hr_manager"])).toBe(false);
  });
});

describe("the role list itself is untouched by the environment", () => {
  it("requiresMfaForRoles stays a pure role check", () => {
    for (const role of PRIVILEGED) expect(requiresMfaForRoles([role])).toBe(true);
    for (const role of ORDINARY) expect(requiresMfaForRoles([role])).toBe(false);
  });

  it("the covered-role list is unchanged, so the security screen still renders it", () => {
    expect([...MFA_REQUIRED_ROLES]).toEqual([
      "super_admin",
      "hotel_owner",
      "general_manager",
      "accountant",
      "housekeeping_supervisor",
    ]);
  });

  it("assurance level parsing is unchanged", () => {
    expect(assuranceLevelFromClaims({ aal: "aal2" })).toBe("aal2");
    expect(assuranceLevelFromClaims({ aal: "aal1" })).toBe("aal1");
    expect(assuranceLevelFromClaims({})).toBe("aal1");
    expect(assuranceLevelFromClaims(null)).toBe("aal1");
  });
});

describe("the enforcement points still look the way these tests assume", () => {
  const read = (p: string) => readFileSync(p, "utf8").split(/\r?\n/).join("\n");

  it("the server middleware asks the environment-aware function", () => {
    const src = read("src/integrations/supabase/auth-middleware.ts");
    expect(src).toMatch(/const mfaRequired = requiresMfa\(roles\)/);
    expect(src).not.toMatch(/const mfaRequired = requiresMfaForRoles\(roles\)/);
    // The aal2 gate itself must still be there — the exemption changes what
    // `mfaRequired` is, never whether the gate exists.
    expect(src).toMatch(/if \(!options\.allowAal1 && mfaRequired && assuranceLevel !== "aal2"\)/);
    expect(src).toMatch(/throw new Error\("MFA verification required"\)/);
  });

  it("assertDerivationStillMatchesSource: the policy `next` derivation is unchanged", () => {
    const src = read("src/lib/security/mfa.functions.ts");
    expect(src).toMatch(/next: !context\.mfaRequired/);
    expect(src).toMatch(/\? "complete"/);
    expect(src).toMatch(/context\.assuranceLevel === "aal2"/);
    expect(src).toMatch(/hasVerifiedTotp/);
  });

  it("the route guard still redirects when the policy says MFA is required", () => {
    const src = read("src/routes/_authenticated/route.tsx");
    expect(src).toMatch(/if \(policy\.required && policy\.assuranceLevel !== "aal2"\) throw redirect\(\{ to: "\/mfa" \}\)/);
  });

  it("the exemption is keyed off APP_ENV and never off a hostname", () => {
    const src = read("src/lib/security/mfa-policy.ts");
    expect(src).toMatch(/APP_ENV/);
    expect(src).not.toMatch(/infinitytechub|theskwoffhotel|location\.host|window\./);
  });
});
