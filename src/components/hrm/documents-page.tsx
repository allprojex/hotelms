import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Archive, Download, Pencil, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  DataQueryState,
  ServerPagination,
  SharedListFilters,
} from "@/components/shared/data-query-controls";
import { useActiveProperty } from "@/hooks/use-active-property";
import { usePermission } from "@/hooks/use-permission";
import { supabase } from "@/integrations/supabase/client";
import { EMPLOYEE_DOCUMENT_CATEGORIES } from "@/lib/hrm/domain";
import {
  createDocumentUploadTicket,
  getEmployeeDocumentDownload,
  listEmployeeDocuments,
  registerEmployeeDocument,
  setEmployeeDocumentArchived,
  updateEmployeeDocumentMetadata,
} from "@/lib/hrm/hrm.functions";
import {
  HrmPageHeader,
  OptionalSelect,
  useHrmListState,
  useHrmOptions,
} from "@/components/hrm/shared";
import { HRM_ADMIN_ROLES } from "@/lib/hrm/permissions";

type DocumentRow = {
  id: string;
  employee_id: string;
  category: string;
  title: string;
  description: string | null;
  file_name: string;
  file_type: string;
  file_size: number;
  issue_date: string | null;
  expiry_date: string | null;
  status: string;
  confidentiality_level: "internal" | "confidential";
  archived_at: string | null;
  employee?: {
    employee_number?: string;
    first_name?: string;
    last_name?: string;
  } | null;
};

