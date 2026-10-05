// Generated from web/src/flex.ts by scripts/build-web.ts. Edit that file instead.
import {
  DEFAULT_RELAYS,
  RelayDirectory,
  checkDomainProof,
  newestPerAddress,
  npubEncode,
  parsePortfolio,
  portfolioFilter,
  queryRelays,
  shorten,
  toPubkeyHex,
  verifyPortfolio,
  attestationFilter,
  parseAttestation,
  tally,
  buildRelayList,
  buildWatchlist,
  fetchRelayInfo,
  identityProofUrl,
  normaliseRelayUrl,
  parseProfile,
  parseRelayList,
  parseWatchlist,
  profileFilter,
  publishOutbox,
  readOwn,
  relayListFilter,
  tryNormaliseDomain,
  buildPortfolio,
  RELAY_LIST_KIND
} from "./fmd.js";
import { CONFIG } from "./config.js";
import {
  $,
  DISCOVERY_RELAYS,
  ageText,
  avatarGradient,
  confirmDialog,
  confirmIncompleteRead,
  copyToClipboard,
  esc,
  idnLine,
  initConnect,
  initTheme,
  now,
  onSessionChange,
  row,
  session,
  toast
} from "./ui.js";
const directory = new RelayDirectory(DISCOVERY_RELAYS);
const state = {
  viewing: null,
  entries: [],
  liveProof: new Map,
  loading: false,
  portfolioAnswered: 0,
  unreadable: null,
  attestations: [],
  profile: null,
  relays: [],
  relayInfo: new Map,
  watch: [],
  identity: null,
  relayListBase: null,
  watchBase: null
};
function pubkeyFromUrl() {
  const url = new URL(location.href);
  const hash = location.hash.replace(/^#/, "");
  let raw = url.searchParams.get("p");
  if (raw === null) {
    try {
      raw = decodeURIComponent(hash);
    } catch {
      raw = hash;
    }
  }
  const pubkey = raw ? toPubkeyHex(raw.trim()) : undefined;
  badLink = !pubkey && (url.searchParams.has("p") || /^(nostr:|npub1|nprofile1|[0-9a-f]{64}$)/i.test(raw.trim()));
  return pubkey;
}
let badLink = false;
async function view(pubkey, { replaceUrl = false } = {}) {
  state.viewing = pubkey;
  state.entries = [];
  state.liveProof.clear();
  state.unreadable = null;
  state.loading = true;
  state.profile = null;
  state.relays = [];
  state.watch = [];
  state.identity = null;
  state.relayListBase = null;
  state.watchBase = null;
  draft.relays = null;
  draft.watch = null;
  if (replaceUrl) {
    const url = new URL(location.href);
    url.searchParams.set("p", npubEncode(pubkey));
    url.hash = "";
    history.replaceState(null, "", url);
  }
  $("#avatar").style.background = avatarGradient(pubkey);
  $("#avatar").hidden = false;
  const npub = npubEncode(pubkey);
  const mine = pubkey === session.pubkey;
  $("#who").textContent = mine ? "Your domains" : "Domains held by";
  $("#npub").innerHTML = `<button type="button" id="copy-npub" title="Copy">${esc(shorten(npub, 12))}</button>`;
  $("#copy-npub").addEventListener("click", () => copyToClipboard(npub, "npub copied."));
  $("#recheck").hidden = false;
  $("#identity-open").hidden = !mine;
  if (!mine)
    $("#identity").hidden = true;
  renderProfile();
  renderIdentity();
  render();
  loadIdentity(pubkey);
  await loadPortfolio(pubkey);
}
async function loadPortfolio(pubkey) {
  state.loading = true;
  render();
  let events = [];
  let answered = 0;
  try {
    await directory.resolve([pubkey], { retryUnsure: true });
    const relays = [...new Set([...directory.readRelays(pubkey), ...DISCOVERY_RELAYS])];
    events = (await queryRelays(relays, [portfolioFilter(pubkey)], {
      timeoutMs: 5000,
      onRelayDone: (_relay, _count, _error, complete) => {
        if (complete)
          answered++;
      }
    })).filter((e) => e.pubkey === pubkey);
  } catch (err) {
    toast(`Relays: ${err.message}`);
  } finally {
    state.loading = false;
  }
  if (state.viewing !== pubkey)
    return;
  state.portfolioAnswered = answered;
  const newest = newestPerAddress(events)[0];
  if (!newest) {
    state.entries = [];
    render();
    return;
  }
  const parsed = parsePortfolio(newest);
  if (!parsed.ok) {
    state.entries = [];
    render();
    toast(`That portfolio event is malformed: ${parsed.reason}`);
    return;
  }
  state.unreadable = parsed.dropped.length ? `${parsed.dropped.length} part${parsed.dropped.length === 1 ? "" : "s"} of this portfolio can't be read here (${parsed.dropped[0].reason})` : null;
  const verdicts = verifyPortfolio(parsed.portfolio);
  state.entries = parsed.portfolio.entries.map((entry, i) => ({
    ...entry,
    signedOk: verdicts[i].proven,
    signedReason: verdicts[i].reason
  }));
  render();
  recheckAll();
  loadAttestations(pubkey);
}
async function loadIdentity(pubkey) {
  let read = { events: [], complete: false, answered: 0, unanswered: [] };
  try {
    read = await readOwn(directory, pubkey, [...profileFilter([pubkey]), relayListFilter([pubkey])], {
      extraRelays: DISCOVERY_RELAYS,
      timeoutMs: 5000
    });
  } catch {}
  if (state.viewing !== pubkey)
    return;
  const newest = newestPerAddress(read.events);
  state.profile = parseProfile(newest.find((e) => e.kind === 0) ?? {}) ?? null;
  const watchEvent = newest.find((e) => parseWatchlist(e) !== undefined);
  state.watch = watchEvent ? parseWatchlist(watchEvent) ?? [] : [];
  state.watchBase = baseOf(watchEvent);
  const listEvent = newest.find((e) => e.kind === RELAY_LIST_KIND);
  state.relays = listEvent ? parseRelayList(listEvent) : [];
  state.relayListBase = baseOf(listEvent);
  state.identity = read;
  draft.relays = null;
  draft.watch = null;
  renderProfile();
  renderIdentity();
  probeRelays();
}
const baseOf = (event) => event ? { id: event.id, createdAt: event.created_at } : null;
function replaces(fresh, base) {
  if (!fresh)
    return false;
  if (!base)
    return true;
  return fresh.created_at > base.createdAt || fresh.created_at === base.createdAt && fresh.id < base.id;
}
const nextAt = (base) => Math.max(now(), (base?.createdAt ?? 0) + 1);
async function probeRelays() {
  const relays = draft.relays ?? state.relays;
  const urls = relays.length ? relays.map((r) => r.url) : [...DEFAULT_RELAYS];
  await Promise.all(urls.map(async (url) => {
    try {
      state.relayInfo.set(url, await fetchRelayInfo(url));
    } catch {
      state.relayInfo.set(url, null);
    }
    renderIdentity();
  }));
}
function renderProfile() {
  const el = $("#profile");
  const p = state.profile;
  if (!p) {
    el.innerHTML = "";
    return;
  }
  const bits = [];
  if (p.displayName || p.name)
    bits.push(`<b>${esc(p.displayName || p.name)}</b>`);
  if (p.nip05)
    bits.push(`<span title="self-attested, not verified here">${esc(p.nip05)}</span>`);
  for (const identity of p.identities) {
    const url = identityProofUrl(identity);
    const label = `${esc(identity.platform)}/${esc(identity.identity)}`;
    bits.push(url ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="Self-attested. Open the proof and check it yourself.">${label}</a>` : `<span title="self-attested, no proof given">${label}</span>`);
  }
  el.innerHTML = bits.length ? bits.join('<span aria-hidden="true">·</span>') : "";
}
async function loadAttestations(pubkey) {
  if (CONFIG.verifiers.length === 0 || state.entries.length === 0)
    return;
  const domains = state.entries.map((e) => e.domain);
  try {
    const events = await queryRelays(DISCOVERY_RELAYS, [attestationFilter({ domains, verifiers: CONFIG.verifiers, since: now() - 7 * 86400 })], { timeoutMs: 5000 });
    if (state.viewing !== pubkey)
      return;
    state.attestations = events.map((e) => parseAttestation(e)).filter((r) => r.ok).map((r) => r.attestation);
    render();
  } catch {}
}
async function recheckAll() {
  const pubkey = state.viewing;
  if (!pubkey)
    return;
  await Promise.all(state.entries.map(async (entry) => {
    try {
      const report = await checkDomainProof({ domain: entry.domain, pubkey });
      if (state.viewing !== pubkey)
        return;
      state.liveProof.set(entry.domain, report);
      render();
    } catch {}
  }));
}
function render() {
  const grid = $("#grid");
  const entries = [...state.entries].sort((a, b) => a.firstSeen - b.firstSeen);
  $("#stats").hidden = entries.length === 0;
  $("#stat-count").textContent = String(entries.length);
  $("#stat-proven").textContent = String(entries.filter((e) => state.liveProof.get(e.domain)?.status.proven).length);
  $("#stat-oldest").textContent = entries.length ? ageText(entries[0].firstSeen) : "—";
  const unreadable = state.unreadable && !state.loading ? row("bad", `${esc(state.unreadable)}. ${entries.length ? "The rest is below, and" : "So"} this page won't republish it.`) : "";
  if (entries.length === 0) {
    grid.innerHTML = unreadable || `<p class="empty">${state.loading ? "Asking the relays…" : !state.viewing ? badLink ? `That link's key isn't a valid npub, so there is no portfolio to show. Check the link, or ${session.pubkey ? `<a href="/flex" id="see-own">see your own</a>` : "connect to see yours"}.` : 'No portfolio open. Connect to see yours, or <a href="/market">prove a domain on the market</a>.' : state.portfolioAnswered === 0 ? "The relays didn't answer, so this portfolio couldn't be read. Reload in a minute." : state.viewing === session.pubkey ? 'No domains yet. Prove one on the <a href="/market">market</a>; it takes one DNS record.' : "This key has not published a portfolio."}</p>`;
    return;
  }
  grid.innerHTML = unreadable + entries.map((entry) => {
    const live = state.liveProof.get(entry.domain);
    const proven = live?.status.proven;
    const stale = live && !proven && live.answered;
    const mine = state.viewing === session.pubkey;
    const tags = [];
    if (proven)
      tags.push(`<span class="tag proven">✓ ${live.status.source === "nip05" ? "NIP-05" : "DNS"}</span>`);
    else if (stale)
      tags.push(`<span class="tag unproven">proof not found</span>`);
    else if (live)
      tags.push(`<span class="tag">resolver unreachable</span>`);
    else
      tags.push(`<span class="tag">checking…</span>`);
    if (live?.dnssec)
      tags.push(`<span class="tag dnssec">DNSSEC</span>`);
    if (CONFIG.verifiers.length > 0) {
      const verdict = tally({
        attestations: state.attestations,
        domain: entry.domain,
        claimant: state.viewing,
        trusted: CONFIG.verifiers,
        threshold: CONFIG.verifierThreshold,
        maxAgeSeconds: 7 * 86400,
        now: now()
      });
      if (verdict.proven) {
        tags.push(`<span class="tag proven">${verdict.agreeing} verifiers agree</span>`);
      } else if (verdict.absent > 0) {
        tags.push(`<span class="tag unproven">${verdict.absent} verifiers disagree</span>`);
      }
    }
    if (!entry.signedOk)
      tags.push(`<span class="tag unproven">unsigned claim</span>`);
    tags.push(`<span class="tag" title="The holder's own date. Nothing can check it.">held ${ageText(entry.firstSeen)}</span>`);
    if (entry.forSale)
      tags.push(`<span class="tag">for sale</span>`);
    return `<article class="domain${stale ? " stale" : ""}">
      <div class="domain-name">${esc(entry.domain)}${idnLine(entry.domain)}</div>
      ${entry.tagline ? `<p class="domain-tagline">${esc(entry.tagline)}</p>` : ""}
      <div class="domain-meta">${tags.join("")}</div>
      ${mine ? `<div class="domain-actions">
        <button class="btn btn-ghost" type="button" data-recheck="${esc(entry.domain)}">Re-check</button>
        <button class="btn btn-ghost" type="button" data-remove="${esc(entry.domain)}" ${writing || state.unreadable ? "disabled" : ""}
          ${state.unreadable ? `title="${esc(state.unreadable)}"` : ""}>Remove</button>
      </div>` : ""}
    </article>`;
  }).join("");
}
const draft = { relays: null, watch: null };
function renderIdentity() {
  const read = state.identity;
  const relays = draft.relays ?? state.relays;
  const known = new Set(relays.map((r) => r.url));
  const shown = relays.length ? relays : DEFAULT_RELAYS.map((url) => ({ url, read: true, write: true }));
  const mark = (r) => !known.has(r.url) ? "fallback" : r.read && r.write ? "yours" : r.read ? "yours, read" : "yours, write";
  $("#relay-list").innerHTML = `<div class="chip-row">` + shown.map((r) => {
    const info = state.relayInfo.get(r.url);
    const down = info === null;
    const name = info && typeof info === "object" && typeof info.name === "string" ? info.name : null;
    return `<span class="chip-x${down ? " down" : ""}" title="${esc(down ? "unreachable" : name ?? r.url)}">
      ${esc(r.url.replace(/^wss:\/\//, ""))}
      <span class="mark">${down ? "down" : mark(r)}</span>
      ${known.has(r.url) ? `<button type="button" data-drop-relay="${esc(r.url)}" aria-label="Remove">&times;</button>` : ""}
    </span>`;
  }).join("") + `</div>` + (!read ? `<p class="hint" style="text-align:left">Reading your relay list from the relays…</p>` : relays.length > 0 ? "" : read.complete ? `<p class="hint" style="text-align:left">${state.relayListBase ? "Your published relay list names no relay this page can use" : "No relay list was found on the relays this page asked"}, so these five are used as a fallback. Add your own
           and your events are read from and written to your relays. Listings, proofs, portfolios and
           these lists still go to the five discovery relays too, so other people can find them.</p>` : `<p class="hint err" style="text-align:left">No relay list was found, but not every relay
           answered, so you may have one there. Reload before publishing one.</p>`);
  const watch = draft.watch ?? state.watch;
  $("#watch-list").innerHTML = !read ? `<p class="hint" style="text-align:left">Reading your watchlist from the relays…</p>` : watch.length ? `<div class="chip-row">` + watch.map((d) => `<span class="chip-x">${esc(d)}
             <button type="button" data-drop-watch="${esc(d)}" aria-label="Remove">&times;</button>
           </span>`).join("") + `</div>` : `<p class="hint" style="text-align:left">Nothing on the watchlist yet.</p>`;
  $("#relay-publish").disabled = !read || writing;
  $("#watch-publish").disabled = !read || writing;
}
let writing = false;
async function exclusively(job) {
  if (writing) {
    toast("Another update is still being published. Wait for it to finish.");
    return;
  }
  writing = true;
  render();
  renderIdentity();
  try {
    await job();
  } finally {
    writing = false;
    render();
    renderIdentity();
  }
}
async function freshBeforeReplace(what, filter, pick, base, hint, reload) {
  const me = session.pubkey;
  hint.className = "hint";
  hint.textContent = `Checking your current ${what} first…`;
  const fresh = await readOwn(directory, me, [filter], { extraRelays: DISCOVERY_RELAYS, timeoutMs: 5000 });
  if (state.viewing !== me || session.pubkey !== me)
    return null;
  const latest = pick(newestPerAddress(fresh.events));
  if (latest && replaces(latest, base)) {
    reload(latest);
    renderIdentity();
    hint.className = "hint err";
    hint.textContent = `Your ${what} changed since this page read it, so nothing was published. The newest one is shown now. Make your change again.`;
    return null;
  }
  if (fresh.answered === 0) {
    hint.className = "hint err";
    hint.textContent = "No relay answered, so nothing was published. Try again in a minute.";
    return null;
  }
  if (!fresh.complete && !await confirmIncompleteRead(what, fresh)) {
    hint.className = "hint";
    hint.textContent = "Nothing was published.";
    return null;
  }
  if (state.viewing !== me || session.pubkey !== me)
    return null;
  hint.textContent = "";
  return { base };
}
async function publishRelayList() {
  const me = session.pubkey;
  const signer = session.signer;
  if (!signer || !me || state.viewing !== me || !state.identity)
    return;
  const entries = draft.relays ?? state.relays;
  const hint = $("#relay-hint");
  const stale = () => state.viewing !== me || session.pubkey !== me;
  if (entries.length === 0) {
    hint.className = "hint err";
    hint.textContent = "Add at least one relay, or there is nowhere to publish the list itself.";
    return;
  }
  await exclusively(async () => {
    try {
      const checked = await freshBeforeReplace("relay list", relayListFilter([me]), (events) => events.find((e) => e.kind === RELAY_LIST_KIND), state.relayListBase, hint, (latest) => {
        state.relays = parseRelayList(latest);
        state.relayListBase = baseOf(latest);
        draft.relays = null;
      });
      if (!checked)
        return;
      if (!checked.base && !await confirmDialog("Publish a first relay list?", `<p>No relay list was found on the relays this page asked. If another app keeps one for this key
       only on relays not asked here, this one replaces it for anyone reading these.</p>`, "Publish")) {
        if (!stale()) {
          hint.className = "hint";
          hint.textContent = "Nothing was published.";
        }
        return;
      }
      if (stale())
        return;
      const event = await signer.signEvent(buildRelayList({ pubkey: me, relays: entries, createdAt: nextAt(checked.base) }));
      const results = await publishOutbox(directory, event, { extraRelays: DISCOVERY_RELAYS });
      if (stale())
        return;
      const ok = results.filter((r) => r.ok);
      $("#relay-out").hidden = false;
      $("#relay-out").innerHTML = (ok.length ? row("good", `<b>Published to ${ok.length} of ${results.length}.</b> Clients will now look
             for your events on the relays you listed.`) : row("bad", "<b>No relay accepted it.</b> Nothing changed.")) + results.filter((r) => !r.ok).map((r) => row("bad", `<b>${esc(r.relay.replace(/^wss:\/\//, ""))}</b>: ${esc(r.message ?? "refused")}`)).join("");
      if (ok.length) {
        state.relays = entries;
        state.relayListBase = baseOf(event);
        draft.relays = null;
        hint.className = "hint";
        hint.textContent = "";
        renderIdentity();
        probeRelays();
      }
    } catch (err) {
      if (stale())
        return;
      hint.className = "hint err";
      hint.textContent = err.message;
    }
  });
}
async function publishWatchlist() {
  const me = session.pubkey;
  const signer = session.signer;
  if (!signer || !me || state.viewing !== me || !state.identity)
    return;
  const domains = draft.watch ?? state.watch;
  const hint = $("#watch-hint");
  const stale = () => state.viewing !== me || session.pubkey !== me;
  await exclusively(async () => {
    try {
      const checked = await freshBeforeReplace("watchlist", profileFilter([me])[1], (events) => events.find((e) => parseWatchlist(e) !== undefined), state.watchBase, hint, (latest) => {
        state.watch = parseWatchlist(latest) ?? [];
        state.watchBase = baseOf(latest);
        draft.watch = null;
      });
      if (!checked)
        return;
      const event = await signer.signEvent(buildWatchlist({ pubkey: me, domains, createdAt: nextAt(checked.base) }));
      const results = await publishOutbox(directory, event, { extraRelays: DISCOVERY_RELAYS });
      if (stale())
        return;
      const ok = results.filter((r) => r.ok).length;
      hint.className = ok ? "hint ok" : "hint err";
      hint.textContent = ok ? `Published to ${ok} of ${results.length} relays.` : "No relay accepted it.";
      if (ok) {
        state.watch = domains;
        state.watchBase = baseOf(event);
        draft.watch = null;
        renderIdentity();
      }
    } catch (err) {
      if (stale())
        return;
      hint.className = "hint err";
      hint.textContent = err.message;
    }
  });
}
async function removeDomain(domain) {
  const me = session.pubkey;
  const signer = session.signer;
  if (!signer || !me || state.viewing !== me || writing)
    return;
  if (!confirm(`Remove ${domain} from your published portfolio?

The DNS record and the proof event stay where they are; this only republishes the list without it.`))
    return;
  await exclusively(() => removeFromPortfolio(domain, me, signer));
}
async function removeFromPortfolio(domain, me, signer) {
  const stale = () => state.viewing !== me || session.pubkey !== me;
  const read = await readOwn(directory, me, [portfolioFilter(me)], { extraRelays: DISCOVERY_RELAYS, timeoutMs: 5000 });
  if (stale())
    return;
  if (read.answered === 0) {
    toast("No relay answered, so nothing changed. Try again in a minute.");
    return;
  }
  const newest = newestPerAddress(read.events)[0];
  const parsed = newest ? parsePortfolio(newest) : undefined;
  if (!newest || !parsed?.ok) {
    toast(newest ? "Your newest portfolio doesn't parse, so nothing changed." : "No portfolio was found, so there is nothing to remove it from.");
    return;
  }
  if (parsed.dropped.length) {
    toast(`This page can't read all of your newest portfolio (${parsed.dropped[0].reason}), so republishing it would drop that part. Nothing changed.`);
    return;
  }
  if (!parsed.portfolio.entries.some((e) => e.domain === domain)) {
    toast(`${domain} is not in your newest portfolio. Showing that one now.`);
    loadPortfolio(me);
    return;
  }
  if (!read.complete && !await confirmIncompleteRead("portfolio", read))
    return;
  if (stale())
    return;
  const entries = parsed.portfolio.entries.filter((e) => e.domain !== domain);
  try {
    const event = await signer.signEvent(buildPortfolio({ pubkey: me, entries, createdAt: nextAt(baseOf(newest)) }));
    const results = await publishOutbox(directory, event, { extraRelays: DISCOVERY_RELAYS });
    const ok = results.filter((r) => r.ok).length;
    if (ok === 0) {
      toast("No relay accepted the update. Nothing changed.");
      return;
    }
    if (stale())
      return;
    state.entries = state.entries.filter((e) => e.domain !== domain);
    state.liveProof.delete(domain);
    render();
    toast(`Removed. Republished to ${ok} of ${results.length} relays.`);
    loadPortfolio(me);
  } catch (err) {
    toast(err.message);
  }
}
initTheme();
initConnect();
onSessionChange((pubkey, restored) => {
  if (pubkey && restored && (state.viewing ? state.viewing !== pubkey : badLink)) {
    render();
  } else if (pubkey) {
    view(pubkey, { replaceUrl: true });
  } else {
    $("#who").textContent = state.viewing ? "Domains held by" : "A domain portfolio";
    render();
  }
});
$("#identity-open").addEventListener("click", () => {
  $("#identity").hidden = false;
  renderIdentity();
  $("#identity").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#identity-close").addEventListener("click", () => $("#identity").hidden = true);
$("#relay-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = normaliseRelayUrl($("#relay-url").value);
  const hint = $("#relay-hint");
  if (!state.identity) {
    hint.className = "hint err";
    hint.textContent = "Still reading your current list. Try again in a moment.";
    return;
  }
  if (!url) {
    hint.className = "hint err";
    hint.textContent = "That is not a websocket URL. Relays look like wss://relay.example.";
    return;
  }
  const current = draft.relays ?? state.relays;
  draft.relays = current.some((r) => r.url === url) ? current : [...current, { url, read: true, write: true }];
  $("#relay-url").value = "";
  hint.className = "hint";
  hint.textContent = "Not published yet.";
  renderIdentity();
  probeRelays();
});
$("#watch-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const parsed = tryNormaliseDomain($("#watch-domain").value);
  const hint = $("#watch-hint");
  if (!state.identity) {
    hint.className = "hint err";
    hint.textContent = "Still reading your current watchlist. Try again in a moment.";
    return;
  }
  if (!parsed.ok) {
    hint.className = "hint err";
    hint.textContent = parsed.reason;
    return;
  }
  const current = draft.watch ?? state.watch;
  draft.watch = current.includes(parsed.domain) ? current : [...current, parsed.domain];
  $("#watch-domain").value = "";
  hint.className = "hint";
  hint.textContent = "Not published yet.";
  renderIdentity();
});
$("#relay-publish").addEventListener("click", publishRelayList);
$("#watch-publish").addEventListener("click", publishWatchlist);
$("#recheck").addEventListener("click", () => {
  toast("Re-checking every domain against DNS…");
  recheckAll();
});
document.addEventListener("click", (event) => {
  if (event.target.closest("#see-own") && session.pubkey) {
    event.preventDefault();
    view(session.pubkey, { replaceUrl: true });
    return;
  }
  const copy = event.target.closest("[data-copy]");
  if (copy)
    return copyToClipboard($(`#${copy.dataset.copy}`).textContent);
  const recheck = event.target.closest("[data-recheck]");
  if (recheck) {
    checkDomainProof({ domain: recheck.dataset.recheck, pubkey: state.viewing }).then((report) => {
      state.liveProof.set(recheck.dataset.recheck, report);
      render();
      toast(report.status.proven ? "Still proven." : `Not proven: ${report.status.reason}`);
    });
    return;
  }
  const remove = event.target.closest("[data-remove]");
  if (remove)
    return removeDomain(remove.dataset.remove);
  const dropRelay = event.target.closest("[data-drop-relay]");
  if (dropRelay) {
    const current = draft.relays ?? state.relays;
    draft.relays = current.filter((r) => r.url !== dropRelay.dataset.dropRelay);
    $("#relay-hint").className = "hint";
    $("#relay-hint").textContent = "Not published yet.";
    renderIdentity();
    return;
  }
  const dropWatch = event.target.closest("[data-drop-watch]");
  if (dropWatch) {
    const current = draft.watch ?? state.watch;
    draft.watch = current.filter((d) => d !== dropWatch.dataset.dropWatch);
    $("#watch-hint").className = "hint";
    $("#watch-hint").textContent = "Not published yet.";
    renderIdentity();
  }
});
const initial = pubkeyFromUrl();
if (initial)
  view(initial);
else
  render();
