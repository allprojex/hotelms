import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Upload,
  ShieldAlert,
  Palette,
  ImagePlus,
  Trash2,
  Building2,
  Globe,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useBrandSettings, type BrandSettings } from "@/hooks/use-brand-settings";
import { useHasAnyRole } from "@/hooks/use-user-roles";

const ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
];
const MAX_BYTES = 2 * 1024 * 1024;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

type BrandFormState = BrandSettings;

const BLANK: BrandFormState = {
  app_name: "",
  app_short_name: "",
  tagline: "",
  logo_url: "",
  logo_dark_url: "",
  favicon_url: "",
  primary_color: "",
  secondary_color: "",
  support_email: "",
  support_phone: "",
};

/**
 * Shared upload helper for both organisation-wide and property-level brand
 * assets — the private brand-assets bucket, random-UUID path, and signed-URL
 * pattern don't depend on which settings row the result gets saved into.
 */
async function uploadBrandAsset(kind: string, file: File): Promise<string> {
  if (!ACCEPT.includes(file.type)) {
    throw new Error("Unsupported file type — use PNG, JPG, SVG, WEBP, or ICO");
  }
  if (file.size > MAX_BYTES) {
    throw new Error("File too large — max 2 MB");
  }
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "bin";
  const path = `${kind}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from("brand-assets")
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
  if (upErr) throw upErr;
  // Bucket is private, so mint a long-lived signed URL that safely renders
  // in <img src> and is directly fetchable by server-side PDF generation.
  const TEN_YEARS_SECONDS = 60 * 60 * 24 * 365 * 10;
  const { data, error: signErr } = await supabase.storage
    .from("brand-assets")
    .createSignedUrl(path, TEN_YEARS_SECONDS);
  if (signErr || !data?.signedUrl) throw signErr ?? new Error("Could not sign asset URL");
  return data.signedUrl;
}

/**
 * Best-effort cleanup of a replaced asset. Conservative by design: only
 * deletes when the old URL is (a) actually one of our own brand-assets
 * signed URLs, and (b) not equal to any other value in the same save
 * payload (guards against deleting an object that's still referenced
 * elsewhere in the very row being saved, e.g. a logo reused as both the
 * light and dark slot). Never blocks or fails the save itself.
 */
async function tryCleanupReplacedAsset(
  oldUrl: string | null | undefined,
  stillReferenced: (string | null | undefined)[],
) {
  if (!oldUrl) return;
  if (!oldUrl.includes("/brand-assets/")) return;
  if (stillReferenced.some((v) => v === oldUrl)) return;
  try {
    const path = oldUrl.split("/brand-assets/")[1]?.split("?")[0];
    if (!path) return;
    await supabase.storage.from("brand-assets").remove([decodeURIComponent(path)]);
  } catch {
    // Best-effort — an orphaned object is a minor storage cost, never a
    // reason to fail the save.
  }
}

export function BrandModule() {
  return (
    <div className="space-y-8">
      <OrganisationBrandingEditor />
      <Separator />
      <PropertyBrandingEditor />
    </div>
  );
}

function OrganisationBrandingEditor() {
  // Organisation-wide brand settings are global (not property-scoped) —
  // pass null so the hook checks for a super_admin grant that spans all
  // properties. Property-level overrides are edited separately below.
  const superOnly = useHasAnyRole(["super_admin"], null);
  const brand = useBrandSettings();
  const qc = useQueryClient();
  const [form, setForm] = useState<BrandFormState>(BLANK);
  const [uploading, setUploading] = useState<null | "logo" | "logo_dark" | "favicon">(null);

  useEffect(() => {
    if (brand.data) {
      setForm({
        app_name: brand.data.app_name ?? "",
        app_short_name: brand.data.app_short_name ?? "",
        tagline: brand.data.tagline ?? "",
        logo_url: brand.data.logo_url ?? "",
        logo_dark_url: brand.data.logo_dark_url ?? "",
        favicon_url: brand.data.favicon_url ?? "",
        primary_color: brand.data.primary_color ?? "",
        secondary_color: brand.data.secondary_color ?? "",
        support_email: brand.data.support_email ?? "",
        support_phone: brand.data.support_phone ?? "",
      });
    }
  }, [brand.data]);

  const save = useMutation({
    mutationFn: async (values: BrandFormState) => {
      const previous = brand.data;
      // RLS on system_settings restricts writes to super_admin.
      const payload: Record<string, unknown> = {
        app_name: values.app_name || "ThesKwoff Hotel",
        app_short_name: nullify(values.app_short_name),
        tagline: nullify(values.tagline),
        logo_url: nullify(values.logo_url),
        logo_dark_url: nullify(values.logo_dark_url),
        favicon_url: nullify(values.favicon_url),
        primary_color: nullify(values.primary_color),
        secondary_color: nullify(values.secondary_color),
        support_email: nullify(values.support_email),
        support_phone: nullify(values.support_phone),
      };
      const { error } = await supabase
        .from("system_settings")
        .update(payload as any)
        .eq("id", true);
      if (error) throw error;
      const nextValues = [payload.logo_url, payload.logo_dark_url, payload.favicon_url] as (
        | string
        | null
      )[];
      if (previous?.logo_url !== payload.logo_url)
        await tryCleanupReplacedAsset(previous?.logo_url, nextValues);
      if (previous?.logo_dark_url !== payload.logo_dark_url)
        await tryCleanupReplacedAsset(previous?.logo_dark_url, nextValues);
      if (previous?.favicon_url !== payload.favicon_url)
        await tryCleanupReplacedAsset(previous?.favicon_url, nextValues);
    },
    onSuccess: () => {
      toast.success("Organisation brand settings saved");
      qc.invalidateQueries({ queryKey: ["brand-settings"] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Failed to save brand settings"),
  });

  async function upload(kind: "logo" | "logo_dark" | "favicon", file: File) {
    setUploading(kind);
    try {
      const url = await uploadBrandAsset(kind, file);
      const key: keyof BrandFormState =
        kind === "logo" ? "logo_url" : kind === "logo_dark" ? "logo_dark_url" : "favicon_url";
      setForm((f) => ({ ...f, [key]: url }));
      toast.success(`${labelFor(kind)} uploaded — click Save to apply`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(null);
    }
  }

  const previewPrimary = form.primary_color || "var(--primary)";

  if (superOnly.loading) {
    return <div className="p-6 text-muted-foreground">Checking access…</div>;
  }
  if (!superOnly.allowed) {
    return (
      <Alert>
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Restricted</AlertTitle>
        <AlertDescription>
          Only a System Super Admin can change organisation brand settings. Contact your
          administrator to request changes.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Organisation branding
          </h2>
        </div>
        <p className="-mt-4 text-xs text-muted-foreground">
          The default branding for every property. Falls back automatically for any property without
          its own override below.
        </p>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Palette className="h-4 w-4 text-primary" /> Identity
            </CardTitle>
            <CardDescription>
              Shown across the app: sidebar header, browser tab, emails, exports.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Application name" required>
              <Input
                value={form.app_name ?? ""}
                onChange={(e) => setForm({ ...form, app_name: e.target.value })}
                placeholder="ThesKwoff Hotel"
              />
            </Field>
            <Field label="Short name (sidebar)">
              <Input
                value={form.app_short_name ?? ""}
                onChange={(e) => setForm({ ...form, app_short_name: e.target.value })}
                placeholder="ThesKwoff Hotel"
              />
            </Field>
            <Field label="Tagline" className="sm:col-span-2">
              <Textarea
                rows={2}
                value={form.tagline ?? ""}
                onChange={(e) => setForm({ ...form, tagline: e.target.value })}
                placeholder="Enterprise cloud hotel property management"
              />
            </Field>
            <Field label="Primary color (optional)">
              <div className="flex items-center gap-2">
                <Input
                  value={form.primary_color ?? ""}
                  onChange={(e) => setForm({ ...form, primary_color: e.target.value })}
                  placeholder="oklch(0.55 0.14 160) or #10b981"
                />
                <span
                  className="h-9 w-9 rounded-md border"
                  style={{ backgroundColor: previewPrimary }}
                  aria-label="Primary color preview"
                />
              </div>
            </Field>
            <Field label="Secondary color (optional)">
              <div className="flex items-center gap-2">
                <Input
                  value={form.secondary_color ?? ""}
                  onChange={(e) => setForm({ ...form, secondary_color: e.target.value })}
                  placeholder="#0087b5"
                />
                <span
                  className="h-9 w-9 rounded-md border"
                  style={{ backgroundColor: form.secondary_color || "var(--secondary)" }}
                  aria-label="Secondary color preview"
                />
              </div>
            </Field>
            <Field label="Support email">
              <Input
                type="email"
                value={form.support_email ?? ""}
                onChange={(e) => setForm({ ...form, support_email: e.target.value })}
                placeholder="support@example.com"
              />
            </Field>
            <Field label="Support phone">
              <Input
                value={form.support_phone ?? ""}
                onChange={(e) => setForm({ ...form, support_phone: e.target.value })}
                placeholder="+233…"
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ImagePlus className="h-4 w-4 text-primary" /> Logos & favicon
            </CardTitle>
            <CardDescription>
              PNG, JPG, SVG, WEBP, or ICO up to 2 MB. Public URLs are safe to share.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <AssetSlot
              label="Logo (light theme)"
              hint="Displayed in the sidebar header when the app is in light mode."
              url={form.logo_url}
              uploading={uploading === "logo"}
              onFile={(f) => upload("logo", f)}
              onClear={() => setForm({ ...form, logo_url: "" })}
            />
            <AssetSlot
              label="Logo (dark theme, optional)"
              hint="Falls back to the light logo when unset."
              url={form.logo_dark_url}
              uploading={uploading === "logo_dark"}
              onFile={(f) => upload("logo_dark", f)}
              onClear={() => setForm({ ...form, logo_dark_url: "" })}
              dark
            />
            <AssetSlot
              label="Favicon"
              hint="Shown in the browser tab. Square, 32×32 or larger recommended."
              url={form.favicon_url}
              uploading={uploading === "favicon"}
              onFile={(f) => upload("favicon", f)}
              onClear={() => setForm({ ...form, favicon_url: "" })}
            />
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => brand.refetch()} disabled={save.isPending}>
            Reset
          </Button>
          <Button
            onClick={() => save.mutate(form)}
            disabled={save.isPending || !form.app_name.trim()}
          >
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save changes
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Live preview</CardTitle>
            <CardDescription>How the brand appears across the app.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <BrowserTabPreview
              title={form.app_name || "ThesKwoff Hotel"}
              favicon={form.favicon_url}
            />
            <Separator />
            <SidebarHeaderPreview
              name={form.app_short_name || form.app_name || "ThesKwoff Hotel"}
              logo={form.logo_url}
            />
            <Separator />
            <div>
              <Label className="text-xs text-muted-foreground">Sample primary button</Label>
              <div className="mt-2">
                <button
                  className="rounded-md px-4 py-2 text-sm font-medium text-white shadow-sm"
                  style={{ backgroundColor: previewPrimary }}
                >
                  {form.app_short_name || "Continue"}
                </button>
              </div>
            </div>
            {form.tagline ? (
              <>
                <Separator />
                <p className="text-sm italic text-muted-foreground">"{form.tagline}"</p>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

type PropertyBrandingRow = {
  property_id: string;
  display_name: string | null;
  logo_url: string | null;
  logo_dark_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  support_email: string | null;
  support_phone: string | null;
};

type PropertyBrandingFormState = Omit<PropertyBrandingRow, "property_id">;

const PROPERTY_BLANK: PropertyBrandingFormState = {
  display_name: "",
  logo_url: "",
  logo_dark_url: "",
  primary_color: "",
  secondary_color: "",
  support_email: "",
  support_phone: "",
};

function PropertyBrandingEditor() {
  const qc = useQueryClient();
  const org = useBrandSettings();

  const properties = useQuery({
    queryKey: ["properties-branding-list"],
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

  const [propertyId, setPropertyId] = useState<string | null>(null);
  useEffect(() => {
    if (!propertyId && properties.data && properties.data.length > 0) {
      setPropertyId(properties.data[0].id);
    }
  }, [properties.data, propertyId]);

  // Property branding requires super_admin, hotel_owner, or general_manager
  // scoped to this exact property — accountant and front_desk are
  // deliberately excluded, mirroring the RLS write policy on
  // property_branding exactly (server-side enforcement is the real
  // boundary; this is UI-hiding only, same convention as the organisation
  // editor's superOnly check above).
  const canEdit = useHasAnyRole(["super_admin", "hotel_owner", "general_manager"], propertyId);

  const existing = useQuery({
    queryKey: ["property-branding", propertyId],
    enabled: !!propertyId,
    queryFn: async (): Promise<PropertyBrandingRow | null> => {
      // property_branding is new and not yet in the generated Database
      // types — same untyped-table pattern already used elsewhere in this
      // codebase for a table awaiting codegen (see pdf.functions.ts's
      // (supabase as any).from("ar_receipts") for the established precedent).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from("property_branding")
        .select("*")
        .eq("property_id", propertyId as string)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as PropertyBrandingRow) ?? null;
    },
  });

  const [form, setForm] = useState<PropertyBrandingFormState>(PROPERTY_BLANK);
  const [uploading, setUploading] = useState<null | "logo" | "logo_dark">(null);

  useEffect(() => {
    if (existing.data) {
      setForm({
        display_name: existing.data.display_name ?? "",
        logo_url: existing.data.logo_url ?? "",
        logo_dark_url: existing.data.logo_dark_url ?? "",
        primary_color: existing.data.primary_color ?? "",
        secondary_color: existing.data.secondary_color ?? "",
        support_email: existing.data.support_email ?? "",
        support_phone: existing.data.support_phone ?? "",
      });
    } else {
      setForm(PROPERTY_BLANK);
    }
  }, [existing.data, propertyId]);

  const save = useMutation({
    mutationFn: async (values: PropertyBrandingFormState) => {
      if (!propertyId) throw new Error("Select a property first");
      if (values.primary_color && !HEX_COLOR_RE.test(values.primary_color)) {
        throw new Error("Primary color must be a #rrggbb hex value");
      }
      if (values.secondary_color && !HEX_COLOR_RE.test(values.secondary_color)) {
        throw new Error("Secondary color must be a #rrggbb hex value");
      }
      const previous = existing.data;
      const payload = {
        property_id: propertyId,
        display_name: nullify(values.display_name),
        logo_url: nullify(values.logo_url),
        logo_dark_url: nullify(values.logo_dark_url),
        primary_color: nullify(values.primary_color),
        secondary_color: nullify(values.secondary_color),
        support_email: nullify(values.support_email),
        support_phone: nullify(values.support_phone),
      };
      // RLS on property_branding restricts writes to super_admin/hotel_owner/
      // general_manager scoped to this exact property.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- awaits generated Database types, see the read query above.
      const { error } = await (supabase as any)
        .from("property_branding")
        .upsert(payload, { onConflict: "property_id" });
      if (error) throw error;
      const nextValues = [payload.logo_url, payload.logo_dark_url];
      if (previous?.logo_url !== payload.logo_url)
        await tryCleanupReplacedAsset(previous?.logo_url, nextValues);
      if (previous?.logo_dark_url !== payload.logo_dark_url)
        await tryCleanupReplacedAsset(previous?.logo_dark_url, nextValues);
    },
    onSuccess: () => {
      toast.success("Property brand overrides saved");
      qc.invalidateQueries({ queryKey: ["property-branding", propertyId] });
      qc.invalidateQueries({ queryKey: ["effective-branding", propertyId] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Failed to save property branding"),
  });

  async function upload(kind: "logo" | "logo_dark", file: File) {
    setUploading(kind);
    try {
      const url = await uploadBrandAsset(kind, file);
      const key: keyof PropertyBrandingFormState = kind === "logo" ? "logo_url" : "logo_dark_url";
      setForm((f) => ({ ...f, [key]: url }));
      toast.success(
        `${kind === "logo" ? "Light logo" : "Dark logo"} uploaded — click Save to apply`,
      );
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(null);
    }
  }

  const selectedProperty = properties.data?.find((p) => p.id === propertyId);
  const inheritedName = org.data?.app_short_name || org.data?.app_name || "";
  const effectivePrimary = form.primary_color || org.data?.primary_color || "var(--primary)";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Property branding
        </h2>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        Optional overrides for one property. Any field left blank inherits the organisation-wide
        value above.
      </p>

      <Field label="Property">
        <Select value={propertyId ?? undefined} onValueChange={setPropertyId}>
          <SelectTrigger className="w-full sm:w-80">
            <SelectValue placeholder="Select a property" />
          </SelectTrigger>
          <SelectContent>
            {(properties.data ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} ({p.code})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {!propertyId ? null : canEdit.loading ? (
        <div className="p-6 text-muted-foreground">Checking access…</div>
      ) : !canEdit.allowed ? (
        <Alert>
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Restricted</AlertTitle>
          <AlertDescription>
            Only a Super Admin, Hotel Owner, or General Manager for{" "}
            {selectedProperty?.name ?? "this property"} can change its branding overrides.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Palette className="h-4 w-4 text-primary" /> Identity override
                </CardTitle>
                <CardDescription>
                  Shown in the sidebar and on this property's documents once a property is active.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <Field label="Display name" hint={`Inherited: ${inheritedName || "—"}`}>
                  <Input
                    value={form.display_name ?? ""}
                    onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                    placeholder={inheritedName || "Inherited from organisation"}
                  />
                </Field>
                <Field label="Support email" hint={`Inherited: ${org.data?.support_email || "—"}`}>
                  <Input
                    type="email"
                    value={form.support_email ?? ""}
                    onChange={(e) => setForm({ ...form, support_email: e.target.value })}
                    placeholder={org.data?.support_email || "Inherited from organisation"}
                  />
                </Field>
                <Field label="Support phone" hint={`Inherited: ${org.data?.support_phone || "—"}`}>
                  <Input
                    value={form.support_phone ?? ""}
                    onChange={(e) => setForm({ ...form, support_phone: e.target.value })}
                    placeholder={org.data?.support_phone || "Inherited from organisation"}
                  />
                </Field>
                <Field
                  label="Primary color"
                  hint={`Inherited: ${org.data?.primary_color || "—"} · must be #rrggbb`}
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={form.primary_color ?? ""}
                      onChange={(e) => setForm({ ...form, primary_color: e.target.value })}
                      placeholder="#10b981"
                    />
                    <span
                      className="h-9 w-9 rounded-md border"
                      style={{ backgroundColor: effectivePrimary }}
                      aria-label="Effective primary color preview"
                    />
                  </div>
                </Field>
                <Field
                  label="Secondary color"
                  hint={`Inherited: ${org.data?.secondary_color || "—"} · must be #rrggbb`}
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={form.secondary_color ?? ""}
                      onChange={(e) => setForm({ ...form, secondary_color: e.target.value })}
                      placeholder="#0087b5"
                    />
                    <span
                      className="h-9 w-9 rounded-md border"
                      style={{
                        backgroundColor:
                          form.secondary_color || org.data?.secondary_color || "var(--secondary)",
                      }}
                      aria-label="Effective secondary color preview"
                    />
                  </div>
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ImagePlus className="h-4 w-4 text-primary" /> Logo override
                </CardTitle>
                <CardDescription>
                  Overrides the organisation logo in the sidebar and on this property's
                  invoices/receipts/statements when active. Favicon and browser title are always
                  organisation-wide (not property-overridable).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <AssetSlot
                  label="Logo (light theme)"
                  hint="Falls back to the organisation logo when unset."
                  url={form.logo_url}
                  uploading={uploading === "logo"}
                  onFile={(f) => upload("logo", f)}
                  onClear={() => setForm({ ...form, logo_url: "" })}
                />
                <AssetSlot
                  label="Logo (dark theme, optional)"
                  hint="Falls back to the organisation dark logo, then the light logo above."
                  url={form.logo_dark_url}
                  uploading={uploading === "logo_dark"}
                  onFile={(f) => upload("logo_dark", f)}
                  onClear={() => setForm({ ...form, logo_dark_url: "" })}
                  dark
                />
              </CardContent>
            </Card>

            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => existing.refetch()}
                disabled={save.isPending}
              >
                Reset
              </Button>
              <Button onClick={() => save.mutate(form)} disabled={save.isPending}>
                {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save property overrides
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Effective preview</CardTitle>
                <CardDescription>
                  What this property will show, combining its overrides with organisation defaults.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <SidebarHeaderPreview
                  name={form.display_name || inheritedName || "ThesKwoff Hotel"}
                  logo={form.logo_url || org.data?.logo_url}
                />
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function nullify(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length === 0 ? null : s;
}

function labelFor(kind: "logo" | "logo_dark" | "favicon") {
  return kind === "logo" ? "Light logo" : kind === "logo_dark" ? "Dark logo" : "Favicon";
}

function Field({
  label,
  children,
  required,
  className,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
  className?: string;
  /** Small helper line under the label — used by the property editor to show what the field inherits when left blank. */
  hint?: string;
}) {
  return (
    <div className={className}>
      <Label className="mb-1.5 block text-xs">
        {label} {required ? <span className="text-destructive">*</span> : null}
      </Label>
      {children}
      {hint ? <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function AssetSlot({
  label,
  hint,
  url,
  uploading,
  onFile,
  onClear,
  dark,
}: {
  label: string;
  hint: string;
  url: string | null | undefined;
  uploading: boolean;
  onFile: (f: File) => void;
  onClear: () => void;
  dark?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapCls = useMemo(
    () =>
      `flex items-center justify-center rounded-md border ${dark ? "bg-slate-900" : "bg-muted/40"} min-h-24 p-3`,
    [dark],
  );
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <p className="text-xs text-muted-foreground">{hint}</p>
        {url ? (
          <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{url}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <div className={wrapCls} style={{ width: 96, height: 64 }}>
          {url ? (
            <img
              src={url}
              alt={`${label} preview`}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="text-[10px] text-muted-foreground">No image</span>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT.join(",")}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
        <div className="flex flex-col gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1.5 h-3.5 w-3.5" />
            )}
            Upload
          </Button>
          {url ? (
            <Button size="sm" variant="ghost" onClick={onClear}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Clear
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function BrowserTabPreview({
  title,
  favicon,
}: {
  title: string;
  favicon: string | null | undefined;
}) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">Browser tab</Label>
      <div className="mt-2 flex max-w-[280px] items-center gap-2 rounded-t-md border border-b-0 bg-background px-3 py-2 text-xs">
        {favicon ? (
          <img src={favicon} alt="favicon" className="h-4 w-4 rounded-sm object-contain" />
        ) : (
          <div className="h-4 w-4 rounded-sm bg-muted" />
        )}
        <span className="truncate">{title}</span>
      </div>
    </div>
  );
}

function SidebarHeaderPreview({ name, logo }: { name: string; logo: string | null | undefined }) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">Sidebar header</Label>
      <div className="mt-2 flex items-center gap-2 rounded-md border bg-[var(--sidebar)] p-3 text-[var(--sidebar-foreground)]">
        {logo ? (
          <img src={logo} alt="logo" className="h-7 w-auto object-contain" />
        ) : (
          <div className="h-7 w-7 rounded-md bg-[var(--sidebar-primary)]/20" />
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{name}</div>
          <div className="text-[10px] uppercase tracking-widest opacity-70">PMS</div>
        </div>
      </div>
    </div>
  );
}
