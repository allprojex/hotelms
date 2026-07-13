/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runServerOp } from "@/lib/server/errors.server";
import {
  normalizeIdentifier,
  validateIdentifier,
  validatePassword,
  type LoginAccountType,
} from "@/lib/auth-identity";

const ADMIN_ROLES = ["super_admin", "hotel_owner", "general_manager"] as const;
const STAFF_ROLES = new Set([
  "front_desk",
  "reservations",
  "cashier",
  "accountant",
  "housekeeping_supervisor",
  "housekeeping",
]);
// Roles that only super_admin or hotel_owner may grant.
const ELEVATED_ROLES = new Set(["super_admin", "hotel_owner", "general_manager"]);

async function assertAdmin(context: any, propertyId: string | null | undefined) {
  const { supabase, userId } = context;
  const { data: isAdmin, error } = await supabase.rpc("has_any_role", {
    _user_id: userId,
    _roles: ADMIN_ROLES as never,
    _property_id: propertyId || undefined,
  });
  if (error) throw new Error(`has_any_role rpc failed: ${error.message}`);
  if (!isAdmin) {
    throw new Error(
      `Not authorized: caller lacks ${ADMIN_ROLES.join("/")} on property ${propertyId ?? "(none)"}`,
    );
  }
}

/** Enforce that the caller may grant `role` on `propertyId`.
 *  - super_admin can grant anything.
 *  - hotel_owner (on this property) can grant any non-super_admin role.
 *  - Other admins (general_manager) can grant only non-elevated roles
 *    (front_desk, cashier, housekeeping, etc.) and only on their property. */
async function assertCanGrantRole(context: any, role: string, propertyId: string) {
  const { supabase, userId } = context;
  const { data: rows, error } = await supabase
    .from("user_roles")
    .select("role,property_id")
    .eq("user_id", userId);
  if (error) throw new Error(`role lookup failed: ${error.message}`);
  const held = (rows ?? []) as { role: string; property_id: string | null }[];
  const isSuper = held.some((r) => r.role === "super_admin");
  if (isSuper) return;
  if (role === "super_admin") throw new Error("Only super_admin may grant super_admin");
  const isOwnerHere = held.some(
    (r) => r.role === "hotel_owner" && (r.property_id === null || r.property_id === propertyId),
  );
  if (ELEVATED_ROLES.has(role) && !isOwnerHere) {
    throw new Error(`Only super_admin or hotel_owner may grant '${role}'`);
  }
  // Non-elevated: any admin scoped to this property is fine (assertAdmin already checked).
}

async function assertNotLastActiveSuperAdmin(supabaseAdmin: any, userId: string) {
  const targetRole = await (supabaseAdmin.from("user_roles") as any)
    .select("id")
    .eq("user_id", userId)
    .eq("role", "super_admin");
  if (targetRole.error) throw targetRole.error;
  if (!(targetRole.data ?? []).length) return;

  const allSuperRoles = await (supabaseAdmin.from("user_roles") as any)
    .select("user_id")
    .eq("role", "super_admin");
  if (allSuperRoles.error) throw allSuperRoles.error;
  const otherIds = Array.from(
    new Set((allSuperRoles.data ?? []).map((row: any) => row.user_id as string)),
  ).filter((id) => id !== userId);
  if (otherIds.length) {
    const activeOthers = await (supabaseAdmin.from("profiles") as any)
      .select("id", { count: "exact", head: true })
      .in("id", otherIds)
      .eq("status", "active");
    if (activeOthers.error) throw activeOthers.error;
    if ((activeOthers.count ?? 0) > 0) return;
  }
  throw new Error("The last active Super Admin cannot be suspended, disabled or demoted.");
}

