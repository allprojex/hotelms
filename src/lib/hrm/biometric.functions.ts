/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase types follow Phase 3C migration validation. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { captureAuditEvent } from "@/lib/audit.server";
import { assertServerPermission } from "@/lib/permissions.server";
import { HRM_ADMIN_ROLES, HRM_PERMISSIONS } from "@/lib/hrm/permissions";
import { assertSafeBiometricMetadata } from "@/lib/hrm/biometric-adapter";

async function allow(context: any, propertyId: string, permission: any) {
  await assertServerPermission(context, {
    propertyId,
    ...permission,
    defaultRoles: HRM_ADMIN_ROLES,
  });
}
async function audit(
  context: any,
  propertyId: string,
  action: string,
  type: string,
  id: string,
  values: unknown,
) {
  await captureAuditEvent(context, {
    propertyId,
    action,
    resourceType: type,
    resourceId: id,
    newValues: values,
    sourceModule: "biometric_architecture",
  });
}
export const getBiometricArchitecture = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.biometricDevicesView);
    const db = context.supabase as any;
    const [devices, mappings, events] = await Promise.all([
      db
        .from("hr_biometric_devices")
        .select("*")
        .eq("property_id", data.propertyId)
        .is("archived_at", null)
        .order("name"),
      db
        .from("hr_biometric_employee_mappings")
        .select(
          "*,employee:employee_id(employee_number,first_name,last_name),device:device_id(name)",
        )
        .eq("property_id", data.propertyId)
        .order("created_at", { ascending: false }),
      db
        .from("hr_biometric_normalized_events")
        .select("*,device:device_id(name)")
        .eq("property_id", data.propertyId)
        .in("processing_status", ["unmapped", "rejected", "retry_pending"])
        .order("ingested_at", { ascending: false })
        .limit(100),
    ]);
    for (const result of [devices, mappings, events])
      if (result.error) throw new Error(result.error.message);
    return {
      devices: (devices.data ?? []).map((device: any) => {
        const { connector_config_reference: connectorReference, ...browserSafeDevice } = device;
        return {
          ...browserSafeDevice,
          hasConnectorReference: Boolean(connectorReference),
        };
      }),
      mappings: mappings.data ?? [],
      events: events.data ?? [],
    };
  });
export const saveBiometricDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => {
    assertSafeBiometricMetadata(data.healthMetadata ?? {});
    return data;
  })
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.biometricDevicesManage);
    if (
      data.connectorConfigReference &&
      !/^secret:\/\/[a-zA-Z0-9/_-]+$/.test(data.connectorConfigReference)
    )
      throw new Error("Use an external secret reference");
    const db = context.supabase as any;
    const payload = {
      property_id: data.propertyId,
      name: data.name.trim(),
      location: data.location?.trim() || null,
      provider_adapter: data.providerAdapter.trim(),
      capability: data.capability ?? [],
      status: data.status ?? "unconfigured",
      connector_config_reference: data.connectorConfigReference || null,
      health_metadata: data.healthMetadata ?? {},
      active: false,
    };
    const result = data.id
      ? await db
          .from("hr_biometric_devices")
          .update(payload)
          .eq("property_id", data.propertyId)
          .eq("id", data.id)
          .select("*")
          .single()
      : await db.from("hr_biometric_devices").insert(payload).select("*").single();
    if (result.error) throw new Error(result.error.message);
    await audit(
      context,
      data.propertyId,
      data.id ? "update" : "create",
      "hr_biometric_device",
      result.data.id,
      {
        name: result.data.name,
        providerAdapter: result.data.provider_adapter,
        status: result.data.status,
      },
    );
    return result.data;
  });
export const saveBiometricMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.biometricMappingsManage);
    const result = await (context.supabase as any)
      .from("hr_biometric_employee_mappings")
      .upsert(
        {
          property_id: data.propertyId,
          device_id: data.deviceId,
          employee_id: data.employeeId,
          external_employee_identifier: data.externalIdentifier.trim(),
          active: true,
        },
        { onConflict: "property_id,device_id,external_employee_identifier" },
      )
      .select("*")
      .single();
    if (result.error) throw new Error(result.error.message);
    await audit(context, data.propertyId, "update", "hr_biometric_mapping", result.data.id, {
      deviceId: data.deviceId,
      employeeId: data.employeeId,
      externalIdentifier: data.externalIdentifier.trim(),
    });
    return result.data;
  });
