import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Secret custom-field values are stored as AES-256-GCM ciphertext (the 16-byte auth tag is appended)
// with a random 12-byte nonce per value. The key is SECRETS_KEY: 32 random bytes, base64 encoded
// (`openssl rand -base64 32`). A lost key means lost secrets; there is no re-encryption step yet.
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SecretsKeyError extends Error {}
export class SecretsDecryptError extends Error {}

function parseKey(raw: string | undefined): Buffer {
  if (!raw?.trim()) throw new SecretsKeyError("SECRETS_KEY is not set, so secret fields are disabled");
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new SecretsKeyError(`SECRETS_KEY must be ${KEY_BYTES} bytes, base64 encoded (openssl rand -base64 32)`);
  return key;
}

// Null when secret fields can be used, else the reason they cannot (shown on the dashboard).
export function secretsDisabledReason(env: string | undefined = process.env.SECRETS_KEY): string | null {
  try {
    parseKey(env);
    return null;
  } catch (e) {
    if (e instanceof SecretsKeyError) return e.message;
    throw e;
  }
}

// `context` (device + field ids) is bound as additional authenticated data, so a ciphertext copied to
// another device or field does not decrypt.
export function encryptSecret(plaintext: string, context: string, rawKey: string | undefined = process.env.SECRETS_KEY): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", parseKey(rawKey), nonce);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

export function decryptSecret(ciphertext: Buffer, nonce: Buffer, context: string, rawKey: string | undefined = process.env.SECRETS_KEY): string {
  const key = parseKey(rawKey);
  if (ciphertext.length < TAG_BYTES) throw new SecretsDecryptError("The stored secret is damaged");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
    return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretsDecryptError("The stored secret cannot be decrypted (wrong SECRETS_KEY or damaged data)");
  }
}
