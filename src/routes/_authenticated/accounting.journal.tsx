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
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/journal")({
  head: () => ({ meta: [{ title: "Journal · Accounting" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <JournalPage />
    </AccountingWorkspaceShell>
  ),
});

type Line = { account_id: string; debit: string; credit: string; memo: string };

function JournalPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [entryDate, setEntryDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [memo, setMemo] = useState("");
  const [currency, setCurrency] = useState("GHS");
  const [lines, setLines] = useState<Line[]>([
    { account_id: "", debit: "", credit: "", memo: "" },
    { account_id: "", debit: "", credit: "", memo: "" },
  ]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ["accounts-min", propertyId],
    queryFn: async () => {
      const { data } = await supabase.from("accounts")
        .select("id, code, name").eq("property_id", propertyId!).eq("is_active", true).order("code");
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const property = useQuery({
    queryKey: ["property-base", propertyId],
    queryFn: async () => {
      const { data } = await supabase.from("properties").select("base_currency").eq("id", propertyId!).single();
      return data;
    },
    enabled: !!propertyId,
  });

  const entries = useQuery({
    queryKey: ["journal", propertyId],
    queryFn: async () => {
      const { data } = await supabase.from("journal_entries")
        .select("id, entry_date, memo, source, source_ref, currency, posted_at, is_reversal_of")
        .eq("property_id", propertyId!)
        .order("entry_date", { ascending: false })
        .order("posted_at", { ascending: false })
        .limit(100);
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const entryLines = useQuery({
    queryKey: ["journal-lines", expanded],
    queryFn: async () => {
      const { data } = await supabase.from("journal_lines")
        .select("*, accounts(code, name)").eq("entry_id", expanded!);
      return data ?? [];
    },
    enabled: !!expanded,
  });

  const totalDr = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
  const totalCr = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  const balanced = Math.abs(totalDr - totalCr) < 0.005 && totalDr > 0;

  const post = useMutation({
    mutationFn: async () => {
      const valid = lines.filter((l) => l.account_id && (parseFloat(l.debit) > 0 || parseFloat(l.credit) > 0));
      const { data, error } = await supabase.rpc("post_journal", {
        _property_id: propertyId!,
        _entry_date: entryDate,
        _currency: currency,
        _memo: (memo || null) as unknown as string,
        _source: "manual",
        _source_ref: (null as unknown) as string,

        _lines: valid.map((l) => ({
          account_id: l.account_id,
          debit: parseFloat(l.debit) || 0,
          credit: parseFloat(l.credit) || 0,
          memo: l.memo || null,
        })),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Entry posted");
      setOpen(false);
      setMemo("");
      setLines([{ account_id: "", debit: "", credit: "", memo: "" }, { account_id: "", debit: "", credit: "", memo: "" }]);
      qc.invalidateQueries({ queryKey: ["journal", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reverse = useMutation({
    mutationFn: async (entryId: string) => {
      const { data: lns } = await supabase.from("journal_lines").select("*").eq("entry_id", entryId);
      const { data: entry } = await supabase.from("journal_entries").select("*").eq("id", entryId).single();
      if (!lns || !entry) throw new Error("Entry not found");
      const { error } = await supabase.rpc("post_journal", {
        _property_id: propertyId!,
        _entry_date: format(new Date(), "yyyy-MM-dd"),
        _currency: entry.currency,
        _memo: `Reversal of ${entry.memo ?? entryId}`,
        _source: "manual",
        _source_ref: entryId,
        _lines: lns.map((l: any) => ({
          account_id: l.account_id, debit: Number(l.credit), credit: Number(l.debit), memo: `Reverse: ${l.memo ?? ""}`,
        })),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Reversal posted");
      qc.invalidateQueries({ queryKey: ["journal", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property.</div>;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display font-semibold flex items-center gap-2"><ClipboardList className="h-6 w-6" /> Journal</h1>
          <p className="text-xs text-muted-foreground">Base currency: {property.data?.base_currency ?? "GHS"}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4 mr-1" /> New entry</Button></DialogTrigger>
          <DialogContent className="max-w-3xl">
            <DialogHeader><DialogTitle>New journal entry</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div><Label>Date</Label><Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} /></div>
                <div><Label>Currency</Label><Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></div>
                <div className="col-span-1"><Label>Memo</Label><Input value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
              </div>
              <div className="border rounded-md">
                <div className="grid grid-cols-[1fr_100px_100px_1fr_32px] gap-2 p-2 text-xs font-medium bg-muted/50 border-b">
                  <div>Account</div><div>Debit</div><div>Credit</div><div>Memo</div><div></div>
                </div>
                {lines.map((line, i) => (
                  <div key={i} className="grid grid-cols-[1fr_100px_100px_1fr_32px] gap-2 p-2 border-b last:border-0">
                    <Select value={line.account_id} onValueChange={(v) => { const c = [...lines]; c[i].account_id = v; setLines(c); }}>
                      <SelectTrigger className="h-8"><SelectValue placeholder="Account…" /></SelectTrigger>
                      <SelectContent>
                        {(accounts.data ?? []).map((a: any) => (
                          <SelectItem key={a.id} value={a.id}>{a.code} · {a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input className="h-8" type="number" value={line.debit} onChange={(e) => { const c = [...lines]; c[i].debit = e.target.value; if (e.target.value) c[i].credit = ""; setLines(c); }} />
                    <Input className="h-8" type="number" value={line.credit} onChange={(e) => { const c = [...lines]; c[i].credit = e.target.value; if (e.target.value) c[i].debit = ""; setLines(c); }} />
                    <Input className="h-8" value={line.memo} onChange={(e) => { const c = [...lines]; c[i].memo = e.target.value; setLines(c); }} />
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
                <div className="p-2 flex items-center justify-between text-xs">
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => setLines([...lines, { account_id: "", debit: "", credit: "", memo: "" }])}>+ Line</Button>
                  <div className="flex gap-4 font-mono">
                    <span>DR {totalDr.toFixed(2)}</span>
                    <span>CR {totalCr.toFixed(2)}</span>
                    <Badge variant={balanced ? "outline" : "destructive"} className={balanced ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : ""}>
                      {balanced ? "Balanced" : `Off by ${Math.abs(totalDr - totalCr).toFixed(2)}`}
                    </Badge>
                  </div>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={!balanced || post.isPending} onClick={() => post.mutate()}>Post entry</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          {(entries.data ?? []).map((e: any) => (
            <div key={e.id} className="border-b last:border-0">
              <div className="flex items-center justify-between p-3 hover:bg-muted/30 cursor-pointer" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-xs text-muted-foreground w-24">{e.entry_date}</span>
                  <Badge variant="outline" className="text-[10px] uppercase">{e.source}</Badge>
                  <span className="truncate">{e.memo ?? "(no memo)"}</span>
                  {e.is_reversal_of && <Badge variant="outline" className="text-[9px]">reversal</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-muted-foreground">{e.currency}</span>
                  {e.source === "manual" && !e.is_reversal_of && (
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={(ev) => { ev.stopPropagation(); reverse.mutate(e.id); }}>Reverse</Button>
                  )}
                </div>
              </div>
              {expanded === e.id && (
                <div className="bg-muted/20 border-t p-3 text-xs space-y-1">
                  {(entryLines.data ?? []).map((l: any) => (
                    <div key={l.id} className="grid grid-cols-[1fr_80px_80px_1fr] gap-2 font-mono">
                      <span>{l.accounts?.code} · {l.accounts?.name}</span>
                      <span className="text-right">{Number(l.debit) > 0 ? Number(l.debit).toFixed(2) : ""}</span>
                      <span className="text-right">{Number(l.credit) > 0 ? Number(l.credit).toFixed(2) : ""}</span>
                      <span className="text-muted-foreground truncate">{l.memo}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {(entries.data ?? []).length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No journal entries yet.</div>}
        </CardContent>
      </Card>
    </div>
  );
}
