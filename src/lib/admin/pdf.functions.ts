import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const ADMIN_ROLES = ["super_admin", "hotel_owner", "general_manager"] as const;

async function assertAdmin(context: any, propertyId: string) {
  const { data, error } = await context.supabase.rpc("has_any_role", {
    _user_id: context.userId,
    _roles: ADMIN_ROLES as unknown as string[],
    _property_id: propertyId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Not authorized to print documents for this property");
}

async function logPrint(context: any, propertyId: string, entityType: string, entityId: string, code: string | null) {
  await context.supabase.from("admin_action_logs").insert({
    property_id: propertyId,
    actor_id: context.userId,
    entity_type: entityType,
    entity_id: entityId,
    action: "print",
    after_snapshot: { code },
  });
}

const Input = z.object({
  kind: z.enum(["folio", "bill", "invoice", "po"]),
  id: z.string().uuid(),
  propertyId: z.string().uuid(),
});

/** Render a folio, AP bill, AR invoice, or purchase order to PDF entirely on the server. */
export const renderAdminPdf = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: unknown) => Input.parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context, data.propertyId);

    const { buildDocPdf, toBase64 } = await import("./pdf-render.server");
    const supabase = context.supabase;

    let doc: import("./pdf-render.server").DocData;
    let entityCode = "";

    if (data.kind === "folio") {
      const [{ data: r, error: rErr }, { data: p }, { data: charges }, { data: payments }] = await Promise.all([
        supabase.from("reservations").select("*, guest:guests(*), room_type:room_types(name), room:rooms(number)").eq("id", data.id).eq("property_id", data.propertyId).maybeSingle(),
        supabase.from("properties").select("name,address,phone,email,base_currency").eq("id", data.propertyId).maybeSingle(),
        supabase.from("reservation_charges").select("*").eq("reservation_id", data.id),
        supabase.from("payments").select("*").eq("reservation_id", data.id),
      ]);
      if (rErr) throw new Error(rErr.message);
      if (!r) throw new Error("Reservation not found for this property");
      const anyR = r as any;
      const anyP = p as any;
      const lines: import("./pdf-render.server").LineItem[] = [];
      const nights = Math.max(1, Math.round((new Date(anyR.check_out).getTime() - new Date(anyR.check_in).getTime()) / 86400000));
      const perNight = Number(anyR.rate_total ?? 0) / nights;
      lines.push({ description: `${anyR.room_type?.name ?? "Room"} · ${anyR.check_in} → ${anyR.check_out}`, qty: nights, unitPrice: perNight, amount: Number(anyR.rate_total ?? 0) });
      for (const c of (charges as any[] ?? [])) lines.push({ description: c.description, amount: Number(c.amount) });
      const totalCharges = lines.reduce((s, l) => s + l.amount, 0);
      const totalPaid = (payments as any[] ?? []).reduce((s: number, x: any) => s + Number(x.amount), 0);
      for (const x of (payments as any[] ?? [])) lines.push({ description: `Payment received — ${x.method}`, amount: -Number(x.amount) });
      entityCode = anyR.code;
      doc = {
        filename: `folio-${anyR.code}.pdf`,
        title: "Guest Folio",
        code: anyR.code,
        fromBlock: [anyP?.name, anyP?.address, anyP?.phone, anyP?.email].filter(Boolean),
        toBlock: [
          `${anyR.guest?.first_name ?? ""} ${anyR.guest?.last_name ?? ""}`.trim(),
          anyR.guest?.email,
          anyR.guest?.phone,
          anyR.guest?.address,
        ].filter(Boolean),
        meta: [
          { label: "Confirmation", value: anyR.confirmation_code ?? "—" },
          { label: "Check-in", value: anyR.check_in },
          { label: "Check-out", value: anyR.check_out },
          { label: "Room", value: anyR.room?.number ?? "—" },
          { label: "Guests", value: `${anyR.adults} adults, ${anyR.children} children` },
        ],
        lines,
        subtotal: totalCharges,
        total: totalCharges - totalPaid,
        currency: anyP?.base_currency ?? "GHS",
        notes: anyR.notes ?? undefined,
      };
    } else if (data.kind === "bill") {
      const [{ data: b, error: bErr }, { data: p }, { data: lines }] = await Promise.all([
        supabase.from("ap_bills").select("*").eq("id", data.id).eq("property_id", data.propertyId).maybeSingle(),
        supabase.from("properties").select("name,address,phone,email").eq("id", data.propertyId).maybeSingle(),
        supabase.from("ap_bill_lines").select("*").eq("bill_id", data.id),
      ]);
      if (bErr) throw new Error(bErr.message);
      if (!b) throw new Error("Bill not found for this property");
      const anyB = b as any;
      const anyP = p as any;
      let sup: any = null;
      if (anyB.supplier_id) {
        const { data: s } = await supabase.from("suppliers").select("name,address,email").eq("id", anyB.supplier_id).maybeSingle();
        sup = s;
      }
      entityCode = anyB.code;
      doc = {
        filename: `bill-${anyB.code}.pdf`,
        title: "Bill",
        code: anyB.code,
        fromBlock: [sup?.name ?? "Unknown supplier", sup?.address, sup?.email].filter(Boolean),
        toBlock: [anyP?.name, anyP?.address, anyP?.phone, anyP?.email].filter(Boolean),
        meta: [
          { label: "Bill date", value: anyB.bill_date },
          { label: "Due", value: anyB.due_date ?? "—" },
          { label: "Status", value: anyB.status },
        ],
        lines: (lines as any[] ?? []).map((l: any) => ({
          description: l.description,
          qty: Number(l.quantity),
          unitPrice: Number(l.unit_price),
          amount: Number(l.quantity) * Number(l.unit_price),
        })),
        subtotal: Number(anyB.subtotal ?? 0),
        tax: Number(anyB.tax ?? 0),
        total: Number(anyB.total ?? 0),
        currency: anyB.currency ?? "GHS",
      };
    } else if (data.kind === "invoice") {
      const [{ data: inv, error: iErr }, { data: p }, { data: lines }] = await Promise.all([
        supabase.from("ar_invoices").select("*").eq("id", data.id).eq("property_id", data.propertyId).maybeSingle(),
        supabase.from("properties").select("name,address,phone,email").eq("id", data.propertyId).maybeSingle(),
        supabase.from("ar_invoice_lines").select("*").eq("invoice_id", data.id),
      ]);
      if (iErr) throw new Error(iErr.message);
      if (!inv) throw new Error("Invoice not found for this property");
      const anyI = inv as any;
      const anyP = p as any;
      entityCode = anyI.code;
      doc = {
        filename: `invoice-${anyI.code}.pdf`,
        title: "Invoice",
        code: anyI.code,
        fromBlock: [anyP?.name, anyP?.address, anyP?.phone, anyP?.email].filter(Boolean),
        toBlock: [anyI.bill_to_name ?? "Customer", anyI.bill_to_email].filter(Boolean),
        meta: [
          { label: "Invoice date", value: anyI.issue_date },
          { label: "Due", value: anyI.due_date ?? "—" },
          { label: "Status", value: anyI.status },
        ],
        lines: (lines as any[] ?? []).map((l: any) => ({
          description: l.description,
          qty: Number(l.quantity),
          unitPrice: Number(l.unit_price),
          amount: Number(l.quantity) * Number(l.unit_price),
        })),
        subtotal: Number(anyI.subtotal ?? 0),
        tax: Number(anyI.tax ?? 0),
        total: Number(anyI.total ?? 0),
        currency: anyI.currency ?? "GHS",
      };
    } else {
      // po
      const [{ data: po, error: pErr }, { data: p }, { data: lines }] = await Promise.all([
        supabase.from("purchase_orders").select("*").eq("id", data.id).eq("property_id", data.propertyId).maybeSingle(),
        supabase.from("properties").select("name,address,phone,email,base_currency").eq("id", data.propertyId).maybeSingle(),
        supabase.from("purchase_order_lines").select("*, item:inventory_items(name,unit)").eq("po_id", data.id),
      ]);
      if (pErr) throw new Error(pErr.message);
      if (!po) throw new Error("Purchase order not found for this property");
      const anyPo = po as any;
      const anyP = p as any;
      let sup: any = null;
      if (anyPo.supplier_id) {
        const { data: s } = await supabase.from("suppliers").select("name,address,email,phone").eq("id", anyPo.supplier_id).maybeSingle();
        sup = s;
      }
      entityCode = anyPo.code;
      doc = {
        filename: `po-${anyPo.code}.pdf`,
        title: "Purchase Order",
        code: anyPo.code,
        fromBlock: [anyP?.name, anyP?.address, anyP?.phone, anyP?.email].filter(Boolean),
        toBlock: [sup?.name, sup?.address, sup?.phone, sup?.email].filter(Boolean),
        meta: [
          { label: "PO date", value: anyPo.ordered_at?.slice(0, 10) ?? "—" },
          { label: "Status", value: anyPo.status },
          { label: "Expected", value: anyPo.expected_at ?? "—" },
        ],
        lines: (lines as any[] ?? []).map((l: any) => ({
          description: `${l.item?.name ?? "Item"} (${l.item?.unit ?? "ea"})`,
          qty: Number(l.quantity),
          unitPrice: Number(l.unit_cost),
          amount: Number(l.quantity) * Number(l.unit_cost),
        })),
        total: Number(anyPo.total ?? 0),
        currency: anyP?.base_currency ?? "GHS",
        notes: anyPo.notes ?? undefined,
      };
    }

    const bytes = await buildDocPdf(doc);
    const base64 = toBase64(bytes);
    await logPrint(context, data.propertyId, data.kind, data.id, entityCode);

    return {
      filename: doc.filename,
      mime: "application/pdf",
      base64,
      bytes: bytes.length,
    };
  });