export function EmployeeDocumentsPage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listEmployeeDocuments);
  const download = useServerFn(getEmployeeDocumentDownload);
  const archive = useServerFn(setEmployeeDocumentArchived);
  const options = useHrmOptions(propertyId);
  const state = useHrmListState();
  const qc = useQueryClient();
  const canUpload = usePermission({
    propertyId,
    module: "employee_documents",
    capability: "create",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const canEdit = usePermission({
    propertyId,
    module: "employee_documents",
    capability: "edit",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const canArchive = usePermission({
    propertyId,
    module: "employee_documents",
    capability: "delete_or_archive",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const canViewConfidential = usePermission({
    propertyId,
    module: "confidential_employee_documents",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const [employeeId, setEmployeeId] = useState("");
  const [editing, setEditing] = useState<DocumentRow | null | undefined>(undefined);
  const query = useQuery({
    queryKey: [
      "hrm-documents",
      propertyId,
      state.search,
      state.from,
      state.to,
      state.status,
      employeeId,
      state.page,
      state.pageSize,
    ],
    enabled: !!propertyId,
    queryFn: () =>
      list({
        data: {
          propertyId: propertyId!,
          search: state.search,
          from: state.from ?? undefined,
          to: state.to ?? undefined,
          status: state.status,
          departmentId: employeeId,
          page: state.page,
          pageSize: state.pageSize,
        },
      }),
  });
  const rows = (query.data?.rows ?? []) as DocumentRow[];

  async function openDownload(row: DocumentRow) {
    try {
      const result = await download({ data: { propertyId: propertyId!, id: row.id } });
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Download was denied");
    }
  }

  async function toggleArchive(row: DocumentRow) {
    const archived = !row.archived_at;
    if (archived && !confirm(`Archive ${row.title}?`)) return;
    try {
      await archive({ data: { propertyId: propertyId!, id: row.id, archived } });
      toast.success(archived ? "Document archived" : "Document restored");
      qc.invalidateQueries({ queryKey: ["hrm-documents"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update document");
    }
  }

  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Employee Documents"
        description="Private employee files with authorized downloads and confidential access controls."
        actions={
          canUpload.allowed ? (
            <Button onClick={() => setEditing(null)}>
              <Plus className="mr-1 h-4 w-4" /> Upload document
            </Button>
          ) : undefined
        }
      />
      <Card className="p-3">
        <SharedListFilters
          search={state.search}
          from={state.from}
          to={state.to}
          onSearchChange={state.setSearch}
          onFromChange={state.setFrom}
          onToChange={state.setTo}
          onClear={() => {
            state.clear();
            setEmployeeId("");
          }}
        >
          <OptionalSelect
            id="document-employee-filter"
            label="Employee"
            value={employeeId}
            onChange={(value) => {
              setEmployeeId(value);
              state.setPage(1);
            }}
            options={(options.data?.employees ?? []).map((row) => ({
              value: row.id,
              label: `${row.employee_number ?? ""} · ${row.first_name ?? ""} ${row.last_name ?? ""}`,
            }))}
            placeholder="All employees"
          />
          <div className="space-y-1">
            <Label htmlFor="document-status-filter">Expiry/status</Label>
            <Select
              value={state.status || "current"}
              onValueChange={(value) => state.setStatus(value === "current" ? "" : value)}
            >
              <SelectTrigger id="document-status-filter" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Current</SelectItem>
                <SelectItem value="expiring">Expiring in 30 days</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </SharedListFilters>
      </Card>
      <Card>
        <DataQueryState loading={query.isLoading} error={query.error} empty={rows.length === 0}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Access</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <p className="font-medium">{row.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.file_name} · {formatBytes(row.file_size)}
                    </p>
                  </TableCell>
                  <TableCell>
                    {row.employee
                      ? `${row.employee.first_name ?? ""} ${row.employee.last_name ?? ""}`
                      : "—"}
                  </TableCell>
                  <TableCell>{label(row.category)}</TableCell>
                  <TableCell>{row.expiry_date ?? "—"}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        row.confidentiality_level === "confidential" ? "destructive" : "outline"
                      }
                    >
                      {row.confidentiality_level}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {!row.archived_at && (
                      <>
                        {(row.confidentiality_level !== "confidential" ||
                          canViewConfidential.allowed) && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Download ${row.title}`}
                            onClick={() => openDownload(row)}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                        )}
                        {canEdit.allowed && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Edit ${row.title}`}
                            onClick={() => setEditing(row)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                      </>
                    )}
                    {canArchive.allowed && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={row.archived_at ? "Restore document" : "Archive document"}
                        onClick={() => toggleArchive(row)}
                      >
                        {row.archived_at ? (
                          <RotateCcw className="h-4 w-4" />
                        ) : (
                          <Archive className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataQueryState>
      </Card>
      <ServerPagination
        page={state.page}
        pageSize={state.pageSize}
        totalRows={query.data?.total ?? 0}
        onPageChange={state.setPage}
        onPageSizeChange={state.setPageSize}
      />
      {editing !== undefined && propertyId && (
        <DocumentDialog
          propertyId={propertyId}
          document={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

function DocumentDialog({
  propertyId,
  document,
  onClose,
}: {
  propertyId: string;
  document: DocumentRow | null;
  onClose: () => void;
}) {
  const ticket = useServerFn(createDocumentUploadTicket);
  const register = useServerFn(registerEmployeeDocument);
  const update = useServerFn(updateEmployeeDocumentMetadata);
  const options = useHrmOptions(propertyId);
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState({
    employeeId: document?.employee_id ?? "",
    category: document?.category ?? "employment_contract",
    title: document?.title ?? "",
    description: document?.description ?? "",
    issueDate: document?.issue_date ?? "",
    expiryDate: document?.expiry_date ?? "",
    confidentialityLevel: document?.confidentiality_level ?? "internal",
  });
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!document && !file) {
      toast.error("Choose a document file");
      return;
    }
    setBusy(true);
    try {
      if (document) {
        await update({
          data: {
            propertyId,
            id: document.id,
            category: form.category,
            title: form.title,
            description: form.description,
            issueDate: form.issueDate || null,
            expiryDate: form.expiryDate || null,
            confidentialityLevel: form.confidentialityLevel as "internal" | "confidential",
          },
        });
      } else if (file) {
        const upload = await ticket({
          data: {
            propertyId,
            employeeId: form.employeeId,
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
          },
        });
        const stored = await supabase.storage.from(upload.bucket).upload(upload.storagePath, file, {
          contentType: file.type,
          upsert: false,
        });
        if (stored.error) throw stored.error;
        try {
          await register({
            data: {
              propertyId,
              id: upload.documentId,
              employeeId: form.employeeId,
              category: form.category,
              title: form.title,
              description: form.description,
              storagePath: upload.storagePath,
              fileName: file.name,
              fileType: file.type,
              fileSize: file.size,
              issueDate: form.issueDate || null,
              expiryDate: form.expiryDate || null,
              confidentialityLevel: form.confidentialityLevel as "internal" | "confidential",
            },
          });
        } catch (error) {
          await supabase.storage.from(upload.bucket).remove([upload.storagePath]);
          throw error;
        }
      }
      toast.success(document ? "Document metadata updated" : "Document uploaded");
      qc.invalidateQueries({ queryKey: ["hrm-documents"] });
      qc.invalidateQueries({ queryKey: ["hrm-dashboard"] });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save document");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {document ? "Edit document metadata" : "Upload employee document"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {!document && (
            <>
              <OptionalSelect
                id="document-employee"
                label="Employee"
                value={form.employeeId}
                onChange={(employeeId) => setForm({ ...form, employeeId })}
                options={(options.data?.employees ?? []).map((row) => ({
                  value: row.id,
                  label: `${row.employee_number ?? ""} · ${row.first_name ?? ""} ${row.last_name ?? ""}`,
                }))}
                placeholder="Select employee"
              />
              <div className="space-y-1">
                <Label htmlFor="document-file">File</Label>
                <Input
                  id="document-file"
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.docx"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                <p className="text-xs text-muted-foreground">
                  PDF, JPEG, PNG, or DOCX · 10 MB maximum
                </p>
              </div>
            </>
          )}
          <div className="space-y-1">
            <Label htmlFor="document-title">Title</Label>
            <Input
              id="document-title"
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="document-category">Category</Label>
            <Select
              value={form.category}
              onValueChange={(category) => setForm({ ...form, category })}
            >
              <SelectTrigger id="document-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMPLOYEE_DOCUMENT_CATEGORIES.map((category) => (
                  <SelectItem key={category} value={category}>
                    {label(category)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="document-issue-date">Issue date</Label>
            <Input
              id="document-issue-date"
              type="date"
              value={form.issueDate}
              onChange={(event) => setForm({ ...form, issueDate: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="document-expiry-date">Expiry date</Label>
            <Input
              id="document-expiry-date"
              type="date"
              value={form.expiryDate}
              onChange={(event) => setForm({ ...form, expiryDate: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="document-confidentiality">Confidentiality</Label>
            <Select
              value={form.confidentialityLevel}
              onValueChange={(confidentialityLevel) =>
                setForm({
                  ...form,
                  confidentialityLevel: confidentialityLevel as "internal" | "confidential",
                })
              }
            >
              <SelectTrigger id="document-confidentiality">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="internal">Internal</SelectItem>
                <SelectItem value="confidential">Confidential</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="document-description">Description</Label>
            <Textarea
              id="document-description"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={submit}>
            {busy ? "Saving…" : document ? "Save metadata" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function label(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
