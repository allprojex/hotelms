/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveProperty } from "@/hooks/use-active-property";
import {
  listCostCentres,
  saveCostCentre,
  archiveCostCentre,
  restoreCostCentre,
} from "@/lib/accounting/reference-data.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Building2, Plus, Archive, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/cost-centres")({
  head: () => ({ meta: [{ title: "Cost Centres · Accounting" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <CostCentresPage />
    </AccountingWorkspaceShell>
  ),
});

const empty = {
  id: undefined as string | undefined,
  name: "",
  code: "",
  description: "",
  parentCostCentreId: null as string | null,
};

function CostCentresPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"active" | "archived" | "all">("active");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);

  const listFn = useServerFn(listCostCentres);
  const saveFn = useServerFn(saveCostCentre);
  const archiveFn = useServerFn(archiveCostCentre);
  const restoreFn = useServerFn(restoreCostCentre);

  const list = useQuery({
    queryKey: ["cost-centres", propertyId, search, status],
    queryFn: () =>
      listFn({ data: { propertyId: propertyId!, search, status, page: 1, pageSize: 100 } }),
    enabled: !!propertyId,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["cost-centres", propertyId] });

  const saveMut = useMutation({
    mutationFn: () => saveFn({ data: { ...form, propertyId: propertyId! } }),
    onSuccess: () => {
      toast.success(form.id ? "Cost centre updated" : "Cost centre created");
      setOpen(false);
      setForm(empty);
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not save cost centre"),
  });
  const archiveMut = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      archiveFn({ data: { propertyId: propertyId!, ...v } }),
    onSuccess: () => {
      toast.success("Cost centre archived");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not archive"),
  });
  const restoreMut = useMutation({
    mutationFn: (id: string) => restoreFn({ data: { propertyId: propertyId!, id } }),
    onSuccess: () => {
      toast.success("Cost centre restored");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not restore"),
  });

  const rows = list.data?.rows ?? [];
  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property first.</div>;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-display font-semibold flex items-center gap-2">
          <Building2 className="h-6 w-6" /> Cost Centres
        </h1>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) setForm(empty);
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-1" /> New cost centre
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{form.id ? "Edit cost centre" : "New cost centre"}</DialogTitle>
              <DialogDescription>
                Cost centres can be nested; a centre cannot be its own ancestor.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Name</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Code</Label>
                  <Input
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                  />
                </div>
              </div>
              <div>
                <Label>Description</Label>
                <Textarea
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
              <div>
                <Label>Parent cost centre</Label>
                <Select
                  value={form.parentCostCentreId ?? "none"}
                  onValueChange={(v) =>
                    setForm({ ...form, parentCostCentreId: v === "none" ? null : v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (top level)</SelectItem>
                    {rows
                      .filter((r: any) => r.id !== form.id)
                      .map((r: any) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={!form.name || !form.code || saveMut.isPending}
                onClick={() => saveMut.mutate()}
              >
                {saveMut.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder="Search name or code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={status} onValueChange={(v) => setStatus(v as any)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Parent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c: any) => (
                <TableRow key={c.id}>
                  <TableCell>{c.name}</TableCell>
                  <TableCell className="font-mono text-xs">{c.code}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {c.parent?.name ?? "—"}
                  </TableCell>
                  <TableCell>
                    {c.archived_at ? (
                      <Badge variant="secondary">Archived</Badge>
                    ) : (
                      <Badge>Active</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setForm({
                          id: c.id,
                          name: c.name,
                          code: c.code,
                          description: c.description ?? "",
                          parentCostCentreId: c.parent_cost_centre_id,
                        });
                        setOpen(true);
                      }}
                    >
                      Edit
                    </Button>
                    {c.archived_at ? (
                      <Button size="sm" variant="ghost" onClick={() => restoreMut.mutate(c.id)}>
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="ghost">
                            <Archive className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Archive "{c.name}"?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Expenses that already reference this cost centre are preserved.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() =>
                                archiveMut.mutate({
                                  id: c.id,
                                  reason: "Archived from cost centre list",
                                })
                              }
                            >
                              Archive
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                    No cost centres found.
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
