// Generated from web/src/market.ts by scripts/build-web.ts. Edit that file instead.
import {
  DEFAULT_RELAYS,
  addressOf,
  MSATS_PER_SAT,
  registrarFindings,
  rdapAnswerProblem,
  RelayDirectory,
  buildPortfolio,
  buildZapRequest,
  checkDomain,
  encodeProofRecord,
  fetchLnurlPay,
  invoiceOfferEnds,
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
  neventEncode,
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
  readOwn,
  shorten,
  tldOf,
  verifyPortfolio
} from "./fmd.js";
import {
  $,
  DISCOVERY_RELAYS,
  ZAP_RECEIPT_RELAYS,
  ageText,
  askDialog,
  closeDialog,
  confirmIncompleteRead,
  copyToClipboard,
  esc,
  idnLine,
  initConnect,
  initTheme,
  invoiceBlock,
  now,
  onSessionChange,
  openConnect,
  row,
  sats,
  session,
  toast,
  wireInvoice
} from "./ui.js";
import { CONFIG, featuringEnabled } from "./config.js";
const directory = new RelayDirectory(DISCOVERY_RELAYS);
const state = {
  draft: null,
  listings: [],
  loading: true,
  search: "",
  tld: null,
  sort: "price-desc",
  showUnverified: false,
  total: undefined,
  answered: 0,
  mine: [],
  fresh: null
};
const AUTHORS_KEY = "fmd-market-authors-v1";
const MAX_REMEMBERED = 500;
function rememberedAuthors() {
  try {
    const list = JSON.parse(localStorage.getItem(AUTHORS_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((a) => typeof a === "string" && /^[0-9a-f]{64}$/.test(a)).slice(0, MAX_REMEMBERED) : [];
  } catch {
    return [];
  }
}
function rememberAuthors(authors) {
  try {
    localStorage.setItem(AUTHORS_KEY, JSON.stringify(authors.slice(0, MAX_REMEMBERED)));
  } catch {}
}
const deletionsBy = (relays, authors, onDone) => relays.length && authors.length ? queryRelays(relays, [deletionFilter([...authors])], {
  timeoutMs: 4000,
  onRelayDone: (relay, _count, _error, complete) => {
    if (complete)
      onDone?.(relay);
  }
}).catch(() => []) : Promise.resolve([]);
let loads = 0;
async function load() {
  const call = ++loads;
  state.loading = true;
  state.total = undefined;
  render();
  let answered = 0;
  const remembered = rememberedAuthors();
  const answeredEarly = new Set;
  const early = deletionsBy(DISCOVERY_RELAYS, remembered, (relay) => answeredEarly.add(relay));
  const events = await queryDiscovery(DISCOVERY_RELAYS, [listingFilter({ limit: 500 })], {
    timeoutMs: 6000,
    onRelayDone: (_relay, _count, _error, complete) => {
      if (complete)
        answered++;
    }
  }).catch(() => []);
  if (call !== loads)
    return;
  const current = newestPerAddress(events);
  const authors = [...new Set(current.map((e) => e.pubkey))];
  const seen = new Set(remembered);
  const later = deletionsBy(DISCOVERY_RELAYS, authors.filter((a) => !seen.has(a)));
  const before = await early;
  const again = deletionsBy(DISCOVERY_RELAYS.filter((r) => !answeredEarly.has(r)), authors.filter((a) => seen.has(a)));
  const [after, retried] = await Promise.all([later, again]);
  if (call !== loads)
    return;
  const live = applyDeletions(current, [...before, ...after, ...retried]);
  if (answered)
    rememberAuthors(authors);
  state.answered = answered;
  state.listings = live.map((event) => {
    const parsed = parseListing(event);
    return parsed.ok ? { event, listing: parsed.listing, check: null, live: null } : null;
  }).filter(Boolean);
  const fresh = state.fresh;
  const freshParsed = fresh ? parseListing(fresh) : undefined;
  if (fresh && freshParsed?.ok) {
    const same = (e) => e.event.pubkey === fresh.pubkey && e.listing.domain === freshParsed.listing.domain;
    if (!state.listings.some((e) => same(e) && e.event.created_at >= fresh.created_at)) {
      state.listings = [{ event: fresh, listing: freshParsed.listing, check: null, live: null }, ...state.listings.filter((e) => !same(e))];
    }
  }
  state.loading = false;
  render();
  countOnRelays(DISCOVERY_RELAYS, [listingFilter()]).catch(() => {
    return;
  }).then((count) => {
    if (call !== loads || count === undefined)
      return;
    state.total = count;
    render();
  });
  await Promise.all(state.listings.filter(forSale).map(async (entry) => {
    const report = await checkDomainProof({
      domain: entry.listing.domain,
      pubkey: entry.event.pubkey,
      dnsOnly: true
    }).catch(() => null);
    entry.live = report;
    entry.check = checkListing({ event: entry.event, dnsProof: report?.dns, now: now() });
    if (call === loads)
      render();
  }));
}
const verified = (entry) => entry.check?.ok === true;
const forSale = (entry) => entry.listing.status !== "sold";
function matchesFilter(entry) {
  if (state.tld && tldOf(entry.listing.domain) !== state.tld)
    return false;
  if (!state.search)
    return true;
  const q = state.search.toLowerCase();
  return entry.listing.domain.includes(q) || entry.listing.summary.toLowerCase().includes(q);
}
function visible() {
  const isFresh = (entry) => entry.event.id === state.fresh?.id;
  const rows = state.listings.filter((entry) => forSale(entry) && (state.showUnverified || verified(entry) || isFresh(entry) && entry.check === null) && matchesFilter(entry));
  const by = {
    "price-desc": (a, b) => b.listing.priceSats - a.listing.priceSats,
    "price-asc": (a, b) => a.listing.priceSats - b.listing.priceSats,
    newest: (a, b) => b.listing.publishedAt - a.listing.publishedAt,
    "oldest-domain": (a, b) => (a.listing.registeredAt ?? 1 / 0) - (b.listing.registeredAt ?? 1 / 0),
    az: (a, b) => a.listing.domain.localeCompare(b.listing.domain)
  };
  const sorted = [...rows].sort(by[state.sort] ?? by["price-desc"]);
  return [...sorted.filter(isFresh), ...sorted.filter((e) => !isFresh(e))];
}
function renderTlds() {
  const counts = new Map;
  for (const entry of state.listings) {
    if (!forSale(entry) || !state.showUnverified && !verified(entry))
      continue;
    const tld = tldOf(entry.listing.domain);
    counts.set(tld, (counts.get(tld) ?? 0) + 1);
  }
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  $("#tlds").innerHTML = chips.length ? `<button class="chip" type="button" data-tld="" aria-pressed="${!state.tld}">All</button>` + chips.map(([tld, n]) => `<button class="chip" type="button" data-tld="${esc(tld)}" aria-pressed="${state.tld === tld}">.${esc(tld)} ${n}</button>`).join("") : "";
}
function render() {
  const rows = visible();
  const selling = state.listings.filter(forSale);
  const pending = selling.filter((e) => e.check === null).length;
  const good = selling.filter(verified).length;
  const sold = state.listings.length - selling.length;
  const unchecked = selling.filter((e) => e.check !== null && e.live?.answered !== true).length;
  $("#count").textContent = state.loading ? "Asking the relays…" : `${good} verified of ${selling.length} for sale` + (pending ? ` · checking ${pending} more` : "") + (unchecked ? ` · ${unchecked} not checked, a DNS resolver didn't answer` : "") + (sold ? ` · ${sold} sold` : "") + (state.total !== undefined ? ` · ${state.total} on the relays` : "");
  renderTlds();
  const grid = $("#grid");
  if (state.loading) {
    grid.innerHTML = `<p class="empty">Asking ${DISCOVERY_RELAYS.length} relays…</p>`;
    return;
  }
  if (rows.length === 0) {
    const waiting = selling.filter((e) => e.check === null && matchesFilter(e)).length;
    grid.innerHTML = `<p class="empty">${selling.length === 0 ? sold ? "Nothing for sale right now: every listing on these relays is sold. Prove a domain, then list it." : state.answered === 0 ? "The relays didn't answer, so no listings could be read. Reload in a minute." : "No listings on these relays yet. Be the first: prove a domain, then list it." : waiting ? `Checking ${waiting === 1 ? "a listing" : `${waiting} listings`} against the domain's DNS…` : state.search || state.tld ? "Nothing matches. Clear the search or the TLD filter." : 'None of these listings passed its check. Tick "Show unverified listings" under What this page checked to see them, and why.'}</p>`;
    return;
  }
  grid.innerHTML = rows.map((entry) => {
    const l = entry.listing;
    const ok = verified(entry);
    const mine = entry.event.pubkey === session.pubkey;
    const fresh = entry.event.id === state.fresh?.id;
    const tags = [];
    if (fresh)
      tags.push(`<span class="tag fresh">just listed</span>`);
    if (ok)
      tags.push(`<span class="tag proven">✓ proof verified</span>`);
    else if (entry.check)
      tags.push(`<span class="tag unproven">unverified</span>`);
    else
      tags.push(`<span class="tag">checking…</span>`);
    if (entry.live?.dnssec)
      tags.push(`<span class="tag dnssec">DNSSEC</span>`);
    if (l.registeredAt)
      tags.push(`<span class="tag">registered ${ageText(l.registeredAt)} ago</span>`);
    if (l.status === "sold")
      tags.push(`<span class="tag">sold</span>`);
    tags.push(`<span class="tag">.${esc(tldOf(l.domain))}</span>`);
    return `<article class="listing${ok ? "" : " unverified"}${fresh ? " fresh" : ""}">
      <div class="listing-top">
        <div class="listing-name">${esc(l.domain)}${idnLine(l.domain)}</div>
        <div class="listing-price">${sats(l.priceSats)}<small>sats</small></div>
      </div>
      ${l.summary ? `<p class="listing-summary">${esc(l.summary)}</p>` : ""}
      ${!ok && entry.check ? `<p class="listing-why">${esc(entry.check.reason ?? "did not verify")}</p>` : ""}
      <div class="listing-meta">${tags.join("")}</div>
      <div class="listing-actions">
        ${!mine && ok && l.status !== "sold" ? `<a class="btn btn-accent" href="escrow.html?${new URLSearchParams({
      domain: l.domain,
      amount: String(l.priceSats),
      seller: npubEncode(entry.event.pubkey)
    }).toString()}">Buy</a>` : ""}
        <button class="btn btn-ghost" type="button" data-feature="${esc(entry.event.id)}">Feature</button>
        <button class="btn btn-ghost" type="button" data-share="${esc(entry.event.id)}">Share</button>
        <button class="btn btn-ghost" type="button" data-seller="${esc(entry.event.pubkey)}">Seller</button>
        ${mine && l.status !== "sold" ? `<button class="btn btn-ghost" type="button" data-delist="${esc(l.domain)}">Delist</button>` : ""}
      </div>
    </article>`;
  }).join("");
}
async function readMine(pubkey) {
  const read = await readOwn(directory, pubkey, [portfolioFilter(pubkey)], { extraRelays: DISCOVERY_RELAYS, timeoutMs: 5000 });
  const newest = newestPerAddress(read.events)[0];
  const none = { read, portfolio: [], mine: [], at: newest?.created_at ?? 0, problem: null };
  if (!newest)
    return none;
  const parsed = parsePortfolio(newest);
  if (!parsed.ok)
    return { ...none, problem: parsed.reason };
  const verdicts = verifyPortfolio(parsed.portfolio);
  return {
    ...none,
    portfolio: parsed.portfolio.entries,
    mine: parsed.portfolio.entries.map((entry, i) => ({ ...entry, proven: verdicts[i].proven })).filter((entry) => entry.proven && entry.iat !== undefined && entry.sig !== undefined),
    problem: parsed.dropped.length ? `${parsed.dropped.length} part${parsed.dropped.length === 1 ? "" : "s"} of it can't be read here: ${parsed.dropped[0].reason}` : null
  };
}
let mineReads = 0;
async function loadMine() {
  const call = ++mineReads;
  const pubkey = session.pubkey;
  if (!pubkey) {
    state.mine = [];
    return;
  }
  const result = await readMine(pubkey);
  if (call !== mineReads || session.pubkey !== pubkey)
    return;
  state.mine = result.mine;
}
async function openSell() {
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
    $("#sell-pick").innerHTML = row("bad", `No proven domains on this key yet. Prove one below (it takes one DNS record)
       and it appears here straight away.`);
    $("#prove").open = true;
    $("#prove").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  $("#sell-pick").innerHTML = row("good", `${state.mine.length} proven domain${state.mine.length === 1 ? "" : "s"} on this key.`);
  $("#sell-domain").innerHTML = state.mine.map((e) => `<option value="${esc(e.domain)}">${esc(e.domain)}</option>`).join("");
  $("#sell-form").hidden = false;
}
async function publishListing(event) {
  event.preventDefault();
  const hint = $("#sell-hint");
  const button = $("#sell-publish");
  const domain = $("#sell-domain").value;
  const entry = state.mine.find((e) => e.domain === domain);
  const priceSats = Number($("#sell-price").value.replace(/[\s,_]/g, ""));
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
    const live = await checkDomainProof({ domain, pubkey: session.pubkey, dnsOnly: true });
    if (!live.status.proven) {
      hint.textContent = live.answered ? `The zone no longer carries your proof: ${live.status.reason}. Re-prove it with "Prove a new domain" below.` : `DNS couldn't be checked: ${live.dns.reason ?? "a resolver didn't answer"}. Your record may still be there; try again in a minute.`;
      hint.className = "hint err";
      return;
    }
    const unsigned = buildListing({
      pubkey: session.pubkey,
      domain,
      priceSats,
      summary: $("#sell-summary").value.trim() || undefined,
      description: $("#sell-description").value.trim() || undefined,
      publishedAt: now(),
      proof: { version: "fmd1", iat: entry.iat, pubkey: session.pubkey, sig: entry.sig }
    });
    const signed = await session.signer.signEvent(unsigned);
    const results = await publishOutbox(directory, signed, { extraRelays: DISCOVERY_RELAYS });
    const accepted = results.filter((r) => r.ok);
    $("#sell-results").hidden = false;
    $("#sell-results").innerHTML = (accepted.length ? row("good", `<b>Published to ${accepted.length} of ${results.length} relays.</b>
             The relays hold the listing now, signed by you. Its Share button gives the link.`) : row("bad", `<b>No relay accepted it.</b> Nothing was published.`)) + results.map((r) => row(r.ok ? "good" : "bad", `<b>${esc(r.relay.replace(/^wss:\/\//, ""))}</b>: ${r.ok ? "accepted" : esc(r.message ?? "refused")}`)).join("");
    if (accepted.length) {
      $("#sell-form").reset();
      state.fresh = signed;
      $("#sell-section").hidden = true;
      $("#sell-results").hidden = true;
      resetProve();
      toast(`${domain} is listed on ${accepted.length} of ${results.length} relays.`);
      $("#grid").scrollIntoView({ behavior: "smooth", block: "start" });
      await load();
    }
  } catch (err) {
    hint.textContent = err.message;
    hint.className = "hint err";
  } finally {
    button.disabled = false;
    button.textContent = "Sign and publish";
  }
}
async function delist(domain) {
  const fresh = state.fresh ? parseListing(state.fresh) : undefined;
  if (fresh?.ok && fresh.listing.domain === domain)
    state.fresh = null;
  const entry = state.listings.find((e) => e.listing.domain === domain && e.event.pubkey === session.pubkey);
  if (!entry || !session.signer)
    return;
  askDialog("Delist this domain", `<p>Two things happen, and they are not equally reliable:</p>
     <p><b>1. The listing is republished as <code>sold</code>.</b> This is the authoritative
        signal. It replaces the old event on your write relays and on the discovery relays.
        A relay this page doesn't reach keeps the old one.</p>
     <p><b>2. A deletion request is sent.</b> Relays may honour it or ignore it, and anyone
        who already fetched the listing still has it.</p>
     <p>Your DNS record and your portfolio are untouched.</p>`, {
    confirmLabel: "Delist",
    onConfirm: async () => {
      closeDialog();
      try {
        const l = entry.listing;
        const at = Math.max(now(), entry.event.created_at + 1);
        const sold = await session.signer.signEvent(buildListing({
          pubkey: session.pubkey,
          domain: l.domain,
          priceSats: l.priceSats,
          summary: l.summary || undefined,
          description: l.description || undefined,
          status: "sold",
          publishedAt: l.publishedAt,
          createdAt: at,
          proof: l.proof
        }));
        const request = await session.signer.signEvent(buildDeletion({
          pubkey: session.pubkey,
          events: [entry.event],
          reason: "delisted",
          createdAt: at - 1
        }));
        const [a, b] = await Promise.all([
          publishOutbox(directory, sold, { extraRelays: DISCOVERY_RELAYS }),
          publishOutbox(directory, request, { extraRelays: DISCOVERY_RELAYS })
        ]);
        toast(`Marked sold on ${a.filter((r) => r.ok).length} relays; deletion requested on ${b.filter((r) => r.ok).length}.`);
        await load();
      } catch (err) {
        toast(err.message);
      }
    }
  });
}
function share(eventId) {
  const entry = state.listings.find((e) => e.event.id === eventId);
  if (!entry)
    return;
  let naddr;
  try {
    naddr = listingAddress(entry.listing, DEFAULT_RELAYS.slice(0, 2));
  } catch {
    naddr = neventEncode({ id: entry.event.id, relays: DEFAULT_RELAYS.slice(0, 2), author: entry.event.pubkey, kind: entry.event.kind });
  }
  askDialog("Share this listing", `<p>This is the listing's identity on Nostr, not a link to a server we run. Any client
        can resolve it from any relay, whether or not this site is still running.</p>
     <div class="nsec" id="naddr">${esc(nostrUri(naddr))}</div>
     <button class="btn btn-ghost btn-sm" type="button" id="copy-naddr">Copy</button>
     <p class="hint">Seller: ${esc(shorten(npubEncode(entry.event.pubkey), 10))}</p>`);
  $("#copy-naddr").addEventListener("click", () => copyToClipboard($("#naddr").textContent));
}
async function featureListing(eventId) {
  const entry = state.listings.find((e) => e.event.id === eventId);
  if (!entry)
    return;
  const domain = entry.listing.domain;
  if (!featuringEnabled()) {
    askDialog("Flex payments aren't on yet", `<p>This site hasn't switched on payments for the flex board yet, so there is
          nowhere to send a payment the board could count.</p>
       <p>The listing stays on the market either way. Featuring only changes where
          it ranks on the flex board.</p>`);
    return;
  }
  if (!session.pubkey) {
    openConnect();
    return;
  }
  const address = addressOf(entry.event);
  askDialog(`Feature ${domain}`, `<p>Rank is sats zapped inside a rolling week. This pays
        <b>${esc(CONFIG.featuredLightningAddress)}</b> and tags the payment with this
        listing, so the receipt is public and anyone can re-count the board.</p>
     <label style="display:block;font-size:12px;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Amount in sats</label>
     <input type="text" id="zap-amount" inputmode="numeric" value="1000" autocomplete="off">
     <label style="display:block;font-size:12px;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Comment, optional</label>
     <input type="text" id="zap-comment" maxlength="180" placeholder="Good name." autocomplete="off">
     <div id="zap-out"></div>`, {
    confirmLabel: "Get an invoice",
    onConfirm: () => requestInvoice(domain, address)
  });
}
async function requestInvoice(domain, address) {
  const out = $("#zap-out");
  const amountSats = Number($("#zap-amount").value.replace(/[\s,_]/g, ""));
  const comment = $("#zap-comment").value.trim();
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    out.innerHTML = row("bad", "Amount must be a whole number of sats.");
    return;
  }
  out.innerHTML = row("", "Asking the lightning provider…");
  const go = $("#key-go");
  go.disabled = true;
  try {
    const lnurl = await fetchLnurlPay(CONFIG.featuredLightningAddress);
    if (!lnurl.ok) {
      out.innerHTML = row("bad", `The lightning address did not answer: ${esc(lnurl.reason)}.`);
      return;
    }
    if (!lnurl.info.allowsNostr) {
      out.innerHTML = row("bad", `That address does not support zaps, so no receipt would be written and the
         board could never count this payment. Nothing was charged.`);
      return;
    }
    const amountMsats = amountSats * MSATS_PER_SAT;
    const unsigned = buildZapRequest({
      pubkey: session.pubkey,
      recipient: CONFIG.featuredRecipientPubkey.trim().toLowerCase(),
      amountMsats,
      relays: ZAP_RECEIPT_RELAYS,
      flexDomain: domain,
      address,
      lnurl: lnurl.url,
      comment: comment || undefined,
      createdAt: now()
    });
    const zapRequest = await session.signer.signEvent(unsigned);
    const invoice = await requestZapInvoice({
      info: lnurl.info,
      amountMsats,
      zapRequest,
      lnurl: lnurl.url
    });
    if (!invoice.ok) {
      out.innerHTML = row("bad", `The provider refused: ${esc(invoice.reason)}.`);
      return;
    }
    if (!out.isConnected)
      return;
    const endsAt = invoiceOfferEnds(invoice.invoice, now());
    out.innerHTML = row("good", `<b>Invoice for ${sats(amountSats)} sats.</b> Pay it with any Lightning wallet.`) + invoiceBlock(invoice.invoice, { endsAt }) + `<p class="hint" style="text-align:left">The board updates when your provider publishes
          the receipt, usually within seconds. We hold nothing at any point.</p>`;
    wireInvoice(out, invoice.invoice, { endsAt });
    go.hidden = true;
  } catch (err) {
    out.innerHTML = row("bad", esc(err.message));
  } finally {
    if (out.isConnected)
      go.disabled = false;
  }
}
function resetProve() {
  state.draft = null;
  $("#domain").value = "";
  $("#domain-hint").textContent = "";
  for (const id of ["#registry", "#observations", "#relay-results"]) {
    $(id).hidden = true;
    $(id).innerHTML = "";
  }
  $("#record").hidden = true;
  step(1);
  $("#prove").open = false;
}
function step(n) {
  document.querySelectorAll(".step").forEach((el) => {
    const i = Number(el.dataset.step);
    el.classList.toggle("on", i === n);
    if (i < n)
      el.classList.add("done");
    if (i >= n)
      el.classList.remove("done");
  });
}
async function checkName(event) {
  event.preventDefault();
  const hint = $("#domain-hint");
  const normalised = tryNormaliseDomain($("#domain").value);
  if (!normalised.ok) {
    hint.textContent = normalised.reason;
    hint.className = "hint err";
    return;
  }
  const domain = normalised.domain;
  hint.className = "hint";
  hint.innerHTML = normalised.unicode !== domain ? `Reading it as <b>${esc(normalised.unicode)}</b>, which is <b>${esc(domain)}</b> in A-label form.` : `Reading it as <b>${esc(domain)}</b>.`;
  $("#check-btn").disabled = true;
  $("#check-btn").textContent = "Checking…";
  const registry = $("#registry");
  registry.hidden = false;
  registry.innerHTML = row("", "Asking the registry and the resolvers…");
  try {
    const { proof, registry: reg } = await checkDomain({ domain, pubkey: session.pubkey });
    state.draft = { domain, proof, registry: reg, record: null, verified: false };
    registry.innerHTML = renderRegistry(reg, proof);
    step(2);
  } catch (err) {
    registry.innerHTML = row("bad", esc(err.message));
  } finally {
    $("#check-btn").disabled = false;
    $("#check-btn").textContent = "Check";
  }
}
function renderRegistry(reg, proof) {
  const rows = [];
  if (!reg.supported) {
    rows.push(row("", `This TLD publishes no RDAP service over HTTPS, so nothing about the registration
      can be checked. You can still flex the name, but it cannot be escrowed here.`));
  } else if (!reg.eligibility) {
    const s = reg.snapshot;
    rows.push(s.status === 404 ? row("bad", `The registry says this domain isn't registered.`) : !s.ok ? row("", `The registry did not answer${s.status ? ` (HTTP ${s.status})` : s.error ? ` (${esc(s.error)})` : ""}. That
            says nothing about the domain; try again.`) : row("", `The registry's answer wasn't usable: ${esc(rdapAnswerProblem(s.response, reg.domain) ?? "it could not be read")}.
            That says nothing about the domain; try again.`));
  } else {
    const e = reg.eligibility;
    const f = e.facts;
    const facts = [];
    if (f.registrarName)
      facts.push(`registrar ${f.registrarName}`);
    if (e.daysSinceRegistration !== undefined)
      facts.push(`registered ${ageText(f.registration)} ago`);
    if (e.daysUntilExpiry !== undefined)
      facts.push(`expires in ${Math.floor(e.daysUntilExpiry)}d`);
    facts.push(e.unlocked ? "transfer lock off" : "transfer lock on");
    const findings = registrarFindings(f, now());
    rows.push(row(findings.some((x) => x.level === "refuse") ? "bad" : "good", esc(facts.join(" · "))));
    for (const finding of findings) {
      rows.push(row(finding.level === "refuse" ? "bad" : "", esc(finding.message)));
    }
    rows.push(row("", `When somebody buys it, they pay into the escrow, and you transfer the domain straight
      to them${f.registrarName ? `: to their account at ${esc(f.registrarName)}, or with a transfer code to their
      own registrar` : ", the registrar's usual way"}. Their confirmation pays you. Listing needs nothing from the
      registrar.`));
  }
  if (proof.status.proven) {
    rows.push(row("good", `This domain already proves your key, so you can publish it straight away.`));
  }
  return rows.join("");
}
async function signProof() {
  if (!state.draft || !session.signer)
    return;
  const button = $("#sign-btn");
  button.disabled = true;
  button.textContent = "Waiting for your signer…";
  try {
    const iat = now();
    const signed = await session.signer.signEvent(proofEvent({ domain: state.draft.domain, pubkey: session.pubkey, iat }));
    const record = { version: "fmd1", iat, pubkey: session.pubkey, sig: signed.sig };
    state.draft.record = record;
    state.draft.event = signed;
    $("#record-name").textContent = proofRecordName(state.draft.domain);
    $("#record-value").textContent = encodeProofRecord(record);
    $("#record").hidden = false;
    button.textContent = "Sign again";
    step(3);
  } catch (err) {
    toast(err.message);
    button.textContent = "Sign the proof";
  } finally {
    button.disabled = false;
  }
}
async function verifyZone() {
  if (!state.draft)
    return;
  const button = $("#verify-btn");
  const out = $("#observations");
  button.disabled = true;
  button.textContent = "Resolving…";
  out.hidden = false;
  out.innerHTML = row("", "Querying two independent resolvers…");
  try {
    const report = await checkDomainProof({ domain: state.draft.domain, pubkey: session.pubkey });
    state.draft.proof = report;
    state.draft.verified = report.status.proven;
    const rows = report.lookup.observations.map((o) => row(o.error ? "" : o.records.length ? "good" : "bad", `<b>${esc(o.provider)}</b>: ${o.error ? `did not answer (${esc(o.error)})` : `${o.records.length} TXT record${o.records.length === 1 ? "" : "s"}${o.dnssec ? ", DNSSEC validated" : ""}`}`));
    if (report.status.proven) {
      rows.push(row("good", report.status.source === "nip05" ? `<b>Proven.</b> <code>${esc(report.nip05Url ?? "nostr.json")}</code> maps <code>_</code> to your key.
            That shows control of the web server, not the zone.` : `<b>Proven.</b> Both resolvers returned a record that verifies
            for your key${report.dnssec ? ", over a validated DNSSEC chain" : ""}.`));
      step(4);
    } else if (!report.lookup.complete) {
      rows.push(row("bad", `A resolver did not answer, and a record counts only when both return it.
        Check again shortly.`));
    } else if (report.lookup.disputed.length) {
      rows.push(row("bad", `One resolver sees the record and the other does not. That is
        normal for a few minutes after you add it; check again shortly.`));
    } else {
      rows.push(row("bad", `No record verified yet${report.dns.reason ? `: ${esc(report.dns.reason)}` : ""}.
        DNS changes can take a few minutes.`));
    }
    out.innerHTML = rows.join("");
  } catch (err) {
    out.innerHTML = row("bad", esc(err.message));
  } finally {
    button.disabled = false;
    button.textContent = "Check again";
  }
}
async function publish() {
  if (!state.draft?.verified || !session.signer || !session.pubkey)
    return;
  const draft = state.draft;
  const pubkey = session.pubkey;
  const signer = session.signer;
  const button = $("#publish-btn");
  const out = $("#relay-results");
  button.disabled = true;
  button.textContent = "Publishing…";
  out.hidden = false;
  const stop = (html) => {
    out.innerHTML = row("bad", html);
    button.disabled = false;
    button.textContent = "Publish to relays";
  };
  out.innerHTML = row("", "Reading your current portfolio first…");
  const current = await readMine(pubkey);
  if (session.pubkey !== pubkey) {
    stop("<b>Nothing was published.</b> The connected key changed.");
    return;
  }
  if (current.problem) {
    stop(`<b>Nothing was published.</b> This page can't read all of your newest portfolio
      (${esc(current.problem)}), and publishing would replace it, dropping what it can't read.`);
    return;
  }
  const read = current.read;
  const go = read.answered > 0 && (read.complete || await confirmIncompleteRead("portfolio", read));
  if (!go || session.pubkey !== pubkey) {
    stop(`<b>Nothing was published.</b> ${session.pubkey !== pubkey ? "The connected key changed." : read.answered ? "Not every relay answered, so this page can't be sure it sees your current portfolio." : "No relay answered, so this page can't see your current portfolio at all."}
      Your proof is still valid in DNS. Try again in a minute.`);
    return;
  }
  out.innerHTML = row("", "Signing your portfolio…");
  try {
    const entries = upsertEntry(current.portfolio, {
      domain: draft.domain,
      source: draft.proof.status.source ?? "dns",
      iat: draft.record.iat,
      sig: draft.record.sig,
      firstSeen: now()
    });
    const portfolio = await signer.signEvent(buildPortfolio({ pubkey, entries, createdAt: Math.max(now(), current.at + 1) }));
    const [proofResults, portfolioResults] = await Promise.all([
      publishOutbox(directory, draft.event, { extraRelays: DISCOVERY_RELAYS }),
      publishOutbox(directory, portfolio, { extraRelays: DISCOVERY_RELAYS })
    ]);
    const relays = [...new Set([...proofResults, ...portfolioResults].map((r) => r.relay))];
    const accepted = new Set;
    const rows = [];
    for (const relay of relays) {
      const a = proofResults.find((r) => r.relay === relay);
      const b = portfolioResults.find((r) => r.relay === relay);
      const ok = a?.ok && b?.ok;
      if (ok)
        accepted.add(relay);
      rows.push(row(ok ? "good" : "bad", `<b>${esc(relay.replace(/^wss:\/\//, ""))}</b>: ${ok ? "accepted both events" : esc(b?.message || a?.message || "refused")}`));
    }
    if (accepted.size === 0) {
      rows.unshift(row("bad", `<b>No relay accepted it.</b> Your proof is still valid (it is
        in DNS), but nothing has been published. Try again.`));
    } else {
      await afterProof();
      resetProve();
      if (state.mine.some((e) => e.domain === draft.domain))
        $("#sell-domain").value = draft.domain;
      toast(`${draft.domain} is proven. Set a price and list it.`);
      $("#sell-form").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    out.innerHTML = rows.join("");
  } catch (err) {
    out.innerHTML = row("bad", esc(err.message));
  } finally {
    button.disabled = false;
    button.textContent = "Publish to relays";
  }
}
async function afterProof() {
  await loadMine();
  if (state.mine.length > 0) {
    $("#sell-domain").innerHTML = state.mine.map((e) => `<option value="${esc(e.domain)}">${esc(e.domain)}</option>`).join("");
    $("#sell-form").hidden = false;
    $("#sell-pick").innerHTML = row("good", `${state.mine.length} proven domain${state.mine.length === 1 ? "" : "s"} on this key.`);
  }
}
initTheme();
initConnect();
onSessionChange((pubkey) => {
  $("#sell").textContent = "List a domain";
  if (!pubkey)
    $("#sell-section").hidden = true;
  render();
});
$("#sell").addEventListener("click", openSell);
$("#domain-form").addEventListener("submit", checkName);
$("#sign-btn").addEventListener("click", signProof);
$("#verify-btn").addEventListener("click", verifyZone);
$("#publish-btn").addEventListener("click", publish);
document.addEventListener("click", (e) => {
  const copy = e.target.closest("[data-copy]");
  if (copy)
    copyToClipboard($(`#${copy.dataset.copy}`).textContent);
});
$("#sell-close").addEventListener("click", () => $("#sell-section").hidden = true);
$("#sell-form").addEventListener("submit", publishListing);
$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  render();
});
$("#show-unverified").addEventListener("change", (e) => {
  state.showUnverified = e.target.checked;
  render();
});
let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value.trim().toLowerCase();
    render();
  }, 160);
});
$("#tlds").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-tld]");
  if (!chip)
    return;
  state.tld = chip.dataset.tld || null;
  render();
});
$("#grid").addEventListener("click", (e) => {
  const featureBtn = e.target.closest("[data-feature]");
  if (featureBtn)
    return featureListing(featureBtn.dataset.feature);
  const shareBtn = e.target.closest("[data-share]");
  if (shareBtn)
    return share(shareBtn.dataset.share);
  const seller = e.target.closest("[data-seller]");
  if (seller) {
    location.href = `flex.html?p=${npubEncode(seller.dataset.seller)}`;
    return;
  }
  const delistBtn = e.target.closest("[data-delist]");
  if (delistBtn)
    delist(delistBtn.dataset.delist);
});
load();
