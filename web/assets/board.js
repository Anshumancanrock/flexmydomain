/* index.html: the flex board.
 *
 * Anyone may put any domain here, with no proof, listing or permission: type
 * a name, pay, appear. Rank is the bid, in sats. A domain on the board means
 * only that somebody paid for it to be there, so the page must not suggest
 * that they own it, that it is for sale or that anyone checked. Ownership is
 * proven on the market page, where listing is free.
 *
 * The ranking is a sum of public NIP-57 zap receipts. The site keeps no record
 * of who paid what, and anyone can fetch the same receipts and re-count it.
 */
import {
  MSATS_PER_SAT,
  addressOf,
  applyDeletions,
  buildZapRequest,
  checkDomainProof,
  checkListing,
  deletionFilter,
  fetchLnurlPay,
  flexZapFilter,
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
  zapperKeyFor,
} from "./fmd.js";
import { CONFIG, featuringEnabled } from "./config.js";
import {
  $, DISCOVERY_RELAYS, ZAP_RECEIPT_RELAYS, ageText, askDialog, copyToClipboard, esc, initConnect, initTheme, now,
  onSessionChange, openConnect, sats, session,
} from "./ui.js";

const PER_PAGE = 15;
const WEEK = 7 * 86400;

const state = {
  rows: [],        // { domain, sats, zaps, payers, first, listing? }
  loading: true,
  search: "",
  tld: null,
  sort: "rank",
  page: 1,
  range: "week",   // the ranking window: "week" or "all", chosen by #sort
  target: 1,       // the rank the stepper is aiming at
  recent: [],      // verified zaps, newest first, for the activity panel
};

/* ------------------------------------------------------------- loading ---*/

/* The board is built from zap receipts, not from listings. Every flex payment
   goes to one recipient, so one filter finds all of them; the domain travels
   inside the signed zap request the receipt echoes back. */
async function load() {
  state.loading = true;
  render();

  if (!featuringEnabled()) {
    // Without both settings no receipt can be verified, so nothing is shown:
    // a ranking nobody can re-count is worse than an empty board.
    state.rows = [];
    state.loading = false;
    render();
    return;
  }

  const recipient = CONFIG.featuredRecipientPubkey.trim().toLowerCase();
  const provider = await zapperKeyFor(CONFIG.featuredLightningAddress).catch(() => undefined);
  if (!provider) {
    state.rows = [];
    state.loading = false;
    render();
    return;
  }

  const windowSeconds = state.range === "all" ? undefined : WEEK;
  const receipts = await queryDiscovery(
    DISCOVERY_RELAYS,
    [flexZapFilter(recipient, windowSeconds ? now() - windowSeconds : undefined)],
    { timeoutMs: 6000 },
  ).catch(() => []);

  const verified = [];
  for (const receipt of receipts) {
    const result = verifyZapReceipt({ receipt, recipient, expectedProvider: provider });
    if (result.ok && result.zap.flexDomain) verified.push(result.zap);
  }

  state.rows = rankFlexDomains(verified, {
    now: now(),
    windowSeconds: state.range === "all" ? 100 * 365 * 86400 : WEEK,
  }).map((r) => ({ ...r, listing: null }));

  state.recent = verified.sort((a, b) => b.at - a.at).slice(0, 6);
  state.loading = false;
  render();

  linkListings();
}

/* A flexed domain may also be listed for sale on the market. When it is and
   the listing verifies, the row links to it. This is the only place the two
   pages meet, and it works one way: a listing can decorate a flex row, but a
   flex payment never implies anything about ownership. */
