/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveProperty } from "@/hooks/use-active-property";
import { createExpenseDraft } from "@/lib/accounting/expenses.functions";
import {
  listVendors,
  listExpenseCategories,
  listCostCentres,
} from "@/lib/accounting/reference-data.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Receipt } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/accounting/expenses/new")({
  head: () => ({ meta: [{ title: "New Expense · Accounting" }] }),
  component: NewExpensePage,
});

function NewExpensePage() {
  const propertyId = useActiveProperty();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    expenseDate: format(new Date(), "yyyy-MM-dd"),
    vendorId: "",
    categoryId: "",
    costCentreId: "",
    amountBeforeTax: "",
    taxAmount: "0",
    description: "",
    businessPurpose: "",
    paymentMethod: "",
    paymentReference: "",
  });

  const createFn = useServerFn(createExpenseDraft);
  const vendorsFn = useServerFn(listVendors);
  const categoriesFn = useServerFn(listExpenseCategories);
  const costCentresFn = useServerFn(listCostCentres);

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

  const selectedCostCentre = (costCentres.data?.rows ?? []).find(
    (c: any) => c.id === form.costCentreId,
  );
  const selectedCategory = (categories.data?.rows ?? []).find((c: any) => c.id === form.categoryId);

  const createMut = useMutation({
    mutationFn: () =>
      createFn({
        data: {
          propertyId: propertyId!,
          expenseDate: form.expenseDate,
          vendorId: form.vendorId || null,
          categoryId: form.categoryId,
          costCentreId: form.costCentreId || null,
          departmentId: selectedCostCentre?.department_id ?? null,
          currency: "GHS",
          amountBeforeTax: Number(form.amountBeforeTax || 0),
          taxAmount: Number(form.taxAmount || 0),
          description: form.description,
          businessPurpose: form.businessPurpose,
          paymentMethod: form.paymentMethod,
          paymentReference: form.paymentReference,
        },
      }),
    onSuccess: (row: any) => {
      toast.success(`Draft ${row.expense_number} created`);
      navigate({ to: "/accounting/expenses/$expenseId", params: { expenseId: row.id } });
    },
    onError: (e: any) => toast.error(e.message ?? "Could not create expense"),
  });

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property first.</div>;

  const total = Number(form.amountBeforeTax || 0) + Number(form.taxAmount || 0);
  const valid = form.categoryId && Number(form.amountBeforeTax) >= 0 && Number(form.taxAmount) >= 0;

  return (
    <div className="p-4 md:p-6 max-w-2xl space-y-4">
      <h1 className="text-2xl font-display font-semibold flex items-center gap-2">
        <Receipt className="h-6 w-6" /> New Expense
      </h1>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Expense date</Label>
              <Input
                type="date"
                value={form.expenseDate}
                onChange={(e) => setForm({ ...form, expenseDate: e.target.value })}
              />
            </div>
            <div>
              <Label>Category</Label>
              <Select
                value={form.categoryId}
                onValueChange={(v) => setForm({ ...form, categoryId: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select category…" />
                </SelectTrigger>
                <SelectContent>
                  {(categories.data?.rows ?? []).map((c: any) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedCategory?.receipt_required && (
                <p className="text-xs text-muted-foreground mt-1">
                  This category requires a receipt before submission.
                </p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Vendor (optional)</Label>
              <Select
                value={form.vendorId || "none"}
                onValueChange={(v) => setForm({ ...form, vendorId: v === "none" ? "" : v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
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
              <Label>Cost centre (optional)</Label>
              <Select
                value={form.costCentreId || "none"}
                onValueChange={(v) => setForm({ ...form, costCentreId: v === "none" ? "" : v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
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
                value={form.amountBeforeTax}
                onChange={(e) => setForm({ ...form, amountBeforeTax: e.target.value })}
              />
            </div>
            <div>
              <Label>Tax amount</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.taxAmount}
                onChange={(e) => setForm({ ...form, taxAmount: e.target.value })}
              />
            </div>
          </div>
          <div className="text-sm text-muted-foreground">
            Total (server-calculated):{" "}
            <span className="font-mono text-foreground">{total.toFixed(2)}</span>
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
            <Label>Business purpose</Label>
            <Textarea
              rows={2}
              value={form.businessPurpose}
              onChange={(e) => setForm({ ...form, businessPurpose: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Payment method</Label>
              <Input
                value={form.paymentMethod}
                onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}
                placeholder="e.g. cash, mobile money"
              />
            </div>
            <div>
              <Label>Payment reference</Label>
              <Input
                value={form.paymentReference}
                onChange={(e) => setForm({ ...form, paymentReference: e.target.value })}
              />
            </div>
          </div>
          <Button disabled={!valid || createMut.isPending} onClick={() => createMut.mutate()}>
            {createMut.isPending ? "Saving draft…" : "Save draft"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
