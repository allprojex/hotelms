/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveProperty } from "@/hooks/use-active-property";
import {
  listExpenses,
  approveExpense,
  rejectExpense,
  returnExpense,
} from "@/lib/accounting/expenses.functions";
import { formatMoney } from "@/lib/accounting/domain";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/accounting/approvals")({
  head: () => ({ meta: [{ title: "Expense Approvals · Accounting" }] }),
  component: ApprovalsPage,
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
          <DialogDescription>A reason of at least 5 characters is required.</DialogDescription>
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

function ApprovalsPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const listFn = useServerFn(listExpenses);
  const approveFn = useServerFn(approveExpense);
  const rejectFn = useServerFn(rejectExpense);
  const returnFn = useServerFn(returnExpense);

  const queue = useQuery({
    queryKey: ["expense-approval-queue", propertyId],
    queryFn: () =>
      listFn({ data: { propertyId: propertyId!, status: "submitted", pageSize: 100 } }),
    enabled: !!propertyId,
  });
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["expense-approval-queue", propertyId] });

  const approveMut = useMutation({
    mutationFn: (id: string) => approveFn({ data: { propertyId: propertyId!, id } }),
    onSuccess: () => {
      toast.success("Expense approved");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not approve"),
  });
  const rejectMut = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      rejectFn({ data: { propertyId: propertyId!, ...v } }),
    onSuccess: () => {
      toast.success("Expense rejected");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not reject"),
  });
  const returnMut = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      returnFn({ data: { propertyId: propertyId!, ...v } }),
    onSuccess: () => {
      toast.success("Returned for correction");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not return"),
  });

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property first.</div>;
  const rows = queue.data?.rows ?? [];

  return (
    <div className="p-4 md:p-6 space-y-4">
      <h1 className="text-2xl font-display font-semibold flex items-center gap-2">
        <ShieldCheck className="h-6 w-6" /> Expense Approvals
      </h1>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Awaiting approval</CardTitle>
          <CardDescription>Submitters cannot approve their own expenses.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Submitted by</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e: any) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Link
                      to="/accounting/expenses/$expenseId"
                      params={{ expenseId: e.id }}
                      className="font-mono text-xs hover:underline"
                    >
                      {e.expense_number}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">{e.creator?.full_name ?? "—"}</TableCell>
                  <TableCell className="text-xs">{e.category?.name ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatMoney(e.total_amount, e.currency)}
                  </TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button
                      size="sm"
                      disabled={approveMut.isPending}
                      onClick={() => approveMut.mutate(e.id)}
                    >
                      Approve
                    </Button>
                    <ReasonDialog
                      label="Reject"
                      title={`Reject ${e.expense_number}`}
                      destructive
                      onConfirm={(reason) => rejectMut.mutate({ id: e.id, reason })}
                    />
                    <ReasonDialog
                      label="Return"
                      title={`Return ${e.expense_number}`}
                      onConfirm={(reason) => returnMut.mutate({ id: e.id, reason })}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                    Nothing awaiting approval.
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
