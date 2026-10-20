/* KamsClouds customer-service chat — Telegram-backed, no extra server.
 *
 * Storage: `supportMsgs` array on the shared index document:
 *   [{ id, accId, accName, from:'user'|'admin', text, at }]
 * Capped (cfg.support.maxMsgs, default 500, oldest dropped).
 *
 * - Any signed-in account can write a 'user' message for its own accId.
 * - Only the owner (admin app, unlocked with ADMIN_PASS) may write 'admin'.
 *   Enforcement is by UI + admin gate; the index itself is readable by anyone
 *   with the bot token, same as file names today — chat text should not carry
 *   passwords.
 */

import { kvGet, kvSet } from "./platform.js";
import { STORAGE_KEYS } from "./config.js";

export function normalizeSupportMsg(m) {
  const o = Object.assign({}, m);
  o.id = String(o.id || ("sm_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)));
  o.accId = String(o.accId || "");
  o.accName = String(o.accName || "");
  o.from = o.from === "admin" ? "admin" : "user";
  o.text = String(o.text || "").slice(0, 2000);
  o.at = Number(o.at) || Date.now();
  return o;
}

export function supportMsgsOf(index) {
  if (!index || !Array.isArray(index.supportMsgs)) return [];
  return index.supportMsgs;
}

export function threadFor(index, accId) {
  return supportMsgsOf(index)
    .filter((m) => m.accId === String(accId))
    .sort((a, b) => Number(a.at) - Number(b.at));
}

/* Admin overview: one row per account, newest message last, unanswered first. */
export function threadsOverview(index) {
  const by = new Map();
  for (const m of supportMsgsOf(index)) {
    if (!m.accId) continue;
    if (!by.has(m.accId)) by.set(m.accId, { accId: m.accId, accName: m.accName || "Account", msgs: [] });
    const t = by.get(m.accId);
    if (m.accName) t.accName = m.accName;
    t.msgs.push(m);
  }
  const rows = [...by.values()].map((t) => {
    t.msgs.sort((a, b) => Number(a.at) - Number(b.at));
    t.lastAt = Number(t.msgs[t.msgs.length - 1].at) || 0;
    t.count = t.msgs.length;
    const last = t.msgs[t.msgs.length - 1];
    t.needsReply = last && last.from === "user";
    t.lastText = last ? last.text : "";
    return t;
  });
  rows.sort((a, b) => {
    if (!!a.needsReply !== !!b.needsReply) return a.needsReply ? -1 : 1;
    return b.lastAt - a.lastAt;
  });
  return rows;
}

export function unreadUserCount(index, accId, lastReadAt) {
  const lr = Number(lastReadAt) || 0;
  return threadFor(index, accId).filter((m) => m.from === "admin" && Number(m.at) > lr).length;
}

/* ------------------------- local read watermarks ---------------------- */

export async function getReadMap() {
  try {
    return (await kvGet(STORAGE_KEYS.supportRead, null)) || {};
  } catch (e) { return {}; }
}

export async function markThreadRead(accId, at) {
  try {
    const m = await getReadMap();
    m[String(accId)] = Number(at || Date.now());
    await kvSet(STORAGE_KEYS.supportRead, m);
  } catch (e) { /* ignore */ }
}

/* ------------------------- mutations ---------------------------------- */
/* Mutate vault.index in place; caller must await vault.publishIndex(). */

export function applyUserMessage(vault, accountId, accountName, text) {
  const clean = String(text || "").trim();
  if (!clean) throw new Error("Type a message first.");
  const maxText = (vault.cfg && vault.cfg.support && vault.cfg.support.maxText) || 2000;
  if (clean.length > maxText) throw new Error(`Message too long (max ${maxText} chars).`);
  const m = normalizeSupportMsg({
    accId: String(accountId),
    accName: String(accountName || ""),
    from: "user",
    text: clean,
    at: Date.now(),
  });
  const maxMsgs = (vault.cfg && vault.cfg.support && vault.cfg.support.maxMsgs) || 500;
  vault.index.supportMsgs = supportMsgsOf(vault.index).concat([m]).slice(-maxMsgs);
  return m;
}

export function applyAdminMessage(vault, accId, text) {
  const clean = String(text || "").trim();
  if (!clean) throw new Error("Type a reply first.");
  const maxText = (vault.cfg && vault.cfg.support && vault.cfg.support.maxText) || 2000;
  if (clean.length > maxText) throw new Error(`Reply too long (max ${maxText} chars).`);
  const m = normalizeSupportMsg({
    accId: String(accId),
    accName: "",
    from: "admin",
    text: clean,
    at: Date.now(),
  });
  const maxMsgs = (vault.cfg && vault.cfg.support && vault.cfg.support.maxMsgs) || 500;
  vault.index.supportMsgs = supportMsgsOf(vault.index).concat([m]).slice(-maxMsgs);
  return m;
}
