/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 5 tables await generated database types. */
// Pre-login WebAuthn/passkey sign-in. No Supabase session exists yet, so these handlers use
// supabaseAdmin (service_role) directly — mirroring identifierSignIn in auth.functions.ts —
// and the two database RPCs they call are granted to service_role only (never `authenticated`
// or `anon`; see the Phase 5 migration). Account resolution here never reveals whether an
// identifier exists: the response shape and the generic failure message are identical whether
// or not an account, credential or approval exists.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { getRequest } from "@tanstack/react-start/server";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { normalizeIdentifier, type LoginAccountType } from "@/lib/auth-identity";
import { getAllowedOrigins, getRpId } from "@/lib/security/webauthn-config.server";

const GENERIC_FAILURE = "Passkey sign-in failed";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function extractChallenge(clientDataJSON: string): string {
  const json = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8"));
  if (typeof json.challenge !== "string") throw new Error(GENERIC_FAILURE);
  return json.challenge;
}

function ipHash(): string | undefined {
  const request = getRequest();
  const ip =
    request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request?.headers.get("x-real-ip") ||
    undefined;
  return ip ? sha256(ip).slice(0, 32) : undefined;
}

function decoyCredentialId(identifier: string): string {
  return sha256(`decoy:${normalizeIdentifier(identifier)}`).slice(0, 64);
}

async function resolveProfile(admin: any, identifier: string) {
  const result = await admin.rpc("find_login_profile", { _identifier: identifier });
  if (result.error) return null;
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return row ?? null;
}

async function recentFailureCount(admin: any, userId: string): Promise<number> {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { count } = await admin
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("action", "auth.passkey.failure")
    .gte("created_at", since);
  return count ?? 0;
}

/** Step 1: resolve the eligible account (without revealing existence) and issue a challenge. */
export const beginPasskeyAuthentication = createServerFn({ method: "POST" })
  .inputValidator((d: { identifier: string }) => ({
    identifier: String(d.identifier ?? "")
      .trim()
      .slice(0, 254),
  }))
  .handler(async ({ data }) => {
    if (!data.identifier) throw new Error(GENERIC_FAILURE);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const profile = await resolveProfile(supabaseAdmin, data.identifier);
    let targetUserId: string | null = null;
    let allowCredentials: { id: string; transports?: any }[] = [];

    if (profile && profile.status === "active") {
      const rateLimited = (await recentFailureCount(supabaseAdmin, profile.id)) >= 5;
      if (!rateLimited) {
        const { data: enrollment } = await (supabaseAdmin as any)
          .from("passkey_enrollments")
          .select("status,enrollment_allowed")
          .eq("user_id", profile.id)
          .eq("status", "approved")
          .eq("enrollment_allowed", true)
          .maybeSingle();
        if (enrollment) {
          const { data: creds } = await (supabaseAdmin as any)
            .from("webauthn_credentials")
            .select("credential_id,transports")
            .eq("user_id", profile.id)
            .is("revoked_at", null)
            .is("disabled_at", null);
          if (creds && creds.length > 0) {
            targetUserId = profile.id;
            allowCredentials = creds.map((c: any) => ({
              id: c.credential_id,
              transports: c.transports,
            }));
          }
        }
      }
    }
    if (allowCredentials.length === 0) {
      allowCredentials = [{ id: decoyCredentialId(data.identifier) }];
    }

    const options = await generateAuthenticationOptions({
      rpID: getRpId(),
      allowCredentials,
      userVerification: "preferred",
    });

    const result = await (supabaseAdmin as any).rpc("passkey_authentication_challenge_create", {
      _target_user_id: targetUserId,
      _property_id: null,
      _challenge_hash: sha256(options.challenge),
      _ttl_seconds: 90,
      _request_ip_hash: ipHash() ?? null,
      _request_user_agent: getRequest()?.headers.get("user-agent")?.slice(0, 200) ?? null,
    });
    if (result.error) throw new Error(GENERIC_FAILURE);

    return { options, challengeId: result.data as string };
  });

