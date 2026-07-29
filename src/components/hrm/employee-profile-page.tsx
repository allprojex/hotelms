import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, FileText, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { DataQueryState } from "@/components/shared/data-query-controls";
import { useActiveProperty } from "@/hooks/use-active-property";
import { usePermission } from "@/hooks/use-permission";
import { supabase } from "@/integrations/supabase/client";
import {
  createEmployeePhotoTicket,
  getEmployee,
  listHrmAudit,
  updateEmployeePhoto,
} from "@/lib/hrm/hrm.functions";
import { HRM_ADMIN_ROLES } from "@/lib/hrm/permissions";

type EmployeeProfile = {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  profile_photo_path: string | null;
  employment_status: string;
  employment_type: string;
  hire_date: string;
  work_location: string | null;
  work_email: string | null;
  staff_user_id: string | null;
  archived_at: string | null;
  profileCompleteness: number;
  department?: { name?: string } | null;
  designation?: { title?: string } | null;
  manager?: { first_name?: string; last_name?: string } | null;
  private?: {
    personal_email?: string | null;
    primary_phone?: string | null;
    residential_address?: string | null;
    emergency_contact_name?: string | null;
    emergency_contact_phone?: string | null;
  } | null;
  documents: {
    id: string;
    title: string;
    category: string;
    expiry_date: string | null;
  }[];
};

type AuditEntry = {
  id: string;
  action: string;
  created_at: string;
};

