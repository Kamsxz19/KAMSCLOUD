import { TDriveConfig, STORAGE_KEYS } from "./config.js";
import { kvGet as pfGet, kvSet as pfSet } from "./platform.js";
import { BRAND } from "./brand.js";
import { guardUpload, refreshKcChrome, openLicenseDialog } from "./commerce.js";
import { ensureSupportWidget, updateSupportBadge, renderSupportThread } from "./support-ui.js";
import { createTg } from "./tg.js";
import { Vault } from "./vault.js";
import { TransferManager, messageLink, saveBlob, sanitizeName, mimeFromName } from "./transfer.js";
import {
  icon, driveLogo, googleG, fileIcon, avatarHtml, kindColor,
  renderSidebar, renderToolbar, renderBrowser, renderDetails, renderTransfersHtml,
  computeOrdered, buildChildCounts, isFolder, KIND_LABEL, SECTIONS,
} from "./ui.js";
import { escapeHtml, fmtBytes, fmtDate, fileKind, isMobileLike, clamp } from "./util.js";

const $ = (id) => document.getElementById(id);
const cfg = TDriveConfig;

const state = {
  section: "home",
  folderId: "root",
  selection: new Set(),
  view: "grid",
  sort: "name",
  search: "",
  theme: "light",
  sidebarOpen: false,
  authMode: "login",
  anchorId: null,
  keepVersions: true,
  trashDays: 30,
  chunkMiB: 0,
};

const VIRTUAL_THRESHOLD = 160;

const ctx = {
  state, vault: null, tg: null, tm: null, cfg, thumbUrls: new Map(),
  rendered: [], childCounts: new Map(), metrics: { perRow: 4, rowH: 214 }, _view: null, _win: null,
};
window.TDrive = ctx;
window.KamsClouds = ctx;
const previewBlobs = new Map();
const thumbFail = new Set();

/* ------------------------------------------------------------------ boot */

async function loadSettings() {
  try {
    const s = await pfGet(STORAGE_KEYS.settings, null);
    if (s && typeof s === "object") {
      if (s.view) state.view = s.view;
      if (s.sort) state.sort = s.sort;
      if (s.theme) state.theme = s.theme;
      if (s.concurrency) cfg.downloadConcurrency = s.concurrency;
      if (s.uploadConcurrency) cfg.uploadConcurrency = clamp(Number(s.uploadConcurrency) || 4, 1, cfg.maxUploadConcurrency);
      if (s.targetChunks) cfg.targetChunks = s.targetChunks;
      if (typeof s.keepVersions === "boolean") state.keepVersions = s.keepVersions;
      if (s.trashDays != null) state.trashDays = Number(s.trashDays) || 0;
      if (s.chunkMiB != null) state.chunkMiB = Number(s.chunkMiB) || 0;
      if (s.speedMBps != null) cfg.maxSpeedMBps = Number(s.speedMBps) || 0;
      if (s.overrides) Object.assign(cfg, s.overrides);
    }
  } catch (e) { /* settings are optional */ }
  applyChunkSize(state.chunkMiB);
  if (!state.theme || state.theme === "auto") {
    state.theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  if (isMobileLike()) {
    cfg.downloadConcurrency = Math.min(cfg.downloadConcurrency, 8);
    cfg.uploadConcurrency = Math.min(cfg.uploadConcurrency, 4);
  }
}

function applyChunkSize(mib) {
  if (!mib) {
    cfg.minChunkSize = 4 * 1024 * 1024;
    cfg.maxChunkSize = 8 * 1024 * 1024;
    cfg.targetChunks = 8;
    return;
  }
  const bytes = clamp(Math.round(mib * 1024 * 1024), 256 * 1024, 1900 * 1024 * 1024);
  cfg.minChunkSize = bytes;
  cfg.maxChunkSize = bytes;
  cfg.targetChunks = 1;
}

async function saveSettings(patch) {
  Object.assign(state, patch || {});
  try {
    const prev = (await pfGet(STORAGE_KEYS.settings, null)) || {};
    await pfSet(STORAGE_KEYS.settings, Object.assign(prev, {
      view: state.view, sort: state.sort, theme: state.theme,
      concurrency: cfg.downloadConcurrency, uploadConcurrency: cfg.uploadConcurrency,
      targetChunks: cfg.targetChunks, keepVersions: state.keepVersions,
      trashDays: state.trashDays, chunkMiB: state.chunkMiB,
      speedMBps: cfg.maxSpeedMBps,
    }));
  } catch (e) { /* ignore */ }
}

function applyTheme() {
  $("tdriveRoot").setAttribute("data-theme", state.theme);
}

/* ------------------------------------------------------------------ render */

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  let done = false;
  const go = () => { if (done) return; done = true; renderQueued = false; doRender(); };
  requestAnimationFrame(go);
  setTimeout(go, 120);
}

function measureLayout(browser) {
  if (state.view === "grid") {
    const card = browser.querySelector(".card");
    const gap = isMobileLike() ? 11 : 16;
    const minCol = isMobileLike() ? 150 : 220;
    const grid = browser.querySelector(".grid");
    const w = grid ? (grid.clientWidth || 0) : 0;
    const usable = w > 0 ? w : Math.max(200, browser.clientWidth - (isMobileLike() ? 24 : 40));
    const perRow = Math.max(1, Math.floor((usable + gap) / (minCol + gap)));
    const rowH = card ? card.offsetHeight + gap : (isMobileLike() ? 177 : 214);
    return { perRow, rowH };
  }
  const row = browser.querySelector("tbody tr:not(.vpad)");
  return { perRow: 1, rowH: row ? row.offsetHeight : 41 };
}

function windowBounds() {
  const browser = $("browserEl");
  const total = (ctx._view && ctx._view.ordered.length) || 0;
  const perRow = Math.max(1, ctx.metrics.perRow || 1);
  const rowH = Math.max(20, ctx.metrics.rowH || 200);
  const rows = Math.ceil(total / perRow);
  const st = browser.scrollTop;
  const vh = browser.clientHeight || 600;
  const buffer = 2;
  const startRow = Math.max(0, Math.floor(st / rowH) - buffer);
  const endRow = Math.min(rows, Math.ceil((st + vh) / rowH) + buffer);
  return {
    active: true,
    start: startRow * perRow,
    end: Math.min(total, endRow * perRow),
    padTop: startRow * rowH,
    padBottom: Math.max(0, (rows - endRow) * rowH),
    perRow,
  };
}

function computeWindow() {
  const total = (ctx._view && ctx._view.ordered.length) || 0;
  if (total <= VIRTUAL_THRESHOLD) return { active: false, start: 0, end: total, padTop: 0, padBottom: 0 };
  return windowBounds();
}

function buildSharedNodeIds(vault) {
  const set = new Set();
  if (!vault || !vault.index || vault.shared) return set;
  for (const s of vault.index.shares || []) if (s.accId === vault.accountId) set.add(s.nodeId);
  return set;
}

function doRender() {
  if (!ctx.vault || !ctx.vault.drive) return;
  ctx.doRender = doRender;
  ctx.shared = ctx.vault.shared || null;
  ctx.readOnly = !!ctx.vault.readOnly;
  ctx.sharedNodeIds = buildSharedNodeIds(ctx.vault);
  const browser = $("browserEl");
  if (!browser) return;
  const prevTop = browser.scrollTop;

  ctx.childCounts = buildChildCounts(ctx.vault);
  $("sidebarEl").innerHTML = renderSidebar(ctx);
  ctx._view = computeOrdered(ctx);
  $("toolbarEl").innerHTML = renderToolbar(ctx);
  const win = computeWindow();
  ctx._win = win;
  browser.innerHTML = renderBrowser(ctx, win);
  ctx.metrics = measureLayout(browser);

  const det = $("detailsEl");
  const showDetails = state.selection.size > 0;
  det.hidden = !showDetails;
  if (showDetails) det.innerHTML = renderDetails(ctx);

  browser.scrollTop = prevTop;
  ctx._renderedForScroll = browser.scrollTop;
  syncChrome();
  renderOfflineBanner();
  hydrateThumbs(browser);
  if (showDetails) hydrateDetailsPreview();
}

function onBrowserScroll() {
  const win = ctx._win;
  if (!win || !win.active || !ctx._view) return;
  const next = windowBounds();
  if (next.start === win.start && next.end === win.end) return;
  render();
}

