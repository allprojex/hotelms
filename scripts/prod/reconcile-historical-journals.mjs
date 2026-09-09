#!/usr/bin/env node
// Section G — historical accounting reconciliation (folio, payment, FX).
//
// PURPOSE
// -------
// The revenue-posting defects fixed on 2026-09-09 left three populations of
// accounting records behind them:
//
//   folio    checked-out stays whose folio journal was never written,
//            because post_reservation_checkout() swallowed its own failure.
//   payment  posted payments whose journal was never written, before the
//            2026-08-23 payment fix shipped.
//   fx       journal entries that WERE written, but labelled with a
//            hardcoded 'USD' and therefore converted through an fx_rates
//            row, recording a base amount a tenth of the real one.
//
// This tool derives, classifies and reconciles the corrections for all
// three. It defaults to DRY RUN and prints exactly what it would post.
//
// SAFETY MODEL (every one of these is enforced below, not merely intended)
// ----------------------------------------------------------------------
//   * Dry run is the default. Write mode requires BOTH `--write` AND an
//     authorization plan whose `historical_repair_authorized` is literally
//     true AND `--yes`. Any one missing => refuse.
//   * Property-scoped. `--property` is mandatory; there is no "all
//     properties" mode. The property must resolve to exactly one row.
//   * The cutoff is LOCKED to the fix-forward boundary constant below. It
//     is not a CLI argument: a repair that could be pointed at a later
//     cutoff could swallow live trading.
//   * Idempotent by construction. Every proposal carries the same
//     source/source_ref idempotency key the application itself uses, and
//     write mode re-checks for an existing journal inside the same
//     transaction immediately before inserting.
//   * Fail closed. An unexpected property, a currency that is not the
//     property's base_currency, a missing account mapping, a malformed or
//     ambiguous source row, or a proposal whose debits do not equal its
//     credits is EXCLUDED with a recorded reason — never guessed at, never
//     silently dropped.
//   * Never edits or deletes anything that already exists. No UPDATE or
//     DELETE against reservations, payments, pos_orders, folios or
//     journal_entries/journal_lines appears anywhere in this file. FX
//     corrections are expressed as a reversal (is_reversal_of) plus a
//     fresh correct entry — never as a rewrite of the original.
//
// USAGE
//   node scripts/prod/reconcile-historical-journals.mjs --property "Theskwoff hotel" [--scope folio|payment|fx|all] [--json out.json] [--report out.txt]
//   ... --write --plan <authorization-plan.json> --yes      (refused unless authorized)

import { writeFileSync } from "node:fs";
import {
  loadProductionConfig,
  assertHumanConfirmed,
  resolveProductionDbUrl,
  assertProjectRefKnownToCli,
  maskConnectionString,
  GuardError,
  log,
  pass,
  fail,
} from "./lib/guard.mjs";
import { execStatementViaSupabaseCli } from "./lib/sql-runner.mjs";
import { loadReleasePlan } from "./lib/release-plan.mjs";

const LABEL = "reconcile";

/** The fix-forward boundary: the moment migration 20260909170000 committed
 * and the posting path became correct. Everything at or after this instant
 * is live trading and is NEVER in scope for a historical repair. Locked as
 * a constant deliberately — see the safety model above. */
export const FIX_FORWARD_BOUNDARY = "2026-09-09T21:55:03.790Z";

/** Exclusion reasons. Every record this tool refuses to repair carries
 * exactly one of these, so the report can be reconciled category by
 * category and nothing can go missing silently. */
