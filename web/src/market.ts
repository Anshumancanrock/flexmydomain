/* market.html: browse listings, and publish one.
 *
 * A listing is shown only when its event signature verifies, its embedded
 * proof verifies for that domain under that key, and the domain's DNS still
 * agrees (the rule in spec/PROTOCOL.md). Nostr has no gatekeeper, so a listing
 * claiming apple.com will exist. The event stays on the relays; the page only
 * declines to show it, and the Unverified toggle lists what was hidden and
 * why.
 */
import {
  DEFAULT_RELAYS,
  MSATS_PER_SAT,
  RelayDirectory,
  buildPortfolio,
  buildZapRequest,
  checkDomain,
  encodeProofRecord,
  fetchLnurlPay,
  proofEvent,
  proofRecordName,
  requestZapInvoice,
  tryNormaliseDomain,
  upsertEntry,
  applyDeletions,
  buildDeletion,
  buildListing,
  checkListing,
  checkDomainProof,
  countOnRelays,
  deletionFilter,
  listingAddress,
  listingFilter,
  newestPerAddress,
  nostrUri,
  npubEncode,
  parseListing,
  parsePortfolio,
  portfolioFilter,
  publishOutbox,
  queryDiscovery,
  queryRelays,
  shorten,
  tldOf,
  verifyPortfolio,
} from "./fmd.js";
import type {
  DomainReport, Listing, ListingCheck, NostrEvent, PortfolioEntry, ProofRecord, RegistryReport,
} from "./fmd.js";
import {
  $, DISCOVERY_RELAYS, ZAP_RECEIPT_RELAYS, ageText, askDialog, closeDialog, copyToClipboard, esc,
  initConnect, initTheme, now, onSessionChange, openConnect, row, sats, session, toast,
} from "./ui.js";
import { CONFIG, featuringEnabled } from "./config.js";

const directory = new RelayDirectory(DISCOVERY_RELAYS);

/** A listing as this page holds it. `check` and `live` fill in once DNS answers. */
interface ListingEntry {
  event: NostrEvent;
  listing: Listing;
  check: ListingCheck | null;
  live: DomainReport | null;
}

/** The prove-a-domain steps, while they are in progress. */
interface Draft {
  domain: string;
  proof: DomainReport;
  registry: RegistryReport;
  record: ProofRecord | null;
  verified: boolean;
  event?: NostrEvent;
}

const state: {
  draft: Draft | null;
  listings: ListingEntry[];
  loading: boolean;
  search: string;
  tld: string | null;
  sort: string;
  showUnverified: boolean;
  total: number | undefined;
  portfolio: PortfolioEntry[];
  mine: (PortfolioEntry & { proven: boolean })[];
  portfolioKnown: boolean;
} = {
  draft: null,      // the prove-a-domain ceremony in progress
  listings: [],     // everything that parsed
  loading: true,
  search: "",
  tld: null,
  sort: "price-desc",
  showUnverified: false,
  total: undefined, // NIP-45 COUNT, or undefined when no relay would answer
  portfolio: [],    // the connected key's portfolio as published; republish from this
  mine: [],         // the listable subset of it, for the sell form
  portfolioKnown: false, // whether a relay finished answering for that portfolio
};

/* ------------------------------------------------------------- loading ---*/

/* A discovery query has no author to route by, so it is a sweep of the
   fallback relays, and the UI says so: this view is the relays asked, not the
   whole network. The outbox model only applies once the author is known. */
async function load(): Promise<void> {
  state.loading = true;
  render();

  const [events, count] = await Promise.all([
    queryDiscovery(DISCOVERY_RELAYS, [listingFilter({ limit: 500 })], { timeoutMs: 6000 }).catch(() => []),
    countOnRelays(DISCOVERY_RELAYS, [listingFilter()]).catch(() => undefined),
  ]);
  state.total = count;

  // One listing per (kind, author, d). Relays also return older versions,
  // especially right after an edit, and those would show a stale price.
  const current = newestPerAddress(events);

  // NIP-09: relays may ignore a deletion request, a client does not have to.
  const authors = [...new Set(current.map((e) => e.pubkey))];
  const deletions = authors.length
    ? await queryRelays(DISCOVERY_RELAYS, [deletionFilter(authors)], { timeoutMs: 4000 }).catch(() => [])
    : [];
  const live = applyDeletions(current, deletions);

  state.listings = live
    .map((event) => {
      const parsed = parseListing(event);
      return parsed.ok ? { event, listing: parsed.listing, check: null, live: null } : null;
    })
    .filter(Boolean) as ListingEntry[];

  state.loading = false;
  render();

  // Then the slow part: one DNS check per listing, rendered as each lands so
  // the page fills in instead of waiting for the slowest zone.
  await Promise.all(
    state.listings.map(async (entry) => {
      const report = await checkDomainProof({
        domain: entry.listing.domain,
        pubkey: entry.event.pubkey,
        dnsOnly: true,
      }).catch(() => null);
      entry.live = report;
      entry.check = checkListing({ event: entry.event, dnsProof: report?.dns, now: now() });
      render();
    }),
  );
}

