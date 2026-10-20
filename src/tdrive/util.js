export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + " " + units[i];
}

export function fmtSpeed(bytesPerSec) {
  return fmtBytes(bytesPerSec) + "/s";
}

export function fmtEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "--";
  if (seconds < 60) return Math.ceil(seconds) + "s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return m + "m " + s + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

export function fmtDate(ts) {
  if (!ts) return "--";
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts) + ", " + time;
}

export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}

const KIND_BY_EXT = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "heic", "heif", "avif", "tiff"],
  video: ["mp4", "webm", "mkv", "mov", "avi", "m4v", "3gp", "flv", "wmv", "mpg", "mpeg", "ts"],
  audio: ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus", "wma", "amr"],
  pdf: ["pdf"],
  doc: ["doc", "docx", "odt", "rtf", "pages"],
  sheet: ["xls", "xlsx", "ods", "csv", "tsv", "numbers"],
  slide: ["ppt", "pptx", "odp", "key"],
  archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "apk", "ipa", "dmg", "jar", "tgz"],
  code: ["js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "html", "htm", "css", "scss", "py", "rb", "php", "java", "c", "h", "cpp", "hpp", "cs", "go", "rs", "swift", "kt", "sh", "bash", "zsh", "sql", "yml", "yaml", "toml", "xml", "ini", "conf", "env", "lua", "pl", "r", "dart", "vue", "svelte"],
  text: ["txt", "md", "markdown", "log", "nfo", "srt", "vtt", "sub"],
  font: ["ttf", "otf", "woff", "woff2", "eot"],
  app: ["exe", "msi", "bin", "deb", "rpm", "appimage", "bat", "cmd"],
};

export function fileKind(name, mime) {
  mime = String(mime || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  const e = extOf(name);
  for (const [kind, exts] of Object.entries(KIND_BY_EXT)) if (exts.includes(e)) return kind;
  if (mime.startsWith("text/")) return "text";
  return "file";
}

export function isTextKind(kind) {
  return kind === "text" || kind === "code" || kind === "sheet";
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  wrapped.flush = (...args) => { clearTimeout(t); t = null; fn(...args); };
  wrapped.cancel = () => { clearTimeout(t); t = null; };
  return wrapped;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function pathJoin(...parts) {
  return parts.filter(Boolean).join("/");
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function isMobileLike() {
  const w = Math.min(window.innerWidth || 9999, screen?.width || 9999);
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  return w <= 820 || cores <= 4 || mem <= 4;
}

export function bytesToBase64(u8) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
