import type { AppRole } from "@/hooks/use-user-roles";

/**
 * Same default tier as room_types_write and product-management: the roles
 * that already manage the property's content catalog. Extendable per
 * property via role_permissions without a further migration.
 */
export const GALLERY_MANAGEMENT_ROLES: readonly AppRole[] = [
  "super_admin",
  "hotel_owner",
  "general_manager",
];

export const GALLERY_PERMISSIONS = {
  view: { module: "gallery", capability: "view" },
  create: { module: "gallery", capability: "create" },
  edit: { module: "gallery", capability: "edit" },
  delete: { module: "gallery", capability: "delete_or_archive" },
} as const;