async function linkListings() {
  if (state.rows.length === 0) return;
  const events = await queryDiscovery(DISCOVERY_RELAYS, [listingFilter({ limit: 500 })], { timeoutMs: 6000 })
    .catch(() => []);
  const current = newestPerAddress(events);
  const authors = [...new Set(current.map((e) => e.pubkey))];
  const deletions = authors.length
    ? await queryRelays(DISCOVERY_RELAYS, [deletionFilter(authors)], { timeoutMs: 4000 }).catch(() => [])
    : [];

  const wanted = new Set(state.rows.map((r) => r.domain));
  await Promise.all(
    applyDeletions(current, deletions).map(async (event) => {
      const parsed = parseListing(event);
      if (!parsed.ok || !wanted.has(parsed.listing.domain)) return;
      const dns = await checkDomainProof({
        domain: parsed.listing.domain,
        pubkey: event.pubkey,
        dnsOnly: true,
      }).catch(() => null);
      const check = checkListing({ event, dnsProof: dns?.dns, now: now() });
      if (!check.ok) return;
      const row = state.rows.find((r) => r.domain === parsed.listing.domain);
      if (row) {
        row.listing = parsed.listing;
        row.address = addressOf(event);
        render();
      }
    }),
  );
}

/* --------------------------------------------------------------- render ---*/

/* rankFlexDomains has already sorted the rows, and paying is the only
   entitlement, so their order is the ranking. Rank is stamped here so it
   survives filtering: #17 stays #17 when you search for it. */
const board = () => state.rows.map((row, i) => ({ ...row, rank: i + 1 }));

function visible() {
  let rows = board();
  if (state.tld) rows = rows.filter((r) => tldOf(r.domain) === state.tld);
  if (state.search) {
    const q = state.search;
    rows = rows.filter((r) => r.domain.includes(q) || (r.listing?.summary ?? "").toLowerCase().includes(q));
  }

  const by = {
    rank: (a, b) => a.rank - b.rank,
    "price-desc": (a, b) => (b.listing?.priceSats ?? -1) - (a.listing?.priceSats ?? -1),
    "price-asc": (a, b) => (a.listing?.priceSats ?? Infinity) - (b.listing?.priceSats ?? Infinity),
    newest: (a, b) => b.last - a.last,
    az: (a, b) => a.domain.localeCompare(b.domain),
  };
  return [...rows].sort(by[state.sort] ?? by.rank);
}

/* A crown, a star and a cut stone rather than medal glyphs: the metal disc is
   already the medal, and a ribbon-and-disc glyph is illegible at 24px. The
   stone is faceted because an irregular outline turns into a blob at that
   size. */
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

/* Hue keyed to a hash of the name, so a domain keeps its tile colour between
   renders. Eight steps from teal to indigo rather than the whole wheel, which
   would clash with the single-accent palette. Lightness varies too, so eight
   steps still tell two dozen tiles apart. */
const tileOf = (d) => {
  let h = 0;
  for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) >>> 0;
  return { h: 186 + (h % 8) * 7, l: 52 + ((h >>> 3) % 3) * 5 };
};

/* ageText says "today" for the recent past, which takes no "ago". */
const agoText = (ts) => {
  const age = ageText(ts);
  return age === "today" ? age : `${age} ago`;
};

const shortNpub = (pubkey) => {
  const npub = npubEncode(pubkey);
  return `${npub.slice(0, 10)}\u2026${npub.slice(-4)}`;
};

const splitName = (d) => {
  const i = d.lastIndexOf(".");
  return [d.slice(0, i), d.slice(i)];
};

/* Second, first, third: the podium order, which the wordmark also draws. */
const PODIUM = [{ rank: 2, cls: "r2" }, { rank: 1, cls: "r1" }, { rank: 3, cls: "r3" }];

/* The podium ignores the search box and the TLD chips: it shows the top of the
   whole board, and re-ranking it under a filter would crown whatever name was
   searched for. The rows below respect the filter and bring the top three back
   into the list while one is on. */
