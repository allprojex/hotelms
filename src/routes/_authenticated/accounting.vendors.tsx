/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveProperty } from "@/hooks/use-active-property";
import {
  listVendors,
  saveVendor,
  archiveVendor,
  restoreVendor,
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
import { Truck, Plus, Archive, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/vendors")({
  head: () => ({ meta: [{ title: "Vendors · Accounting" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <VendorsPage />
    </AccountingWorkspaceShell>
  ),
});

const empty = {
  id: undefined as string | undefined,
  name: "",
  vendorCode: "",
  vendorType: "",
  contactName: "",
  email: "",
  phone: "",
  address: "",
  taxReference: "",
  preferredPaymentMethod: "",
  notes: "",
};

function VendorsPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"active" | "archived" | "all">("active");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);

  const listFn = useServerFn(listVendors);
  const saveFn = useServerFn(saveVendor);
  const archiveFn = useServerFn(archiveVendor);
  const restoreFn = useServerFn(restoreVendor);

  const list = useQuery({
    queryKey: ["vendors", propertyId, search, status],
    queryFn: () =>
      listFn({ data: { propertyId: propertyId!, search, status, page: 1, pageSize: 100 } }),
    enabled: !!propertyId,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["vendors", propertyId] });

  const saveMut = useMutation({
    mutationFn: () => saveFn({ data: { ...form, propertyId: propertyId! } }),
    onSuccess: () => {
      toast.success(form.id ? "Vendor updated" : "Vendor created");
      setOpen(false);
      setForm(empty);
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not save vendor"),
  });
  const archiveMut = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      archiveFn({ data: { propertyId: propertyId!, ...v } }),
    onSuccess: () => {
      toast.success("Vendor archived");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not archive"),
  });
  const restoreMut = useMutation({
    mutationFn: (id: string) => restoreFn({ data: { propertyId: propertyId!, id } }),
    onSuccess: () => {
      toast.success("Vendor restored");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not restore"),
  });

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property first.</div>;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-display font-semibold flex items-center gap-2">
          <Truck className="h-6 w-6" /> Vendors
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
              <Plus className="h-4 w-4 mr-1" /> New vendor
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{form.id ? "Edit vendor" : "New vendor"}</DialogTitle>
              <DialogDescription>
                Bank details are stored as a reference only — never raw account numbers.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
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
                    value={form.vendorCode}
                    onChange={(e) => setForm({ ...form, vendorCode: e.target.value.toUpperCase() })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Type</Label>
                  <Input
                    value={form.vendorType}
                    onChange={(e) => setForm({ ...form, vendorType: e.target.value })}
                    placeholder="e.g. utility, supplier"
                  />
                </div>
                <div>
                  <Label>Contact person</Label>
                  <Input
                    value={form.contactName}
                    onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Email</Label>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Phone</Label>
                  <Input
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <Label>Address</Label>
                <Textarea
                  rows={2}
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Tax / registration ref.</Label>
                  <Input
                    value={form.taxReference}
                    onChange={(e) => setForm({ ...form, taxReference: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Preferred payment method</Label>
                  <Input
                    value={form.preferredPaymentMethod}
                    onChange={(e) => setForm({ ...form, preferredPaymentMethod: e.target.value })}
                    placeholder="e.g. bank transfer"
                  />
                </div>
              </div>
              <div>
                <Label>Notes</Label>
                <Textarea
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!form.name || saveMut.isPending} onClick={() => saveMut.mutate()}>
                {saveMut.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder="Search name, code or email…"
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
                <TableHead>Contact</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data?.rows ?? []).map((v: any) => (
                <TableRow key={v.id}>
                  <TableCell>{v.name}</TableCell>
                  <TableCell className="font-mono text-xs">{v.vendor_code ?? "—"}</TableCell>
                  <TableCell className="text-xs">{v.contact_name ?? v.email ?? "—"}</TableCell>
                  <TableCell className="text-xs">{v.vendor_type ?? "—"}</TableCell>
                  <TableCell>
                    {v.archived_at ? (
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
                          id: v.id,
                          name: v.name,
                          vendorCode: v.vendor_code ?? "",
                          vendorType: v.vendor_type ?? "",
                          contactName: v.contact_name ?? "",
                          email: v.email ?? "",
                          phone: v.phone ?? "",
                          address: v.address ?? "",
                          taxReference: v.tax_reference ?? "",
                          preferredPaymentMethod: v.preferred_payment_method ?? "",
                          notes: v.notes ?? "",
                        });
                        setOpen(true);
                      }}
                    >
                      Edit
                    </Button>
                    {v.archived_at ? (
                      <Button size="sm" variant="ghost" onClick={() => restoreMut.mutate(v.id)}>
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
                            <AlertDialogTitle>Archive "{v.name}"?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Expenses that already reference this vendor are preserved. It will no
                              longer be selectable for new expenses.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() =>
                                archiveMut.mutate({ id: v.id, reason: "Archived from vendor list" })
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
                    No vendors found.
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
