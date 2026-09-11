import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { NationalitySelect } from "@/components/nationality-select";
import { GhanaRegionSelect } from "@/components/ghana-region-select";
import { GuestIdTypeSelect } from "@/components/guest-id-type-select";
import { toast } from "sonner";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/guests/$id")({
  head: () => ({ meta: [{ title: "Guest profile" }] }),
  component: GuestPage,
});

function GuestPage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const g = useQuery({ queryKey: ["guest", id], queryFn: async () => (await supabase.from("guests").select("*").eq("id", id).single()).data });
  const history = useQuery({
    queryKey: ["guest-history", id],
    queryFn: async () => (await supabase.from("reservations").select("*, room_types(name)").eq("guest_id", id).order("check_in", { ascending: false })).data,
  });
  const [form, setForm] = useState<any>({});
  useEffect(() => { if (g.data) setForm(g.data); }, [g.data]);

  async function save() {
    const { id: _, created_at, updated_at, created_by, ...patch } = form;
    const { error } = await supabase.from("guests").update(patch).eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Saved"); qc.invalidateQueries({ queryKey: ["guest", id] });
  }

  if (!g.data) return <div className="p-6">Loading…</div>;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{g.data.first_name} {g.data.last_name}</h1>
          <p className="text-sm text-muted-foreground">Guest profile</p>
        </div>
        <Button onClick={save}>Save changes</Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Contact</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <F l="First name" v={form.first_name} on={(v) => setForm({ ...form, first_name: v })} />
            <F l="Last name" v={form.last_name} on={(v) => setForm({ ...form, last_name: v })} />
            <F l="Email" v={form.email} on={(v) => setForm({ ...form, email: v })} />
            <F l="Phone" v={form.phone} on={(v) => setForm({ ...form, phone: v })} />
            <div className="flex items-center gap-2">
              <Switch checked={!!form.vip} onCheckedChange={(v) => setForm({ ...form, vip: v })} />
              <Label>VIP guest</Label>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Identity</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <div>
              <Label>Identification type</Label>
              <GuestIdTypeSelect propertyId={form.property_id ?? null}
                value={form.id_type_id}
                onChange={(id) => setForm({ ...form, id_type_id: id })} />
            </div>
            <F l="ID number" v={form.id_number} on={(v) => setForm({ ...form, id_number: v })} />
            <div>
              <Label>Nationality</Label>
              <NationalitySelect value={form.nationality_code}
                onChange={(code) => setForm({ ...form, nationality_code: code })} />
            </div>
            <div>
              <Label>Region (Ghana)</Label>
              <GhanaRegionSelect value={form.region_code}
                onChange={(r) => setForm({ ...form, region_code: r.code, region_capital: r.capital })} />
            </div>
            <div><Label>Address</Label><Textarea value={form.address ?? ""} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
            <div><Label>Notes</Label><Textarea value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} /></div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Stay history</CardTitle></CardHeader>
        <CardContent>
          {history.data && history.data.length > 0 ? (
            <div className="divide-y">
              {history.data.map((r: any) => (
                <Link key={r.id} to="/reservations/$id" params={{ id: r.id }} className="flex items-center justify-between py-3 hover:bg-muted/50 -mx-3 px-3 rounded">
                  <div>
                    <div className="font-medium">{r.room_types?.name} · <span className="font-mono text-xs">{r.code}</span></div>
                    <div className="text-xs text-muted-foreground">{format(new Date(r.check_in), "dd/MM/yyyy")} → {format(new Date(r.check_out), "dd/MM/yyyy")}</div>
                  </div>
                  <Badge variant="outline">{r.status.replace("_", " ")}</Badge>
                </Link>
              ))}
            </div>
          ) : <p className="py-6 text-center text-sm text-muted-foreground">No stays yet.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function F({ l, v, on }: { l: string; v: any; on: (v: string) => void }) {
  return <div><Label>{l}</Label><Input value={v ?? ""} onChange={(e) => on(e.target.value)} /></div>;
}
