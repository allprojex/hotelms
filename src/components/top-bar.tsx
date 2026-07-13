import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTheme } from "@/components/theme-provider";
import { Moon, Sun, LogOut, User as UserIcon } from "lucide-react";
import { getActivePropertyId, setActivePropertyId } from "@/lib/property-store";
import { toast } from "sonner";
import { NotificationBell } from "@/components/notification-bell";
import { getPasswordChangeState } from "@/lib/auth.functions";

export function TopBar() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [activeId, setActiveId] = useState<string | null>(null);

  const getViewer = useServerFn(getPasswordChangeState);
  const { data: user } = useQuery({
    queryKey: ["me-profile"],
    queryFn: () => getViewer(),
  });

  const { data: properties } = useQuery({
    queryKey: ["properties-nav"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("properties")
        .select("id,name,code")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    const stored = getActivePropertyId();
    if (stored) {
      setActiveId(stored);
      return;
    }
    if (properties && properties.length > 0) {
      setActivePropertyId(properties[0].id);
      setActiveId(properties[0].id);
      window.dispatchEvent(new Event("iti-property-changed"));
    }
  }, [properties]);

  const active = properties?.find((p) => p.id === activeId);

  async function signOut() {
    await supabase.auth.signOut();
    toast.success("Signed out");
    navigate({ to: "/auth", replace: true });
  }

  const displayName = user?.full_name || user?.identifier || "Account";
  const initials = displayName[0]?.toUpperCase() ?? "?";

  return (
    <div className="flex flex-1 items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        {properties && properties.length > 0 && (
          <Select
            value={activeId ?? undefined}
            onValueChange={(v) => {
              setActivePropertyId(v);
              setActiveId(v);
              window.dispatchEvent(new Event("iti-property-changed"));
            }}
          >
            <SelectTrigger className="h-8 w-[220px]">
              <SelectValue placeholder="Select property" />
            </SelectTrigger>
            <SelectContent>
              {properties.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{p.code}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {active && (
          <span className="hidden text-xs text-muted-foreground sm:inline">{active.name}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <NotificationBell />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 gap-2 px-2">
              <Avatar className="h-6 w-6">
                <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
              </Avatar>
              <span className="hidden text-sm sm:inline">{displayName}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>
              <div>{displayName}</div>
              {user?.identifier && user.identifier !== displayName && (
                <div className="text-xs font-normal text-muted-foreground">{user.identifier}</div>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate({ to: "/settings" })}>
              <UserIcon className="mr-2 h-4 w-4" /> Profile & Settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={signOut} className="text-destructive">
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
