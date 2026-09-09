import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pickRoomTypeCoverPaths } from "../src/lib/gallery/domain";

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");

const roomsPage = read("src/routes/_authenticated/rooms.index.tsx");
const preview = read("src/components/gallery/room-type-gallery-preview.tsx");
const galleryMigration = read("supabase/migrations/20260824090000_hotel_gallery_photo_vault.sql");
const shell = read("src/routes/_authenticated/route.tsx");

const BASIC = "11111111-1111-1111-1111-111111111111";
const EXEC = "22222222-2222-2222-2222-222222222222";
const DELUXE = "33333333-3333-3333-3333-333333333333";
const NO_PHOTO = "44444444-4444-4444-4444-444444444444";

/* --------------------------------------------- which photo represents a type */

describe("room type primary photo selection", () => {
  it("uses the room type's flagged cover photo", () => {
    // Rows arrive already ordered is_cover DESC, sort_order ASC.
    const map = pickRoomTypeCoverPaths([
      { room_type_id: BASIC, thumbnail_path: "p/basic-cover.jpg" },
      { room_type_id: BASIC, thumbnail_path: "p/basic-2.jpg" },
    ]);
    expect(map.get(BASIC)).toBe("p/basic-cover.jpg");
    expect(map.size).toBe(1);
  });

  it("falls back to the first photo in curator order when nothing is flagged", () => {
    const map = pickRoomTypeCoverPaths([
      { room_type_id: EXEC, thumbnail_path: "p/exec-first.jpg" },
    ]);
    expect(map.get(EXEC)).toBe("p/exec-first.jpg");
  });

  it("resolves one entry per room type, so rooms sharing a type share a photo", () => {
    // 32 rooms, 3 room types -> 3 entries, not 32.
    const map = pickRoomTypeCoverPaths([
      { room_type_id: BASIC, thumbnail_path: "p/basic.jpg" },
      { room_type_id: EXEC, thumbnail_path: "p/exec.jpg" },
      { room_type_id: DELUXE, thumbnail_path: "p/deluxe.jpg" },
    ]);
    const rooms = [BASIC, BASIC, BASIC, EXEC, DELUXE, BASIC, EXEC];
    const resolved = rooms.map((id) => map.get(id));
    expect(map.size).toBe(3);
    expect(resolved.filter((p) => p === "p/basic.jpg")).toHaveLength(4);
    expect(new Set(resolved).size).toBe(3);
  });

  it("gives different room types different photos", () => {
    const map = pickRoomTypeCoverPaths([
      { room_type_id: BASIC, thumbnail_path: "p/basic.jpg" },
      { room_type_id: EXEC, thumbnail_path: "p/exec.jpg" },
      { room_type_id: DELUXE, thumbnail_path: "p/deluxe.jpg" },
    ]);
    expect(map.get(BASIC)).not.toBe(map.get(EXEC));
    expect(map.get(EXEC)).not.toBe(map.get(DELUXE));
    expect(map.get(BASIC)).not.toBe(map.get(DELUXE));
  });

  it("leaves a room type with no photo out of the map entirely", () => {
    const map = pickRoomTypeCoverPaths([{ room_type_id: BASIC, thumbnail_path: "p/basic.jpg" }]);
    expect(map.has(NO_PHOTO)).toBe(false);
    // undefined is what the row component receives, which renders the placeholder.
    expect(map.get(NO_PHOTO)).toBeUndefined();
  });

  it("never invents an entry for a room type it was not given rows for", () => {
    const map = pickRoomTypeCoverPaths([]);
    expect(map.size).toBe(0);
    for (const id of [BASIC, EXEC, DELUXE, NO_PHOTO]) expect(map.get(id)).toBeUndefined();
  });
});

/* --------------------------------------------------------- property isolation */

describe("property isolation", () => {
  it("only ever asks for the room types the rooms query already returned", () => {
    // rooms is filtered by property_id, so the id list is property-scoped
    // before it ever reaches the gallery query.
    expect(roomsPage).toContain('.eq("property_id", propertyId!)');
    expect(roomsPage).toContain(
      "const rows = (rooms.data ?? []) as { room_type_id: string | null }[]",
    );
    expect(roomsPage).toContain(
      "[...new Set(rows.map((r) => r.room_type_id).filter((id): id is string => !!id))]",
    );
    expect(roomsPage).toContain("useRoomTypeCoverImages(roomTypeIds)");
  });

  it("scopes the gallery lookup to room-type photos of those ids only", () => {
    expect(preview).toContain('.in("room_type_id", roomTypeIds)');
    expect(preview).toContain('.eq("context", "room_type")');
  });

  it("keeps the database-side property scoping it depends on", () => {
    // gallery_images carries its own property_id and an RLS read policy gated
    // on can_access_property, so a cross-property row cannot even be selected.
    expect(galleryMigration).toContain(
      "property_id UUID NOT NULL REFERENCES public.properties(id)",
    );
    expect(galleryMigration).toContain(
      "CREATE POLICY gallery_images_staff_read ON public.gallery_images",
    );
    expect(galleryMigration).toContain(
      "USING (public.can_access_property(auth.uid(), property_id))",
    );
  });

  it("does not widen the rooms query or drop its property filter", () => {
    expect(roomsPage).toContain(
      '.from("rooms").select("*, room_types(name)").eq("property_id", propertyId!).order("number")',
    );
  });
});

