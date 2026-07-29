/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 4A joined rows await generated types. */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  Archive,
  Banknote,
  CalendarDays,
  CheckCircle2,
  Eye,
  Plus,
  RotateCcw,
  Save,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { DataQueryState, ServerPagination } from "@/components/shared/data-query-controls";
import { HrmPageHeader, OptionalSelect, useHrmListState } from "@/components/hrm/shared";
import { useActiveProperty } from "@/hooks/use-active-property";
import { usePermission } from "@/hooks/use-permission";
import { PAYROLL_SENSITIVE_ROLES } from "@/lib/hrm/permissions";
import {
  correctOpeningBalance,
  generatePlannedPayCalendar,
  getPayrollBootstrap,
  listPaymentDetails,
  listPayrollResource,
  previewPayCalendar,
  revealPaymentDetail,
  saveCompensation,
  saveEmployeeComponent,
  savePayComponent,
  savePayFrequency,
  savePaymentDetail,
  savePayrollSettings,
  saveSalaryGrade,
  saveSalaryStructure,
  saveStatutoryRule,
  saveStructureComponent,
  setPayFrequencyArchived,
  setPayrollConfigurationArchived,
  stageOpeningBalance,
  verifyPaymentDetail,
} from "@/lib/hrm/payroll.functions";

function useBootstrap() {
  const propertyId = useActiveProperty();
  const get = useServerFn(getPayrollBootstrap);
  const query = useQuery({
    queryKey: ["payroll-bootstrap", propertyId],
    enabled: !!propertyId,
    queryFn: () => get({ data: { propertyId: propertyId! } }) as Promise<any>,
  });
  return { propertyId, query };
}

function PhaseNotice({ children }: { children?: React.ReactNode }) {
  return (
    <Alert>
      <ShieldAlert className="h-4 w-4" />
      <AlertTitle>Phase 4A configuration foundation</AlertTitle>
      <AlertDescription>
        Payroll calculations, payroll runs, payslips, payment files, statutory submissions, and
        accounting journals are not available. {children}
      </AlertDescription>
    </Alert>
  );
}

function money(value: number | string, currency = "USD") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

export function PayrollOverviewPage() {
  const { query } = useBootstrap();
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Payroll Overview"
        description="Configuration readiness for future payroll processing."
      />
      <PhaseNotice>No payroll totals or financial results are generated on this page.</PhaseNotice>
      <DataQueryState loading={query.isLoading} error={query.error} empty={!query.data}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Summary
            title="Payroll status"
            value={query.data?.settings?.payroll_enabled ? "Enabled for configuration" : "Disabled"}
          />
          <Summary title="Currency" value={query.data?.property?.base_currency ?? "—"} />
          <Summary title="Pay frequencies" value={query.data?.frequencies.length ?? 0} />
          <Summary title="Salary structures" value={query.data?.structures.length ?? 0} />
        </div>
      </DataQueryState>
    </div>
  );
}

function Summary({ title, value }: { title: string; value: React.ReactNode }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="mt-2 text-xl font-semibold">{value}</p>
    </Card>
  );
}

