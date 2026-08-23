// Pure status computation for an inventory stock batch's expiry date.
// No hardcoded "expiring soon" threshold: the caller always supplies
// warningDays, sourced from properties.inventory_expiry_warning_days
// (see the 20260823130000_inventory_batch_expiration.sql migration).

export type BatchExpiryStatus = "expired" | "expiring_soon" | "valid" | "no_expiry";

export function computeBatchStatus(
  expiryDate: string | null,
  warningDays: number,
  today: Date = new Date(),
): BatchExpiryStatus {
  if (!expiryDate) return "no_expiry";

  const expiry = new Date(`${expiryDate}T00:00:00`);
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysUntilExpiry = Math.round((expiry.getTime() - todayMidnight.getTime()) / msPerDay);

  if (daysUntilExpiry < 0) return "expired";
  if (daysUntilExpiry <= warningDays) return "expiring_soon";
  return "valid";
}

export const BATCH_STATUS_LABEL: Record<BatchExpiryStatus, string> = {
  expired: "Expired",
  expiring_soon: "Expiring Soon",
  valid: "Valid",
  no_expiry: "No Expiry",
};

export const BATCH_STATUS_BADGE_VARIANT: Record<
  BatchExpiryStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  expired: "destructive",
  expiring_soon: "secondary",
  valid: "outline",
  no_expiry: "outline",
};
