import type { AppRole } from "@/hooks/use-user-roles";

/**
 * Phase 5 permission map. Actions reuse the app-wide PermissionCapability vocabulary
 * (view/create/edit/delete_or_archive/approve/manage_settings) so existing role_permissions
 * rows, resolvePermission() and assertServerPermission() apply unchanged.
 *
 * "Own passkey" actions are granted to every staff/admin role by default (seeded in the
 * Phase 5 migration) because managing your own credentials needs no elevated privilege.
 * Admin-side actions default to no one and rely on explicit role_permissions grants or the
 * super_admin/hotel_owner/general_manager override already used across the app (ADMIN_ROLES).
 */
export const PASSKEY_ADMIN_ROLES: readonly AppRole[] = [
  "super_admin",
  "hotel_owner",
  "general_manager",
];

export const PASSKEY_PERMISSIONS = {
  ownPasskeysView: { module: "security_passkeys_own", capability: "view" },
  ownPasskeysEnroll: { module: "security_passkeys_own", capability: "create" },
  ownPasskeysRename: { module: "security_passkeys_own", capability: "edit" },
  ownPasskeysRevoke: { module: "security_passkeys_own", capability: "delete_or_archive" },

  enrollmentRequestsView: { module: "security_passkey_enrollment", capability: "view" },
  enrollmentApprove: { module: "security_passkey_enrollment", capability: "approve" },
  enrollmentReject: { module: "security_passkey_enrollment", capability: "approve" },
  enrollmentRevoke: { module: "security_passkey_enrollment", capability: "manage_settings" },
  enrollmentReset: { module: "security_passkey_enrollment", capability: "manage_settings" },

  credentialsView: { module: "security_passkey_credentials", capability: "view" },
  credentialsDisable: { module: "security_passkey_credentials", capability: "manage_settings" },
  credentialsRevoke: { module: "security_passkey_credentials", capability: "manage_settings" },

  authSettingsView: { module: "security_auth_settings", capability: "view" },
  authSettingsManage: { module: "security_auth_settings", capability: "manage_settings" },

  twoFactorPolicyView: { module: "security_2fa", capability: "view" },
  twoFactorPolicyManage: { module: "security_2fa", capability: "manage_settings" },
  userTwoFactorReset: { module: "security_2fa", capability: "manage_settings" },

  authAuditView: { module: "security_audit", capability: "view" },
} as const;
