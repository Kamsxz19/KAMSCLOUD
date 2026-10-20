import { STORAGE_KEYS } from "./config.js";
import { kvGet as pfGet, kvSet as pfSet, kvDel as pfDel } from "./platform.js";
import { bytesToBase64, base64ToBytes } from "./util.js";
import {
  uid, randomHex, pbkdf2Hex, timingSafeEqualHex, pickColor,
  generateMasterKey, wrapMasterKey, unwrapMasterKey, importAesKey,
  aesEncrypt, aesDecrypt,
} from "./crypto.js";

function pjsRoot() {
  return typeof window !== "undefined" ? window.root : globalThis.root;
}

/* Device-local cache. Delegates to platform.js so the same code runs on
 * Perchance (kv-plugin) and on GitHub Pages (IndexedDB + localStorage). */
async function kvGet(key, def = null) {
  try {
    return await pfGet(key, def);
  } catch (e) {
    console.warn("kvGet failed", key, e);
    return def;
  }
}

async function kvSet(key, val) {
  try {
    return await pfSet(key, val);
  } catch (e) {
    console.warn("kvSet failed", key, e);
    return false;
  }
}

async function kvDel(key) {
  try {
    await pfDel(key);
  } catch (e) { /* ignore */ }
}

/* The unwrapped master key is kept in sessionStorage only: it survives a reload
 * but disappears when the browser tab is closed, so a device that is picked up
 * later can read the drive's file list but not decrypt file contents. */
function encCacheKey(accountId) {
  return STORAGE_KEYS.encKey + accountId;
}
function cacheMasterKey(accountId, raw) {
  try { sessionStorage.setItem(encCacheKey(accountId), bytesToBase64(raw)); } catch (e) { /* ignore */ }
}
function readCachedMasterKey(accountId) {
  try {
    const v = sessionStorage.getItem(encCacheKey(accountId));
    return v ? base64ToBytes(v) : null;
  } catch (e) { return null; }
}
function clearCachedMasterKey(accountId) {
  try { sessionStorage.removeItem(encCacheKey(accountId)); } catch (e) { /* ignore */ }
}

/* Share links carry their own wrapped copy of the master key (wrapped by the
 * link password), so a guest never gets the account password. The unwrapped
 * key is cached per share token in sessionStorage for the life of the tab. */
function shareKeyId(token) {
  return STORAGE_KEYS.shareUnlock + token;
}
function cacheShareKey(token, raw) {
  try { sessionStorage.setItem(shareKeyId(token), bytesToBase64(raw)); } catch (e) { /* ignore */ }
}
function readShareKey(token) {
  try {
    const v = sessionStorage.getItem(shareKeyId(token));
    return v ? base64ToBytes(v) : null;
  } catch (e) { return null; }
}
function clearShareKey(token) {
  try { sessionStorage.removeItem(shareKeyId(token)); } catch (e) { /* ignore */ }
}

export function parseIndexText(text) {
  if (!text) return null;
  const t = String(text).trim();
  const nl = t.indexOf("\n");
  const header = nl >= 0 ? t.slice(0, nl) : t;
  if (!/PERCHANCE_DRIVE_INDEX/.test(header)) return null;
  const jsonPart = nl >= 0 ? t.slice(nl + 1).trim() : "";
  if (!jsonPart) return null;
  try {
    const obj = JSON.parse(jsonPart);
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) {
    return null;
  }
}

export function buildIndexText(prefix, obj) {
  return prefix + "\n" + JSON.stringify(obj);
}

function normalizeAccount(a) {
  const acc = Object.assign({}, a);
  acc.id = String(acc.id || uid("acc_"));
  acc.name = String(acc.name || "Account");
  acc.salt = String(acc.salt || "");
  acc.hash = String(acc.hash || "");
  acc.it = Number(acc.it) || 120000;
  acc.color = acc.color || pickColor(acc.id);
  acc.createdAt = Number(acc.createdAt || acc.at || Date.now());
  acc.lastLogin = Number(acc.lastLogin || acc.at || 0);
  acc.enc = !!acc.enc;
  acc.wrapSalt = String(acc.wrapSalt || "");
  acc.wrapped = String(acc.wrapped || "");
  if (acc.drive && typeof acc.drive === "object") {
    acc.drive = {
      mid: acc.drive.mid != null ? Number(acc.drive.mid) : null,
      fid: acc.drive.fid || null,
      rev: Number(acc.drive.rev) || 0,
      size: Number(acc.drive.size) || 0,
      at: Number(acc.drive.at || acc.driveAt || 0),
    };
  } else {
    acc.drive = null;
  }
  delete acc.at;
  delete acc.driveAt;
  delete acc.adopted;
  return acc;
}

export function normalizeShare(s) {
  const out = Object.assign({}, s || {});
  out.token = String(out.token || "");
  out.accId = String(out.accId || "");
  out.nodeId = String(out.nodeId || "");
  out.perm = out.perm === "edit" ? "edit" : "view";
  out.label = String(out.label || "");
  out.name = String(out.name || "");
  out.enc = !!out.enc;
  out.wrapSalt = out.wrapSalt || "";
  out.wrapped = out.wrapped || "";
  out.created = Number(out.created) || Date.now();
  out.expiresAt = Number(out.expiresAt) || 0;
  return out;
}

export function normalizeIndex(raw, cfg) {
  const idx = Object.assign({}, raw || {});
  idx.v = 2;
  idx.kind = raw && raw.kind ? raw.kind : cfg.indexKind;
  idx.accounts = Array.isArray(raw && raw.accounts) ? raw.accounts.map(normalizeAccount) : [];
  idx.shares = Array.isArray(raw && raw.shares)
    ? raw.shares.map(normalizeShare).filter((s) => s.token && s.accId && s.nodeId)
    : [];
  // KamsClouds additions (safe on old indexes: default to empty arrays)
  try {
    const lic = Array.isArray(raw && raw.licenses) ? raw.licenses : [];
    idx.licenses = lic.map((l) => {
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
    }).filter((l) => l.key);
  } catch (e) { idx.licenses = []; }
  try {
    const act = Array.isArray(raw && raw.activations) ? raw.activations : [];
    idx.activations = act.map((a) => {
      const o = Object.assign({}, a);
      o.id = String(o.id || ("act_" + Date.now().toString(36)));
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
    }).filter((a) => a.accountId);
  } catch (e) { idx.activations = []; }
  try {
    const sm = Array.isArray(raw && raw.supportMsgs) ? raw.supportMsgs : [];
    const maxText = 2000;
    idx.supportMsgs = sm.map((m) => {
      const o = Object.assign({}, m);
      o.id = String(o.id || ("sm_" + Date.now().toString(36)));
      o.accId = String(o.accId || "");
      o.accName = String(o.accName || "");
      o.from = o.from === "admin" ? "admin" : "user";
      o.text = String(o.text || "").slice(0, maxText);
      o.at = Number(o.at) || Date.now();
      return o;
    }).filter((m) => m.accId && m.text);
  } catch (e) { idx.supportMsgs = []; }
  idx.rev = Number(idx.rev) || 0;
  idx.createdAt = Number(idx.createdAt) || Date.now();
  idx.updatedAt = Number(idx.updatedAt) || Date.now();
  delete idx.head;
  return idx;
}

export function emptyIndex(cfg) {
  return { v: 2, kind: cfg.indexKind, rev: 0, createdAt: Date.now(), updatedAt: Date.now(), accounts: [], shares: [], licenses: [], activations: [], supportMsgs: [] };
}

export function newDrive(acc, cfg) {
  return {
    v: 1,
    kind: cfg.driveKind,
    rev: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    owner: { id: acc.id, name: acc.name },
    folders: [],
    files: [],
  };
}

