import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePermission } from "@/lib/permissions";
import { ACCOUNTING_ADMIN_ROLES, EXPENSE_PERMISSIONS } from "@/lib/accounting/permissions";
import {
  expenseReceiptStoragePath,
  validateExpenseReceiptFile,
  uuid,
  reasonText,
} from "@/lib/accounting/domain";

const root = resolve(__dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260801130000_expense_management_foundation.sql"),
  "utf8",
);
const expensesFns = readFileSync(resolve(root, "src/lib/accounting/expenses.functions.ts"), "utf8");
const periodsFns = readFileSync(
  resolve(root, "src/lib/accounting/financial-periods.functions.ts"),
  "utf8",
);
const referenceDataFns = readFileSync(
  resolve(root, "src/lib/accounting/reference-data.functions.ts"),
  "utf8",
);
const receiptsFns = readFileSync(
  resolve(root, "src/lib/accounting/expense-receipts.functions.ts"),
  "utf8",
);
const correctionsFns = readFileSync(
  resolve(root, "src/lib/accounting/expense-corrections.functions.ts"),
  "utf8",
);
const reportsFns = readFileSync(
  resolve(root, "src/lib/accounting/expense-reports.functions.ts"),
  "utf8",
);

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("Phase 6A: financial periods", () => {
  it("prevents overlapping open periods within the same property", () => {
    expect(migration).toContain("accounting_periods_prevent_overlap");
    expect(migration).toContain(
      "An open financial period already exists for an overlapping date range",
    );
  });

  it("validates start/end date ordering", () => {
    expect(migration).toContain("accounting_periods_date_order");
    expect(migration).toContain("CHECK (end_date >= start_date)");
  });

  it("requires the financial_periods manage permission to open, close or reopen", () => {
    expect(migration).toContain(
      "public.has_permission(actor, _property_id, 'financial_periods', 'manage')",
    );
    for (const fn of [
      "financial_period_open",
      "financial_period_close",
      "financial_period_reopen",
    ]) {
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
    }
  });

  it("requires a mandatory reason of at least 5 characters to reopen", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.financial_period_reopen[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("char_length(trim(COALESCE(_reason, ''))) < 5");
  });

  it("only allows closing an open period and reopening a closed period (no silent no-ops that skip state)", () => {
    const closeFn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.financial_period_close[\s\S]*?\$\$;/,
    )?.[0];
    expect(closeFn).toContain("Only an open period can be closed");
    const reopenFn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.financial_period_reopen[\s\S]*?\$\$;/,
    )?.[0];
    expect(reopenFn).toContain("Only a closed period can be reopened");
  });

  it("blocks ordinary expense creation/editing in a closed or locked period unless the actor manages periods", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.expense_assert_period_open");
    expect(migration).toContain("period.status IN ('closed', 'locked')");
    expect(migration).toContain("The financial period covering this date is closed");
  });

  it("does not touch payroll or hotel-operational period tables", () => {
    expect(migration).not.toMatch(/payroll_period|hotel_operational_period/i);
  });

  it("audits every period state change from the server function layer", () => {
    expect(periodsFns).toContain("captureAuditEvent");
    expect(periodsFns).toContain("financial_period.opened");
    expect(periodsFns).toContain("financial_period.closed");
    expect(periodsFns).toContain("financial_period.reopened");
  });

  it("enforces property isolation via property-scoped composite foreign keys", () => {
    expect(migration).toContain("accounting_periods_property_id_uniq");
    expect(migration).toContain(
      "FOREIGN KEY (property_id, financial_period_id) REFERENCES public.accounting_periods(property_id, id)",
    );
  });
});

