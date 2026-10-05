// Generated from web/src/escrow.ts by scripts/build-web.ts. Edit that file instead.
import {
  CHAIN_APIS,
  SITE_RULES,
  addressToScript,
  arbiterIntersection,
  UNLOCKED_MAX_IDLE,
  bip21,
  btcAmount,
  buildAuthEvent,
  buildEscrowMessage,
  cardProblem,
  buildRumor,
  chatPartners,
  chatRoleOf,
  dmRelayListFilter,
  dmRelaysOf,
  escrowChats,
  giftWrapFilter,
  keyOfRole,
  readMessages,
  readMessagesWith,
  wrapForEach,
  wrapForEachWith,
  arbiterRule,
  applyDeletions,
  buildEscrowEvent,
  buildInvite,
  buildDeletion,
  buildKeyBackup,
  buildListing,
  buildReply,
  draftBackupPlaintext,
  buildRuling,
  chainApi,
  collectSettlements,
  compareViews,
  completeSettlement,
  decodeInvite,
  decodeRecovery,
  deletionFilter,
  decodeReply,
  deriveEscrowId,
  describeTree,
  encodeInvite,
  encodeRecovery,
  encodeReply,
  escrowFilters,
  escrowPublicKeyHex,
  escrowTree,
  escrowsForFilter,
  findFunding,
  generateSecretKey,
  isKeyBackup,
  keyBackupFilter,
  keyBackupPlaintext,
  keyBackupSlot,
  leafOfWitness,
  newestPerAddress,
  npubEncode,
  parseArbiterSet,
  parseEscrowEvent,
  parseDraftBackup,
  parseKeyBackup,
  parseListing,
  parseRuling,
  profileFilter,
  publishOutbox,
  publishToRelays,
  proposalOf,
  qrSvg,
  queryRelays,
  readDomain,
  rebuildFromRecovery,
  registrarFindings,
  resolveHandshake,
  settlementFee,
  settlementKey,
  shorten,
  signEvent,
  signSettlement,
  termsProblem,
  toPubkeyHex,
  tryDecodeNip19,
  tryNormaliseDomain,
  DELETION_KIND,
  ESCROW_D_PREFIX,
  ESCROW_KIND,
  LISTING_D_PREFIX,
  LISTING_KIND,
  RelayDirectory,
  RULING_D_PREFIX
} from "./fmd.js";
import { CONFIG } from "./config.js";
import {
  $,
  DISCOVERY_RELAYS,
  confirmDialog,
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
  sessionReady,
  toast
} from "./ui.js";
const ESCROW_RELAYS = DISCOVERY_RELAYS;
const NETWORK = CONFIG.network;
const RULES = SITE_RULES[NETWORK];
const chain = chainApi(NETWORK, CONFIG.chainApiBase.trim() || CHAIN_APIS[NETWORK]);
const state = {
  draft: null,
  watching: null,
  me: null,
  snap: null,
  own: new Map,
  pending: new Map,
  sentChat: new Map,
  chatSeen: new Map,
  chatDrafts: new Map
};
function paintNetwork() {
  const el = $("#net-badge");
  el.className = "net-badge" + (NETWORK === "mainnet" ? " mainnet" : "");
  el.innerHTML = NETWORK === "mainnet" ? `<b>mainnet</b>: real money` : `<b>${esc(NETWORK)}</b>: test coins, no value`;
}
function note(el, message, kind = "") {
  el.classList.remove("ok", "err");
  el.classList.add("hint");
  if (kind)
    el.classList.add(kind);
  el.textContent = message;
}
const fail = (el, message) => note(el, message, "err");
let loggedAt = 0;
function log(html, kind = "", append = false) {
  loggedAt = Date.now();
  $("#act-log").innerHTML = (append ? $("#act-log").innerHTML : "") + row(kind, html);
}
function remember(id, event) {
  state.own.set(id, [...(state.own.get(id) ?? []).filter((e) => e.id !== event.id), event]);
}
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytesOf = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
const random32 = () => crypto.getRandomValues(new Uint8Array(32));
function blocksAway(height, tip) {
  if (tip === undefined)
    return `block ${height}`;
  const left = height - tip;
  if (left <= 0)
    return `block ${height}, passed`;
  const minutes = left * 10;
  const span = minutes < 90 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`;
  return `block ${height}, in about ${span}`;
}
const windowText = (blocks) => {
  const hours = blocks * 10 / 60;
  return hours < 48 ? `about ${Math.round(hours)} hours` : `about ${Math.round(hours / 24)} days`;
};
function stamp(at) {
  const d = new Date(at * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "at an impossible time";
}
const registryCache = new Map;
async function registryOf(domain) {
  const cached = registryCache.get(domain);
  if (cached && now() - cached.at < 300)
    return cached.result;
  const result = await readDomain(domain, { now: now() }).catch((err) => ({ ok: false, reason: err.message }));
  if (result.ok)
    registryCache.set(domain, { at: now(), result });
  return result;
}
async function registryCheck(domain) {
  return checkOf(await registryOf(domain));
}
function registryCheckCached(domain) {
  const cached = registryCache.get(domain);
  return cached && now() - cached.at < 300 ? checkOf(cached.result) : undefined;
}
function registryCheckLast(domain) {
  const cached = registryCache.get(domain);
  return cached ? checkOf(cached.result) : undefined;
}
function checkOf(reading) {
  if (!reading.ok) {
    return "final" in reading && reading.final ? { problem: reading.reason, warnings: [] } : { problem: `the registry could not be read (${reading.reason})`, unread: true, warnings: [] };
  }
  const findings = registrarFindings(reading.facts, now());
  const refusal = findings.find((f) => f.level === "refuse");
  return {
    problem: refusal?.message,
    warnings: findings.filter((f) => f.level === "warn").map((f) => f.message),
    registrar: reading.facts.registrarName
  };
}
const ME_PREFIX = "fmd-escrow-me-v2:";
function keepMe(id, me) {
  if (me.role === "arbiter")
    return;
  try {
    sessionStorage.setItem(ME_PREFIX + id, JSON.stringify({ role: me.role, secret: hexOf(me.secret), at: now() }));
  } catch {}
}
function keptMe(id) {
  let raw = null;
  try {
    sessionStorage.removeItem("fmd-escrow-me-v1:" + id);
    raw = sessionStorage.getItem(ME_PREFIX + id);
  } catch {
    return null;
  }
  if (!raw)
    return null;
  try {
    const kept = JSON.parse(raw);
    const fresh = Number.isSafeInteger(kept.at) && now() - kept.at <= UNLOCKED_MAX_IDLE && kept.at <= now() + 300;
    if (fresh && (kept.role === "buyer" || kept.role === "seller") && typeof kept.secret === "string" && /^[0-9a-f]{64}$/.test(kept.secret)) {
      const secret = bytesOf(kept.secret);
      escrowPublicKeyHex(secret);
      const me = { role: kept.role, secret };
      keepMe(id, me);
      return me;
    }
  } catch {}
  forgetMe(id);
  return null;
}
function forgetMe(id) {
  try {
    sessionStorage.removeItem(ME_PREFIX + id);
  } catch {}
}
const canBackUp = () => !!session.signer?.nip44 && !!session.pubkey;
const BACKUP_IS_ENOUGH = NETWORK !== "mainnet";
const BACKUP_QUORUM = Math.max(1, Math.min(2, ESCROW_RELAYS.length));
async function backUpKey(recovery, info) {
  const signer = session.signer;
  const me = session.pubkey;
  if (!signer?.nip44 || !me)
    throw new Error("the connected key can't encrypt, so it can't keep a backup");
  const plaintext = keyBackupPlaintext({ v: 1, recovery, id: info.id, role: info.role, domain: info.domain, amountSats: info.amountSats, network: info.network, at: now() });
  const ciphertext = await signer.nip44.encrypt(me, plaintext);
  if (await signer.nip44.decrypt(me, ciphertext) !== plaintext)
    throw new Error("the backup didn't open again");
  const event = await signer.signEvent(buildKeyBackup({ pubkey: me, slot: keyBackupSlot(info.secret), ciphertext, createdAt: Math.max(now(), (info.after ?? 0) + 1) }));
  if (session.pubkey !== me)
    throw new Error("the connected key changed");
  const results = await publishToRelays(ESCROW_RELAYS, event);
  if (!results.some((r) => r.ok))
    return { ok: 0, of: results.length };
  let held = 0;
  await queryRelays(ESCROW_RELAYS, [{ ids: [event.id] }], {
    timeoutMs: 6000,
    onRelayDone: (_relay, count) => {
      if (count > 0)
        held++;
    }
  }).catch(() => []);
  return { ok: held, of: results.length };
}
async function findBackups() {
  const signer = session.signer;
  const me = session.pubkey;
  if (!signer?.nip44 || !me)
    return { backups: [], drafts: [], answered: 0 };
  let answered = 0;
  const events = await queryRelays(ESCROW_RELAYS, [keyBackupFilter(me)], {
    timeoutMs: 6000,
    onRelayDone: (_relay, _count, _error, complete) => {
      if (complete)
        answered++;
    }
  }).catch(() => []);
  const byId = new Map;
  const drafts = [];
  for (const event of newestPerAddress(events.filter((e) => e.pubkey === me && isKeyBackup(e)))) {
    try {
      const plaintext = await signer.nip44.decrypt(me, event.content);
      const out = parseKeyBackup(plaintext);
      if (out.ok) {
        if (out.backup.network !== NETWORK)
          continue;
        const before = byId.get(out.backup.id);
        if (!before || out.backup.at > before.at)
          byId.set(out.backup.id, out.backup);
        continue;
      }
      const draft = parseDraftBackup(plaintext);
      if (draft.ok && draft.draft.network === NETWORK)
        drafts.push(draft.draft);
    } catch {}
  }
  return { backups: [...byId.values()].sort((a, b) => b.at - a.at), drafts: drafts.sort((a, b) => b.at - a.at), answered };
}
function meFromRecovery(text) {
  const decoded = decodeRecovery(text);
  if (!decoded.ok)
    return { problem: sentence(decoded.reason) };
  let rebuilt;
  try {
    rebuilt = rebuildFromRecovery(decoded.recovery);
  } catch (err) {
    return { problem: err.message };
  }
  if (rebuilt.role === "arbiter")
    return { problem: "That string holds the arbiter key" };
  const r = decoded.recovery;
  return {
    me: { role: rebuilt.role, secret: r.secretKey },
    keys: [hexOf(r.buyer), hexOf(r.seller), ...r.arbiter ? [hexOf(r.arbiter)] : []],
    address: rebuilt.tree.addresses[NETWORK]
  };
}
function enterEscrow(id, me, keys) {
  state.me = me;
  keepMe(id, me);
  rememberKeys(id, keys);
  setUrl(id, keys);
  $("#open-section").hidden = true;
  $("#join-section").hidden = true;
  watch(id);
}
const mineBackups = new Map;
async function findMine(auto = false) {
  const hint = $("#mine-hint");
  const out = $("#mine-out");
  if (!session.pubkey)
    await sessionReady();
  if (!session.pubkey || !session.signer) {
    if (!auto) {
      note(hint, "Connect first. Your escrows are backed up under your account.");
      openConnect();
    }
    return;
  }
  if (!session.signer.nip44) {
    note(hint, "Your signer can't decrypt (it has no NIP-44), so open an escrow with its recovery string below.");
    return;
  }
  note(hint, "Looking for your escrows… your signer may ask to decrypt them.");
  const reader = session.pubkey;
  const found = await findBackups();
  if (session.pubkey !== reader)
    return;
  mineBackups.clear();
  mineDrafts.clear();
  for (const b of found.backups)
    mineBackups.set(b.id, b);
  for (const d of found.drafts)
    mineDrafts.set(keyBackupSlot(bytesOf(d.key)), d);
  paintInbox();
  const any = found.backups.length + found.drafts.length;
  note(hint, any ? "Newest first." : found.answered ? "No escrows are backed up under this account yet." : "The relays didn't answer. Try again in a minute.");
  out.innerHTML = found.drafts.map((d) => `<div class="invite-row">
      <div><b>${esc(d.domain)}</b> · ${sats(d.amountSats)} sats · you are the ${esc(d.role)}
        <span>Invite sent ${esc(localTime(d.at))} · waiting for their reply</span></div>
      <button class="btn btn-accent btn-sm" type="button" data-draft="${esc(keyBackupSlot(bytesOf(d.key)))}">Continue</button>
    </div>`).join("") + found.backups.map((b) => `<div class="invite-row">
      <div><b>${esc(b.domain)}</b> · ${sats(b.amountSats)} sats · you are the ${esc(b.role)}
        <span>Escrow ${esc(b.id.slice(0, 12))}… · key backed up ${esc(localTime(b.at))}</span></div>
      <button class="btn btn-accent btn-sm" type="button" data-mine="${esc(b.id)}">Open</button>
    </div>`).join("");
}
const mineDrafts = new Map;
function continueDraft(slot) {
  const draft = mineDrafts.get(slot);
  if (!draft)
    return;
  const signed = decodeInvite(draft.invite);
  if (!signed.ok) {
    fail($("#mine-hint"), `That invite doesn't read: ${signed.reason}.`);
    return;
  }
  const i = signed.invite;
  const d = {
    domain: i.domain,
    amountSats: i.amountSats,
    side: i.initiatorRole,
    me: signed.from,
    counterparty: i.to,
    buyerNostr: i.initiatorRole === "buyer" ? signed.from : i.to,
    sellerNostr: i.initiatorRole === "seller" ? signed.from : i.to,
    arbiterOptions: [i.arbiter],
    arbiter: i.arbiter,
    salt: i.salt,
    invite: { invite: i, from: signed.from, id: signed.id },
    invitedAt: draft.at,
    mySecret: bytesOf(draft.key)
  };
  d.resumed = true;
  state.draft = d;
  state.inviteSaved = true;
  $("#sum-1").innerHTML = `<span><b>${esc(i.domain)}</b> · ${sats(i.amountSats)} sats · you ${i.initiatorRole === "buyer" ? "buy from" : "sell to"}
    <b>${esc(shorten(npubEncode(i.to), 8))}</b></span>`;
  $("#sum-2").innerHTML = `<span>Arbiter <b>${esc(shorten(npubEncode(i.arbiter), 8))}</b> · decides a dispute · after funding,
    the seller has ${windowText(i.deliverBlocks)} to transfer the domain to the buyer</span>`;
  showInvite(d, draft.invite);
  $("#steps").scrollIntoView({ behavior: "smooth", block: "start" });
}
function openBackup(id) {
  const b = mineBackups.get(id);
  if (!b)
    return;
  const got = meFromRecovery(b.recovery);
  if ("problem" in got) {
    fail($("#mine-hint"), `That backup doesn't open: ${got.problem}.`);
    return;
  }
  enterEscrow(b.id, got.me, got.keys);
}
async function openFromBackup(id, auto) {
  if (state.me || auto && state.backupTried === id)
    return;
  state.backupTried = id;
  const hint = () => document.getElementById("me-hint");
  if (!session.pubkey)
    await sessionReady();
  if (!session.signer?.nip44) {
    if (!auto && hint())
      fail(hint(), "Connect a key that can decrypt first.");
    return;
  }
  if (!auto && hint())
    note(hint(), "Looking for your key… your signer may ask.");
  const found = await findBackups();
  if (state.me || state.watching !== id)
    return;
  const b = found.backups.find((x) => x.id === id);
  const got = b ? meFromRecovery(b.recovery) : undefined;
  if (!got || "problem" in got) {
    if (!auto && hint())
      note(hint(), found.answered ? "No key for this escrow is backed up under your account. Paste your recovery string instead." : "The relays didn't answer. Try again in a minute.");
    return;
  }
  state.me = got.me;
  keepMe(id, got.me);
  log("Opened with your key from your Nostr backup.", "good");
  if (state.snap)
    render(state.snap);
  refreshWanted();
}
async function backUpPasted(id, text, me, view) {
  if (me.role === "arbiter" || !canBackUp())
    return;
  try {
    const reach = await backUpKey(text, { id, role: me.role, domain: view.domain, amountSats: view.amountSats, network: view.network, secret: me.secret });
    if (reach.ok >= BACKUP_QUORUM && state.watching === id) {
      log(`Your key for this escrow is now backed up to your account, so connecting opens this escrow next time.`, "good", true);
    }
  } catch {}
}
const authAs = (secret) => async (relay, challenge) => signEvent(buildAuthEvent({ relay, challenge, pubkey: escrowPublicKeyHex(secret), createdAt: now() }), secret);
const authWithSigner = () => async (relay, challenge) => session.signer && session.pubkey ? session.signer.signEvent(buildAuthEvent({ relay, challenge, pubkey: session.pubkey, createdAt: now() })) : undefined;
const dmRelayCache = new Map;
async function dmRelaysFor(pubkey) {
  const cached = dmRelayCache.get(pubkey);
  if (cached && now() - cached.at < 600)
    return cached.relays;
  const events = await queryRelays(ESCROW_RELAYS, [dmRelayListFilter([pubkey])], { timeoutMs: 5000 }).catch(() => []);
  const newest = events.filter((e) => e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at)[0];
  const relays = newest ? dmRelaysOf(newest).slice(0, 4) : [];
  dmRelayCache.set(pubkey, { at: now(), relays });
  return relays;
}
const partiesOf = (view) => ({ id: view.id, buyer: view.buyer, seller: view.seller, arbiter: view.arbiter });
async function relaysOfKey(view, key) {
  return [...new Set([...ESCROW_RELAYS, ...key === view.arbiter ? await dmRelaysFor(view.arbiter) : []])];
}
async function readChats(view, secret) {
  const me = escrowPublicKeyHex(secret);
  let answered = 0;
  const wraps = await queryRelays(await relaysOfKey(view, me), [{ ...giftWrapFilter(me), limit: 500 }], {
    timeoutMs: 6000,
    auth: authAs(secret),
    onRelayDone: (_relay, _count, _error, complete) => {
      if (complete)
        answered++;
    }
  }).catch(() => []);
  return { byPartner: escrowChats(readMessages(wraps, secret).messages, partiesOf(view), me), answered };
}
function mergeChats(before, after) {
  if (!before)
    return after;
  const byPartner = new Map;
  for (const partner of new Set([...before.byPartner.keys(), ...after.byPartner.keys()])) {
    const all = new Map((before.byPartner.get(partner) ?? []).map((m) => [m.id, m]));
    for (const m of after.byPartner.get(partner) ?? [])
      all.set(m.id, m);
    byPartner.set(partner, [...all.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)));
  }
  return { byPartner, answered: Math.max(before.answered, after.answered) };
}
function chatOf(snap, partner) {
  const all = new Map;
  for (const m of [...snap.chats?.byPartner.get(partner) ?? [], ...state.sentChat.get(`${snap.id}:${partner}`) ?? []])
    all.set(m.id, m);
  return [...all.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}
async function sendTo(snap, partner, text, card) {
  const me = state.me;
  const parties = partiesOf(snap.view);
  const sender = escrowPublicKeyHex(me.secret);
  const recipient = keyOfRole(parties, partner);
  const rumor = buildEscrowMessage({ parties, sender, recipient, content: text, createdAt: now(), card });
  const recipients = [recipient, sender];
  const wraps = wrapForEach(rumor, me.secret, recipients, now());
  const results = await Promise.all(wraps.map(async (wrap, i) => publishToRelays(await relaysOfKey(snap.view, recipients[i]), wrap, { auth: authAs(me.secret) }).catch(() => [])));
  if (!results[0].some((r) => r.ok))
    throw new Error(`No relay took the message for the ${partner}. Nothing was sent; try again in a minute.`);
  const key = `${snap.id}:${partner}`;
  state.sentChat.set(key, [...state.sentChat.get(key) ?? [], {
    id: rumor.id,
    from: chatRoleOf(parties, sender),
    to: partner,
    author: sender,
    at: rumor.created_at,
    text: rumor.content,
    ...card ? { card } : {}
  }]);
  if (state.snap?.id === snap.id)
    paintThread();
}
async function tell(snap, partner, text) {
  try {
    await sendTo(snap, partner, text);
  } catch (err) {
    log(`Done, but the note to the ${partner} didn't go out: ${esc(err.message)}`, "", true);
  }
}
async function sendInviteDm(d, link) {
  const out = $("#dm-invite-out");
  const signer = session.signer;
  if (!signer?.nip44 || session.pubkey !== d.me || !d.invite) {
    fail(out, "Connect the account you started with; it seals the message.");
    return;
  }
  note(out, "Sealing it for them… your signer may ask.");
  try {
    const rumor = buildRumor({
      pubkey: d.me,
      recipient: d.counterparty,
      createdAt: now(),
      subject: "flexmydomain escrow invite",
      content: `I've opened an escrow on flexmydomain: ${d.domain} for ${sats(d.amountSats)} sats, with you as the ` + `${d.side === "buyer" ? "seller" : "buyer"}. Open this link to read the terms and accept:
${link}`,
      tags: [["fmd_invite", d.invite.id]]
    });
    const [wrap] = await wrapForEachWith(rumor, signer, [d.counterparty], now());
    const relays = [...new Set([...await dmRelaysFor(d.counterparty), ...ESCROW_RELAYS])];
    const results = await publishToRelays(relays, wrap, { auth: authWithSigner() });
    const ok = results.filter((r) => r.ok).length;
    if (!ok)
      throw new Error("no relay took it");
    note(out, `Sent privately (${ok} of ${results.length} relays).`, "ok");
  } catch (err) {
    fail(out, `Not sent: ${err.message}. Send the link another way, below.`);
    const fold = document.querySelector("#invite-fold");
    if (fold)
      fold.open = true;
  }
}
async function sendReplyPrivately(j, replyText) {
  const secret = j.mySecret;
  const to = j.invite.invite.initiatorKey;
  const rumor = buildRumor({
    pubkey: escrowPublicKeyHex(secret),
    recipient: to,
    createdAt: now(),
    subject: "flexmydomain escrow reply",
    content: replyText,
    tags: [["fmd_reply", j.invite.id]]
  });
  const [wrap] = wrapForEach(rumor, secret, [to], now());
  const results = await publishToRelays(ESCROW_RELAYS, wrap, { auth: authAs(secret) }).catch(() => []);
  return results.some((r) => r.ok);
}
function watchForReply(d, from) {
  if (state.replyWatch)
    clearInterval(state.replyWatch);
  const since = (from ?? now()) - 60;
  let busy = false;
  const stop = () => {
    if (state.replyWatch)
      clearInterval(state.replyWatch);
    state.replyWatch = undefined;
  };
  const check = async () => {
    if (!d.invite || d.realised || !d.mySecret) {
      stop();
      return;
    }
    if (busy)
      return;
    busy = true;
    try {
      const me = escrowPublicKeyHex(d.mySecret);
      const wraps = await queryRelays(ESCROW_RELAYS, [giftWrapFilter(me, since)], { timeoutMs: 5000, auth: authAs(d.mySecret) }).catch(() => []);
      for (const { rumor } of readMessages(wraps, d.mySecret).messages) {
        const code = rumor.content.match(/fmdrep5[A-Za-z0-9_-]+/)?.[0];
        if (!code || !d.invite || !decodeReply(code, d.invite).ok)
          continue;
        stop();
        $("#e-reply").value = code;
        useReply();
        return;
      }
    } finally {
      busy = false;
    }
  };
  state.replyWatch = window.setInterval(() => void check(), 8000);
  check();
}
async function checkInbox() {
  if (!session.pubkey)
    await sessionReady();
  if (!session.pubkey || !session.signer) {
    note($("#inbox-hint"), "Connect first.");
    openConnect();
    return;
  }
  const signer = session.signer;
  if (!signer.nip44) {
    fail($("#inbox-hint"), "Your signer can't read private messages (it has no NIP-44).");
    return;
  }
  const me = session.pubkey;
  note($("#inbox-hint"), "Reading your messages… your signer may ask to decrypt them.");
  const relays = [...new Set([...await dmRelaysFor(me), ...ESCROW_RELAYS])];
  const wraps = await queryRelays(relays, [{ ...giftWrapFilter(me, now() - 14 * 86400), limit: 100 }], {
    timeoutMs: 6000,
    auth: authWithSigner()
  }).catch(() => []);
  const { messages } = await readMessagesWith(wraps, signer);
  if (session.pubkey !== me)
    return;
  const invites = messages.flatMap(({ rumor, sender }) => {
    const code = rumor.content.match(/fmdinv5[A-Za-z0-9_-]+/)?.[0];
    if (!code)
      return [];
    const parsed = decodeInvite(code);
    if (!parsed.ok || parsed.invite.to !== me || parsed.from !== sender)
      return [];
    return [{ code, parsed, at: rumor.created_at }];
  });
  const newest = new Map;
  for (const i of invites) {
    const key = `${i.parsed.from}|${i.parsed.invite.domain}`;
    const seen = newest.get(key);
    if (!seen || i.at > seen.at)
      newest.set(key, i);
  }
  const shown = [...newest.values()].sort((a, b) => b.at - a.at);
  inboxShown = shown.map((i) => ({
    code: i.code,
    initiatorKey: i.parsed.invite.initiatorKey,
    domain: i.parsed.invite.domain,
    amountSats: i.parsed.invite.amountSats,
    from: i.parsed.from,
    at: i.at,
    side: i.parsed.invite.initiatorRole === "buyer" ? "seller" : "buyer"
  }));
  inboxOlder = invites.length - shown.length;
  inboxRead = true;
  paintInbox();
}
let inboxShown = [];
let inboxOlder = 0;
let inboxRead = false;
function paintInbox() {
  const out = document.querySelector("#inbox-out");
  const alert = document.querySelector("#inbox-alert");
  if (!out || !alert)
    return;
  const answered = (initiatorKey) => [...mineBackups.values()].find((b) => {
    const r = decodeRecovery(b.recovery);
    return r.ok && [hexOf(r.recovery.buyer), hexOf(r.recovery.seller)].includes(initiatorKey);
  });
  const rowOf = (i, lead = false) => {
    const joined = answered(i.initiatorKey);
    return `<div class="invite-row${lead ? " lead" : ""}">
      <div><b>${esc(i.domain)}</b> · ${sats(i.amountSats)} sats · you'd be the ${i.side}
        <span>from ${esc(shorten(npubEncode(i.from), 10))} · ${esc(localTime(i.at))}${joined ? " · you joined this escrow" : ""}</span></div>
      ${joined ? `<button class="btn btn-ghost btn-sm" type="button" data-mine="${esc(joined.id)}">Open the escrow</button>` : `<a class="btn ${lead ? "btn-accent" : "btn-ghost"} btn-sm" href="?join=${esc(i.code)}">${lead ? "Open the invite" : "Open"}</a>`}
    </div>`;
  };
  const waiting = inboxShown.filter((i) => !answered(i.initiatorKey));
  const done = inboxShown.filter((i) => answered(i.initiatorKey));
  alert.hidden = waiting.length === 0 || !!state.draft;
  alert.innerHTML = waiting.length ? `<h3>${waiting.length === 1 ? "You received an invite for a deal" : `You received ${waiting.length} invites for deals`}</h3>
       ${rowOf(waiting[0], true)}
       ${waiting.length > 1 ? `<p class="inbox-older">Older invites</p>${waiting.slice(1).map((i) => rowOf(i)).join("")}` : ""}` : "";
  out.innerHTML = done.map((i) => rowOf(i)).join("");
  if (!inboxRead)
    return;
  note($("#inbox-hint"), waiting.length ? `${waiting.length === 1 ? "Your invite is" : `${waiting.length} invites are`} at the top of the page.` + (inboxOlder ? ` ${inboxOlder} older one${inboxOlder === 1 ? "" : "s"} from the same sender for the same domain ${inboxOlder === 1 ? "is" : "are"} left out: only the newest can still be finished.` : "") : done.length ? "Invites you have answered." : "No escrow invites in your messages from the last two weeks.", waiting.length ? "ok" : "");
}
const SIGNER_PATIENCE = 2 * 60 * 1000;
function patiently(work) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Your signer didn't answer. Try again.")), SIGNER_PATIENCE);
    work.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
async function checkTerms(event) {
  event.preventDefault();
  const hint = $("#terms-hint");
  const out = $("#terms-out");
  if (!session.pubkey)
    await sessionReady();
  if (!session.pubkey) {
    note(hint, "Connect first. Your account is how the other side knows it's you.");
    openConnect();
    return;
  }
  if (state.draft?.invite)
    return;
  const domain = tryNormaliseDomain($("#e-domain").value);
  if (!domain.ok) {
    fail(hint, domain.reason);
    return;
  }
  const amountText = $("#e-amount").value.replace(/[\s,_]/g, "");
  const amountSats = /^\d{1,16}$/.test(amountText) ? Number(amountText) : NaN;
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    fail(hint, "The price must be a whole number of sats.");
    return;
  }
  if (amountSats < 2000) {
    fail(hint, "Too small to escrow: the settlement fee would exceed it.");
    return;
  }
  const counterparty = toPubkeyHex($("#e-counterparty").value.trim());
  if (!counterparty) {
    fail(hint, "That is not an npub or a hex pubkey.");
    return;
  }
  if (counterparty === session.pubkey) {
    fail(hint, "You cannot trade with yourself.");
    return;
  }
  note(hint, "Checking the domain with its registry…");
  const button = $("#terms-btn");
  button.disabled = true;
  const check = await registryCheck(domain.domain).finally(() => {
    button.disabled = false;
  });
  if (check.problem) {
    fail(hint, `${sentence(check.problem)}.${check.unread ? " Try again in a minute." : ""}`);
    return;
  }
  const side = $("#e-side").value;
  state.draft = {
    domain: domain.domain,
    amountSats,
    side,
    me: session.pubkey,
    counterparty,
    buyerNostr: side === "buyer" ? session.pubkey : counterparty,
    sellerNostr: side === "seller" ? session.pubkey : counterparty
  };
  note(hint, "");
  out.hidden = false;
  const at = check.registrar ? ` at ${esc(check.registrar)}` : "";
  out.innerHTML = row("good", `The registry shows <b>${esc(domain.domain)}</b> registered${at}, so it can change hands.`) + check.warnings.map((w) => row("", esc(sentence(w)) + ".")).join("");
  $("#sum-1").innerHTML = `<span><b>${esc(domain.domain)}</b> · ${sats(amountSats)} sats · you ${side === "buyer" ? "buy from" : "sell to"}
      <b>${esc(shorten(npubEncode(counterparty), 8))}</b>${at}${check.warnings.length ? ` · ${check.warnings.length} warning${check.warnings.length === 1 ? "" : "s"}` : ""}</span>
    <button class="link-btn" type="button" data-goto="1">Change</button>`;
  $("#arbiters").innerHTML = row("", "Reading both sides' published arbiter lists…");
  step(2);
  await loadArbiters();
}
const siteArbiters = () => {
  const site = toPubkeyHex(String(CONFIG.arbiterPubkey ?? "").trim());
  return site ? [site] : [];
};
async function readArbiterLists(buyerNostr, sellerNostr) {
  let answered = 0;
  try {
    const events = await queryRelays(ESCROW_RELAYS, profileFilter([buyerNostr, sellerNostr]), {
      timeoutMs: 6000,
      onRelayDone: (_relay, _count, _error, complete) => {
        if (complete)
          answered++;
      }
    });
    const setOf = (pubkey) => newestPerAddress(events.filter((e) => e.pubkey === pubkey)).map((e) => parseArbiterSet(e)).find((v) => v !== undefined);
    return { buyer: setOf(buyerNostr), seller: setOf(sellerNostr), answered };
  } catch {
    return { answered };
  }
}
async function loadArbiters() {
  const draft = state.draft;
  const { buyerNostr, sellerNostr } = draft;
  const lists = await readArbiterLists(buyerNostr, sellerNostr);
  if (state.draft !== draft)
    return;
  if (lists.answered === 0) {
    state.draft.arbiterOptions = [];
    $("#arbiters").innerHTML = row("bad", `<b>The relays didn't answer</b>, so neither side's arbiter list could be
      read, and no arbiter can be offered yet. Check the terms again in a minute.`);
    return;
  }
  const siteArbiter = siteArbiters().find((a) => a !== buyerNostr && a !== sellerNostr);
  const result = arbiterIntersection(lists.buyer, lists.seller, siteArbiters(), [buyerNostr, sellerNostr]);
  const usable = result.arbiters;
  state.draft.arbiterOptions = usable;
  const rows = [];
  if (lists.buyer === undefined || lists.seller === undefined) {
    const silent = lists.buyer === undefined && lists.seller === undefined ? "Neither side has" : `The ${lists.buyer === undefined ? "buyer" : "seller"} has`;
    rows.push(row("", `${silent} published an arbiter list, which counts as accepting only this
      site's arbiter. One side's list alone never picks the arbiter, since that side could list its
      own second key.`));
  }
  if (usable.length === 0) {
    const why = siteArbiters().length === 0 ? "This site names no arbiter" : !siteArbiter ? "This site's arbiter is one of you, so it can't judge your trade" : "Your published lists don't both accept this site's arbiter";
    rows.push(row("bad", `<b>No arbiter.</b> ${why}, and every escrow here needs one: it decides if the two of you
      disagree. Widen a list, or there is no trade.`));
  } else {
    rows.push(`<div class="key-choice" id="arb-choice">` + usable.map((pubkey) => `<button class="btn btn-ghost" type="button" data-arbiter="${esc(pubkey)}">
         ${esc(shorten(npubEncode(pubkey), 10))}<span>${siteArbiters().includes(pubkey) ? "this site's arbiter" : "an arbiter you both accept"}:
           decides a dispute from the registry's record, never holds the domain, and never moves money alone</span>
       </button>`).join("") + `</div>`);
  }
  rows.push(row("", `<b>The deadlines.</b> After funding, the seller has ${windowText(RULES.deliverBlocks)} to transfer
    the domain to the buyer. The buyer confirms it arrived, which pays the seller; if either of you disagrees, the
    arbiter decides. If the seller doesn't say it's sent in time, the buyer is refunded. If nobody acts at all, the timelock
    refunds the buyer after ${RULES.timeoutBlocks} blocks.`));
  $("#arbiters").innerHTML = rows.join("");
  if (usable.length === 1 && $('.step[data-step="2"]').classList.contains("on"))
    chooseArbiter(usable[0]);
}
function chooseArbiter(pubkey) {
  const d = state.draft;
  if (!d || d.invite || !d.arbiterOptions?.includes(pubkey))
    return;
  d.arbiter = pubkey;
  for (const b of document.querySelectorAll("#arb-choice [data-arbiter]")) {
    b.classList.toggle("btn-accent", b.dataset.arbiter === pubkey);
    b.classList.toggle("btn-ghost", b.dataset.arbiter !== pubkey);
  }
  $("#sum-2").innerHTML = `<span>Arbiter <b>${esc(shorten(npubEncode(pubkey), 8))}</b> · decides a dispute · after funding,
      the seller has ${windowText(RULES.deliverBlocks)} to transfer the domain to the buyer</span>` + ((d.arbiterOptions?.length ?? 0) > 1 ? `<button class="link-btn" type="button" data-goto="2">Change</button>` : "");
  step(3);
}
function renderDerivation(tree, address, id) {
  const t = describeTree(tree);
  return `<div class="derive">
    <div class="derive-row"><span class="k">Address</span><span class="v big">${esc(address)}</span></div>
    <div class="derive-row"><span class="k">Escrow id</span><span class="v">${esc(id)}</span></div>
    <div class="derive-row"><span class="k">Shape</span><span class="v">${esc(t.shape)}</span></div>
    <div class="derive-row"><span class="k">Internal key</span><span class="v">${esc(t.internalKey)} <small>(the NUMS point plus r·G, r from the escrow id: no key path exists)</small></span></div>
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
      <code>bun test test/vectors/escrow.test.ts test/vectors/binding.test.ts</code>, or spend every leaf against a real
      node with <code>bun run test:regtest</code>.</p>
  </div>`;
}
const describeLeaf = (l) => ({
  cooperative: "buyer + seller: the normal path, without the arbiter",
  "arbiter-release": "arbiter + seller: pays the seller under the rules",
  "arbiter-refund": "arbiter + buyer: refunds the buyer under the rules",
  timeout: "the buyer alone, after the timelock (the backstop)"
})[l.role] ?? l.role;
function ensureKey(draft) {
  if (!draft.mySecret)
    draft.mySecret = generateSecretKey();
  return escrowPublicKeyHex(draft.mySecret);
}
function realise(resolved) {
  const params = {
    salt: resolved.salt,
    buyer: bytesOf(resolved.buyerKey),
    seller: bytesOf(resolved.sellerKey),
    arbiter: bytesOf(resolved.arbiter),
    timeoutBlocks: resolved.timeoutBlocks,
    deliverBlocks: resolved.deliverBlocks,
    network: resolved.network,
    amountSats: resolved.amountSats,
    domain: resolved.domain
  };
  const tree = escrowTree(params);
  return { params, tree, id: deriveEscrowId(params), address: tree.addresses[params.network] };
}
function showReady(draft, realised, myRole) {
  draft.realised = realised;
  draft.myRole = myRole;
  $("#recovery").textContent = encodeRecovery({
    version: 1,
    secretKey: draft.mySecret,
    buyer: realised.params.buyer,
    seller: realised.params.seller,
    arbiter: realised.params.arbiter,
    timeoutTo: "buyer",
    timeoutBlocks: realised.params.timeoutBlocks,
    binding: bytesOf(realised.id)
  });
  $("#ready-addr").hidden = false;
  $("#ready-addr").innerHTML = `<span class="k">Escrow address</span>
    <span class="v">${esc(realised.address)}</span>
    <span class="note">Derived here from both keys. Your counterparty's page derives the very same one.</span>`;
  $("#recovery-box").hidden = false;
  $("#derivation-box").hidden = false;
  $("#derivation").innerHTML = renderDerivation(realised.tree, realised.address, realised.id);
  $("#publish-escrow").hidden = false;
  $("#publish-escrow").disabled = !$("#saved-recovery").checked;
  backupDraft(draft);
}
async function backupDraft(d) {
  const status = $("#backup-status");
  const text = $("#recovery").textContent ?? "";
  const r = d.realised;
  state.backedUp = false;
  const needString = (html) => {
    status.innerHTML = row("bad", html);
    $("#recovery-fold").open = true;
    $("#saved-ack").hidden = false;
  };
  if (!r || !d.myRole || !d.mySecret)
    return;
  if (!canBackUp()) {
    needString(`<b>Save your recovery string below.</b> Your connected key can't encrypt (it has no NIP-44), so it can't
      keep a backup, and this string is the only copy of your key to this escrow.`);
    return;
  }
  if (!BACKUP_IS_ENOUGH)
    $("#recovery-fold").open = true;
  status.innerHTML = row("", "Backing up your key to your Nostr account, encrypted so only your key can open it… your signer may ask.");
  try {
    const reach = await backUpKey(text, { id: r.id, role: d.myRole, domain: r.params.domain, amountSats: r.params.amountSats, network: r.params.network, secret: d.mySecret, after: d.draftSavedAt });
    if (state.draft !== d)
      return;
    if (reach.ok < BACKUP_QUORUM) {
      needString(`<b>Only ${reach.ok} of ${reach.of} relays kept the backup</b>, too few to count on. Save your recovery string below.`);
      return;
    }
    state.backedUp = true;
    if (!BACKUP_IS_ENOUGH) {
      status.innerHTML = row("good", `<b>Your key is backed up</b> to your Nostr account (${reach.ok} of ${reach.of} relays keep it),
        encrypted so only your key can open it. This is real money, so keep your own copy too: save the recovery string
        below, then tick the box.`);
      return;
    }
    state.saved = true;
    status.innerHTML = row("good", `<b>Your key is backed up</b> to your Nostr account (${reach.ok} of ${reach.of} relays keep it),
      encrypted so only your key can open it. Connect this key on any device and this escrow opens. An offline copy
      is still a good idea.`);
    $("#saved-ack").hidden = true;
    $("#publish-escrow").disabled = false;
  } catch (err) {
    if (state.draft !== d)
      return;
    needString(`<b>The backup didn't go through</b> (${esc(err.message)}). Save your recovery string below.`);
  }
}
function saveRecoveryFile(info) {
  const body = [
    "flexmydomain escrow recovery",
    "",
    `Escrow id: ${info.id}`,
    `Escrow address: ${info.address}`,
    `Network: ${info.network}`,
    `Your side: ${info.role}`,
    "",
    "Your recovery string. It holds your private key for this escrow: keep it secret, and keep it until the escrow has paid out.",
    "recover.html takes it to sweep the escrow after the timelock if this site is gone.",
    info.recovery,
    ""
  ].join(`
`);
  const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `escrow-${info.id.slice(0, 12)}-recovery.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadRecovery() {
  const d = state.draft;
  const text = $("#recovery").textContent ?? "";
  if (!d?.realised || !text)
    return;
  saveRecoveryFile({ id: d.realised.id, address: d.realised.address, network: d.realised.params.network, role: d.myRole ?? "", recovery: text });
}
function downloadMyRecovery() {
  const snap = state.snap;
  const me = state.me;
  if (!snap || !me || me.role === "arbiter")
    return;
  const v = snap.view;
  const recovery = encodeRecovery({
    version: 1,
    secretKey: me.secret,
    buyer: bytesOf(v.buyer),
    seller: bytesOf(v.seller),
    arbiter: bytesOf(v.arbiter),
    timeoutTo: "buyer",
    timeoutBlocks: v.timeoutBlocks,
    binding: bytesOf(v.id)
  });
  saveRecoveryFile({ id: v.id, address: v.address, network: v.network, role: me.role, recovery });
}
async function createInvite() {
  const hint = $("#commit-hint");
  const d = state.draft;
  if (!d)
    return;
  if (d.invite || state.inviting)
    return;
  if (!d.arbiter) {
    fail(hint, "Choose the arbiter first.");
    return;
  }
  state.inviting = true;
  $("#invite-btn").disabled = true;
  try {
    await makeInvite(d, hint);
  } finally {
    state.inviting = false;
    $("#invite-btn").disabled = false;
  }
}
async function makeInvite(d, hint) {
  if (!d.arbiter)
    return;
  if (!session.signer)
    await sessionReady();
  if (!session.signer || session.pubkey !== d.me) {
    fail(hint, "Connect the account you started with. It signs the invite, so the other side knows it's you.");
    return;
  }
  if (d.realised) {
    fail(hint, "You already used their reply, so this escrow's terms are fixed. To change them, reload the page and start a new one.");
    return;
  }
  const myKey = ensureKey(d);
  if (!d.salt)
    d.salt = hexOf(random32());
  const invite = {
    salt: d.salt,
    domain: d.domain,
    amountSats: d.amountSats,
    network: NETWORK,
    timeoutBlocks: RULES.timeoutBlocks,
    deliverBlocks: RULES.deliverBlocks,
    arbiter: d.arbiter,
    initiatorRole: d.side,
    initiatorKey: myKey,
    to: d.counterparty
  };
  let code;
  try {
    note(hint, "Waiting for your signer…");
    const signed = await patiently(session.signer.signEvent(buildInvite(invite, { pubkey: d.me, createdAt: now() })));
    d.invite = { invite, from: d.me, id: signed.id };
    d.invitedAt = signed.created_at;
    code = encodeInvite(signed);
  } catch (err) {
    fail(hint, err.message);
    return;
  }
  note(hint, "Invite ready.", "ok");
  showInvite(d, code);
  const link = `${location.origin}${location.pathname}?join=${code}`;
  const private_ = !!session.signer?.nip44 && session.pubkey === d.me;
  (async () => {
    if (private_)
      await sendInviteDm(d, link);
    await backupInvite(d, code);
  })();
}
function showInvite(d, code) {
  const link = `${location.origin}${location.pathname}?join=${code}`;
  $("#sum-3").innerHTML = `<span>Invite made · your key for this trade is in it</span>`;
  const private_ = !!session.signer?.nip44 && session.pubkey === d.me;
  const who = `<b>${esc(shorten(npubEncode(d.counterparty), 10))}</b>`;
  const linkBox = `<div class="nsec" id="invite-link">${esc(link)}</div>
      <div class="btn-row">
        <button class="btn ${private_ ? "btn-ghost" : "btn-accent"} btn-sm" type="button" id="copy-invite">Copy link</button>
        ${private_ ? `<button class="btn btn-ghost btn-sm" type="button" id="dm-invite">Send it privately again</button>` : ""}
      </div>`;
  $("#invite-out").innerHTML = `<div class="invite-card">
      <div class="invite-step"><span class="n">1</span><div>${private_ ? `<b>Your invite goes to ${who} privately on Nostr.</b> It shows in their Nostr messages, and under
           "Invites for you" when they open this page.` : `<b>Send ${who} this invite</b> by chat, email or anything else. It holds no secret, and only they can answer it.
           Your signer can't send private messages, so it can't go by itself.`}</div></div>
      <p class="hint" id="dm-invite-out"></p>
      ${private_ ? `<details class="fold" id="invite-fold"><summary>Send it another way</summary>
             <p class="step-lede">The same invite as a link, for chat or email. It holds no secret.</p>${linkBox}</details>` : linkBox}
      <div class="invite-step"><span class="n">2</span><div><b>Wait for their reply.</b> It comes back to this page by
        itself when they accept.</div></div>
      <div id="invite-saved">${row("", state.inviteSaved ? `<b>Saved to your Nostr account.</b> You can close this page: pick it up again under "Your escrows", and the reply is waiting there.` : "Saving this invite's key to your Nostr account, so you can close this page and come back… your signer may ask.")}</div>
      <div class="waiting"><span class="pulse"></span>Waiting for their reply…</div>
    </div>`;
  $("#copy-invite").addEventListener("click", () => copyToClipboard($("#invite-link").textContent));
  $("#dm-invite")?.addEventListener("click", () => void sendInviteDm(d, link));
  $("#reply-in").hidden = false;
  $("#resume-box").hidden = true;
  $("#inbox-box").hidden = true;
  $("#inbox-alert").hidden = true;
  step(4);
  watchForReply(d, d.invitedAt);
}
async function backupInvite(d, code) {
  const show = (html, kind = "") => {
    const el = document.getElementById("invite-saved");
    if (el && state.draft === d)
      el.innerHTML = row(kind, html);
  };
  const keep = `<b>Keep this page open</b> until their reply arrives: the key for this invite lives only here until then.`;
  if (!canBackUp() || !d.mySecret) {
    show(`Your connected key can't keep a backup (it has no NIP-44). ${keep}`, "bad");
    return;
  }
  try {
    const signer = session.signer;
    const me = session.pubkey;
    const plaintext = draftBackupPlaintext({
      v: 1,
      draft: true,
      invite: code,
      key: hexOf(d.mySecret),
      role: d.side,
      domain: d.domain,
      amountSats: d.amountSats,
      network: NETWORK,
      at: d.invitedAt ?? now()
    });
    const ciphertext = await patiently(signer.nip44.encrypt(me, plaintext));
    if (await patiently(signer.nip44.decrypt(me, ciphertext)) !== plaintext)
      throw new Error("the backup didn't open again");
    const event = await patiently(signer.signEvent(buildKeyBackup({ pubkey: me, slot: keyBackupSlot(d.mySecret), ciphertext, createdAt: now() })));
    d.draftSavedAt = event.created_at;
    if (state.draft !== d || d.realised || session.pubkey !== me)
      return;
    const results = await publishToRelays(ESCROW_RELAYS, event);
    let held = 0;
    if (results.some((r) => r.ok)) {
      await queryRelays(ESCROW_RELAYS, [{ ids: [event.id] }], {
        timeoutMs: 6000,
        onRelayDone: (_relay, count) => {
          if (count > 0)
            held++;
        }
      }).catch(() => []);
    }
    if (held < BACKUP_QUORUM) {
      show(`Only ${held} of ${results.length} relays kept the backup. ${keep}`, "bad");
      return;
    }
    state.inviteSaved = true;
    show(`<b>Saved to your Nostr account.</b> You can close this page: pick it up again under "Your escrows", and the reply is waiting there.`, "good");
  } catch (err) {
    show(`The backup didn't go through (${esc(err.message)}). ${keep}`, "bad");
  }
}
function useReply() {
  const d = state.draft;
  if (!d?.invite)
    return;
  const problem = (message) => {
    $("#reply-in").open = true;
    fail($("#reply-hint"), message);
  };
  const reply = decodeReply($("#e-reply").value, d.invite);
  if (!reply.ok) {
    problem(reply.reason);
    return;
  }
  let realised;
  try {
    realised = realise(resolveHandshake(d.invite.invite, reply.reply));
  } catch (err) {
    problem(err.message);
    return;
  }
  $("#reply-in").hidden = true;
  $("#swap-lede").hidden = true;
  note($("#reply-hint"), "");
  if (d.resumed) {
    resumeReplied(d, realised);
    return;
  }
  $("#invite-out").innerHTML = row("good", `<b>Their reply arrived.</b> Both keys are in, and the escrow address below
    is derived from both. Once your key is safe, publish your view.`);
  showReady(d, realised, d.side);
}
async function resumeReplied(d, realised) {
  $("#invite-out").innerHTML = row("", "Their reply is in. Checking whether you published this escrow already…");
  const mine = escrowPublicKeyHex(d.mySecret);
  let answered = 0;
  const events = await queryRelays(ESCROW_RELAYS, [{ kinds: [ESCROW_KIND], authors: [mine], "#d": [ESCROW_D_PREFIX + realised.id] }], {
    timeoutMs: 6000,
    onRelayDone: (_relay, _count, _error, complete) => {
      if (complete)
        answered++;
    }
  }).catch(() => []);
  if (state.draft !== d)
    return;
  if (events.some((e) => e.pubkey === mine)) {
    const p = realised.params;
    enterEscrow(realised.id, { role: d.side, secret: d.mySecret }, [hexOf(p.buyer), hexOf(p.seller), hexOf(p.arbiter)]);
    const recovery = encodeRecovery({
      version: 1,
      secretKey: d.mySecret,
      buyer: p.buyer,
      seller: p.seller,
      arbiter: p.arbiter,
      timeoutTo: "buyer",
      timeoutBlocks: p.timeoutBlocks,
      binding: bytesOf(realised.id)
    });
    backUpKey(recovery, { id: realised.id, role: d.side, domain: p.domain, amountSats: p.amountSats, network: p.network, secret: d.mySecret }).catch(() => {
      return;
    });
    return;
  }
  if (answered === 0) {
    $("#invite-out").innerHTML = row("bad", `<b>The relays didn't answer</b>, so this page can't tell whether you published this
      escrow already. Reload and continue it again in a minute.`);
    return;
  }
  $("#invite-out").innerHTML = row("good", `<b>Their reply arrived.</b> Both keys are in, and the escrow address below
    is derived from both. Once your key is safe, publish your view.`);
  showReady(d, realised, d.side);
}
function openInvite(code) {
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
  const mySide = inv.initiatorRole === "buyer" ? "seller" : "buyer";
  state.joining = { invite: parsed, side: mySide };
  if (inv.network !== NETWORK) {
    $("#join-terms").innerHTML = row("bad", `This invite is for <b>${esc(inv.network)}</b>, and this
      site is set to <b>${esc(NETWORK)}</b>. Open it on a site set to the same network.`);
    $("#join-btn").hidden = true;
    return;
  }
  const problem = termsProblem(inv, RULES);
  if (problem) {
    $("#join-terms").innerHTML = row("bad", `<b>Do not join this escrow.</b> This site refuses its
      terms: ${esc(problem)}. Ask your counterparty to create the invite again here.`);
    $("#join-btn").hidden = true;
    return;
  }
  $("#join-terms").innerHTML = `<div class="confirm">
       <div class="amount">${sats(inv.amountSats)} sats</div>
       <div class="to">for ${esc(inv.domain)} · you are the <b>${esc(mySide)}</b></div>
       <div class="fee">After funding, the seller has ${windowText(inv.deliverBlocks)} to transfer the domain straight to
         the buyer, the registrar's usual way, and the buyer confirms it arrived, which pays the seller. If you disagree,
         arbiter ${esc(shorten(npubEncode(inv.arbiter), 8))} decides from the registry's record; it never holds the domain
         and can never move money alone. If the seller doesn't say it's sent in time, the buyer is refunded; if nobody acts, the
         timelock refunds the buyer after ${inv.timeoutBlocks} blocks. Network: ${esc(inv.network)}.</div>
     </div>` + row("", `Signed by <b>${esc(shorten(npubEncode(parsed.from), 10))}</b>, for
      <b>${esc(shorten(npubEncode(inv.to), 10))}</b>. Check that the first is who you are trading with.`);
}
async function acceptInvite() {
  const j = state.joining;
  if (!j || j.realised || state.inviting)
    return;
  state.inviting = true;
  $("#join-btn").disabled = true;
  try {
    await accept(j);
  } finally {
    state.inviting = false;
    $("#join-btn").disabled = false;
  }
}
async function accept(j) {
  const hint = $("#join-hint");
  if (!session.pubkey)
    await sessionReady();
  if (!session.pubkey || !session.signer) {
    note(hint, "Connect first. Your account signs your reply, so the other side knows it's you.");
    openConnect();
    return;
  }
  const { invite, from } = j.invite;
  if (session.pubkey !== invite.to) {
    fail(hint, `This invite is for ${shorten(npubEncode(invite.to), 10)}. Connect that account to answer it.`);
    return;
  }
  const problem = termsProblem(invite, RULES);
  if (problem) {
    fail(hint, `This site refuses these terms: ${problem}. Do not join.`);
    return;
  }
  note(hint, "Checking the domain with its registry…");
  const check = await registryCheck(invite.domain);
  if (check.problem) {
    fail(hint, `${sentence(check.problem)}. ${check.unread ? "Try again in a minute." : "Do not join."}`);
    return;
  }
  note(hint, "Checking the arbiter against both sides' published lists…");
  const buyerNostr = j.side === "buyer" ? session.pubkey : from;
  const sellerNostr = j.side === "seller" ? session.pubkey : from;
  const lists = await readArbiterLists(buyerNostr, sellerNostr);
  if (lists.answered === 0) {
    fail(hint, "The relays didn't answer, so the arbiter lists couldn't be checked. Try again in a minute.");
    return;
  }
  if (!arbiterIntersection(lists.buyer, lists.seller, siteArbiters(), [buyerNostr, sellerNostr]).arbiters.includes(invite.arbiter)) {
    fail(hint, `The invite names an arbiter the two of you haven't both accepted. A side with no
      published list accepts only this site's arbiter. Do not join. Ask for an invite with an
      arbiter you both accept.`);
    return;
  }
  const myKey = ensureKey(j);
  let replyText;
  try {
    note(hint, "Waiting for your signer…");
    const signed = await patiently(session.signer.signEvent(buildReply({ joinerKey: myKey }, { pubkey: session.pubkey, createdAt: now(), invite: j.invite })));
    replyText = encodeReply(signed);
  } catch (err) {
    fail(hint, err.message);
    return;
  }
  const reply = decodeReply(replyText, j.invite);
  if (!reply.ok) {
    fail(hint, reply.reason);
    return;
  }
  let realised;
  try {
    realised = realise(resolveHandshake(invite, reply.reply));
  } catch (err) {
    fail(hint, err.message);
    return;
  }
  state.draft = j;
  note(hint, "Accepted.", "ok");
  $("#join-section").hidden = true;
  $("#open-section").hidden = false;
  $("#resume-box").hidden = true;
  $("#inbox-box").hidden = true;
  $("#inbox-alert").hidden = true;
  for (const n of [1, 2, 3])
    $(`.step[data-step="${n}"]`).hidden = true;
  $("#swap-lede").hidden = true;
  $("#invite-out").innerHTML = `<div id="reply-status">${row("", `Sending your reply privately to whoever invited you…`)}</div>
     <details class="fold" id="reply-fold">
       <summary>Send the reply another way</summary>
       <p class="step-lede">Only if their page didn't get it, say because they closed it. It holds no secret.</p>
       <div class="nsec" id="reply-out">${esc(replyText)}</div>
       <button class="btn btn-ghost btn-sm" type="button" id="copy-reply">Copy reply</button>
     </details>`;
  $("#copy-reply").addEventListener("click", () => copyToClipboard($("#reply-out").textContent));
  step(4);
  showReady(j, realised, j.side);
  sendReplyPrivately(j, replyText).then((sent) => {
    const status = document.getElementById("reply-status");
    if (!status)
      return;
    status.innerHTML = sent ? row("good", `<b>Your reply is on its way to them privately</b>, and their page uses it by itself while it is open.`) : row("bad", `<b>No relay took your reply.</b> Send it to whoever invited you another way: copy it below.`);
    if (!sent)
      $("#reply-fold").open = true;
  });
}
async function publishEscrow() {
  const d = state.draft;
  if (!d?.realised || !d.mySecret || !d.myRole)
    return;
  const out = $("#publish-out");
  out.hidden = false;
  out.innerHTML = row("", "Signing your view…");
  try {
    const { params } = d.realised;
    let event = d.published;
    if (!event) {
      event = signEvent(buildEscrowEvent({
        ...params,
        pubkey: escrowPublicKeyHex(d.mySecret),
        createdAt: now(),
        deadlines: { fundBy: now() + 24 * 3600 }
      }), d.mySecret);
      d.published = event;
    }
    const results = await publishToRelays(ESCROW_RELAYS, event);
    const ok = results.filter((r) => r.ok);
    out.innerHTML = (ok.length ? row("good", `<b>Published to ${ok.length} of ${results.length}.</b> Your counterparty
             publishes their own view; where the two disagree, both stay visible.`) : row("bad", "<b>No relay accepted it.</b> Nothing was published.")) + results.map((r) => row(r.ok ? "good" : "bad", `<b>${esc(r.relay.replace(/^wss:\/\//, ""))}</b>: ${r.ok ? "accepted" : esc(r.message ?? "refused")}`)).join("");
    if (ok.length) {
      state.published = true;
      const id = d.realised.id;
      remember(id, event);
      state.me = { role: d.myRole, secret: d.mySecret };
      keepMe(id, state.me);
      rememberKeys(id, [hexOf(params.buyer), hexOf(params.seller), hexOf(params.arbiter)]);
      setUrl(id);
      $("#open-section").hidden = true;
      log(`<b>Your view is published</b> to ${ok.length} of ${results.length} relays.${ok.length * 2 < results.length ? " Fewer than half took it, so your counterparty may not see it yet; it goes out again with your next step." : ""}`, ok.length * 2 < results.length ? "bad" : "good");
      $("#escrow").hidden = false;
      $("#escrow").scrollIntoView({ behavior: "smooth", block: "start" });
      watch(id);
    }
  } catch (err) {
    out.innerHTML = row("bad", esc(err.message));
  }
}
const KEYS_PREFIX = "fmd:escrow-keys:";
function rememberKeys(id, keys) {
  try {
    localStorage.setItem(KEYS_PREFIX + id, keys.join(","));
  } catch {}
}
function knownKeys(id) {
  const fromUrl = new URL(location.href).searchParams.get("k") ?? "";
  let stored = "";
  try {
    stored = localStorage.getItem(KEYS_PREFIX + id) ?? "";
  } catch {}
  return [...new Set(`${fromUrl},${stored}`.split(",").filter((k) => /^[0-9a-f]{64}$/.test(k)))];
}
function setUrl(id, keys = knownKeys(id)) {
  const url = new URL(location.href);
  for (const name of ["join", "arbiter", "domain", "amount", "seller"])
    url.searchParams.delete(name);
  url.searchParams.set("id", id);
  if (keys.length)
    url.searchParams.set("k", keys.join(","));
  history.replaceState(null, "", url);
}
async function resume() {
  const hint = $("#resume-hint");
  const parsed = decodeRecovery($("#resume-in").value);
  if (!parsed.ok) {
    fail(hint, sentence(parsed.reason) + ".");
    return;
  }
  let rebuilt;
  try {
    rebuilt = rebuildFromRecovery(parsed.recovery);
  } catch (err) {
    fail(hint, err.message);
    return;
  }
  if (rebuilt.role === "arbiter") {
    fail(hint, "That string holds the arbiter key. Open the escrow's link instead.");
    return;
  }
  note(hint, "Looking for this escrow's views…");
  const buyer = hexOf(parsed.recovery.buyer);
  const seller = hexOf(parsed.recovery.seller);
  const keys = [buyer, seller, ...parsed.recovery.arbiter ? [hexOf(parsed.recovery.arbiter)] : []];
  const address = rebuilt.tree.addresses[NETWORK];
  let answered = 0;
  const events = await queryRelays(ESCROW_RELAYS, [{ kinds: [ESCROW_KIND], authors: [buyer, seller] }], {
    timeoutMs: 6000,
    onRelayDone: (_relay, _count, _error, complete) => {
      if (complete)
        answered++;
    }
  }).catch(() => []);
  const view = events.filter((e) => e.tags.some((t) => t[0] === "d" && t[1]?.startsWith(ESCROW_D_PREFIX))).map((e) => {
    try {
      return parseEscrowEvent(e);
    } catch {
      return { ok: false, reason: "" };
    }
  }).flatMap((r) => r.ok ? [r.view] : []).find((v) => v.address === address);
  if (!view) {
    fail(hint, answered === 0 ? "The relays didn't answer, so this escrow's views couldn't be read. Try again in a minute." : `No published view of this escrow was found. Its address is ${address}; if it was
      funded and the views are gone, recover.html can still take the timeout refund.`);
    return;
  }
  const text = $("#resume-in").value.trim();
  $("#resume-in").value = "";
  note(hint, "");
  const me = { role: rebuilt.role, secret: parsed.recovery.secretKey };
  enterEscrow(view.id, me, keys);
  backUpPasted(view.id, text, me, view);
}
async function watch(id) {
  state.wanted = id;
  if (state.watchBusy) {
    state.watchAgain = true;
    return;
  }
  state.watchBusy = true;
  try {
    do {
      state.watchAgain = false;
      await watchOnce(state.wanted);
    } while (state.watchAgain && !state.acting);
  } finally {
    state.watchBusy = false;
  }
}
function refreshWanted() {
  const id = state.wanted ?? state.watching;
  if (id)
    watch(id);
}
const roleOf = (view, author) => author === view.buyer ? "buyer" : author === view.seller ? "seller" : author === view.arbiter ? "arbiter" : "someone else";
async function watchOnce(id) {
  if (state.watching !== id)
    state.snap = null;
  state.watching = id;
  $("#escrow").hidden = false;
  if (!state.snap) {
    $("#escrow-title").textContent = "Escrow " + id.slice(0, 12) + "…";
    $("#escrow-sub").textContent = "reading every published view…";
  }
  let answered = 0;
  const fetched = await queryRelays(ESCROW_RELAYS, escrowFilters(id, knownKeys(id)), {
    timeoutMs: 6000,
    onRelayDone: (_relay, _count, _error, complete) => {
      if (complete)
        answered++;
    }
  }).catch(() => []);
  const events = [...fetched, ...(state.own.get(id) ?? []).filter((o) => !fetched.some((e) => e.id === o.id))];
  for (const [eventId, p] of state.pending) {
    if (p.escrowId === id && fetched.some((e) => e.id === eventId))
      state.pending.delete(eventId);
  }
  const viewEvents = events.filter((e) => e.tags.some((t) => t[0] === "d" && t[1] === ESCROW_D_PREFIX + id));
  const parsed = viewEvents.map((e) => {
    try {
      return parseEscrowEvent(e);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
  const views = parsed.filter((r) => r.ok).map((r) => r.view);
  const rejected = parsed.filter((r) => !r.ok);
  if (views.length === 0 && state.snap?.id === id) {
    log("The relays sent nothing this time, so this is the last reading. It refreshes on its own.");
    return;
  }
  if (views.length === 0) {
    $("#escrow-sub").textContent = "";
    const earlier = rejected.find((r) => /earlier flow/.test(r.reason));
    $("#state-line").innerHTML = row("bad", earlier ? `<b>This escrow was opened with the earlier flow</b>, where the arbiter held the domain, and this page no longer
         runs it. Its money is safe on chain. If it was funded and never paid out, the buyer takes the timeout refund
         with <a href="/recover">recover.html</a> and their recovery string. If the seller sent the domain to the
         arbiter under that flow, ask the arbiter for it directly.` : rejected.length ? `Found ${rejected.length} event(s) at this coordinate and <b>none of them verified</b>:
         ${esc(rejected[0].reason)}` : answered === 0 ? "The relays didn't answer, so this escrow's views couldn't be read. Refresh in a minute." : "No published view of this escrow was found on these relays yet.");
    return;
  }
  const comparison = compareViews(views, id);
  if (comparison.participants.length === 0) {
    $("#escrow-sub").textContent = "";
    $("#state-line").innerHTML = row("bad", `Found ${views.length} view(s) at this id and
      <b>none is this escrow, signed by one of its keys</b>. Only the buyer's and the seller's own
      escrow keys count. Do not fund anything from these.`);
    return;
  }
  const view = comparison.buyerView ?? comparison.sellerView;
  rememberKeys(id, [view.buyer, view.seller, view.arbiter]);
  if (view.network !== NETWORK) {
    $("#state-line").innerHTML = row("bad", `This escrow is on <b>${esc(view.network)}</b>, and this site
      watches <b>${esc(NETWORK)}</b>. Open it on a site set to the same network.`);
    return;
  }
  const rulings = events.filter((e) => e.pubkey === view.arbiter && e.tags.some((t) => t[0] === "d" && t[1] === RULING_D_PREFIX + id)).map((e) => parseRuling(e)).flatMap((r) => r.ok && r.ruling.id === id ? [r.ruling] : []).sort((a, b) => b.publishedAt - a.publishedAt);
  const tree = escrowTree(paramsOf(view));
  const snap = {
    id,
    view,
    buyerView: comparison.buyerView,
    sellerView: comparison.sellerView,
    ruling: rulings[0],
    tree,
    leftovers: [],
    historyComplete: true,
    relaysAnswered: answered,
    board: [],
    agreed: comparison.agreed
  };
  $("#escrow-title").textContent = view.domain;
  $("#escrow-sub").textContent = `Escrow ${id.slice(0, 12)}… · ${sats(view.amountSats)} sats · ` + `${comparison.participants.length} of 2 views published`;
  const missing = !snap.buyerView ? "buyer" : !snap.sellerView ? "seller" : null;
  $("#disagreements").innerHTML = (!comparison.agreed ? `<div class="clash">
         <h4>The published views disagree</h4>
         ${comparison.disagreements.map((d) => `
           <div class="clash-row"><b>${esc(d.field)}:</b></div>
           ${d.values.map((v) => `<div class="clash-row">the ${esc(roleOf(view, v.author))} says ${esc(v.value)}</div>`).join("")}
         `).join("")}
         <p style="font-size:12.5px;margin:10px 0 0">This is permanent and public. Do not fund
            anything until it is resolved: one of these views is not describing your trade.</p>
       </div>` : missing ? row("", `<b>Waiting for the ${missing}.</b> Only the ${missing === "buyer" ? "seller" : "buyer"}'s view is
          published so far. The ${missing} publishes theirs from their own page after saving their
          recovery string. Nobody should fund until both are here.`) : "") + (comparison.strangers.length ? row("", `${comparison.strangers.length} view(s) that are not this escrow's own were ignored.`) : "");
  const me = state.me;
  const reader = me ? escrowPublicKeyHex(me.secret) : undefined;
  const before = state.snap?.id === id ? state.snap.chats : undefined;
  await Promise.all([
    readChain(snap),
    me && reader && [view.buyer, view.seller, view.arbiter].includes(reader) ? readChats(view, me.secret).then((chats) => {
      snap.chats = mergeChats(before, chats);
    }) : Promise.resolve()
  ]);
  readBoard(snap);
  state.lastRead = Date.now();
  if (state.acting) {
    state.watchAgain = true;
    return;
  }
  state.snap = snap;
  render(snap);
}
async function readChain(snap) {
  const { view } = snap;
  try {
    const [utxos, history, tip] = await Promise.all([
      chain.utxos(view.address),
      chain.activity(view.address),
      chain.tipHeight().catch(() => {
        return;
      })
    ]);
    snap.tip = tip;
    snap.historyComplete = history.complete;
    snap.chainSig = chainSigOf(utxos);
    const amount = BigInt(view.amountSats);
    const spent = history.outputs.filter((o) => o.spentBy && o.valueSats >= amount).sort((a, b) => (a.blockHeight ?? 1 / 0) - (b.blockHeight ?? 1 / 0))[0];
    if (spent) {
      snap.settled = { output: spent, leaf: leafOfWitness(snap.tree, spent.spentBy.witness) };
      snap.leftovers = utxos;
      return;
    }
    const found = findFunding(utxos, amount, 1, tip);
    if (found.funded && found.utxo.blockHeight !== undefined) {
      const u = found.utxo;
      snap.funding = { outpoint: `${u.txid}:${u.vout}`, txid: u.txid, vout: u.vout, value: u.valueSats, height: u.blockHeight };
      snap.leftovers = utxos.filter((o) => o !== u);
    } else {
      snap.fundingNote = found.funded ? "the payment is confirmed, but the chain API gave no block height for it" : found.reason;
      const pending = found.funded ? found.utxo : found.candidates.find((u) => !u.confirmed && u.valueSats >= amount);
      if (pending)
        snap.seen = { txid: pending.txid, vout: pending.vout, valueSats: pending.valueSats, confirmed: pending.confirmed };
      else if (utxos.length && utxos.every((u) => u.valueSats < amount)) {
        snap.short = utxos.reduce((max, u) => u.valueSats > max ? u.valueSats : max, 0n);
      }
      snap.leftovers = utxos.filter((o) => o !== pending);
    }
  } catch (err) {
    snap.chainError = err.message;
    snap.historyComplete = false;
  }
}
function chainSigOf(utxos) {
  return utxos.map((u) => `${u.txid}:${u.vout}:${u.valueSats}:${u.confirmed ? 1 : 0}`).sort().join("|");
}
function readBoard(snap) {
  if (!snap.funding)
    return;
  snap.board = collectSettlements({
    tree: snap.tree,
    network: snap.view.network,
    outpoint: snap.funding.outpoint,
    value: snap.funding.value,
    sources: [
      { role: "buyer", sigs: snap.buyerView?.sigs ?? [] },
      { role: "seller", sigs: snap.sellerView?.sigs ?? [] },
      { role: "arbiter", sigs: snap.ruling?.settlement ? [snap.ruling.settlement] : [] }
    ]
  });
}
const proposal = (snap, kind, leaf) => proposalOf(snap.board, kind, leaf);
function claimsOf(snap) {
  return { seller: snap.sellerView?.claims ?? {}, buyer: snap.buyerView?.claims ?? {} };
}
function payoutKind(snap) {
  const leaf = snap.settled?.leaf;
  if (leaf === "B")
    return "release";
  if (leaf === "C" || leaf === "D")
    return "refund";
  if (leaf === "A") {
    const witness = snap.settled.output.spentBy.witness;
    const signed = [...snap.sellerView?.sigs ?? [], ...snap.buyerView?.sigs ?? []].find((s) => s.leaf === "A" && witness.includes(s.sig));
    if (signed)
      return signed.kind;
    const claims = claimsOf(snap);
    return claims.buyer.received ? "release" : claims.seller.cancelled ? "refund" : undefined;
  }
  return;
}
function render(snap) {
  const { view } = snap;
  const claims = claimsOf(snap);
  if (snap.funding && snap.tip !== undefined) {
    snap.verdict = arbiterRule({
      rules: { timeoutBlocks: view.timeoutBlocks, deliverBlocks: view.deliverBlocks },
      fundingHeight: snap.funding.height,
      tip: snap.tip,
      seller: { sent: !!claims.seller.sent, cancelled: !!claims.seller.cancelled, disputed: !!claims.seller.disputed },
      buyer: { received: !!claims.buyer.received, disputed: !!claims.buyer.disputed }
    });
  }
  safely("#state-line", () => renderState(snap));
  safely("#chain-view", () => renderChain(snap));
  safely("#timeline", () => renderTimeline(snap));
  safely("#deal-log", () => renderDealLog(snap));
  safely("#act-view", () => keepInputs($("#act-view"), () => renderActions(snap)));
  safely("#chat-view", () => renderChat(snap));
  safely("#derivation-view", () => {
    $("#derivation-view").innerHTML = renderDerivation(snap.tree, view.address, view.id);
  });
}
function safely(where, paint) {
  try {
    paint();
  } catch (err) {
    console.error(err);
    $(where).innerHTML = row("bad", `This part of the page failed to draw: ${esc(err.message)}.
      Reload the page. The escrow itself is unaffected.`);
  }
}
let shownStage = "";
function renderState(snap) {
  const { pill, kind, text } = stateOf(snap);
  const stage = `${snap.id}|${pill}`;
  if (shownStage && shownStage !== stage && !state.acting && Date.now() - loggedAt > 60000)
    $("#act-log").innerHTML = "";
  shownStage = stage;
  $("#state-line").innerHTML = `<span class="state-pill ${kind}">${esc(pill)}</span>
     <p class="hint" style="text-align:left;margin:0 0 12px">${esc(sentence(text))}.</p>`;
}
function stateOf(snap) {
  if (snap.chainError)
    return { pill: "unknown", kind: "alert", text: "the chain can't be read right now" };
  if (snap.settled)
    return { pill: "settled", kind: "done", text: settledText(snap) };
  if (!snap.funding) {
    const fundBy = snap.view.deadlines.fundBy;
    if (fundBy !== undefined && now() > fundBy) {
      return { pill: "expired", kind: "alert", text: "the funding deadline passed and nothing is confirmed" };
    }
    return { pill: "open", kind: "", text: "published, and waiting to be funded" };
  }
  const v = snap.verdict;
  if (!v)
    return { pill: "funded", kind: "", text: "funded; the chain tip could not be read, so the deadlines can't be shown" };
  const stages = {
    "awaiting-transfer": ["funded", "", "funded; the seller transfers the domain to the buyer next"],
    transferred: ["sent", "", "the seller says the domain is on its way to the buyer, who confirms once it has arrived"],
    received: ["received", "done", "the buyer confirmed the domain is in their account; the seller is paid next"],
    cancelled: ["cancelled", "alert", "the seller cancelled the sale; the buyer is refunded next"],
    disputed: ["dispute", "alert", `${v.reason}; the arbiter decides next`],
    late: ["transfer missed", "alert", "the seller didn't say the domain was transferred before the deadline, so the buyer is refunded"]
  };
  const [pill, kind, text] = stages[v.stage] ?? ["funded", "", v.reason];
  return { pill, kind, text };
}
function settledText(snap) {
  const spender = snap.settled.output.spentBy;
  const how = {
    A: "by buyer and seller together",
    B: "to the seller, signed by the seller and the arbiter",
    C: "back to the buyer, signed by the buyer and the arbiter",
    D: "back to the buyer by the timelock"
  }[snap.settled.leaf ?? ""] ?? "by a path this page could not identify";
  return `the escrow paid out ${how}${spender.confirmed ? "" : "; that transaction is not confirmed yet"}`;
}
function renderChain(snap) {
  const { view } = snap;
  const explorerLink = `<a href="${esc(chain.explorer)}/address/${esc(view.address)}" target="_blank" rel="noopener">Watch the address on the explorer</a>`;
  const extra = sats(Number(snap.leftovers.reduce((sum, u) => sum + u.valueSats, 0n)));
  const leftover = !snap.leftovers.length ? "" : snap.funding || snap.settled ? row("bad", `<b>${snap.leftovers.length} other payment(s) to this address</b> (${extra} sats) are not part of the
          trade. After the timelock the buyer takes them back with recover.html. Don't send more.`) : row("bad", `<b>${snap.leftovers.length} other payment(s) to this address</b> (${extra} sats) are not part of the
          trade: payments are never added together, and only one funds it. After the timelock the buyer takes them back
          with recover.html.`);
  if (snap.chainError) {
    $("#chain-view").innerHTML = row("bad", `<b>The chain API did not answer</b> (${esc(snap.chainError)}), so this
      page can't tell whether the escrow is funded or settled. That says nothing about the escrow. Don't pay
      anything until it answers; it tries again on its own. · ${explorerLink}`);
    return;
  }
  if (snap.settled) {
    const spender = snap.settled.output.spentBy;
    $("#chain-view").innerHTML = row(spender.confirmed ? "good" : "", `<b>${spender.confirmed ? "Settled" : "Settling"}.</b>
      The payment of ${sats(Number(snap.settled.output.valueSats))} sats was spent in
      <a href="${esc(chain.explorer)}/tx/${esc(spender.txid)}" target="_blank" rel="noopener">${esc(spender.txid.slice(0, 16))}…</a>,
      ${esc(settledText(snap))}. ${spender.confirmed ? "The trade is over; do not pay this address again." : "Until it confirms it can still be replaced, so keep this page and wait for a block."}`) + leftover;
    return;
  }
  if (snap.funding) {
    const f = snap.funding;
    $("#chain-view").innerHTML = row("good", `<b>Funded.</b> ${sats(Number(f.value))} sats at
      <a href="${esc(chain.explorer)}/tx/${esc(f.txid)}" target="_blank" rel="noopener">${esc(f.txid.slice(0, 16))}…:${esc(String(f.vout))}</a>,
      confirmed in block ${esc(String(f.height))}.`) + overpaid(snap, f.value) + leftover + (snap.historyComplete ? "" : row("bad", `This address has more history than the page can read. If this escrow
        was settled before, this payment is an extra one; check the explorer.`));
    registryWarning(snap);
    return;
  }
  const blocker = fundingBlocker(snap);
  const partial = snap.relaysAnswered < ESCROW_RELAYS.length ? row("", `Only ${snap.relaysAnswered} of ${ESCROW_RELAYS.length} relays answered, so a newer view, a cancellation say,
        may be missing. Refresh first if you can.`) : "";
  const status = row("", `${esc(sentence(snap.fundingNote ?? "nothing has been paid to this address yet"))} · ${explorerLink}`);
  if (blocker) {
    $("#chain-view").innerHTML = row("bad", `<b>Do not fund yet:</b> ${esc(blocker)}.`) + leftover + status;
    return;
  }
  const tail = snap.seen || snap.short !== undefined ? row("", explorerLink) : status;
  const paint = (check) => {
    $("#chain-view").innerHTML = check.problem ? row("bad", `<b>Do not fund:</b> ${esc(check.problem)}.`) + leftover + status : (state.me?.role === "buyer" ? payBox(snap) : awaitingPayment(snap)) + check.warnings.map((w) => row("", esc(sentence(w)) + ".")).join("") + partial + leftover + tail;
  };
  const cached = registryCheckCached(view.domain);
  if (cached) {
    paint(cached);
    return;
  }
  $("#chain-view").innerHTML = row("", "Checking the domain with its registry…") + leftover + status;
  registryCheck(view.domain).then((check) => {
    if (state.snap === snap)
      paint(check);
  });
}
function fundingBlocker(snap) {
  const { view } = snap;
  const fundBy = view.deadlines.fundBy;
  const terms = termsProblem(view, RULES);
  return !snap.agreed ? "the published views disagree about the terms" : !snap.buyerView || !snap.sellerView ? "both the buyer and the seller have to publish their views first" : terms ? `this site refuses these terms: ${terms}` : claimsOf(snap).seller.cancelled ? "the seller has cancelled this sale" : fundBy !== undefined && now() > fundBy ? "the funding deadline in the buyer's view has passed. Open a new escrow instead" : !snap.historyComplete ? "the address's history couldn't be read in full, so the page can't rule out an earlier payment" : null;
}
function overpaid(snap, value) {
  const extra = value - BigInt(snap.view.amountSats);
  if (extra <= 0n)
    return "";
  return row("bad", `<b>This payment is ${sats(Number(value))} sats, ${sats(Number(extra))} more than the price.</b> It still funds
    the escrow, and the whole of it goes with the payout: to the seller on release, back to the buyer on refund.`);
}
function payBox(snap) {
  const { view } = snap;
  if (snap.seen) {
    return `<div class="pay seen">
      <div class="pay-top"><span class="pulse"></span><b>Payment received.</b> ${snap.seen.confirmed ? "Confirmed." : "Waiting for it to confirm."}</div>
      <p>${sats(Number(snap.seen.valueSats))} sats arrived in
        <a href="${esc(chain.explorer)}/tx/${esc(snap.seen.txid)}" target="_blank" rel="noopener">${esc(snap.seen.txid.slice(0, 16))}…</a>.
        ${snap.seen.confirmed ? "It is confirmed, and counts as soon as the chain API reports its block." : "It counts once a block confirms it, usually within about 10 minutes, and this page notices by itself."}
        <b>Don't pay again.</b></p>
    </div>` + overpaid(snap, snap.seen.valueSats);
  }
  const uri = bip21(view.address, view.amountSats);
  const btc = btcAmount(view.amountSats);
  const fundBy = view.deadlines.fundBy;
  const short = snap.short !== undefined ? row("bad", `<b>${sats(Number(snap.short))} sats arrived, short of ${sats(view.amountSats)}.</b> Payments are never
        added together, so that one doesn't fund the escrow. Pay the full ${sats(view.amountSats)} sats again, in one payment.`) : "";
  return short + `<div class="pay">
    <div class="pay-qr">${qrSvg(uri, { label: `Pay ${btc} BTC to the escrow` })}</div>
    <div class="pay-body">
      <div class="pay-top"><span class="pulse"></span><b>Pay into the escrow.</b> Waiting for your payment.</div>
      <div class="pay-amount"><span>${sats(view.amountSats)}</span> sats <small>= ${esc(btc)} BTC</small></div>
      <div class="pay-addr" id="pay-addr">${esc(view.address)}</div>
      <div class="btn-row">
        <button class="btn btn-accent btn-sm" type="button" data-copy="#pay-addr">Copy address</button>
        <button class="btn btn-ghost btn-sm" type="button" data-copy-text="${esc(btc)}">Copy amount in BTC</button>
        <a class="btn btn-ghost btn-sm" href="${esc(uri)}">Open in wallet</a>
      </div>
      <ul class="pay-notes">
        <li>Exactly ${sats(view.amountSats)} sats, in <b>one</b> payment, from a wallet you control, not an exchange.${NETWORK === "mainnet" ? "" : ` This site runs on <b>${esc(NETWORK)}</b>: pay with ${esc(NETWORK)} coins.`}</li>
        <li>It counts after one confirmation, usually about 10 minutes. This page checks by itself.</li>
        ${fundBy !== undefined ? `<li>Pay before <b>${esc(localTime(fundBy))}</b>. After that this escrow can't be funded.</li>` : ""}
        <li>Then sign your refund below, so the money comes back to you if the domain never arrives.</li>
      </ul>
    </div>
  </div>`;
}
function awaitingPayment(snap) {
  const { view } = snap;
  if (snap.seen) {
    return row("good", `<b>The buyer's payment has arrived</b> (${sats(Number(snap.seen.valueSats))} sats). ${snap.seen.confirmed ? "It is confirmed, and counts as soon as the chain API reports its block." : "It counts once a block confirms it, usually within about 10 minutes."}${state.me?.role === "seller" ? " Transfer the domain only once this page shows the escrow funded." : ""}`) + overpaid(snap, snap.seen.valueSats);
  }
  return row("", `<b>Waiting for the buyer to pay</b> ${sats(view.amountSats)} sats into
    <code>${esc(view.address)}</code>.${state.me?.role === "seller" ? " Don't transfer the domain until this page shows the escrow funded." : " Only the buyer pays, from their own wallet: don't pay an escrow you hold no recovery string for."}`);
}
async function registryWarning(snap) {
  const claims = claimsOf(snap);
  if (claims.buyer.received || claims.seller.cancelled)
    return;
  const fresh = registryCheckCached(snap.view.domain) === undefined;
  const reading = await registryOf(snap.view.domain);
  if (state.snap !== snap || !reading.ok)
    return;
  if (fresh)
    redrawActions();
  if (document.getElementById("registry-warn"))
    return;
  const moving = reading.facts.statuses.includes("pendingtransfer");
  const refusal = registrarFindings(reading.facts, now()).find((f) => f.level === "refuse" && !(moving && f.code === "status:pendingtransfer"));
  const html = refusal ? row("bad", `<b>The registry shows a problem:</b> ${esc(refusal.message)}. If the seller doesn't say it's sent by the
        deadline, the rules refund the buyer.`) : moving && claims.seller.sent ? row("good", `<b>The registry shows ${esc(snap.view.domain)} moving to another registrar.</b> That usually takes up to
          a week; the buyer confirms once it arrives.`) : "";
  if (html)
    $("#chain-view").insertAdjacentHTML("beforeend", `<div id="registry-warn">${html}</div>`);
}
function renderTimeline(snap) {
  if (snap.chainError) {
    $("#timeline").innerHTML = "";
    return;
  }
  const { view, tip } = snap;
  const claims = claimsOf(snap);
  const items = [];
  const both = !!snap.buyerView && !!snap.sellerView;
  items.push({ cls: both ? "done" : "now", html: `<b>Both sides publish their views</b>` });
  const f = snap.funding;
  const paid = !!snap.settled;
  items.push({
    cls: f || paid ? "done" : both ? "now" : "",
    html: f ? `<b>Funded</b> in block ${esc(String(f.height))}` : paid ? `<b>Funded</b>` : `<b>The buyer funds ${sats(view.amountSats)} sats</b>`
  });
  const d = snap.verdict?.deadlines;
  const open = !f && !paid;
  const sent = claims.seller.sent;
  items.push({
    cls: sent ? "done" : f && !paid ? "now" : "",
    html: sent ? `<b>The seller transferred ${esc(view.domain)} to the buyer</b><span class="when">stated ${esc(stamp(sent.at))}</span>` : `<b>The seller transfers ${esc(view.domain)} to the buyer</b>` + (d ? `<span class="when">deadline ${esc(blocksAway(d.deliverBy, tip))}</span>` : open ? `<span class="when">within ${windowText(view.deliverBlocks)} of funding</span>` : "")
  });
  const received = claims.buyer.received;
  const disputed = claims.buyer.disputed ?? claims.seller.disputed;
  const cancelled = claims.seller.cancelled;
  items.push({
    cls: received || cancelled || snap.ruling ? "done" : disputed || sent && !paid ? "now" : "",
    html: received ? `<b>The buyer confirmed it arrived</b><span class="when">stated ${esc(stamp(received.at))}</span>` : cancelled ? `<b>The seller cancelled the sale</b><span class="when">stated ${esc(stamp(cancelled.at))}</span>` : snap.ruling ? `<b>The arbiter ruled: ${snap.ruling.decision === "release" ? "pay the seller" : "refund the buyer"}</b><span class="when">${esc(stamp(snap.ruling.publishedAt))}</span>` : disputed ? `<b>Dispute: the arbiter decides</b><span class="when">raised ${esc(stamp(disputed.at))}</span>` : `<b>The buyer confirms it arrived</b>`
  });
  if (paid) {
    items.push({ cls: "done", html: `<b>Paid out</b>, ${esc(settledText(snap))}` });
  } else {
    const payoutDue = snap.board.some((e) => e.complete) || snap.verdict?.action === "release" || snap.verdict?.action === "refund";
    items.push({
      cls: payoutDue ? "now" : "",
      html: `<b>Payout</b>` + (d ? `<span class="when">the buyer can take a lone refund from ${esc(blocksAway(d.timeoutAt, tip))}</span>` : "")
    });
  }
  $("#timeline").innerHTML = items.map((i) => `<li class="${i.cls}">${i.html}</li>`).join("");
}
let paintedActions = "";
function paintActions(el, html) {
  if (html === paintedActions && el.innerHTML !== "")
    return;
  paintedActions = html;
  el.innerHTML = html;
}
function keepInputs(el, paint) {
  const kept = new Map;
  for (const input of el.querySelectorAll("input[id], textarea[id]")) {
    if (input.dataset.edited !== "1")
      continue;
    kept.set(input.id, input instanceof HTMLInputElement && (input.type === "checkbox" || input.type === "radio") ? input.checked : input.value);
  }
  const folds = new Map;
  for (const fold of el.querySelectorAll("details[id]"))
    folds.set(fold.id, fold.open);
  const active = document.activeElement;
  const focused = active?.id;
  const caret = active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd ?? active.selectionStart] : undefined;
  paint();
  for (const [id, open] of folds) {
    const fold = el.querySelector(`#${CSS.escape(id)}`);
    if (fold)
      fold.open = open;
  }
  for (const [id, value] of kept) {
    const input = el.querySelector(`#${CSS.escape(id)}`);
    if (!input)
      continue;
    if (typeof value === "boolean")
      input.checked = value;
    else
      input.value = value;
    input.dataset.edited = "1";
  }
  if (!focused)
    return;
  const back = el.querySelector(`#${CSS.escape(focused)}`);
  if (!back || back === document.activeElement)
    return;
  back.focus();
  if (caret)
    try {
      back.setSelectionRange(caret[0], caret[1]);
    } catch {}
}
function renderActions(snap) {
  const el = $("#act-view");
  const parts = [];
  if (state.me) {
    const mine = escrowPublicKeyHex(state.me.secret);
    if (mine !== { buyer: snap.view.buyer, seller: snap.view.seller, arbiter: snap.view.arbiter }[state.me.role]) {
      state.me = null;
      forgetMe(snap.id);
    }
  }
  if (!snap.settled) {
    for (const entry of snap.board.filter((e) => e.complete)) {
      parts.push(`<div class="act"><h3>Ready to broadcast</h3>
        <p class="step-lede">A ${esc(entry.settlement.kind)} to <code>${esc(entry.settlement.dest)}</code> has both
          signatures (leaf ${esc(entry.settlement.leaf)}). Send it to the network:</p>
        <button class="btn btn-accent btn-sm" type="button" data-broadcast="${esc(settlementKey(entry.settlement))}">Broadcast</button>
        <div class="act-out"></div></div>`);
    }
  }
  if (snap.verdict && !snap.settled) {
    const v = snap.verdict;
    const label = { wait: "no payout yet", release: "release to the seller", refund: "refund the buyer", decide: "the arbiter decides" }[v.action];
    parts.push(row(v.stage === "late" || v.stage === "disputed" ? "bad" : "", `<b>The rules say: ${esc(label)}.</b> ${esc(sentence(v.reason))}.` + (v.timedOut ? ` <b>The timelock has passed</b>, so the buyer can take the refund alone at any moment.` : "")));
  }
  if (!state.me) {
    if (!snap.settled) {
      parts.push(`<div class="act"><h3>Act on this escrow</h3>
        ${canBackUp() ? `<p class="step-lede">If you opened or joined this escrow while connected, your account
          opens it.</p>
          <button class="btn btn-accent btn-sm" type="button" id="me-backup">Open with my account</button>` : ""}
        <p class="step-lede">${canBackUp() ? "Or paste" : "Paste"} your recovery string if you are the buyer or the seller,
          or the arbiter key if you are the arbiter. Neither is ever sent anywhere. A recovery string stays in this
          tab until you disconnect or are away for 8 hours; the arbiter key only until you reload.</p>
        <form class="add-form" id="me-form">
          <input type="password" id="me-in" placeholder="fmdrec1… or nsec1…" autocomplete="off" spellcheck="false" aria-label="Recovery string or arbiter key">
          <button class="btn btn-ghost" type="submit" id="me-btn">Use it</button>
        </form>
        <p class="hint" id="me-hint"></p></div>`);
    }
    paintActions(el, parts.join(""));
    return;
  }
  if (snap.settled) {
    parts.push(finishedBox(snap, state.me.role));
    if (state.me.role === "seller" && payoutKind(snap) === "refund")
      parts.push(relockRow(snap));
  } else
    parts.push(`<div class="whoami"><span>You are acting as the <b>${esc(state.me.role)}</b>.
    <small>${state.me.role === "arbiter" ? "Your key is in this page's memory only." : "Your key stays in this tab until you disconnect, or are away for 8 hours."}</small></span>
    <span class="whoami-actions">${state.me.role === "arbiter" ? "" : `<button class="btn btn-ghost btn-sm" type="button" id="me-download">Download recovery string</button>`}
    <button class="btn btn-ghost btn-sm" type="button" id="me-forget">Forget the key</button></span></div>`);
  const unsent = [...state.pending.values()].filter((p) => p.escrowId === snap.id);
  if (unsent.length && state.me.role === "arbiter") {
    parts.push(`<div class="act"><h3>Publish again</h3>
      <p class="step-lede">Too few relays took ${esc(unsent.map((p) => p.what).join(" and "))}. ${unsent.length === 1 ? "It is" : "They are"}
        kept in this tab only, and the parties can't see what no relay holds.</p>
      <button class="btn btn-accent btn-sm" type="button" data-act="republish">Publish again</button>
      <p class="hint act-out"></p></div>`);
  }
  if (!snap.chainError) {
    if (state.me.role === "arbiter")
      parts.push(...arbiterBoxes(snap));
    else if (!snap.settled)
      parts.push(...state.me.role === "buyer" ? buyerBoxes(snap) : sellerBoxes(snap));
    parts.push(soldListingBox(snap));
  }
  paintActions(el, parts.join(""));
}
function finishedBox(snap, role) {
  const domain = payoutKind(snap) === "release" && claimsOf(snap).buyer.received ? "the buyer confirmed the domain arrived" : "";
  const later = snap.leftovers.length;
  const what = later ? `${later} later payment${later === 1 ? " is" : "s are"} still at the escrow address. ${role === "arbiter" ? "The buyer can take them back after the timelock." : "Keep your recovery string: with it the buyer takes them back after the timelock, on recover.html."}` : role === "arbiter" ? "Nothing is left for the arbiter to do on this escrow." : "Nothing is left to sign, so you don't need this escrow's key any more. The deal log below keeps the whole record.";
  return `<div class="whoami done-box"><span><b>This deal is finished.</b> ${esc(sentence(settledText(snap)))}${domain ? `, and ${domain}` : ""}.
    <small>${what}</small></span>
    <span class="whoami-actions">${later && role !== "arbiter" ? `<button class="btn btn-ghost btn-sm" type="button" id="me-download">Download recovery string</button>` : ""}
    <button class="btn btn-ghost btn-sm" type="button" id="me-forget">Forget the key</button></span></div>`;
}
const logOpened = new Set;
function renderDealLog(snap) {
  const { view } = snap;
  const claims = claimsOf(snap);
  const txLink = (txid) => `<a href="${esc(chain.explorer)}/tx/${esc(txid)}" target="_blank" rel="noopener">${esc(txid.slice(0, 12))}…</a>`;
  const key = (hex) => `<code>${esc(shorten(npubEncode(hex), 8))}</code>`;
  const rows = [];
  rows.push({ when: "Terms", what: `<b>${esc(view.domain)}</b> for ${sats(view.amountSats)} sats, on ${esc(view.network)}. Buyer ${key(view.buyer)},
    seller ${key(view.seller)}, arbiter ${key(view.arbiter)}, who decides a dispute. The seller transfers the domain
    straight to the buyer. Escrow <code>${esc(snap.id.slice(0, 12))}…</code>.` });
  for (const [side, v] of [["buyer", snap.buyerView], ["seller", snap.sellerView]]) {
    rows.push(v ? { when: localTime(v.publishedAt), what: `The ${side}'s side of the deal is on record (last updated then).` } : { when: "Waiting", what: `The ${side} hasn't published their side yet.` });
  }
  if (snap.settled || snap.funding) {
    const out = snap.settled ? snap.settled.output : undefined;
    const txid = out?.txid ?? snap.funding.txid;
    const height = out?.blockHeight ?? snap.funding?.height;
    const value = out?.valueSats ?? snap.funding.value;
    rows.push({ when: height !== undefined ? `Block ${height}` : "Paid", what: `<b>Paid in:</b> ${sats(Number(value))} sats, ${txLink(txid)}.`, kind: "good" });
  } else if (snap.seen) {
    rows.push({ when: "Unconfirmed", what: `A payment of ${sats(Number(snap.seen.valueSats))} sats is waiting for a block: ${txLink(snap.seen.txid)}.` });
  } else if (!snap.chainError) {
    rows.push({ when: "Waiting", what: "Nothing has been paid to the escrow address yet." });
  }
  const stated = [];
  if (claims.seller.sent)
    stated.push({ at: claims.seller.sent.at, what: "The seller said the domain is transferred, or on its way, to the buyer." });
  if (claims.seller.cancelled)
    stated.push({ at: claims.seller.cancelled.at, what: `The seller cancelled the sale: ${esc(claims.seller.cancelled.reason || "no reason given")}.`, kind: "bad" });
  if (claims.buyer.received)
    stated.push({ at: claims.buyer.received.at, what: "The buyer confirmed the domain is in their account.", kind: "good" });
  for (const [who, c] of [["buyer", claims.buyer.disputed], ["seller", claims.seller.disputed]]) {
    if (c)
      stated.push({ at: c.at, what: `The ${who} opened a dispute: ${esc(c.reason || "no reason given")}.`, kind: "bad" });
  }
  if (snap.ruling)
    stated.push({ at: snap.ruling.publishedAt, what: `The arbiter ruled: ${snap.ruling.decision === "release" ? "release to the seller" : "refund the buyer"}. ${esc(sentence(snap.ruling.reason))}` });
  for (const s of stated.sort((a, b) => a.at - b.at))
    rows.push({ when: localTime(s.at), what: s.what, kind: s.kind });
  const signed = [];
  for (const [who, v] of [["buyer", snap.buyerView], ["seller", snap.sellerView]]) {
    const paths = new Map;
    for (const s of v?.sigs ?? [])
      paths.set(s.kind, [...paths.get(s.kind) ?? [], s.leaf]);
    for (const [kind, leaves] of paths) {
      signed.push(`the ${who} signed ${kind === "release" ? "the payout to the seller" : "the refund to the buyer"} ` + `(path${leaves.length === 1 ? "" : "s"} ${esc(leaves.join(" and "))})`);
    }
  }
  if (snap.ruling?.settlement)
    signed.push(`the arbiter co-signed ${snap.ruling.decision === "release" ? "the payout" : "the refund"}`);
  if (signed.length)
    rows.push({ when: "Signatures", what: `${esc(sentence(signed.join("; ")))}.` });
  if (snap.settled) {
    const spender = snap.settled.output.spentBy;
    rows.push({
      when: spender.blockHeight !== undefined ? `Block ${spender.blockHeight}` : "Unconfirmed",
      what: `<b>Paid out:</b> ${esc(settledText(snap))}, ${txLink(spender.txid)}.`,
      kind: spender.confirmed ? "good" : ""
    });
  }
  for (const u of snap.leftovers) {
    rows.push({ when: "Extra", what: `A later payment of ${sats(Number(u.valueSats))} sats sits at the address, ${txLink(u.txid)}. It isn't part of the deal.`, kind: "bad" });
  }
  if (snap.chats) {
    const counts = [...snap.chats.byPartner.entries()].map(([partner, messages]) => `${messages.length} with the ${partner}`);
    rows.push({ when: "Messages", what: `${esc(sentence(counts.join(", ")))}, in private chats only the two sides of each can read.` });
  }
  $("#deal-log").innerHTML = `<ol class="deal-log">${rows.map((r) => `<li class="${r.kind ?? ""}"><span class="log-when">${esc(r.when)}</span><span class="log-what">${r.what}</span></li>`).join("")}</ol>
    <p class="hint">Times are each event's own stated time, shown in your time zone; the deadlines go by blocks.</p>`;
  if (snap.settled && !logOpened.has(snap.id)) {
    logOpened.add(snap.id);
    $("#deal-log-wrap").open = true;
  }
}
const listingLooks = new Map;
const outboxes = new RelayDirectory(ESCROW_RELAYS);
function soldListingBox(snap) {
  if (state.me?.role !== "seller")
    return "";
  const sold = payoutKind(snap) === "release" || !!claimsOf(snap).buyer.received;
  if (!sold)
    return "";
  if (!session.pubkey || !session.signer) {
    return row("", `<b>Your market listing for ${esc(snap.view.domain)}</b> may still be up. Connect the account you listed it
      with, and you can take it down here.`);
  }
  const key = `${snap.id}:${session.pubkey}`;
  const look = listingLooks.get(key);
  if (!look) {
    listingLooks.set(key, { state: "loading" });
    lookUpListing(snap, key, session.pubkey);
    return "";
  }
  if (look.state !== "active")
    return "";
  return `<div class="act" id="listing-box"><h3>Take your listing down</h3>
    <p class="step-lede">${esc(snap.view.domain)} is the buyer's now, and your market listing still offers it for sale.
      This marks it sold, so the market stops showing it.</p>
    <button class="btn btn-accent btn-sm" type="button" id="listing-sold">Mark it sold</button>
    <p class="hint act-out"></p></div>`;
}
async function lookUpListing(snap, key, pubkey) {
  let answered = 0;
  const events = await queryRelays(ESCROW_RELAYS, [
    { kinds: [LISTING_KIND], authors: [pubkey], "#d": [LISTING_D_PREFIX + snap.view.domain] },
    deletionFilter([pubkey])
  ], { timeoutMs: 6000, onRelayDone: (_relay, _count, _error, complete) => {
    if (complete)
      answered++;
  } }).catch(() => []);
  if (!answered) {
    listingLooks.delete(key);
    return;
  }
  const own = events.filter((e) => e.pubkey === pubkey);
  const listings = applyDeletions(own.filter((e) => e.kind === LISTING_KIND), own.filter((e) => e.kind === DELETION_KIND));
  const newest = listings.sort((a, b) => b.created_at - a.created_at)[0];
  const parsed = newest ? parseListing(newest) : undefined;
  listingLooks.set(key, !parsed || !parsed.ok ? { state: "none" } : parsed.listing.status === "sold" ? { state: "sold" } : { state: "active", event: newest, listing: parsed.listing });
  if (state.snap?.id === snap.id)
    render(state.snap);
}
function markListingSold(button) {
  return act(button, async (out) => {
    const snap = state.snap;
    const signer = session.signer;
    const pubkey = session.pubkey;
    if (!snap || !signer || !pubkey)
      throw new Error("Connect the account you listed it with first.");
    const key = `${snap.id}:${pubkey}`;
    const look = listingLooks.get(key);
    if (look?.state !== "active")
      throw new Error("This listing isn't up any more. Reload to check.");
    const l = look.listing;
    note(out, "Waiting for your signer…");
    const at = Math.max(now(), look.event.created_at + 1);
    const sold = await patiently(signer.signEvent(buildListing({
      pubkey,
      domain: l.domain,
      priceSats: l.priceSats,
      summary: l.summary || undefined,
      description: l.description || undefined,
      status: "sold",
      publishedAt: l.publishedAt,
      createdAt: at,
      proof: l.proof
    })));
    const request = await patiently(signer.signEvent(buildDeletion({
      pubkey,
      events: [look.event],
      reason: "sold through the escrow",
      createdAt: at - 1
    })));
    if (session.pubkey !== pubkey)
      throw new Error("The connected account changed. Nothing was published.");
    note(out, "Publishing…");
    const [a] = await Promise.all([
      publishOutbox(outboxes, sold, { extraRelays: ESCROW_RELAYS }),
      publishOutbox(outboxes, request, { extraRelays: ESCROW_RELAYS })
    ]);
    const took = a.filter((r) => r.ok).length;
    if (!took)
      throw new Error("No relay took it. Try again in a minute.");
    listingLooks.set(key, { state: "sold" });
    log(`Your listing for ${esc(l.domain)} is marked sold (${took} of ${a.length} relays). The market no longer shows it.`, "good");
    return true;
  });
}
const ROLE_NAME = { buyer: "Buyer", seller: "Seller", arbiter: "Arbiter" };
const LOCK = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/>
  <path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
const CHAT_HINT = "Enter sends · Shift+Enter for a new line";
let chatFor;
let paintedThread = "";
function localTime(at) {
  const d = new Date(at * 1000);
  if (!Number.isFinite(d.getTime()))
    return "";
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(undefined, today ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
const whenText = (at) => (new Date().toDateString() === new Date(at * 1000).toDateString() ? "at " : "on ") + localTime(at);
function shownChat(role) {
  const partners = chatPartners(role);
  if (state.chatWith && partners.includes(state.chatWith))
    return state.chatWith;
  const claims = state.snap ? claimsOf(state.snap) : undefined;
  if (role !== "arbiter" && !state.snap?.settled && (claims?.buyer.disputed || claims?.seller.disputed))
    return "arbiter";
  return partners[0];
}
function chatWho(role, partner) {
  const third = ["buyer", "seller", "arbiter"].find((r) => r !== role && r !== partner);
  return `Only you and the ${partner} can read this chat; the ${third} can't.` + (partner === "arbiter" ? " Use it if something goes wrong: the arbiter may ask here for read-only proof of who holds the domain." : role !== "arbiter" ? " Transfer details and codes go here." : "");
}
function renderChat(snap) {
  const box = $("#chat-view");
  const me = state.me;
  const reader = me ? escrowPublicKeyHex(me.secret) : undefined;
  if (!me || !reader || ![snap.view.buyer, snap.view.seller, snap.view.arbiter].includes(reader)) {
    box.hidden = true;
    box.innerHTML = "";
    chatFor = undefined;
    paintedThread = "";
    $("#escrow-body").classList.remove("with-chat");
    return;
  }
  const key = `${snap.id}:${reader}`;
  if (chatFor !== key) {
    chatFor = key;
    paintedThread = "";
    state.chatWith = undefined;
    state.chatWith = shownChat(me.role);
    const [a, b] = chatPartners(me.role);
    box.innerHTML = `<div class="chat-card">
      <div class="chat-head">
        <div><h3>Messages</h3><p>Two private chats: each only between its two sides.</p></div>
        <span class="chat-badge" title="End-to-end encrypted between the two keys of each chat (NIP-17). Relays see only that somebody wrote to them.">${LOCK} Encrypted</span>
      </div>
      <div class="chat-tabs" role="tablist" id="chat-tabs">
        ${[a, b].map((r) => `<button type="button" role="tab" class="chat-tab" data-chat="${r}" id="chat-tab-${r}">${ROLE_NAME[r]}<span class="chat-count" id="chat-n-${r}"></span></button>`).join("")}
      </div>
      <p class="chat-who" id="chat-who"></p>
      <div class="thread" id="thread" role="log" aria-live="polite" aria-label="Messages"></div>
      <form class="chat-form" id="chat-form">
        <textarea id="chat-text" rows="2" maxlength="2000" aria-label="Message"></textarea>
        <button class="btn btn-accent btn-sm" type="submit" id="chat-send">Send</button>
      </form>
      <div class="chat-foot"><span id="chat-hint">${CHAT_HINT}</span><span id="chat-count">0 / 2000</span></div>
    </div>`;
  }
  box.hidden = false;
  $("#escrow-body").classList.add("with-chat");
  paintThread();
}
function switchChat(partner) {
  const me = state.me;
  const snap = state.snap;
  if (!me || !snap || !chatPartners(me.role).includes(partner))
    return;
  const area = document.querySelector("#chat-text");
  const from = shownChat(me.role);
  if (area && from !== partner) {
    state.chatDrafts.set(`${snap.id}:${from}`, area.value);
    area.value = state.chatDrafts.get(`${snap.id}:${partner}`) ?? "";
    countChat();
  }
  state.chatWith = partner;
  paintedThread = "";
  paintThread();
}
function cardHtml(card) {
  const field = (label, value, copyId) => value ? `<div class="card-row"><span class="k">${esc(label)}</span><span class="v"${copyId ? ` id="${copyId}"` : ""}>${esc(value)}</span>${copyId ? `<button class="link-btn" type="button" data-copy="#${copyId}">Copy</button>` : ""}</div>` : "";
  const id = () => `card-${Math.random().toString(36).slice(2, 10)}`;
  return card.kind === "transfer-to" ? `<div class="msg-card"><b>Transfer the domain to</b>${field("Registrar", card.registrar)}${field("Account", card.account, id())}${field("Email", card.email, id())}</div>` : `<div class="msg-card"><b>${card.method === "code" ? "Transfer code for the move" : "Pushed to your account"}</b>${field("Code", card.code, id())}${field("Note", card.note)}</div>`;
}
function paintThread() {
  const snap = state.snap;
  const thread = document.getElementById("thread");
  if (!snap || !thread || !state.me)
    return;
  const me = state.me;
  const mine = escrowPublicKeyHex(me.secret);
  const partner = shownChat(me.role);
  for (const r of chatPartners(me.role)) {
    const tab = document.getElementById(`chat-tab-${r}`);
    tab?.setAttribute("aria-selected", String(r === partner));
    tab?.classList.toggle("on", r === partner);
    const all = chatOf(snap, r);
    const count = document.getElementById(`chat-n-${r}`);
    if (count)
      count.textContent = all.length ? String(all.length) : "";
    const theirs = all.filter((m) => m.author !== mine).length;
    const seen = `${snap.id}:${r}`;
    if (r === partner)
      state.chatSeen.set(seen, theirs);
    tab?.classList.toggle("fresh", r !== partner && theirs > (state.chatSeen.get(seen) ?? 0));
  }
  const who = document.getElementById("chat-who");
  if (who)
    who.textContent = chatWho(me.role, partner);
  const area = document.querySelector("#chat-text");
  if (area)
    area.placeholder = `Write to the ${partner}…`;
  const messages = chatOf(snap, partner);
  const painted = `${snap.id}|${partner}|${snap.chats ? snap.chats.answered : "-"}|${messages.map((m) => m.id).join(",")}`;
  if (painted === paintedThread)
    return;
  const first = paintedThread === "" || !paintedThread.startsWith(`${snap.id}|${partner}|`);
  paintedThread = painted;
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  const last = messages[messages.length - 1];
  thread.innerHTML = (messages.length ? messages.map((m) => `<div class="msg ${m.author === mine ? "mine" : "theirs"} from-${esc(m.from)}">
        <div class="msg-head"><b>${m.author === mine ? "You" : esc(ROLE_NAME[m.from])}</b><time title="${esc(stamp(m.at))}">${esc(localTime(m.at))}</time></div>
        ${m.card ? cardHtml(m.card) : ""}<div class="msg-text">${esc(m.text)}</div></div>`).join("") : `<p class="thread-empty">${snap.chats ? `No messages with the ${partner} yet.` : "Reading the messages…"}</p>`) + (snap.chats && snap.chats.answered === 0 ? `<p class="thread-warn">No relay answered, so the messages can't be read right now. They refresh on their own.</p>` : "");
  if (first || nearBottom || last?.author === mine)
    thread.scrollTop = thread.scrollHeight;
}
function chatNote(text, kind = "") {
  const el = document.getElementById("chat-hint");
  if (!el)
    return;
  el.textContent = text;
  el.className = kind;
}
async function sendChat() {
  const snap = state.snap;
  const area = document.querySelector("#chat-text");
  const button = document.querySelector("#chat-send");
  if (!snap || !state.me || !area || !button || state.chatSending)
    return;
  const text = area.value.trim();
  if (!text) {
    chatNote("Write something first.", "err");
    return;
  }
  const partner = shownChat(state.me.role);
  state.chatSending = true;
  button.disabled = true;
  chatNote(`Sending to the ${partner}…`);
  try {
    await sendTo(snap, partner, text);
    if (state.me && shownChat(state.me.role) === partner)
      area.value = "";
    else
      state.chatDrafts.delete(`${snap.id}:${partner}`);
    chatNote(`Sent to the ${partner}.`, "ok");
  } catch (err) {
    chatNote(err.message, "err");
  } finally {
    state.chatSending = false;
    button.disabled = false;
    countChat();
    paintThread();
  }
}
function countChat() {
  const area = document.querySelector("#chat-text");
  const count = document.getElementById("chat-count");
  if (area && count)
    count.textContent = `${area.value.length} / 2000`;
}
async function pollChat() {
  const snap = state.snap;
  const me = state.me;
  if (!snap || !me || chatFor === undefined || state.chatPolling || document.visibilityState !== "visible")
    return;
  state.chatPolling = true;
  try {
    const chats = await readChats(snap.view, me.secret);
    if (state.snap === snap && state.me === me) {
      const cards = (c) => [...c?.byPartner.values() ?? []].flat().filter((m) => m.card).map((m) => m.id).join(",");
      const before = cards(snap.chats);
      snap.chats = mergeChats(snap.chats, chats);
      paintThread();
      if (cards(snap.chats) !== before)
        redrawActions();
    }
  } finally {
    state.chatPolling = false;
  }
}
const ack = (id, text) => `<label class="ack"><input type="checkbox" id="${id}"><span>${text}</span></label>`;
const addressField = (id, label) => `<div class="sell-form act-form"><label class="field">
     <span>${label} <small>a ${esc(NETWORK)} address you control</small></span>
     <input type="text" id="${id}" placeholder="${esc(NETWORK === "mainnet" ? "bc1q… or bc1p…" : NETWORK === "regtest" ? "bcrt1…" : "tb1q… or tb1p…")}" autocomplete="off" spellcheck="false">
   </label></div>`;
const reasonField = (id, label, value = "", options = {}) => `<div class="sell-form act-form"><label class="field">
     <span>${label}</span>
     <textarea id="${id}" rows="3" maxlength="${options.max ?? 2000}"${options.placeholder ? ` placeholder="${esc(options.placeholder)}"` : ""}>${esc(value)}</textarea>
   </label></div>`;
const copyBlock = (id, value) => `<div class="nsec" id="${id}">${esc(value)}</div>
   <button class="btn btn-ghost btn-sm" type="button" data-copy="#${id}">Copy</button>`;
const detailRows = (rows, prose = false) => `<div class="derive${prose ? " prose" : ""}">${rows.filter(([, value]) => value).map(([label, value, copyId]) => `<div class="derive-row"><span class="k">${esc(label)}</span><span class="v"${copyId ? ` id="${copyId}"` : ""}>${esc(value)}</span>${copyId ? `<button class="link-btn" type="button" data-copy="#${copyId}">Copy</button>` : ""}</div>`).join("")}</div>`;
function newestCard(messages, kind) {
  for (let i = messages.length - 1;i >= 0; i--) {
    const card = messages[i].card;
    if (card?.kind === kind)
      return { card, at: messages[i].at };
  }
  return;
}
function sameRegistrar(a, b) {
  const fold = (s) => s.toLowerCase().replace(/\b(inc|llc|ltd|limited|corp|corporation|gmbh|ag|sa|sas|bv|co|company)\b/g, "").replace(/[^a-z0-9]/g, "");
  if (!a || !b)
    return false;
  const x = fold(a);
  const y = fold(b);
  return x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x));
}
const methodGuesses = new Map;
function methodGuess(id, there, here) {
  const key = `${id}|${there ?? ""}`;
  if (here)
    methodGuesses.set(key, !there || sameRegistrar(there, here));
  return methodGuesses.get(key) ?? true;
}
const REGISTRARS = [
  "Spaceship",
  "Namecheap",
  "GoDaddy",
  "Cloudflare",
  "Porkbun",
  "Dynadot",
  "Squarespace",
  "Name.com",
  "NameSilo",
  "Gandi",
  "OVHcloud",
  "IONOS",
  "Hostinger",
  "Hover",
  "Network Solutions"
];
const transferToText = (domain, c) => [`Please transfer ${domain} to my account:`, c.registrar && `Registrar: ${c.registrar}`, `Account: ${c.account}`, c.email && `Email: ${c.email}`].filter(Boolean).join(`
`);
const transferSentText = (domain, c) => (c.method === "code" ? `The transfer code for ${domain}: ${c.code}
Start a transfer in at your registrar with it. It can take up to a week, and either registrar may email you to approve it. Confirm on the escrow page once it's in your account.` : `I've moved ${domain} to your account. Check your domain list, accept the move if your registrar asks you to, and confirm on the escrow page once it's there.`) + (c.note ? `

${c.note}` : "");
const publishBox = (side) => `<div class="act"><h3>Publish your view</h3>
    <p class="step-lede">Your view isn't on these relays${side === "seller" ? ", so nobody can fund yet" : ""}. Publish it
      again with the key in this tab.</p>
    <button class="btn btn-accent btn-sm" type="button" data-act="publish-${side}">Publish my view</button>
    <p class="hint act-out"></p></div>`;
const payoutBox = (lede) => `<div class="act"><h3>Sign your payout</h3>
    <p class="step-lede">${lede} It can only pay the address you give here.</p>
    ${addressField("sr-dest", "Pay me at")}
    <button class="btn btn-accent btn-sm" type="button" data-act="sign-release">Sign my payout</button>
    <p class="hint act-out"></p></div>`;
const refundBox = () => `<div class="act"><h3>Sign your refund</h3>
    <p class="step-lede">Do this now. If the domain never comes, the seller cancels, or the arbiter rules for you, this
      signature is what refunds you. It can only pay the address you give here.</p>
    ${addressField("rf-dest", "Refund to")}
    <button class="btn btn-accent btn-sm" type="button" data-act="sign-refund">Sign my refund</button>
    <p class="hint act-out"></p></div>`;
function transferToForm(snap, prior) {
  const here = registryCheckLast(snap.view.domain)?.registrar;
  return `<datalist id="registrar-names">${REGISTRARS.map((r) => `<option value="${esc(r)}">`).join("")}</datalist>
    <div class="sell-form act-form">
      <label class="field"><span>Registrar <small>where your account is</small></span>
        <input type="text" id="tt-registrar" list="registrar-names" maxlength="100" autocomplete="off" spellcheck="false"
          placeholder="Spaceship, Namecheap, GoDaddy…" value="${esc(prior?.registrar ?? "")}"></label>
      <label class="field"><span>Your username or account ID there</span>
        <input type="text" id="tt-account" maxlength="200" autocomplete="off" spellcheck="false" value="${esc(prior?.account ?? "")}"></label>
      <label class="field"><span>The email on that account <small>some registrars ask for it</small></span>
        <input type="email" id="tt-email" maxlength="254" autocomplete="off" spellcheck="false" value="${esc(prior?.email ?? "")}"></label>
    </div>
    ${here ? `<p class="step-lede">The registry shows ${esc(snap.view.domain)} at <b>${esc(here)}</b> now. An account there is
      quickest: the seller just moves it across. At another registrar, the seller gives you a transfer code, and the move
      takes up to a week.</p>` : ""}`;
}
function transferToBox(snap, asked) {
  const form = transferToForm(snap, asked?.card);
  if (!asked) {
    return `<div class="act"><h3>Where should the seller send it?</h3>
      <p class="step-lede">Tell the seller where your account is. It goes only to the seller, in your private chat.</p>
      ${form}
      <button class="btn btn-accent btn-sm" type="button" data-act="transfer-to">Send to the seller</button>
      <p class="hint act-out"></p></div>`;
  }
  const c = asked.card;
  return `<div class="act"><h3>Where it goes</h3>
    <p class="step-lede">You asked for it ${esc(whenText(asked.at))}: ${c.registrar ? `<b>${esc(c.registrar)}</b>, ` : ""}account
      <b>${esc(c.account)}</b>${c.email ? ` (${esc(c.email)})` : ""}. The seller transfers it there next.</p>
    <details class="fold" id="tt-fold"><summary>Change it</summary>
      ${form}
      <button class="btn btn-ghost btn-sm" type="button" data-act="transfer-to">Send the change to the seller</button>
    </details>
    <p class="hint act-out"></p></div>`;
}
const askRefundBox = (lede) => `<div class="act"><h3>Ask for your refund</h3>
    <p class="step-lede">${esc(lede)}</p>
    <button class="btn btn-ghost btn-sm" type="button" data-act="ask-refund">Ask the arbiter to refund me</button>
    <p class="hint act-out"></p></div>`;
function arrivedBox(snap, told) {
  const { view } = snap;
  const c = told?.card;
  const how = !c ? row("", `The seller says it's sent, but their transfer details haven't reached your chat. Ask them in your Seller chat.`) : c.method === "code" ? `<p class="step-lede">The seller sent you the transfer code ${esc(whenText(told.at))}. At your registrar, start a
          transfer in of ${esc(view.domain)} with this code. It can take up to a week, and either registrar may email you to
          approve it.</p>${copyBlock("tc-code", c.code)}` : `<p class="step-lede">The seller says they moved ${esc(view.domain)} to your account ${esc(whenText(told.at))}. Look in
          your registrar's domain list, and accept the move if your registrar asks you to.</p>`;
  return `<div class="act"><h3>The seller sent it</h3>
    ${how}${c?.note ? `<p class="step-lede"><b>Their note:</b> ${esc(c.note)}</p>` : ""}
    <p class="step-lede">Once ${esc(view.domain)} is in your account, under your control, confirm here. This pays the
      seller at once, and it can't be taken back.</p>
    ${ack("rc-ack", `${esc(view.domain)} is in my account at my registrar.`)}
    <button class="btn btn-accent btn-sm" type="button" data-act="received">Confirm and pay the seller</button>
    <p class="hint act-out"></p></div>`;
}
function buyerBoxes(snap) {
  if (!snap.buyerView)
    return [publishBox("buyer")];
  const boxes = [];
  const { view } = snap;
  if (!snap.funding) {
    const blocker = fundingBlocker(snap) ?? registryCheckCached(view.domain)?.problem;
    boxes.push(row("", snap.seen ? `<b>Next: wait for your payment to confirm.</b> Then sign your refund here, and tell the seller where to send
          the domain.` : blocker ? `<b>Don't pay yet:</b> ${esc(blocker)}. The payment box shows above once you can.` : `<b>Next: pay</b> with the payment box above. Once it confirms, sign your refund here, and tell the seller where
            to send the domain.`));
    return boxes;
  }
  const claims = claimsOf(snap);
  const due = snap.verdict?.deadlines;
  const refunds = !!proposal(snap, "refund", "A") && !!proposal(snap, "refund", "C");
  const release = proposal(snap, "release", "A");
  const pair = chatOf(snap, "seller");
  const asked = newestCard(pair, "transfer-to");
  const told = newestCard(pair, "transfer-sent");
  if (claims.buyer.received) {
    const open = release && !release.complete;
    boxes.push(row("good", `You confirmed ${esc(view.domain)} arrived. ${!release ? "The seller is paid once they sign their payout: their page asks them to." : open ? "The seller has signed their payout: send it below." : "The seller is paid once the payout reaches the chain."}`));
    if (open) {
      boxes.push(`<div class="act"><h3>Pay the seller</h3>
        <p class="step-lede">You confirmed the domain arrived. This sends the payout the seller signed.</p>
        <button class="btn btn-accent btn-sm" type="button" data-act="received">Send the seller's payout</button>
        <p class="hint act-out"></p></div>`);
    }
    return boxes;
  }
  if (!refunds)
    boxes.push(refundBox());
  if (claims.seller.cancelled) {
    boxes.push(row("", `<b>The seller cancelled:</b> ${esc(claims.seller.cancelled.reason || "no reason given")}.
      ${refunds ? "Your refund goes out once the seller or the arbiter co-signs it." : "Sign your refund above to get the money back."}`));
    if (refunds)
      boxes.push(askRefundBox("The seller can send your refund from their page, and so can the arbiter. If it hasn't come, ask the arbiter."));
    return boxes;
  }
  if (snap.ruling) {
    boxes.push(row("", `<b>The arbiter ruled: ${snap.ruling.decision === "release" ? "pay the seller" : "refund you"}.</b>
      ${esc(sentence(snap.ruling.reason))} The payout goes out with the ruling.`));
    return boxes;
  }
  const disputed = claims.buyer.disputed ?? claims.seller.disputed;
  if (disputed) {
    boxes.push(row("bad", `<b>Dispute open</b>, ${claims.buyer.disputed ? "opened by you" : "opened by the seller"}:
      ${esc(disputed.reason || "no reason given")}. The arbiter decides from the registry's record and the proof each side
      shows it. Watch your Arbiter chat: it may ask you there for read-only proof of what is in your account.${refunds ? "" : " Sign your refund above, or the arbiter can't refund you."}`));
  }
  if (!claims.seller.sent) {
    if (!disputed)
      boxes.push(transferToBox(snap, asked));
    const late = due !== undefined && snap.tip !== undefined && snap.tip >= due.deliverBy;
    if (!disputed) {
      boxes.push(row(late ? "bad" : "", late ? `<b>The seller didn't say it was sent before block ${due.deliverBy}</b>, so the rules refund you.
           ${refunds ? "The arbiter completes your refund." : "Sign your refund above."}` : `The seller transfers ${esc(view.domain)} to you${due ? ` before ${esc(blocksAway(due.deliverBy, snap.tip))}` : ""}.
           Their transfer details show here and in your Seller chat. If they don't say it's sent by then, you are refunded.`));
      if (late && refunds)
        boxes.push(askRefundBox("Let the arbiter know, so it completes your refund now."));
    }
    return boxes;
  }
  boxes.push(arrivedBox(snap, told));
  if (!disputed) {
    boxes.push(`<div class="act"><h3>Not arrived?</h3>
      <p class="step-lede">Ask the seller first, in your Seller chat: a move between registrars can take up to a week.
        If you can't sort it out, ask the arbiter to decide. It checks the registry's record and may ask you, in your
        Arbiter chat, for read-only proof of what is in your account.</p>
      ${reasonField("dp-reason", "What's wrong <small>public, in your view of the escrow</small>", "", { max: 1500 })}
      ${asked ? `<label class="ack"><input type="checkbox" id="dp-share" checked><span>Tell the arbiter where I asked for
        it: ${asked.card.registrar ? `${esc(asked.card.registrar)}, ` : ""}account ${esc(asked.card.account)}.</span></label>` : ""}
      <button class="btn btn-ghost btn-sm" type="button" data-act="dispute">Ask the arbiter to decide</button>
      <p class="hint act-out"></p></div>`);
  }
  return boxes;
}
function methodPick(push) {
  return `<div class="method-pick" role="radiogroup" aria-label="How you send it">
      <label class="method"><input type="radio" name="ts-method" id="ts-push" value="push"${push ? " checked" : ""}>
        <span><b>Move it to the buyer's account</b><small>Same registrar: its move between accounts, often called a push,
          a change of account or a transfer of ownership.</small></span></label>
      <label class="method"><input type="radio" name="ts-method" id="ts-code" value="code"${push ? "" : " checked"}>
        <span><b>Give the buyer a transfer code</b><small>Another registrar: turn off the transfer lock, get the domain's
          auth (EPP) code, and paste it below.</small></span></label>
    </div>
    <div class="sell-form act-form code-only"><label class="field"><span>Transfer code <small>also called the auth or EPP code</small></span>
      <input type="text" id="ts-code-text" maxlength="500" autocomplete="off" spellcheck="false"></label></div>
    <div class="sell-form act-form"><label class="field"><span>A note for the buyer <small>optional</small></span>
      <textarea id="ts-note" rows="2" maxlength="1000"></textarea></label></div>`;
}
function transferSentCard() {
  const method = document.querySelector('input[name="ts-method"]:checked')?.value === "code" ? "code" : "push";
  const card = {
    kind: "transfer-sent",
    method,
    code: method === "code" ? (document.querySelector("#ts-code-text")?.value ?? "").trim() : "",
    note: (document.querySelector("#ts-note")?.value ?? "").trim()
  };
  if (method === "code" && !card.code)
    throw new Error("Paste the transfer code, or pick the move to the buyer's account.");
  const bad = cardProblem(card, "seller", "buyer");
  if (bad)
    throw new Error(`${sentence(bad)}.`);
  return card;
}
function transferBox(snap, asked) {
  const { view } = snap;
  const due = snap.verdict?.deadlines;
  const late = due !== undefined && snap.tip !== undefined && snap.tip >= due.deliverBy;
  const check = registryCheckLast(view.domain);
  const here = check?.registrar;
  const there = asked?.card.registrar;
  const push = methodGuess(snap.id, there, here);
  const where = asked ? `<p class="step-lede">The buyer asked for it here, ${esc(whenText(asked.at))}:</p>` + detailRows([
    ["Registrar", asked.card.registrar],
    ["Account", asked.card.account, "to-account"],
    ["Email", asked.card.email, "to-email"]
  ]) : row("", `<b>The buyer hasn't said where to send it yet.</b> Ask them in your Buyer chat. For a move to another
        registrar you only need to give them the transfer code.`);
  return `<div class="act ts-form"><h3>${late ? "The transfer deadline has passed" : "Transfer it to the buyer"}</h3>
    ${late ? `<p class="step-lede">You didn't say it was sent before block ${due.deliverBy}, so the rules now refund the buyer,
          and the arbiter may do so at any moment. Transfer it now only if the buyer still wants it: ask in your Buyer chat first.</p>` : due ? `<p class="step-lede">Before ${esc(blocksAway(due.deliverBy, snap.tip))}. Then the buyer confirms it
          arrived, which pays you.</p>` : ""}
    ${where}
    ${here ? `<p class="step-lede">The registry shows ${esc(view.domain)} at <b>${esc(here)}</b> now${there ? `, and the buyer's account is at <b>${esc(there)}</b>: ${push ? "the same registrar, so move it across" : "another registrar, so give them the transfer code"}` : ""}.</p>` : ""}
    ${(check?.warnings ?? []).map((w) => row("", esc(sentence(w)) + ".")).join("")}
    ${methodPick(push)}
    <p class="step-lede">Saying it's sent also signs your payout, so the buyer's confirmation pays you at once. The transfer
      details go only to the buyer, in your private chat.</p>
    ${addressField("ps-dest", "Pay me at")}
    ${ack("ps-ack", `I have started the transfer of ${esc(view.domain)} to the buyer.`)}
    <button class="btn btn-accent btn-sm" type="button" data-act="sent">I sent it: sign my payout</button>
    <p class="hint act-out"></p></div>`;
}
function relockRow(snap) {
  const told = newestCard(chatOf(snap, "buyer"), "transfer-sent");
  if (told?.card.method !== "code")
    return "";
  return row("bad", `<b>You gave the buyer a transfer code, and the sale is off.</b> At your registrar, turn the transfer
    lock back on, have it issue a new code, and reject any transfer out of ${esc(snap.view.domain)} still pending, so the
    domain stays yours.`);
}
function sellerBoxes(snap) {
  if (!snap.sellerView)
    return [publishBox("seller")];
  const boxes = [];
  const { view } = snap;
  const claims = claimsOf(snap);
  if (!snap.funding) {
    boxes.push(row("", `<b>Don't transfer yet.</b> Wait until this page shows the escrow funded and confirmed. Then the
      buyer tells you, in your Buyer chat, where to send ${esc(view.domain)}.`));
    return boxes;
  }
  const due = snap.verdict?.deadlines;
  const released = !!proposal(snap, "release", "A") && !!proposal(snap, "release", "B");
  const pair = chatOf(snap, "buyer");
  const asked = newestCard(pair, "transfer-to");
  const told = newestCard(pair, "transfer-sent");
  if (claims.buyer.received) {
    boxes.push(row("good", `The buyer confirmed ${esc(view.domain)} is in their account.${released ? " You are paid once the payout reaches the chain." : ""}`));
    if (!released)
      boxes.push(payoutBox("The domain is the buyer's now. Sign your payout: the buyer's page, or the arbiter, then completes it."));
    return boxes;
  }
  if (claims.seller.cancelled) {
    const refund = proposal(snap, "refund", "A");
    boxes.push(row("", refund?.complete || !refund ? `You cancelled. The buyer is refunded once ${refund ? "the payout reaches the chain" : "they sign their refund"}.` : "You cancelled. The buyer has signed their refund since: send it below."));
    if (refund && !refund.complete) {
      boxes.push(`<div class="act"><h3>Send the buyer's refund</h3>
        <p class="step-lede">You cancelled the sale. This co-signs the refund the buyer signed, to their own address, and sends it.</p>
        <button class="btn btn-accent btn-sm" type="button" data-act="cosign-refund">Send the refund</button>
        <p class="hint act-out"></p></div>`);
    }
    boxes.push(relockRow(snap));
    return boxes;
  }
  if (snap.ruling) {
    boxes.push(row("", `<b>The arbiter ruled: ${snap.ruling.decision === "release" ? "pay you" : "refund the buyer"}.</b>
      ${esc(sentence(snap.ruling.reason))} The payout goes out with the ruling.`));
    if (snap.ruling.decision === "refund")
      boxes.push(relockRow(snap));
    return boxes;
  }
  const disputed = claims.seller.disputed ?? claims.buyer.disputed;
  if (disputed) {
    boxes.push(row("bad", `<b>Dispute open</b>, ${claims.seller.disputed ? "opened by you" : "opened by the buyer"}:
      ${esc(disputed.reason || "no reason given")}. The arbiter decides from the registry's record and the proof each side
      shows it. Watch your Arbiter chat: it may ask you there for read-only proof of how you sent the domain.`));
  }
  if (!claims.seller.sent) {
    boxes.push(transferBox(snap, asked));
  } else {
    boxes.push(row("", `You said ${esc(view.domain)} is sent, ${esc(whenText(claims.seller.sent.at))}. The buyer confirms
      once it is in their account, which pays you.`));
    if (!released)
      boxes.push(payoutBox("Your payout isn't signed, so the buyer's confirmation can't pay you yet. Sign it now."));
    const push = told ? told.card.method === "push" : methodGuess(snap.id, asked?.card.registrar, registryCheckLast(view.domain)?.registrar);
    boxes.push(`<div class="act ts-form"><h3>${told ? "Send the buyer new transfer details" : "Send the buyer your transfer details"}</h3>
      <p class="step-lede">${told ? `You sent them ${told.card.method === "code" ? "a transfer code" : "word of the move"} ${esc(whenText(told.at))}. If a
           code didn't work or you have a new one, send it here.` : "Your transfer details didn't reach the buyer's chat, so they don't know how to take the domain yet."} It goes only
        to the buyer.</p>
      ${methodPick(push)}
      <button class="btn ${told ? "btn-ghost" : "btn-accent"} btn-sm" type="button" data-act="resend-transfer">Send to the buyer</button>
      <p class="hint act-out"></p></div>`);
    if (!disputed) {
      boxes.push(`<div class="act"><h3>The buyer hasn't confirmed?</h3>
        <p class="step-lede">If ${esc(view.domain)} is in the buyer's account and they don't confirm, ask the arbiter to
          decide${due ? `, well before block ${due.timeoutAt}: from then on the buyer can take the money back alone` : ""}.
          It checks the registry's record and may ask you, in your Arbiter chat, for read-only proof.</p>
        ${reasonField("dp-reason", "What happened <small>public, in your view of the escrow</small>", "", { max: 1500 })}
        <button class="btn btn-ghost btn-sm" type="button" data-act="dispute">Ask the arbiter to decide</button>
        <p class="hint act-out"></p></div>`);
    }
  }
  boxes.push(`<div class="act"><h3>Cancel the sale</h3>
    <p class="step-lede">${claims.seller.sent ? "Only if the transfer failed and you are keeping the domain. The buyer gets the money back." : "If you can't or won't transfer it, cancel, and the buyer gets the money back."}</p>
    ${reasonField("cn-reason", "Why <small>public, in your view of the escrow</small>", "", { max: 1500 })}
    ${ack("cn-ack", "Refund the buyer. I won't be paid for this trade.")}
    <button class="btn btn-ghost btn-sm" type="button" data-act="cancel">Cancel and refund the buyer</button>
    <p class="hint act-out"></p></div>`);
  return boxes;
}
const registryReads = new Set;
const registryFailed = new Map;
function redrawActions() {
  const snap = state.snap;
  if (snap && !state.acting)
    safely("#act-view", () => keepInputs($("#act-view"), () => renderActions(snap)));
}
function readRegistryFor(domain) {
  const failed = registryFailed.get(domain);
  if (registryReads.has(domain) || failed && now() - failed.at < 60)
    return;
  registryReads.add(domain);
  registryOf(domain).then((result) => {
    registryReads.delete(domain);
    if (result.ok)
      registryFailed.delete(domain);
    else
      registryFailed.set(domain, { at: now(), reason: result.reason });
    if (state.snap?.view.domain === domain)
      redrawActions();
  });
}
const STATUS_WORDS = {
  clienttransferprohibited: "locked against a move to another registrar",
  servertransferprohibited: "the registry blocks moves to another registrar",
  pendingtransfer: "a move to another registrar is under way",
  clientupdateprohibited: "locked against changes",
  serverupdateprohibited: "the registry blocks changes",
  clienthold: "doesn't resolve",
  serverhold: "doesn't resolve"
};
function registryPanel(snap) {
  const domain = snap.view.domain;
  const cached = registryCache.get(domain);
  if (!cached || now() - cached.at >= 300)
    readRegistryFor(domain);
  const head = `<h3>The registry's record <small>WHOIS</small></h3>`;
  if (!cached) {
    const failed = registryFailed.get(domain);
    return `<div class="act">${head}${failed ? row("bad", `The registry couldn't be read: ${esc(failed.reason)}. It is tried again in a minute.`) : row("", "Reading the registry…")}</div>`;
  }
  if (!cached.result.ok)
    return "";
  const f = cached.result.facts;
  const day = (t) => t === undefined ? "none on record" : new Date(t * 1000).toISOString().slice(0, 10);
  const opened = snap.view.deadlines.fundBy !== undefined ? snap.view.deadlines.fundBy - 86400 : undefined;
  const since = (t) => t !== undefined && opened !== undefined && t >= opened ? " · after this escrow opened" : "";
  const notes = f.statuses.filter((s) => STATUS_WORDS[s]).map((s) => STATUS_WORDS[s]);
  return `<div class="act">${head}
    ${detailRows([
    ["Registrar", `${f.registrarName ?? "not named"}${f.registrarIanaId ? ` · IANA ${f.registrarIanaId}` : ""}`],
    ["Status", `${f.rawStatuses.length ? f.rawStatuses.join(", ") : "none"}${notes.length ? ` · ${notes.join("; ")}` : ""}`],
    ["Last transfer", day(f.lastTransfer) + since(f.lastTransfer)],
    ["Last changed", day(f.lastChanged) + since(f.lastChanged)],
    ["Expires", day(f.expiration)],
    ["Nameservers", f.nameservers.join(", ")]
  ])}
    <p class="step-lede">Read ${esc(whenText(cached.at))} from the registry's RDAP service, the modern WHOIS${opened !== undefined ? `; this escrow opened about ${esc(day(opened))}` : ""}. A move to another registrar shows here as a new registrar,
      and a new transfer or change date. A move between two accounts at one registrar doesn't show here at all: only that
      registrar knows the account, so ask for read-only proof.</p>
    <button class="btn btn-ghost btn-sm" type="button" data-act="registry-refresh">Read it again</button>
    <p class="hint act-out"></p></div>`;
}
const evidenceAsk = (domain, side) => side === "buyer" ? `About the dispute on ${domain}: please send me proof of whether ${domain} is in your account at your registrar. Best is a read-only API key, one that can only read your domains and change nothing. If your registrar can't make a read-only key, say so and send a screenshot of your domain list instead. Send it here, in this chat. Never send a password, a login code or a transfer code. Delete the key once I've ruled.` : `About the dispute on ${domain}: please send me proof of how and when you transferred ${domain} to the buyer. Best is a read-only API key, one that can only read your domains and change nothing, and the date you started the transfer. If your registrar can't make a read-only key, say so and send a screenshot of the transfer instead. Send it here, in this chat. Never send a password, a login code or a transfer code. Delete the key once I've ruled.`;
function evidenceBox(snap) {
  const domain = snap.view.domain;
  return `<div class="act"><h3>Ask for proof</h3>
    <p class="step-lede">Ask each side, in your own chat with it, for read-only proof of where the domain is. Neither sees
      what you ask the other. Edit the request if you like.</p>
    ${reasonField("ev-buyer", "To the buyer", evidenceAsk(domain, "buyer"))}
    <button class="btn btn-ghost btn-sm" type="button" data-act="ask-buyer">Send to the buyer</button>
    ${reasonField("ev-seller", "To the seller", evidenceAsk(domain, "seller"))}
    <button class="btn btn-ghost btn-sm" type="button" data-act="ask-seller">Send to the seller</button>
    <details class="fold" id="ev-howto"><summary>Checking a read-only key</summary>
      <p class="step-lede">On your own computer, never in a web page. A registrar's API answers only about the domains in
        the key's own account. Spaceship's, for example:</p>
      <div class="nsec">curl -s -H "X-API-Key: KEY" -H "X-API-Secret: SECRET" https://spaceship.dev/api/v1/domains/${esc(domain)}</div>
      <p class="step-lede">It returns the domain's details when the domain is in that account, and an error when it isn't.
        Other registrars have a call like it; their API documentation names it. Say what you checked in the ruling's reason.</p>
    </details>
    <p class="hint act-out"></p></div>`;
}
function ruleBox(snap) {
  const v = snap.verdict;
  const release = proposal(snap, "release", "B");
  const refund = proposal(snap, "refund", "C");
  const suggested = v.action === "release" || v.action === "refund" ? v.action : undefined;
  const partial = snap.relaysAnswered < ESCROW_RELAYS.length;
  return `<div class="act"><h3>Rule</h3>
    <p class="step-lede">${v.action === "decide" ? "A side asked you to decide. Weigh the registry's record and the proof each side shows you, then rule. " : v.action === "wait" ? "The rules don't call for a payout yet. Rule now only if you have checked, and the rules alone don't decide this. " : ""}Each
      button co-signs that side's own signed payout, broadcasts it, and publishes the ruling with your reason.</p>
    ${partial ? row("bad", `<b>Only ${snap.relaysAnswered} of ${ESCROW_RELAYS.length} relays answered</b>, so a claim may be
      missing from this record. Refresh before ruling if you can.`) : ""}
    ${reasonField("ar-reason", "Reason, published with the ruling", suggested ? sentence(v.reason) + "." : "", {
    max: 1800,
    placeholder: v.action === "decide" ? "What the proof showed: say, the registry shows the domain at the buyer's registrar since…" : ""
  })}
    ${partial ? ack("ar-partial", "Rule on this record although not every relay answered.") : ""}
    ${v.action === "decide" ? "" : ack(`ar-override-${v.action}`, suggested ? "Rule against the rules. Needed only for the other button." : "I have checked the record, and the rules alone don't decide this.")}
    <div class="btn-row">
      <button class="btn ${suggested === "release" ? "btn-accent" : "btn-ghost"} btn-sm" type="button" data-act="rule-release" ${release ? "" : "disabled"}>Release to the seller</button>
      <button class="btn ${suggested === "refund" ? "btn-accent" : "btn-ghost"} btn-sm" type="button" data-act="rule-refund" ${refund ? "" : "disabled"}>Refund the buyer</button>
    </div>
    ${release ? "" : `<p class="hint">No release yet: the seller hasn't signed a payout. Ask them in your Seller chat.</p>`}
    ${refund ? "" : `<p class="hint">No refund yet: the buyer hasn't signed a refund. Ask them in your Buyer chat.</p>`}
    <p class="hint act-out"></p></div>`;
}
function arbiterBoxes(snap) {
  const boxes = [];
  const v = snap.verdict;
  const claims = claimsOf(snap);
  const said = (what, c) => c ? `${what}, stated ${stamp(c.at)}${c.reason !== undefined ? `: ${c.reason || "no reason given"}` : ""}` : "";
  const seller = [
    said("says sent", claims.seller.sent) || "hasn't said sent",
    said("cancelled", claims.seller.cancelled),
    said("asked you to decide", claims.seller.disputed)
  ].filter(Boolean).join("; ");
  const buyer = [
    said("confirmed it arrived", claims.buyer.received) || "hasn't confirmed it arrived",
    said("asked you to decide", claims.buyer.disputed)
  ].filter(Boolean).join("; ");
  boxes.push(`<div class="act"><h3>The record</h3>
    ${detailRows([
    ["Seller", seller],
    ["Buyer", buyer],
    ["Deadlines", v ? `transfer by block ${v.deadlines.deliverBy}; the buyer's lone refund from block ${v.deadlines.timeoutAt}` : `${snap.view.deliverBlocks} blocks to transfer after funding; the buyer's lone refund after ${snap.view.timeoutBlocks}`],
    ["Ruling", snap.ruling ? `${snap.ruling.decision}: ${snap.ruling.reason}` : "none yet"]
  ], true)}
    <p class="hint">Times are what each side stated, not proof of when; the deadlines count blocks from funding. The buyer
      and the seller have their own chat, which you can't read: you see only what each tells you.</p></div>`);
  boxes.push(registryPanel(snap));
  if (snap.settled)
    return boxes;
  if (!snap.funding) {
    boxes.push(row("", "Nothing to rule on until the escrow is funded."));
    return boxes;
  }
  if (!v) {
    boxes.push(row("", "The chain tip can't be read, so the rules can't be applied yet. Refresh in a minute."));
    return boxes;
  }
  if (claims.buyer.disputed || claims.seller.disputed)
    boxes.push(evidenceBox(snap));
  boxes.push(ruleBox(snap));
  return boxes;
}
async function act(button, run) {
  const box = button.closest(".act") ?? button.parentElement;
  let out = box.querySelector(".act-out");
  if (!out) {
    out = document.createElement("p");
    out.className = "hint act-out";
    box.append(out);
  }
  if (button.hasAttribute("disabled") || state.acting)
    return;
  button.setAttribute("disabled", "");
  state.acting = true;
  let done = false;
  try {
    done = await run(out) === true;
  } catch (err) {
    fail(out, err.message);
  } finally {
    state.acting = false;
    if (done) {
      paintedActions = "";
      box.classList.add("is-done");
      note(out, "Done. Updating the page…", "ok");
    } else {
      button.removeAttribute("disabled");
    }
    refreshWanted();
  }
}
function destOf(id, snap) {
  const dest = $(id).value.trim().replace(/^bitcoin:/i, "").split("?")[0];
  addressToScript(dest, snap.view.network);
  if (dest.toLowerCase() === snap.view.address.toLowerCase())
    throw new Error("That is the escrow address itself. Pay out to an address you control.");
  return dest;
}
const paramsOf = (v) => ({
  salt: v.salt,
  buyer: bytesOf(v.buyer),
  seller: bytesOf(v.seller),
  arbiter: bytesOf(v.arbiter),
  timeoutBlocks: v.timeoutBlocks,
  deliverBlocks: v.deliverBlocks,
  network: v.network,
  amountSats: v.amountSats,
  domain: v.domain,
  ...v.listing ? { listing: v.listing } : {},
  deadlines: v.deadlines
});
async function freshRecord(snap) {
  let answered = 0;
  const events = await queryRelays(ESCROW_RELAYS, escrowFilters(snap.id, [snap.view.buyer, snap.view.seller, snap.view.arbiter]), {
    timeoutMs: 6000,
    onRelayDone: (_relay, _count, _error, complete) => {
      if (complete)
        answered++;
    }
  }).catch(() => []);
  const views = events.filter((e) => e.tags.some((t) => t[0] === "d" && t[1] === ESCROW_D_PREFIX + snap.id)).map((e) => {
    try {
      return parseEscrowEvent(e);
    } catch {
      return { ok: false, reason: "" };
    }
  }).flatMap((r) => r.ok ? [r.view] : []);
  const c = compareViews(views, snap.id);
  const newer = (a, b) => !a ? b : !b ? a : b.publishedAt > a.publishedAt ? b : a;
  const ruled = events.some((e) => e.pubkey === snap.view.arbiter && e.tags.some((t) => t[0] === "d" && t[1] === RULING_D_PREFIX + snap.id) && (() => {
    const r = parseRuling(e);
    return r.ok && r.ruling.id === snap.id;
  })());
  return {
    seller: newer(snap.sellerView, c.sellerView)?.claims ?? {},
    buyer: newer(snap.buyerView, c.buyerView)?.claims ?? {},
    ruled,
    answered
  };
}
async function quote(snap, kind, dest) {
  const f = snap.funding;
  const rate = Math.min(Math.max(await chain.feeRate(), 1), 500);
  return settlementFee({ tree: snap.tree, settlement: { kind, leaf: "A", outpoint: f.outpoint, dest }, value: f.value, network: snap.view.network, rate });
}
function confirmPayout(title, payout) {
  const share = Number(BigInt(payout.fee) * 1000n / payout.value) / 10;
  return confirmDialog(title, `<div class="confirm">
      <div class="amount">${sats(payout.value - BigInt(payout.fee))} sats</div>
      <div class="to">to ${esc(payout.dest)}</div>
      <div class="fee">Network fee ${sats(payout.fee)} sats, out of ${sats(payout.value)} in the escrow. ${payout.note}</div>
    </div>` + (share > 5 ? row("bad", `<b>The fee is ${share}% of the escrow</b>, because fees are high right now. It goes to miners, not to anyone here.`) : ""), "Sign");
}
function propose(snap, kind, dest, fee) {
  const f = snap.funding;
  const leaves = kind === "release" ? ["A", "B"] : ["A", "C"];
  return leaves.map((leaf) => signSettlement({
    tree: snap.tree,
    settlement: { kind, leaf, outpoint: f.outpoint, dest, fee },
    value: f.value,
    network: snap.view.network,
    secretKey: state.me.secret
  }));
}
function cosign(snap, entry) {
  return signSettlement({ tree: snap.tree, settlement: entry.settlement, value: snap.funding.value, network: snap.view.network, secretKey: state.me.secret });
}
async function publishMine(snap, change) {
  const me = state.me;
  const mine = newestMine(snap);
  if (!mine)
    throw new Error("Publish your own view first.");
  const claims = { ...mine.claims, ...change.claims };
  const fresh = change.sigs ?? [];
  const sigs = [...mine.sigs.filter((s) => !fresh.some((n) => n.kind === s.kind && n.leaf === s.leaf)), ...fresh];
  const event = signEvent(buildEscrowEvent({
    ...paramsOf(mine),
    pubkey: mine.author,
    createdAt: Math.max(now(), mine.publishedAt + 1),
    claims,
    sigs
  }), me.secret);
  const results = await publishToRelays(ESCROW_RELAYS, event);
  if (!results.some((r) => r.ok))
    throw new Error(`No relay accepted the update: ${results.map((r) => r.message ?? "refused").join("; ")}`);
  remember(snap.id, event);
  return reachOf(results);
}
function reachOf(results) {
  const ok = results.filter((r) => r.ok).length;
  return ok * 2 < results.length ? ` Only ${ok} of ${results.length} relays took it, so a reader who reaches only the others won't see it yet. It goes out again with your next change; check back.` : ` It reached ${ok} of ${results.length} relays.`;
}
function newestMine(snap) {
  const author = escrowPublicKeyHex(state.me.secret);
  let best = state.me.role === "buyer" ? snap.buyerView : snap.sellerView;
  for (const event of state.own.get(snap.id) ?? []) {
    if (event.pubkey !== author)
      continue;
    const parsed = parseEscrowEvent(event);
    if (!parsed.ok || parsed.view.id !== snap.id)
      continue;
    const v = parsed.view;
    if (!best || v.publishedAt > best.publishedAt || v.publishedAt === best.publishedAt && v.event.id < best.event.id)
      best = v;
  }
  return best;
}
async function publishSigned(escrowId, event, what) {
  const results = await publishToRelays(ESCROW_RELAYS, event);
  remember(escrowId, event);
  const taken = results.filter((r) => r.ok).length;
  const thin = taken * 2 < results.length;
  if (thin)
    state.pending.set(event.id, { escrowId, event, what });
  else
    state.pending.delete(event.id);
  return {
    ok: taken > 0,
    thin,
    reach: thin ? ` Only ${taken} of ${results.length} relays took it, so publish it again from the box below.` : ` It reached ${taken} of ${results.length} relays.`
  };
}
async function broadcastEntry(snap, entry, out, append = false) {
  const done = completeSettlement({
    tree: snap.tree,
    settlement: entry.settlement,
    value: snap.funding.value,
    network: snap.view.network,
    signatures: entry.sigs
  });
  const answer = await chain.broadcast(done.hex).catch((err) => ({ ok: false, reason: err.message }));
  if (answer.ok) {
    log(`Broadcast <a href="${esc(chain.explorer)}/tx/${esc(answer.txid)}" target="_blank" rel="noopener">${esc(answer.txid)}</a>.
      It counts once it confirms.`, "good", append);
    return true;
  }
  log(`The network refused it: ${esc(answer.reason)}. Raw transaction, to broadcast anywhere else:
    <span class="nsec">${esc(done.hex)}</span>`, "bad", append);
  note(out, "Not broadcast. See above.", "err");
  return false;
}
async function completeAndSend(snap, entry, mine, out) {
  const role = state.me.role;
  const filled = { ...entry, sigs: { ...entry.sigs, [role]: mine.sig }, complete: true };
  return broadcastEntry(snap, filled, out);
}
async function arbiterPayout(snap, decision, reason, entry, out, append = false) {
  const mine = cosign(snap, entry);
  const filled = { ...entry, sigs: { ...entry.sigs, arbiter: mine.sig }, complete: true };
  const done = completeSettlement({ tree: snap.tree, settlement: entry.settlement, value: snap.funding.value, network: snap.view.network, signatures: filled.sigs });
  if (!await broadcastEntry(snap, filled, out, append))
    return false;
  const ruling = signEvent(buildRuling({
    id: snap.id,
    decision,
    reason,
    settlement: mine,
    txid: done.txid,
    parties: [snap.view.buyer, snap.view.seller],
    pubkey: snap.view.arbiter,
    createdAt: now()
  }), state.me.secret);
  const published = await publishSigned(snap.id, ruling, "the ruling");
  log(published.ok ? `Ruled ${esc(decision)}, and the ruling is published.${published.reach}` : `Ruled ${esc(decision)}, but no relay accepted the ruling. Publish it again from the box below while this tab is open.`, published.thin ? "bad" : "good", true);
  return true;
}
async function onAct(name, button) {
  const snap = state.snap;
  if (!snap || !state.me)
    return;
  const refresh = refreshWanted;
  const as = (role) => {
    if (state.me.role !== role)
      throw new Error(`That needs the ${role}'s key, and this one is the ${state.me.role}'s.`);
  };
  await act(button, async (out) => {
    switch (name) {
      case "publish-seller":
      case "publish-buyer": {
        const role = name === "publish-buyer" ? "buyer" : "seller";
        if (state.me.role !== role)
          throw new Error(`That key is the ${state.me.role}'s.`);
        if (snap.relaysAnswered < ESCROW_RELAYS.length && !await confirmDialog("Not every relay answered", `<p>Only ${snap.relaysAnswered} of ${ESCROW_RELAYS.length} relays answered, so your view may be on one that didn't.
           Publishing now would replace it there with a fresh one, without its claims and signatures. Refreshing
           first is safer.</p>`, "Publish anyway"))
          return;
        const event = signEvent(buildEscrowEvent({
          ...paramsOf(snap.view),
          pubkey: escrowPublicKeyHex(state.me.secret),
          createdAt: now()
        }), state.me.secret);
        const results = await publishToRelays(ESCROW_RELAYS, event);
        if (!results.some((r) => r.ok))
          throw new Error("No relay accepted it.");
        remember(snap.id, event);
        log("Your view is published.", "good");
        refresh();
        return true;
      }
      case "sign-refund": {
        as("buyer");
        const dest = destOf("#rf-dest", snap);
        const fee = await quote(snap, "refund", dest);
        if (!await confirmPayout("Sign your refund", {
          value: snap.funding.value,
          fee,
          dest,
          note: "This is what you get back if the seller or the arbiter completes your refund. It can pay nobody else."
        }))
          return;
        note(out, "Signing…");
        const reach = await publishMine(snap, { sigs: propose(snap, "refund", dest, fee) });
        log("Refund signed and published. It can only pay the address you gave." + reach, "good");
        refresh();
        return true;
      }
      case "transfer-to": {
        as("buyer");
        const card = {
          kind: "transfer-to",
          registrar: $("#tt-registrar").value.trim(),
          account: $("#tt-account").value.trim(),
          email: $("#tt-email").value.trim()
        };
        if (!card.account)
          throw new Error("Enter your username or account ID at your registrar.");
        if (card.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(card.email))
          throw new Error("That email doesn't look right.");
        const bad = cardProblem(card, "buyer", "seller");
        if (bad)
          throw new Error(`${sentence(bad)}.`);
        note(out, "Sending it to the seller…");
        await sendTo(snap, "seller", transferToText(snap.view.domain, card), card);
        log("Sent to the seller, in your private chat with them.", "good");
        refresh();
        return true;
      }
      case "sent":
      case "sign-release": {
        as("seller");
        const card = name === "sent" ? transferSentCard() : undefined;
        if (name === "sent" && !$("#ps-ack").checked)
          throw new Error("Tick the box once you have started the transfer.");
        const dest = destOf(name === "sent" ? "#ps-dest" : "#sr-dest", snap);
        const fee = await quote(snap, "release", dest);
        if (!await confirmPayout("Sign your payout", {
          value: snap.funding.value,
          fee,
          dest,
          note: "Paid here when the buyer confirms the domain arrived, or when the arbiter rules for you. Check every character."
        }))
          return;
        note(out, "Signing…");
        const reach = await publishMine(snap, {
          ...name === "sent" ? { claims: { sent: { at: now() } } } : {},
          sigs: propose(snap, "release", dest, fee)
        });
        log((name === "sent" ? "Marked sent, and your payout is signed." : "Your payout is signed.") + reach, "good");
        if (card) {
          try {
            await sendTo(snap, "buyer", transferSentText(snap.view.domain, card), card);
          } catch (err) {
            log(`The transfer details didn't reach the buyer's chat: ${esc(err.message)} Send them again below.`, "bad", true);
          }
        }
        refresh();
        return true;
      }
      case "resend-transfer": {
        as("seller");
        const card = transferSentCard();
        note(out, "Sending it to the buyer…");
        await sendTo(snap, "buyer", transferSentText(snap.view.domain, card), card);
        log("Sent to the buyer, in your private chat with them.", "good");
        refresh();
        return true;
      }
      case "received": {
        as("buyer");
        const already = !!claimsOf(snap).buyer.received;
        if (!already && !$("#rc-ack").checked)
          throw new Error("Tick the box once the domain is in your account.");
        const found = proposal(snap, "release", "A");
        const release = found && !found.complete ? found : undefined;
        if (release && !await confirmPayout("Pay the seller", {
          value: snap.funding.value,
          fee: release.settlement.fee,
          dest: release.settlement.dest,
          note: "The seller's own address. This can't be taken back."
        }))
          return;
        const mine = release ? cosign(snap, release) : undefined;
        if (!release || !mine) {
          if (already)
            throw new Error(found ? "The payout is signed by you both: broadcast it from the box above." : "The seller's payout isn't signed yet, so there is nothing to send.");
          const reach = await publishMine(snap, { claims: { received: { at: now() } } });
          log((found ? "Recorded. The payout is signed by you both: broadcast it from the box above." : "Recorded. The seller hasn't signed a payout yet; once they do, it can be sent.") + reach, "good");
          tell(snap, "seller", `${snap.view.domain} is in my account, and I've confirmed it. Sign your payout on the escrow page to be paid.`);
          refresh();
          return true;
        }
        const recorded = await publishMine(snap, { ...already ? {} : { claims: { received: { at: now() } } }, sigs: [mine] }).then(() => true, () => false);
        const sent = await completeAndSend(snap, release, mine, out);
        if (sent && !recorded)
          log("No relay accepted your confirmation, but the payout is what counts.", "", true);
        tell(snap, "seller", `${snap.view.domain} is in my account, and I've confirmed it${sent ? ". Your payout is sent" : ""}.`);
        refresh();
        return sent;
      }
      case "dispute": {
        const role = state.me.role;
        if (role === "arbiter")
          throw new Error("Only the buyer or the seller asks the arbiter to decide.");
        const reason = $("#dp-reason").value.trim();
        if (!reason)
          throw new Error("Say what's wrong: the arbiter reads it first.");
        if (!await confirmDialog("Ask the arbiter to decide", `<p>The arbiter then decides who is paid, from the registry's
            record and the proof each of you shows it, in your own chat with it. Your reason is public, in your view of the
            escrow. ${role === "buyer" ? "You can still confirm the domain arrived later." : "You can still cancel later."}</p>`, "Ask the arbiter"))
          return;
        const reach = await publishMine(snap, { claims: { disputed: { at: now(), reason } } });
        log("Dispute opened. The arbiter decides next: watch your Arbiter chat." + reach, "good");
        const asked = role === "buyer" && document.querySelector("#dp-share")?.checked ? newestCard(chatOf(snap, "seller"), "transfer-to")?.card : undefined;
        const told = role === "seller" ? newestCard(chatOf(snap, "buyer"), "transfer-sent") : undefined;
        tell(snap, "arbiter", [
          `I've asked you to decide the escrow for ${snap.view.domain}: ${reason.length > 1200 ? `${reason.slice(0, 1200)}… (the rest is in my view of the escrow)` : reason}`,
          asked && `I asked the seller to transfer it to ${asked.registrar ? `${asked.registrar}, ` : ""}account ${asked.account}.`,
          told && `I sent it ${told.card.method === "code" ? "with a transfer code" : "as a move to the buyer's account"}, ${stamp(told.at)}.`
        ].filter(Boolean).join(`
`));
        switchChat("arbiter");
        refresh();
        return true;
      }
      case "cancel": {
        as("seller");
        if (!$("#cn-ack").checked)
          throw new Error("Tick the box to confirm the refund.");
        const reason = $("#cn-reason").value.trim() || "the seller cancelled";
        const found = proposal(snap, "refund", "A");
        const refund = found && !found.complete ? found : undefined;
        if (refund && !await confirmPayout("Refund the buyer", {
          value: snap.funding.value,
          fee: refund.settlement.fee,
          dest: refund.settlement.dest,
          note: "The buyer's own address. You won't be paid for this trade."
        }))
          return;
        if ((await freshRecord(snap)).buyer.received)
          throw new Error("The buyer has just confirmed the domain arrived, which pays you. Nothing was cancelled. Refresh to see it.");
        const mine = refund ? cosign(snap, refund) : undefined;
        if (!refund || !mine) {
          const reach = await publishMine(snap, { claims: { cancelled: { at: now(), reason } } });
          log((found?.complete ? "Recorded. The refund is signed by both: broadcast it above." : "Recorded. The buyer is refunded once they sign their refund.") + reach, "good");
          tell(snap, "buyer", `I've cancelled the sale: ${reason}.${found ? "" : " Sign your refund on the escrow page to get the money back."}`);
          refresh();
          return true;
        }
        const recorded = await publishMine(snap, { claims: { cancelled: { at: now(), reason } }, sigs: [mine] }).then(() => true, () => false);
        const sent = await completeAndSend(snap, refund, mine, out);
        if (sent && !recorded)
          log("No relay accepted your update, but the refund is what counts.", "", true);
        tell(snap, "buyer", `I've cancelled the sale: ${reason}.${sent ? " Your refund is sent." : ""}`);
        refresh();
        return sent;
      }
      case "ask-refund": {
        as("buyer");
        const v = snap.verdict;
        const why = claimsOf(snap).seller.cancelled ? "The seller cancelled the sale" : `The transfer deadline passed${v ? ` at block ${v.deadlines.deliverBy}` : ""} without the seller saying the domain was sent`;
        note(out, "Sending it to the arbiter…");
        await sendTo(snap, "arbiter", `${why}, so the rules refund me. My refund is signed on the escrow page for ${snap.view.domain}: please complete it.`);
        log("Asked the arbiter, in your private chat with it, to complete your refund.", "good");
        switchChat("arbiter");
        return true;
      }
      case "cosign-refund": {
        as("seller");
        const found = proposal(snap, "refund", "A");
        if (!found || found.complete)
          throw new Error(found ? "The refund is signed by you both: broadcast it from the box above." : "The buyer hasn't signed a refund yet.");
        if (!await confirmPayout("Refund the buyer", {
          value: snap.funding.value,
          fee: found.settlement.fee,
          dest: found.settlement.dest,
          note: "The buyer's own address. You cancelled this sale."
        }))
          return;
        const mine = cosign(snap, found);
        const recorded = await publishMine(snap, { sigs: [mine] }).then(() => true, () => false);
        const sent = await completeAndSend(snap, found, mine, out);
        if (sent && !recorded)
          log("No relay accepted your update, but the refund is what counts.", "", true);
        if (sent)
          tell(snap, "buyer", "Your refund is sent.");
        refresh();
        return sent;
      }
      case "ask-buyer":
      case "ask-seller": {
        as("arbiter");
        const side = name === "ask-buyer" ? "buyer" : "seller";
        const text = $(`#ev-${side}`).value.trim();
        if (!text)
          throw new Error("Write the request first.");
        note(out, `Sending it to the ${side}…`);
        await sendTo(snap, side, text);
        log(`Asked the ${side} for proof, in your private chat with them. Their answer shows in your ${ROLE_NAME[side]} chat.`, "good");
        switchChat(side);
        note(out, "");
        return;
      }
      case "registry-refresh": {
        as("arbiter");
        registryCache.delete(snap.view.domain);
        registryFailed.delete(snap.view.domain);
        return;
      }
      case "rule-release":
      case "rule-refund": {
        as("arbiter");
        const decision = name === "rule-release" ? "release" : "refund";
        const v = snap.verdict;
        const reason = (document.querySelector("#ar-reason")?.value ?? "").trim();
        if (!reason)
          throw new Error("A ruling is published with its reason. Write one.");
        if (v?.action !== decision && v?.action !== "decide" && !document.querySelector(`#ar-override-${v?.action ?? "none"}`)?.checked) {
          throw new Error(v?.action === "wait" || !v ? "The rules don't call for a payout yet. Tick the box to rule anyway." : `The rules say ${v.action}. Tick the box to rule otherwise.`);
        }
        if (snap.relaysAnswered < ESCROW_RELAYS.length && !document.querySelector("#ar-partial")?.checked) {
          throw new Error(`Only ${snap.relaysAnswered} of ${ESCROW_RELAYS.length} relays answered, so a claim may be missing. Refresh, or tick the box to rule on this record anyway.`);
        }
        const entry = proposal(snap, decision, decision === "release" ? "B" : "C");
        if (!entry)
          throw new Error(`The ${decision === "release" ? "seller" : "buyer"} hasn't signed a payout to complete.`);
        if (!await confirmPayout(decision === "release" ? "Release to the seller" : "Refund the buyer", {
          value: snap.funding.value,
          fee: entry.settlement.fee,
          dest: entry.settlement.dest,
          note: `The ${decision === "release" ? "seller" : "buyer"}'s own address. The ruling is published with your reason.`
        }))
          return;
        note(out, "Reading the record again before signing…");
        const now_ = await freshRecord(snap);
        if (now_.ruled && !snap.ruling)
          throw new Error("A ruling on this escrow is out already. Refresh, and look at it first.");
        if (v && snap.funding && snap.tip !== undefined) {
          const again = arbiterRule({
            rules: { timeoutBlocks: snap.view.timeoutBlocks, deliverBlocks: snap.view.deliverBlocks },
            fundingHeight: snap.funding.height,
            tip: snap.tip,
            seller: { sent: !!now_.seller.sent, cancelled: !!now_.seller.cancelled, disputed: !!now_.seller.disputed },
            buyer: { received: !!now_.buyer.received, disputed: !!now_.buyer.disputed }
          });
          if (again.action !== v.action) {
            throw new Error(`The record changed since this page drew it: ${again.reason}. Nothing was signed. Refresh, and rule on the new record.`);
          }
        }
        if (!await arbiterPayout(snap, decision, reason, entry, out))
          return false;
        const said = `I ruled: ${decision === "release" ? "release to the seller" : "refund the buyer"}. ${reason}`;
        tell(snap, "buyer", said);
        tell(snap, "seller", said);
        refresh();
        return true;
      }
      case "republish": {
        as("arbiter");
        for (const p of [...state.pending.values()].filter((p) => p.escrowId === snap.id)) {
          const results = await publishToRelays(ESCROW_RELAYS, p.event);
          if (results.filter((r) => r.ok).length * 2 >= results.length)
            state.pending.delete(p.event.id);
        }
        const left = [...state.pending.values()].filter((p) => p.escrowId === snap.id);
        if (left.length)
          throw new Error(`Too few relays took ${left.map((p) => p.what).join(" and ")} this time either. Try again in a minute.`);
        log("Published.", "good");
        refresh();
        return true;
      }
    }
  });
}
function useKey() {
  const snap = state.snap;
  const hint = $("#me-hint");
  if (!snap)
    return;
  const text = $("#me-in").value.trim();
  const recovery = decodeRecovery(text);
  if (recovery.ok) {
    let rebuilt;
    try {
      rebuilt = rebuildFromRecovery(recovery.recovery);
    } catch (err) {
      fail(hint, err.message);
      return;
    }
    if (rebuilt.tree.addresses[snap.view.network] !== snap.view.address) {
      fail(hint, "That recovery string is for a different escrow.");
      return;
    }
    state.me = { role: rebuilt.role, secret: recovery.recovery.secretKey };
    keepMe(snap.id, state.me);
    backUpPasted(snap.id, text, state.me, snap.view);
    render(snap);
    refreshWanted();
    return;
  }
  if (/^fmdrec/i.test(text)) {
    fail(hint, `That recovery string doesn't read: ${recovery.reason}.`);
    return;
  }
  const decoded = tryDecodeNip19(text);
  const secret = decoded?.type === "nsec" ? decoded.data : /^[0-9a-f]{64}$/.test(text) ? bytesOf(text) : undefined;
  if (!secret) {
    fail(hint, "That is neither a recovery string nor a key.");
    return;
  }
  let pubkey;
  try {
    pubkey = escrowPublicKeyHex(secret);
  } catch {
    fail(hint, "That key is not valid.");
    return;
  }
  if (pubkey !== snap.view.arbiter) {
    fail(hint, "That key is not this escrow's arbiter.");
    return;
  }
  state.me = { role: "arbiter", secret };
  render(snap);
  refreshWanted();
}
async function listForArbiter() {
  const arbiter = siteArbiters()[0];
  $("#arbiter-section").hidden = false;
  $("#open-section").hidden = true;
  const list = $("#arbiter-list");
  if (!arbiter) {
    list.innerHTML = row("bad", "This site names no arbiter in config.js.");
    return;
  }
  list.innerHTML = row("", "Reading the relays…");
  const events = await queryRelays(ESCROW_RELAYS, [
    { ...escrowsForFilter([arbiter]), limit: 500 },
    { kinds: [ESCROW_KIND], authors: [arbiter], limit: 500 }
  ], { timeoutMs: 8000 }).catch(() => []);
  const byId = new Map;
  const rulings = new Map;
  for (const e of events) {
    if (e.pubkey === arbiter) {
      const r = parseRuling(e);
      if (r.ok && (rulings.get(r.ruling.id)?.publishedAt ?? -1) < r.ruling.publishedAt)
        rulings.set(r.ruling.id, r.ruling);
      continue;
    }
    let r;
    try {
      r = parseEscrowEvent(e);
    } catch {
      continue;
    }
    if (!r.ok || r.view.arbiter !== arbiter)
      continue;
    byId.set(r.view.id, [...byId.get(r.view.id) ?? [], r.view]);
  }
  const rows = [...byId.entries()].map(([id, views]) => {
    const c = compareViews(views, id);
    const latest = Math.max(...c.participants.map((v) => v.publishedAt), 0);
    return { id, c, latest };
  }).filter((r) => r.c.participants.length).sort((a, b) => b.latest - a.latest);
  $("#arbiter-sub").textContent = `${rows.length} escrow(s) name this site's arbiter on the relays asked.`;
  const perDomain = new Map;
  for (const { c } of rows) {
    const domain = (c.buyerView ?? c.sellerView).domain;
    perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
  }
  list.innerHTML = rows.length ? rows.map(({ id, c }) => {
    const v = c.buyerView ?? c.sellerView;
    const s = c.sellerView?.claims ?? {};
    const b = c.buyerView?.claims ?? {};
    const ruling = rulings.get(id);
    const disputed = !ruling && !b.received && !s.cancelled && (b.disputed || s.disputed);
    const status = ruling ? `ruled: ${ruling.decision === "release" ? "released to the seller" : "refunded the buyer"}` : b.received ? "the buyer confirmed it arrived" : s.cancelled ? "the seller cancelled" : disputed ? `the ${b.disputed && s.disputed ? "buyer and the seller" : b.disputed ? "buyer" : "seller"} asked you to decide` : s.sent ? "the seller says sent; waiting for the buyer" : "no claims yet";
    const href = `?id=${id}&k=${v.buyer},${v.seller},${arbiter}`;
    const shared = (perDomain.get(v.domain) ?? 0) > 1 ? ` · <b>${perDomain.get(v.domain)} escrows name this domain</b>` : "";
    return row(disputed ? "bad" : "", `<a href="${esc(href)}"><b>${esc(v.domain)}</b></a> · ${sats(v.amountSats)} sats · ${esc(status)}${shared} · <code>${esc(id.slice(0, 12))}…</code>`);
  }).join("") : row("", "None yet.");
}
function saveRecord() {
  const snap = state.snap;
  if (!snap) {
    toast("Nothing has been read yet.");
    return;
  }
  const events = [
    snap.buyerView?.event,
    snap.sellerView?.event,
    snap.ruling?.event
  ].filter((e) => e !== undefined);
  const record = {
    escrow: snap.id,
    saved_at: now(),
    about: "Signed Nostr events: each party's view of this escrow, with its claims and payout signatures, and the " + "arbiter's ruling. Each verifies on its own; spec/PROTOCOL.md says how to read them. The private chats are not in it.",
    address: snap.view.address,
    funding: snap.funding?.outpoint ?? null,
    settlement: snap.settled?.output.spentBy?.txid ?? null,
    events
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `escrow-${snap.id.slice(0, 16)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
initTheme();
initConnect();
paintNetwork();
function step(n) {
  document.querySelectorAll(".step").forEach((el) => {
    const i = Number(el.dataset.step);
    el.classList.toggle("on", i === n);
    if (i < n)
      el.classList.add("done");
    else
      el.classList.remove("done");
  });
  $("#steps").classList.toggle("locked", !!state.draft?.invite);
}
$("#steps").addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (!go || state.draft?.invite)
    return;
  const n = Number(go.dataset.goto);
  step(n);
  $(`.step[data-step="${n}"]`).scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("#terms-form").addEventListener("submit", checkTerms);
$("#invite-btn").addEventListener("click", createInvite);
$("#reply-btn").addEventListener("click", useReply);
$("#join-btn").addEventListener("click", acceptInvite);
$("#publish-escrow").addEventListener("click", publishEscrow);
$("#resume-form").addEventListener("submit", (e) => {
  e.preventDefault();
  resume();
});
$("#refresh").addEventListener("click", refreshWanted);
$("#save-record").addEventListener("click", saveRecord);
$("#inbox-btn").addEventListener("click", () => void checkInbox());
$("#saved-recovery").addEventListener("change", (e) => {
  state.saved = e.target.checked || !!state.backedUp && BACKUP_IS_ENOUGH;
  $("#publish-escrow").disabled = !(state.saved && state.draft?.realised);
});
$("#mine-btn").addEventListener("click", () => void findMine());
let listsFor = null;
function clearAccountLists() {
  mineBackups.clear();
  mineDrafts.clear();
  inboxShown = [];
  $("#mine-out").innerHTML = "";
  note($("#mine-hint"), "");
  $("#inbox-out").innerHTML = "";
  $("#inbox-alert").innerHTML = "";
  $("#inbox-alert").hidden = true;
  inboxRead = false;
  note($("#inbox-hint"), "");
}
const plainVisit = () => {
  const p = new URL(location.href).searchParams;
  return !p.get("join") && !p.get("id") && !p.has("arbiter") && !p.has("domain");
};
onSessionChange((pubkey, restored) => {
  if (listsFor !== pubkey) {
    clearAccountLists();
    listsFor = pubkey;
  }
  if (pubkey) {
    if (state.snap)
      render(state.snap);
    if (!restored && session.kind === "local" && plainVisit() && !state.draft) {
      if (!$("#inbox-box").hidden)
        checkInbox();
      if (!$("#resume-box").hidden)
        findMine(true);
    }
    return;
  }
  if (!state.me)
    return;
  state.me = null;
  if (state.snap)
    render(state.snap);
});
$("#inbox-out").addEventListener("click", (e) => {
  const open = e.target.closest("[data-mine]");
  if (open?.dataset.mine)
    openBackup(open.dataset.mine);
});
$("#mine-out").addEventListener("click", (e) => {
  const open = e.target.closest("[data-mine]");
  if (open?.dataset.mine) {
    openBackup(open.dataset.mine);
    return;
  }
  const draft = e.target.closest("[data-draft]");
  if (draft?.dataset.draft)
    continueDraft(draft.dataset.draft);
});
window.addEventListener("beforeunload", (e) => {
  const safe = state.published || state.saved || state.inviteSaved && !state.draft?.realised;
  if (state.draft?.mySecret && !safe) {
    e.preventDefault();
    e.returnValue = "";
  }
});
setInterval(() => {
  if (document.visibilityState === "visible")
    refreshWanted();
}, 2 * 60 * 1000);
$("#copy-recovery").addEventListener("click", () => copyToClipboard($("#recovery").textContent));
$("#download-recovery").addEventListener("click", downloadRecovery);
$("#arbiters").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-arbiter]");
  if (btn?.dataset.arbiter)
    chooseArbiter(btn.dataset.arbiter);
});
async function pollChain() {
  const snap = state.snap;
  if (!snap || state.watching !== snap.id || snap.chainError || state.chainPolling || state.watchBusy || state.acting)
    return;
  if (document.visibilityState !== "visible")
    return;
  state.chainPolling = true;
  try {
    const changed = snap.funding || snap.settled ? await chain.tipHeight() !== snap.tip : chainSigOf(await chain.utxos(snap.view.address)) !== snap.chainSig;
    if (changed && state.snap === snap)
      refreshWanted();
  } catch {} finally {
    state.chainPolling = false;
  }
}
setInterval(() => void pollChain(), 20 * 1000);
setInterval(() => {
  if (state.me && state.watching && state.me.role !== "arbiter")
    keepMe(state.watching, state.me);
}, 10 * 60 * 1000);
setInterval(() => {
  if (Date.now() - (state.lastRead ?? 0) > 10 * 1000)
    pollChat();
}, 20 * 1000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.watching && Date.now() - (state.lastRead ?? 0) > 15 * 1000)
    refreshWanted();
});
$("#escrow").addEventListener("click", (e) => {
  const target = e.target;
  const copy = target.closest("[data-copy]");
  if (copy) {
    copyToClipboard(document.querySelector(copy.dataset.copy)?.textContent ?? "");
    return;
  }
  const text = target.closest("[data-copy-text]");
  if (text)
    copyToClipboard(text.dataset.copyText ?? "", `Copied ${text.dataset.copyText ?? ""}.`);
});
$("#chat-view").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-chat]");
  if (tab?.dataset.chat)
    switchChat(tab.dataset.chat);
});
$("#chat-view").addEventListener("submit", (e) => {
  if (e.target.id !== "chat-form")
    return;
  e.preventDefault();
  sendChat();
});
$("#chat-view").addEventListener("keydown", (e) => {
  const target = e.target;
  if (target.id !== "chat-text" || e.key !== "Enter" || e.shiftKey || e.isComposing)
    return;
  e.preventDefault();
  sendChat();
});
$("#chat-view").addEventListener("input", (e) => {
  if (e.target.id !== "chat-text")
    return;
  countChat();
  const hint = document.getElementById("chat-hint");
  if (hint && hint.className)
    chatNote(CHAT_HINT);
});
for (const type of ["input", "change"]) {
  $("#act-view").addEventListener(type, (e) => {
    const target = e.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
      target.dataset.edited = "1";
    if (target instanceof HTMLInputElement && target.id === "ts-code-text" && target.value.trim()) {
      const code = document.querySelector("#ts-code");
      if (code && !code.checked) {
        code.checked = true;
        code.dataset.edited = "1";
      }
    }
  });
}
$("#act-view").addEventListener("submit", (e) => {
  if (e.target.id !== "me-form")
    return;
  e.preventDefault();
  useKey();
});
$("#act-view").addEventListener("click", (e) => {
  const target = e.target;
  if (target.closest("#me-backup") && state.snap) {
    openFromBackup(state.snap.id, false);
    return;
  }
  if (target.closest("#me-download")) {
    downloadMyRecovery();
    return;
  }
  const listingSold = target.closest("#listing-sold");
  if (listingSold) {
    markListingSold(listingSold);
    return;
  }
  if (target.closest("#me-forget")) {
    if (state.snap)
      forgetMe(state.snap.id);
    state.me = null;
    if (state.snap)
      render(state.snap);
    return;
  }
  const broadcast = target.closest("[data-broadcast]");
  if (broadcast && state.snap) {
    const snap = state.snap;
    const entry = snap.board.find((b) => settlementKey(b.settlement) === broadcast.dataset.broadcast && b.complete);
    if (entry)
      act(broadcast, (out) => broadcastEntry(snap, entry, out));
    return;
  }
  const action = target.closest("[data-act]");
  if (action)
    onAct(action.dataset.act, action);
});
{
  const q = new URL(location.href).searchParams;
  const domain = q.get("domain");
  if (domain) {
    $("#e-domain").value = domain;
    const amount = q.get("amount");
    if (amount && /^\d+$/.test(amount))
      $("#e-amount").value = amount;
    const seller = q.get("seller");
    if (seller)
      $("#e-counterparty").value = seller;
    $("#e-side").value = "buyer";
    note($("#terms-hint"), "Filled in from the listing. Check the price, then check the terms.");
  }
}
const params = new URL(location.href).searchParams;
const joinCode = params.get("join");
const wanted = params.get("id");
if (joinCode)
  openInvite(joinCode);
else if (wanted && /^[0-9a-f]{64}$/.test(wanted)) {
  $("#open-section").hidden = true;
  state.me = keptMe(wanted);
  watch(wanted);
  if (!state.me)
    sessionReady().then(() => {
      if (session.kind === "local")
        openFromBackup(wanted, true);
    });
} else if (params.has("arbiter"))
  listForArbiter();
else if (!params.has("domain")) {
  sessionReady().then(() => {
    if (session.kind !== "local" || state.draft)
      return;
    if (!$("#inbox-box").hidden)
      checkInbox();
    if (!$("#resume-box").hidden)
      findMine(true);
  });
}
