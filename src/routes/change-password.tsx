import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { changeOwnPassword } from "@/lib/auth.functions";
import { validatePassword } from "@/lib/auth-identity";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/change-password")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
  },
  head: () => ({ meta: [{ title: pageTitle("Change Password", "—") }] }),
  component: ChangePasswordPage,
});

function ChangePasswordPage() {
  const change = useServerFn(changeOwnPassword);
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [caps, setCaps] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      validatePassword(password);
      if (password !== confirmation) throw new Error("Passwords do not match.");
      const result = await change({ data: { password, confirmation } });
      const session = await supabase.auth.setSession({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
      });
      if (session.error) throw session.error;
      toast.success("Password changed");
      navigate({ to: "/mfa", replace: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Password change failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-8"
      style={{ background: "var(--gradient-surface)" }}
    >
      <main className="w-full max-w-md">
        <BrandMark className="mx-auto mb-6 h-12" />
        <section className="rounded-2xl border bg-card p-6 shadow-[var(--shadow-elegant)]">
          <h1 className="text-2xl font-semibold">Change your password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            You must set a private password before opening the hotel workspace.
          </p>
          <form onSubmit={submit} className="mt-6 space-y-4">
            <PasswordField
              id="new-password"
              label="New password"
              value={password}
              setValue={setPassword}
              show={show}
              setShow={setShow}
              onCaps={setCaps}
            />
            <div>
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input
                id="confirm-password"
                className="mt-2"
                type={show ? "text" : "password"}
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
            {caps && <p className="text-xs text-amber-600">Caps Lock is on</p>}
            <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              At least 10 characters with uppercase, lowercase, a number and a symbol. Passwords are
              case-sensitive.
            </div>
            <Button className="w-full" size="lg" disabled={busy}>
              {busy ? "Updating…" : "Change password"}
            </Button>
          </form>
        </section>
      </main>
    </div>
  );
}
function PasswordField({
  id,
  label,
  value,
  setValue,
  show,
  setShow,
  onCaps,
}: {
  id: string;
  label: string;
  value: string;
  setValue: (v: string) => void;
  show: boolean;
  setShow: (v: boolean) => void;
  onCaps: (v: boolean) => void;
}) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative mt-2">
        <Input
          id={id}
          className="pr-11"
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => onCaps(e.getModifierState("CapsLock"))}
          autoComplete="new-password"
          required
        />
        <button
          type="button"
          aria-label={show ? "Hide password" : "Show password"}
          onClick={() => setShow(!show)}
          className="absolute inset-y-0 right-0 px-3 text-muted-foreground"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
