/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 5 tables await generated database types. */
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveProperty } from "@/hooks/use-active-property";
import { useHasAnyRole } from "@/hooks/use-user-roles";
import { PASSKEY_ADMIN_ROLES } from "@/lib/security/passkey-permissions";
import { AccessDenied } from "@/components/access-denied";
import {
  listPasskeyEnrollments,
  listPasskeyEnrollmentHistory,
  approvePasskeyEnrollment,
  rejectPasskeyEnrollment,
  revokePasskeyEnrollment,
  resetPasskeyEnrollment,
} from "@/lib/security/passkey-enrollment.functions";
import {
  listPasskeyCredentialsForAdmin,
  disablePasskeyCredential,
  revokePasskeyCredential,
  revokeAllPasskeyCredentials,
  resetUserTwoFactor,
  getOwnAuthPolicy,
  saveAuthPolicy,
} from "@/lib/security/passkey-credentials.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { ShieldCheck, Fingerprint, History, Settings2 } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin_/security/passkeys")({
  head: () => ({
    meta: [
      { title: "Passkey Administration · ThesKwoff Hotel" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminPasskeysPage,
});

function AdminPasskeysPage() {
  const propertyId = useActiveProperty();
  const gate = useHasAnyRole(PASSKEY_ADMIN_ROLES as any, propertyId);
  const [tab, setTab] = useState("requests");

  if (gate.loading) return <div className="p-6 text-muted-foreground">Checking access…</div>;
  if (!gate.allowed)
    return <AccessDenied message="Only administrators can manage passkey enrollment." />;
  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property first.</div>;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <header className="flex items-center gap-3">
        <Fingerprint className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-display font-semibold">Passkey Administration</h1>
          <p className="text-xs text-muted-foreground">
            Approve enrollment, manage credentials, and set the passkey/2FA policy for this
            property.
          </p>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="requests" className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            Enrollment
          </TabsTrigger>
          <TabsTrigger value="policy" className="gap-1.5">
            <Settings2 className="h-3.5 w-3.5" />
            Policy
          </TabsTrigger>
        </TabsList>
        <TabsContent value="requests">
          <EnrollmentTab propertyId={propertyId} />
        </TabsContent>
        <TabsContent value="policy">
          <PolicyTab propertyId={propertyId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EnrollmentTab({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const listFn = useServerFn(listPasskeyEnrollments);
  const list = useQuery({
    queryKey: ["admin-passkey-enrollments", propertyId, statusFilter],
    queryFn: () =>
      listFn({ data: { propertyId, status: statusFilter === "all" ? undefined : statusFilter } }),
  });

  const approveFn = useServerFn(approvePasskeyEnrollment);
  const rejectFn = useServerFn(rejectPasskeyEnrollment);
  const revokeFn = useServerFn(revokePasskeyEnrollment);
  const resetFn = useServerFn(resetPasskeyEnrollment);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["admin-passkey-enrollments", propertyId] });

  const approveMut = useMutation({
    mutationFn: (userId: string) => approveFn({ data: { propertyId, targetUserId: userId } }),
    onSuccess: () => {
      toast.success("Enrollment approved.");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not approve."),
  });
  const rejectMut = useMutation({
    mutationFn: (v: { userId: string; reason: string }) =>
      rejectFn({ data: { propertyId, targetUserId: v.userId, reason: v.reason } }),
    onSuccess: () => {
      toast.success("Enrollment rejected.");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not reject."),
  });
  const revokeMut = useMutation({
    mutationFn: (v: { userId: string; reason: string }) =>
      revokeFn({ data: { propertyId, targetUserId: v.userId, reason: v.reason } }),
    onSuccess: () => {
      toast.success("Enrollment revoked; all passkeys disabled.");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not revoke."),
  });
  const resetMut = useMutation({
    mutationFn: (v: { userId: string; reason: string }) =>
      resetFn({ data: { propertyId, targetUserId: v.userId, reason: v.reason } }),
    onSuccess: () => {
      toast.success("Enrollment reset. User must request approval again.");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not reset."),
  });

  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle className="text-base">Enrollment requests</CardTitle>
          <CardDescription>
            Approval is required before any user may register a passkey.
          </CardDescription>
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="revoked">Revoked</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Requested</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(list.data ?? []).map((row: any) => (
              <Fragment key={row.id}>
                <TableRow>
                  <TableCell className="text-sm">
                    {row.profiles?.full_name ?? row.profiles?.identifier ?? row.user_id.slice(0, 8)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.requested_at ? format(new Date(row.requested_at), "MMM d, HH:mm") : "—"}
                  </TableCell>
                  <TableCell className="text-right space-x-1">
                    {row.status === "pending" && (
                      <>
                        <Button size="sm" onClick={() => approveMut.mutate(row.user_id)}>
                          Approve
                        </Button>
                        <ReasonDialog
                          label="Reject"
                          title="Reject enrollment"
                          onConfirm={(reason) => rejectMut.mutate({ userId: row.user_id, reason })}
                        />
                      </>
                    )}
                    {row.status === "approved" && (
                      <ReasonDialog
                        label="Revoke"
                        title="Revoke enrollment"
                        destructive
                        onConfirm={(reason) => revokeMut.mutate({ userId: row.user_id, reason })}
                      />
                    )}
                    {(row.status === "revoked" || row.status === "rejected") && (
                      <ReasonDialog
                        label="Reset"
                        title="Reset enrollment eligibility"
                        onConfirm={(reason) => resetMut.mutate({ userId: row.user_id, reason })}
                      />
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpanded(expanded === row.user_id ? null : row.user_id)}
                    >
                      <History className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
                {expanded === row.user_id && (
                  <TableRow>
                    <TableCell colSpan={4} className="bg-muted/30">
                      <UserDetail propertyId={propertyId} userId={row.user_id} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
            {(list.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                  No enrollment requests match this filter.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, any> = {
    not_requested: "secondary",
    pending: "outline",
    approved: "default",
    rejected: "destructive",
    revoked: "destructive",
  };
  return <Badge variant={map[status] ?? "secondary"}>{status.replace("_", " ")}</Badge>;
}

function ReasonDialog({
  label,
  title,
  onConfirm,
  destructive,
}: {
  label: string;
  title: string;
  onConfirm: (reason: string) => void;
  destructive?: boolean;
}) {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={destructive ? "destructive" : "outline"}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            A reason of at least 5 characters is required and is recorded in the audit trail.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason…"
          rows={3}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={reason.trim().length < 5}
            onClick={() => {
              onConfirm(reason.trim());
              setOpen(false);
              setReason("");
            }}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserDetail({ propertyId, userId }: { propertyId: string; userId: string }) {
  const qc = useQueryClient();
  const credsFn = useServerFn(listPasskeyCredentialsForAdmin);
  const historyFn = useServerFn(listPasskeyEnrollmentHistory);
  const creds = useQuery({
    queryKey: ["admin-passkey-creds", propertyId, userId],
    queryFn: () => credsFn({ data: { propertyId, targetUserId: userId } }),
  });
  const history = useQuery({
    queryKey: ["admin-passkey-history", propertyId, userId],
    queryFn: () => historyFn({ data: { propertyId, targetUserId: userId } }),
  });

  const disableFn = useServerFn(disablePasskeyCredential);
  const revokeFn = useServerFn(revokePasskeyCredential);
  const revokeAllFn = useServerFn(revokeAllPasskeyCredentials);
  const resetTwoFactorFn = useServerFn(resetUserTwoFactor);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["admin-passkey-creds", propertyId, userId] });
  const disableMut = useMutation({
    mutationFn: (v: { credentialId: string; reason: string }) =>
      disableFn({ data: { propertyId, targetUserId: userId, ...v } }),
    onSuccess: () => {
      toast.success("Credential disabled.");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not disable."),
  });
  const revokeMut = useMutation({
    mutationFn: (v: { credentialId: string; reason: string }) =>
      revokeFn({ data: { propertyId, targetUserId: userId, ...v } }),
    onSuccess: () => {
      toast.success("Credential revoked.");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not revoke."),
  });
  const revokeAllMut = useMutation({
    mutationFn: (reason: string) =>
      revokeAllFn({ data: { propertyId, targetUserId: userId, reason } }),
    onSuccess: () => {
      toast.success("All credentials revoked.");
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? "Could not revoke all."),
  });
  const resetTwoFactorMut = useMutation({
    mutationFn: (reason: string) =>
      resetTwoFactorFn({ data: { propertyId, targetUserId: userId, reason } }),
    onSuccess: () => toast.success("Two-factor status reset."),
    onError: (e: any) => toast.error(e.message ?? "Could not reset 2FA."),
  });

  return (
    <div className="space-y-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Credentials ({(creds.data ?? []).length})</span>
        <div className="flex gap-2">
          <ReasonDialog
            label="Revoke all"
            title="Revoke all credentials"
            destructive
            onConfirm={(reason) => revokeAllMut.mutate(reason)}
          />
          <ReasonDialog
            label="Reset 2FA"
            title="Reset two-factor status"
            onConfirm={(reason) => resetTwoFactorMut.mutate(reason)}
          />
        </div>
      </div>
      <div className="space-y-1">
        {(creds.data ?? []).map((c: any) => (
          <div key={c.id} className="flex items-center justify-between text-xs border rounded p-2">
            <span>
              {c.device_name} — {c.authenticator_attachment ?? "unknown"} — added{" "}
              {format(new Date(c.created_at), "MMM d, yyyy")}
              {c.last_used_at
                ? ` · last used ${format(new Date(c.last_used_at), "MMM d, yyyy")}`
                : " · never used"}
              {c.revoked_at && (
                <Badge variant="destructive" className="ml-2">
                  Revoked
                </Badge>
              )}
              {c.disabled_at && !c.revoked_at && (
                <Badge variant="secondary" className="ml-2">
                  Disabled
                </Badge>
              )}
            </span>
            {!c.revoked_at && !c.disabled_at && (
              <div className="flex gap-1">
                <ReasonDialog
                  label="Disable"
                  title="Disable credential"
                  onConfirm={(reason) => disableMut.mutate({ credentialId: c.id, reason })}
                />
                <ReasonDialog
                  label="Revoke"
                  title="Revoke credential"
                  destructive
                  onConfirm={(reason) => revokeMut.mutate({ credentialId: c.id, reason })}
                />
              </div>
            )}
          </div>
        ))}
        {(creds.data ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground">No credentials registered.</p>
        )}
      </div>
      <div>
        <span className="text-sm font-medium">History</span>
        <div className="space-y-1 mt-1">
          {(history.data ?? []).map((h: any) => (
            <div key={h.id} className="text-xs text-muted-foreground">
              {format(new Date(h.created_at), "MMM d, HH:mm")} — {h.action}
              {h.reason ? `: ${h.reason}` : ""}
            </div>
          ))}
          {(history.data ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">No history yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function PolicyTab({ propertyId }: { propertyId: string }) {
  const getFn = useServerFn(getOwnAuthPolicy);
  const saveFn = useServerFn(saveAuthPolicy);
  const q = useQuery({
    queryKey: ["auth-policy", propertyId],
    queryFn: () => getFn({ data: { propertyId } }),
  });
  const [passkeyPolicy, setPasskeyPolicy] = useState("optional");
  const [twoFactorPolicy, setTwoFactorPolicy] = useState("disabled");

  const settings = q.data;
  if (settings && passkeyPolicy !== settings.passkey_policy) {
    setPasskeyPolicy(settings.passkey_policy);
    setTwoFactorPolicy(settings.two_factor_policy);
  }

  const saveMut = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          propertyId,
          passkeyPolicy: passkeyPolicy as any,
          twoFactorPolicy: twoFactorPolicy as any,
          twoFactorRequiredRoles: [],
          stepUpMaxAgeMinutes: 15,
        },
      }),
    onSuccess: () => toast.success("Policy saved."),
    onError: (e: any) => toast.error(e.message ?? "Could not save policy."),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Passkey &amp; two-factor policy</CardTitle>
        <CardDescription>
          TOTP is not implemented in this phase — passkeys are the supported strong second factor.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label>Passkey policy</Label>
          <Select value={passkeyPolicy} onValueChange={setPasskeyPolicy}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="disabled">Disabled</SelectItem>
              <SelectItem value="optional">Optional</SelectItem>
              <SelectItem value="encouraged">Encouraged</SelectItem>
              <SelectItem value="required">Required</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Two-factor policy</Label>
          <Select value={twoFactorPolicy} onValueChange={setTwoFactorPolicy}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="disabled">Disabled</SelectItem>
              <SelectItem value="optional">Optional</SelectItem>
              <SelectItem value="required">Required for selected roles</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
          {saveMut.isPending ? "Saving…" : "Save policy"}
        </Button>
      </CardContent>
    </Card>
  );
}