export const inviteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (d: {
      email: string;
      fullName: string;
      role?: string;
      roles?: string[];
      propertyId: string;
    }) => {
      if (!d.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email))
        throw new Error("Valid email required");
      if (!d.fullName?.trim()) throw new Error("Full name required");
      const rolesList = d.roles && d.roles.length > 0 ? d.roles : d.role ? [d.role] : [];
      if (rolesList.length === 0) throw new Error("At least one role required");
      const needsProp = rolesList.some((r) => r !== "super_admin");
      if (!d.propertyId && needsProp) throw new Error("Property required");
      return { ...d, roles: rolesList };
    },
  )
  .handler(async ({ data, context }) =>
    runServerOp(
      { op: "users.inviteUser", email: data.email, roles: data.roles, propertyId: data.propertyId },
      async () => {
        await assertAdmin(context, data.propertyId);
        // Scope check: caller must be permitted to grant every requested role.
        for (const r of data.roles) await assertCanGrantRole(context, r, data.propertyId);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const siteUrl = process.env.SITE_URL || "";
        const { data: invited, error: invErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
          data.email,
          {
            data: { full_name: data.fullName },
            redirectTo: siteUrl ? `${siteUrl}/reset-password` : undefined,
          },
        );

        let targetId: string | null = invited?.user?.id ?? null;

        if (invErr) {
          const msg = invErr.message?.toLowerCase() ?? "";
          if (!msg.includes("registered") && !msg.includes("exists")) throw invErr;
          const { data: list, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
            perPage: 200,
          });
          if (listErr) throw listErr;
          const found = list.users.find((u) => u.email?.toLowerCase() === data.email.toLowerCase());
          if (!found)
            throw new Error(
              `User ${data.email} exists in Auth but could not be located via listUsers`,
            );
          targetId = found.id;
        }

        if (!targetId) throw new Error("Invite did not return a target user id");

        // Insert via caller's supabase so enforce_user_role_scope trigger sees auth.uid()
        for (const role of data.roles) {
          const { error: grantErr } = await context.supabase.from("user_roles").insert({
            user_id: targetId,
            role: role as never,
            property_id: role === "super_admin" ? null : data.propertyId,
          });
          if (grantErr && !grantErr.message.toLowerCase().includes("duplicate")) throw grantErr;
        }

        await (supabaseAdmin.from("profiles") as any).upsert(
          { id: targetId, full_name: data.fullName, status: "pending" },
          { onConflict: "id" },
        );

        return { userId: targetId, invited: !invErr, roles: data.roles };
      },
    ),
  );

export const setUserStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (d: {
      userId: string;
      status: "pending" | "active" | "suspended" | "disabled";
      propertyId: string;
    }) => {
      if (!d.userId) throw new Error("userId required");
      if (!d.propertyId) throw new Error("propertyId required");
      if (!["pending", "active", "suspended", "disabled"].includes(d.status))
        throw new Error("Invalid status");
      return d;
    },
  )
  .handler(async ({ data, context }) =>
    runServerOp(
      {
        op: "users.setUserStatus",
        userId: data.userId,
        status: data.status,
        propertyId: data.propertyId,
      },
      async () => {
        await assertAdmin(context, data.propertyId);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        if (data.status !== "active")
          await assertNotLastActiveSuperAdmin(supabaseAdmin, data.userId);
        const banDuration =
          data.status === "disabled" ? "876000h" : data.status === "suspended" ? "8760h" : "none";
        const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
          ban_duration: banDuration,
        } as any);
        if (banErr) throw banErr;

        const patch: Record<string, unknown> = { status: data.status };
        if (data.status === "active") {
          patch.approved_at = new Date().toISOString();
          patch.approved_by = context.userId;
        }
        const { error } = await (supabaseAdmin.from("profiles") as any)
          .update(patch)
          .eq("id", data.userId);
        if (error) throw error;

        await (supabaseAdmin.from("audit_logs") as any).insert({
          user_id: context.userId,
          property_id: data.propertyId,
          action: `users.status.${data.status}`,
          entity: "profiles",
          entity_id: data.userId,
        });

        return { ok: true, status: data.status };
      },
    ),
  );

type CreateManagedAccountInput = {
  firstName: string;
  lastName: string;
  identifier: string;
  email?: string;
  phone?: string;
  accountType: LoginAccountType;
  role: string;
  department?: string;
  propertyIds: string[];
  password: string;
  confirmation: string;
  status: "active" | "pending";
};

