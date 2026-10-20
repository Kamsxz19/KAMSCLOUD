/* KamsClouds platform layer — Perchance-independent storage + network.
 *
 * Goal: the SAME src/tdrive/*.js files run in two places:
 *   1. Perchance preview  (window.root.superFetch + window.root.kv.tdrive exist)
 *   2. GitHub Pages / any static host (neither exists)
 *
 * Rule for all app code: NEVER touch window.root / superFetch / kv directly.
 * Always go through this module:
 *   import { kvGet, kvSet, kvDel, pfetch } from "./platform.js";
 *
 * kv* API matches the old kv-plugin folder API (get/set/delete, async).
 * pfetch(url, opts) matches the fetch Response API.
 */

function pjsRoot() {
  try {
    if (typeof window !== "undefined" && window.root) return window.root;
  } catch (e) { /* ignore */ }
  try {
    if (typeof globalThis !== "undefined" && globalThis.root) return globalThis.root;
  } catch (e) { /* ignore */ }
  return null;
}

export function hasPerchanceKv() {
  const r = pjsRoot();
  return !!(r && r.kv && r.kv.tdrive);
}

export function hasPerchanceFetch() {
  const r = pjsRoot();
  return !!(r && typeof r.superFetch === "function");
}

/* ---------------------------------------------------------- IDB fallback */

const IDB_DB = "kamsclouds";
const IDB_STORE = "kv";
let _idb = null;
let _idbFailed = false;

function openIdb() {
  if (_idb || _idbFailed) return Promise.resolve(_idb);
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") { _idbFailed = true; resolve(null); return; }
      const req = indexedDB.open(IDB_DB, 1);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(IDB_STORE); } catch (e) { /* exists */ }
      };
      req.onsuccess = () => { _idb = req.result; resolve(_idb); };
      req.onerror = () => { _idbFailed = true; resolve(null); };
      req.onblocked = () => { /* still usable */ };
    } catch (e) {
      _idbFailed = true;
      resolve(null);
    }
  });
}

function idbGet(key) {
  return openIdb().then((db) => {
    if (!db) return { hit: false };
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, "readonly");
        const st = tx.objectStore(IDB_STORE);
        const rq = st.get(String(key));
        rq.onsuccess = () => {
          if (rq.result === undefined) resolve({ hit: false });
          else resolve({ hit: true, value: rq.result && rq.result.v });
        };
        rq.onerror = () => resolve({ hit: false });
      } catch (e) { resolve({ hit: false }); }
    });
  });
}

function idbSet(key, val) {
  return openIdb().then((db) => {
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, "readwrite");
        const st = tx.objectStore(IDB_STORE);
        const rq = st.put({ v: val }, String(key));
        rq.onsuccess = () => resolve(true);
        rq.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  });
}

function idbDel(key) {
  return openIdb().then((db) => {
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(String(key));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) { resolve(); }
    });
  });
}

/* localStorage mirror: keeps small JSON values readable/debuggable and
 * covers environments where IndexedDB is blocked (private mode). IDB wins. */
function lsGet(key) {
  try {
    if (typeof localStorage === "undefined") return undefined;
    const raw = localStorage.getItem("kc:" + key);
    if (raw == null) return undefined;
    return JSON.parse(raw);
  } catch (e) { return undefined; }
}
function lsSet(key, val) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem("kc:" + key, JSON.stringify(val));
  } catch (e) { /* quota — IDB still has it */ }
}
function lsDel(key) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem("kc:" + key);
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ kv */

export async function kvGet(key, def = null) {
  // 1) Perchance kv (keeps existing Perchance users working)
  try {
    const r = pjsRoot();
    if (r && r.kv && r.kv.tdrive) {
      const v = await r.kv.tdrive.get(key);
      if (v !== undefined && v !== null) return v;
    }
  } catch (e) { console.warn("kvGet (perchance) failed", key, e); }
  // 2) IndexedDB
  try {
    const r = await idbGet(key);
    if (r.hit) return r.value === undefined ? def : r.value;
  } catch (e) { /* ignore */ }
  // 3) localStorage mirror
  const lv = lsGet(key);
  return lv === undefined ? def : lv;
}

export async function kvSet(key, val) {
  let ok = false;
  try {
    const r = pjsRoot();
    if (r && r.kv && r.kv.tdrive) {
      await r.kv.tdrive.set(key, val);
      ok = true;
    }
  } catch (e) { console.warn("kvSet (perchance) failed", key, e); }
  try { if (await idbSet(key, val)) ok = true; } catch (e) { /* ignore */ }
  try { lsSet(key, val); ok = true; } catch (e) { /* ignore */ }
  return ok;
}

export async function kvDel(key) {
  try {
    const r = pjsRoot();
    if (r && r.kv && r.kv.tdrive) await r.kv.tdrive.delete(key);
  } catch (e) { /* ignore */ }
  try { await idbDel(key); } catch (e) { /* ignore */ }
  try { lsDel(key); } catch (e) { /* ignore */ }
}

/* --------------------------------------------------------------- fetch */

/* Optional CORS relay for the Telegram Bot API (api.telegram.org sends no
 * CORS headers, so a plain static host cannot call it directly).
 * Set cfg.corsProxy to the worker URL, e.g. "https://tg.you.workers.dev".
 * The worker must forward:  {target} url + method + headers + body.
 * See docs/DEPLOY-GITHUB.md for the 20-line sample worker. */
export function proxyFor(cfg, url) {
  const px = cfg && cfg.corsProxy ? String(cfg.corsProxy).trim().replace(/\/+$/, "") : "";
  if (!px) return null;
  return px + "?target=" + encodeURIComponent(String(url));
}

export async function pfetch(cfg, url, opts = {}) {
  // 1) Perchance relay when available (zero-config on Perchance)
  const r = pjsRoot();
  if (r && typeof r.superFetch === "function") {
    return r.superFetch(url, opts);
  }
  // 2) Proxied fetch when a corsProxy is configured (GitHub Pages path)
  const px = proxyFor(cfg, url);
  if (px) {
    return fetch(px, {
      method: opts.method || "GET",
      headers: opts.headers,
      body: opts.body,
      signal: opts.signal,
    });
  }
  // 3) Plain fetch (works for self-hosted Bot API servers with CORS on,
  //    and for file downloads that already allow CORS)
  return fetch(url, opts);
}

export function platformInfo() {
  return {
    perchanceKv: hasPerchanceKv(),
    perchanceFetch: hasPerchanceFetch(),
    idb: typeof indexedDB !== "undefined",
    standalone: !hasPerchanceKv() && !hasPerchanceFetch(),
  };
}
