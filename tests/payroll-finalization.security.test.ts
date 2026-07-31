import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260729235900_payroll_finalization_foundation.sql"),
  "utf8",
);
const permissions = fs.readFileSync(path.join(root, "src/lib/hrm/permissions.ts"), "utf8");
const functionsFile = fs.readFileSync(
  path.join(root, "src/lib/hrm/payroll-finalization.functions.ts"),
  "utf8",
);
const pages = fs.readFileSync(
  path.join(root, "src/components/hrm/payroll-finalization-pages.tsx"),
  "utf8",
);

describe("Phase 4C payroll finalization foundation", () => {
  it("adds a new migration without changing prior migration names", () => {
    expect(migration).toContain("Phase 4C");
    expect(migration).toContain("payroll_runs_status_phase4c");
  });

  it("creates immutable finalized payroll snapshot tables", () => {
    for (const table of [
      "finalized_payrolls",
      "finalized_payroll_employees",
      "finalized_payroll_line_items",
    ]) {
      expect(migration).toContain(`CREATE TABLE public.${table}`);
      expect(migration).toContain(`'${table}'`);
    }
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("source_run_version_id");
    expect(migration).toContain("source_hash");
    expect(migration).toContain("UNIQUE(property_id,source_run_version_id)");
  });

  it("implements approval history, stale-version and separation-of-duties controls", () => {
    expect(migration).toContain("CREATE TABLE public.payroll_approval_actions");
    expect(migration).toContain("Stale payroll calculation version");
    expect(migration).toContain("require_payroll_separation_of_duties");
    expect(migration).toContain("Requester cannot approve this payroll run");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("idempotency_key");
  });

  it("guards finalization behind approved current versions and reconciliation", () => {
    expect(migration).toContain("run_row.status<>'approved'");
    expect(migration).toContain("Payroll totals do not reconcile");
    expect(migration).toContain("Blocking validations remain");
    expect(migration).toContain("payroll_finalize_run");
    expect(migration).toContain("status='finalized'");
  });

  it("adds payslip versioning and own published payslip access", () => {
    expect(migration).toContain("CREATE TABLE public.payroll_payslips");
    expect(migration).toContain("document_version");
    expect(migration).toContain("payroll_payslips_own_published_read");
    expect(migration).toContain("status='published'");
    expect(migration).toContain("staff_user_id=auth.uid()");
  });

  it("keeps payment preparation separate from payment execution", () => {
    expect(migration).toContain("CREATE TABLE public.payroll_payment_batches");
    expect(migration).toContain("CREATE TABLE public.payroll_payment_batch_lines");
    expect(migration).toContain(
      "CHECK(status IN('draft','validated','ready_for_export','exported','cancelled'))",
    );
    expect(migration).not.toMatch(/'paid'|'sent'|'processed'|'settled'/);
    expect(migration).toContain("no bank transmission");
  });

  it("validates export templates as data only", () => {
    expect(migration).toContain("payroll_payment_export_templates");
    expect(migration).toContain("format IN('csv','xlsx','fixed_width')");
    expect(migration).toContain("lower(template::text) !~");
    expect(migration).toContain("eval|script|javascript|sql");
  });

  it("adds statutory liability and journal draft foundations without submission or posting claims", () => {
    expect(migration).toContain("payroll_statutory_liability_summaries");
    expect(migration).toContain("payroll_journal_drafts");
    expect(migration).toContain("CHECK(debit_total=credit_total OR status='blocked')");
    expect(migration).toContain("no external accounting posting");
    expect(migration).not.toMatch(/posted|submitted return|bank acceptance/i);
  });

  it("records period-close history and blocks unverified reversal execution", () => {
    expect(migration).toContain("payroll_period_close_history");
    expect(migration).toContain("payroll_correction_requests");
    expect(migration).toContain("payroll_reversal_requests");
    expect(migration).toContain("execution_blocked");
    expect(migration).toContain("pending migrations are verified against a disposable database");
  });

  it("adds Phase 4C permissions with no external payment or posting permissions", () => {
    for (const key of [
      "payrollApprovalSubmit",
      "payrollFinalizationExecute",
      "finalizedPayrollView",
      "payslipGenerate",
      "paymentExportSensitiveFields",
      "statutoryLiabilitiesExport",
      "journalDraftsExport",
      "payrollReversalExecute",
      "finalizedPayrollPrint",
    ]) {
      expect(permissions).toContain(key);
    }
    expect(permissions).not.toContain("bankPaymentExecute");
    expect(permissions).not.toContain("journalPost");
    expect(permissions).not.toContain("statutorySubmit");
  });

  it("uses authoritative server functions and RPCs for critical transitions", () => {
    for (const fn of [
      "transitionPayrollApproval",
      "finalizePayrollRun",
      "generatePayslips",
      "publishPayslips",
      "preparePaymentBatch",
      "validatePaymentBatch",
      "exportPaymentBatch",
      "prepareJournalDraft",
      "closePayrollPeriod",
      "executeReversalFoundation",
      "reviewPayrollCorrection",
    ]) {
      expect(functionsFile).toContain(`export const ${fn}`);
    }
    expect(functionsFile).toContain("assertServerPermission");
    expect(functionsFile).toContain("captureAuditEvent");
  });

  it("labels UI surfaces as preparation only", () => {
    expect(pages).toContain("does not transmit payments, submit returns or post journals");
    expect(pages).toContain("no payment execution");
    expect(pages).toContain("not submitted returns");
    expect(pages).toContain("no posting");
  });

  describe("correction-review UI", () => {
    it("gates review actions behind the approve permission and hides self-review", () => {
      expect(pages).toContain("reviewPayrollCorrection");
      expect(pages).toContain('capability: "approve"');
      expect(pages).toContain("useCurrentUserId");
      expect(pages).toContain("isOwnRequest");
      expect(pages).toContain("Requester cannot review own request");
      expect(pages).toContain("Review permission required");
    });

    it("requires a reason and confirmation before approval or rejection", () => {
      expect(pages).toContain("Reason for rejecting this correction request (required)");
      expect(pages).toContain("reviewReason.trim().length < 5");
      expect(pages).toContain("window.confirm(");
    });

    it("never claims a correction, reversal or repayment has already been executed", () => {
      expect(pages).toMatch(
        /Approving a correction request only authorizes the next controlled correction,\s+supplemental/,
      );
      expect(pages).not.toMatch(/correction (has been|was) (executed|applied)/i);
      expect(pages).not.toMatch(/payment (was|has been) reversed/i);
    });

    it("shows reviewer identity, reviewed timestamp and prevents editing reviewed requests", () => {
      expect(pages).toContain("Not yet reviewed");
      expect(pages).toContain("row.reviewed_at");
      expect(pages).toContain("Decision recorded - not editable");
    });
  });

  describe("PL/pgSQL identifier-collision regression", () => {
    const tableColumns = new Map<string, Set<string>>();
    for (const tableMatch of migration.matchAll(/CREATE TABLE public\.(\w+) \(([\s\S]*?)\n\);/g)) {
      const [, table, body] = tableMatch;
      const columns = new Set<string>();
      for (const line of body.split("\n")) {
        const trimmed = line.trim().replace(/,$/, "");
        if (!trimmed || /^(CONSTRAINT|CHECK|UNIQUE|FOREIGN KEY|PRIMARY KEY)\b/i.test(trimmed))
          continue;
        const columnMatch = trimmed.match(/^(\w+)\s+/);
        if (columnMatch) columns.add(columnMatch[1]);
      }
      tableColumns.set(table, columns);
    }
    const allColumns = new Set<string>();
    for (const columns of tableColumns.values()) for (const c of columns) allColumns.add(c);

    const functionBodies = [
      ...migration.matchAll(
        /CREATE OR REPLACE FUNCTION public\.(\w+)\([^)]*\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/g,
      ),
    ].map((m) => ({ name: m[1], body: m[2] }));

    it("declares at least the twelve Phase 4C security-definer RPCs", () => {
      expect(functionBodies.length).toBeGreaterThanOrEqual(12);
    });

    it("has no self-referential bare column=variable ambiguity in any Phase 4C function", () => {
      const offenders: string[] = [];
      for (const { name, body } of functionBodies) {
        const declared = new Set<string>();
        for (const declLine of body.match(/^DECLARE.*$/gm) ?? []) {
          for (const varMatch of declLine.matchAll(
            /(\w+)\s+(?:uuid|text|integer|numeric|jsonb|record|boolean)\b/g,
          )) {
            declared.add(varMatch[1]);
          }
        }
        for (const varName of declared) {
          if (!allColumns.has(varName)) continue;
          const selfRefPattern = new RegExp(`\\b${varName}\\s*=\\s*${varName}\\b`);
          if (selfRefPattern.test(body)) {
            offenders.push(`${name}: ${varName}=${varName}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it("uses v_-prefixed locals for the fixed collisions instead of bare column-shadowing names", () => {
      expect(migration).toContain("v_batch_id uuid");
      expect(migration).toContain("v_export_hash text");
      expect(migration).toContain("v_debit_total numeric");
      expect(migration).toContain("v_credit_total numeric");
      expect(migration).not.toMatch(/\bbatch_id\s*=\s*batch_id\b/);
      expect(migration).not.toMatch(/\bexport_hash\s*=\s*export_hash\b/);
      expect(migration).not.toMatch(/\bdebit_total\s*=\s*debit_total\b/);
      expect(migration).not.toMatch(/\bcredit_total\s*=\s*credit_total\b/);
    });

    it("declares an explicit search_path on every Phase 4C security-definer function", () => {
      for (const fn of [
        "payroll_approval_transition",
        "payroll_finalize_run",
        "payroll_generate_payslips",
        "payroll_publish_payslips",
        "payroll_prepare_payment_batch",
        "payroll_validate_payment_batch",
        "payroll_export_payment_batch",
        "payroll_prepare_journal_draft",
        "payroll_close_period",
        "payroll_create_correction_request",
        "payroll_review_correction_request",
        "payroll_execute_reversal_foundation",
      ]) {
        const fnMatch = migration.match(
          new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\([^)]*\\)[\\s\\S]*?AS \\$\\$`),
        );
        expect(fnMatch?.[0]).toMatch(/SECURITY DEFINER SET search_path=public/);
      }
    });

    it("writes a transactional audit event inside every Phase 4C mutating RPC", () => {
      const missing = functionBodies
        .filter((fn) => !/PERFORM public\.log_audit_event\(/.test(fn.body))
        .map((fn) => fn.name);
      expect(missing).toEqual([]);
      expect(functionBodies.length).toBe(12);
    });
  });

  describe("correction-review workflow", () => {
    const reviewFn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.payroll_review_correction_request\(([\s\S]*?)AS \$\$([\s\S]*?)\$\$;/,
    );
    const reviewBody = reviewFn?.[2] ?? "";

    it("adds the review RPC with server-authoritative gating", () => {
      expect(reviewFn).not.toBeNull();
      expect(reviewFn?.[0]).toContain("SECURITY DEFINER SET search_path=public");
      expect(reviewBody).toContain("Authentication required");
      expect(reviewBody).toContain("'payroll_corrections','approve'");
      expect(reviewBody).toContain("Unsupported correction decision");
    });

    it("locks the correction row and enforces property isolation", () => {
      expect(reviewBody).toContain(
        "FROM public.payroll_correction_requests WHERE property_id=_property_id AND id=_correction_id FOR UPDATE",
      );
    });

    it("requires a mandatory reason for rejection but not for approval", () => {
      expect(reviewBody).toContain("Rejection reason is required");
      expect(reviewBody).not.toMatch(/Approval reason is required/);
    });

    it("enforces separation of duties using the existing payroll setting", () => {
      expect(reviewBody).toContain("require_payroll_separation_of_duties");
      expect(reviewBody).toContain("Requester cannot review their own correction request");
      expect(reviewBody).toContain("v_request.created_by=actor");
    });

    it("allows review only from the pending (requested) state, with same-decision idempotency", () => {
      expect(reviewBody).toContain("v_request.status=_decision");
      expect(reviewBody).toContain("'idempotent',true");
      expect(reviewBody).toContain("v_request.status<>'requested'");
      expect(reviewBody).toContain("already reviewed with a different decision");
    });

    it("preserves immutable review history separate from the request row", () => {
      expect(migration).toContain("CREATE TABLE public.payroll_correction_review_history");
      expect(migration).toContain("payroll_correction_review_history_read");
      expect(reviewBody).toContain("INSERT INTO public.payroll_correction_review_history");
      expect(migration).not.toMatch(
        /UPDATE public\.payroll_correction_review_history|DELETE FROM public\.payroll_correction_review_history/,
      );
    });

    it("writes reviewer identity, timestamp and reason on the request row", () => {
      expect(reviewBody).toContain("reviewed_by=actor,reviewed_at=now()");
      expect(migration).toContain("reviewed_by uuid REFERENCES public.profiles(id)");
      expect(migration).toContain("reviewed_at timestamptz");
      expect(migration).toContain("review_reason text");
    });

    it("never mutates finalized payroll, payment, payslip, journal or liability tables", () => {
      expect(reviewBody).not.toMatch(
        /UPDATE public\.(finalized_payrolls|finalized_payroll_employees|finalized_payroll_line_items|payroll_payslips|payroll_payment_batches|payroll_payment_batch_lines|payroll_journal_drafts|payroll_statutory_liability_summaries)/,
      );
    });

    it("does not claim execution, payment reversal or posting from a review decision", () => {
      expect(reviewBody).not.toMatch(/executed|reversed|posted|paid/i);
    });

    it("writes a transactional audit event for the review decision", () => {
      expect(reviewBody).toContain(
        "PERFORM public.log_audit_event(_property_id,'payroll_correction_review'",
      );
    });
  });

  it("protects finalization against concurrent duplicate runs", () => {
    expect(migration).toContain(
      "SELECT * INTO run_row FROM public.payroll_runs WHERE property_id=_property_id AND id=_run_id FOR UPDATE;",
    );
    expect(migration).toContain("UNIQUE(property_id,source_run_version_id)");
    expect(migration).toContain("finalized_payrolls_one_active_period_uniq");
  });

  it("prevents duplicate active payment-batch lines and enforces journal balance", () => {
    expect(migration).toContain("UNIQUE(property_id,batch_id,finalized_employee_id)");
    expect(migration).toContain("payroll_payment_batches_active_method_uniq");
    expect(migration).toContain("CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0))");
  });

  it("derives payment amounts only from finalized net pay, never from client input", () => {
    expect(migration).toContain("fe.net_pay,pd.payment_reference");
    expect(functionsFile).not.toMatch(/paymentAmount|payment_amount/);
  });

  it("requires mandatory reasons for reject, return, unpublish, reopen, correction and reversal", () => {
    expect(migration).toContain("CHECK(reason IS NULL OR char_length(trim(reason))>=5)");
    expect(migration).toContain(
      "CHECK(unpublish_reason IS NULL OR char_length(trim(unpublish_reason))>=5)",
    );
    expect(migration).toContain(
      "CHECK(payroll_reopen_reason IS NULL OR char_length(trim(payroll_reopen_reason))>=5)",
    );
    expect(migration).toContain("reason text NOT NULL CHECK(char_length(trim(reason))>=5)");
  });

  it("requires explicit separation-of-duties on reversal execution and finalization permissions", () => {
    expect(migration).toContain("'payroll_reversals','approve'");
    expect(migration).toContain("'payroll_finalization','approve'");
  });
});
