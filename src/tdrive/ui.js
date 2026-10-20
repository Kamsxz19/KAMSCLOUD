import { icon, driveLogo, googleG, fileIcon, kindColor } from "./icons.js";
import { escapeHtml, fmtBytes, fmtDate, fmtEta, fmtSpeed } from "./util.js";

export const SECTIONS = [
  { id: "home", label: "Home", icon: "home" },
  { id: "drive", label: "My Drive", icon: "folder" },
  { id: "starred", label: "Starred", icon: "starBorder" },
  { id: "recent", label: "Recent", icon: "recent" },
  { id: "activity", label: "Activity", icon: "activity" },
  { id: "trash", label: "Trash", icon: "trash" },
  { id: "storage", label: "Storage", icon: "storage" },
];

export const KIND_LABEL = {
  image: "Image", video: "Video", audio: "Audio", pdf: "PDF", doc: "Document",
  sheet: "Spreadsheet", slide: "Presentation", archive: "Archive", code: "Code",
  text: "Text", font: "Font", app: "Application", file: "File", folder: "Folder",
};

const AVATAR_LETTER = (name) => (String(name || "?").trim()[0] || "?").toUpperCase();

export function avatarHtml(account, cls = "avatar") {
  if (!account) return "";
  return `<span class="${cls}" style="background:${escapeHtml(account.color || "#1a73e8")}">${escapeHtml(AVATAR_LETTER(account.name))}</span>`;
}

export function isFolder(node) {
  return !!(node && node.parts === undefined);
}

/** Parent id -> child totals, computed once per render so cards are O(1). */
export function buildChildCounts(vault) {
  const map = new Map();
  const bump = (parentId) => {
    const rec = map.get(parentId) || { folders: 0, files: 0 };
    rec.files += 1;
    map.set(parentId, rec);
  };
  const bumpF = (parentId) => {
    const rec = map.get(parentId) || { folders: 0, files: 0 };
    rec.folders += 1;
    map.set(parentId, rec);
  };
  for (const f of vault.drive.folders) if (!f.trashed) bumpF(f.parentId || "root");
  for (const f of vault.drive.files) if (!f.trashed) bump(f.parentId || "root");
  return map;
}

function childTotal(folder, ctx) {
  const rec = ctx.childCounts && ctx.childCounts.get(folder.id);
  if (!rec) return 0;
  return rec.folders + rec.files;
}

function itemSubtitle(node, ctx) {
  if (node.id === "root") return "My Drive";
  if (node.trashed) return `Trashed ${fmtDate(node.modifiedAt || node.createdAt)}`;
  if (ctx.state.search.trim()) {
    const p = ctx.vault.pathOf(node.parentId).map((f) => f.name).join(" / ");
    return (p ? p + " / " : "") + (isFolder(node) ? folderSubtitle(node, ctx) : fmtBytes(node.size || 0));
  }
  if (isFolder(node)) return folderSubtitle(node, ctx);
  return `${KIND_LABEL[node.kind] || "File"} · ${fmtBytes(node.size)}`;
}

function folderSubtitle(folder, ctx) {
  const n = childTotal(folder, ctx);
  return n === 0 ? "Empty folder" : `${n} item${n === 1 ? "" : "s"}`;
}

function lockBadge(node) {
  return node.enc ? `<span class="enctag" title="Encrypted on this device before upload">${icon("lock", "icon-sm")}</span>` : "";
}

function versionBadge(node) {
  const n = (node.versions || []).length;
  return n ? `<span class="vertag" title="${n} earlier version${n === 1 ? "" : "s"}">v${n + 1}</span>` : "";
}

function shareBadge(node, ctx) {
  if (!ctx || !ctx.sharedNodeIds || !ctx.sharedNodeIds.has(node.id)) return "";
  return `<span class="sharetag" title="Shared by link">${icon("link", "icon-sm")}</span>`;
}

