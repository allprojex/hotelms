import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Settings2 } from "lucide-react";
import { toast } from "sonner";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/posting-rules")({
  head: () => ({ meta: [{ title: "Posting Rules · Accounting" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <PostingRulesPage />
    </AccountingWorkspaceShell>
  ),
});

const RULES: { key: string; label: string; group: string; fallback: string }[] = [
  { group: "Folio (Reservation checkout)", key: "folio_ar", label: "Receivable / Cash on checkout", fallback: "ar" },
  { group: "Folio (Reservation checkout)", key: "folio_room_revenue", label: "Room revenue", fallback: "room_revenue" },
  { group: "Folio (Reservation checkout)", key: "folio_tax", label: "Room tax", fallback: "tax_payable" },
  { group: "POS", key: "pos_cash", label: "POS cash / receivable", fallback: "cash" },
  { group: "POS", key: "pos_revenue", label: "POS F&B revenue", fallback: "fnb_revenue" },
  { group: "POS", key: "pos_tax", label: "POS tax", fallback: "tax_payable" },
  { group: "POS", key: "pos_cogs", label: "POS cost of goods sold", fallback: "cogs_fnb" },
  { group: "Payments & Refunds", key: "payment_cash", label: "Cash payments in", fallback: "cash" },
  { group: "Payments & Refunds", key: "payment_bank", label: "Bank / card payments in", fallback: "bank" },
  { group: "Payments & Refunds", key: "refund_cash", label: "Refunds out", fallback: "cash" },
  { group: "Accounts Receivable", key: "ar_receivable", label: "AR receivable account", fallback: "ar" },
  { group: "Accounts Receivable", key: "ar_revenue", label: "Default AR line revenue", fallback: "other_revenue" },
  { group: "Accounts Receivable", key: "ar_tax", label: "AR tax", fallback: "tax_payable" },
  { group: "Accounts Payable", key: "ap_liability", label: "AP liability account", fallback: "ap" },
  { group: "Accounts Payable", key: "ap_expense", label: "Default bill expense", fallback: "opex" },
  { group: "Accounts Payable", key: "ap_tax", label: "AP tax", fallback: "tax_payable" },
];

function PostingRulesPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();

  const accounts = useQuery({
    queryKey: ["accounts-all", propertyId],
    queryFn: async () => {
      const { data } = await supabase.from("accounts")
        .select("id, code, name, type, system_key")
        .eq("property_id", propertyId!).eq("is_active", true).order("code");
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const rules = useQuery({
    queryKey: ["posting-rules", propertyId],
    queryFn: async () => {
      const { data } = await supabase.from("posting_rules").select("*").eq("property_id", propertyId!);
      const map: Record<string, string> = {};
      (data ?? []).forEach((r: any) => { map[r.rule_key] = r.account_id; });
      return map;
    },
    enabled: !!propertyId,
  });

  const upsert = useMutation({
    mutationFn: async ({ rule_key, account_id }: { rule_key: string; account_id: string }) => {
      const { error } = await supabase.from("posting_rules").upsert({
        property_id: propertyId!, rule_key, account_id,
      } as any, { onConflict: "property_id,rule_key" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Posting rule saved");
      qc.invalidateQueries({ queryKey: ["posting-rules", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const fallback = (key: string) => {
    const acc = (accounts.data ?? []).find((a: any) => a.system_key === key);
    return acc ? `${acc.code} · ${acc.name}` : "(no default)";
  };

  const grouped: Record<string, typeof RULES> = {};
  RULES.forEach((r) => { (grouped[r.group] ??= []).push(r); });

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property.</div>;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-display font-semibold flex items-center gap-2"><Settings2 className="h-6 w-6" /> Posting Rules</h1>
        <p className="text-sm text-muted-foreground">Override which account each PMS event posts to. Leave blank to use the default system account.</p>
      </div>

      {Object.entries(grouped).map(([group, items]) => (
        <Card key={group}>
          <CardHeader className="py-3"><CardTitle className="text-sm">{group}</CardTitle></CardHeader>
          <CardContent className="divide-y">
            {items.map((r) => (
              <div key={r.key} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr] gap-3 py-2 items-center">
                <div>
                  <div className="text-sm font-medium">{r.label}</div>
                  <div className="text-[10px] font-mono text-muted-foreground">{r.key}</div>
                </div>
                <div className="text-xs text-muted-foreground">Default: {fallback(r.fallback)}</div>
                <Select
                  value={rules.data?.[r.key] ?? ""}
                  onValueChange={(v) => upsert.mutate({ rule_key: r.key, account_id: v })}
                >
                  <SelectTrigger className="h-8"><SelectValue placeholder="Use default" /></SelectTrigger>
                  <SelectContent>
                    {(accounts.data ?? []).map((a: any) => (
                      <SelectItem key={a.id} value={a.id}>{a.code} · {a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