describe("Phase 6A: expense categories", () => {
  it("enforces a unique code within a property but allows reuse across properties", () => {
    expect(migration).toContain("CREATE TABLE public.expense_categories");
    expect(migration).toContain("UNIQUE (property_id, code)");
    expect(migration).not.toMatch(/UNIQUE\s*\(code\)/);
  });

  it("never grants DELETE on categories — archival only", () => {
    expect(migration).toContain(
      "GRANT SELECT, INSERT, UPDATE ON public.expense_categories TO authenticated;",
    );
  });

  it("supports archive/restore metadata and gates writes behind a manage permission", () => {
    expect(migration).toContain("archived_at timestamptz");
    expect(migration).toContain("archived_by uuid REFERENCES public.profiles(id)");
    expect(referenceDataFns).toContain("archiveExpenseCategory");
    expect(referenceDataFns).toContain("restoreExpenseCategory");
  });

  it("scopes RLS to property access", () => {
    expect(migration).toContain(
      "CREATE POLICY expense_categories_read ON public.expense_categories FOR SELECT TO authenticated",
    );
    expect(migration).toContain("public.can_access_property(auth.uid(), property_id)");
  });

  it("keeps the accounting mapping and approval threshold optional", () => {
    expect(migration).toContain(
      "accounting_mapping_account_id uuid REFERENCES public.accounts(id)",
    );
    expect(migration).toContain("approval_threshold numeric(18,4)");
  });
});

describe("Phase 6A: vendors", () => {
  it("enforces a unique vendor code within a property via a partial index", () => {
    expect(migration).toContain("suppliers_vendor_code_property_uidx");
    expect(migration).toContain(
      "ON public.suppliers(property_id, vendor_code) WHERE vendor_code IS NOT NULL",
    );
  });

  it("stores bank details only as a reference, never raw account data", () => {
    expect(migration).toContain("bank_detail_reference text");
    expect(migration).toContain("Reference/pointer only");
    expect(migration).not.toMatch(/bank_account_number|iban|swift_code/i);
  });

  it("preserves vendors referenced by expenses via a composite foreign key, not cascade delete", () => {
    expect(migration).toContain(
      "FOREIGN KEY (property_id, vendor_id) REFERENCES public.suppliers(property_id, id)",
    );
  });

  it("exposes archive but never a hard-delete server function", () => {
    expect(referenceDataFns).toContain("archiveVendor");
    expect(referenceDataFns).not.toMatch(/export const deleteVendor/);
  });
});

describe("Phase 6A: cost centres", () => {
  it("enforces a unique code within a property and supports hierarchy", () => {
    expect(migration).toContain("CREATE TABLE public.cost_centres");
    expect(migration).toContain("UNIQUE (property_id, code)");
    expect(migration).toContain("parent_cost_centre_id uuid REFERENCES public.cost_centres(id)");
  });

  it("prevents self-parenting and cross-property parents via a trigger", () => {
    expect(migration).toContain("cost_centres_prevent_cycle");
    expect(migration).toContain("A cost centre cannot be its own parent");
    expect(migration).toContain("Parent cost centre must belong to the same property");
  });

  it("walks the full ancestor chain to reject indirect cycles, not just direct self-parenting", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.cost_centres_prevent_cycle[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("WHILE current_id IS NOT NULL");
    expect(fn).toContain("Cost centre hierarchy cannot contain a cycle");
  });

  it("preserves cost centres referenced by expenses via composite foreign key", () => {
    expect(migration).toContain(
      "FOREIGN KEY (property_id, cost_centre_id) REFERENCES public.cost_centres(property_id, id)",
    );
  });
});

describe("Phase 6A: expense records", () => {
  it("server-calculates the total via a generated column — clients cannot set it", () => {
    expect(migration).toContain(
      "total_amount numeric(18,4) GENERATED ALWAYS AS (amount_before_tax + tax_amount) STORED",
    );
  });

  it("rejects negative amounts on ordinary expenses but allows them on explicit reversal evidence", () => {
    expect(migration).toContain("reversal_of_expense_id IS NOT NULL OR amount_before_tax >= 0");
    expect(migration).toContain("reversal_of_expense_id IS NOT NULL OR tax_amount >= 0");
  });

  it("enforces a unique expense number per property using the shared short_code generator", () => {
    expect(migration).toContain("UNIQUE (property_id, expense_number)");
    expect(migration).toContain("public.short_code('EXP')");
  });

  it("enforces currency against the property's base currency", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_create[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("_currency IS DISTINCT FROM prop.base_currency");
  });

  it("only allows editing draft or returned expenses — approved expenses are immutable", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_update_draft[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("row.status NOT IN ('draft', 'returned')");
    expect(fn).toContain("Only draft or returned expenses can be edited");
  });

  it("enforces receipt requirement at submission time based on the category flag", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_submit[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("cat.receipt_required");
    expect(fn).toContain("A receipt is required before this expense can be submitted");
  });

  it("scopes every expense to its property via composite foreign keys on category, cost centre, vendor and period", () => {
    expect(migration).toContain(
      "FOREIGN KEY (property_id, category_id) REFERENCES public.expense_categories(property_id, id)",
    );
    expect(migration).toContain(
      "FOREIGN KEY (property_id, cost_centre_id) REFERENCES public.cost_centres(property_id, id)",
    );
  });

  it("restricts row visibility to the owner or a permitted viewer", () => {
    expect(migration).toContain(
      "created_by = auth.uid() OR public.has_permission(auth.uid(), property_id, 'expenses', 'read')",
    );
  });

  it("wires create/update/submit through server functions with audit logging", () => {
    expect(expensesFns).toContain("export const createExpenseDraft");
    expect(expensesFns).toContain("export const updateExpenseDraft");
    expect(expensesFns).toContain("export const submitExpense");
    expect(expensesFns).toContain("captureAuditEvent");
  });
});

