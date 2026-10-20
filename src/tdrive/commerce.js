/* KamsClouds commerce UI — license dialog, trial banner, upload gate.
 * Kept separate from app.js so existing drive logic stays untouched.
 */

import { escapeHtml, fmtBytes, fmtDate } from "./util.js";
import {
  keyLooksValid, prettyKey, licenseForAccount, pendingActivationFor,
  checkAccess, driveBytes, applyClaim, applyActivationRequest,
  cacheLicense,
} from "./license.js";

function $(id) { return document.getElementById(id); }

export function currentAccess(ctx) {
  try {
    const v = ctx && ctx.vault;
    if (!v || !v.accountId) return { ok: true, plan: null };
    return checkAccess(v.index, v.drive, v.accountId, v.cfg);
  } catch (e) {
    return { ok: true, plan: null };
  }
}

/* Called before every upload batch. Returns true when allowed. */
export function guardUpload(ctx, newBytes) {
  const v = ctx.vault;
  if (!v || !v.accountId || v.shared) return true; // shares stay as-is
  const access = currentAccess(ctx);
  if (access.ok) return true;
  if (access.reason === "expired") {
    toastSafe("Your plan expired — renew to upload again.");
  } else {
    const cap = (v.cfg && v.cfg.plans && v.cfg.plans.trialMaxBytes) || 100 * 1024 * 1024;
    toastSafe(`Trial limit reached (${fmtBytes(cap)}). Activate KamsClouds to keep uploading.`);
  }
  openLicenseDialog(ctx);
  return false;
}

function toastSafe(msg) {
  try {
    const el = document.createElement("div");
    el.className = "toast err";
    el.textContent = msg;
    const wrap = $("toastsEl");
    if (wrap) { wrap.appendChild(el); setTimeout(() => el.remove(), 4200); return; }
  } catch (e) { /* ignore */ }
  try { alert(msg); } catch (e2) { /* ignore */ }
}

export function planBadgeHtml(ctx) {
  const v = ctx && ctx.vault;
  if (!v || !v.accountId) return "";
  const access = currentAccess(ctx);
  if (access.plan === "lifetime")
    return `<span class="permbadge edit" title="Lifetime license">Lifetime</span>`;
  if (access.plan === "monthly") {
    const d = fmtDate(access.expiresAt);
    return `<span class="permbadge edit" title="Monthly plan — valid until ${escapeHtml(d)}">Monthly · ${escapeHtml(d)}</span>`;
  }
  if (access.reason === "expired")
    return `<button class="permbadge view" data-kc="license" title="Plan expired — tap to renew" style="border:1px solid var(--red);color:var(--red)">Expired — renew</button>`;
  return `<button class="permbadge view" data-kc="license" title="Trial — tap to activate">Trial — activate</button>`;
}

export function licenseBannerHtml(ctx) {
  const v = ctx && ctx.vault;
  if (!v || !v.accountId || v.shared) return "";
  const access = currentAccess(ctx);
  if (access.ok && access.plan !== "trial") return "";
  if (access.reason === "expired") {
    return `<div class="offlinebar" style="background:#fce8e6;color:#a50e0e" data-kc-banner>
      Your KamsClouds plan expired. Uploads are paused — <button data-kc="license" style="text-decoration:underline;font-weight:600;color:inherit">renew now</button>.
    </div>`;
  }
  if (access.plan === "trial") {
    const cap = (v.cfg && v.cfg.plans && v.cfg.plans.trialMaxBytes) || 100 * 1024 * 1024;
    const used = driveBytes(v.drive);
    return `<div class="offlinebar" data-kc-banner>
      Trial: ${escapeHtml(fmtBytes(used))} of ${escapeHtml(fmtBytes(cap))} used.
      <button data-kc="license" style="text-decoration:underline;font-weight:600;color:inherit">Activate KamsClouds</button>
      for unlimited uploads + support.
    </div>`;
  }
  return `<div class="offlinebar" style="background:#fce8e6;color:#a50e0e" data-kc-banner>
    Trial limit reached. <button data-kc="license" style="text-decoration:underline;font-weight:600;color:inherit">Activate to continue uploading</button>.
  </div>`;
}