/** Step 2: verify the assertion and, on success, issue a real Supabase Auth session. */
export const completePasskeyAuthentication = createServerFn({ method: "POST" })
  .inputValidator((d: { challengeId: string; response: AuthenticationResponseJSON }) => d)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const clientDataJSON = data.response?.response?.clientDataJSON;
    if (!clientDataJSON) throw new Error(GENERIC_FAILURE);
    const challenge = extractChallenge(clientDataJSON);

    const { data: challengeRow } = await (supabaseAdmin as any)
      .from("webauthn_challenges")
      .select("id,user_id,challenge_hash,expires_at,used_at,invalidated,challenge_type")
      .eq("id", data.challengeId)
      .maybeSingle();
    if (
      !challengeRow ||
      challengeRow.challenge_type !== "authentication" ||
      challengeRow.used_at ||
      challengeRow.invalidated ||
      new Date(challengeRow.expires_at) < new Date() ||
      challengeRow.challenge_hash !== sha256(challenge) ||
      !challengeRow.user_id
    ) {
      throw new Error(GENERIC_FAILURE);
    }

    const { data: cred } = await (supabaseAdmin as any)
      .from("webauthn_credentials")
      .select("id,credential_id,public_key,sign_count,transports,user_id,property_id,device_name")
      .eq("credential_id", data.response.id)
      .eq("user_id", challengeRow.user_id)
      .is("revoked_at", null)
      .is("disabled_at", null)
      .maybeSingle();

    const fail = async () => {
      if (challengeRow.user_id) {
        await supabaseAdmin.from("audit_logs").insert({
          user_id: challengeRow.user_id,
          action: "auth.passkey.failure",
          entity: "webauthn_credentials",
        } as never);
      }
      throw new Error(GENERIC_FAILURE);
    };

    if (!cred) return fail();

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: data.response,
        expectedChallenge: challenge,
        expectedOrigin: getAllowedOrigins(),
        expectedRPID: getRpId(),
        credential: {
          id: cred.credential_id,
          publicKey: new Uint8Array(Buffer.from(cred.public_key, "base64")),
          counter: Number(cred.sign_count),
          transports: cred.transports ?? undefined,
        },
        requireUserVerification: false,
      });
    } catch {
      return fail();
    }
    if (!verification.verified) return fail();

    const result = await (supabaseAdmin as any).rpc("passkey_authentication_complete", {
      _challenge_id: data.challengeId,
      _challenge_hash: sha256(challenge),
      _credential_id: cred.credential_id,
      _new_sign_count: verification.authenticationInfo.newCounter,
    });
    if (result.error || !result.data?.[0]) return fail();

    const outcome = result.data[0];
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("must_change_password,account_type")
      .eq("id", outcome.out_user_id)
      .single();

    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(outcome.out_user_id);
    const email = authUser.user?.email;
    if (!email) return fail();

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error("Authentication is unavailable");

    const link = await supabaseAdmin.auth.admin.generateLink({ type: "magiclink", email });
    const tokenHash = (link.data as any)?.properties?.hashed_token;
    if (link.error || !tokenHash) throw new Error("Authentication is unavailable");

    const anon = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const verified = await anon.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
    if (verified.error || !verified.data.session) throw new Error("Authentication is unavailable");

    await supabaseAdmin.from("audit_logs").insert({
      user_id: outcome.out_user_id,
      action: "auth.login.success",
      entity: "profiles",
      entity_id: outcome.out_user_id,
      meta: { method: "passkey" },
    } as never);

    return {
      accessToken: verified.data.session.access_token,
      refreshToken: verified.data.session.refresh_token,
      mustChangePassword: !!(profile as any)?.must_change_password,
      accountType: (profile as any)?.account_type as LoginAccountType,
    };
  });
