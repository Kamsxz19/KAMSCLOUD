/* KamsClouds licensing — one-time (lifetime) + monthly, PH GCash flow.
 *
 * No server, no secret in the frontend. The Telegram index document is the
 * authority: the owner approves an activation in the admin app, which writes
 * a `licenses` entry into the index. Clients validate against that index
 * (plus a small local cache so the app still opens offline).
 *
 * Index shapes (all added by normalizeIndex, capped):
 *   licenses: [{ key, type:'lifetime'|'monthly', accountId, accountName,
 *                createdAt, expiresAt (0 = never), status:'active'|'revoked', note }]
 *   activations: [{ id, accountId, accountName, plan:'lifetime'|'monthly',
 *                   ref (GCash ref no.), sender, amount, status:'pending'|'approved'|'rejected',
 *                   createdAt, decidedAt }]
 */

import { kvGet, kvSet } from "./platform.js";
import { STORAGE_KEYS } from "./config.js";

const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L confusion

export function makeLicenseKey() {
  const rnd = new Uint8Array(12);
  try {
    crypto.getRandomValues(rnd);
  } catch (e) {
    for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
  }
  let s = "";
  for (let i = 0; i < rnd.length; i++) s += KEY_ALPHABET[rnd[i] % KEY_ALPHABET.length];
  return `KAMS-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

export function normalizeKey(str) {
  return String(str || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function prettyKey(str) {
  const n = normalizeKey(str);
  const body = n.startsWith("KAMS") ? n.slice(4) : n;
  if (body.length !== 12) return String(str || "").trim().toUpperCase();
  return `KAMS-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

export function keyLooksValid(str) {
  const n = normalizeKey(str);
  const body = n.startsWith("KAMS") ? n.slice(4) : n;
  if (body.length !== 12) return false;
  for (const ch of body) if (!KEY_ALPHABET.includes(ch)) return false;
  return true;
}

export function normalizeLicense(l) {
  const o = Object.assign({}, l);
  o.key = String(o.key || "").toUpperCase();
  o.type = o.type === "monthly" ? "monthly" : "lifetime";
  o.accountId = o.accountId ? String(o.accountId) : null;
  o.accountName = String(o.accountName || "");
  o.createdAt = Number(o.createdAt) || Date.now();
  o.expiresAt = Number(o.expiresAt) || 0;
  o.status = o.status === "revoked" ? "revoked" : "active";
  o.note = String(o.note || "");
  return o;
}

export function normalizeActivation(a) {
  const o = Object.assign({}, a);
  o.id = String(o.id || ("act_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)));
  o.accountId = String(o.accountId || "");
  o.accountName = String(o.accountName || "");
  o.plan = o.plan === "monthly" ? "monthly" : "lifetime";
  o.ref = String(o.ref || "").slice(0, 64);
  o.sender = String(o.sender || "").slice(0, 64);
  o.amount = Number(o.amount) || 0;
  o.status = ["pending", "approved", "rejected"].includes(o.status) ? o.status : "pending";
  o.createdAt = Number(o.createdAt) || Date.now();
  o.decidedAt = Number(o.decidedAt) || 0;
  return o;
}

export function licensesOf(index) {
  if (!index || !Array.isArray(index.licenses)) return [];
  return index.licenses;
}

export function activationsOf(index) {
  if (!index || !Array.isArray(index.activations)) return [];
  return index.activations;
}

export function findLicense(index, key) {
  const want = String(key || "").toUpperCase();
  return licensesOf(index).find((l) => String(l.key).toUpperCase() === want) || null;
}

/* Active license bound to an account (a key may be bound to one account).
 * Unbound keys (accountId null) are claimable: entering the key binds it. */
export function licenseForAccount(index, accountId) {
  if (!index || !accountId) return null;
  const now = Date.now();
  const list = licensesOf(index).filter(
    (l) => l.status === "active" && l.accountId === String(accountId),
  );
  // lifetime wins over monthly
  list.sort((a, b) => {
    if (a.type !== b.type) return a.type === "lifetime" ? -1 : 1;
    return (Number(b.expiresAt) || 0) - (Number(a.expiresAt) || 0);
  });
  for (const l of list) {
    if (l.type === "lifetime") return { ok: true, license: l, plan: "lifetime", expiresAt: 0 };
    if (Number(l.expiresAt) > now) return { ok: true, license: l, plan: "monthly", expiresAt: Number(l.expiresAt) };
  }
  return null;
}

export function claimableLicense(index, key) {
  const l = findLicense(index, key);
  if (!l || l.status !== "active") return null;
  if (l.accountId) return null; // already bound
  return l;
}

export function pendingActivationFor(index, accountId) {
  return activationsOf(index).find(
    (a) => a.accountId === String(accountId) && a.status === "pending",
  ) || null;
}

export function driveBytes(drive) {
  if (!drive) return 0;
  let n = 0;
  for (const f of drive.files || []) n += Number(f.size) || 0;
  return n;
}

/* Gate: returns { ok, plan, expiresAt, reason }.
 * - Licensed → ok (upload/download/full use)
 * - Else trial → ok only while under trial caps, reason 'trial'
 * - Else → ok:false, reason 'trial-exceeded' | 'expired' */
export function checkAccess(index, drive, accountId, cfg) {
  const lic = licenseForAccount(index, accountId);
  if (lic) {
    if (lic.plan === "lifetime") return { ok: true, plan: "lifetime", expiresAt: 0, license: lic.license };
    if (Number(lic.expiresAt) > Date.now())
      return { ok: true, plan: "monthly", expiresAt: Number(lic.expiresAt), license: lic.license };
    return { ok: false, plan: null, reason: "expired" };
  }
  // any expired monthly still on the account → explicit expired message
  const past = licensesOf(index).find(
    (l) => l.status === "active" && l.accountId === String(accountId) && l.type === "monthly",
  );
  const trialBytes = (cfg && cfg.plans && cfg.plans.trialMaxBytes) || 100 * 1024 * 1024;
  if (driveBytes(drive) >= trialBytes)
    return { ok: false, plan: null, reason: past ? "expired" : "trial-exceeded" };
  return { ok: true, plan: "trial", expiresAt: 0, reason: "trial" };
}

export function monthlyExpiryFrom(nowMs, days) {
  return Number(nowMs || Date.now()) + Number(days || 30) * 86400000;
}

/* ------------------------- local license cache (offline) -------------- */

export async function cacheLicense(accountId, info) {
  try {
    const all = (await kvGet(STORAGE_KEYS.licenseCache, null)) || {};
    all[String(accountId)] = Object.assign({}, info, { cachedAt: Date.now() });
    await kvSet(STORAGE_KEYS.licenseCache, all);
  } catch (e) { /* ignore */ }
}

export async function cachedLicense(accountId) {
  try {
    const all = (await kvGet(STORAGE_KEYS.licenseCache, null)) || {};
    return all[String(accountId)] || null;
  } catch (e) { return null; }
}

/* ------------------------- mutations (owner / self) ------------------- */
/* Each mutates vault.index in place; caller must await vault.publishIndex(). */

export function applyClaim(vault, key, accountId, accountName) {
  const l = findLicense(vault.index, key);
  if (!l) throw new Error("License key not found. Check the code and try again.");
  if (l.status !== "active") throw new Error("This license has been revoked.");
  if (l.accountId && l.accountId !== String(accountId))
    throw new Error("This license is already used by another account.");
  l.accountId = String(accountId);
  l.accountName = String(accountName || "");
  const monthlyDays = (vault.cfg && vault.cfg.plans && vault.cfg.plans.monthlyDays) || 30;
  if (l.type === "monthly" && !l.expiresAt) l.expiresAt = monthlyExpiryFrom(Date.now(), monthlyDays);
  return l;
}

export function applyCreateLicense(vault, { type, accountId, accountName, note }) {
  const monthlyDays = (vault.cfg && vault.cfg.plans && vault.cfg.plans.monthlyDays) || 30;
  const now = Date.now();
  const l = normalizeLicense({
    key: makeLicenseKey(),
    type: type === "monthly" ? "monthly" : "lifetime",
    accountId: accountId ? String(accountId) : null,
    accountName: String(accountName || ""),
    createdAt: now,
    expiresAt: type === "monthly" ? monthlyExpiryFrom(now, monthlyDays) : 0,
    status: "active",
    note: String(note || ""),
  });
  vault.index.licenses = licensesOf(vault.index).concat([l]).slice(-(vault.cfg.maxLicenses || 2000));
  return l;
}

export function applyRevoke(vault, key) {
  const l = findLicense(vault.index, key);
  if (!l) throw new Error("License not found.");
  l.status = "revoked";
  return l;
}

export function applyActivationRequest(vault, { accountId, accountName, plan, ref, sender, amount }) {
  const cleanRef = String(ref || "").trim();
  if (!cleanRef) throw new Error("Enter your GCash reference number.");
  const dupe = activationsOf(vault.index).some(
    (a) => a.accountId === String(accountId) && a.status === "pending",
  );
  if (dupe) throw new Error("You already have a pending request. Please wait for approval.");
  const a = normalizeActivation({
    accountId: String(accountId),
    accountName: String(accountName || ""),
    plan: plan === "monthly" ? "monthly" : "lifetime",
    ref: cleanRef,
    sender: String(sender || ""),
    amount: Number(amount) || 0,
    status: "pending",
    createdAt: Date.now(),
  });
  vault.index.activations = activationsOf(vault.index).concat([a]).slice(-(vault.cfg.maxActivations || 500));
  return a;
}

export function applyDecideActivation(vault, id, approve) {
  const a = activationsOf(vault.index).find((x) => x.id === String(id));
  if (!a) throw new Error("Request not found.");
  if (a.status !== "pending") throw new Error("Request already decided.");
  a.status = approve ? "approved" : "rejected";
  a.decidedAt = Date.now();
  let license = null;
  if (approve) {
    license = applyCreateLicense(vault, {
      type: a.plan,
      accountId: a.accountId,
      accountName: a.accountName,
      note: `GCash ${a.ref}`,
    });
  }
  return { activation: a, license };
}