export function openLicenseDialog(ctx) {
  const v = ctx.vault;
  const cfg = v.cfg;
  const acc = v.account;
  if (!acc) return;
  const access = currentAccess(ctx);
  const lic = licenseForAccount(v.index, v.accountId);
  const pending = pendingActivationFor(v.index, v.accountId);
  const g = (cfg && cfg.gcash) || {};
  const monthlyPrice = Number(g.monthlyPrice) || 99;
  const lifetimePrice = Number(g.lifetimePrice) || 1499;

  const statusRow = lic
    ? `<div class="kv"><span class="k">Plan</span><span class="v">${lic.plan === "lifetime" ? "Lifetime" : "Monthly until " + escapeHtml(fmtDate(lic.expiresAt))}</span></div>
       <div class="kv"><span class="k">Key</span><span class="v" style="font-family:monospace">${escapeHtml(lic.license.key)}</span></div>`
    : access.reason === "expired"
      ? `<div class="autherr">Expired — renew with a new key or GCash payment below.</div>`
      : `<div class="hint">You are on <b>trial</b>. Enter a license key, or pay via GCash and submit the reference number.</div>`;

  const pendingRow = pending
    ? `<div class="rnprev">Pending ${escapeHtml(pending.plan)} request · GCash ref <b>${escapeHtml(pending.ref)}</b> · sent ${escapeHtml(fmtDate(pending.createdAt))}. Waiting for approval — check back later.</div>`
    : "";

  const body = `
    <div class="field"><label>License status — ${escapeHtml(acc.name)}</label>${statusRow}${pendingRow}</div>
    <div class="field"><label for="kcKey">I have a license key</label>
      <div class="linkrow"><input class="input" id="kcKey" placeholder="KAMS-XXXX-XXXX-XXXX" spellcheck="false" autocomplete="off">
      <button class="btn primary" data-kc-act="claim" type="button">Activate</button></div>
      <div class="autherr" id="kcKeyErr"></div>
    </div>
    <div class="navsep"></div>
    <div class="field"><label>Pay with GCash (manual verification)</label>
      <div class="kv"><span class="k">Monthly</span><span class="v">₱${monthlyPrice} / 30 days</span></div>
      <div class="kv"><span class="k">Lifetime</span><span class="v">₱${lifetimePrice} one-time</span></div>
      <div class="rnprev">1. Send payment to GCash <b>${escapeHtml(g.number || "09XX-XXX-XXXX")}</b> (${escapeHtml(g.name || "KAMS CLOUDS")}). 2. Save the reference number. 3. Submit it below — approval is usually within a few hours.</div>
    </div>
    <div class="field"><label>Plan</label>
      <div class="rolegrid">
        <button class="rolecard on" data-kc-plan="monthly" type="button"><span class="rt">Monthly</span><span class="rh">₱${monthlyPrice} · 30 days</span></button>
        <button class="rolecard" data-kc-plan="lifetime" type="button"><span class="rt">Lifetime</span><span class="rh">₱${lifetimePrice} · one-time</span></button>
      </div>
    </div>
    <div class="field"><label for="kcRef">GCash reference number</label>
      <input class="input" id="kcRef" placeholder="e.g. 1234567890123" autocomplete="off">
    </div>
    <div class="field"><label for="kcSender">Your GCash name / number (optional)</label>
      <input class="input" id="kcSender" placeholder="e.g. Juan 09xx..." autocomplete="off">
    </div>
    <div class="autherr" id="kcPayErr"></div>`;

  openKcModal({
    title: "KamsClouds license",
    body,
    buttons: [
      { label: "Submit payment", kind: "primary", act: "pay" },
      { label: "Close", kind: "text", act: "close" },
    ],
    onAction: async (act, modal) => {
      if (act === "claim") {
        const keyEl = modal.querySelector("#kcKey");
        const errEl = modal.querySelector("#kcKeyErr");
        const raw = keyEl ? keyEl.value : "";
        if (!keyLooksValid(raw)) {
          if (errEl) errEl.textContent = "That doesn't look like a KamsClouds key (KAMS-XXXX-XXXX-XXXX).";
          return;
        }
        try {
          const before = modal.querySelector('[data-kc-act="claim"]');
          if (before) before.disabled = true;
          await v.reloadDrive().catch(() => {});
          const lic2 = applyClaim(v, prettyKey(raw), v.accountId, acc.name);
          await v.publishIndex();
          await cacheLicense(v.accountId, { plan: lic2.type, key: lic2.key, at: Date.now() });
          closeKcModal(modal);
          toastSafe("KamsClouds activated. Salamat!");
          if (ctx.render) ctx.render();
          refreshKcChrome(ctx);
        } catch (e) {
          if (before) before.disabled = false;
          if (errEl) errEl.textContent = String((e && e.message) || e);
        }
        return;
      }
      if (act === "pay") {
        const planBtn = modal.querySelector(".rolecard.on");
        const plan = planBtn ? planBtn.getAttribute("data-kc-plan") : "monthly";
        const ref = modal.querySelector("#kcRef") ? modal.querySelector("#kcRef").value : "";
        const sender = modal.querySelector("#kcSender") ? modal.querySelector("#kcSender").value : "";
        const errEl = modal.querySelector("#kcPayErr");
        try {
          const amount = plan === "monthly" ? monthlyPrice : lifetimePrice;
          await v.reloadDrive().catch(() => {});
          applyActivationRequest(v, { accountId: v.accountId, accountName: acc.name, plan, ref, sender, amount });
          await v.publishIndex();
          closeKcModal(modal);
          toastSafe("Payment submitted — we'll approve it shortly.");
          if (ctx.render) ctx.render();
          refreshKcChrome(ctx);
        } catch (e) {
          if (errEl) errEl.textContent = String((e && e.message) || e);
        }
      }
    },
    onMount: (modal) => {
      modal.addEventListener("click", (e) => {
        const card = e.target.closest("[data-kc-plan]");
        if (card) {
          modal.querySelectorAll("[data-kc-plan]").forEach((c) => c.classList.remove("on"));
          card.classList.add("on");
        }
      });
    },
  });
}