describe("Phase 6A: expense approval workflow", () => {
  it("requires the expense_approval permission and blocks self-approval", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_decide[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("actor = row.created_by");
    expect(fn).toContain("Cannot approve your own expense");
    expect(fn).toContain("'expense_approval', 'approve'");
  });

  it("only allows deciding a submitted expense (approve/reject/return)", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_decide[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("row.status <> 'submitted'");
    expect(fn).toContain("Expense is not in a state that allows this action");
  });

  it("requires a mandatory reason for reject, return and cancel but not approve", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_decide[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain(
      "_decision IN ('rejected','returned','cancelled') AND char_length(trim(COALESCE(_reason, ''))) < 5",
    );
  });

  it("is idempotent for a repeated identical decision and fails for a conflicting one", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_decide[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("row.status::text = _decision THEN RETURN row");
  });

  it("uses row locking for concurrency protection before mutating", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_decide[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("FOR UPDATE");
  });

  it("blocks cancelling an approved expense — corrections/reversal are required instead", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_decide[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("row.status NOT IN ('draft','submitted','returned')");
    expect(fn).toContain("use a correction or reversal for approved expenses");
  });

  it("records an immutable, insert-only status history entry for every decision", () => {
    expect(migration).toContain("CREATE TABLE public.expense_status_history");
    expect(migration).not.toMatch(
      /UPDATE public\.expense_status_history|DELETE FROM public\.expense_status_history/,
    );
  });

  it("notifies the requester through the existing notify() function", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_decide[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("PERFORM public.notify(row.property_id, requester");
  });

  it("wires approve/reject/return/cancel through server functions with audit logging", () => {
    for (const name of ["approveExpense", "rejectExpense", "returnExpense", "cancelExpense"]) {
      expect(expensesFns).toContain(`export const ${name}`);
    }
    expect(expensesFns).toContain("captureAuditEvent");
  });

  it("does not gate cancellation with a blanket admin-only permission (owners may cancel their own drafts)", () => {
    expect(expensesFns).toContain('data.decision !== "cancelled"');
  });
});

