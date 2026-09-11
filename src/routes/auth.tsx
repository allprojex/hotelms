import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { supabase } from "@/integrations/supabase/client";
import { identifierSignIn } from "@/lib/auth.functions";
import { getAuthenticationPolicy, recordMfaEvent } from "@/lib/security/mfa.functions";
import {
  beginPasskeyAuthentication,
  completePasskeyAuthentication,
} from "@/lib/security/passkey-authentication.functions";
import type { LoginAccountType } from "@/lib/auth-identity";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandMark } from "@/components/brand-mark";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { Building2, Eye, EyeOff, Fingerprint, LockKeyhole, Shield, Users } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/auth")({
  // Static SSR/pre-hydration fallback — the live tab title is overwritten
  // post-hydration by __root.tsx's BrandTitle with the configured
  // organisation app_name (see that file's comment for why this isn't
  // fully dynamic in Branding Phase 1). Kept brand-name-neutral here
  // rather than hardcoding a specific tenant name into the static meta.
  head: () => ({ meta: [{ title: "Staff & Admin Sign In" }] }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  // Organisation-wide branding only — the login page has no property
  // context (property selection is client-side, post-authentication;
  // see src/lib/property-store.ts), so per-property branding never
  // applies here.
  const { data: brand } = useBrandSettings();
  const signIn = useServerFn(identifierSignIn);
  const beginPasskey = useServerFn(beginPasskeyAuthentication);
  const completePasskey = useServerFn(completePasskeyAuthentication);
  const getPolicy = useServerFn(getAuthenticationPolicy);
  const auditMfa = useServerFn(recordMfaEvent);
  const [accountType, setAccountType] = useState<LoginAccountType>("staff");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [secureContext, setSecureContext] = useState(false);

  useEffect(() => {
    setPasskeySupported(browserSupportsWebAuthn());
    setSecureContext(window.isSecureContext);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) void routeAfterPrimaryAuthentication(false);
    });
    // Authentication routing is re-run explicitly after each successful sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  async function routeAfterPrimaryAuthentication(mustChangePassword: boolean) {
    if (mustChangePassword) {
      navigate({ to: "/change-password", replace: true });
      return;
    }
    const policy = await getPolicy();
    if (policy.next !== "complete") {
      await auditMfa({ data: { action: "auth.mfa.required" } }).catch(() => undefined);
      navigate({ to: "/mfa", replace: true });
      return;
    }
    navigate({ to: "/dashboard", replace: true });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await signIn({ data: { accountType, identifier, password } });
      const session = await supabase.auth.setSession({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
      });
      if (session.error) throw session.error;
      await routeAfterPrimaryAuthentication(result.mustChangePassword);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid ID or password");
    } finally {
      setLoading(false);
    }
  }

  async function signInWithPasskey() {
    if (!identifier.trim()) {
      toast.error("Enter your username, Staff ID or Admin ID first.");
      return;
    }
    setPasskeyLoading(true);
    try {
      const begin = await beginPasskey({ data: { identifier } });
      const assertion = await startAuthentication({ optionsJSON: begin.options });
      const result = await completePasskey({
        data: { challengeId: begin.challengeId, response: assertion },
      });
      const session = await supabase.auth.setSession({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
      });
      if (session.error) throw session.error;
      await routeAfterPrimaryAuthentication(result.mustChangePassword);
    } catch (error) {
      if (error instanceof Error && error.name === "NotAllowedError") {
        // User cancelled the device prompt — no need for an error toast.
      } else {
        toast.error("Passkey sign-in failed");
      }
    } finally {
      setPasskeyLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#f5f3ee] text-slate-950">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-70 [background-image:radial-gradient(circle_at_18%_12%,rgba(174,143,73,0.16),transparent_28%),radial-gradient(circle_at_86%_88%,rgba(15,45,42,0.1),transparent_30%)]"
      />
      <div className="relative grid min-h-screen lg:grid-cols-[minmax(22rem,0.88fr)_minmax(32rem,1.12fr)]">
        <aside className="relative hidden overflow-hidden bg-[#123b37] px-10 py-12 text-white lg:flex lg:flex-col lg:justify-between xl:px-16 xl:py-14">
          <div
            aria-hidden="true"
            className="absolute -right-28 -top-24 h-80 w-80 rounded-full border border-white/10"
          />
          <div
            aria-hidden="true"
            className="absolute -bottom-40 -left-24 h-[32rem] w-[32rem] rounded-full border border-[#d4b367]/20"
          />
          <div className="relative flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.24em] text-white/75">
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-white/15 bg-white/10">
              <Building2 className="h-5 w-5" aria-hidden="true" />
            </span>
            Hotel operations platform
          </div>
          <div className="relative max-w-lg pb-10">
            <p className="mb-5 text-sm font-semibold uppercase tracking-[0.3em] text-[#d8ba75]">
              Welcome back
            </p>
            <h2 className="text-4xl font-semibold leading-tight tracking-[-0.03em] xl:text-5xl">
              Exceptional stays begin with exceptional operations.
            </h2>
            <p className="mt-6 max-w-md text-base leading-7 text-white/70">
              A secure workspace for front office, reservations, finance, housekeeping and hotel
              leadership.
            </p>
          </div>
          <p className="relative text-xs tracking-wide text-white/45">
            Secure access · Authorised personnel only
          </p>
        </aside>

        <main className="flex min-h-screen items-center justify-center px-4 py-7 sm:px-8 sm:py-10 lg:px-12 xl:px-20">
          <div className="w-full max-w-[31rem]">
            <header className="mb-6 text-center sm:mb-8">
              <div className="mx-auto flex min-h-16 items-center justify-center">
                <BrandMark className="mx-auto h-12" />
              </div>
              <p className="mt-5 text-xs font-semibold uppercase tracking-[0.28em] text-[#9a762d]">
                Secure hotel access
              </p>
              <h1 className="mt-2 text-[1.7rem] font-semibold leading-tight tracking-[-0.025em] text-slate-950 sm:text-3xl">
                {brand?.app_name || "ThesKwoff Hotel"}
              </h1>
              <p className="mt-2 text-sm text-slate-600 sm:text-base">
                {brand?.tagline || "Hotel Management & Operations"}
              </p>
            </header>

            <section className="rounded-[1.5rem] border border-slate-200/90 bg-white p-5 shadow-[0_24px_70px_-34px_rgba(15,23,42,0.42)] sm:p-8">
              <div
                className="mb-7 grid grid-cols-2 rounded-xl bg-slate-100 p-1.5"
                role="tablist"
                aria-label="Account type"
              >
                <Tab
                  active={accountType === "staff"}
                  onClick={() => setAccountType("staff")}
                  icon={<Users className="h-4 w-4" />}
                  label="Staff & Operations"
                />
                <Tab
                  active={accountType === "admin"}
                  onClick={() => setAccountType("admin")}
                  icon={<Shield className="h-4 w-4" />}
                  label="Admin"
                />
              </div>
              <form className="space-y-5" onSubmit={submit}>
                <div className="space-y-2">
                  <Label htmlFor="identifier" className="text-sm font-medium text-slate-800">
                    {accountType === "staff" ? "Staff ID / Username" : "Admin ID / Email"}
                  </Label>
                  <Input
                    id="identifier"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder={
                      accountType === "staff"
                        ? "Enter Staff ID or Username"
                        : "Enter Admin ID or Email"
                    }
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    autoComplete="username"
                    className="h-12 rounded-xl border-slate-300 bg-white px-4 text-base shadow-sm transition-shadow focus-visible:border-[#1b504a] focus-visible:ring-[#1b504a]/20"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-sm font-medium text-slate-800">
                    Password
                  </Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={show ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyUp={(e) => setCapsLock(e.getModifierState("CapsLock"))}
                      onKeyDown={(e) => setCapsLock(e.getModifierState("CapsLock"))}
                      autoComplete="current-password"
                      className="h-12 rounded-xl border-slate-300 bg-white px-4 pr-12 text-base shadow-sm transition-shadow focus-visible:border-[#1b504a] focus-visible:ring-[#1b504a]/20"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShow(!show)}
                      aria-label={show ? "Hide password" : "Show password"}
                      aria-pressed={show}
                      className="absolute inset-y-0 right-0 flex min-w-12 items-center justify-center rounded-r-xl text-slate-500 transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1b504a] focus-visible:ring-offset-1"
                    >
                      {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {capsLock && (
                    <p role="status" className="text-xs text-amber-600">
                      Caps Lock is on
                    </p>
                  )}
                </div>
                <Button
                  className="h-12 w-full rounded-xl bg-[#174a45] text-sm font-semibold tracking-wide text-white shadow-[0_10px_24px_-12px_rgba(23,74,69,0.9)] hover:bg-[#103d38]"
                  size="lg"
                  disabled={loading}
                >
                  {loading ? "Signing in…" : accountType === "admin" ? "Admin Sign In" : "Sign In"}
                </Button>
              </form>

              {secureContext && passkeySupported ? (
                <>
                  <div className="my-5 flex items-center gap-3 text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-slate-400">
                    <div className="h-px flex-1 bg-slate-200" />
                    OR
                    <div className="h-px flex-1 bg-slate-200" />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-12 w-full gap-2 rounded-xl border-slate-300 bg-white text-sm font-semibold text-slate-800 hover:border-[#1b504a] hover:bg-[#f3f7f6]"
                    disabled={passkeyLoading}
                    onClick={signInWithPasskey}
                  >
                    <Fingerprint className="h-5 w-5 text-[#1b504a]" />
                    {passkeyLoading ? "Follow your device's prompt…" : "Sign in with a passkey"}
                  </Button>
                  <p className="mt-2.5 text-center text-[0.7rem] leading-relaxed text-slate-500">
                    Supported devices can use fingerprint, face recognition, Windows Hello, Touch ID
                    or your device PIN — handled by your operating system, not this app.
                  </p>
                </>
              ) : (
                <p className="mt-4 text-center text-xs text-muted-foreground">
                  {secureContext
                    ? "Passkey sign-in isn't supported in this browser. Use your password instead."
                    : "Passkey sign-in requires a secure (HTTPS) connection."}
                </p>
              )}

              <button
                type="button"
                onClick={() =>
                  toast.info("Contact your system administrator to reset your password.")
                }
                className="mx-auto mt-5 block min-h-11 px-3 text-sm font-medium text-[#174a45] underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1b504a]"
              >
                Forgot Password?
              </button>

              <div className="mt-5 rounded-xl border border-[#d9c99e]/70 bg-[#fbf8ef] px-4 py-3.5">
                <p className="flex items-start gap-2.5 text-xs leading-5 text-slate-600">
                  <LockKeyhole
                    className="mt-0.5 h-4 w-4 shrink-0 text-[#9a762d]"
                    aria-hidden="true"
                  />
                  <span>
                    Privileged accounts may require an authenticator code after sign-in.{" "}
                    {"Password sign-in is always available."}
                  </span>
                </p>
              </div>
            </section>
            <p className="mt-5 text-center text-xs leading-5 text-slate-500">
              Accounts are created by an authorised administrator.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}

function Tab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-center text-xs font-semibold leading-tight transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1b504a] focus-visible:ring-offset-2 sm:text-sm",
        active
          ? "bg-white text-[#174a45] shadow-sm ring-1 ring-black/[0.04]"
          : "text-slate-500 hover:bg-white/60 hover:text-slate-900",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
