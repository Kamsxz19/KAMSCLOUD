/* Persistent state for resumable transfers, plus the storage "sinks" that
 * downloads write into. All of this lives in the device's IndexedDB / OPFS —
 * nothing is ever uploaded to Telegram. */

import { STORAGE_KEYS } from "./config.js";
import { kvGet as pfGet, kvSet as pfSet, kvDel as pfDel } from "./platform.js";

const JOBS_KEY = STORAGE_KEYS.resume;
const HANDLE_PREFIX = "tdrive.handle.";
const FILE_PREFIX = "tdrive.srcfile.";

export async function kvGet(key, def = null) {
  try {
    return await pfGet(key, def);
  } catch (e) {
    console.warn("resume kvGet failed", key, e);
    return def;
  }
}

export async function kvSet(key, val) {
  try {
    return await pfSet(key, val);
  } catch (e) {
    console.warn("resume kvSet failed", key, e);
    return false;
  }
}

export async function kvDel(key) {
  try {
    await pfDel(key);
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------- job registry */

export async function loadJobs() {
  const rec = await kvGet(JOBS_KEY, null);
  return rec && Array.isArray(rec.jobs) ? rec.jobs : [];
}

export async function saveJobs(jobs) {
  const slim = jobs.map((j) => ({
    id: j.id,
    type: j.type,
    entryId: j.entryId || null,
    name: j.name,
    size: j.size,
    chunkSize: j.chunkSize || 0,
    chunkTotal: j.chunkTotal || 0,
    partDone: j.partDone || null,
    partResults: j.partResults || null,
    mode: j.mode || "blob",
    handleKey: j.handleKey || null,
    opfsName: j.opfsName || null,
    srcKey: j.srcKey || null,
    parentId: j.parentId || null,
    mime: j.mime || null,
    encrypted: !!j.encrypted,
    received: j.received || 0,
    createdAt: j.createdAt,
    updatedAt: Date.now(),
  }));
  return kvSet(JOBS_KEY, { v: 1, jobs: slim });
}

export function upsertJob(jobs, rec) {
  const i = jobs.findIndex((j) => j.id === rec.id);
  if (i >= 0) jobs[i] = Object.assign(jobs[i], rec);
  else jobs.push(rec);
  return jobs;
}

export function dropJob(jobs, id) {
  const out = jobs.filter((j) => j.id !== id);
  jobs.length = 0;
  jobs.push(...out);
  return jobs;
}

/* ------------------------------------------------------------ handle / file */

export async function putHandle(key, handle) { return kvSet(HANDLE_PREFIX + key, handle); }
export async function getHandle(key) { return kvGet(HANDLE_PREFIX + key, null); }
export async function delHandle(key) { return kvDel(HANDLE_PREFIX + key); }

export async function ensureHandlePermission(handle, mode = "readwrite") {
  try {
    if (!handle || !handle.queryPermission) return true;
    if ((await handle.queryPermission({ mode })) === "granted") return true;
    return (await handle.requestPermission({ mode })) === "granted";
  } catch (e) {
    return false;
  }
}

export async function putSourceFile(key, file) { return kvSet(FILE_PREFIX + key, file); }
export async function getSourceFile(key) { return kvGet(FILE_PREFIX + key, null); }
export async function delSourceFile(key) { return kvDel(FILE_PREFIX + key); }

export async function cleanup(rec) {
  if (rec.handleKey) await delHandle(rec.handleKey);
  if (rec.srcKey) await delSourceFile(rec.srcKey);
  if (rec.opfsName) await removeOpfs(rec.opfsName);
}

/* ------------------------------------------------------------------- OPFS */

export function opfsSupported() {
  try {
    return !!(navigator.storage && navigator.storage.getDirectory && typeof FileSystemFileHandle !== "undefined"
      && FileSystemFileHandle.prototype.createWritable);
  } catch (e) {
    return false;
  }
}

async function opfsDir() {
  return navigator.storage.getDirectory();
}

export function opfsNameFor(id) {
  return "tdrive-" + String(id).replace(/[^a-z0-9_-]/gi, "") + ".part";
}

export async function removeOpfs(name) {
  if (!opfsSupported() || !name) return;
  try {
    const dir = await opfsDir();
    await dir.removeEntry(name);
  } catch (e) { /* already gone */ }
}

export async function opfsFile(name) {
  const dir = await opfsDir();
  const fh = await dir.getFileHandle(name);
  return fh.getFile();
}

/* ------------------------------------------------------------------ sinks */

export class BlobSink {
  constructor() { this.parts = []; }
  supportsResume() { return false; }
  async open() {}
  async writeAt(pos, u8) { this.parts.push(u8); }
  async close() {}
  async toBlob(mime) { return new Blob(this.parts, { type: mime || "application/octet-stream" }); }
  async dispose() { this.parts = []; }
}

export class DiskSink {
  constructor(handle) { this.handle = handle; this.stream = null; }
  supportsResume() { return true; }
  async open(keep) {
    this.stream = await this.handle.createWritable({ keepExistingData: !!keep });
  }
  async writeAt(pos, u8) {
    await this.stream.write({ type: "write", position: pos, data: u8 });
  }
  async close() { await this.stream.close(); }
  async dispose() { try { await this.stream?.abort?.(); } catch (e) { /* ignore */ } }
}

export class OpfsSink {
  constructor(name) { this.name = name; this.stream = null; }
  supportsResume() { return true; }
  async open(keep) {
    const dir = await opfsDir();
    this.fh = await dir.getFileHandle(this.name, { create: true });
    this.stream = await this.fh.createWritable({ keepExistingData: !!keep });
  }
  async writeAt(pos, u8) {
    await this.stream.write({ type: "write", position: pos, data: u8 });
  }
  async close() { await this.stream.close(); }
  async toBlob(mime) {
    const f = await this.fh.getFile();
    return new Blob([f], { type: mime || "application/octet-stream" });
  }
  async dispose() {
    try { await this.stream?.abort?.(); } catch (e) { /* ignore */ }
  }
}

export async function makeSink(job, opts = {}) {
  if (opts.handle) return { kind: "disk", sink: new DiskSink(opts.handle) };
  if (opfsSupported()) {
    const name = job.opfsName || opfsNameFor(job.id);
    job.opfsName = name;
    return { kind: "opfs", sink: new OpfsSink(name) };
  }
  return { kind: "blob", sink: new BlobSink() };
}
