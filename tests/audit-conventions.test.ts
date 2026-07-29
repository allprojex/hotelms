import { describe, expect, it } from "vitest";
import {
  auditMetadataRemarks,
  normalizeAuditMetadata,
  redactAuditText,
  redactAuditValue,
} from "@/lib/audit-conventions";
import { captureAuditEvent, type AuditContext } from "@/lib/audit.server";

describe("audit conventions", () => {
  it("redacts nested secrets and sensitive document contents", () => {
    const value = redactAuditValue({
      username: "frontdesk",
      password: "NeverLogThis",
      nested: {
        api_key: "secret-key",
        receipt_content: "binary receipt",
        guest: "Ada",
      },
    });
    expect(value).toEqual({
      username: "frontdesk",
      password: "[REDACTED]",
      nested: {
        api_key: "[REDACTED]",
        receipt_content: "[REDACTED]",
        guest: "Ada",
      },
    });
  });

  it("redacts bearer tokens and JWT-shaped strings", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value_123";
    expect(redactAuditText(`Bearer abc.def-123 ${jwt}`)).not.toContain("abc.def-123");
    expect(redactAuditText(jwt)).toBe("[REDACTED]");
  });

  it("normalizes shared source, correlation, and timestamp metadata", () => {
    const metadata = normalizeAuditMetadata(
      { sourceModule: "accounting_reports", correlationId: "req-42" },
      new Date("2026-07-29T12:00:00.000Z"),
    );
    expect(metadata.occurredAt).toBe("2026-07-29T12:00:00.000Z");
    expect(auditMetadataRemarks(metadata)).toContain("source_module=accounting_reports");
    expect(auditMetadataRemarks(metadata)).toContain("correlation_id=req-42");
  });

  it("sanitizes snapshots and treats non-critical write failures as best effort", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const context = {
      userId: "user-1",
      supabase: {
        rpc: async (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args });
          if (name === "can_access_property") return { data: true, error: null };
          return { data: null, error: { message: "audit unavailable" } };
        },
      },
    } as unknown as AuditContext;

    const result = await captureAuditEvent(context, {
      propertyId: "property-1",
      action: "export",
      resourceType: "report",
      resourceId: "guest_report",
      sourceModule: "guest_reports",
      correlationId: "req-7",
      newValues: { password: "hidden", count: 2 },
    });

    expect(result).toEqual({
      logged: false,
      id: null,
      error: "audit unavailable",
    });
    expect(calls[1].args._after).toEqual({
      password: "[REDACTED]",
      count: 2,
    });
    expect(calls[1].args._remarks).toContain("source_module=guest_reports");
  });
});