function ensureVisible(id) {
  const browser = $("browserEl");
  if (ctx._win && ctx._win.active && ctx._view) {
    const idx = ctx._view.ordered.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const perRow = Math.max(1, ctx.metrics.perRow || 1);
    const rowH = Math.max(20, ctx.metrics.rowH || 200);
    const row = Math.floor(idx / perRow);
    const top = row * rowH;
    if (top < browser.scrollTop) browser.scrollTop = top;
    else if (top + rowH > browser.scrollTop + browser.clientHeight) browser.scrollTop = top + rowH - browser.clientHeight;
    return;
  }
  setTimeout(() => {
    const el = browser.querySelector(`[data-id="${id}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }, 60);
}

function renderOfflineBanner() {
  const el = $("offlineBanner");
  if (!el) return;
  el.hidden = navigator.onLine !== false;
}

function applyShareChrome(v) {
  const shared = v && v.shared;
  const banner = $("shareBanner");
  $("searchWrap").hidden = !!shared;
  $("syncBtn").hidden = !!shared;
  $("settingsBtn").hidden = !!shared;
  $("accountBtn").hidden = !!shared;
  if (!banner) return;
  if (!shared) { banner.hidden = true; return; }
  const canEdit = shared.perm === "edit";
  banner.hidden = false;
  banner.innerHTML = `${icon(canEdit ? "edit" : "eye", "icon")}
    <span class="sb-by">Shared by <span class="sb-owner">${escapeHtml(shared.ownerName)}</span></span>
    <span class="sb-perm">${canEdit ? "Can edit" : "View only"}</span>
    <div class="grow" style="flex:1"></div>
   <button class="btn ghost" data-act="copytodrive" type="button" style="height:30px;padding:0 12px">Save to my drive</button>
    <button class="btn ghost" data-act="openapp" type="button" style="height:30px;padding:0 12px">Open KamsClouds</button>`;
}

function syncChrome() {
  const v = ctx.vault;
  applyShareChrome(v);
  const btn = $("accountBtn");
  if (v.account) {
    btn.innerHTML = `${avatarHtml(v.account)}`;
    btn.title = v.account.name;
  }
  const sync = $("syncBtn");
  const s = v.status.syncState;
  sync.innerHTML = icon(s === "saving" || s === "syncing" ? "cloud" : s === "error" ? "cloudOff" : "cloudDone");
  sync.title = s === "saving" ? "Saving to Telegram…" : s === "error" ? "Sync problem — click to retry" : "All changes saved to Telegram";
  sync.style.color = s === "error" ? "var(--red)" : s === "saved" ? "var(--green)" : "var(--text-2)";
  $("themeBtn").innerHTML = icon(state.theme === "dark" ? "sun" : "moon");
  const fab = $("fabBtn");
  if (fab) fab.hidden = !v.accountId || !!v.readOnly || !!v.shared;
  try { refreshKcChrome(ctx); } catch (e) { /* ignore */ }
  try { updateSupportBadge(ctx); } catch (e) { /* ignore */ }
}

function renderTransfersPanel() {
  const el = $("transfersEl");
  const jobs = ctx.tm.list();
  const relevant = jobs.filter((j) => j.status === "active" || j.status === "queued" || j.status === "error" || (j.endedAt && Date.now() - j.endedAt < 4000));
  if (!relevant.length) {
    if (el._hideTimer) clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.hidden = true; ctx.tm.clearFinished(); }, 1200);
    el.innerHTML = renderTransfersHtml(ctx.tm);
    return;
  }
  if (el._hideTimer) { clearTimeout(el._hideTimer); el._hideTimer = null; }
  el.hidden = false;
  const collapsed = el.classList.contains("collapsed");
  el.innerHTML = renderTransfersHtml(ctx.tm);
  if (collapsed) el.classList.add("collapsed");
}

/* ------------------------------------------------------------- thumbnails */

async function hydrateThumbs(rootEl) {
  if (!rootEl) return;
  const imgs = [...rootEl.querySelectorAll("img[data-thumb]")].filter((i) => !thumbFail.has(i.getAttribute("data-thumb")));
  let i = 0;
  const worker = async () => {
    while (i < imgs.length) {
      const img = imgs[i++];
      if (!img.isConnected) continue;
      const fid = img.getAttribute("data-thumb");
      try {
        const url = await ctx.tm.thumbUrl({ thumb: fid });
        ctx.thumbUrls.set(fid, url);
        if (img.isConnected) img.src = url;
      } catch (e) {
        thumbFail.add(fid);
        const card = img.closest("[data-id]");
        const node = card ? ctx.vault.getNode(card.getAttribute("data-id")) : null;
        if (img.isConnected && node) img.parentElement.innerHTML = fileIcon(node.kind, node.name, "icon-lg");
        else if (img.isConnected) img.remove();
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

async function getPreviewSrc(node) {
  const parts = node.parts || [];
  if (!parts.length) return null;
  if (parts.length === 1 && !node.enc) return await ctx.tm.previewUrl(node);
  if (node.size > 96 * 1024 * 1024) return null;
  if (previewBlobs.has(node.id)) return previewBlobs.get(node.id);
  const job = ctx.tm._newJob({ type: "download", name: node.name, size: node.size, entry: node, chunkTotal: parts.length, encrypted: !!node.enc });
  job.status = "active";
  const bags = [];
  await ctx.tm._downloadParts(job, { write: async (u8) => { bags.push(u8); }, close: async () => {} });
  const url = URL.createObjectURL(new Blob(bags, { type: node.mime || "application/octet-stream" }));
  previewBlobs.set(node.id, url);
  return url;
}

async function hydrateDetailsPreview() {
  const holder = $("detailsEl").querySelector("[data-preview]");
  if (!holder) return;
  const id = holder.getAttribute("data-preview");
  const node = ctx.vault.getNode(id);
  if (!node) return;
  const stillValid = () => holder.isConnected && $("detailsEl").querySelector("[data-preview]") === holder;
  try {
    if (node.kind === "image" || node.kind === "video" || node.kind === "audio") {
      const src = await getPreviewSrc(node);
      if (!stillValid()) return;
      if (!src) { noPreview(holder, node); return; }
      if (node.kind === "image") holder.innerHTML = `<img src="${escapeHtml(src)}" alt="">`;
      else if (node.kind === "video") holder.innerHTML = `<video src="${escapeHtml(src)}" controls preload="metadata"></video>`;
      else holder.innerHTML = `<audio src="${escapeHtml(src)}" controls style="width:92%"></audio>`;
    } else if (node.kind === "pdf") {
      const src = await getPreviewSrc(node);
      if (!stillValid()) return;
      holder.innerHTML = src ? `<iframe src="${escapeHtml(src)}" title="preview"></iframe>` : `<div style="padding:18px;color:var(--text-2)">Open or download to view this PDF</div>`;
    } else if (node.kind === "text" || node.kind === "code" || node.kind === "sheet") {
      const text = await ctx.tm.readTextHead(node, 3000);
      if (!stillValid()) return;
      holder.innerHTML = `<pre style="margin:0;padding:14px;width:100%;max-height:300px;overflow:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word">${escapeHtml(text)}</pre>`;
    } else {
      noPreview(holder, node);
    }
  } catch (e) {
    if (stillValid()) noPreview(holder, node);
  }
}

function noPreview(holder, node) {
  holder.innerHTML = `<div style="text-align:center;padding:22px;color:var(--text-2)">
    ${fileIcon(node.kind, node.name, "icon-lg")}
    <div style="margin-top:10px;font-size:13px">No preview available</div>
    <button class="btn ghost" data-act="download" style="margin-top:12px">${icon("download", "icon-sm")} Download</button>
  </div>`;
}

/* ------------------------------------------------------------------ auth */

function showAuth() {
  $("authScreen").hidden = false;
  if ($("connectScreen")) $("connectScreen").hidden = true;
  $("appShell").hidden = true;
  $("bootEl").hidden = true;
  renderAuthAccounts();
  setAuthMode(state.authMode);
  $("authNote").innerHTML = "";
  try { updateSupportBadge(ctx); } catch (e) { /* widget stays hidden */ }
}

function renderAuthAccounts() {
  const wrap = $("authAccountsWrap");
  if (wrap) wrap.hidden = true;
  return;
}

function setAuthMode(mode) {
  state.authMode = mode;
  $("tabLogin").classList.toggle("on", mode === "login");
  $("tabSignup").classList.toggle("on", mode === "signup");
  $("authPass2Wrap").hidden = mode !== "signup";
  const encWrap = $("authEncWrap");
  if (encWrap) encWrap.hidden = mode !== "signup";
  $("authSubmit").textContent = mode === "signup" ? "Create account" : "Sign in";
  $("authErr").textContent = "";
  if (mode === "signup") {
    $("authPass").setAttribute("autocomplete", "new-password");
  } else {
    $("authPass").setAttribute("autocomplete", "current-password");
  }
}

async function submitAuth() {
  const name = $("authName").value.trim();
  const pass = $("authPass").value;
  const err = $("authErr");
  const btn = $("authSubmit");
  err.textContent = "";
  if (state.authMode === "signup" && pass !== $("authPass2").value) {
    err.textContent = "Passwords do not match";
    return;
  }
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = state.authMode === "signup" ? "Creating…" : "Signing in…";
  try {
    if (state.authMode === "signup") await ctx.vault.createAccount(name, pass, { encrypt: $("authEnc") ? $("authEnc").checked : false });
    else await ctx.vault.login(name, pass);
    $("authPass").value = "";
    $("authPass2").value = "";
    enterApp();
  } catch (e) {
    err.textContent = String((e && e.message) || e);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function enterApp() {
  $("authScreen").hidden = true;
  if ($("connectScreen")) $("connectScreen").hidden = true;
  $("appShell").hidden = false;
  state.section = "home";
  state.folderId = "root";
  state.selection.clear();
  render();
  renderTransfersPanel();
  startSession();
}

async function startSession() {
  try {
    const restored = await ctx.tm.restoreResumable();
    if (restored.length) {
      renderTransfersPanel();
      toast(`${restored.length} interrupted transfer${restored.length === 1 ? "" : "s"} ready to resume`);
    }
  } catch (e) { /* nothing else we can do */ }
  if (ctx.vault.status.needsUnlock) await askUnlock();
  try {
    const purged = await ctx.vault.autoPurgeTrash(state.trashDays);
    if (purged) toast(`Auto-emptied ${purged} old trash item${purged === 1 ? "" : "s"}`);
  } catch (e) { /* ignore */ }
  applyHashTarget();
}

async function askUnlock() {
  const acc = ctx.vault.account;
  if (!acc) return;
  for (let tries = 0; tries < 4; tries++) {
    const pass = await promptDialog(`Unlock "${acc.name}"`, "This drive is encrypted. Enter the password to unlock your files.", "", "Unlock", { type: "password" });
    if (pass == null) {
      const keep = await confirmDialog("Stay locked?", "You can still browse the file list, but uploads, previews and downloads stay locked until you unlock.", "Stay locked");
      if (keep) return;
      continue;
    }
    try {
      await ctx.vault.unlock(pass);
      toast("Drive unlocked");
      render();
      return;
    } catch (e) {
      toast(String((e && e.message) || e), "err");
    }
  }
}

function applyHashTarget() {
  const m = /#tdrive=([^:&]*):([^&]*)/.exec(location.hash || "");
  if (!m) return;
  const accId = decodeURIComponent(m[1]);
  const nodeId = decodeURIComponent(m[2]);
  if (accId && ctx.vault.accountId && accId !== ctx.vault.accountId) {
    toast("That KamsClouds link belongs to a different account", "err");
    return;
  }
  const node = ctx.vault.getNode(nodeId);
  if (!node) { toast("The shared item was not found in this drive", "err"); return; }
  if (isFolder(node)) openFolder(node.id, "drive");
  else { selectOnly(node.id); openViewer(node); }
}

/* ---------------------------------------------------------------- sharing */

function shareTokenFromHash() {
  const m = /[#&]share=([^&]+)/.exec(location.hash || "");
  return m ? decodeURIComponent(m[1]) : null;
}

function leaveShare() {
  try { ctx.vault.leaveShared(); } catch (e) { /* ignore */ }
  try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* ignore */ }
  location.reload();
}

function showShareError(title, message) {
  $("bootEl").hidden = true;
  $("authScreen").hidden = true;
  if ($("connectScreen")) $("connectScreen").hidden = true;
  $("appShell").hidden = true;
  const scr = $("shareError");
  if (!scr) { showAuth(); return; }
  scr.hidden = false;
  $("shareErrTitle").textContent = title;
  $("shareErrMsg").textContent = message;
  try { updateSupportBadge(ctx); } catch (e) { /* widget stays hidden */ }
}

function enterSharedApp() {
  $("bootEl").hidden = true;
  $("authScreen").hidden = true;
  if ($("connectScreen")) $("connectScreen").hidden = true;
  const scr = $("shareError");
  if (scr) scr.hidden = true;
  $("appShell").hidden = false;
  const sh = ctx.vault.shared;
  state.section = "drive";
  state.search = "";
  state.selection.clear();
  state.folderId = (sh && sh.rootId) || "root";
  applyShareChrome(ctx.vault);
  render();
  renderTransfersPanel();
}

async function askSharePassword() {
  const sh = ctx.vault.shared;
  if (!sh) return;
  for (let tries = 0; tries < 5; tries++) {
    const pass = await promptDialog("Protected link", `Enter the password for "${sh.label || "this share"}" to unlock the files.`, "", "Unlock", { type: "password" });
    if (pass == null) { toast("Browsing locked — previews and downloads stay locked until you unlock", "err"); return; }
    try {
      await ctx.vault.unlockShare(pass);
      toast("Unlocked");
      render();
      return;
    } catch (e) {
      toast(String((e && e.message) || e), "err");
    }
  }
}

async function enterShared(token) {
  let res;
  try { res = await ctx.vault.resolveShare(token); }
  catch (e) { showShareError("Couldn't open this link", String((e && e.message) || e)); return; }

  if (res.status === "missing") { showShareError("Link not found", "This share link is invalid or was turned off by the owner."); return; }
  if (res.status === "expired") { showShareError("Link expired", "This share link has passed its expiry date."); return; }
  if (res.status === "no-owner") { showShareError("Link unavailable", "The account that shared this item no longer exists."); return; }

  try {
    await ctx.vault.openSharedDrive(res.share);
  } catch (e) {
    showShareError("Couldn't load the shared drive", String((e && e.message) || e));
    return;
  }
  enterSharedApp();
  try {
    const restored = await ctx.tm.restoreResumable();
    if (restored.length) renderTransfersPanel();
  } catch (e) { /* ignore */ }
  if (ctx.vault.status.needsUnlock) await askSharePassword();
}

/* ----------------------------------------------------------------- modals */

function showShortcuts() {
  const row = (k, d) => `<div class="kv"><span class="k" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(k)}</span><span class="v" style="text-align:right">${escapeHtml(d)}</span></div>`;
  openModal({
    title: "Keyboard shortcuts",
    body: [
      row("Arrows / Home / End / PgUp / PgDn", "Move focus"),
      row("Shift + Arrow", "Extend selection"),
      row("Enter", "Open folder / preview file"),
      row("Space", "Toggle selection"),
      row("Ctrl / Cmd + A", "Select all"),
      row("Shift + click", "Select a range"),
      row("Ctrl / Cmd + click", "Add to selection"),
      row("F2", "Rename"),
      row("Delete / Backspace", "Move to trash (delete forever in Trash)"),
      row("Esc", "Clear selection / close dialog"),
      row("?", "Show this help"),
    ].join(""),
    buttons: [{ label: "Got it", kind: "primary" }],
  });
}

function openModal({ title, body, buttons, width, onMount }) {
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = `<div class="modal" style="${width ? `max-width:${width}px` : ""}">
    ${title ? `<h3>${escapeHtml(title)}</h3>` : ""}
    <div class="mbody">${body || ""}</div>
    <div class="mfoot">${(buttons || []).map((b, i) =>
      `<button class="btn ${b.kind || "text"}" data-bi="${i}" ${b.disabled ? "disabled" : ""}>${escapeHtml(b.label)}</button>`).join("")}</div>
  </div>`;
  const close = () => { scrim.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) close(); });
  const modal = scrim.querySelector(".modal");
  (buttons || []).forEach((b, i) => {
    modal.querySelector(`[data-bi="${i}"]`).addEventListener("click", async () => {
      if (!b.onClick) { close(); return; }
      const keep = await b.onClick(close, modal);
      if (keep !== true) close();
    });
  });
  $("modalRoot").appendChild(scrim);
  if (onMount) onMount(modal, close);
  const focus = modal.querySelector("input, select, textarea, .btn.primary");
  if (focus) setTimeout(() => focus.focus(), 30);
  return { close, modal, scrim };
}

function confirmDialog(title, message, okLabel, opts = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p style="margin:6px 0 12px;color:var(--text-2)">${escapeHtml(message)}</p>`,
      buttons: [
        { label: "Cancel", kind: "text", onClick: () => resolve(false) },
        { label: okLabel || "OK", kind: opts.danger ? "danger" : "primary", onClick: () => resolve(true) },
      ],
    });
  });
}

