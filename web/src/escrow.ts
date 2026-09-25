/* escrow.html: open and watch a 2-of-3 taproot escrow (2-of-2 with no arbiter).
 * No server state. Each party publishes its own signed view, and we show any
 * disagreement, never pick a side. Addresses are re-derived, never trusted.
 */
import {
  CHAIN_APIS,
  addressToScript,
  buildCommitment,
  buildEscrowEvent,
  buildTree,
  chainApi,
  compareViews,
  decodeRecovery,
  rebuildFromRecovery,
  deriveEscrowId,
  deriveEscrowState,
  deriveTransferState,
  describeTree,
  encodeRecovery,
  escrowFilter,
  escrowPublicKeyHex,
  feeOf,
  findFunding,
  buildSpend,
  finaliseSpend,
  signSpend,
  npubEncode,
  parseArbiterSet,
  parseEscrowEvent,
  profileFilter,
  publishToRelays,
  signEvent,
  record,
  fingerprintMatches,
  fingerprintOf,
  queryRelays,
  shorten,
  toPubkeyHex,
  tryNormaliseDomain,
  arbiterIntersection,
  decodeInvite,
  decodeReply,
  encodeInvite,
  encodeReply,
  resolveHandshake,
  observe,
  fundable,
  registrantActed,
  transferAllowed,
  releasable,
} from "./fmd.js";
import type { EscrowTree, EscrowView, Invite, NetworkName, Observation, TransferCommitment, Utxo } from "./fmd.js";
import { CONFIG } from "./config.js";
import {
  $, DISCOVERY_RELAYS, copyToClipboard, esc, initConnect, initTheme, now,
  openConnect, row, sats, session,
} from "./ui.js";

/* Both sides must use the same relays, so they come from the deployment.
   Per-escrow keys have no NIP-65 list. */
const ESCROW_RELAYS = DISCOVERY_RELAYS;
const chain = chainApi(CONFIG.network as NetworkName, CONFIG.chainApiBase.trim() || CHAIN_APIS[CONFIG.network as NetworkName]);

type Side = "buyer" | "seller";

type Realised = ReturnType<typeof realise>;

interface Joining {
  invite: Invite;
  side: Side;
  mySecret?: Uint8Array;
  realised?: Realised;
  myRole?: Side;
}

/** The initiator's escrow, filled in step by step. */
interface Draft extends Omit<Joining, "invite"> {
  domain: string;
  amountSats: number;
  me: string;
  counterparty: string;
  buyerNostr: string;
  sellerNostr: string;
  arbiterOptions?: string[];
  arbiter?: string | null;
  salt?: string;
  invite?: Invite;
}

const state: {
  draft: Draft | null;
  views: ReturnType<typeof compareViews> | null;
  watching: string | null;
  joining?: Joining;
  published?: boolean;
  saved?: boolean;
  watchBusy?: boolean;
  settleFor?: string | null;
} = {
  draft: null,
  views: null,
  watching: null,
};

function paintNetwork(): void {
  const el = $("#net-badge");
  el.className = "net-badge" + (CONFIG.network === "mainnet" ? " mainnet" : "");
  el.innerHTML = CONFIG.network === "mainnet"
    ? `<b>mainnet</b>: real money`
    : `<b>${esc(CONFIG.network)}</b>: test coins, no value`;
}

async function checkTerms(event: Event): Promise<void> {
  event.preventDefault();
  const hint = $("#terms-hint");
  const out = $("#terms-out");

  if (!session.pubkey) {
    hint.className = "hint";
    hint.textContent = "Connect a key first. It identifies you to your counterparty.";
    openConnect();
    return;
  }

  const domain = tryNormaliseDomain($<HTMLInputElement>("#e-domain").value);
  if (!domain.ok) { fail(hint, domain.reason); return; }

  const amountSats = Number($<HTMLInputElement>("#e-amount").value.replace(/[\s,_]/g, ""));
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    fail(hint, "The price must be a whole number of sats.");
    return;
  }
  /* Must stay above dust after the settlement fee. Fail now, not at signing. */
  if (amountSats < 2000) { fail(hint, "Too small to escrow: the settlement fee would exceed it."); return; }

  const counterparty = toPubkeyHex($<HTMLInputElement>("#e-counterparty").value.trim());
  if (!counterparty) { fail(hint, "That is not an npub or a hex pubkey."); return; }
  if (counterparty === session.pubkey) { fail(hint, "You cannot trade with yourself."); return; }

  const side = $<HTMLSelectElement>("#e-side").value as Side;
  state.draft = {
    domain: domain.domain,
    amountSats,
    side,
    me: session.pubkey,
    counterparty,
    buyerNostr: side === "buyer" ? session.pubkey : counterparty,
    sellerNostr: side === "seller" ? session.pubkey : counterparty,
  };

  hint.className = "hint";
  hint.textContent = "";
  out.hidden = false;
  out.innerHTML = row("", "Reading both sides' published arbiter lists…");

  await loadArbiters();
  step(2);
}

const fail = (el: HTMLElement, message: string): void => { el.className = "hint err"; el.textContent = message; };

/* Each side publishes accepted arbiters as a NIP-51 set. An empty
   intersection means no trade, never a default. */