/* --------------------------------------------------------------- render ---*/

const verified = (entry: ListingEntry): boolean => entry.check?.ok === true;

function visible(): ListingEntry[] {
  let rows = state.listings.filter((entry) => (state.showUnverified ? true : verified(entry)));

  if (state.tld) rows = rows.filter((e) => tldOf(e.listing.domain) === state.tld);
  if (state.search) {
    const q = state.search.toLowerCase();
    rows = rows.filter(
      (e) => e.listing.domain.includes(q) || e.listing.summary.toLowerCase().includes(q),
    );
  }

  const by: Record<string, (a: ListingEntry, b: ListingEntry) => number> = {
    "price-desc": (a, b) => b.listing.priceSats - a.listing.priceSats,
    "price-asc": (a, b) => a.listing.priceSats - b.listing.priceSats,
    newest: (a, b) => b.listing.publishedAt - a.listing.publishedAt,
    "oldest-domain": (a, b) => (a.listing.registeredAt ?? Infinity) - (b.listing.registeredAt ?? Infinity),
    az: (a, b) => a.listing.domain.localeCompare(b.listing.domain),
  };
  return [...rows].sort(by[state.sort] ?? by["price-desc"]);
}

function renderTlds(): void {
  const counts = new Map<string, number>();
  for (const entry of state.listings) {
    if (!state.showUnverified && !verified(entry)) continue;
    const tld = tldOf(entry.listing.domain);
    counts.set(tld, (counts.get(tld) ?? 0) + 1);
  }
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  $("#tlds").innerHTML = chips.length
    ? `<button class="chip" type="button" data-tld="" aria-pressed="${!state.tld}">All</button>` +
      chips.map(([tld, n]) =>
        `<button class="chip" type="button" data-tld="${esc(tld)}" aria-pressed="${state.tld === tld}">.${esc(tld)} ${n}</button>`,
      ).join("")
    : "";
}

