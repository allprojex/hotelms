/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveProperty } from "@/hooks/use-active-property";
import {
  listFinancialPeriods,
  openFinancialPeriod,
  closeFinancialPeriod,
  reopenFinancialPeriod,
} from "@/lib/accounting/financial-periods.functions";
import { FINANCIAL_PERIOD_STATUS_LABELS } from "@/lib/accounting/domain";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Lock, Unlock, CalendarDays } from "lucide-react";
import { toast } from "sonner";
import { format, startOfMonth, endOfMonth } from "date-fns";

export const Route = createFileRoute("/_authenticated/accounting/periods")({
  head: () => ({ meta: [{ title: "Financial Periods · Accounting" }] }),
  component: PeriodsPage,
});

function statusBadge(status: string) {
  const variant = status === "open" ? "default" : status === "closed" ? "secondary" : "outline";
  return <Badge variant={variant as any}>{FINANCIAL_PERIOD_STATUS_LABELS[status] ?? status}</Badge>;
}

function PeriodsPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: format(new Date(), "MMMM yyyy"),
    code: "",
    startDate: format(startOfMonth(new Date()), "yyyy-MM-dd"),
    endDate: format(endOfMonth(new Date()), "yyyy-MM-dd"),
  });
  const [reopenTarget, setReopenTarget] = useState<any | null>(null);
  const [reopenReason, setReopenReason] = useState("");

  const listFn = useServerFn(listFinancialPeriods);
  const openFn = useServerFn(openFinancialPeriod);
  const closeFn = useServerFn(closeFinancialPeriod);
  const reopenFn = useServerFn(reopenFinancialPeriod);

  const periods = useQuery({
    queryKey: ["financial-periods", propertyId],
    queryFn: () => listFn({ data: { propertyId: propertyId! } }),
    enabled: !!propertyId,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["financial-periods", propertyId] });

  const openMut = useMutation({
    mutationFn: () => openFn({ data: { propertyId: propertyId!, ...form } }),
    onSuccess: () => {
      toast.success("Financial period opened");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not open period"),
  });
  const closeMut = useMutation({
    mutationFn: (periodId: string) => closeFn({ data: { propertyId: propertyId!, periodId } }),
    onSuccess: () => {
      toast.success("Financial period closed");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not close period"),
  });
  const reopenMut = useMutation({
    mutationFn: () =>
      reopenFn({
        data: { propertyId: propertyId!, periodId: reopenTarget.id, reason: reopenReason },
      }),
    onSuccess: () => {
      toast.success("Financial period reopened");
      setReopenTarget(null);
      setReopenReason("");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not reopen period"),
  });

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property.</div>;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <h1 className="text-2xl font-display font-semibold flex items-center gap-2">
        <CalendarDays className="h-6 w-6" /> Financial Periods
      </h1>
      <p className="text-sm text-muted-foreground">
        Closing a period blocks ordinary expense creation and editing within its date range.
        Approved expenses in a closed period remain visible. This does not close payroll or hotel
        operational periods.
      </p>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Open a new financial period</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 items-end flex-wrap">
            <div>
              <Label className="text-xs">Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-40"
              />
            </div>
            <div>
              <Label className="text-xs">Code</Label>
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                className="w-32"
                placeholder="optional"
              />
            </div>
            <div>
              <Label className="text-xs">Start</Label>
              <Input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              />
            </div>
            <div>
              <Label className="text-xs">End</Label>
              <Input
                type="date"
                value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
              />
            </div>
            <Button onClick={() => openMut.mutate()} disabled={openMut.isPending}>
              {openMut.isPending ? "Opening…" : "Open period"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Periods</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {(periods.data ?? []).map((p: any) => (
            <div
              key={p.id}
              className="flex items-center justify-between py-2 border-b last:border-0 gap-3 flex-wrap"
            >
              <div className="flex items-center gap-3">
                <span className="font-medium">{p.name ?? "—"}</span>
                {p.code && (
                  <span className="font-mono text-xs text-muted-foreground">{p.code}</span>
                )}
                <span className="font-mono text-xs">
                  {p.start_date} → {p.end_date}
                </span>
                {statusBadge(p.status)}
                {p.reopen_reason && (
                  <span className="text-xs text-muted-foreground">reopened: {p.reopen_reason}</span>
                )}
              </div>
              {p.status === "open" && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="outline">
                      <Lock className="h-3 w-3 mr-1" /> Close
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Close this financial period?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Ordinary users will no longer be able to create or edit expenses dated
                        within {p.start_date} to {p.end_date}. Approved expenses remain visible and
                        this can be reopened later with a reason.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => closeMut.mutate(p.id)}>
                        Close period
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
              {p.status === "closed" && (
                <Button size="sm" variant="outline" onClick={() => setReopenTarget(p)}>
                  <Unlock className="h-3 w-3 mr-1" /> Reopen
                </Button>
              )}
            </div>
          ))}
          {(periods.data ?? []).length === 0 && (
            <div className="text-muted-foreground text-xs py-3">No financial periods yet.</div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!reopenTarget} onOpenChange={(o) => !o && setReopenTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen {reopenTarget?.name ?? "period"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Reason (required)</Label>
            <Textarea
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              rows={3}
              placeholder="Why is this period being reopened?"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={reopenReason.trim().length < 5 || reopenMut.isPending}
              onClick={() => reopenMut.mutate()}
            >
              {reopenMut.isPending ? "Reopening…" : "Reopen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