export function EmployeeProfilePage({ employeeId }: { employeeId: string }) {
  const propertyId = useActiveProperty();
  const fetchEmployee = useServerFn(getEmployee);
  const fetchAudit = useServerFn(listHrmAudit);
  const photoTicket = useServerFn(createEmployeePhotoTicket);
  const updatePhoto = useServerFn(updateEmployeePhoto);
  const qc = useQueryClient();
  const canEdit = usePermission({
    propertyId,
    module: "employees",
    capability: "edit",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const employee = useQuery({
    queryKey: ["hrm-employee", propertyId, employeeId],
    enabled: !!propertyId,
    queryFn: async () =>
      (await fetchEmployee({
        data: { propertyId: propertyId!, id: employeeId },
      })) as EmployeeProfile,
  });
  const audit = useQuery({
    queryKey: ["hrm-employee-audit", propertyId, employeeId],
    enabled: !!propertyId,
    queryFn: async () =>
      (await fetchAudit({
        data: {
          propertyId: propertyId!,
          resourceType: "hr_employee",
          resourceId: employeeId,
          limit: 12,
        },
      })) as AuditEntry[],
  });
  const photo = useQuery({
    queryKey: ["hrm-employee-photo", employee.data?.profile_photo_path],
    enabled: !!employee.data?.profile_photo_path,
    queryFn: async () => {
      const result = await supabase.storage
        .from("employee-documents")
        .createSignedUrl(employee.data!.profile_photo_path!, 300);
      if (result.error) throw result.error;
      return result.data.signedUrl;
    },
  });

  async function uploadPhoto(file: File) {
    try {
      const ticket = await photoTicket({
        data: {
          propertyId: propertyId!,
          employeeId,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
        },
      });
      const uploaded = await supabase.storage
        .from(ticket.bucket)
        .upload(ticket.path, file, { contentType: file.type, upsert: false });
      if (uploaded.error) throw uploaded.error;
      await updatePhoto({
        data: { propertyId: propertyId!, employeeId, storagePath: ticket.path },
      });
      toast.success("Profile photo updated");
      qc.invalidateQueries({ queryKey: ["hrm-employee", propertyId, employeeId] });
      qc.invalidateQueries({ queryKey: ["hrm-employee-photo"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to upload photo");
    }
  }

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" className="-ml-2">
        <Link to="/hrm/employees">
          <ArrowLeft className="mr-1 h-4 w-4" /> Employees
        </Link>
      </Button>
      <DataQueryState
        loading={employee.isLoading}
        error={employee.error}
        empty={!employee.data}
        emptyTitle="Employee not found"
      >
        {employee.data && (
          <>
            <Card className="flex flex-wrap items-center gap-5 p-5">
              <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-muted text-2xl font-semibold">
                {photo.data ? (
                  <img
                    src={photo.data}
                    alt={`${employee.data.first_name} ${employee.data.last_name}`}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  `${employee.data.first_name[0]}${employee.data.last_name[0]}`
                )}
              </div>
              <div className="min-w-56 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold">
                    {employee.data.first_name} {employee.data.last_name}
                  </h1>
                  <Badge>{employee.data.employment_status}</Badge>
                  {employee.data.archived_at && <Badge variant="secondary">Archived</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">
                  {employee.data.employee_number} ·{" "}
                  {employee.data.designation?.title ?? "No designation"}
                </p>
                <div className="mt-3 max-w-sm">
                  <div className="mb-1 flex justify-between text-xs">
                    <span>Profile completeness</span>
                    <span>{employee.data.profileCompleteness}%</span>
                  </div>
                  <Progress value={employee.data.profileCompleteness} />
                </div>
              </div>
              {canEdit.allowed && (
                <label className="inline-flex cursor-pointer items-center">
                  <input
                    type="file"
                    className="sr-only"
                    accept="image/jpeg,image/png"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) uploadPhoto(file);
                    }}
                  />
                  <span className="inline-flex h-9 items-center rounded-md border px-3 text-sm">
                    <Upload className="mr-1 h-4 w-4" /> Upload photo
                  </span>
                </label>
              )}
            </Card>
            <div className="grid gap-4 lg:grid-cols-2">
              <DetailCard
                title="Employment"
                rows={[
                  ["Department", employee.data.department?.name],
                  ["Designation", employee.data.designation?.title],
                  [
                    "Reporting manager",
                    employee.data.manager
                      ? `${employee.data.manager.first_name} ${employee.data.manager.last_name}`
                      : null,
                  ],
                  ["Employment type", employee.data.employment_type],
                  ["Hire date", employee.data.hire_date],
                  ["Work location", employee.data.work_location],
                  ["Linked account", employee.data.staff_user_id ? "Linked" : "Not linked"],
                ]}
              />
              <DetailCard
                title="Contact"
                rows={[
                  ["Work email", employee.data.work_email],
                  ["Personal email", employee.data.private?.personal_email],
                  ["Primary phone", employee.data.private?.primary_phone],
                  ["Address", employee.data.private?.residential_address],
                  ["Emergency contact", employee.data.private?.emergency_contact_name],
                  ["Emergency phone", employee.data.private?.emergency_contact_phone],
                ]}
              />
              <Card className="p-4">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  <h2 className="font-semibold">Documents</h2>
                </div>
                <div className="mt-3 space-y-2">
                  {employee.data.documents.map((document) => (
                    <div key={document.id} className="rounded-md border p-3">
                      <p className="font-medium">{document.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {document.category.replace(/_/g, " ")}
                        {document.expiry_date ? ` · Expires ${document.expiry_date}` : ""}
                      </p>
                    </div>
                  ))}
                  {employee.data.documents.length === 0 && (
                    <p className="text-sm text-muted-foreground">No active documents.</p>
                  )}
                </div>
              </Card>
              <Card className="p-4">
                <h2 className="font-semibold">Recent activity</h2>
                <div className="mt-3 space-y-2">
                  {(audit.data ?? []).map((entry) => (
                    <div key={entry.id} className="rounded-md border p-3 text-sm">
                      <p className="font-medium">{entry.action}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(entry.created_at).toLocaleString()}
                      </p>
                    </div>
                  ))}
                  {!audit.isLoading && (audit.data?.length ?? 0) === 0 && (
                    <p className="text-sm text-muted-foreground">No recorded activity.</p>
                  )}
                </div>
              </Card>
            </div>
          </>
        )}
      </DataQueryState>
    </div>
  );
}

function DetailCard({
  title,
  rows,
}: {
  title: string;
  rows: [string, string | null | undefined][];
}) {
  return (
    <Card className="p-4">
      <h2 className="font-semibold">{title}</h2>
      <dl className="mt-3 grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value ? value.replace(/_/g, " ") : "—"}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
