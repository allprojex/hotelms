import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const foundationPath = path.join(
  root,
  "supabase/migrations/20260812120000_ar_customer_account_foundation.sql",
);
const hardeningPath = path.join(
  root,
  "supabase/migrations/20260812130000_ar_customer_function_acl_hardening.sql",
);
const foundation = fs.readFileSync(foundationPath, "utf8");
const hardening = fs.readFileSync(hardeningPath, "utf8");

describe("AR customer function ACL hardening", () => {
  const invoiceSignature =
    "public.create_ar_invoice(\n  uuid, uuid, date, date, text, text, jsonb\n)";

  it("keeps the invoice RPC SECURITY DEFINER with its internal property-role check", () => {
    expect(foundation).toMatch(
      /CREATE OR REPLACE FUNCTION public\.create_ar_invoice\([\s\S]*?LANGUAGE plpgsql SECURITY DEFINER SET search_path=public/,
    );
    expect(foundation).toContain("IF NOT public.has_any_role(auth.uid()");
    expect(foundation).toContain("_property_id) THEN");
  });

  it("revokes both PUBLIC and direct anon execution from the invoice RPC", () => {
    expect(hardening).toContain(
      `REVOKE EXECUTE ON FUNCTION ${invoiceSignature} FROM PUBLIC, anon;`,
    );
  });

  it("retains authenticated execution on the invoice RPC", () => {
    expect(hardening).toContain(
      `GRANT EXECUTE ON FUNCTION ${invoiceSignature} TO authenticated;`,
    );
  });

  it("does not grant invoice execution to anon", () => {
    expect(hardening).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.create_ar_invoice\([\s\S]*?\) TO anon/,
    );
  });

  it("removes every client-role execution path to the trigger-only helper", () => {
    expect(hardening).toContain(
      "REVOKE EXECUTE ON FUNCTION public.gen_ar_customer_code()\n  FROM PUBLIC, anon, authenticated;",
    );
    expect(hardening).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.gen_ar_customer_code\(\)/,
    );
  });

  it("does not alter functions, RLS, accounting data, or invoice behavior", () => {
    expect(hardening).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(hardening).not.toMatch(/ALTER TABLE|CREATE POLICY|DROP POLICY/i);
    expect(hardening).not.toMatch(/INSERT INTO|UPDATE public|DELETE FROM/i);
  });
});