function render(): void {
  const rows = visible();
  const checked = state.listings.filter((e) => e.check !== null).length;
  const good = state.listings.filter(verified).length;

  $("#count").textContent = state.loading
    ? "Asking the relays…"
    : `${good} verified of ${state.listings.length} fetched` +
      (checked < state.listings.length ? ` · checking ${state.listings.length - checked} more` : "") +
      (state.total !== undefined ? ` · ${state.total} on the relays` : "");

  renderTlds();

  const grid = $("#grid");
  if (state.loading) {
    grid.innerHTML = `<p class="empty">Asking ${DISCOVERY_RELAYS.length} relays…</p>`;
    return;
  }
  if (rows.length === 0) {
    grid.innerHTML = `<p class="empty">${
      state.listings.length === 0
        ? "No listings on these relays yet. Be the first: prove a domain, then list it."
        : "Nothing matches. Clear the search or the TLD filter."
    }</p>`;
    return;
  }

  grid.innerHTML = rows.map((entry) => {
    const l = entry.listing;
    const ok = verified(entry);
    const mine = entry.event.pubkey === session.pubkey;

    const tags: string[] = [];
    if (ok) tags.push(`<span class="tag proven">✓ proof verified</span>`);
    else if (entry.check) tags.push(`<span class="tag unproven">unverified</span>`);
    else tags.push(`<span class="tag">checking…</span>`);
    if (entry.live?.dnssec) tags.push(`<span class="tag dnssec">DNSSEC</span>`);
    if (l.registeredAt) tags.push(`<span class="tag">registered ${ageText(l.registeredAt)} ago</span>`);
    if (l.status === "sold") tags.push(`<span class="tag">sold</span>`);
    tags.push(`<span class="tag">.${esc(tldOf(l.domain))}</span>`);

    return `<article class="listing${ok ? "" : " unverified"}">
      <div class="listing-top">
        <div class="listing-name">${esc(l.domain)}</div>
        <div class="listing-price">${sats(l.priceSats)}<small>sats</small></div>
      </div>
      ${l.summary ? `<p class="listing-summary">${esc(l.summary)}</p>` : ""}
      ${!ok && entry.check ? `<p class="listing-why">${esc(entry.check.reason ?? "did not verify")}</p>` : ""}
      <div class="listing-meta">${tags.join("")}</div>
      <div class="listing-actions">
        ${!mine && ok ? `<a class="btn btn-accent" href="escrow.html?${new URLSearchParams({
            domain: l.domain,
            amount: String(l.priceSats),
            seller: npubEncode(entry.event.pubkey),
          }).toString()}">Buy</a>` : ""}
        <button class="btn btn-ghost" type="button" data-feature="${esc(l.domain)}">Feature</button>
        <button class="btn btn-ghost" type="button" data-share="${esc(l.domain)}">Share</button>
        <button class="btn btn-ghost" type="button" data-seller="${esc(entry.event.pubkey)}">Seller</button>
        ${mine ? `<button class="btn btn-ghost" type="button" data-delist="${esc(l.domain)}">Delist</button>` : ""}
      </div>
    </article>`;
  }).join("");
}

/* ----------------------------------------------------------- the seller ---*/

/* Only a domain the connected key has already proven can be listed. A listing
   embeds the proof signature, so one cannot be built without a proof, and a
   free-text domain field would only produce listings that fail on every
   reader's machine. */
async function loadMine(): Promise<void> {
  state.portfolioKnown = false;
  if (!session.pubkey) {
    state.portfolio = [];
    state.mine = [];
    return;
  }

  /* Read from the user's NIP-65 write relays as well as the sweep relays: a
     portfolio published before portfolios also went to the sweep relays
     exists only on the write relays. Only relays that finished answering
     count. If none did, the portfolio is marked unknown rather than empty,
     because the next proof would otherwise republish from nothing and replace
     the real one; publishing waits for a real answer. */
  const pubkey = session.pubkey;
  await directory.resolve([pubkey]).catch(() => {});
  const relays = [...new Set([...directory.readRelays(pubkey), ...DISCOVERY_RELAYS])];
  let completed = 0;
  const events = await queryRelays(relays, [portfolioFilter(pubkey)], {
    timeoutMs: 5000,
    onRelayDone: (_relay, _count, _error, complete) => { if (complete) completed++; },
  }).catch(() => []);
  if (session.pubkey !== pubkey) return; // the key changed mid-read; its own load follows
  state.portfolioKnown = completed > 0;

  const newest = newestPerAddress(events)[0];
  if (!newest) {
    state.portfolio = [];
    state.mine = [];
    return;
  }
  const parsed = parsePortfolio(newest);
  if (!parsed.ok) {
    state.portfolio = [];
    state.mine = [];
    return;
  }

  /* Two lists, and they must not be mixed up.
   *
   * `portfolio` is every entry as published, and every republish is built
   * from it. Kind 30078 is replaceable, so a filtered copy replaces the whole
   * portfolio and whatever was filtered out is gone. A NIP-05-proven domain
   * carries no signature and would be dropped by the filter below, so
   * republishing from the filtered list would delete it the next time the
   * user proves anything.
   *
   * `mine` is the subset that can back a listing: DNS-proven, with a signature
   * to embed. Only the sell dropdown reads it.
   */
  const verdicts = verifyPortfolio(parsed.portfolio);
  state.portfolio = parsed.portfolio.entries;
  state.mine = parsed.portfolio.entries
    .map((entry, i) => ({ ...entry, proven: verdicts[i].proven }))
    .filter((entry) => entry.proven && entry.iat !== undefined && entry.sig !== undefined);
}

async function openSell(): Promise<void> {
  if (!session.pubkey) {
    openConnect();
    return;
  }
  $("#sell-section").hidden = false;
  $("#sell-pick").innerHTML = row("", "Reading your portfolio from the relays…");
  $("#sell-form").hidden = true;
  $("#sell-results").hidden = true;

  await loadMine();

  if (state.mine.length === 0) {
    $("#sell-pick").innerHTML = row(
      "bad",
      `No proven domains on this key yet. Prove one below (it takes one DNS record)
       and it appears here straight away.`,
    );
    // Open the prove steps here instead of sending the user to another page.
    $<HTMLDetailsElement>("#prove").open = true;
    $("#prove").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  $("#sell-pick").innerHTML = row(
    "good",
    `${state.mine.length} proven domain${state.mine.length === 1 ? "" : "s"} on this key.`,
  );
  $("#sell-domain").innerHTML = state.mine
    .map((e) => `<option value="${esc(e.domain)}">${esc(e.domain)}</option>`)
    .join("");
  $("#sell-form").hidden = false;
}

async function publishListing(event: Event): Promise<void> {
  event.preventDefault();
  const hint = $("#sell-hint");
  const button = $<HTMLButtonElement>("#sell-publish");

  const domain = $<HTMLSelectElement>("#sell-domain").value;
  const entry = state.mine.find((e) => e.domain === domain);
  const priceSats = Number($<HTMLInputElement>("#sell-price").value.replace(/[\s,_]/g, ""));

  if (!entry) {
    hint.textContent = "Pick a proven domain.";
    hint.className = "hint err";
    return;
  }
  if (!Number.isSafeInteger(priceSats) || priceSats <= 0) {
    hint.textContent = "Price must be a whole number of sats.";
    hint.className = "hint err";
    return;
  }

  button.disabled = true;
  button.textContent = "Waiting for your signer…";
  hint.textContent = "";

  try {
    /* Re-check the zone before publishing. The portfolio says this key proved
       the domain at some point; a listing asserts it is true now, and the gap
       between those two is where a stale listing comes from. */
    const live = await checkDomainProof({ domain, pubkey: session.pubkey as string, dnsOnly: true });
    if (!live.status.proven) {
      hint.textContent = `The zone no longer carries your proof: ${live.status.reason}. Re-prove it with "Prove a new domain" below.`;
      hint.className = "hint err";
      return;
    }

    const unsigned = buildListing({
      pubkey: session.pubkey as string,
      domain,
      priceSats,
      summary: $<HTMLInputElement>("#sell-summary").value.trim() || undefined,
      description: $<HTMLTextAreaElement>("#sell-description").value.trim() || undefined,
      publishedAt: now(),
      proof: { version: "fmd1", iat: entry.iat!, pubkey: session.pubkey as string, sig: entry.sig! },
    });

    const signed = await session.signer!.signEvent(unsigned);
    const results = await publishOutbox(directory, signed, { extraRelays: DISCOVERY_RELAYS });
    const accepted = results.filter((r) => r.ok);

    $("#sell-results").hidden = false;
    $("#sell-results").innerHTML =
      (accepted.length
        ? row("good", `<b>Published to ${accepted.length} of ${results.length} relays.</b>
             The relays hold the listing now, signed by you. Its Share button gives the link.`)
        : row("bad", `<b>No relay accepted it.</b> Nothing was published.`)) +
      results.map((r) =>
        row(r.ok ? "good" : "bad",
          `<b>${esc(r.relay.replace(/^wss:\/\//, ""))}</b>: ${r.ok ? "accepted" : esc(r.message ?? "refused")}`),
      ).join("");

    if (accepted.length) {
      $<HTMLFormElement>("#sell-form").reset();
      await load();
    }
  } catch (err) {
    hint.textContent = (err as Error).message;
    hint.className = "hint err";
  } finally {
    button.disabled = false;
    button.textContent = "Sign and publish";
  }
}

