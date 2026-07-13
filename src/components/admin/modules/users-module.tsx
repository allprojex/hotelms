/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  createManagedAccount,
  listManageableUsers,
  resetManagedPassword,
  setUserStatus,
  updateManagedAccount,
  updateManagedIdentifier,
  type ManageableUser,
} from "@/lib/users.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { KeyRound, Pencil, Plus, Settings2, Shield, UserRound } from "lucide-react";
import { toast } from "sonner";

interface Props {
  propertyId: string | null;
}
const STAFF_ROLES = [
  "front_desk",
  "reservations",
  "cashier",
  "accountant",
  "housekeeping_supervisor",
  "housekeeping",
];
const ADMIN_ROLES = ["general_manager", "hotel_owner", "super_admin"];

export function UsersModule({ propertyId }: Props) {
  const qc = useQueryClient();
  const listUsers = useServerFn(listManageableUsers);
  const changeStatus = useServerFn(setUserStatus);
  const [createType, setCreateType] = useState<"staff" | "admin" | null>(null);
  const [resetTarget, setResetTarget] = useState<ManageableUser | null>(null);
  const [identifierTarget, setIdentifierTarget] = useState<ManageableUser | null>(null);
  const [editTarget, setEditTarget] = useState<ManageableUser | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [role, setRole] = useState("all");
  const [department, setDepartment] = useState("all");
  const users = useQuery({
    queryKey: ["managed-users", propertyId],
    enabled: !!propertyId,
    queryFn: () => listUsers({ data: { propertyId: propertyId! } }),
  });
  const filtered = useMemo(
    () =>
      (users.data ?? []).filter((u) => {
        const needle = search.toLowerCase();
        const hay = `${u.identifier} ${u.full_name} ${u.department ?? ""}`.toLowerCase();
        return (
          (!needle || hay.includes(needle)) &&
          (type === "all" || u.account_type === type) &&
          (status === "all" || u.status === status) &&
          (department === "all" || u.department === department) &&
          (role === "all" || u.roles.some((r) => r.role === role))
        );
      }),
    [users.data, search, type, status, role, department],
  );
  const departments = useMemo(
    () =>
      Array.from(
        new Set((users.data ?? []).map((user) => user.department).filter(Boolean) as string[]),
      ).sort(),
    [users.data],
  );
  const statusMut = useMutation({
    mutationFn: (v: { userId: string; status: "active" | "suspended" | "disabled" }) =>
      changeStatus({ data: { ...v, propertyId: propertyId! } }),
    onSuccess: () => {
      toast.success("Account status updated");
      qc.invalidateQueries({ queryKey: ["managed-users", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["managed-users", propertyId] });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">User &amp; Staff Management</h2>
          <p className="text-sm text-muted-foreground">
            Register and manage property-scoped Staff and Administrators.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setCreateType("staff")}>
            <UserRound className="mr-1 h-4 w-4" />
            Register Staff
          </Button>
          <Button onClick={() => setCreateType("admin")}>
            <Shield className="mr-1 h-4 w-4" />
            Register Administrator
          </Button>
        </div>
      </div>
      <Card className="p-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search ID, name or department"
            aria-label="Search accounts"
          />
          <Filter
            value={type}
            setValue={setType}
            label="Account type"
            values={["staff", "admin"]}
          />
          <Filter
            value={role}
            setValue={setRole}
            label="Role"
            values={[...ADMIN_ROLES, ...STAFF_ROLES]}
          />
          <Filter
            value={status}
            setValue={setStatus}
            label="Status"
            values={["active", "pending", "suspended", "disabled"]}
          />
          <Filter
            value={department}
            setValue={setDepartment}
            label="Department"
            values={departments}
          />
        </div>
      </Card>
      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Identifier / Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Role / Department</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Property</TableHead>
              <TableHead>Last login / Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="font-mono font-medium">{u.identifier}</div>
                  <div className="text-xs text-muted-foreground">{u.full_name}</div>
                </TableCell>
                <TableCell>
                  <Badge variant={u.account_type === "admin" ? "default" : "secondary"}>
                    {u.account_type}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div>{u.roles.map((r) => r.role.replaceAll("_", " ")).join(", ")}</div>
                  <div className="text-xs text-muted-foreground">{u.department ?? "—"}</div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      u.status === "active"
                        ? "default"
                        : u.status === "disabled"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {u.status}
                  </Badge>
                  {u.must_change_password && (
                    <div className="mt-1 text-[10px] text-amber-600">Password change required</div>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {u.roles.length} assignment{u.roles.length === 1 ? "" : "s"}
                </TableCell>
                <TableCell className="text-xs">
                  <div>{date(u.last_successful_login_at)}</div>
                  <div className="text-muted-foreground">Created {date(u.created_at)}</div>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditTarget(u)}
                      title="Edit account"
                      aria-label={`Edit account ${u.identifier}`}
                    >
                      <Settings2 className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setIdentifierTarget(u)}
                      title="Change ID"
                      aria-label={`Change ID for ${u.identifier}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setResetTarget(u)}
                      title="Reset password"
                    >
                      <KeyRound className="h-4 w-4" />
                    </Button>
                    {u.status !== "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => statusMut.mutate({ userId: u.id, status: "active" })}
                      >
                        Activate
                      </Button>
                    )}
                    {u.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => statusMut.mutate({ userId: u.id, status: "suspended" })}
                      >
                        Suspend
                      </Button>
                    )}
                    {u.status !== "disabled" && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          if (confirm(`Disable ${u.identifier}?`))
                            statusMut.mutate({ userId: u.id, status: "disabled" });
                        }}
                      >
                        Disable
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!users.isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  No matching accounts.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
      {createType && (
        <CreateDialog
          accountType={createType}
          currentPropertyId={propertyId!}
          onClose={() => setCreateType(null)}
          onDone={refresh}
        />
      )}
      {resetTarget && (
        <ResetDialog
          user={resetTarget}
          propertyId={propertyId!}
          onClose={() => setResetTarget(null)}
          onDone={refresh}
        />
      )}
      {identifierTarget && (
        <IdentifierDialog
          user={identifierTarget}
          propertyId={propertyId!}
          onClose={() => setIdentifierTarget(null)}
          onDone={refresh}
        />
      )}
      {editTarget && (
        <EditAccountDialog
          user={editTarget}
          currentPropertyId={propertyId!}
          onClose={() => setEditTarget(null)}
          onDone={refresh}
        />
      )}
    </div>
  );
}

function Filter({
  value,
  setValue,
  label,
  values,
}: {
  value: string;
  setValue: (v: string) => void;
  label: string;
  values: string[];
}) {
  return (
    <Select value={value} onValueChange={setValue}>
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All {label.toLowerCase()}s</SelectItem>
        {values.map((v) => (
          <SelectItem key={v} value={v}>
            {v.replaceAll("_", " ")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
function date(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : "Never";
}

function CreateDialog({
  accountType,
  currentPropertyId,
  onClose,
  onDone,
}: {
  accountType: "staff" | "admin";
  currentPropertyId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const create = useServerFn(createManagedAccount);
  const roles = accountType === "admin" ? ADMIN_ROLES : STAFF_ROLES;
  const properties = useQuery({
    queryKey: ["account-properties"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("properties")
        .select("id,name")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    identifier: "",
    email: "",
    phone: "",
    role: roles[0],
    department: "",
    propertyIds: [currentPropertyId],
    password: "",
    confirmation: "",
    status: "active" as "active" | "pending",
  });
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const set = (key: string, value: any) => setForm((f) => ({ ...f, [key]: value }));
  async function save() {
    setBusy(true);
    try {
      await create({ data: { ...form, accountType } });
      toast.success(
        `${accountType === "admin" ? "Administrator" : "Staff"} account created. Copy the temporary password now; it is not stored.`,
      );
      onDone();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Account creation failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Register {accountType === "admin" ? "Administrator" : "Staff"}</DialogTitle>
          <DialogDescription>
            The user must replace this temporary password at first login.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" value={form.firstName} setValue={(v) => set("firstName", v)} />
          <Field label="Last name" value={form.lastName} setValue={(v) => set("lastName", v)} />
          <Field
            label={accountType === "admin" ? "Admin ID" : "Username / Staff ID"}
            value={form.identifier}
            setValue={(v) => set("identifier", v)}
            placeholder={accountType === "admin" ? "ADMIN-001" : "STF-001"}
          />
          <Field
            label="Email (optional, internal)"
            value={form.email}
            setValue={(v) => set("email", v)}
            type="email"
          />
          <Field label="Phone number" value={form.phone} setValue={(v) => set("phone", v)} />
          <Field
            label="Department"
            value={form.department}
            setValue={(v) => set("department", v)}
          />
          <div>
            <Label>Role</Label>
            <Select value={form.role} onValueChange={(v) => set("role", v)}>
              <SelectTrigger className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Status</Label>
            <Select value={form.status} onValueChange={(v) => set("status", v)}>
              <SelectTrigger className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label>Assigned properties</Label>
            <div className="mt-2 grid gap-2 rounded-md border p-3 sm:grid-cols-2">
              {properties.data?.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.propertyIds.includes(p.id)}
                    onCheckedChange={(checked) =>
                      set(
                        "propertyIds",
                        checked
                          ? [...form.propertyIds, p.id]
                          : form.propertyIds.filter((id) => id !== p.id),
                      )
                    }
                  />
                  {p.name}
                </label>
              ))}
            </div>
          </div>
          <Field
            label="Default password"
            value={form.password}
            setValue={(v) => set("password", v)}
            type={show ? "text" : "password"}
            onKey={(e) => setCaps(e.getModifierState("CapsLock"))}
          />
          <Field
            label="Confirm default password"
            value={form.confirmation}
            setValue={(v) => set("confirmation", v)}
            type={show ? "text" : "password"}
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={show} onCheckedChange={(v) => setShow(!!v)} />
            Show passwords
          </label>
          {caps && <span className="text-sm text-amber-600">Caps Lock is on</span>}
          <p className="sm:col-span-2 text-xs text-muted-foreground">
            At least 10 characters with uppercase, lowercase, a number and a symbol.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            <Plus className="mr-1 h-4 w-4" />
            {busy ? "Creating…" : "Create account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function EditAccountDialog({
  user,
  currentPropertyId,
  onClose,
  onDone,
}: {
  user: ManageableUser;
  currentPropertyId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const updateAccount = useServerFn(updateManagedAccount);
  const roles = user.account_type === "admin" ? ADMIN_ROLES : STAFF_ROLES;
  const properties = useQuery({
    queryKey: ["account-properties"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("properties")
        .select("id,name")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const assigned = user.roles.map((role) => role.property_id).filter(Boolean) as string[];
  const [form, setForm] = useState({
    fullName: user.full_name ?? "",
    phone: user.phone ?? "",
    department: user.department ?? "",
    role: user.roles[0]?.role ?? roles[0],
    propertyIds: assigned.length ? assigned : [currentPropertyId],
  });
  const [busy, setBusy] = useState(false);
  const set = (key: string, value: any) => setForm((current) => ({ ...current, [key]: value }));
  async function save() {
    setBusy(true);
    try {
      await updateAccount({
        data: { ...form, userId: user.id, propertyId: currentPropertyId },
      });
      toast.success("Account details updated.");
      onDone();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Account update failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit account</DialogTitle>
          <DialogDescription>
            Update profile details, role and property access for {user.identifier}. Login
            credentials are unchanged.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Full name"
            value={form.fullName}
            setValue={(value) => set("fullName", value)}
          />
          <Field
            label="Phone number"
            value={form.phone}
            setValue={(value) => set("phone", value)}
          />
          <Field
            label="Department"
            value={form.department}
            setValue={(value) => set("department", value)}
          />
          <div>
            <Label>Role</Label>
            <Select value={form.role} onValueChange={(value) => set("role", value)}>
              <SelectTrigger className="mt-2" aria-label="Role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((role) => (
                  <SelectItem key={role} value={role}>
                    {role.replaceAll("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label>Assigned properties</Label>
            <div className="mt-2 grid gap-2 rounded-md border p-3 sm:grid-cols-2">
              {properties.data?.map((property) => (
                <label key={property.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.propertyIds.includes(property.id)}
                    disabled={form.role === "super_admin"}
                    onCheckedChange={(checked) =>
                      set(
                        "propertyIds",
                        checked
                          ? [...form.propertyIds, property.id]
                          : form.propertyIds.filter((id) => id !== property.id),
                      )
                    }
                  />
                  {property.name}
                </label>
              ))}
            </div>
            {form.role === "super_admin" && (
              <p className="mt-2 text-xs text-muted-foreground">
                Super Admin access is global across properties.
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IdentifierDialog({
  user,
  propertyId,
  onClose,
  onDone,
}: {
  user: ManageableUser;
  propertyId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const updateIdentifier = useServerFn(updateManagedIdentifier);
  const [identifier, setIdentifier] = useState(user.identifier);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await updateIdentifier({ data: { userId: user.id, identifier, propertyId } });
      toast.success(`${user.account_type === "admin" ? "Admin ID" : "Staff ID"} updated.`);
      onDone();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "ID update failed");
    } finally {
      setBusy(false);
    }
  }
  const label = user.account_type === "admin" ? "Admin ID" : "Username / Staff ID";
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change {label}</DialogTitle>
          <DialogDescription>
            Set the login ID for {user.full_name || user.identifier}. Their email, password, roles
            and property assignments will not change.
          </DialogDescription>
        </DialogHeader>
        <Field label={label} value={identifier} setValue={setIdentifier} />
        <p className="text-xs text-muted-foreground">
          Use 3–80 letters, numbers, dots, underscores, hyphens or @ symbols with no spaces. The ID
          must be unique.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || identifier.trim() === user.identifier}>
            {busy ? "Saving…" : "Save ID"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetDialog({
  user,
  propertyId,
  onClose,
  onDone,
}: {
  user: ManageableUser;
  propertyId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const reset = useServerFn(resetManagedPassword);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (
      !confirm(`Reset the password for ${user.identifier}? Existing credentials will stop working.`)
    )
      return;
    setBusy(true);
    try {
      await reset({ data: { userId: user.id, password, confirmation, propertyId } });
      toast.success("Temporary password set; change required at next login.");
      onDone();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Set a temporary password for {user.identifier}. It will not be logged or stored by the
            application.
          </DialogDescription>
        </DialogHeader>
        <Field
          label="Temporary password"
          value={password}
          setValue={setPassword}
          type={show ? "text" : "password"}
        />
        <Field
          label="Confirm temporary password"
          value={confirmation}
          setValue={setConfirmation}
          type={show ? "text" : "password"}
        />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={show} onCheckedChange={(v) => setShow(!!v)} />
          Show passwords
        </label>
        <p className="text-xs text-muted-foreground">
          At least 10 characters with uppercase, lowercase, a number and a symbol.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "Resetting…" : "Reset password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function Field({
  label,
  value,
  setValue,
  type = "text",
  placeholder,
  onKey,
}: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  type?: string;
  placeholder?: string;
  onKey?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const id = label.toLowerCase().replace(/\W+/g, "-");
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="mt-2"
        type={type}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        autoComplete={type === "password" ? "new-password" : undefined}
      />
    </div>
  );
}
