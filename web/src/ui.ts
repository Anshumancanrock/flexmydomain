/* Shared page furniture for every page in web/: theme, toast, key dialog,
 * connect flow. Domain rules live in fmd.js, not here.
 */
import {
  DEFAULT_RELAYS,
  extensionSigner,
  generateSecretKey,
  hasStoredKey,
  loadKey,
  localSigner,
  npubEncode,
  shorten,
  storeKey,
  waitForExtension,
} from "./fmd.js";
import type { Signer } from "./fmd.js";
import { CONFIG } from "./config.js";

/* Defaults plus config extras. A sweep can't see events that live only on the
   author's relays, so discoverable events go here too, never instead. */
export const DISCOVERY_RELAYS = [...new Set([...DEFAULT_RELAYS, ...(CONFIG.extraRelays ?? [])])];

/* NIP-57 `relays`. Ours are included so the receipt reaches the board's relay
   without waiting for a mirror. */
export const ZAP_RECEIPT_RELAYS = [...new Set([...DEFAULT_RELAYS.slice(0, 3), ...(CONFIG.extraRelays ?? [])])];

/* No null check. Pages only query their own elements, so a miss is a bug. */
export const $ = <T extends HTMLElement = HTMLElement>(s: string): T => document.querySelector(s) as T;
export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
export const now = (): number => Math.floor(Date.now() / 1000);

export const row = (kind: string, html: string): string =>
  `<div class="obs ${kind}"><span class="mark"></span><span class="what">${html}</span></div>`;

/** Short age of a unix-seconds timestamp. */
export function ageText(seconds: number): string {
  const days = Math.floor((now() - seconds) / 86400);
  if (days < 1) return "today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, "")}y`;
}

export const sats = (n: number | bigint | string): string => Number(n).toLocaleString("en-US");

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string): void {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 3600);
}

export function copyToClipboard(text: string, message = "Copied."): void {
  navigator.clipboard.writeText(text).then(
    () => toast(message),
    () => toast("Select the text and copy it manually."),
  );
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

/* Read the attribute, never a colour. A retuned palette would break a hex check. */
const currentTheme = () =>
  document.documentElement.dataset.theme || (systemDark.matches ? "dark" : "light");

export function initTheme(): void {
  const btn = $("#theme");
  if (!btn) return;
  const paint = () => {
    const dark = currentTheme() === "dark";
    btn.innerHTML = dark ? SUN : MOON;
    btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  };
  btn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("fmd-theme", next); } catch (e) {}
    paint();
  });
  systemDark.addEventListener("change", () => {
    if (!document.documentElement.dataset.theme) paint();
  });
  paint();
}

/* Derived locally, so no avatar service learns who is being viewed. */
export function avatarGradient(pubkey: string): string {
  let h = 0;
  for (let i = 0; i < pubkey.length; i++) h = (h * 31 + pubkey.charCodeAt(i)) >>> 0;
  const hue = 186 + (h % 8) * 7;
  return `conic-gradient(from ${h % 360}deg, hsl(${hue} 62% 56%), hsl(${(hue + 40) % 360} 62% 46%), hsl(${hue} 62% 56%))`;
}

export function askDialog(
  title: string,
  bodyHtml: string,
  { confirmLabel = "Continue", onConfirm }: { confirmLabel?: string; onConfirm?: () => unknown } = {},
): HTMLDialogElement {
  const dialog = $<HTMLDialogElement>("#key-dialog");
  $("#key-title").textContent = title;
  $("#key-body").innerHTML = bodyHtml;
  const go = $<HTMLButtonElement>("#key-go");
  go.textContent = confirmLabel;
  go.hidden = !onConfirm;
  go.onclick = onConfirm ? () => onConfirm() : null;
  dialog.showModal();
  return dialog;
}

export const closeDialog = (): void => $<HTMLDialogElement>("#key-dialog")?.close();

/** Pages only read this. Connect and disconnect write it. */
export const session: { signer: Signer | null; pubkey: string | null } = { signer: null, pubkey: null };

type SessionListener = (pubkey: string | null) => void;
const listeners = new Set<SessionListener>();

