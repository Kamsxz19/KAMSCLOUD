import { pfetch } from "./platform.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TgError extends Error {
  constructor(kind, message, info) {
    super(message);
    this.name = "TgError";
    this.kind = kind;
    this.info = info || null;
  }
}

function raceTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new TgError("timeout", `${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(t); reject(e); } },
    );
  });
}

export function createTg(cfg) {
  const apiBase = () => String(cfg.apiBase || "https://api.telegram.org").replace(/\/+$/, "");
  const botUrl = (method) => `${apiBase()}/bot${cfg.botToken}/${method}`;
  const fileUrl = (path) => `${apiBase()}/file/bot${cfg.botToken}/${path}`;

  async function raw(method, opts = {}) {
    const { json, form, signal, retries = 4 } = opts;
    const timeoutMs = opts.timeoutMs || (form ? 180000 : 60000);
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal && signal.aborted) throw new TgError("aborted", "Aborted");
      let res;
      try {
        res = await raceTimeout(
          pfetch(cfg, botUrl(method), {
            method: "POST",
            signal,
            ...(form
              ? { body: form }
              : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(json || {}) }),
          }),
          timeoutMs,
          method,
        );
      } catch (e) {
        if (signal && signal.aborted) throw new TgError("aborted", "Aborted");
        const hint = !cfg.corsProxy && typeof window !== "undefined" && !window.root?.superFetch
          ? " (GitHub Pages: api.telegram.org blocks direct calls — set cfg.corsProxy, see docs/DEPLOY-GITHUB.md)"
          : "";
        lastErr = new TgError("network", `Network error on ${method}: ${(e && e.message) || e}${hint}`);
        await sleep(500 * (attempt + 1));
        continue;
      }
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { data = null; }
      if (!data) {
        lastErr = new TgError("proxy", `${method} failed (HTTP ${res.status})`);
        if (attempt < retries) { await sleep(700 * (attempt + 1)); continue; }
        throw lastErr;
      }
      if (data.ok) return data.result;
      const desc = data.description || "Telegram API error";
      lastErr = new TgError("api", desc, data);
      const code = data.error_code;
      const retryAfter = data.parameters && data.parameters.retry_after;
      const throttled = code === 429 || /too many requests/i.test(desc);
      if (throttled && attempt < retries) {
        await sleep(((retryAfter || 3) + 1) * 1000);
        continue;
      }
      if (code >= 500 && attempt < retries) { await sleep(700 * (attempt + 1)); continue; }
      throw lastErr;
    }
    throw lastErr || new TgError("unknown", "Request failed");
  }

  const call = (method, json, opts) => raw(method, { json, ...opts });

  async function sendDocument(chatId, blob, filename, caption, signal) {
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (caption) fd.append("caption", caption);
    fd.append("disable_notification", "true");
    fd.append("disable_content_type_detection", "true");
    fd.append("document", blob, filename);
    return raw("sendDocument", { form: fd, signal, retries: 5 });
  }

  async function sendPhoto(chatId, blob, filename, caption) {
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (caption) fd.append("caption", caption);
    fd.append("disable_notification", "true");
    fd.append("photo", blob, filename);
    return raw("sendPhoto", { form: fd, retries: 2 });
  }

  async function fetchBytes(path, signal) {
    const res = await pfetch(cfg, fileUrl(path), { signal });
    if (!res.ok) throw new TgError("download", `Download failed (HTTP ${res.status})`);
    return await res.arrayBuffer();
  }

  async function fetchText(path, signal) {
    const res = await pfetch(cfg, fileUrl(path), { signal });
    if (!res.ok) throw new TgError("download", `Download failed (HTTP ${res.status})`);
    return await res.text();
  }

  return {
    cfg,
    fileUrl,
    call,
    fetchBytes,
    fetchText,
    sendDocument,
    sendPhoto,
    getMe: () => call("getMe", {}),
    getChat: (chatId) => call("getChat", { chat_id: chatId != null ? chatId : cfg.chatId }),
    getFilePath: (fileId) => call("getFile", { file_id: fileId }).then((r) => r.file_path),
    deleteMessage: (chatId, messageId) => call("deleteMessage", { chat_id: chatId != null ? chatId : cfg.chatId, message_id: messageId }),
    editMessageText: (messageId, text) => call("editMessageText", {
      chat_id: cfg.chatId,
      message_id: messageId,
      text,
      link_preview_options: { is_disabled: true },
    }),
    sendMessage: (text, extra) => call("sendMessage", { chat_id: cfg.chatId, text, disable_notification: true, ...(extra || {}) }),
    pinChatMessage: (messageId) => call("pinChatMessage", { chat_id: cfg.chatId, message_id: messageId, disable_notification: true }),
    unpinChatMessage: (messageId) => call("unpinChatMessage", { chat_id: cfg.chatId, message_id: messageId }),
  };
}
