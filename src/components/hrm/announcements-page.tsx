import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Archive, Pencil, Plus, RotateCcw, Send, Undo2 } from "lucide-react";
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
import {
  listStaffAnnouncements,
  saveStaffAnnouncement,
  setAnnouncementPublication,
} from "@/lib/hrm/hrm.functions";
import { HrmPageHeader, useHrmListState, useHrmOptions } from "@/components/hrm/shared";
import { HRM_ADMIN_ROLES } from "@/lib/hrm/permissions";

type AnnouncementRow = {
  id: string;
  title: string;
  content: string;
  audience_type: "all_staff" | "departments" | "designations" | "employees";
  publication_status: string;
  publish_date: string | null;
  expiry_date: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  archived_at: string | null;
  hr_announcement_departments?: { department_id: string }[];
  hr_announcement_designations?: { designation_id: string }[];
  hr_announcement_employees?: { employee_id: string }[];
};

export function StaffAnnouncementsPage() {
  const propertyId = useActiveProperty();
  const list = useServerFn(listStaffAnnouncements);
  const transition = useServerFn(setAnnouncementPublication);
  const qc = useQueryClient();
  const canManage = usePermission({
    propertyId,
    module: "staff_announcements",
    capability: "manage_settings",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const canPublish = usePermission({
    propertyId,
    module: "staff_announcements",
    capability: "approve",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const state = useHrmListState();
  const [editing, setEditing] = useState<AnnouncementRow | null | undefined>(undefined);
  const query = useQuery({
    queryKey: [
      "hrm-announcements",
      propertyId,
      state.search,
      state.from,
      state.to,
      state.status,
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
          page: state.page,
          pageSize: state.pageSize,
        },
      }),
  });
  const rows = (query.data?.rows ?? []) as AnnouncementRow[];

  async function act(
    row: AnnouncementRow,
    action: "publish" | "unpublish" | "archive" | "restore",
  ) {
    if (action === "archive" && !confirm(`Archive ${row.title}?`)) return;
    try {
      await transition({ data: { propertyId: propertyId!, id: row.id, action } });
      toast.success(`Announcement ${action === "publish" ? "published" : `${action}d`}`);
      qc.invalidateQueries({ queryKey: ["hrm-announcements"] });
      qc.invalidateQueries({ queryKey: ["hrm-dashboard"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update announcement");
    }
  }

  return (
    <div className="space-y-4">
      <HrmPageHeader
        title="Staff Announcements"
        description="Publish property-scoped notices to defined employee audiences."
        actions={
          canManage.allowed ? (
            <Button onClick={() => setEditing(null)}>
              <Plus className="mr-1 h-4 w-4" /> New announcement
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
          onClear={state.clear}
        >
          <div className="space-y-1">
            <Label htmlFor="announcement-status-filter">Status</Label>
            <Select
              value={state.status || "current"}
              onValueChange={(value) => state.setStatus(value === "current" ? "" : value)}
            >
              <SelectTrigger id="announcement-status-filter" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Current</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="unpublished">Unpublished</SelectItem>
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
                <TableHead>Announcement</TableHead>
                <TableHead>Audience</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Publication</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <p className="font-medium">{row.title}</p>
                    <p className="max-w-md truncate text-xs text-muted-foreground">{row.content}</p>
                  </TableCell>
                  <TableCell>{label(row.audience_type)}</TableCell>
                  <TableCell>
                    <Badge variant={row.priority === "urgent" ? "destructive" : "outline"}>
                      {row.priority}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={row.publication_status === "published" ? "default" : "secondary"}
                    >
                      {row.publication_status}
                    </Badge>
                    {row.expiry_date && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Expires {new Date(row.expiry_date).toLocaleDateString()}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {!row.archived_at && (
                      <>
                        {canManage.allowed && (
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Edit ${row.title}`}
                            onClick={() => setEditing(row)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        {canPublish.allowed &&
                          (row.publication_status === "published" ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Unpublish ${row.title}`}
                              onClick={() => act(row, "unpublish")}
                            >
                              <Undo2 className="h-4 w-4" />
                            </Button>
                          ) : (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Publish ${row.title}`}
                              onClick={() => act(row, "publish")}
                            >
                              <Send className="h-4 w-4" />
                            </Button>
                          ))}
                      </>
                    )}
                    {canManage.allowed && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={
                          row.archived_at ? `Restore ${row.title}` : `Archive ${row.title}`
                        }
                        onClick={() => act(row, row.archived_at ? "restore" : "archive")}
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
        <AnnouncementDialog
          propertyId={propertyId}
          announcement={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

function AnnouncementDialog({
  propertyId,
  announcement,
  onClose,
}: {
  propertyId: string;
  announcement: AnnouncementRow | null;
  onClose: () => void;
}) {
  const save = useServerFn(saveStaffAnnouncement);
  const options = useHrmOptions(propertyId);
  const qc = useQueryClient();
  const existingIds = announcement
    ? announcement.audience_type === "departments"
      ? announcement.hr_announcement_departments?.map((row) => row.department_id)
      : announcement.audience_type === "designations"
        ? announcement.hr_announcement_designations?.map((row) => row.designation_id)
        : announcement.audience_type === "employees"
          ? announcement.hr_announcement_employees?.map((row) => row.employee_id)
          : []
    : [];
  const [form, setForm] = useState({
    title: announcement?.title ?? "",
    content: announcement?.content ?? "",
    audienceType: announcement?.audience_type ?? "all_staff",
    audienceIds: existingIds ?? [],
    publishDate: toLocalInput(announcement?.publish_date),
    expiryDate: toLocalInput(announcement?.expiry_date),
    priority: announcement?.priority ?? "normal",
  });
  const [busy, setBusy] = useState(false);

  const audienceOptions =
    form.audienceType === "departments"
      ? (options.data?.departments ?? []).map((row) => ({ id: row.id, label: row.name ?? "" }))
      : form.audienceType === "designations"
        ? (options.data?.designations ?? []).map((row) => ({ id: row.id, label: row.title ?? "" }))
        : form.audienceType === "employees"
          ? (options.data?.employees ?? []).map((row) => ({
              id: row.id,
              label: `${row.employee_number ?? ""} · ${row.first_name ?? ""} ${row.last_name ?? ""}`,
            }))
          : [];

  async function submit() {
    setBusy(true);
    try {
      await save({
        data: {
          propertyId,
          id: announcement?.id,
          title: form.title,
          content: form.content,
          audienceType: form.audienceType,
          audienceIds: form.audienceIds,
          publishDate: form.publishDate ? new Date(form.publishDate).toISOString() : null,
          expiryDate: form.expiryDate ? new Date(form.expiryDate).toISOString() : null,
          priority: form.priority,
        },
      });
      toast.success(announcement ? "Announcement updated" : "Announcement created");
      qc.invalidateQueries({ queryKey: ["hrm-announcements"] });
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save announcement");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{announcement ? "Edit announcement" : "New announcement"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="announcement-title">Title</Label>
            <Input
              id="announcement-title"
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="announcement-content">Content</Label>
            <Textarea
              id="announcement-content"
              rows={6}
              value={form.content}
              onChange={(event) => setForm({ ...form, content: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="announcement-audience">Audience</Label>
            <Select
              value={form.audienceType}
              onValueChange={(audienceType) =>
                setForm({
                  ...form,
                  audienceType: audienceType as typeof form.audienceType,
                  audienceIds: [],
                })
              }
            >
              <SelectTrigger id="announcement-audience">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all_staff">All staff in property</SelectItem>
                <SelectItem value="departments">Selected departments</SelectItem>
                <SelectItem value="designations">Selected designations</SelectItem>
                <SelectItem value="employees">Selected employees</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="announcement-priority">Priority</Label>
            <Select
              value={form.priority}
              onValueChange={(priority) =>
                setForm({ ...form, priority: priority as typeof form.priority })
              }
            >
              <SelectTrigger id="announcement-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="urgent">Urgent</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {audienceOptions.length > 0 && (
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="announcement-targets">Recipients</Label>
              <select
                id="announcement-targets"
                multiple
                className="min-h-32 w-full rounded-md border bg-background p-2 text-sm"
                value={form.audienceIds}
                onChange={(event) =>
                  setForm({
                    ...form,
                    audienceIds: [...event.currentTarget.selectedOptions].map(
                      (option) => option.value,
                    ),
                  })
                }
              >
                {audienceOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Hold Ctrl or Command to select more than one recipient.
              </p>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="announcement-publish-date">Publish date</Label>
            <Input
              id="announcement-publish-date"
              type="datetime-local"
              value={form.publishDate}
              onChange={(event) => setForm({ ...form, publishDate: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="announcement-expiry-date">Expiry date</Label>
            <Input
              id="announcement-expiry-date"
              type="datetime-local"
              value={form.expiryDate}
              onChange={(event) => setForm({ ...form, expiryDate: event.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={submit}>
            {busy ? "Saving…" : "Save announcement"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function label(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
