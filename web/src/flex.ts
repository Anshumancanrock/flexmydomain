/* flex.html: public portfolio of every domain one Nostr key has proven.
 * No backend. Data comes from relays, DNS and NIP-05, and every entry is
 * verified offline against the portfolio's key.
 */
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
  relayListFilter,
  tryNormaliseDomain,
  buildPortfolio,
} from "./fmd.js";
import type { Attestation, DomainReport, NostrEvent, PortfolioEntry, Profile, RelayEntry } from "./fmd.js";
import { CONFIG } from "./config.js";
import {
  $, DISCOVERY_RELAYS, ageText, avatarGradient, copyToClipboard, esc,
  initConnect, initTheme, now, onSessionChange, row, session, toast,
} from "./ui.js";

const directory = new RelayDirectory(DISCOVERY_RELAYS);

type ShownEntry = PortfolioEntry & { signedOk: boolean; signedReason?: string };

const state: {
  viewing: string | null;
  entries: ShownEntry[];
  liveProof: Map<string, DomainReport>;
  loading: boolean;
  attestations: Attestation[];
  profile: Profile | null;
  relays: RelayEntry[];
  relayInfo: Map<string, { name?: unknown } | null>;
  watch: string[];
} = {
  viewing: null,      // Whose page this is. Works with no key connected.
  entries: [],
  liveProof: new Map(),
  loading: false,
  attestations: [],   // Only from configured verifiers.
  profile: null,
  relays: [],         // NIP-65.
  relayInfo: new Map(),// NIP-11 doc per url, null when unreachable.
  watch: [],          // NIP-51 watchlist.
};