describe("Phase 6A: expense receipts", () => {
  it("validates MIME type and file size on both client helper and server RPC", () => {
    expect(() => validateExpenseReceiptFile({ type: "application/exe", size: 100 })).toThrow(
      "Unsupported receipt file type",
    );
    expect(() => validateExpenseReceiptFile({ type: "application/pdf", size: 0 })).toThrow();
    expect(() =>
      validateExpenseReceiptFile({ type: "application/pdf", size: 11 * 1024 * 1024 }),
    ).toThrow();
    expect(() => validateExpenseReceiptFile({ type: "application/pdf", size: 1024 })).not.toThrow();

    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_receipt_register[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("Unsupported receipt file type");
    expect(fn).toContain("Receipt must be between 1 byte and 10 MB");
  });

  it("builds a property/expense-scoped storage path and rejects path traversal", () => {
    const path = expenseReceiptStoragePath({
      propertyId: UUID_A,
      expenseId: UUID_B,
      receiptId: UUID_A,
      fileName: "../../etc/passwd",
    });
    expect(path.startsWith(`${UUID_A}/expenses/${UUID_B}/`)).toBe(true);
    expect(path).not.toContain("..");

    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_receipt_register[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("_storage_path LIKE '%..%'");
    expect(fn).toContain("Invalid receipt storage path");
  });

  it("uses a private, non-public storage bucket", () => {
    expect(migration).toContain("'expense-receipts', 'expense-receipts', false");
  });

  it("scopes read access to the expense owner or a permitted viewer, and never grants a public URL policy", () => {
    expect(migration).toContain("expense_receipts_storage_read");
    expect(migration).toContain(
      "e.created_by = auth.uid() OR public.has_permission(auth.uid(), r.property_id, 'expense_receipts', 'read')",
    );
    expect(migration).not.toMatch(/expense-receipts.*public\s*=\s*true/s);
  });

  it("never logs receipt file contents in audit events — only safe metadata", () => {
    expect(receiptsFns).toContain("File contents are never logged");
    expect(receiptsFns).not.toMatch(/newValues:\s*\{\s*.*contents/i);
  });

  it("archives rather than deletes, and requires a reason", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.expense_receipt_archive");
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_receipt_archive[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("char_length(trim(COALESCE(_reason, ''))) < 5");
  });
});

describe("Phase 6A: corrections and reversals", () => {
  it("only allows a correction request against an approved expense, with a mandatory reason", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_correction_request[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("expense.status <> 'approved'");
    expect(fn).toContain("Corrections may only be requested for approved expenses");
    expect(fn).toContain("char_length(trim(COALESCE(_reason, ''))) < 5");
  });

  it("requires explicit review authorization and notes to approve or reject a correction", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_correction_review[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("'expense_corrections', 'approve'");
    expect(fn).toContain("char_length(trim(COALESCE(_review_notes, ''))) < 5");
  });

  it("keeps the original expense immutable — reversal creates a new linked evidence row instead of editing it", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_reverse[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("original.status <> 'approved'");
    expect(fn).toContain("INSERT INTO public.expenses(");
    expect(fn).toContain("reversal_of_expense_id");
    expect(fn).toContain("UPDATE public.expenses SET status = 'reversed' WHERE id = original.id");
  });

  it("documents that no bank or cash payment reversal is claimed, and never fabricates a refund", () => {
    expect(migration).toContain("Never claims a bank/cash payment was reversed");
    expect(migration).not.toMatch(/refund (issued|processed)/i);
  });

  it("is idempotent for a repeated reversal of the same expense", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_reverse[\s\S]*?\$\$;/,
    )?.[0];
    expect(fn).toContain("idempotent: already reversed");
  });

  it("scopes corrections to the same property as the original expense", () => {
    expect(migration).toContain(
      "FOREIGN KEY (property_id, expense_id) REFERENCES public.expenses(property_id, id) ON DELETE RESTRICT",
    );
  });

  it("wires correction request/review/reversal through server functions with audit logging", () => {
    expect(correctionsFns).toContain("export const requestExpenseCorrection");
    expect(correctionsFns).toContain("export const reviewExpenseCorrection");
    expect(correctionsFns).toContain("export const reverseExpense");
    expect(correctionsFns).toContain("captureAuditEvent");
  });
});

describe("Phase 6A: reports and exports", () => {
  it("gates export and print behind the shared authorizeReportAction gate", () => {
    expect(reportsFns).toContain("authorizeReportAction");
    expect(reportsFns).toContain('reportKey: "expense_reports"');
    expect(reportsFns).toContain("sensitive: true");
  });

  it("enforces property scope and the reportsView permission before returning data", () => {
    expect(reportsFns).toContain("assertServerPermission");
    expect(reportsFns).toContain("EXPENSE_PERMISSIONS.reportsView");
    expect(reportsFns).toContain('.eq("property_id", data.propertyId)');
  });

  it("masks the payment reference unless the caller holds sensitive-details view", () => {
    expect(reportsFns).toContain("function maskReference");
    expect(reportsFns).toContain("EXPENSE_PERMISSIONS.expensesSensitiveView");
  });

  it("reuses the shared report-core formula-neutralization framework rather than a bespoke exporter", () => {
    expect(reportsFns).not.toMatch(/XLSX\.|jsPDF/);
  });

  it("never claims journal posting or payment settlement in report code", () => {
    expect(reportsFns).not.toMatch(/posted to (the )?ledger|payment settled/i);
  });
});

describe("Phase 6A: permissions", () => {
  it("defines the full Phase 6A permission set", () => {
    for (const key of [
      "overviewView",
      "periodsView",
      "periodsManage",
      "categoriesView",
      "categoriesManage",
      "vendorsView",
      "vendorsManage",
      "costCentresView",
      "costCentresManage",
      "expensesView",
      "expensesCreate",
      "expensesEdit",
      "expensesSubmit",
      "expensesApprove",
      "expensesReject",
      "expensesCancel",
      "expensesSensitiveView",
      "receiptsView",
      "receiptsUpload",
      "receiptsArchive",
      "correctionsView",
      "correctionsCreate",
      "correctionsApprove",
      "reversalsExecute",
      "reportsView",
      "reportsExport",
      "reportsPrint",
    ] as const) {
      expect(EXPENSE_PERMISSIONS[key]).toBeDefined();
    }
  });

  it("resolves admin-only capabilities to false for an unprivileged role with no explicit grant", () => {
    const allowed = resolvePermission({
      roles: [{ role: "front_desk", property_id: "p1" }],
      grants: [],
      request: { propertyId: "p1", ...EXPENSE_PERMISSIONS.expensesApprove },
    });
    expect(allowed).toBe(false);
  });

  it("resolves admin capabilities to true for the seeded accounting-admin roles via defaultRoles", () => {
    for (const role of ACCOUNTING_ADMIN_ROLES) {
      const allowed = resolvePermission({
        roles: [{ role, property_id: "p1" }],
        grants: [],
        request: {
          propertyId: "p1",
          ...EXPENSE_PERMISSIONS.expensesApprove,
          defaultRoles: ACCOUNTING_ADMIN_ROLES,
        },
      });
      expect(allowed).toBe(true);
    }
  });

  it("never hard-codes role names inside the migration's decision RPCs — uses has_permission", () => {
    const decideFn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.expense_decide[\s\S]*?\$\$;/,
    )?.[0];
    expect(decideFn).toContain("public.has_permission(actor, row.property_id");
    expect(decideFn).not.toMatch(/role\s*=\s*'(super_admin|hotel_owner|manager)'/);
  });

  it("does not grant managers automatic approval or sensitive financial access by default", () => {
    expect(migration).not.toMatch(/'manager'\).*expense_approval|expense_approval.*'manager'/);
  });
});

