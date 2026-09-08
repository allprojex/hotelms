import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveProperty } from "@/hooks/use-active-property";
import { useHasAnyRole } from "@/hooks/use-user-roles";
import { ADMIN_ROLES } from "@/lib/admin/permissions";
import { AccessDenied } from "@/components/access-denied";
import {
  listRecycleBin, restoreRecycleBinItem, purgeRecycleBinItem, emptyRecycleBin,
} from "@/lib/recycle-bin.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Trash2, RotateCcw, Eye, Recycle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin_/recycle-bin")({
  head: () => ({
    meta: [
      { title: pageTitle("Recycle Bin") },
      { name: "description", content: "Restore or permanently delete removed items across the system." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RecycleBinPage,
});

function RecycleBinPage() {
  const propertyId = useActiveProperty();
  const gate = useHasAnyRole(ADMIN_ROLES, propertyId);
  const qc = useQueryClient();
  const listFn = useServerFn(listRecycleBin);
  const restoreFn = useServerFn(restoreRecycleBinItem);
  const purgeFn = useServerFn(purgeRecycleBinItem);
  const emptyFn = useServerFn(emptyRecycleBin);

  const [includeHistory, setIncludeHistory] = useState(false);
  const [filter, setFilter] = useState("");

  const q = useQuery({
    queryKey: ["recycle-bin", propertyId, includeHistory],
    enabled: !!propertyId,
    queryFn: () => listFn({ data: { propertyId, includePurged: includeHistory } }),
  });

  const restore = useMutation({
    mutationFn: (id: string) => restoreFn({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["recycle-bin"] }); toast.success("Item restored."); },
    onError: (e: any) => toast.error(e.message ?? "Restore failed."),
  });
  const purge = useMutation({
    mutationFn: (id: string) => purgeFn({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["recycle-bin"] }); toast.success("Item permanently deleted."); },
    onError: (e: any) => toast.error(e.message ?? "Delete failed."),
  });
  const empty = useMutation({
    mutationFn: () => emptyFn({ data: { propertyId } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["recycle-bin"] }); toast.success("Recycle bin emptied."); },
    onError: (e: any) => toast.error(e.message ?? "Empty failed."),
  });

  if (gate.loading) return <div className="p-6 text-muted-foreground">Checking access…</div>;
  if (!gate.allowed) return <AccessDenied message="Only admins can access the recycle bin." />;

  const rows = (q.data ?? []).filter((r) =>
    !filter ? true :
      `${r.source_table} ${r.label ?? ""} ${r.source_id}`.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="p-4 md:p-6 space-y-4">
      <header className="flex items-center gap-3">
        <Recycle className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-display font-semibold">Recycle Bin</h1>
          <p className="text-xs text-muted-foreground">
            Restore deleted items or permanently purge them. Applies to rows moved to the bin via app soft-delete actions.
          </p>
        </div>
      </header>

      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between space-y-0 gap-3 flex-wrap">
          <CardTitle className="text-base">Deleted items</CardTitle>
          <div className="flex items-center gap-3">
            <Input
              placeholder="Filter by table, label, id…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 w-[240px]"
            />
            <div className="flex items-center gap-2">
              <Switch id="hist" checked={includeHistory} onCheckedChange={setIncludeHistory} />
              <Label htmlFor="hist" className="text-xs">Show history</Label>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive" className="gap-1.5" disabled={rows.length === 0}>
                  <Trash2 className="h-3.5 w-3.5" />Empty bin
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Empty the recycle bin?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Every restorable item {propertyId ? "for this property" : ""} will be permanently marked as purged and can no longer be restored.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => empty.mutate()} disabled={empty.isPending}>
                    {empty.isPending ? "Emptying…" : "Empty bin"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Deleted</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const state = r.purged_at ? "purged" : r.restored_at ? "restored" : "in bin";
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="text-sm font-medium">{r.label ?? r.source_id}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">{r.source_id}</div>
                    </TableCell>
                    <TableCell className="text-xs font-mono">{r.source_table}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(r.deleted_at), { addSuffix: true })}
                    </TableCell>
                    <TableCell>
                      <Badge variant={state === "purged" ? "destructive" : state === "restored" ? "secondary" : "outline"}>
                        {state}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button size="icon" variant="ghost" title="View snapshot">
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="max-w-2xl">
                            <DialogHeader><DialogTitle>Snapshot · {r.source_table}</DialogTitle></DialogHeader>
                            <pre className="text-xs bg-muted p-3 rounded max-h-[60vh] overflow-auto">
                              {JSON.stringify(r.snapshot, null, 2)}
                            </pre>
                          </DialogContent>
                        </Dialog>
                        {!r.restored_at && !r.purged_at && (
                          <>
                            <Button size="icon" variant="ghost" title="Restore" onClick={() => restore.mutate(r.id)}>
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" title="Delete permanently" onClick={() => purge.mutate(r.id)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                    Recycle bin is empty.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