export const createManagedAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: CreateManagedAccountInput) => {
    const identifier = validateIdentifier(d.identifier);
    validatePassword(d.password);
    if (d.password !== d.confirmation) throw new Error("Passwords do not match.");
    if (!d.firstName.trim() || !d.lastName.trim())
      throw new Error("First and last name are required.");
    if (!d.propertyIds?.length && d.role !== "super_admin")
      throw new Error("Assign at least one property.");
    if (d.accountType === "staff" && ELEVATED_ROLES.has(d.role))
      throw new Error("Staff cannot be assigned an administrator role.");
    if (d.accountType === "admin" && !ELEVATED_ROLES.has(d.role))
      throw new Error("Choose an administrator role.");
    return { ...d, identifier };
  })
  .handler(async ({ data, context }) =>
    runServerOp(
      {
        op: "users.createManagedAccount",
        accountType: data.accountType,
        identifier: data.identifier,
      },
      async () => {
        const propertyId = data.propertyIds[0] ?? "";
        await assertAdmin(context, propertyId || null);
        await assertCanGrantRole(context, data.role, propertyId);
        if (data.accountType === "admin") {
          const { data: callerRoles } = await context.supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", context.userId);
          if (!(callerRoles ?? []).some((r: any) => r.role === "super_admin"))
            throw new Error("Only a Super Admin may register an Administrator.");
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const normalized = normalizeIdentifier(data.identifier);
        const duplicate = await (supabaseAdmin.from("profiles") as any)
          .select("id")
          .eq("identifier_normalized", normalized)
          .maybeSingle();
        if (duplicate.data) throw new Error("That identifier is already assigned.");
        const email =
          data.email?.trim() ||
          `${normalized.replace(/[^a-z0-9]/g, ".")}.${crypto.randomUUID().slice(0, 8)}@accounts.theskwoffhotel.invalid`;
        const created = await supabaseAdmin.auth.admin.createUser({
          email,
          password: data.password,
          email_confirm: true,
          user_metadata: {
            full_name: `${data.firstName.trim()} ${data.lastName.trim()}`,
            identifier: data.identifier,
            account_type: data.accountType,
          },
        });
        if (created.error || !created.data.user)
          throw created.error ?? new Error("Account creation failed");
        const userId = created.data.user.id;
        try {
          const profile = await (supabaseAdmin.from("profiles") as any)
            .update({
              full_name: `${data.firstName.trim()} ${data.lastName.trim()}`,
              phone: data.phone?.trim() || null,
              identifier: data.identifier,
              account_type: data.accountType,
              department: data.department?.trim() || null,
              default_property_id: propertyId || null,
              status: data.status,
              must_change_password: true,
              created_by: context.userId,
              approved_at: data.status === "active" ? new Date().toISOString() : null,
              approved_by: data.status === "active" ? context.userId : null,
            })
            .eq("id", userId);
          if (profile.error) throw profile.error;
          const rows =
            data.role === "super_admin"
              ? [{ user_id: userId, role: data.role, property_id: null }]
              : data.propertyIds.map((id) => ({
                  user_id: userId,
                  role: data.role,
                  property_id: id,
                }));
          const roles = await (supabaseAdmin.from("user_roles") as any).insert(rows);
          if (roles.error) throw roles.error;
          await (supabaseAdmin.from("audit_logs") as any).insert({
            user_id: context.userId,
            property_id: propertyId || null,
            action: "users.created",
            entity: "profiles",
            entity_id: userId,
            meta: {
              identifier: data.identifier,
              account_type: data.accountType,
              role: data.role,
              properties: data.propertyIds,
            },
          });
          return { ok: true, userId, identifier: data.identifier };
        } catch (error) {
          await supabaseAdmin.auth.admin.deleteUser(userId);
          throw error;
        }
      },
    ),
  );

export const updateManagedIdentifier = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { userId: string; identifier: string; propertyId: string }) => {
    if (!d.userId || !d.propertyId) throw new Error("User and property are required.");
    return { ...d, identifier: validateIdentifier(d.identifier) };
  })
  .handler(async ({ data, context }) =>
    runServerOp({ op: "users.updateManagedIdentifier", userId: data.userId }, async () => {
      await assertAdmin(context, data.propertyId);
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      const [targetResult, targetRolesResult, callerRolesResult] = await Promise.all([
        (supabaseAdmin.from("profiles") as any)
          .select("id,identifier,account_type")
          .eq("id", data.userId)
          .maybeSingle(),
        (supabaseAdmin.from("user_roles") as any).select("property_id").eq("user_id", data.userId),
        (supabaseAdmin.from("user_roles") as any).select("role").eq("user_id", context.userId),
      ]);
      if (targetResult.error) throw targetResult.error;
      if (targetRolesResult.error) throw targetRolesResult.error;
      if (callerRolesResult.error) throw callerRolesResult.error;
      const target = targetResult.data;
      if (!target) throw new Error("Account not found.");
      const targetIsInScope = (targetRolesResult.data ?? []).some(
        (role: any) => role.property_id === null || role.property_id === data.propertyId,
      );
      if (!targetIsInScope) throw new Error("Account is outside your property scope.");
      if (
        target.account_type === "admin" &&
        !(callerRolesResult.data ?? []).some((role: any) => role.role === "super_admin")
      ) {
        throw new Error("Only a Super Admin may change an Administrator ID.");
      }

      const normalized = normalizeIdentifier(data.identifier);
      const duplicate = await (supabaseAdmin.from("profiles") as any)
        .select("id")
        .eq("identifier_normalized", normalized)
        .neq("id", data.userId)
        .maybeSingle();
      if (duplicate.error) throw duplicate.error;
      if (duplicate.data) throw new Error("That identifier is already assigned.");

      const updated = await (supabaseAdmin.from("profiles") as any)
        .update({ identifier: data.identifier })
        .eq("id", data.userId);
      if (updated.error) throw updated.error;
      await (supabaseAdmin.from("audit_logs") as any).insert({
        user_id: context.userId,
        property_id: data.propertyId,
        action: "users.identifier.changed",
        entity: "profiles",
        entity_id: data.userId,
        meta: { previous_identifier: target.identifier, new_identifier: data.identifier },
      });
      return { ok: true, identifier: data.identifier };
    }),
  );

