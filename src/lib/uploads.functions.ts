import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { validateInventoryImportBatch } from "@/lib/inventory/import-validation";

const ADMIN_ROLES = ["super_admin", "hotel_owner", "general_manager"] as const;

async function assertAdmin(context: any, propertyId: string) {
  const { data: ok, error } = await context.supabase.rpc("has_any_role", {
    _user_id: context.userId,
    _roles: ADMIN_ROLES as never,
    _property_id: propertyId,
  });
  if (error) throw new Error(error.message);
  if (!ok) throw new Error("Admins only");
}

export type UploadTargetKind = "menu" | "product" | "inventory" | "service" | "price_list";

export const createUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    propertyId: string; targetKind: UploadTargetKind;
    filename: string; storagePath?: string;
    rows: Record<string, unknown>[];
    duplicateMode?: "skip" | "reject";
  }) => {
    if (!d.propertyId) throw new Error("propertyId required");
    if (!Array.isArray(d.rows) || d.rows.length === 0) throw new Error("rows required");
    if (d.rows.length > 5000) throw new Error("Max 5000 rows per upload");
    return d;
  })
  .handler(async ({ data, context }) => {
    await assertAdmin(context, data.propertyId);
    const { supabase } = context;

    // Duplicate detection summary. Inventory rows are keyed on SKU alone
    // (the field the DB itself enforces uniqueness on), not the generic
    // code/name/sku fallback used for the other targets, so two inventory
    // rows sharing a name but with distinct SKUs are never misflagged.
    const seen = new Map<string, number>();
    const duplicates: number[] = [];
    data.rows.forEach((r, i) => {
      const k = data.targetKind === "inventory"
        ? String(r.sku ?? "").trim().toLowerCase()
        : String(r.code ?? r.name ?? r.sku ?? "").trim().toLowerCase();
      if (!k) return;
      if (seen.has(k)) duplicates.push(i); else seen.set(k, i);
    });

    const { data: upload, error: upErr } = await (supabase.from("data_uploads") as any).insert({
      property_id: data.propertyId,
      uploaded_by: context.userId,
      target_kind: data.targetKind,
      filename: data.filename,
      storage_path: data.storagePath ?? null,
      row_count: data.rows.length,
      status: "pending",
      summary: { duplicates: duplicates.length, distinctKeys: seen.size, duplicateMode: data.duplicateMode ?? "skip" },
      errors: duplicates.length ? [{ code: "duplicate_rows", rows: duplicates }] : [],
    }).select("id").single();
    if (upErr) throw new Error(upErr.message);

    const rows = data.rows.map((payload, i) => ({
      upload_id: upload.id, row_index: i, payload, status: duplicates.includes(i) ? "duplicate" : "pending",
    }));
    // Chunk insert
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await (supabase.from("data_upload_rows") as any).insert(chunk);
      if (error) throw new Error(error.message);
    }

    await context.supabase.rpc("audit_capture", {
      _property_id: data.propertyId, _entity_type: "data_upload", _entity_id: upload.id,
      _action: "import", _before: null as never, _after: { rows: data.rows.length } as never,
      _memo: `Uploaded ${data.filename}`,
      _ip: null, _user_agent: null, _os: null, _browser: null,
      _fingerprint: null, _session_id: null, _success: true, _remarks: null,
    } as never);

    return { uploadId: upload.id, duplicates: duplicates.length };
  });