/* Delisting is two acts, and the dialog says so because only one of them is
   reliable. Republishing with status: sold replaces the old event everywhere
   it reached; the kind 5 is a request relays may ignore. Calling the deletion
   alone "removed" would tell a seller their asking price is private when it
   is not. */
async function delist(domain: string): Promise<void> {
  const entry = state.listings.find(
    (e) => e.listing.domain === domain && e.event.pubkey === session.pubkey,
  );
  if (!entry || !session.signer) return;

  askDialog(
    "Delist this domain",
    `<p>Two things happen, and they are not equally reliable:</p>
     <p><b>1. The listing is republished as <code>sold</code>.</b> This is the authoritative
        signal. It replaces the old event on every relay that carried it.</p>
     <p><b>2. A deletion request is sent.</b> Relays may honour it or ignore it, and anyone
        who already fetched the listing still has it.</p>
     <p>Your DNS record and your portfolio are untouched.</p>`,
    {
      confirmLabel: "Delist",
      onConfirm: async () => {
        closeDialog();
        try {
          const l = entry.listing;
          const sold = await session.signer!.signEvent(
            buildListing({
              pubkey: session.pubkey as string,
              domain: l.domain,
              priceSats: l.priceSats,
              summary: l.summary || undefined,
              description: l.description || undefined,
              status: "sold",
              publishedAt: l.publishedAt,
              createdAt: now(),
              proof: l.proof,
            }),
          );
          const request = await session.signer!.signEvent(
            buildDeletion({
              pubkey: session.pubkey as string,
              events: [entry.event],
              reason: "delisted",
              createdAt: now(),
            }),
          );
          const [a, b] = await Promise.all([
            publishOutbox(directory, sold, { extraRelays: DISCOVERY_RELAYS }),
            publishOutbox(directory, request, { extraRelays: DISCOVERY_RELAYS }),
          ]);
          toast(`Marked sold on ${a.filter((r) => r.ok).length} relays; deletion requested on ${b.filter((r) => r.ok).length}.`);
          await load();
        } catch (err) {
          toast((err as Error).message);
        }
      },
    },
  );
}

