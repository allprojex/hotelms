/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 5 tables await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { captureAuditEvent } from "@/lib/audit.server";
import { PASSKEY_ADMIN_ROLES, PASSKEY_PERMISSIONS } from "@/lib/security/passkey-permissions";

const uuid = (value: unknown): string => {
  const v = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v)) throw new Error("Valid identifier required");
  return v;
};
const reasonText = (value: unknown, min: number, max = 500): string => {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length < min) throw new Error(`A reason of at least ${min} characters is required`);
  return trimmed.slice(0, max);
};

/** Own credentials: never returns the credential's public key or full credential id. */
export const listOwnPasskeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await (context.supabase as any)
      .from("webauthn_credentials")
      .select(
        "id,credential_id,device_name,authenticator_attachment,transports,backup_state,created_at,last_used_at,disabled_at,revoked_at",
      )
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((row: any) => ({
      id: row.id,
      deviceName: row.device_name,
      attachment: row.authenticator_attachment,
      transports: row.transports,
      backedUp: row.backup_state,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      active: !row.disabled_at && !row.revoked_at,
      credentialIdSuffix: String(row.credential_id).slice(-6),
    }));
  });

export const renameOwnPasskey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { credentialId: string; name: string }) => ({
    credentialId: uuid(d.credentialId),
    name: String(d.name ?? "")
      .trim()
      .slice(0, 80),
  }))
  .handler(async ({ data, context }) => {
    const result = await (context.supabase as any).rpc("passkey_credential_rename", {
      _credential_id: data.credentialId,
      _name: data.name,
    });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: result.data?.property_id ?? null,
      sourceModule: "passkeys",
      action: "passkey.credential.renamed",
      resourceType: "webauthn_credential",
      resourceId: data.credentialId,
    });
    return result.data;
  });

export const revokeOwnPasskey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { credentialId: string }) => ({ credentialId: uuid(d.credentialId) }))
  .handler(async ({ data, context }) => {
    const result = await (context.supabase as any).rpc("passkey_credential_revoke_self", {
      _credential_id: data.credentialId,
    });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: result.data?.property_id ?? null,
      sourceModule: "passkeys",
      action: "passkey.credential.revoked_by_owner",
      resourceType: "webauthn_credential",
      resourceId: data.credentialId,
    });
    return result.data;
  });

/** Admin: list credential counts + last-used status per user for a property. */
export const listPasskeyCredentialsForAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; targetUserId: string }) => ({
    propertyId: uuid(d.propertyId),
    targetUserId: uuid(d.targetUserId),
  }))
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...PASSKEY_PERMISSIONS.credentialsView,
      defaultRoles: PASSKEY_ADMIN_ROLES,
    });
    const { data: rows, error } = await (context.supabase as any)
      .from("webauthn_credentials")
      .select(
        "id,device_name,authenticator_attachment,created_at,last_used_at,disabled_at,revoked_at",
      )
      .eq("property_id", data.propertyId)
      .eq("user_id", data.targetUserId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

async function adminCredentialAction(
  context: any,
  data: {
    propertyId: string;
    targetUserId: string;
    credentialId: string | null;
    action: "disable" | "revoke" | "revoke_all";
    reason: string;
  },
) {
  await assertServerPermission(context, {
    propertyId: data.propertyId,
    ...(data.action === "disable"
      ? PASSKEY_PERMISSIONS.credentialsDisable
      : PASSKEY_PERMISSIONS.credentialsRevoke),
    defaultRoles: PASSKEY_ADMIN_ROLES,
  });
  const result = await (context.supabase as any).rpc("passkey_admin_credential_action", {
    _property_id: data.propertyId,
    _target_user_id: data.targetUserId,
    _credential_id: data.credentialId,
    _action: data.action,
    _reason: data.reason,
  });
  if (result.error) throw new Error(result.error.message);
  await captureAuditEvent(context, {
    propertyId: data.propertyId,
    sourceModule: "passkeys",
    action: `passkey.credential.admin_${data.action}`,
    resourceType: "webauthn_credential",
    resourceId: data.targetUserId,
    memo: data.reason,
  });
  return { affected: result.data as number };
}

export const disablePasskeyCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { propertyId: string; targetUserId: string; credentialId: string; reason: string }) => ({
      propertyId: uuid(d.propertyId),
      targetUserId: uuid(d.targetUserId),
      credentialId: uuid(d.credentialId),
      reason: reasonText(d.reason, 5),
    }),
  )
  .handler(({ data, context }) => adminCredentialAction(context, { ...data, action: "disable" }));

export const revokePasskeyCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { propertyId: string; targetUserId: string; credentialId: string; reason: string }) => ({
      propertyId: uuid(d.propertyId),
      targetUserId: uuid(d.targetUserId),
      credentialId: uuid(d.credentialId),
      reason: reasonText(d.reason, 5),
    }),
  )
  .handler(({ data, context }) => adminCredentialAction(context, { ...data, action: "revoke" }));

export const revokeAllPasskeyCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; targetUserId: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    targetUserId: uuid(d.targetUserId),
    reason: reasonText(d.reason, 5),
  }))
  .handler(({ data, context }) =>
    adminCredentialAction(context, { ...data, credentialId: null, action: "revoke_all" }),
  );

/** Admin: reset a user's 2FA status (policy foundation only — no TOTP secret exists to clear). */
export const resetUserTwoFactor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; targetUserId: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    targetUserId: uuid(d.targetUserId),
    reason: reasonText(d.reason, 5),
  }))
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...PASSKEY_PERMISSIONS.userTwoFactorReset,
      defaultRoles: PASSKEY_ADMIN_ROLES,
    });
    const result = await (context.supabase as any).rpc("two_factor_admin_reset", {
      _property_id: data.propertyId,
      _target_user_id: data.targetUserId,
      _reason: data.reason,
    });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "passkeys",
      action: "passkey.two_factor.admin_reset",
      resourceType: "profile",
      resourceId: data.targetUserId,
      memo: data.reason,
    });
    return { ok: true };
  });

/** Safe, read-only auth policy for the current property (passkey/2FA policy only — no thresholds). */
export const getOwnAuthPolicy = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string }) => ({ propertyId: uuid(d.propertyId) }))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await (supabaseAdmin as any)
      .from("security_settings")
      .select("passkey_policy,two_factor_policy,two_factor_required_roles,step_up_max_age_minutes")
      .eq("property_id", data.propertyId)
      .maybeSingle();
    return (
      row ?? {
        passkey_policy: "optional",
        two_factor_policy: "disabled",
        two_factor_required_roles: [],
        step_up_max_age_minutes: 15,
      }
    );
  });

export const saveAuthPolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      passkeyPolicy: "disabled" | "optional" | "encouraged" | "required";
      twoFactorPolicy: "disabled" | "optional" | "required";
      twoFactorRequiredRoles: string[];
      stepUpMaxAgeMinutes: number;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...PASSKEY_PERMISSIONS.authSettingsManage,
      defaultRoles: PASSKEY_ADMIN_ROLES,
    });
    const { error } = await (context.supabase as any).from("security_settings").upsert(
      {
        property_id: data.propertyId,
        passkey_policy: data.passkeyPolicy,
        two_factor_policy: data.twoFactorPolicy,
        two_factor_required_roles: data.twoFactorRequiredRoles,
        step_up_max_age_minutes: data.stepUpMaxAgeMinutes,
      },
      { onConflict: "property_id" },
    );
    if (error) throw new Error(error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "passkeys",
      action: "passkey.auth_policy.updated",
      resourceType: "security_settings",
      resourceId: data.propertyId,
      newValues: data,
    });
    return { ok: true };
  });
