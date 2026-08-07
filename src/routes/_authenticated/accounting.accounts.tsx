import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Boxes } from "lucide-react";
import { toast } from "sonner";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/accounts")({
  head: () => ({ meta: [{ title: "Chart of Accounts · Accounting" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <AccountsPage />
    </AccountingWorkspaceShell>
  ),
});

const TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
type AcctType = (typeof TYPES)[number];

function AccountsPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", type: "asset" as AcctType });

  const accounts = useQuery({
    queryKey: ["accounts", propertyId],
    queryFn: async () => {
      const { data, error } = await supabase.from("accounts")
        .select("*").eq("property_id", propertyId!).order("code");
      if (error) throw error;
      return data;
    },
    enabled: !!propertyId,
  });

  const create = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("accounts").insert({
        property_id: propertyId!, code: form.code, name: form.name, type: form.type,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Account added");
      setOpen(false);
      setForm({ code: "", name: "", type: "asset" });
      qc.invalidateQueries({ queryKey: ["accounts", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from("accounts").update({ is_active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts", propertyId] }),
  });

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property.</div>;

  const grouped = TYPES.map((t) => ({
    type: t,
    items: (accounts.data ?? []).filter((a: any) => a.type === t),
  }));

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-display font-semibold flex items-center gap-2"><Boxes className="h-6 w-6" /> Chart of Accounts</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4 mr-1" /> New account</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add account</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Code</Label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="e.g. 4300" /></div>
              <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Spa Revenue" /></div>
              <div><Label>Type</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as AcctType })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={() => create.mutate()} disabled={!form.code || !form.name || create.isPending}>Add</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {grouped.map((g) => (
        <Card key={g.type}>
          <CardHeader className="pb-2"><CardTitle className="text-sm capitalize">{g.type}</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {g.items.map((a: any) => (
              <div key={a.id} className="flex items-center justify-between border-b py-1.5 last:border-0">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-muted-foreground w-14">{a.code}</span>
                  <span className={a.is_active ? "" : "line-through text-muted-foreground"}>{a.name}</span>
                  {a.system_key && <Badge variant="outline" className="text-[9px]">{a.system_key}</Badge>}
                </div>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => toggle.mutate({ id: a.id, is_active: !a.is_active })}>
                  {a.is_active ? "Deactivate" : "Activate"}
                </Button>
              </div>
            ))}
            {g.items.length === 0 && <div className="text-muted-foreground text-xs">No accounts</div>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
