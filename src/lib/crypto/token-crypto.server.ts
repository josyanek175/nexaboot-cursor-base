// Criptografia server-only para tokens sensíveis (ex.: Meta access token).
// Nunca logar plaintext nem ciphertext em console/responses.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT_SALT = "nexaboot-meta-token-v1";

function resolveKey(): Buffer {
  const raw = process.env.META_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("META_TOKEN_ENCRYPTION_KEY não configurada");
  }

  const fromBase64 = Buffer.from(raw, "base64");
  if (fromBase64.length === KEY_LENGTH) {
    return fromBase64;
  }

  return scryptSync(raw, SCRYPT_SALT, KEY_LENGTH);
}

/** Indica se a chave de criptografia está disponível (sem expor valor). */
export function hasTokenEncryptionKey(): boolean {
  return !!process.env.META_TOKEN_ENCRYPTION_KEY;
}

/** Cifra um token; retorna base64(iv + authTag + ciphertext). */
export function encryptToken(plaintext: string): string {
  const key = resolveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/** Decifra um token previamente cifrado com encryptToken. Uso exclusivo server-side. */
export function decryptToken(ciphertextB64: string): string {
  const key = resolveKey();
  const packed = Buffer.from(ciphertextB64, "base64");
  if (packed.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error("ciphertext_invalid");
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = packed.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
