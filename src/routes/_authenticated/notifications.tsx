import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { useUserRoles } from "@/hooks/use-user-roles";
import { ADMIN_ROLES } from "@/lib/admin/permissions";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { Check, RefreshCw, Trash2 } from "lucide-react";
import { purgeOnlineUsers } from "@/lib/sessions.functions";
import { markNotificationRead } from "@/lib/notifications.functions";
import {
  NOTIFICATIONS_HISTORY_QUERY_KEY,
  invalidateNotificationQueries,
  prepareNotificationFeed,
  type NotificationRow,
} from "@/lib/notifications.client";
import { format } from "date-fns";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/notifications")({
  head: () => ({ meta: [{ title: "Notifications" }] }),
  component: NotificationsPage,
});

const CATEGORIES = [
  "all",
  "reservation",
  "pos",
  "payment",
  "housekeeping",
  "inventory",
  "upload",
  "approval",
  "user_mgmt",
  "system",
];

function NotificationsPage() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const rolesQ = useUserRoles();
  const isSuper = (rolesQ.data ?? []).some((r) => r.role === "super_admin");
  const isAdmin =
    isSuper ||
    (rolesQ.data ?? []).some(
      (r) =>
        ADMIN_ROLES.includes(r.role) && (r.property_id === null || r.property_id === propertyId),
    );
  const [scope, setScope] = useState<"property" | "all">("property");
  const purgeFn = useServerFn(purgeOnlineUsers);
  const purge = useMutation({
    mutationFn: () => purgeFn({ data: { propertyId: propertyId!, scope } }),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ["online-users"] });
      toast.success(`Purged ${res.purged} session${res.purged === 1 ? "" : "s"}.`);
    },
    onError: (e: any) => toast.error(e.message ?? "Purge failed."),
  });

  const markOne = useServerFn(markNotificationRead);

  const list = useQuery({
    queryKey: NOTIFICATIONS_HISTORY_QUERY_KEY,
    refetchInterval: 60_000,
    queryFn: async (): Promise<NotificationRow[]> => {
      const { data, error } = await supabase
        .from("notifications_with_read_state" as any)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw new Error(error.message);
      return prepareNotificationFeed((data as any[]) ?? []);
    },
  });

  async function readOne(id: string) {
    try {
      await markOne({ data: { id } });
      await invalidateNotificationQueries(qc);
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  const filtered = useMemo(() => {
    return (list.data ?? []).filter(
      (n) =>
        (cat === "all" || n.category === cat) &&
        (!q || (n.title + " " + (n.body ?? "")).toLowerCase().includes(q.toLowerCase())),
    );
  }, [list.data, q, cat]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            Full notification history across the property.
          </p>
        </div>
        {isAdmin && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="gap-1.5" disabled={!propertyId}>
                <Trash2 className="h-3.5 w-3.5" />
                Purge online users
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear all online users?</AlertDialogTitle>
                <AlertDialogDescription>
                  All affected users will be signed out on their next request. This does not delete
                  accounts.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="flex gap-2 my-2">
                <Button
                  type="button"
                  variant={scope === "property" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setScope("property")}
                >
                  This property
                </Button>
                {isSuper && (
                  <Button
                    type="button"
                    variant={scope === "all" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setScope("all")}
                  >
                    All properties
                  </Button>
                )}
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => purge.mutate()} disabled={purge.isPending}>
                  {purge.isPending ? "Purging…" : "Purge now"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs"
        />
        <Select value={cat} onValueChange={setCat}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Body</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  Loading notifications…
                </TableCell>
              </TableRow>
            )}
            {list.isError && !list.isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="py-8">
                  <div className="flex flex-col items-center gap-2 text-center text-destructive">
                    <span>Couldn't load notifications.</span>
                    <Button size="sm" variant="outline" onClick={() => list.refetch()}>
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                      Retry
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!list.isLoading &&
              !list.isError &&
              filtered.map((n) => (
                <TableRow key={n.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {format(new Date(n.created_at), "MMM d HH:mm")}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{n.category}</Badge>
                  </TableCell>
                  <TableCell className="font-medium">{n.title}</TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-md truncate">
                    {n.body}
                  </TableCell>
                  <TableCell>
                    {n.is_read ? <Badge variant="secondary">Read</Badge> : <Badge>New</Badge>}
                  </TableCell>
                  <TableCell>
                    {!n.is_read && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => readOne(n.id)}
                      >
                        <Check className="h-3 w-3 mr-1" />
                        Mark read
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            {!list.isLoading && !list.isError && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  No notifications match.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
