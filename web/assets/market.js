// Generated from web/src/market.ts by scripts/build-web.ts. Edit that file instead.
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
  verifyPortfolio
} from "./fmd.js";
import {
  $,
  DISCOVERY_RELAYS,
  ZAP_RECEIPT_RELAYS,
  ageText,
  askDialog,
  closeDialog,
  copyToClipboard,
  esc,
  initConnect,
  initTheme,
  now,
  onSessionChange,
  openConnect,
  row,
  sats,
  session,
  toast
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
  portfolio: [],
  mine: [],
  portfolioKnown: false
};
async function load() {
  state.loading = true;
  render();
  const [events, count] = await Promise.all([
    queryDiscovery(DISCOVERY_RELAYS, [listingFilter({ limit: 500 })], { timeoutMs: 6000 }).catch(() => []),
    countOnRelays(DISCOVERY_RELAYS, [listingFilter()]).catch(() => {
      return;
    })
  ]);
  state.total = count;
  const current = newestPerAddress(events);
  const authors = [...new Set(current.map((e) => e.pubkey))];
  const deletions = authors.length ? await queryRelays(DISCOVERY_RELAYS, [deletionFilter(authors)], { timeoutMs: 4000 }).catch(() => []) : [];
  const live = applyDeletions(current, deletions);
  state.listings = live.map((event) => {
    const parsed = parseListing(event);
    return parsed.ok ? { event, listing: parsed.listing, check: null, live: null } : null;
  }).filter(Boolean);
  state.loading = false;
  render();
  await Promise.all(state.listings.map(async (entry) => {
    const report = await checkDomainProof({
      domain: entry.listing.domain,
      pubkey: entry.event.pubkey,
      dnsOnly: true
    }).catch(() => null);
    entry.live = report;
    entry.check = checkListing({ event: entry.event, dnsProof: report?.dns, now: now() });
    render();
  }));
}
const verified = (entry) => entry.check?.ok === true;
function visible() {
  let rows = state.listings.filter((entry) => state.showUnverified ? true : verified(entry));
  if (state.tld)
    rows = rows.filter((e) => tldOf(e.listing.domain) === state.tld);
  if (state.search) {
    const q = state.search.toLowerCase();
    rows = rows.filter((e) => e.listing.domain.includes(q) || e.listing.summary.toLowerCase().includes(q));
  }
  const by = {
    "price-desc": (a, b) => b.listing.priceSats - a.listing.priceSats,
    "price-asc": (a, b) => a.listing.priceSats - b.listing.priceSats,
    newest: (a, b) => b.listing.publishedAt - a.listing.publishedAt,
    "oldest-domain": (a, b) => (a.listing.registeredAt ?? 1 / 0) - (b.listing.registeredAt ?? 1 / 0),
    az: (a, b) => a.listing.domain.localeCompare(b.listing.domain)
  };
  return [...rows].sort(by[state.sort] ?? by["price-desc"]);
}
function renderTlds() {
  const counts = new Map;
  for (const entry of state.listings) {
    if (!state.showUnverified && !verified(entry))
      continue;
    const tld = tldOf(entry.listing.domain);
    counts.set(tld, (counts.get(tld) ?? 0) + 1);
  }
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  $("#tlds").innerHTML = chips.length ? `<button class="chip" type="button" data-tld="" aria-pressed="${!state.tld}">All</button>` + chips.map(([tld, n]) => `<button class="chip" type="button" data-tld="${esc(tld)}" aria-pressed="${state.tld === tld}">.${esc(tld)} ${n}</button>`).join("") : "";
}
function render() {
  const rows = visible();
  const checked = state.listings.filter((e) => e.check !== null).length;
  const good = state.listings.filter(verified).length;
  $("#count").textContent = state.loading ? "Asking the relays…" : `${good} verified of ${state.listings.length} fetched` + (checked < state.listings.length ? ` · checking ${state.listings.length - checked} more` : "") + (state.total !== undefined ? ` · ${state.total} on the relays` : "");
  renderTlds();
  const grid = $("#grid");
  if (state.loading) {
    grid.innerHTML = `<p class="empty">Asking ${DISCOVERY_RELAYS.length} relays…</p>`;
    return;
  }
  if (rows.length === 0) {
    grid.innerHTML = `<p class="empty">${state.listings.length === 0 ? "No listings on these relays yet. Be the first: prove a domain, then list it." : "Nothing matches. Clear the search or the TLD filter."}</p>`;
    return;
  }
  grid.innerHTML = rows.map((entry) => {
    const l = entry.listing;
    const ok = verified(entry);
    const mine = entry.event.pubkey === session.pubkey;
    const tags = [];
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
      seller: npubEncode(entry.event.pubkey)
    }).toString()}">Buy</a>` : ""}
        <button class="btn btn-ghost" type="button" data-feature="${esc(l.domain)}">Feature</button>
        <button class="btn btn-ghost" type="button" data-share="${esc(l.domain)}">Share</button>
        <button class="btn btn-ghost" type="button" data-seller="${esc(entry.event.pubkey)}">Seller</button>
        ${mine ? `<button class="btn btn-ghost" type="button" data-delist="${esc(l.domain)}">Delist</button>` : ""}
      </div>
    </article>`;
  }).join("");
}
async function loadMine() {
  state.portfolioKnown = false;
  if (!session.pubkey) {
    state.portfolio = [];
    state.mine = [];
    return;
  }
  const pubkey = session.pubkey;
  await directory.resolve([pubkey]).catch(() => {});
  const relays = [...new Set([...directory.readRelays(pubkey), ...DISCOVERY_RELAYS])];
  let completed = 0;
  const events = await queryRelays(relays, [portfolioFilter(pubkey)], {
    timeoutMs: 5000,
    onRelayDone: (_relay, _count, _error, complete) => {
      if (complete)
        completed++;
    }
  }).catch(() => []);
  if (session.pubkey !== pubkey)
    return;
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
  const verdicts = verifyPortfolio(parsed.portfolio);
  state.portfolio = parsed.portfolio.entries;
  state.mine = parsed.portfolio.entries.map((entry, i) => ({ ...entry, proven: verdicts[i].proven })).filter((entry) => entry.proven && entry.iat !== undefined && entry.sig !== undefined);
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
      hint.textContent = `The zone no longer carries your proof: ${live.status.reason}. Re-prove it with "Prove a new domain" below.`;
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
  const entry = state.listings.find((e) => e.listing.domain === domain && e.event.pubkey === session.pubkey);
  if (!entry || !session.signer)
    return;
  askDialog("Delist this domain", `<p>Two things happen, and they are not equally reliable:</p>
     <p><b>1. The listing is republished as <code>sold</code>.</b> This is the authoritative
        signal. It replaces the old event on every relay that carried it.</p>
     <p><b>2. A deletion request is sent.</b> Relays may honour it or ignore it, and anyone
        who already fetched the listing still has it.</p>
     <p>Your DNS record and your portfolio are untouched.</p>`, {
    confirmLabel: "Delist",
    onConfirm: async () => {
      closeDialog();
      try {
        const l = entry.listing;
        const sold = await session.signer.signEvent(buildListing({
          pubkey: session.pubkey,
          domain: l.domain,
          priceSats: l.priceSats,
          summary: l.summary || undefined,
          description: l.description || undefined,
          status: "sold",
          publishedAt: l.publishedAt,
          createdAt: now(),
          proof: l.proof
        }));
        const request = await session.signer.signEvent(buildDeletion({
          pubkey: session.pubkey,
          events: [entry.event],
          reason: "delisted",
          createdAt: now()
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
function share(domain) {
  const entry = state.listings.find((e) => e.listing.domain === domain);
  if (!entry)
    return;
  const naddr = listingAddress(entry.listing, DEFAULT_RELAYS.slice(0, 2));
  askDialog("Share this listing", `<p>This is the listing's identity on Nostr, not a link to a server we run. Any client
        can resolve it from any relay, whether or not this site is still running.</p>
     <div class="nsec" id="naddr">${esc(nostrUri(naddr))}</div>
     <button class="btn btn-ghost btn-sm" type="button" id="copy-naddr">Copy</button>
     <p class="hint">Seller: ${esc(shorten(npubEncode(entry.event.pubkey), 10))}</p>`);
  $("#copy-naddr").addEventListener("click", () => copyToClipboard($("#naddr").textContent));
}
async function featureListing(domain) {
  const entry = state.listings.find((e) => e.listing.domain === domain);
  if (!entry)
    return;
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
  const address = listingAddress(entry.listing, DEFAULT_RELAYS.slice(0, 2));
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
    out.innerHTML = row("good", `<b>Invoice for ${sats(amountSats)} sats.</b> Pay it in any wallet.`) + `<div class="nsec" id="invoice">${esc(invoice.invoice)}</div>
       <div style="display:flex;gap:8px;flex-wrap:wrap">
         <a class="btn btn-accent btn-sm" href="lightning:${esc(invoice.invoice)}">Open in wallet</a>
         <button class="btn btn-ghost btn-sm" type="button" id="copy-invoice">Copy invoice</button>
       </div>
       <p class="hint" style="text-align:left">The board updates when your provider publishes
          the receipt, usually within seconds. We hold nothing at any point.</p>`;
    $("#copy-invoice").addEventListener("click", () => copyToClipboard($("#invoice").textContent));
    go.hidden = true;
  } catch (err) {
    out.innerHTML = row("bad", esc(err.message));
  } finally {
    go.disabled = false;
  }
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
  hint.innerHTML = normalised.unicode !== domain ? `Reading it as <b>${esc(domain)}</b>, which is <b>${esc(normalised.unicode)}</b> in A-label form.` : `Reading it as <b>${esc(domain)}</b>.`;
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
    rows.push(row("", `This TLD publishes no RDAP service, so nothing about the registration
      can be checked. You can still flex the name, but it cannot be escrowed here.`));
  } else if (!reg.eligibility) {
    rows.push(row("", `The registry did not answer. That says nothing about the domain; try again.`));
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
    rows.push(row(e.listable ? "good" : "bad", esc(facts.join(" · "))));
    for (const finding of e.findings) {
      rows.push(row(finding.level === "refuse" ? "bad" : "", esc(finding.message)));
    }
    rows.push(row("", e.unlocked ? `When somebody buys it, the escrow will ask you to turn the transfer lock
         <b>on</b> at your registrar and, once it has seen that, <b>off</b> again. Only the
         registrant can change the lock, so that is how a buyer knows you hold the domain
         and not just its DNS. Listing needs nothing from the registrar.` : `When somebody buys it, the escrow will ask you to turn this transfer lock
         <b>off</b> at your registrar. Only the registrant can change the lock, so that is
         how a buyer knows you hold the domain and not just its DNS. Listing needs nothing
         from the registrar.`));
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
    out.innerHTML = row("bad", esc(err.message));
  } finally {
    button.disabled = false;
    button.textContent = "Check again";
  }
}
async function publish() {
  if (!state.draft?.verified || !session.signer)
    return;
  const button = $("#publish-btn");
  const out = $("#relay-results");
  button.disabled = true;
  button.textContent = "Publishing…";
  out.hidden = false;
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
    const entries = upsertEntry(state.portfolio, {
      domain: state.draft.domain,
      source: state.draft.proof.status.source ?? "dns",
      iat: state.draft.record.iat,
      sig: state.draft.record.sig,
      firstSeen: now()
    });
    const portfolio = await session.signer.signEvent(buildPortfolio({ pubkey: session.pubkey, entries, createdAt: now() }));
    const [proofResults, portfolioResults] = await Promise.all([
      publishOutbox(directory, state.draft.event, { extraRelays: DISCOVERY_RELAYS }),
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
      rows.unshift(row("good", `<b>Published to ${accepted.size} of ${relays.length} relays.</b>
        Your domains live there now, signed by you.`));
      $("#domain").value = "";
      step(1);
      await afterProof();
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
