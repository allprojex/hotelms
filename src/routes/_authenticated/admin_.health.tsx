import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Activity, RefreshCw, CheckCircle2, XCircle, AlertTriangle, ExternalLink, Clock, Server, Database, KeyRound } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin_/health")({
  head: () => ({ meta: [{ title: "Health Dashboard" }] }),
  component: HealthDashboard,
});

type CheckResult = { ok: boolean; ms?: number; detail?: string };
type HealthResponse = {
  status: "ok" | "degraded";
  version: string;
  node: string;
  startedAt: string;
  timestamp: string;
  checks: Record<string, CheckResult>;
};

type Remediation = { icon: typeof Server; title: string; steps: string[] };

const REMEDIATION: Record<string, Remediation> = {
  node: {
    icon: Server,
    title: "Node runtime unavailable",
    steps: [
      "Confirm the process is running: systemctl status infinity-pms",
      "Verify Node version: node -v (must be v20.x or v22.x)",
      "Reinstall Node from the offline tarball if missing (see Offline Deployment Guide § 3)",
    ],
  },
  env: {
    icon: KeyRound,
    title: "Required environment variables missing",
    steps: [
      "Open /opt/infinity-pms/.env and set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY",
      "Also set the matching VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY",
      "Restart the service: sudo systemctl restart infinity-pms",
      "Re-run the health probe to confirm the checks now pass",
    ],
  },
  database: {
    icon: Database,
    title: "Database unreachable",
    steps: [
      "Check network egress from the app host to the Supabase URL (curl -I $SUPABASE_URL)",
      "Verify SUPABASE_PUBLISHABLE_KEY is valid and not rotated",
      "Confirm the brand_settings_public view still exists and has a public SELECT policy",
      "Inspect journalctl -u infinity-pms -n 100 for connection errors",
      "If latency is high (>2000ms), check Cloud database health from the backend panel",
    ],
  },
};

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtSince(iso: string, now: number): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function HealthDashboard() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const q = useQuery({
    queryKey: ["admin-health"],
    refetchInterval: 15_000,
    queryFn: async (): Promise<{ data: HealthResponse | null; httpStatus: number; fetchedAt: string; error?: string }> => {
      const fetchedAt = new Date().toISOString();
      try {
        const res = await fetch("/api/public/health", { cache: "no-store" });
        const json = (await res.json()) as HealthResponse;
        return { data: json, httpStatus: res.status, fetchedAt };
      } catch (e: any) {
        return { data: null, httpStatus: 0, fetchedAt, error: String(e?.message ?? e) };
      }
    },
  });

  const payload = q.data?.data;
  const httpStatus = q.data?.httpStatus ?? 0;
  const fetchedAt = q.data?.fetchedAt;
  const overallOk = payload?.status === "ok" && httpStatus === 200;
  const unreachable = httpStatus === 0;

  const failing = Object.entries(payload?.checks ?? {}).filter(([, v]) => !v.ok);

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Health Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Live results from <code className="text-xs bg-muted px-1 py-0.5 rounded">/api/public/health</code>. Auto-refreshes every 15 seconds.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" asChild>
            <a href="/api/public/health" target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3 mr-1" />Open raw JSON
            </a>
          </Button>
          <Button size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`h-3 w-3 mr-1 ${q.isFetching ? "animate-spin" : ""}`} />Refresh
          </Button>
        </div>
      </div>

      {/* Overall status */}
      <Card className={`p-5 border-l-4 ${
        unreachable ? "border-l-destructive"
          : overallOk ? "border-l-emerald-500"
          : "border-l-amber-500"
      }`}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className={`rounded-full p-2 ${
              unreachable ? "bg-destructive/10 text-destructive"
                : overallOk ? "bg-emerald-500/10 text-emerald-600"
                : "bg-amber-500/10 text-amber-600"
            }`}>
              {unreachable ? <XCircle className="h-6 w-6" /> : overallOk ? <CheckCircle2 className="h-6 w-6" /> : <AlertTriangle className="h-6 w-6" />}
            </div>
            <div>
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Overall status</div>
              <div className="text-2xl font-semibold capitalize">
                {unreachable ? "Unreachable" : payload?.status ?? (q.isLoading ? "Loading…" : "Unknown")}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">HTTP {httpStatus || "—"}{payload?.version ? ` · v${payload.version}` : ""}{payload?.node ? ` · node ${payload.node}` : ""}</div>
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground space-y-0.5">
            <div className="flex items-center justify-end gap-1"><Clock className="h-3 w-3" />Fetched {fetchedAt ? fmtSince(fetchedAt, now) : "—"}</div>
            {payload?.timestamp && <div>Server ts: {new Date(payload.timestamp).toLocaleString("en-GB")}</div>}
            {payload?.startedAt && <div>Started: {new Date(payload.startedAt).toLocaleString("en-GB")}</div>}
          </div>
        </div>
      </Card>

      {/* Individual checks */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="h-4 w-4" />
          <h2 className="font-semibold">Checks</h2>
        </div>
        {q.isLoading && !payload ? (
          <div className="text-sm text-muted-foreground">Probing…</div>
        ) : unreachable ? (
          <div className="text-sm text-destructive">
            Endpoint did not respond{q.data?.error ? `: ${q.data.error}` : "."} Verify the service is running and the reverse proxy is routing <code className="bg-muted px-1 rounded">/api/public/health</code>.
          </div>
        ) : !payload ? (
          <div className="text-sm text-muted-foreground">No data.</div>
        ) : (
          <div className="grid gap-2">
            {Object.entries(payload.checks).map(([name, c]) => (
              <div key={name} className={`flex items-center justify-between border rounded-md px-3 py-2 ${c.ok ? "" : "border-amber-500/50 bg-amber-500/5"}`}>
                <div className="flex items-center gap-2 min-w-0">
                  {c.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" /> : <XCircle className="h-4 w-4 text-amber-600 shrink-0" />}
                  <span className="font-medium capitalize">{name}</span>
                  {c.detail && <span className="text-xs text-muted-foreground truncate">— {c.detail}</span>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {typeof c.ms === "number" && <Badge variant="outline" className="text-[10px]">{fmtDuration(c.ms)}</Badge>}
                  <Badge variant={c.ok ? "outline" : "secondary"} className="text-[10px]">
                    {c.ok ? "OK" : "FAIL"}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Remediation for failing checks */}
      {failing.length > 0 && (
        <Card className="p-4 border-amber-500/40">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <h2 className="font-semibold">Remediation ({failing.length} failing)</h2>
          </div>
          <div className="space-y-4">
            {failing.map(([name, c]) => {
              const r = REMEDIATION[name] ?? {
                icon: AlertTriangle,
                title: `Check "${name}" failing`,
                steps: [c.detail ?? "Inspect the raw JSON response for details.", "Check systemd + Nginx logs for the request time above."],
              };
              const Icon = r.icon;
              return (
                <div key={name} className="border rounded-md p-3">
                  <div className="flex items-center gap-2">
                    <div className="rounded-md bg-amber-500/10 p-1.5"><Icon className="h-4 w-4 text-amber-600" /></div>
                    <div>
                      <div className="font-medium">{r.title}</div>
                      {c.detail && <div className="text-xs text-muted-foreground">{c.detail}</div>}
                    </div>
                  </div>
                  <ol className="mt-2 ml-9 list-decimal text-sm text-muted-foreground space-y-1">
                    {r.steps.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <div className="text-xs text-muted-foreground">
          For CLI monitoring use <code className="bg-muted px-1 rounded">./scripts/healthcheck.sh https://your-host</code> (exit 0 healthy · 1 degraded · 2 unreachable). Full runbook in{" "}
          <a href="/admin/help" className="underline">Help &amp; Docs</a>.
        </div>
      </Card>
    </div>
  );
}