/* Banner + badge injection (called after every render + on boot). */
export function refreshKcChrome(ctx) {
  try {
    const bannerHost = $("offlineBanner");
    // Replace/augment: our banner lives right under offlineBanner.
    let el = $("kcLicenseBanner");
    const html = licenseBannerHtml(ctx);
    if (!html) { if (el) el.remove(); }
    else if (el) { el.outerHTML = `<div id="kcLicenseBanner">${html}</div>`; }
    else if (bannerHost && bannerHost.parentNode) {
      const d = document.createElement("div");
      d.id = "kcLicenseBanner";
      d.innerHTML = html;
      bannerHost.parentNode.insertBefore(d, bannerHost.nextSibling);
    }
    // toolbar badge: append plan badge next to sort selector when possible
    const toolbar = $("toolbarEl");
    if (toolbar) {
      let badge = toolbar.querySelector("[data-kc-badge]");
      if (ctx.vault && ctx.vault.accountId && !ctx.vault.shared) {
        if (!badge) {
          badge = document.createElement("span");
          badge.setAttribute("data-kc-badge", "1");
          badge.style.marginLeft = "8px";
          toolbar.appendChild(badge);
        }
        badge.innerHTML = planBadgeHtml(ctx);
      } else if (badge) badge.remove();
    }
  } catch (e) { /* never break render */ }
}

/* Minimal modal helper (mirrors app.js modal style, standalone). */
function openKcModal({ title, body, buttons, onAction, onMount, width }) {
  const root = $("modalRoot");
  if (!root) return;
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = `<div class="modal" style="${width ? `max-width:${width}px` : ""}">
    <h3>${escapeHtml(title)}</h3>
    <div class="mbody">${body}</div>
    <div class="mfoot"></div>
  </div>`;
  const foot = scrim.querySelector(".mfoot");
  (buttons || [{ label: "Close", kind: "text", act: "close" }]).forEach((b) => {
    const btn = document.createElement("button");
    btn.className = "btn " + (b.kind || "text");
    btn.textContent = b.label;
    btn.type = "button";
    btn.onclick = async () => {
      if (b.act === "close") { closeKcModal(scrim); return; }
      try { await onAction(b.act, scrim); } catch (e) { /* handled inside */ }
    };
    foot.appendChild(btn);
  });
  scrim.addEventListener("click", async (e) => {
    if (e.target === scrim) { closeKcModal(scrim); return; }
    const claim = e.target.closest('[data-kc-act="claim"]');
    if (claim) { try { await onAction("claim", scrim); } catch (er) { /* shown inline */ } }
  });
  root.appendChild(scrim);
  if (onMount) try { onMount(scrim); } catch (e) { /* ignore */ }
  return scrim;
}

function closeKcModal(scrim) {
  try {
    const el = scrim && scrim.classList && scrim.classList.contains("scrim") ? scrim : scrim.closest(".scrim");
    if (el) el.remove();
  } catch (e) { /* ignore */ }
}