function thumbInner(node, ctx) {
  if (isFolder(node)) {
    return `<svg class="icon-lg" style="width:64px;height:64px" viewBox="0 0 24 24" fill="#5f6368"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
  }
  if (node.thumb) {
    const cached = ctx.thumbUrls.get(node.thumb);
    if (cached) return `<img src="${escapeHtml(cached)}" alt="" loading="lazy" decoding="async">`;
    return `<img data-thumb="${escapeHtml(node.thumb)}" alt="" decoding="async">`;
  }
  return fileIcon(node.kind, node.name, "icon-lg");
}

export function cardHtml(node, ctx) {
  const selected = ctx.state.selection.has(node.id);
  const folder = isFolder(node);
  return `<div class="card${selected ? " sel" : ""}" data-id="${escapeHtml(node.id)}" data-kind="${folder ? "folder" : "file"}" tabindex="0">
    <div class="thumb">${thumbInner(node, ctx)}${!folder ? `<span class="badges">${lockBadge(node)}${versionBadge(node)}${shareBadge(node, ctx)}</span>` : ""}</div>
    ${node.starred ? `<span class="star">${icon("star", "icon-sm")}</span>` : ""}
    <span class="check${selected ? " on" : ""}" data-act="check">${selected ? icon("check", "icon-sm") : ""}</span>
    <div class="meta">
      ${folder ? `<svg class="kindicon" viewBox="0 0 24 24" fill="#5f6368"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>` : fileIcon(node.kind, node.name)}
      <div class="txt">
        <div class="name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</div>
        <div class="sub">${escapeHtml(itemSubtitle(node, ctx))}</div>
      </div>
      <button class="iconbtn" style="width:30px;height:30px" data-act="menu" title="More actions">${icon("more", "icon-sm")}</button>
    </div>
  </div>`;
}

export function rowHtml(node, ctx) {
  const selected = ctx.state.selection.has(node.id);
  const folder = isFolder(node);
  return `<tr class="${selected ? "sel" : ""}" data-id="${escapeHtml(node.id)}" data-kind="${folder ? "folder" : "file"}">
    <td style="width:34px"><span class="check${selected ? " on" : ""}" data-act="check" style="display:inline-flex;width:20px;height:20px;border-radius:4px;border:2px solid var(--text-3);align-items:center;justify-content:center;${selected ? "background:var(--primary);border-color:var(--primary);color:#fff" : ""}">${selected ? icon("check", "icon-sm") : ""}</span></td>
    <td>
      <div class="rowname">
        ${folder ? `<svg class="kindicon" viewBox="0 0 24 24" fill="#5f6368"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>` : fileIcon(node.kind, node.name)}
        <span class="nm" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>
        ${node.starred ? `<span style="color:var(--yellow);display:inline-flex">${icon("star", "icon-sm")}</span>` : ""}
        ${lockBadge(node)}${versionBadge(node)}${shareBadge(node, ctx)}
      </div>
    </td>
    <td class="col-owner">${folder ? "—" : KIND_LABEL[node.kind] || "File"}</td>
    <td class="col-date">${escapeHtml(fmtDate(node.modifiedAt || node.createdAt))}</td>
    <td class="col-size">${folder ? childTotal(node, ctx) + " items" : escapeHtml(fmtBytes(node.size))}</td>
    <td style="width:40px"><button class="iconbtn" style="width:32px;height:32px" data-act="menu">${icon("more", "icon-sm")}</button></td>
  </tr>`;
}

function renderSharedSidebar(ctx) {
  const s = ctx.shared;
  const canEdit = s.perm === "edit";
  const owner = { name: s.ownerName, color: s.ownerColor };
  return `
    <button class="newbtn" data-act="openapp" type="button">${icon("folder", "icon")}<span>Open KamsClouds</span></button>
    <div class="navsep"></div>
    <div class="sideaccount">${avatarHtml(owner)}<div style="flex:1;min-width:0">
      <div style="color:var(--text);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.ownerName)}</div>
      <div style="font-size:11.5px">Shared with you</div>
    </div></div>
    <div class="sharedbox">
      <div class="permrow ${canEdit ? "edit" : "view"}">${icon(canEdit ? "edit" : "eye", "icon-sm")}<b>${canEdit ? "Can edit" : "View only"}</b></div>
      <div class="hint">${canEdit
        ? "You can upload, rename and change items inside this shared view. Changes are saved to the owner's drive."
        : "You can preview and download these items. Editing is turned off for this link."}</div>
    </div>`;
}

export function renderSidebar(ctx) {
  if (ctx.shared) return renderSharedSidebar(ctx);
  const { state, vault } = ctx;
  const stats = vault.stats();
  const acc = vault.account;
  const items = SECTIONS.map((s) => {
    const active = state.section === s.id;
    const count = s.id === "trash" ? stats.trashed : 0;
    return `<button class="navitem${active ? " active" : ""}" data-nav="${s.id}">
      ${icon(s.icon, "icon")}<span style="flex:1">${escapeHtml(s.label)}</span>
      ${count ? `<span class="badge">${count}</span>` : ""}
    </button>`;
  }).join("");

  const kinds = Object.entries(stats.byKind || {}).sort((a, b) => b[1].bytes - a[1].bytes);
  const total = stats.bytes || 1;
  const barSegs = kinds.slice(0, 6).map(([k, v]) =>
    `<i style="width:${Math.max(1.2, (v.bytes / total) * 100)}%;background:${kindColor(k)}"></i>`).join("");
  const kindRows = kinds.slice(0, 5).map(([k, v]) =>
    `<div><span class="dot" style="background:${kindColor(k)}"></span><span style="flex:1">${escapeHtml(KIND_LABEL[k] || k)}</span><span>${escapeHtml(fmtBytes(v.bytes))}</span></div>`).join("");

  return `
    <button class="newbtn" data-act="new">${icon("plus", "icon")}<span>New</span></button>
    ${items}
    <div class="navsep"></div>
    <div class="storagebox">
      <div style="font-size:13px;color:var(--text-2)">Storage</div>
      <div class="storagebar">${barSegs || `<i style="width:0%"></i>`}</div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:8px">${escapeHtml(fmtBytes(stats.bytes))} used · ${stats.files} files · ${stats.folders} folders</div>
      <div class="storage-kinds">${kindRows}</div>
    </div>
    ${acc ? `<div class="navsep"></div><div class="sideaccount">${avatarHtml(acc)}<div style="flex:1;min-width:0"><div style="color:var(--text);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(acc.name)}</div><div style="font-size:11.5px">${acc.enc ? icon("lock", "icon-sm") + " Encrypted" : "KamsClouds account"}</div></div></div>` : ""}
  `;
}

export function breadcrumbHtml(ctx) {
  const { vault, state } = ctx;
  const chain = vault.pathOf(state.folderId);
  const parts = [`<button class="crumbbtn" data-nav="drive" data-folder="root">My Drive</button>`];
  chain.forEach((f, i) => {
    parts.push(`<span class="sep">${icon("chevronRight", "icon-sm")}</span>`);
    parts.push(`<button class="crumbbtn${i === chain.length - 1 && state.section === "drive" ? "" : " last"}" data-nav="drive" data-folder="${escapeHtml(f.id)}">${escapeHtml(f.name)}</button>`);
  });
  return `<div class="crumb">${parts.join("")}</div>`;
}

function viewToggleHtml(state) {
  return `<div class="viewtoggle">
      <button data-view="list" class="${state.view === "list" ? "on" : ""}" title="List view">${icon("list", "icon-sm")}</button>
      <button data-view="grid" class="${state.view === "grid" ? "on" : ""}" title="Grid view">${icon("grid", "icon-sm")}</button>
    </div>`;
}

function sortSelectHtml(state) {
  return `<select class="sortsel" data-act="sort" title="Sort">
      <option value="name"${state.sort === "name" ? " selected" : ""}>Name</option>
      <option value="modified"${state.sort === "modified" ? " selected" : ""}>Last modified</option>
      <option value="size"${state.sort === "size" ? " selected" : ""}>Size</option>
    </select>`;
}

function sharedCrumbsHtml(ctx) {
  const s = ctx.shared;
  const parts = [];
  if (s.isFile) {
    parts.push(`<span class="crumbbtn last">${escapeHtml(s.label || "Shared file")}</span>`);
  } else {
    const chain = ctx.vault.pathOf(ctx.state.folderId);
    const rootIdx = chain.findIndex((f) => f.id === s.rootId);
    const visible = rootIdx >= 0 ? chain.slice(rootIdx) : chain;
    visible.forEach((f, i) => {
      if (i) parts.push(`<span class="sep">${icon("chevronRight", "icon-sm")}</span>`);
      const last = i === visible.length - 1;
      const name = i === 0 ? (s.label || f.name) : f.name;
      parts.push(`<button class="crumbbtn${last ? " last" : ""}" data-nav="drive" data-folder="${escapeHtml(f.id)}">${escapeHtml(name)}</button>`);
    });
    if (!visible.length) parts.push(`<span class="crumbbtn last">${escapeHtml(s.label || "Shared folder")}</span>`);
  }
  return `<div class="crumb">${parts.join("")}</div>`;
}

function renderSharedToolbar(ctx) {
  const { state } = ctx;
  const s = ctx.shared;
  const canEdit = s.perm === "edit";
  const n = state.selection.size;
  const perm = `<span class="permbadge ${canEdit ? "edit" : "view"}">${icon(canEdit ? "edit" : "eye", "icon-sm")}${canEdit ? "Can edit" : "View only"}</span>`;

  if (n > 0) {
    return `<button class="iconbtn" data-act="clearsel" title="Clear selection">${icon("close")}</button>
      <span class="selcount">${n} selected</span>
      <div class="grow"></div>
      <button class="iconbtn" data-act="download" title="Download">${icon("download")}</button>
      <button class="iconbtn" data-act="zip" title="Download as .zip">${icon("archive")}</button>
      ${canEdit ? `<button class="iconbtn" data-act="renamebulk" title="Rename">${icon("textFormat")}</button>
        <button class="iconbtn" data-act="move" title="Move to">${icon("move")}</button>
        <button class="iconbtn" data-act="star" title="Star">${icon("starBorder")}</button>
        <button class="iconbtn" data-act="trash" title="Move to trash">${icon("trash")}</button>` : ""}
      ${perm}`;
  }

  const view = ctx._view || {};
  const editable = canEdit && !(ctx.shared && ctx.shared.isFile);
  return `${sharedCrumbsHtml(ctx)}
    ${editable ? `<button class="btn primary" data-act="upload" type="button" style="height:34px;padding:0 14px;margin-left:6px">${icon("upload", "icon-sm")}Upload</button>
      <button class="iconbtn" data-act="newfolder" title="New folder" type="button">${icon("addFolder")}</button>` : ""}
    <div class="grow"></div>
    ${view.ordered && view.ordered.length ? `<button class="iconbtn" data-act="selectall" title="Select all">${icon("selectAll")}</button>` : ""}
    ${perm}
    ${sortSelectHtml(state)}${viewToggleHtml(state)}`;
}

export function renderToolbar(ctx) {
  if (ctx.shared) return renderSharedToolbar(ctx);
  const { state } = ctx;
  const n = state.selection.size;
  const viewT = viewToggleHtml(state);
  const sortSel = sortSelectHtml(state);

  if (n > 0) {
    const inTrash = state.section === "trash";
    const anyFolder = [...state.selection].some((id) => isFolder(ctx.vault.getNode(id)));
    return `<button class="iconbtn" data-act="clearsel" title="Clear selection">${icon("close")}</button>
      <span class="selcount">${n} selected</span>
      <div class="grow"></div>
      ${inTrash ? `
        <button class="iconbtn" data-act="restore" title="Restore">${icon("restore")}</button>
        <button class="iconbtn" data-act="purge" title="Delete forever">${icon("trash")}</button>`
      : `
        <button class="iconbtn" data-act="download" title="Download">${icon("download")}</button>
        <button class="iconbtn" data-act="zip" title="Download as .zip">${icon("archive")}</button>
        <button class="iconbtn" data-act="share" title="Get link">${icon("link")}</button>
        <button class="iconbtn" data-act="renamebulk" title="Rename (bulk)">${icon("textFormat")}</button>
        <button class="iconbtn" data-act="move" title="Move to">${icon("move")}</button>
        <button class="iconbtn" data-act="star" title="Star">${icon("starBorder")}</button>
        <button class="iconbtn" data-act="trash" title="Move to trash">${icon("trash")}</button>`}
    `;
  }

  const section = state.section;
  const view = ctx._view || {};
  const allSelected = view.ordered && view.ordered.length > 0 && view.ordered.every((x) => state.selection.has(x.id));
  const head = section === "drive" ? breadcrumbHtml(ctx)
    : `<div class="crumb"><button class="crumbbtn">${escapeHtml((SECTIONS.find((s) => s.id === section) || { label: "Home" }).label)}</button></div>`;

  return `${head}
    <div class="grow"></div>
    ${view.ordered && view.ordered.length ? `<button class="iconbtn" data-act="selectall" title="${allSelected ? "Clear selection" : "Select all"}">${icon(allSelected ? "close" : "selectAll")}</button>` : ""}
    ${section === "trash" ? `<button class="iconbtn" data-act="emptytrash" title="Empty trash">${icon("trash")}</button>` : ""}
    ${section === "activity" ? `<button class="iconbtn" data-act="clearactivity" title="Clear activity">${icon("trash")}</button>` : ""}
    ${section === "activity" || section === "storage" ? "" : sortSel}
    ${section === "activity" || section === "storage" ? "" : viewT}`;
}

function sortNodes(arr, sort) {
  const out = [...arr];
  const coll = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  if (sort === "modified") out.sort((a, b) => (b.modifiedAt || b.createdAt) - (a.modifiedAt || a.createdAt));
  else if (sort === "size") out.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
  else if (sort === "type") out.sort((a, b) => String(a.kind || "folder").localeCompare(String(b.kind || "folder")) || coll(a, b));
  else out.sort(coll);
  return out;
}

/* ---------------------------------------------------------- search filters */

function parseSizeExpr(v) {
  const toBytes = (s) => {
    const m = /^([0-9.]+)\s*(b|kb|mb|gb|tb)?$/.exec(String(s).trim());
    if (!m) return null;
    const n = parseFloat(m[1]);
    const u = m[2] || "b";
    const mul = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[u] || 1;
    return Math.round(n * mul);
  };
  const s = String(v).trim();
  let m;
  if ((m = /^([<>]=?)(.+)$/.exec(s))) { const b = toBytes(m[2]); return b == null ? null : { op: m[1], bytes: b }; }
  if ((m = /^(.+?)-(.+)$/.exec(s))) { const a = toBytes(m[1]); const b = toBytes(m[2]); return (a == null || b == null) ? null : { min: a, max: b }; }
  const b = toBytes(s);
  return b == null ? null : { op: "=", bytes: b };
}

function parseDateExpr(v) {
  const s = String(v).trim().toLowerCase();
  let m;
  if ((m = /^([<>]?)(\d+)([dhwm])$/.exec(s))) {
    const n = parseInt(m[2], 10);
    const unit = { d: 86400000, h: 3600000, w: 604800000, m: 2592000000 }[m[3]];
    return { op: m[1] || "<", at: Date.now() - n * unit };
  }
  if (s === "today") return { op: ">=", at: new Date().setHours(0, 0, 0, 0) };
  const d = Date.parse(s);
  return isNaN(d) ? null : { op: ">=", at: d };
}

function parseSearch(q) {
  const tokens = String(q || "").trim().split(/\s+/).filter(Boolean);
  const f = { text: [], kinds: [], size: null, modified: null, starred: null, trashed: null, filterCount: 0 };
  for (const t of tokens) {
    const m = /^([a-z]+):(.*)$/i.exec(t);
    if (!m) { f.text.push(t.toLowerCase()); continue; }
    const k = m[1].toLowerCase();
    const v = m[2].toLowerCase();
    if (k === "type" || k === "kind") { f.kinds.push(...v.split(",").map((s) => s.trim()).filter(Boolean)); f.filterCount++; }
    else if (k === "size") { f.size = parseSizeExpr(v); f.filterCount++; }
    else if (k === "modified" || k === "date") { f.modified = parseDateExpr(v); f.filterCount++; }
    else if (k === "starred") { f.starred = v !== "false" && v !== "0"; f.filterCount++; }
    else if (k === "trashed" || k === "trash") { f.trashed = v !== "false" && v !== "0"; f.filterCount++; }
    else f.text.push(t.toLowerCase());
  }
  return f;
}

function matchFilters(n, f) {
  if (f.kinds.length && !f.kinds.includes(String(n.kind || "folder"))) return false;
  if (f.size) {
    const s = Number(n.size) || 0;
    const { op, bytes, min, max } = f.size;
    if (op === ">" && !(s > bytes)) return false;
    if (op === ">=" && !(s >= bytes)) return false;
    if (op === "<" && !(s < bytes)) return false;
    if (op === "<=" && !(s <= bytes)) return false;
    if (op === "=" && s !== bytes) return false;
    if (min != null && !(s >= min && s <= max)) return false;
  }
  if (f.modified) {
    const m = Number(n.modifiedAt || n.createdAt) || 0;
    if (f.modified.op === "<" && !(m < f.modified.at)) return false;
    if ((f.modified.op === ">" || f.modified.op === ">=") && !(m >= f.modified.at)) return false;
  }
  if (f.starred != null && !!n.starred !== f.starred) return false;
  return true;
}

/** Builds the ordered node list for the current section without touching the DOM. */
export function computeOrdered(ctx) {
  const { vault, state } = ctx;
  const sec = state.section;
  if (sec === "storage" || sec === "activity") return { ordered: [], heading: null, empty: null, folders: [], files: [] };

  if (ctx.shared && ctx.shared.fileId) {
    const f = vault.getNode(ctx.shared.fileId);
    const ordered = f ? [f] : [];
    return { folders: [], files: ordered, ordered, heading: null, empty: "This item is no longer available" };
  }

  let folders = [];
  let files = [];
  let heading = null;
  let empty = null;

  if (state.search.trim()) {
    const f = parseSearch(state.search);
    const pool = [...vault.drive.folders, ...vault.drive.files].filter((n) => (f.trashed ? true : !n.trashed));
    const hits = pool.filter((n) => matchFilters(n, f) && f.text.every((w) => n.name.toLowerCase().includes(w)));
    folders = hits.filter(isFolder);
    files = hits.filter((n) => !isFolder(n));
    const extra = f.filterCount ? " (filtered)" : "";
    heading = `${hits.length} result${hits.length === 1 ? "" : "s"} for "${state.search.trim()}"${extra}`;
    empty = "No files matching your search";
  } else if (sec === "trash") {
    folders = vault.drive.folders.filter((f) => f.trashed);
    files = vault.drive.files.filter((f) => f.trashed);
    heading = "Items in trash are deleted forever after you empty it";
    empty = "Trash is empty";
  } else if (sec === "starred") {
    const all = [...vault.drive.folders, ...vault.drive.files].filter((n) => n.starred && !n.trashed);
    folders = all.filter(isFolder);
    files = all.filter((n) => !isFolder(n));
    heading = "Starred items";
    empty = "No starred items yet";
  } else if (sec === "recent") {
    files = [...vault.drive.files].filter((f) => !f.trashed).sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 80);
    heading = "Recent files";
    empty = "No recent files";
  } else if (sec === "home") {
    const all = [...vault.drive.folders, ...vault.drive.files].filter((n) => !n.trashed);
    folders = all.filter(isFolder).sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 8);
    files = all.filter((n) => !isFolder(n)).sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 16);
    heading = null;
    empty = "Nothing here yet";
  } else {
    const c = vault.children(state.folderId);
    folders = c.folders;
    files = c.files;
    empty = "This folder is empty";
  }

  const ordered = [...sortNodes(folders, state.sort), ...sortNodes(files, state.sort)];
  return { folders, files, ordered, heading, empty };
}

function sortCaret(state, key) {
  return `<span style="opacity:${state.sort === key ? 1 : 0.28};font-size:9px">&#9660;</span>`;
}

function emptyHtml(sec, ctx, heading, msg) {
  const tail = ctx && ctx.readOnly
    ? `<div>Nothing has been shared in this folder yet.</div>`
    : `<div>Drag files here, or use the <b>New</b> button to upload.</div>`;
  return `${heading ? `<div class="sectionlabel">${escapeHtml(heading)}</div>` : ""}
    <div class="empty">${icon("cloud", "icon-lg")}<h3>${escapeHtml(msg)}</h3>
    ${tail}</div>`;
}

export function renderBrowser(ctx, win) {
  const { state } = ctx;
  const sec = state.section;
  if (sec === "storage") return renderStorage(ctx);
  if (sec === "activity") return renderActivity(ctx);

  const view = ctx._view || computeOrdered(ctx);
  const ordered = view.ordered;
  if (!ordered.length) return emptyHtml(sec, ctx, view.heading, view.empty);

  const slicing = win && win.active ? ordered.slice(win.start, win.end) : ordered;
  const lead = win && win.active ? win.padTop : 0;
  const tail = win && win.active ? win.padBottom : 0;
  const label = view.heading ? `<div class="sectionlabel">${escapeHtml(view.heading)}</div>` : "";

  if (state.view === "grid") {
    const cards = slicing.map((n) => cardHtml(n, ctx)).join("");
    const pad = win && win.active ? `padding-top:${win.padTop}px;padding-bottom:${win.padBottom}px` : "";
    return `${label}
      <div class="grid" style="${pad}">${cards}</div>`;
  }

  const rows = slicing.map((n) => rowHtml(n, ctx)).join("");
  const vrow = (h) => (h ? `<tr class="vpad"><td colspan="6" style="height:${h}px;padding:0;border:0"></td></tr>` : "");
  const allSelected = ordered.length > 0 && ordered.every((n) => state.selection.has(n.id));
  return `${label}
    <table class="listtable">
      <thead><tr>
        <th style="width:34px"><button data-act="selectall" title="Select all">${icon(allSelected ? "close" : "selectAll", "icon-sm")}</button></th>
        <th data-act="sortby" data-key="name" style="cursor:pointer" title="Sort by name">Name ${sortCaret(state, "name")}</th>
        <th data-act="sortby" data-key="type" class="col-owner" style="cursor:pointer" title="Sort by type">Type ${sortCaret(state, "type")}</th>
        <th data-act="sortby" data-key="modified" class="col-date" style="cursor:pointer" title="Sort by last modified">Last modified ${sortCaret(state, "modified")}</th>
        <th data-act="sortby" data-key="size" class="col-size" style="cursor:pointer" title="Sort by size">Size ${sortCaret(state, "size")}</th>
        <th></th>
      </tr></thead>
      <tbody>${vrow(lead)}${rows}${vrow(tail)}</tbody>
    </table>`;
}

function renderActivity(ctx) {
  const log = ctx.vault.getActivity();
  if (!log.length) return `<div class="sectionlabel" style="margin-left:0">Activity</div><div class="empty">${icon("activity", "icon-lg")}<h3>No activity yet</h3><div>Uploads, downloads, moves, renames and deletions will show up here.</div></div>`;
  const iconFor = (k) => ({
    upload: "upload", download: "download", delete: "trash", trash: "trash", restore: "restore",
    rename: "edit", move: "move", folder: "addFolder", zip: "archive", password: "key",
  }[k] || "info");
  const rows = log.slice(0, 300).map((e) => `<div class="actrow">
      <span class="acticon">${icon(iconFor(e.kind), "icon-sm")}</span>
      <span class="actname" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span>
      <span class="actmeta">${e.size ? escapeHtml(fmtBytes(e.size)) + " · " : ""}${escapeHtml(fmtDate(e.at))}</span>
    </div>`).join("");
  return `<div class="sectionlabel" style="margin-left:0">Activity <span style="font-weight:400;color:var(--text-3)">· last ${log.length} events</span></div>
    <div class="actlist">${rows}</div>`;
}

function renderStorage(ctx) {
  const { vault } = ctx;
  const s = vault.stats();
  const rec = vault.reclaimable();
  const chat = vault.chat;
  const kinds = Object.entries(s.byKind || {}).sort((a, b) => b[1].bytes - a[1].bytes);
  const max = Math.max(1, ...kinds.map(([, v]) => v.bytes));
  const rows = kinds.map(([k, v]) => `<div class="kindrow">
      <span class="kname">${escapeHtml(KIND_LABEL[k] || k)}</span>
      <span class="kbar"><i style="width:${Math.max(1.5, (v.bytes / max) * 100)}%;background:${kindColor(k)}"></i></span>
      <span style="width:84px;text-align:right;color:var(--text-2)">${escapeHtml(fmtBytes(v.bytes))}</span>
      <span style="width:52px;text-align:right;color:var(--text-3)">${v.count}×</span>
    </div>`).join("");
  const msgCount = (vault.drive.files || []).reduce((a, f) => a + (f.parts ? f.parts.length : 0), 0)
    + (vault.drive.files || []).reduce((a, f) => a + (f.versions || []).reduce((b, v) => b + (v.parts ? v.parts.length : 0), 0), 0);
  return `<div class="sectionlabel" style="margin-left:0">Storage</div>
    <div class="panels">
      <div class="statcard"><div class="lbl">Used by this account</div><div class="big">${escapeHtml(fmtBytes(s.bytes))}</div><div class="lbl">${s.files} files · ${s.folders} folders</div></div>
      <div class="statcard"><div class="lbl">Telegram messages used</div><div class="big">${msgCount}</div><div class="lbl">chunks + thumbnails</div></div>
      <div class="statcard"><div class="lbl">Version history</div><div class="big">${s.versions}</div><div class="lbl">${escapeHtml(fmtBytes(s.versionsBytes))} in old versions</div></div>
      <div class="statcard"><div class="lbl">Encrypted files</div><div class="big">${s.encrypted}</div><div class="lbl">${vault.account && vault.account.enc ? "drive encryption on" : "off"}</div></div>
      <div class="statcard"><div class="lbl">In trash</div><div class="big">${s.trashed}</div><div class="lbl">items awaiting purge</div></div>
      <div class="statcard"><div class="lbl">Max file size</div><div class="big">2 GB</div><div class="lbl">split across chunks</div></div>
    </div>
    <div class="sectionlabel" style="margin-left:0">Reclaim space</div>
    <div class="panels">
      <div class="statcard"><div class="lbl">Old versions</div><div class="big">${escapeHtml(fmtBytes(rec.versions.bytes))}</div><div class="lbl">${rec.versions.count} kept snapshot${rec.versions.count === 1 ? "" : "s"}</div>
        ${rec.versions.count ? `<button class="btn ghost" data-act="delversions" type="button" style="margin-top:10px">Delete all versions</button>` : `<div class="lbl" style="margin-top:10px">Nothing to free</div>`}</div>
      <div class="statcard"><div class="lbl">In trash</div><div class="big">${escapeHtml(fmtBytes(rec.trash.bytes))}</div><div class="lbl">${rec.trash.count} item${rec.trash.count === 1 ? "" : "s"} awaiting purge</div>
        ${rec.trash.count ? `<button class="btn ghost" data-act="emptytrash" type="button" style="margin-top:10px">Empty trash</button>` : `<div class="lbl" style="margin-top:10px">Trash is empty</div>`}</div>
    </div>
    <div class="sectionlabel" style="margin-left:0">By file type</div>
    ${rows || `<div style="color:var(--text-2)">No files yet.</div>`}
    ${chat ? `<div class="navsep"></div><div class="sectionlabel" style="margin-left:0">Telegram backend</div>
      <div class="dsect" style="border:1px solid var(--border-soft);border-radius:12px;margin-top:6px">
        <div class="kv"><span class="k">Chat</span><span class="v">${escapeHtml(chat.title || "—")}</span></div>
        <div class="kv"><span class="k">Type</span><span class="v">${escapeHtml(chat.type || "—")}</span></div>
        <div class="kv"><span class="k">Chat ID</span><span class="v">${escapeHtml(String(chat.id || ""))}</span></div>
        ${chat.invite_link ? `<div class="kv"><span class="k">Invite</span><span class="v"><a href="${escapeHtml(chat.invite_link)}" target="_blank" rel="noopener" style="color:var(--primary)">${escapeHtml(chat.invite_link)}</a></span></div>` : ""}
      </div>` : ""}
  `;
}

export function renderDetails(ctx) {
  const { vault, state } = ctx;
  const ro = !!ctx.readOnly;
  const ids = [...state.selection];
  if (!ids.length) return "";

  if (ids.length > 1) {
    let bytes = 0;
    let folders = 0;
    for (const id of ids) {
      const n = vault.getNode(id);
      if (!n) continue;
      if (isFolder(n)) folders++; else bytes += Number(n.size) || 0;
    }
    return `<div class="dhead"><span style="flex:1;font-weight:500">${ids.length} items selected</span>
      <button class="iconbtn" data-act="clearsel">${icon("close")}</button></div>
      <div class="dsect"><div class="kv"><span class="k">Files</span><span class="v">${ids.length - folders}</span></div>
      <div class="kv"><span class="k">Folders</span><span class="v">${folders}</span></div>
      <div class="kv"><span class="k">Total size</span><span class="v">${escapeHtml(fmtBytes(bytes))}</span></div></div>
      <div class="dactions">
        <button class="daction" data-act="download">${icon("download")}<span>Download</span></button>
        <button class="daction" data-act="zip">${icon("archive")}<span>Zip</span></button>
        ${ro ? "" : `<button class="daction" data-act="renamebulk">${icon("textFormat")}<span>Rename</span></button>
        <button class="daction" data-act="move">${icon("move")}<span>Move</span></button>
        <button class="daction" data-act="trash">${icon("trash")}<span>Trash</span></button>`}
      </div>`;
  }

  const node = vault.getNode(ids[0]);
  if (!node) return "";
  const folder = isFolder(node);
  const path = vault.pathOf(node.parentId).map((f) => f.name).join(" / ") || "My Drive";
  const preview = folder
    ? `<div class="dprev">${icon("folder", "icon-lg")}<div style="margin-left:10px">Folder</div></div>`
    : `<div class="dprev" data-preview="${escapeHtml(node.id)}"><div class="spin"></div></div>`;

  const inTrash = !!node.trashed;
  const vcount = (node.versions || []).length;
  const guest = !!ctx.shared;
  return `<div class="dhead">
      <button class="iconbtn" data-act="clearsel" title="Close">${icon("close")}</button>
      <div class="grow"></div>
      ${inTrash ? `<button class="iconbtn" data-act="restore" title="Restore">${icon("restore")}</button>` : (guest ? "" : `<button class="iconbtn" data-act="share" title="Get link">${icon("link")}</button>`)}
      <button class="iconbtn" data-act="menu" title="More actions">${icon("more")}</button>
    </div>
    ${preview}
    <div class="dname">${folder ? icon("folder", "icon") : fileIcon(node.kind, node.name, "icon")}<span class="nm">${escapeHtml(node.name)}</span>
      ${node.enc ? `<span class="enctag" title="Encrypted">${icon("lock", "icon-sm")}</span>` : ""}
      ${node.starred ? `<span style="color:var(--yellow)">${icon("star", "icon-sm")}</span>` : ""}</div>
    <div class="dactions">
      ${folder ? `<button class="daction" data-act="open">${icon("folder")}<span>Open</span></button>`
        : `<button class="daction" data-act="preview">${icon("eye")}<span>Preview</span></button>
           <button class="daction" data-act="download">${icon("download")}<span>Download</span></button>`}
      ${guest ? "" : `<button class="daction" data-act="share">${icon("share")}<span>Share</span></button>`}
      ${ro ? "" : `<button class="daction" data-act="rename">${icon("edit")}<span>Rename</span></button>
      <button class="daction" data-act="move">${icon("move")}<span>Move</span></button>
      <button class="daction" data-act="star">${icon(node.starred ? "star" : "starBorder")}<span>${node.starred ? "Starred" : "Star"}</span></button>
      ${vcount ? `<button class="daction" data-act="versions">${icon("history")}<span>${vcount} version${vcount === 1 ? "" : "s"}</span></button>` : ""}
      <button class="daction" data-act="trash">${icon("trash")}<span>${inTrash ? "Delete" : "Trash"}</span></button>`}
    </div>
    <div class="dsect">
      <h4>File details</h4>
      <div class="kv"><span class="k">Type</span><span class="v">${escapeHtml(folder ? "Folder" : (KIND_LABEL[node.kind] || "File"))}</span></div>
      ${folder ? "" : `<div class="kv"><span class="k">Size</span><span class="v">${escapeHtml(fmtBytes(node.size))}</span></div>`}
      ${folder || !node.mime ? "" : `<div class="kv"><span class="k">MIME</span><span class="v">${escapeHtml(node.mime)}</span></div>`}
      <div class="kv"><span class="k">Owner</span><span class="v">${escapeHtml(vault.account ? vault.account.name : "me")}</span></div>
      <div class="kv"><span class="k">Created</span><span class="v">${escapeHtml(fmtDate(node.createdAt))}</span></div>
      <div class="kv"><span class="k">Modified</span><span class="v">${escapeHtml(fmtDate(node.modifiedAt))}</span></div>
      <div class="kv"><span class="k">Location</span><span class="v">${escapeHtml(path)}</span></div>
      ${folder ? "" : `<div class="kv"><span class="k">Chunks</span><span class="v">${(node.parts || []).length} on Telegram</span></div>`}
      ${node.enc ? `<div class="kv"><span class="k">Encryption</span><span class="v">AES-GCM (client-side)</span></div>` : ""}
      ${vcount ? `<div class="kv"><span class="k">Versions</span><span class="v">${vcount} earlier</span></div>` : ""}
    </div>
    ${folder ? `<div class="dsect"><h4>Contents</h4><div class="kv"><span class="v">${folderSubtitle(node, ctx)}</span></div></div>` : ""}
  `;
}

export function renderTransfersHtml(tm) {
  const all = tm.list();
  const jobs = all.filter((j) => j.status !== "done" || Date.now() - (j.endedAt || 0) < 4000);
  const visible = jobs.length ? jobs : all.slice(-3);
  const active = all.filter((j) => j.status === "active").length;
  const paused = all.filter((j) => j.status === "paused").length;
  const title = active ? `${active} transfer${active === 1 ? "" : "s"} in progress`
    : paused ? `${paused} paused`
    : "Transfers";
  const rows = visible.slice(-14).reverse().map((j) => {
    const pct = j.size ? Math.min(100, (j.transferred / j.size) * 100) : (j.status === "done" ? 100 : 0);
    const starting = j.status === "active" && j.transferred === 0;
    let sub;
    if (j.status === "active") {
      const chunks = j.type === "archive"
        ? `${j.chunkDone}/${j.chunkTotal} files · `
        : j.chunkTotal > 1 ? `chunk ${Math.min(j.chunkDone + 1, j.chunkTotal)}/${j.chunkTotal} · ` : "";
      const left = j.eta == null ? "" : ` · ${fmtEta(j.eta)} left`;
      sub = `${chunks}${fmtBytes(j.transferred)} of ${fmtBytes(j.size)} · <span class="speed-tag">${fmtSpeed(j.speed || 0)}</span>${left}`;
      if (starting) sub = `${chunks}starting…`;
    } else if (j.status === "done") sub = `${fmtBytes(j.size)} · complete`;
    else if (j.status === "error") sub = escapeHtml(j.error || "Failed");
    else if (j.status === "cancelled") sub = "Cancelled";
    else if (j.status === "paused") sub = `${fmtBytes(j.transferred)} of ${fmtBytes(j.size)} · paused`;
    else sub = "Waiting…";

    const iconName = j.type === "archive" ? "archive" : j.type === "upload" ? "upload" : "download";
    const controls = [];
    if (j.status === "active") {
      controls.push(`<span class="icon-sm act" data-tpause="${escapeHtml(j.id)}" title="Pause">${icon("pause", "icon-sm")}</span>`);
      controls.push(`<span class="icon-sm act" data-tcancel="${escapeHtml(j.id)}" title="Cancel">${icon("close", "icon-sm")}</span>`);
    } else if (j.status === "paused") {
      controls.push(`<span class="icon-sm act" data-tresume="${escapeHtml(j.id)}" title="Resume">${icon("play", "icon-sm")}</span>`);
      controls.push(`<span class="icon-sm act" data-tcancel="${escapeHtml(j.id)}" title="Cancel">${icon("close", "icon-sm")}</span>`);
    } else if (j.status === "queued") {
      controls.push(`<span class="icon-sm act" data-tcancel="${escapeHtml(j.id)}" title="Cancel">${icon("close", "icon-sm")}</span>`);
    } else if (j.status === "error") {
      if (j.type === "download" || j.type === "archive" || (j.type === "upload" && j.file)) {
        controls.push(`<span class="icon-sm act" data-tretry="${escapeHtml(j.id)}" title="Retry">${icon("refresh", "icon-sm")}</span>`);
      }
      controls.push(`<span class="icon-sm act" data-tdiscard="${escapeHtml(j.id)}" title="Discard">${icon("trash", "icon-sm")}</span>`);
    }

    return `<div class="trow ${j.status}">
      <span style="color:var(--text-2)">${icon(iconName, "icon")}</span>
      <div class="tbody">
        <div class="tname" title="${escapeHtml(j.name)}">${escapeHtml(j.name)}${j.restored ? ` <span class="badge">restored</span>` : ""}</div>
        <div class="tsub">${sub}</div>
        <div class="tbar"><i class="${starting ? "indet" : ""}" style="width:${pct}%"></i></div>
      </div>
      ${controls.join("")}
    </div>`;
  }).join("");

  const doneAll = all.filter((j) => j.status === "done").length;
  const hasPaused = paused > 0;
  const hasActive = active > 0;
  return `<div class="thead">
      <span style="color:var(--primary)">${active ? `<div class="spin" style="width:18px;height:18px"></div>` : icon("checkCircle", "icon")}</span>
      <span class="tt">${escapeHtml(title)}${doneAll && !active && !paused ? ` · ${doneAll} completed` : ""}</span>
      ${hasActive ? `<button class="iconbtn" style="width:32px;height:32px" data-act="tpauseall" title="Pause all">${icon("pause", "icon-sm")}</button>` : ""}
      ${hasPaused ? `<button class="iconbtn" style="width:32px;height:32px" data-act="tresumeall" title="Resume all">${icon("play", "icon-sm")}</button>` : ""}
      <button class="iconbtn" style="width:32px;height:32px" data-act="tclear" title="Clear finished">${icon("close", "icon-sm")}</button>
    </div>
    <div class="tlist">${rows}</div>`;
}

export function fileTypeLine(node) {
  if (isFolder(node)) return "Folder";
  return `${KIND_LABEL[node.kind] || "File"}${node.mime ? " · " + escapeHtml(node.mime) : ""}`;
}

export { kindColor, fileIcon, icon, driveLogo, googleG };