function normalizeNode(n, isFile) {
  const out = {
    id: String(n.id || uid(isFile ? "d_" : "f_")),
    name: String(n.name || (isFile ? "untitled" : "New folder")),
    parentId: n.parentId || "root",
    createdAt: Number(n.createdAt) || Date.now(),
    modifiedAt: Number(n.modifiedAt || n.createdAt) || Date.now(),
    starred: !!n.starred,
    trashed: !!n.trashed,
  };
  if (isFile) {
    out.kind = n.kind || "file";
    out.mime = n.mime || "application/octet-stream";
    out.size = Number(n.size) || 0;
    out.thumb = n.thumb || null;
    out.thumbMid = n.thumbMid != null ? Number(n.thumbMid) : null;
    out.enc = !!n.enc;
    out.versions = Array.isArray(n.versions) ? n.versions.map((v) => ({
      id: String((v && v.id) || uid("v_")),
      parts: Array.isArray(v && v.parts) ? v.parts.map((p) => ({
        mid: p.mid != null ? Number(p.mid) : null,
        fid: p.fid || null,
        size: Number(p.size) || 0,
        csize: Number(p.csize) || 0,
        crc: p && p.crc != null ? Number(p.crc) >>> 0 : null,
      })) : [],
      size: Number(v && v.size) || 0,
      thumb: (v && v.thumb) || null,
      thumbMid: v && v.thumbMid != null ? Number(v.thumbMid) : null,
      mime: (v && v.mime) || null,
      createdAt: Number(v && v.createdAt) || Date.now(),
    })) : [];
    out.parts = Array.isArray(n.parts) ? n.parts.map((p) => ({
      mid: p.mid != null ? Number(p.mid) : null,
      fid: p.fid || null,
      size: Number(p.size) || 0,
      csize: Number(p.csize) || 0,
      crc: p && p.crc != null ? Number(p.crc) >>> 0 : null,
    })) : [];
    out.path = n.path || null;
    out.pathAt = Number(n.pathAt) || 0;
  } else {
    out.color = n.color || null;
  }
  return out;
}

export function normalizeDrive(d, acc, cfg) {
  const out = Object.assign({}, d || {});
  out.v = 1;
  out.kind = (d && d.kind) || cfg.driveKind;
  out.rev = Number(out.rev) || 0;
  out.createdAt = Number(out.createdAt) || Date.now();
  out.updatedAt = Number(out.updatedAt) || Date.now();
  out.owner = { id: acc.id, name: acc.name };
  out.folders = Array.isArray(d && d.folders) ? d.folders.map((f) => normalizeNode(f, false)) : [];
  out.files = Array.isArray(d && d.files) ? d.files.map((f) => normalizeNode(f, true)) : [];
  out.log = Array.isArray(d && d.log) ? d.log.slice(-(cfg.maxLogEntries || 400)) : [];
  return out;
}

function mergeNodes(a, b) {
  const map = new Map();
  for (const n of (a || [])) map.set(n.id, n);
  for (const n of (b || [])) {
    const cur = map.get(n.id);
    if (!cur) { map.set(n.id, n); continue; }
    if ((Number(n.modifiedAt) || 0) > (Number(cur.modifiedAt) || 0)) map.set(n.id, n);
  }
  return [...map.values()];
}

function mergeLogs(a, b, cfg) {
  const seen = new Set();
  const all = [];
  for (const e of [...(a || []), ...(b || [])]) {
    const k = `${e.at}|${e.kind}|${e.name}|${e.size}`;
    if (seen.has(k)) continue;
    seen.add(k);
    all.push(e);
  }
  all.sort((x, y) => (Number(x.at) || 0) - (Number(y.at) || 0));
  return all.slice(-(cfg.maxLogEntries || 400));
}

/** Node-level union of two drive documents. Concurrent edits resolve to the
 *  newer `modifiedAt`; concurrent additions are all kept. (A concurrent delete
 *  on one device can be undone by the other device's copy — documented.) */
export function mergeDrives(local, remote, cfg) {
  const out = Object.assign({}, local);
  out.folders = mergeNodes(local.folders, remote.folders);
  out.files = mergeNodes(local.files, remote.files);
  out.log = mergeLogs(local.log, remote.log, cfg);
  out.rev = Math.max(Number(local.rev) || 0, Number(remote.rev) || 0);
  out.updatedAt = Math.max(Number(local.updatedAt) || 0, Number(remote.updatedAt) || 0);
  return out;
}

/** Union of two indexes: newest drive pointer per account, newest share per token.
 *  Entries present in `tomb` (deleted accounts / revoked links on this device)
 *  are never re-added, so a stale copy elsewhere cannot resurrect them. */
export function mergeIndexes(local, remote, cfg, tomb) {
  const deadAcc = new Set((tomb && tomb.accounts) || []);
  const deadShare = new Set((tomb && tomb.shares) || []);
  const out = normalizeIndex(local, cfg);
  const byId = new Map(out.accounts.filter((a) => !deadAcc.has(a.id)).map((a) => [a.id, a]));
  for (const ra of remote.accounts) {
    if (deadAcc.has(ra.id)) continue;
    const la = byId.get(ra.id);
    if (!la) { byId.set(ra.id, ra); continue; }
    const lrev = la.drive ? Number(la.drive.rev) || 0 : -1;
    const rrev = ra.drive ? Number(ra.drive.rev) || 0 : -1;
    if (rrev > lrev) byId.set(ra.id, ra);
  }
  out.accounts = [...byId.values()];
  const byTok = new Map((out.shares || []).filter((s) => !deadShare.has(s.token)).map((s) => [s.token, s]));
  for (const rs of (remote.shares || [])) {
    if (deadShare.has(rs.token)) continue;
    const ls = byTok.get(rs.token);
    if (!ls || (Number(rs.created) || 0) >= (Number(ls.created) || 0)) byTok.set(rs.token, rs);
  }
  out.shares = [...byTok.values()];
  // KamsClouds: licenses keyed by key (newest createdAt wins; revoked sticks),
  // activations keyed by id (newest decidedAt/createdAt wins), support messages
  // unioned by id (append-only, capped).
  try {
    const byKey = new Map((out.licenses || []).map((l) => [String(l.key), l]));
    for (const rl of (remote.licenses || [])) {
      const k = String(rl.key);
      const ll = byKey.get(k);
      if (!ll) { byKey.set(k, rl); continue; }
      // revoked always wins (so a revoke propagates even if older)
      if (rl.status === "revoked" && ll.status !== "revoked") { byKey.set(k, rl); continue; }
      if (ll.status === "revoked" && rl.status !== "revoked") continue;
      if ((Number(rl.createdAt) || 0) >= (Number(ll.createdAt) || 0)) byKey.set(k, rl);
    }
    out.licenses = [...byKey.values()];
  } catch (e) { /* keep local */ }
  try {
    const byAct = new Map((out.activations || []).map((a) => [String(a.id), a]));
    for (const ra of (remote.activations || [])) {
      const id = String(ra.id);
      const la = byAct.get(id);
      if (!la) { byAct.set(id, ra); continue; }
      const rt = Math.max(Number(ra.decidedAt) || 0, Number(ra.createdAt) || 0);
      const lt = Math.max(Number(la.decidedAt) || 0, Number(la.createdAt) || 0);
      if (rt >= lt) byAct.set(id, ra);
    }
    out.activations = [...byAct.values()].sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  } catch (e) { /* keep local */ }
  try {
    const seen = new Set((out.supportMsgs || []).map((m) => String(m.id)));
    const all = (out.supportMsgs || []).slice();
    for (const rm of (remote.supportMsgs || [])) {
      if (seen.has(String(rm.id))) continue;
      seen.add(String(rm.id));
      all.push(rm);
    }
    all.sort((a, b) => Number(a.at) - Number(b.at));
    const maxMsgs = 500;
    out.supportMsgs = all.slice(-maxMsgs);
  } catch (e) { /* keep local */ }
  out.rev = Math.max(Number(local.rev) || 0, Number(remote.rev) || 0);
  return out;
}