function share(domain: string): void {
  const entry = state.listings.find((e) => e.listing.domain === domain);
  if (!entry) return;
  const naddr = listingAddress(entry.listing, DEFAULT_RELAYS.slice(0, 2));
  askDialog(
    "Share this listing",
    `<p>This is the listing's identity on Nostr, not a link to a server we run. Any client
        can resolve it from any relay, whether or not this site is still running.</p>
     <div class="nsec" id="naddr">${esc(nostrUri(naddr))}</div>
     <button class="btn btn-ghost btn-sm" type="button" id="copy-naddr">Copy</button>
     <p class="hint">Seller: ${esc(shorten(npubEncode(entry.event.pubkey), 10))}</p>`,
  );
  $("#copy-naddr").addEventListener("click", () => copyToClipboard($("#naddr").textContent!));
}

/* ---------------------------------------------------------------- zapping ---
 *
 * Featuring a listing is a NIP-57 zap. The site runs no payment
 * infrastructure: the invoice comes from the recipient's own lightning
 * provider, the user pays from whatever wallet they already have, and the
 * board counts the receipt the provider publishes. The site holds no payment
 * state.
 *
 * The zap request is signed but not published to relays. It travels in the
 * LNURL callback, and the provider echoes it back inside the receipt.
 */
async function featureListing(domain: string): Promise<void> {
  const entry = state.listings.find((e) => e.listing.domain === domain);
  if (!entry) return;

  if (!featuringEnabled()) {
    askDialog(
      "Flex payments aren't on yet",
      `<p>This site hasn't switched on payments for the flex board yet, so there is
          nowhere to send a payment the board could count.</p>
       <p>The listing stays on the market either way. Featuring only changes where
          it ranks on the flex board.</p>`,
    );
    return;
  }
  if (!session.pubkey) {
    openConnect();
    return;
  }

  const address = listingAddress(entry.listing, DEFAULT_RELAYS.slice(0, 2));

  askDialog(
    `Feature ${domain}`,
    `<p>Rank is sats zapped inside a rolling week. This pays
        <b>${esc(CONFIG.featuredLightningAddress)}</b> and tags the payment with this
        listing, so the receipt is public and anyone can re-count the board.</p>
     <label style="display:block;font-size:12px;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Amount in sats</label>
     <input type="text" id="zap-amount" inputmode="numeric" value="1000" autocomplete="off">
     <label style="display:block;font-size:12px;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Comment, optional</label>
     <input type="text" id="zap-comment" maxlength="180" placeholder="Good name." autocomplete="off">
     <div id="zap-out"></div>`,
    {
      confirmLabel: "Get an invoice",
      onConfirm: () => requestInvoice(domain, address),
    },
  );
}

async function requestInvoice(domain: string, address: string): Promise<void> {
  const out = $("#zap-out");
  const amountSats = Number($<HTMLInputElement>("#zap-amount").value.replace(/[\s,_]/g, ""));
  const comment = $<HTMLInputElement>("#zap-comment").value.trim();

  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    out.innerHTML = row("bad", "Amount must be a whole number of sats.");
    return;
  }

  out.innerHTML = row("", "Asking the lightning provider…");
  const go = $<HTMLButtonElement>("#key-go");
  go.disabled = true;

  try {
    const lnurl = await fetchLnurlPay(CONFIG.featuredLightningAddress);
    if (!lnurl.ok) {
      out.innerHTML = row("bad", `The lightning address did not answer: ${esc(lnurl.reason)}.`);
      return;
    }
    if (!lnurl.info.allowsNostr) {
      out.innerHTML = row(
        "bad",
        `That address does not support zaps, so no receipt would be written and the
         board could never count this payment. Nothing was charged.`,
      );
      return;
    }

    const amountMsats = amountSats * MSATS_PER_SAT;
    const unsigned = buildZapRequest({
      pubkey: session.pubkey as string,
      recipient: CONFIG.featuredRecipientPubkey.trim().toLowerCase(),
      amountMsats,
      relays: ZAP_RECEIPT_RELAYS,
      /* Both tags. The flex board counts zaps by domain and drops any zap
         without `fmd_flex`, so a payment carrying only the listing coordinate
         would take the user's sats and never appear on the board. `address`
         keeps the receipt pointing at the listing it was paid from. */
      flexDomain: domain,
      address,
      lnurl: lnurl.url,
      comment: comment || undefined,
      createdAt: now(),
    });

    const zapRequest = await session.signer!.signEvent(unsigned);
    const invoice = await requestZapInvoice({
      info: lnurl.info,
      amountMsats,
      zapRequest,
      lnurl: lnurl.url,
    });

    if (!invoice.ok) {
      out.innerHTML = row("bad", `The provider refused: ${esc(invoice.reason)}.`);
      return;
    }

    /* The invoice is shown, not paid: the payment happens in the user's own
       wallet, and the board counts the receipt once the provider publishes
       it. */
    out.innerHTML =
      row("good", `<b>Invoice for ${sats(amountSats)} sats.</b> Pay it in any wallet.`) +
      `<div class="nsec" id="invoice">${esc(invoice.invoice)}</div>
       <div style="display:flex;gap:8px;flex-wrap:wrap">
         <a class="btn btn-accent btn-sm" href="lightning:${esc(invoice.invoice)}">Open in wallet</a>
         <button class="btn btn-ghost btn-sm" type="button" id="copy-invoice">Copy invoice</button>
       </div>
       <p class="hint" style="text-align:left">The board updates when your provider publishes
          the receipt, usually within seconds. We hold nothing at any point.</p>`;
    $("#copy-invoice").addEventListener("click", () => copyToClipboard($("#invoice").textContent!));
    go.hidden = true;
  } catch (err) {
    out.innerHTML = row("bad", esc((err as Error).message));
  } finally {
    go.disabled = false;
  }
}

