import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePermission, type PermissionGrant, type PropertyRole } from "@/lib/permissions";
import { PRODUCT_IMAGE_PERMISSIONS, PRODUCT_MANAGEMENT_ROLES } from "@/lib/inventory/permissions";

const root = resolve(__dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260812150000_product_image_generation.sql"),
  "utf8",
);
const productImagesFns = readFileSync(
  resolve(root, "src/lib/inventory/product-images.functions.ts"),
  "utf8",
);
const aiServerModule = readFileSync(
  resolve(root, "src/lib/inventory/product-image-ai.server.ts"),
  "utf8",
);
const domain = readFileSync(resolve(root, "src/lib/inventory/domain.ts"), "utf8");
const permissionsModule = readFileSync(resolve(root, "src/lib/inventory/permissions.ts"), "utf8");
const imageField = readFileSync(
  resolve(root, "src/components/inventory/product-image-field.tsx"),
  "utf8",
);
const inventoryModule = readFileSync(
  resolve(root, "src/components/admin/modules/inventory-module.tsx"),
  "utf8",
);
const envExample = readFileSync(resolve(root, ".env.production.example"), "utf8");
const inventoryItemsMigration = readFileSync(
  resolve(root, "supabase/migrations/20260705032118_e058dda0-25db-4d70-8408-f042276a7240.sql"),
  "utf8",
);
const adminActionLogsMigration = readFileSync(
  resolve(root, "supabase/migrations/20260705095718_db7ce255-abe2-4a25-b1f4-59f68a09d151.sql"),
  "utf8",
);

// ============ PERMISSION MODEL ============

const PROPERTY_ID = "00000000-0000-4000-8000-00000000000a";

function roleRow(role: PropertyRole["role"], propertyId: string | null = PROPERTY_ID): PropertyRole[] {
  return [{ role, property_id: propertyId }];
}

const request = {
  propertyId: PROPERTY_ID,
  ...PRODUCT_IMAGE_PERMISSIONS.imagesCreate,
  defaultRoles: PRODUCT_MANAGEMENT_ROLES,
};

