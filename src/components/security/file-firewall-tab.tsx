import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ShieldCheck, ShieldAlert, ShieldX, Upload, Loader2, ExternalLink, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { useActiveProperty } from "@/hooks/use-active-property";
import { scanUploadedFile, listFileScanLogs } from "@/lib/security/file-firewall.functions";

type Verdict = "clean" | "suspicious" | "malicious" | "error" | "unscanned";

function verdictBadge(v: Verdict) {
  switch (v) {
    case "clean":
      return <Badge className="bg-emerald-500/15 text-emerald-500 border-emerald-500/30 gap-1"><ShieldCheck className="h-3 w-3" />Clean</Badge>;
    case "suspicious":
      return <Badge className="bg-amber-500/15 text-amber-500 border-amber-500/30 gap-1"><ShieldAlert className="h-3 w-3" />Suspicious</Badge>;
    case "malicious":
      return <Badge variant="destructive" className="gap-1"><ShieldX className="h-3 w-3" />Malicious</Badge>;
    case "error":
      return <Badge variant="secondary" className="gap-1">Error</Badge>;
    default:
      return <Badge variant="outline">Unscanned</Badge>;
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsDataURL(file);
  });
}

const MAX_UPLOAD = 25 * 1024 * 1024;

export function FileFirewallTab() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const scanFn = useServerFn(scanUploadedFile);
  const listFn = useServerFn(listFileScanLogs);
  const [scanning, setScanning] = useState(false);
  const [lastResult, setLastResult] = useState<any>(null);

  const logs = useQuery({
    queryKey: ["file-scan-logs", propertyId],
    queryFn: () => listFn({ data: { propertyId: propertyId ?? null, limit: 100 } }),
  });

  async function handleFile(file: File) {
    if (file.size > MAX_UPLOAD) {
      toast.error("File exceeds 25 MB scan limit");
      return;
    }
    setScanning(true);
    setLastResult(null);
    try {
      const contentBase64 = await fileToBase64(file);
      const result = await scanFn({
        data: {
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          fileSize: file.size,
          contentBase64,
          propertyId: propertyId ?? null,
        },
      });
      setLastResult(result);
      if (result.verdict === "malicious") {
        toast.error(`Threat detected in ${file.name}`, { description: "File quarantined." });
      } else if (result.verdict === "suspicious") {
        toast.warning(`${file.name} flagged as suspicious`);
      } else {
        toast.success(`${file.name} scanned clean`);
      }
      qc.invalidateQueries({ queryKey: ["file-scan-logs"] });
    } catch (err: any) {
      toast.error(err?.message ?? "Scan failed");
    } finally {
      setScanning(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const rows = logs.data ?? [];
  const stats = {
    total: rows.length,
    clean: rows.filter((r: any) => r.verdict === "clean").length,
    suspicious: rows.filter((r: any) => r.verdict === "suspicious").length,
    malicious: rows.filter((r: any) => r.verdict === "malicious").length,
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <StatBox label="Files scanned" value={stats.total} tone="ok" />
        <StatBox label="Clean" value={stats.clean} tone="ok" />
        <StatBox label="Suspicious" value={stats.suspicious} tone={stats.suspicious > 0 ? "warn" : "ok"} />
        <StatBox label="Malicious blocked" value={stats.malicious} tone={stats.malicious > 0 ? "danger" : "ok"} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Upload className="h-4 w-4" /> Scan a file
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Heuristic firewall (magic bytes, extension deny-list, embedded-script sniffing)
            combined with VirusTotal signature lookup. Max 25&nbsp;MB.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              ref={inputRef}
              type="file"
              disabled={scanning}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
              className="max-w-sm"
            />
            {scanning && (
              <span className="text-sm text-muted-foreground inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Scanning…
              </span>
            )}
          </div>

          {lastResult && (
            <div className="rounded-md border p-3 space-y-2 bg-muted/30">
              <div className="flex items-center gap-2 flex-wrap">
                {verdictBadge(lastResult.verdict)}
                <code className="text-xs text-muted-foreground truncate">
                  sha256: {lastResult.sha256}
                </code>
                {lastResult.virustotal?.permalink && (
                  <a
                    href={lastResult.virustotal.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                  >
                    VirusTotal <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              {lastResult.reason && (
                <p className="text-sm text-muted-foreground">{lastResult.reason}</p>
              )}
              {lastResult.virustotal?.found && (
                <div className="text-xs text-muted-foreground">
                  Engines — malicious: <b className="text-destructive">{lastResult.virustotal.malicious}</b>,
                  suspicious: <b className="text-amber-500">{lastResult.virustotal.suspicious}</b>,
                  harmless: <b>{lastResult.virustotal.harmless}</b>,
                  undetected: <b>{lastResult.virustotal.undetected}</b>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Scan history</CardTitle>
          <Button size="sm" variant="outline" onClick={() => logs.refetch()} disabled={logs.isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${logs.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead className="hidden md:table-cell">Size</TableHead>
                  <TableHead>Verdict</TableHead>
                  <TableHead className="hidden lg:table-cell">Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-6">
                      No scans yet. Upload a file above to begin.
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((r: any) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {format(new Date(r.created_at), "dd/MM/yyyy HH:mm")}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate" title={r.file_name}>
                      {r.file_name}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                      {(r.file_size / 1024).toFixed(1)} KB
                    </TableCell>
                    <TableCell>{verdictBadge(r.verdict)}</TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground max-w-md truncate">
                      {r.reason || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatBox({ label, value, tone }: { label: string; value: number; tone: "ok" | "warn" | "danger" }) {
  const cls = tone === "danger" ? "text-destructive" : tone === "warn" ? "text-amber-500" : "text-emerald-500";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-2xl font-semibold ${cls}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