export function PayrollSettingsPage() {
  const { propertyId, query } = useBootstrap();
  const save = useServerFn(savePayrollSettings);
  const qc = useQueryClient();
  const settings = query.data?.settings;
  const property = query.data?.property;
  const [form, setForm] = useState<any>(null);
  const values = form ?? {
    effectiveFrom: new Date().toISOString().slice(0, 10),
    payrollEnabled: settings?.payroll_enabled ?? false,
    displayName: settings?.display_name ?? "Payroll",
    currency: property?.base_currency ?? "USD",
    jurisdictionCode: settings?.jurisdiction_code ?? "UNSPECIFIED",
    defaultPayFrequencyId: settings?.default_pay_frequency_id ?? "",
    timezone: settings?.timezone ?? property?.timezone ?? "UTC",
    roundingMethod: settings?.rounding_method ?? "half_up",
    monetaryPrecision: settings?.monetary_precision ?? 2,
    defaultPaymentMethod: settings?.default_payment_method ?? "bank_transfer",
    salaryProrationMethod: settings?.salary_proration_method ?? "working_days",
    unpaidDayMethod: settings?.unpaid_day_method ?? "working_days",
    workingDaysBasis: settings?.working_days_basis ?? 260,
    calendarDaysBasis: settings?.calendar_days_basis ?? 365,
    approvalRequired: settings?.approval_required ?? true,
    finalizationRequiresApproval: settings?.finalization_requires_approval ?? true,
    allowNegativeNetPay: settings?.allow_negative_net_pay ?? false,
    allowRetroactiveAdjustments: settings?.allow_retroactive_adjustments ?? true,
    requireEmployeeBankDetails: settings?.require_employee_bank_details ?? false,
    payslipVisibilityPlaceholder: settings?.payslip_visibility_placeholder ?? "after_finalization",
    payrollYearStartMonth: settings?.payroll_year_start_month ?? 1,
  };
  const update = (key: string, value: unknown) => setForm({ ...values, [key]: value });
  async function submit() {
    try {
      await save({ data: { propertyId: propertyId!, ...values } });
      await qc.invalidateQueries({ queryKey: ["payroll-bootstrap"] });
      setForm(null);
      toast.success("New effective-dated payroll settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save settings");
    }
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Payroll Settings"
        description="Effective-dated property payroll controls."
      />
      <PhaseNotice>Enabling configuration does not activate payroll processing.</PhaseNotice>
      <DataQueryState loading={query.isLoading} error={query.error} empty={!query.data}>
        <Card className="space-y-4 p-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Field
              id="settings-effective"
              label="Effective from"
              type="date"
              value={values.effectiveFrom}
              onChange={(v) => update("effectiveFrom", v)}
            />
            <Field
              id="settings-name"
              label="Display name"
              value={values.displayName}
              onChange={(v) => update("displayName", v)}
            />
            <Field
              id="settings-currency"
              label="Property currency"
              value={values.currency}
              onChange={(v) => update("currency", v.toUpperCase())}
            />
            <Field
              id="settings-jurisdiction"
              label="Jurisdiction code"
              value={values.jurisdictionCode}
              onChange={(v) => update("jurisdictionCode", v)}
            />
            <Field
              id="settings-timezone"
              label="IANA timezone"
              value={values.timezone}
              onChange={(v) => update("timezone", v)}
            />
            <NumberField
              id="settings-precision"
              label="Monetary precision"
              value={values.monetaryPrecision}
              onChange={(v) => update("monetaryPrecision", v)}
            />
            <NumberField
              id="settings-working-days"
              label="Working-days basis"
              value={values.workingDaysBasis}
              onChange={(v) => update("workingDaysBasis", v)}
            />
            <NumberField
              id="settings-calendar-days"
              label="Calendar-days basis"
              value={values.calendarDaysBasis}
              onChange={(v) => update("calendarDaysBasis", v)}
            />
            <NumberField
              id="settings-year-month"
              label="Payroll year start month"
              value={values.payrollYearStartMonth}
              onChange={(v) => update("payrollYearStartMonth", v)}
            />
            <Choice
              id="settings-rounding"
              label="Rounding"
              value={values.roundingMethod}
              values={["half_up", "half_even", "down", "up"]}
              onChange={(v) => update("roundingMethod", v)}
            />
            <Choice
              id="settings-payment"
              label="Default payment method"
              value={values.defaultPaymentMethod}
              values={["bank_transfer", "mobile_money", "cash", "cheque", "other"]}
              onChange={(v) => update("defaultPaymentMethod", v)}
            />
            <Choice
              id="settings-proration"
              label="Salary proration placeholder"
              value={values.salaryProrationMethod}
              values={["working_days", "calendar_days", "fixed_days", "none"]}
              onChange={(v) => update("salaryProrationMethod", v)}
            />
            <Choice
              id="settings-unpaid"
              label="Unpaid-day placeholder"
              value={values.unpaidDayMethod}
              values={["working_days", "calendar_days", "fixed_days", "none"]}
              onChange={(v) => update("unpaidDayMethod", v)}
            />
            <OptionalSelect
              id="settings-frequency"
              label="Default pay frequency"
              value={values.defaultPayFrequencyId}
              onChange={(v) => update("defaultPayFrequencyId", v)}
              options={(query.data?.frequencies ?? []).map((row: any) => ({
                value: row.id,
                label: row.name,
              }))}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Check
              label="Payroll configuration enabled"
              value={values.payrollEnabled}
              onChange={(v) => update("payrollEnabled", v)}
            />
            <Check
              label="Approval required later"
              value={values.approvalRequired}
              onChange={(v) => update("approvalRequired", v)}
            />
            <Check
              label="Finalization will require approval"
              value={values.finalizationRequiresApproval}
              onChange={(v) => update("finalizationRequiresApproval", v)}
            />
            <Check
              label="Allow negative net pay later"
              value={values.allowNegativeNetPay}
              onChange={(v) => update("allowNegativeNetPay", v)}
            />
            <Check
              label="Allow retroactive adjustments later"
              value={values.allowRetroactiveAdjustments}
              onChange={(v) => update("allowRetroactiveAdjustments", v)}
            />
            <Check
              label="Require employee bank details"
              value={values.requireEmployeeBankDetails}
              onChange={(v) => update("requireEmployeeBankDetails", v)}
            />
          </div>
          <Button onClick={submit}>
            <Save className="mr-1 h-4 w-4" />
            Save new effective version
          </Button>
        </Card>
      </DataQueryState>
    </div>
  );
}

