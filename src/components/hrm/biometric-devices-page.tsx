/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 3C joined records await generated database types. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Cpu, Link2, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataQueryState } from "@/components/shared/data-query-controls";
import { HrmPageHeader } from "@/components/hrm/shared";
import { useActiveProperty } from "@/hooks/use-active-property";
import { usePermission } from "@/hooks/use-permission";
import { HRM_ADMIN_ROLES } from "@/lib/hrm/permissions";
import {
  convertBiometricEvent,
  getBiometricArchitecture,
  saveBiometricDevice,
  saveBiometricMapping,
} from "@/lib/hrm/biometric.functions";
import { getLeaveBootstrap } from "@/lib/hrm/leave.functions";

export function BiometricDevicesPage() {
  const propertyId = useActiveProperty();
  const get = useServerFn(getBiometricArchitecture);
  const bootstrap = useServerFn(getLeaveBootstrap);
  const convert = useServerFn(convertBiometricEvent);
  const qc = useQueryClient();
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);
  const manageDevices = usePermission({
    propertyId,
    module: "biometric_devices",
    capability: "manage_settings",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const manageMappings = usePermission({
    propertyId,
    module: "biometric_mappings",
    capability: "manage_settings",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const processEvents = usePermission({
    propertyId,
    module: "biometric_events",
    capability: "create",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const query = useQuery({
    queryKey: ["biometric-architecture", propertyId],
    enabled: !!propertyId,
    queryFn: () => get({ data: { propertyId: propertyId! } }) as Promise<any>,
  });
  const options = useQuery({
    queryKey: ["leave-bootstrap", propertyId],
    enabled: !!propertyId,
    queryFn: () => bootstrap({ data: { propertyId: propertyId! } }) as Promise<any>,
  });
  async function process(id: string) {
    try {
      const result = await convert({ data: { propertyId: propertyId!, eventId: id } });
      toast.success(
        result.attendanceEventId
          ? "Converted to immutable attendance event"
          : "Event remains unmapped",
      );
      qc.invalidateQueries({ queryKey: ["biometric-architecture"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Conversion failed");
    }
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Biometric Devices"
        description="Vendor-neutral attendance integration foundation."
        actions={
          manageDevices.allowed || manageMappings.allowed ? (
            <div className="flex gap-2">
              {manageMappings.allowed && (
                <Button variant="outline" onClick={() => setMappingOpen(true)}>
                  <Link2 className="mr-1 h-4 w-4" />
                  Add mapping
                </Button>
              )}
              {manageDevices.allowed && (
                <Button onClick={() => setDeviceOpen(true)}>
                  <Plus className="mr-1 h-4 w-4" />
                  Add device
                </Button>
              )}
            </div>
          ) : null
        }
      />
      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>Architecture ready — no live physical-device adapter configured</AlertTitle>
        <AlertDescription>
          No raw fingerprint images, facial images, or biometric templates are stored. Credentials
          remain external secret references and are never sent to the browser.
        </AlertDescription>
      </Alert>
      <DataQueryState loading={query.isLoading} error={query.error} empty={!query.data}>
        <div className="space-y-5">
          <section>
            <h2 className="mb-2 font-semibold">Devices</h2>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {query.data?.devices.map((row: any) => (
                <Card key={row.id} className="p-4">
                  <div className="flex justify-between">
                    <Cpu className="h-5 w-5" />
                    <Badge variant="outline">{row.status}</Badge>
                  </div>
                  <h3 className="mt-2 font-semibold">{row.name}</h3>
                  <p className="text-sm text-muted-foreground">
                    {row.provider_adapter} · {row.location || "No location"}
                  </p>
                  <p className="mt-2 text-xs">
                    Connector:{" "}
                    {row.hasConnectorReference ? "External secret reference" : "Not configured"}
                  </p>
                </Card>
              ))}
            </div>
          </section>
          <section>
            <h2 className="mb-2 font-semibold">Employee mappings</h2>
            <Card className="divide-y">
              {query.data?.mappings.map((row: any) => (
                <div key={row.id} className="flex justify-between p-3 text-sm">
                  <span>
                    {row.employee?.employee_number} · {row.employee?.first_name}{" "}
                    {row.employee?.last_name}
                  </span>
                  <span className="text-muted-foreground">
                    {row.device?.name}: {row.external_employee_identifier}
                  </span>
                </div>
              ))}
            </Card>
          </section>
          <section>
            <h2 className="mb-2 font-semibold">Review queue</h2>
            <Card className="divide-y">
              {query.data?.events.map((row: any) => (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
                >
                  <div>
                    <Badge variant="outline">{row.processing_status}</Badge>{" "}
                    {row.external_employee_identifier} · {row.event_type} · {row.event_at}
                  </div>
                  {processEvents.allowed && (
                    <Button size="sm" variant="outline" onClick={() => process(row.id)}>
                      <RefreshCw className="mr-1 h-3 w-3" />
                      Retry mapping
                    </Button>
                  )}
                </div>
              ))}
            </Card>
          </section>
        </div>
      </DataQueryState>
      {deviceOpen && propertyId && (
        <DeviceDialog propertyId={propertyId} onClose={() => setDeviceOpen(false)} />
      )}
      {mappingOpen && propertyId && query.data && options.data && (
        <MappingDialog
          propertyId={propertyId}
          devices={query.data.devices}
          employees={options.data.employees}
          onClose={() => setMappingOpen(false)}
        />
      )}
    </div>
  );
}
function DeviceDialog({ propertyId, onClose }: { propertyId: string; onClose: () => void }) {
  const save = useServerFn(saveBiometricDevice);
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [adapter, setAdapter] = useState("generic_placeholder");
  const [reference, setReference] = useState("");
  async function submit() {
    try {
      await save({
        data: {
          propertyId,
          name,
          location,
          providerAdapter: adapter,
          connectorConfigReference: reference || null,
          status: "unconfigured",
          capability: ["clock_in", "clock_out"],
          healthMetadata: { architecture: "placeholder" },
        },
      });
      qc.invalidateQueries({ queryKey: ["biometric-architecture"] });
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to save device");
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add device architecture record</DialogTitle>
        </DialogHeader>
        <Field id="device-name" label="Name" value={name} onChange={setName} />
        <Field id="device-location" label="Location" value={location} onChange={setLocation} />
        <Field id="device-adapter" label="Adapter type" value={adapter} onChange={setAdapter} />
        <Field
          id="device-secret"
          label="External connector reference (secret://…)"
          value={reference}
          onChange={setReference}
        />
        <p className="text-xs text-muted-foreground">
          This does not connect physical hardware. No credential value is stored here.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name || !adapter} onClick={submit}>
            Save architecture record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function MappingDialog({
  propertyId,
  devices,
  employees,
  onClose,
}: {
  propertyId: string;
  devices: any[];
  employees: any[];
  onClose: () => void;
}) {
  const save = useServerFn(saveBiometricMapping);
  const qc = useQueryClient();
  const [device, setDevice] = useState("");
  const [employee, setEmployee] = useState("");
  const [external, setExternal] = useState("");
  async function submit() {
    try {
      await save({
        data: { propertyId, deviceId: device, employeeId: employee, externalIdentifier: external },
      });
      qc.invalidateQueries({ queryKey: ["biometric-architecture"] });
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to save mapping");
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Map external employee identifier</DialogTitle>
        </DialogHeader>
        <NativeSelect
          id="mapping-device"
          label="Device"
          value={device}
          onChange={setDevice}
          options={devices.map((v) => ({ value: v.id, label: v.name }))}
        />
        <NativeSelect
          id="mapping-employee"
          label="Employee"
          value={employee}
          onChange={setEmployee}
          options={employees.map((v) => ({
            value: v.id,
            label: `${v.employee_number} · ${v.first_name} ${v.last_name}`,
          }))}
        />
        <Field
          id="external-id"
          label="External identifier"
          value={external}
          onChange={setExternal}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!device || !employee || !external.trim()} onClick={submit}>
            Save mapping
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function Field({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
function NativeSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="w-full rounded-md border bg-background p-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