type UpdateManagedAccountInput = {
  userId: string;
  propertyId: string;
  fullName: string;
  phone?: string;
  department?: string;
  role: string;
  propertyIds: string[];
};

export const updateManagedAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: UpdateManagedAccountInput) => {
    const fullName = d.fullName?.trim();
    const phone = d.phone?.trim() || "";
    const department = d.department?.trim() || "";
    const propertyIds = Array.from(new Set(d.propertyIds ?? []));
    if (!d.userId || !d.propertyId) throw new Error("User and property are required.");
    if (!fullName || fullName.length > 120) throw new Error("Enter a valid full name.");
    if (phone.length > 50 || department.length > 100)
      throw new Error("Account details are too long.");
    if (!d.role) throw new Error("Role is required.");
    if (d.role !== "super_admin" && !propertyIds.length)
      throw new Error("Assign at least one property.");
    return { ...d, fullName, phone, department, propertyIds };
  })
  .handler(async ({ data, context }) =>
    runServerOp({ op: "users.updateManagedAccount", userId: data.userId }, async () => {
      await assertAdmin(context, data.propertyId);
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const [targetResult, targetRolesResult, callerRolesResult] = await Promise.all([
        (supabaseAdmin.from("profiles") as any)
          .select("id,account_type,full_name,phone,department")
          .eq("id", data.userId)
          .maybeSingle(),
        (supabaseAdmin.from("user_roles") as any)
          .select("id,role,property_id")
          .eq("user_id", data.userId),
        (supabaseAdmin.from("user_roles") as any).select("role").eq("user_id", context.userId),
      ]);
      if (targetResult.error) throw targetResult.error;
      if (targetRolesResult.error) throw targetRolesResult.error;
      if (callerRolesResult.error) throw callerRolesResult.error;
      const target = targetResult.data;
      if (!target) throw new Error("Account not found.");
      const previousRoles = targetRolesResult.data ?? [];
      const targetIsInScope = previousRoles.some(
        (row: any) => row.property_id === null || row.property_id === data.propertyId,
      );
      if (!targetIsInScope) throw new Error("Account is outside your property scope.");
      const callerIsSuper = (callerRolesResult.data ?? []).some(
        (row: any) => row.role === "super_admin",
      );
      if (target.account_type === "admin" && !callerIsSuper)
        throw new Error("Only a Super Admin may edit an Administrator.");
      if (target.account_type === "staff" && !STAFF_ROLES.has(data.role))
        throw new Error("Choose a Staff role.");
      if (target.account_type === "admin" && !ELEVATED_ROLES.has(data.role))
        throw new Error("Choose an Administrator role.");

      for (const propertyId of data.propertyIds)
        await assertCanGrantRole(context, data.role, propertyId);
      if (data.role === "super_admin")
        await assertCanGrantRole(context, data.role, data.propertyId);
      const wasSuper = previousRoles.some((row: any) => row.role === "super_admin");
      if (wasSuper && data.role !== "super_admin")
        await assertNotLastActiveSuperAdmin(supabaseAdmin, data.userId);

      const nextRoles =
        data.role === "super_admin"
          ? [{ user_id: data.userId, role: data.role, property_id: null }]
          : data.propertyIds.map((propertyId) => ({
              user_id: data.userId,
              role: data.role,
              property_id: propertyId,
            }));
      const removed = await (supabaseAdmin.from("user_roles") as any)
        .delete()
        .eq("user_id", data.userId);
      if (removed.error) throw removed.error;
      const inserted = await (supabaseAdmin.from("user_roles") as any).insert(nextRoles);
      if (inserted.error) {
        if (previousRoles.length) {
          await (supabaseAdmin.from("user_roles") as any).insert(
            previousRoles.map((row: any) => ({
              user_id: data.userId,
              role: row.role,
              property_id: row.property_id,
            })),
          );
        }
        throw inserted.error;
      }

      const profile = await (supabaseAdmin.from("profiles") as any)
        .update({
          full_name: data.fullName,
          phone: data.phone || null,
          department: data.department || null,
          default_property_id: data.role === "super_admin" ? null : data.propertyIds[0],
        })
        .eq("id", data.userId);
      if (profile.error) throw profile.error;
      await (supabaseAdmin.from("audit_logs") as any).insert({
        user_id: context.userId,
        property_id: data.propertyId,
        action: "users.account.updated",
        entity: "profiles",
        entity_id: data.userId,
        meta: { role: data.role, properties: data.propertyIds },
      });
      return { ok: true };
    }),
  );