function promptDialog(title, label, value, okLabel, opts = {}) {
  return new Promise((resolve) => {
    let input;
    openModal({
      title,
      body: `<div class="field"><label>${escapeHtml(label)}</label><input class="input" id="promptInput" type="${opts.type || "text"}" spellcheck="false"></div>`,
      buttons: [
        { label: "Cancel", kind: "text", onClick: () => resolve(null) },
        { label: okLabel || "Save", kind: "primary", onClick: () => resolve(input.value.trim()) },
      ],
      onMount: (modal) => {
        input = modal.querySelector("#promptInput");
        input.value = value || "";
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); resolve(input.value.trim()); modal.querySelector('.btn.primary').click(); } });
        setTimeout(() => { input.focus(); input.select(); }, 40);
      },
    });
  });
}

function toast(message, kind, action) {
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.innerHTML = `<span style="flex:1">${message}</span>${action ? `<span class="undo">${escapeHtml(action.label)}</span>` : ""}`;
  if (action) {
    el.querySelector(".undo").addEventListener("click", () => { action.onClick(); el.remove(); });
  }
  $("toastsEl").appendChild(el);
  setTimeout(() => el.remove(), action ? 9000 : 4200);
}

/* ---------------------------------------------------------------- helpers */

function selectedNodes() {
  return [...state.selection].map((id) => ctx.vault.getNode(id)).filter(Boolean);
}

function selectOnly(id) {
  state.selection.clear();
  if (id) state.selection.add(id);
  state.anchorId = id;
  state.focusId = id;
  render();
}

function toggleSelect(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  state.anchorId = id;
  state.focusId = id;
  render();
}

function navigableIds() {
  if (ctx._view && ctx._view.ordered.length) return ctx._view.ordered.map((n) => n.id);
  return [...document.querySelectorAll("#browserEl [data-id]")].map((x) => x.getAttribute("data-id"));
}

function selectRange(id) {
  const ids = navigableIds();
  const anchor = state.anchorId || [...state.selection][state.selection.size - 1];
  const a = ids.indexOf(anchor);
  const b = ids.indexOf(id);
  if (a < 0 || b < 0) { toggleSelect(id); return; }
  const lo = Math.min(a, b), hi = Math.max(a, b);
  state.selection = new Set(ids.slice(lo, hi + 1));
  state.focusId = id;
  render();
}

function setSelection(ids) {
  state.selection = new Set(ids);
  state.anchorId = ids.length ? ids[ids.length - 1] : null;
  state.focusId = state.anchorId;
  render();
}

function openFolder(id, section) {
  if (ctx.vault.shared) {
    const sh = ctx.vault.shared;
    if (sh.isFile) return;
    let target = id || sh.rootId;
    if (target === "root") target = sh.rootId;
    if (!ctx.vault.inSharedScope(target)) { toast("That folder isn't part of this share", "err"); return; }
    state.section = "drive";
    state.folderId = target;
    state.selection.clear();
    state.search = "";
    $("searchInput").value = "";
    $("searchClearBtn").hidden = true;
    render();
    return;
  }
  state.section = section || "drive";
  state.folderId = id || "root";
  state.selection.clear();
  state.search = "";
  $("searchInput").value = "";
  $("searchClearBtn").hidden = true;
  render();
}

/* ---------------------------------------------------------------- context */

function showContextMenu(x, y, node) {
  removeMenus();
  const inTrash = state.section === "trash" || (node && node.trashed);
  const folder = node && isFolder(node);
  const ro = !!ctx.readOnly;
  const guest = !!ctx.shared;
  let html = "";
  if (node) {
    if (!inTrash) {
      html += folder
        ? `<button data-c="open">${icon("folder", "icon-sm")} Open</button>`
        : `<button data-c="preview">${icon("eye", "icon-sm")} Preview</button><button data-c="download">${icon("download", "icon-sm")} Download</button>`;
      if (!guest) html += `<button data-c="share">${icon("link", "icon-sm")} Share</button>`;
      html += `<button data-c="zip">${icon("archive", "icon-sm")} Download as .zip</button>`;
      if (guest) html += `<button data-c="copytodrive">${icon("download", "icon-sm")} Save to my drive</button>`;
      if (!folder && (node.versions || []).length) html += `<button data-c="versions">${icon("history", "icon-sm")} Versions (${node.versions.length})</button>`;
      if (!ro) {
        html += `<div class="sep"></div>`;
        html += `<button data-c="rename">${icon("edit", "icon-sm")} Rename</button>`;
        html += `<button data-c="move">${icon("move", "icon-sm")} Move to…</button>`;
        html += `<button data-c="star">${icon("starBorder", "icon-sm")} ${node.starred ? "Remove star" : "Star"}</button>`;
        html += `<div class="sep"></div>`;
        html += `<button data-c="trash" class="danger">${icon("trash", "icon-sm")} Move to trash</button>`;
      }
    } else if (!ro) {
      html += `<button data-c="restore">${icon("restore", "icon-sm")} Restore</button>`;
      html += `<button data-c="purge" class="danger">${icon("trash", "icon-sm")} Delete forever</button>`;
    }
  } else if (!ro) {
    html += `<button data-c="newfolder">${icon("addFolder", "icon-sm")} New folder</button>`;
    html += `<button data-c="upload">${icon("upload", "icon-sm")} File upload</button>`;
    html += `<button data-c="uploaddir">${icon("folder", "icon-sm")} Folder upload</button>`;
  }
  if (!html) return;
  const menu = document.createElement("div");
  menu.className = "ctxmenu";
  menu.innerHTML = html;
  menu.style.left = Math.min(x, window.innerWidth - 230) + "px";
  menu.style.top = Math.min(y, window.innerHeight - 300) + "px";
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-c]");
    if (!b) return;
    handleAction(b.getAttribute("data-c"), node);
    removeMenus();
  });
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener("mousedown", outsideClose), 0);
}

function outsideClose(e) {
  if (!e.target.closest(".ctxmenu") && !e.target.closest(".dropdown")) removeMenus();
}

function removeMenus() {
  document.querySelectorAll(".ctxmenu, .dropdown").forEach((n) => n.remove());
  document.removeEventListener("mousedown", outsideClose);
}

function showDropdown(anchor, html, onPick) {
  removeMenus();
  const el = document.createElement("div");
  el.className = "dropdown";
  el.innerHTML = html;
  const r = anchor.getBoundingClientRect();
  el.style.top = Math.min(r.bottom + 6, window.innerHeight - 360) + "px";
  el.style.left = Math.max(8, Math.min(r.right - 230, window.innerWidth - 240)) + "px";
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-d]");
    if (!b) return;
    removeMenus();
    onPick(b.getAttribute("data-d"));
  });
  document.body.appendChild(el);
  setTimeout(() => document.addEventListener("mousedown", outsideClose), 0);
  return el;
}

/* --------------------------------------------------------------- actions */

const ALLOWED_VIEW_ACTIONS = new Set(["clearsel", "selectall", "open", "preview", "download", "zip", "copytodrive"]);

async function handleAction(action, node) {
  if (ctx.vault.readOnly && !ALLOWED_VIEW_ACTIONS.has(action)) {
    toast("This share is view-only", "err");
    return;
  }
  if (!node && state.selection.size === 1) node = ctx.vault.getNode([...state.selection][0]);
  const ids = node ? [node.id] : [...state.selection];
  switch (action) {
    case "open":
      if (node && isFolder(node)) openFolder(node.id);
      break;
    case "preview":
      if (node) openViewer(node);
      break;
    case "download":
      await downloadNodes(selectedNodes().length ? selectedNodes() : (node ? [node] : []));
      break;
    case "zip":
      await downloadAsZip(node ? [node] : selectedNodes());
      break;
    case "renamebulk":
      await renameBulk(node ? [node] : selectedNodes());
      break;
    case "versions":
      if (node) openVersions(node);
      break;
    case "clearactivity":
      ctx.vault.clearActivity();
      render();
      toast("Activity cleared");
      break;
    case "share":
      await shareNodes(node ? [node] : selectedNodes());
      break;
    case "copytodrive":
      await copyToMyDrive();
      break;
    case "rename":
      if (node) await renameNode(node);
      break;
    case "move":
      await moveNodes(node ? [node] : selectedNodes());
      break;
    case "star": {
      const nodes = node ? [node] : selectedNodes();
      const anyUnstarred = nodes.some((n) => !n.starred);
      ctx.vault.toggleStar(nodes.map((n) => n.id), anyUnstarred);
      toast(anyUnstarred ? "Added to starred" : "Removed from starred");
      break;
    }
    case "trash": {
      const nodes = node ? [node] : selectedNodes();
      const prev = nodes.map((n) => ({ id: n.id, trashed: n.trashed }));
      ctx.vault.setTrashed(nodes.map((n) => n.id), true);
      state.selection.clear();
      toast(`${nodes.length} item${nodes.length === 1 ? "" : "s"} moved to trash`, "", {
        label: "Undo",
        onClick: () => { prev.forEach((p) => ctx.vault.setTrashed([p.id], p.trashed)); render(); },
      });
      break;
    }
    case "restore": {
      const nodes = node ? [node] : selectedNodes();
      ctx.vault.setTrashed(nodes.map((n) => n.id), false);
      state.selection.clear();
      toast("Restored");
      break;
    }
    case "purge": {
      const nodes = node ? [node] : selectedNodes();
      const ok = await confirmDialog("Delete forever?", `${nodes.length} item${nodes.length === 1 ? "" : "s"} will be permanently removed from this drive and from Telegram.`, "Delete forever", { danger: true });
      if (!ok) return;
      state.selection.clear();
      const res = await ctx.vault.purge(nodes.map((x) => x.id), { deferMs: 9000 });
      toast(`${res.count} item${res.count === 1 ? "" : "s"} permanently deleted`, "", {
        label: "Undo",
        onClick: () => {
          res.cancel();
          const back = ctx.vault.restorePurged(res);
          render();
          toast(back ? `Restored ${back} item${back === 1 ? "" : "s"}` : "Nothing to restore");
        },
      });
      render();
      break;
    }
    case "emptytrash": {
      const ok = await confirmDialog("Empty trash?", "Everything in the trash will be permanently deleted from Telegram.", "Empty trash", { danger: true });
      if (!ok) return;
      const n = await ctx.vault.wipeTrash();
      toast(`Trash emptied (${n} files)`);
      render();
      break;
    }
    case "delversions": {
      const rec = ctx.vault.reclaimable();
      if (!rec.versions.count) { toast("No old versions to remove", "err"); return; }
      const ok = await confirmDialog("Delete old versions?", `${rec.versions.count} kept snapshot${rec.versions.count === 1 ? "" : "s"} (${fmtBytes(rec.versions.bytes)}) will be removed from Telegram. Your current files are kept.`, "Delete versions", { danger: true });
      if (!ok) return;
      const r = await ctx.vault.deleteAllVersions();
      toast(`Freed ${fmtBytes(r.bytes)} — ${r.files} version${r.files === 1 ? "" : "s"} removed`);
      render();
      break;
    }
    case "clearsel":
      state.selection.clear();
      render();
      break;
    case "selectall": {
      const ids = navigableIds();
      const allSelected = ids.length && ids.every((id) => state.selection.has(id));
      if (allSelected) { state.selection.clear(); }
      else setSelection(ids);
      render();
      break;
    }
    case "new":
      openNewMenu();
      break;
    case "newfolder":
      await createFolderFlow();
      break;
    case "upload":
      $("fileInput").click();
      break;
    case "uploaddir":
      $("folderInput").click();
      break;
    case "settings":
      openSettings();
      break;
    case "openapp":
      leaveShare();
      break;
    case "tclear":
      ctx.tm.clearFinished();
      renderTransfersPanel();
      break;
  }
}

async function createFolderFlow() {
  const name = await promptDialog("New folder", "Folder name", "Untitled folder", "Create");
  if (!name) return;
  const parent = state.section === "drive" ? state.folderId : "root";
  const f = ctx.vault.createFolder(name, parent);
  state.section = "drive";
  state.folderId = parent;
  render();
  toast(`Folder "${escapeHtml(f.name)}" created`);
}

async function renameNode(node) {
  const name = await promptDialog("Rename", "New name", node.name, "Rename");
  if (!name || name === node.name) return;
  ctx.vault.renameNode(node.id, name);
  render();
}

