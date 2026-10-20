/* KamsClouds support widget — floating chat button + panel for signed-in users.
 * Polls the shared index for admin replies. Kept separate from app.js.
 */

import { escapeHtml, fmtDate } from "./util.js";
import {
  threadFor, unreadUserCount, getReadMap, markThreadRead, applyUserMessage,
} from "./support.js";

function $(id) { return document.getElementById(id); }

let _pollTimer = null;
let _open = false;
let _sending = false;

export function ensureSupportWidget(ctx) {
  try {
    if ($("kcSupportFab")) return;
    const cfg = (ctx && ctx.cfg) || {};
    if (!cfg.support || cfg.support.enabled === false) return;
    const fab = document.createElement("button");
    fab.id = "kcSupportFab";
    fab.className = "kc-fab";
    fab.type = "button";
    fab.title = "Chat with support";
    fab.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg><span class="kc-fab-badge" hidden></span>`;
    fab.onclick = () => toggleSupportPanel(ctx);
    fab.style.display = "none"; // shown after sign-in by updateSupportBadge()
    document.body.appendChild(fab);

    const panel = document.createElement("div");
    panel.id = "kcSupportPanel";
    panel.className = "kc-support";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="kc-sup-head"><span>Customer service</span><button class="iconbtn" data-kc-sup="close" type="button" style="width:30px;height:30px;color:#fff">✕</button></div>
      <div class="kc-sup-body"><div class="hint" style="padding:12px">Loading…</div></div>
      <div class="kc-sup-foot"><input id="kcSupInput" placeholder="Type your message…" maxlength="2000" autocomplete="off"><button class="btn primary" data-kc-sup="send" type="button">Send</button></div>`;
    document.body.appendChild(panel);
    panel.addEventListener("click", (e) => {
      const b = e.target.closest("[data-kc-sup]");
      if (!b) return;
      if (b.getAttribute("data-kc-sup") === "close") toggleSupportPanel(ctx, false);
      if (b.getAttribute("data-kc-sup") === "send") sendSupportMsg(ctx);
    });
    const input = panel.querySelector("#kcSupInput");
    if (input) input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendSupportMsg(ctx); }
    });
    startSupportPoll(ctx);
  } catch (e) { /* never break boot */ }
}

export function toggleSupportPanel(ctx, force) {
  const panel = $("kcSupportPanel");
  if (!panel) return;
  _open = force !== undefined ? !!force : panel.hidden;
  panel.hidden = !_open;
  const fab = $("kcSupportFab");
  if (fab) fab.classList.toggle("open", _open);
  if (_open) {
    renderSupportThread(ctx);
    const input = $("kcSupInput");
    if (input) setTimeout(() => input.focus(), 60);
  }
}

function startSupportPoll(ctx) {
  stopSupportPoll();
  const ms = (ctx.cfg && ctx.cfg.support && ctx.cfg.support.pollMs) || 15000;
  _pollTimer = setInterval(async () => {
    try {
      const v = ctx.vault;
      if (!v || !v.accountId || v.shared) return;
      if (document.hidden) return;
      await v.loadIndex().catch(() => {});
      updateSupportBadge(ctx);
      if (_open) renderSupportThread(ctx, true);
    } catch (e) { /* next tick */ }
  }, Math.max(8000, ms));
}

function stopSupportPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

export async function updateSupportBadge(ctx) {
  try {
    const fab = $("kcSupportFab");
    const panel = $("kcSupportPanel");
    if (!fab) return;
    const v = ctx && ctx.vault;
    // Never show the widget to signed-out users, share guests, or on the
    // share-error screen (it floats above auth/error screens otherwise).
    const shareErrVisible = (() => { const el = $("shareError"); return !!(el && !el.hidden); })();
    const authVisible = (() => { const el = $("authScreen"); return !!(el && !el.hidden); })();
    const allowed = !!(v && v.accountId && !v.shared && !shareErrVisible && !authVisible);
    if (!allowed) {
      fab.style.display = "none";
      if (panel) panel.hidden = true;
      _open = false;
      return;
    }
    fab.style.display = "";
    const map = await getReadMap();
    const n = unreadUserCount(v.index, v.accountId, map[String(v.accountId)]);
    const badge = fab.querySelector(".kc-fab-badge");
    if (badge) {
      badge.hidden = !n;
      badge.textContent = n > 9 ? "9+" : String(n);
    }
  } catch (e) { /* ignore */ }
}

export async function renderSupportThread(ctx, quiet) {
  const panel = $("kcSupportPanel");
  if (!panel || panel.hidden) return;
  const body = panel.querySelector(".kc-sup-body");
  if (!body) return;
  const v = ctx.vault;
  if (!v || !v.accountId) {
    body.innerHTML = `<div class="hint" style="padding:12px">Sign in to chat with support.</div>`;
    return;
  }
  const msgs = threadFor(v.index, v.accountId);
  if (!msgs.length) {
    body.innerHTML = `<div class="hint" style="padding:14px">Hi ${escapeHtml(v.account ? v.account.name : "there")}! 👋<br>Message us here — we usually reply within a few hours.<br><br>Please don't send passwords.</div>`;
  } else {
    body.innerHTML = msgs.slice(-80).map((m) => `
      <div class="kc-msg ${m.from === "admin" ? "admin" : "user"}">
        <div class="kc-bubble">${escapeHtml(m.text)}</div>
        <div class="kc-meta">${m.from === "admin" ? "Support" : "You"} · ${escapeHtml(fmtDate(m.at))}</div>
      </div>`).join("");
    body.scrollTop = body.scrollHeight;
    const last = msgs[msgs.length - 1];
    if (last && last.from === "admin") markThreadRead(v.accountId, last.at);
    updateSupportBadge(ctx);
  }
  if (!quiet) { body.scrollTop = body.scrollHeight; }
}

async function sendSupportMsg(ctx) {
  if (_sending) return;
  const input = $("kcSupInput");
  const v = ctx.vault;
  if (!input || !v || !v.accountId) return;
  const text = input.value.trim();
  if (!text) return;
  _sending = true;
  try {
    input.disabled = true;
    await v.loadIndex().catch(() => {});
    applyUserMessage(v, v.accountId, v.account ? v.account.name : "", text);
    await v.publishIndex();
    input.value = "";
    renderSupportThread(ctx);
  } catch (e) {
    try {
      const body = document.querySelector("#kcSupportPanel .kc-sup-body");
      if (body) body.insertAdjacentHTML("beforeend", `<div class="autherr" style="padding:8px 12px">${escapeHtml(String((e && e.message) || e))}</div>`);
    } catch (e2) { /* ignore */ }
  } finally {
    _sending = false;
    if (input) input.disabled = false;
    if (input) input.focus();
  }
}
