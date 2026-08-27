import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// Server-side wrappers for the exec_pos_* analytical RPCs (PR-A:
// 20260826090000 + 20260826133000). Every metric this dashboard shows comes
// from one of these five calls -- the client never aggregates raw POS rows.
//
// Each RPC is SECURITY INVOKER and carries its own Executive role gate
// (super_admin / hotel_owner / general_manager / accountant) plus the
// existing can_access_property RLS on pos_orders/pos_outlets/
// pos_order_items/pos_payments. That gate is the real security boundary;
// the UI's role check is presentation only.
//
// The RPCs return bare numerics and never a currency: money is formatted in
// the client from the active property's properties.base_currency via
// execMoney/execCurrency.

const RangeSchema = z.object({
  propertyId: z.string().uuid(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const TopItemsSchema = RangeSchema.extend({
  limit: z.number().int().min(1).max(100).optional(),
});

const PeriodSchema = RangeSchema.extend({
  granularity: z.enum(["day", "month"]),
});

// The RPCs return JSON scalars only (numerics arrive as string or number
// depending on the column's SQL type), so rows are serializable across the
// server-function boundary without further narrowing.
type RpcScalar = string | number | boolean | null;
type RpcRow = Record<string, RpcScalar>;

type RpcCall = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: RpcRow[] | null; error: { message: string } | null }>;

/**
 * The exec_pos_* functions post-date the last emitted Supabase types, so
 * rpc() has no overload for them. Rather than opting out of type checking
 * with `any`, narrow the call to "takes named args, returns rows of unknown
 * columns" -- the column shapes are declared at the point of use in the
 * dashboard, against the migration's actual RETURNS TABLE.
 */
async function callPosRpc(
  supabase: { rpc: unknown },
  fn: string,
  args: Record<string, unknown>,
): Promise<RpcRow[]> {
  const { data, error } = await (supabase.rpc as unknown as RpcCall)(fn, args);
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** exec_pos_summary — one row of headline POS figures for the range. */
export const getPosExecSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => RangeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const rows = await callPosRpc(context.supabase, "exec_pos_summary", {
      _property_id: data.propertyId,
      _from: data.from,
      _to: data.to,
    });
    // The RPC returns zero rows when the caller is not an Executive for this
    // property -- surface that as null rather than inventing zeroes, so the
    // UI can distinguish "denied" from "no trading activity".
    return rows[0] ?? null;
  });

/** exec_pos_by_department — one row per outlet BELONGING TO this property. */
export const getPosExecByDepartment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => RangeSchema.parse(d))
  .handler(async ({ data, context }) =>
    callPosRpc(context.supabase, "exec_pos_by_department", {
      _property_id: data.propertyId,
      _from: data.from,
      _to: data.to,
    }),
  );

/**
 * exec_pos_by_user — order-creator and till-payment-receiver figures kept as
 * two distinct domains. The schema cannot prove either means "salesperson",
 * so neither is presented as one.
 */
export const getPosExecByUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => RangeSchema.parse(d))
  .handler(async ({ data, context }) =>
    callPosRpc(context.supabase, "exec_pos_by_user", {
      _property_id: data.propertyId,
      _from: data.from,
      _to: data.to,
    }),
  );

/** exec_pos_top_items — best sellers from closed, non-void orders. */
export const getPosExecTopItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => TopItemsSchema.parse(d))
  .handler(async ({ data, context }) =>
    callPosRpc(context.supabase, "exec_pos_top_items", {
      _property_id: data.propertyId,
      _from: data.from,
      _to: data.to,
      _limit: data.limit ?? 10,
    }),
  );

/** exec_pos_sales_by_period — gap-filled day or month trend. */
export const getPosExecSalesByPeriod = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => PeriodSchema.parse(d))
  .handler(async ({ data, context }) =>
    callPosRpc(context.supabase, "exec_pos_sales_by_period", {
      _property_id: data.propertyId,
      _from: data.from,
      _to: data.to,
      _granularity: data.granularity,
    }),
  );