/* ------------------------------------------------- the add-a-domain flow ---*/

function step(n: number): void {
  document.querySelectorAll<HTMLElement>(".step").forEach((el) => {
    const i = Number(el.dataset.step);
    el.classList.toggle("on", i === n);
    if (i < n) el.classList.add("done");
    if (i >= n) el.classList.remove("done");
  });
}

/* Step 1: normalise the name and ask the registry about it. The registry
   answer is shown as information here and never blocks the next step: a
   locked or young domain can still be proven. Those findings matter once
   money is about to move. */
async function checkName(event: Event): Promise<void> {
  event.preventDefault();
  const hint = $("#domain-hint");
  const normalised = tryNormaliseDomain($<HTMLInputElement>("#domain").value);
  if (!normalised.ok) {
    hint.textContent = normalised.reason;
    hint.className = "hint err";
    return;
  }

  const domain = normalised.domain;
  hint.className = "hint";
  hint.innerHTML = normalised.unicode !== domain
    ? `Reading it as <b>${esc(domain)}</b>, which is <b>${esc(normalised.unicode)}</b> in A-label form.`
    : `Reading it as <b>${esc(domain)}</b>.`;

  $<HTMLButtonElement>("#check-btn").disabled = true;
  $("#check-btn").textContent = "Checking…";
  const registry = $("#registry");
  registry.hidden = false;
  registry.innerHTML = row("", "Asking the registry and the resolvers…");

  try {
    const { proof, registry: reg } = await checkDomain({ domain, pubkey: session.pubkey as string });
    state.draft = { domain, proof, registry: reg, record: null, verified: false };
    registry.innerHTML = renderRegistry(reg, proof);
    step(2);
  } catch (err) {
    registry.innerHTML = row("bad", esc((err as Error).message));
  } finally {
    $<HTMLButtonElement>("#check-btn").disabled = false;
    $("#check-btn").textContent = "Check";
  }
}

function renderRegistry(reg: RegistryReport, proof: DomainReport): string {
  const rows: string[] = [];

  if (!reg.supported) {
    rows.push(row("", `This TLD publishes no RDAP service, so nothing about the registration
      can be checked. You can still flex the name, but it cannot be escrowed here.`));
  } else if (!reg.eligibility) {
    rows.push(row("", `The registry did not answer. That says nothing about the domain; try again.`));
  } else {
    const e = reg.eligibility;
    const f = e.facts;
    const facts: string[] = [];
    if (f.registrarName) facts.push(`registrar ${f.registrarName}`);
    if (e.daysSinceRegistration !== undefined) facts.push(`registered ${ageText(f.registration!)} ago`);
    if (e.daysUntilExpiry !== undefined) facts.push(`expires in ${Math.floor(e.daysUntilExpiry)}d`);
    facts.push(e.unlocked ? "transfer lock off" : "transfer lock on");
    rows.push(row(e.listable ? "good" : "bad", esc(facts.join(" · "))));

    for (const finding of e.findings) {
      rows.push(row(finding.level === "refuse" ? "bad" : "", esc(finding.message)));
    }
    /* What a sale will ask of the seller, so it is no surprise later: the escrow
       funds only after the registry has seen the transfer lock change, because a
       change to the lock is the one thing only the registrant can do. */
    rows.push(row("", e.unlocked
      ? `When somebody buys it, the escrow will ask you to turn the transfer lock
         <b>on</b> at your registrar and, once it has seen that, <b>off</b> again. Only the
         registrant can change the lock, so that is how a buyer knows you hold the domain
         and not just its DNS. Listing needs nothing from the registrar.`
      : `When somebody buys it, the escrow will ask you to turn this transfer lock
         <b>off</b> at your registrar. Only the registrant can change the lock, so that is
         how a buyer knows you hold the domain and not just its DNS. Listing needs nothing
         from the registrar.`));
  }

  if (proof.status.proven) {
    rows.push(row("good", `This domain already proves your key, so you can publish it straight away.`));
  }
  return rows.join("");
}

