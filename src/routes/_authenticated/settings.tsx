import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useTheme } from "@/components/theme-provider";
import { toast } from "sonner";
import { useUserRoles } from "@/hooks/use-user-roles";
import { refreshFxRates, updateSystemSettings } from "@/lib/fx.functions";
import { Coins, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Settings — ThesKwoff Hotel" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const { theme, setTheme } = useTheme();
  const user = useQuery({ queryKey: ["me"], queryFn: async () => (await supabase.auth.getUser()).data.user });
  const profile = useQuery({
    queryKey: ["profile", user.data?.id], enabled: !!user.data?.id,
    queryFn: async () => (await supabase.from("profiles").select("*").eq("id", user.data!.id).single()).data,
  });
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  useEffect(() => { if (profile.data) { setFullName(profile.data.full_name ?? ""); setPhone(profile.data.phone ?? ""); } }, [profile.data]);

  async function save() {
    const { error } = await supabase.from("profiles").update({ full_name: fullName, phone }).eq("id", user.data!.id);
    if (error) return toast.error(error.message);
    toast.success("Profile saved"); qc.invalidateQueries({ queryKey: ["profile"] });
  }

  const rolesQ = useUserRoles();
  const isSuperAdmin = (rolesQ.data ?? []).some((r) => r.role === "super_admin");

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 md:p-6">
      <div><h1 className="text-2xl font-display font-semibold">Settings</h1><p className="text-sm text-muted-foreground">Your profile and preferences.</p></div>

      <Card>
        <CardHeader><CardTitle className="text-base">Profile</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div><Label>Email</Label><Input value={user.data?.email ?? ""} disabled /></div>
          <div><Label>Full name</Label><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
          <div><Label>Phone</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <Button onClick={save}>Save profile</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Appearance</CardTitle></CardHeader>
        <CardContent className="flex items-center gap-3">
          <Button variant={theme === "light" ? "default" : "outline"} onClick={() => setTheme("light")}>Light</Button>
          <Button variant={theme === "dark" ? "default" : "outline"} onClick={() => setTheme("dark")}>Dark</Button>
        </CardContent>
      </Card>

      {isSuperAdmin && <CurrencyPanel />}

      <Card>
        <CardHeader><CardTitle className="text-base">Security</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>· Passwords are checked against known-breached databases (HIBP).</p>
          <p>· You're automatically signed out after 30 minutes of inactivity.</p>
          <p>· All role changes and folio actions are recorded to the audit log.</p>
          <Button variant="outline" size="sm" asChild className="mt-1">
            <Link to="/security/passkeys">Manage passkeys</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function CurrencyPanel() {
  const qc = useQueryClient();
  const refresh = useServerFn(refreshFxRates);
  const update = useServerFn(updateSystemSettings);

  const settingsQ = useQuery({
    queryKey: ["system_settings"],
    queryFn: async () => {
      const { data, error } = await (supabase.from("system_settings" as any) as any)
        .select("*").eq("id", true).maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });
  const currenciesQ = useQuery({
    queryKey: ["currencies-all"],
    queryFn: async () => (await supabase.from("currencies").select("code,name").order("code")).data ?? [],
  });

  const [defaultCurrency, setDefaultCurrency] = useState<string>("GHS");
  const [interval, setInterval] = useState<number>(60);
  useEffect(() => {
    if (settingsQ.data) {
      setDefaultCurrency(settingsQ.data.default_currency ?? "GHS");
      setInterval(Number(settingsQ.data.fx_refresh_interval_minutes ?? 60));
    }
  }, [settingsQ.data]);

  const saveMut = useMutation({
    mutationFn: async () => {
      await update({ data: { default_currency: defaultCurrency, fx_refresh_interval_minutes: interval } });
    },
    onSuccess: () => { toast.success("Currency settings saved"); qc.invalidateQueries({ queryKey: ["system_settings"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const refreshMut = useMutation({
    mutationFn: async () => await refresh({}),
    onSuccess: (r: any) => {
      if (r?.ok) toast.success(`Refreshed ${r.count} rates (base ${r.base})`);
      else toast.error(r?.error ?? "Refresh failed");
      qc.invalidateQueries({ queryKey: ["system_settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const s = settingsQ.data;
  const lastAt = s?.fx_last_synced_at ? new Date(s.fx_last_synced_at) : null;
  const ok = s?.fx_last_status === "ok";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2"><Coins className="h-4 w-4" />Currency &amp; FX</CardTitle>
        <Badge variant={ok ? "default" : s?.fx_last_status === "failed" ? "destructive" : "outline"} className="gap-1">
          {ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
          {s?.fx_last_status ?? "never synced"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Default currency</Label>
            <Select value={defaultCurrency} onValueChange={setDefaultCurrency}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(currenciesQ.data ?? []).map((c: any) => (
                  <SelectItem key={c.code} value={c.code}>{c.code} — {c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Refresh interval (min)</Label>
            <Input type="number" min={5} step={5} value={interval} onChange={(e) => setInterval(Number(e.target.value))} />
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          Provider: <span className="font-mono">{s?.fx_provider ?? "exchangerate.host"}</span>
          {lastAt && <> · Last sync {formatDistanceToNow(lastAt, { addSuffix: true })}</>}
          {s?.fx_last_error && <div className="text-destructive mt-1">Last error: {s.fx_last_error}</div>}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>Save</Button>
          <Button variant="outline" onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${refreshMut.isPending ? "animate-spin" : ""}`} />
            Refresh now
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Only super administrators can change the default currency or configure FX synchronization.
          Rates are fetched from the configured provider and stored in <span className="font-mono">fx_rates</span>.
        </p>
      </CardContent>
    </Card>
  );
}
