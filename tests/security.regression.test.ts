/**
 * Security regression suite.
 * Guards against reintroduction of previously-fixed vulnerabilities:
 *   1. SSRF via user-supplied webhook URLs
 *   2. Unauthenticated backup cron dispatcher
 *   3. Audit-trail injection across properties
 *   4. Analytics export IDOR (running another property's schedule)
 *
 * Run: bunx vitest run tests/security.regression.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// 1. SSRF URL guard
// ---------------------------------------------------------------------------
import { assertSafeOutboundUrl } from "@/lib/server/url-guard";

describe("SSRF guard — assertSafeOutboundUrl", () => {
  const BLOCKED = [
    "http://localhost/x",
    "http://127.0.0.1/x",
    "http://127.5.6.7/x",
    "http://10.0.0.1/x",
    "http://192.168.1.1/x",
    "http://169.254.169.254/latest/meta-data/", // AWS metadata
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://0.0.0.0/x",
    "http://172.16.0.1/x",
    "http://172.31.255.255/x",
    "http://[::1]/x",
    "http://[fe80::1]/x",
    "http://[fd00::1]/x",
  ];
  const ALLOWED = [
    "https://example.com/webhook",
    "https://hooks.slack.com/services/T/B/xyz",
    "http://8.8.8.8/x",
    "https://api.stripe.com/v1/foo",
  ];
  const INVALID = ["", "not a url", "ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)"];

  for (const u of BLOCKED) {
    it(`blocks ${u}`, () => {
      expect(() => assertSafeOutboundUrl(u)).toThrow();
    });
  }
  for (const u of ALLOWED) {
    it(`allows ${u}`, () => {
      expect(() => assertSafeOutboundUrl(u)).not.toThrow();
    });
  }
  for (const u of INVALID) {
    it(`rejects invalid ${JSON.stringify(u)}`, () => {
      expect(() => assertSafeOutboundUrl(u)).toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Backup cron auth — call the file route's POST handler directly
// ---------------------------------------------------------------------------
vi.mock("@/lib/backup.server", () => ({
  runDueSchedules: vi.fn(async () => ({ ran: 0, skipped: 0 })),
}));

async function callBackupRun(headers: Record<string, string>) {
  const mod = await import("@/routes/api/public/hooks/backup-run");
  const handler = (mod as any).Route.options.server.handlers.POST;
  const req = new Request("https://example.test/api/public/hooks/backup-run", {
    method: "POST", headers,
  });
  return handler({ request: req });
}

describe("Backup cron dispatcher — /api/public/hooks/backup-run", () => {
  const ORIG = process.env.CRON_SECRET;
  beforeEach(() => { process.env.CRON_SECRET = "test-secret-abc"; });
  afterEach(() => { process.env.CRON_SECRET = ORIG; vi.clearAllMocks(); });

  it("rejects request with no auth header (401)", async () => {
    const res = await callBackupRun({});
    expect(res.status).toBe(401);
  });

  it("rejects wrong x-cron-secret (401)", async () => {
    const res = await callBackupRun({ "x-cron-secret": "wrong" });
    expect(res.status).toBe(401);
  });

  it("rejects wrong bearer token (401)", async () => {
    const res = await callBackupRun({ authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  it("rejects Supabase publishable-key style bearer (401)", async () => {
    // Previously this endpoint was called with the anon key from the client bundle.
    const res = await callBackupRun({
      authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.key",
    });
    expect(res.status).toBe(401);
  });

  it("accepts matching x-cron-secret (200)", async () => {
    const res = await callBackupRun({ "x-cron-secret": "test-secret-abc" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("accepts matching Bearer token (200)", async () => {
    const res = await callBackupRun({ authorization: "Bearer test-secret-abc" });
    expect(res.status).toBe(200);
  });

  it("returns 500 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await callBackupRun({ "x-cron-secret": "anything" });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 3. Analytics export IDOR — expectedPropertyId must match schedule
// ---------------------------------------------------------------------------
const scheduleFixture = {
  id: "sched-1", property_id: "prop-A", frequency: "daily", format: "csv",
  recipients: [], enabled: true,
};

vi.mock("@/integrations/supabase/client.server", () => {
  const supabaseAdmin: any = {
    from: vi.fn((table: string) => {
      if (table === "analytics_export_schedules") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: scheduleFixture, error: null }) }),
          }),
        };
      }
      if (table === "analytics_export_runs") {
        return {
          insert: () => ({
            select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      return {};
    }),
    rpc: vi.fn(async () => ({ data: [], error: null })),
  };
  return { supabaseAdmin };
});

describe("runScheduledExport — ownership guard", () => {
  it("throws when expectedPropertyId does not match schedule", async () => {
    const { runScheduledExport } = await import("@/lib/analytics-exports.server");
    await expect(
      runScheduledExport("sched-1", { expectedPropertyId: "prop-B-attacker" }),
    ).rejects.toThrow(/does not belong/i);
  });

  it("throws when schedule id is unknown", async () => {
    const { supabaseAdmin } = (await import("@/integrations/supabase/client.server")) as any;
    (supabaseAdmin.from as any).mockImplementationOnce(() => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }));
    const { runScheduledExport } = await import("@/lib/analytics-exports.server");
    await expect(
      runScheduledExport("missing", { expectedPropertyId: "prop-A" }),
    ).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Audit-trail injection — source-level regression check
// createServerFn handlers require the full server middleware stack to invoke;
// assert the guard remains present so it cannot be silently removed.
// ---------------------------------------------------------------------------
describe("logAuditEvent — property-access guard", () => {
  const src = readFileSync(resolve(__dirname, "../src/lib/audit.server.ts"), "utf8");
  const wrapper = readFileSync(resolve(__dirname, "../src/lib/audit.functions.ts"), "utf8");

  it("routes the public server function through the guarded audit helper", () => {
    expect(wrapper).toContain("captureAuditEvent");
  });

  it("calls can_access_property before recording property-scoped events", () => {
    expect(src).toMatch(/rpc\(\s*["']can_access_property["']/);
    expect(src).toMatch(/Not authorized to record audit events for this property/);
  });

  it("requires super_admin for system-level (null property) events", () => {
    expect(src).toMatch(/rpc\(\s*["']has_role["']/);
    expect(src).toMatch(/Only super_admin may record system-level audit events/);
  });

  it("guard runs before audit_capture insert", () => {
    const guardIdx = src.indexOf("can_access_property");
    const insertIdx = src.indexOf("audit_capture");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(insertIdx);
  });
});
