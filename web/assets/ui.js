// Generated from web/src/ui.ts by scripts/build-web.ts. Edit that file instead.
import {
  DEFAULT_RELAYS,
  escrowPublicKeyHex,
  normaliseRelayUrl,
  qrSvg,
  extensionSigner,
  forgetUnlocked,
  generateSecretKey,
  hasStoredKey,
  keepConnectionsWarm,
  keepUnlocked,
  loadKey,
  localSigner,
  npubEncode,
  shorten,
  storeKey,
  storedPubkey,
  toPubkeyHex,
  toUnicode,
  unlockedKey,
  waitForExtension
} from "./fmd.js";
import { CONFIG } from "./config.js";
keepConnectionsWarm(4000);
const relaysOf = (urls) => [...new Set(urls.map((u) => normaliseRelayUrl(u)).filter((u) => u !== undefined))];
export const DISCOVERY_RELAYS = relaysOf([...DEFAULT_RELAYS, ...CONFIG.extraRelays ?? []]);
export const ZAP_RECEIPT_RELAYS = relaysOf([...DEFAULT_RELAYS.slice(0, 3), ...CONFIG.extraRelays ?? []]);
export const $ = (s) => document.querySelector(s);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const now = () => Math.floor(Date.now() / 1000);
export const row = (kind, html) => `<div class="obs ${kind}"><span class="mark"></span><span class="what">${html}</span></div>`;
export function ageText(seconds) {
  const days = Math.floor((now() - seconds) / 86400);
  if (days < 1)
    return "today";
  if (days < 30)
    return `${days}d`;
  if (days < 365)
    return `${Math.floor(days / 30)}mo`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, "")}y`;
}
export const sats = (n) => Number(n).toLocaleString("en-US");
export function idnLine(domain) {
  const unicode = toUnicode(domain);
  return unicode === domain ? "" : `<span class="idn">${esc(unicode)}</span>`;
}
const webln = () => window.webln;
export function clockText(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export function invoiceBlock(invoice, { endsAt } = {}) {
  let qr = "";
  try {
    qr = qrSvg(`lightning:${invoice}`.toUpperCase(), { label: "Lightning invoice QR code" });
  } catch {}
  return `<div class="invoice">
      ${qr ? `<div class="invoice-qr">${qr}</div>` : ""}
      <div class="btn-row">
        <button class="btn btn-accent btn-sm" type="button" id="pay-webln" ${webln() ? "" : "hidden"}>Pay with browser wallet</button>
        <a class="btn ${webln() ? "btn-ghost" : "btn-accent"} btn-sm" href="lightning:${esc(invoice)}">Open in wallet app</a>
        <button class="btn btn-ghost btn-sm" type="button" id="copy-invoice">Copy invoice</button>
      </div>
      ${endsAt ? `<p class="hint invoice-left" id="invoice-left">Expires in ${clockText(endsAt - now())}</p>` : ""}
      <p class="hint invoice-out" id="invoice-out"></p>
      <details class="invoice-text"><summary>Show the invoice</summary><div class="nsec" id="invoice">${esc(invoice)}</div></details>
    </div>`;
}
function withdrawInvoice(block, note, ok = false) {
  block.innerHTML = `<p class="hint invoice-gone${ok ? " ok" : " err"}">${note}</p>`;
}
export function markInvoicePaid(root, note) {
  const block = root.querySelector(".invoice");
  if (block)
    withdrawInvoice(block, note, true);
}
export function wireInvoice(root, invoice, { endsAt, onPaid } = {}) {
  root.querySelector("#copy-invoice")?.addEventListener("click", () => copyToClipboard(invoice, "Invoice copied."));
  const block = root.querySelector(".invoice");
  const left = root.querySelector("#invoice-left");
  if (endsAt !== undefined && block && left) {
    const tick = () => {
      if (!left.isConnected) {
        clearInterval(timer);
        return;
      }
      const remaining = endsAt - now();
      if (remaining > 0) {
        left.textContent = `Expires in ${clockText(remaining)}`;
        return;
      }
      clearInterval(timer);
      withdrawInvoice(block, "This invoice expired. Close this and get a new one.");
    };
    const timer = setInterval(tick, 1000);
    tick();
  }
  const button = root.querySelector("#pay-webln");
  const out = root.querySelector("#invoice-out");
  if (!button || !out)
    return;
  if (button.hidden)
    waitForWebln().then((ok) => {
      if (ok && button.isConnected)
        button.hidden = false;
    });
  button.addEventListener("click", async () => {
    const wallet = webln();
    if (!wallet)
      return;
    button.disabled = true;
    out.className = "hint invoice-out";
    out.textContent = "Waiting for your wallet…";
    try {
      await wallet.enable();
      const paid = await wallet.sendPayment(invoice);
      out.className = "hint invoice-out ok";
      out.textContent = paid?.preimage ? "Paid. The board counts it once the receipt is published, usually within seconds." : "Your wallet says it's sent.";
      onPaid?.();
    } catch (err) {
      const why = (err instanceof Error ? err.message : typeof err === "string" ? err : "").trim().replace(/\.+$/, "");
      out.className = "hint invoice-out err";
      out.textContent = `Not paid: ${why || "the wallet declined"}.`;
      button.disabled = false;
    }
  });
}
async function waitForWebln(timeoutMs = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (webln())
      return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !!webln();
}
let toastTimer;
export function toast(message) {
  const el = $("#toast");
  if (!el)
    return;
  el.textContent = message;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 3600);
}
export function copyToClipboard(text, message = "Copied.") {
  navigator.clipboard.writeText(text).then(() => toast(message), () => toast("Select the text and copy it manually."));
}
const MOON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const SUN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4.2"/>
    <path d="M12 2v2.4M12 19.6V22M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2 12h2.4M19.6 12H22
             M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/></svg>`;
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const currentTheme = () => document.documentElement.dataset.theme || (systemDark.matches ? "dark" : "light");
export function initTheme() {
  const btn = $("#theme");
  if (!btn)
    return;
  const paint = () => {
    const dark = currentTheme() === "dark";
    btn.innerHTML = dark ? SUN : MOON;
    btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  };
  btn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("fmd-theme", next);
    } catch (e) {}
    paint();
  });
  systemDark.addEventListener("change", () => {
    if (!document.documentElement.dataset.theme)
      paint();
  });
  paint();
}
export function avatarGradient(pubkey) {
  let h = 0;
  for (let i = 0;i < pubkey.length; i++)
    h = h * 31 + pubkey.charCodeAt(i) >>> 0;
  const hue = 186 + h % 8 * 7;
  return `conic-gradient(from ${h % 360}deg, hsl(${hue} 62% 56%), hsl(${(hue + 40) % 360} 62% 46%), hsl(${hue} 62% 56%))`;
}
export function askDialog(title, bodyHtml, { confirmLabel = "Continue", onConfirm, place } = {}) {
  const dialog = $("#key-dialog");
  dialog.classList.toggle("at-account", place === "account");
  $("#key-title").textContent = title;
  $("#key-body").innerHTML = bodyHtml;
  const go = $("#key-go");
  go.textContent = confirmLabel;
  go.hidden = !onConfirm;
  go.disabled = false;
  go.onclick = onConfirm ? () => onConfirm() : null;
  dialog.showModal();
  return dialog;
}
export function closeDialog() {
  $("#key-dialog")?.close();
  const body = $("#key-body");
  if (body)
    body.innerHTML = "";
}
export function confirmDialog(title, bodyHtml, confirmLabel) {
  return new Promise((resolve) => {
    let done = false;
    const dialog = askDialog(title, bodyHtml, { confirmLabel, onConfirm: () => finish(true) });
    const onClose = () => {
      if (!dialog.open)
        finish(false);
    };
    const finish = (yes) => {
      if (done)
        return;
      done = true;
      dialog.removeEventListener("close", onClose);
      if (yes)
        closeDialog();
      resolve(yes);
    };
    dialog.addEventListener("close", onClose);
  });
}
export function confirmIncompleteRead(what, read) {
  const names = read.unanswered.map((r) => `<code>${esc(r.replace(/^wss:\/\//, ""))}</code>`).join(", ");
  return confirmDialog("Not every relay answered", `
    <p>${read.unanswered.length ? `${names} didn't answer` : "Your relay list couldn't be confirmed"}, so this
      page may not see your newest ${esc(what)}. ${read.answered} relay${read.answered === 1 ? "" : "s"} did.</p>
    <p>Publishing now replaces your ${esc(what)} everywhere with the one built here. Anything saved only
      on a relay that didn't answer would be lost. Waiting a minute and trying again is safer.</p>`, "Publish anyway");
}
export const session = { signer: null, pubkey: null, kind: null };
const listeners = new Set;
export function onSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function announce(restored = false) {
  for (const fn of listeners)
    fn(session.pubkey, restored);
}
const PREFERENCE = "fmd-signer-v1";
function prefer(kind) {
  try {
    if (kind)
      localStorage.setItem(PREFERENCE, kind);
    else
      localStorage.removeItem(PREFERENCE);
  } catch {}
}
function preferred() {
  try {
    return localStorage.getItem(PREFERENCE);
  } catch {
    return null;
  }
}
let generation = 0;
async function adopt(signer, kind, restored = false) {
  const mine = ++generation;
  const pubkey = await signer.getPublicKey();
  if (mine !== generation)
    return;
  session.signer = signer;
  session.pubkey = pubkey;
  session.kind = kind;
  if (kind === "extension") {
    prefer("extension");
    forgetUnlocked();
  } else
    prefer(null);
  const btn = $("#connect");
  if (btn) {
    const short = shorten(npubEncode(session.pubkey), 7);
    btn.innerHTML = `<span class="who-dot" aria-hidden="true"></span><span class="who-npub">${esc(short)}</span>`;
    btn.querySelector(".who-dot").style.background = avatarGradient(session.pubkey);
    btn.classList.add("connected");
    btn.title = "Your account";
    btn.setAttribute("aria-label", `Your account, ${short}`);
  }
  announce(restored);
}
const TAB_SECRETS = "fmd-";
function forgetTabSecrets() {
  forgetUnlocked();
  try {
    for (const name of Object.keys(sessionStorage))
      if (name.startsWith(TAB_SECRETS))
        sessionStorage.removeItem(name);
  } catch {}
}
export function disconnect(everywhere = true) {
  generation++;
  session.signer = null;
  session.pubkey = null;
  session.kind = null;
  forgetTabSecrets();
  prefer(null);
  if (everywhere)
    channel?.postMessage({ type: "disconnect" });
  const btn = $("#connect");
  if (btn) {
    btn.textContent = "Connect";
    btn.classList.remove("connected");
    btn.title = "";
    btn.removeAttribute("aria-label");
  }
  announce();
  toast("Disconnected, in every tab. A key saved in this browser stays encrypted here.");
}
const SITE_ARBITER = toPubkeyHex(String(CONFIG.arbiterPubkey ?? "").trim());
const mayKeep = (secret) => escrowPublicKeyHex(secret) !== SITE_ARBITER;
const channel = (() => {
  try {
    return new BroadcastChannel("fmd-session-v1");
  } catch {
    return null;
  }
})();
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
channel?.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg?.type === "ask" && session.kind === "local") {
    const kept = unlockedKey();
    if (kept && mayKeep(kept))
      channel.postMessage({ type: "key", key: hex(kept) });
  } else if (msg?.type === "disconnect") {
    if (session.pubkey)
      disconnect(false);
    else {
      forgetTabSecrets();
      announce();
    }
  }
});
setInterval(() => {
  if (session.kind === "local")
    unlockedKey();
}, 10 * 60 * 1000);
function askOtherTabs(timeoutMs = 300) {
  const bus = channel;
  if (!bus)
    return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const done = (key) => {
      bus.removeEventListener("message", heard);
      clearTimeout(timer);
      resolve(key);
    };
    const heard = (e) => {
      const msg = e.data;
      if (msg?.type === "key" && typeof msg.key === "string" && /^[0-9a-f]{64}$/.test(msg.key)) {
        done(Uint8Array.from(msg.key.match(/../g).map((h) => parseInt(h, 16))));
      }
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    bus.addEventListener("message", heard);
    bus.postMessage({ type: "ask" });
  });
}
async function restoreSession() {
  const kept = unlockedKey();
  if (kept) {
    await adopt(localSigner(kept), "local", true).catch(() => forgetUnlocked());
    return;
  }
  const stored = storedPubkey();
  if (preferred() !== "extension" && stored) {
    const shared = await askOtherTabs();
    if (shared && !session.pubkey && mayKeep(shared)) {
      keepUnlocked(shared);
      const checked = unlockedKey();
      if (checked && escrowPublicKeyHex(checked) === stored) {
        await adopt(localSigner(checked), "local", true).catch(() => forgetUnlocked());
        return;
      }
      forgetUnlocked();
    }
  }
  if (preferred() !== "extension" || !await waitForExtension(2000) || session.pubkey)
    return;
  await adopt(extensionSigner(), "extension", true).catch(() => prefer(null));
}
let ready = Promise.resolve();
export function sessionReady() {
  return ready;
}
const keepBox = `<label class="check">
     <input type="checkbox" id="keep" checked>
     <span>Keep me connected while I use this site, so other pages and tabs don't ask again. It locks
       when you disconnect, or after 8 hours away from the site.</span>
   </label>`;