export const importNormalizedBiometricEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: any) => {
    if (!Array.isArray(data.events) || data.events.length > 500)
      throw new Error("Import supports up to 500 normalized events");
    for (const event of data.events) {
      assertSafeBiometricMetadata(event);
      if (
        !["clock_in", "clock_out", "break_start", "break_end"].includes(event.eventType) ||
        !event.sourceEventId?.trim() ||
        !event.externalEmployeeIdentifier?.trim() ||
        !event.deduplicationKey?.trim() ||
        Number.isNaN(Date.parse(event.eventAt))
      )
        throw new Error("Normalized biometric event is invalid");
    }
    return data;
  })
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.biometricEventsImport);
    const db = context.supabase as any;
    const batch = await db
      .from("hr_biometric_import_batches")
      .insert({
        property_id: data.propertyId,
        device_id: data.deviceId,
        adapter_type: data.adapterType,
        safe_provider_reference: data.safeProviderReference || null,
        imported_by: context.userId,
      })
      .select("*")
      .single();
    if (batch.error) throw new Error(batch.error.message);
    const insert = await db.from("hr_biometric_normalized_events").upsert(
      data.events.map((event: any) => ({
        property_id: data.propertyId,
        device_id: data.deviceId,
        batch_id: batch.data.id,
        external_employee_identifier: event.externalEmployeeIdentifier,
        source_event_id: event.sourceEventId,
        event_at: event.eventAt,
        event_type: event.eventType,
        deduplication_key: event.deduplicationKey,
        payload_hash: event.payloadHash || null,
        safe_provider_reference: event.safeProviderReference || null,
      })),
      { onConflict: "property_id,deduplication_key", ignoreDuplicates: true },
    );
    if (insert.error) throw new Error(insert.error.message);
    const pending = await db
      .from("hr_biometric_normalized_events")
      .select("id")
      .eq("property_id", data.propertyId)
      .eq("batch_id", batch.data.id);
    if (pending.error) throw new Error(pending.error.message);
    let incomplete = 0;
    for (const event of pending.data ?? []) {
      const conversion = await db.rpc("hr_convert_biometric_event", {
        _property_id: data.propertyId,
        _event_id: event.id,
      });
      if (conversion.error) {
        incomplete += 1;
        const rejected = await db
          .from("hr_biometric_normalized_events")
          .update({
            processing_status: "rejected",
            rejection_reason: "Attendance validation rejected the normalized event",
          })
          .eq("property_id", data.propertyId)
          .eq("id", event.id);
        if (rejected.error) throw new Error(rejected.error.message);
        const logged = await db.from("hr_biometric_processing_logs").insert({
          property_id: data.propertyId,
          normalized_event_id: event.id,
          previous_status: "pending",
          new_status: "rejected",
          message: "Attendance validation rejected the normalized event",
          actor_id: context.userId,
        });
        if (logged.error) throw new Error(logged.error.message);
      } else if (!conversion.data) {
        incomplete += 1;
      }
    }
    const completed = await db
      .from("hr_biometric_import_batches")
      .update({
        status: incomplete ? "partial" : "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("property_id", data.propertyId)
      .eq("id", batch.data.id);
    if (completed.error) throw new Error(completed.error.message);
    await audit(context, data.propertyId, "create", "hr_biometric_import_batch", batch.data.id, {
      adapterType: data.adapterType,
      eventCount: data.events.length,
    });
    return { batchId: batch.data.id };
  });
export const convertBiometricEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string; eventId: string }) => data)
  .handler(async ({ data, context }) => {
    await allow(context, data.propertyId, HRM_PERMISSIONS.biometricEventsImport);
    const db = context.supabase as any;
    const before = await db
      .from("hr_biometric_normalized_events")
      .select("processing_status")
      .eq("property_id", data.propertyId)
      .eq("id", data.eventId)
      .single();
    if (before.error) throw new Error(before.error.message);
    if (["unmapped", "rejected"].includes(before.data.processing_status)) {
      const retry = await db
        .from("hr_biometric_normalized_events")
        .update({ processing_status: "retry_pending", rejection_reason: null })
        .eq("property_id", data.propertyId)
        .eq("id", data.eventId);
      if (retry.error) throw new Error(retry.error.message);
      const logged = await db.from("hr_biometric_processing_logs").insert({
        property_id: data.propertyId,
        normalized_event_id: data.eventId,
        previous_status: before.data.processing_status,
        new_status: "retry_pending",
        message: "Authorized mapping retry requested",
        actor_id: context.userId,
      });
      if (logged.error) throw new Error(logged.error.message);
    }
    const result = await db.rpc("hr_convert_biometric_event", {
      _property_id: data.propertyId,
      _event_id: data.eventId,
    });
    if (result.error) throw new Error(result.error.message);
    await audit(context, data.propertyId, "create", "hr_biometric_conversion", data.eventId, {
      converted: !!result.data,
    });
    return { attendanceEventId: result.data };
  });
