import {
  createFileRoute,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { FastScrollControls } from "@/components/shared/data-query-controls";
import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { TopBar } from "@/components/top-bar";
import { AccessDenied } from "@/components/access-denied";
import { BrandFavicon } from "@/components/brand-favicon";
import { EnvironmentBanner } from "@/components/environment-banner";
import { useUserRoles } from "@/hooks/use-user-roles";
import { useActiveProperty } from "@/hooks/use-active-property";
import { isAllowed, requiredRolesFor } from "@/lib/admin/route-permissions";
import { getDeviceContext } from "@/lib/device-context";
import { pingSession } from "@/lib/sessions.functions";
import { getPasswordChangeState } from "@/lib/auth.functions";
import { getAuthenticationPolicy } from "@/lib/security/mfa.functions";
import { recordLogout } from "@/lib/security/mfa.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    const policy = await getAuthenticationPolicy();
    if (policy.required && policy.assuranceLevel !== "aal2") throw redirect({ to: "/mfa" });
    return { user: data.user };
  },
  component: AuthLayout,
});

const INACTIVITY_MS = 30 * 60 * 1000;

function AuthLayout() {
  const navigate = useNavigate();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPath = useRouterState({ select: (s) => s.location.pathname });
  const propertyId = useActiveProperty();
  const rolesQ = useUserRoles();
  const rows = rolesQ.data ?? [];
  const required = requiredRolesFor(currentPath);
  const guardReady = !required || !rolesQ.isLoading;
  const allowed = !required || isAllowed(currentPath, rows, propertyId ?? null);
  const passwordState = useServerFn(getPasswordChangeState);
  const auditLogout = useServerFn(recordLogout);

  useEffect(() => {
    passwordState()
      .then((state) => {
        if (state?.must_change_password) navigate({ to: "/change-password", replace: true });
      })
      .catch(() => navigate({ to: "/auth", replace: true }));
  }, [navigate, passwordState]);

  useEffect(() => {
    const reset = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        await auditLogout().catch(() => undefined);
        await supabase.auth.signOut();
        toast.info("Signed out after 30 minutes of inactivity.");
        navigate({ to: "/auth", replace: true });
      }, INACTIVITY_MS);
    };
    const events = ["mousemove", "keydown", "click", "touchstart"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      events.forEach((e) => window.removeEventListener(e, reset));
      if (timer.current) clearTimeout(timer.current);
    };
  }, [auditLogout, navigate]);

  // Session heartbeat for Live Online Users
  const ping = useServerFn(pingSession);
  useEffect(() => {
    const ctx = getDeviceContext();
    const beat = () => {
      ping({
        data: {
          sessionKey: ctx.sessionKey,
          propertyId: propertyId ?? null,
          userAgent: ctx.userAgent,
          os: ctx.os,
          browser: ctx.browser,
          fingerprint: ctx.fingerprint,
        },
      }).catch(() => {});
    };
    beat();
    const id = setInterval(beat, 60_000);
    return () => clearInterval(id);
  }, [propertyId, ping]);

  return (
    <SidebarProvider>
      {/* Organisation favicon override. Deliberately mounted HERE and not in
          __root.tsx: it rewrites every link[rel="icon"] in the document head,
          and running it above this authenticated boundary also ran it on
          /auth — the page Google crawls — replacing the static crawler-facing
          icon set with a signed cross-origin Supabase URL. See
          src/components/brand-favicon.tsx for the full history. */}
      <BrandFavicon />
      <div className="flex min-h-screen w-full bg-background">
        <AppSidebar />
        {/* min-w-0: this column is a flex item, so without it its automatic
            minimum size is the min-content width of the whole page below it.
            Any wide descendant -- a table inside its own overflow-x-auto, a
            grid of KPI cards -- then stretches this column past the viewport
            and the entire document scrolls sideways instead of the wide
            region scrolling inside itself. Clamping it here is what lets
            overflow-x-auto regions actually do their job. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The environment strip and the app header share one sticky
              container, so on a demo deployment the strip stays visible on
              every screen rather than scrolling away at the top of a page.
              On production ENVIRONMENT_LABEL is empty, <EnvironmentBanner />
              renders null, and this wrapper is visually identical to the
              plain sticky header it replaces. */}
          <div className="sticky top-0 z-30 bg-background/80 backdrop-blur">
            <EnvironmentBanner />
            <header className="flex h-14 items-center gap-2 border-b px-3">
              <SidebarTrigger />
              <TopBar />
            </header>
          </div>
          <main className="flex-1 p-4 sm:p-6">
            {!guardReady ? null : allowed ? <Outlet /> : <AccessDenied />}
          </main>
          {guardReady && allowed ? <FastScrollControls /> : null}
        </div>
      </div>
    </SidebarProvider>
  );
}