async function loadArbiters(): Promise<void> {
  const { buyerNostr, sellerNostr } = state.draft!;
  let mine: string[] | undefined, theirs: string[] | undefined;

  try {
    const events = await queryRelays(
      ESCROW_RELAYS,
      profileFilter([buyerNostr, sellerNostr]),
      { timeoutMs: 6000 },
    );
    const setOf = (pubkey: string) => {
      const list = events
        .filter((e) => e.pubkey === pubkey)
        .map((e) => parseArbiterSet(e))
        .find((v) => v !== undefined);
      return list;
    };
    mine = setOf(buyerNostr);
    theirs = setOf(sellerNostr);
  } catch {
    mine = undefined;
    theirs = undefined;
  }

  const result = arbiterIntersection(mine, theirs);
  state.draft!.arbiterOptions = result.arbiters;

  const el = $("#arbiters");
  const rows: string[] = [];

  /* With no lists, offer only the site's arbiter. No paste box: a counterparty's
     own key posing as the arbiter would hold 2 of 3, and a newcomer can't tell. */
  const unconstrained = mine === undefined && theirs === undefined;
  const siteArbiter = toPubkeyHex(String(CONFIG.arbiterPubkey ?? "").trim());
  if (unconstrained) {
    rows.push(row("", siteArbiter
      ? `Neither side has published an arbiter list, so neither has expressed a constraint.
         You can use this site's arbiter, or trade without one.`
      : `Neither side has published an arbiter list, and this site names no arbiter, so the
         choice is to trade without one: the two of you plus the timelock.`));
  } else if (result.arbiters.length === 0 && !result.noArbiterPossible) {
    rows.push(row("bad", `<b>No overlap.</b> You accept different arbiters and neither list is
      empty, so there is nobody you both agree on. Either one of you widens their list, or
      there is no trade on these terms.`));
  }

  const options = [
    ...result.arbiters.map((pubkey) => ({
      value: pubkey,
      title: shorten(npubEncode(pubkey), 10),
      note: "accepted by both sides",
    })),
    ...(unconstrained && siteArbiter
      ? [{ value: siteArbiter, title: shorten(npubEncode(siteArbiter), 10), note: "this site's arbiter: co-signs a dispute, never alone" }]
      : []),
    {
      value: "",
      title: "No arbiter",
      note: "only you two, plus a timelock that pays the seller, so the buyer is trusting the seller to deliver. Nobody can referee.",
    },
  ];

  rows.push(`<div class="key-choice" id="arb-choice">` + options.map((o) =>
    `<button class="btn btn-ghost" type="button" data-arbiter="${esc(o.value)}">
       ${esc(o.title)}<span>${esc(o.note)}</span>
     </button>`).join("") + `</div>`);

  rows.push(row("", `<b>The timeout.</b> With an arbiter, the timelock returns the money to the
    <b>buyer</b> after ${esc(String(timeoutBlocks()))} blocks. With no arbiter it pays the
    <b>seller</b> instead, because otherwise a buyer who already had the domain could simply wait.`));

  el.innerHTML = rows.join("");
}

const timeoutBlocks = () => (CONFIG.network === "mainnet" ? 4320 : 144);

/* Show every input, so anyone can recompute the address. */
function renderDerivation(tree: EscrowTree, address: string, id: string): string {
  const t = describeTree(tree);
  return `<div class="derive">
    <div class="derive-row"><span class="k">Address</span><span class="v big">${esc(address)}</span></div>
    <div class="derive-row"><span class="k">Escrow id</span><span class="v">${esc(id)}</span></div>
    <div class="derive-row"><span class="k">Shape</span><span class="v">${esc(t.shape)}</span></div>
    <div class="derive-row"><span class="k">Internal key</span><span class="v">${esc(t.internalKey)} <small>(NUMS: no key path exists)</small></span></div>
    <div class="derive-row"><span class="k">Merkle root</span><span class="v">${esc(t.merkleRoot)}</span></div>
    <div class="derive-row"><span class="k">Output key</span><span class="v">${esc(t.outputKey)} <small>parity ${t.parity}</small></span></div>
    <div class="derive-row"><span class="k">scriptPubKey</span><span class="v">${esc(t.scriptPubKey)}</span></div>
    <div class="derive-row" style="display:block">
      <span class="k" style="display:block;margin-bottom:8px">Spending paths</span>
      ${t.leaves.map((l) => `<div class="leaf">
        <span class="n">${esc(l.name)}</span>
        <span class="who"><b>${esc(describeLeaf(l))}</b><br><span class="seq">leaf hash ${esc(l.leafHash.slice(0, 24))}… · nSequence ${esc(l.sequence)}</span></span>
      </div>`).join("")}
    </div>
    <p class="derive-note"><b>No path is spendable by the arbiter alone.</b> Every leaf naming
      the arbiter also names a party. Recompute all of this yourself with
      <code>bun test test/vectors/escrow.test.ts</code>, or spend every leaf against a real
      node with <code>bun run test:regtest</code>.</p>
  </div>`;
}

const describeLeaf = (l: { role: string }): string => ({
  cooperative: "buyer + seller: the normal path, without us",
  "arbiter-release": "arbiter + seller: a dispute resolved for the seller",
  "arbiter-refund": "arbiter + buyer: a dispute resolved for the buyer",
  timeout: "the timeout party alone, after the timelock (the backstop)",
} as Record<string, string>)[l.role] ?? l.role;

/* Invite and reply carry every input both sides must match, salt included, or
   each side derives a different id. Keys and salt are made once per draft,
   since re-keying orphans the key already sent. */
const hexOf = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function ensureKey(draft: { mySecret?: Uint8Array }): string {
  if (!draft.mySecret) draft.mySecret = crypto.getRandomValues(new Uint8Array(32));
  return escrowPublicKeyHex(draft.mySecret);
}

function readCommitment(registrarId: string, nsId: string): TransferCommitment {
  const registrarIanaId = $<HTMLInputElement>(registrarId).value.trim() || undefined;
  const nameservers = $<HTMLInputElement>(nsId).value.split(",").map((n) => n.trim()).filter(Boolean);
  // buildCommitment refuses an empty one, which could never show as complete.
  return buildCommitment({ registrarIanaId, nameservers, committedAt: now() });
}

