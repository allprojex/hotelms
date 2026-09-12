import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Printer } from "lucide-react";

export const Route = createFileRoute("/_authenticated/pos/kot/$id")({
  head: () => ({ meta: [{ title: "Kitchen Order Ticket" }] }),
  component: KOTPage,
});

function KOTPage() {
  const { id } = Route.useParams();
  const order = useQuery({
    queryKey: ["kot-order", id],
    queryFn: async () => (await (supabase.from as any)("pos_orders").select("*, pos_outlets(name), pos_tables(label)").eq("id", id).single()).data,
  });
  const kots = useQuery({
    queryKey: ["kot-list", id],
    queryFn: async () => (await (supabase.from as any)("pos_kots").select("*").eq("order_id", id).order("fired_at", { ascending: false })).data ?? [],
  });
  const items = useQuery({
    queryKey: ["kot-items", id],
    queryFn: async () => (await (supabase.from as any)("pos_order_items").select("*").eq("order_id", id).not("kot_fired_at", "is", null).order("kot_fired_at")).data ?? [],
  });

  const latest = kots.data?.[0];
  const latestItems = latest ? items.data?.filter((i: any) => Math.abs(new Date(i.kot_fired_at).getTime() - new Date(latest.fired_at).getTime()) < 3000) ?? [] : [];

  useEffect(() => {
    if (order.data && kots.data && items.data) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [order.data, kots.data, items.data]);

  if (!order.data || !latest) {
    return <div className="p-8 text-center text-muted-foreground">No KOT fired yet for this order.</div>;
  }

  return (
    <div className="mx-auto max-w-sm p-6 font-mono text-sm print:p-0">
      <div className="text-center border-b-2 border-dashed pb-2 mb-2">
        <div className="text-lg font-bold">KITCHEN ORDER TICKET</div>
        <div>{order.data.pos_outlets?.name}</div>
        <div className="text-xs">{new Date(latest.fired_at).toLocaleString("en-GB")}</div>
      </div>
      <div className="flex justify-between mb-1"><span>KOT</span><span className="font-bold">{latest.code}</span></div>
      <div className="flex justify-between mb-1"><span>Order</span><span>{order.data.code}</span></div>
      {order.data.pos_tables?.label && <div className="flex justify-between mb-1"><span>Table</span><span>{order.data.pos_tables.label}</span></div>}
      {order.data.guest_name && <div className="flex justify-between mb-1"><span>Guest</span><span>{order.data.guest_name}</span></div>}
      <div className="border-t-2 border-dashed my-2"></div>
      <table className="w-full">
        <tbody>
          {latestItems.map((i: any) => (
            <tr key={i.id}>
              <td className="align-top pr-2 font-bold">{Number(i.quantity)}×</td>
              <td className="align-top">
                {i.name_snapshot}
                {i.notes && <div className="italic text-xs">{i.notes}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t-2 border-dashed my-2"></div>
      <div className="text-center text-xs">*** END OF KOT ***</div>
      <div className="mt-6 flex justify-center print:hidden">
        <Button onClick={() => window.print()}><Printer className="h-4 w-4 mr-1" /> Print</Button>
      </div>
    </div>
  );
}
