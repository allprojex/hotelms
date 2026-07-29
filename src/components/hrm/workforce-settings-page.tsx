import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { DataQueryState } from "@/components/shared/data-query-controls";
import { HrmPageHeader } from "@/components/hrm/shared";
import { useActiveProperty } from "@/hooks/use-active-property";
import { usePermission } from "@/hooks/use-permission";
import { HRM_ADMIN_ROLES } from "@/lib/hrm/permissions";
import { getWorkforceSettings, saveWorkforceSettings } from "@/lib/hrm/workforce.functions";

type Settings = {
  timezone: string;
  default_working_days: number[];
  standard_start_time: string;
  standard_end_time: string;
  grace_period_minutes: number;
  late_threshold_minutes: number;
  early_departure_threshold_minutes: number;
  minimum_full_day_minutes: number;
  minimum_half_day_minutes: number;
  maximum_open_shift_minutes: number;
  allow_overnight_shifts: boolean;
  weekend_treatment: string;
  holiday_treatment: string;
  rounding_rule: string;
  rounding_interval_minutes: number;
  attendance_approval_required: boolean;
  manual_adjustment_enabled: boolean;
  biometric_attendance_enabled: boolean;
  biometric_integration_mode: string;
  maximum_consecutive_workdays: number;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function WorkforceSettingsPage() {
  const propertyId = useActiveProperty();
  const getSettings = useServerFn(getWorkforceSettings);
  const saveSettings = useServerFn(saveWorkforceSettings);
  const queryClient = useQueryClient();
  const permission = usePermission({
    propertyId,
    module: "workforce_settings",
    capability: "manage_settings",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const query = useQuery({
    queryKey: ["workforce-settings", propertyId],
    enabled: !!propertyId,
    queryFn: async () => (await getSettings({ data: { propertyId: propertyId! } })) as Settings,
  });
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);

  async function submit() {
    if (!form || !propertyId) return;
    setBusy(true);
    try {
      await saveSettings({
        data: {
          propertyId,
          timezone: form.timezone,
          defaultWorkingDays: form.default_working_days,
          standardStartTime: trimTime(form.standard_start_time),
          standardEndTime: trimTime(form.standard_end_time),
          gracePeriodMinutes: form.grace_period_minutes,
          lateThresholdMinutes: form.late_threshold_minutes,
          earlyDepartureThresholdMinutes: form.early_departure_threshold_minutes,
          minimumFullDayMinutes: form.minimum_full_day_minutes,
          minimumHalfDayMinutes: form.minimum_half_day_minutes,
          maximumOpenShiftMinutes: form.maximum_open_shift_minutes,
          allowOvernightShifts: form.allow_overnight_shifts,
          weekendTreatment: form.weekend_treatment,
          holidayTreatment: form.holiday_treatment,
          roundingRule: form.rounding_rule,
          roundingIntervalMinutes: form.rounding_interval_minutes,
          attendanceApprovalRequired: form.attendance_approval_required,
          manualAdjustmentEnabled: form.manual_adjustment_enabled,
          biometricAttendanceEnabled: form.biometric_attendance_enabled,
          biometricIntegrationMode: form.biometric_integration_mode,
          maximumConsecutiveWorkdays: form.maximum_consecutive_workdays,
        },
      });
      toast.success("Workforce settings saved");
      queryClient.invalidateQueries({ queryKey: ["workforce-settings", propertyId] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save workforce settings");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Workforce Settings"
        description="Property timezone and scheduling policy for later attendance workflows."
      />
      <DataQueryState loading={query.isLoading} error={query.error} empty={!form}>
        {form && (
          <div className="space-y-4">
            <Card className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
              <Field
                id="workforce-timezone"
                label="IANA timezone"
                value={form.timezone}
                onChange={(timezone) => setForm({ ...form, timezone })}
              />
              <Field
                id="workforce-start"
                label="Standard start"
                type="time"
                value={trimTime(form.standard_start_time)}
                onChange={(standard_start_time) => setForm({ ...form, standard_start_time })}
              />
              <Field
                id="workforce-end"
                label="Standard end"
                type="time"
                value={trimTime(form.standard_end_time)}
                onChange={(standard_end_time) => setForm({ ...form, standard_end_time })}
              />
              <NumberField
                label="Grace period (minutes)"
                value={form.grace_period_minutes}
                onChange={(grace_period_minutes) => setForm({ ...form, grace_period_minutes })}
              />
              <NumberField
                label="Late threshold (minutes)"
                value={form.late_threshold_minutes}
                onChange={(late_threshold_minutes) => setForm({ ...form, late_threshold_minutes })}
              />
              <NumberField
                label="Early-departure threshold"
                value={form.early_departure_threshold_minutes}
                onChange={(early_departure_threshold_minutes) =>
                  setForm({ ...form, early_departure_threshold_minutes })
                }
              />
              <NumberField
                label="Full-day minimum (minutes)"
                value={form.minimum_full_day_minutes}
                onChange={(minimum_full_day_minutes) =>
                  setForm({ ...form, minimum_full_day_minutes })
                }
              />
              <NumberField
                label="Half-day minimum (minutes)"
                value={form.minimum_half_day_minutes}
                onChange={(minimum_half_day_minutes) =>
                  setForm({ ...form, minimum_half_day_minutes })
                }
              />
              <NumberField
                label="Maximum open shift (minutes)"
                value={form.maximum_open_shift_minutes}
                onChange={(maximum_open_shift_minutes) =>
                  setForm({ ...form, maximum_open_shift_minutes })
                }
              />
              <NumberField
                label="Maximum consecutive workdays"
                value={form.maximum_consecutive_workdays}
                onChange={(maximum_consecutive_workdays) =>
                  setForm({ ...form, maximum_consecutive_workdays })
                }
              />
              <Choice
                id="weekend-treatment"
                label="Weekend treatment"
                value={form.weekend_treatment}
                options={["normal", "non_working", "premium_placeholder"]}
                onChange={(weekend_treatment) => setForm({ ...form, weekend_treatment })}
              />
              <Choice
                id="holiday-treatment"
                label="Holiday treatment"
                value={form.holiday_treatment}
                options={["normal", "non_working", "premium_placeholder"]}
                onChange={(holiday_treatment) => setForm({ ...form, holiday_treatment })}
              />
              <Choice
                id="rounding-rule"
                label="Rounding rule"
                value={form.rounding_rule}
                options={["none", "nearest", "up", "down"]}
                onChange={(rounding_rule) => setForm({ ...form, rounding_rule })}
              />
              <Choice
                id="rounding-interval"
                label="Rounding interval"
                value={String(form.rounding_interval_minutes)}
                options={["5", "10", "15", "30", "60"]}
                onChange={(value) => setForm({ ...form, rounding_interval_minutes: Number(value) })}
              />
              <Choice
                id="biometric-mode"
                label="Biometric integration placeholder"
                value={form.biometric_integration_mode}
                options={[
                  "disabled",
                  "manual_placeholder",
                  "api_placeholder",
                  "device_placeholder",
                ]}
                onChange={(biometric_integration_mode) =>
                  setForm({
                    ...form,
                    biometric_integration_mode,
                    biometric_attendance_enabled: biometric_integration_mode !== "disabled",
                  })
                }
              />
            </Card>
            <Card className="p-4">
              <Label>Default working days</Label>
              <div className="mt-2 flex flex-wrap gap-3">
                {DAYS.map((day, index) => (
                  <label key={day} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.default_working_days.includes(index)}
                      onCheckedChange={(checked) =>
                        setForm({
                          ...form,
                          default_working_days: checked
                            ? [...form.default_working_days, index]
                            : form.default_working_days.filter((value) => value !== index),
                        })
                      }
                    />
                    {day}
                  </label>
                ))}
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Toggle
                  label="Allow overnight shifts"
                  value={form.allow_overnight_shifts}
                  onChange={(allow_overnight_shifts) =>
                    setForm({ ...form, allow_overnight_shifts })
                  }
                />
                <Toggle
                  label="Attendance approval required"
                  value={form.attendance_approval_required}
                  onChange={(attendance_approval_required) =>
                    setForm({ ...form, attendance_approval_required })
                  }
                />
                <Toggle
                  label="Manual adjustments enabled"
                  value={form.manual_adjustment_enabled}
                  onChange={(manual_adjustment_enabled) =>
                    setForm({ ...form, manual_adjustment_enabled })
                  }
                />
                <Toggle
                  label="Biometric attendance flag"
                  value={form.biometric_attendance_enabled}
                  onChange={(biometric_attendance_enabled) =>
                    setForm({
                      ...form,
                      biometric_attendance_enabled,
                      biometric_integration_mode: biometric_attendance_enabled
                        ? "manual_placeholder"
                        : "disabled",
                    })
                  }
                />
              </div>
            </Card>
            {permission.allowed && (
              <div className="flex justify-end">
                <Button disabled={busy} onClick={submit}>
                  {busy ? "Saving…" : "Save workforce settings"}
                </Button>
              </div>
            )}
          </div>
        )}
      </DataQueryState>
    </div>
  );
}

function Field(props: {
  id: string;
  label: string;
  value: string;
  type?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        type={props.type}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

function NumberField(props: { label: string; value: number; onChange: (value: number) => void }) {
  const id = props.label.toLowerCase().replace(/\W+/g, "-");
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{props.label}</Label>
      <Input
        id={id}
        type="number"
        min={0}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </div>
  );
}

function Choice(props: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Select value={props.value} onValueChange={props.onChange}>
        <SelectTrigger id={props.id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((option) => (
            <SelectItem key={option} value={option}>
              {option.replace(/_/g, " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Toggle(props: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
      {props.label}
      <Switch checked={props.value} onCheckedChange={props.onChange} />
    </label>
  );
}

function trimTime(value: string): string {
  return value.slice(0, 5);
}