/** Tree, address and id from a resolved handshake. Identical on both sides. */
function realise(resolved: ReturnType<typeof resolveHandshake>) {
  const params = {
    salt: resolved.salt,
    buyer: bytesOf(resolved.buyerKey),
    seller: bytesOf(resolved.sellerKey),
    ...(resolved.arbiter ? { arbiter: bytesOf(resolved.arbiter) } : {}),
    timeoutTo: resolved.timeoutTo,
    timeoutBlocks: resolved.timeoutBlocks,
    network: resolved.network,
    amountSats: resolved.amountSats,
    domain: resolved.domain,
  };
  const tree = buildTree({
    buyer: params.buyer,
    seller: params.seller,
    arbiter: params.arbiter,
    timeoutTo: params.timeoutTo,
    timeoutBlocks: params.timeoutBlocks,
  });
  return {
    params,
    tree,
    id: deriveEscrowId(params),
    address: tree.addresses[params.network],
    // From whichever message the buyer sent.
    commitment: resolved.commitment,
  };
}

/* Assign each element. Prepending to innerHTML re-creates the rest and drops their listeners. */
function showReady(draft: Draft | Joining, realised: Realised, myRole: Side): void {
  draft.realised = realised;
  draft.myRole = myRole;

  $("#recovery").textContent = encodeRecovery({
    version: 1,
    secretKey: draft.mySecret!,
    buyer: realised.params.buyer,
    seller: realised.params.seller,
    arbiter: realised.params.arbiter,
    timeoutTo: realised.params.timeoutTo,
    timeoutBlocks: realised.params.timeoutBlocks,
  });
  $("#recovery-box").hidden = false;
  $("#derivation").innerHTML = renderDerivation(realised.tree, realised.address, realised.id);
  $("#publish-escrow").hidden = false;
  $<HTMLButtonElement>("#publish-escrow").disabled = !$<HTMLInputElement>("#saved-recovery").checked;
}

/* Refuse a commitment the registry already matches. It would read as
   transferred from the first poll, the usual same-registrar trap. */
async function checkCommitmentAgainstRegistry(domain: string, commitment: TransferCommitment, hint: HTMLElement): Promise<boolean> {
  hint.className = "hint";
  hint.textContent = "Checking your destination against the registry…";
  const result = await observe({ domain, now: now() }).catch(() => ({} as Awaited<ReturnType<typeof observe>>));
  if (!result.observation) {
    // Unreadable now means the transfer can't be watched either.
    fail(hint, `The registry could not be read for ${domain} (${result.reason ?? "no answer"}), so a
      transfer could not be watched. Try again in a minute.`);
    return false;
  }
  const current = fingerprintOf(result.observation.facts);
  if (fingerprintMatches(current, commitment)) {
    fail(hint, `The registry already shows ${domain} at registrar ${current.registrarIanaId ?? "?"}` +
      (current.nameservers.length ? ` with nameservers ${current.nameservers.join(", ")}` : "") +
      `. That matches what you entered, so it could never show the domain moving to you. ` +
      `Enter something that will change when you receive it: your registrar's id if it is ` +
      `different, or nameservers you run that it does not use now.`);
    return false;
  }
  return true;
}

async function createInvite(): Promise<void> {
  const hint = $("#commit-hint");
  const d = state.draft;
  if (!d) return;
  if (d.arbiter === undefined) { fail(hint, "Choose an arbiter, or explicitly choose none."); return; }

  let commitment: TransferCommitment | undefined;
  if (d.side === "buyer") {
    try { commitment = readCommitment("#e-registrar", "#e-ns"); }
    catch (err) { fail(hint, (err as Error).message); return; }
    if (!(await checkCommitmentAgainstRegistry(d.domain, commitment, hint))) return;
  }

  if (!d.salt) d.salt = hexOf(crypto.getRandomValues(new Uint8Array(32)));
  const myKey = ensureKey(d);

  d.invite = {
    salt: d.salt,
    domain: d.domain,
    amountSats: d.amountSats,
    network: CONFIG.network as NetworkName,
    timeoutBlocks: timeoutBlocks(),
    timeoutTo: d.arbiter ? "buyer" : "seller",
    arbiter: d.arbiter || undefined,
    initiatorRole: d.side,
    initiatorKey: myKey,
    commitment: commitment
      ? { registrarIanaId: commitment.registrarIanaId, nameservers: commitment.nameservers }
      : undefined,
  };

  let code: string;
  try { code = encodeInvite(d.invite); }
  catch (err) { fail(hint, (err as Error).message); return; }

  const link = `${location.origin}${location.pathname}?join=${code}`;
  hint.className = "hint ok";
  hint.textContent = "Invite ready.";

  $("#invite-out").innerHTML =
    row("", `<b>1. Send this link to your counterparty.</b> Chat, email or anything else will
      do; it contains no secrets. <b>Keep this tab open until their reply arrives:</b> the key
      that goes with this invite lives only here until your recovery string is shown.`) +
    `<div class="nsec" id="invite-link">${esc(link)}</div>
     <button class="btn btn-ghost btn-sm" type="button" id="copy-invite">Copy link</button>` +
    row("", `<b>2. Paste the reply they send back</b>, below.`);
  $("#copy-invite").addEventListener("click", () => copyToClipboard($("#invite-link").textContent!));
  $("#reply-in").hidden = false;
  step(4);
}

function useReply(): void {
  const hint = $("#commit-hint");
  const d = state.draft;
  if (!d?.invite) return;

  const reply = decodeReply($<HTMLInputElement>("#e-reply").value, d.invite);
  if (!reply.ok) { fail(hint, reply.reason); return; }

  let realised: Realised;
  try { realised = realise(resolveHandshake(d.invite, reply.reply)); }
  catch (err) { fail(hint, (err as Error).message); return; }

  $("#reply-in").hidden = true;
  hint.className = "hint ok";
  hint.textContent = "Address derived. Your counterparty derived the same one from the same inputs.";
  showReady(d, realised, d.side);
}

