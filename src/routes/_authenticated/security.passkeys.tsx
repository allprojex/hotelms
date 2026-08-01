/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 5 tables await generated database types. */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useActiveProperty } from "@/hooks/use-active-property";
import {
  requestPasskeyEnrollment,
  getOwnPasskeyEnrollment,
} from "@/lib/security/passkey-enrollment.functions";
import {
  beginPasskeyRegistration,
  completePasskeyRegistration,
} from "@/lib/security/passkey-registration.functions";
import {
  listOwnPasskeys,
  renameOwnPasskey,
  revokeOwnPasskey,
} from "@/lib/security/passkey-credentials.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Fingerprint, KeyRound, ShieldCheck, ShieldQuestion, Trash2, Pencil } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/security/passkeys")({
  head: () => ({
    meta: [
      { title: "Passkeys & Security · ThesKwoff Hotel" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PasskeysPage,
});

function PasskeysPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();

  const enrollmentFn = useServerFn(getOwnPasskeyEnrollment);
  const requestFn = useServerFn(requestPasskeyEnrollment);
  const listFn = useServerFn(listOwnPasskeys);
  const beginFn = useServerFn(beginPasskeyRegistration);
  const completeFn = useServerFn(completePasskeyRegistration);
  const renameFn = useServerFn(renameOwnPasskey);
  const revokeFn = useServerFn(revokeOwnPasskey);

  const enrollment = useQuery({
    queryKey: ["passkey-enrollment", propertyId],
    queryFn: () => enrollmentFn({ data: { propertyId: propertyId! } }),
    enabled: !!propertyId,
  });
  const passkeys = useQuery({
    queryKey: ["own-passkeys"],
    queryFn: () => listFn(),
  });

  const requestMut = useMutation({
    mutationFn: () => requestFn({ data: { propertyId: propertyId! } }),
    onSuccess: () => {
      toast.success(
        "Enrollment requested. An administrator must approve it before you can add a passkey.",
      );
      qc.invalidateQueries({ queryKey: ["passkey-enrollment", propertyId] });
    },
    onError: (e: any) => toast.error(e.message ?? "Could not request enrollment."),
  });

  const [enrolling, setEnrolling] = useState(false);
  const [deviceName, setDeviceName] = useState("");

  async function enroll() {
    if (!propertyId) return;
    if (!browserSupportsWebAuthn()) {
      toast.error("This browser does not support passkeys. Use password sign-in instead.");
      return;
    }
    setEnrolling(true);
    try {
      const begin = await beginFn({ data: { propertyId } });
      const attestation = await startRegistration({ optionsJSON: begin.options });
      await completeFn({
        data: {
          propertyId,
          challengeId: begin.challengeId,
          deviceName: deviceName || "Passkey",
          response: attestation,
        },
      });
      toast.success("Passkey added.");
      setDeviceName("");
      qc.invalidateQueries({ queryKey: ["own-passkeys"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Could not add passkey.");
    } finally {
      setEnrolling(false);
    }
  }

  const renameMut = useMutation({
    mutationFn: (vars: { id: string; name: string }) =>
      renameFn({ data: { credentialId: vars.id, name: vars.name } }),
    onSuccess: () => {
      toast.success("Passkey renamed.");
      qc.invalidateQueries({ queryKey: ["own-passkeys"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Could not rename passkey."),
  });
  const revokeMut = useMutation({
    mutationFn: (id: string) => revokeFn({ data: { credentialId: id } }),
    onSuccess: () => {
      toast.success("Passkey revoked. Password sign-in remains available.");
      qc.invalidateQueries({ queryKey: ["own-passkeys"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Could not revoke passkey."),
  });

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property first.</div>;

  const status = enrollment.data?.status ?? "not_requested";
  const activeCount = (passkeys.data ?? []).filter((p: any) => p.active).length;

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-3xl">
      <header className="flex items-center gap-3">
        <Fingerprint className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-display font-semibold">Passkeys &amp; Security</h1>
          <p className="text-xs text-muted-foreground">
            Sign in with your device's fingerprint, face recognition, Windows Hello, Touch ID or PIN
            — handled entirely by your operating system. This app never sees or stores your
            biometrics.
          </p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldQuestion className="h-4 w-4" /> Enrollment status
          </CardTitle>
          <CardDescription>
            An administrator must approve passkey enrollment before you can add one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <EnrollmentBadge status={status} />
          {status === "not_requested" || status === "rejected" ? (
            <Button size="sm" onClick={() => requestMut.mutate()} disabled={requestMut.isPending}>
              {requestMut.isPending ? "Requesting…" : "Request passkey enrollment"}
            </Button>
          ) : null}
          {status === "pending" && (
            <p className="text-sm text-muted-foreground">Waiting for administrator approval.</p>
          )}
          {status === "revoked" && (
            <p className="text-sm text-muted-foreground">
              Your enrollment was revoked. Ask an administrator to reset it before requesting again.
            </p>
          )}
        </CardContent>
      </Card>

      {status === "approved" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="h-4 w-4" /> Add a passkey
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col sm:flex-row gap-2">
            <Input
              placeholder="Device name (e.g. My iPhone)"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              maxLength={80}
            />
            <Button onClick={enroll} disabled={enrolling}>
              {enrolling ? "Follow your device's prompt…" : "Add passkey"}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your passkeys</CardTitle>
          <CardDescription>
            Password sign-in always remains available as a fallback.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(passkeys.data ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground py-4">No passkeys registered yet.</p>
          )}
          {(passkeys.data ?? []).map((p: any) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-md border p-3 gap-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{p.deviceName}</span>
                  {!p.active && <Badge variant="secondary">Revoked</Badge>}
                  {p.active && (
                    <Badge variant="outline" className="gap-1">
                      <ShieldCheck className="h-3 w-3" />
                      Active
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {p.attachment ?? "Unknown type"} · ····{p.credentialIdSuffix} · Added{" "}
                  {format(new Date(p.createdAt), "MMM d, yyyy")}
                  {p.lastUsedAt
                    ? ` · Last used ${format(new Date(p.lastUsedAt), "MMM d, yyyy")}`
                    : ""}
                </p>
              </div>
              {p.active && (
                <div className="flex items-center gap-1 shrink-0">
                  <RenameButton
                    current={p.deviceName}
                    onSave={(name) => renameMut.mutate({ id: p.id, name })}
                  />
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="icon" variant="ghost">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revoke this passkey?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {activeCount <= 1
                            ? "This is your only passkey. You will still be able to sign in with your password."
                            : "You can add another passkey later once approved."}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => revokeMut.mutate(p.id)}>
                          Revoke
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function EnrollmentBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: any }> = {
    not_requested: { label: "Not requested", variant: "secondary" },
    pending: { label: "Pending approval", variant: "outline" },
    approved: { label: "Approved", variant: "default" },
    rejected: { label: "Rejected", variant: "destructive" },
    revoked: { label: "Revoked", variant: "destructive" },
  };
  const entry = map[status] ?? map.not_requested;
  return <Badge variant={entry.variant}>{entry.label}</Badge>;
}

function RenameButton({ current, onSave }: { current: string; onSave: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(current);
  if (!editing) {
    return (
      <Button
        size="icon"
        variant="ghost"
        onClick={() => {
          setName(current);
          setEditing(true);
        }}
      >
        <Pencil className="h-4 w-4" />
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        className="h-8 w-32"
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
      />
      <Button
        size="sm"
        onClick={() => {
          onSave(name);
          setEditing(false);
        }}
      >
        Save
      </Button>
    </div>
  );
}
