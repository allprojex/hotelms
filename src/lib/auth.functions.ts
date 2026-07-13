/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { getRequest } from "@tanstack/react-start/server";
import {
  requireSupabaseAuth,
  requireSupabaseAuthAllowPasswordChange,
} from "@/integrations/supabase/auth-middleware";
import {
  normalizeIdentifier,
  validateIdentifier,
  validatePassword,
  type LoginAccountType,
} from "@/lib/auth-identity";

const INVALID = "Invalid ID or password";

function ipHash() {
  const request = getRequest();
  const ip =
    request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request?.headers.get("x-real-ip") ||
    "unknown";
  // Deliberately non-reversible enough for rate-limit correlation; no raw IP is stored.
  let h = 2166136261;
  for (let i = 0; i < ip.length; i++) h = Math.imul(h ^ ip.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

export const identifierSignIn = createServerFn({ method: "POST" })
  .validator((d: { accountType: LoginAccountType; identifier: string; password: string }) => {
    if (d.accountType !== "staff" && d.accountType !== "admin") throw new Error(INVALID);
    return {
      accountType: d.accountType,
      identifier: validateIdentifier(d.identifier),
      password: d.password,
    };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const normalized = normalizeIdentifier(data.identifier);
    const since = new Date(Date.now() - 15 * 60_000).toISOString();
    const attempts = await ((supabaseAdmin as any).from("login_attempts") as any)
      .select("id", { count: "exact", head: true })
      .eq("identifier_normalized", normalized)
      .eq("account_type", data.accountType)
      .eq("succeeded", false)
      .gte("created_at", since);
    if ((attempts.count ?? 0) >= 5) throw new Error(INVALID);

    const profileRes = await (supabaseAdmin.from("profiles") as any)
      .select("id,account_type,status,must_change_password")
      .eq("identifier_normalized", normalized)
      .maybeSingle();
    const profile = profileRes.data;
    let succeeded = false;
    try {
      if (!profile || profile.account_type !== data.accountType || profile.status !== "active")
        throw new Error(INVALID);
      const authUser = await supabaseAdmin.auth.admin.getUserById(profile.id);
      const email = authUser.data.user?.email;
      if (!email) throw new Error(INVALID);
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_PUBLISHABLE_KEY;
      if (!url || !key) throw new Error("Authentication is unavailable");
      const auth = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const signed = await auth.auth.signInWithPassword({ email, password: data.password });
      if (signed.error || !signed.data.session) throw new Error(INVALID);
      succeeded = true;
      const now = new Date().toISOString();
      await Promise.all([
        (supabaseAdmin.from("profiles") as any)
          .update({ last_successful_login_at: now })
          .eq("id", profile.id),
        (supabaseAdmin.from("audit_logs") as any).insert({
          user_id: profile.id,
          action: "auth.login.success",
          entity: "profiles",
          entity_id: profile.id,
          meta: { account_type: data.accountType },
        }),
      ]);
      return {
        accessToken: signed.data.session.access_token,
        refreshToken: signed.data.session.refresh_token,
        mustChangePassword: !!profile.must_change_password,
        accountType: profile.account_type as LoginAccountType,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "Authentication is unavailable") throw error;
      throw new Error(INVALID);
    } finally {
      await ((supabaseAdmin as any).from("login_attempts") as any).insert({
        identifier_normalized: normalized,
        account_type: data.accountType,
        succeeded,
        ip_hash: ipHash(),
      });
      if (!succeeded && (attempts.count ?? 0) === 4) {
        await (supabaseAdmin.from("audit_logs") as any).insert({
          action: "auth.login.failure_threshold",
          entity: "profiles",
          meta: { account_type: data.accountType, identifier_normalized: normalized },
        });
      }
    }
  });

export const getPasswordChangeState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuthAllowPasswordChange])
  .handler(async ({ context }) => {
    const { data } = await (context.supabase.from("profiles") as any)
      .select("must_change_password,account_type,status,identifier,full_name")
      .eq("id", context.userId)
      .single();
    return data;
  });

export const changeOwnPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuthAllowPasswordChange])
  .validator((d: { password: string; confirmation: string }) => {
    validatePassword(d.password);
    if (d.password !== d.confirmation) throw new Error("Passwords do not match.");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const updated = await supabaseAdmin.auth.admin.updateUserById(context.userId, {
      password: data.password,
    });
    if (updated.error) throw updated.error;
    const now = new Date().toISOString();
    const profile = await (supabaseAdmin.from("profiles") as any)
      .update({ must_change_password: false, password_changed_at: now })
      .eq("id", context.userId);
    if (profile.error) throw profile.error;
    await (supabaseAdmin.from("audit_logs") as any).insert({
      user_id: context.userId,
      action: "auth.password.changed",
      entity: "profiles",
      entity_id: context.userId,
    });

    // Updating a password through the Admin API invalidates refresh tokens. Issue a
    // new normal Supabase session so the mandatory-change flow can continue safely.
    const email = updated.data.user.email;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!email || !url || !key) throw new Error("Password changed. Please sign in again.");
    const auth = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signed = await auth.auth.signInWithPassword({ email, password: data.password });
    if (signed.error || !signed.data.session) {
      throw new Error("Password changed. Please sign in again.");
    }
    return {
      ok: true,
      accessToken: signed.data.session.access_token,
      refreshToken: signed.data.session.refresh_token,
    };
  });