function openInvite(code: string): void {
  const parsed = decodeInvite(code);
  $("#open-section").hidden = true;
  $("#join-section").hidden = false;

  if (!parsed.ok) {
    $("#join-terms").innerHTML = row("bad", `This invite did not decode: ${esc(parsed.reason)}.
      Ask for the link again.`);
    $("#join-btn").hidden = true;
    return;
  }

  const inv = parsed.invite;
  const mySide: Side = inv.initiatorRole === "buyer" ? "seller" : "buyer";
  state.joining = { invite: inv, side: mySide };

  // Never derive an address on a network this site isn't watching.
  if (inv.network !== CONFIG.network) {
    $("#join-terms").innerHTML = row("bad", `This invite is for <b>${esc(inv.network)}</b>, and this
      site is set to <b>${esc(CONFIG.network)}</b>. Open it on a site set to the same network.`);
    $("#join-btn").hidden = true;
    return;
  }

  $("#join-terms").innerHTML =
    `<div class="confirm">
       <div class="amount">${sats(inv.amountSats)} sats</div>
       <div class="to">for ${esc(inv.domain)} · you are the <b>${esc(mySide)}</b></div>
       <div class="fee">${inv.arbiter
         ? `Arbiter ${esc(shorten(npubEncode(inv.arbiter), 8))} can co-sign with either of you, never alone.`
         : mySide === "buyer"
           ? "No arbiter: only the two of you, plus the timelock. The timelock pays the seller, so you are trusting them to deliver."
           : "No arbiter: only the two of you, plus the timelock."}
         Timeout after ${inv.timeoutBlocks} blocks pays the ${esc(inv.timeoutTo)}.
         Network: ${esc(inv.network)}.</div>
     </div>` +
    (mySide === "seller" && inv.commitment
      ? row("", `The buyer will receive it at registrar <code>${esc(inv.commitment.registrarIanaId ?? "—")}</code>,
          nameservers <code>${esc(inv.commitment.nameservers.join(", ") || "—")}</code>.`)
      : "");

  $("#join-commit").hidden = mySide !== "buyer";
}

async function acceptInvite(): Promise<void> {
  const hint = $("#join-hint");
  const j = state.joining;
  if (!j) return;
  if (!session.pubkey) {
    hint.className = "hint";
    hint.textContent = "Connect a key first. It identifies you to your counterparty.";
    openConnect();
    return;
  }

  let commitment: TransferCommitment | undefined;
  if (j.side === "buyer") {
    try { commitment = readCommitment("#j-registrar", "#j-ns"); }
    catch (err) { fail(hint, (err as Error).message); return; }
    if (!(await checkCommitmentAgainstRegistry(j.invite.domain, commitment, hint))) return;
  }

  const myKey = ensureKey(j);
  const replyText = encodeReply({
    joinerKey: myKey,
    salt: j.invite.salt,
    commitment: commitment
      ? { registrarIanaId: commitment.registrarIanaId, nameservers: commitment.nameservers }
      : undefined,
  });

  // The joiner has both keys now, so derive the escrow here.
  const reply = decodeReply(replyText, j.invite);
  if (!reply.ok) { fail(hint, reply.reason); return; }

  let realised: Realised;
  try { realised = realise(resolveHandshake(j.invite, reply.reply)); }
  catch (err) { fail(hint, (err as Error).message); return; }

  state.draft = j as Draft;
  hint.className = "hint ok";
  hint.textContent = "Accepted.";

  // Reuse step 4's controls for the recovery string and publishing.
  $("#join-section").hidden = true;
  $("#open-section").hidden = false;
  for (const n of [1, 2, 3]) $(`.step[data-step="${n}"]`).hidden = true;
  $("#invite-out").innerHTML =
    row("good", `<b>Send this reply back to whoever invited you.</b> It contains no secrets.`) +
    `<div class="nsec" id="reply-out">${esc(replyText)}</div>
     <button class="btn btn-ghost btn-sm" type="button" id="copy-reply">Copy reply</button>`;
  $("#copy-reply").addEventListener("click", () => copyToClipboard($("#reply-out").textContent!));
  step(4);
  showReady(j, realised, j.side);
}

async function publishEscrow(): Promise<void> {
  const d = state.draft;
  if (!d?.realised || !d.mySecret) return;
  const out = $("#publish-out");
  out.hidden = false;
  out.innerHTML = row("", "Signing your view…");

  const commitment = d.realised.commitment;

  try {
    /* Sign with this side's tree key, not the Nostr identity. Only a tree key
       says who can spend, and the watch page treats any other signer as a stranger. */
    const event = signEvent(
      buildEscrowEvent({
        ...d.realised.params,
        pubkey: escrowPublicKeyHex(d.mySecret),
        createdAt: now(),
        ...(commitment ? { commitment } : {}),
        deadlines: { fundBy: now() + 24 * 3600 },
      }),
      d.mySecret,
    );

    const results = await publishToRelays(ESCROW_RELAYS, event);
    const ok = results.filter((r) => r.ok);

    out.innerHTML =
      (ok.length
        ? row("good", `<b>Published to ${ok.length} of ${results.length}.</b> Your counterparty
             publishes their own view; where the two disagree, both stay visible.`)
        : row("bad", "<b>No relay accepted it.</b> Nothing was published.")) +
      results.map((r) => row(r.ok ? "good" : "bad",
        `<b>${esc(r.relay.replace(/^wss:\/\//, ""))}</b>: ${r.ok ? "accepted" : esc(r.message ?? "refused")}`)).join("");

    if (ok.length) {
      state.published = true;
      const url = new URL(location.href);
      url.searchParams.delete("join");
      url.searchParams.set("id", d.realised.id);
      history.replaceState(null, "", url);
      watch(d.realised.id);
    }
  } catch (err) {
    out.innerHTML = row("bad", esc((err as Error).message));
  }
}

async function watch(id: string): Promise<void> {
  // The timer and Refresh must not interleave.
  if (state.watchBusy) return;
  state.watchBusy = true;
  try { await watchOnce(id); } finally { state.watchBusy = false; }
}

/** Author by role. Tree keys are per-escrow, so an npub would mean nothing. */
const roleOf = (view: EscrowView, author: string): string =>
  author === view.buyer ? "buyer" : author === view.seller ? "seller" : author === view.arbiter ? "arbiter" : "someone else";

