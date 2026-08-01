// Server-only WebAuthn Relying Party configuration.
// RP ID and allowed origins are derived from SITE_URL (the same env var used for auth
// redirect links) unless explicitly overridden — never hard-coded, per Phase 5 policy.

function siteUrlOrigin(): URL | null {
  const raw = process.env.SITE_URL;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function getRpId(): string {
  const override = process.env.WEBAUTHN_RP_ID;
  if (override) return override;
  const site = siteUrlOrigin();
  if (site) return site.hostname;
  return "localhost";
}

export function getRpName(): string {
  return process.env.WEBAUTHN_RP_NAME || "ThesKwoff Hotel PMS";
}

export function getAllowedOrigins(): string[] {
  const override = process.env.WEBAUTHN_ORIGINS;
  if (override) {
    return override
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  }
  const site = siteUrlOrigin();
  if (site) return [site.origin];
  return ["http://localhost:3000", "http://localhost:5173"];
}

export function assertAllowedOrigin(origin: string): void {
  const allowed = getAllowedOrigins();
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!allowed.includes(origin) && !isLocalhost) {
    throw new Error("Unrecognized sign-in origin");
  }
  if (!origin.startsWith("https://") && !isLocalhost) {
    throw new Error("Passkeys require a secure (HTTPS) connection");
  }
}