/* Step 2: sign the proof, a canonical event that the record alone
   reconstructs (spec/PROOF.md 2.1). */
async function signProof(): Promise<void> {
  if (!state.draft || !session.signer) return;
  const button = $<HTMLButtonElement>("#sign-btn");
  button.disabled = true;
  button.textContent = "Waiting for your signer…";

  try {
    const iat = now();
    const signed = await session.signer.signEvent(
      proofEvent({ domain: state.draft.domain, pubkey: session.pubkey as string, iat }),
    );
    const record: ProofRecord = { version: "fmd1", iat, pubkey: session.pubkey as string, sig: signed.sig };

    state.draft.record = record;
    state.draft.event = signed;

    $("#record-name").textContent = proofRecordName(state.draft.domain);
    $("#record-value").textContent = encodeProofRecord(record);
    $("#record").hidden = false;
    button.textContent = "Sign again";
    step(3);
  } catch (err) {
    toast((err as Error).message);
    button.textContent = "Sign the proof";
  } finally {
    button.disabled = false;
  }
}

/* Step 3: ask two resolvers and show what each said, so the user can watch
   propagation happen and see which resolver is behind. */
async function verifyZone(): Promise<void> {
  if (!state.draft) return;
  const button = $<HTMLButtonElement>("#verify-btn");
  const out = $("#observations");
  button.disabled = true;
  button.textContent = "Resolving…";
  out.hidden = false;
  out.innerHTML = row("", "Querying two independent resolvers…");

  try {
    const report = await checkDomainProof({ domain: state.draft.domain, pubkey: session.pubkey as string });
    state.draft.proof = report;
    state.draft.verified = report.status.proven;

    const rows = report.lookup.observations.map((o) =>
      row(o.error ? "" : o.records.length ? "good" : "bad",
        `<b>${esc(o.provider)}</b>: ${
          o.error
            ? `did not answer (${esc(o.error)})`
            : `${o.records.length} TXT record${o.records.length === 1 ? "" : "s"}${o.dnssec ? ", DNSSEC validated" : ""}`
        }`),
    );

    if (report.status.proven) {
      rows.push(row("good", `<b>Proven.</b> Both resolvers returned a record that verifies
        for your key${report.dnssec ? ", over a validated DNSSEC chain" : ""}.`));
      step(4);
    } else if (report.lookup.disputed.length) {
      rows.push(row("bad", `One resolver sees the record and the other does not. That is
        normal for a few minutes after you add it; check again shortly.`));
    } else {
      rows.push(row("bad", `No record verified yet${report.dns.reason ? `: ${esc(report.dns.reason)}` : ""}.
        DNS changes can take a few minutes.`));
    }
    out.innerHTML = rows.join("");
  } catch (err) {
    out.innerHTML = row("bad", esc((err as Error).message));
  } finally {
    button.disabled = false;
    button.textContent = "Check again";
  }
}

/* Step 4: publish two events, both signed by the user: the proof, which any
   Nostr client can check without DNS, and the portfolio, so the flex page
   renders from one fetch. Both go to the user's own NIP-65 write relays and to
   the discovery relays this market sweeps. Every relay's answer is shown,
   refusals included, so two acceptances out of five are not reported as a
   plain "published". */