async function watchOnce(id: string): Promise<void> {
  if (state.watching !== id) state.settleFor = null;
  state.watching = id;
  $("#escrow").hidden = false;
  $("#escrow-title").textContent = "Escrow " + id.slice(0, 12) + "…";
  $("#escrow-sub").textContent = "reading every published view…";

  const events = await queryRelays(ESCROW_RELAYS, [escrowFilter(id)], { timeoutMs: 6000 }).catch(() => []);
  const parsed = events.map((e) => parseEscrowEvent(e));
  const views = parsed.filter((r) => r.ok).map((r) => (r as { view: EscrowView }).view);
  const rejected = parsed.filter((r) => !r.ok);

  if (views.length === 0) {
    $("#escrow-sub").textContent = "";
    $("#state-line").innerHTML = row("bad", rejected.length
      ? `Found ${rejected.length} event(s) at this coordinate and <b>none of them verified</b>:
         ${esc((rejected[0] as { reason: string }).reason)}`
      : "No published view of this escrow was found on these relays yet.");
    return;
  }

  const comparison = compareViews(views);
  state.views = comparison;

  /* Anyone can publish at any id. Only views signed by a tree key count. */
  if (comparison.participants.length === 0) {
    $("#escrow-sub").textContent = "";
    $("#state-line").innerHTML = row("bad", `Found ${views.length} view(s) at this id and
      <b>none is signed by a key in this escrow</b>. Only the buyer's and the seller's own escrow
      keys count. Do not fund anything from these.`);
    return;
  }
  const view = comparison.newest!;
  const hasBuyer = comparison.participants.some((v) => v.author === view.buyer);
  const hasSeller = comparison.participants.some((v) => v.author === view.seller);
  const bothSides = hasBuyer && hasSeller;

  $("#escrow-sub").textContent =
    `${comparison.participants.length} view(s) published · ${esc(view.domain)} · ${sats(view.amountSats)} sats`;

  /* A lone view trivially agrees with itself, so name the missing side until both publish. */
  const missing = !hasBuyer ? "buyer" : !hasSeller ? "seller" : null;
  $("#disagreements").innerHTML = !comparison.agreed
    ? `<div class="clash">
         <h4>The published views disagree</h4>
         ${comparison.disagreements.map((d) => `
           <div class="clash-row"><b>${esc(d.field)}:</b></div>
           ${d.values.map((v) => `<div class="clash-row">the ${esc(roleOf(view, v.author))} says ${esc(v.value)}</div>`).join("")}
         `).join("")}
         <p style="font-size:12.5px;margin:10px 0 0">This is permanent and public. Do not fund
            anything until it is resolved: one of these views is not describing your trade.</p>
       </div>`
    : missing
      ? row("", `<b>Waiting for the ${missing}.</b> Only the ${missing === "buyer" ? "seller" : "buyer"}'s view is
          published so far. The ${missing} publishes theirs from their own page after saving their
          recovery string. Nobody should fund until both are here.`)
      : row("good", "Both sides have published, and their views agree on the terms.");
  if (comparison.strangers.length) {
    $("#disagreements").innerHTML +=
      row("", `${comparison.strangers.length} view(s) by keys outside this escrow were ignored.`);
  }

  $("#derivation-view").innerHTML = renderDerivation(
    buildTree({
      buyer: bytesOf(view.buyer),
      seller: bytesOf(view.seller),
      arbiter: view.arbiter ? bytesOf(view.arbiter) : undefined,
      timeoutTo: view.timeoutTo,
      timeoutBlocks: view.timeoutBlocks,
    }),
    view.address,
    view.id,
  );

  await checkChain(view, { bothSides, agreed: comparison.agreed });
}

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

/* Funded means one confirmed output of at least the amount. Partials aren't
   summed, which keeps settlement single-input. */