describe("AI product image permission model", () => {
  it("1. admin (super_admin) can generate", () => {
    expect(resolvePermission({ roles: roleRow("super_admin", null), request })).toBe(true);
  });

  it("2. super_admin can generate (explicit duplicate of the admin case per the regression checklist)", () => {
    expect(resolvePermission({ roles: roleRow("super_admin", null), request })).toBe(true);
  });

  it("3. a non-admin user with product-management permission (hotel_owner / general_manager) can generate", () => {
    expect(resolvePermission({ roles: roleRow("hotel_owner"), request })).toBe(true);
    expect(resolvePermission({ roles: roleRow("general_manager"), request })).toBe(true);
  });

  it("4. a non-admin user without product-management permission cannot generate", () => {
    expect(resolvePermission({ roles: roleRow("front_desk"), request })).toBe(false);
    expect(resolvePermission({ roles: roleRow("housekeeping"), request })).toBe(false);
  });

  it("6. removing product-management permission (explicit deny grant) removes AI generation access", () => {
    const deny: PermissionGrant = {
      role: "hotel_owner",
      property_id: PROPERTY_ID,
      module: "product_images",
      action: "create",
      allowed: false,
    };
    expect(
      resolvePermission({ roles: roleRow("hotel_owner"), grants: [deny], request }),
    ).toBe(false);
  });

  it("6b. granting product-management permission to an otherwise-unlisted role extends AI generation access, proving this is not a fixed admin-only allowlist", () => {
    const grant: PermissionGrant = {
      role: "front_desk",
      property_id: PROPERTY_ID,
      module: "product_images",
      action: "create",
      allowed: true,
    };
    expect(
      resolvePermission({ roles: roleRow("front_desk"), grants: [grant], request }),
    ).toBe(true);
  });

  it("7. no separate hardcoded AI-admin gate exists in the server function or the UI component", () => {
    for (const source of [productImagesFns, imageField]) {
      expect(source).not.toMatch(/role\s*===\s*["']admin["']/);
      expect(source).not.toMatch(/\[\s*["']admin["']\s*,\s*["']super_admin["']\s*\]/);
    }
  });

  it("the defaultRoles fallback is exactly the inv_items_write role set — provably the same permission that already gates product creation/editing", () => {
    const inventoryWritePolicy = inventoryItemsMigration.match(
      /CREATE POLICY inv_items_write[\s\S]*?;/,
    )?.[0];
    expect(inventoryWritePolicy).toBeDefined();
    expect(inventoryWritePolicy).toContain(
      "ARRAY['super_admin','hotel_owner','general_manager']::app_role[]",
    );
    expect([...PRODUCT_MANAGEMENT_ROLES].sort()).toEqual(
      ["general_manager", "hotel_owner", "super_admin"].sort(),
    );
  });

  it("uses the same permission (product_images.create) for upload, generation, applying, and deleting a temporary image", () => {
    // All four call sites share one assertProductManagePermission() helper,
    // which is itself defined in terms of PRODUCT_IMAGE_PERMISSIONS.imagesCreate —
    // a single source of truth rather than independent checks that could drift.
    expect(productImagesFns).toContain("...PRODUCT_IMAGE_PERMISSIONS.imagesCreate");
    const usages = productImagesFns.match(/await assertProductManagePermission\(context, data\.propertyId\)/g) ?? [];
    expect(usages.length).toBeGreaterThanOrEqual(4);
  });
});

// ============ SERVER-SIDE ENFORCEMENT ============

describe("server-side permission enforcement (independent of UI)", () => {
  it("5. every exported server function asserts the product-management permission before doing anything else billable/mutating", () => {
    for (const fnName of [
      "createProductImageUploadTicket",
      "generateProductImage",
      "applyProductImage",
      "getProductImageUrl",
      "deleteProductImage",
    ]) {
      const start = productImagesFns.indexOf(`export const ${fnName}`);
      expect(start, `${fnName} not found`).toBeGreaterThanOrEqual(0);
      const nextExport = productImagesFns.indexOf("export const", start + 1);
      const body = productImagesFns.slice(start, nextExport === -1 ? undefined : nextExport);
      expect(body).toMatch(/assertProductManagePermission|assertServerPermission/);
    }
  });

  it("generation checks permission before calling OpenAI and before uploading to storage", () => {
    const start = productImagesFns.indexOf("export const generateProductImage");
    const body = productImagesFns.slice(start, productImagesFns.indexOf("export const applyProductImage"));
    const permissionIdx = body.indexOf("assertProductManagePermission");
    const generateIdx = body.indexOf("generateProductImageBytes(");
    const uploadIdx = body.indexOf(".storage");
    expect(permissionIdx).toBeGreaterThanOrEqual(0);
    expect(permissionIdx).toBeLessThan(generateIdx);
    expect(permissionIdx).toBeLessThan(uploadIdx);
  });

  it("16. rejects generation/upload against a product id that does not belong to the given property, instead of trusting the client — with the correct not-found error still reachable for an authorized caller", () => {
    expect(productImagesFns).toContain("assertProductImageOwnership");
    expect(productImagesFns).toContain("Product not found");
    expect(productImagesFns).toContain("item.property_id !== propertyId");
  });

  it("uses the request-scoped authenticated Supabase client (RLS as the caller), matching requireSupabaseAuth everywhere else", () => {
    expect(productImagesFns).toContain('import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware"');
    expect((productImagesFns.match(/\.middleware\(\[requireSupabaseAuth\]\)/g) ?? []).length).toBe(5);
  });
});

// ============ AUTHORIZATION ORDER (generateProductImage) ============

describe("authorization order in generateProductImage", () => {
  const start = productImagesFns.indexOf("export const generateProductImage");
  const body = productImagesFns.slice(start, productImagesFns.indexOf("export const applyProductImage"));

  it("13. authentication happens first — requireSupabaseAuth middleware runs before the handler body at all", () => {
    const middlewareIdx = body.indexOf(".middleware([requireSupabaseAuth])");
    const handlerIdx = body.indexOf(".handler(");
    expect(middlewareIdx).toBeGreaterThanOrEqual(0);
    expect(middlewareIdx).toBeLessThan(handlerIdx);
  });

  it("14. permission assertion happens before the product ownership/existence lookup", () => {
    const permissionIdx = body.indexOf("assertProductManagePermission");
    const ownershipIdx = body.indexOf("assertProductImageOwnership");
    expect(permissionIdx).toBeGreaterThanOrEqual(0);
    expect(ownershipIdx).toBeGreaterThan(permissionIdx);
  });

  it("15. an unauthorized caller cannot learn product existence through differing errors — the ownership lookup (and its distinct 'Product not found' error) is only reachable after the permission check has already passed", () => {
    const permissionIdx = body.indexOf("await assertProductManagePermission(context, data.propertyId);");
    const ownershipCallIdx = body.indexOf("await assertProductImageOwnership(context, data.itemId, data.propertyId);");
    expect(permissionIdx).toBeGreaterThanOrEqual(0);
    expect(ownershipCallIdx).toBeGreaterThan(permissionIdx);
  });

  it("16b. an authorized caller still receives the correct not-found error for a bad/foreign item id — ownership validation was reordered, not removed", () => {
    expect(body).toContain("if (data.itemId) {");
    expect(body).toContain("assertProductImageOwnership(context, data.itemId, data.propertyId)");
  });

  it("17. OpenAI is never called before permission passes, and the rate limit check also runs pre-ownership-lookup", () => {
    const permissionIdx = body.indexOf("assertProductManagePermission");
    const rateLimitIdx = body.indexOf("checkGenerationRateLimit");
    const ownershipIdx = body.indexOf("assertProductImageOwnership");
    const openAiIdx = body.indexOf("generateProductImageBytes(");
    expect(permissionIdx).toBeLessThan(rateLimitIdx);
    expect(rateLimitIdx).toBeLessThan(ownershipIdx);
    expect(ownershipIdx).toBeLessThan(openAiIdx);
  });
});

// ============ INPUT VALIDATION ============

describe("input validation", () => {
  it("12/13. rejects an empty or whitespace-only prompt via sanitizeProductImagePrompt", () => {
    expect(domain).toContain("MIN_PRODUCT_IMAGE_PROMPT_LENGTH");
    expect(domain).toMatch(/trimmed\.length < MIN_PRODUCT_IMAGE_PROMPT_LENGTH/);
  });

  it("14. rejects an oversized prompt", () => {
    expect(domain).toContain("MAX_PRODUCT_IMAGE_PROMPT_LENGTH");
    expect(domain).toMatch(/trimmed\.length > MAX_PRODUCT_IMAGE_PROMPT_LENGTH/);
  });

  it("15. rejects a malformed product id via the shared uuid() validator, not ad-hoc parsing", () => {
    expect(productImagesFns).toContain("optionalUuid(d.itemId)");
    expect(productImagesFns).toContain("uuid(d.propertyId)");
  });

  it("never accepts cost, supplier, staff, or internal-note fields in the generation input", () => {
    const start = productImagesFns.indexOf("export const generateProductImage");
    const inputBlock = productImagesFns.slice(start, productImagesFns.indexOf(".handler(", start));
    for (const forbidden of ["cost", "supplier", "supplierId", "internalNote", "staff", "apiKey"]) {
      expect(inputBlock.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

// ============ COST CONTROL ============

describe("cost control", () => {
  it("35. the Generate/Regenerate button is disabled while a request is pending", () => {
    expect(imageField).toMatch(/disabled=\{generating/);
  });

  it("36. no automatic retry/backoff loop around generation, and the OpenAI SDK's own automatic retry is explicitly disabled for this billable call", () => {
    expect(aiServerModule).not.toMatch(/setTimeout|setInterval|for\s*\(.*retry/i);
    expect(productImagesFns).not.toMatch(/setTimeout|setInterval/);
    // The SDK retries 5xx/timeout/connection failures by default (up to 2
    // extra attempts), which could otherwise turn one Generate click into
    // more than one billable OpenAI request.
    expect(aiServerModule).toContain("{ maxRetries: 0 }");
  });

  it("37. one Generate click issues exactly one server call, which issues exactly one OpenAI request (see product-image-ai.test.ts for the mocked call-count assertion)", () => {
    const handleGenerate = imageField.match(/async function handleGenerate\(\)[\s\S]*?\n {2}\}/)?.[0];
    expect(handleGenerate).toBeDefined();
    expect(handleGenerate).not.toMatch(/for\s*\(|while\s*\(/);
  });
});

// ============ RATE LIMIT ============

describe("generation rate limit — role-independent, per-user, audit-visibility-independent", () => {
  const rpcName = "count_recent_product_image_generations";
  const rpcDef = migration.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${rpcName}[\\s\\S]*?\\$\\$;`),
  )?.[0];
  const adminLogsReadPolicy = adminActionLogsMigration.match(
    /"Admins can view logs for their properties"[\s\S]*?;/,
  )?.[0];

  it("uses a SECURITY DEFINER RPC rather than a plain SELECT against admin_action_logs through the caller's own RLS session", () => {
    expect(rpcDef).toBeDefined();
    expect(rpcDef).toContain("SECURITY DEFINER");
    expect(rpcDef).toContain("SET search_path = public");
    expect(productImagesFns).toContain('context.supabase.rpc("count_recent_product_image_generations")');
    expect(productImagesFns).not.toMatch(/from\(["']admin_action_logs["']\)\.select/);
  });

  it("1-4. rate-limit logic never branches on role — the same unconditional check runs for every authorized caller, so it applies identically to admin, super_admin, hotel_owner, and general_manager", () => {
    const start = productImagesFns.indexOf("async function checkGenerationRateLimit");
    const body = productImagesFns.slice(start, productImagesFns.indexOf("\n}", start));
    expect(body).not.toMatch(/role\s*===|\.includes\(\s*role/i);
    expect(body).not.toMatch(/super_admin|hotel_owner|general_manager/);
  });

  it("5. the RPC's own query has no role filter at all (only actor_id = auth.uid()), so it is blind neither to the 3 legacy admin-log-visible roles nor to a custom role granted product_images:create but no separate audit-log visibility", () => {
    expect(rpcDef).toContain("WHERE actor_id = auth.uid()");
    expect(rpcDef).not.toMatch(/super_admin|hotel_owner|general_manager|has_any_role|has_permission/);
  });

  it("proves the actual bug this replaces: admin_action_logs' own SELECT policy really is restricted to the 3 legacy roles, which is exactly why a direct table query was blind for any other authorized role", () => {
    expect(adminLogsReadPolicy).toBeDefined();
    expect(adminLogsReadPolicy).toContain(
      "ARRAY['super_admin','hotel_owner','general_manager']::app_role[]",
    );
  });

  it("6. an unauthorized caller never reaches the rate limiter or OpenAI — permission is asserted first (see the authorization-order suite for the full ordering proof)", () => {
    const start = productImagesFns.indexOf("export const generateProductImage");
    const body = productImagesFns.slice(start, productImagesFns.indexOf("export const applyProductImage"));
    const permissionIdx = body.indexOf("assertProductManagePermission");
    const rateLimitIdx = body.indexOf("checkGenerationRateLimit");
    expect(permissionIdx).toBeGreaterThanOrEqual(0);
    expect(permissionIdx).toBeLessThan(rateLimitIdx);
  });

  it("7. per-user isolation — the RPC counts only auth.uid()'s own rows, taken from the session, never a caller-supplied identifier, so one user's usage cannot consume another user's quota", () => {
    expect(rpcDef).toMatch(/count_recent_product_image_generations\(\)/);
    expect(rpcDef).not.toMatch(/_user_id|_actor_id|p_user/);
    expect(rpcDef).toContain("actor_id = auth.uid()");
  });

  it("8. exactly 6 successful generations are allowed before the 7th is rejected — the comparison is >= (not >) against a limit of 6", () => {
    expect(productImagesFns).toContain("const GENERATION_RATE_LIMIT_MAX = 6;");
    expect(productImagesFns).toContain("(result.data ?? 0) >= GENERATION_RATE_LIMIT_MAX");
  });

  it("9. the window is a rolling 60 seconds, so generation becomes available again once older events age out rather than via a fixed reset time", () => {
    expect(rpcDef).toContain("created_at >= now() - interval '60 seconds'");
  });

  it("10/11. a rate-limited or permission-denied call never reaches generateProductImageBytes — both checks precede the OpenAI call in a plain sequential await chain, and neither is wrapped in a try/catch that could swallow the rejection and continue (the handler has no try/catch at all before the OpenAI call)", () => {
    const start = productImagesFns.indexOf("export const generateProductImage");
    const handlerStart = productImagesFns.indexOf(".handler(async", start);
    const body = productImagesFns.slice(handlerStart, productImagesFns.indexOf("export const applyProductImage"));
    const permissionIdx = body.indexOf("await assertProductManagePermission");
    const rateLimitIdx = body.indexOf("await checkGenerationRateLimit");
    const openAiIdx = body.indexOf("await generateProductImageBytes(");
    expect(permissionIdx).toBeGreaterThanOrEqual(0);
    expect(rateLimitIdx).toBeGreaterThan(permissionIdx);
    expect(openAiIdx).toBeGreaterThan(rateLimitIdx);
    // nothing before the OpenAI call can catch and continue past a
    // permission/rate-limit rejection, because there is no try/catch at all
    // until the OpenAI call itself
    const preOpenAiBody = body.slice(0, openAiIdx);
    expect(preOpenAiBody).not.toContain("try {");
  });

  it("12. no caller can request another user's generation count — the RPC takes zero parameters and is never called with an id argument", () => {
    expect(rpcDef).toMatch(/FUNCTION public\.count_recent_product_image_generations\(\)/);
    expect(productImagesFns).toContain('context.supabase.rpc("count_recent_product_image_generations");');
    expect(productImagesFns).not.toMatch(/count_recent_product_image_generations["'],\s*\{/);
  });

  it("13. no general audit-log data is exposed — the RPC returns only an integer count, PUBLIC/anon execute are revoked, and only authenticated gets EXECUTE", () => {
    expect(rpcDef).toMatch(/RETURNS integer/);
    expect(rpcDef).not.toMatch(/RETURNS SETOF|RETURNS TABLE|RETURNS public\.admin_action_logs/);
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.count_recent_product_image_generations() FROM PUBLIC;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.count_recent_product_image_generations() TO authenticated;",
    );
    expect(productImagesFns).toContain("result.data ?? 0");
  });

  it("does not weaken admin_action_logs' own RLS — the pre-existing role-restricted read policy is untouched by this migration", () => {
    expect(adminLogsReadPolicy).toBeDefined();
    expect(migration).not.toMatch(/DROP POLICY.*admin_action_logs|ALTER TABLE public\.admin_action_logs/);
  });
});

// ============ PRODUCT SAVE WORKFLOW ============

describe("generation never auto-saves the product", () => {
  it("22/24. neither generateProductImage nor applyProductImage writes to inventory_items", () => {
    expect(productImagesFns).not.toMatch(/from\(["']inventory_items["']\)\.(insert|update)/);
  });

  it("26. the product form only persists the image through the normal Save/Update action, inside ItemsSection's submit()", () => {
    const itemsSection = inventoryModule.match(/function ItemsSection[\s\S]*?\n\}/)?.[0];
    expect(itemsSection).toBeDefined();
    const submitFn = itemsSection!.match(/const submit = async[\s\S]*?\n {2}\};/)?.[0];
    expect(submitFn).toBeDefined();
    expect(submitFn).toContain("image_path");
    expect(submitFn).toContain("update.mutateAsync");
    expect(submitFn).toContain("create.mutateAsync");
  });

  it("22b. the image is only added to the save payload when the user made an explicit selection, never unconditionally", () => {
    expect(inventoryModule).toMatch(/if\s*\(imageSelection\)\s*\{\s*\n\s*payload\.image_path/);
  });

  it("23. AI generation stores its result in separate preview state (aiPreview), not in the applied selection state", () => {
    expect(imageField).toContain("aiPreview");
    expect(imageField).toMatch(/setAiPreview\(\{ path: result\.storagePath/);
    expect(imageField).not.toMatch(/setSelected[\s\S]{0,40}result\.storagePath/);
  });

  it("24. Regenerate (handleGenerate) never calls onChange or applyFn — only Use Image does", () => {
    const handleGenerate = imageField.match(/async function handleGenerate\(\)[\s\S]*?\n {2}\}/)?.[0]!;
    expect(handleGenerate).not.toContain("onChange(");
    expect(handleGenerate).not.toContain("applyFn(");
  });

  it("25. Use Image (handleUseImage) is the only path that calls onChange with the AI result", () => {
    const handleUseImage = imageField.match(/async function handleUseImage\(\)[\s\S]*?\n {2}\}/)?.[0]!;
    expect(handleUseImage).toContain("onChange({ path: aiPreview.path, source: \"ai\" })");
  });

  it("27. cancelling the AI panel (handleCancelAi) only clears local preview state — it never calls onChange", () => {
    const handleCancelAi = imageField.match(/function handleCancelAi\(\)[\s\S]*?\n {2}\}/)?.[0]!;
    expect(handleCancelAi).not.toContain("onChange");
    expect(handleCancelAi).toContain("setAiPreview(null)");
  });

  it("28. editing an existing product loads the saved image straight into preview state, not into the applied selection — so it stays untouched until the user explicitly changes it", () => {
    expect(imageField).toMatch(/setPreviewUrl\(res\.url\)/);
    expect(imageField).not.toMatch(/setSelected[\s\S]{0,60}initialImagePath/);
  });

  it("29. the plain upload workflow (Upload Image) is preserved alongside AI generation, both gated the same way", () => {
    expect(imageField).toContain("handleFileSelected");
    expect(imageField).toContain("createProductImageUploadTicket");
    expect(imageField).toMatch(/Upload Image/);
    expect(imageField).toMatch(/Generate with AI/);
  });

  it("UI hides both Upload Image and Generate with AI controls for a user without product-management permission", () => {
    expect(imageField).toContain("usePermission");
    expect(imageField).toMatch(/canManageImages\s*\?/);
  });
});

// ============ STORAGE ============

describe("storage integration", () => {
  it("30/31. uploads decoded bytes into the existing Supabase Storage product-image bucket via the request-scoped client, the same pattern expense receipts use", () => {
    expect(productImagesFns).toContain('context.supabase.storage\n      .from(PRODUCT_IMAGES_BUCKET)\n      .upload(');
  });

  it("32. a storage upload failure throws before any audit event is captured or a path is returned", () => {
    const start = productImagesFns.indexOf("export const generateProductImage");
    const body = productImagesFns.slice(start, productImagesFns.indexOf("export const applyProductImage"));
    const uploadErrorIdx = body.indexOf("if (uploaded.error)");
    const auditIdx = body.indexOf("captureAuditEvent");
    const returnIdx = body.lastIndexOf("return {");
    expect(uploadErrorIdx).toBeGreaterThanOrEqual(0);
    expect(uploadErrorIdx).toBeLessThan(auditIdx);
    expect(uploadErrorIdx).toBeLessThan(returnIdx);
  });

  it("33. every generated/uploaded image gets a fresh crypto.randomUUID()-based path segment", () => {
    expect(productImagesFns).toContain("crypto.randomUUID()");
  });

  it("34. no base64 image data column exists on inventory_items — only a storage path/source/timestamp", () => {
    const alter = migration.match(/ALTER TABLE public\.inventory_items[\s\S]*?;/)?.[0] ?? "";
    expect(alter).toContain("image_path TEXT");
    expect(alter).toContain("image_source TEXT");
    expect(alter).not.toMatch(/base64|bytea/i);
  });

  it("storage bucket is private (not public) and MIME/size bounded, matching the expense-receipts convention", () => {
    expect(migration).toContain("'product-images', 'product-images', false, 8388608");
    expect(migration).toContain("ARRAY['image/jpeg', 'image/png', 'image/webp']");
  });

  it("storage RLS is property-scoped via the first path segment and reuses has_permission, not a bespoke check", () => {
    expect(migration).toContain("((storage.foldername(name))[1])::uuid, 'product_images', 'create'");
    expect(migration).toContain("((storage.foldername(name))[1])::uuid, 'product_images', 'read'");
  });
});

// ============ TEMPORARY IMAGE CLEANUP ============

describe("temporary image cleanup", () => {
  it("1. a DELETE storage policy exists for the product-images bucket", () => {
    expect(migration).toContain("CREATE POLICY product_images_storage_delete ON storage.objects");
    expect(migration).toMatch(/product_images_storage_delete[\s\S]*?FOR DELETE TO authenticated/);
  });

  it("2. anonymous delete is blocked — the DELETE policy is authenticated-only, same as insert/read", () => {
    const deletePolicy = migration.match(/CREATE POLICY product_images_storage_delete[\s\S]*?;/)?.[0];
    expect(deletePolicy).toBeDefined();
    expect(deletePolicy).toContain("FOR DELETE TO authenticated");
    expect(deletePolicy).not.toMatch(/\banon\b/);
  });

  it("3/4. unauthorized and cross-property delete are blocked the same way as insert — both gated by has_permission('product_images','create') scoped to the path's own property segment", () => {
    const deletePolicy = migration.match(/CREATE POLICY product_images_storage_delete[\s\S]*?;/)?.[0]!;
    const insertPolicy = migration.match(/CREATE POLICY product_images_storage_insert[\s\S]*?;/)?.[0]!;
    const deletePermCall = deletePolicy.match(/has_permission\([^)]*\)/)?.[0];
    const insertPermCall = insertPolicy.match(/has_permission\([^)]*\)/)?.[0];
    expect(deletePermCall).toBe(insertPermCall);
    expect(deletePolicy).toContain("((storage.foldername(name))[1])::uuid");
  });

  it("does not grant a broad bucket-wide delete — the policy still requires bucket_id = 'product-images' AND a permission check, not a bare USING (true)", () => {
    const deletePolicy = migration.match(/CREATE POLICY product_images_storage_delete[\s\S]*?;/)?.[0]!;
    expect(deletePolicy).toContain("bucket_id = 'product-images'");
    expect(deletePolicy).not.toMatch(/USING\s*\(\s*true\s*\)/);
  });

  it("5. the server-side deleteProductImage function checks permission, validates the path is actually in the product-images namespace for that property, and refuses to remove a path currently referenced by a product", () => {
    const start = productImagesFns.indexOf("export const deleteProductImage");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = productImagesFns.slice(start);
    expect(body).toContain("assertProductManagePermission(context, data.propertyId)");
    expect(body).toContain("assertProductImageNamespace(data.storagePath, data.propertyId)");
    expect(body).toContain('.eq("image_path", data.storagePath)');
    expect(body).toContain("currently in use by a product");
    expect(body).toContain(".storage\n      .from(PRODUCT_IMAGES_BUCKET)\n      .remove(");
  });

  it("does not expose raw Storage delete capability to the browser — the client never calls supabase.storage....remove() directly, only the server function", () => {
    expect(imageField).not.toMatch(/supabase\.storage[\s\S]{0,40}\.remove\(/);
    expect(imageField).toContain("deleteFn");
    expect(imageField).toContain("deleteProductImage");
  });

  it("6. Regenerate deletes the previous temporary image, but only after the new generation has already succeeded", () => {
    const handleGenerate = imageField.match(/async function handleGenerate\(\)[\s\S]*?\n {2}\}/)?.[0]!;
    const setAiPreviewIdx = handleGenerate.indexOf("setAiPreview({");
    const deleteIdx = handleGenerate.indexOf("if (previousAiPreviewPath) void deleteTempImage(previousAiPreviewPath);");
    expect(setAiPreviewIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(setAiPreviewIdx);
    // the delete call must be inside the try block (before catch), i.e. only
    // reached on the success path
    const catchIdx = handleGenerate.indexOf("} catch");
    expect(deleteIdx).toBeLessThan(catchIdx);
  });

  it("7. a failed Regenerate keeps the previous preview — the catch block never clears or replaces aiPreview, and never deletes the still-displayed previous preview", () => {
    const handleGenerate = imageField.match(/async function handleGenerate\(\)[\s\S]*?\n {2}\}/)?.[0]!;
    const catchBlock = handleGenerate.match(/\} catch[\s\S]*?\} finally/)?.[0]!;
    expect(catchBlock).not.toContain("setAiPreview");
    expect(catchBlock).not.toContain("deleteTempImage");
  });

  it("8. Cancel (handleCancelAi) deletes the pending unsaved temporary generated image", () => {
    const handleCancelAi = imageField.match(/function handleCancelAi\(\)[\s\S]*?\n {2}\}/)?.[0]!;
    expect(handleCancelAi).toContain("if (aiPreview) void deleteTempImage(aiPreview.path);");
    const deleteIdx = handleCancelAi.indexOf("deleteTempImage(aiPreview.path)");
    const clearIdx = handleCancelAi.indexOf("setAiPreview(null)");
    expect(deleteIdx).toBeLessThan(clearIdx);
  });

  it("9. replacing an already-selected temporary upload/generation deletes the old temporary image, computed before it's overwritten and preserving the pre-existing saved image", () => {
    const handleFileSelected = imageField.match(/async function handleFileSelected\([\s\S]*?\n {2}\}/)?.[0]!;
    expect(handleFileSelected).toContain(
      "const previousTempPath =\n        selected && selected.path !== initialImagePath ? selected.path : null;",
    );
    expect(handleFileSelected).toContain("if (previousTempPath) void deleteTempImage(previousTempPath);");
    const handleUseImage = imageField.match(/async function handleUseImage\(\)[\s\S]*?\n {2}\}/)?.[0]!;
    expect(handleUseImage).toContain(
      "const previousTempPath =\n        selected && selected.path !== initialImagePath ? selected.path : null;",
    );
    expect(handleUseImage).toContain("if (previousTempPath) void deleteTempImage(previousTempPath);");
  });

  it("10. a successful Save retains the selected image — cleanupUnsaved is called with the saved path as keepPath, so it is never a deletion target", () => {
    const itemsSection = inventoryModule.match(/function ItemsSection[\s\S]*?\n\}/)?.[0]!;
    const submitFn = itemsSection.match(/const submit = async[\s\S]*?\n {2}\};/)?.[0]!;
    expect(submitFn).toContain(
      "imageFieldRef.current?.cleanupUnsaved(imageSelection?.path ?? editing?.image_path ?? null);",
    );
    // cleanupUnsaved itself never deletes a path equal to keepPath
    const cleanupImpl = imageField.match(/cleanupUnsaved\(keepPath\)\s*\{[\s\S]*?\n {6}\},/)?.[0]!;
    expect(cleanupImpl).toContain("selected.path !== keepPath");
  });

  it("11. cancelling the edit dialog never deletes the pre-existing saved product image — cleanupUnsaved's selected-branch also excludes initialImagePath unconditionally, independent of keepPath", () => {
    const itemsSection = inventoryModule.match(/function ItemsSection[\s\S]*?\n\}/)?.[0]!;
    expect(itemsSection).toContain("imageFieldRef.current?.cleanupUnsaved(editing?.image_path ?? null);");
    const cleanupImpl = imageField.match(/cleanupUnsaved\(keepPath\)\s*\{[\s\S]*?\n {6}\},/)?.[0]!;
    expect(cleanupImpl).toContain("selected.path !== initialImagePath");
  });

  it("12. a cleanup delete failure never breaks the product form — deleteTempImage swallows errors into a console warning instead of throwing or touching component state", () => {
    const deleteTempImageFn = imageField.match(/async function deleteTempImage[\s\S]*?\n {2}\}/)?.[0]!;
    expect(deleteTempImageFn).toContain("try {");
    expect(deleteTempImageFn).toContain("} catch (err) {");
    expect(deleteTempImageFn).toContain("console.warn(");
    expect(deleteTempImageFn).not.toMatch(/throw|setSelected|setAiPreview|toast\.error/);
  });

  it("documents the residual limitation: a browser/tab close mid-flow (no clean unmount) can still leave an orphan, and this is intentionally not solved with background infrastructure", () => {
    expect(imageField).toMatch(/Best-effort/);
  });
});

// ============ AUDIT LOGGING ============

describe("audit logging", () => {
  it("38. successful generation is audited under product_image.generated", () => {
    expect(productImagesFns).toContain('action: "product_image.generated"');
  });

  it("39. applying the generated/uploaded image is audited under product_image.applied", () => {
    expect(productImagesFns).toContain('action: "product_image.applied"');
  });

  it("40. audit events never carry raw image bytes, base64, or OpenAI response payloads — only storage path/background metadata and a truncated prompt memo", () => {
    const generatedEventBlock = productImagesFns.match(
      /captureAuditEvent\(context, \{[\s\S]*?product_image\.generated[\s\S]*?\}\);/,
    )?.[0];
    expect(generatedEventBlock).toBeDefined();
    expect(generatedEventBlock).not.toMatch(/b64_json|bytes|apiKey|OPENAI_API_KEY/);
    expect(generatedEventBlock).toContain("memo: data.prompt.slice(0, 200)");
  });

  it("captures audit events through the shared captureAuditEvent helper (audit_capture RPC), not a bespoke insert", () => {
    expect(productImagesFns).toContain('import { captureAuditEvent } from "@/lib/audit.server"');
    expect(productImagesFns).not.toMatch(/from\(["']admin_action_logs["']\)\.insert/);
  });
});

// ============ API KEY SECURITY ============

describe("OpenAI API key security", () => {
  it("8/server-only. the key is only ever read from process.env.OPENAI_API_KEY, inside a .server.ts module", () => {
    expect(aiServerModule).toContain("process.env.OPENAI_API_KEY");
    expect(aiServerModule).not.toContain("import.meta.env");
  });

  it("does not introduce VITE_OPENAI_API_KEY anywhere in the app", () => {
    for (const source of [aiServerModule, productImagesFns, imageField, domain, permissionsModule, envExample]) {
      expect(source).not.toContain("VITE_OPENAI_API_KEY");
    }
  });

  it("9. the API key value itself is never returned from a server function or embedded in a response object", () => {
    expect(productImagesFns).not.toMatch(/apiKey|OPENAI_API_KEY/);
  });

  it("10. the API key never appears in an audit event payload", () => {
    expect(productImagesFns.match(/captureAuditEvent\([\s\S]*?\}\);/g) ?? []).not.toEqual([]);
    for (const block of productImagesFns.match(/captureAuditEvent\([\s\S]*?\}\);/g) ?? []) {
      expect(block).not.toMatch(/apiKey|OPENAI_API_KEY/);
    }
  });

  it("11. OPENAI_API_KEY and the literal API key prefix never appear anywhere under src/ outside the server-only module and generated route tree", () => {
    const offenders: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules") continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (full.endsWith("product-image-ai.server.ts")) continue;
        const contents = readFileSync(full, "utf8");
        if (contents.includes("OPENAI_API_KEY") || /sk-proj-/.test(contents)) {
          offenders.push(full);
        }
      }
    }
    walk(resolve(root, "src"));
    expect(offenders).toEqual([]);
  });
});

// ============ ENV DOCUMENTATION ============

describe(".env.production.example", () => {
  it("documents OPENAI_API_KEY as a blank, server-only entry", () => {
    expect(envExample).toMatch(/^OPENAI_API_KEY=$/m);
    expect(envExample).not.toContain("VITE_OPENAI_API_KEY");
    expect(envExample).not.toMatch(/OPENAI_API_KEY=sk-/);
  });
});
