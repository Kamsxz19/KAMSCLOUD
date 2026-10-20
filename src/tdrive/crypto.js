import { bytesToBase64, base64ToBytes } from "./util.js";

const HEX_ALPHABET = "0123456789abcdef";

export function bytesToHex(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += HEX_ALPHABET[(u8[i] >> 4) & 15] + HEX_ALPHABET[u8[i] & 15];
  return s;
}

export function hexToBytes(hex) {
  hex = String(hex || "");
  const n = hex.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
  return out;
}

export const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function randomId(len = 13) {
  const r = new Uint8Array(len);
  crypto.getRandomValues(r);
  let s = "";
  for (let i = 0; i < len; i++) s += ID_ALPHABET[r[i] % ID_ALPHABET.length];
  return s;
}

export function uid(prefix = "") {
  return prefix + Date.now().toString(36) + randomId(8);
}

export function randomHex(bytes = 16) {
  const r = new Uint8Array(bytes);
  crypto.getRandomValues(r);
  return bytesToHex(r);
}

async function deriveBitsRaw(password, saltHex, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

export async function pbkdf2Hex(password, saltHex, iterations = 120000) {
  return bytesToHex(await deriveBitsRaw(password, saltHex, iterations));
}

export function timingSafeEqualHex(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------ client-side encryption
 * Envelope scheme:
 *   masterKey        = 32 random bytes, generated once per account
 *   KEK              = PBKDF2(password, wrapSalt, it)          (never stored)
 *   wrappedMasterKey = AES-GCM(KEK, masterKey)                 (stored in the public index)
 * Changing the password only re-wraps the master key, so existing files stay readable.
 * Each file chunk is encrypted independently with the master key (fresh 12-byte IV).
 */

const AES_ALGO = { name: "AES-GCM" };

export function generateMasterKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function deriveRawKey(password, saltHex, iterations = 120000) {
  return deriveBitsRaw(password, saltHex, iterations);
}

export async function importAesKey(raw) {
  return crypto.subtle.importKey("raw", raw, AES_ALGO, false, ["encrypt", "decrypt"]);
}

export async function aesEncrypt(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

export async function aesDecrypt(key, bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf.length < 13) throw new Error("Encrypted chunk is too short");
  const iv = buf.subarray(0, 12);
  const ct = buf.subarray(12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
}

export async function wrapMasterKey(password, wrapSalt, iterations, masterRaw) {
  const kek = await importAesKey(await deriveRawKey(password, wrapSalt, iterations));
  return bytesToBase64(await aesEncrypt(kek, masterRaw));
}

export async function unwrapMasterKey(password, wrapSalt, iterations, wrappedB64) {
  const kek = await importAesKey(await deriveRawKey(password, wrapSalt, iterations));
  const raw = await aesDecrypt(kek, base64ToBytes(wrappedB64));
  if (raw.length !== 32) throw new Error("Bad key");
  return raw;
}

export const ACCOUNT_COLORS = [
  "#1a73e8", "#0f9d58", "#d93025", "#f4b400", "#a142f4", "#e8710a",
  "#00838f", "#4e342e", "#c2185b", "#283593", "#2e7d32", "#6d4c41",
];

export function pickColor(seed) {
  const s = String(seed || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ACCOUNT_COLORS[h % ACCOUNT_COLORS.length];
}
