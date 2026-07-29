export type NormalizedBiometricEvent = {
  sourceEventId: string;
  externalEmployeeIdentifier: string;
  eventAt: string;
  eventType: "clock_in" | "clock_out" | "break_start" | "break_end";
  deduplicationKey: string;
  payloadHash?: string;
  safeProviderReference?: string;
};

export interface BiometricAttendanceAdapter {
  readonly adapterType: string;
  readonly supportsPolling: boolean;
  readonly supportsWebhook: boolean;
  normalize(input: unknown): NormalizedBiometricEvent[];
}

export function assertSafeBiometricMetadata(value: Record<string, unknown>): void {
  const keys = Object.keys(value).join(" ");
  if (
    /(fingerprint|face.?image|template|credential|password|secret|token|raw.?payload)/i.test(keys)
  ) {
    throw new Error("Raw biometric data and credentials are forbidden");
  }
}
