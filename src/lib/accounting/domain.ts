import { safeStorageSegment } from "@/lib/hrm/domain";

export function uuid(value: unknown): string {
  const v = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v)) throw new Error("Valid identifier required");
  return v;
}

export function optionalUuid(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return uuid(value);
}

export function reasonText(value: unknown, min = 5, max = 500): string {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length < min) throw new Error(`A reason of at least ${min} characters is required`);
  return trimmed.slice(0, max);
}

export const EXPENSE_RECEIPT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export const MAX_EXPENSE_RECEIPT_BYTES = 10 * 1024 * 1024;

export function validateExpenseReceiptFile(file: { type: string; size: number }): void {
  if (
    !EXPENSE_RECEIPT_MIME_TYPES.includes(file.type as (typeof EXPENSE_RECEIPT_MIME_TYPES)[number])
  ) {
    throw new Error("Unsupported receipt file type");
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_EXPENSE_RECEIPT_BYTES) {
    throw new Error("Receipt must be between 1 byte and 10 MB");
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

export function expenseReceiptStoragePath(input: {
  propertyId: string;
  expenseId: string;
  receiptId: string;
  fileName: string;
}): string {
  if (![input.propertyId, input.expenseId, input.receiptId].every((value) => UUID_RE.test(value))) {
    throw new Error("Invalid storage identifier");
  }
  return `${input.propertyId}/expenses/${input.expenseId}/${input.receiptId}-${safeStorageSegment(input.fileName)}`;
}

export function formatMoney(amount: number | string, currency: string): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "GHS",
    currencyDisplay: "narrowSymbol",
  }).format(Number.isFinite(value) ? value : 0);
}

export const EXPENSE_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  returned: "Returned",
  cancelled: "Cancelled",
  reversed: "Reversed",
};

export const FINANCIAL_PERIOD_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  closed: "Closed",
  locked: "Locked",
};
