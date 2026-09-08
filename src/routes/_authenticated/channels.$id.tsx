import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { importQueuedReservation } from "@/lib/channels.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Download, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { useState } from "react";

export const Route = createFileRoute("/_authenticated/channels/$id")({
  head: () => ({ meta: [{ title: pageTitle("Channel") }] }),
  component: ChannelDetail,
  errorComponent: ({ error }) => <div className="p-6 text-sm text-destructive">{error.message}</div>,
  notFoundComponent: () => <div className="p-6">Channel not found</div>,
});

function ChannelDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();

  const channel = useQuery({
    queryKey: ["channel", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("channels").select("*").eq("id", id).single();
      if (error) throw error;
      return data;
    },
  });

  const roomTypes = useQuery({
    queryKey: ["channel-room-types", channel.data?.property_id],
    queryFn: async () => {
      const { data } = await supabase.from("room_types").select("id,name,code").eq("property_id", channel.data!.property_id);
      return data ?? [];
    },
    enabled: !!channel.data?.property_id,
  });

  const mappings = useQuery({
    queryKey: ["channel-room-mappings", id],
    queryFn: async () => {
      const { data } = await supabase
        .from("channel_room_mappings")
        .select("id, room_type_id, external_room_code, room_types(name)")
        .eq("channel_id", id);
      return data ?? [];
    },
  });

  const logs = useQuery({
    queryKey: ["channel-logs", id],
    queryFn: async () => {
      const { data } = await supabase
        .from("channel_sync_logs")
        .select("*")
        .eq("channel_id", id)
        .order("created_at", { ascending: false })
        .limit(30);
      return data ?? [];
    },
    refetchInterval: 5000,
  });

  const queue = useQuery({
    queryKey: ["channel-queue", id],
    queryFn: async () => {
      const { data } = await supabase
        .from("channel_reservations_queue")
        .select("*")
        .eq("channel_id", id)
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    },
    refetchInterval: 5000,
  });

  const [newMap, setNewMap] = useState({ room_type_id: "", external_room_code: "" });

  const addMap = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("channel_room_mappings").insert({
        channel_id: id,
        room_type_id: newMap.room_type_id,
        external_room_code: newMap.external_room_code,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setNewMap({ room_type_id: "", external_room_code: "" });
      qc.invalidateQueries({ queryKey: ["channel-room-mappings", id] });
      toast.success("Mapping added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const delMap = useMutation({
    mutationFn: async (mid: string) => {
      const { error } = await supabase.from("channel_room_mappings").delete().eq("id", mid);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["channel-room-mappings", id] }),
  });

  const importFn = useServerFn(importQueuedReservation);
  const importMut = useMutation({
    mutationFn: (queueId: string) => importFn({ data: { queueId } }),
    onSuccess: () => {
      toast.success("Reservation imported");
      qc.invalidateQueries({ queryKey: ["channel-queue", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (channel.isLoading) return <div className="p-6">Loading…</div>;
  if (!channel.data) return <div className="p-6">Not found</div>;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm"><Link to="/channels"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Link></Button>
        <div>
          <h1 className="font-display text-2xl font-semibold">{channel.data.name}</h1>
          <p className="text-xs text-muted-foreground">{channel.data.type} · Hotel {channel.data.external_hotel_id ?? "—"}</p>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Room type mappings</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Internal room type</TableHead>
                <TableHead>External room code</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {mappings.data?.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{(m.room_types as { name: string } | null)?.name ?? m.room_type_id}</TableCell>
                  <TableCell><code className="text-xs">{m.external_room_code}</code></TableCell>
                  <TableCell><Button size="icon" variant="ghost" onClick={() => delMap.mutate(m.id)}><Trash2 className="h-3.5 w-3.5" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end pt-2 border-t">
            <div>
              <Label className="text-xs">Room type</Label>
              <select className="flex h-9 w-full rounded-md border bg-background px-2 text-sm" value={newMap.room_type_id} onChange={(e) => setNewMap({ ...newMap, room_type_id: e.target.value })}>
                <option value="">Select…</option>
                {roomTypes.data?.map((rt) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
              </select>
            </div>
            <div><Label className="text-xs">External code</Label><Input value={newMap.external_room_code} onChange={(e) => setNewMap({ ...newMap, external_room_code: e.target.value })} placeholder="BDC-DBL-01" /></div>
            <Button size="sm" onClick={() => addMap.mutate()} disabled={!newMap.room_type_id || !newMap.external_room_code}><Plus className="h-3.5 w-3.5 mr-1" /> Add</Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Sync activity</CardTitle></CardHeader>
          <CardContent className="space-y-2 max-h-96 overflow-auto">
            {logs.data?.length === 0 && <div className="text-sm text-muted-foreground">No sync activity yet.</div>}
            {logs.data?.map((l) => (
              <div key={l.id} className="flex items-start gap-3 text-sm border-b pb-2 last:border-0">
                <Badge variant="outline" className={l.status === "success" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : l.status === "failed" ? "bg-destructive/15 text-destructive" : ""}>{l.status}</Badge>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-xs">{l.direction} · {l.duration_ms}ms</div>
                  <div className="text-xs text-muted-foreground truncate">{l.message}</div>
                </div>
                <div className="text-[10px] text-muted-foreground">{format(new Date(l.created_at), "HH:mm:ss")}</div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Inbound reservations queue</CardTitle></CardHeader>
          <CardContent className="space-y-2 max-h-96 overflow-auto">
            {queue.data?.length === 0 && <div className="text-sm text-muted-foreground">Queue is empty.</div>}
            {queue.data?.map((q) => {
              const payload = q.payload as Record<string, unknown>;
              return (
                <div key={q.id} className="flex items-start gap-3 text-sm border-b pb-2 last:border-0">
                  <Badge variant="outline" className={q.status === "imported" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : q.status === "pending" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-muted"}>{q.status}</Badge>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-xs">{String(payload.first_name)} {String(payload.last_name)}</div>
                    <div className="text-xs text-muted-foreground">{String(payload.check_in)} → {String(payload.check_out)} · {String(payload.adults)}A · ${String(payload.total)}</div>
                    <div className="text-[10px] text-muted-foreground">{q.external_ref}</div>
                  </div>
                  {q.status === "pending" && (
                    <Button size="sm" variant="outline" onClick={() => importMut.mutate(q.id)} disabled={importMut.isPending}>
                      <Download className="h-3 w-3 mr-1" /> Import
                    </Button>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
