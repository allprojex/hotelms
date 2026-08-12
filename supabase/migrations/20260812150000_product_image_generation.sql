-- AI product image generation: image column on inventory_items, a dedicated
-- private storage bucket, and a "product_images" permission module that is
-- seeded with the exact same default role set that already gates
-- inventory_items writes (inv_items_write: super_admin, hotel_owner,
-- general_manager). This keeps AI generation and plain upload governed by
-- one permission that can never diverge from actual product-management
-- access, while still allowing an operator to extend it via role_permissions
-- later (e.g. granting a storekeeper role) without a further migration.

-- ============ INVENTORY_ITEMS IMAGE COLUMNS ============
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS image_path TEXT,
  ADD COLUMN IF NOT EXISTS image_source TEXT CHECK (image_source IN ('upload', 'ai')),
  ADD COLUMN IF NOT EXISTS image_updated_at TIMESTAMPTZ;

-- ============ PERMISSION SEEDING ============
CREATE OR REPLACE FUNCTION public.seed_product_image_permissions(_property_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Same role set as the inv_items_write RLS policy (public.inventory_items),
  -- so this can never grant image access to a role that cannot manage products.
  INSERT INTO public.role_permissions(property_id, role, module, action, allowed)
  SELECT _property_id, role_name::public.app_role, module_name, action_name, true
  FROM (VALUES
    ('product_images', 'read'),
    ('product_images', 'create')
  ) permission(module_name, action_name)
  CROSS JOIN (VALUES ('super_admin'), ('hotel_owner'), ('general_manager')) role(role_name)
  ON CONFLICT DO NOTHING;
END; $$;
SELECT public.seed_product_image_permissions(id) FROM public.properties;
REVOKE ALL ON FUNCTION public.seed_product_image_permissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_product_image_permissions(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.seed_product_image_permissions_for_property()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN PERFORM public.seed_product_image_permissions(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER properties_seed_product_image_permissions AFTER INSERT ON public.properties
FOR EACH ROW EXECUTE FUNCTION public.seed_product_image_permissions_for_property();
REVOKE ALL ON FUNCTION public.seed_product_image_permissions_for_property() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_product_image_permissions_for_property() TO service_role;

-- ============ PRODUCT IMAGE STORAGE BUCKET ============
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images', 'product-images', false, 8388608,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Property-scoped: the first storage path segment must be the property_id.
-- Product photos carry no per-item ownership sensitivity, so (unlike expense
-- receipts) access is governed purely by the product_images permission,
-- without an item-level registry table.
CREATE POLICY product_images_storage_insert ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'product-images'
  AND public.has_permission(auth.uid(), ((storage.foldername(name))[1])::uuid, 'product_images', 'create')
);

CREATE POLICY product_images_storage_read ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'product-images'
  AND public.has_permission(auth.uid(), ((storage.foldername(name))[1])::uuid, 'product_images', 'read')
);

-- Deleting a temporary (never-saved) generated/uploaded image requires the
-- same permission as creating one — deletion here is just cleanup of your
-- own draft work, not a distinct capability. The application layer (see
-- deleteProductImage in product-images.functions.ts) additionally refuses to
-- delete a path that is currently referenced by any inventory_items row, so
-- this policy intentionally does not need to be narrower than INSERT.
CREATE POLICY product_images_storage_delete ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'product-images'
  AND public.has_permission(auth.uid(), ((storage.foldername(name))[1])::uuid, 'product_images', 'create')
);
