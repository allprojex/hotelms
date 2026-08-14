import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  listUnmappedArInvoices,
  assignArInvoiceCustomer,
} from "@/lib/accounting/ar-invoice-mapping.functions";
import { listArCustomers } from "@/lib/accounting/ar-customers.functions";
import { formatMoney } from "@/lib/accounting/domain";
import { totalPages } from "@/lib/query-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type UnmappedInvoice = {
  id: string;
  code: string;
  issue_date: string;
  due_date: string;
  bill_to_name: string | null;
  bill_to_email: string | null;
  bill_to_address: string | null;
  currency: string;
  total: number;
  status: string;
  reservation_id: string | null;
  customer_id: string | null;
};

const STATUS_OPTIONS = ["draft", "sent", "paid", "void"] as const;
const PAGE_SIZE = 25;

export function ArHistoricalInvoiceMapping({
  propertyId,
  open,
  onOpenChange,
  onMapped,
}: {
  propertyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMapped: () => void;
}) {
  const listFn = useServerFn(listUnmappedArInvoices);
  const customersFn = useServerFn(listArCustomers);
  const assignFn = useServerFn(assignArInvoiceCustomer);

  const [unmappedOnly, setUnmappedOnly] = useState(true);
  const [code, setCode] = useState("");
  const [billToName, setBillToName] = useState("");
  const [billToEmail, setBillToEmail] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [currency, setCurrency] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const [assigning, setAssigning] = useState<UnmappedInvoice | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");

  function updateFilter<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  const list = useQuery({
    queryKey: [
      "ar-invoice-mapping",
      propertyId,
      unmappedOnly,
      code,
      billToName,
      billToEmail,
      from,
      to,
      currency,
      status,
      page,
    ],
    queryFn: () =>
      listFn({
        data: {
          propertyId,
          unmappedOnly,
          code,
          billToName,
          billToEmail,
          from,
          to,
          currency,
          status,
          page,
          pageSize: PAGE_SIZE,
        },
      }),
    enabled: open,
  });

  const customers = useQuery({
    queryKey: ["ar-customers", propertyId, "active"],
    queryFn: () => customersFn({ data: { propertyId } }),
    enabled: open && !!assigning,
  });

  const rows = (list.data?.rows ?? []) as UnmappedInvoice[];
  const total = list.data?.total ?? 0;
  const pages = totalPages(total, PAGE_SIZE);
  const activeCustomers = (customers.data ?? []) as any[];
  const chosenCustomer = activeCustomers.find((c) => c.id === selectedCustomerId);

  const assign = useMutation({
    mutationFn: () => {
      if (!assigning) throw new Error("No invoice selected");
      if (!selectedCustomerId) throw new Error("Select an AR customer");
      return assignFn({
        data: { propertyId, invoiceId: assigning.id, customerId: selectedCustomerId },
      });
    },
    onSuccess: async (result: any) => {
      toast.success(
        `Invoice ${result.invoiceCode ?? ""} mapped to ${result.customerAccountCode ?? "customer"}`,
      );
      setAssigning(null);
      setSelectedCustomerId("");
      await list.refetch();
      onMapped();
    },
    onError: (error: Error) => {
      // Covers the concurrency case too — if another user mapped this
      // invoice first, the RPC rejects it; refresh so the row's true state
      // (now showing "Mapped") replaces the stale one instead of the user
      // retrying blind.
      toast.error(error.message);
      list.refetch();
    },
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Map historical invoices</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground -mt-2">
            Review each invoice&apos;s original details, then deliberately choose the AR customer it
            belongs to. Nothing is assigned automatically.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <div className="col-span-2 md:col-span-4 flex items-center gap-2">
              <Checkbox
                checked={unmappedOnly}
                onCheckedChange={(c) => updateFilter(setUnmappedOnly)(!!c)}
              />
              <Label className="font-normal">Unmapped only</Label>
            </div>
            <div>
              <Label className="text-xs">Invoice code</Label>
              <Input
                className="h-8"
                value={code}
                onChange={(e) => updateFilter(setCode)(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Bill-to name</Label>
              <Input
                className="h-8"
                value={billToName}
                onChange={(e) => updateFilter(setBillToName)(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Bill-to email</Label>
              <Input
                className="h-8"
                value={billToEmail}
                onChange={(e) => updateFilter(setBillToEmail)(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Currency</Label>
              <Input
                className="h-8"
                value={currency}
                onChange={(e) => updateFilter(setCurrency)(e.target.value.toUpperCase())}
              />
            </div>
            <div>
              <Label className="text-xs">From</Label>
              <Input
                className="h-8"
                type="date"
                value={from}
                onChange={(e) => updateFilter(setFrom)(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">To</Label>
              <Input
                className="h-8"
                type="date"
                value={to}
                onChange={(e) => updateFilter(setTo)(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Status</Label>
              <Select
                value={status || "any"}
                onValueChange={(v) => updateFilter(setStatus)(v === "any" ? "" : v)}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="border rounded-md max-h-96 overflow-y-auto">
            {rows.map((invoice) => (
              <div
                key={invoice.id}
                className="flex items-center justify-between gap-3 px-3 py-2 border-b last:border-0 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{invoice.code}</span>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {invoice.status}
                    </Badge>
                    {invoice.customer_id && (
                      <Badge variant="secondary" className="text-[10px]">
                        Mapped
                      </Badge>
                    )}
                  </div>
                  <div className="truncate">
                    {invoice.bill_to_name || "—"}
                    {invoice.bill_to_email ? ` · ${invoice.bill_to_email}` : ""}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    Issued {invoice.issue_date} · Due {invoice.due_date}
                    {invoice.bill_to_address ? ` · ${invoice.bill_to_address}` : ""}
                    {invoice.reservation_id ? ` · Reservation ${invoice.reservation_id.slice(0, 8)}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono">{formatMoney(Number(invoice.total), invoice.currency)}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!invoice.customer_id}
                    onClick={() => {
                      setAssigning(invoice);
                      setSelectedCustomerId("");
                    }}
                  >
                    {invoice.customer_id ? "Mapped" : "Assign customer"}
                  </Button>
                </div>
              </div>
            ))}
            {rows.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {unmappedOnly ? "No unmapped invoices found." : "No invoices found."}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {total} invoice{total === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span>
                Page {page} of {pages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!assigning} onOpenChange={(o) => !o && setAssigning(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign customer · {assigning?.code}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="border rounded-md p-3 space-y-1">
              <div className="font-medium">{assigning?.bill_to_name || "—"}</div>
              {assigning?.bill_to_email && (
                <div className="text-muted-foreground">{assigning.bill_to_email}</div>
              )}
              {assigning?.bill_to_address && (
                <div className="text-muted-foreground whitespace-pre-wrap">
                  {assigning.bill_to_address}
                </div>
              )}
              <div className="text-muted-foreground">
                {assigning?.issue_date} · {formatMoney(Number(assigning?.total ?? 0), assigning?.currency)}{" "}
                · {assigning?.status}
              </div>
            </div>
            <div>
              <Label>AR customer</Label>
              <Select value={selectedCustomerId} onValueChange={setSelectedCustomerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select the customer this invoice belongs to" />
                </SelectTrigger>
                <SelectContent>
                  {activeCustomers.map((customer) => (
                    <SelectItem key={customer.id} value={customer.id}>
                      {customer.account_code} · {customer.name}
                      {customer.email ? ` · ${customer.email}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeCustomers.length === 0 && (
                <p className="text-xs text-muted-foreground mt-1">No active AR customers available.</p>
              )}
            </div>
            {chosenCustomer && (
              <div className="border rounded-md p-3 text-xs space-y-1">
                <div className="font-medium text-sm">{chosenCustomer.name}</div>
                <div className="font-mono">{chosenCustomer.account_code}</div>
                <div>{chosenCustomer.email ?? "No email"}</div>
                <Badge variant={chosenCustomer.active ? "default" : "secondary"}>
                  {chosenCustomer.active ? "Active" : "Inactive"}
                </Badge>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssigning(null)}>
              Cancel
            </Button>
            <Button disabled={!selectedCustomerId || assign.isPending} onClick={() => assign.mutate()}>
              Confirm assignment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
