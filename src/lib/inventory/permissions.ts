import type { AppRole } from "@/hooks/use-user-roles";

/**
 * Product (inventory_items) management is currently gated in RLS by a fixed
 * role set (see inv_items_write in the foundation migration), not the
 * configurable role_permissions module. These are the same three roles,
 * reused verbatim as the defaultRoles fallback so product-image permissions
 * can never grant access that plain product create/edit does not already
 * allow. An operator can still extend access (e.g. to a storekeeper role) by
 * adding explicit role_permissions rows for the "product_images" module —
 * resolvePermission() honors that override the same way every other module
 * in this app does.
 */
export const PRODUCT_MANAGEMENT_ROLES: readonly AppRole[] = [
  "super_admin",
  "hotel_owner",
  "general_manager",
];

export const PRODUCT_IMAGE_PERMISSIONS = {
  imagesView: { module: "product_images", capability: "view" },
  imagesCreate: { module: "product_images", capability: "create" },
} as const;
