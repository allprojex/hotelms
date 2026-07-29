import { createFileRoute } from "@tanstack/react-router";
import { BiometricDevicesPage } from "@/components/hrm/biometric-devices-page";
export const Route = createFileRoute("/_authenticated/hrm/biometric-devices")({
  head: () => ({ meta: [{ title: "Biometric Architecture · ThesKwoff Hotel" }] }),
  component: BiometricDevicesPage,
});