export function onSessionChange(fn: SessionListener): () => boolean {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(): void {
  for (const fn of listeners) fn(session.pubkey);
}

async function adopt(signer: Signer): Promise<void> {
  session.signer = signer;
  session.pubkey = await signer.getPublicKey();
  const btn = $("#connect");
  if (btn) {
    btn.textContent = shorten(npubEncode(session.pubkey), 7);
    btn.title = "Disconnect";
  }
  announce();
}

export function disconnect(): void {
  session.signer = null;
  session.pubkey = null;
  const btn = $("#connect");
  if (btn) {
    btn.textContent = "Connect";
    btn.title = "";
  }
  announce();
  toast("Disconnected. Any key stored in this browser is still encrypted here.");
}

/* NIP-07 first, since then the page never touches a key. */
export async function openConnect(): Promise<void> {
  const extension = await waitForExtension(600);
  const stored = hasStoredKey();

  askDialog(
    "Connect a key",
    `<div class="key-choice">
       <button class="btn btn-accent" type="button" id="use-ext" ${extension ? "" : "disabled"}>
         Browser extension
         <span>${extension
           ? "Alby, nos2x or similar. This page never sees your key."
           : "No NIP-07 extension detected in this browser."}</span>
       </button>
       ${stored ? `<button class="btn btn-ghost" type="button" id="use-stored">
         Unlock the key in this browser
         <span>Encrypted here under your passphrase.</span>
       </button>` : ""}
       <button class="btn btn-ghost" type="button" id="use-new">
         Create a key in this page
         <span>Generated locally, encrypted at rest, and yours to back up. Good for trying this out.</span>
       </button>
     </div>
     <p>Browsing and viewing need no key at all.</p>`,
  );

  $("#use-ext")?.addEventListener("click", async () => {
    closeDialog();
    try {
      await adopt(extensionSigner());
    } catch (err) {
      toast((err as Error).message);
    }
  });

  $("#use-stored")?.addEventListener("click", () => {
    closeDialog();
    askDialog(
      "Unlock",
      `<p>Your key is encrypted in this browser. The passphrase never leaves this page.</p>
       <input type="password" id="pass" placeholder="Passphrase" autocomplete="current-password">
       <p class="hint" id="pass-hint"></p>`,
      {
        confirmLabel: "Unlock",
        onConfirm: async () => {
          try {
            const signer = localSigner(await loadKey($<HTMLInputElement>("#pass").value));
            closeDialog();
            await adopt(signer);
          } catch (err) {
            $("#pass-hint").textContent = (err as Error).message;
            $("#pass-hint").className = "hint err";
          }
        },
      },
    );
  });

  $("#use-new")?.addEventListener("click", () => {
    closeDialog();
    createKey();
  });
}

/* Force a backup. Clearing site data wipes localStorage, and there is no reset. */
function createKey(): void {
  const secret = generateSecretKey();
  const signer = localSigner(secret);

  askDialog(
    "Your new key",
    `<div class="warn">
       <b>Write this down before you continue.</b> It is the only copy. We cannot reset it,
       recover it, or tell you what it was: there is no account and no server holding one.
     </div>
     <div class="nsec" id="nsec">${esc(signer.backup())}</div>
     <button class="btn btn-ghost btn-sm" type="button" id="copy-nsec">Copy</button>
     <p>Now choose a passphrase. It encrypts the key in this browser so a script
        that reads your storage does not get a usable key.</p>
     <input type="password" id="pass" placeholder="Passphrase (8+ characters)" autocomplete="new-password">
     <label style="display:flex;gap:8px;font-size:13px;color:var(--muted);align-items:flex-start">
       <input type="checkbox" id="saved" style="width:auto;height:auto;margin-top:3px">
       <span>I have saved the key above somewhere safe.</span>
     </label>
     <p class="hint" id="pass-hint"></p>`,
    {
      confirmLabel: "Save and connect",
      onConfirm: async () => {
        const hint = $("#pass-hint");
        if (!$<HTMLInputElement>("#saved").checked) {
          hint.textContent = "Confirm you have saved the key first.";
          hint.className = "hint err";
          return;
        }
        try {
          await storeKey(secret, $<HTMLInputElement>("#pass").value);
          closeDialog();
          await adopt(signer);
          toast("Key created. Back it up somewhere off this machine.");
        } catch (err) {
          hint.textContent = (err as Error).message;
          hint.className = "hint err";
        }
      },
    },
  );

  $("#copy-nsec").addEventListener("click", () =>
    copyToClipboard($("#nsec").textContent!, "Copied. Store it somewhere that is not this browser."));
}

/** Wire the header button. Call once per page. */
export function initConnect(): void {
  $("#connect")?.addEventListener("click", () => (session.pubkey ? disconnect() : openConnect()));
}
