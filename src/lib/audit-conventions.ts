export const AUDIT_ACTIONS = {
  view: "view",
  create: "create",
  edit: "update",
  approve: "approve",
  deleteOrArchive: "delete",
  export: "export",
  print: "print",
  reversal: "reversal",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export type AuditMetadata = {
  sourceModule: string;
  correlationId?: string | null;
  occurredAt?: string;
};

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const SENSITIVE_KEY =
  /(password|passwd|passcode|pwd|secret|token|authorization|cookie|credential|private.?key|api.?key|service.?role|access.?key|biometric|fingerprint.?image|face.?image|receipt.?content|file.?content|document.?content|raw.?auth|base64|binary)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function redactAuditText(value: string): string {
  return value.replace(BEARER, "Bearer [REDACTED]").replace(JWT, REDACTED);
}

export function redactAuditValue(
  value: unknown,
  options: { maxDepth?: number; maxArrayLength?: number } = {},
): unknown {
  const maxDepth = options.maxDepth ?? 6;
  const maxArrayLength = options.maxArrayLength ?? 100;
  const seen = new WeakSet<object>();

  function walk(current: unknown, depth: number, key?: string): unknown {
    if (key && SENSITIVE_KEY.test(key)) return REDACTED;
    if (current === null || current === undefined) return current ?? null;
    if (typeof current === "string") return redactAuditText(current);
    if (
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "bigint"
    ) {
      return typeof current === "bigint" ? current.toString() : current;
    }
    if (current instanceof Date) return current.toISOString();
    if (typeof current !== "object") return String(current);
    if (depth >= maxDepth) return TRUNCATED;
    if (seen.has(current)) return TRUNCATED;
    seen.add(current);

    if (Array.isArray(current)) {
      const result = current.slice(0, maxArrayLength).map((item) => walk(item, depth + 1));
      if (current.length > maxArrayLength) result.push(TRUNCATED);
      return result;
    }

    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        walk(childValue, depth + 1, childKey),
      ]),
    );
  }

  return walk(value, 0);
}

export function normalizeAuditMetadata(
  metadata: AuditMetadata,
  now = new Date(),
): Required<AuditMetadata> {
  if (!/^[a-z][a-z0-9_]*$/.test(metadata.sourceModule)) {
    throw new Error("Audit source modules must use lower_snake_case");
  }
  return {
    sourceModule: metadata.sourceModule,
    correlationId: metadata.correlationId
      ? redactAuditText(metadata.correlationId).slice(0, 200)
      : null,
    occurredAt: metadata.occurredAt ?? now.toISOString(),
  };
}

export function auditMetadataRemarks(
  metadata: Required<AuditMetadata>,
  remarks?: string | null,
): string {
  const fields = [`source_module=${metadata.sourceModule}`, `occurred_at=${metadata.occurredAt}`];
  if (metadata.correlationId) {
    fields.push(`correlation_id=${metadata.correlationId}`);
  }
  if (remarks) fields.push(`remarks=${redactAuditText(remarks).slice(0, 1000)}`);
  return fields.join("; ");
}
