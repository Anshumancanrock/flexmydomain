// Generated from web/src/board.ts by scripts/build-web.ts. Edit that file instead.
import {
  INVOICE_OFFER_SECONDS,
  MSATS_PER_SAT,
  addressOf,
  applyDeletions,
  buildZapRequest,
  checkDomainProof,
  checkListing,
  deletionFilter,
  fetchLnurlPay,
  lightningAddressUrl,
  flexZapFilter,
  invoiceOfferEnds,
  listingFilter,
  newestPerAddress,
  npubEncode,
  parseListing,
  queryDiscovery,
  queryRelays,
  rankFlexDomains,
  requestZapInvoice,
  tldOf,
  tryNormaliseDomain,
  verifyZapReceipt,
  zapperKeyFor
} from "./fmd.js";
import { CONFIG, featuringEnabled } from "./config.js";
import {
  $,
  DISCOVERY_RELAYS,
  ZAP_RECEIPT_RELAYS,
  ageText,
  askDialog,
  clockText,
  esc,
  initConnect,
  initTheme,
  invoiceBlock,
  markInvoicePaid,
  now,
  onSessionChange,
  openConnect,
  sats,
  session,
  toast,
  wireInvoice
} from "./ui.js";
const PER_PAGE = 15;
const WEEK = 7 * 86400;
const state = {
  rows: [],
  loading: true,
  search: "",
  tld: null,
  sort: "rank",
  page: 1,
  range: "week",
  amount: null,
  recent: [],
  missing: [],
  answered: 0,
  unknown: null,
  flexed: null
};
const uncertain = () => state.loading || state.unknown !== null || state.missing.length > 0;
async function load() {
  state.loading = true;
  render();
  const unknownBecause = (reason) => {
    state.unknown = reason;
    state.missing = [];
    state.answered = 0;
    state.rows = [];
    state.loading = false;
    render();
  };
  if (!featuringEnabled()) {
    unknownBecause(null);
    return;
  }
  const address = CONFIG.featuredLightningAddress.trim();
  if (!/^https?:\/\//i.test(address) && !lightningAddressUrl(address)) {
    unknownBecause("This site's lightning address isn't a valid one, so no payment can be counted.");
    return;
  }
  const recipient = CONFIG.featuredRecipientPubkey.trim().toLowerCase();
  let provider = await zapperKeyFor(CONFIG.featuredLightningAddress).catch(() => {
    return;
  });
  if (!provider) {
    const lnurl = await fetchLnurlPay(CONFIG.featuredLightningAddress).catch((err) => ({ ok: false, reason: err.message }));
    if (lnurl.ok && lnurl.info.allowsNostr && lnurl.info.nostrPubkey) {
      provider = lnurl.info.nostrPubkey;
    } else {
      unknownBecause(lnurl.ok ? "This site's lightning address doesn't support zaps, so no payment can be counted." : "The lightning provider didn't answer, so payments can't be counted. Reload in a minute.");
      return;
    }
  }
  const windowSeconds = state.range === "all" ? undefined : WEEK;
  const finished = new Set;
  const receipts = await queryDiscovery(DISCOVERY_RELAYS, [{ ...flexZapFilter(recipient, windowSeconds ? now() - windowSeconds : undefined), authors: [provider] }], { timeoutMs: 6000, onRelayDone: (relay, _count, _error, complete) => {
    if (complete)
      finished.add(relay);
  } }).catch(() => []);
  state.unknown = null;
  state.answered = finished.size;
  state.missing = ZAP_RECEIPT_RELAYS.filter((r) => !finished.has(r));
  const verified = [];
  for (const receipt of receipts) {
    const result = verifyZapReceipt({ receipt, recipient, expectedProvider: provider });
    if (result.ok && result.zap.flexDomain)
      verified.push(result.zap);
  }
  state.rows = rankFlexDomains(verified, {
    now: now(),
    windowSeconds: state.range === "all" ? 100 * 365 * 86400 : WEEK
  }).map((r) => ({ ...r, listing: null }));
  state.recent = verified.sort((a, b) => b.at - a.at).slice(0, 6);
  state.loading = false;
  render();
  settlePending(verified);
  linkListings();
}
async function linkListings() {
  if (state.rows.length === 0)
    return;
  const events = await queryDiscovery(DISCOVERY_RELAYS, [listingFilter({ limit: 500 })], { timeoutMs: 6000 }).catch(() => []);
  const current = newestPerAddress(events);
  const authors = [...new Set(current.map((e) => e.pubkey))];
  const deletions = authors.length ? await queryRelays(DISCOVERY_RELAYS, [deletionFilter(authors)], { timeoutMs: 4000 }).catch(() => []) : [];
  const wanted = new Set(state.rows.map((r) => r.domain));
  await Promise.all(applyDeletions(current, deletions).map(async (event) => {
    const parsed = parseListing(event);
    if (!parsed.ok || parsed.listing.status === "sold" || !wanted.has(parsed.listing.domain))
      return;
    const dns = await checkDomainProof({
      domain: parsed.listing.domain,
      pubkey: event.pubkey,
      dnsOnly: true
    }).catch(() => null);
    const check = checkListing({ event, dnsProof: dns?.dns, now: now() });
    if (!check.ok)
      return;
    const row = state.rows.find((r) => r.domain === parsed.listing.domain);
    if (row) {
      row.listing = parsed.listing;
      row.address = addressOf(event);
      render();
    }
  }));
}
const board = () => state.rows.map((row, i) => ({ ...row, rank: i + 1 }));
function visible() {
  let rows = board();
  if (state.tld)
    rows = rows.filter((r) => tldOf(r.domain) === state.tld);
  if (state.search) {
    const q = state.search;
    rows = rows.filter((r) => r.domain.includes(q) || (r.listing?.summary ?? "").toLowerCase().includes(q));
  }
  const by = {
    rank: (a, b) => a.rank - b.rank,
    "price-desc": (a, b) => (b.listing?.priceSats ?? -1) - (a.listing?.priceSats ?? -1),
    "price-asc": (a, b) => (a.listing?.priceSats ?? 1 / 0) - (b.listing?.priceSats ?? 1 / 0),
    newest: (a, b) => b.last - a.last,
    az: (a, b) => a.domain.localeCompare(b.domain)
  };
  return [...rows].sort(by[state.sort] ?? by.rank);
}
const CROWN = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M2.9 7.9 7.5 12.4 12 4.9l4.5 7.5 4.6-4.5-1.7 9.8H4.6L2.9 7.9Z"/>
    <rect x="4.7" y="19.2" width="14.6" height="2.6" rx="1.3"/>
    <circle cx="2.9" cy="6.4" r="1.75"/><circle cx="21.1" cy="6.4" r="1.75"/>
    <circle cx="12" cy="3.6" r="1.85"/></svg>`;
const STAR = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"
    stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 4.2 14.12 9.69 19.99 10 15.42 13.71 16.94 19.4 12 16.2
             7.06 19.4 8.58 13.71 4.01 10 9.88 9.69Z"/></svg>`;
