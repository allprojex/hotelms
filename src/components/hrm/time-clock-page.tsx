import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Coffee, LogIn, LogOut, Play, Timer } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataQueryState } from "@/components/shared/data-query-controls";
import { HrmPageHeader } from "@/components/hrm/shared";
import { useActiveProperty } from "@/hooks/use-active-property";
import { elapsedMinutes } from "@/lib/hrm/attendance-domain";
import { getTimeClockState, recordTimeClockEvent } from "@/lib/hrm/attendance.functions";

type ClockState = {
  employee: { first_name: string; last_name: string; employee_number: string };
  timezone: string;
  currentStatus: string;
  openSince: string | null;
  currentRoster: {
    duty_date: string;
    starts_at: string;
    ends_at: string;
    shift?: { name: string };
  } | null;
  recentEvents: { id: string; event_type: string; event_at: string; business_date: string }[];
};

export function TimeClockPage() {
  const propertyId = useActiveProperty();
  const getState = useServerFn(getTimeClockState);
  const record = useServerFn(recordTimeClockEvent);
  const queryClient = useQueryClient();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const query = useQuery({
    queryKey: ["time-clock", propertyId],
    enabled: !!propertyId,
    queryFn: () => getState({ data: { propertyId: propertyId! } }) as Promise<ClockState>,
  });
  const mutation = useMutation({
    mutationFn: (eventType: string) =>
      record({ data: { propertyId: propertyId!, eventType, requestId: crypto.randomUUID() } }),
    onSuccess: () => {
      toast.success("Time recorded using the server clock");
      queryClient.invalidateQueries({ queryKey: ["time-clock"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Unable to record time"),
  });
  const status = query.data?.currentStatus ?? "not_clocked_in";
  const actions = useMemo(() => {
    if (status === "not_clocked_in" || status === "clock_out") return ["clock_in"];
    if (status === "break_start") return ["break_end"];
    return ["break_start", "clock_out"];
  }, [status]);
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <HrmPageHeader
        title="Staff Time Clock"
        description="Server-confirmed attendance events in your property timezone."
      />
      <DataQueryState
        loading={query.isLoading}
        error={query.error}
        empty={!query.data}
        emptyTitle="Employee link required"
      >
        {query.data && (
          <>
            <Card className="space-y-5 p-6 text-center">
              <div>
                <p className="text-sm text-muted-foreground">
                  {query.data.employee.employee_number}
                </p>
                <h2 className="text-2xl font-semibold">
                  {query.data.employee.first_name} {query.data.employee.last_name}
                </h2>
                <Badge
                  className="mt-2"
                  variant={status === "break_start" ? "secondary" : "default"}
                >
                  {status.replaceAll("_", " ")}
                </Badge>
              </div>
              <div className="rounded-xl bg-muted p-5">
                <Timer className="mx-auto mb-2 h-7 w-7" />
                <p className="text-4xl font-semibold tabular-nums">
                  {elapsedMinutes(query.data.openSince)} min
                </p>
                <p className="text-xs text-muted-foreground">
                  Elapsed since the most recent event · {query.data.timezone}
                </p>
              </div>
              {query.data.currentRoster && (
                <div className="text-sm">
                  <p className="font-medium">
                    {query.data.currentRoster.shift?.name ?? "Scheduled shift"} ·{" "}
                    {query.data.currentRoster.duty_date}
                  </p>
                  <p className="text-muted-foreground">
                    {formatTime(query.data.currentRoster.starts_at, query.data.timezone)} –{" "}
                    {formatTime(query.data.currentRoster.ends_at, query.data.timezone)}
                  </p>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {actions.map((action) => (
                  <Button
                    key={action}
                    className="min-h-16 text-base"
                    disabled={mutation.isPending}
                    onClick={() => mutation.mutate(action)}
                  >
                    <ActionIcon action={action} /> {label(action)}
                  </Button>
                ))}
              </div>
              {status === "break_start" && (
                <p className="text-sm text-amber-700">End your open break before clocking out.</p>
              )}
            </Card>
            <Card className="p-4">
              <h3 className="mb-3 font-semibold">Recent events</h3>
              <div className="divide-y">
                {query.data.recentEvents.map((event) => (
                  <div key={event.id} className="flex items-center justify-between py-3 text-sm">
                    <span className="capitalize">{event.event_type.replaceAll("_", " ")}</span>
                    <span className="text-muted-foreground">
                      {formatDateTime(event.event_at, query.data.timezone)}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </DataQueryState>
    </div>
  );
}
function ActionIcon({ action }: { action: string }) {
  if (action === "clock_in") return <LogIn className="mr-2 h-5 w-5" />;
  if (action === "clock_out") return <LogOut className="mr-2 h-5 w-5" />;
  if (action === "break_start") return <Coffee className="mr-2 h-5 w-5" />;
  return <Play className="mr-2 h-5 w-5" />;
}
function label(action: string) {
  return (
    {
      clock_in: "Clock in",
      clock_out: "Clock out",
      break_start: "Start break",
      break_end: "End break",
    } as Record<string, string>
  )[action];
}
function formatTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
function formatDateTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
