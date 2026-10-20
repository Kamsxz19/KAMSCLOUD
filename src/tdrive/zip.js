const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, seed = 0) {
  let c = (~seed) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function dosDateTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function u16(arr, n) { arr.push(n & 0xff, (n >>> 8) & 0xff); }
function u32(arr, n) { arr.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff); }
function u64(arr, n) {
  const lo = n >>> 0;
  const hi = Math.floor(Number(n) / 0x100000000) >>> 0;
  u32(arr, lo); u32(arr, hi);
}

const MAX32 = 0xffffffff;

export const DEFLATE_SUPPORTED = (() => {
  try {
    const cs = new CompressionStream("deflate-raw");
    return !!cs && typeof cs.writable === "object";
  } catch (e) {
    return false;
  }
})();

const STORED_KINDS = ["image", "video", "audio", "archive", "pdf", "font", "app"];

export function shouldCompress(kind, size) {
  if (!DEFLATE_SUPPORTED) return false;
  if (size > 512 * 1024 * 1024) return false;
  return !STORED_KINDS.includes(kind);
}

/**
 * Streaming ZIP writer. Writes sequentially to `write(bytes)`; uses data
 * descriptors so no seeking is required. Emits central-directory / EOCD records
 * with ZIP64 extras when any value overflows 32 bits.
 */
export class ZipWriter {
  constructor(write, opts = {}) {
    this.write = write;
    this.offset = 0;
    this.entries = [];
    this.onBytes = opts.onBytes || null;
    this.forceZip64 = !!opts.zip64;
  }

  async _emit(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.length) {
      await this.write(u8);
      this.offset += u8.length;
      if (this.onBytes) this.onBytes(u8.length);
    }
  }

  /**
   * read: async (onChunk) => void  — calls onChunk(Uint8Array) sequentially.
   */
  async addFile(name, { read, compress = false, kind = "file", modifiedAt = 0 }) {
    const nameBytes = enc.encode(name);
    const useDeflate = compress && DEFLATE_SUPPORTED;
    const method = useDeflate ? 8 : 0;
    const flags = 0x0808;
    const { time, date } = dosDateTime(modifiedAt);
    const localOffset = this.offset;

    const header = [];
    u32(header, 0x04034b50);
    u16(header, 45);
    u16(header, flags);
    u16(header, method);
    u16(header, time);
    u16(header, date);
    u32(header, 0);
    u32(header, 0);
    u32(header, 0);
    u16(header, nameBytes.length);
    u16(header, 0);
    await this._emit(header);
    await this._emit(nameBytes);

    let size = 0;
    let csize = 0;
    let crc = 0;

    const sink = async (bytes) => { csize += bytes.length; await this._emit(bytes); };

    if (useDeflate) {
      const cs = new CompressionStream("deflate-raw");
      const writer = cs.writable.getWriter();
      const reader = cs.readable.getReader();
      const pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await sink(value);
        }
      })();
      await read(async (chunk) => {
        const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        crc = crc32(u8, crc);
        size += u8.length;
        await writer.write(u8);
      });
      await writer.close();
      await pump;
    } else {
      await read(async (chunk) => {
        const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        crc = crc32(u8, crc);
        size += u8.length;
        await sink(u8);
      });
    }

    const desc = [];
    u32(desc, 0x08074b50);
    u32(desc, crc);
    if (csize > MAX32 || size > MAX32) {
      u64(desc, csize);
      u64(desc, size);
    } else {
      u32(desc, csize);
      u32(desc, size);
    }
    await this._emit(desc);

    this.entries.push({ name, nameBytes, method, flags, time, date, crc, size, csize, localOffset });
    return { size, csize, crc };
  }

  async finish() {
    const cdStart = this.offset;
    let total = 0;

    for (const e of this.entries) {
      const needZip64 = this.forceZip64 || e.size > MAX32 || e.csize > MAX32 || e.localOffset > MAX32;
      const extra = [];
      if (needZip64) {
        u16(extra, 0x0001);
        u16(extra, 24);
        u64(extra, e.size);
        u64(extra, e.csize);
        u64(extra, e.localOffset);
      }
      const h = [];
      u32(h, 0x02014b50);
      u16(h, needZip64 ? 45 : 20);
      u16(h, needZip64 ? 45 : 20);
      u16(h, e.flags);
      u16(h, e.method);
      u16(h, e.time);
      u16(h, e.date);
      u32(h, e.crc);
      u32(h, needZip64 ? MAX32 : Math.min(e.csize, MAX32));
      u32(h, needZip64 ? MAX32 : Math.min(e.size, MAX32));
      u16(h, e.nameBytes.length);
      u16(h, extra.length);
      u16(h, 0);
      u16(h, 0);
      u16(h, 0);
      u32(h, 0);
      u32(h, needZip64 ? MAX32 : e.localOffset);
      await this._emit(h);
      await this._emit(e.nameBytes);
      if (extra.length) await this._emit(extra);
      total++;
    }

    const cdSize = this.offset - cdStart;
    const needZip64 = this.forceZip64 || cdStart > MAX32 || cdSize > MAX32 || total > 0xffff;

    if (needZip64) {
      const z = [];
      u32(z, 0x06064b50);
      u64(z, 44);
      u16(z, 45);
      u16(z, 45);
      u32(z, 0);
      u32(z, 0);
      u64(z, total);
      u64(z, total);
      u64(z, cdSize);
      u64(z, cdStart);
      await this._emit(z);

      const loc = [];
      u32(loc, 0x07064b50);
      u32(loc, 0);
      u64(loc, this.offset - 56);
      u32(loc, 1);
      await this._emit(loc);
    }

    const eocd = [];
    u32(eocd, 0x06054b50);
    u16(eocd, 0);
    u16(eocd, 0);
    u16(eocd, needZip64 ? 0xffff : total);
    u16(eocd, needZip64 ? 0xffff : total);
    u32(eocd, needZip64 ? MAX32 : cdSize);
    u32(eocd, needZip64 ? MAX32 : cdStart);
    u16(eocd, 0);
    await this._emit(eocd);

    return { entries: total, size: this.offset };
  }
}

export function zipNameFor(name) {
  const base = String(name || "files").replace(/[\\/:*?"<>|]+/g, "_").trim() || "files";
  return /\.zip$/i.test(base) ? base : base + ".zip";
}
