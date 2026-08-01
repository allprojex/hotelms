/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveProperty } from "@/hooks/use-active-property";
import {
  listExpenseCategories,
  saveExpenseCategory,
  archiveExpenseCategory,
  restoreExpenseCategory,
} from "@/lib/accounting/reference-data.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import { Tags, Plus, Archive, RotateCcw } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/accounting/expense-categories")({
  head: () => ({ meta: [{ title: "Expense Categories · Accounting" }] }),
  component: ExpenseCategoriesPage,
});

const empty = {
  id: undefined as string | undefined,
  name: "",
  code: "",
  description: "",
  approvalThreshold: "",
  receiptRequired: true,
};

function ExpenseCategoriesPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"active" | "archived" | "all">("active");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);

  const listFn = useServerFn(listExpenseCategories);
  const saveFn = useServerFn(saveExpenseCategory);
  const archiveFn = useServerFn(archiveExpenseCategory);
  const restoreFn = useServerFn(restoreExpenseCategory);

  const list = useQuery({
    queryKey: ["expense-categories", propertyId, search, status],
    queryFn: () =>
      listFn({ data: { propertyId: propertyId!, search, status, page: 1, pageSize: 100 } }),
    enabled: !!propertyId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["expense-categories", propertyId] });

  const saveMut = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          ...form,
          propertyId: propertyId!,
          approvalThreshold: form.approvalThreshold ? Number(form.approvalThreshold) : null,
        },
      }),
    onSuccess: () => {
      toast.success(form.id ? "Category updated" : "Category created");
      setOpen(false);
      setForm(empty);
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not save category"),
  });

  const archiveMut = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      archiveFn({ data: { propertyId: propertyId!, ...v } }),
    onSuccess: () => {
      toast.success("Category archived");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not archive"),
  });
  const restoreMut = useMutation({
    mutationFn: (id: string) => restoreFn({ data: { propertyId: propertyId!, id } }),
    onSuccess: () => {
      toast.success("Category restored");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not restore"),
  });

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property first.</div>;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-display font-semibold flex items-center gap-2">
          <Tags className="h-6 w-6" /> Expense Categories
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
              <Plus className="h-4 w-4 mr-1" /> New category
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{form.id ? "Edit category" : "New expense category"}</DialogTitle>
              <DialogDescription>
                Categories classify expenses and can require a receipt.
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
              <div className="grid grid-cols-2 gap-2 items-end">
                <div>
                  <Label>Approval threshold (optional)</Label>
                  <Input
                    type="number"
                    value={form.approvalThreshold}
                    onChange={(e) => setForm({ ...form, approvalThreshold: e.target.value })}
                  />
                </div>
                <div className="flex items-center gap-2 pb-2">
                  <Switch
                    checked={form.receiptRequired}
                    onCheckedChange={(v) => setForm({ ...form, receiptRequired: v })}
                  />
                  <Label>Receipt required</Label>
                </div>
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
                <TableHead>Receipt</TableHead>
                <TableHead>Threshold</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data?.rows ?? []).map((c: any) => (
                <TableRow key={c.id}>
                  <TableCell>{c.name}</TableCell>
                  <TableCell className="font-mono text-xs">{c.code}</TableCell>
                  <TableCell>
                    {c.receipt_required ? (
                      <Badge variant="outline">Required</Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">Optional</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{c.approval_threshold ?? "—"}</TableCell>
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
                          approvalThreshold: c.approval_threshold
                            ? String(c.approval_threshold)
                            : "",
                          receiptRequired: c.receipt_required,
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
                              Existing expenses that reference this category keep it. It will no
                              longer be selectable for new expenses.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() =>
                                archiveMut.mutate({
                                  id: c.id,
                                  reason: "Archived from category list",
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
              {(list.data?.rows ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                    No categories found.
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
