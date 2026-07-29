type EncryptedValue = { ciphertext: string; iv: string; last4: string };

function encryptionKey(): Uint8Array {
  const encoded = process.env.PAYROLL_FIELD_ENCRYPTION_KEY;
  if (!encoded) throw new Error("Payroll field encryption is not configured");
  const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
  if (bytes.length !== 32) throw new Error("Payroll field encryption key must be 32 bytes");
  return bytes;
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(value.byteLength);
  new Uint8Array(result).set(value);
  return result;
}

async function cryptoKey() {
  return crypto.subtle.importKey("raw", arrayBuffer(encryptionKey()), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptPayrollValue(value: string): Promise<EncryptedValue> {
  const clean = value.trim();
  if (!clean) throw new Error("Sensitive payment value is required");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await cryptoKey(),
    new TextEncoder().encode(clean),
  );
  return {
    ciphertext: Buffer.from(encrypted).toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
    last4: clean.replace(/\s+/g, "").slice(-4),
  };
}

export async function decryptPayrollValue(ciphertext: string, iv: string): Promise<string> {
  const ivBytes = arrayBuffer(Uint8Array.from(Buffer.from(iv, "base64")));
  const encryptedBytes = arrayBuffer(Uint8Array.from(Buffer.from(ciphertext, "base64")));
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    await cryptoKey(),
    encryptedBytes,
  );
  return new TextDecoder().decode(decrypted);
}
