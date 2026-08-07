/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveProperty } from "@/hooks/use-active-property";
import { listExpenses } from "@/lib/accounting/expenses.functions";
import {
  listVendors,
  listExpenseCategories,
  listCostCentres,
} from "@/lib/accounting/reference-data.functions";
import { formatMoney, EXPENSE_STATUS_LABELS } from "@/lib/accounting/domain";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Receipt, Plus, AlertCircle } from "lucide-react";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/expenses")({
  head: () => ({ meta: [{ title: "Expenses · Accounting" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <ExpensesPage />
    </AccountingWorkspaceShell>
  ),
});

function statusVariant(status: string): any {
  if (status === "approved") return "default";
  if (status === "rejected" || status === "cancelled") return "destructive";
  if (status === "submitted") return "outline";
  return "secondary";
}

function ExpensesPage() {
  const propertyId = useActiveProperty();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [costCentreId, setCostCentreId] = useState("");
  const [page, setPage] = useState(1);

  const listFn = useServerFn(listExpenses);
  const vendorsFn = useServerFn(listVendors);
  const categoriesFn = useServerFn(listExpenseCategories);
  const costCentresFn = useServerFn(listCostCentres);

  const expenses = useQuery({
    queryKey: ["expenses", propertyId, search, status, vendorId, categoryId, costCentreId, page],
    queryFn: () =>
      listFn({
        data: {
          propertyId: propertyId!,
          search,
          status,
          vendorId,
          categoryId,
          costCentreId,
          page,
          pageSize: 25,
        },
      }),
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

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property first.</div>;

  const rows = expenses.data?.rows ?? [];
  const total = expenses.data?.total ?? 0;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-display font-semibold flex items-center gap-2">
          <Receipt className="h-6 w-6" /> Expenses
        </h1>
        <Button asChild size="sm">
          <Link to="/accounting/expenses/new">
            <Plus className="h-4 w-4 mr-1" /> New expense
          </Link>
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder="Search number or description…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="max-w-xs"
        />
        <Select
          value={status || "all"}
          onValueChange={(v) => {
            setStatus(v === "all" ? "" : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {Object.entries(EXPENSE_STATUS_LABELS).map(([k, l]) => (
              <SelectItem key={k} value={k}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={vendorId || "all"}
          onValueChange={(v) => {
            setVendorId(v === "all" ? "" : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Vendor" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All vendors</SelectItem>
            {(vendors.data?.rows ?? []).map((v: any) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={categoryId || "all"}
          onValueChange={(v) => {
            setCategoryId(v === "all" ? "" : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {(categories.data?.rows ?? []).map((c: any) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={costCentreId || "all"}
          onValueChange={(v) => {
            setCostCentreId(v === "all" ? "" : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Cost centre" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All cost centres</SelectItem>
            {(costCentres.data?.rows ?? []).map((c: any) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e: any) => (
                <TableRow key={e.id} className="cursor-pointer hover:bg-muted/30">
                  <TableCell>
                    <Link
                      to="/accounting/expenses/$expenseId"
                      params={{ expenseId: e.id }}
                      className="font-mono text-xs hover:underline"
                    >
                      {e.expense_number}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">{e.expense_date}</TableCell>
                  <TableCell className="text-xs">{e.category?.name ?? "—"}</TableCell>
                  <TableCell className="text-xs">{e.vendor?.name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(e.status)}>
                      {EXPENSE_STATUS_LABELS[e.status] ?? e.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatMoney(e.total_amount, e.currency)}
                  </TableCell>
                  <TableCell>
                    {e.receipt_status === "missing" && (
                      <span title="Receipt missing">
                        <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                    No expenses match these filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {total} expense{total === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span>Page {page}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={rows.length < 25}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