export const resetManagedPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (d: { userId: string; password: string; confirmation: string; propertyId: string }) => {
      if (!d.userId || !d.propertyId) throw new Error("User and property are required.");
      validatePassword(d.password);
      if (d.password !== d.confirmation) throw new Error("Passwords do not match.");
      return d;
    },
  )
  .handler(async ({ data, context }) =>
    runServerOp({ op: "users.resetManagedPassword", userId: data.userId }, async () => {
      await assertAdmin(context, data.propertyId);
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const auth = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
        password: data.password,
      });
      if (auth.error) throw auth.error;
      const now = new Date().toISOString();
      const profile = await (supabaseAdmin.from("profiles") as any)
        .update({
          must_change_password: true,
          password_reset_at: now,
          password_reset_by: context.userId,
        })
        .eq("id", data.userId);
      if (profile.error) throw profile.error;
      await (supabaseAdmin.from("audit_logs") as any).insert({
        user_id: context.userId,
        property_id: data.propertyId,
        action: "users.password.reset",
        entity: "profiles",
        entity_id: data.userId,
      });
      return { ok: true };
    }),
  );

export const resetUserPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { userId: string; email: string; propertyId: string }) => {
    if (!d.userId || !d.email || !d.propertyId)
      throw new Error("userId, email, propertyId required");
    return d;
  })
  .handler(async ({ data, context }) =>
    runServerOp(
      {
        op: "users.resetUserPassword",
        userId: data.userId,
        email: data.email,
        propertyId: data.propertyId,
      },
      async () => {
        await assertAdmin(context, data.propertyId);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const siteUrl = process.env.SITE_URL || "";
        const { data: link, error } = await supabaseAdmin.auth.admin.generateLink({
          type: "recovery",
          email: data.email,
          options: { redirectTo: siteUrl ? `${siteUrl}/reset-password` : undefined },
        });
        if (error) throw error;
        return { ok: true, actionLink: link?.properties?.action_link ?? null };
      },
    ),
  );

export const updateUserProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { userId: string; fullName?: string; phone?: string; propertyId: string }) => {
    if (!d.userId || !d.propertyId) throw new Error("userId, propertyId required");
    return d;
  })
  .handler(async ({ data, context }) =>
    runServerOp(
      { op: "users.updateUserProfile", userId: data.userId, propertyId: data.propertyId },
      async () => {
        await assertAdmin(context, data.propertyId);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const patch: Record<string, unknown> = {};
        if (data.fullName !== undefined) patch.full_name = data.fullName;
        if (data.phone !== undefined) patch.phone = data.phone;
        const { error } = await (supabaseAdmin.from("profiles") as any)
          .update(patch)
          .eq("id", data.userId);
        if (error) throw error;
        return { ok: true };
      },
    ),
  );

export type ManageableUser = {
  id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  identifier: string;
  account_type: LoginAccountType;
  department: string | null;
  must_change_password: boolean;
  last_successful_login_at: string | null;
  status: "pending" | "active" | "suspended" | "disabled";
  created_at: string;
  approved_at: string | null;
  banned_until: string | null;
  roles: { id: string; role: string; property_id: string | null }[];
};