async function publish(): Promise<void> {
  if (!state.draft?.verified || !session.signer) return;
  const button = $<HTMLButtonElement>("#publish-btn");
  const out = $("#relay-results");
  button.disabled = true;
  button.textContent = "Publishing…";
  out.hidden = false;

  /* What gets published here replaces the portfolio, so it must be built from
     a read that finished. If none did, stop rather than risk overwriting it
     with this one domain. */
  if (!state.portfolioKnown) {
    out.innerHTML = row("", "Reading your current portfolio first…");
    await loadMine();
  }
  if (!state.portfolioKnown) {
    out.innerHTML = row("bad", `<b>Nothing was published.</b> None of your relays finished
      answering, so this page cannot see your current portfolio, and publishing now could replace
      it with just this domain. Your proof is still valid in DNS. Try again in a minute.`);
    button.disabled = false;
    button.textContent = "Publish to relays";
    return;
  }
  out.innerHTML = row("", "Signing your portfolio…");

  try {
    // Republish from the full portfolio, never from the listable subset.
    const entries = upsertEntry(state.portfolio, {
      domain: state.draft.domain,
      source: state.draft.proof.status.source ?? "dns",
      iat: state.draft.record!.iat,
      sig: state.draft.record!.sig,
      firstSeen: now(),
    });

    const portfolio = await session.signer.signEvent(
      buildPortfolio({ pubkey: session.pubkey as string, entries, createdAt: now() }),
    );

    const [proofResults, portfolioResults] = await Promise.all([
      publishOutbox(directory, state.draft.event!, { extraRelays: DISCOVERY_RELAYS }),
      publishOutbox(directory, portfolio, { extraRelays: DISCOVERY_RELAYS }),
    ]);

    const relays = [...new Set([...proofResults, ...portfolioResults].map((r) => r.relay))];
    const accepted = new Set<string>();
    const rows: string[] = [];
    for (const relay of relays) {
      const a = proofResults.find((r) => r.relay === relay);
      const b = portfolioResults.find((r) => r.relay === relay);
      const ok = a?.ok && b?.ok;
      if (ok) accepted.add(relay);
      rows.push(row(ok ? "good" : "bad",
        `<b>${esc(relay.replace(/^wss:\/\//, ""))}</b>: ${
          ok ? "accepted both events" : esc(b?.message || a?.message || "refused")
        }`));
    }

    if (accepted.size === 0) {
      rows.unshift(row("bad", `<b>No relay accepted it.</b> Your proof is still valid (it is
        in DNS), but nothing has been published. Try again.`));
    } else {
      rows.unshift(row("good", `<b>Published to ${accepted.size} of ${relays.length} relays.</b>
        Your domains live there now, signed by you.`));
      $<HTMLInputElement>("#domain").value = "";
      step(1);
      await afterProof();
    }
    out.innerHTML = rows.join("");
  } catch (err) {
    out.innerHTML = row("bad", esc((err as Error).message));
  } finally {
    button.disabled = false;
    button.textContent = "Publish to relays";
  }
}

/* Publishing the proof also refreshes the sell form, so a domain proved just
   now is immediately listable without a reload. */
async function afterProof(): Promise<void> {
  await loadMine();
  if (state.mine.length > 0) {
    $("#sell-domain").innerHTML = state.mine
      .map((e) => `<option value="${esc(e.domain)}">${esc(e.domain)}</option>`)
      .join("");
    $("#sell-form").hidden = false;
    $("#sell-pick").innerHTML = row("good",
      `${state.mine.length} proven domain${state.mine.length === 1 ? "" : "s"} on this key.`);
  }
}

/* ------------------------------------------------------------- wiring ---*/

initTheme();
initConnect();

onSessionChange((pubkey) => {
  $("#sell").textContent = "List a domain";
  if (!pubkey) $("#sell-section").hidden = true;
  render();
});

$("#sell").addEventListener("click", openSell);
$("#domain-form").addEventListener("submit", checkName);
$("#sign-btn").addEventListener("click", signProof);
$("#verify-btn").addEventListener("click", verifyZone);
$("#publish-btn").addEventListener("click", publish);

document.addEventListener("click", (e) => {
  const copy = (e.target as Element).closest<HTMLElement>("[data-copy]");
  if (copy) copyToClipboard($(`#${copy.dataset.copy}`).textContent!);
});
$("#sell-close").addEventListener("click", () => ($("#sell-section").hidden = true));
$("#sell-form").addEventListener("submit", publishListing);
$("#sort").addEventListener("change", (e) => { state.sort = (e.target as HTMLSelectElement).value; render(); });
$("#show-unverified").addEventListener("change", (e) => {
  state.showUnverified = (e.target as HTMLInputElement).checked;
  render();
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = (e.target as HTMLInputElement).value.trim().toLowerCase(); render(); }, 160);
});

$("#tlds").addEventListener("click", (e) => {
  const chip = (e.target as Element).closest<HTMLElement>("[data-tld]");
  if (!chip) return;
  state.tld = chip.dataset.tld || null;
  render();
});

$("#grid").addEventListener("click", (e) => {
  const featureBtn = (e.target as Element).closest<HTMLElement>("[data-feature]");
  if (featureBtn) return featureListing(featureBtn.dataset.feature!);
  const shareBtn = (e.target as Element).closest<HTMLElement>("[data-share]");
  if (shareBtn) return share(shareBtn.dataset.share!);
  const seller = (e.target as Element).closest<HTMLElement>("[data-seller]");
  if (seller) { location.href = `flex.html?p=${npubEncode(seller.dataset.seller!)}`; return; }
  const delistBtn = (e.target as Element).closest<HTMLElement>("[data-delist]");
  if (delistBtn) delist(delistBtn.dataset.delist!);
});

load();