const GEM = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"
    stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
    <path d="M7.7 4.3h8.6l3.9 5.9L12 20.5 3.8 10.2 7.7 4.3Z"/></svg>`;
const GLYPH = { 1: CROWN, 2: STAR, 3: GEM };
const ORDINAL = { 1: "1<i>st</i>", 2: "2<i>nd</i>", 3: "3<i>rd</i>" };
const badge = (r) => `<span class="badge">${GLYPH[r]}</span>
       <span class="rank-no">${ORDINAL[r]}</span>`;
const TREND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6 18 18 6M9.5 6H18v8.5"/></svg>`;
const ARROW = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5 12h13M12.5 5.5 19 12l-6.5 6.5"/></svg>`;
const tileOf = (d) => {
  let h = 0;
  for (let i = 0;i < d.length; i++)
    h = h * 31 + d.charCodeAt(i) >>> 0;
  return { h: 186 + h % 8 * 7, l: 52 + (h >>> 3) % 3 * 5 };
};
const agoText = (ts) => {
  const age = ageText(ts);
  return age === "today" ? age : `${age} ago`;
};
const shortNpub = (pubkey) => {
  const npub = npubEncode(pubkey);
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
};
const splitName = (d) => {
  const i = d.lastIndexOf(".");
  return [d.slice(0, i), d.slice(i)];
};
const PODIUM = [{ rank: 2, cls: "r2" }, { rank: 1, cls: "r1" }, { rank: 3, cls: "r3" }];
function renderPodium() {
  const top = board().slice(0, 3);
  $("#podium").innerHTML = PODIUM.map(({ rank, cls }) => {
    const row = top[rank - 1];
    if (!row) {
      return `<article class="card-rank ${cls}">
        ${badge(rank)}
        <span class="name">unclaimed</span>
        <span class="tag">this floor is open</span>
        <span class="bid">&mdash;</span>
        <span class="clicks">nobody has paid for it</span>
        <a class="btn btn-ghost view" href="#claim">Take it ${ARROW}</a>
      </article>`;
    }
    const [stem, t] = splitName(row.domain);
    return `<article class="card-rank ${cls}${row.domain === state.flexed ? " fresh" : ""}" data-domain="${esc(row.domain)}">
      ${badge(rank)}
      <span class="name">${esc(stem)}<span class="tld">${esc(t)}</span></span>
      <span class="tag">${row.listing ? esc(row.listing.summary || "For sale on the market") : `${row.zaps} payment${row.zaps === 1 ? "" : "s"}`}</span>
      <span class="bid">${sats(row.sats)} sats</span>
      <span class="clicks">${row.payers.length} backer${row.payers.length === 1 ? "" : "s"}</span>
      <a class="btn ${rank === 1 ? "btn-solid" : "btn-ghost"} view"
         href="https://${esc(row.domain)}" target="_blank" rel="noopener">Visit ${ARROW}</a>
    </article>`;
  }).join("");
}
function renderRows(rows) {
  const filtered = state.search || state.tld;
  const body = filtered ? rows : rows.slice(PODIUM.length);
  const pages = Math.max(1, Math.ceil(body.length / PER_PAGE));
  if (state.page > pages)
    state.page = pages;
  const start = (state.page - 1) * PER_PAGE;
  const page = body.slice(start, start + PER_PAGE);
  $("#rows").innerHTML = page.length === 0 ? `<li class="empty">${state.loading ? "Asking the relays…" : state.unknown ? esc(state.unknown) : state.rows.length === 0 && state.answered === 0 && featuringEnabled() ? "The relays didn't answer, so the board can't be shown. Reload in a minute." : state.rows.length === 0 && state.missing.length ? "No flexes were found, but not every relay answered, so there may be some. Reload in a minute." : state.rows.length === 0 ? "Nobody has flexed a domain yet. Type one above and take #1." : filtered ? "Nothing matches that filter." : "Only the podium so far. Flex a domain to take the next spot."}</li>` : page.map((row) => {
    const [stem, t] = splitName(row.domain);
    const tile = tileOf(row.domain);
    const rank = row.rank;
    const metal = rank <= 3 ? ` r${rank} metal` : "";
    return `<li class="row${rank === 1 ? " row-top" : ""}${row.domain === state.flexed ? " fresh" : ""}" data-domain="${esc(row.domain)}">
          <span class="r-rank${metal}">#${rank}</span>
          <span class="r-av" style="--h:${tile.h};--l:${tile.l}" aria-hidden="true">${esc((stem[0] ?? "?").toUpperCase())}</span>
          <div class="r-body">
            <p class="r-title">${esc(stem)}<span class="tld">${esc(t)}</span></p>
            <p class="r-desc">${row.listing ? esc(row.listing.summary || "Listed for sale") : `${row.zaps} payment${row.zaps === 1 ? "" : "s"} from ${row.payers.length} backer${row.payers.length === 1 ? "" : "s"}`}</p>
            <p class="r-meta">
              <span class="r-cat">${esc(t)}</span>
              <span>${agoText(row.last)}</span>
              ${row.listing ? `<a href="/market">for sale &middot; ${sats(row.listing.priceSats)} sats</a>` : ""}
              <a href="https://${esc(row.domain)}" target="_blank" rel="noopener">visit</a>
            </p>
          </div>
          <span class="r-bid">${sats(row.sats)} sats</span>
        </li>`;
  }).join("");
  renderPager(pages);
}
function renderPager(pages) {
  const el = $("#pager");
  if (pages <= 1) {
    el.innerHTML = "";
    return;
  }
  const cur = state.page;
  const want = new Set([1, pages, cur, cur - 1, cur + 1]);
  const numbers = [...want].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const parts = [
    `<button class="pg" type="button" data-page="${cur - 1}"${cur === 1 ? " disabled" : ""}>&larr; Previous</button>`
  ];
  let previous = 0;
  for (const n of numbers) {
    if (n - previous > 1)
      parts.push(`<span class="pg gap" aria-hidden="true">&hellip;</span>`);
    parts.push(`<button class="pg" type="button" data-page="${n}"${n === cur ? ' aria-current="page"' : ""}>${n}</button>`);
    previous = n;
  }
  parts.push(`<button class="pg" type="button" data-page="${cur + 1}"${cur === pages ? " disabled" : ""}>Next &rarr;</button>`);
  el.innerHTML = parts.join("");
}
function renderChips() {
  const counts = new Map;
  for (const row of state.rows) {
    const tld = tldOf(row.domain);
    counts.set(tld, (counts.get(tld) ?? 0) + 1);
  }
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  $("#chips").innerHTML = chips.length ? `<button class="chip" type="button" data-tld="" aria-pressed="${!state.tld}">All</button>` + chips.map(([tld, n]) => `<button class="chip" type="button" data-tld="${esc(tld)}" aria-pressed="${state.tld === tld}">.${esc(tld)} ${n}</button>`).join("") : "";
}
function renderSide(rows) {
  const total = rows.reduce((s, r) => s + r.sats, 0);
  const tlds = new Set(rows.map((r) => tldOf(r.domain)));
  $("#s-total").textContent = `${sats(total)} sats`;
  $("#s-count").textContent = sats(rows.length);
  $("#s-tld").textContent = String(tlds.size);
  $("#feed").innerHTML = state.recent.length ? state.recent.map((zap, i) => {
    const domain = zap.flexDomain ?? "a domain";
    return `<li>
           <span class="act-i ${i < 3 ? "act-up" : "act-bid"}">${TREND}</span>
           <span class="act-body">
             <b>${esc(domain)}</b>
             <span>zapped by ${esc(shortNpub(zap.sender))}</span>
           </span>
           <span class="act-figs"><b>${sats(zap.amountSats)}</b><span>${agoText(zap.at)}</span></span>
         </li>`;
  }).join("") : `<li><span class="act-body"><span>${!featuringEnabled() ? "Nothing yet. Flex payments are not switched on for this site." : !state.loading && uncertain() ? "Payments can't all be counted right now." : state.range === "all" ? "No zaps yet." : "No zaps in the last week."}</span></span></li>`;
}
function render() {
  const rows = visible();
  const all = state.rows;
  $("#count").textContent = state.loading ? "asking the relays…" : !featuringEnabled() ? "flex payments are not switched on yet" : `${all.length} domain${all.length === 1 ? "" : "s"} on the board` + (state.unknown ? " · payments can't be counted right now" : state.missing.length ? " · not every relay answered, so payments may be missing" : "");
  renderPodium();
  renderChips();
  renderRows(rows);
  renderSide(all);
  paintClaim();
}
const MIN_FLEX_SATS = 1000;
function costOfRank(r) {
  const list = board();
  const rank = Math.max(1, r);
  return rank > list.length ? MIN_FLEX_SATS : Math.max(MIN_FLEX_SATS, list[rank - 1].sats + 1);
}
function rankFor(amount) {
  const list = board();
  let i = 0;
  while (i < list.length && list[i].sats >= amount)
    i++;
  return i + 1;
}
const STEPS = [1000, 2000, 5000, 1e4, 20000, 50000, 1e5, 200000, 500000, 1e6, 2000000, 5000000, 1e7];
const claimAmount = () => Math.max(MIN_FLEX_SATS, state.amount ?? costOfRank(1));
function stepAmount(up) {
  const now_ = claimAmount();
  state.amount = up ? STEPS.find((s) => s > now_) ?? now_ * 2 : Math.max(MIN_FLEX_SATS, [...STEPS].reverse().find((s) => s < now_) ?? MIN_FLEX_SATS);
  paintClaim();
}
const PRICE_KEY = "fmd-btc-usd-v1";
let usdPerBtc;
async function loadPrice() {
  try {
    const kept = JSON.parse(localStorage.getItem(PRICE_KEY) ?? "null");
    if (kept && typeof kept.usd === "number" && kept.usd > 0 && Date.now() - (kept.at ?? 0) < 10 * 60000) {
      usdPerBtc = kept.usd;
      paintClaim();
      return;
    }
  } catch {}
  try {
    const res = await fetch("https://mempool.space/api/v1/prices", { signal: AbortSignal.timeout(6000) });
    const usd = Number((await res.json()).USD);
    if (!Number.isFinite(usd) || usd <= 0)
      return;
    usdPerBtc = usd;
    try {
      localStorage.setItem(PRICE_KEY, JSON.stringify({ usd, at: Date.now() }));
    } catch {}
    paintClaim();
  } catch {}
}
function usdText(satsAmount) {
  if (!usdPerBtc)
    return;
  const v = satsAmount * usdPerBtc / 1e8;
  const cents = v < 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0
  }).format(v);
}
function paintClaim() {
  const amount = claimAmount();
  const sure = !state.loading && !uncertain();
  $("#c-rank").textContent = `#${rankFor(amount)}${sure ? "" : "?"}`;
  const usd = usdText(amount);
  $("#c-amount").textContent = usd ?? `${sats(amount)} sats`;
  $("#c-sats").textContent = usd ? `⚡ ${sats(amount)} sats` : "";
}
function failHint(message) {
  const el = $("#hint");
  el.className = "hint err";
  el.textContent = message;
}
async function flexIt(event) {
  event.preventDefault();
  const hint = $("#hint");
  const raw = $("#domain").value;
  if (!raw.trim())
    return failHint("Enter a domain to flex.");
  const normalised = tryNormaliseDomain(raw);
  if (!normalised.ok) {
    return failHint(`"${raw.trim()}" isn't a registrable domain: ${normalised.reason}.`);
  }
  if (!featuringEnabled()) {
    return failHint("Flex payments are not switched on for this site yet, so there is nothing to pay. Browse the market meanwhile.");
  }
  if (!session.pubkey) {
    hint.className = "hint";
    hint.textContent = "Connect first, or create an account: it signs the payment as yours.";
    openConnect();
    return;
  }
  const domain = normalised.domain;
  const amount = claimAmount();
  hint.className = "hint";
  hint.innerHTML = `Getting an invoice for <b>${esc(domain)}</b>…`;
  try {
    const lnurl = await fetchLnurlPay(CONFIG.featuredLightningAddress);
    if (!lnurl.ok)
      return failHint(`The lightning address did not answer: ${lnurl.reason}.`);
    if (!lnurl.info.allowsNostr) {
      return failHint("That address does not support zaps, so no receipt would be written and the board could never count this.");
    }
    const amountMsats = amount * MSATS_PER_SAT;
    const zapRequest = await session.signer.signEvent(buildZapRequest({
      pubkey: session.pubkey,
      recipient: CONFIG.featuredRecipientPubkey.trim().toLowerCase(),
      amountMsats,
      relays: ZAP_RECEIPT_RELAYS,
      flexDomain: domain,
      lnurl: lnurl.url,
      createdAt: now()
    }));
    const invoice = await requestZapInvoice({ info: lnurl.info, amountMsats, zapRequest, lnurl: lnurl.url });
    if (!invoice.ok)
      return failHint(`The provider refused: ${invoice.reason}.`);
    const pending = {
      pubkey: zapRequest.pubkey,
      domain,
      amountSats: amount,
      invoice: invoice.invoice,
      requestId: zapRequest.id,
      endsAt: invoiceOfferEnds(invoice.invoice, now())
    };
    keepPending(pending);
    hint.className = "hint";
    hint.textContent = "";
    renderPending();
    showInvoice(pending);
  } catch (err) {
    failHint(err.message);
  }
}
function showInvoice(p) {
  const { domain, amountSats: amount, invoice } = p;
  askDialog(`Flex ${domain}`, `<p><b>${sats(amount)} sats</b>${usdText(amount) ? ` (about ${usdText(amount)})` : ""} puts <b>${esc(domain)}</b> at <b>#${rankFor(amount)}</b>.
        Pay in any wallet. We never touch the payment.</p>` + (uncertain() ? `<p class="hint err" style="text-align:left"><strong>${state.loading ? "The board is still loading" : state.unknown ? "The board was read while payments couldn't be counted" : "Not every relay answered"}</strong>, so the board may be missing payments, and this may land lower
           than #${rankFor(amount)}. ${state.loading ? "Wait for it before paying." : "Reload the page before paying to be sure."}</p>` : "") + invoiceBlock(invoice, { endsAt: p.endsAt }) + `<p class="hint" style="text-align:left">The board updates when your provider publishes the
        receipt, usually within seconds. Being on this board says only that somebody paid; it is
        not a claim of ownership. To say you own it, prove it on the <a href="/market">market</a>.</p>`);
  shownInvoice = p.requestId;
  wireInvoice($("#key-body"), invoice, {
    endsAt: p.endsAt,
    onPaid: () => {
      const now_ = pendingFlex();
      if (now_?.requestId === p.requestId)
        keepPending({ ...now_, paid: true });
      renderPending();
      checkPending();
    }
  });
}
const PENDING_KEY = "fmd-flex-invoice-v1";
const isHex64 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
function pendingFlex() {
  let p = null;
  try {
    p = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");
  } catch {
    p = null;
  }
  if (!p)
    return;
  const usable = isHex64(p.pubkey) && isHex64(p.requestId) && typeof p.domain === "string" && tryNormaliseDomain(p.domain).ok && Number.isSafeInteger(p.amountSats) && p.amountSats > 0 && typeof p.invoice === "string" && /^ln/i.test(p.invoice) && Number.isSafeInteger(p.endsAt);
  if (!usable || p.endsAt <= now()) {
    forgetPending();
    return;
  }
  return p;
}
function keepPending(p) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {}
}
function forgetPending() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {}
}
let shownInvoice;
function renderPending() {
  const line = document.querySelector("#pending");
  if (!line)
    return;
  const p = pendingFlex();
  if (!p || p.pubkey !== session.pubkey) {
    line.hidden = true;
    line.innerHTML = "";
    return;
  }
  line.hidden = false;
  line.innerHTML = p.paid ? `Paid for <b>${esc(p.domain)}</b>. It shows on the board as soon as the receipt lands.` : `Your invoice for <b>${esc(p.domain)}</b> (${sats(p.amountSats)} sats) is waiting to be paid.
    <span id="pending-left">Expires in ${clockText(p.endsAt - now())}</span>.
    <button class="text-btn" type="button" id="pending-open">Open it</button>`;
}
function settlePending(verified) {
  const p = pendingFlex();
  if (p && verified.some((z) => z.request.id === p.requestId)) {
    forgetPending();
    state.flexed = p.domain;
    const input = document.querySelector("#domain");
    const typed = input ? tryNormaliseDomain(input.value) : undefined;
    if (input && typed?.ok && typed.domain === p.domain)
      input.value = "";
    render();
    document.querySelector(`[data-domain="${CSS.escape(p.domain)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    toast(`Paid: ${p.domain} is on the board.`);
    const dialog = document.querySelector("#key-dialog");
    if (dialog?.open && shownInvoice === p.requestId) {
      markInvoicePaid($("#key-body"), `Paid. ${esc(p.domain)} is on the board.`);
    }
  }
  renderPending();
}
async function checkPending() {
  const p = pendingFlex();
  if (!p || p.pubkey !== session.pubkey || !featuringEnabled())
    return;
  const provider = await zapperKeyFor(CONFIG.featuredLightningAddress).catch(() => {
    return;
  });
  if (!provider)
    return;
  const recipient = CONFIG.featuredRecipientPubkey.trim().toLowerCase();
  const since = p.endsAt - INVOICE_OFFER_SECONDS - 600;
  const receipts = await queryRelays(ZAP_RECEIPT_RELAYS, [{ ...flexZapFilter(recipient, since), authors: [provider] }], { timeoutMs: 5000 }).catch(() => []);
  const verified = [];
  for (const receipt of receipts) {
    const result = verifyZapReceipt({ receipt, recipient, expectedProvider: provider });
    if (result.ok)
      verified.push(result.zap);
  }
  if (verified.some((z) => z.request.id === p.requestId)) {
    settlePending(verified);
    load();
  }
}
function paintLive() {
  const badge = document.querySelector(".activity .live");
  if (badge)
    badge.hidden = !featuringEnabled();
}
initTheme();
initConnect();
onSessionChange(() => {
  render();
  renderPending();
});
$("#form").addEventListener("submit", flexIt);
$("#pending").addEventListener("click", (e) => {
  if (!e.target.closest("#pending-open"))
    return;
  const p = pendingFlex();
  if (p && p.pubkey === session.pubkey)
    showInvoice(p);
  else
    renderPending();
});
renderPending();
setInterval(() => {
  const line = document.querySelector("#pending");
  if (!line || line.hidden)
    return;
  const p = pendingFlex();
  const left = document.querySelector("#pending-left");
  if (p && p.pubkey === session.pubkey && left)
    left.textContent = `Expires in ${clockText(p.endsAt - now())}`;
  else
    renderPending();
}, 1000);
setInterval(() => {
  if (!document.hidden)
    checkPending();
}, 1e4);
$("#c-minus").addEventListener("click", () => stepAmount(false));
$("#c-plus").addEventListener("click", () => stepAmount(true));
loadPrice();
$("#sort").addEventListener("change", (e) => {
  const value = e.target.value;
  const wantRange = value === "rank-all" ? "all" : "week";
  state.sort = value === "rank-all" ? "rank" : value;
  state.page = 1;
  if (wantRange !== state.range) {
    state.range = wantRange;
    load();
  } else {
    render();
  }
});
let searchTimer;
$("#search")?.addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value.trim().toLowerCase();
    state.page = 1;
    render();
  }, 160);
});
$("#chips").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-tld]");
  if (!chip)
    return;
  state.tld = chip.dataset.tld || null;
  state.page = 1;
  render();
});
$("#pager").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-page]");
  if (!btn || btn.disabled)
    return;
  state.page = Number(btn.dataset.page);
  render();
  $("#board").scrollIntoView({ behavior: "smooth", block: "start" });
});
for (const b of document.querySelectorAll(".js-social")) {
  const key = (b.getAttribute("aria-label") ?? "").toLowerCase();
  const url = (CONFIG.socials?.[key] ?? "").trim();
  if (!url) {
    b.hidden = true;
    continue;
  }
  b.addEventListener("click", () => window.open(url, "_blank", "noopener"));
}
paintLive();
load();
if (featuringEnabled())
  setInterval(() => {
    if (!document.hidden)
      load();
  }, 60000);
