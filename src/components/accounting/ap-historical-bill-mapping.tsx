import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  listUnmappedApBills,
  listActiveSuppliers,
  assignApBillSupplier,
} from "@/lib/accounting/ap-bill-mapping.functions";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type UnmappedBill = {
  id: string;
  code: string;
  bill_date: string;
  due_date: string;
  supplier_name: string | null;
  reference: string | null;
  currency: string;
  total: number;
  status: string;
  supplier_id: string | null;
};

const STATUS_OPTIONS = ["draft", "open", "paid", "void"] as const;
const PAGE_SIZE = 25;

export function ApHistoricalBillMapping({
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
  const listFn = useServerFn(listUnmappedApBills);
  const suppliersFn = useServerFn(listActiveSuppliers);
  const assignFn = useServerFn(assignApBillSupplier);

  const [unmappedOnly, setUnmappedOnly] = useState(true);
  const [code, setCode] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [currency, setCurrency] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const [assigning, setAssigning] = useState<UnmappedBill | null>(null);
  const [selectedSupplierId, setSelectedSupplierId] = useState("");

  function updateFilter<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  const list = useQuery({
    queryKey: [
      "ap-bill-mapping",
      propertyId,
      unmappedOnly,
      code,
      supplierName,
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
          supplierName,
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

  const suppliers = useQuery({
    queryKey: ["suppliers-active", propertyId],
    queryFn: () => suppliersFn({ data: { propertyId } }),
    enabled: open && !!assigning,
  });

  const rows = (list.data?.rows ?? []) as UnmappedBill[];
  const total = list.data?.total ?? 0;
  const pages = totalPages(total, PAGE_SIZE);
  const activeSuppliers = (suppliers.data ?? []) as any[];
  const chosenSupplier = activeSuppliers.find((s) => s.id === selectedSupplierId);

  const assign = useMutation({
    mutationFn: () => {
      if (!assigning) throw new Error("No bill selected");
      if (!selectedSupplierId) throw new Error("Select a supplier");
      return assignFn({
        data: { propertyId, billId: assigning.id, supplierId: selectedSupplierId },
      });
    },
    onSuccess: async (result: any) => {
      toast.success(`Bill ${result.billCode ?? ""} mapped to ${result.supplierName ?? "supplier"}`);
      setAssigning(null);
      setSelectedSupplierId("");
      await list.refetch();
      onMapped();
    },
    onError: (error: Error) => {
      // Covers the concurrency case too — if another user mapped this bill
      // first, the RPC rejects it; refresh so the row's true state (now
      // showing "Mapped") replaces the stale one instead of the user
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
            <DialogTitle>Map historical bills</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground -mt-2">
            Review each bill&apos;s original details, then deliberately choose the supplier it
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
              <Label className="text-xs">Bill code</Label>
              <Input
                className="h-8"
                value={code}
                onChange={(e) => updateFilter(setCode)(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Supplier name</Label>
              <Input
                className="h-8"
                value={supplierName}
                onChange={(e) => updateFilter(setSupplierName)(e.target.value)}
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
            {rows.map((bill) => (
              <div
                key={bill.id}
                className="flex items-center justify-between gap-3 px-3 py-2 border-b last:border-0 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{bill.code}</span>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {bill.status}
                    </Badge>
                    {bill.supplier_id && (
                      <Badge variant="secondary" className="text-[10px]">
                        Mapped
                      </Badge>
                    )}
                  </div>
                  <div className="truncate">
                    {bill.supplier_name || "—"}
                    {bill.reference ? ` · ${bill.reference}` : ""}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    Billed {bill.bill_date} · Due {bill.due_date}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono">
                    {formatMoney(Number(bill.total), bill.currency)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!bill.supplier_id}
                    onClick={() => {
                      setAssigning(bill);
                      setSelectedSupplierId("");
                    }}
                  >
                    {bill.supplier_id ? "Mapped" : "Assign supplier"}
                  </Button>
                </div>
              </div>
            ))}
            {rows.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {unmappedOnly ? "No unmapped bills found." : "No bills found."}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {total} bill{total === 1 ? "" : "s"}
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
            <DialogTitle>Assign supplier · {assigning?.code}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="border rounded-md p-3 space-y-1">
              <div className="font-medium">{assigning?.supplier_name || "—"}</div>
              {assigning?.reference && (
                <div className="text-muted-foreground">{assigning.reference}</div>
              )}
              <div className="text-muted-foreground">
                {assigning?.bill_date} ·{" "}
                {formatMoney(Number(assigning?.total ?? 0), assigning?.currency)} ·{" "}
                {assigning?.status}
              </div>
            </div>
            <div>
              <Label>Supplier</Label>
              <Select value={selectedSupplierId} onValueChange={setSelectedSupplierId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select the supplier this bill belongs to" />
                </SelectTrigger>
                <SelectContent>
                  {activeSuppliers.map((supplier) => (
                    <SelectItem key={supplier.id} value={supplier.id}>
                      {supplier.name}
                      {supplier.email ? ` · ${supplier.email}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeSuppliers.length === 0 && (
                <p className="text-xs text-muted-foreground mt-1">No active suppliers available.</p>
              )}
            </div>
            {chosenSupplier && (
              <div className="border rounded-md p-3 text-xs space-y-1">
                <div className="font-medium text-sm">{chosenSupplier.name}</div>
                <div>{chosenSupplier.email ?? "No email"}</div>
                <Badge variant={chosenSupplier.active ? "default" : "secondary"}>
                  {chosenSupplier.active ? "Active" : "Inactive"}
                </Badge>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssigning(null)}>
              Cancel
            </Button>
            <Button
              disabled={!selectedSupplierId || assign.isPending}
              onClick={() => assign.mutate()}
            >
              Confirm assignment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