export const approveUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { uploadId: string; propertyId: string }) => {
    if (!d.uploadId || !d.propertyId) throw new Error("uploadId, propertyId required");
    return d;
  })
  .handler(async ({ data, context }) => {
    await assertAdmin(context, data.propertyId);
    const { supabase } = context;
    // Atomic claim, not a plain select-then-check: two concurrent Approve
    // calls for the same upload both racing past a "status === 'pending'"
    // read would otherwise both proceed to import. The UPDATE's row-level
    // lock lets only one of them flip pending -> processing; the loser
    // gets zero rows back and is rejected before touching anything.
    const { data: claimed, error: claimErr } = await (supabase.from("data_uploads") as any)
      .update({ status: "processing" })
      .eq("id", data.uploadId).eq("status", "pending")
      .select("*").maybeSingle();
    if (claimErr) throw new Error(claimErr.message);
    if (!claimed) throw new Error("Upload is not pending (already processed, or being processed by another request)");
    const up = claimed;

    const { data: rows } = await (supabase.from("data_upload_rows") as any)
      .select("id,row_index,payload,status").eq("upload_id", data.uploadId).order("row_index");

    let imported = 0;
    const errors: any[] = [];

    if (up.target_kind === "menu") {
      // Pick first outlet for the property (or expect payload.outlet)
      const { data: outlets } = await (supabase.from("pos_outlets") as any)
        .select("id,name").eq("property_id", data.propertyId);
      const outletByName = new Map<string, string>();
      (outlets ?? []).forEach((o: any) => outletByName.set(String(o.name).toLowerCase(), o.id));
      const defaultOutlet: string | null = outlets?.[0]?.id ?? null;

      const catCache = new Map<string, string>();
      async function ensureCategory(outletId: string, name: string): Promise<string | null> {
        const key = `${outletId}::${name.toLowerCase()}`;
        if (catCache.has(key)) return catCache.get(key)!;
        const { data: existing } = await (supabase.from("pos_menu_categories") as any)
          .select("id").eq("outlet_id", outletId).ilike("name", name).maybeSingle();
        if (existing) { catCache.set(key, existing.id); return existing.id; }
        const { data: created, error } = await (supabase.from("pos_menu_categories") as any)
          .insert({ property_id: data.propertyId, outlet_id: outletId, name }).select("id").single();
        if (error) return null;
        catCache.set(key, created.id); return created.id;
      }

      for (const r of rows ?? []) {
        const p = r.payload as any;
        if (r.status === "duplicate") continue;
        const outletId = outletByName.get(String(p.outlet ?? "").toLowerCase()) ?? defaultOutlet;
        if (!outletId) { errors.push({ row: r.row_index, error: "No POS outlet exists" }); continue; }
        const catName = String(p.category ?? "").trim();
        const catId = catName ? await ensureCategory(outletId, catName) : null;
        const { error } = await (supabase.from("pos_menu_items") as any).insert({
          property_id: data.propertyId,
          outlet_id: outletId,
          category_id: catId,
          name: String(p.name ?? "").trim(),
          price: Number(p.price ?? 0),
          description: p.description ? String(p.description) : null,
        });
        if (error) errors.push({ row: r.row_index, error: error.message });
        else imported++;
      }
    } else if (up.target_kind === "product") {
      for (const r of rows ?? []) {
        const p = r.payload as any;
        if (r.status === "duplicate") continue;
        const { error } = await (supabase.from("inventory_items") as any).insert({
          property_id: data.propertyId,
          name: String(p.name ?? "").trim(),
          sku: String(p.sku ?? p.name ?? "").trim(),
          unit: p.unit ? String(p.unit) : "each",
          cost: p.cost ? Number(p.cost) : 0,
          sale_price: p.price ? Number(p.price) : 0,
        });
        if (error) errors.push({ row: r.row_index, error: error.message });
        else imported++;
      }
    } else if (up.target_kind === "inventory") {
      // Hardened inventory import: item creation, opening item_stock, and
      // an opening inventory_stock_batches record all happen atomically per
      // row inside import_inventory_item() -- never several unrelated
      // client/server-driven inserts. Re-validates every row against a
      // FRESH read of existing SKUs/locations (never trusts the client's
      // earlier Preview-time validation), using the exact same
      // validateInventoryImportBatch() the Preview UI already ran.
      const duplicateMode = up.summary?.duplicateMode === "reject" ? "reject" : "skip";

      const [{ data: existingItems }, { data: existingLocations }] = await Promise.all([
        (supabase.from("inventory_items") as any).select("sku").eq("property_id", data.propertyId),
        (supabase.from("stock_locations") as any).select("name").eq("property_id", data.propertyId),
      ]);
      const ctx = {
        existingSkusLower: new Set<string>((existingItems ?? []).map((i: any) => String(i.sku).toLowerCase())),
        validLocationNamesLower: new Set<string>((existingLocations ?? []).map((l: any) => String(l.name).toLowerCase())),
      };

      const eligibleRows = (rows ?? []).filter((r: any) => r.status !== "duplicate");
      const batch = validateInventoryImportBatch(eligibleRows.map((r: any) => r.payload as Record<string, unknown>), ctx);

      if (duplicateMode === "reject" && batch.totals.duplicateInProperty > 0) {
        const dupSkus = batch.rows
          .filter((row) => row.isDuplicateInProperty && !row.isDuplicateInFile)
          .map((row) => row.parsed?.sku ?? "?");
        const message = `Import rejected: duplicate SKU(s) already exist in this property: ${dupSkus.join(", ")}`;
        await (supabase.from("data_uploads") as any).update({
          status: "rejected", approved_by: context.userId, approved_at: new Date().toISOString(),
          summary: { ...up.summary, imported: 0, errors: 0, rejectedReason: message },
        }).eq("id", data.uploadId);
        throw new Error(message);
      }

      for (let i = 0; i < eligibleRows.length; i++) {
        const r = eligibleRows[i];
        const v = batch.rows[i];
        if (v.isBlank || v.isExample) {
          await (supabase.from("data_upload_rows") as any)
            .update({ status: v.isExample ? "example_skipped" : "blank_skipped" }).eq("id", r.id);
          continue;
        }
        if (v.errors.length > 0 || !v.parsed) {
          const msg = v.errors.join("; ") || "Invalid row";
          errors.push({ row: r.row_index, error: msg });
          await (supabase.from("data_upload_rows") as any).update({ status: "error", error: msg }).eq("id", r.id);
          continue;
        }
        if (v.isDuplicateInFile || v.isDuplicateInProperty) {
          await (supabase.from("data_upload_rows") as any).update({ status: "skipped_duplicate" }).eq("id", r.id);
          continue;
        }
        const { data: rpcResult, error } = await (context.supabase.rpc as any)("import_inventory_item", {
          _property_id: data.propertyId,
          _name: v.parsed.name,
          _sku: v.parsed.sku,
          _category: v.parsed.category,
          _unit: v.parsed.unit,
          _cost: v.parsed.cost,
          _sale_price: v.parsed.salePrice,
          _reorder_level: v.parsed.reorderLevel,
          _location_name: v.parsed.location,
          _opening_quantity: v.parsed.openingQuantity,
          _expiry_date: v.parsed.expiryDate,
        });
        if (error) {
          errors.push({ row: r.row_index, error: error.message });
          await (supabase.from("data_upload_rows") as any).update({ status: "error", error: error.message }).eq("id", r.id);
        } else if ((rpcResult as any)?.skipped) {
          await (supabase.from("data_upload_rows") as any).update({ status: "skipped_duplicate" }).eq("id", r.id);
        } else {
          imported++;
          await (supabase.from("data_upload_rows") as any).update({ status: "imported" }).eq("id", r.id);
        }
      }
    } else {
      // service / price_list — record as approved-only (implementers wire specific tables later).
    }

    await (supabase.from("data_uploads") as any).update({
      status: errors.length && !imported ? "rejected" : "imported",
      approved_by: context.userId,
      approved_at: new Date().toISOString(),
      summary: { ...up.summary, imported, errors: errors.length },
      errors: [...(up.errors ?? []), ...errors],
    }).eq("id", data.uploadId);

    await context.supabase.rpc("audit_capture", {
      _property_id: data.propertyId, _entity_type: "data_upload", _entity_id: data.uploadId,
      _action: "approve", _before: null as never, _after: { imported, errors: errors.length } as never,
      _memo: `Approved ${up.filename}`,
      _ip: null, _user_agent: null, _os: null, _browser: null,
      _fingerprint: null, _session_id: null, _success: errors.length === 0, _remarks: null,
    } as never);

    return { imported, errors: errors.length };
  });

export const rejectUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { uploadId: string; propertyId: string; reason?: string }) => d)
  .handler(async ({ data, context }) => {
    await assertAdmin(context, data.propertyId);
    const { error } = await (context.supabase.from("data_uploads") as any).update({
      status: "rejected", approved_by: context.userId, approved_at: new Date().toISOString(),
      summary: { rejectedReason: data.reason ?? "" },
    }).eq("id", data.uploadId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { uploadId: string; propertyId: string }) => d)
  .handler(async ({ data, context }) => {
    await assertAdmin(context, data.propertyId);
    const { error } = await (context.supabase.from("data_uploads") as any).delete().eq("id", data.uploadId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
