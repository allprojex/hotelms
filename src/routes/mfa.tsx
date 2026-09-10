import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import {
  confirmAal2Access,
  getAuthenticationPolicy,
  recordMfaEvent,
  recordLogout,
} from "@/lib/security/mfa.functions";

export const Route = createFileRoute("/mfa")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
  },
  component: MfaPage,
});

function MfaPage() {
  const navigate = useNavigate();
  const getPolicy = useServerFn(getAuthenticationPolicy);
  const confirmAccess = useServerFn(confirmAal2Access);
  const recordEvent = useServerFn(recordMfaEvent);
  const auditLogout = useServerFn(recordLogout);
  const [mode, setMode] = useState<"loading" | "enroll" | "challenge">("loading");
  const [factorId, setFactorId] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);

  useEffect(() => {
    void initialise();
    // Run once for this authentication step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function initialise() {
    try {
      const policy = await getPolicy();
      if (!policy.required || policy.next === "complete") {
        navigate({ to: "/dashboard", replace: true });
        return;
      }
      if (policy.next === "challenge") {
        const factors = await supabase.auth.mfa.listFactors();
        const verified = factors.data?.totp.find((factor) => factor.status === "verified");
        if (factors.error || !verified) throw new Error("Authenticator factor unavailable");
        setFactorId(verified.id);
        setMode("challenge");
        return;
      }
      const factors = await supabase.auth.mfa.listFactors();
      if (factors.error) throw factors.error;
      for (const pending of factors.data.all.filter(
        (factor) => factor.factor_type === "totp" && factor.status === "unverified",
      )) {
        const removed = await supabase.auth.mfa.unenroll({ factorId: pending.id });
        if (removed.error) throw removed.error;
      }
      const enrolled = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "Infinity Hotel Authenticator",
      });
      if (enrolled.error) throw enrolled.error;
      setFactorId(enrolled.data.id);
      setQrCode(enrolled.data.totp.qr_code);
      setSecret(enrolled.data.totp.secret);
      setMode("enroll");
    } catch {
      toast.error("Multi-factor authentication is unavailable. Please sign in again.");
      await supabase.auth.signOut();
      navigate({ to: "/auth", replace: true });
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      toast.error("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    try {
      const result = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
      if (result.error) throw result.error;
      await supabase.auth.refreshSession();
      await confirmAccess();
      await recordEvent({
        data: {
          action: mode === "enroll" ? "auth.mfa.enrolled" : "auth.mfa.challenge.success",
        },
      });
      navigate({ to: "/dashboard", replace: true });
    } catch {
      await recordEvent({ data: { action: "auth.mfa.challenge.failure" } }).catch(() => undefined);
      const nextFailedAttempts = failedAttempts + 1;
      setFailedAttempts(nextFailedAttempts);
      setCode("");
      if (nextFailedAttempts >= 5) {
        toast.error("Too many unsuccessful attempts. Please sign in again.");
        await supabase.auth.signOut();
        navigate({ to: "/auth", replace: true });
      } else {
        toast.error("The authenticator code could not be verified.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await auditLogout().catch(() => undefined);
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-8"
      style={{ background: "var(--gradient-surface)" }}
    >
      <main className="w-full max-w-md">
        <BrandMark className="mx-auto mb-6 h-12" />
        <section className="rounded-2xl border bg-card p-6 shadow-[var(--shadow-elegant)]">
          <div className="mb-5 flex items-center gap-3">
            <ShieldCheck className="h-7 w-7 text-primary" />
            <div>
              <h1 className="text-xl font-semibold">Secure your account</h1>
              <p className="text-sm text-muted-foreground">Required for privileged hotel access</p>
            </div>
          </div>
          {mode === "loading" ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Checking security settings…
            </p>
          ) : (
            <form className="space-y-4" onSubmit={verify}>
              {mode === "enroll" ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Scan this QR code with Microsoft Authenticator, Google Authenticator, Authy, or
                    another standards-compatible TOTP app.
                  </p>
                  <img
                    src={qrCode}
                    alt="Authenticator enrollment QR code"
                    className="mx-auto h-52 w-52 rounded-lg border bg-white p-2"
                  />
                  <details className="text-xs text-muted-foreground">
                    <summary>Cannot scan the QR code?</summary>
                    <p className="mt-2 break-all font-mono" aria-label="Manual authenticator key">
                      {secret}
                    </p>
                  </details>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Enter the current code from your authenticator app.
                </p>
              )}
              <div className="space-y-2">
                <Label htmlFor="totp-code">6-digit authenticator code</Label>
                <Input
                  id="totp-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  className="text-center text-xl tracking-[0.4em]"
                  autoFocus
                  required
                />
              </div>
              <Button className="w-full" size="lg" disabled={busy}>
                {busy ? "Verifying…" : "Verify and continue"}
              </Button>
              <Button type="button" variant="ghost" className="w-full" onClick={signOut}>
                Sign out
              </Button>
            </form>
          )}
        </section>
      </main>
    </div>
  );
}
