/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertServerPermission } from "@/lib/permissions.server";
import { captureAuditEvent } from "@/lib/audit.server";
import { ACCOUNTING_ADMIN_ROLES, EXPENSE_PERMISSIONS } from "@/lib/accounting/permissions";
import {
  uuid,
  reasonText,
  validateExpenseReceiptFile,
  expenseReceiptStoragePath,
} from "@/lib/accounting/domain";

const RECEIPTS_BUCKET = "expense-receipts";

export const createExpenseReceiptUploadTicket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      expenseId: string;
      fileName: string;
      fileType: string;
      fileSize: number;
    }) => ({
      propertyId: uuid(d.propertyId),
      expenseId: uuid(d.expenseId),
      fileName: String(d.fileName ?? ""),
      fileType: String(d.fileType ?? ""),
      fileSize: Number(d.fileSize),
    }),
  )
  .handler(async ({ data, context }) => {
    validateExpenseReceiptFile({ type: data.fileType, size: data.fileSize });
    const { data: expense, error } = await (context.supabase as any)
      .from("expenses")
      .select("id,property_id,created_by")
      .eq("id", data.expenseId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!expense || expense.property_id !== data.propertyId) throw new Error("Expense not found");
    if (expense.created_by !== context.userId) {
      await assertServerPermission(context as any, {
        propertyId: data.propertyId,
        ...EXPENSE_PERMISSIONS.receiptsUpload,
        defaultRoles: ACCOUNTING_ADMIN_ROLES,
      });
    }
    const receiptId = crypto.randomUUID();
    return {
      bucket: RECEIPTS_BUCKET,
      receiptId,
      storagePath: expenseReceiptStoragePath({
        propertyId: data.propertyId,
        expenseId: data.expenseId,
        receiptId,
        fileName: data.fileName,
      }),
    };
  });

export const registerExpenseReceipt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      propertyId: string;
      expenseId: string;
      storagePath: string;
      fileName: string;
      fileType: string;
      fileSize: number;
      receiptType?: string;
    }) => ({
      propertyId: uuid(d.propertyId),
      expenseId: uuid(d.expenseId),
      storagePath: String(d.storagePath ?? ""),
      fileName: String(d.fileName ?? "").slice(0, 200),
      fileType: String(d.fileType ?? ""),
      fileSize: Number(d.fileSize),
      receiptType: d.receiptType?.trim().slice(0, 40) || "receipt",
    }),
  )
  .handler(async ({ data, context }) => {
    const result = await (context.supabase as any).rpc("expense_receipt_register", {
      _expense_id: data.expenseId,
      _file_name: data.fileName,
      _mime_type: data.fileType,
      _file_size: data.fileSize,
      _storage_path: data.storagePath,
      _receipt_type: data.receiptType,
    });
    if (result.error) throw new Error(result.error.message);
    // File contents are never logged; only safe metadata.
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "expense_receipt.uploaded",
      resourceType: "expense_receipt",
      resourceId: result.data?.id ?? null,
      newValues: { fileName: data.fileName, mimeType: data.fileType, fileSize: data.fileSize },
    });
    return result.data;
  });

export const listExpenseReceipts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; expenseId: string }) => ({
    propertyId: uuid(d.propertyId),
    expenseId: uuid(d.expenseId),
  }))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await (context.supabase as any)
      .from("expense_receipts")
      .select("id,file_name,mime_type,file_size,uploaded_at,receipt_type,archived_at")
      .eq("property_id", data.propertyId)
      .eq("expense_id", data.expenseId)
      .order("uploaded_at", { ascending: false });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const getExpenseReceiptDownloadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; receiptId: string }) => ({
    propertyId: uuid(d.propertyId),
    receiptId: uuid(d.receiptId),
  }))
  .handler(async ({ data, context }) => {
    const db = context.supabase as any;
    const { data: receipt, error } = await db
      .from("expense_receipts")
      .select("id,property_id,storage_path,file_name")
      .eq("id", data.receiptId)
      .eq("property_id", data.propertyId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!receipt) throw new Error("Receipt not found");
    const signed = await db.storage
      .from(RECEIPTS_BUCKET)
      .createSignedUrl(receipt.storage_path, 60, { download: receipt.file_name });
    if (signed.error) throw new Error(signed.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "expense_receipt.viewed",
      resourceType: "expense_receipt",
      resourceId: data.receiptId,
    });
    return { url: signed.data.signedUrl };
  });

export const archiveExpenseReceipt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; receiptId: string; reason: string }) => ({
    propertyId: uuid(d.propertyId),
    receiptId: uuid(d.receiptId),
    reason: reasonText(d.reason),
  }))
  .handler(async ({ data, context }) => {
    const result = await (context.supabase as any).rpc("expense_receipt_archive", {
      _receipt_id: data.receiptId,
      _reason: data.reason,
    });
    if (result.error) throw new Error(result.error.message);
    await captureAuditEvent(context as any, {
      propertyId: data.propertyId,
      sourceModule: "accounting",
      action: "expense_receipt.archived",
      resourceType: "expense_receipt",
      resourceId: data.receiptId,
      memo: data.reason,
    });
    return result.data;
  });