/* A query param works on any static host. Accepts `nostr:`, npub, nprofile or hex. */
function pubkeyFromUrl(): string | undefined {
  const url = new URL(location.href);
  const raw = url.searchParams.get("p") ?? decodeURIComponent(location.hash.replace(/^#/, ""));
  return raw ? toPubkeyHex(raw.trim()) : undefined;
}

async function view(pubkey: string, { replaceUrl = false }: { replaceUrl?: boolean } = {}): Promise<void> {
  state.viewing = pubkey;
  state.entries = [];
  state.liveProof.clear();

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
  if (!mine) $("#identity").hidden = true;
  render();

  await loadPortfolio(pubkey);
}

async function loadPortfolio(pubkey: string): Promise<void> {
  state.loading = true;
  render();

  let events: NostrEvent[] = [];
  try {
    /* Their NIP-65 relays plus the discovery relays. With no relay list,
       readRelays() gives only a few fallbacks. */
    await directory.resolve([pubkey]);
    const relays = [...new Set([...directory.readRelays(pubkey), ...DISCOVERY_RELAYS])];
    events = await queryRelays(relays, [portfolioFilter(pubkey)], { timeoutMs: 5000 });
  } catch (err) {
    toast(`Relays: ${(err as Error).message}`);
  } finally {
    state.loading = false;
  }
  if (state.viewing !== pubkey) return; // User navigated away mid-flight.

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

  /* Relay data. Verify every entry's signature before drawing anything. */
  const verdicts = verifyPortfolio(parsed.portfolio);
  state.entries = parsed.portfolio.entries.map((entry, i) => ({
    ...entry,
    signedOk: verdicts[i].proven,
    signedReason: verdicts[i].reason,
  }));
  render();
  recheckAll();
  loadAttestations(pubkey);
  loadIdentity(pubkey);
}

/* Kind 0 is self-attested and unchecked here. Most NIP-39 platforms send no
 * CORS headers, so identities render as links to check, never verified badges. */
async function loadIdentity(pubkey: string): Promise<void> {
  try {
    const [meta, relayEvents] = await Promise.all([
      queryRelays(DISCOVERY_RELAYS, profileFilter([pubkey]), { timeoutMs: 5000 }),
      queryRelays(DISCOVERY_RELAYS, [relayListFilter([pubkey])], { timeoutMs: 5000 }),
    ]);
    if (state.viewing !== pubkey) return;

    const newest = newestPerAddress(meta);
    state.profile = parseProfile(newest.find((e) => e.kind === 0) ?? ({} as NostrEvent)) ?? null;
    state.watch = parseWatchlist(newest.find((e) => e.kind === 30000 && parseWatchlist(e)) ?? ({} as NostrEvent)) ?? [];

    const listEvent = newestPerAddress(relayEvents)[0];
    state.relays = listEvent ? parseRelayList(listEvent) : [];

    renderProfile();
    renderIdentity();
    probeRelays();
  } catch {
    /* Identity is decoration. A failure says nothing about the domains. */
  }
}

/* NIP-11 probe for the relay panel: which relays are up, and their names. */
async function probeRelays(): Promise<void> {
  const urls = state.relays.length
    ? state.relays.map((r) => r.url)
    : [...DEFAULT_RELAYS];
  await Promise.all(
    urls.map(async (url) => {
      try {
        state.relayInfo.set(url, (await fetchRelayInfo(url)) as { name?: unknown });
      } catch {
        state.relayInfo.set(url, null); // Unreachable, shown as down.
      }
      renderIdentity();
    }),
  );
}

function renderProfile(): void {
  const el = $("#profile");
  const p = state.profile;
  if (!p) {
    el.innerHTML = "";
    return;
  }
  const bits: string[] = [];
  if (p.displayName || p.name) bits.push(`<b>${esc(p.displayName || p.name)}</b>`);
  // Only a claim. Not checked here.
  if (p.nip05) bits.push(`<span title="self-attested, not verified here">${esc(p.nip05)}</span>`);
  for (const identity of p.identities) {
    const url = identityProofUrl(identity);
    const label = `${esc(identity.platform)}/${esc(identity.identity)}`;
    bits.push(url
      ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="Self-attested. Open the proof and check it yourself.">${label}</a>`
      : `<span title="self-attested, no proof given">${label}</span>`);
  }
  el.innerHTML = bits.length ? bits.join('<span aria-hidden="true">·</span>') : "";
}

/* A second opinion beside our own DNS check, never a stand-in. Each
   configured verifier counts once, or one daemon could meet any threshold. */
async function loadAttestations(pubkey: string): Promise<void> {
  if (CONFIG.verifiers.length === 0 || state.entries.length === 0) return;
  const domains = state.entries.map((e) => e.domain);
  try {
    const events = await queryRelays(
      DISCOVERY_RELAYS,
      [attestationFilter({ domains, verifiers: CONFIG.verifiers, since: now() - 7 * 86400 })],
      { timeoutMs: 5000 },
    );
    if (state.viewing !== pubkey) return;
    state.attestations = events
      .map((e) => parseAttestation(e))
      .filter((r) => r.ok)
      .map((r) => (r as { attestation: Attestation }).attestation);
    render();
  } catch {
    /* Missing attestations say nothing against any domain. */
  }
}

/* A signature shows a past claim. DNS shows today. Stale domains stay
   visible, since a buyer needs to see that. */
async function recheckAll(): Promise<void> {
  const pubkey = state.viewing;
  if (!pubkey) return;
  await Promise.all(
    state.entries.map(async (entry) => {
      try {
        const report = await checkDomainProof({ domain: entry.domain, pubkey });
        if (state.viewing !== pubkey) return;
        state.liveProof.set(entry.domain, report);
        render();
      } catch {
        /* A failed lookup is not a negative result. Leave it unknown. */
      }
    }),
  );
}

function render(): void {
  const grid = $("#grid");
  const entries = [...state.entries].sort((a, b) => a.firstSeen - b.firstSeen);

  $("#stats").hidden = entries.length === 0;
  $("#stat-count").textContent = String(entries.length);
  $("#stat-proven").textContent = String(entries.filter((e) => state.liveProof.get(e.domain)?.status.proven).length);
  $("#stat-oldest").textContent = entries.length ? ageText(entries[0].firstSeen) : "—";

  if (entries.length === 0) {
    grid.innerHTML = `<p class="empty">${
      state.loading
        ? "Asking the relays…"
        : !state.viewing
          ? "No portfolio open. Connect a key to see yours, or <a href=\"market.html\">prove a domain on the market</a>."
          : state.viewing === session.pubkey
            ? "No domains yet. Prove one on the <a href=\"market.html\">market</a>; it takes one DNS record."
            : "This key has not published a portfolio."
    }</p>`;
    return;
  }

  grid.innerHTML = entries.map((entry) => {
    const live = state.liveProof.get(entry.domain);
    const proven = live?.status.proven;
    const stale = live && !proven && live.answered;
    const mine = state.viewing === session.pubkey;

    const tags: string[] = [];
    if (proven) tags.push(`<span class="tag proven">✓ ${live!.status.source === "nip05" ? "NIP-05" : "DNS"}</span>`);
    else if (stale) tags.push(`<span class="tag unproven">proof not found</span>`);
    else if (live) tags.push(`<span class="tag">resolver unreachable</span>`);
    else tags.push(`<span class="tag">checking…</span>`);
    if (live?.dnssec) tags.push(`<span class="tag dnssec">DNSSEC</span>`);

    if (CONFIG.verifiers.length > 0) {
      const verdict = tally({
        attestations: state.attestations,
        domain: entry.domain,
        claimant: state.viewing as string,
        trusted: CONFIG.verifiers,
        threshold: CONFIG.verifierThreshold,
        maxAgeSeconds: 7 * 86400,
        now: now(),
      });
      if (verdict.proven) {
        tags.push(`<span class="tag proven">${verdict.agreeing} verifiers agree</span>`);
      } else if (verdict.absent > 0) {
        tags.push(`<span class="tag unproven">${verdict.absent} verifiers disagree</span>`);
      }
    }
    if (!entry.signedOk) tags.push(`<span class="tag unproven">unsigned claim</span>`);
    tags.push(`<span class="tag">held ${ageText(entry.firstSeen)}</span>`);
    if (entry.forSale) tags.push(`<span class="tag">for sale</span>`);

    return `<article class="domain${stale ? " stale" : ""}">
      <div class="domain-name">${esc(entry.domain)}</div>
      ${entry.tagline ? `<p class="domain-tagline">${esc(entry.tagline)}</p>` : ""}
      <div class="domain-meta">${tags.join("")}</div>
      ${mine ? `<div class="domain-actions">
        <button class="btn btn-ghost" type="button" data-recheck="${esc(entry.domain)}">Re-check</button>
        <button class="btn btn-ghost" type="button" data-remove="${esc(entry.domain)}">Remove</button>
      </div>` : ""}
    </article>`;
  }).join("");
}

/* Editor state. Nothing publishes until asked. */
const draft: { relays: string[] | null; watch: string[] | null } = { relays: null, watch: null };

function renderIdentity(): void {
  const relays = draft.relays ?? state.relays.map((r) => r.url);
  const known = new Set(relays);
  // No list of their own, so show the fallbacks.
  const shown = relays.length ? relays : [...DEFAULT_RELAYS];

  $("#relay-list").innerHTML = `<div class="chip-row">` + shown.map((url) => {
    const info = state.relayInfo.get(url);
    const down = info === null;
    const name = info && typeof info === "object" && typeof info.name === "string" ? info.name : null;
    return `<span class="chip-x${down ? " down" : ""}" title="${esc(down ? "unreachable" : name ?? url)}">
      ${esc(url.replace(/^wss:\/\//, ""))}
      <span class="mark">${down ? "down" : known.has(url) ? "yours" : "fallback"}</span>
      ${known.has(url) ? `<button type="button" data-drop-relay="${esc(url)}" aria-label="Remove">&times;</button>` : ""}
    </span>`;
  }).join("") + `</div>` +
  (relays.length === 0
    ? `<p class="hint" style="text-align:left">You have published no relay list, so these
       five are used as a fallback. Add your own and they stop being used.</p>`
    : "");

  const watch = draft.watch ?? state.watch;
  $("#watch-list").innerHTML = watch.length
    ? `<div class="chip-row">` + watch.map((d) =>
        `<span class="chip-x">${esc(d)}
           <button type="button" data-drop-watch="${esc(d)}" aria-label="Remove">&times;</button>
         </span>`).join("") + `</div>`
    : `<p class="hint" style="text-align:left">Nothing on the watchlist yet.</p>`;
}

async function publishRelayList(): Promise<void> {
  if (!session.signer) return;
  const urls = draft.relays ?? state.relays.map((r) => r.url);
  const hint = $("#relay-hint");

  if (urls.length === 0) {
    hint.className = "hint err";
    hint.textContent = "Add at least one relay, or there is nowhere to publish the list itself.";
    return;
  }

  try {
    const event = await session.signer.signEvent(
      buildRelayList({
        pubkey: session.pubkey as string,
        relays: urls.map((url) => ({ url, read: true, write: true })),
        createdAt: now(),
      }),
    );
    /* Old relays too, or readers who only know them can't find the new list. */
    const results = await publishOutbox(directory, event, { extraRelays: DISCOVERY_RELAYS });
    const ok = results.filter((r) => r.ok);

    $("#relay-out").hidden = false;
    $("#relay-out").innerHTML =
      (ok.length
        ? row("good", `<b>Published to ${ok.length} of ${results.length}.</b> Clients will now look
             for your events on the relays you listed.`)
        : row("bad", "<b>No relay accepted it.</b> Nothing changed.")) +
      results.map((r) => row(r.ok ? "good" : "bad",
        `<b>${esc(r.relay.replace(/^wss:\/\//, ""))}</b>: ${r.ok ? "accepted" : esc(r.message ?? "refused")}`)).join("");

    if (ok.length) {
      state.relays = urls.map((url) => ({ url, read: true, write: true }));
      draft.relays = null;
      hint.className = "hint";
      hint.textContent = "";
      renderIdentity();
      probeRelays();
    }
  } catch (err) {
    hint.className = "hint err";
    hint.textContent = (err as Error).message;
  }
}

async function publishWatchlist(): Promise<void> {
  if (!session.signer) return;
  const domains = draft.watch ?? state.watch;
  const hint = $("#watch-hint");
  try {
    const event = await session.signer.signEvent(
      buildWatchlist({ pubkey: session.pubkey as string, domains, createdAt: now() }),
    );
    const results = await publishOutbox(directory, event, { extraRelays: DISCOVERY_RELAYS });
    const ok = results.filter((r) => r.ok).length;
    hint.className = ok ? "hint ok" : "hint err";
    hint.textContent = ok
      ? `Published to ${ok} of ${results.length} relays.`
      : "No relay accepted it.";
    if (ok) {
      state.watch = domains;
      draft.watch = null;
      renderIdentity();
    }
  } catch (err) {
    hint.className = "hint err";
    hint.textContent = (err as Error).message;
  }
}

/* Republish without it. Not a NIP-09 delete, and old versions may linger, so
   never promise erasure. */
async function removeDomain(domain: string): Promise<void> {
  if (!session.signer) return;
  if (!confirm(`Remove ${domain} from your published portfolio?\n\nThe DNS record and the proof event stay where they are; this only republishes the list without it.`)) return;

  const entries = state.entries.filter((e) => e.domain !== domain);
  try {
    const event = await session.signer.signEvent(
      buildPortfolio({ pubkey: session.pubkey as string, entries, createdAt: now() }),
    );
    const results = await publishOutbox(directory, event, { extraRelays: DISCOVERY_RELAYS });
    const ok = results.filter((r) => r.ok).length;
    if (ok === 0) {
      toast("No relay accepted the update. Nothing changed.");
      return;
    }
    state.entries = entries;
    state.liveProof.delete(domain);
    render();
    toast(`Removed. Republished to ${ok} of ${results.length} relays.`);
  } catch (err) {
    toast((err as Error).message);
  }
}

initTheme();
initConnect();

onSessionChange((pubkey) => {
  if (pubkey) {
    view(pubkey, { replaceUrl: true });
  } else {
    // Portfolios are public. Disconnecting keeps the page.
    $("#who").textContent = state.viewing ? "Domains held by" : "A domain portfolio";
    render();
  }
});

$("#identity-open").addEventListener("click", () => {
  $("#identity").hidden = false;
  renderIdentity();
  $("#identity").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#identity-close").addEventListener("click", () => ($("#identity").hidden = true));

$("#relay-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = normaliseRelayUrl($<HTMLInputElement>("#relay-url").value);
  const hint = $("#relay-hint");
  if (!url) {
    hint.className = "hint err";
    hint.textContent = "That is not a websocket URL. Relays look like wss://relay.example.";
    return;
  }
  const current = draft.relays ?? state.relays.map((r) => r.url);
  draft.relays = current.includes(url) ? current : [...current, url];
  $<HTMLInputElement>("#relay-url").value = "";
  hint.className = "hint";
  hint.textContent = "Not published yet.";
  renderIdentity();
  probeRelays();
});

$("#watch-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const parsed = tryNormaliseDomain($<HTMLInputElement>("#watch-domain").value);
  const hint = $("#watch-hint");
  if (!parsed.ok) {
    hint.className = "hint err";
    hint.textContent = parsed.reason;
    return;
  }
  const current = draft.watch ?? state.watch;
  draft.watch = current.includes(parsed.domain) ? current : [...current, parsed.domain];
  $<HTMLInputElement>("#watch-domain").value = "";
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
  const copy = (event.target as Element).closest<HTMLElement>("[data-copy]");
  if (copy) return copyToClipboard($(`#${copy.dataset.copy}`).textContent!);

  const recheck = (event.target as Element).closest<HTMLElement>("[data-recheck]");
  if (recheck) {
    checkDomainProof({ domain: recheck.dataset.recheck!, pubkey: state.viewing! }).then((report) => {
      state.liveProof.set(recheck.dataset.recheck!, report);
      render();
      toast(report.status.proven ? "Still proven." : `Not proven: ${report.status.reason}`);
    });
    return;
  }
  const remove = (event.target as Element).closest<HTMLElement>("[data-remove]");
  if (remove) return removeDomain(remove.dataset.remove!);

  const dropRelay = (event.target as Element).closest<HTMLElement>("[data-drop-relay]");
  if (dropRelay) {
    const current = draft.relays ?? state.relays.map((r) => r.url);
    draft.relays = current.filter((u) => u !== dropRelay.dataset.dropRelay);
    $("#relay-hint").className = "hint";
    $("#relay-hint").textContent = "Not published yet.";
    renderIdentity();
    return;
  }
  const dropWatch = (event.target as Element).closest<HTMLElement>("[data-drop-watch]");
  if (dropWatch) {
    const current = draft.watch ?? state.watch;
    draft.watch = current.filter((d) => d !== dropWatch.dataset.dropWatch);
    $("#watch-hint").className = "hint";
    $("#watch-hint").textContent = "Not published yet.";
    renderIdentity();
  }
});

const initial = pubkeyFromUrl();
if (initial) view(initial);
else render();