export const listManageableUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { propertyId: string }) => {
    if (!d.propertyId) throw new Error("propertyId required");
    return d;
  })
  .handler(async ({ data, context }): Promise<ManageableUser[]> =>
    runServerOp({ op: "users.listManageableUsers", propertyId: data.propertyId }, async () => {
      await assertAdmin(context, data.propertyId);
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      // 1. Only users who actually hold a role at this property (or global roles).
      const roleRes = await (supabaseAdmin.from("user_roles") as any)
        .select("id,user_id,role,property_id")
        .or(`property_id.eq.${data.propertyId},property_id.is.null`);
      if (roleRes.error) throw roleRes.error;
      const roles = roleRes.data ?? [];
      const scopedIds = Array.from(new Set((roles as any[]).map((r) => r.user_id))).filter(Boolean);
      if (scopedIds.length === 0) return [];

      // 2. Fetch profiles + auth data ONLY for those scoped users.
      const [profRes, authRes] = await Promise.all([
        (supabaseAdmin.from("profiles") as any)
          .select(
            "id,identifier,account_type,full_name,phone,department,status,must_change_password,last_successful_login_at,created_at,approved_at",
          )
          .in("id", scopedIds),
        Promise.all(
          scopedIds.map((id) =>
            supabaseAdmin.auth.admin.getUserById(id).then(
              (r) => (r.error ? null : r.data.user),
              () => null,
            ),
          ),
        ),
      ]);
      if (profRes.error) throw profRes.error;

      const profiles = profRes.data ?? [];
      const authUsers = (authRes ?? []).filter(Boolean) as any[];

      const rolesByUser = new Map<string, any[]>();
      (roles as any[]).forEach((r) => {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push({ id: r.id, role: r.role, property_id: r.property_id });
        rolesByUser.set(r.user_id, arr);
      });

      const authByUser = new Map<string, any>();
      authUsers.forEach((u) => authByUser.set(u.id, u));

      const out: ManageableUser[] = [];
      for (const id of scopedIds) {
        const p = (profiles as any[]).find((x) => x.id === id);
        const a = authByUser.get(id);
        out.push({
          id,
          email: null,
          identifier: p?.identifier ?? "",
          account_type: p?.account_type ?? "staff",
          department: p?.department ?? null,
          must_change_password: !!p?.must_change_password,
          last_successful_login_at: p?.last_successful_login_at ?? null,
          full_name: p?.full_name ?? null,
          phone: p?.phone ?? null,
          status: (p?.status ?? "pending") as any,
          created_at: p?.created_at ?? a?.created_at ?? new Date().toISOString(),
          approved_at: p?.approved_at ?? null,
          banned_until: a?.banned_until ?? null,
          roles: rolesByUser.get(id) ?? [],
        });
      }
      return out.sort((a, b) =>
        (a.full_name ?? a.email ?? "").localeCompare(b.full_name ?? b.email ?? ""),
      );
    }),
  );

export const grantUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { userId: string; role: string; propertyId: string }) => {
    if (!d.userId || !d.role || !d.propertyId) throw new Error("userId, role, propertyId required");
    return d;
  })
  .handler(async ({ data, context }) =>
    runServerOp(
      {
        op: "users.grantUserRole",
        userId: data.userId,
        role: data.role,
        propertyId: data.propertyId,
      },
      async () => {
        await assertAdmin(context, data.propertyId);
        await assertCanGrantRole(context, data.role, data.propertyId);
        const { error } = await context.supabase.from("user_roles").insert({
          user_id: data.userId,
          role: data.role as never,
          property_id: data.role === "super_admin" ? null : data.propertyId,
        });
        if (error && !error.message.toLowerCase().includes("duplicate")) throw error;
        return { ok: true };
      },
    ),
  );

export const revokeUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { roleId: string; propertyId: string }) => {
    if (!d.roleId || !d.propertyId) throw new Error("roleId, propertyId required");
    return d;
  })
  .handler(async ({ data, context }) =>
    runServerOp(
      { op: "users.revokeUserRole", roleId: data.roleId, propertyId: data.propertyId },
      async () => {
        await assertAdmin(context, data.propertyId);
        const { error } = await context.supabase.from("user_roles").delete().eq("id", data.roleId);
        if (error) throw error;
        return { ok: true };
      },
    ),
  );
