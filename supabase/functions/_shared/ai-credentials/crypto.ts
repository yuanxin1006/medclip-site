export const CREDENTIAL_ENCRYPTION_VERSION = 1;

export type EncryptedCredential = {
  ciphertext: string;
  iv: string;
  encryptionVersion: typeof CREDENTIAL_ENCRYPTION_VERSION;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error("MALFORMED_ENCRYPTION_KEY");
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("MALFORMED_ENCRYPTION_KEY");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32) throw new Error("MALFORMED_ENCRYPTION_KEY");
  return bytes;
}

async function importEncryptionKey(base64Key: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(base64Key);
  const rawKey = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptCredential(plaintext: string, base64Key: string): Promise<EncryptedCredential> {
  if (!plaintext) throw new Error("EMPTY_CREDENTIAL");
  const key = await importEncryptionKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
    encryptionVersion: CREDENTIAL_ENCRYPTION_VERSION,
  };
}

export async function decryptCredential(
  encrypted: Pick<EncryptedCredential, "ciphertext" | "iv" | "encryptionVersion">,
  base64Key: string,
): Promise<string> {
  if (encrypted.encryptionVersion !== CREDENTIAL_ENCRYPTION_VERSION) {
    throw new Error("UNSUPPORTED_ENCRYPTION_VERSION");
  }
  const key = await importEncryptionKey(base64Key);
  const iv = Uint8Array.from(atob(encrypted.iv), (character) => character.charCodeAt(0));
  if (iv.byteLength !== 12) throw new Error("MALFORMED_IV");
  const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), (character) => character.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

export function encodeEncryptionKeyForTest(bytes: Uint8Array): string {
  if (bytes.byteLength !== 32) throw new Error("TEST_KEY_MUST_BE_32_BYTES");
  return bytesToBase64(bytes);
}
