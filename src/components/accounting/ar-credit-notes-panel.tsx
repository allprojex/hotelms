/* eslint-disable @typescript-eslint/no-explicit-any -- ar_credit_notes/ar_credit_note_lines/ar_invoice_balances are not yet in generated Database types, matching the established (supabase as any) precedent used elsewhere for the same reason (see ar-customers.functions.ts). */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { createArCreditNote } from "@/lib/accounting/ar-credit-notes.functions";
import { formatMoney } from "@/lib/accounting/domain";
import { ACCOUNTING_ADMIN_ROLES } from "@/lib/accounting/permissions";
import { useHasAnyRole } from "@/hooks/use-user-roles";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, FileMinus2, Send } from "lucide-react";
import { format } from "date-fns";

type ArInvoice = {
  id: string;
  code: string;
  bill_to_name: string | null;
  status: string;
  currency: string;
  total: number;
  amount_paid: number;
};

type ArCreditNote = {
  id: string;
  code: string;
  issue_date: string;
  reason: string;
  invoice_id: string;
  subtotal: number;
  tax: number;
  total: number;
  currency: string;
  status: "draft" | "posted" | "void";
  updated_at: string;
  invoice: { code: string; bill_to_name: string | null } | null;
};

type InvoiceLine = {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
};

type InvoiceBalance = {
  total: number;
  amount_paid: number;
  credited_total: number;
  net_balance: number;
};

