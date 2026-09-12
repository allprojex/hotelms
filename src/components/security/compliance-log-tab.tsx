import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  queryComplianceLog, exportComplianceCsv, exportCompliancePdf,
  type ComplianceRow,
} from "@/lib/security/compliance.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Download, FileText, Filter } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

function daysAgo(n: number) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

export function ComplianceLogTab() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState<"security" | "audit" | "both">("both");
  const [severity, setSeverity] = useState<string>("");
  const [search, setSearch] = useState("");

  const queryFn = useServerFn(queryComplianceLog);
  const csvFn = useServerFn(exportComplianceCsv);
  const pdfFn = useServerFn(exportCompliancePdf);

  const filters = {
    from: `${from}T00:00:00Z`,
    to: `${to}T23:59:59Z`,
    source,
    severity: severity || null,
    search: search || null,
    limit: 500,
  };

  const q = useQuery({
    queryKey: ["compliance-log", filters],
    queryFn: () => queryFn({ data: filters }),
  });

  function download(name: string, mime: string, content: string | Uint8Array) {
    const parts: BlobPart[] = content instanceof Uint8Array
      ? [new Uint8Array(content).buffer as ArrayBuffer]
      : [content];
    const blob = new Blob(parts, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const csv = useMutation({
    mutationFn: () => csvFn({ data: filters }),
    onSuccess: (r) => {
      download(`compliance-${from}-to-${to}.csv`, "text/csv", r.csv);
      toast.success(`Exported ${r.count} rows.`);
    },
    onError: (e: any) => toast.error(e.message ?? "CSV export failed."),
  });

  const pdf = useMutation({
    mutationFn: () => pdfFn({ data: filters }),
    onSuccess: (r) => {
      const bin = atob(r.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      download(`compliance-${from}-to-${to}.pdf`, "application/pdf", bytes);
      toast.success(`Exported ${r.count} rows.`);
    },
    onError: (e: any) => toast.error(e.message ?? "PDF export failed."),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="h-4 w-4" />Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 grid-cols-2 md:grid-cols-6">
            <div>
              <Label className="text-xs">From</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">To</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Source</Label>
              <Select value={source} onValueChange={(v) => setSource(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="both">Both</SelectItem>
                  <SelectItem value="security">Security events</SelectItem>
                  <SelectItem value="audit">Audit log</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Severity</Label>
              <Select value={severity || "any"} onValueChange={(v) => setSeverity(v === "any" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 md:col-span-2">
              <Label className="text-xs">Search event / action</Label>
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. failed_login, reservation.update" />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <Button variant="outline" size="sm" onClick={() => csv.mutate()} disabled={csv.isPending} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />{csv.isPending ? "Exporting…" : "Export CSV"}
            </Button>
            <Button size="sm" onClick={() => pdf.mutate()} disabled={pdf.isPending} className="gap-1.5">
              <FileText className="h-3.5 w-3.5" />{pdf.isPending ? "Rendering…" : "Export PDF"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Compliance timeline <span className="text-xs text-muted-foreground font-normal">({q.data?.length ?? 0} rows, max 500)</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Event / Action</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>User</TableHead>
                <TableHead>IP / Entity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data ?? []).map((r: ComplianceRow) => (
                <TableRow key={`${r.source}-${r.id}`}>
                  <TableCell className="text-xs whitespace-nowrap">
                    {format(new Date(r.when), "dd/MM/yyyy HH:mm:ss")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.source === "security" ? "destructive" : "outline"} className="text-[10px] uppercase">
                      {r.source}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{r.event_type}</TableCell>
                  <TableCell className="text-xs uppercase">{r.severity ?? "—"}</TableCell>
                  <TableCell className="text-xs font-mono">{r.user_id?.slice(0, 8) ?? "—"}</TableCell>
                  <TableCell className="text-xs">{r.ip ?? r.entity ?? "—"}</TableCell>
                </TableRow>
              ))}
              {q.isLoading && (
                <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">Loading…</TableCell></TableRow>
              )}
              {!q.isLoading && (q.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                  No records match the current filters.
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
