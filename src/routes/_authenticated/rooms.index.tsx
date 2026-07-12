import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertCircle, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/rooms/")({
  head: () => ({ meta: [{ title: "Rooms" }] }),
  component: RoomsPage,
});

const STATUS_MAP: Record<string, string> = {
  available: "secondary", occupied: "default", blocked: "outline", out_of_order: "destructive",
};
const HK_MAP: Record<string, string> = {
  clean: "secondary", inspected: "default", dirty: "outline", maintenance: "destructive",
};

function RoomsPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();

  const rooms = useQuery({
    queryKey: ["rooms", propertyId],
    enabled: !!propertyId,
    queryFn: async () => {
      const { data, error } = await supabase.from("rooms").select("*, room_types(name)").eq("property_id", propertyId!).order("number");
      if (error) throw error;
      return data;
    },
  });

  const roomTypes = useQuery({
    queryKey: ["room-types", propertyId],
    enabled: !!propertyId,
    queryFn: async () => {
      const { data, error } = await supabase.from("room_types").select("id, name").eq("property_id", propertyId!).order("name");
      if (error) throw error;
      return data;
    },
  });

  async function update(id: string, patch: any) {
    const { error } = await supabase.from("rooms").update(patch).eq("id", id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["rooms", propertyId] });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Rooms</h1>
          <p className="text-sm text-muted-foreground">Manage room status and housekeeping state.</p>
        </div>
        <RoomDialog propertyId={propertyId} roomTypes={roomTypes.data ?? []} onDone={() => qc.invalidateQueries({ queryKey: ["rooms", propertyId] })} />
      </div>
      {rooms.isLoading && <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Loading rooms…</div>}
      {rooms.isError && <Card className="flex items-center gap-3 border-destructive p-5 text-destructive"><AlertCircle className="h-5 w-5" /><div><div className="font-medium">Rooms could not be loaded</div><div className="text-sm">{rooms.error.message}</div></div></Card>}
      {!rooms.isLoading && !rooms.isError && rooms.data?.length === 0 && (
        <Card className="p-8 text-center">
          <h2 className="font-semibold">No rooms have been configured</h2>
          <p className="mt-1 text-sm text-muted-foreground">Create a room type first, then add the hotel's room numbers here.</p>
          <div className="mt-4 flex justify-center gap-2">
            <Button asChild variant="outline"><Link to="/rooms/types">Set up room types</Link></Button>
            <RoomDialog propertyId={propertyId} roomTypes={roomTypes.data ?? []} onDone={() => qc.invalidateQueries({ queryKey: ["rooms", propertyId] })} />
          </div>
        </Card>
      )}
      {!rooms.isLoading && !rooms.isError && !!rooms.data?.length && (
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Room</TableHead><TableHead>Type</TableHead><TableHead>Floor</TableHead>
              <TableHead>Status</TableHead><TableHead>Housekeeping</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rooms.data?.map((r: any) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.number}</TableCell>
                <TableCell>{r.room_types?.name}</TableCell>
                <TableCell>{r.floor ?? "—"}</TableCell>
                <TableCell>
                  <Select value={r.status} onValueChange={(v) => update(r.id, { status: v })}>
                    <SelectTrigger className="h-8 w-[140px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="available">Available</SelectItem>
                      <SelectItem value="occupied">Occupied</SelectItem>
                      <SelectItem value="blocked">Blocked</SelectItem>
                      <SelectItem value="out_of_order">Out of order</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Select value={r.housekeeping_status} onValueChange={(v) => update(r.id, { housekeeping_status: v })}>
                    <SelectTrigger className="h-8 w-[140px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="clean">Clean</SelectItem>
                      <SelectItem value="inspected">Inspected</SelectItem>
                      <SelectItem value="dirty">Dirty</SelectItem>
                      <SelectItem value="maintenance">Maintenance</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      )}
    </div>
  );
}

function RoomDialog({ propertyId, roomTypes, onDone }: { propertyId: string | null; roomTypes: Array<{ id: string; name: string }>; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ number: "", floor: "", room_type_id: "" });

  async function save() {
    if (!propertyId || !form.number.trim() || !form.room_type_id) return;
    setSaving(true);
    const { error } = await supabase.from("rooms").insert({
      property_id: propertyId,
      room_type_id: form.room_type_id,
      number: form.number.trim(),
      floor: form.floor.trim() || null,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success(`Room ${form.number.trim()} added`);
    setForm({ number: "", floor: "", room_type_id: "" });
    setOpen(false);
    onDone();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button disabled={!propertyId || roomTypes.length === 0}><Plus className="mr-1 h-4 w-4" /> Add room</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add room</DialogTitle></DialogHeader>
        <div className="grid gap-4">
          <div><Label htmlFor="room-number">Room number</Label><Input id="room-number" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} placeholder="101" /></div>
          <div><Label htmlFor="room-floor">Floor</Label><Input id="room-floor" value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} placeholder="1" /></div>
          <div><Label>Room type</Label><Select value={form.room_type_id} onValueChange={(value) => setForm({ ...form, room_type_id: value })}><SelectTrigger><SelectValue placeholder="Select room type" /></SelectTrigger><SelectContent>{roomTypes.map((type) => <SelectItem key={type.id} value={type.id}>{type.name}</SelectItem>)}</SelectContent></Select></div>
        </div>
        <DialogFooter><Button onClick={save} disabled={saving || !form.number.trim() || !form.room_type_id}>{saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save room</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
