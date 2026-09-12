import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listPrintJobsFiltered, retryPrintJob, cancelPrintJob, bulkPrintJobAction,
} from "@/lib/printer/print-queue.functions";
import { listPrinters } from "@/lib/printer/printers.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RefreshCw, XCircle, RotateCcw, Info } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

const JOB_TYPES = ["all", "receipt", "invoice", "label", "barcode", "report", "document", "kot", "bill"];
const STATUSES = ["all", "pending", "processing", "completed", "failed", "cancelled"];

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    pending: "outline", processing: "default", completed: "secondary",
    failed: "destructive", cancelled: "outline",
  };
  return <Badge variant={map[status] ?? "outline"} className="uppercase text-[10px]">{status}</Badge>;
}

export function PrintQueueTab() {
  const qc = useQueryClient();
  const listFn = useServerFn(listPrintJobsFiltered);
  const retryFn = useServerFn(retryPrintJob);
  const cancelFn = useServerFn(cancelPrintJob);
  const bulkFn = useServerFn(bulkPrintJobAction);
  const printersFn = useServerFn(listPrinters);

  const [status, setStatus] = useState("all");
  const [jobType, setJobType] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<any>(null);

  const filters = { status, jobType, from: from || null, to: to || null, limit: 200 };

  const jobs = useQuery({
    queryKey: ["print-queue", filters],
    queryFn: () => listFn({ data: filters }),
    refetchInterval: 3000,
  });

  const printers = useQuery({ queryKey: ["printers"], queryFn: () => printersFn() });
  const printerMap = new Map((printers.data ?? []).map((p) => [p.id, p.name]));

  const retry = useMutation({
    mutationFn: (id: string) => retryFn({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["print-queue"] }); toast.success("Job re-queued."); },
    onError: (e: any) => toast.error(e.message ?? "Retry failed."),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => cancelFn({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["print-queue"] }); toast.success("Job cancelled."); },
    onError: (e: any) => toast.error(e.message ?? "Cancel failed."),
  });
  const bulk = useMutation({
    mutationFn: (action: "retry" | "cancel") =>
      bulkFn({ data: { ids: Array.from(selected), action } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["print-queue"] });
      setSelected(new Set());
      toast.success(`${r.count} job(s) updated.`);
    },
    onError: (e: any) => toast.error(e.message ?? "Bulk action failed."),
  });

  function toggleAll(checked: boolean) {
    if (!checked) return setSelected(new Set());
    setSelected(new Set((jobs.data ?? []).map((j) => j.id)));
  }
  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      checked ? next.add(id) : next.delete(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span>Print job queue</span>
            <Button variant="ghost" size="sm" onClick={() => jobs.refetch()} className="gap-1.5">
              <RefreshCw className={`h-3.5 w-3.5 ${jobs.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 grid-cols-2 md:grid-cols-5 mb-3">
            <div>
              <Label className="text-xs">Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Job type</Label>
              <Select value={jobType} onValueChange={setJobType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {JOB_TYPES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">From</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">To</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="flex items-end gap-2">
              <Button size="sm" variant="outline" disabled={!selected.size || bulk.isPending} onClick={() => bulk.mutate("retry")} className="gap-1.5">
                <RotateCcw className="h-3.5 w-3.5" />Retry ({selected.size})
              </Button>
              <Button size="sm" variant="outline" disabled={!selected.size || bulk.isPending} onClick={() => bulk.mutate("cancel")} className="gap-1.5">
                <XCircle className="h-3.5 w-3.5" />Cancel
              </Button>
            </div>
          </div>

          <div className="border rounded-md overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={!!jobs.data?.length && selected.size === jobs.data.length}
                      onCheckedChange={(v) => toggleAll(!!v)}
                    />
                  </TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Printer</TableHead>
                  <TableHead>Copies</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(jobs.data ?? []).map((j) => (
                  <TableRow key={j.id}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(j.id)}
                        onCheckedChange={(v) => toggleOne(j.id, !!v)}
                      />
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {format(new Date(j.created_at), "dd/MM/yyyy HH:mm:ss")}
                    </TableCell>
                    <TableCell className="text-xs uppercase">{j.job_type}</TableCell>
                    <TableCell className="text-xs max-w-[200px] truncate">{j.title ?? "—"}</TableCell>
                    <TableCell className="text-xs">{j.printer_id ? printerMap.get(j.printer_id) ?? "—" : "—"}</TableCell>
                    <TableCell className="text-xs">{j.copies}</TableCell>
                    <TableCell><StatusBadge status={j.status} /></TableCell>
                    <TableCell className="text-xs text-destructive max-w-[200px] truncate">
                      {j.error ?? "—"}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="icon" variant="ghost" onClick={() => setDetail(j)} title="Details">
                        <Info className="h-3.5 w-3.5" />
                      </Button>
                      {(j.status === "failed" || j.status === "cancelled") && (
                        <Button size="icon" variant="ghost" onClick={() => retry.mutate(j.id)} title="Retry">
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {(j.status === "pending" || j.status === "processing") && (
                        <Button size="icon" variant="ghost" onClick={() => cancel.mutate(j.id)} title="Cancel">
                          <XCircle className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {(jobs.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-sm text-muted-foreground py-8">
                      No jobs match the filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Print job details</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-muted-foreground">ID:</span> <span className="font-mono">{detail.id}</span></div>
                <div><span className="text-muted-foreground">Status:</span> <StatusBadge status={detail.status} /></div>
                <div><span className="text-muted-foreground">Job type:</span> {detail.job_type}</div>
                <div><span className="text-muted-foreground">Copies:</span> {detail.copies}</div>
                <div><span className="text-muted-foreground">Created:</span> {format(new Date(detail.created_at), "dd/MM/yyyy HH:mm")}</div>
                <div><span className="text-muted-foreground">Started:</span> {detail.started_at ? format(new Date(detail.started_at), "dd/MM/yyyy HH:mm") : "—"}</div>
                <div><span className="text-muted-foreground">Completed:</span> {detail.completed_at ? format(new Date(detail.completed_at), "dd/MM/yyyy HH:mm") : "—"}</div>
                <div><span className="text-muted-foreground">Printer:</span> {detail.printer_id ? printerMap.get(detail.printer_id) ?? detail.printer_id : "—"}</div>
              </div>
              {detail.error && (
                <div>
                  <Label className="text-xs">Error</Label>
                  <pre className="text-xs bg-destructive/10 text-destructive p-2 rounded overflow-auto max-h-40">{detail.error}</pre>
                </div>
              )}
              <div>
                <Label className="text-xs">Metadata</Label>
                <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-60">{JSON.stringify(detail.metadata ?? {}, null, 2)}</pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