async function moveNodes(nodes) {
  if (!nodes.length) return;
  const sh = ctx.vault.shared;
  if (sh && sh.isFile) { toast("Move isn't available for a single shared file", "err"); return; }
  const scoped = sh && sh.rootId !== "root";
  const options = scoped ? [] : [{ id: "root", name: "My Drive", depth: 0 }];
  const walk = (parentId, depth) => {
    for (const f of ctx.vault.drive.folders) {
      if (f.parentId !== parentId || f.trashed) continue;
      if (nodes.some((n) => n.id === f.id)) continue;
      if (scoped && !ctx.vault.inSharedScope(f.id)) continue;
      options.push({ id: f.id, name: f.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(scoped ? sh.rootId : "root", 0);
  const body = `<div class="field"><label>Move ${nodes.length} item${nodes.length === 1 ? "" : "s"} to</label>
    <div style="max-height:300px;overflow:auto;border:1px solid var(--border);border-radius:8px">
      ${options.map((o) => `<button type="button" data-folder="${escapeHtml(o.id)}" style="display:flex;gap:10px;align-items:center;width:100%;padding:9px 12px;text-align:left;padding-left:${12 + o.depth * 16}px">
        ${icon("folder", "icon-sm")}<span>${escapeHtml(o.name)}</span></button>`).join("")}
    </div></div>`;
  let picked = null;
  openModal({
    title: "Move to…", body,
    buttons: [{ label: "Cancel", kind: "text" }, { label: "Move", kind: "primary", onClick: () => { if (!picked) { toast("Pick a destination folder", "err"); return true; } ctx.vault.moveNodes(nodes.map((n) => n.id), picked); state.selection.clear(); render(); return; } }],
    onMount: (modal) => {
      modal.addEventListener("click", (e) => {
        const b = e.target.closest("[data-folder]");
        if (!b) return;
        picked = b.getAttribute("data-folder");
        modal.querySelectorAll("[data-folder]").forEach((x) => x.style.background = "");
        b.style.background = "var(--primary-soft)";
      });
    },
  });
}

function patternName(pattern, node, index, startAt) {
  const dot = node.name.lastIndexOf(".");
  const stem = dot > 0 ? node.name.slice(0, dot) : node.name;
  const ext = dot > 0 ? node.name.slice(dot) : "";
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const n = (Number(startAt) || 1) + index;
  return String(pattern || "{name}")
    .replace(/\{name\}/gi, stem)
    .replace(/\{ext\}/gi, ext)
    .replace(/\{nnn\}/gi, pad(n, 3))
    .replace(/\{nn\}/gi, pad(n))
    .replace(/\{n\}/gi, String(n))
    .replace(/\{index\}/gi, String(index + 1))
    .replace(/\{date\}/gi, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    .replace(/\{time\}/gi, `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`)
    .trim();
}

async function renameBulk(nodes) {
  if (!nodes.length) return;
  if (nodes.length === 1) return renameNode(nodes[0]);
  const ordered = nodes;
  openModal({
    title: `Rename ${nodes.length} items`,
    body: `<div class="field"><label>Pattern</label><input class="input" id="rnPattern" value="{name}" spellcheck="false"></div>
      <div class="field"><label>Start number</label><input class="input" id="rnStart" type="number" min="0" value="1"></div>
      <div class="hint">Tokens: <b>{name}</b> original name · <b>{ext}</b> extension · <b>{n}</b>/<b>{nn}</b>/<b>{nnn}</b> counter · <b>{index}</b> position · <b>{date}</b> · <b>{time}</b></div>
      <div class="field" style="margin-top:12px"><label>Preview</label><div class="rnprev" id="rnPreview"></div></div>`,
    buttons: [
      { label: "Cancel", kind: "text" },
      {
        label: "Rename", kind: "primary",
        onClick: (close, modal) => {
          const pat = modal.querySelector("#rnPattern").value;
          const start = Number(modal.querySelector("#rnStart").value) || 1;
          let changed = 0;
          ordered.forEach((n, i) => {
            const next = sanitizeName(patternName(pat, n, i, start));
            if (next && next !== n.name) { ctx.vault.renameNode(n.id, next); changed++; }
          });
          render();
          toast(`Renamed ${changed} item${changed === 1 ? "" : "s"}`);
        },
      },
    ],
    onMount: (modal) => {
      const pat = modal.querySelector("#rnPattern");
      const start = modal.querySelector("#rnStart");
      const prev = modal.querySelector("#rnPreview");
      const update = () => {
        const p = pat.value;
        const s = Number(start.value) || 1;
        prev.innerHTML = ordered.slice(0, 4).map((n, i) =>
          `<div>${escapeHtml(n.name)} <span style="color:var(--text-3)">→</span> ${escapeHtml(patternName(p, n, i, s))}</div>`).join("");
      };
      pat.addEventListener("input", update);
      start.addEventListener("input", update);
      update();
    },
  });
}

async function downloadAsZip(nodes) {
  const picked = (nodes || []).filter(Boolean);
  if (!picked.length) { toast("Nothing to zip", "err"); return; }
  try {
    const job = await ctx.tm.downloadZip(picked);
    renderTransfersPanel();
    const watch = setInterval(() => {
      if (job.status === "done") { clearInterval(watch); toast(`Zip ready · ${job.name}`); }
      else if (job.status === "error") { clearInterval(watch); toast(job.error || "Zip failed", "err"); }
      else if (job.status === "cancelled") clearInterval(watch);
    }, 900);
  } catch (e) {
    toast(String((e && e.message) || e), "err");
  }
}

async function downloadVersion(node, version) {
  const entry = {
    id: node.id + ":" + version.id,
    name: node.name,
    mime: version.mime || node.mime,
    size: version.size,
    parts: version.parts || [],
    enc: !!node.enc,
  };
  if (!entry.parts.length) { toast("This version has no data", "err"); return; }
  const target = entry.size > 8 * 1024 * 1024 ? await ctx.tm.pickSaveTarget(entry) : null;
  ctx.tm.downloadFile(entry, { target });
  renderTransfersPanel();
}

function openVersions(node) {
  const listHtml = () => {
    const vs = ctx.vault.versionsOf(node.id);
    if (!vs.length) return `<div class="hint">No earlier versions are stored for this file.</div>`;
    return vs.map((v, i) => `<div class="verrow">
      <div style="flex:1;min-width:0">
        <div class="vername">v${vs.length - i} <span class="badge">${escapeHtml(fmtBytes(v.size))}</span></div>
        <div class="verdate">${escapeHtml(fmtDate(v.createdAt))}</div>
      </div>
      <button class="btn ghost" type="button" data-vdown="${escapeHtml(v.id)}">Download</button>
      <button class="btn ghost" type="button" data-vrestore="${escapeHtml(v.id)}">Restore</button>
      <button class="iconbtn" type="button" data-vdel="${escapeHtml(v.id)}" title="Delete this version">${icon("trash", "icon-sm")}</button>
    </div>`).join("");
  };
  openModal({
    title: `Versions · ${node.name}`,
    body: `<div class="hint" style="margin-bottom:10px">New uploads of the same file name become new versions instead of duplicates. Up to ${cfg.maxVersions} older copies are kept.</div>
      <div id="verList">${listHtml()}</div>`,
    buttons: [{ label: "Done", kind: "primary" }],
    onMount: (modal) => {
      modal.addEventListener("click", async (e) => {
        const d = e.target.closest("[data-vdown]");
        const r = e.target.closest("[data-vrestore]");
        const x = e.target.closest("[data-vdel]");
        const find = (id) => (node.versions || []).find((v) => v.id === id);
        if (d) { const v = find(d.getAttribute("data-vdown")); if (v) await downloadVersion(node, v); }
        if (r) {
          const id = r.getAttribute("data-vrestore");
          const ok = await confirmDialog("Restore this version?", "The current content will be kept as an older version.", "Restore");
          if (!ok) return;
          ctx.vault.restoreVersion(node.id, id);
          await ctx.vault.flushSaves();
          modal.querySelector("#verList").innerHTML = listHtml();
          render();
          toast("Version restored");
        }
        if (x) {
          const id = x.getAttribute("data-vdel");
          ctx.vault.deleteVersion(node.id, id);
          modal.querySelector("#verList").innerHTML = listHtml();
          render();
          toast("Version deleted");
        }
      });
    },
  });
}

function appBaseUrl() {
  return "https://perchance.org/" + (window.generatorName || "");
}

function shareLink(token) {
  return `${appBaseUrl()}#share=${encodeURIComponent(token)}`;
}

function shareExpiryLabel(expiresAt) {
  if (!expiresAt) return "Never expires";
  return "Expires " + new Date(expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function maskToken(token) {
  const t = String(token || "");
  return t.length > 9 ? `${t.slice(0, 5)}…${t.slice(-4)}` : t;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) { return false; }
}

function shareDialogHtml(node, dlg) {
  const acc = ctx.vault.account;
  const existing = ctx.vault.sharesForNode(node.id);
  const enc = !!(acc && acc.enc);
  const roleCard = (perm, title, hint) => `<button type="button" class="rolecard${dlg.perm === perm ? " on" : ""}" data-role="${perm}">
      <div class="rt">${icon(perm === "edit" ? "edit" : "eye", "icon-sm")}${title}</div>
      <div class="rh">${hint}</div>
    </button>`;
  const opt = (v, label) => `<option value="${v}"${Number(dlg.days) === v ? " selected" : ""}>${label}</option>`;
  const rows = existing.map((s) => `<div class="sharerow">
      <span style="display:inline-flex;flex:none;color:var(--text-2)">${icon(s.perm === "edit" ? "edit" : "eye", "icon-sm")}</span>
      <div class="srmeta">
        <div class="srtitle">
          <select class="sortsel" data-share="role" data-token="${escapeHtml(s.token)}" style="height:26px">
            <option value="view"${s.perm === "view" ? " selected" : ""}>Viewer</option>
            <option value="edit"${s.perm === "edit" ? " selected" : ""}>Editor</option>
          </select>
          ${s.name ? `<span style="font-weight:400">${escapeHtml(s.name)}</span>` : ""}
          <span style="color:var(--text-3);font-weight:400">${escapeHtml(shareExpiryLabel(s.expiresAt))}</span>
        </div>
        <div class="srsub">${escapeHtml(maskToken(s.token))}${s.enc ? " · password protected" : ""}</div>
      </div>
      <button class="btn ghost" type="button" data-share="copy" data-token="${escapeHtml(s.token)}">Copy</button>
      <button class="iconbtn" type="button" data-share="revoke" data-token="${escapeHtml(s.token)}" title="Stop sharing">${icon("trash")}</button>
    </div>`).join("");
  const created = dlg.created ? ctx.vault.shareByToken(dlg.created) : null;
  return `
    <div class="sharehead">${isFolder(node) ? icon("folder", "icon") : fileIcon(node.kind, node.name, "icon")}<b>${escapeHtml(node.name)}</b></div>
    <div class="hint" style="margin:3px 0 14px">Anyone with the link can open this exact item — they don't need an account.${enc ? " This drive is encrypted, so the link needs a password." : ""}</div>
    <div class="sectionlabel" style="margin-left:0">General access</div>
    <div class="rolegrid">
      ${roleCard("view", "Viewer", "Can preview and download the items in this share.")}
      ${roleCard("edit", "Editor", "Can also upload, rename, move and delete items.")}
    </div>
    <div class="field" style="margin-top:14px"><label>Link expires</label>
      <select class="input" data-share="expiry">${opt(0, "Never")}${opt(1, "1 day")}${opt(7, "7 days")}${opt(30, "30 days")}${opt(90, "90 days")}</select>
    </div>
    ${enc ? `<div class="field"><label>Link password</label>
      <input class="input" type="password" data-share="pw" value="${escapeHtml(dlg.pw || "")}" placeholder="at least 4 characters" autocomplete="new-password">
      <div class="hint">The recipient types this to unlock the encrypted contents. Only a wrapped copy of the key is stored — your account password is never exposed.</div>
    </div>` : ""}
    <div class="field"><label>Link name <span style="color:var(--text-3)">(optional)</span></label>
      <input class="input" data-share="name" value="${escapeHtml(dlg.name || "")}" placeholder="e.g. For the design team" maxlength="60">
    </div>
    ${created ? `
      <div class="sectionlabel" style="margin-left:0">New link</div>
      <div class="linkrow"><input class="input" readonly value="${escapeHtml(shareLink(created.token))}"><button class="btn primary" type="button" data-share="copy" data-token="${escapeHtml(created.token)}">Copy</button></div>`
    : `<button class="btn primary" type="button" data-share="create" style="width:100%">${dlg.busy ? "Creating…" : "Create link"}</button>`}
    ${existing.length ? `<div class="sectionlabel" style="margin-left:0">Links for this item</div><div class="sharelist">${rows}</div>` : ""}
    ${node.id !== "root" ? `<div style="margin-top:14px;text-align:center"><button class="btn ghost" type="button" data-share="makedrive">Share your entire drive instead</button></div>` : ""}
  `;
}

function openShareDialog(node) {
  const acc = ctx.vault.account;
  if (!acc) return;
  const dlg = { perm: "view", days: 0, pw: "", name: "", created: null, busy: false };
  openModal({
    title: "Share",
    width: 560,
    body: `<div id="shareBody"></div>`,
    buttons: [{ label: "Done", kind: "primary" }],
    onMount: (modal) => {
      const body = modal.querySelector("#shareBody");
      const paint = () => { body.innerHTML = shareDialogHtml(node, dlg); };
      paint();

      body.addEventListener("click", async (e) => {
        const role = e.target.closest("[data-role]");
        if (role) { dlg.perm = role.getAttribute("data-role"); dlg.created = null; paint(); return; }
        const act = e.target.closest("[data-share]");
        if (!act) return;
        const kind = act.getAttribute("data-share");
        const token = act.getAttribute("data-token");
        if (kind === "makedrive") {
          modal.closest(".scrim").remove();
          openShareDialog(ctx.vault.getNode("root"));
          return;
        }
        if (kind === "copy") {
          const ok = await copyText(shareLink(token));
          toast(ok ? "Link copied" : "Press Ctrl/Cmd+C to copy", ok ? "" : "err");
          return;
        }
        if (kind === "revoke") {
          const ok = await confirmDialog("Stop sharing?", "This link stops working immediately for anyone who has it.", "Stop sharing", { danger: true });
          if (!ok) return;
          await ctx.vault.revokeShare(token);
          if (dlg.created === token) dlg.created = null;
          toast("Sharing stopped");
          paint();
          render();
          return;
        }
        if (kind === "create") {
          if (acc.enc && (!dlg.pw || dlg.pw.length < 4)) { toast("Set a link password (4+ characters)", "err"); return; }
          dlg.busy = true; paint();
          try {
            const expiresAt = dlg.days ? Date.now() + dlg.days * 86400000 : 0;
            const share = await ctx.vault.createShare(node.id, dlg.perm, { expiresAt, password: dlg.pw || undefined, name: dlg.name || "" });
            dlg.created = share.token; dlg.busy = false; dlg.pw = "";
            paint();
            const ok = await copyText(shareLink(share.token));
            toast(ok ? "Link created and copied" : "Link created");
            render();
          } catch (err) {
            dlg.busy = false; paint();
            toast(String((err && err.message) || err), "err");
          }
          return;
        }
      });

      body.addEventListener("input", (e) => {
        const pw = e.target.closest('[data-share="pw"]');
        if (pw) dlg.pw = pw.value;
        const nm = e.target.closest('[data-share="name"]');
        if (nm) dlg.name = nm.value;
      });
      body.addEventListener("change", async (e) => {
        const exp = e.target.closest('[data-share="expiry"]');
        if (exp) { dlg.days = Number(exp.value) || 0; return; }
        const role = e.target.closest('[data-share="role"]');
        if (role) {
          const token = role.getAttribute("data-token");
          try { await ctx.vault.updateShare(token, { perm: role.value }); toast("Access updated"); }
          catch (err) { toast(String((err && err.message) || err), "err"); }
          paint();
          render();
        }
      });
    },
  });
}

async function shareNodes(nodes) {
  if (!nodes.length) return;
  if (nodes.length > 1) toast("Links are created one item at a time — sharing the first selected item");
  openShareDialog(nodes[0]);
}

/* --------------------------------------------------------- copy to a drive */

/* Copying a shared item into one of your own accounts means reading the bytes
 * with the share's key, then re-uploading them with the target account's key —
 * so the files are decrypted once and re-encrypted per target. To keep memory
 * bounded we only do this for reasonably sized selections and stream nothing. */
const COPY_MAX_BYTES = 512 * 1024 * 1024;

function buildCopyPlan(vault, sources) {
  const files = [];
  let totalBytes = 0;
  const walk = (node, path) => {
    if (isFolder(node)) {
      const kids = vault.children(node.id);
      const next = [...path, node.name];
      for (const f of kids.folders) walk(f, next);
      for (const f of kids.files) walk(f, next);
    } else if ((node.parts || []).length) {
      files.push({ node, path });
      totalBytes += Number(node.size) || 0;
    }
  };
  for (const s of sources) walk(s, []);
  return { files, totalBytes };
}

function pickAccountForCopy(vault) {
  return new Promise((resolve) => {
    const accs = (vault.index && vault.index.accounts) || [];
    if (!accs.length) {
      toast("You have no account to copy into yet — open KamsClouds and create one first.", "err");
      resolve(null);
      return;
    }
    const rows = accs.map((a) => `<button class="authacct" data-copyto="${escapeHtml(a.id)}">
        ${avatarHtml(a, "avatar lg")}<span class="nm">${escapeHtml(a.name)}</span>
        ${a.enc ? `<span class="lbl" style="font-size:11px">${icon("key", "icon-sm")} locked</span>` : ""}
      </button>`).join("");
    openModal({
      title: "Save a copy to…",
      body: `<p style="margin:6px 0 14px;color:var(--text-2)">Choose the account that should receive a copy. You'll be asked for its password.</p>
        <div class="authaccts" style="justify-content:center">${rows}</div>`,
      buttons: [{ label: "Cancel", kind: "text", onClick: () => resolve(null) }],
      onMount: (modal, close) => {
        modal.addEventListener("click", (e) => {
          const b = e.target.closest("[data-copyto]");
          if (!b) return;
          resolve(b.getAttribute("data-copyto"));
          close();
        });
      },
    });
  });
}

function progressOverlay(title, message) {
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.style.zIndex = "500";
  scrim.innerHTML = `<div class="modal" style="max-width:380px;text-align:center">
    <h3 style="justify-content:center">${escapeHtml(title)}</h3>
    <div class="mbody" style="text-align:center">
      <div class="spin" style="margin:4px auto 16px"></div>
      <div class="msg" style="color:var(--text-2);font-size:13px;min-height:20px">${escapeHtml(message || "")}</div>
      <div style="height:6px;border-radius:3px;background:var(--surface-2);overflow:hidden;margin-top:16px">
        <i class="bar" style="display:block;height:100%;width:0;background:var(--primary);transition:width .25s ease"></i>
      </div>
    </div>
  </div>`;
  $("modalRoot").appendChild(scrim);
  return {
    set(msg, pct) {
      const m = scrim.querySelector(".msg");
      if (m) m.textContent = msg;
      const b = scrim.querySelector(".bar");
      if (b && pct != null) b.style.width = Math.max(0, Math.min(100, pct)) + "%";
    },
    close() { scrim.remove(); },
  };
}

async function readNodeBlob(node) {
  const parts = node.parts || [];
  if (!parts.length) return new Blob([]);
  const job = ctx.tm._newJob({
    type: "download", name: node.name, size: node.size, entry: node,
    chunkTotal: parts.length, encrypted: !!node.enc,
  });
  job.status = "active";
  const bags = [];
  try {
    await ctx.tm._downloadParts(job, { write: async (u8) => { bags.push(u8); }, close: async () => {} });
  } finally {
    job.status = "done";
    job.transferred = job.size;
    job.endedAt = Date.now();
    ctx.tm.emit();
  }
  return new Blob(bags, { type: node.mime || "application/octet-stream" });
}

function waitForUploads(jobs) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const live = jobs.filter((j) => j.status === "active" || j.status === "queued" || j.status === "paused");
      if (live.length) { setTimeout(tick, 250); return; }
      const bad = jobs.filter((j) => j.status === "error");
      if (bad.length) reject(new Error(String(bad[0].error || "upload failed")));
      else resolve();
    };
    tick();
  });
}

let _copyBusy = false;

async function copyToMyDrive() {
  const v = ctx.vault;
  if (!v.shared) { toast("Open a shared link first, then you can save items to your own drive", "err"); return; }
  if (_copyBusy) { toast("A copy is already running", "err"); return; }
  /* The chrome can paint before openSharedDrive() has finished fetching the
   * drive, so make sure we resolve sources against the fully-loaded tree. */
  for (let i = 0; i < 60 && v.status.phase !== "ready"; i++) await new Promise((r) => setTimeout(r, 150));
  if (v.status.phase !== "ready" || !v.drive) { toast("Still loading the shared item — try again in a moment", "err"); return; }

  const sh = v.shared;
  let sources = selectedNodes();
  if (!sources.length) {
    if (sh.isFile && sh.fileId) {
      const f = v.getNode(sh.fileId);
      if (f) sources = [f];
    }
    if (!sources.length) {
      const here = state.folderId && state.folderId !== "root" ? v.getNode(state.folderId) : null;
      if (here) sources = [here];
    }
    if (!sources.length && sh.nodeId && sh.nodeId !== "root") {
      const n = v.getNode(sh.nodeId);
      if (n) sources = [n];
    }
    if (!sources.length) {
      const kids = v.children("root");
      sources = [...kids.folders, ...kids.files];
    }
  }
  if (!sources.length) { toast("Nothing to copy here", "err"); return; }

  const plan = buildCopyPlan(v, sources);
  if (!plan.files.length) { toast("There are no files to copy here", "err"); return; }
  if (plan.totalBytes > COPY_MAX_BYTES) {
    toast(`Too large to copy (${fmtBytes(plan.totalBytes)}). The limit is ${fmtBytes(COPY_MAX_BYTES)}.`, "err");
    return;
  }

  const targetId = await pickAccountForCopy(v);
  if (!targetId) return;
  const target = v.getAccount(targetId);
  if (target && target.id === v.shared.accId) {
    toast("That's the account that shared this item — pick a different one", "err");
    return;
  }

  const label = plan.files.length === 1 ? `"${plan.files[0].node.name}"` : `${plan.files.length} files`;
  const ok = await confirmDialog("Save a copy?", `${label} (${fmtBytes(plan.totalBytes)}) will be copied into "${target.name}". This can generate new Telegram messages.`, "Copy");
  if (!ok) return;

  let password = null;
  for (let tries = 0; tries < 4; tries++) {
    const pass = await promptDialog(`Save to "${target.name}"`, `Enter the password for "${target.name}".`, "", "Copy", { type: "password" });
    if (pass == null) return;
    try { await v.checkPassword(targetId, pass); password = pass; break; }
    catch (e) { toast(String((e && e.message) || e), "err"); }
  }
  if (password == null) return;

  const ov = progressOverlay("Saving a copy", `Preparing ${plan.files.length} file${plan.files.length === 1 ? "" : "s"}…`);
  _copyBusy = true;
  const finish = (fn) => { try { fn(); } finally { _copyBusy = false; ov.close(); } };
  try {
    const staged = [];
    let done = 0;
    for (const item of plan.files) {
      ov.set(`Reading ${done + 1}/${plan.files.length} — ${item.node.name}`, (done / plan.files.length) * 55);
      const blob = await readNodeBlob(item.node);
      staged.push({ name: item.node.name, path: item.path, mime: item.node.mime || "", blob });
      done += 1;
    }

    ov.set(`Switching to "${target.name}"…`, 58);
    let uploaded = 0;
    await v.withAccount(targetId, password, async () => {
      const dirs = new Map([["", "root"]]);
      const ensureDir = (path) => {
        let parent = "root";
        let key = "";
        for (const seg of path) {
          key = key ? `${key}/${seg}` : seg;
          if (dirs.has(key)) { parent = dirs.get(key); continue; }
          const folder = ctx.vault.createFolder(seg, parent);
          dirs.set(key, folder.id);
          parent = folder.id;
        }
        return parent;
      };
      for (const s of staged) {
        const parent = ensureDir(s.path);
        const file = new File([s.blob], s.name, { type: s.mime || "application/octet-stream" });
        const jobs = await ctx.tm.enqueueUploads([file], parent);
        await waitForUploads(jobs);
        s.blob = null;
        uploaded += 1;
        ov.set(`Copying ${uploaded}/${staged.length} — ${s.name}`, 58 + (uploaded / staged.length) * 40);
      }
    });

    state.selection.clear();
    render();
    finish(() => toast(`Copied ${staged.length} file${staged.length === 1 ? "" : "s"} to "${escapeHtml(target.name)}"`));
  } catch (e) {
    finish(() => toast("Copy failed: " + String((e && e.message) || e), "err"));
  }
}

/* ------------------------------------------------------------- downloads */

async function downloadNodes(nodes) {
  const files = nodes.filter((n) => !isFolder(n));
  if (!files.length) { toast("Nothing to download", "err"); return; }
  if (files.length === 1) {
    const target = files[0].size > 8 * 1024 * 1024 ? await ctx.tm.pickSaveTarget(files[0]) : null;
    ctx.tm.downloadFile(files[0], { target });
    renderTransfersPanel();
    return;
  }
  for (const f of files) {
    ctx.tm.downloadFile(f, { target: null });
    await new Promise((r) => setTimeout(r, 400));
  }
  renderTransfersPanel();
  toast(`Downloading ${files.length} files`);
}

export function openViewer(node) {
  if (!node || isFolder(node)) return;
  const list = [...document.querySelectorAll("#browserEl [data-id]")]
    .map((el) => ctx.vault.getNode(el.getAttribute("data-id")))
    .filter((n) => n && !isFolder(n));
  let idx = list.findIndex((n) => n.id === node.id);
  const v = document.createElement("div");
  v.className = "viewer";
  document.body.appendChild(v);
  const close = () => { document.removeEventListener("keydown", onKey); v.remove(); };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "ArrowRight" && idx < list.length - 1) { idx++; show(list[idx]); }
    if (e.key === "ArrowLeft" && idx > 0) { idx--; show(list[idx]); }
  };
  document.addEventListener("keydown", onKey);

  async function show(n) {
    node = n;
    v.innerHTML = `<div class="vhead">
        ${fileIcon(n.kind, n.name, "icon")}
        <span class="vname">${escapeHtml(n.name)}</span>
        <span class="badge">${escapeHtml(KIND_LABEL[n.kind] || "File")}</span>
        <span class="badge">${escapeHtml(fmtBytes(n.size))}</span>
        <button class="iconbtn" data-v="download" title="Download">${icon("download")}</button>
        <button class="iconbtn" data-v="close" title="Close">${icon("close")}</button>
      </div>
      <div class="vstage"><div class="spin spin-lg"></div></div>
      <div class="vfoot">${idx > 0 ? `<button class="iconbtn" data-v="prev">${icon("chevronLeft")}</button>` : ""}
        ${idx < list.length - 1 ? `<button class="iconbtn" data-v="next">${icon("chevronRight")}</button>` : ""}</div>`;
    v.querySelector('[data-v="close"]').onclick = close;
    v.querySelector('[data-v="download"]').onclick = () => downloadNodes([n]);
    const prev = v.querySelector('[data-v="prev"]'); if (prev) prev.onclick = () => { idx--; show(list[idx]); };
    const next = v.querySelector('[data-v="next"]'); if (next) next.onclick = () => { idx++; show(list[idx]); };
    const stage = v.querySelector(".vstage");
    try {
      if (n.kind === "text" || n.kind === "code" || n.kind === "sheet") {
        const text = await ctx.tm.readTextHead(n, 400 * 1024);
        stage.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
      } else if (n.kind === "image" || n.kind === "video" || n.kind === "audio" || n.kind === "pdf") {
        const src = await getPreviewSrc(n);
        if (!src) throw new Error("no preview");
        if (n.kind === "image") stage.innerHTML = `<img src="${escapeHtml(src)}" alt="">`;
        else if (n.kind === "video") stage.innerHTML = `<video src="${escapeHtml(src)}" controls autoplay></video>`;
        else if (n.kind === "audio") stage.innerHTML = `<audio src="${escapeHtml(src)}" controls autoplay></audio>`;
        else stage.innerHTML = `<iframe src="${escapeHtml(src)}" title="${escapeHtml(n.name)}"></iframe>`;
      } else {
        throw new Error("no preview");
      }
    } catch (e) {
      stage.innerHTML = `<div style="text-align:center;color:#e8eaed">
        ${fileIcon(n.kind, n.name, "icon-lg")}
        <div style="margin:16px 0;opacity:.85">This file type can't be previewed here.</div>
        <button class="btn primary" data-v="download">${icon("download", "icon-sm")} Download</button></div>`;
      stage.querySelector('[data-v="download"]').onclick = () => downloadNodes([n]);
    }
  }
  show(node);
}