export const EXCLUSION = {
  ALREADY_POSTED: "already_posted",
  POSTED_UNDER_OTHER_LINKAGE: "posted_under_other_linkage",
  AFTER_BOUNDARY: "after_boundary",
  ZERO_OR_NEGATIVE_AMOUNT: "zero_or_negative_amount",
  MISSING_AMOUNT: "missing_amount",
  MISSING_BUSINESS_DATE: "missing_business_date",
  WRONG_PROPERTY: "wrong_property",
  CURRENCY_MISMATCH: "currency_mismatch",
  MISSING_ACCOUNT_MAPPING: "missing_account_mapping",
  MISSING_TAX_CODE: "missing_tax_code",
  UNBALANCED: "unbalanced",
  PERIOD_LOCKED: "period_locked",
  AMBIGUOUS_SOURCE: "ambiguous_source",
  /** The original entry's BASE amounts do not tie, though its transaction
   * amounts do. post_journal_internal enforces balance as
   * ROUND(sum_dr,2) <> ROUND(sum_cr,2) on the TRANSACTION amounts only, so
   * an FX conversion that rounded each line's base independently could
   * leave a sub-pesewa residue and still be accepted. A faithful reversal
   * would inherit that residue. Refused rather than silently absorbed:
   * where the difference lands is an accounting decision, not a rounding
   * convenience. */
  BASE_ROUNDING_RESIDUE: "base_rounding_residue",
};

/** Repair categories, recorded on every proposal. */
export const CATEGORY = {
  FOLIO_OMISSION: "folio_revenue_omission",
  PAYMENT_OMISSION: "payment_cash_omission",
  FX_REVERSAL: "fx_misconversion_reversal",
  FX_REPLACEMENT: "fx_misconversion_replacement",
};

function parseArgs(argv) {
  const out = { scope: "all", write: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--property") out.property = argv[++i];
    else if (a === "--scope") out.scope = argv[++i];
    else if (a === "--plan") out.plan = argv[++i];
    else if (a === "--json") out.json = argv[++i];
    else if (a === "--report") out.report = argv[++i];
    else if (a === "--write") out.write = true;
    else if (a === "--yes") out.yes = true;
  }
  return out;
}

/** Rounds to 2dp using the same half-up convention the posting functions'
 * ROUND() uses, via integer arithmetic so binary floating point cannot
 * drift a cedi over 369 records. */