describe("Phase 6A: RLS and property isolation", () => {
  it("enables RLS on every new table", () => {
    for (const table of [
      "cost_centres",
      "expense_categories",
      "expenses",
      "expense_status_history",
      "expense_receipts",
      "expense_corrections",
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    }
  });

  it("restricts direct writes on workflow tables to service_role — mutation goes through SECURITY DEFINER RPCs", () => {
    expect(migration).toContain("REVOKE ALL ON public.expenses FROM authenticated;");
    expect(migration).toContain("REVOKE ALL ON public.expense_status_history FROM authenticated;");
    expect(migration).toContain("REVOKE ALL ON public.expense_receipts FROM authenticated;");
    expect(migration).toContain("REVOKE ALL ON public.expense_corrections FROM authenticated;");
  });

  it("pins search_path=public on every new SECURITY DEFINER function", () => {
    const fns = [
      ...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?AS \$\$/g),
    ].filter((m) => m[0].includes("SECURITY DEFINER"));
    expect(fns.length).toBeGreaterThan(0);
    for (const fn of fns) {
      expect(fn[0]).toMatch(/SECURITY DEFINER\s+SET search_path = public/);
    }
  });

  it("uses no duplicate policy names within the migration", () => {
    const names = [...migration.matchAll(/CREATE POLICY (\w+)/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("Phase 6A: shared domain helpers", () => {
  it("uuid() rejects malformed identifiers", () => {
    expect(() => uuid("not-a-uuid")).toThrow();
    expect(uuid(UUID_A)).toBe(UUID_A);
  });

  it("reasonText() enforces the minimum length", () => {
    expect(() => reasonText("hi")).toThrow();
    expect(reasonText("A valid reason")).toBe("A valid reason");
  });
});

describe("Phase 6A: no false accounting claims", () => {
  it("never claims general-ledger posting for expenses", () => {
    expect(migration).not.toMatch(/posted to (the )?(general )?ledger/i);
    expect(expensesFns).not.toMatch(/posted to (the )?ledger/i);
  });

  it("never fabricates cash drawer, bank deposit or tax-filing behavior", () => {
    expect(migration).not.toMatch(/cash_drawer|bank_deposit|tax_filing/i);
  });
});
