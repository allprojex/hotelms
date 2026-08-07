/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import {
  getExpense,
  listExpenseStatusHistory,
  updateExpenseDraft,
  submitExpense,
  approveExpense,
  rejectExpense,
  returnExpense,
  cancelExpense,
} from "@/lib/accounting/expenses.functions";
import {
  createExpenseReceiptUploadTicket,
  registerExpenseReceipt,
  listExpenseReceipts,
  getExpenseReceiptDownloadUrl,
  archiveExpenseReceipt,
} from "@/lib/accounting/expense-receipts.functions";
import {
  requestExpenseCorrection,
  reverseExpense,
} from "@/lib/accounting/expense-corrections.functions";
import {
  listVendors,
  listExpenseCategories,
  listCostCentres,
} from "@/lib/accounting/reference-data.functions";
import { formatMoney, EXPENSE_STATUS_LABELS } from "@/lib/accounting/domain";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { Receipt, Upload, Download, History } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/expenses/$expenseId")({
  head: () => ({ meta: [{ title: "Expense · Accounting" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <ExpenseDetailPage />
    </AccountingWorkspaceShell>
  ),
});

function statusVariant(status: string): any {
  if (status === "approved") return "default";
  if (status === "rejected" || status === "cancelled") return "destructive";
  if (status === "submitted") return "outline";
  return "secondary";
}

function ReasonDialog({
  label,
  title,
  onConfirm,
  disabled,
}: {
  label: string;
  title: string;
  onConfirm: (reason: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            A reason of at least 5 characters is required and is recorded in the audit trail.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Reason…"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={reason.trim().length < 5}
            onClick={() => {
              onConfirm(reason.trim());
              setOpen(false);
              setReason("");
            }}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExpenseDetailPage() {
  const { expenseId } = Route.useParams();
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const getFn = useServerFn(getExpense);
  const historyFn = useServerFn(listExpenseStatusHistory);
  const updateFn = useServerFn(updateExpenseDraft);
  const submitFn = useServerFn(submitExpense);
  const approveFn = useServerFn(approveExpense);
  const rejectFn = useServerFn(rejectExpense);
  const returnFn = useServerFn(returnExpense);
  const cancelFn = useServerFn(cancelExpense);
  const ticketFn = useServerFn(createExpenseReceiptUploadTicket);
  const registerFn = useServerFn(registerExpenseReceipt);
  const receiptsFn = useServerFn(listExpenseReceipts);
  const downloadFn = useServerFn(getExpenseReceiptDownloadUrl);
  const archiveReceiptFn = useServerFn(archiveExpenseReceipt);
  const correctionFn = useServerFn(requestExpenseCorrection);
  const reverseFn = useServerFn(reverseExpense);
  const vendorsFn = useServerFn(listVendors);
  const categoriesFn = useServerFn(listExpenseCategories);
  const costCentresFn = useServerFn(listCostCentres);

  const expense = useQuery({
    queryKey: ["expense", propertyId, expenseId],
    queryFn: () => getFn({ data: { propertyId: propertyId!, id: expenseId } }),
    enabled: !!propertyId,
  });
  const history = useQuery({
    queryKey: ["expense-history", propertyId, expenseId],
    queryFn: () => historyFn({ data: { propertyId: propertyId!, expenseId } }),
    enabled: !!propertyId,
  });
  const receipts = useQuery({
    queryKey: ["expense-receipts", propertyId, expenseId],
    queryFn: () => receiptsFn({ data: { propertyId: propertyId!, expenseId } }),
    enabled: !!propertyId,
  });
  const vendors = useQuery({
    queryKey: ["vendors-min", propertyId],
    queryFn: () => vendorsFn({ data: { propertyId: propertyId!, pageSize: 200 } }),
    enabled: !!propertyId,
  });
  const categories = useQuery({
    queryKey: ["expense-categories-min", propertyId],
    queryFn: () => categoriesFn({ data: { propertyId: propertyId!, pageSize: 200 } }),
    enabled: !!propertyId,
  });
  const costCentres = useQuery({
    queryKey: ["cost-centres-min", propertyId],
    queryFn: () => costCentresFn({ data: { propertyId: propertyId!, pageSize: 200 } }),
    enabled: !!propertyId,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["expense", propertyId, expenseId] });
    qc.invalidateQueries({ queryKey: ["expense-history", propertyId, expenseId] });
    qc.invalidateQueries({ queryKey: ["expense-receipts", propertyId, expenseId] });
  };

  const [edit, setEdit] = useState<any | null>(null);
  const e = expense.data;

  const updateMut = useMutation({
    mutationFn: () =>
      updateFn({
        data: {
          id: expenseId,
          propertyId: propertyId!,
          expenseDate: edit.expenseDate,
          vendorId: edit.vendorId || null,
          categoryId: edit.categoryId,
          costCentreId: edit.costCentreId || null,
          departmentId: e?.department_id ?? null,
          currency: e?.currency,
          amountBeforeTax: Number(edit.amountBeforeTax),
          taxAmount: Number(edit.taxAmount),
          description: edit.description,
          businessPurpose: edit.businessPurpose,
          paymentMethod: edit.paymentMethod,
          paymentReference: edit.paymentReference,
        },
      }),
    onSuccess: () => {
      toast.success("Draft updated");
      setEdit(null);
      invalidateAll();
    },
    onError: (err: any) => toast.error(err.message ?? "Could not update"),
  });
  const submitMut = useMutation({
    mutationFn: () => submitFn({ data: { propertyId: propertyId!, id: expenseId } }),
    onSuccess: () => {
      toast.success("Submitted for approval");
      invalidateAll();
    },
    onError: (err: any) => toast.error(err.message ?? "Could not submit"),
  });
  const approveMut = useMutation({
    mutationFn: () => approveFn({ data: { propertyId: propertyId!, id: expenseId } }),
    onSuccess: () => {
      toast.success("Expense approved");
      invalidateAll();
    },
    onError: (err: any) => toast.error(err.message ?? "Could not approve"),
  });
  const rejectMut = useMutation({
    mutationFn: (reason: string) =>
      rejectFn({ data: { propertyId: propertyId!, id: expenseId, reason } }),
    onSuccess: () => {
      toast.success("Expense rejected");
      invalidateAll();
    },
    onError: (err: any) => toast.error(err.message ?? "Could not reject"),
  });
  const returnMut = useMutation({
    mutationFn: (reason: string) =>
      returnFn({ data: { propertyId: propertyId!, id: expenseId, reason } }),
    onSuccess: () => {
      toast.success("Returned for correction");
      invalidateAll();
    },
    onError: (err: any) => toast.error(err.message ?? "Could not return"),
  });
  const cancelMut = useMutation({
    mutationFn: (reason: string) =>
      cancelFn({ data: { propertyId: propertyId!, id: expenseId, reason } }),
    onSuccess: () => {
      toast.success("Expense cancelled");
      invalidateAll();
    },
    onError: (err: any) => toast.error(err.message ?? "Could not cancel"),
  });
  const correctionMut = useMutation({
    mutationFn: (reason: string) =>
      correctionFn({ data: { propertyId: propertyId!, expenseId, reason } }),
    onSuccess: () => {
      toast.success("Correction requested");
      invalidateAll();
    },
    onError: (err: any) => toast.error(err.message ?? "Could not request correction"),
  });
  const reverseMut = useMutation({
    mutationFn: (reason: string) =>
      reverseFn({ data: { propertyId: propertyId!, expenseId, reason } }),
    onSuccess: () => {
      toast.success("Reversal evidence created");
      invalidateAll();
    },
    onError: (err: any) => toast.error(err.message ?? "Could not reverse"),
  });
  const archiveReceiptMut = useMutation({
    mutationFn: (v: { receiptId: string; reason: string }) =>
      archiveReceiptFn({ data: { propertyId: propertyId!, ...v } }),
    onSuccess: () => {
      toast.success("Receipt archived");
      invalidateAll();
    },
    onError: (err: any) => toast.error(err.message ?? "Could not archive receipt"),
  });

  async function handleUpload(file: File) {
    if (!propertyId) return;
    setUploading(true);
    try {
      const ticket = await ticketFn({
        data: {
          propertyId,
          expenseId,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
        },
      });
      const stored = await supabase.storage.from(ticket.bucket).upload(ticket.storagePath, file, {
        contentType: file.type,
        upsert: false,
      });
      if (stored.error) throw stored.error;
      try {
        await registerFn({
          data: {
            propertyId,
            expenseId,
            storagePath: ticket.storagePath,
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
          },
        });
      } catch (err) {
        await supabase.storage.from(ticket.bucket).remove([ticket.storagePath]);
        throw err;
      }
      toast.success("Receipt uploaded");
      invalidateAll();
    } catch (err: any) {
      toast.error(err.message ?? "Could not upload receipt");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleDownload(receiptId: string) {
    if (!propertyId) return;
    try {
      const { url } = await downloadFn({ data: { propertyId, receiptId } });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err: any) {
      toast.error(err.message ?? "Could not open receipt");
    }
  }

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property first.</div>;
  if (expense.isLoading) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (expense.isError || !e) return <div className="p-6 text-destructive">Expense not found.</div>;

  const canEdit = ["draft", "returned"].includes(e.status);
  const activeReceipts = (receipts.data ?? []).filter((r: any) => !r.archived_at);

  return (
    <div className="p-4 md:p-6 max-w-3xl space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-display font-semibold flex items-center gap-2">
            <Receipt className="h-6 w-6" /> {e.expense_number}
          </h1>
          <p className="text-sm text-muted-foreground">
            {e.expense_date} · {e.category?.name}
          </p>
        </div>
        <Badge variant={statusVariant(e.status)}>
          {EXPENSE_STATUS_LABELS[e.status] ?? e.status}
        </Badge>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!canEdit || !edit ? (
            <>
              <div className="grid grid-cols-2 gap-y-1.5">
                <span className="text-muted-foreground">Vendor</span>
                <span>{e.vendor?.name ?? "—"}</span>
                <span className="text-muted-foreground">Cost centre</span>
                <span>{e.cost_centre?.name ?? "—"}</span>
                <span className="text-muted-foreground">Amount before tax</span>
                <span className="font-mono">{formatMoney(e.amount_before_tax, e.currency)}</span>
                <span className="text-muted-foreground">Tax</span>
                <span className="font-mono">{formatMoney(e.tax_amount, e.currency)}</span>
                <span className="text-muted-foreground">Total (server-calculated)</span>
                <span className="font-mono font-semibold">
                  {formatMoney(e.total_amount, e.currency)}
                </span>
                <span className="text-muted-foreground">Payment method</span>
                <span>{e.payment_method ?? "—"}</span>
                <span className="text-muted-foreground">Description</span>
                <span>{e.description ?? "—"}</span>
                <span className="text-muted-foreground">Business purpose</span>
                <span>{e.business_purpose ?? "—"}</span>
              </div>
              {canEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setEdit({
                      expenseDate: e.expense_date,
                      vendorId: e.vendor_id ?? "",
                      categoryId: e.category_id,
                      costCentreId: e.cost_centre_id ?? "",
                      amountBeforeTax: String(e.amount_before_tax),
                      taxAmount: String(e.tax_amount),
                      description: e.description ?? "",
                      businessPurpose: e.business_purpose ?? "",
                      paymentMethod: e.payment_method ?? "",
                      paymentReference: e.payment_reference ?? "",
                    })
                  }
                >
                  Edit draft
                </Button>
              )}
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Expense date</Label>
                  <Input
                    type="date"
                    value={edit.expenseDate}
                    onChange={(ev) => setEdit({ ...edit, expenseDate: ev.target.value })}
                  />
                </div>
                <div>
                  <Label>Category</Label>
                  <Select
                    value={edit.categoryId}
                    onValueChange={(v) => setEdit({ ...edit, categoryId: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(categories.data?.rows ?? []).map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Vendor</Label>
                  <Select
                    value={edit.vendorId || "none"}
                    onValueChange={(v) => setEdit({ ...edit, vendorId: v === "none" ? "" : v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {(vendors.data?.rows ?? []).map((v: any) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Cost centre</Label>
                  <Select
                    value={edit.costCentreId || "none"}
                    onValueChange={(v) => setEdit({ ...edit, costCentreId: v === "none" ? "" : v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {(costCentres.data?.rows ?? []).map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Amount before tax</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={edit.amountBeforeTax}
                    onChange={(ev) => setEdit({ ...edit, amountBeforeTax: ev.target.value })}
                  />
                </div>
                <div>
                  <Label>Tax amount</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={edit.taxAmount}
                    onChange={(ev) => setEdit({ ...edit, taxAmount: ev.target.value })}
                  />
                </div>
              </div>
              <div>
                <Label>Description</Label>
                <Textarea
                  rows={2}
                  value={edit.description}
                  onChange={(ev) => setEdit({ ...edit, description: ev.target.value })}
                />
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEdit(null)}>
                  Cancel
                </Button>
                <Button size="sm" disabled={updateMut.isPending} onClick={() => updateMut.mutate()}>
                  {updateMut.isPending ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {canEdit && !edit && (
            <Button size="sm" disabled={submitMut.isPending} onClick={() => submitMut.mutate()}>
              {submitMut.isPending ? "Submitting…" : "Submit for approval"}
            </Button>
          )}
          {e.status === "submitted" && (
            <>
              <Button size="sm" disabled={approveMut.isPending} onClick={() => approveMut.mutate()}>
                Approve
              </Button>
              <ReasonDialog
                label="Reject"
                title="Reject expense"
                onConfirm={(r) => rejectMut.mutate(r)}
              />
              <ReasonDialog
                label="Return for correction"
                title="Return expense"
                onConfirm={(r) => returnMut.mutate(r)}
              />
            </>
          )}
          {["draft", "submitted", "returned"].includes(e.status) && (
            <ReasonDialog
              label="Cancel"
              title="Cancel expense"
              onConfirm={(r) => cancelMut.mutate(r)}
            />
          )}
          {e.status === "approved" && (
            <>
              <ReasonDialog
                label="Request correction"
                title="Request a correction"
                onConfirm={(r) => correctionMut.mutate(r)}
              />
              <ReasonDialog
                label="Reverse"
                title="Reverse this expense"
                onConfirm={(r) => reverseMut.mutate(r)}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Receipts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {activeReceipts.map((r: any) => (
            <div
              key={r.id}
              className="flex items-center justify-between text-sm border rounded p-2"
            >
              <span className="truncate">
                {r.file_name}{" "}
                <span className="text-xs text-muted-foreground">
                  ({Math.round(r.file_size / 1024)} KB)
                </span>
              </span>
              <div className="flex items-center gap-1">
                <Button size="icon" variant="ghost" onClick={() => handleDownload(r.id)}>
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <ReasonDialog
                  label="Archive"
                  title="Archive receipt"
                  onConfirm={(reason) => archiveReceiptMut.mutate({ receiptId: r.id, reason })}
                />
              </div>
            </div>
          ))}
          {activeReceipts.length === 0 && (
            <p className="text-sm text-muted-foreground">No receipts uploaded yet.</p>
          )}
          <div>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(ev) => {
                const f = ev.target.files?.[0];
                if (f) handleUpload(f);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5 mr-1" /> {uploading ? "Uploading…" : "Upload receipt"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <History className="h-4 w-4" /> History
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {(history.data ?? []).map((h: any) => (
            <div key={h.id} className="text-xs text-muted-foreground">
              {format(new Date(h.created_at), "MMM d, yyyy HH:mm")} — {h.action} by{" "}
              {h.actor?.full_name ?? "system"}
              {h.reason ? `: ${h.reason}` : ""}
            </div>
          ))}
          {(history.data ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">No history yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