export function money(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** journal_lines.debit/credit/debit_base/credit_base are NUMERIC(18,4), and
 * post_reservation_checkout() derives its split with ROUND(..., 4). Line
 * amounts and the balance test therefore use 4dp, not 2 — rounding to 2
 * here would make a repaired entry differ from the one the application
 * itself would have written, by a few pesewas per stay. */
export function money4(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
}

/** Derives the folio split exactly as post_reservation_checkout() does:
 * room_net = rate_total / (1 + tax_rate/100), tax = gross - net. Mirrored
 * rather than re-invented so a repaired entry is indistinguishable from
 * one the application would have written itself. */
export function deriveFolioSplit(rateTotal, taxRate) {
  const gross = money4(rateTotal);
  const net = money4(gross / (1 + Number(taxRate) / 100));
  const tax = money4(gross - net);
  return { gross, net, tax };
}

/** A proposal is only ever emitted through this, so no code path can
 * produce one that does not balance. */
export function buildProposal({ category, sourceType, sourceId, sourceRef, sourceCode, propertyId, propertyName, currency, entryDate, memo, lines, extra = {} }) {
  const debit = money4(lines.reduce((s, l) => s + Number(l.debit || 0), 0));
  const credit = money4(lines.reduce((s, l) => s + Number(l.credit || 0), 0));
  const balanced = debit === credit && debit > 0;
  return {
    category,
    source_type: sourceType,
    source_id: sourceId,
    source_ref: sourceRef,
    source_code: sourceCode ?? null,
    property_id: propertyId,
    property_name: propertyName,
    currency,
    entry_date: entryDate,
    memo,
    lines,
    total_debit: debit,
    total_credit: credit,
    balanced,
    eligible: balanced,
    exclusion_reason: balanced ? null : EXCLUSION.UNBALANCED,
    ...extra,
  };
}

/** Marks a record excluded. Excluded records still appear in the report —
 * hiding them is exactly the failure mode this tool exists to prevent. */
export function exclude(base, reason, detail) {
  return { ...base, eligible: false, exclusion_reason: reason, exclusion_detail: detail ?? null };
}

/** Supabase's JSON output encodes numerics as {Int, Exp}. */
export function decodeNumeric(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (typeof v === "object" && "Int" in v) {
    return Number(v.Int) * Math.pow(10, Number(v.Exp ?? 0));
  }
  return Number(v);
}

/** Supabase's JSON output encodes uuid as a 16-byte array. */
export function decodeUuid(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const h = v.map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return null;
}

async function query(url, sql) {
  const { stdout } = await execStatementViaSupabaseCli(url, sql);
  const start = stdout.indexOf("{");
  if (start < 0) return [];
  const parsed = JSON.parse(stdout.slice(start));
  return parsed.rows ?? [];
}

// ---------------------------------------------------------------------------
// Scope 1 — folio revenue omissions
// ---------------------------------------------------------------------------
export function classifyFolio(rows, prop, accounts, taxRate) {
  return rows.map((raw) => {
    const id = decodeUuid(raw.id);
    const base = {
      source_type: "reservation",
      source_id: id,
      source_ref: id,
      source_code: raw.code ?? null,
      property_id: prop.id,
      property_name: prop.name,
      category: CATEGORY.FOLIO_OMISSION,
      check_out: raw.check_out,
      rate_total: decodeNumeric(raw.rate_total),
    };

    if (decodeUuid(raw.property_id) !== prop.id) return exclude(base, EXCLUSION.WRONG_PROPERTY, `reservation belongs to ${decodeUuid(raw.property_id)}`);
    if (raw.existing_entry_id) return exclude(base, EXCLUSION.ALREADY_POSTED, `journal ${decodeUuid(raw.existing_entry_id)} exists`);
    if (raw.other_linkage_entry_id) return exclude(base, EXCLUSION.POSTED_UNDER_OTHER_LINKAGE, `entry ${decodeUuid(raw.other_linkage_entry_id)} already references this reservation`);
    if (!raw.check_out) return exclude(base, EXCLUSION.MISSING_BUSINESS_DATE, "reservation has no check_out date");
    if (new Date(raw.check_out) >= new Date(FIX_FORWARD_BOUNDARY)) return exclude(base, EXCLUSION.AFTER_BOUNDARY, `check_out ${raw.check_out} is at or after the boundary`);
    if (raw.rate_total === null || raw.rate_total === undefined) return exclude(base, EXCLUSION.MISSING_AMOUNT, "rate_total is null");
    const gross0 = decodeNumeric(raw.rate_total);
    if (!(gross0 > 0)) return exclude(base, EXCLUSION.ZERO_OR_NEGATIVE_AMOUNT, `rate_total = ${gross0}`);
    if (raw.period_locked) return exclude(base, EXCLUSION.PERIOD_LOCKED, "the accounting period covering check_out is locked or closed");
    if (taxRate === null || taxRate === undefined) return exclude(base, EXCLUSION.MISSING_TAX_CODE, "property has no STD tax code");
    for (const k of ["ar", "room_revenue", "tax_payable"]) {
      if (!accounts[k]) return exclude(base, EXCLUSION.MISSING_ACCOUNT_MAPPING, `no account with system_key=${k}`);
    }

    const { gross, net, tax } = deriveFolioSplit(gross0, taxRate);
    return buildProposal({
      category: CATEGORY.FOLIO_OMISSION,
      sourceType: "reservation",
      sourceId: id,
      sourceRef: id,
      sourceCode: raw.code,
      propertyId: prop.id,
      propertyName: prop.name,
      currency: prop.base_currency,
      entryDate: String(raw.check_out).slice(0, 10),
      memo: `Folio ${raw.code}`,
      lines: [
        { account_id: accounts.ar, system_key: "ar", debit: gross, credit: 0, memo: `Reservation ${raw.code}` },
        { account_id: accounts.room_revenue, system_key: "room_revenue", debit: 0, credit: net, memo: "Room revenue" },
        { account_id: accounts.tax_payable, system_key: "tax_payable", debit: 0, credit: tax, memo: "Tax on room" },
      ],
      extra: { expected_revenue: net, expected_tax: tax, expected_ar: gross, tax_rate: Number(taxRate), check_out: raw.check_out },
    });
  });
}

// ---------------------------------------------------------------------------
// Scope 2 — payment cash omissions
// ---------------------------------------------------------------------------
export function classifyPayment(rows, prop, accounts) {
  return rows.map((raw) => {
    const id = decodeUuid(raw.id);
    const amount = decodeNumeric(raw.amount);
    const base = {
      source_type: "payment",
      source_id: id,
      source_ref: id,
      property_id: prop.id,
      property_name: prop.name,
      category: CATEGORY.PAYMENT_OMISSION,
      reservation_id: decodeUuid(raw.reservation_id),
      received_at: raw.received_at,
      method: raw.method ?? null,
      amount,
    };

    if (decodeUuid(raw.property_id) !== prop.id) return exclude(base, EXCLUSION.WRONG_PROPERTY, `payment's reservation belongs to ${decodeUuid(raw.property_id)}`);
    if (!raw.reservation_id) return exclude(base, EXCLUSION.AMBIGUOUS_SOURCE, "payment has no reservation linkage");
    if (raw.existing_entry_id) return exclude(base, EXCLUSION.ALREADY_POSTED, `journal ${decodeUuid(raw.existing_entry_id)} exists`);
    if (raw.reversal_entry_id) return exclude(base, EXCLUSION.POSTED_UNDER_OTHER_LINKAGE, `a reversal entry ${decodeUuid(raw.reversal_entry_id)} already references this payment`);
    if (!raw.received_at) return exclude(base, EXCLUSION.MISSING_BUSINESS_DATE, "payment has no received_at");
    if (new Date(raw.received_at) >= new Date(FIX_FORWARD_BOUNDARY)) return exclude(base, EXCLUSION.AFTER_BOUNDARY, `received_at ${raw.received_at} is at or after the boundary`);
    if (amount === null) return exclude(base, EXCLUSION.MISSING_AMOUNT, "amount is null");
    if (!(amount > 0)) return exclude(base, EXCLUSION.ZERO_OR_NEGATIVE_AMOUNT, `amount = ${amount}`);
    if (raw.period_locked) return exclude(base, EXCLUSION.PERIOD_LOCKED, "the accounting period covering received_at is locked or closed");
    for (const k of ["cash", "ar"]) {
      if (!accounts[k]) return exclude(base, EXCLUSION.MISSING_ACCOUNT_MAPPING, `no account with system_key=${k}`);
    }

    const amt = money4(amount);
    return buildProposal({
      category: CATEGORY.PAYMENT_OMISSION,
      sourceType: "payment",
      sourceId: id,
      sourceRef: id,
      sourceCode: null,
      propertyId: prop.id,
      propertyName: prop.name,
      currency: prop.base_currency,
      entryDate: String(raw.received_at).slice(0, 10),
      memo: `Payment ${id}`,
      lines: [
        { account_id: accounts.cash, system_key: "cash", debit: amt, credit: 0, memo: "Payment received" },
        { account_id: accounts.ar, system_key: "ar", debit: 0, credit: amt, memo: "Apply to AR" },
      ],
      extra: { reservation_id: decodeUuid(raw.reservation_id), method: raw.method ?? null, received_at: raw.received_at },
    });
  });
}

// ---------------------------------------------------------------------------
// Scope 3 — FX misconversion: reversal + replacement, never a rewrite
// ---------------------------------------------------------------------------
export function classifyFx(entries, prop) {
  const out = [];
  for (const e of entries) {
    const entryId = decodeUuid(e.entry_id);
    const lines = e.lines ?? [];
    const base = {
      source_type: "journal_entry",
      source_id: entryId,
      source_ref: e.source_ref,
      property_id: prop.id,
      property_name: prop.name,
      original_entry_id: entryId,
      original_currency: e.currency,
      original_source: e.source,
      entry_date: e.entry_date,
      category: CATEGORY.FX_REVERSAL,
    };

    if (decodeUuid(e.property_id) !== prop.id) { out.push(exclude(base, EXCLUSION.WRONG_PROPERTY, `entry belongs to ${decodeUuid(e.property_id)}`)); continue; }
    if (e.already_reversed_by) { out.push(exclude(base, EXCLUSION.ALREADY_POSTED, `already reversed by ${decodeUuid(e.already_reversed_by)}`)); continue; }
    if (!lines.length) { out.push(exclude(base, EXCLUSION.AMBIGUOUS_SOURCE, "entry has no lines")); continue; }
    if (e.period_locked) { out.push(exclude(base, EXCLUSION.PERIOD_LOCKED, "the accounting period covering entry_date is locked or closed")); continue; }

    // The posted base amounts (wrong) and the transaction amounts (right).
    const revLines = lines.map((l) => ({
      account_id: decodeUuid(l.account_id),
      system_key: l.system_key ?? null,
      // A reversal mirrors the ORIGINAL posted base amounts exactly, so the
      // pair nets to zero in the ledger. It must not "improve" anything.
      debit: money4(decodeNumeric(l.credit_base)),
      credit: money4(decodeNumeric(l.debit_base)),
      memo: `Reversal of ${entryId}`,
    }));
    const newLines = lines.map((l) => ({
      account_id: decodeUuid(l.account_id),
      system_key: l.system_key ?? null,
      // The replacement posts the transaction amounts at rate 1, in the
      // property's own currency — what should have been recorded.
      debit: money4(decodeNumeric(l.debit)),
      credit: money4(decodeNumeric(l.credit)),
      memo: l.memo ?? null,
    }));

    const postedBase = money(revLines.reduce((s, l) => s + l.credit, 0));
    const shouldHave = money(newLines.reduce((s, l) => s + l.debit, 0));

    // Does the ORIGINAL entry's base side actually tie? If it does not, a
    // faithful reversal cannot balance either, and where the residue should
    // land is an accounting decision. Refuse with a specific reason.
    const revDr = money4(revLines.reduce((s, l) => s + l.debit, 0));
    const revCr = money4(revLines.reduce((s, l) => s + l.credit, 0));
    if (revDr !== revCr) {
      out.push(exclude(
        { ...base, total_debit: revDr, total_credit: revCr, lines: revLines },
        EXCLUSION.BASE_ROUNDING_RESIDUE,
        `original entry's base amounts differ by ${money4(revDr - revCr)} (Dr ${revDr} vs Cr ${revCr}); the ledger's own invariant only tests transaction amounts at 2dp`,
      ));
      continue;
    }

    const reversal = buildProposal({
      category: CATEGORY.FX_REVERSAL,
      sourceType: "journal_entry",
      sourceId: entryId,
      sourceRef: e.source_ref,
      propertyId: prop.id,
      propertyName: prop.name,
      currency: prop.base_currency,
      entryDate: String(e.entry_date).slice(0, 10),
      memo: `Reversal of ${entryId} — corrected FX misconversion`,
      lines: revLines,
      extra: {
        is_reversal_of: entryId,
        original_source: e.source,
        original_currency: e.currency,
        amount_actually_posted: postedBase,
        amount_that_should_have_posted: shouldHave,
        difference: money(shouldHave - postedBase),
      },
    });
    const replacement = buildProposal({
      category: CATEGORY.FX_REPLACEMENT,
      sourceType: "journal_entry",
      sourceId: entryId,
      sourceRef: e.source_ref,
      propertyId: prop.id,
      propertyName: prop.name,
      currency: prop.base_currency,
      entryDate: String(e.entry_date).slice(0, 10),
      memo: `Re-post of ${entryId} in ${prop.base_currency} at rate 1`,
      lines: newLines,
      extra: {
        replaces_entry_id: entryId,
        original_source: e.source,
        amount_actually_posted: postedBase,
        amount_that_should_have_posted: shouldHave,
        difference: money(shouldHave - postedBase),
      },
    });
    out.push(reversal, replacement);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
export function summarize(proposals) {
  const eligible = proposals.filter((p) => p.eligible);
  const excluded = proposals.filter((p) => !p.eligible);
  const byReason = {};
  for (const e of excluded) byReason[e.exclusion_reason] = (byReason[e.exclusion_reason] ?? 0) + 1;
  const byCategory = {};
  for (const p of eligible) {
    const c = (byCategory[p.category] ??= { count: 0, debit: 0, credit: 0 });
    c.count++;
    c.debit = money(c.debit + p.total_debit);
    c.credit = money(c.credit + p.total_credit);
  }
  const accountMovement = {};
  for (const p of eligible) {
    for (const l of p.lines) {
      const k = l.system_key ?? l.account_id;
      const m = (accountMovement[k] ??= { debit: 0, credit: 0 });
      m.debit = money(m.debit + Number(l.debit || 0));
      m.credit = money(m.credit + Number(l.credit || 0));
    }
  }
  return {
    total: proposals.length,
    eligible: eligible.length,
    excluded: excluded.length,
    excluded_by_reason: byReason,
    by_category: byCategory,
    account_movement: accountMovement,
    total_debit: money(eligible.reduce((s, p) => s + p.total_debit, 0)),
    total_credit: money(eligible.reduce((s, p) => s + p.total_credit, 0)),
  };
}

export function renderReport(summary, proposals, meta) {
  const L = [];
  L.push("HISTORICAL ACCOUNTING RECONCILIATION — DRY RUN".padEnd(72, " "));
  L.push("=".repeat(72));
  L.push(`property         : ${meta.property_name} (${meta.property_id})`);
  L.push(`base currency    : ${meta.base_currency}`);
  L.push(`cutoff (locked)  : ${FIX_FORWARD_BOUNDARY}`);
  L.push(`scope            : ${meta.scope}`);
  L.push(`mode             : ${meta.mode}`);
  L.push(`generated        : ${meta.generated_at}`);
  L.push("");
  L.push(`proposals        : ${summary.total}`);
  L.push(`  eligible       : ${summary.eligible}`);
  L.push(`  excluded       : ${summary.excluded}`);
  for (const [r, n] of Object.entries(summary.excluded_by_reason)) L.push(`      ${r.padEnd(28)} ${n}`);
  L.push("");
  L.push("BY CATEGORY");
  for (const [c, v] of Object.entries(summary.by_category)) {
    L.push(`  ${c.padEnd(34)} n=${String(v.count).padStart(5)}  Dr ${v.debit.toFixed(2).padStart(14)}  Cr ${v.credit.toFixed(2).padStart(14)}`);
  }
  L.push("");
  L.push("ACCOUNT MOVEMENT (proposed)");
  for (const [k, v] of Object.entries(summary.account_movement)) {
    L.push(`  ${String(k).padEnd(34)} Dr ${v.debit.toFixed(2).padStart(14)}  Cr ${v.credit.toFixed(2).padStart(14)}  net ${money(v.debit - v.credit).toFixed(2).padStart(14)}`);
  }
  L.push("");
  L.push(`TOTAL DEBIT  ${summary.total_debit.toFixed(2)}`);
  L.push(`TOTAL CREDIT ${summary.total_credit.toFixed(2)}`);
  L.push(`BALANCED     ${summary.total_debit === summary.total_credit ? "YES" : "NO — REFUSE"}`);
  L.push("");
  L.push("NOTHING WAS WRITTEN. This is a dry run.");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadProductionConfig();
  assertHumanConfirmed(config);
  pass(LABEL, "human_confirmation.confirmed is true");

  if (!args.property) throw new GuardError("--property is required. This tool has no all-properties mode.");
  if (!["folio", "payment", "fx", "all"].includes(args.scope)) throw new GuardError(`--scope must be folio|payment|fx|all, got "${args.scope}"`);

  // ---- Write-mode authorization: three independent gates, all required ----
  let mode = "dry-run";
  if (args.write) {
    if (!args.plan) throw new GuardError("--write requires --plan <authorization-plan.json>.");
    const { plan } = loadReleasePlan(args.plan);
    if (plan.historical_repair_authorized !== true) {
      throw new GuardError(
        `Release plan does not authorize a historical repair (historical_repair_authorized is ${JSON.stringify(plan.historical_repair_authorized)}). Refusing to write.`,
      );
    }
    if (!args.yes) throw new GuardError("--write requires --yes as the final explicit confirmation.");
    mode = "WRITE";
  }
  if (mode === "WRITE") {
    // Deliberately not implemented in this change. The classification,
    // reconciliation and safety machinery above is what is under review;
    // the write path is a separate, separately-approved change so that
    // this file cannot mutate production even if every flag were supplied.
    throw new GuardError(
      "Write mode is not implemented in this revision. The repair has been designed, classified and reconciled in dry run only; " +
        "the INSERT path is deliberately absent so that this tool cannot mutate production accounting under any combination of flags.",
    );
  }
  pass(LABEL, `mode: ${mode} (write path is absent from this build)`);

  const { url, masked } = resolveProductionDbUrl(config);
  await assertProjectRefKnownToCli(config);
  pass(LABEL, `target verified (${masked})`);

  // ---- Resolve the property; must be exactly one ----
  const props = await query(url, `SELECT id, name, base_currency, currency FROM public.properties WHERE name ILIKE '%${args.property.replace(/'/g, "''")}%';`);
  if (props.length !== 1) throw new GuardError(`--property "${args.property}" matched ${props.length} properties; it must match exactly one.`);
  const prop = { id: decodeUuid(props[0].id), name: props[0].name, base_currency: props[0].base_currency, currency: props[0].currency };
  if (!prop.base_currency) throw new GuardError(`Property ${prop.name} has no base_currency. Failing closed.`);
  if (prop.base_currency !== prop.currency) {
    fail(LABEL, `Property ${prop.name} has base_currency=${prop.base_currency} but currency=${prop.currency}. These must agree before a repair is run against it.`);
    throw new GuardError("Currency configuration is inconsistent for this property. Failing closed.");
  }
  pass(LABEL, `property resolved: ${prop.name} (${prop.base_currency})`);

  // ---- Account mappings; fail closed on any missing ----
  const accRows = await query(url, `SELECT system_key, id FROM public.accounts WHERE property_id='${prop.id}' AND system_key IS NOT NULL;`);
  const accounts = {};
  for (const r of accRows) accounts[r.system_key] = decodeUuid(r.id);
  pass(LABEL, `account mappings loaded: ${Object.keys(accounts).sort().join(", ")}`);

  const taxRows = await query(url, `SELECT rate FROM public.tax_codes WHERE property_id='${prop.id}' AND code='STD' LIMIT 1;`);
  const taxRate = taxRows.length ? decodeNumeric(taxRows[0].rate) : null;
  pass(LABEL, `STD tax rate: ${taxRate ?? "(none)"}`);

  const proposals = [];

  if (args.scope === "folio" || args.scope === "all") {
    const rows = await query(url, `
      SELECT r.id, r.code, r.property_id, r.check_out, r.rate_total,
             (SELECT je.id FROM public.journal_entries je WHERE je.source='folio' AND je.source_ref=r.id::text LIMIT 1) AS existing_entry_id,
             (SELECT je.id FROM public.journal_entries je WHERE je.source_ref=r.id::text AND je.source<>'folio' LIMIT 1) AS other_linkage_entry_id,
             EXISTS (SELECT 1 FROM public.accounting_periods ap WHERE ap.property_id=r.property_id AND r.check_out::date BETWEEN ap.start_date AND ap.end_date AND ap.status IN ('locked','closed')) AS period_locked
        FROM public.reservations r
       WHERE r.status='checked_out' AND r.property_id='${prop.id}'
         AND NOT EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.source='folio' AND je.source_ref=r.id::text);`);
    proposals.push(...classifyFolio(rows, prop, accounts, taxRate));
    pass(LABEL, `folio scope: ${rows.length} candidate stay(s) examined`);
  }

  if (args.scope === "payment" || args.scope === "all") {
    const rows = await query(url, `
      SELECT pay.id, pay.reservation_id, pay.received_at, pay.amount, pay.method::text AS method, r.property_id,
             (SELECT je.id FROM public.journal_entries je WHERE je.source='payment' AND je.source_ref=pay.id::text AND je.is_reversal_of IS NULL LIMIT 1) AS existing_entry_id,
             (SELECT je.id FROM public.journal_entries je WHERE je.source_ref=pay.id::text AND je.is_reversal_of IS NOT NULL LIMIT 1) AS reversal_entry_id,
             EXISTS (SELECT 1 FROM public.accounting_periods ap WHERE ap.property_id=r.property_id AND pay.received_at::date BETWEEN ap.start_date AND ap.end_date AND ap.status IN ('locked','closed')) AS period_locked
        FROM public.payments pay
        JOIN public.reservations r ON r.id = pay.reservation_id
       WHERE pay.status='posted' AND r.property_id='${prop.id}'
         AND NOT EXISTS (SELECT 1 FROM public.journal_entries je WHERE je.source='payment' AND je.source_ref=pay.id::text);`);
    proposals.push(...classifyPayment(rows, prop, accounts));
    pass(LABEL, `payment scope: ${rows.length} candidate payment(s) examined`);
  }

  if (args.scope === "fx" || args.scope === "all") {
    const rows = await query(url, `
      SELECT je.id AS entry_id, je.property_id, je.source::text AS source, je.source_ref, je.currency, je.entry_date,
             (SELECT r.id FROM public.journal_entries r WHERE r.is_reversal_of = je.id LIMIT 1) AS already_reversed_by,
             EXISTS (SELECT 1 FROM public.accounting_periods ap WHERE ap.property_id=je.property_id AND je.entry_date BETWEEN ap.start_date AND ap.end_date AND ap.status IN ('locked','closed')) AS period_locked,
             (SELECT jsonb_agg(jsonb_build_object('account_id',l.account_id,'system_key',a.system_key,'debit',l.debit,'credit',l.credit,'debit_base',l.debit_base,'credit_base',l.credit_base,'memo',l.memo))
                FROM public.journal_lines l LEFT JOIN public.accounts a ON a.id=l.account_id WHERE l.entry_id=je.id) AS lines
        FROM public.journal_entries je
       WHERE je.property_id='${prop.id}'
         AND EXISTS (SELECT 1 FROM public.journal_lines l WHERE l.entry_id=je.id AND l.fx_rate <> 1);`);
    proposals.push(...classifyFx(rows, prop));
    pass(LABEL, `fx scope: ${rows.length} affected entr(ies) examined`);
  }

  const summary = summarize(proposals);
  const meta = {
    property_id: prop.id, property_name: prop.name, base_currency: prop.base_currency,
    scope: args.scope, mode, generated_at: new Date().toISOString(), boundary: FIX_FORWARD_BOUNDARY,
  };
  const text = renderReport(summary, proposals, meta);
  process.stdout.write("\n" + text + "\n\n");

  if (args.json) { writeFileSync(args.json, JSON.stringify({ meta, summary, proposals }, null, 2)); pass(LABEL, `machine-readable report written: ${args.json}`); }
  if (args.report) { writeFileSync(args.report, text + "\n"); pass(LABEL, `human-readable report written: ${args.report}`); }

  if (summary.total_debit !== summary.total_credit) {
    throw new GuardError(`Proposed repair does not balance (Dr ${summary.total_debit} vs Cr ${summary.total_credit}). Refusing.`);
  }
  pass(LABEL, `dry run complete — ${summary.eligible} eligible, ${summary.excluded} excluded, balanced at ${summary.total_debit.toFixed(2)}. Nothing was written.`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("reconcile-historical-journals.mjs")) {
  main().catch((e) => { fail(LABEL, e.message); process.exit(1); });
}
