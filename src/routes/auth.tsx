import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { BrandMark } from "@/components/brand-mark";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { isCurrentlyLocked, logFailedLogin, checkAndLockout } from "@/lib/security/threat-monitor.functions";

export const Route = createFileRoute("/auth")({
  head: () => ({ meta: [{ title: "Sign in — Infinity Techub PMS" }] }),
  component: AuthPage,
});

function scorePassword(pw: string): number {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  if (pw.length >= 12) s = Math.min(4, s + 1);
  return Math.min(4, s);
}
const STRENGTH_META = [
  { label: "Too short", color: "bg-muted" },
  { label: "Weak", color: "bg-destructive" },
  { label: "Fair", color: "bg-amber-500" },
  { label: "Good", color: "bg-primary" },
  { label: "Strong", color: "bg-emerald-500" },
];

function AuthPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard", replace: true });
    });
  }, [navigate]);

  const score = useMemo(() => scorePassword(password), [password]);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      // Brute-force gate: refuse before hitting Supabase Auth
      const lockCheck = await isCurrentlyLocked({ data: { email } }).catch(() => ({ locked: false } as any));
      if (lockCheck?.locked) {
        const until = new Date(lockCheck.until).toLocaleTimeString();
        throw new Error(`This account is temporarily locked (until ${until}) due to too many failed attempts.`);
      }
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        // Record failure + evaluate lockout threshold
        await logFailedLogin({ data: { email, userAgent: navigator.userAgent } }).catch(() => {});
        await checkAndLockout({ data: { email } }).catch(() => {});
        throw error;
      }
      navigate({ to: "/dashboard", replace: true });
    } catch (e: any) {
      toast.error(e.message ?? "Sign in failed");
    } finally { setLoading(false); }
  }


  async function handleGoogle() {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/dashboard` },
    });
    if (error) {
      toast.error(error.message ?? "Google sign-in failed");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10" style={{ background: "var(--gradient-surface)" }}>
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <BrandMark className="h-12" />
          <h1 className="mt-4 text-2xl font-semibold">Infinity Techub PMS</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to your hospitality workspace</p>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-[var(--shadow-elegant)]">
          <form className="space-y-3" onSubmit={handleSignIn}>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                >
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {password.length > 0 && <StrengthMeter score={score} />}
            </div>
            <Button type="submit" className="w-full" disabled={loading}>Sign in</Button>
          </form>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center"><div className="w-full border-t" /></div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">or</span>
            </div>
          </div>

          <Button type="button" variant="outline" className="w-full" onClick={handleGoogle} disabled={loading}>
            <GoogleIcon /> Continue with Google
          </Button>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            <Link to="/reset-password" className="hover:text-primary">Forgot your password?</Link>
          </p>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Accounts are created by invitation from an administrator.
        </p>
      </div>
    </div>
  );
}

function StrengthMeter({ score }: { score: number }) {
  const meta = STRENGTH_META[score];
  return (
    <div className="pt-1">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={cn("h-1 flex-1 rounded-full transition-colors", i <= score ? meta.color : "bg-muted")}
          />
        ))}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Password strength: <span className="font-medium text-foreground">{meta.label}</span></p>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="mr-2 h-4 w-4">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z"/>
    </svg>
  );
}