/* --------------------------------------------------------------- uploads */

async function uploadFiles(files, parentId) {
  if (!files.length) return;
  if (ctx.vault.readOnly) { toast("This share is view-only", "err"); return; }
  if (ctx.vault.shared && ctx.vault.shared.isFile) { toast("Can't upload into a single-file share", "err"); return; }
  try {
    const newBytes = files.reduce((n, f) => n + (Number(f.size) || 0), 0);
    if (!guardUpload(ctx, newBytes)) return;
  } catch (e) { /* license gate must never break uploads on error */ }
  let jobs;
  try {
    jobs = await ctx.tm.uploadFiles(files, parentId || "root");
  } catch (e) {
    toast(String((e && e.message) || e), "err");
    return;
  }
  renderTransfersPanel();
  const bad = jobs.filter((j) => j.status === "error");
  if (bad.length) toast(bad[0].error || "Upload failed", "err");
}

function filesFromFileList(list, withRel) {
  const out = [];
  for (const f of list) {
    const rel = withRel ? (f.webkitRelativePath || "") : "";
    out.push({ file: f, rel });
  }
  return out;
}

function ensureFolderPath(parentId, rel) {
  const parts = String(rel || "").split("/").filter(Boolean);
  if (parts.length) parts.pop();
  let cur = parentId || "root";
  for (const p of parts) {
    const existing = ctx.vault.drive.folders.find((f) => f.parentId === cur && f.name.toLowerCase() === p.toLowerCase() && !f.trashed);
    cur = existing ? existing.id : ctx.vault.createFolder(p, cur).id;
  }
  return cur;
}

