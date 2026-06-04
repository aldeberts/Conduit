import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * AES-256-GCM sealing of small secrets (SSH passwords / PEM private keys) for
 * at-rest storage in the sqlite `connections.encrypted_secret` column.
 *
 * We use AES-GCM rather than pulling in libsodium because:
 *   - GCM is authenticated (no separate MAC needed),
 *   - it's built into Node, no native compilation,
 *   - the on-disk format is opaque and versioned so we can swap algorithms
 *     without a migration.
 *
 * Format (binary):
 *   1 byte  version (0x01)
 *   12 bytes iv
 *   16 bytes auth tag
 *   N bytes  ciphertext
 *
 * The key is derived once from `CONDUIT_SECRET_KEY` via scrypt so the user
 * can pass any reasonable string (a passphrase) without thinking about exact
 * key length.
 */

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
/** Static salt: this is a key-derivation function, not a password hash; we
 *  don't need per-secret salts because the secret itself is random per call
 *  and authenticated. */
const KDF_SALT = Buffer.from("conduit:secret:v1", "utf8");

let cachedKey: { source: string; key: Buffer } | null = null;

function deriveKey(source: string): Buffer {
  if (cachedKey && cachedKey.source === source) {
    return cachedKey.key;
  }
  const key = scryptSync(source, KDF_SALT, KEY_LEN);
  cachedKey = { source, key };
  return key;
}

/**
 * Seals `plaintext` with the configured server key. Returns the binary blob
 * to store in sqlite. Throws when no key is configured (callers should check
 * `secretsConfigured(keySource)` first if they want to noop instead).
 */
export function sealSecret(plaintext: string, keySource: string): Uint8Array {
  if (!keySource) {
    throw new Error("CONDUIT_SECRET_KEY is not configured; cannot seal secrets");
  }
  const key = deriveKey(keySource);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]);
}

export function unsealSecret(blob: Uint8Array | null, keySource: string): string | null {
  if (!blob || blob.length === 0) return null;
  if (!keySource) {
    throw new Error("CONDUIT_SECRET_KEY is not configured; cannot unseal stored secrets");
  }
  const buf = Buffer.from(blob);
  if (buf[0] !== VERSION) {
    throw new Error(`unknown secret blob version: ${buf[0]}`);
  }
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = buf.subarray(1 + IV_LEN + TAG_LEN);
  const key = deriveKey(keySource);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

export function secretsConfigured(keySource: string | undefined): boolean {
  return Boolean(keySource && keySource.length > 0);
}