function renderPodium() {
  const top = board().slice(0, 3);

  $("#podium").innerHTML = PODIUM.map(({ rank, cls }) => {
    const row = top[rank - 1];

    /* An empty floor is shown as open rather than left out, so the podium
       always has three cards. */
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
    return `<article class="card-rank ${cls}">
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
  /* The podium already shows the top three, so the list starts at #4. While a
     search or TLD filter is on they come back, because the podium ignores the
     filter and a search for the leader would otherwise find nothing. */
  const filtered = state.search || state.tld;
  const body = filtered ? rows : rows.slice(PODIUM.length);

  /* Clamp before slicing. Filtering down to one page while sitting on page 4
     otherwise shows an empty list with a pager that disagrees with it. */
  const pages = Math.max(1, Math.ceil(body.length / PER_PAGE));
  if (state.page > pages) state.page = pages;

  const start = (state.page - 1) * PER_PAGE;
  const page = body.slice(start, start + PER_PAGE);

  $("#rows").innerHTML = page.length === 0
    ? `<li class="empty">${
        state.loading
          ? "Asking the relays\u2026"
          : state.rows.length === 0
            ? "Nobody has flexed a domain yet. Type one above and take #1."
            : filtered
              ? "Nothing matches that filter."
              : "Only the podium so far. Flex a domain to take the next spot."
      }</li>`
    : page.map((row) => {
        const [stem, t] = splitName(row.domain);
        const tile = tileOf(row.domain);
        const rank = row.rank;
        const metal = rank <= 3 ? ` r${rank} metal` : "";
        return `<li class="row${rank === 1 ? " row-top" : ""}">
          <span class="r-rank${metal}">#${rank}</span>
          <span class="r-av" style="--h:${tile.h};--l:${tile.l}" aria-hidden="true">${esc((stem[0] ?? "?").toUpperCase())}</span>
          <div class="r-body">
            <p class="r-title">${esc(stem)}<span class="tld">${esc(t)}</span></p>
            <p class="r-desc">${row.listing ? esc(row.listing.summary || "Listed for sale") : `${row.zaps} payment${row.zaps === 1 ? "" : "s"} from ${row.payers.length} backer${row.payers.length === 1 ? "" : "s"}`}</p>
            <p class="r-meta">
              <span class="r-cat">${esc(t)}</span>
              <span>${agoText(row.last)}</span>
              ${row.listing ? `<a href="market.html">for sale &middot; ${sats(row.listing.priceSats)} sats</a>` : ""}
              <a href="https://${esc(row.domain)}" target="_blank" rel="noopener">visit</a>
            </p>
          </div>
          <span class="r-bid">${sats(row.sats)} sats</span>
        </li>`;
      }).join("");

  renderPager(pages);
}

/* Previous, first, a window around the current page, last, Next, with a
   `.gap` ellipsis where numbers are skipped. app.css styles the current page
   through `[aria-current=page]` and the ends through `:disabled`, so both must
   be real attributes; a class such as `.on` is not styled. */
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
    `<button class="pg" type="button" data-page="${cur - 1}"${cur === 1 ? " disabled" : ""}>&larr; Previous</button>`,
  ];
  let previous = 0;
  for (const n of numbers) {
    if (n - previous > 1) parts.push(`<span class="pg gap" aria-hidden="true">&hellip;</span>`);
    parts.push(
      `<button class="pg" type="button" data-page="${n}"${n === cur ? ' aria-current="page"' : ""}>${n}</button>`,
    );
    previous = n;
  }
  parts.push(
    `<button class="pg" type="button" data-page="${cur + 1}"${cur === pages ? " disabled" : ""}>Next &rarr;</button>`,
  );

  el.innerHTML = parts.join("");
}

function renderChips() {
  const counts = new Map();
  for (const row of state.rows) {
    const tld = tldOf(row.domain);
    counts.set(tld, (counts.get(tld) ?? 0) + 1);
  }
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  $("#chips").innerHTML = chips.length
    ? `<button class="chip" type="button" data-tld="" aria-pressed="${!state.tld}">All</button>` +
      chips.map(([tld, n]) =>
        `<button class="chip" type="button" data-tld="${esc(tld)}" aria-pressed="${state.tld === tld}">.${esc(tld)} ${n}</button>`,
      ).join("")
    : "";
}

function renderSide(rows) {
  const total = rows.reduce((s, r) => s + r.sats, 0);
  const tlds = new Set(rows.map((r) => tldOf(r.domain)));
  $("#s-total").textContent = `${sats(total)} sats`;
  $("#s-count").textContent = sats(rows.length);
  $("#s-tld").textContent = tlds.size;

  /* The weekly panel uses the ranking's own zap window, so the two never
     disagree. */
  const weekly = [...rows].filter((r) => r.sats > 0).sort((a, b) => b.sats - a.sats).slice(0, 8);
  $("#weekly").innerHTML = weekly.length
    ? weekly.map((r, i) => {
        const [stem, t] = splitName(r.domain);
        // app.css styles `.wk-rank.metal`, so the medal classes go on the
        // rank span, not on the row.
        const metal = i < 3 ? ` r${i + 1} metal` : "";
        return `<li class="wk-row">
           <span class="wk-rank${metal}">#${i + 1}</span>
           <span class="wk-name">${esc(stem)}<span class="tld">${esc(t)}</span></span>
           <span class="wk-bid">${sats(r.sats)} sats</span>
         </li>`;
      }).join("")
    : `<li class="wk-empty">${
        featuringEnabled()
          ? "No featured zaps this week."
          : "Flex payments are not switched on for this site yet."
      }</li>`;

  /* `.act-i` is the 30x30 icon disc inside a row, not the row: on the <li> it
     would make every entry a 30px square. `.act-up` is the green treatment for
     the top three, `.act-bid` the blue one below. */
  $("#feed").innerHTML = state.recent.length
    ? state.recent.map((zap, i) => {
        const domain = zap.flexDomain ?? "a domain";
        return `<li>
           <span class="act-i ${i < 3 ? "act-up" : "act-bid"}">${TREND}</span>
           <span class="act-body">
             <b>${esc(domain)}</b>
             <span>zapped by ${esc(shortNpub(zap.sender))}</span>
           </span>
           <span class="act-figs"><b>${sats(zap.amountSats)}</b><span>${agoText(zap.at)}</span></span>
         </li>`;
      }).join("")
    : `<li><span class="act-body"><span>${
        featuringEnabled() ? "No zaps in the last week." : "Nothing yet. Flex payments are not switched on for this site."
      }</span></span></li>`;
}

function render() {
  const rows = visible();
  const all = state.rows;

  $("#count").textContent = state.loading
    ? "asking the relays…"
    : !featuringEnabled()
      ? "flex payments are not switched on yet"
      : `${all.length} domain${all.length === 1 ? "" : "s"} on the board`;

  renderPodium();
  renderChips();
  renderRows(rows);
  renderSide(all);
  paintClaim();
}

/* ------------------------------------------------------------- the flex ---
 *
 * Type a domain, pick an amount, pay, with no proof, account or listing. The
 * steppers aim at a rank, and the price is one sat more than whoever holds
 * that rank now.
 *
 * The site never touches the payment. The invoice comes from a lightning
 * provider, the user pays from their own wallet, and the board counts the
 * receipt the provider publishes.
 */

const MIN_FLEX_SATS = 1000;

/* One sat more than whoever holds that rank now; an empty floor costs the
   minimum. */
function costOfRank(r) {
  const list = board();
  const rank = Math.max(1, r);
  return rank > list.length ? MIN_FLEX_SATS : Math.max(MIN_FLEX_SATS, list[rank - 1].sats + 1);
}

/* The rank that many sats would reach. */
function rankFor(amount) {
  const list = board();
  let i = 0;
  while (i < list.length && list[i].sats >= amount) i++;
  return i + 1;
}

function paintClaim() {
  const amount = costOfRank(state.target);
  $("#c-rank").textContent = `#${rankFor(amount)}`;
  $("#c-amount").textContent = `${sats(amount)} sats`;
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

  if (!raw.trim()) return failHint("Enter a domain to flex.");
  const normalised = tryNormaliseDomain(raw);
  if (!normalised.ok) {
    return failHint(`"${raw.trim()}" isn't a registrable domain: ${normalised.reason}.`);
  }
  if (!featuringEnabled()) {
    return failHint("Flex payments are not switched on for this site yet, so there is nothing to pay. Browse the market meanwhile.");
  }
  if (!session.pubkey) {
    // The payer signs the zap request, which is what makes the receipt
    // attributable. The page can make a key in two clicks.
    hint.className = "hint";
    hint.textContent = "Connect or create a key first. Your key signs the payment.";
    openConnect();
    return;
  }

  const domain = normalised.domain;
  const amount = costOfRank(state.target);
  hint.className = "hint";
  hint.innerHTML = `Getting an invoice for <b>${esc(domain)}</b>…`;

  try {
    const lnurl = await fetchLnurlPay(CONFIG.featuredLightningAddress);
    if (!lnurl.ok) return failHint(`The lightning address did not answer: ${lnurl.reason}.`);
    if (!lnurl.info.allowsNostr) {
      return failHint("That address does not support zaps, so no receipt would be written and the board could never count this.");
    }

    const amountMsats = amount * MSATS_PER_SAT;
    const zapRequest = await session.signer.signEvent(
      buildZapRequest({
        pubkey: session.pubkey,
        recipient: CONFIG.featuredRecipientPubkey.trim().toLowerCase(),
        amountMsats,
        relays: ZAP_RECEIPT_RELAYS,
        flexDomain: domain,
        lnurl: lnurl.url,
        createdAt: now(),
      }),
    );

    const invoice = await requestZapInvoice({ info: lnurl.info, amountMsats, zapRequest, lnurl: lnurl.url });
    if (!invoice.ok) return failHint(`The provider refused: ${invoice.reason}.`);

    showInvoice(domain, amount, invoice.invoice);
    hint.className = "hint";
    hint.innerHTML = `Invoice ready for <b>${esc(domain)}</b>.`;
  } catch (err) {
    failHint(err.message);
  }
}

function showInvoice(domain, amount, invoice) {
  askDialog(
    `Flex ${domain}`,
    `<p><b>${sats(amount)} sats</b> puts <b>${esc(domain)}</b> at <b>#${rankFor(amount)}</b>.
        Pay in any wallet. We never touch the payment.</p>
     <div class="nsec" id="invoice">${esc(invoice)}</div>
     <div style="display:flex;gap:8px;flex-wrap:wrap">
       <a class="btn btn-accent btn-sm" href="lightning:${esc(invoice)}">Open in wallet</a>
       <button class="btn btn-ghost btn-sm" type="button" id="copy-invoice">Copy invoice</button>
     </div>
     <p class="hint" style="text-align:left">The board updates when your provider publishes the
        receipt, usually within seconds. Being on this board says only that somebody paid; it is
        not a claim of ownership. To say you own it, prove it on the <a href="market.html">market</a>.</p>`,
  );
  $("#copy-invoice").addEventListener("click", () => copyToClipboard($("#invoice").textContent));
}

/* The "Live" badge shows only when payments are on, and then the receipts are
   re-read every minute. */
function paintLive() {
  const badge = document.querySelector(".activity .live");
  if (badge) badge.hidden = !featuringEnabled();
}

/* ------------------------------------------------------------- wiring ---*/

initTheme();
initConnect();
onSessionChange(() => render());

$("#form").addEventListener("submit", flexIt);

$("#c-minus").addEventListener("click", () => {
  // A cheaper rank is further down the board, so the target number goes up.
  state.target = Math.min(board().length + 1, state.target + 1);
  paintClaim();
});
$("#c-plus").addEventListener("click", () => {
  state.target = Math.max(1, state.target - 1);
  paintClaim();
});

/* Sorting and the ranking window share one control. "All time" changes which
   receipts are fetched as well as their order: this week shows who is paying
   for attention now, all time shows who has paid for it most. */
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
  if (!chip) return;
  state.tld = chip.dataset.tld || null;
  state.page = 1;
  render();
});

$("#pager").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-page]");
  if (!btn || btn.disabled) return;
  state.page = Number(btn.dataset.page);
  render();
  $("#board").scrollIntoView({ behavior: "smooth", block: "start" });
});

/* Footer socials come from config.js. One with no URL is hidden. */
for (const b of document.querySelectorAll(".js-social")) {
  const key = (b.getAttribute("aria-label") ?? "").toLowerCase();
  const url = (CONFIG.socials?.[key] ?? "").trim();
  if (!url) { b.hidden = true; continue; }
  b.addEventListener("click", () => window.open(url, "_blank", "noopener"));
}

paintLive();
load();
// One interval, registered once, and only when payments are on.
if (featuringEnabled()) setInterval(() => { if (!document.hidden) load(); }, 60_000);