export function PayCalendarsPage() {
  const { propertyId, query: options } = useBootstrap();
  const list = useServerFn(listPayrollResource);
  const save = useServerFn(savePayFrequency);
  const archive = useServerFn(setPayFrequencyArchived);
  const preview = useServerFn(previewPayCalendar);
  const generate = useServerFn(generatePlannedPayCalendar);
  const qc = useQueryClient();
  const [year, setYear] = useState(new Date().getFullYear());
  const [showArchived, setShowArchived] = useState(false);
  const [selectedFrequency, setSelectedFrequency] = useState("");
  const [previewRows, setPreviewRows] = useState<any[]>([]);
  const [form, setForm] = useState({
    name: "",
    code: "",
    frequencyType: "monthly",
    periodsPerYear: 12,
    intervalDays: 30,
    firstPeriodStart: `${year}-01-01`,
    cutoffOffsetDays: 0,
    paymentOffsetDays: 0,
    weekendAdjustment: "previous_working_day",
    holidayAdjustment: "previous_working_day",
  });
  const frequencies = useQuery({
    queryKey: ["payroll-resource", propertyId, "frequencies", showArchived],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: {
          propertyId: propertyId!,
          resource: "frequencies",
          status: showArchived ? "archived" : "active",
          page: 1,
          pageSize: 100,
        },
      }) as Promise<any>,
  });
  const periods = useQuery({
    queryKey: ["payroll-resource", propertyId, "periods", selectedFrequency],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: {
          propertyId: propertyId!,
          resource: "periods",
          parentId: selectedFrequency || undefined,
          page: 1,
          pageSize: 100,
        },
      }) as Promise<any>,
  });
  async function addFrequency() {
    try {
      await save({ data: { propertyId: propertyId!, ...form, continuousPeriods: true } });
      qc.invalidateQueries({ queryKey: ["payroll-resource"] });
      qc.invalidateQueries({ queryKey: ["payroll-bootstrap"] });
      toast.success("Pay frequency created");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to create frequency");
    }
  }
  async function previewOrGenerate(commit: boolean) {
    if (!selectedFrequency) return toast.error("Select a pay frequency");
    try {
      if (commit) {
        const result = await generate({
          data: { propertyId: propertyId!, frequencyId: selectedFrequency, payrollYear: year },
        });
        toast.success(`${result.created} planned periods generated`);
        qc.invalidateQueries({ queryKey: ["payroll-resource"] });
      } else {
        setPreviewRows(
          (await preview({
            data: { propertyId: propertyId!, frequencyId: selectedFrequency, payrollYear: year },
          })) as any[],
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Calendar action failed");
    }
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Pay Calendars"
        description="Configurable frequencies and planned periods only."
      />
      <PhaseNotice>Generated periods do not create payroll runs.</PhaseNotice>
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">Add pay frequency</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            id="freq-name"
            label="Name"
            value={form.name}
            onChange={(v) => setForm({ ...form, name: v })}
          />
          <Field
            id="freq-code"
            label="Code"
            value={form.code}
            onChange={(v) => setForm({ ...form, code: v })}
          />
          <Choice
            id="freq-type"
            label="Frequency type"
            value={form.frequencyType}
            values={["weekly", "biweekly", "semimonthly", "monthly", "quarterly", "custom"]}
            onChange={(v) => setForm({ ...form, frequencyType: v })}
          />
          <NumberField
            id="freq-periods"
            label="Periods/year"
            value={form.periodsPerYear}
            onChange={(v) => setForm({ ...form, periodsPerYear: v })}
          />
          <NumberField
            id="freq-days"
            label="Interval days"
            value={form.intervalDays}
            onChange={(v) => setForm({ ...form, intervalDays: v })}
          />
          <Field
            id="freq-first"
            label="First period start"
            type="date"
            value={form.firstPeriodStart}
            onChange={(v) => setForm({ ...form, firstPeriodStart: v })}
          />
          <NumberField
            id="freq-cutoff"
            label="Cut-off offset days"
            value={form.cutoffOffsetDays}
            onChange={(v) => setForm({ ...form, cutoffOffsetDays: v })}
          />
          <NumberField
            id="freq-payment"
            label="Payment offset days"
            value={form.paymentOffsetDays}
            onChange={(v) => setForm({ ...form, paymentOffsetDays: v })}
          />
        </div>
        <Button onClick={addFrequency}>
          <Plus className="mr-1 h-4 w-4" />
          Add frequency
        </Button>
      </Card>
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <OptionalSelect
            id="calendar-frequency"
            label="Frequency"
            value={selectedFrequency}
            onChange={setSelectedFrequency}
            options={(options.data?.frequencies ?? []).map((r: any) => ({
              value: r.id,
              label: r.name,
            }))}
          />
          <NumberField id="calendar-year" label="Payroll year" value={year} onChange={setYear} />
          <Button variant="outline" onClick={() => previewOrGenerate(false)}>
            Preview
          </Button>
          <Button onClick={() => previewOrGenerate(true)}>Generate planned periods</Button>
        </div>
        {!!previewRows.length && (
          <p className="text-sm">{previewRows.length} continuous planned periods previewed.</p>
        )}
      </Card>
      <div className="grid gap-3 md:grid-cols-2">
        <Button variant="outline" onClick={() => setShowArchived((value) => !value)}>
          <RotateCcw className="mr-1 h-4 w-4" />
          {showArchived ? "Show active frequencies" : "Restore archived frequencies"}
        </Button>
        {frequencies.data?.rows.map((row: any) => (
          <Card key={row.id} className="p-4">
            <div className="flex justify-between">
              <h3 className="font-semibold">{row.name}</h3>
              <Badge>{row.frequency_type}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {row.code} · {row.periods_per_year} periods/year
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                archive({
                  data: { propertyId: propertyId!, id: row.id, archived: !showArchived },
                })
                  .then(() => qc.invalidateQueries({ queryKey: ["payroll-resource"] }))
                  .catch((e) => toast.error(e.message))
              }
            >
              {showArchived ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
            </Button>
          </Card>
        ))}
        {periods.data?.rows.map((row: any) => (
          <Card key={row.id} className="p-4">
            <div className="flex justify-between">
              <h3 className="font-semibold">{row.period_label}</h3>
              <Badge variant="outline">{row.status}</Badge>
            </div>
            <p className="text-sm">
              {row.start_date} – {row.end_date}
            </p>
            <p className="text-xs text-muted-foreground">
              Expected payment: {row.expected_payment_date}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function SalaryStructuresPage() {
  const { propertyId, query: options } = useBootstrap();
  const list = useServerFn(listPayrollResource);
  const saveStructure = useServerFn(saveSalaryStructure);
  const saveGrade = useServerFn(saveSalaryGrade);
  const attach = useServerFn(saveStructureComponent);
  const archive = useServerFn(setPayrollConfigurationArchived);
  const qc = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [structure, setStructure] = useState({
    name: "",
    code: "",
    payFrequencyId: "",
    effectiveFrom: new Date().toISOString().slice(0, 10),
    description: "",
  });
  const [grade, setGrade] = useState({
    salaryStructureId: "",
    name: "",
    code: "",
    rankOrder: 0,
    minimum: 0,
    midpoint: 0,
    maximum: 0,
    effectiveFrom: new Date().toISOString().slice(0, 10),
  });
  const [attachment, setAttachment] = useState({
    salaryStructureId: "",
    gradeId: "",
    payComponentId: "",
    effectiveFrom: new Date().toISOString().slice(0, 10),
    required: true,
  });
  const rows = useQuery({
    queryKey: ["payroll-resource", propertyId, "structures", showArchived],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: {
          propertyId: propertyId!,
          resource: "structures",
          status: showArchived ? "archived" : "active",
          page: 1,
          pageSize: 100,
        },
      }) as Promise<any>,
  });
  async function run(action: () => Promise<unknown>, message: string) {
    try {
      await action();
      qc.invalidateQueries({ queryKey: ["payroll-resource"] });
      qc.invalidateQueries({ queryKey: ["payroll-bootstrap"] });
      toast.success(message);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to save");
    }
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Salary Structures"
        description="Effective-dated structures, grades, and component attachments."
      />
      <PhaseNotice />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="space-y-3 p-4">
          <h2 className="font-semibold">New structure version</h2>
          <Field
            id="structure-name"
            label="Name"
            value={structure.name}
            onChange={(v) => setStructure({ ...structure, name: v })}
          />
          <Field
            id="structure-code"
            label="Code"
            value={structure.code}
            onChange={(v) => setStructure({ ...structure, code: v })}
          />
          <OptionalSelect
            id="structure-frequency"
            label="Pay frequency"
            value={structure.payFrequencyId}
            onChange={(v) => setStructure({ ...structure, payFrequencyId: v })}
            options={(options.data?.frequencies ?? []).map((r: any) => ({
              value: r.id,
              label: r.name,
            }))}
          />
          <Field
            id="structure-effective"
            label="Effective from"
            type="date"
            value={structure.effectiveFrom}
            onChange={(v) => setStructure({ ...structure, effectiveFrom: v })}
          />
          <Button
            onClick={() =>
              run(
                () =>
                  saveStructure({
                    data: {
                      propertyId: propertyId!,
                      ...structure,
                      currency: options.data.property.base_currency,
                    },
                  }),
                "Structure created",
              )
            }
          >
            Create structure
          </Button>
        </Card>
        <Card className="space-y-3 p-4">
          <h2 className="font-semibold">New salary grade</h2>
          <OptionalSelect
            id="grade-structure"
            label="Structure"
            value={grade.salaryStructureId}
            onChange={(v) => setGrade({ ...grade, salaryStructureId: v })}
            options={(options.data?.structures ?? []).map((r: any) => ({
              value: r.id,
              label: r.name,
            }))}
          />
          <Field
            id="grade-name"
            label="Grade name"
            value={grade.name}
            onChange={(v) => setGrade({ ...grade, name: v })}
          />
          <Field
            id="grade-code"
            label="Grade code"
            value={grade.code}
            onChange={(v) => setGrade({ ...grade, code: v })}
          />
          <div className="grid grid-cols-3 gap-2">
            <NumberField
              id="grade-min"
              label="Minimum"
              value={grade.minimum}
              onChange={(v) => setGrade({ ...grade, minimum: v })}
            />
            <NumberField
              id="grade-mid"
              label="Midpoint"
              value={grade.midpoint}
              onChange={(v) => setGrade({ ...grade, midpoint: v })}
            />
            <NumberField
              id="grade-max"
              label="Maximum"
              value={grade.maximum}
              onChange={(v) => setGrade({ ...grade, maximum: v })}
            />
          </div>
          <Button
            onClick={() =>
              run(() => saveGrade({ data: { propertyId: propertyId!, ...grade } }), "Grade created")
            }
          >
            Create grade
          </Button>
        </Card>
        <Card className="space-y-3 p-4">
          <h2 className="font-semibold">Attach component</h2>
          <OptionalSelect
            id="attachment-structure"
            label="Structure"
            value={attachment.salaryStructureId}
            onChange={(v) => setAttachment({ ...attachment, salaryStructureId: v })}
            options={(options.data?.structures ?? []).map((r: any) => ({
              value: r.id,
              label: r.name,
            }))}
          />
          <OptionalSelect
            id="attachment-grade"
            label="Optional grade"
            value={attachment.gradeId}
            onChange={(v) => setAttachment({ ...attachment, gradeId: v })}
            options={(options.data?.grades ?? [])
              .filter((r: any) => r.salary_structure_id === attachment.salaryStructureId)
              .map((r: any) => ({ value: r.id, label: r.name }))}
          />
          <OptionalSelect
            id="attachment-component"
            label="Pay component"
            value={attachment.payComponentId}
            onChange={(v) => setAttachment({ ...attachment, payComponentId: v })}
            options={(options.data?.components ?? []).map((r: any) => ({
              value: r.id,
              label: r.name,
            }))}
          />
          <Button
            onClick={() =>
              run(
                () => attach({ data: { propertyId: propertyId!, ...attachment } }),
                "Component attached",
              )
            }
          >
            Attach definition
          </Button>
        </Card>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Button variant="outline" onClick={() => setShowArchived((value) => !value)}>
          <RotateCcw className="mr-1 h-4 w-4" />
          {showArchived ? "Show active structures" : "Restore archived structures"}
        </Button>
        {rows.data?.rows.map((row: any) => (
          <Card key={row.id} className="p-4">
            <h3 className="font-semibold">{row.name}</h3>
            <p className="text-sm">
              {row.code} · {row.currency}
            </p>
            <p className="text-xs text-muted-foreground">Effective {row.effective_from}</p>
            <Button
              size="icon"
              variant="ghost"
              onClick={() =>
                run(
                  () =>
                    archive({
                      data: {
                        propertyId: propertyId!,
                        resource: "structure",
                        id: row.id,
                        archived: !showArchived,
                      },
                    }),
                  showArchived ? "Structure restored" : "Structure archived",
                )
              }
            >
              {showArchived ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function PayComponentsPage() {
  const { propertyId, query: options } = useBootstrap();
  const list = useServerFn(listPayrollResource);
  const save = useServerFn(savePayComponent);
  const archive = useServerFn(setPayrollConfigurationArchived);
  const qc = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState<any>({
    name: "",
    code: "",
    componentType: "earning",
    valueType: "fixed",
    calculationMethod: "fixed_amount",
    defaultAmount: 0,
    defaultPercentage: null,
    percentageBasisCode: "",
    recurrence: "recurring",
    effectiveFrom: new Date().toISOString().slice(0, 10),
    prorationEnabled: false,
    attendanceSensitive: false,
    leaveSensitive: false,
    overtimeSensitive: false,
  });
  const query = useQuery({
    queryKey: ["payroll-resource", propertyId, "components", showArchived],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: {
          propertyId: propertyId!,
          resource: "components",
          status: showArchived ? "archived" : "active",
          page: 1,
          pageSize: 100,
        },
      }) as Promise<any>,
  });
  async function submit() {
    try {
      await save({
        data: { propertyId: propertyId!, ...form, currency: options.data.property.base_currency },
      });
      qc.invalidateQueries({ queryKey: ["payroll-resource"] });
      qc.invalidateQueries({ queryKey: ["payroll-bootstrap"] });
      toast.success("Pay component definition created");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to save component");
    }
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Pay Components"
        description="Reusable definitions only; no formulas are executed."
      />
      <PhaseNotice />
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            id="component-name"
            label="Name"
            value={form.name}
            onChange={(v) => setForm({ ...form, name: v })}
          />
          <Field
            id="component-code"
            label="Code"
            value={form.code}
            onChange={(v) => setForm({ ...form, code: v })}
          />
          <Choice
            id="component-type"
            label="Type"
            value={form.componentType}
            values={[
              "earning",
              "deduction",
              "employer_contribution",
              "employee_contribution",
              "reimbursement",
              "informational",
            ]}
            onChange={(v) => setForm({ ...form, componentType: v })}
          />
          <Choice
            id="component-method"
            label="Stored method"
            value={form.calculationMethod}
            values={["fixed_amount", "percentage", "manual_input", "none"]}
            onChange={(v) =>
              setForm({
                ...form,
                calculationMethod: v,
                defaultAmount: v === "percentage" ? null : form.defaultAmount,
                defaultPercentage: v === "fixed_amount" ? null : form.defaultPercentage,
              })
            }
          />
          {form.calculationMethod === "fixed_amount" && (
            <NumberField
              id="component-amount"
              label="Default amount"
              value={form.defaultAmount ?? 0}
              onChange={(v) => setForm({ ...form, defaultAmount: v })}
            />
          )}
          {form.calculationMethod === "percentage" && (
            <>
              <NumberField
                id="component-percentage"
                label="Default percentage"
                value={form.defaultPercentage ?? 0}
                onChange={(v) => setForm({ ...form, defaultPercentage: v })}
              />
              <Field
                id="component-basis"
                label="Percentage basis code"
                value={form.percentageBasisCode}
                onChange={(v) => setForm({ ...form, percentageBasisCode: v })}
              />
            </>
          )}
          <Field
            id="component-effective"
            label="Effective from"
            type="date"
            value={form.effectiveFrom}
            onChange={(v) => setForm({ ...form, effectiveFrom: v })}
          />
        </div>
        <div className="flex flex-wrap gap-4">
          <Check
            label="Proration flag"
            value={form.prorationEnabled}
            onChange={(v) => setForm({ ...form, prorationEnabled: v })}
          />
          <Check
            label="Attendance-sensitive flag"
            value={form.attendanceSensitive}
            onChange={(v) => setForm({ ...form, attendanceSensitive: v })}
          />
          <Check
            label="Leave-sensitive flag"
            value={form.leaveSensitive}
            onChange={(v) => setForm({ ...form, leaveSensitive: v })}
          />
          <Check
            label="Overtime-sensitive flag"
            value={form.overtimeSensitive}
            onChange={(v) => setForm({ ...form, overtimeSensitive: v })}
          />
        </div>
        <Button onClick={submit}>Create definition</Button>
      </Card>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Button variant="outline" onClick={() => setShowArchived((value) => !value)}>
          <RotateCcw className="mr-1 h-4 w-4" />
          {showArchived ? "Show active components" : "Restore archived components"}
        </Button>
        {query.data?.rows.map((row: any) => (
          <Card key={row.id} className="p-4">
            <div className="flex justify-between">
              <h3 className="font-semibold">{row.name}</h3>
              <Badge>{row.component_type}</Badge>
            </div>
            <p className="text-sm">
              {row.code} · {row.calculation_method}
            </p>
            <p className="text-xs text-muted-foreground">
              Definition only · Effective {row.effective_from}
            </p>
            <Button
              size="icon"
              variant="ghost"
              onClick={() =>
                archive({
                  data: {
                    propertyId: propertyId!,
                    resource: "component",
                    id: row.id,
                    archived: !showArchived,
                  },
                })
                  .then(() => qc.invalidateQueries({ queryKey: ["payroll-resource"] }))
                  .catch((error) => toast.error(error.message))
              }
            >
              {showArchived ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function EmployeeCompensationPage() {
  const { propertyId, query: options } = useBootstrap();
  const list = useServerFn(listPayrollResource);
  const save = useServerFn(saveCompensation);
  const attach = useServerFn(saveEmployeeComponent);
  const qc = useQueryClient();
  const [form, setForm] = useState<any>({
    employeeId: "",
    salaryStructureId: "",
    gradeId: "",
    payFrequencyId: "",
    baseSalary: 0,
    effectiveFrom: new Date().toISOString().slice(0, 10),
    employmentPercentage: 100,
    paymentMethod: "bank_transfer",
    reason: "",
    gradeBandOverride: false,
    gradeBandOverrideReason: "",
  });
  const [component, setComponent] = useState<any>({
    compensationId: "",
    payComponentId: "",
    fixedAmount: null,
    percentage: null,
    recurrence: "recurring",
    startDate: new Date().toISOString().slice(0, 10),
    reason: "",
  });
  const query = useQuery({
    queryKey: ["payroll-resource", propertyId, "compensations"],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: { propertyId: propertyId!, resource: "compensations", page: 1, pageSize: 100 },
      }) as Promise<any>,
  });
  async function create() {
    try {
      await save({
        data: { propertyId: propertyId!, ...form, currency: options.data.property.base_currency },
      });
      qc.invalidateQueries({ queryKey: ["payroll-resource"] });
      toast.success("New effective compensation record created");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to save compensation");
    }
  }
  async function addComponent() {
    try {
      await attach({ data: { propertyId: propertyId!, ...component } });
      toast.success("Employee component assignment created");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to assign component");
    }
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Employee Compensation"
        description="Restricted effective-dated compensation assignments."
      />
      <PhaseNotice>Base salaries are stored but no gross or net pay is calculated.</PhaseNotice>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="space-y-3 p-4">
          <h2 className="font-semibold">New compensation record</h2>
          <OptionalSelect
            id="comp-employee"
            label="Employee"
            value={form.employeeId}
            onChange={(v) => setForm({ ...form, employeeId: v })}
            options={(options.data?.employees ?? []).map((r: any) => ({
              value: r.id,
              label: `${r.employee_number} · ${r.first_name} ${r.last_name}`,
            }))}
          />
          <OptionalSelect
            id="comp-structure"
            label="Salary structure"
            value={form.salaryStructureId}
            onChange={(v) => setForm({ ...form, salaryStructureId: v })}
            options={(options.data?.structures ?? []).map((r: any) => ({
              value: r.id,
              label: r.name,
            }))}
          />
          <OptionalSelect
            id="comp-grade"
            label="Grade"
            value={form.gradeId}
            onChange={(v) => setForm({ ...form, gradeId: v })}
            options={(options.data?.grades ?? [])
              .filter((r: any) => r.salary_structure_id === form.salaryStructureId)
              .map((r: any) => ({
                value: r.id,
                label: `${r.name} (${money(r.minimum_base_salary, options.data?.property.base_currency)}–${money(r.maximum_base_salary, options.data?.property.base_currency)})`,
              }))}
          />
          <OptionalSelect
            id="comp-frequency"
            label="Pay frequency"
            value={form.payFrequencyId}
            onChange={(v) => setForm({ ...form, payFrequencyId: v })}
            options={(options.data?.frequencies ?? []).map((r: any) => ({
              value: r.id,
              label: r.name,
            }))}
          />
          <NumberField
            id="comp-salary"
            label="Base salary"
            value={form.baseSalary}
            onChange={(v) => setForm({ ...form, baseSalary: v })}
          />
          <Field
            id="comp-effective"
            label="Effective from"
            type="date"
            value={form.effectiveFrom}
            onChange={(v) => setForm({ ...form, effectiveFrom: v })}
          />
          <Field
            id="comp-reason"
            label="Reason for change"
            value={form.reason}
            onChange={(v) => setForm({ ...form, reason: v })}
          />
          <Check
            label="Authorized grade-band override"
            value={form.gradeBandOverride}
            onChange={(v) => setForm({ ...form, gradeBandOverride: v })}
          />
          {form.gradeBandOverride && (
            <Field
              id="comp-override-reason"
              label="Override reason"
              value={form.gradeBandOverrideReason}
              onChange={(v) => setForm({ ...form, gradeBandOverrideReason: v })}
            />
          )}
          <Button onClick={create}>Create compensation version</Button>
        </Card>
        <Card className="space-y-3 p-4">
          <h2 className="font-semibold">Employee component assignment</h2>
          <OptionalSelect
            id="employee-component-comp"
            label="Compensation record"
            value={component.compensationId}
            onChange={(v) => setComponent({ ...component, compensationId: v })}
            options={(query.data?.rows ?? []).map((r: any) => ({
              value: r.id,
              label: `${r.employee_id} · ${r.effective_from}`,
            }))}
          />
          <OptionalSelect
            id="employee-component-pay"
            label="Pay component"
            value={component.payComponentId}
            onChange={(v) => setComponent({ ...component, payComponentId: v })}
            options={(options.data?.components ?? []).map((r: any) => ({
              value: r.id,
              label: r.name,
            }))}
          />
          <NumberField
            id="employee-component-amount"
            label="Fixed override (0 for none)"
            value={component.fixedAmount ?? 0}
            onChange={(v) =>
              setComponent({ ...component, fixedAmount: v || null, percentage: null })
            }
          />
          <Field
            id="employee-component-reason"
            label="Reason"
            value={component.reason}
            onChange={(v) => setComponent({ ...component, reason: v })}
          />
          <Button onClick={addComponent}>Assign component</Button>
        </Card>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {query.data?.rows.map((row: any) => (
          <Card key={row.id} className="p-4">
            <div className="flex justify-between">
              <Banknote className="h-5 w-5" />
              <Badge>{row.approval_status}</Badge>
            </div>
            <p className="mt-2 font-semibold">{money(row.base_salary, row.currency)}</p>
            <p className="text-xs text-muted-foreground">
              Effective {row.effective_from} · Historical records are preserved
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function PaymentDetailsPage() {
  const { propertyId, query: options } = useBootstrap();
  const list = useServerFn(listPaymentDetails);
  const save = useServerFn(savePaymentDetail);
  const reveal = useServerFn(revealPaymentDetail);
  const verify = useServerFn(verifyPaymentDetail);
  const qc = useQueryClient();
  const state = useHrmListState();
  const canReveal = usePermission({
    propertyId,
    module: "payment_details_full",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const canVerify = usePermission({
    propertyId,
    module: "payment_details",
    capability: "approve",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const [form, setForm] = useState<any>({
    employeeId: "",
    paymentMethod: "bank_transfer",
    accountName: "",
    bankName: "",
    branchName: "",
    accountNumber: "",
    routingCode: "",
    mobileProvider: "",
    mobileNumber: "",
    paymentReference: "",
    isPrimary: true,
    effectiveFrom: new Date().toISOString().slice(0, 10),
  });
  const query = useQuery({
    queryKey: ["payroll-payment-details", propertyId, state.page, state.pageSize],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: { propertyId: propertyId!, page: state.page, pageSize: state.pageSize },
      }) as Promise<any>,
  });
  async function submit() {
    try {
      await save({ data: { propertyId: propertyId!, ...form } });
      qc.invalidateQueries({ queryKey: ["payroll-payment-details"] });
      toast.success("Encrypted payment detail saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to save payment detail");
    }
  }
  async function show(row: any) {
    const reason = prompt("Audited reason for revealing full payment details:") ?? "";
    if (reason.trim().length < 5) return;
    try {
      const value = await reveal({ data: { propertyId: propertyId!, id: row.id, reason } });
      alert(
        `Account: ${value.accountNumber ?? "—"}\nRouting: ${value.routingCode ?? "—"}\nMobile: ${value.mobileNumber ?? "—"}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reveal unavailable");
    }
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Payment Details"
        description="Restricted and masked employee payment destinations."
      />
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Sensitive financial data</AlertTitle>
        <AlertDescription>
          Full values require a server encryption key, explicit reveal permission, a reason, and an
          audit event. No payment files are created.
        </AlertDescription>
      </Alert>
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <OptionalSelect
            id="payment-employee"
            label="Employee"
            value={form.employeeId}
            onChange={(v) => setForm({ ...form, employeeId: v })}
            options={(options.data?.employees ?? []).map((r: any) => ({
              value: r.id,
              label: `${r.employee_number} · ${r.first_name} ${r.last_name}`,
            }))}
          />
          <Choice
            id="payment-method"
            label="Payment method"
            value={form.paymentMethod}
            values={["bank_transfer", "mobile_money", "cash", "cheque", "other"]}
            onChange={(v) => setForm({ ...form, paymentMethod: v })}
          />
          <Field
            id="payment-account-name"
            label="Account name"
            value={form.accountName}
            onChange={(v) => setForm({ ...form, accountName: v })}
          />
          <Field
            id="payment-bank"
            label="Bank name"
            value={form.bankName}
            onChange={(v) => setForm({ ...form, bankName: v })}
          />
          <Field
            id="payment-account"
            label="Account number"
            value={form.accountNumber}
            onChange={(v) => setForm({ ...form, accountNumber: v })}
          />
          <Field
            id="payment-routing"
            label="Routing/sort code"
            value={form.routingCode}
            onChange={(v) => setForm({ ...form, routingCode: v })}
          />
          <Field
            id="payment-mobile-provider"
            label="Mobile-money provider"
            value={form.mobileProvider}
            onChange={(v) => setForm({ ...form, mobileProvider: v })}
          />
          <Field
            id="payment-mobile"
            label="Mobile-money number"
            value={form.mobileNumber}
            onChange={(v) => setForm({ ...form, mobileNumber: v })}
          />
        </div>
        <Check
          label="Primary payment method"
          value={form.isPrimary}
          onChange={(v) => setForm({ ...form, isPrimary: v })}
        />
        <Button onClick={submit}>Encrypt and save</Button>
      </Card>
      <DataQueryState
        loading={query.isLoading}
        error={query.error}
        empty={!query.data?.rows.length}
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {query.data?.rows.map((row: any) => (
            <Card key={row.id} className="p-4">
              <div className="flex justify-between">
                <h3 className="font-semibold">
                  {row.employee?.first_name} {row.employee?.last_name}
                </h3>
                <Badge>{row.verification_status}</Badge>
              </div>
              <p className="text-sm">
                {row.bank_name || row.mobile_provider || row.payment_method}
              </p>
              <p className="font-mono text-sm">
                {row.maskedAccount} {row.maskedMobile}
              </p>
              <div className="mt-3 flex gap-2">
                {canReveal.allowed && (
                  <Button size="sm" variant="outline" onClick={() => show(row)}>
                    <Eye className="mr-1 h-3 w-3" />
                    Audited reveal
                  </Button>
                )}
                {canVerify.allowed && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      verify({
                        data: {
                          propertyId: propertyId!,
                          id: row.id,
                          verified: true,
                          reason: "Payment destination verified",
                        },
                      })
                        .then(() => qc.invalidateQueries({ queryKey: ["payroll-payment-details"] }))
                        .catch((e) => toast.error(e.message))
                    }
                  >
                    <CheckCircle2 className="mr-1 h-3 w-3" />
                    Verify
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      </DataQueryState>
      <ServerPagination
        page={state.page}
        pageSize={state.pageSize}
        totalRows={query.data?.total ?? 0}
        onPageChange={state.setPage}
        onPageSizeChange={state.setPageSize}
      />
    </div>
  );
}

export function StatutoryRulesPage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listPayrollResource);
  const save = useServerFn(saveStatutoryRule);
  const qc = useQueryClient();
  const [form, setForm] = useState<any>({
    jurisdictionCode: "UNSPECIFIED",
    name: "",
    ruleCategory: "income_tax",
    version: "draft-1",
    effectiveFrom: new Date().toISOString().slice(0, 10),
    verificationStatus: "draft",
    sourceReferenceText: "{}",
    parametersText: "{}",
  });
  const query = useQuery({
    queryKey: ["payroll-resource", propertyId, "statutoryRules"],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: { propertyId: propertyId!, resource: "statutoryRules", page: 1, pageSize: 100 },
      }) as Promise<any>,
  });
  async function submit() {
    try {
      await save({
        data: {
          propertyId: propertyId!,
          ...form,
          sourceReference: JSON.parse(form.sourceReferenceText),
          parameters: JSON.parse(form.parametersText),
        },
      });
      qc.invalidateQueries({ queryKey: ["payroll-resource"] });
      toast.success("Versioned statutory configuration saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Invalid statutory configuration");
    }
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Statutory Rules"
        description="Jurisdiction-aware versioned configuration; no legal calculations."
      />
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>No compliance claim</AlertTitle>
        <AlertDescription>
          Draft or verified metadata does not establish statutory or legal compliance. No rates are
          pre-populated.
        </AlertDescription>
      </Alert>
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            id="rule-jurisdiction"
            label="Jurisdiction"
            value={form.jurisdictionCode}
            onChange={(v) => setForm({ ...form, jurisdictionCode: v })}
          />
          <Field
            id="rule-name"
            label="Rule-set name"
            value={form.name}
            onChange={(v) => setForm({ ...form, name: v })}
          />
          <Field
            id="rule-category"
            label="Rule category"
            value={form.ruleCategory}
            onChange={(v) => setForm({ ...form, ruleCategory: v })}
          />
          <Field
            id="rule-version"
            label="Version"
            value={form.version}
            onChange={(v) => setForm({ ...form, version: v })}
          />
          <Field
            id="rule-effective"
            label="Effective from"
            type="date"
            value={form.effectiveFrom}
            onChange={(v) => setForm({ ...form, effectiveFrom: v })}
          />
          <Choice
            id="rule-status"
            label="Verification status"
            value={form.verificationStatus}
            values={["draft", "unverified", "verified", "rejected"]}
            onChange={(v) => setForm({ ...form, verificationStatus: v })}
          />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <JsonField
            id="rule-source"
            label="Source-reference metadata JSON"
            value={form.sourceReferenceText}
            onChange={(v) => setForm({ ...form, sourceReferenceText: v })}
          />
          <JsonField
            id="rule-parameters"
            label="Structured parameters JSON (not executable)"
            value={form.parametersText}
            onChange={(v) => setForm({ ...form, parametersText: v })}
          />
        </div>
        <Button onClick={submit}>Save rule-set version</Button>
      </Card>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {query.data?.rows.map((row: any) => (
          <Card key={row.id} className="p-4">
            <div className="flex justify-between">
              <h3 className="font-semibold">{row.name}</h3>
              <Badge variant={row.verification_status === "verified" ? "default" : "outline"}>
                {row.verification_status}
              </Badge>
            </div>
            <p className="text-sm">
              {row.jurisdiction_code} · {row.rule_category} · {row.version}
            </p>
            <p className="text-xs text-muted-foreground">
              Configuration only · Effective {row.effective_from}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function OpeningBalancesPage() {
  const { propertyId, query: options } = useBootstrap();
  const list = useServerFn(listPayrollResource);
  const stage = useServerFn(stageOpeningBalance);
  const correct = useServerFn(correctOpeningBalance);
  const qc = useQueryClient();
  const [form, setForm] = useState<any>({
    employeeId: "",
    category: "gross",
    amount: 0,
    asOfDate: new Date().toISOString().slice(0, 10),
    sourceSystem: "",
    sourceReference: "",
  });
  const query = useQuery({
    queryKey: ["payroll-resource", propertyId, "openingBalances"],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: { propertyId: propertyId!, resource: "openingBalances", page: 1, pageSize: 100 },
      }) as Promise<any>,
  });
  async function submit() {
    try {
      await stage({
        data: { propertyId: propertyId!, ...form, currency: options.data.property.base_currency },
      });
      qc.invalidateQueries({ queryKey: ["payroll-resource"] });
      toast.success("Opening balance staged with source evidence");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to stage balance");
    }
  }
  async function correction(row: any) {
    const amount = prompt("Corrected amount:", String(row.amount));
    const sourceReference = prompt("Correction source reference:");
    if (amount == null || !sourceReference) return;
    try {
      await correct({
        data: { propertyId: propertyId!, id: row.id, amount: Number(amount), sourceReference },
      });
      qc.invalidateQueries({ queryKey: ["payroll-resource"] });
      toast.success("Correction created; original preserved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Correction failed");
    }
  }
  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Opening Balances"
        description="Migration staging and validation evidence only."
      />
      <PhaseNotice>Opening balances never masquerade as payroll runs.</PhaseNotice>
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <OptionalSelect
            id="opening-employee"
            label="Employee"
            value={form.employeeId}
            onChange={(v) => setForm({ ...form, employeeId: v })}
            options={(options.data?.employees ?? []).map((r: any) => ({
              value: r.id,
              label: `${r.employee_number} · ${r.first_name} ${r.last_name}`,
            }))}
          />
          <Choice
            id="opening-category"
            label="Category"
            value={form.category}
            values={[
              "gross",
              "taxable_earnings",
              "statutory_deduction",
              "pension",
              "employee_contribution",
              "employer_contribution",
              "net_pay",
              "leave_without_pay",
              "year_to_date_other",
            ]}
            onChange={(v) => setForm({ ...form, category: v })}
          />
          <NumberField
            id="opening-amount"
            label="Amount"
            value={form.amount}
            onChange={(v) => setForm({ ...form, amount: v })}
          />
          <Field
            id="opening-date"
            label="As-of date"
            type="date"
            value={form.asOfDate}
            onChange={(v) => setForm({ ...form, asOfDate: v })}
          />
          <Field
            id="opening-source"
            label="Source system"
            value={form.sourceSystem}
            onChange={(v) => setForm({ ...form, sourceSystem: v })}
          />
          <Field
            id="opening-reference"
            label="Source reference"
            value={form.sourceReference}
            onChange={(v) => setForm({ ...form, sourceReference: v })}
          />
        </div>
        <Button onClick={submit}>Stage validated balance</Button>
      </Card>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {query.data?.rows.map((row: any) => (
          <Card key={row.id} className="p-4">
            <div className="flex justify-between">
              <h3 className="font-semibold">{row.category}</h3>
              <Badge>{row.validation_status}</Badge>
            </div>
            <p className="text-lg font-semibold">{money(row.amount, row.currency)}</p>
            <p className="text-xs text-muted-foreground">
              As of {row.as_of_date} · Source {row.source_reference || "retained in batch"}
            </p>
            {row.validation_status !== "superseded" && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => correction(row)}>
                <RotateCcw className="mr-1 h-3 w-3" />
                Correct with history
              </Button>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
function Choice({
  id,
  label,
  value,
  values,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((option) => (
            <SelectItem key={option} value={option}>
              {option.replaceAll("_", " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
function Check({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={value} onCheckedChange={(checked) => onChange(checked === true)} />
      {label}
    </label>
  );
}
function JsonField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        className="min-h-32 font-mono text-xs"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