async function checkChain(view: EscrowView, gate: { bothSides: boolean; agreed: boolean }): Promise<void> {
  $("#chain-view").innerHTML = row("", `Asking ${esc(chain.network)} about the address…`);

  let utxos: Utxo[] = [], tip: number | undefined;
  try {
    [utxos, tip] = await Promise.all([chain.utxos(view.address), chain.tipHeight().catch(() => undefined)]);
  } catch (err) {
    $("#chain-view").innerHTML = row("bad", `The chain API did not answer: ${esc((err as Error).message)}.
      That says nothing about the escrow; try again.`);
    return;
  }

  const found = findFunding(utxos, BigInt(view.amountSats), 1, tip);
  const derived = deriveEscrowState({
    view,
    funded: found.funded,
    now: now(),
  });

  $("#state-line").innerHTML =
    `<span class="state-pill ${esc(derived.state)}">${esc(derived.state)}</span>
     <p class="hint" style="text-align:left;margin:0 0 12px">${esc(derived.reason)}</p>`;

  // Read the transfer first. It gates the funding advice.
  const reading = await checkTransfer(view);
  const verdict = reading?.verdict;

  /* "Ready to fund" shows only when every check passes. Otherwise name the first blocker. */
  const blocker =
    !gate.agreed ? "the published views disagree about the terms"
    : !gate.bothSides ? "both the buyer and the seller have to publish their views first"
    : !view.commitment ? "no destination was committed, so the transfer could never be shown to complete"
    : !verdict ? "the registry could not be read, so nobody can see whether the seller has unlocked the domain"
    : fundable({ verdict, observations: reading!.history, commitment: reading!.commitment }) ? null
    : !verdict.confirmed ? "the registry reading is not confirmed yet: two readings at least 30 minutes apart must agree"
    : verdict.state === "locked" ? "the transfer lock is confirmed on. Buyer: tell the seller your page shows this line. Seller: then turn the lock off at your registrar"
    : verdict.state === "pending" ? "a transfer of this domain is already underway, before anything has been paid. The buyer starts the transfer only after funding, so this one is somebody else's: do not fund"
    : !transferAllowed(verdict) ? `the registry shows "${verdict.state}", which is not a state to fund in`
    /* Never seen locked proves nothing about who holds the registrar account.
       The seller proves it by toggling the lock. */
    : reading!.acted.lockedAt ? "the transfer lock has been seen on and turned off; two readings at least 30 minutes apart must confirm it is off"
    : "the domain has been unlocked the whole time this page has watched, which does not show that the seller holds it at the registrar. Seller: turn the transfer lock on at your registrar. Once the buyer's page confirms it (two readings 30 minutes apart), turn it off again. Only the registrant can change the lock, and each side's page trusts only its own readings";

  /* After funding. The auth code goes out only now, and nobody signs a release
     until the registry shows the committed destination. */
  const transferState = verdict?.confirmed ? verdict.state : undefined;
  const nextStep =
    transferState === "transferred"
      ? row("good", `<b>Next: the release.</b> The registry shows the domain at the buyer's committed
          destination. Buyer: check that it is in your own registrar account. Then both of you sign
          below, paying the seller.`)
      : transferState === "reverted"
        ? row("bad", `<b>Do not sign anything.</b> The registry showed the transfer complete and then
            moved back. That is a dispute, not a finished trade.`)
        : transferState === "pending"
          ? row("", `<b>The transfer is underway.</b> Between registrars it can take up to five days;
              the seller can often approve it sooner on their registrar's transfer page. Nothing is
              released until the registry shows the domain at the buyer's destination.`)
          : row("", `<b>Next: the transfer.</b> Seller: get the domain's transfer auth code (also
              called the EPP code) from your registrar and send it to the buyer privately, never in a
              public chat. (At the same registrar, you can push the domain to the buyer's account
              instead.) Buyer: start the transfer at your registrar. This page shows it as pending,
              then transferred. Nobody signs a release before that.`);

  $("#chain-view").innerHTML = found.funded
    ? row("good", `<b>Funded.</b> ${sats(Number(found.utxo.valueSats))} sats at
        <a href="${esc(chain.explorer)}/tx/${esc(found.utxo.txid)}" target="_blank" rel="noopener">
        ${esc(found.utxo.txid.slice(0, 16))}…:${found.utxo.vout}</a>`) + nextStep
    : (blocker
        ? row("bad", `<b>Do not fund yet:</b> ${esc(blocker)}.`)
        : row("good", `<b>Ready to fund.</b> The buyer pays <b>${sats(view.amountSats)} sats</b> in
            <b>one</b> payment to <code>${esc(view.address)}</code>. It counts once it confirms.`)) +
      row("", `${esc(found.reason)} ·
        <a href="${esc(chain.explorer)}/address/${esc(view.address)}" target="_blank"
        rel="noopener">Watch the address on the explorer</a>`);

  /* Render once per funding output, so a refresh can't wipe what someone is typing. */
  if (found.funded) {
    const key = `${found.utxo.txid}:${found.utxo.vout}`;
    if (state.settleFor !== key) { state.settleFor = key; renderSettle(view, found.utxo); }
  } else {
    state.settleFor = null;
    $("#settle-view").innerHTML = "";
  }
}

/* RDAP readings, per escrow. A state counts once two polls 30+ minutes apart
   agree (spec/PROTOCOL.md), so each browser keeps its own readings across
   visits and trusts nobody else's. Losing them only resets to unconfirmed. */
const OBS_PREFIX = "fmd:rdap:";
const isObservation = (o: any): boolean =>
  o && Number.isSafeInteger(o.at) && typeof o.snapshotHash === "string" &&
  o.facts && Array.isArray(o.facts.statuses) && Array.isArray(o.facts.nameservers);

function loadObservations(id: string): Observation[] {
  try {
    const list = JSON.parse(localStorage.getItem(OBS_PREFIX + id) ?? "[]");
    return Array.isArray(list) ? list.filter(isObservation) : [];
  } catch { return []; }
}
function saveObservations(id: string, list: Observation[]): void {
  try { localStorage.setItem(OBS_PREFIX + id, JSON.stringify(list)); } catch { /* Private mode. This visit still counts. */ }
}

/** Seconds between fresh readings. Refresh reuses the last one. */
const READING_REUSE_SECONDS = 300;

async function checkTransfer(view: EscrowView) {
  const el = $("#transfer-view");
  if (!view.commitment) {
    el.innerHTML = row("bad", `No destination was committed, so a completed transfer could never
      be shown. Do not fund this escrow.`);
    return undefined;
  }

  const at = now();
  let history = loadObservations(view.id);
  const newest = history[history.length - 1];
  let note = "";

  if (!newest || at - newest.at >= READING_REUSE_SECONDS) {
    el.innerHTML = row("", "Asking the registry…");
    const result = await observe({ domain: view.domain, now: at }).catch(() => ({ reason: "unreachable" } as Awaited<ReturnType<typeof observe>>));
    if (result.observation) {
      history = record(history, result.observation);
      saveObservations(view.id, history);
    } else {
      // A failed fetch is not evidence. Record nothing.
      note = row("", `<b>No new reading</b> (${esc(result.reason ?? "the registry did not answer")}).
        This says nothing about the domain, and nothing was recorded.`);
    }
  }

  if (history.length === 0) {
    el.innerHTML = note;
    return undefined;
  }

  const commitment = {
    registrarIanaId: view.commitment.registrarIanaId,
    nameservers: view.commitment.nameservers ?? [],
    committedAt: 0,
  };
  const verdict = deriveTransferState({ observations: history, commitment, now: at });
  const acted = registrantActed({ observations: history, commitment });
  const latest = history[history.length - 1];

  el.innerHTML =
    row(verdict.state === "transferred" ? "good" : verdict.state === "reverted" ? "bad" : "",
      `<b>${esc(verdict.confirmed ? verdict.state : "not confirmed yet")}</b>: ${esc(verdict.reason)}`) +
    (verdict.confirmed ? "" : row("", `${history.length} reading(s) from this browser so far. While this
      page is open it reads the registry again every ten minutes, and it keeps its readings, so
      coming back later counts too.`)) +
    note +
    row(acted.acted ? "good" : "", `<b>Registrant check.</b> ${esc(acted.reason)}. A DNS record shows who
      controls the zone; only a change to the transfer lock shows who holds the registrar account.`) +
    row("", `Committed destination: registrar <code>${esc(commitment.registrarIanaId ?? "—")}</code>,
      nameservers <code>${esc(commitment.nameservers.join(", ") || "—")}</code>`) +
    row("", `Latest snapshot <code>${esc(latest.snapshotHash.slice(0, 24))}…</code>, hashed from the
      bytes the registry sent, so a dispute can rest on evidence rather than memory.`) +
    (releasable(verdict)
      ? row("good", `<b>The registry shows the domain at the committed destination.</b> It cannot
          show whose <em>account</em> it is in. Buyer: before you sign the release, log in to your
          registrar and see the domain in your own account.`)
      : "");
  return { verdict, acted, history, commitment };
}

