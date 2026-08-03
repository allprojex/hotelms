import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Bell, Check, CheckCheck, RefreshCw } from "lucide-react";
import { markNotificationRead, markAllNotificationsRead } from "@/lib/notifications.functions";
import {
  NOTIFICATIONS_QUERY_KEY,
  invalidateNotificationQueries,
  prepareNotificationFeed,
  countUnread,
  type NotificationRow,
} from "@/lib/notifications-shared";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

async function fetchNotifications(): Promise<NotificationRow[]> {
  const { data, error } = await supabase
    .from("notifications_with_read_state" as any)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return prepareNotificationFeed((data as any[]) ?? []);
}

export function NotificationBell() {
  const qc = useQueryClient();
  const markOne = useServerFn(markNotificationRead);
  const markAll = useServerFn(markAllNotificationsRead);
  const [tab, setTab] = useState<"unread" | "all">("unread");
  const [open, setOpen] = useState(false);

  const q = useQuery({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    refetchInterval: 30_000,
    queryFn: fetchNotifications,
  });

  const unread = useMemo(() => (q.data ?? []).filter((n) => !n.is_read), [q.data]);
  const unreadCount = useMemo(() => countUnread(q.data ?? []), [q.data]);
  const list = tab === "unread" ? unread : (q.data ?? []);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) void q.refetch();
  }

  async function readOne(id: string) {
    try {
      await markOne({ data: { id } });
      await invalidateNotificationQueries(qc);
    } catch (e: any) {
      toast.error(e.message);
    }
  }
  async function readAll() {
    try {
      await markAll();
      await invalidateNotificationQueries(qc);
      toast.success("All marked read");
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <Badge className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px]">
              {unreadCount > 99 ? "99+" : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b p-3">
          <div className="font-semibold text-sm">Notifications</div>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={readAll}
              className="h-7 text-xs"
              disabled={unreadCount === 0}
            >
              <CheckCheck className="h-3 w-3 mr-1" />
              Mark all read
            </Button>
          </div>
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
          <TabsList className="grid grid-cols-2 w-full rounded-none">
            <TabsTrigger value="unread">Unread ({unreadCount})</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
          <TabsContent value={tab} className="mt-0">
            <div className="max-h-96 overflow-y-auto">
              {q.isLoading && (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  Loading notifications…
                </div>
              )}
              {q.isError && !q.isLoading && (
                <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-destructive">
                  <span>Couldn't load notifications.</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => q.refetch()}
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Retry
                  </Button>
                </div>
              )}
              {!q.isLoading && !q.isError && list.length === 0 && (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  Nothing here yet.
                </div>
              )}
              {!q.isLoading &&
                !q.isError &&
                list.map((n) => (
                  <div
                    key={n.id}
                    className={`flex gap-2 border-b p-3 text-xs ${!n.is_read ? "bg-primary/5" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px] uppercase">
                          {n.category}
                        </Badge>
                        {n.priority !== "normal" && (
                          <Badge className="text-[10px]">{n.priority}</Badge>
                        )}
                      </div>
                      <div className="font-medium mt-1 truncate">{n.title}</div>
                      {n.body && <div className="text-muted-foreground truncate">{n.body}</div>}
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-[10px] text-muted-foreground">
                          {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                        </span>
                        {n.link ? (
                          <Link
                            to={n.link}
                            onClick={() => {
                              if (!n.is_read) void readOne(n.id);
                            }}
                            className="text-[10px] text-primary hover:underline"
                          >
                            Open →
                          </Link>
                        ) : (
                          !n.is_read && (
                            <button
                              type="button"
                              onClick={() => readOne(n.id)}
                              className="text-[10px] text-primary hover:underline"
                            >
                              Mark read
                            </button>
                          )
                        )}
                      </div>
                    </div>
                    {!n.is_read && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        onClick={() => readOne(n.id)}
                      >
                        <Check className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
            </div>
          </TabsContent>
        </Tabs>
        <div className="border-t p-2 text-center">
          <Link to="/notifications" className="text-xs text-primary hover:underline">
            View all notifications →
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