export class Vault {
  constructor(tg, cfg) {
    this.tg = tg;
    this.cfg = cfg;
    this.index = null;
    this.drive = null;
    this.accountId = null;
    this.pinnedMid = null;
    this.headMid = null;
    this.dirty = false;
    this.saving = false;
    this.listeners = new Set();
    this.encKey = null;
    this.masterRaw = null;
    this.keepVersions = true;
    this.shared = null;
    this.readOnly = false;
    this.status = {
      phase: "idle",
      indexLoaded: false,
      driveLoaded: false,
      online: navigator.onLine !== false,
      lastError: null,
      lastSavedAt: null,
      syncState: "idle",
      staleCache: false,
      needsUnlock: false,
    };
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of [...this.listeners]) {
      try { fn(this); } catch (e) { console.error("listener error", e); }
    }
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.emit();
  }

  get account() {
    return this.getAccount(this.accountId);
  }

  getAccount(id) {
    if (!this.index || !id) return null;
    return this.index.accounts.find((a) => a.id === id) || null;
  }

  findAccountByName(name) {
    if (!this.index) return null;
    const n = String(name || "").trim().toLowerCase();
    return this.index.accounts.find((a) => a.name.toLowerCase() === n) || null;
  }

  async downloadJson(fid) {
    const path = await this.tg.getFilePath(fid);
    const text = await this.tg.fetchText(path);
    return JSON.parse(text);
  }

  async boot() {
    this.setStatus({ phase: "loading" });
    await this.loadTombstones();
    try {
      await this.loadIndex();
    } catch (e) {
      this.setStatus({ phase: "error", lastError: e });
      this.emit();
      throw e;
    }
    const sess = await kvGet(STORAGE_KEYS.session, null);
    if (sess && sess.accountId && this.getAccount(sess.accountId)) {
      try {
        await this.openAccount(sess.accountId);
      } catch (e) {
        console.warn("auto session failed", e);
        await kvDel(STORAGE_KEYS.session);
      }
    }
    this.setStatus({ phase: "ready", indexLoaded: true });
    return this;
  }

  async resolveIndex(parsed) {
    if (parsed.head && parsed.head.fid) {
      try {
        const doc = await this.downloadJson(parsed.head.fid);
        if (doc && Array.isArray(doc.accounts)) {
          this.headMid = parsed.head.mid != null ? Number(parsed.head.mid) : null;
          return normalizeIndex(doc, this.cfg);
        }
      } catch (e) {
        console.warn("head doc download failed", e);
      }
    }
    if (Array.isArray(parsed.accounts)) {
      const idx = normalizeIndex(parsed, this.cfg);
      this.index = idx;
      try { await this.publishIndex(); } catch (e) { console.warn("legacy index migration publish failed", e); }
      return idx;
    }
    return emptyIndex(this.cfg);
  }

  async loadIndex() {
    let netErr = null;
    try {
      const chat = await this.tg.getChat();
      this.chat = chat || null;
      const pinned = chat && chat.pinned_message;
      const parsed = parseIndexText(pinned && pinned.text);
      if (parsed) {
        this.pinnedMid = pinned.message_id;
        this.index = await this.resolveIndex(parsed);
        await kvSet(STORAGE_KEYS.indexCache, this.index);
        this.setStatus({ lastError: null, staleCache: false });
        return this.index;
      }
      netErr = new Error("No KamsClouds index found in the pinned message");
    } catch (e) {
      netErr = e;
    }

    const cached = await kvGet(STORAGE_KEYS.indexCache, null);
    if (cached && Array.isArray(cached.accounts)) {
      this.index = normalizeIndex(cached, this.cfg);
      this.setStatus({ lastError: netErr, staleCache: true });
      try { await this.publishIndex(); } catch (e) { console.warn("re-publish failed", e); }
      return this.index;
    }
    if (netErr) throw netErr;
    this.index = emptyIndex(this.cfg);
    return this.index;
  }

  async publishIndex() {
    if (!this.index) return;
    const clean = Object.assign({}, this.index);
    delete clean.head;
    const tomb = await this.loadTombstones();
    if (tomb.accounts && tomb.accounts.length) {
      const dead = new Set(tomb.accounts);
      clean.accounts = (clean.accounts || []).filter((a) => !dead.has(a.id));
    }
    if (tomb.shares && tomb.shares.length) {
      const dead = new Set(tomb.shares);
      clean.shares = (clean.shares || []).filter((s) => !dead.has(s.token));
    }
    clean.rev = (Number(clean.rev) || 0) + 1;
    clean.updatedAt = Date.now();
    this.index.rev = clean.rev;
    this.index.updatedAt = clean.updatedAt;
    const json = JSON.stringify(clean);
    const blob = new Blob([json], { type: "application/json" });
    const oldHead = this.headMid;
    let res;
    try {
      res = await this.tg.sendDocument(this.cfg.chatId, blob, "tdrive-index.json", this.cfg.indexPrefix + ":HEAD");
    } catch (e) {
      res = await this.tg.sendDocument(this.cfg.chatId, blob, "tdrive-index.json", this.cfg.indexPrefix + ":HEAD");
    }
    if (!res || !res.document || !res.document.file_id) {
      const inline = JSON.stringify(clean);
      if (inline.length > 3800) throw new Error("Index too large for inline storage");
      const text = buildIndexText(this.cfg.indexPrefix, clean);
      await this.writePinnedText(text);
      return;
    }
    this.headMid = res.message_id;
    const text = buildIndexText(this.cfg.indexPrefix, {
      v: 2,
      kind: this.cfg.indexKind,
      rev: clean.rev,
      createdAt: clean.createdAt,
      updatedAt: clean.updatedAt,
      head: {
        mid: this.headMid,
        fid: res.document.file_id,
        size: res.document.file_size || json.length,
        at: Date.now(),
      },
    });
    await this.writePinnedText(text);
    if (oldHead && oldHead !== this.headMid) {
      this.tg.deleteMessage(this.cfg.chatId, oldHead).catch(() => {});
    }
    await kvSet(STORAGE_KEYS.indexCache, this.index);
    this.setStatus({ lastSavedAt: Date.now(), lastError: null });
  }

  async writePinnedText(text) {
    if (this.pinnedMid) {
      try {
        await this.tg.editMessageText(this.pinnedMid, text);
        return;
      } catch (e) {
        console.warn("editing pinned index failed; creating a new index message", e);
        this.pinnedMid = null;
      }
    }
    const sent = await this.tg.sendMessage(text);
    this.pinnedMid = sent.message_id;
    try { await this.tg.pinChatMessage(this.pinnedMid); } catch (e) { console.warn("pin failed", e); }
  }

  async openAccount(accountId) {
    const acc = this.getAccount(accountId);
    if (!acc) throw new Error("Account not found");
    this.accountId = accountId;
    this.setStatus({ phase: "loadingDrive" });

    const pending = await kvGet(STORAGE_KEYS.pending, null);
    const hasPending = !!(pending && pending.accountId === accountId);
    let drive = null;
    let fromCache = false;
    /* Unsaved local edits win over the server copy so an offline session is not
     * wiped on reload — scheduleSave() re-publishes them below. */
    if (hasPending) {
      const cached = await kvGet(STORAGE_KEYS.drivePrefix + accountId, null);
      if (cached) { drive = cached; fromCache = true; }
    }
    if (!drive && acc.drive && acc.drive.fid) {
      try {
        drive = await this.downloadJson(acc.drive.fid);
      } catch (e) {
        console.warn("drive doc fetch failed", e);
      }
    }
    if (!drive) {
      const cached = await kvGet(STORAGE_KEYS.drivePrefix + accountId, null);
      if (cached) { drive = cached; fromCache = true; }
    }
    if (!drive) drive = newDrive(acc, this.cfg);

    this.drive = normalizeDrive(drive, acc, this.cfg);
    if (acc.enc) {
      if (!this.encKey) {
        const cached = readCachedMasterKey(acc.id);
        if (cached && cached.length === 32) {
          try {
            this.masterRaw = cached;
            this.encKey = await importAesKey(cached);
          } catch (e) { this.encKey = null; this.masterRaw = null; }
        }
      }
    } else {
      this.encKey = null;
      this.masterRaw = null;
    }
    await kvSet(STORAGE_KEYS.session, { accountId, name: acc.name, at: Date.now() });
    await kvSet(STORAGE_KEYS.drivePrefix + accountId, this.drive);
    this.setStatus({
      phase: "ready",
      driveLoaded: true,
      indexLoaded: true,
      staleCache: fromCache,
      syncState: hasPending ? "pending" : "saved",
      needsUnlock: !!acc.enc && !this.encKey,
    });
    if (hasPending) this.scheduleSave();
    return this.drive;
  }

  async reloadDrive() {
    if (!this.accountId) return;
    const id = this.accountId;
    this.setStatus({ syncState: "syncing" });
    await this.loadIndex().catch((e) => console.warn(e));
    await this.openAccount(id);
  }

  async logOut() {
    this.dirty = false;
    clearTimeout(this._saveTimer);
    clearTimeout(this._retryTimer);
    const prev = this.accountId;
    if (prev) clearCachedMasterKey(prev);
    if (this.shared) clearShareKey(this.shared.token);
    this.shared = null;
    this.readOnly = false;
    this.encKey = null;
    this.masterRaw = null;
    this.accountId = null;
    this.drive = null;
    await kvDel(STORAGE_KEYS.session);
    this.setStatus({ driveLoaded: false, phase: "ready", syncState: "idle", needsUnlock: false });
  }

  async createAccount(name, password, opts = {}) {
    name = String(name || "").trim();
    const problem = validateCredentials(name, password);
    if (problem) throw new Error(problem);
    if (!this.index) await this.loadIndex();
    if (this.index.accounts.length >= this.cfg.maxAccounts) {
      throw new Error(`Account limit reached (max ${this.cfg.maxAccounts})`);
    }
    if (this.findAccountByName(name)) throw new Error("That account name is already taken");
    const salt = randomHex(this.cfg.saltBytes);
    const it = this.cfg.pbkdf2Iterations;
    const hash = await pbkdf2Hex(password, salt, it);
    const acc = {
      id: uid("acc_"),
      name,
      salt,
      hash,
      it,
      color: pickColor(name + randomHex(4)),
      createdAt: Date.now(),
      lastLogin: Date.now(),
      enc: false,
      wrapSalt: "",
      wrapped: "",
      drive: null,
    };
    if (opts.encrypt) {
      const master = generateMasterKey();
      acc.wrapSalt = randomHex(this.cfg.saltBytes);
      acc.wrapped = await wrapMasterKey(password, acc.wrapSalt, it, master);
      acc.enc = true;
      this.masterRaw = master;
      this.encKey = await importAesKey(master);
      cacheMasterKey(acc.id, master);
    }
    this.index.accounts.push(acc);
    await this.publishIndex();
    await this.openAccount(acc.id);
    return acc;
  }

  lock() {
    const id = this.accountId;
    if (id) clearCachedMasterKey(id);
    this.encKey = null;
    this.masterRaw = null;
    this.setStatus({ needsUnlock: !!(this.account && this.account.enc) });
  }

  /** Verifies the password and unlocks client-side encryption for this account. */
  async unlock(password) {
    const acc = this.account;
    if (!acc) throw new Error("Not signed in");
    if (!acc.enc) return true;
    if (!acc.wrapped || !acc.wrapSalt) throw new Error("This account has no encryption key stored");
    const hash = await pbkdf2Hex(password, acc.salt, acc.it || this.cfg.pbkdf2Iterations);
    if (!timingSafeEqualHex(hash, acc.hash)) throw new Error("Incorrect password");
    const master = await unwrapMasterKey(password, acc.wrapSalt, acc.it || this.cfg.pbkdf2Iterations, acc.wrapped);
    this.masterRaw = master;
    this.encKey = await importAesKey(master);
    cacheMasterKey(acc.id, master);
    this.setStatus({ needsUnlock: false });
    return true;
  }

  /** Verifies a password against an account without opening it. Works for
   *  plain accounts too (unlike unlock(), which no-ops when enc is false). */
  async checkPassword(accountId, password) {
    const acc = this.getAccount(accountId);
    if (!acc) throw new Error("Account not found");
    const it = acc.it || this.cfg.pbkdf2Iterations;
    const hash = await pbkdf2Hex(password, acc.salt, it);
    if (!timingSafeEqualHex(hash, acc.hash)) throw new Error("Incorrect password");
    return acc;
  }

  /** Temporarily switches the drive to `accountId`, runs `fn` there, then puts
   *  the previous session (including a guest/share view) back exactly as it was.
   *  Used to copy files into another account without losing where the user was. */
  async withAccount(accountId, password, fn) {
    const tacc = this.getAccount(accountId);
    if (!tacc) throw new Error("Account not found");
    if (!this.shared && this.accountId === accountId) return fn(this);

    clearTimeout(this._saveTimer);
    clearTimeout(this._retryTimer);
    try { await this.flushSaves(); } catch (e) { console.warn(e); }

    const snap = {
      accountId: this.accountId,
      drive: this.drive,
      shared: this.shared,
      readOnly: this.readOnly,
      encKey: this.encKey,
      masterRaw: this.masterRaw,
      syncState: this.status.syncState,
      staleCache: this.status.staleCache,
      session: await kvGet(STORAGE_KEYS.session, null),
      pending: await kvGet(STORAGE_KEYS.pending, null),
    };
    this.dirty = false;
    this.shared = null;
    this.readOnly = false;

    await this.openAccount(accountId);
    if (tacc.enc && !this.encKey) {
      if (!password) throw new Error("This account is encrypted — a password is required");
      const it = tacc.it || this.cfg.pbkdf2Iterations;
      const master = await unwrapMasterKey(password, tacc.wrapSalt, it, tacc.wrapped);
      this.masterRaw = master;
      this.encKey = await importAesKey(master);
      cacheMasterKey(tacc.id, master);
      this.setStatus({ needsUnlock: false });
    }

    let result = null, err = null;
    try {
      result = await fn(this);
    } catch (e) {
      err = e;
    }
    try { await this.flushSaves(); } catch (e) { console.warn(e); }
    clearTimeout(this._saveTimer);
    clearTimeout(this._retryTimer);
    this.dirty = false;

    this.accountId = snap.accountId;
    this.drive = snap.drive;
    this.shared = snap.shared;
    this.readOnly = snap.readOnly;
    this.encKey = snap.encKey;
    this.masterRaw = snap.masterRaw;
    if (snap.session) await kvSet(STORAGE_KEYS.session, snap.session); else await kvDel(STORAGE_KEYS.session);
    if (snap.pending) await kvSet(STORAGE_KEYS.pending, snap.pending); else await kvDel(STORAGE_KEYS.pending);
    this.setStatus({ phase: "ready", driveLoaded: !!snap.drive, syncState: snap.syncState, staleCache: snap.staleCache });
    this.emit();

    if (err) throw err;
    return result;
  }

  /** Re-encrypts every file with a brand-new master key and drops all existing
   *  share links. Rotating the key is the only way to actually revoke access to
   *  ciphertext that has already been handed out with a link password. */
  async rotateEncryptionKey(password, onProgress) {
    const acc = this.account;
    if (!acc) throw new Error("Not signed in");
    if (!acc.enc) throw new Error("This drive is not encrypted");
    const it = acc.it || this.cfg.pbkdf2Iterations;
    const hash = await pbkdf2Hex(password, acc.salt, it);
    if (!timingSafeEqualHex(hash, acc.hash)) throw new Error("Incorrect password");
    const oldKey = this.encKey;
    if (!oldKey) throw new Error("Unlock the drive before rotating its key");

    const newMaster = generateMasterKey();
    const newKey = await importAesKey(newMaster);
    const env = [];
    let failed = 0;
    for (const f of this.drive.files) {
      if (!f.enc || !(f.parts || []).length) continue;
      env.push(f);
    }
    let done = 0;
    for (const f of env) {
      const newParts = [];
      try {
        for (let i = 0; i < f.parts.length; i++) {
          const p = f.parts[i];
          const path = await this.tg.getFilePath(p.fid);
          const raw = await this.tg.fetchBytes(path);
          const plain = await aesDecrypt(oldKey, new Uint8Array(raw));
          const enc = await aesEncrypt(newKey, plain);
          const res = await this.tg.sendDocument(
            this.cfg.chatId,
            new Blob([enc]),
            `${f.name}.tdrive${i + 1}-${f.parts.length}.bin`,
            `${this.cfg.indexPrefix}:PART:ENC`,
          );
          newParts.push({ mid: res.message_id, fid: res.document.file_id, size: p.size, csize: res.document.file_size || enc.byteLength, crc: p.crc != null ? p.crc : null, path: null, pathAt: 0 });
        }
        for (const p of f.parts) if (p.mid) this.tg.deleteMessage(this.cfg.chatId, p.mid).catch(() => {});
        for (const v of f.versions || []) {
          for (const vp of v.parts || []) if (vp.mid) this.tg.deleteMessage(this.cfg.chatId, vp.mid).catch(() => {});
          if (v.thumbMid) this.tg.deleteMessage(this.cfg.chatId, v.thumbMid).catch(() => {});
        }
        f.parts = newParts;
        f.versions = [];
      } catch (e) {
        failed += 1;
        console.warn("re-key failed for", f.name, e);
      }
      done += 1;
      if (onProgress) { try { onProgress(done, env.length, f.name); } catch (e2) { /* ignore */ } }
    }

    acc.wrapSalt = randomHex(this.cfg.saltBytes);
    acc.wrapped = await wrapMasterKey(password, acc.wrapSalt, it, newMaster);
    this.masterRaw = newMaster;
    this.encKey = newKey;
    cacheMasterKey(acc.id, newMaster);

    const mine = (this.index.shares || []).filter((s) => s.accId === this.accountId);
    for (const s of mine) await this.addTombstone("shares", s.token);
    this.index.shares = (this.index.shares || []).filter((s) => s.accId !== this.accountId);

    this.logEvent("password", `Encryption key rotated (${env.length - failed}/${env.length} files)`, 0);
    this.scheduleSave();
    await this.flushSaves();
    return { files: env.length, failed, linksRevoked: mine.length };
  }

  async changePassword(oldPassword, newPassword) {
    const acc = this.account;
    if (!acc) throw new Error("Not signed in");
    const oldHash = await pbkdf2Hex(oldPassword, acc.salt, acc.it || this.cfg.pbkdf2Iterations);
    if (!timingSafeEqualHex(oldHash, acc.hash)) throw new Error("Current password is incorrect");
    const problem = validateCredentials(acc.name, newPassword);
    if (problem) throw new Error(problem.replace("Account name", "Password"));
    const salt = randomHex(this.cfg.saltBytes);
    const it = this.cfg.pbkdf2Iterations;
    acc.salt = salt;
    acc.it = it;
    acc.hash = await pbkdf2Hex(newPassword, salt, it);
    if (acc.enc) {
      const master = this.masterRaw || readCachedMasterKey(acc.id);
      if (!master) throw new Error("Unlock this drive before changing its password");
      acc.wrapSalt = randomHex(this.cfg.saltBytes);
      acc.wrapped = await wrapMasterKey(newPassword, acc.wrapSalt, it, master);
      cacheMasterKey(acc.id, master);
    }
    await this.publishIndex();
    this.logEvent("password", "Password changed", 0);
    return true;
  }

  async deleteAccount(id, password) {
    const acc = this.getAccount(id);
    if (!acc) throw new Error("Account not found");
    if (password != null) {
      const hash = await pbkdf2Hex(password, acc.salt, acc.it || this.cfg.pbkdf2Iterations);
      if (!timingSafeEqualHex(hash, acc.hash)) throw new Error("Incorrect password");
    }
    let doomed = [];
    if (acc.drive && acc.drive.fid) {
      try {
        const d = await this.downloadJson(acc.drive.fid);
        doomed = Array.isArray(d.files) ? d.files : [];
      } catch (e) { console.warn("could not read drive doc during delete", e); }
    }
    if (id === this.accountId) await this.logOut();
    clearCachedMasterKey(id);
    await this.addTombstone("accounts", id);
    this.index.accounts = this.index.accounts.filter((a) => a.id !== id);
    await this.publishIndex();
    await kvDel(STORAGE_KEYS.drivePrefix + id);
    for (const f of doomed) {
      for (const p of f.parts || []) if (p.mid) this.tg.deleteMessage(this.cfg.chatId, p.mid).catch(() => {});
      for (const v of f.versions || []) {
        for (const p of v.parts || []) if (p.mid) this.tg.deleteMessage(this.cfg.chatId, p.mid).catch(() => {});
        if (v.thumbMid) this.tg.deleteMessage(this.cfg.chatId, v.thumbMid).catch(() => {});
      }
      if (f.thumbMid) this.tg.deleteMessage(this.cfg.chatId, f.thumbMid).catch(() => {});
    }
    if (acc.drive && acc.drive.mid) this.tg.deleteMessage(this.cfg.chatId, acc.drive.mid).catch(() => {});
    return true;
  }

  /* ------------------------------------------------------------- shares */

  async loadTombstones() {
    if (this.tombstones) return this.tombstones;
    let t = await kvGet(STORAGE_KEYS.tombstones, null);
    if (!t || typeof t !== "object") t = { accounts: [], shares: [] };
    if (!Array.isArray(t.accounts)) t.accounts = [];
    if (!Array.isArray(t.shares)) t.shares = [];
    this.tombstones = t;
    return t;
  }

  async addTombstone(kind, id) {
    const t = await this.loadTombstones();
    const arr = t[kind] || (t[kind] = []);
    if (!arr.includes(id)) arr.push(id);
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    t.at = Date.now();
    await kvSet(STORAGE_KEYS.tombstones, t);
  }

  listShares() {
    if (!this.index) return [];
    return (this.index.shares || []).filter((s) => s.accId === this.accountId);
  }

  sharesForNode(nodeId) {
    return this.listShares().filter((s) => s.nodeId === nodeId);
  }

  shareByToken(token) {
    if (!this.index || !token) return null;
    return (this.index.shares || []).find((s) => s.token === token) || null;
  }

  shareStatus(share) {
    if (!share) return "missing";
    if (share.expiresAt && Number(share.expiresAt) < Date.now()) return "expired";
    return "active";
  }

  /** True when a node is reachable from the currently shared subtree. */
  inSharedScope(nodeId) {
    if (!this.shared) return true;
    if (nodeId === "root") return this.shared.rootId === "root";
    const root = this.shared.rootId;
    if (root === "root") return true;
    return nodeId === root || this.isAncestor(root, nodeId);
  }

  async createShare(nodeId, perm, opts = {}) {
    if (!this.index) await this.loadIndex();
    const node = this.getNode(nodeId);
    if (!node) throw new Error("Item not found");
    const share = {
      token: randomHex(this.cfg.shareTokenBytes || 16),
      accId: this.accountId,
      nodeId,
      perm: perm === "edit" ? "edit" : "view",
      created: Date.now(),
      expiresAt: Number(opts.expiresAt) || 0,
      label: node.name,
      name: String(opts.name || "").slice(0, 60),
      enc: !!this.encKey,
      wrapSalt: "",
      wrapped: "",
    };
    if (this.encKey) {
      if (!opts.password || String(opts.password).length < 4) {
        throw new Error("This drive is encrypted — set a link password (4+ characters)");
      }
      share.wrapSalt = randomHex(this.cfg.saltBytes);
      share.wrapped = await wrapMasterKey(opts.password, share.wrapSalt, this.cfg.pbkdf2Iterations, this.masterRaw);
    }
    this.index.shares.push(share);
    await this.publishIndex();
    this.logEvent("share", `shared "${node.name}" (${share.perm === "edit" ? "editor" : "viewer"})`, 0);
    return share;
  }

  async updateShare(token, patch = {}) {
    const s = this.shareByToken(token);
    if (!s) throw new Error("Share not found");
    if (s.accId !== this.accountId) throw new Error("Not your share");
    if (patch.perm) s.perm = patch.perm === "edit" ? "edit" : "view";
    if (patch.expiresAt !== undefined) s.expiresAt = Number(patch.expiresAt) || 0;
    if (patch.password) {
      if (!this.encKey) throw new Error("This drive is not encrypted");
      s.wrapSalt = randomHex(this.cfg.saltBytes);
      s.wrapped = await wrapMasterKey(patch.password, s.wrapSalt, this.cfg.pbkdf2Iterations, this.masterRaw);
    }
    await this.publishIndex();
    return s;
  }

  async revokeShare(token) {
    if (!this.index) await this.loadIndex();
    const share = this.shareByToken(token);
    if (!share) return false;
    this.index.shares = (this.index.shares || []).filter((s) => s.token !== token);
    await this.addTombstone("shares", token);
    clearShareKey(token);
    await this.publishIndex();
    return true;
  }

  async resolveShare(token) {
    if (!this.index) await this.loadIndex();
    const share = this.shareByToken(token);
    if (!share) return { status: "missing", share: null };
    if (this.shareStatus(share) === "expired") return { status: "expired", share };
    const acc = this.getAccount(share.accId);
    if (!acc) return { status: "no-owner", share };
    return { status: "active", share, account: acc };
  }

  /** Opens an owner's drive as a guest, without signing in or touching the session. */
  async openSharedDrive(share) {
    const acc = this.getAccount(share.accId);
    if (!acc) throw new Error("The owner account no longer exists");
    this.accountId = share.accId;
    this.shared = {
      token: share.token,
      accId: share.accId,
      perm: share.perm,
      nodeId: share.nodeId,
      label: share.label,
      ownerName: acc.name,
      ownerColor: acc.color,
      isFile: false,
      fileId: null,
      rootId: "root",
    };
    this.readOnly = share.perm !== "edit";
    this.setStatus({ phase: "loadingDrive" });

    let drive = null;
    if (acc.drive && acc.drive.fid) {
      try { drive = await this.downloadJson(acc.drive.fid); } catch (e) { console.warn("shared drive fetch failed", e); }
    }
    if (!drive) {
      const cached = await kvGet(STORAGE_KEYS.drivePrefix + share.accId, null);
      if (cached) drive = cached;
    }
    if (!drive) throw new Error("Could not load the shared drive");
    this.drive = normalizeDrive(drive, acc, this.cfg);

    this.encKey = null;
    this.masterRaw = null;
    if (acc.enc) {
      const cached = readShareKey(share.token);
      if (cached && cached.length === 32) {
        try { this.masterRaw = cached; this.encKey = await importAesKey(cached); } catch (e) { this.encKey = null; this.masterRaw = null; }
      }
    }

    const node = this.getNode(share.nodeId);
    if (node && this.drive.files.includes(node)) {
      this.shared.isFile = true;
      this.shared.fileId = node.id;
    } else if (node) {
      this.shared.rootId = node.id;
    }
    this.setStatus({
      phase: "ready",
      driveLoaded: true,
      indexLoaded: true,
      staleCache: false,
      syncState: "idle",
      needsUnlock: !!acc.enc && !this.encKey,
    });
    return this.drive;
  }

  async unlockShare(password) {
    const share = this.shared && this.shareByToken(this.shared.token);
    if (!share) throw new Error("Share not found");
    if (!share.enc) return true;
    if (!share.wrapped || !share.wrapSalt) throw new Error("This link has no key to unlock");
    let master;
    try {
      master = await unwrapMasterKey(password, share.wrapSalt, this.cfg.pbkdf2Iterations, share.wrapped);
    } catch (e) {
      throw new Error("Incorrect password");
    }
    this.masterRaw = master;
    this.encKey = await importAesKey(master);
    cacheShareKey(share.token, master);
    this.setStatus({ needsUnlock: false });
    return true;
  }

  leaveShared() {
    if (this.shared) clearShareKey(this.shared.token);
    this.shared = null;
    this.readOnly = false;
    this.encKey = null;
    this.masterRaw = null;
    this.accountId = null;
    this.drive = null;
    this.setStatus({ driveLoaded: false, phase: "ready", syncState: "idle", needsUnlock: false });
  }

  /** Re-fetches the shared drive document so guests see the owner's latest changes.
   *  Returns { ok, gone } — `gone` when the link was revoked or expired since load. */
  async refreshShared() {
    if (!this.shared) return { ok: false, gone: false };
    const token = this.shared.token;
    try {
      await this.loadIndex();
      const share = this.shareByToken(token);
      if (!share || this.shareStatus(share) !== "active") return { ok: false, gone: true };
    } catch (e) {
      /* network hiccup re-checking the link — keep showing what we have */
    }
    const acc = this.getAccount(this.shared.accId);
    if (!acc || !acc.drive || !acc.drive.fid) return { ok: false, gone: false };
    const raw = await this.downloadJson(acc.drive.fid);
    if (!raw || !Array.isArray(raw.files)) return { ok: false, gone: false };
    this.drive = normalizeDrive(raw, acc, this.cfg);
    const node = this.getNode(this.shared.nodeId);
    if (node && this.drive.files.includes(node)) {
      this.shared.isFile = true;
      this.shared.fileId = node.id;
    } else if (node) {
      this.shared.isFile = false;
      this.shared.fileId = null;
      this.shared.rootId = node.id;
    } else {
      return { ok: false, gone: true };
    }
    this.shared.label = node.name;
    return { ok: true, gone: false };
  }

  async login(name, password) {
    if (!this.index) await this.loadIndex();
    const acc = this.findAccountByName(name);
    if (!acc) throw new Error("No account with that name on this drive");
    const it = acc.it || this.cfg.pbkdf2Iterations;
    const hash = await pbkdf2Hex(password, acc.salt, it);
    if (!timingSafeEqualHex(hash, acc.hash)) throw new Error("Incorrect password");
    if (acc.enc) {
      const master = await unwrapMasterKey(password, acc.wrapSalt, it, acc.wrapped);
      this.masterRaw = master;
      this.encKey = await importAesKey(master);
      cacheMasterKey(acc.id, master);
    } else {
      this.masterRaw = null;
      this.encKey = null;
    }
    acc.lastLogin = Date.now();
    try { await this.publishIndex(); } catch (e) { console.warn(e); }
    await this.openAccount(acc.id);
    return acc;
  }

  scheduleSave() {
    if (this.readOnly) return;
    this.dirty = true;
    this.setStatus({ syncState: "pending" });
    /* Persist the in-memory drive immediately so edits made offline (or just
     * before a reload) survive; the `pending` marker tells openAccount() to
     * prefer this copy over the server one and re-publish it. */
    if (this.accountId && this.drive) {
      const id = this.accountId;
      kvSet(STORAGE_KEYS.drivePrefix + id, this.drive).catch(() => {});
      kvSet(STORAGE_KEYS.pending, { accountId: id, at: Date.now() }).catch(() => {});
    }
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flushSaves(), 600);
  }

  async flushSaves() {
    if (this.saving) { this.dirty = true; return; }
    if (!this.dirty) return;
    this.saving = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        try {
          await this.saveDriveNow();
        } catch (e) {
          console.error("drive save failed", e);
          if (!this.accountId || !this.drive) { this.dirty = false; break; }
          this.setStatus({ lastError: e, syncState: "error" });
          this.dirty = true;
          clearTimeout(this._retryTimer);
          this._retryTimer = setTimeout(() => this.flushSaves(), 6000);
          break;
        }
      }
    } finally {
      this.saving = false;
      if (!this.dirty && this.status.syncState !== "error") this.setStatus({ syncState: "saved" });
    }
  }

  async saveDriveNow() {
    if (this.readOnly) return;
    let acc = this.account;
    const drive0 = this.drive;
    if (!drive0 || !acc || !this.accountId) return;
    this.setStatus({ syncState: "saving" });
    await this.reconcileBeforeSave();
    acc = this.account;
    const drive = this.drive;
    if (!drive || !acc) return;
    drive.rev = (Number(drive.rev) || 0) + 1;
    drive.updatedAt = Date.now();
    const json = JSON.stringify(drive);
    const blob = new Blob([json], { type: "application/json" });
    const oldMid = acc.drive && acc.drive.mid;
    const res = await this.tg.sendDocument(
      this.cfg.chatId,
      blob,
      `tdrive-${acc.id}.json`,
      `${this.cfg.indexPrefix}:DRIVE:${acc.id}`,
    );
    if (this.drive !== drive || this.accountId !== acc.id) return;
    acc.drive = {
      mid: res.message_id,
      fid: res.document.file_id,
      rev: drive.rev,
      size: res.document.file_size || json.length,
      at: Date.now(),
    };
    if (this.index) this.index.updatedAt = Date.now();
    await this.publishIndex();
    await kvSet(STORAGE_KEYS.drivePrefix + acc.id, drive);
    await kvDel(STORAGE_KEYS.pending);
    if (oldMid && oldMid !== res.message_id) {
      this.tg.deleteMessage(this.cfg.chatId, oldMid).catch(() => {});
    }
    this.setStatus({ syncState: "saved", lastSavedAt: Date.now(), lastError: null });
  }

  /** Before writing, look for a newer copy on Telegram (another device) and
   *  union it into ours so concurrent edits/additions are not silently lost. */
  async reconcileBeforeSave() {
    if (Date.now() - (this._lastIndexCheck || 0) < 15000) return;
    this._lastIndexCheck = Date.now();
    try {
      const chat = await this.tg.getChat();
      const pinned = chat && chat.pinned_message;
      const parsed = parseIndexText(pinned && pinned.text);
      if (!parsed || !parsed.head || !parsed.head.fid) return;
      this.pinnedMid = pinned.message_id;
      if (parsed.head.mid != null) this.headMid = Number(parsed.head.mid);
      const remoteIndex = normalizeIndex(await this.downloadJson(parsed.head.fid), this.cfg);
      const me = this.account;
      const remoteAcc = me && remoteIndex.accounts.find((a) => a.id === me.id);
      const remoteRev = remoteAcc && remoteAcc.drive ? Number(remoteAcc.drive.rev) || 0 : 0;
      const localRev = me && me.drive ? Number(me.drive.rev) || 0 : 0;
      if (remoteAcc && remoteAcc.drive && remoteAcc.drive.fid && remoteRev > localRev) {
        const remoteDrive = normalizeDrive(await this.downloadJson(remoteAcc.drive.fid), remoteAcc, this.cfg);
        this.drive = mergeDrives(this.drive, remoteDrive, this.cfg);
      }
      this.index = mergeIndexes(this.index, remoteIndex, this.cfg, await this.loadTombstones());
    } catch (e) {
      console.warn("reconcile before save failed", e);
    }
  }

  getNode(id) {
    if (!this.drive) return null;
    if (id === "root") return { id: "root", name: "My Drive" };
    return this.drive.folders.find((f) => f.id === id) || this.drive.files.find((f) => f.id === id) || null;
  }

  children(parentId, opts = {}) {
    const p = parentId || "root";
    const folders = this.drive.folders.filter((f) => f.parentId === p && (opts.includeTrashed || !f.trashed));
    const files = this.drive.files.filter((f) => f.parentId === p && (opts.includeTrashed || !f.trashed));
    return { folders, files };
  }

  isAncestor(ancestorId, nodeId) {
    let cur = nodeId;
    let guard = 0;
    while (cur && cur !== "root" && guard++ < 500) {
      if (cur === ancestorId) return true;
      const n = this.getNode(cur);
      cur = n ? n.parentId : null;
    }
    return false;
  }

  pathOf(folderId) {
    const out = [];
    let cur = folderId;
    let guard = 0;
    while (cur && cur !== "root" && guard++ < 500) {
      const n = this.getNode(cur);
      if (!n) break;
      out.unshift(n);
      cur = n.parentId;
    }
    return out;
  }

  uniqueName(name, parentId, excludeId) {
    const base = String(name || "").trim() || "untitled";
    const siblings = [...this.drive.folders, ...this.drive.files].filter(
      (n) => n.parentId === (parentId || "root") && n.id !== excludeId && !n.trashed,
    );
    const taken = new Set(siblings.map((n) => n.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    for (let i = 2; i < 10000; i++) {
      const cand = `${stem} (${i})${ext}`;
      if (!taken.has(cand.toLowerCase())) return cand;
    }
    return `${stem}-${randomHex(3)}${ext}`;
  }

  createFolder(name, parentId = "root") {
    const folder = {
      id: uid("f_"),
      name: this.uniqueName(name || "New folder", parentId),
      parentId,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      starred: false,
      trashed: false,
      color: null,
    };
    this.drive.folders.push(folder);
    this.logEvent("folder", `Created "${folder.name}"`, 0);
    this.scheduleSave();
    return folder;
  }

  addFile(entry) {
    const parent = entry.parentId || "root";
    const name = String(entry.name || "file");
    const existing = this.drive.files.find((f) => f.parentId === parent && !f.trashed
      && f.name.toLowerCase() === name.toLowerCase() && f.parts);
    if (existing && this.keepVersions && existing.parts.length) {
      existing.versions = existing.versions || [];
      existing.versions.push({
        id: uid("v_"),
        parts: existing.parts,
        size: existing.size,
        thumb: existing.thumb,
        thumbMid: existing.thumbMid,
        mime: existing.mime,
        createdAt: existing.modifiedAt || existing.createdAt || Date.now(),
      });
      const cap = this.cfg.maxVersions || 20;
      while (existing.versions.length > cap) {
        const old = existing.versions.shift();
        for (const p of old.parts || []) if (p.mid) this.tg.deleteMessage(this.cfg.chatId, p.mid).catch(() => {});
        if (old.thumbMid) this.tg.deleteMessage(this.cfg.chatId, old.thumbMid).catch(() => {});
      }
      existing.parts = entry.parts;
      existing.size = entry.size;
      existing.kind = entry.kind;
      existing.mime = entry.mime;
      existing.thumb = entry.thumb || null;
      existing.thumbMid = entry.thumbMid != null ? entry.thumbMid : null;
      existing.enc = !!entry.enc;
      existing.modifiedAt = Date.now();
      this.logEvent("upload", existing.name + " (new version)", entry.size);
      this.scheduleSave();
      return existing;
    }
    entry.name = this.uniqueName(name, parent);
    this.drive.files.push(entry);
    this.logEvent("upload", entry.name, entry.size);
    this.scheduleSave();
    return entry;
  }

  logEvent(kind, name, size) {
    if (!this.drive) return;
    if (this.readOnly) return;
    if (!Array.isArray(this.drive.log)) this.drive.log = [];
    this.drive.log.push({
      at: Date.now(),
      kind: String(kind || "event"),
      name: String(name || "").slice(0, 140),
      size: Number(size) || 0,
      by: (this.account && this.account.name) || "",
    });
    const cap = this.cfg.maxLogEntries || 400;
    if (this.drive.log.length > cap) this.drive.log = this.drive.log.slice(-cap);
    this.scheduleSave();
  }

  getActivity() {
    return this.drive && Array.isArray(this.drive.log) ? [...this.drive.log].reverse() : [];
  }

  clearActivity() {
    if (!this.drive) return;
    this.drive.log = [];
    this.scheduleSave();
  }

  versionsOf(id) {
    const f = this.getNode(id);
    if (!f || !f.parts) return [];
    return (f.versions || []).slice().reverse();
  }

  restoreVersion(fileId, versionId) {
    const f = this.getNode(fileId);
    if (!f || !f.parts) return null;
    const idx = (f.versions || []).findIndex((v) => v.id === versionId);
    if (idx < 0) return null;
    const v = f.versions[idx];
    f.versions.splice(idx, 1);
    f.versions.push({
      id: uid("v_"), parts: f.parts, size: f.size, thumb: f.thumb, thumbMid: f.thumbMid,
      mime: f.mime, createdAt: f.modifiedAt || Date.now(),
    });
    f.parts = v.parts;
    f.size = v.size;
    f.thumb = v.thumb || null;
    f.thumbMid = v.thumbMid != null ? v.thumbMid : null;
    f.mime = v.mime || f.mime;
    f.modifiedAt = Date.now();
    this.logEvent("restore", `${f.name} (v${f.versions.length})`, f.size);
    this.scheduleSave();
    return f;
  }

  deleteVersion(fileId, versionId) {
    const f = this.getNode(fileId);
    if (!f || !f.versions) return false;
    const idx = f.versions.findIndex((v) => v.id === versionId);
    if (idx < 0) return false;
    const v = f.versions[idx];
    f.versions.splice(idx, 1);
    for (const p of v.parts || []) if (p.mid) this.tg.deleteMessage(this.cfg.chatId, p.mid).catch(() => {});
    if (v.thumbMid) this.tg.deleteMessage(this.cfg.chatId, v.thumbMid).catch(() => {});
    this.logEvent("delete", `${f.name} (old version)`, v.size);
    this.scheduleSave();
    return true;
  }

  async autoPurgeTrash(days) {
    if (!days || days <= 0 || !this.drive) return 0;
    const cutoff = Date.now() - days * 86400000;
    const ids = [...this.drive.folders, ...this.drive.files]
      .filter((n) => n.trashed && (n.modifiedAt || n.createdAt) < cutoff)
      .map((n) => n.id);
    if (!ids.length) return 0;
    const n = await this.purge(ids);
    return n;
  }

  renameNode(id, name) {
    const n = this.getNode(id);
    if (!n || id === "root") return;
    const before = n.name;
    n.name = this.uniqueName(name, n.parentId, n.id);
    n.modifiedAt = Date.now();
    if (before !== n.name) this.logEvent("rename", `${before} → ${n.name}`, 0);
    this.scheduleSave();
    return n;
  }

  moveNodes(ids, targetId) {
    const moved = [];
    for (const id of ids) {
      if (id === targetId || id === "root") continue;
      const n = this.getNode(id);
      if (!n) continue;
      if (n.parentId === "root" && this.drive.folders.includes(n) && this.isAncestor(n.id, targetId)) continue;
      if (this.isAncestor(id, targetId)) continue;
      n.parentId = targetId;
      n.modifiedAt = Date.now();
      moved.push(n);
    }
    this.uniqueResolveMoves(moved);
    if (moved.length) this.logEvent("move", `${moved.length} item${moved.length === 1 ? "" : "s"} moved`, 0);
    this.scheduleSave();
    return moved;
  }

  uniqueResolveMoves(moved) {
    for (const n of moved) {
      const keep = n.name;
      n.name = this.uniqueName(keep, n.parentId, n.id);
    }
  }

  setTrashed(ids, value) {
    const visited = new Set();
    const apply = (id) => {
      if (visited.has(id)) return;
      visited.add(id);
      const n = this.getNode(id);
      if (!n || id === "root") return;
      n.trashed = !!value;
      n.modifiedAt = Date.now();
      if (this.drive.folders.includes(n)) {
        for (const child of [...this.drive.folders, ...this.drive.files]) {
          if (child.parentId === id) apply(child.id);
        }
      }
    };
    for (const id of ids) apply(id);
    if (ids.length) this.logEvent(value ? "trash" : "restore", `${ids.length} item${ids.length === 1 ? "" : "s"}`, 0);
    this.scheduleSave();
  }

  toggleStar(ids, value) {
    for (const id of ids) {
      const n = this.getNode(id);
      if (!n || id === "root") continue;
      n.starred = value == null ? !n.starred : !!value;
      n.modifiedAt = Date.now();
    }
    this.scheduleSave();
  }

  touchModified(id) {
    const n = this.getNode(id);
    if (n && id !== "root") { n.modifiedAt = Date.now(); this.scheduleSave(); }
  }

  async purge(ids, opts = {}) {
    const set = new Set();
    const collect = (id) => {
      if (set.has(id)) return;
      set.add(id);
      const n = this.getNode(id);
      if (n && this.drive.folders.includes(n)) {
        for (const child of [...this.drive.folders, ...this.drive.files]) if (child.parentId === id) collect(child.id);
      }
    };
    for (const id of ids) collect(id);

    const doomedFiles = this.drive.files.filter((f) => set.has(f.id));
    const doomedFolders = this.drive.folders.filter((f) => set.has(f.id));
    this.drive.folders = this.drive.folders.filter((f) => !set.has(f.id));
    this.drive.files = this.drive.files.filter((f) => !set.has(f.id));
    if (this.index && (this.index.shares || []).some((s) => set.has(s.nodeId))) {
      this.index.shares = this.index.shares.filter((s) => !set.has(s.nodeId));
      await this.publishIndex().catch((e) => console.warn("share prune publish failed", e));
    }
    this.logEvent("delete", `${doomedFiles.length} file${doomedFiles.length === 1 ? "" : "s"} permanently deleted`, doomedFiles.reduce((s, f) => s + (Number(f.size) || 0), 0));
    this.scheduleSave();

    const dropMessages = () => {
      for (const f of doomedFiles) {
        for (const p of f.parts || []) {
          if (p.mid) this.tg.deleteMessage(this.cfg.chatId, p.mid).catch(() => {});
        }
        for (const v of f.versions || []) {
          for (const p of v.parts || []) if (p.mid) this.tg.deleteMessage(this.cfg.chatId, p.mid).catch(() => {});
          if (v.thumbMid) this.tg.deleteMessage(this.cfg.chatId, v.thumbMid).catch(() => {});
        }
        if (f.thumbMid) this.tg.deleteMessage(this.cfg.chatId, f.thumbMid).catch(() => {});
      }
    };

    const result = {
      count: doomedFiles.length + doomedFolders.length,
      files: doomedFiles,
      folders: doomedFolders,
      cancel: () => {},
    };
    /* With `deferMs` the Telegram messages are only dropped after a short
     * window, so the UI can offer an Undo that cancels the deletion and puts
     * the nodes back. (A reload inside that window just leaves them
     * unreferenced — harmless, they can be purged again later.) */
    if (opts.deferMs > 0) {
      const timer = setTimeout(dropMessages, opts.deferMs);
      result.cancel = () => clearTimeout(timer);
    } else {
      dropMessages();
    }
    return result;
  }

  restorePurged(res) {
    if (!res || !this.drive) return 0;
    let n = 0;
    for (const f of res.folders || []) {
      if (!this.drive.folders.some((x) => x.id === f.id)) { this.drive.folders.push(f); n += 1; }
    }
    for (const f of res.files || []) {
      if (!this.drive.files.some((x) => x.id === f.id)) { this.drive.files.push(f); n += 1; }
    }
    if (n) { this.logEvent("restore", `${n} item${n === 1 ? "" : "s"} restored from delete`, 0); this.scheduleSave(); }
    return n;
  }

  bytesUsed() {
    if (!this.drive) return 0;
    return this.drive.files.reduce((s, f) => s + (Number(f.size) || 0), 0);
  }

  /** Storage that could be freed: old version snapshots + trashed items. */
  reclaimable() {
    const d = this.drive;
    const out = { versions: { count: 0, bytes: 0 }, trash: { count: 0, bytes: 0 } };
    if (!d) return out;
    for (const f of d.files) {
      for (const v of f.versions || []) { out.versions.count += 1; out.versions.bytes += Number(v.size) || 0; }
      if (f.trashed) { out.trash.count += 1; out.trash.bytes += Number(f.size) || 0; }
    }
    for (const fo of d.folders) if (fo.trashed) out.trash.count += 1;
    return out;
  }

  async deleteAllVersions() {
    const d = this.drive;
    if (!d) return { files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    for (const f of d.files) {
      for (const v of f.versions || []) {
        for (const p of v.parts || []) if (p.mid) this.tg.deleteMessage(this.cfg.chatId, p.mid).catch(() => {});
        if (v.thumbMid) this.tg.deleteMessage(this.cfg.chatId, v.thumbMid).catch(() => {});
      }
      files += (f.versions || []).length;
      bytes += (f.versions || []).reduce((s, v) => s + (Number(v.size) || 0), 0);
      f.versions = [];
    }
    if (files) {
      this.logEvent("delete", `${files} old version${files === 1 ? "" : "s"} removed`, bytes);
      this.scheduleSave();
    }
    return { files, bytes };
  }

  stats() {
    const d = this.drive;
    if (!d) return { files: 0, folders: 0, trashed: 0, bytes: 0, byKind: {}, versions: 0, versionsBytes: 0, encrypted: 0 };
    const byKind = {};
    let bytes = 0;
    let versions = 0;
    let versionsBytes = 0;
    let encrypted = 0;
    for (const f of d.files) {
      if (f.trashed) continue;
      bytes += Number(f.size) || 0;
      if (f.enc) encrypted += 1;
      for (const v of f.versions || []) { versions += 1; versionsBytes += Number(v.size) || 0; }
      byKind[f.kind] = byKind[f.kind] || { count: 0, bytes: 0 };
      byKind[f.kind].count++;
      byKind[f.kind].bytes += Number(f.size) || 0;
    }
    return {
      files: d.files.filter((f) => !f.trashed).length,
      folders: d.folders.filter((f) => !f.trashed).length,
      trashed: d.files.filter((f) => f.trashed).length + d.folders.filter((f) => f.trashed).length,
      bytes,
      byKind,
      versions,
      versionsBytes,
      encrypted,
    };
  }

  async wipeTrash() {
    const ids = [...this.drive.folders, ...this.drive.files].filter((n) => n.trashed).map((n) => n.id);
    const res = await this.purge(ids);
    return res.count;
  }
}

export function validateCredentials(name, password) {
  if (!name || name.length < 2) return "Account name must be at least 2 characters";
  if (name.length > 32) return "Account name must be 32 characters or fewer";
  if (!/^[A-Za-z0-9 ._\-]+$/.test(name)) return "Account name may only contain letters, numbers, spaces, . _ -";
  if (!password || String(password).length < 6) return "Password must be at least 6 characters";
  if (String(password).length > 200) return "Password is too long";
  return null;
}
