import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Pencil, Images } from "lucide-react";
import { toast } from "sonner";
import { RoomTypeCoverThumbnail } from "@/components/gallery/room-type-gallery-preview";

export const Route = createFileRoute("/_authenticated/rooms/types")({
  head: () => ({ meta: [{ title: "Room types" }] }),
  component: TypesPage,
});

function TypesPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["room-types", propertyId],
    enabled: !!propertyId,
    queryFn: async () => (await supabase.from("room_types").select("*").eq("property_id", propertyId!).order("base_rate")).data,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Room types</h1>
          <p className="text-sm text-muted-foreground">Categories, occupancy and base rates.</p>
        </div>
        <TypeDialog propertyId={propertyId} onDone={() => qc.invalidateQueries({ queryKey: ["room-types", propertyId] })} />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {list.data?.map((t: any) => (
          <Card key={t.id}>
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <RoomTypeCoverThumbnail roomTypeId={t.id} className="h-16 w-16 shrink-0" />
                <div className="flex-1">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">{t.code}</div>
                  <div className="text-lg font-semibold">{t.name}</div>
                </div>
                <TypeDialog propertyId={propertyId} existing={t} trigger={<Button size="icon" variant="ghost"><Pencil className="h-4 w-4" /></Button>} onDone={() => qc.invalidateQueries({ queryKey: ["room-types", propertyId] })} />
              </div>
              <p className="mt-2 text-sm text-muted-foreground line-clamp-2">{t.description}</p>
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Occupancy {t.base_occupancy}/{t.max_occupancy}</span>
                <span className="font-semibold">{Number(t.base_rate).toFixed(2)}/night</span>
              </div>
              <Button asChild size="sm" variant="outline" className="mt-3 w-full">
                <Link to="/gallery" search={{ context: "room_type", roomTypeId: t.id } as never}>
                  <Images className="h-3.5 w-3.5 mr-1" /> Manage photos
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function TypeDialog({ propertyId, existing, trigger, onDone }: { propertyId: string | null; existing?: any; trigger?: React.ReactNode; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    code: existing?.code ?? "", name: existing?.name ?? "", description: existing?.description ?? "",
    base_occupancy: existing?.base_occupancy ?? 2, max_occupancy: existing?.max_occupancy ?? 2, base_rate: existing?.base_rate ?? 100,
  });
  async function save() {
    if (!propertyId) return;
    const payload: any = { ...form, property_id: propertyId };
    const q = existing ? supabase.from("room_types").update(payload).eq("id", existing.id) : supabase.from("room_types").insert(payload);
    const { error } = await q;
    if (error) return toast.error(error.message);
    toast.success("Saved"); setOpen(false); onDone();
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger ?? <Button><Plus className="h-4 w-4 mr-1" /> New type</Button>}</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{existing ? "Edit" : "New"} room type</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label>Code</Label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
          <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="sm:col-span-2"><Label>Description</Label><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div><Label>Base occupancy</Label><Input type="number" value={form.base_occupancy} onChange={(e) => setForm({ ...form, base_occupancy: +e.target.value })} /></div>
          <div><Label>Max occupancy</Label><Input type="number" value={form.max_occupancy} onChange={(e) => setForm({ ...form, max_occupancy: +e.target.value })} /></div>
          <div className="sm:col-span-2"><Label>Base rate</Label><Input type="number" step="0.01" value={form.base_rate} onChange={(e) => setForm({ ...form, base_rate: +e.target.value })} /></div>
        </div>
        <DialogFooter><Button onClick={save}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
