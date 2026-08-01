/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 5 tables await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { createHash } from "node:crypto";
import { getRequest } from "@tanstack/react-start/server";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";
import { getAllowedOrigins, getRpId, getRpName } from "@/lib/security/webauthn-config.server";

const uuid = (value: unknown): string => {
  const v = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v)) throw new Error("Valid identifier required");
  return v;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function extractChallenge(clientDataJSON: string): string {
  const json = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8"));
  if (typeof json.challenge !== "string") throw new Error("Invalid response");
  return json.challenge;
}

function requestIpHash(): string | undefined {
  const request = getRequest();
  const ip =
    request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request?.headers.get("x-real-ip") ||
    undefined;
  if (!ip) return undefined;
  return sha256(ip).slice(0, 32);
}

/** Registration ceremony begin: server confirms approval, then issues a single-use challenge. */
export const beginPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string }) => ({ propertyId: uuid(d.propertyId) }))
  .handler(async ({ data, context }) => {
    const { data: profile, error: profileError } = await (context.supabase as any)
      .from("profiles")
      .select("identifier,full_name")
      .eq("id", context.userId)
      .single();
    if (profileError || !profile) throw new Error("Account not found");

    const { data: existing } = await (context.supabase as any)
      .from("webauthn_credentials")
      .select("credential_id,transports")
      .eq("property_id", data.propertyId)
      .eq("user_id", context.userId)
      .is("revoked_at", null);

    const options = await generateRegistrationOptions({
      rpName: getRpName(),
      rpID: getRpId(),
      userName: profile.identifier,
      userDisplayName: profile.full_name || profile.identifier,
      attestationType: "none",
      excludeCredentials: (existing ?? []).map((c: any) => ({
        id: c.credential_id,
        transports: c.transports,
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

    const result = await (context.supabase as any).rpc("passkey_registration_challenge_create", {
      _property_id: data.propertyId,
      _challenge_hash: sha256(options.challenge),
      _ttl_seconds: 120,
      _request_ip_hash: requestIpHash() ?? null,
      _request_user_agent: getRequest()?.headers.get("user-agent")?.slice(0, 200) ?? null,
    });
    if (result.error) throw new Error(result.error.message);

    return { options, challengeId: result.data as string };
  });

/** Registration ceremony complete: verifies the attestation, then persists credential metadata. */
export const completePasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      challengeId: string;
      deviceName: string;
      response: RegistrationResponseJSON;
    }) => ({
      propertyId: uuid(d.propertyId),
      challengeId: uuid(d.challengeId),
      deviceName:
        String(d.deviceName ?? "Passkey")
          .trim()
          .slice(0, 80) || "Passkey",
      response: d.response,
    }),
  )
  .handler(async ({ data, context }) => {
    const clientDataJSON = data.response?.response?.clientDataJSON;
    if (!clientDataJSON) throw new Error("Invalid registration response");
    const challenge = extractChallenge(clientDataJSON);

    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response: data.response,
        expectedChallenge: challenge,
        expectedOrigin: getAllowedOrigins(),
        expectedRPID: getRpId(),
        requireUserVerification: false,
      });
    } catch {
      throw new Error("Passkey registration could not be verified");
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("Passkey registration could not be verified");
    }

    const info = verification.registrationInfo;
    const result = await (context.supabase as any).rpc("passkey_registration_complete", {
      _challenge_id: data.challengeId,
      _challenge_hash: sha256(challenge),
      _credential_id: info.credential.id,
      _public_key: Buffer.from(info.credential.publicKey).toString("base64"),
      _sign_count: info.credential.counter,
      _transports: data.response.response.transports ?? [],
      _attachment: data.response.authenticatorAttachment ?? null,
      _credential_type: data.response.type ?? "public-key",
      _backup_eligible: info.credentialDeviceType === "multiDevice",
      _backup_state: info.credentialBackedUp ?? false,
      _aaguid: info.aaguid ?? null,
      _device_name: data.deviceName,
      _user_verified: info.userVerified ?? true,
    });
    if (result.error) throw new Error(result.error.message);

    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "passkeys",
      action: "passkey.credential.registered",
      resourceType: "webauthn_credential",
      resourceId: result.data?.id ?? null,
    });

    return { id: result.data?.id, deviceName: result.data?.device_name };
  });
