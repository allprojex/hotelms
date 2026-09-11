import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { useHasAnyRole } from "@/hooks/use-user-roles";
import { purgeAuditLogs } from "@/lib/audit.functions";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Download, Info, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin_/audit")({
  head: () => ({ meta: [{ title: "Audit Trail" }] }),
  component: AuditTrailPage,
});

function AuditTrailPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [action, setAction] = useState("all");
  const [purgeBefore, setPurgeBefore] = useState<string>("");
  const [purgeScope, setPurgeScope] = useState<"property" | "all">("property");
  const isSuper = useHasAnyRole(["super_admin"], null);
  const purgeFn = useServerFn(purgeAuditLogs);

  const purge = useMutation({
    mutationFn: () => purgeFn({ data: {
      propertyId: purgeScope === "property" ? propertyId : null,
      before: purgeBefore ? new Date(purgeBefore).toISOString() : null,
    }}),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ["audit-logs"] });
      toast.success(`Purged ${res.purged} audit entr${res.purged === 1 ? "y" : "ies"}.`);
    },
    onError: (e: any) => toast.error(e.message ?? "Purge failed."),
  });

  const list = useQuery({
    queryKey: ["audit-logs", propertyId],
    enabled: !!propertyId,
    queryFn: async () => {
      const { data, error } = await supabase.from("admin_action_logs")
        .select("*").eq("property_id", propertyId!)
        .order("created_at", { ascending: false }).limit(1000);
      if (error) throw error;
      return data ?? [];
    },
  });

  const filtered = useMemo(() => {
    return (list.data ?? []).filter((r: any) =>
      (action === "all" || r.action === action) &&
      (!q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase()))
    );
  }, [list.data, q, action]);

  function exportCsv() {
    const cols = ["created_at","actor_id","full_name_snapshot","role_snapshot","entity_type","entity_id","action","success","ip","os","browser","memo"];
    const csv = [cols.join(",")].concat(
      filtered.map((r: any) => cols.map((c) => JSON.stringify(r[c] ?? "")).join(","))
    ).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `audit-${Date.now()}.csv`; a.click();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Audit Trail</h1>
          <p className="text-sm text-muted-foreground">All administrative actions recorded for this property.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={exportCsv}><Download className="h-4 w-4 mr-1" />Export CSV</Button>
          {isSuper.allowed && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive"><Trash2 className="h-4 w-4 mr-1" />Purge…</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Permanently purge audit records?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This deletes rows from the audit trail. The purge action itself is not recorded, so treat it as an out-of-band operation. Only super admins can run this.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium">Delete entries older than</label>
                    <Input type="datetime-local" value={purgeBefore} onChange={(e) => setPurgeBefore(e.target.value)} />
                    <p className="text-[10px] text-muted-foreground mt-1">Leave blank to purge every matching entry.</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium">Scope</label>
                    <Select value={purgeScope} onValueChange={(v) => setPurgeScope(v as any)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="property">This property only</SelectItem>
                        <SelectItem value="all">All properties (system-wide)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => purge.mutate()} disabled={purge.isPending}>
                    {purge.isPending ? "Purging…" : "Purge now"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <Card className="p-3 flex gap-2 flex-wrap">
        <Input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["all","create","update","delete","approve","import","export","print","login","logout","failed_login","password_change","other"].map((a) =>
              <SelectItem key={a} value={a}>{a}</SelectItem>)}
          </SelectContent>
        </Select>
      </Card>

      <Card className="p-3 border-primary/30 bg-primary/5 flex gap-2">
        <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground">
          Device MAC addresses are not available in web browsers for privacy reasons. A stable device fingerprint hash is used instead, alongside IP, OS, and browser details.
        </p>
      </Card>

      <Card>
        <Table>
          <TableHeader><TableRow>
            <TableHead>When</TableHead><TableHead>User</TableHead><TableHead>Role</TableHead>
            <TableHead>Action</TableHead><TableHead>Entity</TableHead><TableHead>Status</TableHead>
            <TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {filtered.map((r: any) => (
              <TableRow key={r.id}>
                <TableCell className="text-xs whitespace-nowrap">{format(new Date(r.created_at), "dd/MM/yyyy HH:mm:ss")}</TableCell>
                <TableCell className="text-sm">{r.full_name_snapshot ?? r.actor_id?.slice(0, 8) ?? "—"}</TableCell>
                <TableCell className="text-xs">{r.role_snapshot ?? "—"}</TableCell>
                <TableCell><Badge variant="outline">{r.action}</Badge></TableCell>
                <TableCell className="text-xs">{r.entity_type}{r.entity_id ? ` #${r.entity_id.slice(0,8)}` : ""}</TableCell>
                <TableCell>
                  {r.success ? <Badge variant="secondary">OK</Badge> : <Badge variant="destructive">Fail</Badge>}
                </TableCell>
                <TableCell>
                  <Sheet>
                    <SheetTrigger asChild><Button size="sm" variant="ghost">Details</Button></SheetTrigger>
                    <SheetContent className="overflow-y-auto w-full sm:max-w-lg">
                      <SheetHeader><SheetTitle>Audit entry</SheetTitle></SheetHeader>
                      <div className="mt-4 space-y-2 text-xs">
                        <Row label="When">{format(new Date(r.created_at), "dd/MM/yyyy HH:mm")}</Row>
                        <Row label="User">{r.full_name_snapshot} ({r.actor_id?.slice(0,8)})</Row>
                        <Row label="Role">{r.role_snapshot ?? "—"}</Row>
                        <Row label="IP">{r.ip ?? "—"}</Row>
                        <Row label="OS">{r.os ?? "—"}</Row>
                        <Row label="Browser">{r.browser ?? "—"}</Row>
                        <Row label="Device fingerprint">{r.device_fingerprint ?? "—"}</Row>
                        <Row label="Session">{r.session_id ?? "—"}</Row>
                        <Row label="Remarks">{r.remarks ?? "—"}</Row>
                        <div>
                          <div className="font-semibold mb-1">Before</div>
                          <pre className="bg-muted p-2 rounded overflow-auto text-[10px]">{JSON.stringify(r.before_snapshot, null, 2)}</pre>
                        </div>
                        <div>
                          <div className="font-semibold mb-1">After</div>
                          <pre className="bg-muted p-2 rounded overflow-auto text-[10px]">{JSON.stringify(r.after_snapshot, null, 2)}</pre>
                        </div>
                      </div>
                    </SheetContent>
                  </Sheet>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No audit entries match.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 border-b pb-1">
      <div className="text-muted-foreground">{label}</div>
      <div className="col-span-2 break-all">{children}</div>
    </div>
  );
}