/* Cooperative settle. Both sides build the same tx and swap 64-byte signatures.
   The proposer fixes destination and fee, and the responder must match them
   exactly or the sighashes differ. */
function renderSettle(view: EscrowView, utxo: Utxo): void {
  const el = $("#settle-view");
  el.innerHTML = `
    <h3 class="ident-h">Settle</h3>
    <p class="step-lede">Both signatures are required. Whoever goes first fixes the
      destination and the fee; the other reviews those exact numbers, signs, and broadcasts.
      To release, pay the seller. To refund by agreement, pay the buyer.</p>
    <div class="sell-form">
      <label class="field">
        <span>Pay out to <small>any ${esc(view.network)} address, checked before anything is signed</small></span>
        <input type="text" id="s-dest" placeholder="${esc(view.network === "mainnet" ? "bc1q… or bc1p…" : view.network === "regtest" ? "bcrt1…" : "tb1q… or tb1p…")}" autocomplete="off" spellcheck="false">
      </label>
      <label class="field">
        <span>Fee in sats</span>
        <input type="text" id="s-fee" inputmode="numeric" value="500" autocomplete="off">
      </label>
      <label class="field full">
        <span>Their half <small>paste the counterparty's signature bundle, if they went first</small></span>
        <input type="text" id="s-theirs" placeholder="fmdsig1…" autocomplete="off" spellcheck="false">
      </label>
    </div>
    <label class="field full">
      <span>Your escrow recovery string <small>holds the key that signs</small></span>
      <input type="password" id="s-recovery" placeholder="fmdrec1…" autocomplete="off">
    </label>
    <button class="btn btn-accent" type="button" id="s-review">Review the transaction</button>
    <div id="s-out"></div>`;

  $("#s-review").addEventListener("click", () => reviewSettlement(view, utxo));
}

