import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listRecentSecurityEvents, listLockouts, listFailedLogins,
  releaseLockout, resolveEvent,
  getSecuritySettings, saveSecuritySettings,
} from "@/lib/security/threat-monitor.functions";
import { useActiveProperty } from "@/hooks/use-active-property";
import { useHasAnyRole } from "@/hooks/use-user-roles";
import { ADMIN_ROLES } from "@/lib/admin/permissions";
import { AccessDenied } from "@/components/access-denied";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ShieldAlert, ShieldCheck, Lock, Activity, Settings2, KeyRound, AlertTriangle, FileText, ScanLine } from "lucide-react";
import { ComplianceLogTab } from "@/components/security/compliance-log-tab";
import { FileFirewallTab } from "@/components/security/file-firewall-tab";
import { format } from "date-fns";
import { toast } from "sonner";
import { ChildRouteOr } from "@/components/child-route-or";

export const Route = createFileRoute("/_authenticated/admin_/security")({
  head: () => ({
    meta: [
      { title: pageTitle("Security Center") },
      { name: "description", content: "Threat monitoring, brute-force protection, session policies, and compliance controls." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <ChildRouteOr>
      <SecurityCenterPage />
    </ChildRouteOr>
  ),
});

function SecurityCenterPage() {
  const propertyId = useActiveProperty();
  const gate = useHasAnyRole(ADMIN_ROLES, propertyId);
  const [tab, setTab] = useState("overview");

  if (gate.loading) return <div className="p-6 text-muted-foreground">Checking access…</div>;
  if (!gate.allowed) return <AccessDenied message="Only admins can view the Security Center." />;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <header className="flex items-center gap-3">
        <ShieldAlert className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-display font-semibold">Security Center</h1>
          <p className="text-xs text-muted-foreground">
            Threat feed, brute-force lockouts, session policies, and compliance controls.
          </p>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="overview" className="gap-1.5"><Activity className="h-3.5 w-3.5" />Overview</TabsTrigger>
          <TabsTrigger value="firewall" className="gap-1.5"><ScanLine className="h-3.5 w-3.5" />File firewall</TabsTrigger>
          <TabsTrigger value="threats" className="gap-1.5"><ShieldAlert className="h-3.5 w-3.5" />Threat feed</TabsTrigger>
          <TabsTrigger value="lockouts" className="gap-1.5"><Lock className="h-3.5 w-3.5" />Lockouts</TabsTrigger>
          <TabsTrigger value="failed" className="gap-1.5"><KeyRound className="h-3.5 w-3.5" />Failed logins</TabsTrigger>
          <TabsTrigger value="compliance" className="gap-1.5"><FileText className="h-3.5 w-3.5" />Compliance log</TabsTrigger>
          <TabsTrigger value="policy" className="gap-1.5"><Settings2 className="h-3.5 w-3.5" />Policy</TabsTrigger>
        </TabsList>

        <TabsContent value="overview"><Overview /></TabsContent>
        <TabsContent value="firewall"><FileFirewallTab /></TabsContent>
        <TabsContent value="threats"><ThreatFeed /></TabsContent>
        <TabsContent value="lockouts"><Lockouts /></TabsContent>
        <TabsContent value="failed"><FailedLogins /></TabsContent>
        <TabsContent value="compliance"><ComplianceLogTab /></TabsContent>
        <TabsContent value="policy"><PolicyForm propertyId={propertyId} /></TabsContent>
      </Tabs>
    </div>
  );
}

function Overview() {
  const eventsFn = useServerFn(listRecentSecurityEvents);
  const lockFn = useServerFn(listLockouts);
  const failFn = useServerFn(listFailedLogins);
  const events = useQuery({ queryKey: ["sec-events"], queryFn: () => eventsFn() });
  const lockouts = useQuery({ queryKey: ["sec-lockouts"], queryFn: () => lockFn() });
  const failed = useQuery({ queryKey: ["sec-failed"], queryFn: () => failFn() });

  const critical = (events.data ?? []).filter((e) => e.severity === "critical" && !e.resolved_at).length;
  const active = (lockouts.data ?? []).filter((l) => !l.released_at && new Date(l.locked_until) > new Date()).length;
  const failed24 = (failed.data ?? []).filter(
    (f) => new Date(f.attempted_at) > new Date(Date.now() - 86400000),
  ).length;

  return (
    <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
      <StatCard label="Open critical events" value={critical} icon={AlertTriangle} tone={critical > 0 ? "danger" : "ok"} />
      <StatCard label="Active lockouts" value={active} icon={Lock} tone={active > 0 ? "warn" : "ok"} />
      <StatCard label="Failed logins (24h)" value={failed24} icon={KeyRound} tone={failed24 > 20 ? "warn" : "ok"} />
      <StatCard label="MFA policy" value="Optional" icon={ShieldCheck} tone="ok" hint="See Policy tab" />
    </div>
  );
}

function StatCard({ label, value, icon: Icon, tone, hint }: {
  label: string; value: number | string; icon: any; tone: "ok" | "warn" | "danger"; hint?: string;
}) {
  const toneClass = tone === "danger" ? "text-destructive" : tone === "warn" ? "text-amber-500" : "text-emerald-500";
  return (
    <Card>
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className={`h-4 w-4 ${toneClass}`} />{label}
        </div>
        <div className={`text-3xl font-semibold ${toneClass}`}>{value}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function ThreatFeed() {
  const qc = useQueryClient();
  const listFn = useServerFn(listRecentSecurityEvents);
  const resolveFn = useServerFn(resolveEvent);
  const list = useQuery({ queryKey: ["sec-events"], queryFn: () => listFn() });
  const resolveMut = useMutation({
    mutationFn: (id: string) => resolveFn({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sec-events"] }); toast.success("Event resolved."); },
    onError: (e: any) => toast.error(e.message ?? "Failed to resolve."),
  });

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Recent security events</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead><TableHead>Type</TableHead><TableHead>Severity</TableHead>
              <TableHead>IP</TableHead><TableHead>Status</TableHead><TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(list.data ?? []).map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-xs whitespace-nowrap">{format(new Date(e.created_at), "MMM d, HH:mm")}</TableCell>
                <TableCell className="text-xs">{e.event_type}</TableCell>
                <TableCell><SeverityBadge severity={e.severity} /></TableCell>
                <TableCell className="text-xs">{e.ip ?? "—"}</TableCell>
                <TableCell>{e.resolved_at
                  ? <Badge variant="secondary">Resolved</Badge>
                  : <Badge variant="destructive">Open</Badge>}
                </TableCell>
                <TableCell className="text-right">
                  {!e.resolved_at && (
                    <Button size="sm" variant="outline" onClick={() => resolveMut.mutate(e.id)}>
                      Resolve
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {(list.data ?? []).length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                No security events recorded — that's a good thing.
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    critical: "bg-red-500/15 text-red-500 border-red-500/30",
    high: "bg-orange-500/15 text-orange-500 border-orange-500/30",
    medium: "bg-amber-500/15 text-amber-500 border-amber-500/30",
    low: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  };
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] uppercase ${map[severity] ?? map.low}`}>{severity}</span>;
}

function Lockouts() {
  const qc = useQueryClient();
  const listFn = useServerFn(listLockouts);
  const releaseFn = useServerFn(releaseLockout);
  const list = useQuery({ queryKey: ["sec-lockouts"], queryFn: () => listFn() });
  const releaseMut = useMutation({
    mutationFn: (id: string) => releaseFn({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sec-lockouts"] }); toast.success("Account released."); },
    onError: (e: any) => toast.error(e.message ?? "Failed to release."),
  });
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Account lockouts</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead><TableHead>Reason</TableHead>
              <TableHead>Locked until</TableHead><TableHead>Status</TableHead><TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(list.data ?? []).map((l) => {
              const active = !l.released_at && new Date(l.locked_until) > new Date();
              return (
                <TableRow key={l.id}>
                  <TableCell className="text-xs">{l.email ?? l.user_id?.slice(0, 8) ?? "—"}</TableCell>
                  <TableCell className="text-xs">{l.reason}</TableCell>
                  <TableCell className="text-xs">{format(new Date(l.locked_until), "MMM d, HH:mm")}</TableCell>
                  <TableCell>{active ? <Badge variant="destructive">Locked</Badge> : <Badge variant="secondary">Released</Badge>}</TableCell>
                  <TableCell className="text-right">
                    {active && <Button size="sm" variant="outline" onClick={() => releaseMut.mutate(l.id)}>Release</Button>}
                  </TableCell>
                </TableRow>
              );
            })}
            {(list.data ?? []).length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                No lockouts on record.
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function FailedLogins() {
  const listFn = useServerFn(listFailedLogins);
  const list = useQuery({ queryKey: ["sec-failed"], queryFn: () => listFn() });
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Failed sign-in attempts (last 200)</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow>
            <TableHead>When</TableHead><TableHead>Email</TableHead><TableHead>IP</TableHead><TableHead>User agent</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(list.data ?? []).map((f) => (
              <TableRow key={f.id}>
                <TableCell className="text-xs whitespace-nowrap">{format(new Date(f.attempted_at), "MMM d, HH:mm:ss")}</TableCell>
                <TableCell className="text-xs">{f.email}</TableCell>
                <TableCell className="text-xs">{f.ip ?? "—"}</TableCell>
                <TableCell className="text-xs truncate max-w-[400px]">{f.user_agent ?? "—"}</TableCell>
              </TableRow>
            ))}
            {(list.data ?? []).length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                No failed sign-ins in the log.
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function PolicyForm({ propertyId }: { propertyId: string | null }) {
  const getFn = useServerFn(getSecuritySettings);
  const saveFn = useServerFn(saveSecuritySettings);
  const q = useQuery({ queryKey: ["sec-settings"], queryFn: () => getFn(), enabled: !!propertyId });
  const [maxAttempts, setMaxAttempts] = useState<number>(5);
  const [lockoutMin, setLockoutMin] = useState<number>(30);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [sessionHours, setSessionHours] = useState(24);
  const [concurrent, setConcurrent] = useState(true);
  const [notify, setNotify] = useState(true);

  // Hydrate once when settings arrive
  const settings = q.data;
  if (settings && maxAttempts !== settings.max_failed_attempts) {
    // one-time init
    setMaxAttempts(settings.max_failed_attempts);
    setLockoutMin(settings.lockout_duration_minutes);
    setMfaRequired(!!settings.mfa_required);
    setSessionHours(settings.session_max_age_hours);
    setConcurrent(!!settings.allow_concurrent_sessions);
    setNotify(!!settings.notify_on_critical);
  }

  const saveMut = useMutation({
    mutationFn: () => saveFn({ data: {
      propertyId: propertyId!,
      max_failed_attempts: maxAttempts,
      lockout_duration_minutes: lockoutMin,
      mfa_required: mfaRequired,
      session_max_age_hours: sessionHours,
      allow_concurrent_sessions: concurrent,
      notify_on_critical: notify,
    }}),
    onSuccess: () => toast.success("Security policy saved."),
    onError: (e: any) => toast.error(e.message ?? "Failed to save."),
  });

  if (!propertyId) return <AccessDenied message="Select a property from the header first." />;

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Brute-force & session policy</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Max failed sign-in attempts (per 15 min)" hint="Trigger a lockout after this many failures.">
            <Input type="number" min={1} max={50} value={maxAttempts} onChange={(e) => setMaxAttempts(+e.target.value)} />
          </Field>
          <Field label="Lockout duration (minutes)" hint="How long a locked account stays locked.">
            <Input type="number" min={1} max={1440} value={lockoutMin} onChange={(e) => setLockoutMin(+e.target.value)} />
          </Field>
          <Field label="Session max age (hours)" hint="Force sign-in after this many hours.">
            <Input type="number" min={1} max={168} value={sessionHours} onChange={(e) => setSessionHours(+e.target.value)} />
          </Field>
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div><Label>Require multi-factor authentication</Label>
                <p className="text-xs text-muted-foreground">Enforce TOTP for all staff.</p></div>
              <Switch checked={mfaRequired} onCheckedChange={setMfaRequired} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div><Label>Allow concurrent sessions</Label>
                <p className="text-xs text-muted-foreground">Users can sign in from multiple devices.</p></div>
              <Switch checked={concurrent} onCheckedChange={setConcurrent} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div><Label>Notify admins on critical events</Label>
                <p className="text-xs text-muted-foreground">Push notifications for brute-force, hijack, etc.</p></div>
              <Switch checked={notify} onCheckedChange={setNotify} />
            </div>
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
            {saveMut.isPending ? "Saving…" : "Save policy"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