async function uploadEntries(entries, parentId) {
  const groups = new Map();
  for (const { file, rel } of entries) {
    const folderId = rel ? ensureFolderPath(parentId, rel) : (parentId || "root");
    if (!groups.has(folderId)) groups.set(folderId, []);
    groups.get(folderId).push(file);
  }
  render();
  for (const [folderId, files] of groups) {
    await uploadFiles(files, folderId);
  }
}

async function getDroppedEntries(dt) {
  const items = dt.items ? [...dt.items] : [];
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) return [...dt.files].map((f) => ({ file: f, rel: "" }));
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, rel: prefix });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let kids = [];
      do {
        kids = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const k of kids) await walk(k, prefix + entry.name + "/");
      } while (kids.length);
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

/* -------------------------------------------------------------- settings */

function openSettings() {
  const v = ctx.vault;
  const acc = v.account;
  const s = v.status;
  const body = `
    <div class="field"><label>Account</label>
      <div style="display:flex;align-items:center;gap:10px">${avatarHtml(acc)}<div style="flex:1"><div style="font-weight:500">${escapeHtml(acc ? acc.name : "")}</div><div style="font-size:12px;color:var(--text-2)">${escapeHtml(fmtBytes(v.bytesUsed()))} used · ${(v.drive.files || []).length} files</div></div></div>
    </div>
    <div class="field"><label>Appearance</label>
      <div style="display:flex;gap:8px">
        <button class="btn ghost" data-set="theme" data-val="light" type="button">Light</button>
        <button class="btn ghost" data-set="theme" data-val="dark" type="button">Dark</button>
        <button class="btn ghost" data-set="theme" data-val="auto" type="button">System</button>
      </div>
    </div>
    <div class="field"><label>Default view</label>
      <div style="display:flex;gap:8px">
        <button class="btn ghost" data-set="view" data-val="grid" type="button">Grid</button>
        <button class="btn ghost" data-set="view" data-val="list" type="button">List</button>
      </div>
    </div>
    <div class="field"><label>Download connections (higher = faster, more memory): ${cfg.downloadConcurrency}</label>
      <input type="range" min="2" max="16" value="${cfg.downloadConcurrency}" data-set="concurrency" style="width:100%">
    </div>
    <div class="field"><label>Chunks per file (parallel download segments): ${cfg.targetChunks}</label>
      <input type="range" min="4" max="32" value="${cfg.targetChunks}" data-set="chunks" style="width:100%">
    </div>
    <div class="field"><label>Connection</label>
      <div class="kv"><span class="k">Chat</span><span class="v">${escapeHtml((v.chat && v.chat.title) || cfg.chatId)}</span></div>
      <div class="kv"><span class="k">Bot</span><span class="v">${escapeHtml((ctx.vault.botInfo && ctx.vault.botInfo.username) || "—")}</span></div>
      <div class="kv"><span class="k">Sync</span><span class="v">${escapeHtml(s.syncState)}${s.lastError ? " · " + escapeHtml(String(s.lastError.message || s.lastError)) : ""}</span></div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
        <div class="hint">Shared drive — same backend for all accounts.</div>
      </div>
    </div>
    <div class="field"><label>Upload connections: ${cfg.uploadConcurrency}</label>
      <input type="range" min="1" max="${cfg.maxUploadConcurrency}" value="${cfg.uploadConcurrency}" data-set="upconcurrency" style="width:100%">
    </div>
    <div class="field"><label>Chunk size</label>
      <select class="input" data-set="chunksize">
        <option value="0"${state.chunkMiB ? "" : " selected"}>Automatic — 4–8 MiB (works with api.telegram.org)</option>
        <option value="16"${state.chunkMiB === 16 ? " selected" : ""}>16 MiB</option>
        <option value="32"${state.chunkMiB === 32 ? " selected" : ""}>32 MiB</option>
        <option value="64"${state.chunkMiB === 64 ? " selected" : ""}>64 MiB</option>
        <option value="128"${state.chunkMiB === 128 ? " selected" : ""}>128 MiB</option>
        <option value="256"${state.chunkMiB === 256 ? " selected" : ""}>256 MiB</option>
        <option value="1024"${state.chunkMiB === 1024 ? " selected" : ""}>1024 MiB</option>
        <option value="1900"${state.chunkMiB === 1900 ? " selected" : ""}>1900 MiB (single chunk)</option>
      </select>
      <div class="hint">Chunks above 8 MiB need a self-hosted Bot API server — set the API base below to it first.</div>
    </div>
    <div class="field"><label>Speed limit</label>
      <select class="input" data-set="speed">
        <option value="0"${!cfg.maxSpeedMBps ? " selected" : ""}>Unlimited</option>
        <option value="1"${cfg.maxSpeedMBps === 1 ? " selected" : ""}>1 MB/s</option>
        <option value="2"${cfg.maxSpeedMBps === 2 ? " selected" : ""}>2 MB/s</option>
        <option value="5"${cfg.maxSpeedMBps === 5 ? " selected" : ""}>5 MB/s</option>
        <option value="10"${cfg.maxSpeedMBps === 10 ? " selected" : ""}>10 MB/s</option>
        <option value="25"${cfg.maxSpeedMBps === 25 ? " selected" : ""}>25 MB/s</option>
      </select>
      <div class="hint">Caps the combined upload + download rate. Useful on metered or shared connections.</div>
    </div>
    <div class="field"><label>Version history</label>
      <label class="checkrow"><input type="checkbox" data-set="keepversions" ${state.keepVersions ? "checked" : ""}><span>Keep older versions when the same file name is uploaded again</span></label>
    </div>
    <div class="field"><label>Auto-empty trash</label>
      <select class="input" data-set="trashdays">
        <option value="0"${!state.trashDays ? " selected" : ""}>Never (empty it manually)</option>
        <option value="7"${state.trashDays === 7 ? " selected" : ""}>After 7 days</option>
        <option value="14"${state.trashDays === 14 ? " selected" : ""}>After 14 days</option>
        <option value="30"${state.trashDays === 30 ? " selected" : ""}>After 30 days</option>
        <option value="90"${state.trashDays === 90 ? " selected" : ""}>After 90 days</option>
      </select>
    </div>
    <div class="field"><label>Encryption</label>
      ${acc && acc.enc ? `
        <div class="kv"><span class="k">Status</span><span class="v">${v.encKey ? "Unlocked" : "Locked"}</span></div>
        <div class="kv"><span class="k">Mode</span><span class="v">AES-GCM · per account</span></div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          ${v.encKey ? `<button class="btn ghost" data-set="lock" type="button">Lock now</button>` : `<button class="btn ghost" data-set="unlock" type="button">Unlock</button>`}
          <button class="btn ghost" data-set="chpass" type="button">Change password</button>
          ${v.encKey ? `<button class="btn ghost" data-set="rotatekey" type="button">Rotate key</button>` : ""}
        </div>
        <div class="hint">File contents are encrypted on this device before they are uploaded, so nobody else in the Telegram chat can read them. <b>Rotate key</b> re-encrypts everything with a fresh key and revokes every share link.</div>`
        : `<div class="kv"><span class="k">Status</span><span class="v">Off — files are stored as-is in Telegram</span></div>
        <div class="hint">Encryption is chosen when an account is created, so enabling it later would require re-uploading everything. Create a new encrypted account to use it.</div>
        <div style="display:flex;gap:8px;margin-top:8px"><button class="btn ghost" data-set="chpass" type="button">Change password</button></div>`}
    </div>
    <div class="navsep"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn ghost" data-set="signout" type="button">Sign out</button>
      <button class="btn ghost" data-set="switch" type="button">Switch account</button>
      <button class="btn danger" data-set="deleteacct" type="button">Delete account</button>
    </div>`;
  openModal({
    title: "Settings", body, width: 520,
    buttons: [{ label: "Done", kind: "primary" }],
    onMount: (modal) => {
      modal.addEventListener("input", (e) => {
        const t = e.target.closest("[data-set]");
        if (!t) return;
        const kind = t.getAttribute("data-set");
        if (kind === "concurrency") { cfg.downloadConcurrency = Number(t.value); saveSettings(); }
        if (kind === "upconcurrency") { cfg.uploadConcurrency = Number(t.value); saveSettings(); }
        if (kind === "chunks") { cfg.targetChunks = Number(t.value); saveSettings(); }
        if (kind === "keepversions") { state.keepVersions = t.checked; ctx.vault.keepVersions = t.checked; saveSettings(); }
        if (kind === "trashdays") { state.trashDays = Number(t.value) || 0; saveSettings(); }
        if (kind === "chunksize") { state.chunkMiB = Number(t.value) || 0; applyChunkSize(state.chunkMiB); saveSettings(); }
        if (kind === "speed") { cfg.maxSpeedMBps = Number(t.value) || 0; saveSettings(); }
        const lbl = t.closest(".field") && t.closest(".field").querySelector("label");
        if (lbl) lbl.textContent = lbl.textContent.replace(/:\s*[0-9]+$/, ": " + t.value);
      });
      modal.addEventListener("click", async (e) => {
        const t = e.target.closest("[data-set]");
        if (!t || t.tagName === "INPUT" || t.tagName === "SELECT") return;
        const kind = t.getAttribute("data-set");
        const val = t.getAttribute("data-val");
        if (kind === "theme") { state.theme = val === "auto" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : val; applyTheme(); saveSettings(); }
        if (kind === "view") { state.view = val; saveSettings(); render(); }
        if (kind === "lock") { ctx.vault.lock(); toast("Drive locked — encrypted files need the password again"); modal.closest(".scrim").remove(); }
        if (kind === "unlock") {
          const pass = await promptDialog("Unlock drive", "Password", "", "Unlock", { type: "password" });
          if (pass == null) return;
          try {
            await ctx.vault.unlock(pass);
            toast("Drive unlocked");
            modal.closest(".scrim").remove();
            render();
          } catch (err) { toast(String(err.message || err), "err"); }
        }
        if (kind === "chpass") {
          const cur = await promptDialog("Change password", "Current password", "", "Continue", { type: "password" });
          if (cur == null) return;
          const next = await promptDialog("Change password", "New password (6+ characters)", "", "Continue", { type: "password" });
          if (next == null) return;
          if (next !== (await promptDialog("Change password", "Repeat new password", "", "Save", { type: "password" }))) { toast("Passwords do not match", "err"); return; }
          try {
            await ctx.vault.changePassword(cur, next);
            toast("Password changed");
          } catch (err) { toast(String(err.message || err), "err"); }
        }
        if (kind === "signout") { await ctx.vault.logOut(); modal.closest(".scrim").remove(); showAuth(); }
        if (kind === "switch") { await ctx.vault.logOut(); modal.closest(".scrim").remove(); showAuth(); }
        if (kind === "rotatekey") {
          const ok = await confirmDialog("Rotate encryption key?", "Every file is re-encrypted with a brand-new key, so ALL existing share links stop working immediately. This re-uploads your whole drive and can take a while on a big drive.", "Rotate key", { danger: true });
          if (!ok) return;
          const pass = await promptDialog("Rotate key", "Enter your password to start", "", "Rotate", { type: "password" });
          if (pass == null) return;
          try {
            const r = await ctx.vault.rotateEncryptionKey(pass, (done, total, name) => {
              if (done === 1 || done === total || done % 5 === 0) toast(`Re-encrypting ${done}/${total}: ${escapeHtml(name)}`);
            });
            toast(`Key rotated — ${r.files} file${r.files === 1 ? "" : "s"} re-encrypted${r.failed ? `, ${r.failed} failed` : ""}. ${r.linksRevoked} link${r.linksRevoked === 1 ? "" : "s"} revoked.`);
            modal.closest(".scrim").remove();
            render();
          } catch (err) { toast(String(err.message || err), "err"); }
        }
        if (kind === "deleteacct") {
          const pass = await promptDialog("Delete account", `Type the password for "${acc.name}" to confirm`, "", "Delete", { type: "password" });
          if (pass == null) return;
          try {
            await ctx.vault.deleteAccount(acc.id, pass);
            modal.closest(".scrim").remove();
            toast("Account deleted");
            showAuth();
          } catch (err) { toast(String(err.message || err), "err"); }
        }
      });
    },
  });
}