function reviewSettlement(view: EscrowView, utxo: Utxo): void {
  const out = $("#s-out");
  const dest = $<HTMLInputElement>("#s-dest").value.trim();
  const fee = BigInt(($<HTMLInputElement>("#s-fee").value || "0").replace(/[^0-9]/g, ""));

  let scriptPubKey: Uint8Array;
  try { scriptPubKey = addressToScript(dest, view.network); }
  catch (err) { out.innerHTML = row("bad", esc((err as Error).message)); return; }
  if (fee <= 0n || fee >= utxo.valueSats) { out.innerHTML = row("bad", "The fee must be positive and smaller than the escrow."); return; }

  const parsed = decodeRecovery($<HTMLInputElement>("#s-recovery").value);
  if (!parsed.ok) { out.innerHTML = row("bad", esc(parsed.reason)); return; }

  let rebuilt: ReturnType<typeof rebuildFromRecovery>;
  try { rebuilt = rebuildFromRecovery(parsed.recovery); }
  catch (err) { out.innerHTML = row("bad", esc((err as Error).message)); return; }

  if (rebuilt.tree.addresses[view.network] !== view.address) {
    out.innerHTML = row("bad", `That recovery string is for a different escrow: it derives
      ${esc(rebuilt.tree.addresses[view.network])}, not this address. Do not continue.`);
    return;
  }

  const leaf = rebuilt.tree.leaves.A;
  const payout = utxo.valueSats - fee;
  const tx = buildSpend({
    tree: rebuilt.tree,
    leaf,
    outpoint: { txid: utxo.txid, vout: utxo.vout, amountSats: utxo.valueSats },
    destinations: [{ scriptPubKey, amountSats: payout }],
  });

  const estimate = feeOf(tx, false, leaf);

  /* Last chance to catch a wrong address, so show it big. */
  out.innerHTML = `
    <div class="confirm">
      <div class="amount">${sats(Number(payout))} sats</div>
      <div class="to">to ${esc(dest)}</div>
      <div class="fee">Fee ${sats(Number(fee))} sats · ${estimate.vbytes} vbytes ·
        ${(Number(fee) / estimate.vbytes).toFixed(1)} sat/vB · spending
        <code>${esc(utxo.txid.slice(0, 16))}…:${utxo.vout}</code> via leaf A (buyer + seller)</div>
    </div>
    <button class="btn btn-accent" type="button" id="s-sign">Sign as the ${esc(rebuilt.role)}</button>
    <div id="s-result"></div>`;

  $("#s-sign").addEventListener("click", () => {
    const mySig = signSpend({ tx, leaf, secretKey: parsed.recovery.secretKey });
    const theirs = $<HTMLInputElement>("#s-theirs").value.trim();

    if (!theirs) {
      // First signer: hand over a bundle the other side checks against the same numbers.
      const bundle = "fmdsig1" + btoa(JSON.stringify({
        role: rebuilt.role,
        dest,
        fee: String(fee),
        sig: [...mySig].map((b) => b.toString(16).padStart(2, "0")).join(""),
      })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

      $("#s-result").innerHTML =
        row("good", `<b>Signed.</b> Send this to your counterparty. It is useless to anyone
          else: it only signs this one transaction, to this address.`) +
        `<div class="nsec" id="s-bundle">${esc(bundle)}</div>
         <button class="btn btn-ghost btn-sm" type="button" id="s-copy">Copy</button>`;
      $("#s-copy").addEventListener("click", () => copyToClipboard($("#s-bundle").textContent!));
      return;
    }

    // Second signer: their terms must match these exact numbers.
    let other: { role: string; dest: string; fee: string; sig: string };
    try {
      const json = atob(theirs.slice(7).replace(/-/g, "+").replace(/_/g, "/"));
      other = JSON.parse(json);
    } catch { $("#s-result").innerHTML = row("bad", "That signature bundle did not decode."); return; }

    if (other.dest !== dest || other.fee !== String(fee)) {
      $("#s-result").innerHTML = row("bad", `<b>Their bundle is for different terms.</b>
        They signed a payout to <code>${esc(other.dest)}</code> with fee ${esc(other.fee)}.
        Match those exactly, or ask them to re-sign yours.`);
      return;
    }

    const theirSig = Uint8Array.from(other.sig.match(/../g)!.map((h) => parseInt(h, 16)));
    try {
      const signed = finaliseSpend({
        tree: rebuilt.tree,
        leaf,
        tx,
        signatures: { [rebuilt.role]: mySig, [other.role]: theirSig },
      });
      $("#s-result").innerHTML =
        row("good", `<b>Complete.</b> ${signed.vbytes} vbytes, txid
          <code>${esc(signed.txid)}</code>`) +
        `<div class="nsec" id="s-hex">${esc(signed.hex)}</div>
         <button class="btn btn-accent btn-sm" type="button" id="s-broadcast">Broadcast</button>
         <button class="btn btn-ghost btn-sm" type="button" id="s-copyhex">Copy raw hex</button>
         <p class="hint" style="text-align:left">You can broadcast this anywhere: your own node,
            a block explorer, a friend. This page does it over the public chain API, with nothing
            of ours in the path.</p>`;
      $("#s-copyhex").addEventListener("click", () => copyToClipboard($("#s-hex").textContent!));
      $("#s-broadcast").addEventListener("click", async () => {
        const result = await chain.broadcast(signed.hex);
        $("#s-result").innerHTML += result.ok
          ? row("good", `<b>Broadcast.</b> <a href="${esc(chain.explorer)}/tx/${esc(result.txid)}"
              target="_blank" rel="noopener">${esc(result.txid)}</a>`)
          : row("bad", `Rejected: ${esc(result.reason)}. The hex above is still valid; try elsewhere.`);
      });
    } catch (err) {
      $("#s-result").innerHTML = row("bad", esc((err as Error).message));
    }
  });
}

initTheme();
initConnect();
paintNetwork();

function step(n: number): void {
  document.querySelectorAll<HTMLElement>(".step").forEach((el) => {
    const i = Number(el.dataset.step);
    el.classList.toggle("on", i === n);
    if (i < n) el.classList.add("done"); else el.classList.remove("done");
  });
}

$("#terms-form").addEventListener("submit", checkTerms);
$("#invite-btn").addEventListener("click", createInvite);
$("#reply-btn").addEventListener("click", useReply);
$("#join-btn").addEventListener("click", acceptInvite);
$("#publish-escrow").addEventListener("click", publishEscrow);
$("#refresh").addEventListener("click", () => state.watching && watch(state.watching));

$("#saved-recovery").addEventListener("change", (e) => {
  state.saved = (e.target as HTMLInputElement).checked;
  $<HTMLButtonElement>("#publish-escrow").disabled = !((e.target as HTMLInputElement).checked && state.draft?.realised);
});

/* Until the recovery string is saved, the escrow key lives only in this tab. */
window.addEventListener("beforeunload", (e) => {
  if (state.draft?.mySecret && !state.saved && !state.published) {
    e.preventDefault();
    e.returnValue = "";
  }
});

/* Feed the two-poll rule while the tab is visible. */
setInterval(() => {
  if (state.watching && document.visibilityState === "visible") watch(state.watching);
}, 10 * 60 * 1000);
$("#copy-recovery").addEventListener("click", () => copyToClipboard($("#recovery").textContent!));

$("#arbiters").addEventListener("click", (e) => {
  const btn = (e.target as Element).closest<HTMLElement>("[data-arbiter]");
  if (!btn || !state.draft) return;
  state.draft.arbiter = btn.dataset.arbiter || null;
  for (const b of document.querySelectorAll("#arb-choice [data-arbiter]")) {
    b.classList.toggle("btn-accent", b === btn);
    b.classList.toggle("btn-ghost", b !== btn);
  }
  // Only the buyer knows the destination.
  const isBuyer = state.draft.side === "buyer";
  $("#commit-fields").hidden = !isBuyer;
  $("#commit-seller-note").hidden = isBuyer;
  step(3);
});

/* Prefill from a listing's Buy link. Fields stay editable, since prices get negotiated. */
{
  const q = new URL(location.href).searchParams;
  const domain = q.get("domain");
  if (domain) {
    $<HTMLInputElement>("#e-domain").value = domain;
    const amount = q.get("amount");
    if (amount && /^\d+$/.test(amount)) $<HTMLInputElement>("#e-amount").value = amount;
    const seller = q.get("seller");
    if (seller) $<HTMLInputElement>("#e-counterparty").value = seller;
    $<HTMLSelectElement>("#e-side").value = "buyer";
    const hint = $("#terms-hint");
    hint.className = "hint";
    hint.textContent = "Filled in from the listing. Check the price, then check the terms.";
  }
}

const joinCode = new URL(location.href).searchParams.get("join");
if (joinCode) openInvite(joinCode);

const wanted = new URL(location.href).searchParams.get("id");
if (wanted && /^[0-9a-f]{32}$/.test(wanted)) {
  $("#open-section").hidden = true;
  watch(wanted);
}
