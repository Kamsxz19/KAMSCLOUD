import { fileKind, fmtBytes, sleep, extOf } from "./util.js";
import { uid, aesEncrypt, aesDecrypt } from "./crypto.js";
import * as store from "./resume.js";
import { ZipWriter, shouldCompress, zipNameFor, crc32 } from "./zip.js";

const MIME_BY_EXT = {
  txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif", heic: "image/heic",
  mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
  pdf: "application/pdf", zip: "application/zip", rar: "application/vnd.rar", "7z": "application/x-7z-compressed",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  html: "text/html", css: "text/css", js: "text/javascript", apk: "application/vnd.android.package-archive",
};

export function mimeFromName(name) {
  const m = MIME_BY_EXT[extOf(name)];
  return m || "application/octet-stream";
}

export function sanitizeName(name) {
  return String(name || "file")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96) || "file";
}

export function messageLink(chatId, messageId) {
  const s = String(chatId).replace(/^-100/, "");
  return `https://t.me/c/${s}/${messageId}`;
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sanitizeName(name) || "download";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30 * 60 * 1000);
}

function thumbCanvas(source, w, h) {
  const max = 400;
  const scale = Math.min(1, max / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const ctx = c.getContext("2d");
  ctx.drawImage(source, 0, 0, cw, ch);
  return new Promise((res) => c.toBlob((b) => res(b), "image/jpeg", 0.72));
}

export async function makeThumbnail(file, kind) {
  if (kind !== "image" && kind !== "video") return null;
  if (file.size > 400 * 1024 * 1024) return null;
  const url = URL.createObjectURL(file);
  try {
    if (kind === "image") {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        const t = setTimeout(() => rej(new Error("image thumb timeout")), 12000);
        i.onload = () => { clearTimeout(t); res(i); };
        i.onerror = () => { clearTimeout(t); rej(new Error("image decode failed")); };
        i.src = url;
      });
      return await thumbCanvas(img, img.naturalWidth, img.naturalHeight);
    }
    const video = await new Promise((res, rej) => {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "metadata";
      const t = setTimeout(() => rej(new Error("video thumb timeout")), 15000);
      v.onloadeddata = () => {
        try {
          const at = Math.min(Math.max(0.1, (v.duration || 2) * 0.2), 6);
          v.currentTime = at;
        } catch (e) { clearTimeout(t); res(v); }
      };
      v.onseeked = () => { clearTimeout(t); res(v); };
      v.onerror = () => { clearTimeout(t); rej(new Error("video decode failed")); };
      v.src = url;
    });
    if (!video.videoWidth) return null;
    return await thumbCanvas(video, video.videoWidth, video.videoHeight);
  } catch (e) {
    console.warn("thumbnail generation skipped:", e.message);
    return null;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

const PART_CAPTION = (cfg, enc) => `${cfg.indexPrefix}:PART${enc ? ":ENC" : ""}`;

export class TransferManager {
  constructor(vault, tg, cfg) {
    this.vault = vault;
    this.tg = tg;
    this.cfg = cfg;
    this.jobs = new Map();
    this.order = [];
    this.listeners = new Set();
    this.uploadQueue = [];
    this.uploadWorkers = 0;
    this.pathCache = new Map();
    this._pathInflight = new Map();
    this.resumeRecords = [];
    this._restoreDone = false;
    this._timer = setInterval(() => this._updateRates(), 650);
    this._persistTimer = null;
  }

  /* ------------------------------------------------------------- helpers */

  get encKey() {
    return (this.vault && this.vault.encKey) || null;
  }

  chunkSizeFor(size) {
    const target = this.cfg.targetChunks || 8;
    const ideal = Math.ceil((Number(size) || 0) / target);
    return Math.max(this.cfg.minChunkSize, Math.min(this.cfg.maxChunkSize, ideal));
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of [...this.listeners]) {
      try { fn(this); } catch (e) { console.error("transfer listener error", e); }
    }
  }

  list() {
    return this.order.map((id) => this.jobs.get(id)).filter(Boolean);
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  activeCount() {
    return this.list().filter((j) => j.status === "active" || j.status === "queued" || j.status === "paused").length;
  }

  clearFinished(includeErrors) {
    for (const id of [...this.order]) {
      const j = this.jobs.get(id);
      if (!j) continue;
      const finished = j.status === "done" || j.status === "cancelled" || (includeErrors && j.status === "error");
      if (finished) {
        this.jobs.delete(id);
        this.order = this.order.filter((x) => x !== id);
        store.dropJob(this.resumeRecords, id);
      }
    }
    this._schedulePersist();
    this.emit();
  }

  /* -------------------------------------------------------- pause/resume */

  pause(id) {
    const job = this.jobs.get(id);
    if (!job || (job.status !== "active" && job.status !== "queued")) return;
    job.paused = true;
    if (job.status === "queued") job.status = "paused";
    else job.status = "paused";
    this.emit();
  }

  resume(id) {
    const job = this.jobs.get(id);
    if (!job || !job.paused) return;
    job.paused = false;
    job.status = "active";
    job.startedAt = job.startedAt || Date.now();
    const waiters = job._pauseWaiters.splice(0);
    for (const w of waiters) w();
    if (job.type === "upload") {
      this._requeueMissingUploadChunks(job);
      for (let i = 0; i < this.cfg.uploadConcurrency; i++) this._spawnUploadWorker();
    } else if (job.resumeFn) {
      job.resumeFn();
    }
    this.emit();
  }

  pauseAll() {
    for (const j of this.list()) if (!j.paused) this.pause(j.id);
  }

  resumeAll() {
    for (const j of this.list()) if (j.paused) this.resume(j.id);
  }

  _waitWhilePaused(job) {
    if (!job || !job.paused || job.cancelled) return Promise.resolve();
    return new Promise((res) => job._pauseWaiters.push(res));
  }

  /** Shared token bucket that caps the *combined* upload+download rate.
   *  `cfg.maxSpeedMBps === 0` means unlimited (no overhead at all). */
  async _throttle(bytes) {
    const limit = Number(this.cfg.maxSpeedMBps) || 0;
    if (limit <= 0 || !bytes) return;
    const perMs = (limit * 1024 * 1024) / 1000;
    const cap = limit * 1024 * 1024;
    const now = Date.now();
    const tb = this._tb || (this._tb = { tokens: cap, last: now, cap });
    tb.tokens = Math.min(tb.cap, tb.tokens + (now - tb.last) * perMs);
    tb.last = now;
    tb.tokens -= bytes;
    if (tb.tokens < 0) {
      const wait = Math.min(5000, (-tb.tokens) / perMs);
      await sleep(wait);
      tb.tokens = 0;
      tb.last = Date.now();
    }
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    if (job.controller) job.controller.abort();
    if (job.status === "queued" || job.status === "active" || job.status === "paused") {
      job.status = "cancelled";
      job.endedAt = Date.now();
      job.speed = 0;
      job.eta = Infinity;
    }
    const waiters = job._pauseWaiters.splice(0);
    for (const w of waiters) w();
    this._pruneUploadQueue();
    if (job.type === "upload") {
      for (const p of job.partResults || []) {
        if (p && p.mid) this.tg.deleteMessage(this.cfg.chatId, p.mid).catch(() => {});
      }
      for (const t of this.uploadQueue) if (t.job === job) t.job = null;
      this._pruneUploadQueue();
    }
    this._forget(job);
    this.emit();
  }

  cancelAll() {
    for (const j of this.list()) this.cancel(j.id);
  }

  retry(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.type === "upload") return this.retryUpload(id);
    if (job.type === "archive") return this.downloadZip(job.archive?.nodes || [], { replaceId: id });
    return this.retryDownload(id);
  }

  retryDownload(id) {
    const job = this.jobs.get(id);
    if (!job || job.type !== "download") return null;
    const entry = job.entry;
    const handleKey = job.mode === "disk" ? job.handleKey : null;
    this.jobs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    return this.downloadFile(entry, { target: handleKey ? { kind: "disk", key: handleKey } : null });
  }

  retryUpload(id) {
    const job = this.jobs.get(id);
    if (!job || job.type !== "upload" || !job.file) return null;
    job.status = "active";
    job.paused = false;
    job.cancelled = false;
    job.error = null;
    job.controller = new AbortController();
    job._pauseWaiters = [];
    job.chunkAttempts = new Array(job.chunkTotal).fill(0);
    job.endedAt = null;
    this._requeueMissingUploadChunks(job);
    for (let i = 0; i < this.cfg.uploadConcurrency; i++) this._spawnUploadWorker();
    this.emit();
    return job;
  }

  /** Removes an interrupted transfer's data (source file, staged bytes, handle). */
  async discard(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.cancel(id);
    if (job.type === "upload") {
      for (const p of job.partResults || []) {
        if (p && p.mid) this.tg.deleteMessage(this.cfg.chatId, p.mid).catch(() => {});
      }
    }
    const rec = this.resumeRecords.find((r) => r.id === id);
    if (rec) {
      await store.cleanup(rec);
      store.dropJob(this.resumeRecords, id);
      this._schedulePersist();
    }
    this.jobs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.emit();
  }

  /* ------------------------------------------------------------ persists */

  _schedulePersist() {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      store.saveJobs(this.resumeRecords).catch(() => {});
    }, 900);
  }

  _register(job) {
    const rec = {
      id: job.id, type: job.type, entryId: job.entryId || null, name: job.name, size: job.size,
      chunkSize: job.chunkSize || 0, chunkTotal: job.chunkTotal || 0,
      partDone: job.partDone ? [...job.partDone] : null,
      partResults: job.partResults || null,
      mode: job.mode || "blob", handleKey: job.handleKey || null, opfsName: job.opfsName || null,
      srcKey: job.srcKey || null, parentId: job.parentId || null, mime: job.mime || null,
      encrypted: !!job.encrypted, received: job.transferred || 0, createdAt: job.createdAt || Date.now(),
    };
    if (job.type === "archive") return;
    if (job.type === "upload" && !rec.srcKey) return;
    store.upsertJob(this.resumeRecords, rec);
    this._schedulePersist();
  }

  _persistProgress(job) {
    if (job.type === "archive") return;
    const rec = this.resumeRecords.find((r) => r.id === job.id);
    if (!rec) {
      if (job.type === "upload" && !job.srcKey) return;
      this._register(job);
      return;
    }
    if (job.partDone) rec.partDone = [...job.partDone];
    if (job.partResults) rec.partResults = job.partResults;
    rec.received = job.transferred || 0;
    rec.updatedAt = Date.now();
    this._schedulePersist();
  }

  async _forget(job, opts = {}) {
    const rec = this.resumeRecords.find((r) => r.id === job.id);
    if (!rec) return;
    if (opts.keepStaged) rec.opfsName = null;
    await store.cleanup(rec);
    store.dropJob(this.resumeRecords, job.id);
    this._schedulePersist();
  }

  /* -------------------------------------------------------------- rates */

  _updateRates() {
    const now = Date.now();
    let changed = false;
    for (const job of this.jobs.values()) {
      if (job.status !== "active") continue;
      const dt = (now - job._lastAt) / 1000;
      if (dt < 0.45) continue;
      const inst = (job.transferred - job._lastBytes) / dt;
      job.speed = job.speed == null ? inst : job.speed * 0.6 + inst * 0.4;
      job._lastBytes = job.transferred;
      job._lastAt = now;
      job.eta = job.speed > 2048 ? Math.max(0, (job.size - job.transferred) / job.speed) : null;
      changed = true;
    }
    if (changed) this.emit();
  }

  _newJob(patch) {
    const job = Object.assign({
      id: uid("t_"),
      status: "queued",
      transferred: 0,
      speed: null,
      eta: null,
      error: null,
      startedAt: null,
      endedAt: null,
      createdAt: Date.now(),
      cancelled: false,
      paused: false,
      chunkDone: 0,
      chunkTotal: 0,
      _lastBytes: 0,
      _lastAt: Date.now(),
      _pauseWaiters: [],
      controller: new AbortController(),
    }, patch);
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    return job;
  }

  /* ------------------------------------------------------------ restores */

  async restoreResumable() {
    if (this._restoreDone) return [];
    this._restoreDone = true;
    let recs = [];
    try { recs = await store.loadJobs(); } catch (e) { recs = []; }
    const restored = [];
    for (const rec of recs) {
      if (!rec || !rec.id) continue;
      this.resumeRecords.push(rec);
      if (rec.type === "download") {
        const entry = this.vault.getNode(rec.entryId);
        if (!entry || !entry.parts) { await store.cleanup(rec); store.dropJob(this.resumeRecords, rec.id); continue; }
        const job = this._newJob({
          id: rec.id, type: "download", name: rec.name, size: rec.size, entry, entryId: rec.entryId,
          chunkTotal: entry.parts.length, partDone: (rec.partDone && rec.partDone.length === entry.parts.length)
            ? rec.partDone.slice() : new Array(entry.parts.length).fill(false),
          mime: rec.mime || entry.mime || "", encrypted: !!entry.enc,
          mode: rec.mode || "blob", handleKey: rec.handleKey || null, opfsName: rec.opfsName || null,
          paused: true, status: "paused", restored: true,
        });
        job.transferred = (entry.parts || []).reduce((s, p, i) => s + (job.partDone[i] ? (Number(p.size) || 0) : 0), 0);
        job.chunkDone = job.partDone.filter(Boolean).length;
        job._pauseWaiters = [];
        restored.push(job);
      } else if (rec.type === "upload") {
        const file = rec.srcKey ? await store.getSourceFile(rec.srcKey) : null;
        if (!file) {
          await store.cleanup(rec);
          store.dropJob(this.resumeRecords, rec.id);
          continue;
        }
        const job = this._newJob({
          id: rec.id, type: "upload", name: rec.name, size: rec.size, file,
          parentId: rec.parentId || "root", chunkSize: rec.chunkSize || this.chunkSizeFor(rec.size),
          chunkTotal: rec.chunkTotal || 0, srcKey: rec.srcKey,
          encrypted: !!rec.encrypted, partResults: rec.partResults || [],
          paused: true, status: "paused", restored: true,
        });
        job.chunkAttempts = new Array(job.chunkTotal).fill(0);
        job.chunkDone = job.partResults.filter(Boolean).length;
        job.transferred = job.partResults.reduce((s, p) => s + (p ? Number(p.size) || 0 : 0), 0);
        restored.push(job);
      }
    }
    if (restored.length) this.emit();
    this.sweepOpfs().catch(() => {});
    return restored;
  }

  /** Removes staged OPFS files that no resume record refers to. */
  async sweepOpfs() {
    if (!store.opfsSupported()) return 0;
    try {
      const dir = await navigator.storage.getDirectory();
      const keep = new Set(this.resumeRecords.map((r) => r.opfsName).filter(Boolean));
      let removed = 0;
      for await (const [name, handle] of dir.entries()) {
        if (!name.startsWith("tdrive-")) continue;
        if (keep.has(name)) continue;
        if (handle.kind !== "file") continue;
        await dir.removeEntry(name).catch(() => {});
        removed++;
      }
      return removed;
    } catch (e) {
      return 0;
    }
  }

  /* ------------------------------------------------------------- uploads */

  async enqueueUploads(files, parentId) {
    if (this.vault.account && this.vault.account.enc && !this.encKey) {
      throw new Error("Unlock this encrypted drive before uploading files");
    }
    const jobs = [];
    const tasks = [];
    const encrypted = !!this.encKey;

    for (const file of files) {
      if (file.size > this.cfg.maxFileSize) {
        const bad = this._newJob({
          type: "upload", name: file.name, size: file.size, status: "error",
          error: `Exceeds the ${fmtBytes(this.cfg.maxFileSize)} per-file limit`, endedAt: Date.now(),
        });
        jobs.push(bad);
        continue;
      }
      const chunkSize = this.chunkSizeFor(file.size);
      const chunkTotal = file.size === 0 ? 0 : Math.ceil(file.size / chunkSize);
      const job = this._newJob({
        type: "upload", name: file.name, size: file.size, file, parentId,
        chunkSize, chunkTotal, chunkAttempts: new Array(chunkTotal).fill(0),
        partResults: new Array(chunkTotal).fill(null), encrypted,
      });
      jobs.push(job);
      for (let i = 0; i < chunkTotal; i++) tasks.push({ job, index: i });
      if (!encrypted && file.size > 0 && file.size <= this.cfg.persistUploadMax) {
        job.srcKey = "src_" + job.id;
        store.putSourceFile(job.srcKey, file).then(() => this._register(job)).catch(() => {});
      }
    }

    const interleaved = [];
    const cursors = jobs.map((j) => ({ job: j, i: 0 }));
    let remaining = true;
    while (remaining) {
      remaining = false;
      for (const c of cursors) {
        if (c.i < c.job.chunkTotal) {
          interleaved.push({ job: c.job, index: c.i++ });
          remaining = true;
        }
      }
    }
    this.emit();

    for (const job of jobs) {
      if (job.chunkTotal === 0 && job.status !== "error") {
        job.status = "active";
        job.startedAt = Date.now();
        await this._finalizeUpload(job).catch((e) => {
          job.status = "error";
          job.error = String((e && e.message) || e);
          job.endedAt = Date.now();
        });
      }
    }

    this.uploadQueue.push(...interleaved);
    for (let i = 0; i < this.cfg.uploadConcurrency; i++) this._spawnUploadWorker();
    return jobs;
  }

  _requeueMissingUploadChunks(job) {
    const queued = new Set(this.uploadQueue.filter((t) => t.job === job).map((t) => t.index));
    for (let i = 0; i < job.chunkTotal; i++) {
      if (job.partResults[i]) continue;
      if (queued.has(i)) continue;
      this.uploadQueue.push({ job, index: i });
    }
    this._pruneUploadQueue();
  }

  _pruneUploadQueue() {
    this.uploadQueue = this.uploadQueue.filter((t) => {
      const j = t.job;
      if (!j || j.cancelled || j.status === "error") return false;
      if (j.partResults && j.partResults[t.index]) return false;
      return true;
    });
  }

  _spawnUploadWorker() {
    if (this.uploadWorkers >= this.cfg.uploadConcurrency) return;
    this.uploadWorkers++;
    (async () => {
      try {
        for (;;) {
          if (!this.uploadQueue.length) break;
          const idx = this.uploadQueue.findIndex((t) =>
            t.job && !t.job.cancelled && t.job.status !== "error" && !t.job.paused
            && !(t.job.partResults && t.job.partResults[t.index]));
          if (idx < 0) {
            const alive = this.uploadQueue.some((t) => t.job && !t.job.cancelled && t.job.status !== "error");
            this._pruneUploadQueue();
            if (!alive || !this.uploadQueue.length) break;
            await sleep(280);
            continue;
          }
          const task = this.uploadQueue.splice(idx, 1)[0];
          await this._uploadChunk(task);
        }
      } catch (e) {
        console.error("upload worker crashed", e);
      } finally {
        this.uploadWorkers--;
        if (this.uploadQueue.length) this._spawnUploadWorker();
      }
    })();
  }

  async _uploadChunk(task) {
    const { job, index } = task;
    if (!job || job.cancelled || job.status === "error") return;
    if (job.partResults && job.partResults[index]) return;
    await this._waitWhilePaused(job);
    if (job.cancelled) return;
    if (job.status === "queued") { job.status = "active"; job.startedAt = Date.now(); }

    const start = index * job.chunkSize;
    const end = Math.min(job.file.size, start + job.chunkSize);
    const plain = job.file.slice(start, end);
    const plainSize = plain.size;
    await this._throttle(plainSize);
    let payload = plain;
    let crc = null;
    try { crc = crc32(new Uint8Array(await plain.arrayBuffer())) >>> 0; } catch (e) { crc = null; }
    if (job.encrypted && this.encKey) {
      try {
        const u8 = new Uint8Array(await plain.arrayBuffer());
        payload = new Blob([await aesEncrypt(this.encKey, u8)]);
      } catch (e) {
        job.status = "error";
        job.error = "Could not encrypt: " + String(e.message || e);
        job.endedAt = Date.now();
        this.emit();
        return;
      }
    }
    const safe = sanitizeName(job.name);
    const fname = `${safe}.tdrive${index + 1}-${job.chunkTotal}.bin`;
    try {
      const res = await this.tg.sendDocument(
        this.cfg.chatId, payload, fname, PART_CAPTION(this.cfg, job.encrypted),
        job.controller.signal,
      );
      if (job.cancelled) return;
      job.partResults[index] = {
        mid: res.message_id,
        fid: res.document.file_id,
        size: plainSize,
        csize: res.document.file_size || payload.size,
        crc,
      };
      job.chunkDone += 1;
      job.transferred += plainSize;
      this._persistProgress(job);
      this.emit();
      if (job.chunkDone >= job.chunkTotal) await this._finalizeUpload(job);
    } catch (e) {
      if (job.cancelled || (job.controller && job.controller.signal.aborted)) return;
      job.chunkAttempts[index] = (job.chunkAttempts[index] || 0) + 1;
      if (job.chunkAttempts[index] <= (this.cfg.chunkRetries || 3)) {
        this.uploadQueue.push({ job, index });
        this.emit();
        return;
      }
      job.status = "error";
      job.error = String((e && e.message) || e);
      job.endedAt = Date.now();
      job.speed = 0;
      this.emit();
    }
  }

  async _finalizeUpload(job) {
    const kind = fileKind(job.name, job.file.type);
    let thumb = null;
    let thumbMid = null;
    if (!job.encrypted) {
      try {
        const t = await makeThumbnail(job.file, kind);
        if (t) {
          const r = await this.tg.sendPhoto(this.cfg.chatId, t, "thumb.jpg", `${this.cfg.indexPrefix}:THUMB`);
          const sizes = (r && r.photo) || [];
          const best = sizes[sizes.length - 1];
          if (best) { thumb = best.file_id; thumbMid = r.message_id; }
        }
      } catch (e) {
        console.warn("thumbnail upload failed", e);
      }
    }
    if (job.cancelled) return;
    const entry = {
      id: uid("d_"),
      name: sanitizeName(job.name),
      kind,
      mime: job.file.type || mimeFromName(job.name),
      size: job.file.size,
      parentId: job.parentId,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      starred: false,
      trashed: false,
      thumb,
      thumbMid,
      enc: !!job.encrypted,
      versions: [],
      parts: job.partResults.filter(Boolean).map((p) => ({
        mid: p.mid, fid: p.fid, size: p.size, csize: p.csize, crc: p.crc != null ? p.crc : null, path: null, pathAt: 0,
      })),
      path: null,
      pathAt: 0,
    };
    const final = this.vault.addFile(entry);
    job.entry = final;
    job.status = "done";
    job.transferred = job.size;
    job.endedAt = Date.now();
    job.speed = 0;
    job.eta = 0;
    await this._forget(job);
    this.emit();
  }

  /* ----------------------------------------------------------- downloads */

  _prepareOffsets(job) {
    const parts = (job.entry && job.entry.parts) || [];
    let off = 0;
    job.partOffsets = parts.map((p) => {
      const o = off;
      off += Number(p.size) || 0;
      return o;
    });
    return job.partOffsets;
  }

  async pickSaveTarget(entry) {
    if (!window.showSaveFilePicker) return null;
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: sanitizeName(entry.name) });
      const key = "h_" + uid();
      await store.putHandle(key, handle);
      return { kind: "disk", key };
    } catch (e) {
      return null;
    }
  }

  async downloadFile(entry, opts = {}) {
    const parts = entry.parts || [];
    const job = this._newJob({
      type: "download",
      name: entry.name,
      size: entry.size,
      entry,
      entryId: entry.id,
      chunkTotal: parts.length,
      partDone: new Array(parts.length).fill(false),
      mime: entry.mime || "",
      encrypted: !!entry.enc,
      mode: opts.target ? "disk" : (store.opfsSupported() ? "opfs" : "blob"),
      handleKey: (opts.target && opts.target.key) || null,
      keepTarget: !!(opts.target && opts.target.keep),
    });
    job.status = "active";
    job.startedAt = Date.now();
    this.emit();
    await this._runDownload(job, opts);
    return job;
  }

  async resumeDownload(id) {
    const job = this.jobs.get(id);
    if (!job || job.type !== "download" || !job.restored) return this.resume(id);
    if (job.mode === "disk" && job.handleKey) {
      const handle = await store.getHandle(job.handleKey);
      if (!handle || !(await store.ensureHandlePermission(handle))) {
        job.restored = false;
        job.mode = store.opfsSupported() ? "opfs" : "blob";
        job.handleKey = null;
        job.partDone = new Array(job.chunkTotal).fill(false);
        job.transferred = 0;
        job.chunkDone = 0;
        job.restored = false;
      }
    }
    job.restored = false;
    job.paused = false;
    job.status = "active";
    job.controller = new AbortController();
    job._pauseWaiters = [];
    this.emit();
    this._runDownload(job, {});
    return job;
  }

  async _runDownload(job, opts) {
    job.paused = false;
    try {
      const canRandom = job.entry.parts.every((p, i) => i === job.entry.parts.length - 1 || Number(p.size) > 0);
      let handle = null;
      if (job.mode === "disk" && job.handleKey) {
        handle = await store.getHandle(job.handleKey);
        if (!handle) throw new Error("The saved file location is no longer available");
        if (!(await store.ensureHandlePermission(handle))) throw new Error("Permission to the save location was denied");
      }
      let kind = job.mode;
      let sink;
      if (job.mode === "disk") { sink = new store.DiskSink(handle); kind = "disk"; }
      else if (job.mode === "opfs" && canRandom) { sink = new store.OpfsSink(job.opfsName || store.opfsNameFor(job.id)); kind = "opfs"; }
      else { sink = new store.BlobSink(); kind = "blob"; job.mode = "blob"; }
      job.mode = kind;
      job.opfsName = kind === "opfs" ? (job.opfsName || store.opfsNameFor(job.id)) : null;
      const hasPartial = job.restored || job.partDone.some(Boolean);
      try {
        await sink.open(hasPartial);
      } catch (e) {
        if (kind !== "opfs") throw e;
        console.warn("OPFS staging unavailable, falling back to in-memory download", e);
        sink = new store.BlobSink();
        kind = "blob";
        job.mode = "blob";
        job.opfsName = null;
        job.partDone = new Array(job.entry.parts.length).fill(false);
        job.transferred = 0;
        job.chunkDone = 0;
        await sink.open(false);
      }
      if (!job.partDone) job.partDone = new Array(job.entry.parts.length).fill(false);
      this._prepareOffsets(job);
      if (job.opfsName && !job.restored) this._register(job);

      if (sink.supportsResume()) {
        await this._pumpDownload(job, sink);
      } else {
        await this._downloadParts(job, { write: async (u8) => sink.writeAt(0, u8) });
      }
      if (job.cancelled) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
      await sink.close();
      if (kind !== "disk") {
        const blob = await sink.toBlob(job.mime);
        saveBlob(blob, job.name);
      }
      job.status = "done";
      job.transferred = job.size;
      job.eta = 0;
      job.endedAt = Date.now();
      this.vault.logEvent && this.vault.logEvent("download", job.name, job.size);
      const staged = job.opfsName;
      job.opfsName = null;
      await this._forget(job, { keepStaged: true });
      if (staged) setTimeout(() => store.removeOpfs(staged).catch(() => {}), 10 * 60 * 1000);
    } catch (e) {
      if (job.cancelled || (e && (e.name === "AbortError" || /aborted/i.test(String(e.message))))) {
        job.status = "cancelled";
      } else {
        job.status = "error";
        job.error = String((e && e.message) || e);
      }
      job.endedAt = Date.now();
    }
    job.speed = 0;
    this.emit();
    return job;
  }

  async _pumpDownload(job, sink) {
    const parts = job.entry.parts || [];
    const total = parts.length;
    if (!total) return;
    const concurrency = Math.max(1, Math.min(this.cfg.downloadConcurrency, total));
    this._prefetchPaths(job, parts);
    let next = 0;
    let failed = null;
    const worker = async () => {
      while (!failed) {
        if (job.cancelled) return;
        await this._waitWhilePaused(job);
        if (job.cancelled) return;
        const i = next++;
        if (i >= total) return;
        if (job.partDone[i]) continue;
        try {
          const buf = await this._downloadPart(parts[i], job, i);
          if (job.cancelled) return;
          await sink.writeAt(job.partOffsets[i], buf);
          job.partDone[i] = true;
          job.chunkDone = job.partDone.filter(Boolean).length;
          job.transferred += Number(parts[i].size) || buf.byteLength;
          this._persistProgress(job);
          this.emit();
        } catch (e) {
          failed = e;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (job.cancelled) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
    if (failed) throw failed;
    if (job.partDone.filter(Boolean).length < total) throw new Error("Download incomplete - some chunks failed");
  }

  _prefetchPaths(job, parts) {
    const limit = Math.max(1, Math.min(this.cfg.pathPrefetch || 8, parts.length));
    let i = 0;
    const worker = async () => {
      while (i < parts.length) {
        if (job.cancelled || job.paused) return;
        const p = parts[i++];
        try { await this.resolvePath(p); } catch (e) { /* worker retries with a fresh path */ }
      }
    };
    for (let k = 0; k < limit; k++) worker();
  }

  async resolvePath(part) {
    const cached = this.pathCache.get(part.fid);
    if (cached && Date.now() - cached.at < 45 * 60 * 1000) return cached.path;
    let inflight = this._pathInflight.get(part.fid);
    if (!inflight) {
      inflight = this.tg.getFilePath(part.fid)
        .then((path) => {
          this.pathCache.set(part.fid, { path, at: Date.now() });
          this._pathInflight.delete(part.fid);
          return path;
        })
        .catch((e) => {
          this._pathInflight.delete(part.fid);
          throw e;
        });
      this._pathInflight.set(part.fid, inflight);
    }
    return inflight;
  }

  invalidatePath(fid) {
    this.pathCache.delete(fid);
  }

  async fetchPartRaw(part, job) {
    let path = null;
    try { path = await this.resolvePath(part); } catch (e) { path = null; }
    if (!path) throw new Error("Lost track of a file chunk on Telegram");
    const signal = job && job.controller ? job.controller.signal : undefined;
    try {
      return await this.tg.fetchBytes(path, signal);
    } catch (e) {
      this.invalidatePath(part.fid);
      const fresh = await this.tg.getFilePath(part.fid);
      this.pathCache.set(part.fid, { path: fresh, at: Date.now() });
      return await this.tg.fetchBytes(fresh, signal);
    }
  }

  async _downloadPart(part, job, index, encFlag) {
    const encrypted = encFlag != null ? !!encFlag : !!(job && job.encrypted);
    let attempt = 0;
    for (;;) {
      await this._waitWhilePaused(job);
      if (job && job.cancelled) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
      try {
        await this._throttle(Number(part.size) || 0);
        const raw = await this.fetchPartRaw(part, job);
        let bytes;
        if (encrypted) {
          if (!this.encKey) throw new Error("This drive is encrypted - unlock it to read your files");
          bytes = await aesDecrypt(this.encKey, new Uint8Array(raw));
        } else {
          bytes = new Uint8Array(raw);
        }
        /* Per-chunk CRC-32 (of the plaintext) catches a truncated/mangled chunk.
         * A mismatch is treated like a failed fetch: drop the cached path and
         * retry, so a corrupt copy on Telegram self-heals from a fresh one. */
        if (part.crc != null && part.crc !== null && (crc32(bytes) >>> 0) !== (Number(part.crc) >>> 0)) {
          this.invalidatePath(part.fid);
          throw new Error("Chunk integrity check failed");
        }
        return bytes;
      } catch (e) {
        if (job && job.cancelled) throw e;
        if (encrypted && /unlock it/.test(String(e.message))) throw e;
        attempt += 1;
        if (attempt >= (this.cfg.chunkRetries || 3)) throw e;
        await sleep(500 * attempt);
      }
    }
  }

  /** Ordered, random-access-free download used for previews and blob fallback. */
  async _downloadParts(job, writer) {
    const parts = (job.entry && job.entry.parts) || [];
    const total = parts.length;
    if (!total) return;
    const concurrency = Math.max(1, Math.min(this.cfg.downloadConcurrency, total));
    const results = new Map();
    let nextToStart = 0;
    let nextToWrite = 0;
    let failed = null;
    let writeChain = Promise.resolve();
    const pumpWrites = () => {
      writeChain = writeChain.then(async () => {
        while (results.has(nextToWrite)) {
          const b = results.get(nextToWrite);
          results.delete(nextToWrite);
          await writer.write(b);
          nextToWrite += 1;
          job.chunkDone = nextToWrite;
          job.transferred += b.byteLength;
          this.emit();
        }
      });
      return writeChain;
    };
    const worker = async () => {
      for (;;) {
        if (job.cancelled || failed) return;
        const i = nextToStart++;
        if (i >= total) return;
        if (job.partDone && job.partDone[i]) { nextToWrite = Math.max(nextToWrite, i); continue; }
        try {
          const buf = await this._downloadPart(parts[i], job, i);
          results.set(i, buf);
          pumpWrites();
          await writeChain;
        } catch (e) {
          failed = e;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    await writeChain;
    if (job.cancelled) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
    if (failed) throw failed;
    if (nextToWrite < total) throw new Error("Download incomplete - some chunks failed");
  }

  /* ------------------------------------------------------------ previews */

  async previewUrl(entry) {
    const parts = entry.parts || [];
    if (entry.enc) return null;
    if (parts.length !== 1) return null;
    const path = await this.resolvePath(parts[0]);
    return this.tg.fileUrl(path);
  }

  async thumbUrl(entry) {
    if (!entry.thumb) return null;
    const cached = this.pathCache.get(entry.thumb);
    if (cached && Date.now() - cached.at < 45 * 60 * 1000) return this.tg.fileUrl(cached.path);
    const path = await this.tg.getFilePath(entry.thumb);
    this.pathCache.set(entry.thumb, { path, at: Date.now() });
    return this.tg.fileUrl(path);
  }

  async readTextHead(entry, maxBytes = 512 * 1024) {
    const parts = entry.parts || [];
    if (!parts.length) return "";
    const bytes = await this._downloadPart(parts[0], null, 0, !!entry.enc);
    const slice = bytes.byteLength > maxBytes ? bytes.slice(0, maxBytes) : bytes;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
    const truncated = entry.size > maxBytes || parts.length > 1;
    return truncated ? text + "\n\n... [truncated preview]" : text;
  }

  /** Streams an entry's bytes in order, downloading parts in parallel. */
  async streamEntry(entry, onChunk, job) {
    const parts = entry.parts || [];
    const total = parts.length;
    const encrypted = !!entry.enc;
    if (!total) return;
    const concurrency = Math.max(1, Math.min(this.cfg.downloadConcurrency, total));
    const results = new Map();
    let nextToStart = 0;
    let nextToWrite = 0;
    let failed = null;
    let writeChain = Promise.resolve();
    const pump = () => {
      writeChain = writeChain.then(async () => {
        while (results.has(nextToWrite)) {
          const b = results.get(nextToWrite);
          results.delete(nextToWrite);
          await onChunk(b);
          nextToWrite += 1;
        }
      });
      return writeChain;
    };
    const worker = async () => {
      for (;;) {
        if (failed || (job && job.cancelled)) return;
        const i = nextToStart++;
        if (i >= total) return;
        try {
          const buf = await this._downloadPart(parts[i], job, i, encrypted);
          results.set(i, buf);
          pump();
          await writeChain;
        } catch (e) {
          failed = e;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    await writeChain;
    if (failed) throw failed;
    if (nextToWrite < total) throw new Error("Download incomplete - some chunks failed");
  }

  /* --------------------------------------------------------- zip archive */

  async downloadZip(nodes, opts = {}) {
    const picked = nodes.filter(Boolean);
    const files = [];
    const folders = [];
    const walk = (node, prefix) => {
      if (!node) return;
      if (node.parts === undefined) {
        folders.push({ path: (prefix + node.name).replace(/^\/+/, ""), node });
        const kids = this.vault.children(node.id);
        for (const f of [...kids.folders, ...kids.files]) walk(f, prefix + node.name + "/");
      } else {
        files.push({ path: (prefix + node.name).replace(/^\/+/, ""), node });
      }
    };
    for (const n of picked) walk(n, "");
    const totalSize = files.reduce((s, f) => s + (Number(f.node.size) || 0), 0);
    const name = zipNameFor(picked.length === 1 ? picked[0].name : "KamsClouds archive");
    const job = this._newJob({
      type: "archive", name, size: totalSize, mime: "application/zip",
      chunkTotal: files.length,
      archive: { nodes: picked, files: files.length, folders: folders.length, done: 0, offset: 0, list: files, dirs: folders },
    });
    job.status = "active";
    job.startedAt = Date.now();
    this.emit();
    const useOpfs = store.opfsSupported();
    let opfsName = useOpfs ? "tdrive-" + job.id.replace(/[^a-z0-9_-]/gi, "") + ".zip" : null;
    let sink = null;
    if (opfsName) {
      const s = new store.OpfsSink(opfsName);
      try { await s.open(false); sink = s; }
      catch (e) { console.warn("OPFS staging unavailable for archive, using memory", e); opfsName = null; }
    }
    if (!sink) { sink = new store.BlobSink(); await sink.open(false); }
    try {
      const writer = new ZipWriter(async (u8) => {
        const pos = job.archive.offset;
        job.archive.offset += u8.length;
        await sink.writeAt(pos, u8);
      });
      for (const d of folders) {
        if (!d.path) continue;
        await writer.addFile(d.path.replace(/\/?$/, "/"), { read: async () => {} });
      }
      for (const f of files) {
        await this._waitWhilePaused(job);
        if (job.cancelled) break;
        const node = f.node;
        await writer.addFile(f.path, {
          kind: node.kind,
          compress: shouldCompress(node.kind, node.size),
          modifiedAt: node.modifiedAt,
          read: async (onChunk) => {
            await this.streamEntry(node, async (u8) => {
              await this._waitWhilePaused(job);
              await onChunk(u8);
              job.transferred += u8.length;
              this.emit();
            }, job);
          },
        });
        job.archive.done += 1;
        job.chunkDone = job.archive.done;
        this.emit();
      }
      if (job.cancelled) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
      await writer.finish();
      await sink.close();
      const blob = await sink.toBlob("application/zip");
      saveBlob(blob, name);
      job.status = "done";
      job.endedAt = Date.now();
      job.speed = 0;
      job.eta = 0;
      job.transferred = job.size;
      this.vault.logEvent && this.vault.logEvent("zip", name, totalSize);    } catch (e) {
      if (job.cancelled || (e && (e.name === "AbortError" || /aborted|cancel/i.test(String(e.message))))) {
        job.status = "cancelled";
      } else {
        job.status = "error";
        job.error = String((e && e.message) || e);
      }
      job.endedAt = Date.now();
      job.speed = 0;
    }
    if (opfsName) {
      if (job.status === "done") setTimeout(() => store.removeOpfs(opfsName).catch(() => {}), 10 * 60 * 1000);
      else await store.removeOpfs(opfsName).catch(() => {});
    }
    this.emit();
    return job;
  }

  async uploadFiles(files, parentId) {
    return this.enqueueUploads(Array.from(files), parentId || "root");
  }

  destroy() {
    clearInterval(this._timer);
    clearTimeout(this._persistTimer);
  }
}