function openAccountMenu() {
  const acc = ctx.vault.account;
  const vault = ctx.vault;
  const html = `
    <div style="display:flex;gap:14px;align-items:center;padding:14px 16px 12px">
      ${avatarHtml(acc, "avatar lg")}
      <div style="flex:1;min-width:0"><div style="font-weight:500">${escapeHtml(acc ? acc.name : "")}</div>
      <div style="font-size:12px;color:var(--text-2)">${escapeHtml(fmtBytes(ctx.vault.bytesUsed()))} used</div></div>
    </div>
    <div class="sep" style="height:1px;background:var(--border-soft);margin:0 0 6px"></div>
    <button data-d="settings">${icon("settings", "icon-sm")} Settings</button>
    <button data-d="activity">${icon("activity", "icon-sm")} Activity</button>
    ${acc && acc.enc ? `<button data-d="lock">${icon(vault.encKey ? "lock" : "unlock", "icon-sm")} ${vault.encKey ? "Lock drive" : "Unlock drive"}</button>` : ""}
    <button data-d="switch">${icon("people", "icon-sm")} Switch account</button>
    <button data-d="sync">${icon("refresh", "icon-sm")} Sync now</button>
    <div class="sep" style="height:1px;background:var(--border-soft);margin:6px 0"></div>
    <button data-d="signout">${icon("logout", "icon-sm")} Sign out</button>`;
  showDropdown($("accountBtn"), html, async (k) => {
    if (k === "settings") openSettings();
    if (k === "activity") { openFolder("root", "activity"); }
    if (k === "sync") syncNow();
    if (k === "lock") {
      if (vault.encKey) { vault.lock(); toast("Drive locked"); }
      else {
        const pass = await promptDialog("Unlock drive", "Password", "", "Unlock", { type: "password" });
        if (pass == null) return;
        try { await vault.unlock(pass); toast("Drive unlocked"); render(); }
        catch (e) { toast(String(e.message || e), "err"); }
      }
    }
    if (k === "switch" || k === "signout") {
      await ctx.vault.logOut();
      showAuth();
    }
  });
}

function openNewMenu(anchor) {
  const html = `
    <button data-d="newfolder">${icon("addFolder", "icon-sm")} New folder</button>
    <button data-d="upload">${icon("upload", "icon-sm")} File upload</button>
    <button data-d="uploaddir">${icon("folder", "icon-sm")} Folder upload</button>`;
  showDropdown(anchor || $("sidebarEl").querySelector('[data-act="new"]') || $("menuBtn"), html, (k) => {
    if (k === "newfolder") createFolderFlow();
    if (k === "upload") $("fileInput").click();
    if (k === "uploaddir") $("folderInput").click();
  });
}

async function syncNow() {
  toast("Syncing with Telegram…");
  try {
    await ctx.vault.reloadDrive();
    const info = await ctx.tg.getMe();
    ctx.vault.botInfo = info;
    render();
    toast("Up to date");
  } catch (e) {
    toast("Sync failed: " + String(e.message || e), "err");
  }
}

let _lastSilentPull = 0;
async function silentPull() {
  const v = ctx.vault;
  if (!v || !v.accountId || v.shared) return;
  if (document.visibilityState !== "visible") return;
  if (v.dirty || v.saving) return;
  if (v.status.syncState === "pending" || v.status.syncState === "saving" ||
      v.status.syncState === "syncing" || v.status.syncState === "error") return;
  if (ctx.tm.list().some((j) => j.status === "active" || j.status === "queued")) return;
  const now = Date.now();
  if (now - _lastSilentPull < 10000) return;
  _lastSilentPull = now;
  const id = v.accountId;
  try {
    await v.reloadDrive();
    if (ctx.vault.accountId === id) render();
  } catch (e) { /* next tick */ }
}

/* ---------------------------------------------------------------- wiring */

function wireChrome() {
  $("menuBtn").innerHTML = icon("menu");
  $("searchIcon").innerHTML = icon("search");
  $("searchClearBtn").innerHTML = icon("close", "icon-sm");
  $("brandLogo").innerHTML = driveLogo();
  $("authLogo").innerHTML = driveLogo();
  if ($("shareErrLogo")) $("shareErrLogo").innerHTML = driveLogo();
  if ($("shareErrBtn")) $("shareErrBtn").addEventListener("click", () => leaveShare());
  if ($("fabBtn")) {
    $("fabBtn").innerHTML = icon("plus");
    $("fabBtn").addEventListener("click", () => openNewMenu($("fabBtn")));
  }
  $("themeBtn").innerHTML = icon("cloud");
  $("settingsBtn").innerHTML = icon("settings");
  $("syncBtn").innerHTML = icon("checkCircle");

  $("menuBtn").addEventListener("click", () => {
    state.sidebarOpen = !state.sidebarOpen;
    $("sidebarEl").classList.toggle("open", state.sidebarOpen);
  });
  $("themeBtn").addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme();
    saveSettings();
  });
  $("settingsBtn").addEventListener("click", () => { if (ctx.vault.account) openSettings(); });
  $("accountBtn").addEventListener("click", () => { if (ctx.vault.account) openAccountMenu(); });
  $("syncBtn").addEventListener("click", () => {
    if (ctx.vault.status.syncState === "error") { ctx.vault.flushSaves(); toast("Retrying save…"); }
    else syncNow();
  });

  let searchTimer = null;
  $("searchInput").addEventListener("input", (e) => {
    state.search = e.target.value;
    $("searchClearBtn").hidden = !state.search;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 180);
  });
  $("searchClearBtn").addEventListener("click", () => {
    state.search = "";
    $("searchInput").value = "";
    $("searchClearBtn").hidden = true;
    render();
  });

  $("fileInput").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) await uploadEntries(files.map((f) => ({ file: f, rel: "" })), currentUploadParent());
  });
  $("folderInput").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) await uploadEntries(filesFromFileList(files, true), currentUploadParent());
  });

  $("authForm").addEventListener("submit", (e) => { e.preventDefault(); submitAuth(); });
  $("tabLogin").addEventListener("click", () => setAuthMode("login"));
  $("tabSignup").addEventListener("click", () => setAuthMode("signup"));
  $("authAccountsEl").addEventListener("click", (e) => {
    const b = e.target.closest("[data-account]");
    if (!b) return;
    const acc = ctx.vault.index.accounts.find((a) => a.id === b.getAttribute("data-account"));
    if (!acc) return;
    $("authName").value = acc.name;
    setAuthMode("login");
    $("authPass").focus();
  });

  $("tdriveRoot").addEventListener("click", onRootClick);
  $("tdriveRoot").addEventListener("dblclick", onRootDblClick);
  $("tdriveRoot").addEventListener("contextmenu", onRootContextMenu);
  $("tdriveRoot").addEventListener("change", (e) => {
    const sel = e.target.closest('[data-act="sort"]');
    if (sel) { state.sort = sel.value; saveSettings(); render(); }
  });

  let scrollTimer = null;
  let lastScrollAt = 0;
  ctx._scrollEvents = 0;
  const onScrollTick = () => {
    ctx._scrollEvents++;
    const now = Date.now();
    const since = now - lastScrollAt;
    if (since < 120) {
      if (!scrollTimer) scrollTimer = setTimeout(() => { scrollTimer = null; lastScrollAt = Date.now(); onBrowserScroll(); }, 140);
      return;
    }
    lastScrollAt = now;
    onBrowserScroll();
  };
  $("browserEl").addEventListener("scroll", onScrollTick);
  /* Some embedded/sandboxed contexts don't deliver scroll events reliably, so
   * also poll the scroll offset; a property read every 240 ms is essentially free. */
  setInterval(() => {
    const b = $("browserEl");
    if (!b || !ctx.vault || !ctx.vault.accountId) return;
    if (b.scrollTop === ctx._renderedForScroll) return;
    if (!ctx._win || !ctx._win.active) { ctx._renderedForScroll = b.scrollTop; return; }
    onBrowserScroll();
  }, 240);
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 170);
  });

  $("transfersEl").addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (act) {
      const a = act.getAttribute("data-act");
      if (a === "tclear") { ctx.tm.clearFinished(); renderTransfersPanel(); return; }
      if (a === "tpauseall") { ctx.tm.pauseAll(); renderTransfersPanel(); return; }
      if (a === "tresumeall") {
        for (const j of ctx.tm.list()) if (j.paused && j.restored && j.type === "download") await ctx.tm.resumeDownload(j.id);
        ctx.tm.resumeAll();
        renderTransfersPanel();
        return;
      }
      if (e.target.closest(".thead")) { $("transfersEl").classList.toggle("collapsed"); return; }
      return;
    }
    const attr = (name) => { const el = e.target.closest(`[${name}]`); return el ? el.getAttribute(name) : null; };
    const p = attr("data-tpause");
    if (p) { ctx.tm.pause(p); renderTransfersPanel(); return; }
    const rs = attr("data-tresume");
    if (rs) {
      const job = ctx.tm.get(rs);
      if (job && job.restored && job.type === "download") await ctx.tm.resumeDownload(rs);
      else ctx.tm.resume(rs);
      renderTransfersPanel();
      return;
    }
    const c = attr("data-tcancel");
    if (c) { ctx.tm.cancel(c); renderTransfersPanel(); return; }
    const r = attr("data-tretry");
    if (r) {
      const job = ctx.tm.get(r);
      if (job && job.restored && job.type === "download") await ctx.tm.resumeDownload(r);
      else ctx.tm.retry(r);
      renderTransfersPanel();
      return;
    }
    const d = attr("data-tdiscard");
    if (d) { await ctx.tm.discard(d); renderTransfersPanel(); return; }
    if (e.target.closest(".thead")) $("transfersEl").classList.toggle("collapsed");
  });

  window.addEventListener("keydown", onGlobalKey);

  const overlay = $("dropOverlay");
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!ctx.vault.accountId || ctx.vault.readOnly) return;
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    dragDepth++;
    overlay.hidden = false;
  });
  function setDropTarget(el) {
    if (window.__dropTargetEl === el) return;
    if (window.__dropTargetEl) window.__dropTargetEl.classList.remove("dropTarget");
    window.__dropTargetEl = el || null;
    window.__dropTarget = el ? el.getAttribute("data-id") : null;
    if (el) el.classList.add("dropTarget");
  }
  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    const card = e.target && e.target.closest ? e.target.closest('.card[data-kind="folder"], tr[data-kind="folder"]') : null;
    setDropTarget(card || null);
  });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { overlay.hidden = true; setDropTarget(null); } });
  window.addEventListener("drop", async (e) => {
    dragDepth = 0;
    overlay.hidden = true;
    if (!ctx.vault.accountId || ctx.vault.readOnly) return;
    if (!e.dataTransfer) return;
    e.preventDefault();
    const wasOverCard = window.__dropTarget;
    setDropTarget(null);
    try {
      const entries = await getDroppedEntries(e.dataTransfer);
      if (entries.length) await uploadEntries(entries, wasOverCard || currentUploadParent());
    } catch (err) { toast("Upload failed: " + String(err.message || err), "err"); }
  });

  window.addEventListener("online", async () => {
    toast("Back online");
    renderOfflineBanner();
    try { await ctx.vault.flushSaves(); } catch (e) { /* retried on its own timer */ }
    autoResumeTransfers();
  });
  window.addEventListener("offline", () => { toast("You are offline — cached data only until you reconnect", "err"); renderOfflineBanner(); });

  window.addEventListener("pagehide", () => { try { ctx.vault.flushSaves(); } catch (e) { /* best effort */ } });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") silentPull(); });
  window.addEventListener("focus", () => { silentPull(); });
  setInterval(() => { silentPull(); }, 20000);

  window.addEventListener("hashchange", () => {
    const t = shareTokenFromHash();
    if (t && ctx.vault && (!ctx.vault.shared || ctx.vault.shared.token !== t)) enterShared(t);
  });

  /* View-only guests quietly re-fetch the shared drive document so newly added
   * files show up without a reload. Editors are skipped (it would clobber their
   * in-flight changes) and so is anything while a transfer is running. */
  setInterval(async () => {
    const v = ctx.vault;
    if (!v || !v.shared || !v.readOnly) return;
    if (document.visibilityState !== "visible") return;
    const scr = $("shareError");
    if (scr && !scr.hidden) return;
    if (v.status.syncState === "saving" || v.status.syncState === "pending") return;
    if (ctx.tm.list().some((j) => j.status === "active" || j.status === "queued")) return;
    try {
      const r = await v.refreshShared();
      if (r && r.gone) { showShareError("Link unavailable", "The owner stopped sharing this item, or the link has expired."); return; }
      if (r && r.ok) render();
    } catch (e) { /* next tick */ }
  }, 30000);

  // KamsClouds: license entry points + support widget (never breaks core UI)
  try { ensureSupportWidget(ctx); } catch (e) { /* ignore */ }
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest('[data-kc="license"]');
    if (b) { e.preventDefault(); try { openLicenseDialog(ctx); } catch (er) { /* ignore */ } }
  });
  // Keep the support widget visibility correct on every screen (auth, share
  // error, guest, signed-in) no matter which path showed it.
  setInterval(() => { try { updateSupportBadge(ctx); } catch (e) { /* ignore */ } }, 3000);
}