export async function openConnect() {
  const extension = await waitForExtension(600);
  const stored = hasStoredKey();
  const extensionButton = `<button class="btn ${extension ? "btn-accent" : "btn-ghost"}" type="button" id="use-ext" ${extension ? "" : "disabled"}>
         Use a Nostr extension
         <span>${extension ? "Alby, nos2x or similar. This page never sees your key." : "None found in this browser. Already on Nostr? Install one such as Alby or nos2x, then reload."}</span>
       </button>`;
  askDialog("Connect", `<p class="key-intro">Your account here is a key: no email, no password, and no company that holds it.
       New here? Create one; it takes a few seconds.</p>
     <div class="key-choice">
       ${extension ? extensionButton : ""}
       ${stored ? `<button class="btn ${extension ? "btn-ghost" : "btn-accent"}" type="button" id="use-stored">
         Unlock my saved key
         <span>Saved in this browser, locked with your passphrase.</span>
       </button>` : ""}
       <button class="btn ${extension || stored ? "btn-ghost" : "btn-accent"}" type="button" id="use-new">
         Create a new account
         <span>Made in this page and saved, encrypted, in this browser. You get a backup code to keep.</span>
       </button>
       ${extension ? "" : extensionButton}
     </div>
     <p>Browsing needs no account. You connect to list, buy, sell or flex.</p>`, { place: "account" });
  $("#use-ext")?.addEventListener("click", async () => {
    closeDialog();
    try {
      await adopt(extensionSigner(), "extension");
    } catch (err) {
      toast(err.message);
    }
  });
  $("#use-stored")?.addEventListener("click", () => {
    closeDialog();
    askDialog("Unlock", `<p>Your key is saved, encrypted, in this browser. The passphrase never leaves this page.</p>
       <input type="password" id="pass" placeholder="Passphrase" autocomplete="current-password">
       ${keepBox}
       <p class="hint" id="pass-hint"></p>`, {
      confirmLabel: "Unlock",
      place: "account",
      onConfirm: async () => {
        try {
          const secret = await loadKey($("#pass").value);
          if ($("#keep").checked && mayKeep(secret))
            keepUnlocked(secret);
          else
            forgetUnlocked();
          closeDialog();
          await adopt(localSigner(secret), "local");
        } catch (err) {
          $("#pass-hint").textContent = err.message;
          $("#pass-hint").className = "hint err";
        }
      }
    });
  });
  $("#use-new")?.addEventListener("click", () => {
    closeDialog();
    createKey();
  });
}
function createKey() {
  const secret = generateSecretKey();
  const signer = localSigner(secret);
  askDialog("Your new account", `<div class="warn">
       <b>Save this backup code before you continue.</b> It is your account's key, and the only copy.
       We can't reset it or recover it: no server holds one. With it you can connect on any device.
     </div>
     <div class="nsec" id="nsec">${esc(signer.backup())}</div>
     <button class="btn btn-ghost btn-sm" type="button" id="copy-nsec">Copy</button>
     <p>Now choose a passphrase. It locks the key in this browser, so you type the passphrase here
        instead of the code each time.</p>
     <input type="password" id="pass" placeholder="Passphrase (8+ characters)" autocomplete="new-password">
     <label class="check">
       <input type="checkbox" id="saved">
       <span>I have saved the backup code above somewhere safe.</span>
     </label>
     <label class="check" id="replace-row" ${hasStoredKey() ? "" : "hidden"}>
       <input type="checkbox" id="replace">
       <span>Replace the key already stored in this browser. It is gone for good unless you
         backed it up.</span>
     </label>
     ${keepBox}
     <p class="hint" id="pass-hint"></p>`, {
    confirmLabel: "Save and connect",
    place: "account",
    onConfirm: async () => {
      const hint = $("#pass-hint");
      if (!$("#saved").checked) {
        hint.textContent = "Confirm you have saved the key first.";
        hint.className = "hint err";
        return;
      }
      const replacing = hasStoredKey();
      if (replacing && !$("#replace").checked) {
        $("#replace-row").hidden = false;
        hint.textContent = "A key is already stored here. Tick the box to replace it, or cancel and unlock it instead.";
        hint.className = "hint err";
        return;
      }
      try {
        await storeKey(secret, $("#pass").value, { replace: replacing });
        if ($("#keep").checked && mayKeep(secret))
          keepUnlocked(secret);
        else
          forgetUnlocked();
        closeDialog();
        await adopt(signer, "local");
        toast("You're connected. Keep your backup code somewhere off this machine.");
      } catch (err) {
        hint.textContent = err.message;
        hint.className = "hint err";
      }
    }
  });
  $("#copy-nsec").addEventListener("click", () => copyToClipboard($("#nsec").textContent, "Copied. Store it somewhere that is not this browser."));
}
function openConnected() {
  if (!session.pubkey)
    return;
  const npub = npubEncode(session.pubkey);
  const held = session.kind === "extension" ? "Signing through your browser extension. This site never sees the key." : unlockedKey() ? "A key saved in this browser, kept unlocked until you disconnect or are away from the site for 8 hours." : "A key saved in this browser, unlocked on this page only.";
  askDialog("Your account", `<p>This is your public key, your address on Nostr. Share it with the other side of a deal so they can
        find you. It holds no secret.</p>
     <div class="nsec" id="my-npub">${esc(npub)}</div>
     <button class="btn btn-ghost btn-sm" type="button" id="copy-npub">Copy</button>
     <p class="muted-line">${esc(held)}</p>`, { confirmLabel: "Disconnect", onConfirm: () => {
    closeDialog();
    disconnect(true);
  }, place: "account" });
  $("#copy-npub").addEventListener("click", () => copyToClipboard(npub));
}
export function initConnect() {
  $("#connect")?.addEventListener("click", () => session.pubkey ? openConnected() : void openConnect());
  ready = restoreSession().catch(() => {});
  const dialog = $("#key-dialog");
  dialog?.addEventListener("close", () => {
    if (!dialog.open)
      $("#key-body").innerHTML = "";
  });
  $("#key-form")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !(e.target instanceof HTMLInputElement))
      return;
    e.preventDefault();
    const go = $("#key-go");
    if (e.target.type !== "checkbox" && !go.hidden && !go.disabled)
      go.click();
  });
}
