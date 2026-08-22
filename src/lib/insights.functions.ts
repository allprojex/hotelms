import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const InputSchema = z.object({ propertyId: z.string().uuid() });

export type Insight = {
  title: string;
  body: string;
  severity: "info" | "positive" | "warning";
};

export const getBusinessInsights = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = today.toISOString().slice(0, 10);

    const [roomsRes, reservationsRes, paymentsRes] = await Promise.all([
      supabase.from("rooms").select("id", { count: "exact", head: true }).eq("property_id", data.propertyId),
      supabase.from("reservations")
        .select("id, check_in, check_out, status, created_at")
        .eq("property_id", data.propertyId)
        .gte("check_in", startStr)
        .lte("check_in", endStr),
      // status filter: excludes refunded payments from the revenue trend —
      // see 20260822130000_reservation_payment_refund.sql. Cast to `any`
      // because `payments.status` is not yet in the generated Supabase
      // types (matching the ap_payments/ar_receipts precedent).
      (supabase as any).from("payments")
        .select("amount, received_at, reservations!inner(property_id)")
        .eq("reservations.property_id", data.propertyId)
        .eq("status", "posted")
        .gte("received_at", startStr),
    ]);

    const totalRooms = roomsRes.count ?? 0;
    const reservations = reservationsRes.data ?? [];
    const payments = (paymentsRes.data ?? []) as Array<{ amount: number; received_at: string }>;

    const days: Array<{ date: string; arrivals: number; revenue: number; occupancy: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const arrivals = reservations.filter((r: any) => r.check_in === key).length;
      const inhouse = reservations.filter((r: any) => r.check_in <= key && r.check_out > key && r.status !== "cancelled").length;
      const revenue = payments
        .filter((p) => (p.received_at || "").slice(0, 10) === key)
        .reduce((s, p) => s + Number(p.amount || 0), 0);
      const occupancy = totalRooms > 0 ? Math.round((inhouse / totalRooms) * 100) : 0;
      days.push({ date: key, arrivals, revenue, occupancy });
    }

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) {
      return {
        days,
        insights: [
          { title: "AI unavailable", body: "LOVABLE_API_KEY is not configured.", severity: "warning" as const },
        ] satisfies Insight[],
      };
    }

    const prompt = `You are a hotel operations analyst. Given the last 7 days of KPIs for a single property, produce exactly 3 short, actionable insights for the general manager. Cover: (1) occupancy trend, (2) revenue anomaly, (3) staffing/arrivals hint for the next 1-2 days. Return strict JSON only.

Data (oldest first):
${JSON.stringify(days)}

Respond as JSON: {"insights":[{"title":"...","body":"...","severity":"info|positive|warning"}]}. Keep each title <= 6 words and each body <= 24 words.`;

    try {
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Lovable-API-Key": apiKey,
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: "You output only valid JSON matching the requested schema." },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        return {
          days,
          insights: [
            { title: "AI request failed", body: `Gateway ${res.status}: ${text.slice(0, 120)}`, severity: "warning" as const },
          ] satisfies Insight[],
        };
      }
      const json = await res.json();
      const content: string = json?.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content);
      const insights: Insight[] = Array.isArray(parsed?.insights)
        ? parsed.insights.slice(0, 3).map((i: any) => ({
            title: String(i?.title ?? "Insight"),
            body: String(i?.body ?? ""),
            severity: ["info", "positive", "warning"].includes(i?.severity) ? i.severity : "info",
          }))
        : [];
      return { days, insights };
    } catch (err) {
      return {
        days,
        insights: [
          { title: "AI unavailable", body: (err as Error).message.slice(0, 140), severity: "warning" as const },
        ] satisfies Insight[],
      };
    }
  });