function currentUploadParent() {
  return state.section === "drive" && !state.search.trim() ? state.folderId : "root";
}

async function autoResumeTransfers() {
  const failed = ctx.tm.list().filter((j) => j.status === "error");
  if (!failed.length) return;
  let n = 0;
  for (const j of failed) {
    try { if (ctx.tm.retry(j.id)) n++; } catch (e) { /* skip */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (n) { renderTransfersPanel(); toast(`Retrying ${n} interrupted transfer${n === 1 ? "" : "s"}`); }
}

function onRootClick(e) {
  const view = e.target.closest("[data-view]");
  if (view) { state.view = view.getAttribute("data-view"); saveSettings(); render(); return; }
  const nav = e.target.closest("[data-nav]");
  if (nav) {
    const sec = nav.getAttribute("data-nav");
    const folder = nav.getAttribute("data-folder");
    if (sec === "drive") openFolder(folder || "root", "drive");
    else openFolder("root", sec);
    state.sidebarOpen = false;
    $("sidebarEl").classList.remove("open");
    return;
  }
  const act = e.target.closest("[data-act]");
  if (act) {
    const a = act.getAttribute("data-act");
    if (a === "sortby") { state.sort = act.getAttribute("data-key"); saveSettings(); render(); return; }
    const item = e.target.closest("[data-id]");
    const node = item ? ctx.vault.getNode(item.getAttribute("data-id")) : null;
    if (a === "check" && node) { e.stopPropagation(); toggleSelect(node.id); return; }
    if (a === "menu" && node) { e.stopPropagation(); const r = act.getBoundingClientRect(); showContextMenu(r.left, r.bottom + 4, node); return; }
    handleAction(a, node);
    return;
  }
  const item = e.target.closest("[data-id]");
  if (item) {
    const id = item.getAttribute("data-id");
    if (e.metaKey || e.ctrlKey) toggleSelect(id);
    else if (e.shiftKey && state.selection.size) selectRange(id);
    else selectOnly(id);
    return;
  }
  if (e.target.closest("#browserEl") && state.selection.size) {
    state.selection.clear();
    render();
  }
}

function onRootDblClick(e) {
  const item = e.target.closest("[data-id]");
  if (!item) return;
  const node = ctx.vault.getNode(item.getAttribute("data-id"));
  if (!node) return;
  if (isFolder(node)) openFolder(node.id, state.section === "trash" ? "trash" : "drive");
  else openViewer(node);
}

function onRootContextMenu(e) {
  const item = e.target.closest("[data-id]");
  const node = item ? ctx.vault.getNode(item.getAttribute("data-id")) : null;
  if (node && !state.selection.has(node.id)) setSelection([node.id]);
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, node);
}

function moveFocus(e) {
  const ids = navigableIds();
  if (!ids.length || !state.focusId) return;
  let idx = ids.indexOf(state.focusId);
  if (idx < 0) idx = 0;
  const perRow = state.view === "grid" ? Math.max(1, ctx.metrics.perRow || 1) : 1;
  let next = idx;
  switch (e.key) {
    case "ArrowDown": next = idx + perRow; break;
    case "ArrowUp": next = idx - perRow; break;
    case "ArrowRight": next = idx + 1; break;
    case "ArrowLeft": next = idx - 1; break;
    case "Home": next = 0; break;
    case "End": next = ids.length - 1; break;
    case "PageDown": next = idx + perRow * 5; break;
    case "PageUp": next = idx - perRow * 5; break;
    default: return;
  }
  e.preventDefault();
  next = clamp(next, 0, ids.length - 1);
  const id = ids[next];
  if (e.shiftKey) {
    state.selection.add(id);
    state.focusId = id;
    render();
  } else {
    selectOnly(id);
  }
  ensureVisible(id);
}

function onGlobalKey(e) {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
  if (!ctx.vault.accountId) return;
  const ro = !!ctx.vault.readOnly;
  if (e.key === "?" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); showShortcuts(); return; }
  if (e.key === "Escape") { state.selection.clear(); render(); removeMenus(); return; }
  if (document.querySelector(".scrim")) return;
  if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey) {
    if (ro) return;
    if (state.selection.size) { e.preventDefault(); handleAction(state.section === "trash" ? "purge" : "trash", null); }
    return;
  }
  if (e.key === "F2" && state.selection.size === 1) { if (ro) return; e.preventDefault(); handleAction("rename", selectedNodes()[0]); return; }
  if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) { e.preventDefault(); handleAction("selectall", null); return; }
  if (e.key === "Enter" && state.focusId) {
    const n = ctx.vault.getNode(state.focusId);
    if (n) { e.preventDefault(); if (isFolder(n)) openFolder(n.id, state.section === "trash" ? "trash" : "drive"); else openViewer(n); }
    return;
  }
  if (e.key === " " && state.focusId && state.selection.size) { e.preventDefault(); toggleSelect(state.focusId); return; }
  if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End" || e.key === "PageDown" || e.key === "PageUp") moveFocus(e);
}

/* ------------------------------------------------------------------- boot */

async function loadCredentials() {
  const shared = {
    botToken: cfg.botToken, chatId: cfg.chatId, apiBase: cfg.apiBase,
    apiId: cfg.apiId, apiHash: cfg.apiHash,
  };
  try {
    const c = await pfGet(STORAGE_KEYS.credentials, null);
    if (c && typeof c === "object") {
      if (c.botToken) cfg.botToken = String(c.botToken).trim();
      if (c.chatId) cfg.chatId = String(c.chatId).trim();
      if (c.apiBase) cfg.apiBase = String(c.apiBase).trim();
      if (c.apiId) cfg.apiId = c.apiId;
      if (c.apiHash) cfg.apiHash = c.apiHash;
    }
  } catch (e) { /* credentials are optional in source */ }
  if (shared.botToken && shared.botToken !== "PASTE_BOT_TOKEN_HERE") {
    cfg.botToken = shared.botToken;
    cfg.chatId = shared.chatId;
    cfg.apiBase = shared.apiBase;
    cfg.apiId = shared.apiId;
    cfg.apiHash = shared.apiHash;
  }
}

function hasCredentials() {
  if (cfg.botToken && cfg.botToken !== "PASTE_BOT_TOKEN_HERE" && cfg.chatId && cfg.chatId !== "PASTE_CHAT_ID_HERE") return true;
  return false;
}

async function saveCredentials(patch) {
  const prev = (await pfGet(STORAGE_KEYS.credentials, null)) || {};
  const next = Object.assign({}, prev, patch, { savedAt: Date.now() });
  await pfSet(STORAGE_KEYS.credentials, next);
  if (next.botToken) cfg.botToken = next.botToken;
  if (next.chatId) cfg.chatId = next.chatId;
  if (next.apiBase) cfg.apiBase = next.apiBase;
  return next;
}

function showConnect() {
  showAuth();
  const note = $("authNote");
  if (note && !hasCredentials()) {
    note.innerHTML = `<span style="color:var(--red)">Shared drive not configured yet — paste the bot token + chat id in src/tdrive/config.js.</span>`;
  }
}

async function boot() {
  await loadSettings();
  await loadCredentials();
  applyTheme();
  ctx.tg = createTg(cfg);
  ctx.vault = new Vault(ctx.tg, cfg);
  ctx.vault.keepVersions = state.keepVersions;
  ctx.tm = new TransferManager(ctx.vault, ctx.tg, cfg);
  ctx.vault.on(() => {
    if (ctx.vault.accountId) render();
    else if (ctx.vault.status.phase === "ready" && !$("appShell").hidden) showAuth();
  });
  ctx.tm.subscribe(() => renderTransfersPanel());
  ctx.enterApp = enterApp;
  ctx.enterShared = enterShared;
  ctx.silentPull = silentPull;
  ctx.showAuth = showAuth;
  ctx.render = render;
  ctx.onBrowserScroll = onBrowserScroll;
  ctx.windowBounds = windowBounds;
  wireChrome();

  if (!hasCredentials()) { $("bootEl").hidden = true; showConnect(); return; }

  try {
    await ctx.vault.boot();
  } catch (e) {
    $("bootEl").hidden = true;
    $("authScreen").hidden = false;
    $("appShell").hidden = true;
    $("authNote").innerHTML = `<span style="color:var(--red)">Could not reach Telegram: ${escapeHtml(String(e.message || e))}</span><br>Check your connection, then reload.`;
    return;
  }

  try { ctx.vault.botInfo = await ctx.tg.getMe(); } catch (e) { /* optional */ }

  $("bootEl").hidden = true;
  const shareToken = shareTokenFromHash();
  if (shareToken) { await enterShared(shareToken); return; }
  if (ctx.vault.accountId) enterApp();
  else showAuth();
}

boot();
