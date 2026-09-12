/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServerFn } from "@tanstack/react-start";
import {
  requireSupabaseAuth,
  requireSupabaseAuthAllowMfaChallenge,
} from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";

export const getAuthenticationPolicy = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuthAllowMfaChallenge])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const factors = await supabaseAdmin.auth.admin.mfa.listFactors({ userId: context.userId });
    if (factors.error) throw new Error("Unable to verify multi-factor status");
    const hasVerifiedTotp = factors.data.factors.some(
      (factor) => factor.factor_type === "totp" && factor.status === "verified",
    );
    return {
      required: context.mfaRequired,
      assuranceLevel: context.assuranceLevel,
      hasVerifiedTotp,
      roles: context.roles,
      next: !context.mfaRequired
        ? "complete"
        : context.assuranceLevel === "aal2"
          ? "complete"
          : hasVerifiedTotp
            ? "challenge"
            : "enroll",
    } as const;
  });

const MFA_EVENTS = [
  "auth.mfa.required",
  "auth.mfa.enrolled",
  "auth.mfa.challenge.success",
  "auth.mfa.challenge.failure",
] as const;

export const recordMfaEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuthAllowMfaChallenge])
  .inputValidator((data: { action: (typeof MFA_EVENTS)[number] }) => {
    if (!MFA_EVENTS.includes(data.action)) throw new Error("Invalid MFA event");
    return data;
  })
  .handler(async ({ data, context }) => {
    if (
      (data.action === "auth.mfa.enrolled" || data.action === "auth.mfa.challenge.success") &&
      context.assuranceLevel !== "aal2"
    ) {
      throw new Error("MFA verification required");
    }
    const propertyId = await primaryPropertyId(context.supabase, context.userId);
    await captureAuditEvent(
      context as any,
      {
        propertyId,
        sourceModule: "authentication",
        action: data.action,
        resourceType: "profile",
        resourceId: context.userId,
        success: data.action !== "auth.mfa.challenge.failure",
      },
      { required: true },
    );
    return { ok: true };
  });

export const confirmAal2Access = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(() => ({ ok: true }));

export const recordLogout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuthAllowMfaChallenge])
  .handler(async ({ context }) => {
    const propertyId = await primaryPropertyId(context.supabase, context.userId);
    await captureAuditEvent(context as any, {
      propertyId,
      sourceModule: "authentication",
      action: "auth.logout",
      resourceType: "profile",
      resourceId: context.userId,
    });
    return { ok: true };
  });

async function primaryPropertyId(supabase: any, userId: string): Promise<string | null> {
  const { data } = await supabase
    .from("profiles")
    .select("default_property_id")
    .eq("id", userId)
    .maybeSingle();
  if (data?.default_property_id) return data.default_property_id;
  const role = await supabase
    .from("user_roles")
    .select("property_id")
    .eq("user_id", userId)
    .not("property_id", "is", null)
    .limit(1)
    .maybeSingle();
  return role.data?.property_id ?? null;
}
