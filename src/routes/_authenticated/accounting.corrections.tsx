/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveProperty } from "@/hooks/use-active-property";
import {
  listExpenseCorrections,
  reviewExpenseCorrection,
  reverseExpense,
} from "@/lib/accounting/expense-corrections.functions";
import { formatMoney } from "@/lib/accounting/domain";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
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
import { Undo2 } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/accounting/corrections")({
  head: () => ({ meta: [{ title: "Expense Corrections · Accounting" }] }),
  component: CorrectionsPage,
});

function ReasonDialog({
  label,
  title,
  onConfirm,
  destructive,
}: {
  label: string;
  title: string;
  onConfirm: (reason: string) => void;
  destructive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={destructive ? "destructive" : "outline"}>
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
            variant={destructive ? "destructive" : "default"}
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

function CorrectionsPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");

  const listFn = useServerFn(listExpenseCorrections);
  const reviewFn = useServerFn(reviewExpenseCorrection);
  const reverseFn = useServerFn(reverseExpense);

  const list = useQuery({
    queryKey: ["expense-corrections", propertyId, status],
    queryFn: () => listFn({ data: { propertyId: propertyId!, status, pageSize: 100 } }),
    enabled: !!propertyId,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["expense-corrections", propertyId] });

  const reviewMut = useMutation({
    mutationFn: (v: { correctionId: string; decision: "approved" | "rejected"; notes: string }) =>
      reviewFn({ data: { propertyId: propertyId!, ...v } }),
    onSuccess: () => {
      toast.success("Correction reviewed");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not review correction"),
  });
  const reverseMut = useMutation({
    mutationFn: (v: { expenseId: string; reason: string; correctionId: string }) =>
      reverseFn({ data: { propertyId: propertyId!, ...v } }),
    onSuccess: () => {
      toast.success("Reversal evidence created");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not reverse"),
  });

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property first.</div>;
  const rows = list.data?.rows ?? [];

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-display font-semibold flex items-center gap-2">
          <Undo2 className="h-6 w-6" /> Expense Corrections
        </h1>
        <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Correction requests</CardTitle>
          <CardDescription>
            Approved expenses stay immutable. A correction request must be approved before a
            reversal can be created — reversals only produce explicit accounting evidence, never a
            claim of an actual payment reversal.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Expense</TableHead>
                <TableHead>Requested by</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Requested</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c: any) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link
                      to="/accounting/expenses/$expenseId"
                      params={{ expenseId: c.expense_id }}
                      className="font-mono text-xs hover:underline"
                    >
                      {c.expense?.expense_number ?? c.expense_id.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">{c.requester?.full_name ?? "—"}</TableCell>
                  <TableCell className="text-xs max-w-xs truncate">{c.reason}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        c.status === "approved"
                          ? "default"
                          : c.status === "rejected"
                            ? "destructive"
                            : "outline"
                      }
                    >
                      {c.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {format(new Date(c.requested_at), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell className="text-right space-x-1">
                    {c.status === "pending" && (
                      <>
                        <ReasonDialog
                          label="Approve"
                          title="Approve correction"
                          onConfirm={(notes) =>
                            reviewMut.mutate({ correctionId: c.id, decision: "approved", notes })
                          }
                        />
                        <ReasonDialog
                          label="Reject"
                          title="Reject correction"
                          destructive
                          onConfirm={(notes) =>
                            reviewMut.mutate({ correctionId: c.id, decision: "rejected", notes })
                          }
                        />
                      </>
                    )}
                    {c.status === "approved" && !c.reversal_expense_id && (
                      <ReasonDialog
                        label="Create reversal"
                        title="Create reversal evidence"
                        destructive
                        onConfirm={(reason) =>
                          reverseMut.mutate({ expenseId: c.expense_id, reason, correctionId: c.id })
                        }
                      />
                    )}
                    {c.reversal_expense_id && (
                      <span className="text-xs text-muted-foreground">Reversed</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                    No correction requests found.
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
