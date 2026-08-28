import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Pencil, Images, ImageOff, Users } from "lucide-react";
import { toast } from "sonner";
import { useRoomTypeCoverImages } from "@/components/gallery/room-type-gallery-preview";
import { useRoomTypePhotoCounts } from "@/lib/gallery/use-room-type-photo-counts";
import { formatOccupancy, formatPhotoCount, formatRatePerNight } from "@/lib/room-type-display";

export const Route = createFileRoute("/_authenticated/rooms/types")({
  head: () => ({ meta: [{ title: "Room types" }] }),
  component: TypesPage,
});

function TypesPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ["room-types", propertyId],
    enabled: !!propertyId,
    queryFn: async () =>
      (
        await supabase
          .from("room_types")
          .select("*")
          .eq("property_id", propertyId!)
          .order("base_rate")
      ).data,
  });

  // Rates are shown in the active property's own currency. base_currency is
  // the accounting-canonical column; properties.currency is a separate legacy
  // field and is deliberately not read here.
  const property = useQuery({
    queryKey: ["room-types-property", propertyId],
    enabled: !!propertyId,
    queryFn: async () =>
      (
        await supabase
          .from("properties")
          .select("base_currency")
          .eq("id", propertyId!)
          .maybeSingle()
      ).data,
  });
  const currency = property.data?.base_currency;

  const rows = useMemo(() => list.data ?? [], [list.data]);
  const roomTypeIds = useMemo(() => rows.map((t: { id: string }) => t.id), [rows]);
  // Two batched reads for the whole grid, regardless of how many cards there
  // are. Previously each card mounted its own cover hook: one metadata query
  // plus one signing round-trip per room type.
  const covers = useRoomTypeCoverImages(roomTypeIds);
  const photoCounts = useRoomTypePhotoCounts(roomTypeIds);

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Room types</h1>
          <p className="text-sm text-muted-foreground">Categories, occupancy and base rates.</p>
        </div>
        <TypeDialog
          propertyId={propertyId}
          onDone={() => qc.invalidateQueries({ queryKey: ["room-types", propertyId] })}
        />
      </div>

      {list.isLoading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading room types…</p>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No room types yet for this property.
        </p>
      ) : (
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((t: Record<string, unknown>) => (
            <RoomTypeCard
              key={t.id as string}
              type={t}
              currency={currency}
              coverUrl={covers.data?.get(t.id as string) ?? null}
              photoCount={photoCounts.data?.get(t.id as string) ?? 0}
              photoCountReady={!photoCounts.isLoading}
              propertyId={propertyId}
              onDone={() => qc.invalidateQueries({ queryKey: ["room-types", propertyId] })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RoomTypeCard({
  type,
  currency,
  coverUrl,
  photoCount,
  photoCountReady,
  propertyId,
  onDone,
}: {
  type: Record<string, unknown>;
  currency: unknown;
  coverUrl: string | null;
  photoCount: number;
  photoCountReady: boolean;
  propertyId: string | null;
  onDone: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const name = String(type.name ?? "");
  const code = type.code ? String(type.code) : null;
  const showImage = coverUrl && !imageFailed;

  return (
    <Card className="min-w-0 overflow-hidden">
      {/* Fixed aspect ratio so portrait and landscape photos occupy the same
          space and neither distorts. The placeholder fills the identical box,
          so a room type without a photo does not change the card's height. */}
      <div className="relative aspect-[4/3] w-full bg-muted">
        {showImage ? (
          <img
            src={coverUrl}
            alt={name ? `${name} cover photo` : "Room type cover photo"}
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center text-muted-foreground"
            aria-hidden="true"
          >
            <ImageOff className="h-8 w-8" />
          </div>
        )}
      </div>

      <CardContent className="min-w-0 p-4">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            {code && (
              <div className="truncate text-xs uppercase tracking-wider text-muted-foreground">
                {code}
              </div>
            )}
            <h2 className="truncate text-lg font-semibold" title={name}>
              {name}
            </h2>
          </div>
          <TypeDialog
            propertyId={propertyId}
            existing={type}
            trigger={
              <Button size="icon" variant="ghost" aria-label={`Edit ${name || "room type"}`}>
                <Pencil className="h-4 w-4" />
              </Button>
            }
            onDone={onDone}
          />
        </div>

        <div className="mt-3 min-w-0 space-y-1">
          <div className="truncate font-semibold">
            {formatRatePerNight(type.base_rate, currency)}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Users className="h-3.5 w-3.5 shrink-0" />
              {formatOccupancy(type.base_occupancy, type.max_occupancy)}
            </span>
            {photoCountReady && (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatPhotoCount(photoCount)}</span>
              </>
            )}
          </div>
        </div>

        <Button asChild size="sm" variant="outline" className="mt-4 w-full">
          <Link to="/gallery" search={{ context: "room_type", roomTypeId: type.id } as never}>
            <Images className="mr-1 h-3.5 w-3.5" /> Manage photos
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function TypeDialog({
  propertyId,
  existing,
  trigger,
  onDone,
}: {
  propertyId: string | null;
  existing?: Record<string, unknown>;
  trigger?: React.ReactNode;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    code: (existing?.code as string) ?? "",
    name: (existing?.name as string) ?? "",
    description: (existing?.description as string) ?? "",
    base_occupancy: (existing?.base_occupancy as number) ?? 2,
    max_occupancy: (existing?.max_occupancy as number) ?? 2,
    base_rate: (existing?.base_rate as number) ?? 100,
  });
  async function save() {
    if (!propertyId) return;
    const payload = { ...form, property_id: propertyId };
    const q = existing
      ? supabase
          .from("room_types")
          .update(payload)
          .eq("id", existing.id as string)
      : supabase.from("room_types").insert(payload);
    const { error } = await q;
    if (error) return toast.error(error.message);
    toast.success("Saved");
    setOpen(false);
    onDone();
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <Plus className="mr-1 h-4 w-4" /> New type
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? "Edit" : "New"} room type</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Code</Label>
            <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </div>
          <div>
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <Label>Description</Label>
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div>
            <Label>Base occupancy</Label>
            <Input
              type="number"
              value={form.base_occupancy}
              onChange={(e) => setForm({ ...form, base_occupancy: +e.target.value })}
            />
          </div>
          <div>
            <Label>Max occupancy</Label>
            <Input
              type="number"
              value={form.max_occupancy}
              onChange={(e) => setForm({ ...form, max_occupancy: +e.target.value })}
            />
          </div>
          <div className="sm:col-span-2">
            <Label>Base rate</Label>
            <Input
              type="number"
              step="0.01"
              value={form.base_rate}
              onChange={(e) => setForm({ ...form, base_rate: +e.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
