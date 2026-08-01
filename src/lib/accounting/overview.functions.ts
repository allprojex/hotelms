/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { ACCOUNTING_ADMIN_ROLES, EXPENSE_PERMISSIONS } from "@/lib/accounting/permissions";
import { uuid, optionalUuid } from "@/lib/accounting/domain";

export const getAccountingOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; periodId?: string }) => ({
    propertyId: uuid(d.propertyId),
    periodId: optionalUuid(d.periodId),
  }))
  .handler(async ({ data, context }) => {
    await assertServerPermission(context as any, {
      propertyId: data.propertyId,
      ...EXPENSE_PERMISSIONS.overviewView,
      defaultRoles: ACCOUNTING_ADMIN_ROLES,
    });
    const db = context.supabase as any;

    const openPeriod = await db
      .from("accounting_periods")
      .select("id,name,code,start_date,end_date,status")
      .eq("property_id", data.propertyId)
      .eq("status", "open")
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (openPeriod.error) throw new Error(openPeriod.error.message);

    const periodId = data.periodId ?? openPeriod.data?.id ?? null;

    let categoryTotalsQuery = db
      .from("expenses")
      .select("category:category_id(id,name),total_amount,currency,status")
      .eq("property_id", data.propertyId)
      .eq("status", "approved");
    let costCentreTotalsQuery = db
      .from("expenses")
      .select("cost_centre:cost_centre_id(id,name),total_amount,currency,status")
      .eq("property_id", data.propertyId)
      .eq("status", "approved");
    if (periodId) {
      categoryTotalsQuery = categoryTotalsQuery.eq("financial_period_id", periodId);
      costCentreTotalsQuery = costCentreTotalsQuery.eq("financial_period_id", periodId);
    }

    const [statusCounts, missingReceipts, categoryTotals, costCentreTotals, recent, queue] =
      await Promise.all([
        db
          .from("expenses")
          .select("status", { count: "exact", head: false })
          .eq("property_id", data.propertyId),
        db
          .from("expenses")
          .select("id", { count: "exact", head: true })
          .eq("property_id", data.propertyId)
          .eq("receipt_status", "missing")
          .in("status", ["draft", "submitted"]),
        categoryTotalsQuery,
        costCentreTotalsQuery,
        db
          .from("expenses")
          .select("id,expense_number,status,total_amount,currency,expense_date,updated_at")
          .eq("property_id", data.propertyId)
          .order("updated_at", { ascending: false })
          .limit(10),
        db
          .from("expenses")
          .select(
            "id,expense_number,total_amount,currency,submitted_at,creator:created_by(full_name)",
          )
          .eq("property_id", data.propertyId)
          .eq("status", "submitted")
          .order("submitted_at", { ascending: true })
          .limit(10),
      ]);
    for (const result of [
      statusCounts,
      missingReceipts,
      categoryTotals,
      costCentreTotals,
      recent,
      queue,
    ]) {
      if (result.error) throw new Error(result.error.message);
    }

    const counts: Record<string, number> = {};
    for (const row of statusCounts.data ?? []) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }

    const sumBy = (rows: any[], keyFn: (row: any) => string | null) => {
      const map = new Map<string, { label: string; total: number; currency: string }>();
      for (const row of rows) {
        const key = keyFn(row);
        if (!key) continue;
        const existing = map.get(key) ?? { label: key, total: 0, currency: row.currency };
        existing.total += Number(row.total_amount);
        map.set(key, existing);
      }
      return [...map.values()].sort((a, b) => b.total - a.total);
    };

    return {
      openPeriod: openPeriod.data ?? null,
      counts: {
        draft: counts.draft ?? 0,
        submitted: counts.submitted ?? 0,
        approved: counts.approved ?? 0,
        rejected: counts.rejected ?? 0,
        cancelled: counts.cancelled ?? 0,
        reversed: counts.reversed ?? 0,
        missingReceipts: missingReceipts.count ?? 0,
      },
      approvedTotalForPeriod: (categoryTotals.data ?? []).reduce(
        (sum: number, row: any) => sum + Number(row.total_amount),
        0,
      ),
      byCategory: sumBy(categoryTotals.data ?? [], (row) => row.category?.name ?? null),
      byCostCentre: sumBy(costCentreTotals.data ?? [], (row) => row.cost_centre?.name ?? null),
      recentActivity: recent.data ?? [],
      approvalQueue: queue.data ?? [],
    };
  });
