import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  ShieldCheck,
  Building2,
  CalendarDays,
  Wallet,
  Utensils,
  Package,
  Radio,
  UserCog,
  Lock,
  Beaker,
  Palette,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { useHasAnyRole } from "@/hooks/use-user-roles";
import { setActivePropertyId } from "@/lib/property-store";
import { AccessDenied } from "@/components/access-denied";
import { ADMIN_ROLES } from "@/lib/admin/permissions";
import { PropertiesModule } from "@/components/admin/modules/properties-module";
import { ReservationsModule } from "@/components/admin/modules/reservations-module";
import { AccountingModule } from "@/components/admin/modules/accounting-module";
import { PosModule } from "@/components/admin/modules/pos-module";
import { InventoryModule } from "@/components/admin/modules/inventory-module";
import { ChannelsModule } from "@/components/admin/modules/channels-module";
import { UsersModule } from "@/components/admin/modules/users-module";
import { TrialDataModule } from "@/components/admin/modules/trial-data-module";
import { BrandModule } from "@/components/admin/modules/brand-module";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: pageTitle("Administration") },
      {
        name: "description",
        content:
          "System-wide admin console: manage properties, reservations, accounting, POS, inventory, channels, and users.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminPage,
});

const TABS = [
  { key: "properties", label: "Properties", icon: Building2 },
  { key: "reservations", label: "Reservations", icon: CalendarDays },
  { key: "accounting", label: "Accounting", icon: Wallet },
  { key: "pos", label: "POS", icon: Utensils },
  { key: "inventory", label: "Inventory", icon: Package },
  { key: "channels", label: "Channels", icon: Radio },
  { key: "users", label: "User & Staff Management", icon: UserCog },
  { key: "brand", label: "Brand", icon: Palette },
  { key: "trial", label: "Trial data", icon: Beaker },
] as const;

function AdminPage() {
  const propertyId = useActiveProperty();
  const gate = useHasAnyRole(ADMIN_ROLES, propertyId);
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("properties");

  const { data: properties = [] } = useQuery({
    queryKey: ["admin-properties-nav"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("properties")
        .select("id,name,code")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const active = properties.find((p) => p.id === propertyId);

  function onChangeProperty(id: string) {
    setActivePropertyId(id);
    window.dispatchEvent(new Event("iti-property-changed"));
  }

  if (gate.loading) return <div className="p-6 text-muted-foreground">Checking access…</div>;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-display font-semibold">Administration</h1>
            <p className="text-xs text-muted-foreground">
              All actions and printed documents target the selected property. Authorization is
              re-checked when you switch.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Property</span>
          <Select value={propertyId ?? ""} onValueChange={onChangeProperty}>
            <SelectTrigger className="h-9 w-[260px]">
              <SelectValue placeholder="Select a property" />
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
          {active ? (
            <Badge variant="secondary" className="gap-1">
              <Building2 className="h-3 w-3" /> {active.code}
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <Lock className="h-3 w-3" /> None
            </Badge>
          )}
        </div>
      </div>

      {!propertyId ? (
        <AccessDenied message="Select a property from the header to load the admin console." />
      ) : !gate.allowed ? (
        <AccessDenied
          message={`You don't have admin access for ${active?.name ?? "this property"}. Switch to a property where you are a super admin, hotel owner, or general manager.`}
        />
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="space-y-4">
          <TabsList className="flex flex-wrap h-auto">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key} className="gap-1.5">
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="properties">
            <PropertiesModule propertyId={propertyId} />
          </TabsContent>
          <TabsContent value="reservations">
            <ReservationsModule propertyId={propertyId} />
          </TabsContent>
          <TabsContent value="accounting">
            <AccountingModule propertyId={propertyId} />
          </TabsContent>
          <TabsContent value="pos">
            <PosModule propertyId={propertyId} />
          </TabsContent>
          <TabsContent value="inventory">
            <InventoryModule propertyId={propertyId} />
          </TabsContent>
          <TabsContent value="channels">
            <ChannelsModule propertyId={propertyId} />
          </TabsContent>
          <TabsContent value="users">
            <UsersModule propertyId={propertyId} />
          </TabsContent>
          <TabsContent value="brand">
            <BrandModule />
          </TabsContent>
          <TabsContent value="trial">
            <TrialDataModule propertyId={propertyId} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
