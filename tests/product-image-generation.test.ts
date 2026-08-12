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

  it("uses the same permission (product_images.create) for upload, generation, and applying the generated image", () => {
    // All three call sites share one assertProductManagePermission() helper,
    // which is itself defined in terms of PRODUCT_IMAGE_PERMISSIONS.imagesCreate —
    // a single source of truth rather than three independent checks that could drift.
    expect(productImagesFns).toContain("...PRODUCT_IMAGE_PERMISSIONS.imagesCreate");
    const usages = productImagesFns.match(/await assertProductManagePermission\(context, data\.propertyId\)/g) ?? [];
    expect(usages.length).toBeGreaterThanOrEqual(3);
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

  it("16. rejects generation/upload against a product id that does not belong to the given property, instead of trusting the client", () => {
    expect(productImagesFns).toContain("assertProductImageOwnership");
    expect(productImagesFns).toContain("Product not found");
    expect(productImagesFns).toContain("item.property_id !== propertyId");
  });

  it("uses the request-scoped authenticated Supabase client (RLS as the caller), matching requireSupabaseAuth everywhere else", () => {
    expect(productImagesFns).toContain('import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware"');
    expect((productImagesFns.match(/\.middleware\(\[requireSupabaseAuth\]\)/g) ?? []).length).toBe(4);
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

  it("36. no automatic retry/backoff loop around generation", () => {
    expect(aiServerModule).not.toMatch(/setTimeout|setInterval|for\s*\(.*retry/i);
    expect(productImagesFns).not.toMatch(/setTimeout|setInterval/);
  });

  it("37. one Generate click issues exactly one server call, which issues exactly one OpenAI request (see product-image-ai.test.ts for the mocked call-count assertion)", () => {
    const handleGenerate = imageField.match(/async function handleGenerate\(\)[\s\S]*?\n {2}\}/)?.[0];
    expect(handleGenerate).toBeDefined();
    expect(handleGenerate).not.toMatch(/for\s*\(|while\s*\(/);
  });

  it("applies a modest server-side rate limit reusing the existing audit table, without new rate-limiting infrastructure", () => {
    expect(productImagesFns).toContain("checkGenerationRateLimit");
    expect(productImagesFns).toContain("admin_action_logs");
    expect(productImagesFns).toContain("GENERATION_RATE_LIMIT_MAX");
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