// Matches the ROUND(x, 4) calls create_ar_credit_note() uses at draft-create
// time — a display-only preview, never itself an accounting decision. The
// authoritative subtotal/tax/total are always whatever the RPC actually
// stores (re-read via query invalidation after create), and a fully-
// exhausted line's exact residual is only ever finalized by
// post_ar_credit_note() at posting time (see that function's terminal-
// residual comment) — this preview intentionally does not attempt to
// predict that residual.
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function ArCreditNotesPanel({
  propertyId,
  invoices,
  onPosted,
}: {
  propertyId: string;
  /** The parent's already-fetched invoice list — reused rather than re-queried. */
  invoices: ArInvoice[];
  /** Called after a successful post — the parent owns ar-invoices/ar-aging query invalidation. */
  onPosted: () => void;
}) {
  const qc = useQueryClient();
  const createFn = useServerFn(createArCreditNote);
  const canManage = useHasAnyRole([...ACCOUNTING_ADMIN_ROLES], propertyId);

  const [createOpen, setCreateOpen] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");
  const [issueDate, setIssueDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [reason, setReason] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [postTarget, setPostTarget] = useState<ArCreditNote | null>(null);

  const creditNotes = useQuery({
    queryKey: ["ar-credit-notes", propertyId],
    queryFn: async () => {
      // ar_credit_notes_invoice_fkey is the only FK from ar_credit_notes to
      // ar_invoices, so this embed is unambiguous (unlike ar_receipts <->
      // ar_invoices via ar_receipt_allocations, which needs two flat
      // queries instead — see pdf.functions.ts).
      const { data, error } = await (supabase as any)
        .from("ar_credit_notes")
        .select(
          "id,code,issue_date,reason,invoice_id,subtotal,tax,total,currency,status,updated_at,invoice:ar_invoices(code,bill_to_name)",
        )
        .eq("property_id", propertyId)
        .order("issue_date", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as ArCreditNote[];
    },
    enabled: !!propertyId,
  });

  const eligibleInvoices = useMemo(() => invoices.filter((i) => i.status === "sent"), [invoices]);
  const selectedInvoice = eligibleInvoices.find((i) => i.id === invoiceId) ?? null;

  const invoiceLines = useQuery({
    queryKey: ["ar-invoice-lines", invoiceId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ar_invoice_lines")
        .select("id,description,quantity,unit_price,tax_rate")
        .eq("invoice_id", invoiceId);
      if (error) throw error;
      return (data ?? []) as InvoiceLine[];
    },
    enabled: createOpen && !!invoiceId,
  });

  const balance = useQuery({
    queryKey: ["ar-invoice-balance", propertyId, invoiceId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ar_invoice_balances")
        .select("total,amount_paid,credited_total,net_balance")
        .eq("property_id", propertyId)
        .eq("invoice_id", invoiceId)
        .maybeSingle();
      if (error) throw error;
      return data as InvoiceBalance | null;
    },
    enabled: createOpen && !!invoiceId,
  });

  // Two flat queries + client-side join, deliberately not a PostgREST embed:
  // ar_credit_note_lines has TWO foreign keys into ar_credit_notes
  // (ar_credit_note_lines_property_note_fkey and
  // ar_credit_note_lines_note_invoice_fkey), so an embed would be
  // ambiguous — the same class of issue already fixed for HRM
  // (20260803160000_hrm_fk_ambiguity_fix.sql) and worked around the same
  // way for ar_receipt_allocations in pdf.functions.ts.
  const existingCreditLines = useQuery({
    queryKey: ["ar-credit-note-lines", invoiceId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ar_credit_note_lines")
        .select("credit_note_id,source_invoice_line_id,quantity")
        .eq("invoice_id", invoiceId);
      if (error) throw error;
      return (data ?? []) as {
        credit_note_id: string;
        source_invoice_line_id: string;
        quantity: number;
      }[];
    },
    enabled: createOpen && !!invoiceId,
  });

  const postedNoteIdsForInvoice = useQuery({
    queryKey: ["ar-credit-notes-posted-ids", invoiceId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ar_credit_notes")
        .select("id")
        .eq("invoice_id", invoiceId)
        .eq("status", "posted");
      if (error) throw error;
      return new Set((data ?? []).map((r: { id: string }) => r.id));
    },
    enabled: createOpen && !!invoiceId,
  });

  // Only quantity already committed by a POSTED credit note counts against
  // remaining capacity — draft/void lines never consumed it, mirroring
  // post_ar_credit_note()'s own _cum_qty computation exactly (it sums only
  // from sibling credit notes with status = 'posted').
  const remainingByLine = useMemo(() => {
    const postedIds = postedNoteIdsForInvoice.data ?? new Set<string>();
    const consumed = new Map<string, number>();
    for (const row of existingCreditLines.data ?? []) {
      if (!postedIds.has(row.credit_note_id)) continue;
      consumed.set(
        row.source_invoice_line_id,
        (consumed.get(row.source_invoice_line_id) ?? 0) + Number(row.quantity),
      );
    }
    const result = new Map<string, number>();
    for (const line of invoiceLines.data ?? []) {
      result.set(line.id, Number(line.quantity) - (consumed.get(line.id) ?? 0));
    }
    return result;
  }, [invoiceLines.data, existingCreditLines.data, postedNoteIdsForInvoice.data]);

  function openCreate() {
    setInvoiceId("");
    setIssueDate(format(new Date(), "yyyy-MM-dd"));
    setReason("");
    setQuantities({});
    setCreateOpen(true);
  }

  function setLineQuantity(lineId: string, raw: string, remaining: number) {
    const parsed = parseFloat(raw);
    if (raw !== "" && (!Number.isFinite(parsed) || parsed < 0)) return;
    // Prevent an obviously invalid quantity client-side: clamp to the
    // remaining creditable quantity on this line. The server re-enforces
    // this authoritatively regardless (post_ar_credit_note() recomputes
    // remaining quantity fresh under an invoice row lock) — this clamp is
    // UX only.
    const clamped = raw === "" ? "" : String(Math.min(parsed, Math.max(0, remaining)));
    setQuantities((prev) => ({ ...prev, [lineId]: clamped }));
  }

  const selectedLines = useMemo(() => {
    return (invoiceLines.data ?? [])
      .map((line) => {
        const qty = parseFloat(quantities[line.id] ?? "");
        if (!(qty > 0)) return null;
        const subtotal = round4(qty * Number(line.unit_price));
        const tax = round4(subtotal * (Number(line.tax_rate) / 100));
        return { line, qty, subtotal, tax };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [invoiceLines.data, quantities]);

  const previewSubtotal = round4(selectedLines.reduce((s, l) => s + l.subtotal, 0));
  const previewTax = round4(selectedLines.reduce((s, l) => s + l.tax, 0));
  const previewTotal = round4(previewSubtotal + previewTax);
  const exceedsNetBalance =
    !!balance.data && previewTotal > Number(balance.data.net_balance) + 0.0001;
  const reasonValid = reason.trim().length >= 5 && reason.trim().length <= 500;

  const create = useMutation({
    mutationFn: async () => {
      if (!invoiceId) throw new Error("Select an invoice to credit");
      if (selectedLines.length === 0) throw new Error("Select at least one line to credit");
      return createFn({
        data: {
          propertyId,
          invoiceId,
          issueDate,
          reason: reason.trim(),
          lines: selectedLines.map((l) => ({ sourceInvoiceLineId: l.line.id, quantity: l.qty })),
        },
      });
    },
    onSuccess: () => {
      toast.success("Credit note created as draft");
      setCreateOpen(false);
      qc.invalidateQueries({ queryKey: ["ar-credit-notes", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const post = useMutation({
    mutationFn: async (id: string) => {
      // post_ar_credit_note is not yet in the generated Database types
      // (20260819120000_ar_credit_notes_pr1.sql) — same untyped-RPC
      // precedent already used for get_effective_branding in
      // use-effective-branding.ts.
      const { data, error } = await (supabase.rpc as any)("post_ar_credit_note", { _id: id });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Credit note posted — a new accounting entry was recorded");
      setPostTarget(null);
      qc.invalidateQueries({ queryKey: ["ar-credit-notes", propertyId] });
      onPosted();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <Card>
        <CardHeader className="py-3 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Credit Notes</CardTitle>
          {canManage.allowed && (
            <Button size="sm" variant="outline" className="h-7" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New credit note
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {(creditNotes.data ?? []).map((cn) => (
            <div
              key={cn.id}
              className="flex items-center justify-between gap-3 px-4 py-2 border-b last:border-0 hover:bg-muted/30"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">
                    {cn.code}
                  </span>
                  <span className="text-xs text-muted-foreground">{cn.issue_date}</span>
                  <Badge
                    variant={
                      cn.status === "posted"
                        ? "default"
                        : cn.status === "void"
                          ? "secondary"
                          : "outline"
                    }
                    className="text-[10px] uppercase"
                  >
                    {cn.status}
                  </Badge>
                  {cn.status === "posted" && (
                    <span className="text-[10px] text-muted-foreground">
                      Posted {format(new Date(cn.updated_at), "yyyy-MM-dd")}
                    </span>
                  )}
                </div>
                <div className="truncate text-sm">
                  {cn.invoice?.bill_to_name ?? "—"}
                  <span className="text-muted-foreground">
                    {" "}
                    · against invoice {cn.invoice?.code ?? "—"}
                  </span>
                </div>
                <div className="truncate text-xs text-muted-foreground">{cn.reason}</div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right text-xs">
                  <div className="text-muted-foreground">
                    Subtotal {formatMoney(Number(cn.subtotal), cn.currency)}
                  </div>
                  <div className="text-muted-foreground">
                    Tax {formatMoney(Number(cn.tax), cn.currency)}
                  </div>
                </div>
                <span className="font-mono text-sm font-semibold">
                  {formatMoney(Number(cn.total), cn.currency)}
                </span>
                {cn.status === "draft" && canManage.allowed && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={() => setPostTarget(cn)}
                  >
                    <FileMinus2 className="h-3 w-3 mr-1" /> Post
                  </Button>
                )}
              </div>
            </div>
          ))}
          {(creditNotes.data ?? []).length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No credit notes yet.
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New credit note</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Invoice to credit</Label>
              <Select
                value={invoiceId}
                onValueChange={(v) => {
                  setInvoiceId(v);
                  setQuantities({});
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a sent invoice" />
                </SelectTrigger>
                <SelectContent>
                  {eligibleInvoices.map((inv) => (
                    <SelectItem key={inv.id} value={inv.id}>
                      {inv.code} · {inv.bill_to_name ?? "—"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {eligibleInvoices.length === 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  No sent invoices are eligible for a credit note. Only a fully-sent, unpaid-in-full
                  invoice can be credited.
                </p>
              )}
            </div>

            {selectedInvoice && (
              <>
                <div className="grid grid-cols-4 gap-2 text-xs border rounded-md p-3">
                  <div>
                    <div className="text-muted-foreground">Original total</div>
                    <div className="font-mono">
                      {balance.data
                        ? formatMoney(Number(balance.data.total), selectedInvoice.currency)
                        : "…"}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Paid</div>
                    <div className="font-mono">
                      {balance.data
                        ? formatMoney(Number(balance.data.amount_paid), selectedInvoice.currency)
                        : "…"}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Already credited</div>
                    <div className="font-mono">
                      {balance.data
                        ? formatMoney(Number(balance.data.credited_total), selectedInvoice.currency)
                        : "…"}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Remaining net balance</div>
                    <div className="font-mono font-semibold">
                      {balance.data
                        ? formatMoney(Number(balance.data.net_balance), selectedInvoice.currency)
                        : "…"}
                    </div>
                  </div>
                </div>

                <div>
                  <Label>Reason (required, 5–500 characters)</Label>
                  <Textarea
                    rows={2}
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why is this credit note being issued?"
                  />
                  <p className="text-xs text-muted-foreground mt-1">{reason.trim().length}/500</p>
                </div>

                <div>
                  <Label>Issue date</Label>
                  <Input
                    type="date"
                    value={issueDate}
                    onChange={(e) => setIssueDate(e.target.value)}
                  />
                </div>

                <div className="border rounded-md">
                  <div className="grid grid-cols-[2fr_70px_90px_60px_90px_100px] gap-2 p-2 text-xs font-medium bg-muted/50 border-b">
                    <div>Description</div>
                    <div>Remaining</div>
                    <div>Price</div>
                    <div>Tax %</div>
                    <div>Qty to credit</div>
                    <div>Line total</div>
                  </div>
                  {(invoiceLines.data ?? []).map((line) => {
                    const remaining = remainingByLine.get(line.id) ?? 0;
                    const fullyCredited = remaining <= 0;
                    const qty = parseFloat(quantities[line.id] ?? "");
                    const lineTotal =
                      qty > 0
                        ? round4(
                            round4(qty * Number(line.unit_price)) *
                              (1 + Number(line.tax_rate) / 100),
                          )
                        : 0;
                    return (
                      <div
                        key={line.id}
                        className={`grid grid-cols-[2fr_70px_90px_60px_90px_100px] gap-2 p-2 border-b last:border-0 items-center ${fullyCredited ? "opacity-50" : ""}`}
                      >
                        <div className="truncate text-sm">{line.description}</div>
                        <div className="text-xs font-mono">
                          {fullyCredited ? "Fully credited" : `${remaining} of ${line.quantity}`}
                        </div>
                        <div className="text-xs font-mono">
                          {formatMoney(Number(line.unit_price), selectedInvoice.currency)}
                        </div>
                        <div className="text-xs font-mono">{line.tax_rate}%</div>
                        <Input
                          className="h-8"
                          type="number"
                          min={0}
                          max={Math.max(0, remaining)}
                          step="any"
                          disabled={fullyCredited}
                          value={quantities[line.id] ?? ""}
                          onChange={(e) => setLineQuantity(line.id, e.target.value, remaining)}
                        />
                        <div className="text-xs font-mono">
                          {qty > 0 ? formatMoney(lineTotal, selectedInvoice.currency) : "—"}
                        </div>
                      </div>
                    );
                  })}
                  {(invoiceLines.data ?? []).length === 0 && (
                    <div className="p-4 text-center text-sm text-muted-foreground">
                      Loading invoice lines…
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between text-sm border-t pt-2">
                  <span className="text-muted-foreground">
                    Preview: subtotal {formatMoney(previewSubtotal, selectedInvoice.currency)} + tax{" "}
                    {formatMoney(previewTax, selectedInvoice.currency)}
                  </span>
                  <span className="font-mono font-semibold">
                    {formatMoney(previewTotal, selectedInvoice.currency)}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground -mt-2">
                  This preview mirrors the draft calculation. If a line is fully exhausted by this
                  credit, the exact residual (never more than the original amount) is finalized only
                  when the credit note is posted.
                </p>
                {exceedsNetBalance && (
                  <div className="text-xs text-destructive">
                    This total exceeds the invoice&apos;s remaining net balance and will be rejected
                    when posted. Reduce the quantities above.
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                create.isPending ||
                !invoiceId ||
                selectedLines.length === 0 ||
                !reasonValid ||
                exceedsNetBalance
              }
              onClick={() => create.mutate()}
            >
              Create draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!postTarget} onOpenChange={(v) => !v && setPostTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Post credit note</DialogTitle>
          </DialogHeader>
          {postTarget && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Credit note</span>
                  <div className="font-mono">{postTarget.code}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Invoice</span>
                  <div className="font-mono">{postTarget.invoice?.code ?? "—"}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Customer</span>
                  <div className="truncate">{postTarget.invoice?.bill_to_name ?? "—"}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Total</span>
                  <div className="font-mono">
                    {formatMoney(Number(postTarget.total), postTarget.currency)}
                  </div>
                </div>
              </div>
              <p className="text-xs text-destructive">
                Posting creates a new accounting entry (debiting revenue and tax, crediting accounts
                receivable) against this invoice and cannot be edited afterward. There is currently
                no reversal for a posted credit note.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPostTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={post.isPending}
              onClick={() => postTarget && post.mutate(postTarget.id)}
            >
              <Send className="h-4 w-4 mr-1" /> Post credit note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