/* ------------------------------------------------------------- N+1 prevention */

describe("no N+1 per room row", () => {
  it("resolves covers once for the whole table, not once per row", () => {
    // The batched hook runs one metadata query and one bulk sign call.
    expect(roomsPage).toContain("useRoomTypeCoverImages");
    expect(roomsPage).toContain("useMemo(");
    // The per-room-type component would fire a query per row — it must not be
    // the thing rendered inside the table body.
    expect(roomsPage).not.toContain("RoomTypeCoverThumbnail");
    expect(roomsPage).not.toContain("RoomTypeGalleryStrip");
    expect(roomsPage).not.toContain("useRoomTypeGalleryImages");
  });

  it("hands the row component an already-resolved url rather than an id", () => {
    expect(roomsPage).toContain("url={covers.data?.get(r.room_type_id)}");
    expect(preview).toContain("export function RoomTypeRowThumbnail({");
    expect(preview).toMatch(/RoomTypeRowThumbnail\(\{\s*url,/);
  });

  it("signs every path in one request", () => {
    expect(preview).toContain("gallerySignedUrls([...coverByRoomType.values()])");
    expect(preview).not.toMatch(/rows\.map\([^)]*gallerySignedUrl\(/);
  });

  it("requests the stored thumbnail, never the full-resolution image", () => {
    const batched = preview.slice(preview.indexOf("useRoomTypeCoverImages"));
    const queryBlock = batched.slice(0, batched.indexOf("export function RoomTypeRowThumbnail"));
    expect(queryBlock).toContain("thumbnail_path");
    expect(queryBlock).not.toMatch(/select\([^)]*storage_path/);
  });

  it("keeps the cache alive no longer than the signed URL it holds", () => {
    expect(preview).toContain("staleTime: (GALLERY_SIGNED_URL_TTL_SECONDS / 2) * 1000");
  });

  it("adds no second photo storage system", () => {
    expect(roomsPage).not.toMatch(/createSignedUrl|from\("gallery_images"\)|storage\s*\.from/);
    expect(roomsPage).not.toMatch(/\.storage\b/);
  });
});

/* ------------------------------------------------------------------ fallback */

describe("missing or broken photo fallback", () => {
  it("renders a neutral placeholder at the same dimensions, not a broken image", () => {
    expect(preview).toContain('const box = className ?? "h-9 w-9"');
    expect(preview).toMatch(/url && !failed \?/);
    expect(preview).toContain('<ImageOff className="h-4 w-4" />');
  });

  it("degrades to the placeholder when the image itself fails to load", () => {
    // Covers an expired signed URL, a deleted object, or any 4xx/5xx.
    expect(preview).toContain("const [failed, setFailed] = useState(false)");
    expect(preview).toContain("onError={() => setFailed(true)}");
  });

  it("never emits an img with an undefined, null or empty src", () => {
    // The <img> is only reachable through the `url && !failed` guard, so a
    // falsy url can never reach the src attribute.
    const start = preview.indexOf("export function RoomTypeRowThumbnail");
    const body = preview.slice(start, preview.indexOf("export function RoomTypeCoverThumbnail"));
    expect(body).toMatch(/\{url && !failed \? \([\s\S]*<img/);
    expect(body).not.toMatch(/src=\{url \?\? ""\}|src=\{String\(url\)\}/);
  });

  it("does not reintroduce a coloured status dot as the fallback", () => {
    const start = preview.indexOf("export function RoomTypeRowThumbnail");
    const body = preview.slice(start, preview.indexOf("export function RoomTypeCoverThumbnail"));
    expect(body).not.toMatch(/rounded-full|bg-(red|green|amber|yellow|emerald|blue)-/);
    expect(roomsPage).not.toMatch(/rounded-full/);
  });

  it("keeps the placeholder out of the accessibility tree and labels real photos", () => {
    expect(preview).toContain('aria-hidden="true"');
    expect(roomsPage).toContain("room type photo`");
  });
});

/* -------------------------------------------------------------- presentation */

describe("thumbnail presentation", () => {
  it("is a compact fixed square with rounded corners and no distortion", () => {
    expect(preview).toContain('className ?? "h-9 w-9"'); // 36px
    expect(preview).toContain("shrink-0 overflow-hidden rounded-md border bg-muted");
    expect(preview).toContain('className="h-full w-full object-cover"');
  });

  it("sits between the room number and the room type name", () => {
    const body = roomsPage.slice(roomsPage.indexOf("<TableBody>"));
    const numberAt = body.indexOf("{r.number}");
    const thumbAt = body.indexOf("RoomTypeRowThumbnail");
    const typeAt = body.indexOf("{r.room_types?.name}");
    expect(numberAt).toBeGreaterThan(-1);
    expect(thumbAt).toBeGreaterThan(numberAt);
    expect(typeAt).toBeGreaterThan(thumbAt);
  });

  it("keeps the room type name readable beside the image", () => {
    expect(roomsPage).toContain(
      '<TableCell className="whitespace-nowrap">{r.room_types?.name}</TableCell>',
    );
  });

  it("adds a matching header cell so the header and body rows stay aligned", () => {
    expect(roomsPage).toContain(
      '<TableHead className="w-[52px]"><span className="sr-only">Room type photo</span></TableHead>',
    );
    const headerRow = roomsPage.slice(
      roomsPage.indexOf("<TableHeader>"),
      roomsPage.indexOf("</TableHeader>"),
    );
    const bodyRow = roomsPage.slice(
      roomsPage.indexOf("<TableRow key={r.id}>"),
      roomsPage.indexOf("</TableRow>", roomsPage.indexOf("<TableRow key={r.id}>")),
    );
    // [ >] so <TableHeader> itself is not counted as a column.
    expect((headerRow.match(/<TableHead[ >]/g) ?? []).length).toBe(6);
    expect((bodyRow.match(/<TableCell/g) ?? []).length).toBe(6);
  });

  it("lazy-loads so a long room list does not fetch every image up front", () => {
    expect(preview).toContain('loading="lazy"');
    expect(preview).toContain('decoding="async"');
  });
});

/* ------------------------------------------------------ mobile / no overflow */

describe("mobile containment", () => {
  it("keeps the table's own horizontal scroller rather than widening the page", () => {
    // shadcn Table wraps itself in `relative w-full overflow-auto`, so the
    // extra column scrolls inside the table. Measured on the built page at
    // 375/390/768/1024/1440: documentElement.scrollWidth === clientWidth.
    const table = read("src/components/ui/table.tsx");
    expect(table).toContain('<div className="relative w-full overflow-auto">');
  });

  it("does not clamp the page with an overflow-hidden workaround", () => {
    expect(roomsPage).not.toMatch(/overflow-hidden|overflow-x-hidden/);
  });

  it("keeps the shell clamps that stop a wide table scrolling the document", () => {
    // PR #88 (shell column) and PR #91 (top bar) are what make an internally
    // scrolling table safe; this column must not rely on anything else.
    expect(shell).toContain("flex min-w-0 flex-1 flex-col");
    const topbar = read("src/components/top-bar.tsx");
    expect(topbar).toContain('className="flex min-w-0 flex-1 items-center justify-between gap-3"');
  });

  it("keeps the thumbnail from stretching the row height", () => {
    expect(roomsPage).toContain('className="w-[52px] py-1.5"');
    expect(preview).toContain("shrink-0");
  });

  it("hides no column at a breakpoint to buy room", () => {
    expect(roomsPage).not.toMatch(/\bhidden\s+(sm|md|lg|xl):(table-cell|flex|block)/);
    expect(roomsPage).not.toMatch(/\b(sm|md|lg|xl):hidden/);
  });
});

/* ------------------------------------------------- room operations untouched */

describe("room operations are unchanged", () => {
  it("keeps the Status control and every one of its options", () => {
    expect(roomsPage).toContain(
      "<Select value={r.status} onValueChange={(v) => update(r.id, { status: v })}>",
    );
    for (const v of ["available", "occupied", "blocked", "out_of_order"]) {
      expect(roomsPage).toContain(`<SelectItem value="${v}">`);
    }
    expect(roomsPage).toContain(
      '<SelectTrigger className="h-8 w-[140px]"><SelectValue /></SelectTrigger>',
    );
  });

  it("keeps the Housekeeping control and every one of its options", () => {
    expect(roomsPage).toContain(
      "<Select value={r.housekeeping_status} onValueChange={(v) => update(r.id, { housekeeping_status: v })}>",
    );
    for (const v of ["clean", "inspected", "dirty", "maintenance"]) {
      expect(roomsPage).toContain(`<SelectItem value="${v}">`);
    }
  });

  it("keeps the update path and its cache invalidation exactly as they were", () => {
    expect(roomsPage).toContain(
      'const { error } = await supabase.from("rooms").update(patch).eq("id", id);',
    );
    expect(roomsPage).toContain('qc.invalidateQueries({ queryKey: ["rooms", propertyId] });');
  });

  it("changes no room number, floor, assignment or room-type data", () => {
    expect(roomsPage).toContain('<TableCell className="font-medium">{r.number}</TableCell>');
    expect(roomsPage).toContain('<TableCell>{r.floor ?? "—"}</TableCell>');
    // The only write on this page is still the status/housekeeping patch.
    expect((roomsPage.match(/supabase\.from\("rooms"\)\.update/g) ?? []).length).toBe(1);
    expect((roomsPage.match(/\.delete\(\)/g) ?? []).length).toBe(0);
  });

  it("adds no migration, RPC or availability logic", () => {
    expect(roomsPage).not.toMatch(/\.rpc\(|availability|reservation|invoice|journal/i);
  });
});
