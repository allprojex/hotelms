import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Download, FileText, Printer } from "lucide-react";
import {
  getArCustomerStatement,
  type ArCustomerStatementResult,
} from "@/lib/accounting/ar-statements.functions";
import { renderArCustomerStatementPdf } from "@/lib/accounting/ar-statement-pdf.functions";
import { formatMoney } from "@/lib/accounting/domain";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ArCustomerSummary = {
  id: string;
  account_code: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
};

function firstOfMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function csvCell(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function exportStatementCsv(statement: ArCustomerStatementResult) {
  const header = [
    "Currency",
    "Date",
    "Type",
    "Reference",
    "Description",
    "Debit",
    "Credit",
    "Balance",
  ];
  const rows: string[][] = [];
  for (const section of statement.sections) {
    rows.push([
      section.currency,
      "",
      "Opening balance",
      "",
      "",
      "",
      "",
      String(section.openingBalance),
    ]);
    for (const t of section.transactions) {
      rows.push([
        section.currency,
        t.date,
        t.type,
        t.reference,
        t.description,
        t.debit ? String(t.debit) : "",
        t.credit ? String(t.credit) : "",
        String(t.runningBalance),
      ]);
    }
    rows.push([
      section.currency,
      "",
      "Closing balance",
      "",
      "",
      "",
      "",
      String(section.closingBalance),
    ]);
  }
  const csv = [header.join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `statement-${statement.customer.accountCode}-${statement.from}-to-${statement.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ArCustomerStatementView({
  propertyId,
  customer,
  open,
  onOpenChange,
}: {
  propertyId: string;
  customer: ArCustomerSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const statementFn = useServerFn(getArCustomerStatement);
  const printFn = useServerFn(renderArCustomerStatementPdf);

  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(today);
  const [printing, setPrinting] = useState(false);

  const dateRangeValid = from <= to;

  const statement = useQuery({
    queryKey: ["ar-customer-statement", propertyId, customer?.id, from, to],
    queryFn: () => statementFn({ data: { propertyId, customerId: customer!.id, from, to } }),
    enabled: open && !!customer && dateRangeValid,
  });

  async function handlePrint() {
    if (!customer) return;
    setPrinting(true);
    // Reserve the browser target while the click still has user activation —
    // a synthetic download started after the server round-trip may be
    // blocked silently once transient activation has expired.
    const pdfWindow = window.open("", "_blank");
    try {
      if (!pdfWindow) throw new Error("PDF window was blocked. Allow pop-ups and try again.");
      pdfWindow.opener = null;
      pdfWindow.document.title = "Preparing statement…";
      const res = await printFn({ data: { propertyId, customerId: customer.id, from, to } });
      const bin = atob(res.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: res.mime });
      const url = URL.createObjectURL(blob);
      pdfWindow.document.title = res.filename;
      pdfWindow.location.href = url;
    } catch (error) {
      pdfWindow?.close();
      toast.error(error instanceof Error ? error.message : "Could not generate statement PDF");
    } finally {
      setPrinting(false);
    }
  }

  const data = statement.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" /> Statement
            {customer && (
              <span className="font-mono text-sm text-muted-foreground">
                {customer.account_code}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {customer && (
          <div className="text-sm border rounded-md p-3 space-y-0.5">
            <div className="font-medium">{customer.name}</div>
            {customer.email && <div className="text-muted-foreground">{customer.email}</div>}
            {customer.address && (
              <div className="text-muted-foreground whitespace-pre-wrap">{customer.address}</div>
            )}
          </div>
        )}

        <div className="flex items-end gap-3">
          <div>
            <Label className="text-xs">From</Label>
            <Input
              className="h-8"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Input className="h-8" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            disabled={!data || data.sections.length === 0}
            onClick={() => data && exportStatementCsv(data)}
          >
            <Download className="h-3.5 w-3.5 mr-1" /> CSV
          </Button>
          <Button size="sm" disabled={printing || !dateRangeValid} onClick={handlePrint}>
            <Printer className="h-3.5 w-3.5 mr-1" /> {printing ? "Preparing…" : "Print PDF"}
          </Button>
        </div>

        {!dateRangeValid && (
          <p className="text-xs text-destructive">From date must not be after To date.</p>
        )}

        <div className="space-y-6 max-h-[55vh] overflow-y-auto">
          {statement.isLoading && (
            <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
          )}
          {statement.error && (
            <p className="text-sm text-destructive py-6 text-center">
              {(statement.error as Error).message}
            </p>
          )}
          {data && data.sections.length === 0 && (
            <p className="text-sm text-muted-foreground py-10 text-center">
              No AR activity for this customer in the selected period.
            </p>
          )}
          {data?.sections.map((section) => (
            <div key={section.currency} className="space-y-2">
              <div className="flex items-center justify-between">
                <Badge variant="outline" className="font-mono">
                  {section.currency}
                </Badge>
                <div className="text-sm">
                  Opening balance:{" "}
                  <span className="font-mono">
                    {formatMoney(section.openingBalance, section.currency)}
                  </span>
                </div>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {section.transactions.map((t, i) => (
                    <TableRow key={`${t.type}-${t.reference}-${i}`}>
                      <TableCell className="text-xs">{t.date}</TableCell>
                      <TableCell className="text-xs capitalize">{t.type}</TableCell>
                      <TableCell className="font-mono text-xs">{t.reference}</TableCell>
                      <TableCell className="text-xs truncate max-w-[200px]">
                        {t.description}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {t.debit ? formatMoney(t.debit, section.currency) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {t.credit ? formatMoney(t.credit, section.currency) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatMoney(t.runningBalance, section.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {section.transactions.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="text-center text-xs text-muted-foreground py-6"
                      >
                        No transactions in this period.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              <div className="flex justify-end gap-6 text-sm">
                <div>
                  Total debits:{" "}
                  <span className="font-mono">
                    {formatMoney(section.totalDebits, section.currency)}
                  </span>
                </div>
                <div>
                  Total credits:{" "}
                  <span className="font-mono">
                    {formatMoney(section.totalCredits, section.currency)}
                  </span>
                </div>
                <div className="font-medium">
                  Closing balance:{" "}
                  <span className="font-mono">
                    {formatMoney(section.closingBalance, section.currency)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
