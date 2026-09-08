import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { BiometricDevicesPage } from "@/components/hrm/biometric-devices-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";
export const Route = createFileRoute("/_authenticated/hrm/biometric-devices")({
  head: () => ({ meta: [{ title: pageTitle("Biometric Architecture") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <BiometricDevicesPage />
    </HrmWorkspaceShell>
  ),
});
