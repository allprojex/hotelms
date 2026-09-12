import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/rates")({
  head: () => ({ meta: [{ title: "Rate plans" }] }),
  component: RatesPage,
});

function RatesPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();

  const plans = useQuery({
    queryKey: ["rate-plans", propertyId], enabled: !!propertyId,
    queryFn: async () => (await supabase.from("rate_plans").select("*, room_types(name)").eq("property_id", propertyId!).order("start_date")).data,
  });
  const types = useQuery({
    queryKey: ["rt-simple", propertyId], enabled: !!propertyId,
    queryFn: async () => (await supabase.from("room_types").select("id,name,base_rate").eq("property_id", propertyId!)).data,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Rate plans</h1>
          <p className="text-sm text-muted-foreground">Seasonal and promotional pricing.</p>
        </div>
        <RateDialog propertyId={propertyId} types={types.data ?? []} onDone={() => qc.invalidateQueries({ queryKey: ["rate-plans", propertyId] })} />
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead><TableHead>Room type</TableHead><TableHead>Window</TableHead>
              <TableHead>Min stay</TableHead><TableHead className="text-right">Rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.data?.map((p: any) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell>{p.room_types?.name}</TableCell>
                <TableCell>{format(new Date(p.start_date), "dd/MM/yyyy")} → {format(new Date(p.end_date), "dd/MM/yyyy")}</TableCell>
                <TableCell>{p.min_stay}</TableCell>
                <TableCell className="text-right font-semibold">{Number(p.rate).toFixed(2)}</TableCell>
              </TableRow>
            ))}
            {plans.data?.length === 0 && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No rate plans yet.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function RateDialog({ propertyId, types, onDone }: { propertyId: string | null; types: any[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", room_type_id: "", start_date: "", end_date: "", rate: 0, min_stay: 1 });
  async function save() {
    if (!propertyId) return;
    const { error } = await supabase.from("rate_plans").insert({ ...form, property_id: propertyId });
    if (error) return toast.error(error.message);
    toast.success("Rate plan created"); setOpen(false); onDone();
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-1" /> New rate plan</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New rate plan</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><Label>Room type</Label>
            <Select value={form.room_type_id} onValueChange={(v) => setForm({ ...form, room_type_id: v })}>
              <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>{types.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Start</Label><Input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></div>
            <div><Label>End</Label><Input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /></div>
            <div><Label>Rate</Label><Input type="number" step="0.01" value={form.rate} onChange={(e) => setForm({ ...form, rate: +e.target.value })} /></div>
            <div><Label>Min stay</Label><Input type="number" value={form.min_stay} onChange={(e) => setForm({ ...form, min_stay: +e.target.value })} /></div>
          </div>
        </div>
        <DialogFooter><Button onClick={save}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
