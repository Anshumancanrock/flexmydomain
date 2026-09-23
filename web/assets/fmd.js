// core/oracle/punycode.ts
var BASE = 36;
var TMIN = 1;
var TMAX = 26;
var SKEW = 38;
var DAMP = 700;
var INITIAL_BIAS = 72;
var INITIAL_N = 128;
var DELIMITER = "-";
var ACE_PREFIX = "xn--";
var MAX_CODE_POINT = 1114111;
function digitToBasic(digit) {
  return String.fromCharCode(digit < 26 ? digit + 97 : digit - 26 + 48);
}
function basicToDigit(code) {
  if (code >= 48 && code <= 57)
    return code - 48 + 26;
  if (code >= 97 && code <= 122)
    return code - 97;
  if (code >= 65 && code <= 90)
    return code - 65;
  return BASE;
}
function adapt(delta, numPoints, firstTime) {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > (BASE - TMIN) * TMAX >> 1) {
    d = Math.floor(d / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor((BASE - TMIN + 1) * d / (d + SKEW));
}
function encodeLabel(label) {
  const input = Array.from(label, (c) => c.codePointAt(0));
  const output = [];
  for (const cp of input)
    if (cp < 128)
      output.push(String.fromCharCode(cp));
  const basicLength = output.length;
  let handled = basicLength;
  if (basicLength > 0)
    output.push(DELIMITER);
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (handled < input.length) {
    let m = MAX_CODE_POINT + 1;
    for (const cp of input)
      if (cp >= n && cp < m)
        m = cp;
    if (m - n > Math.floor((2147483647 - delta) / (handled + 1))) {
      throw new Error("punycode: overflow while encoding");
    }
    delta += (m - n) * (handled + 1);
    n = m;
    for (const cp of input) {
      if (cp < n && ++delta > 2147483647)
        throw new Error("punycode: overflow while encoding");
      if (cp !== n)
        continue;
      let q = delta;
      for (let k = BASE;; k += BASE) {
        const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
        if (q < t)
          break;
        output.push(digitToBasic(t + (q - t) % (BASE - t)));
        q = Math.floor((q - t) / (BASE - t));
      }
      output.push(digitToBasic(q));
      bias = adapt(delta, handled + 1, handled === basicLength);
      delta = 0;
      handled++;
    }
    delta++;
    n++;
  }
  return output.join("");
}
function decodeLabel(label) {
  const output = [];
  const delimiterIndex = label.lastIndexOf(DELIMITER);
  let index = 0;
  if (delimiterIndex > 0) {
    for (let i2 = 0;i2 < delimiterIndex; i2++) {
      const code = label.charCodeAt(i2);
      if (code >= 128)
        throw new Error("punycode: non-ASCII byte in the basic section");
      output.push(code);
    }
    index = delimiterIndex + 1;
  }
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  while (index < label.length) {
    const oldi = i;
    for (let w = 1, k = BASE;; k += BASE) {
      if (index >= label.length)
        throw new Error("punycode: truncated encoding");
      const digit = basicToDigit(label.charCodeAt(index++));
      if (digit >= BASE)
        throw new Error("punycode: invalid digit");
      if (digit > Math.floor((2147483647 - i) / w))
        throw new Error("punycode: overflow");
      i += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t)
        break;
      if (w > Math.floor(2147483647 / (BASE - t)))
        throw new Error("punycode: overflow");
      w *= BASE - t;
    }
    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    if (Math.floor(i / out) > 2147483647 - n)
      throw new Error("punycode: overflow");
    n += Math.floor(i / out);
    i %= out;
    if (n > MAX_CODE_POINT || n >= 55296 && n <= 57343) {
      throw new Error("punycode: decoded an invalid code point");
    }
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}
function labelToASCII(label) {
  if (!/[^\x00-\x7f]/.test(label)) {
    if (label.toLowerCase().startsWith(ACE_PREFIX))
      assertValidALabel(label.toLowerCase());
    return label;
  }
  return ACE_PREFIX + encodeLabel(label);
}
function assertValidALabel(label) {
  const body = label.slice(ACE_PREFIX.length);
  if (body === "")
    throw new Error(`punycode: "${label}" is the bare ACE prefix with no payload`);
  let decoded;
  try {
    decoded = decodeLabel(body);
  } catch (err) {
    throw new Error(`punycode: "${label}" is not a valid A-label: ${err.message}`);
  }
  if (ACE_PREFIX + encodeLabel(decoded) !== label) {
    throw new Error(`punycode: "${label}" is not the canonical encoding of "${decoded}"`);
  }
  if (!/[^\x00-\x7f]/.test(decoded)) {
    throw new Error(`punycode: "${label}" decodes to the ASCII label "${decoded}", which must not be encoded`);
  }
}
function toASCII(name) {
  return name.split(".").map(labelToASCII).join(".");
}
function toUnicode(name) {
  return name.split(".").map((l) => l.toLowerCase().startsWith(ACE_PREFIX) ? tryDecode(l) : l).join(".");
}
function tryDecode(label) {
  try {
    return decodeLabel(label.slice(ACE_PREFIX.length));
  } catch {
    return label;
  }
}
// core/oracle/domain.ts
var MAX_DOMAIN_LENGTH = 253;
var MAX_LABEL_LENGTH = 63;
var LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
var TLD_RE = /^[a-z]{2,24}$/;
var SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
var PORT_RE = /:\d{1,5}$/;
function tryNormaliseDomain(raw) {
  if (typeof raw !== "string") {
    return { ok: false, reason: "expected a string" };
  }
  let v = raw.trim();
  if (v === "")
    return { ok: false, reason: "empty" };
  if (/\s/.test(v))
    return { ok: false, reason: "contains whitespace" };
  v = v.replace(SCHEME_RE, "");
  v = v.replace(/^\/\//, "");
  v = v.split(/[/?#]/, 1)[0];
  const at = v.lastIndexOf("@");
  if (at !== -1)
    v = v.slice(at + 1);
  if (v.startsWith("["))
    return { ok: false, reason: "an IPv6 literal is not a domain" };
  v = v.replace(PORT_RE, "");
  if (v === "")
    return { ok: false, reason: "no host part" };
  v = v.toLowerCase();
  if (v.endsWith("."))
    v = v.slice(0, -1);
  while (v.startsWith("www.") && v.split(".").length > 2)
    v = v.slice(4);
  if (v === "")
    return { ok: false, reason: "empty after normalisation" };
  if (v.includes(".."))
    return { ok: false, reason: "empty label" };
  try {
    v = toASCII(v);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const labels = v.split(".");
  if (labels.length < 2) {
    return { ok: false, reason: `"${v}" is a single label, not a domain` };
  }
  if (v.length > MAX_DOMAIN_LENGTH) {
    return { ok: false, reason: `${v.length} characters exceeds the ${MAX_DOMAIN_LENGTH} limit` };
  }
  for (const label of labels) {
    if (label.length > MAX_LABEL_LENGTH) {
      return { ok: false, reason: `label "${label}" exceeds ${MAX_LABEL_LENGTH} characters` };
    }
    if (!LABEL_RE.test(label)) {
      return { ok: false, reason: `label "${label}" is not a valid hostname label` };
    }
  }
  const tld = labels[labels.length - 1];
  if (!TLD_RE.test(tld)) {
    return { ok: false, reason: `"${tld}" is not a supported top-level domain` };
  }
  return { ok: true, domain: v, unicode: toUnicode(v) };
}
function normaliseDomain(raw) {
  const r = tryNormaliseDomain(raw);
  if (!r.ok) {
    const shown = typeof raw === "string" ? JSON.stringify(raw) : Object.prototype.toString.call(raw);
    throw new Error(`normaliseDomain: ${shown} is not a domain: ${r.reason}`);
  }
  return r.domain;
}
function isNormalisedDomain(value) {
  const r = tryNormaliseDomain(value);
  return r.ok && r.domain === value;
}
function tldOf(domain) {
  const d = normaliseDomain(domain);
  return d.slice(d.lastIndexOf(".") + 1);
}
function splitDomain(domain) {
  const d = normaliseDomain(domain);
  const i = d.lastIndexOf(".");
  return [d.slice(0, i), d.slice(i + 1)];
}
var PROOF_LABEL = "_flexmydomain";
function proofRecordName(domain) {
  return `${PROOF_LABEL}.${normaliseDomain(domain)}`;
}
function nip05Url(domain, name = "_") {
  return `https://${normaliseDomain(domain)}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
}
// node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === undefined || value.length === length))
    return value;
  if (length !== undefined)
    anumber(length, "length");
  const bytes = isBytes(value);
  const ofLen = length !== undefined ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new TypeError("expected hash wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
  if (h.outputLen < 1 || h.blockLen < 1)
    throw new Error("hash blockLen / outputLen must be >= 1");
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, undefined, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0;i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function")();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0;i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}
function asciiToBase16(ch) {
  return ch >= 48 && ch <= 57 ? ch - 48 : ch >= 65 && ch <= 70 ? ch - (65 - 10) : ch >= 97 && ch <= 102 ? ch - (97 - 10) : undefined;
}
function hexToBytes(hex) {
  if (typeof hex !== "string")
    throw new TypeError("hex string expected, got " + typeof hex);
  if (hasHexBuiltin) {
    try {
      return Uint8Array.fromHex(hex);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new RangeError(error.message);
      throw error;
    }
  }
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new RangeError("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0;ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === undefined || n2 === undefined) {
      const char = hex[hi] + hex[hi + 1];
      throw new RangeError('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new TypeError("string expected");
  const encoded = new TextEncoder().encode(str);
  try {
    return new Uint8Array(encoded);
  } finally {
    clean(encoded);
  }
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0;i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0;i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== undefined)
    aopts(opts, title);
  const merged = Object.assign(Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(undefined);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
function randomBytes(bytesLength = 32) {
  anumber(bytesLength, "bytesLength");
  const cr = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues !== "function")
    throw new Error("crypto.getRandomValues must be defined");
  if (bytesLength > 65536)
    throw new RangeError(`"bytesLength" expected <= 65536, got ${bytesLength}`);
  return cr.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist = (suffix) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// node_modules/@noble/hashes/_u64.js
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h, isLE);
  view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}

// node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}

class HashMD {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0;pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (;blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0;i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
}
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);

class SHA2_32B extends HashMD {
  A = 0;
  B = 0;
  C = 0;
  D = 0;
  E = 0;
  F = 0;
  G = 0;
  H = 0;
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0;i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16;i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0;i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
}

class _SHA256 extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
}
var sha256 = /* @__PURE__ */ createHasher(() => new _SHA256, /* @__PURE__ */ oidNist(1));

// node_modules/@noble/curves/utils.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function aarray(item, title, inner = () => {}) {
  if (!Array.isArray(item))
    throw new TypeError(`"${title}" expected array, got type=${typeof item}`);
  for (let i = 0;i < item.length; i++)
    inner(item[i], `${title}[${i}]`);
  return item;
}
var abytes2 = (value, length, title) => abytes(value, length, title);
var anumber2 = anumber;
function astring(value, title = "") {
  if (typeof value !== "string") {
    const prefix = title && `"${title}" `;
    throw new TypeError(prefix + "expected string, got type=" + typeof value);
  }
  return value;
}
function aobject2(value, title = "object") {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(title === "object" ? "expected valid options object" : `"${title}" expected object, got type=${typeof value}`);
  return value;
}
function afunction(value, title) {
  if (typeof value !== "function")
    throw new TypeError(`"${title}" is invalid: expected function, got ${typeof value}`);
  return value;
}
var bytesToHex2 = bytesToHex;
var concatBytes2 = (...arrays) => concatBytes(...arrays);
var hexToBytes2 = (hex) => hexToBytes(hex);
var isBytes2 = isBytes;
var randomBytes2 = (bytesLength) => randomBytes(bytesLength);
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
var atitle2 = (title) => title ? `"${title}" ` : "";
function abool(value, title = "") {
  if (typeof value !== "boolean")
    throw new TypeError(atitle2(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function abignumber(n) {
  if (typeof n === "bigint") {
    if (!isPosBig(n))
      throw new RangeError("positive bigint expected, got " + n);
  } else
    anumber2(n);
  return n;
}
function asafenumber(value, title = "") {
  if (typeof value !== "number") {
    const prefix = title && `"${title}" `;
    throw new TypeError(prefix + "expected number, got type=" + typeof value);
  }
  if (!Number.isSafeInteger(value)) {
    const prefix = title && `"${title}" `;
    throw new RangeError(prefix + "expected safe integer, got " + value);
  }
}
function numberToHexUnpadded(num) {
  const hex = abignumber(num).toString(16);
  return hex.length & 1 ? "0" + hex : hex;
}
function hexToNumber(hex) {
  if (typeof hex !== "string")
    throw new TypeError("hex string expected, got " + typeof hex);
  return hex === "" ? _0n : BigInt("0x" + hex);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  return hexToNumber(bytesToHex(copyBytes(abytes(bytes)).reverse()));
}
function numberToBytesBE(n, len) {
  anumber(len);
  if (len === 0)
    throw new Error("zero output length is invalid");
  n = abignumber(n);
  const expectedLen = len * 2;
  const hex = n.toString(16);
  if (hex.length > expectedLen)
    throw new RangeError("number is too large");
  return hexToBytes(hex.padStart(expectedLen, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function copyBytes(bytes) {
  return Uint8Array.from(abytes2(bytes));
}
function asciiToBytes(ascii) {
  if (typeof ascii !== "string")
    throw new TypeError("ascii string expected, got " + typeof ascii);
  return Uint8Array.from(ascii, (c, i) => {
    const charCode = c.charCodeAt(0);
    if (c.length !== 1 || charCode > 127) {
      throw new RangeError(`string contains non-ASCII character "${ascii[i]}" with code ${charCode} at position ${i}`);
    }
    return charCode;
  });
}
function isPosBig(n) {
  return typeof n === "bigint" && _0n <= n;
}
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new RangeError("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  if (n < _0n)
    throw new Error("expected non-negative bigint, got " + n);
  return n === _0n ? 0 : n.toString(2).length;
}
var bitMask = (n) => {
  asafenumber(n, "n");
  return (_1n << BigInt(n)) - _1n;
};
function createHmacDrbg(hashLen, qByteLen, hmacFn) {
  anumber(hashLen, "hashLen");
  anumber(qByteLen, "qByteLen");
  if (typeof hmacFn !== "function")
    throw new TypeError("hmacFn must be a function");
  const u8n = (len) => new Uint8Array(len);
  const NULL = Uint8Array.of();
  const byte0 = Uint8Array.of(0);
  const byte1 = Uint8Array.of(1);
  const _maxDrbgIters = 1000;
  let v = u8n(hashLen);
  let k = u8n(hashLen);
  let i = 0;
  const reset = () => {
    v.fill(1);
    k.fill(0);
    i = 0;
  };
  const h = (...msgs) => hmacFn(k, concatBytes2(v, ...msgs));
  const reseed = (seed = NULL) => {
    k = h(byte0, seed);
    v = h();
    if (seed.length === 0)
      return;
    k = h(byte1, seed);
    v = h();
  };
  const gen = () => {
    if (i++ >= _maxDrbgIters)
      throw new Error("drbg: tried max amount of iterations");
    let len = 0;
    const out = [];
    while (len < qByteLen) {
      v = h();
      const sl = v.slice();
      out.push(sl);
      len += v.length;
    }
    return concatBytes2(...out);
  };
  const genUntil = (seed, pred) => {
    reset();
    reseed(seed);
    let res = undefined;
    while ((res = pred(gen())) === undefined)
      reseed();
    reset();
    return res;
  };
  return genUntil;
}
function validateObject(object, fields = {}, optFields = {}, title = "object") {
  aobject2(object, title);
  aobject2(fields, "fields");
  aobject2(optFields, "optFields");
  function checkField(fieldName, expectedType, isOpt) {
    const label = title === "object" ? `param "${String(fieldName)}"` : `"${title}.${String(fieldName)}"`;
    const val = object[fieldName];
    if (!Object.hasOwn(object, fieldName) && (isOpt ? val !== undefined : expectedType !== "function")) {
      throw new TypeError(`${label} is invalid: expected own property`);
    }
    if (isOpt && val === undefined)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new TypeError(`${label} is invalid: expected ${expectedType}, got ${current}`);
  }
  const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
  iter(fields, false);
  iter(optFields, true);
}

// node_modules/@noble/curves/abstract/modular.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n2 = /* @__PURE__ */ BigInt(0);
var _1n2 = /* @__PURE__ */ BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _7n = /* @__PURE__ */ BigInt(7);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _15n = /* @__PURE__ */ BigInt(15);
var _16n = /* @__PURE__ */ BigInt(16);
var POW_WINDOWED_MIN = /* @__PURE__ */ BigInt("0x10000000000000000");
function mod(a, b) {
  if (b <= _0n2)
    throw new Error("mod: expected positive modulus, got " + b);
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow(num, power, modulo) {
  if (modulo <= _1n2)
    throw new Error("pow: expected modulus > 1, got " + modulo);
  if (typeof power !== "bigint")
    throw new TypeError("invalid exponent: expected bigint, got " + typeof power);
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return _1n2;
  if (power === _1n2)
    return num;
  let d = num % modulo;
  if (d < _0n2)
    d += modulo;
  if (power < POW_WINDOWED_MIN) {
    let p2 = _1n2;
    while (power > _0n2) {
      if (power & _1n2)
        p2 = p2 * d % modulo;
      d = d * d % modulo;
      power >>= _1n2;
    }
    return p2;
  }
  const digits = [];
  while (power > _0n2) {
    digits.push(Number(power & _15n));
    power >>= _4n;
  }
  const table = new Array(16);
  table[0] = _1n2;
  table[1] = d;
  for (let i = 2;i < 16; i++)
    table[i] = table[i - 1] * d % modulo;
  let p = table[digits[digits.length - 1]];
  for (let w = digits.length - 2;w >= 0; w--) {
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    const digit = digits[w];
    if (digit !== 0)
      p = p * table[digit] % modulo;
  }
  return p;
}
function pow2(x, power, modulo) {
  if (modulo <= _1n2)
    throw new Error("pow2: expected modulus > 1, got " + modulo);
  if (power < _0n2)
    throw new Error("pow2: expected non-negative exponent, got " + power);
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _1n2)
    throw new Error("invert: expected modulus > 1, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, u = _1n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b - a * q;
    const m = x - u * q;
    b = a, a = r, x = u, u = m;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function invertCt(a, prime) {
  if (prime <= _1n2)
    throw new Error("invertCt: expected prime modulus > 1, got " + prime);
  const an = mod(a, prime);
  if (an === _0n2)
    throw new Error("invertCt: expected non-zero number");
  const inverse = pow(an, prime - _2n, prime);
  if (mod(an * inverse, prime) !== _1n2)
    throw new Error("invertCt: does not exist");
  return inverse;
}
function assertIsSquare(Fp, root, n) {
  const F = Fp;
  if (!F.eql(F.sqr(root), n))
    throw new Error("Cannot find square root");
}
function aoddModulus(order, fnName) {
  if ((order & _1n2) === _0n2)
    throw new Error(fnName + ": expected odd modulus, got " + order);
}
function sqrt3mod4(Fp, n) {
  const F = Fp;
  const p1div4 = (F.ORDER + _1n2) / _4n;
  const root = F.pow(n, p1div4);
  assertIsSquare(F, root, n);
  return root;
}
function sqrt5mod8(Fp, n) {
  const F = Fp;
  const p5div8 = (F.ORDER - _5n) / _8n;
  const n2 = F.mul(n, _2n);
  const v = F.pow(n2, p5div8);
  const nv = F.mul(n, v);
  const i = F.mul(F.mul(nv, _2n), v);
  const root = F.mul(nv, F.sub(i, F.ONE));
  assertIsSquare(F, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n) / _16n;
  return (Fp, n) => {
    const F = Fp;
    let tv1 = F.pow(n, c4);
    let tv2 = F.mul(tv1, c1);
    const tv3 = F.mul(tv1, c2);
    const tv4 = F.mul(tv1, c3);
    const e1 = F.eql(F.sqr(tv2), n);
    const e2 = F.eql(F.sqr(tv3), n);
    tv1 = F.cmov(tv1, tv2, e1);
    tv2 = F.cmov(tv4, tv3, e2);
    const e3 = F.eql(F.sqr(tv2), n);
    const root = F.cmov(tv1, tv2, e3);
    assertIsSquare(F, root, n);
    return root;
  };
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  aoddModulus(P, "tonelliShanks");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1000)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp, n) {
    const F = Fp;
    if (F.is0(n))
      return n;
    if (FpLegendre(F, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = F.mul(F.ONE, cc);
    let t = F.pow(n, Q);
    let R = F.pow(n, Q1div2);
    while (!F.eql(t, F.ONE)) {
      if (F.is0(t))
        throw new Error("Cannot find square root: probably non-prime P");
      let i = 1;
      let t_tmp = F.sqr(t);
      while (!F.eql(t_tmp, F.ONE)) {
        i++;
        t_tmp = F.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i - 1);
      const b = F.pow(c, exponent);
      M = i;
      c = F.sqr(b);
      t = F.mul(t, c);
      R = F.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  aoddModulus(P, "Fp.sqrt");
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  aobject2(field, "field");
  if (typeof field.ORDER !== "bigint")
    throw new TypeError('param "ORDER" is invalid: expected bigint, got ' + typeof field.ORDER);
  asafenumber(field.BYTES, "BYTES");
  asafenumber(field.BITS, "BITS");
  for (const name of FIELD_FIELDS)
    afunction(field[name], "field." + name);
  if (field.BYTES < 1 || field.BITS < 1)
    throw new Error("invalid field: expected BYTES/BITS > 0");
  if (field.ORDER <= _1n2)
    throw new Error("invalid field: expected ORDER > 1, got " + field.ORDER);
  return field;
}
function FpInvertBatch(Fp, nums, passZero = false) {
  validateField(Fp);
  aarray(nums, "nums");
  abool(passZero, "passZero");
  const F = Fp;
  const inverted = new Array(nums.length).fill(passZero ? F.ZERO : undefined);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = acc;
    return F.mul(acc, num);
  }, F.ONE);
  const invertedAcc = F.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = F.mul(acc, inverted[i]);
    return F.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp, n) {
  validateField(Fp);
  const F = Fp;
  aoddModulus(F.ORDER, "FpLegendre");
  const p1mod2 = (F.ORDER - _1n2) / _2n;
  const powered = F.pow(n, p1mod2);
  const yes = F.eql(powered, F.ONE);
  const zero = F.eql(powered, F.ZERO);
  const no = F.eql(powered, F.neg(F.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== undefined)
    anumber2(nBitLength);
  if (n <= _0n2)
    throw new Error("invalid n length: expected positive n, got " + n);
  if (nBitLength !== undefined && nBitLength < 1)
    throw new Error("invalid n length: expected positive bit length, got " + nBitLength);
  const bits = bitLen(n);
  if (nBitLength !== undefined && nBitLength < bits)
    throw new Error(`invalid n length: expected nBitLength (${nBitLength}) >= bitLen(n) (${bits})`);
  const _nBitLength = nBitLength !== undefined ? nBitLength : bits;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
var FIELD_SQRT = new WeakMap;

class _Field {
  ORDER;
  BITS;
  BYTES;
  isLE;
  ZERO = _0n2;
  ONE = _1n2;
  _lengths;
  _mod;
  constructor(ORDER, opts = {}) {
    if (ORDER <= _1n2)
      throw new Error("invalid field: expected ORDER > 1, got " + ORDER);
    let _nbitLength = undefined;
    this.isLE = false;
    if (opts != null && typeof opts === "object") {
      if (typeof opts.BITS === "number")
        _nbitLength = opts.BITS;
      if (typeof opts.sqrt === "function")
        Object.defineProperty(this, "sqrt", { value: opts.sqrt, enumerable: true });
      if (typeof opts.isLE === "boolean")
        this.isLE = opts.isLE;
      if (opts.allowedLengths)
        this._lengths = Object.freeze(opts.allowedLengths.slice());
      if (typeof opts.modFromBytes === "boolean")
        this._mod = opts.modFromBytes;
    }
    const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
    if (nByteLength > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = ORDER;
    this.BITS = nBitLength;
    this.BYTES = nByteLength;
    Object.freeze(this);
  }
  create(num) {
    return mod(num, this.ORDER);
  }
  isValid(num) {
    if (typeof num !== "bigint")
      throw new TypeError("invalid field element: expected bigint, got " + typeof num);
    return _0n2 <= num && num < this.ORDER;
  }
  is0(num) {
    return num === _0n2;
  }
  isValidNot0(num) {
    return !this.is0(num) && this.isValid(num);
  }
  isOdd(num) {
    return (num & _1n2) === _1n2;
  }
  neg(num) {
    return mod(-num, this.ORDER);
  }
  eql(lhs, rhs) {
    return lhs === rhs;
  }
  sqr(num) {
    return mod(num * num, this.ORDER);
  }
  add(lhs, rhs) {
    return mod(lhs + rhs, this.ORDER);
  }
  sub(lhs, rhs) {
    return mod(lhs - rhs, this.ORDER);
  }
  mul(lhs, rhs) {
    return mod(lhs * rhs, this.ORDER);
  }
  pow(num, power) {
    return pow(num, power, this.ORDER);
  }
  div(lhs, rhs) {
    return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
  }
  sqrN(num) {
    return num * num;
  }
  addN(lhs, rhs) {
    return lhs + rhs;
  }
  subN(lhs, rhs) {
    return lhs - rhs;
  }
  mulN(lhs, rhs) {
    return lhs * rhs;
  }
  inv(num) {
    return invert(num, this.ORDER);
  }
  sqrt(num) {
    let sqrt = FIELD_SQRT.get(this);
    if (!sqrt)
      FIELD_SQRT.set(this, sqrt = FpSqrt(this.ORDER));
    return sqrt(this, num);
  }
  toBytes(num) {
    return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
  }
  fromBytes(bytes, skipValidation = false) {
    abytes2(bytes);
    const { _lengths: allowedLengths, BYTES, isLE, ORDER, _mod: modFromBytes } = this;
    if (allowedLengths) {
      if (bytes.length < 1 || !allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
        throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
      }
      const padded = new Uint8Array(BYTES);
      padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
      bytes = padded;
    }
    if (bytes.length !== BYTES)
      throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
    let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
    if (modFromBytes)
      scalar = mod(scalar, ORDER);
    if (!skipValidation) {
      if (!this.isValid(scalar))
        throw new Error("invalid field element: outside of range 0..ORDER");
    }
    return scalar;
  }
  invertBatch(lst) {
    return FpInvertBatch(this, lst, true);
  }
  cmov(a, b, condition) {
    abool(condition, "condition");
    return condition ? b : a;
  }
}
function Field(ORDER, opts = {}) {
  Object.freeze(_Field.prototype);
  return new _Field(ORDER, opts);
}
function getFieldBytesLength(fieldOrder) {
  if (typeof fieldOrder !== "bigint")
    throw new Error("field order must be bigint");
  if (fieldOrder <= _1n2)
    throw new Error("field order must be greater than 1");
  const bitLength = bitLen(fieldOrder - _1n2);
  return Math.ceil(bitLength / 8);
}
function getMinHashLength(fieldOrder) {
  const length = getFieldBytesLength(fieldOrder);
  return length + Math.ceil(length / 2);
}
function mapHashToField(key, fieldOrder, isLE = false) {
  abytes2(key);
  const len = key.length;
  const fieldLen = getFieldBytesLength(fieldOrder);
  const minLen = Math.max(getMinHashLength(fieldOrder), 16);
  if (len < minLen || len > 1024)
    throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
  const num = isLE ? bytesToNumberLE(key) : bytesToNumberBE(key);
  const reduced = mod(num, fieldOrder - _1n2) + _1n2;
  return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}

// node_modules/@noble/curves/abstract/curve.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n3 = /* @__PURE__ */ BigInt(0);
var _1n3 = /* @__PURE__ */ BigInt(1);
var _4n2 = /* @__PURE__ */ BigInt(4);
var BLIND_BYTES = 16;
var BLIND_BITS = 128;
var FW_WINDOW = 5;
var TABLE_BYTES_MAX = /* @__PURE__ */ (() => 2 ** 31)();
function validatePointCons(Point) {
  const pc = Point;
  if (typeof pc !== "function")
    throw new TypeError('"Point" expected constructor, got type=' + typeof Point);
  afunction(pc.fromAffine, "Point.fromAffine");
  afunction(pc.fromBytes, "Point.fromBytes");
  afunction(pc.fromHex, "Point.fromHex");
  aobject2(pc.BASE, "Point.BASE");
  aobject2(pc.ZERO, "Point.ZERO");
  validateField(pc.Fp);
  validateField(pc.Fn);
}
function normalizeZ(c, points) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits, min = 1) {
  if (!Number.isSafeInteger(W) || W < min || W > bits)
    throw new Error("invalid window size, expected [" + min + ".." + bits + "], got W=" + W);
}
function validateTableBytes(numPoints, fpBytes) {
  const bytes = numPoints * (4 * fpBytes + 128);
  if (bytes > TABLE_BYTES_MAX)
    throw new Error("invalid window size: table would need ~" + Math.ceil(bytes / 2 ** 20) + " MiB, max " + TABLE_BYTES_MAX / 2 ** 20 + " MiB");
}
function probeRandomBytes(randomBytes3, length) {
  if (randomBytes3 === undefined)
    return;
  afunction(randomBytes3, "randomBytes");
  try {
    const probe = randomBytes3(length);
    if (!isBytes2(probe) || probe.length !== length)
      return;
  } catch {
    return;
  }
  return randomBytes3;
}
function validateMSMPoints(points, c) {
  aarray(points, "points");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field, maxScalar) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    const ok = maxScalar === undefined ? field.isValid(s) : isPosBig(s) && s < maxScalar;
    if (!ok)
      throw new Error("invalid scalar at index " + i);
  });
}
var pointWindowSizes = new WeakMap;
function getWindowSize(P) {
  return pointWindowSizes.get(P) || 1;
}
function oddMultiples(p, size) {
  const dbl = p.double();
  const t = [p];
  for (let j = 1;j < size; j++)
    t.push(t[j - 1].add(dbl));
  return t;
}
function wnafDigits(n, W) {
  const size = 2 ** W;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const d = [];
  while (n > _0n3) {
    let w = 0;
    if (n & _1n3) {
      w = Number(n & mask);
      if (w >= half)
        w -= size;
      n -= BigInt(w);
    }
    d.push(w);
    n >>= _1n3;
  }
  return d;
}
function signedWindowDigits(n, W, windows) {
  const size = 2 ** W;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const shiftBy = BigInt(W);
  const d = [];
  for (let w = 0;w < windows; w++) {
    let v = Number(n & mask);
    n >>= shiftBy;
    if (v > half) {
      v -= size;
      n += _1n3;
    }
    d.push(v);
  }
  if (n !== _0n3)
    throw new Error("invalid wnaf");
  return d;
}
function wnafWalk(zero, tables, digits) {
  let max = 0;
  for (const d of digits)
    max = Math.max(max, d.length);
  let acc = zero;
  for (let bit = max - 1;bit >= 0; bit--) {
    if (bit !== max - 1)
      acc = acc.double();
    for (let i = 0;i < digits.length; i++) {
      const w = digits[i][bit];
      if (w) {
        const item = tables[i][Math.abs(w) - 1 >> 1];
        acc = acc.add(w < 0 ? item.negate() : item);
      }
    }
  }
  return acc;
}

class ScalarMultiplier {
  Point;
  BASE;
  ZERO;
  randomBytes;
  wnafPrecomputes = new WeakMap;
  baseCanBeBlinded;
  bits;
  constructor(Point, randomBytes3) {
    validatePointCons(Point);
    this.randomBytes = probeRandomBytes(randomBytes3, BLIND_BYTES);
    this.Point = Point;
    this.BASE = Point.BASE;
    this.ZERO = Point.ZERO;
    this.bits = Point.Fn.BITS;
  }
  buildWnafTable(point, W, bits) {
    const windows = Math.ceil(bits / W) + 1;
    const half = 2 ** (W - 1);
    const comp = [];
    let base = point;
    for (let w = 0;w < windows; w++) {
      let acc = base;
      for (let i = 0;i < half; i++) {
        comp.push(acc);
        acc = acc.add(base);
      }
      base = comp[comp.length - 1].double();
    }
    return { W, bits, windows, comp };
  }
  wnafCachedCT(precomputes, n) {
    const { W, windows, comp } = precomputes;
    const half = 2 ** (W - 1);
    const digits = signedWindowDigits(n, W, windows);
    let p = this.ZERO;
    let f = this.BASE;
    for (let w = 0;w < windows; w++) {
      const digit = digits[w];
      const start = w * half;
      const idx = Math.abs(digit) - 1;
      let sel = comp[start];
      for (let i = 1;i < half; i++)
        sel = i === idx ? comp[start + i] : sel;
      const neg = sel.negate();
      if (digit === 0)
        f = f.add(comp[start]);
      else
        p = p.add(digit < 0 ? neg : sel);
    }
    return { p, f };
  }
  getWnafPrecomputes(W, point, bits, transform) {
    let entries = this.wnafPrecomputes.get(point);
    let comp = entries?.find((entry) => entry.W === W && entry.bits === bits);
    if (!comp) {
      comp = this.buildWnafTable(point, W, bits);
      if (typeof transform === "function")
        comp = { ...comp, comp: transform(comp.comp) };
      if (!entries) {
        entries = [];
        this.wnafPrecomputes.set(point, entries);
      }
      entries.push(comp);
    }
    return comp;
  }
  assertPoint(point) {
    if (!(point instanceof this.Point))
      throw new TypeError('"point" expected Point instance, got type=' + typeof point);
  }
  validateMulInput(point, scalar) {
    this.assertPoint(point);
    if (!inRange(scalar, _1n3, this.Point.Fn.ORDER))
      throw new Error("invalid scalar");
  }
  runCT(point, n, bits, transform) {
    const W = getWindowSize(point);
    if (W === 1)
      return this.fixedWindowCT(point, n, bits);
    return this.wnafCachedCT(this.getWnafPrecomputes(W, point, bits, transform), n);
  }
  mulCT(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    return this.runCT(point, scalar, this.bits, transform);
  }
  mulCTBlinded(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    if (this.randomBytes === undefined)
      throw new Error("randomBytes is required for scalar blinding");
    const bits = this.Point.Fn.BITS + BLIND_BITS;
    const blind = this.randomBytes(BLIND_BYTES);
    if (!isBytes2(blind) || blind.length !== BLIND_BYTES)
      throw new Error("randomBytes returned invalid byte array");
    blind[0] = blind[0] & 63 | 128;
    const n = scalar + bytesToNumberBE(blind) * this.Point.Fn.ORDER;
    return this.runCT(point, n, bits, transform);
  }
  fixedWindowCT(point, n, bits) {
    const W = FW_WINDOW;
    const size = 1 << W;
    const mask = bitMask(W);
    const table = new Array(size);
    table[0] = this.ZERO;
    for (let i = 1;i < size; i++)
      table[i] = table[i - 1].add(point);
    const windows = Math.ceil(bits / W);
    let acc = this.ZERO;
    for (let window2 = windows - 1;window2 >= 0; window2--) {
      if (window2 !== windows - 1)
        for (let d = 0;d < W; d++)
          acc = acc.double();
      const digit = Number(n >> BigInt(window2 * W) & mask);
      let sel = table[0];
      for (let i = 1;i < size; i++)
        sel = i === digit ? table[i] : sel;
      acc = acc.add(sel);
    }
    return { p: acc, f: acc };
  }
  shouldBlind(point, cofactor) {
    if (this.randomBytes === undefined)
      return false;
    if (cofactor === _1n3)
      return true;
    if (point !== this.BASE)
      return false;
    if (this.baseCanBeBlinded === undefined)
      this.baseCanBeBlinded = this.mulUnsafe(this.BASE, this.Point.Fn.ORDER).is0();
    return this.baseCanBeBlinded;
  }
  mulSecret(point, scalar, cofactor, transform) {
    return this.shouldBlind(point, cofactor) ? this.mulCTBlinded(point, scalar, transform) : this.mulCT(point, scalar, transform);
  }
  mulUnsafe(point, scalar, transform) {
    this.assertPoint(point);
    if (!isPosBig(scalar))
      throw new Error("invalid scalar");
    const W = getWindowSize(point);
    if (W === 1 || scalar >= this.Point.Fn.ORDER)
      return mulAddUnsafe(this.Point, [point], [scalar], true);
    const precomputes = this.getWnafPrecomputes(W, point, this.bits, transform);
    return this.wnafCachedCT(precomputes, scalar).p;
  }
  setWindowSize(point, W) {
    this.assertPoint(point);
    validateW(W, this.bits);
    const windows = Math.ceil((this.bits + BLIND_BITS) / W) + 1;
    validateTableBytes(windows * 2 ** (W - 1), this.Point.Fp.BYTES);
    pointWindowSizes.set(point, W);
    this.wnafPrecomputes.delete(point);
  }
  hasWindowSize(point) {
    return getWindowSize(point) !== 1;
  }
}
function mulAddUnsafe(c, points, scalars, allowOversized = false) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  abool(allowOversized, "allowOversized");
  validateMSMScalars(scalars, c.Fn, allowOversized ? c.Fn.ORDER ** _4n2 : undefined);
  if (points.length !== scalars.length)
    throw new Error("arrays of points and scalars must have equal length");
  const tables = points.map((p) => oddMultiples(p, 4));
  const digits = scalars.map((n) => wnafDigits(n, 4));
  return wnafWalk(c.ZERO, tables, digits);
}
function createField(order, field, isLE) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, { isLE });
  }
}
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (type !== "weierstrass" && type !== "edwards")
    throw new Error('expected curve type "weierstrass" or "edwards"');
  if (FpFnLE === undefined)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  validateObject(curveOpts);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(isPosBig(val) && val !== _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp, Fn };
}
function createKeygen(randomSecretKey, getPublicKey) {
  return function keygen(seed) {
    const secretKey = randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey(secretKey) };
  };
}

// node_modules/@noble/hashes/hmac.js
class _HMAC {
  oHash;
  iHash;
  blockLen;
  outputLen;
  canXOF = false;
  finished = false;
  destroyed = false;
  constructor(hash, key) {
    ahash(hash);
    abytes(key, undefined, "key");
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("expected Hash instance");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0;i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0;i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean(pad);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const buf = out.subarray(0, this.outputLen);
    this.iHash.digestInto(buf);
    this.oHash.update(buf);
    this.oHash.digestInto(buf);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to ||= Object.create(Object.getPrototypeOf(this), {});
    const { oHash, iHash, finished, destroyed, blockLen, outputLen, canXOF } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.canXOF = canXOF;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
}
var hmac = /* @__PURE__ */ (() => {
  const hmac_ = (hash, key, message) => new _HMAC(hash, key).update(message).digest();
  hmac_.create = (hash, key) => new _HMAC(hash, key);
  return hmac_;
})();

// node_modules/@noble/curves/abstract/der.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n4 = /* @__PURE__ */ BigInt(0);

class DERErr extends Error {
  constructor(m = "") {
    super(m);
  }
}
var _DER = {
  Err: DERErr,
  _tlv: {
    encode: (tag, data) => {
      const { Err: E } = _DER;
      asafenumber(tag, "tag");
      if (tag < 0 || tag > 255)
        throw new E("tlv.encode: wrong tag");
      astring(data, "data");
      if (data.length & 1)
        throw new E("tlv.encode: unpadded data");
      const dataLen = data.length / 2;
      const len = numberToHexUnpadded(dataLen);
      if (len.length / 2 & 128)
        throw new E("tlv.encode: long form length too big");
      const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
      const t = numberToHexUnpadded(tag);
      return t + lenLen + len + data;
    },
    decode(tag, data) {
      const { Err: E } = _DER;
      data = abytes2(data, undefined, "DER data");
      let pos = 0;
      if (tag < 0 || tag > 255)
        throw new E("tlv.decode: wrong tag");
      if (data.length < 2 || data[pos++] !== tag)
        throw new E("tlv.decode: wrong tlv");
      const first = data[pos++];
      const isLong = !!(first & 128);
      let length = 0;
      if (!isLong)
        length = first;
      else {
        const lenLen = first & 127;
        if (!lenLen)
          throw new E("tlv.decode(long): indefinite length not supported");
        if (lenLen > 4)
          throw new E("tlv.decode(long): byte length is too big");
        const lengthBytes = data.subarray(pos, pos + lenLen);
        if (lengthBytes.length !== lenLen)
          throw new E("tlv.decode: length bytes not complete");
        if (lengthBytes[0] === 0)
          throw new E("tlv.decode(long): zero leftmost byte");
        for (const b of lengthBytes)
          length = length << 8 | b;
        pos += lenLen;
        if (length < 128)
          throw new E("tlv.decode(long): not minimal encoding");
      }
      const v = data.subarray(pos, pos + length);
      if (v.length !== length)
        throw new E("tlv.decode: wrong value length");
      return { v, l: data.subarray(pos + length) };
    }
  },
  _int: {
    encode(num) {
      const { Err: E } = _DER;
      abignumber(num);
      if (num < _0n4)
        throw new E("integer: negative integers are not allowed");
      let hex = numberToHexUnpadded(num);
      if (Number.parseInt(hex[0], 16) & 8)
        hex = "00" + hex;
      if (hex.length & 1)
        throw new E("unexpected DER parsing assertion: unpadded hex");
      return hex;
    },
    decode(data) {
      const { Err: E } = _DER;
      if (data.length < 1)
        throw new E("invalid signature integer: empty");
      if (data[0] & 128)
        throw new E("invalid signature integer: negative");
      if (data.length > 1 && data[0] === 0 && !(data[1] & 128))
        throw new E("invalid signature integer: unnecessary leading zero");
      return bytesToNumberBE(data);
    }
  },
  toSig(bytes, maxScalarBytes) {
    const { Err: E, _int: int, _tlv: tlv } = _DER;
    if (maxScalarBytes !== undefined) {
      asafenumber(maxScalarBytes, "maxScalarBytes");
      if (maxScalarBytes < 1)
        throw new E("invalid signature: maxScalarBytes must be positive");
    }
    const data = abytes2(bytes, undefined, "signature");
    const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
    if (seqLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
    const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
    if (sLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    if (maxScalarBytes !== undefined && (rBytes.length > maxScalarBytes || sBytes.length > maxScalarBytes))
      throw new E("invalid signature: integer too large");
    return { r: int.decode(rBytes), s: int.decode(sBytes) };
  },
  hexFromSig(sig) {
    const { _tlv: tlv, _int: int } = _DER;
    validateObject(sig, { r: "bigint", s: "bigint" }, {}, "sig");
    const rs = tlv.encode(2, int.encode(sig.r));
    const ss = tlv.encode(2, int.encode(sig.s));
    const seq = rs + ss;
    return tlv.encode(48, seq);
  }
};
var DER = /* @__PURE__ */ (() => {
  Object.freeze(_DER._tlv);
  Object.freeze(_DER._int);
  return Object.freeze(_DER);
})();

// node_modules/@noble/curves/abstract/weierstrass.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var divNearest = (num, den) => (num + (num >= 0 ? den : -den) / _2n2) / den;
function _splitEndoScalar(k, basis, n) {
  aInRange("scalar", k, _0n5, n);
  const [[a1, b1], [a2, b2]] = basis;
  const c1 = divNearest(b2 * k, n);
  const c2 = divNearest(-b1 * k, n);
  let k1 = k - c1 * a1 - c2 * a2;
  let k2 = -c1 * b1 - c2 * b2;
  const k1neg = k1 < _0n5;
  const k2neg = k2 < _0n5;
  if (k1neg)
    k1 = -k1;
  if (k2neg)
    k2 = -k2;
  const MAX_NUM = bitMask(Math.ceil(bitLen(n) / 2)) + _1n4;
  if (k1 < _0n5 || k1 >= MAX_NUM || k2 < _0n5 || k2 >= MAX_NUM) {
    throw new Error("splitScalar (endomorphism): failed for k");
  }
  return { k1neg, k1, k2neg, k2 };
}
function validateSigFormat(format) {
  if (!["compact", "recovered", "der"].includes(format))
    throw new Error('Signature format must be "compact", "recovered", or "der"');
  return format;
}
function validateSigOpts(opts, def) {
  validateObject(opts);
  const optsn = {};
  for (let optName of Object.keys(def)) {
    optsn[optName] = opts[optName] === undefined ? def[optName] : opts[optName];
  }
  abool(optsn.lowS, "lowS");
  abool(optsn.prehash, "prehash");
  if (optsn.format !== undefined)
    validateSigFormat(optsn.format);
  return optsn;
}
var _0n5 = /* @__PURE__ */ BigInt(0);
var _1n4 = /* @__PURE__ */ BigInt(1);
var _2n2 = /* @__PURE__ */ BigInt(2);
var _3n2 = /* @__PURE__ */ BigInt(3);
var _4n3 = /* @__PURE__ */ BigInt(4);
function weierstrass(params, extraOpts = {}) {
  const validated = createCurveFields("weierstrass", params, extraOpts);
  const Fp = validated.Fp;
  const Fn = validated.Fn;
  let CURVE = validated.CURVE;
  const { h: cofactor, n: CURVE_ORDER } = CURVE;
  validateObject(extraOpts, {}, {
    allowInfinityPoint: "boolean",
    clearCofactor: "function",
    isTorsionFree: "function",
    fromBytes: "function",
    toBytes: "function",
    endo: "object",
    randomBytes: "function"
  });
  const { endo: endoOpts, allowInfinityPoint, clearCofactor, isTorsionFree, fromBytes, toBytes } = extraOpts;
  const randomBytes3 = extraOpts.randomBytes === undefined ? randomBytes2 : extraOpts.randomBytes;
  if (endoOpts) {
    if (!Fp.is0(CURVE.a) || typeof endoOpts.beta !== "bigint" || !Array.isArray(endoOpts.basises)) {
      throw new Error('invalid endo: expected "beta": bigint and "basises": array');
    }
  }
  const endo = endoOpts ? {
    beta: endoOpts.beta,
    basises: endoOpts.basises.map((basis) => [...basis])
  } : undefined;
  const lengths = getWLengths(Fp, Fn);
  function assertCompressionIsSupported() {
    if (!Fp.isOdd)
      throw new Error("compression is not supported: Field does not have .isOdd()");
  }
  function pointToBytes(_c, point, isCompressed) {
    if (point.is0()) {
      if (!allowInfinityPoint)
        throw new Error("bad point: ZERO");
      return Uint8Array.of(0);
    }
    const { x, y } = point.toAffine();
    const bx = Fp.toBytes(x);
    abool(isCompressed, "isCompressed");
    if (isCompressed) {
      assertCompressionIsSupported();
      const hasEvenY = !Fp.isOdd(y);
      return concatBytes2(pprefix(hasEvenY), bx);
    } else {
      return concatBytes2(Uint8Array.of(4), bx, Fp.toBytes(y));
    }
  }
  function pointFromBytes(bytes) {
    abytes2(bytes, undefined, "Point");
    const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;
    const length = bytes.length;
    const head = bytes[0];
    const tail = bytes.subarray(1);
    if (allowInfinityPoint && length === 1 && head === 0)
      return { x: Fp.ZERO, y: Fp.ZERO };
    if (length === comp && (head === 2 || head === 3)) {
      const x = Fp.fromBytes(tail);
      if (!Fp.isValid(x))
        throw new Error("bad point: is not on curve, wrong x");
      const y2 = weierstrassEquation(x);
      let y;
      try {
        y = Fp.sqrt(y2);
      } catch (sqrtError) {
        const err = sqrtError instanceof Error ? ": " + sqrtError.message : "";
        throw new Error("bad point: is not on curve, sqrt error" + err);
      }
      assertCompressionIsSupported();
      const evenY = Fp.isOdd(y);
      const evenH = (head & 1) === 1;
      if (evenH !== evenY)
        y = Fp.neg(y);
      return { x, y };
    } else if (length === uncomp && head === 4) {
      const L = Fp.BYTES;
      const x = Fp.fromBytes(tail.subarray(0, L));
      const y = Fp.fromBytes(tail.subarray(L, L * 2));
      if (!isValidXY(x, y))
        throw new Error("bad point: is not on curve");
      return { x, y };
    } else {
      throw new Error(`bad point: got length ${length}, expected compressed=${comp} or uncompressed=${uncomp}`);
    }
  }
  const encodePoint = toBytes === undefined ? pointToBytes : toBytes;
  const decodePoint = fromBytes === undefined ? pointFromBytes : fromBytes;
  const b3 = Fp.mul(CURVE.b, _3n2);
  const mulA = Fp.is0(CURVE.a) ? (_) => Fp.ZERO : (x) => Fp.mul(CURVE.a, x);
  function weierstrassEquation(x) {
    const x2 = Fp.sqr(x);
    const x3 = Fp.mul(x2, x);
    return Fp.add(Fp.add(x3, Fp.mul(x, CURVE.a)), CURVE.b);
  }
  function isValidXY(x, y) {
    const left = Fp.sqr(y);
    const right = weierstrassEquation(x);
    return Fp.eql(left, right);
  }
  if (!isValidXY(CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n2), _4n3);
  const _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));
  if (Fp.is0(Fp.add(_4a3, _27b2)))
    throw new Error("bad curve params: a or b");
  function acoord(title, n, banZero = false) {
    if (!Fp.isValid(n) || banZero && Fp.is0(n))
      throw new Error(`bad point coordinate ${title}`);
    return typeof n === "object" && n !== null ? Fp.create(n) : n;
  }
  function aprjpoint(other) {
    if (!(other instanceof Point))
      throw new Error("Weierstrass Point expected");
  }
  function splitEndoScalarN(k) {
    if (!endo || !endo.basises)
      throw new Error("no endo");
    return _splitEndoScalar(k, endo.basises, Fn.ORDER);
  }
  function pushWnafPair(points, scalars, p, k) {
    if (!Fn.isValid(k))
      throw new RangeError("invalid scalar: out of range");
    if (endo) {
      const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(k);
      const psi = new Point(Fp.mul(p.X, endo.beta), p.Y, p.Z);
      points.push(k1neg ? p.negate() : p, k2neg ? psi.negate() : psi);
      scalars.push(k1, k2);
    } else {
      points.push(p);
      scalars.push(k);
    }
  }
  const validityCache = new WeakSet;

  class Point {
    static BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE);
    static ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ZERO);
    static Fp = Fp;
    static Fn = Fn;
    X;
    Y;
    Z;
    constructor(X, Y, Z) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y, true);
      this.Z = acoord("z", Z);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    static fromAffine(p) {
      const { x, y } = p || {};
      if (!p || !Fp.isValid(x) || !Fp.isValid(y))
        throw new Error("invalid affine point");
      if (p instanceof Point)
        throw new Error("projective point not allowed");
      if (Fp.is0(x) && Fp.is0(y))
        return Point.ZERO;
      return new Point(x, y, Fp.ONE);
    }
    static fromBytes(bytes) {
      const P = Point.fromAffine(decodePoint(abytes2(bytes, undefined, "point")));
      P.assertValidity();
      return P;
    }
    static fromHex(hex) {
      return Point.fromBytes(hexToBytes2(hex));
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 6, isLazy = true) {
      wnaf.setWindowSize(this, windowSize);
      if (!isLazy)
        this.multiply(_3n2);
      return this;
    }
    assertValidity() {
      const p = this;
      if (p.is0()) {
        if (allowInfinityPoint && Fp.is0(p.X) && Fp.eql(p.Y, Fp.ONE) && Fp.is0(p.Z))
          return;
        throw new Error("bad point: ZERO");
      }
      if (validityCache.has(p))
        return;
      const { x, y } = p.toAffine();
      if (!Fp.isValid(x) || !Fp.isValid(y))
        throw new Error("bad point: x or y not field elements");
      if (!isValidXY(x, y))
        throw new Error("bad point: equation left != right");
      if (!p.isTorsionFree())
        throw new Error("bad point: not in prime-order subgroup");
      validityCache.add(p);
    }
    hasEvenY() {
      const { y } = this.toAffine();
      if (!Fp.isOdd)
        throw new Error("Field doesn't support isOdd");
      return !Fp.isOdd(y);
    }
    equals(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
      const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
      return U1 && U2;
    }
    negate() {
      return new Point(this.X, Fp.neg(this.Y), this.Z);
    }
    double() {
      const { X: X1, Y: Y1, Z: Z1 } = this;
      let { ZERO: X3, ZERO: Y3, ZERO: Z3 } = Fp;
      let t0 = Fp.mul(X1, X1);
      let t1 = Fp.mul(Y1, Y1);
      let t2 = Fp.mul(Z1, Z1);
      let t3 = Fp.mul(X1, Y1);
      t3 = Fp.add(t3, t3);
      Z3 = Fp.mul(X1, Z1);
      Z3 = Fp.add(Z3, Z3);
      X3 = mulA(Z3);
      Y3 = Fp.mul(b3, t2);
      Y3 = Fp.add(X3, Y3);
      X3 = Fp.sub(t1, Y3);
      Y3 = Fp.add(t1, Y3);
      Y3 = Fp.mul(X3, Y3);
      X3 = Fp.mul(t3, X3);
      Z3 = Fp.mul(b3, Z3);
      t2 = mulA(t2);
      t3 = Fp.sub(t0, t2);
      t3 = mulA(t3);
      t3 = Fp.add(t3, Z3);
      Z3 = Fp.add(t0, t0);
      t0 = Fp.add(Z3, t0);
      t0 = Fp.add(t0, t2);
      t0 = Fp.mul(t0, t3);
      Y3 = Fp.add(Y3, t0);
      t2 = Fp.mul(Y1, Z1);
      t2 = Fp.add(t2, t2);
      t0 = Fp.mul(t2, t3);
      X3 = Fp.sub(X3, t0);
      Z3 = Fp.mul(t2, t1);
      Z3 = Fp.add(Z3, Z3);
      Z3 = Fp.add(Z3, Z3);
      return new Point(X3, Y3, Z3);
    }
    add(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      let { ZERO: X3, ZERO: Y3, ZERO: Z3 } = Fp;
      let t0 = Fp.mul(X1, X2);
      let t1 = Fp.mul(Y1, Y2);
      let t2 = Fp.mul(Z1, Z2);
      let t3 = Fp.add(X1, Y1);
      let t4 = Fp.add(X2, Y2);
      t3 = Fp.mul(t3, t4);
      t4 = Fp.add(t0, t1);
      t3 = Fp.sub(t3, t4);
      t4 = Fp.add(X1, Z1);
      let t5 = Fp.add(X2, Z2);
      t4 = Fp.mul(t4, t5);
      t5 = Fp.add(t0, t2);
      t4 = Fp.sub(t4, t5);
      t5 = Fp.add(Y1, Z1);
      X3 = Fp.add(Y2, Z2);
      t5 = Fp.mul(t5, X3);
      X3 = Fp.add(t1, t2);
      t5 = Fp.sub(t5, X3);
      Z3 = mulA(t4);
      X3 = Fp.mul(b3, t2);
      Z3 = Fp.add(X3, Z3);
      X3 = Fp.sub(t1, Z3);
      Z3 = Fp.add(t1, Z3);
      Y3 = Fp.mul(X3, Z3);
      t1 = Fp.add(t0, t0);
      t1 = Fp.add(t1, t0);
      t2 = mulA(t2);
      t4 = Fp.mul(b3, t4);
      t1 = Fp.add(t1, t2);
      t2 = Fp.sub(t0, t2);
      t2 = mulA(t2);
      t4 = Fp.add(t4, t2);
      t0 = Fp.mul(t1, t4);
      Y3 = Fp.add(Y3, t0);
      t0 = Fp.mul(t5, t4);
      X3 = Fp.mul(t3, X3);
      X3 = Fp.sub(X3, t0);
      t0 = Fp.mul(t3, t1);
      Z3 = Fp.mul(t5, Z3);
      Z3 = Fp.add(Z3, t0);
      return new Point(X3, Y3, Z3);
    }
    subtract(other) {
      aprjpoint(other);
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    multiply(scalar) {
      if (!Fn.isValidNot0(scalar))
        throw new RangeError("invalid scalar: out of range");
      const { p, f } = wnaf.mulSecret(this, scalar, cofactor, normalize);
      return normalize([p, f])[0];
    }
    multiplyUnsafe(scalar) {
      const p = this;
      const sc = scalar;
      if (!Fn.isValid(sc))
        throw new RangeError("invalid scalar: out of range");
      if (sc === _0n5 || p.is0())
        return Point.ZERO;
      if (sc === _1n4)
        return p;
      if (wnaf.hasWindowSize(this))
        return wnaf.mulUnsafe(p, sc, normalize);
      const points = [];
      const scalars = [];
      pushWnafPair(points, scalars, p, sc);
      return mulAddUnsafe(Point, points, scalars);
    }
    mulAddUnsafe(a, other, b) {
      aprjpoint(other);
      const points = [];
      const scalars = [];
      pushWnafPair(points, scalars, this, a);
      pushWnafPair(points, scalars, other, b);
      return mulAddUnsafe(Point, points, scalars);
    }
    toAffine(invertedZ) {
      const p = this;
      let iz = invertedZ;
      if (iz != null && !Fp.isValid(iz))
        throw new RangeError('"invertedZ" expected valid field element');
      const { X, Y, Z } = p;
      if (Fp.eql(Z, Fp.ONE))
        return { x: X, y: Y };
      const is0 = p.is0();
      if (iz == null)
        iz = is0 ? Fp.ONE : Fp.inv(Z);
      const x = Fp.mul(X, iz);
      const y = Fp.mul(Y, iz);
      const zz = Fp.mul(Z, iz);
      if (is0)
        return { x: Fp.ZERO, y: Fp.ZERO };
      if (!Fp.eql(zz, Fp.ONE))
        throw new Error("invZ was invalid");
      return { x, y };
    }
    isTorsionFree() {
      if (cofactor === _1n4)
        return true;
      if (isTorsionFree)
        return isTorsionFree(Point, this);
      return wnaf.mulUnsafe(this, CURVE_ORDER).is0();
    }
    clearCofactor() {
      if (cofactor === _1n4)
        return this;
      if (clearCofactor)
        return clearCofactor(Point, this);
      return this.multiplyUnsafe(cofactor);
    }
    isSmallOrder() {
      if (cofactor === _1n4)
        return this.is0();
      return this.clearCofactor().is0();
    }
    toBytes(isCompressed = true) {
      abool(isCompressed, "isCompressed");
      this.assertValidity();
      return encodePoint(Point, this, isCompressed);
    }
    toHex(isCompressed = true) {
      return bytesToHex2(this.toBytes(isCompressed));
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  }
  const normalize = (points) => normalizeZ(Point, points);
  const wnaf = new ScalarMultiplier(Point, randomBytes3);
  if (wnaf.bits >= 6)
    Point.BASE.precompute(6);
  Object.freeze(Point.prototype);
  Object.freeze(Point);
  return Point;
}
function pprefix(hasEvenY) {
  return Uint8Array.of(hasEvenY ? 2 : 3);
}
function getWLengths(Fp, Fn) {
  return {
    secretKey: Fn.BYTES,
    publicKey: 1 + Fp.BYTES,
    publicKeyUncompressed: 1 + 2 * Fp.BYTES,
    publicKeyHasPrefix: true,
    signature: 2 * Fn.BYTES
  };
}
function ecdh(Point, ecdhOpts = {}) {
  validatePointCons(Point);
  const { Fn } = Point;
  const randomBytes_ = ecdhOpts.randomBytes === undefined ? randomBytes2 : ecdhOpts.randomBytes;
  const lengths = Object.assign(getWLengths(Point.Fp, Fn), {
    seed: Math.max(getMinHashLength(Fn.ORDER), 16)
  });
  function isValidSecretKey(secretKey) {
    try {
      const num = Fn.fromBytes(secretKey);
      return Fn.isValidNot0(num);
    } catch (error) {
      return false;
    }
  }
  function isValidPublicKey(publicKey, isCompressed) {
    const { publicKey: comp, publicKeyUncompressed } = lengths;
    try {
      const l = publicKey.length;
      if (isCompressed === true && l !== comp)
        return false;
      if (isCompressed === false && l !== publicKeyUncompressed)
        return false;
      return !Point.fromBytes(publicKey).is0();
    } catch (error) {
      return false;
    }
  }
  function randomSecretKey(seed) {
    seed = seed === undefined ? randomBytes_(lengths.seed) : seed;
    return mapHashToField(abytes2(seed, lengths.seed, "seed"), Fn.ORDER);
  }
  function getPublicKey(secretKey, isCompressed = true) {
    return Point.BASE.multiply(Fn.fromBytes(secretKey)).toBytes(isCompressed);
  }
  function isProbPub(item) {
    const { secretKey, publicKey, publicKeyUncompressed } = lengths;
    const allowedLengths = Fn._lengths;
    if (!isBytes2(item))
      return;
    const l = abytes2(item, undefined, "key").length;
    const isPub = l === publicKey || l === publicKeyUncompressed;
    const isSec = l === secretKey || !!allowedLengths?.includes(l);
    if (isPub && isSec)
      return;
    return isPub;
  }
  function getSharedSecret(secretKeyA, publicKeyB, isCompressed = true) {
    if (isProbPub(secretKeyA) === true)
      throw new Error("first arg must be private key");
    if (isProbPub(publicKeyB) === false)
      throw new Error("second arg must be public key");
    const s = Fn.fromBytes(secretKeyA);
    const b = Point.fromBytes(publicKeyB);
    if (b.is0())
      throw new Error("invalid public key: point at infinity");
    return b.multiply(s).toBytes(isCompressed);
  }
  const utils = {
    isValidSecretKey,
    isValidPublicKey,
    randomSecretKey
  };
  const keygen = createKeygen(randomSecretKey, getPublicKey);
  Object.freeze(utils);
  Object.freeze(lengths);
  return Object.freeze({ getPublicKey, getSharedSecret, keygen, Point, utils, lengths });
}
function ecdsa(Point, hash, ecdsaOpts = {}) {
  validatePointCons(Point);
  const hash_ = hash;
  ahash(hash_);
  validateObject(ecdsaOpts, {}, {
    hmac: "function",
    lowS: "boolean",
    randomBytes: "function",
    bits2int: "function",
    bits2int_modN: "function"
  });
  const opts = Object.assign({}, ecdsaOpts);
  const randomBytes3 = opts.randomBytes === undefined ? randomBytes2 : opts.randomBytes;
  const hmac2 = opts.hmac === undefined ? (key, msg) => hmac(hash_, key, msg) : opts.hmac;
  const { Fp, Fn } = Point;
  const { ORDER: CURVE_ORDER, BITS: fnBits } = Fn;
  const blindLength = getMinHashLength(CURVE_ORDER);
  const csprng = probeRandomBytes(randomBytes3, blindLength);
  const { keygen, getPublicKey, getSharedSecret, utils, lengths } = ecdh(Point, opts);
  const defaultSigOpts = {
    prehash: true,
    lowS: typeof opts.lowS === "boolean" ? opts.lowS : true,
    format: "compact",
    extraEntropy: false
  };
  const hasLargeRecoveryLifts = CURVE_ORDER * _2n2 + _1n4 < Fp.ORDER;
  function isBiggerThanHalfOrder(number) {
    const HALF = CURVE_ORDER >> _1n4;
    return number > HALF;
  }
  function validateRS(title, num) {
    if (!Fn.isValidNot0(num))
      throw new Error(`invalid signature ${title}: out of range 1..Point.Fn.ORDER`);
    return num;
  }
  function assertFieldSignIsSupported() {
    if (!Fp.isOdd)
      throw new Error("Field doesn't support isOdd");
  }
  function getRecoveryBit(x, y, r) {
    assertFieldSignIsSupported();
    return (x === r ? 0 : 2) | Number(Fp.isOdd(y));
  }
  function assertRecoverableCurve() {
    if (hasLargeRecoveryLifts)
      throw new Error('"recovered" sig type is not supported for cofactor >2 curves');
  }
  function validateSigLength(bytes, format) {
    validateSigFormat(format);
    const size = lengths.signature;
    const sizer = format === "compact" ? size : format === "recovered" ? size + 1 : undefined;
    return abytes2(bytes, sizer);
  }

  class Signature {
    r;
    s;
    recovery;
    constructor(r, s, recovery) {
      this.r = validateRS("r", r);
      this.s = validateRS("s", s);
      if (recovery != null) {
        assertRecoverableCurve();
        if (![0, 1, 2, 3].includes(recovery))
          throw new Error("invalid recovery id");
        this.recovery = recovery;
      }
      Object.freeze(this);
    }
    static fromBytes(bytes, format = defaultSigOpts.format) {
      validateSigLength(bytes, format);
      let recid;
      if (format === "der") {
        if (bytes.length > 2 * Fn.BYTES + 16)
          throw new DER.Err("invalid signature: DER signature too long");
        const { r: r2, s: s2 } = DER.toSig(abytes2(bytes), Fn.BYTES + 1);
        return new Signature(r2, s2);
      }
      if (format === "recovered") {
        recid = bytes[0];
        format = "compact";
        bytes = bytes.subarray(1);
      }
      const L = lengths.signature / 2;
      const r = bytes.subarray(0, L);
      const s = bytes.subarray(L, L * 2);
      return new Signature(Fn.fromBytes(r), Fn.fromBytes(s), recid);
    }
    static fromHex(hex, format) {
      return this.fromBytes(hexToBytes2(hex), format);
    }
    assertRecovery() {
      const { recovery } = this;
      if (recovery == null)
        throw new Error("invalid recovery id: must be present");
      return recovery;
    }
    addRecoveryBit(recovery) {
      return new Signature(this.r, this.s, recovery);
    }
    recoverPublicKey(messageHash) {
      const { r, s } = this;
      const recovery = this.assertRecovery();
      const radj = recovery === 2 || recovery === 3 ? r + CURVE_ORDER : r;
      if (!Fp.isValid(radj))
        throw new Error("invalid recovery id: sig.r+curve.n != R.x");
      const x = Fp.toBytes(radj);
      const R = Point.fromBytes(concatBytes2(pprefix((recovery & 1) === 0), x));
      const ir = Fn.inv(radj);
      const h = bits2int_modN(abytes2(messageHash, undefined, "msgHash"));
      const u1 = Fn.create(-h * ir);
      const u2 = Fn.create(s * ir);
      const Q = Point.BASE.mulAddUnsafe(u1, R, u2);
      if (Q.is0())
        throw new Error("invalid recovery: point at infinify");
      Q.assertValidity();
      return Q;
    }
    hasHighS() {
      return isBiggerThanHalfOrder(this.s);
    }
    toBytes(format = defaultSigOpts.format) {
      validateSigFormat(format);
      if (format === "der")
        return hexToBytes2(DER.hexFromSig(this));
      const { r, s } = this;
      const rb = Fn.toBytes(r);
      const sb = Fn.toBytes(s);
      if (format === "recovered") {
        assertRecoverableCurve();
        return concatBytes2(Uint8Array.of(this.assertRecovery()), rb, sb);
      }
      return concatBytes2(rb, sb);
    }
    toHex(format) {
      return bytesToHex2(this.toBytes(format));
    }
  }
  Object.freeze(Signature.prototype);
  Object.freeze(Signature);
  const bits2int = opts.bits2int === undefined ? function bits2int_def(bytes) {
    if (bytes.length > 8192)
      throw new Error("input is too large");
    const num = bytesToNumberBE(bytes);
    const delta = bytes.length * 8 - fnBits;
    return delta > 0 ? num >> BigInt(delta) : num;
  } : opts.bits2int;
  const bits2int_modN = opts.bits2int_modN === undefined ? function bits2int_modN_def(bytes) {
    return Fn.create(bits2int(bytes));
  } : opts.bits2int_modN;
  const ORDER_MASK = bitMask(fnBits);
  function int2octets(num) {
    aInRange("num < 2^" + fnBits, num, _0n5, ORDER_MASK);
    return Fn.toBytes(num);
  }
  function validateMsgAndHash(message, prehash) {
    abytes2(message, undefined, "message");
    return prehash ? abytes2(hash_(message), undefined, "prehashed message") : message;
  }
  function prepSig(message, secretKey, opts2) {
    const { lowS, prehash, extraEntropy } = validateSigOpts(opts2, defaultSigOpts);
    message = validateMsgAndHash(message, prehash);
    const h1int = bits2int_modN(message);
    const d = Fn.fromBytes(secretKey);
    if (!Fn.isValidNot0(d))
      throw new Error("invalid private key");
    const seedArgs = [int2octets(d), int2octets(h1int)];
    if (extraEntropy != null && extraEntropy !== false) {
      const e = extraEntropy === true ? randomBytes3(lengths.secretKey) : extraEntropy;
      seedArgs.push(abytes2(e, undefined, "extraEntropy"));
    }
    const seed = concatBytes2(...seedArgs);
    const m = h1int;
    function k2sig(kBytes) {
      const k = bits2int(kBytes);
      if (!Fn.isValidNot0(k))
        return;
      const q = Point.BASE.multiply(k).toAffine();
      const r = Fn.create(q.x);
      if (r === _0n5)
        return;
      let s;
      if (csprng !== undefined) {
        const b = bytesToNumberBE(mapHashToField(csprng(blindLength), CURVE_ORDER));
        const ibk = Fn.inv(Fn.mul(b, k));
        const bm = Fn.mul(b, m);
        const bd = Fn.mul(b, d);
        s = Fn.create(ibk * Fn.create(bm + bd * r));
      } else {
        const ik = invertCt(k, CURVE_ORDER);
        s = Fn.create(ik * Fn.create(m + r * d));
      }
      if (s === _0n5)
        return;
      let recovery = getRecoveryBit(q.x, q.y, r);
      let normS = s;
      if (lowS && isBiggerThanHalfOrder(s)) {
        normS = Fn.neg(s);
        recovery ^= 1;
      }
      return new Signature(r, normS, hasLargeRecoveryLifts ? undefined : recovery);
    }
    return { seed, k2sig };
  }
  function sign(message, secretKey, opts2 = {}) {
    const { seed, k2sig } = prepSig(message, secretKey, opts2);
    const drbg = createHmacDrbg(hash_.outputLen, Fn.BYTES, hmac2);
    const sig = drbg(seed, k2sig);
    return sig.toBytes(opts2.format);
  }
  function verify(signature, message, publicKey, opts2 = {}) {
    const { lowS, prehash, format } = validateSigOpts(opts2, defaultSigOpts);
    publicKey = abytes2(publicKey, undefined, "publicKey");
    message = validateMsgAndHash(message, prehash);
    if (!isBytes2(signature)) {
      const end = signature instanceof Signature ? ", use sig.toBytes()" : "";
      throw new Error("verify expects Uint8Array signature" + end);
    }
    validateSigLength(signature, format);
    try {
      const sig = Signature.fromBytes(signature, format);
      const P = Point.fromBytes(publicKey);
      if (P.is0())
        return false;
      if (lowS && sig.hasHighS())
        return false;
      const { r, s } = sig;
      const h = bits2int_modN(message);
      const is = Fn.inv(s);
      const u1 = Fn.create(h * is);
      const u2 = Fn.create(r * is);
      const R = Point.BASE.mulAddUnsafe(u1, P, u2);
      if (R.is0())
        return false;
      const q = R.toAffine();
      const v = Fn.create(q.x);
      if (v !== r)
        return false;
      if (format === "recovered" && sig.recovery !== getRecoveryBit(q.x, q.y, r))
        return false;
      return true;
    } catch (e) {
      return false;
    }
  }
  function recoverPublicKey(signature, message, opts2 = {}) {
    const { prehash } = validateSigOpts(opts2, defaultSigOpts);
    message = validateMsgAndHash(message, prehash);
    return Signature.fromBytes(signature, "recovered").recoverPublicKey(message).toBytes();
  }
  return Object.freeze({
    keygen,
    getPublicKey,
    getSharedSecret,
    utils,
    lengths,
    Point,
    sign,
    verify,
    recoverPublicKey,
    Signature,
    hash: hash_
  });
}

// node_modules/@noble/curves/secp256k1.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var secp256k1_CURVE = {
  p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
  n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
  h: BigInt(1),
  a: BigInt(0),
  b: BigInt(7),
  Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
  Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
};
var secp256k1_ENDO = {
  beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
  basises: [
    [BigInt("0x3086d221a7d46bcde86c90e49284eb15"), -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],
    [BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"), BigInt("0x3086d221a7d46bcde86c90e49284eb15")]
  ]
};
var _0n6 = /* @__PURE__ */ BigInt(0);
var _2n3 = /* @__PURE__ */ BigInt(2);
function sqrtMod(y) {
  const P = secp256k1_CURVE.p;
  const _3n3 = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
  const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
  const b2 = y * y * y % P;
  const b3 = b2 * b2 * y % P;
  const b6 = pow2(b3, _3n3, P) * b3 % P;
  const b9 = pow2(b6, _3n3, P) * b3 % P;
  const b11 = pow2(b9, _2n3, P) * b2 % P;
  const b22 = pow2(b11, _11n, P) * b11 % P;
  const b44 = pow2(b22, _22n, P) * b22 % P;
  const b88 = pow2(b44, _44n, P) * b44 % P;
  const b176 = pow2(b88, _88n, P) * b88 % P;
  const b220 = pow2(b176, _44n, P) * b44 % P;
  const b223 = pow2(b220, _3n3, P) * b3 % P;
  const t1 = pow2(b223, _23n, P) * b22 % P;
  const t2 = pow2(t1, _6n, P) * b2 % P;
  const root = pow2(t2, _2n3, P);
  if (!Fpk1.eql(Fpk1.sqr(root), y))
    throw new Error("Cannot find square root");
  return root;
}
var Fpk1 = /* @__PURE__ */ Field(secp256k1_CURVE.p, { sqrt: sqrtMod });
var Pointk1 = /* @__PURE__ */ weierstrass(secp256k1_CURVE, {
  Fp: Fpk1,
  endo: secp256k1_ENDO
});
var secp256k1 = /* @__PURE__ */ ecdsa(Pointk1, sha256);
var TAGGED_HASH_PREFIXES = Object.create(null);
function taggedHash(tag, ...messages) {
  let tagP = TAGGED_HASH_PREFIXES[tag];
  if (tagP === undefined) {
    const tagH = sha256(asciiToBytes(tag));
    tagP = concatBytes2(tagH, tagH);
    TAGGED_HASH_PREFIXES[tag] = tagP;
  }
  return sha256(concatBytes2(tagP, ...messages));
}
var pointToBytes = (point) => point.toBytes(true).slice(1);
var affineXToBytes = ({ x }) => Fpk1.toBytes(x);
var hasEven = (y) => !Fpk1.isOdd(y);
function schnorrGetExtPubKey(priv) {
  const { Fn, BASE: BASE2 } = Pointk1;
  const d_ = Fn.fromBytes(abytes2(priv, 32, "secretKey"));
  const p = BASE2.multiply(d_);
  const affine = p.toAffine();
  const scalar = hasEven(affine.y) ? d_ : Fn.neg(d_);
  return { scalar, bytes: affineXToBytes(affine) };
}
function lift_x(x) {
  const Fp = Fpk1;
  if (!Fp.isValidNot0(x))
    throw new Error("invalid x: Fail if x ≥ p");
  const xx = Fp.sqr(x);
  const c = Fp.add(Fp.mulN(xx, x), BigInt(7));
  let y = Fp.sqrt(c);
  if (!hasEven(y))
    y = Fp.neg(y);
  const p = Pointk1.fromAffine({ x, y });
  p.assertValidity();
  return p;
}
var num = bytesToNumberBE;
function challenge(...args) {
  return Pointk1.Fn.create(num(taggedHash("BIP0340/challenge", ...args)));
}
function schnorrGetPublicKey(secretKey) {
  return schnorrGetExtPubKey(secretKey).bytes;
}
function schnorrSign(message, secretKey, auxRand = randomBytes(32)) {
  const { Fn, BASE: BASE2 } = Pointk1;
  const m = copyBytes(abytes2(message, undefined, "message"));
  const { bytes: px, scalar: d } = schnorrGetExtPubKey(secretKey);
  const a = abytes2(auxRand, 32, "auxRand");
  const t = Fn.toBytes(d ^ num(taggedHash("BIP0340/aux", a)));
  const rand = taggedHash("BIP0340/nonce", t, px, m);
  const k_ = Fn.create(num(rand));
  if (k_ === _0n6)
    throw new Error("sign failed: k is zero");
  const p = BASE2.multiply(k_);
  const affine = p.toAffine();
  const k = hasEven(affine.y) ? k_ : Fn.neg(k_);
  const rx = affineXToBytes(affine);
  const e = challenge(rx, px, m);
  const sig = new Uint8Array(64);
  sig.set(rx, 0);
  sig.set(Fn.toBytes(Fn.create(k + e * d)), 32);
  if (!schnorrVerify(sig, m, px))
    throw new Error("sign: Invalid signature produced");
  return sig;
}
function schnorrVerify(signature, message, publicKey) {
  const { Fp, Fn, BASE: BASE2 } = Pointk1;
  const sig = abytes2(signature, 64, "signature");
  const m = abytes2(message, undefined, "message");
  const pub = abytes2(publicKey, 32, "publicKey");
  try {
    const P = lift_x(num(pub));
    const rBytes = sig.subarray(0, 32);
    const r = num(rBytes);
    if (!Fp.isValidNot0(r))
      return false;
    const s = num(sig.subarray(32, 64));
    if (!Fn.isValidNot0(s))
      return false;
    const e = challenge(rBytes, pointToBytes(P), m);
    const R = BASE2.mulAddUnsafe(s, P, Fn.neg(e));
    const { x, y } = R.toAffine();
    if (R.is0() || !hasEven(y) || !Fp.eql(x, r))
      return false;
    return true;
  } catch (error) {
    return false;
  }
}
var schnorr = /* @__PURE__ */ (() => {
  const size = 32;
  const seedLength = 48;
  const randomSecretKey = (seed) => {
    seed = seed === undefined ? randomBytes(seedLength) : seed;
    return mapHashToField(abytes2(seed, seedLength, "seed"), secp256k1_CURVE.n);
  };
  return Object.freeze({
    keygen: createKeygen(randomSecretKey, schnorrGetPublicKey),
    getPublicKey: schnorrGetPublicKey,
    sign: schnorrSign,
    verify: schnorrVerify,
    Point: Pointk1,
    utils: Object.freeze({
      randomSecretKey,
      taggedHash,
      lift_x,
      pointToBytes
    }),
    lengths: Object.freeze({
      secretKey: size,
      publicKey: size,
      publicKeyHasPrefix: false,
      signature: size * 2,
      seed: seedLength
    })
  });
})();

// core/nostr/event.ts
var HEX32_RE = /^[0-9a-f]{64}$/;
var HEX64_RE = /^[0-9a-f]{128}$/;
function isHex32(value) {
  return typeof value === "string" && HEX32_RE.test(value);
}
function isHex64(value) {
  return typeof value === "string" && HEX64_RE.test(value);
}
function serializeEvent(event) {
  assertSerialisable(event);
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}
function assertSerialisable(event) {
  if (!isHex32(event.pubkey)) {
    throw new Error(`serializeEvent: pubkey must be 64 lowercase hex characters, got ${show(event.pubkey)}`);
  }
  if (!Number.isInteger(event.created_at) || event.created_at < 0) {
    throw new Error(`serializeEvent: created_at must be a non-negative integer, got ${show(event.created_at)}`);
  }
  if (!Number.isInteger(event.kind) || event.kind < 0 || event.kind > 65535) {
    throw new Error(`serializeEvent: kind must be an integer in 0..65535, got ${show(event.kind)}`);
  }
  if (typeof event.content !== "string") {
    throw new Error(`serializeEvent: content must be a string, got ${show(event.content)}`);
  }
  if (!Array.isArray(event.tags)) {
    throw new Error(`serializeEvent: tags must be an array, got ${show(event.tags)}`);
  }
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.some((v) => typeof v !== "string")) {
      throw new Error(`serializeEvent: every tag must be an array of strings, got ${show(tag)}`);
    }
  }
}
function show(value) {
  if (typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "bigint")
    return `${value}n`;
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}
function eventDigest(event) {
  return sha256(utf8ToBytes(serializeEvent(event)));
}
function eventId(event) {
  return bytesToHex(eventDigest(event));
}
function signEvent(unsigned, secretKey, auxRand) {
  const derived = bytesToHex(schnorr.getPublicKey(secretKey));
  if (derived !== unsigned.pubkey) {
    throw new Error(`signEvent: this key is ${derived}, but the event claims ${show(unsigned.pubkey)}; ` + "a signature under the wrong pubkey verifies nowhere");
  }
  const digest = eventDigest(unsigned);
  const sig = auxRand ? schnorr.sign(digest, secretKey, auxRand) : schnorr.sign(digest, secretKey);
  return { ...unsigned, id: bytesToHex(digest), sig: bytesToHex(sig) };
}
function checkEvent(event) {
  if (typeof event !== "object" || event === null)
    return { ok: false, reason: "not an object" };
  const e = event;
  if (!isHex32(e.id))
    return { ok: false, reason: "id is not 64 lowercase hex characters" };
  if (!isHex64(e.sig))
    return { ok: false, reason: "sig is not 128 lowercase hex characters" };
  let digest;
  try {
    digest = eventDigest(e);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const computed = bytesToHex(digest);
  if (computed !== e.id) {
    return { ok: false, reason: `id mismatch: the content hashes to ${computed}, not ${e.id}` };
  }
  let valid;
  try {
    valid = schnorr.verify(hexToBytes(e.sig), digest, hexToBytes(e.pubkey));
  } catch (err) {
    return { ok: false, reason: `signature did not parse: ${err.message}` };
  }
  if (!valid)
    return { ok: false, reason: "signature does not verify under this pubkey" };
  return { ok: true, event: e };
}
function verifyEvent(event) {
  return checkEvent(event).ok;
}
function verifyDigestSignature(sigHex, digest, pubkeyHex) {
  if (!isHex64(sigHex) || !isHex32(pubkeyHex))
    return false;
  try {
    return schnorr.verify(hexToBytes(sigHex), digest, hexToBytes(pubkeyHex));
  } catch {
    return false;
  }
}
function findTag(event, name) {
  return event.tags.find((t) => t[0] === name);
}
function tagValue(event, name) {
  return findTag(event, name)?.[1];
}
function tagValues(event, name) {
  return event.tags.filter((t) => t[0] === name && t.length > 1).map((t) => t[1]);
}
function addressOf(event) {
  return `${event.kind}:${event.pubkey}:${tagValue(event, "d") ?? ""}`;
}
function isReplaceable(kind) {
  return kind === 0 || kind === 3 || kind >= 1e4 && kind < 20000;
}
function isEphemeral(kind) {
  return kind >= 20000 && kind < 30000;
}
function isAddressable(kind) {
  return kind >= 30000 && kind < 40000;
}

// core/oracle/proof.ts
var PROOF_VERSION = "fmd1";
var PROOF_MESSAGE_PREFIX = "flexmydomain:v1";
var PROOF_KIND = 30078;
var PROOF_D_PREFIX = "fmd:proof:";
var MAX_CLOCK_SKEW_SECONDS = 300;
function proofDTag(domain) {
  return PROOF_D_PREFIX + normaliseDomain(domain);
}
function proofMessage(domain, iat) {
  assertIat(iat);
  return `${PROOF_MESSAGE_PREFIX}:${normaliseDomain(domain)}:${iat}`;
}
function proofEvent(params) {
  const domain = normaliseDomain(params.domain);
  if (!isHex32(params.pubkey)) {
    throw new Error(`proofEvent: pubkey must be 64 lowercase hex characters, got ${JSON.stringify(params.pubkey)}`);
  }
  assertIat(params.iat);
  return {
    pubkey: params.pubkey,
    created_at: params.iat,
    kind: PROOF_KIND,
    tags: [["d", PROOF_D_PREFIX + domain]],
    content: `${PROOF_MESSAGE_PREFIX}:${domain}:${params.iat}`
  };
}
function proofDigest(params) {
  return eventDigest(proofEvent(params));
}
function proofDigestHex(params) {
  return bytesToHex(proofDigest(params));
}
function encodeProofRecord(record) {
  if (record.version !== PROOF_VERSION) {
    throw new Error(`encodeProofRecord: refusing to emit version ${JSON.stringify(record.version)}`);
  }
  assertIat(record.iat);
  if (!isHex32(record.pubkey))
    throw new Error("encodeProofRecord: pubkey must be 64 lowercase hex characters");
  if (!isHex64(record.sig))
    throw new Error("encodeProofRecord: sig must be 128 lowercase hex characters");
  return `${record.version}.${record.iat}.${record.pubkey}.${record.sig}`;
}
function parseProofRecord(raw) {
  if (typeof raw !== "string")
    return { ok: false, reason: "not a string" };
  const cleaned = raw.trim().replace(/"/g, "").trim();
  if (cleaned === "")
    return { ok: false, reason: "empty" };
  const fields = cleaned.toLowerCase().split(/[\s.]+/).filter((f) => f !== "");
  if (fields.length !== 4) {
    return { ok: false, reason: `expected 4 fields, found ${fields.length}` };
  }
  const [version, iatText, pubkey, sig] = fields;
  if (version !== PROOF_VERSION) {
    return { ok: false, reason: `unknown version ${JSON.stringify(version)}` };
  }
  if (!/^\d{1,10}$/.test(iatText)) {
    return { ok: false, reason: "iat is not decimal unix seconds" };
  }
  const iat = Number(iatText);
  if (!Number.isSafeInteger(iat))
    return { ok: false, reason: "iat is out of range" };
  if (!isHex32(pubkey))
    return { ok: false, reason: "pubkey is not 64 hex characters" };
  if (!isHex64(sig))
    return { ok: false, reason: "sig is not 128 hex characters" };
  return { ok: true, record: { version, iat, pubkey, sig } };
}
function verifyProofRecord(params) {
  const normalised = tryNormaliseDomain(params.domain);
  if (!normalised.ok)
    return { ok: false, reason: `domain: ${normalised.reason}` };
  if (!isHex32(params.pubkey))
    return { ok: false, reason: "pubkey is not 64 lowercase hex characters" };
  let record;
  if (typeof params.record === "string") {
    const parsed = parseProofRecord(params.record);
    if (!parsed.ok)
      return { ok: false, reason: parsed.reason };
    record = parsed.record;
  } else {
    record = params.record;
  }
  if (record.pubkey !== params.pubkey) {
    return { ok: false, reason: "record is for a different pubkey", record };
  }
  const ageSeconds = params.now === undefined ? undefined : params.now - record.iat;
  if (ageSeconds !== undefined && ageSeconds < -MAX_CLOCK_SKEW_SECONDS) {
    return {
      ok: false,
      reason: `dated ${-ageSeconds} seconds in the future`,
      record,
      ageSeconds
    };
  }
  const digest = proofDigest({ domain: normalised.domain, pubkey: record.pubkey, iat: record.iat });
  if (!verifyDigestSignature(record.sig, digest, record.pubkey)) {
    return { ok: false, reason: "signature does not verify", record, ageSeconds };
  }
  return { ok: true, record, ageSeconds };
}
function verifyProofRecords(params) {
  const rejected = [];
  let best;
  for (const value of params.records) {
    const result = verifyProofRecord({ ...params, record: value });
    if (!result.ok) {
      rejected.push({ value, reason: result.reason ?? "rejected" });
      continue;
    }
    if (!best || result.record.iat > best.record.iat)
      best = result;
  }
  return {
    ...best ?? { ok: false, reason: rejected.length ? "no record verified" : "no records found" },
    checked: params.records.length,
    rejected
  };
}
function proofFromEvent(event) {
  if (event.kind !== PROOF_KIND)
    return { ok: false, reason: `kind ${event.kind} is not ${PROOF_KIND}` };
  const d = tagValue(event, "d");
  if (!d || !d.startsWith(PROOF_D_PREFIX)) {
    return { ok: false, reason: `d tag ${JSON.stringify(d ?? null)} is not a ${PROOF_D_PREFIX}* identifier` };
  }
  const claimed = tryNormaliseDomain(d.slice(PROOF_D_PREFIX.length));
  if (!claimed.ok)
    return { ok: false, reason: `d tag domain: ${claimed.reason}` };
  if (d !== PROOF_D_PREFIX + claimed.domain) {
    return { ok: false, reason: "d tag is not in normalised form" };
  }
  const expected = proofEvent({ domain: claimed.domain, pubkey: event.pubkey, iat: event.created_at });
  if (event.content !== expected.content) {
    return { ok: false, reason: "content is not the canonical proof message for this domain and timestamp" };
  }
  if (!isHex64(event.sig))
    return { ok: false, reason: "sig is not 128 lowercase hex characters" };
  const digest = eventDigest(expected);
  if (!verifyDigestSignature(event.sig, digest, event.pubkey)) {
    return { ok: false, reason: "signature does not verify" };
  }
  return {
    ok: true,
    domain: claimed.domain,
    record: { version: PROOF_VERSION, iat: event.created_at, pubkey: event.pubkey, sig: event.sig }
  };
}
async function createProof(params) {
  const domain = normaliseDomain(params.domain);
  const pubkey = (await params.signer.getPublicKey()).toLowerCase();
  const unsigned = proofEvent({ domain, pubkey, iat: params.iat });
  const event = await params.signer.signEvent(unsigned);
  const check = proofFromEvent(event);
  if (!check.ok)
    throw new Error(`createProof: the signer returned an event that does not verify: ${check.reason}`);
  if (check.domain !== domain)
    throw new Error("createProof: the signer changed the domain");
  return { domain, record: check.record, txt: encodeProofRecord(check.record), event };
}
function assertIat(iat) {
  if (!Number.isSafeInteger(iat) || iat < 0) {
    throw new Error(`iat must be a non-negative integer of unix seconds, got ${JSON.stringify(iat)}`);
  }
  if (iat > 9999999999) {
    throw new Error(`iat ${iat} exceeds 10 decimal digits, which the record format cannot carry`);
  }
}
// core/oracle/nip05.ts
var ROOT_NAME = "_";
function nip05DocumentUrl(domain, name = ROOT_NAME) {
  return `https://${normaliseDomain(domain)}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
}
function parseNip05Identifier(raw) {
  if (typeof raw !== "string")
    return { ok: false, reason: "not a string" };
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "")
    return { ok: false, reason: "empty" };
  const at = trimmed.lastIndexOf("@");
  const name = at === -1 ? ROOT_NAME : trimmed.slice(0, at);
  const domainPart = at === -1 ? trimmed : trimmed.slice(at + 1);
  if (!/^[a-z0-9\-_.]+$/.test(name)) {
    return { ok: false, reason: `"${name}" is not a valid NIP-05 local part` };
  }
  const domain = tryNormaliseDomain(domainPart);
  if (!domain.ok)
    return { ok: false, reason: `domain: ${domain.reason}` };
  return { ok: true, name, domain: domain.domain, identifier: `${name}@${domain.domain}` };
}
function namesForPubkey(document, pubkey) {
  if (!isHex32(pubkey))
    return [];
  if (typeof document !== "object" || document === null)
    return [];
  const names = document.names;
  if (typeof names !== "object" || names === null)
    return [];
  const matches = [];
  for (const [name, value] of Object.entries(names)) {
    if (typeof value === "string" && value.toLowerCase() === pubkey)
      matches.push(name);
  }
  return matches;
}
function verifyNip05(params) {
  const domain = tryNormaliseDomain(params.domain);
  if (!domain.ok)
    return { ok: false, reason: `domain: ${domain.reason}` };
  if (!isHex32(params.pubkey))
    return { ok: false, reason: "pubkey is not 64 lowercase hex characters" };
  const names = namesForPubkey(params.document, params.pubkey);
  if (names.length === 0) {
    return { ok: false, reason: "no name in this document maps to that pubkey" };
  }
  const ordered = names.includes(ROOT_NAME) ? [ROOT_NAME, ...names.filter((n) => n !== ROOT_NAME)] : names;
  const best = ordered[0];
  return {
    ok: true,
    names: ordered,
    identifier: best === ROOT_NAME ? domain.domain : `${best}@${domain.domain}`
  };
}
function relayHints(document, pubkey) {
  if (!isHex32(pubkey))
    return [];
  if (typeof document !== "object" || document === null)
    return [];
  const relays = document.relays;
  if (typeof relays !== "object" || relays === null)
    return [];
  const list = relays[pubkey];
  if (!Array.isArray(list))
    return [];
  return list.filter((r) => typeof r === "string" && /^wss?:\/\//i.test(r));
}
// core/oracle/rdap.ts
var SECONDS_PER_DAY = 86400;
var TRANSFER_LOCK_DAYS = 60;
var MIN_EXPIRY_DAYS = 45;
var RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
function rdapBaseUrls(bootstrap, domain) {
  const d = tryNormaliseDomain(domain);
  if (!d.ok)
    return [];
  if (typeof bootstrap !== "object" || bootstrap === null)
    return [];
  const services = bootstrap.services;
  if (!Array.isArray(services))
    return [];
  const labels = d.domain.split(".");
  let bestLength = -1;
  let best = [];
  for (const service of services) {
    if (!Array.isArray(service) || service.length < 2)
      continue;
    const [entries, urls] = service;
    if (!Array.isArray(entries) || !Array.isArray(urls))
      continue;
    for (const entry of entries) {
      if (typeof entry !== "string")
        continue;
      const suffix = entry.toLowerCase().replace(/^\.|\.$/g, "");
      if (suffix === "")
        continue;
      const suffixLabels = suffix.split(".");
      if (suffixLabels.length >= labels.length)
        continue;
      const tail = labels.slice(labels.length - suffixLabels.length).join(".");
      if (tail !== suffix)
        continue;
      if (suffixLabels.length > bestLength) {
        bestLength = suffixLabels.length;
        best = urls.filter((u) => typeof u === "string");
      }
    }
  }
  return best.map((u) => u.endsWith("/") ? u : `${u}/`);
}
function rdapDomainUrl(baseUrl, domain) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}domain/${normaliseDomain(domain)}`;
}
function tldHasRdap(bootstrap, domain) {
  return rdapBaseUrls(bootstrap, domain).length > 0;
}
function foldStatus(value) {
  return value.toLowerCase().replace(/[\s\-_]/g, "");
}
var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}[Tt]/;
function parseDate(value) {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value))
    return;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}
function lastEvent(events, action) {
  let latest;
  for (const e of events) {
    if (foldStatus(e.action) !== foldStatus(action) || e.unix === undefined)
      continue;
    if (latest === undefined || e.unix > latest)
      latest = e.unix;
  }
  return latest;
}
function parseRdapDomain(response) {
  const r = typeof response === "object" && response !== null ? response : {};
  const rawStatuses = Array.isArray(r.status) ? r.status.filter((s) => typeof s === "string") : [];
  const events = (Array.isArray(r.events) ? r.events : []).filter((e) => typeof e === "object" && e !== null).map((e) => ({
    action: typeof e.eventAction === "string" ? e.eventAction : "",
    date: typeof e.eventDate === "string" ? e.eventDate : "",
    unix: parseDate(e.eventDate)
  }));
  const ldh = typeof r.ldhName === "string" ? r.ldhName : typeof r.unicodeName === "string" ? r.unicodeName : undefined;
  const parsedDomain = ldh ? tryNormaliseDomain(ldh) : undefined;
  const registrar = findRegistrar(r.entities);
  const nameservers = (Array.isArray(r.nameservers) ? r.nameservers : []).map((ns) => typeof ns === "object" && ns !== null ? ns.ldhName : undefined).filter((n) => typeof n === "string").map((n) => n.toLowerCase().replace(/\.$/, "")).sort();
  return {
    domain: parsedDomain && parsedDomain.ok ? parsedDomain.domain : undefined,
    statuses: rawStatuses.map(foldStatus),
    rawStatuses,
    events,
    registration: lastEvent(events, "registration"),
    expiration: lastEvent(events, "expiration"),
    lastTransfer: lastEvent(events, "transfer"),
    lastChanged: lastEvent(events, "last changed"),
    registrarName: registrar.name,
    registrarIanaId: registrar.ianaId,
    nameservers,
    hasRedaction: Array.isArray(r.redacted) && r.redacted.length > 0
  };
}
function findRegistrar(entities) {
  if (!Array.isArray(entities))
    return {};
  for (const entity of entities) {
    if (typeof entity !== "object" || entity === null)
      continue;
    const e = entity;
    const roles = Array.isArray(e.roles) ? e.roles.map((x) => String(x).toLowerCase()) : [];
    if (!roles.includes("registrar"))
      continue;
    let ianaId;
    if (Array.isArray(e.publicIds)) {
      for (const pid of e.publicIds) {
        if (typeof pid !== "object" || pid === null)
          continue;
        const p = pid;
        if (typeof p.type === "string" && /iana/i.test(p.type) && p.identifier !== undefined) {
          ianaId = String(p.identifier);
        }
      }
    }
    return { name: vcardName(e.vcardArray), ianaId };
  }
  return {};
}
function vcardName(vcardArray) {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2)
    return;
  const properties = vcardArray[1];
  if (!Array.isArray(properties))
    return;
  for (const property of properties) {
    if (!Array.isArray(property) || property.length < 4)
      continue;
    if (property[0] === "fn" && typeof property[3] === "string")
      return property[3];
  }
  return;
}
var REFUSING_STATUSES = [
  "pendingdelete",
  "redemptionperiod",
  "servertransferprohibited",
  "pendingrenew",
  "pendingrestore"
];
var WARNING_STATUSES = ["clienthold", "serverhold", "inactive", "pendingupdate"];
var TRANSFER_LOCK_STATUS = "clienttransferprohibited";
var PENDING_TRANSFER_STATUS = "pendingtransfer";
function checkEligibility(params) {
  const facts = parseRdapDomain(params.response);
  const findings = [];
  const days = (from) => from === undefined ? undefined : (params.now - from) / SECONDS_PER_DAY;
  const domain = tryNormaliseDomain(params.domain);
  if (domain.ok && facts.domain && facts.domain !== domain.domain) {
    findings.push({
      level: "refuse",
      code: "domain-mismatch",
      message: `the registry answered about ${facts.domain}, not ${domain.domain}`
    });
  }
  if (params.bootstrap !== undefined && domain.ok && !tldHasRdap(params.bootstrap, domain.domain)) {
    findings.push({
      level: "refuse",
      code: "no-rdap",
      message: `.${tldOf(domain.domain)} publishes no RDAP service, so nothing about this name can be verified`
    });
  }
  for (const status of REFUSING_STATUSES) {
    if (facts.statuses.includes(status)) {
      findings.push({ level: "refuse", code: `status:${status}`, message: `registry status ${status}` });
    }
  }
  for (const status of WARNING_STATUSES) {
    if (facts.statuses.includes(status)) {
      findings.push({ level: "warn", code: `status:${status}`, message: `registry status ${status}` });
    }
  }
  const daysSinceRegistration = days(facts.registration);
  const daysSinceTransfer = days(facts.lastTransfer);
  const daysUntilExpiry = facts.expiration === undefined ? undefined : (facts.expiration - params.now) / SECONDS_PER_DAY;
  if (daysSinceRegistration !== undefined && daysSinceRegistration < TRANSFER_LOCK_DAYS) {
    findings.push({
      level: "refuse",
      code: "transfer-lock:registration",
      message: `registered ${Math.floor(daysSinceRegistration)} days ago; ICANN locks transfers for ${TRANSFER_LOCK_DAYS}`
    });
  }
  if (daysSinceTransfer !== undefined && daysSinceTransfer < TRANSFER_LOCK_DAYS) {
    findings.push({
      level: "refuse",
      code: "transfer-lock:transfer",
      message: `transferred ${Math.floor(daysSinceTransfer)} days ago; ICANN locks transfers for ${TRANSFER_LOCK_DAYS}`
    });
  }
  if (daysUntilExpiry !== undefined) {
    if (daysUntilExpiry < 0) {
      findings.push({
        level: "refuse",
        code: "expired",
        message: `expired ${Math.floor(-daysUntilExpiry)} days ago`
      });
    } else if (daysUntilExpiry < MIN_EXPIRY_DAYS) {
      findings.push({
        level: "refuse",
        code: "expiring",
        message: `expires in ${Math.floor(daysUntilExpiry)} days; a sale inside ${MIN_EXPIRY_DAYS} days raises who pays the renewal`
      });
    }
  } else {
    findings.push({
      level: "warn",
      code: "no-expiry",
      message: "the registry published no expiration date, so the expiry rule could not be applied"
    });
  }
  if (facts.registration === undefined) {
    findings.push({
      level: "warn",
      code: "no-registration",
      message: "the registry published no registration date, so age could not be checked"
    });
  }
  const pendingTransfer = facts.statuses.includes(PENDING_TRANSFER_STATUS);
  if (pendingTransfer) {
    findings.push({
      level: "warn",
      code: "pending-transfer",
      message: "a transfer is already underway on this name"
    });
  }
  return {
    listable: !findings.some((f) => f.level === "refuse"),
    unlocked: !facts.statuses.includes(TRANSFER_LOCK_STATUS),
    pendingTransfer,
    findings,
    facts,
    daysUntilExpiry,
    daysSinceRegistration,
    daysSinceTransfer
  };
}
function fingerprintOf(facts) {
  return { registrarIanaId: facts.registrarIanaId, nameservers: facts.nameservers.slice() };
}
function fingerprintMatches(observed, committed) {
  if (committed.registrarIanaId && observed.registrarIanaId === committed.registrarIanaId)
    return true;
  if (committed.nameservers.length === 0)
    return false;
  const set = new Set(observed.nameservers);
  return committed.nameservers.every((ns) => set.has(ns));
}
function snapshotHash(rawResponseText) {
  return bytesToHex(sha256(utf8ToBytes(rawResponseText)));
}

// core/oracle/index.ts
function combineProofs(params) {
  const base = { domain: params.domain, pubkey: params.pubkey };
  if (params.dns?.ok) {
    return { ...base, proven: true, source: "dns", iat: params.dns.record?.iat };
  }
  if (params.nip05?.ok) {
    return { ...base, proven: true, source: "nip05" };
  }
  return {
    ...base,
    proven: false,
    reason: params.dns?.reason ?? params.nip05?.reason ?? "no proof was checked"
  };
}
// node_modules/@scure/base/index.js
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var freeze = (fn) => Object.freeze(fn());
function isBytes3(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
function abytes3(b) {
  if (!isBytes3(b))
    throw new TypeError("Uint8Array expected");
}
function isArrayOf(isString, arr) {
  if (!Array.isArray(arr))
    return false;
  if (arr.length === 0)
    return true;
  if (isString) {
    return arr.every((item) => typeof item === "string");
  } else {
    return arr.every((item) => Number.isSafeInteger(item));
  }
}
function afn(input) {
  if (typeof input !== "function")
    throw new TypeError("function expected");
  return true;
}
function astr(label, input) {
  if (typeof input !== "string")
    throw new TypeError(`${label}: string expected`);
  return true;
}
function anumber3(n, title = "number") {
  if (typeof n !== "number")
    throw new TypeError(`${title}: expected number, got ${typeof n}`);
  if (!Number.isSafeInteger(n))
    throw new RangeError(`${title}: expected safe integer, got ${n}`);
}
function anumArr(label, input) {
  if (!isArrayOf(false, input))
    throw new TypeError(`${label}: array of numbers expected`);
}
function chain(...args) {
  const id = (a) => a;
  const wrap = (a, b) => (c) => a(b(c));
  const encode = args.map((x) => x.encode).reduceRight(wrap, id);
  const decode = args.map((x) => x.decode).reduce(wrap, id);
  return { encode, decode };
}
var powers = /* @__PURE__ */ (() => {
  let res = [];
  for (let i = 0;i < 40; i++)
    res.push(2 ** i);
  return res;
})();
function u8ToNumArr(u8, len = u8.length) {
  const res = new Array(len);
  for (let i = 0;i < len; i++)
    res[i] = u8[i];
  return res;
}
var asciiDecoder = /* @__PURE__ */ (() => {
  try {
    const decoder = new TextDecoder;
    return decoder.decode(Uint8Array.of(65, 48, 43, 127)) === "A0+" ? decoder : undefined;
  } catch (e) {
    return;
  }
})();
var B2S_CHUNK = 8192;
function charcodesToString(codes) {
  const len = codes.length;
  if (asciiDecoder !== undefined && len >= 12)
    return asciiDecoder.decode(codes);
  if (len <= B2S_CHUNK)
    return String.fromCharCode.apply(null, codes);
  let res = "";
  for (let i = 0;i < len; i += B2S_CHUNK)
    res += String.fromCharCode.apply(null, codes.subarray(i, i + B2S_CHUNK));
  return res;
}
function radix2(bits) {
  anumber3(bits);
  if (bits <= 0 || bits > 8)
    throw new RangeError("radix2: bits should be in (0..8]");
  const mask = powers[bits] - 1;
  return {
    encode: (bytes) => {
      abytes3(bytes);
      const len = bytes.length;
      const res = new Uint8Array(Math.ceil(len * 8 / bits));
      let carry = 0;
      let pos = 0;
      let j = 0;
      for (let i = 0;i < len; ) {
        if (i + 2 < len) {
          carry = carry << 24 | bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
          pos += 24;
          i += 3;
        } else {
          carry = (carry << 8 | bytes[i]) & 65535;
          pos += 8;
          i++;
        }
        for (;; ) {
          pos -= bits;
          res[j++] = carry >> pos & mask;
          if (pos < bits)
            break;
        }
      }
      if (pos > 0)
        res[j] = carry << bits - pos & mask;
      return res;
    },
    decode: (digits) => {
      const len = digits.length;
      const res = new Uint8Array(Math.floor(len * bits / 8));
      let carry = 0;
      let pos = 0;
      let j = 0;
      for (let i = 0;i < len; i++) {
        carry = (carry << bits | digits[i]) & 65535;
        pos += bits;
        for (;pos >= 8; pos -= 8)
          res[j++] = carry >> pos - 8 & 255;
      }
      carry = carry << 8 - pos & 255;
      if (pos >= bits)
        throw new Error("Excess padding");
      if (carry > 0)
        throw new Error(`Non-zero padding: ${carry}`);
      return res;
    }
  };
}
function alphabet(letters, aliases) {
  const len = letters.length;
  if (len > 128)
    throw new Error("alphabet: max 128 letters");
  const encTable = new Uint8Array(len);
  const decTable = new Int8Array(128).fill(-1);
  for (let i = 0;i < len; i++) {
    const code = letters.charCodeAt(i);
    if (letters.codePointAt(i) !== code || code > 127)
      throw new Error("alphabet: single-char ASCII letters only");
    encTable[i] = code;
    decTable[code] = i;
  }
  if (aliases !== undefined) {
    for (const alias of Object.keys(aliases)) {
      const code = alias.charCodeAt(0);
      const target = decTable[aliases[alias].charCodeAt(0)];
      if (alias.length !== 1 || code > 127 || target === undefined || target === -1)
        throw new Error(`alphabet: invalid alias ${alias}`);
      decTable[code] = target;
    }
  }
  return {
    encode: (digits) => {
      const codes = new Uint8Array(digits.length);
      for (let i = 0;i < digits.length; i++) {
        const d = digits[i];
        const code = encTable[d];
        if (code === undefined)
          throw new Error(`alphabet.encode: invalid digit ${d}`);
        codes[i] = code;
      }
      return charcodesToString(codes);
    },
    decode: (input) => {
      astr("decode", input);
      const slen = input.length;
      const digits = new Uint8Array(slen);
      for (let i = 0;i < slen; i++) {
        const code = input.charCodeAt(i);
        const digit = code < 128 ? decTable[code] : -1;
        if (digit === -1)
          throw new Error(`Unknown letter "${input[i]}". Allowed: ${letters}`);
        digits[i] = digit;
      }
      return digits;
    }
  };
}
function padding(bits, chr = "=") {
  anumber3(bits);
  astr("padding", chr);
  return {
    encode(data) {
      while (data.length * bits % 8)
        data += chr;
      return data;
    },
    decode(input) {
      astr("decode", input);
      let end = input.length;
      if (end * bits % 8)
        throw new Error("padding: invalid length");
      for (;end > 0 && input[end - 1] === chr; end--) {
        const byte = (end - 1) * bits;
        if (byte % 8 === 0)
          throw new Error("padding: excess padding");
      }
      return input.slice(0, end);
    }
  };
}
function unsafeWrapper(fn) {
  afn(fn);
  return function(...args) {
    try {
      return fn.apply(null, args);
    } catch (e) {}
  };
}
function checksum(len, fn) {
  anumber3(len);
  if (len <= 0)
    throw new RangeError(`checksum length must be positive: ${len}`);
  afn(fn);
  const _fn = fn;
  return {
    encode(data) {
      abytes3(data);
      const sum = _fn(data).slice(0, len);
      const res = new Uint8Array(data.length + len);
      res.set(data);
      res.set(sum, data.length);
      return res;
    },
    decode(data) {
      abytes3(data);
      const payload = data.slice(0, -len);
      const oldChecksum = data.slice(-len);
      const newChecksum = _fn(payload).slice(0, len);
      for (let i = 0;i < len; i++)
        if (newChecksum[i] !== oldChecksum[i])
          throw new Error("Invalid checksum");
      return payload;
    }
  };
}
var hasBase64Builtin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toBase64 === "function" && typeof Uint8Array.fromBase64 === "function")();
var ASCII_WHITESPACE = /[\t\n\f\r ]/;
var decodeBase64Builtin = (s, isUrl) => {
  astr("base64", s);
  const alphabet2 = isUrl ? "base64url" : "base64";
  if (s.length > 0 && ASCII_WHITESPACE.test(s))
    throw new Error("invalid base64");
  return Uint8Array.fromBase64(s, { alphabet: alphabet2, lastChunkHandling: "strict" });
};
var base64Fallback = /* @__PURE__ */ freeze(() => chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"), padding(6)));
var base64 = /* @__PURE__ */ freeze(() => hasBase64Builtin ? {
  encode(b) {
    abytes3(b);
    return b.toBase64();
  },
  decode(s) {
    return decodeBase64Builtin(s, false);
  }
} : base64Fallback);
var base64urlnopad = /* @__PURE__ */ freeze(() => chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")));
var B58_GROUP = 656356768;
var RADIX_BASE_N_MAX_LENGTH = 65536;
var BASE_N_MAX_BYTES = 2048;
var BASE_N_MAX_CHARS = 4096;
var radixBaseN = (BASE2, GROUP) => ({
  encode: (bytes) => {
    abytes3(bytes);
    const blen = bytes.length;
    if (blen === 0)
      return new Uint8Array(0);
    if (blen >= RADIX_BASE_N_MAX_LENGTH)
      throw new Error("invalid length");
    let zeros = 0;
    while (zeros < blen - 1 && bytes[zeros] === 0)
      zeros++;
    const nlimbs = Math.ceil(blen / 2);
    const limbs = new Uint16Array(nlimbs);
    const odd = blen & 1;
    if (odd)
      limbs[0] = bytes[0];
    for (let i = odd, j2 = odd;i < blen; i += 2, j2++)
      limbs[j2] = bytes[i] << 8 | bytes[i + 1];
    const groups = [];
    let pos = 0;
    while (pos < nlimbs) {
      let carry = 0;
      for (let i = pos;i < nlimbs; i++) {
        const cur = carry * 65536 + limbs[i];
        const q = Math.floor(cur / GROUP);
        carry = cur - q * GROUP;
        limbs[i] = q;
        if (q === 0 && i === pos)
          pos++;
      }
      groups.push(carry);
    }
    const top = groups.length - 1;
    let sig = top * 5;
    for (let v = groups[top];; v = Math.floor(v / BASE2)) {
      sig++;
      if (v < BASE2)
        break;
    }
    const res = new Uint8Array(zeros + sig);
    let j = res.length - 1;
    for (let g = 0;g < top; g++) {
      let v = groups[g];
      for (let k = 0;k < 5; k++) {
        res[j--] = v % BASE2;
        v = Math.floor(v / BASE2);
      }
    }
    for (let v = groups[top];j >= zeros; v = Math.floor(v / BASE2))
      res[j--] = v % BASE2;
    return res;
  },
  decode: (digits) => {
    abytes3(digits);
    const dlen = digits.length;
    if (dlen === 0)
      return new Uint8Array(0);
    if (dlen >= RADIX_BASE_N_MAX_LENGTH)
      throw new Error("invalid length");
    let zeros = 0;
    while (zeros < dlen - 1 && digits[zeros] === 0)
      zeros++;
    const limbs = new Uint16Array(Math.ceil(dlen * 6 / 16) + 1);
    let used = 0;
    let i = 0;
    let group = dlen % 5 || 5;
    while (i < dlen) {
      let gval = 0;
      let factor = 1;
      for (const end = i + group;i < end; i++) {
        const d = digits[i];
        if (d >= BASE2)
          throw new Error(`invalid integer: ${d}`);
        gval = gval * BASE2 + d;
        factor *= BASE2;
      }
      group = 5;
      let carry = gval;
      for (let k = 0;k < used; k++) {
        const cur = limbs[k] * factor + carry;
        carry = Math.floor(cur / 65536);
        limbs[k] = cur - carry * 65536;
      }
      for (;carry > 0; carry = Math.floor(carry / 65536))
        limbs[used++] = carry % 65536;
    }
    const valueBytes = used === 0 ? 1 : used * 2 - (limbs[used - 1] < 256 ? 1 : 0);
    const res = new Uint8Array(zeros + valueBytes);
    let j = res.length - 1;
    for (let k = 0;k < used; k++) {
      const limb = limbs[k];
      res[j--] = limb & 255;
      if (j >= zeros)
        res[j--] = limb >> 8;
    }
    return res;
  }
});
var genBaseN = (radix, abc) => {
  const letters = alphabet(abc);
  return {
    encode(bytes) {
      abytes3(bytes);
      if (bytes.length > BASE_N_MAX_BYTES)
        throw new Error("invalid length");
      return letters.encode(radix.encode(bytes));
    },
    decode(str) {
      astr("baseN.decode", str);
      if (str.length > BASE_N_MAX_CHARS)
        throw new Error("invalid length");
      return radix.decode(letters.decode(str));
    }
  };
};
var radix58 = /* @__PURE__ */ radixBaseN(58, B58_GROUP);
var genBase58 = (abc) => genBaseN(radix58, abc);
var base58 = /* @__PURE__ */ freeze(() => genBase58("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"));
var createBase58check = (sha2562) => {
  afn(sha2562);
  const _sha256 = sha2562;
  return chain(checksum(4, (data) => _sha256(_sha256(data))), base58);
};
var BECH_ALPHABET = /* @__PURE__ */ alphabet("qpzry9x8gf2tvdw0s3jn54khce6mua7l");
var BECH_UPPERCASE_PRINTABLE = /^[\x21-\x60\x7b-\x7e]+$/;
function assertBech32Printable(label, value) {
  for (let i = 0;i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 33 || c > 126)
      throw new Error(`${label}: printable ASCII expected`);
  }
}
function wordsToU8(words) {
  const len = words.length;
  const res = new Uint8Array(len);
  for (let i = 0;i < len; i++) {
    const w = words[i];
    if (w < 0 || w >= 32)
      throw new Error(`alphabet.encode: invalid digit ${w}`);
    res[i] = w;
  }
  return res;
}
var POLYMOD_GENERATORS = [996825010, 642813549, 513874426, 1027748829, 705979059];
function bech32Polymod(pre) {
  const b = pre >> 25;
  let chk = (pre & 33554431) << 5;
  for (let i = 0;i < POLYMOD_GENERATORS.length; i++) {
    if ((b >> i & 1) === 1)
      chk ^= POLYMOD_GENERATORS[i];
  }
  return chk;
}
function bechChecksum(prefix, words, encodingConst = 1) {
  const len = prefix.length;
  let chk = 1;
  for (let i = 0;i < len; i++) {
    const c = prefix.charCodeAt(i);
    if (c < 33 || c > 126)
      throw new Error(`Invalid prefix (${prefix})`);
    chk = bech32Polymod(chk) ^ c >> 5;
  }
  chk = bech32Polymod(chk);
  for (let i = 0;i < len; i++)
    chk = bech32Polymod(chk) ^ prefix.charCodeAt(i) & 31;
  for (let v of words)
    chk = bech32Polymod(chk) ^ v;
  for (let i = 0;i < 6; i++)
    chk = bech32Polymod(chk);
  chk ^= encodingConst;
  const sum = new Uint8Array(6);
  for (let i = 0;i < 6; i++)
    sum[i] = chk >>> 5 * (5 - i) & 31;
  return BECH_ALPHABET.encode(sum);
}
function genBech32(encoding) {
  const ENCODING_CONST = encoding === "bech32" ? 1 : 734539939;
  const _words = radix2(5);
  const toWords = (from) => {
    abytes3(from);
    const len = from.length;
    const res = new Array(Math.ceil(len * 8 / 5));
    let carry = 0;
    let pos = 0;
    let j = 0;
    for (let i = 0;i < len; i++) {
      carry = carry << 8 | from[i];
      pos += 8;
      for (;pos >= 5; pos -= 5)
        res[j++] = carry >> pos - 5 & 31;
    }
    if (pos > 0)
      res[j] = carry << 5 - pos & 31;
    return res;
  };
  const fromWords = (to) => {
    anumArr("radix2.decode", to);
    const len = to.length;
    const digits = new Uint8Array(len);
    for (let i = 0;i < len; i++) {
      const w = to[i];
      if (w < 0 || w >= 32)
        throw new Error(`convertRadix2: invalid word=${w}`);
      digits[i] = w;
    }
    return _words.decode(digits);
  };
  const fromWordsUnsafe = unsafeWrapper(fromWords);
  function encode(prefix, words, limit = 90) {
    astr("bech32.encode prefix", prefix);
    if (limit !== false)
      anumber3(limit, "limit");
    if (isBytes3(words))
      words = u8ToNumArr(words);
    anumArr("bech32.encode", words);
    const plen = prefix.length;
    if (plen === 0)
      throw new TypeError(`Invalid prefix length ${plen}`);
    const actualLength = plen + 7 + words.length;
    if (limit !== false && actualLength > limit)
      throw new TypeError(`Length ${actualLength} exceeds limit ${limit}`);
    assertBech32Printable("bech32.encode prefix", prefix);
    const lowered = prefix.toLowerCase();
    const sum = bechChecksum(lowered, words, ENCODING_CONST);
    return `${lowered}1${BECH_ALPHABET.encode(wordsToU8(words))}${sum}`;
  }
  function decode(str, limit = 90) {
    astr("bech32.decode input", str);
    if (limit !== false)
      anumber3(limit, "limit");
    const slen = str.length;
    if (slen < 8 || limit !== false && slen > limit)
      throw new TypeError(`invalid string length ${slen}, expected (8..${limit})`);
    const lowered = str.toLowerCase();
    if (str !== lowered) {
      if (!BECH_UPPERCASE_PRINTABLE.test(str)) {
        assertBech32Printable("bech32.decode input", str);
        throw new Error(`mixed-case string not allowed`);
      }
    }
    const sepIndex = lowered.lastIndexOf("1");
    if (sepIndex === 0 || sepIndex === -1)
      throw new Error(`invalid separator "1"`);
    const prefix = lowered.slice(0, sepIndex);
    const data = lowered.slice(sepIndex + 1);
    if (data.length < 6)
      throw new Error("invalid data length");
    const digits = BECH_ALPHABET.decode(data);
    const words = u8ToNumArr(digits, digits.length - 6);
    const sum = bechChecksum(prefix, words, ENCODING_CONST);
    if (!data.endsWith(sum))
      throw new Error(`Invalid checksum in ${str}`);
    return { prefix, words };
  }
  const decodeUnsafe = unsafeWrapper(decode);
  function decodeToBytes(str, limit = 90) {
    const { prefix, words } = decode(str, limit);
    return {
      prefix,
      words,
      bytes: fromWords(words)
    };
  }
  function encodeFromBytes(prefix, bytes) {
    return encode(prefix, toWords(bytes));
  }
  return {
    encode,
    decode,
    encodeFromBytes,
    decodeToBytes,
    decodeUnsafe,
    fromWords,
    fromWordsUnsafe,
    toWords
  };
}
var bech32 = /* @__PURE__ */ freeze(() => genBech32("bech32"));
var bech32m = /* @__PURE__ */ freeze(() => genBech32("bech32m"));

// core/nostr/nip19.ts
var BECH32_LIMIT = 5000;
var TLV_SPECIAL = 0;
var TLV_RELAY = 1;
var TLV_AUTHOR = 2;
var TLV_KIND = 3;
function encodeBytes(prefix, bytes) {
  return bech32.encode(prefix, bech32.toWords(bytes), BECH32_LIMIT);
}
function npubEncode(pubkeyHex) {
  if (!isHex32(pubkeyHex))
    throw new Error(`npubEncode: expected 64 lowercase hex characters, got ${JSON.stringify(pubkeyHex)}`);
  return encodeBytes("npub", hexToBytes(pubkeyHex));
}
function noteEncode(idHex) {
  if (!isHex32(idHex))
    throw new Error(`noteEncode: expected 64 lowercase hex characters, got ${JSON.stringify(idHex)}`);
  return encodeBytes("note", hexToBytes(idHex));
}
function nsecEncode(secretKey) {
  if (secretKey.length !== 32)
    throw new Error("nsecEncode: a secret key is 32 bytes");
  return encodeBytes("nsec", secretKey);
}
function tlv(type, value) {
  if (value.length > 255) {
    throw new Error(`nip19: a TLV value of ${value.length} bytes does not fit in one length byte`);
  }
  const out = new Uint8Array(2 + value.length);
  out[0] = type;
  out[1] = value.length;
  out.set(value, 2);
  return out;
}
function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function relayParts(relays) {
  return (relays ?? []).map((r) => tlv(TLV_RELAY, utf8ToBytes(r)));
}
function kindBytes(kind) {
  if (!Number.isInteger(kind) || kind < 0 || kind > 4294967295) {
    throw new Error(`nip19: kind must be a uint32, got ${kind}`);
  }
  return Uint8Array.of(kind >>> 24 & 255, kind >>> 16 & 255, kind >>> 8 & 255, kind & 255);
}
function nprofileEncode(pointer) {
  if (!isHex32(pointer.pubkey))
    throw new Error("nprofileEncode: pubkey must be 64 lowercase hex characters");
  return encodeBytes("nprofile", concat([tlv(TLV_SPECIAL, hexToBytes(pointer.pubkey)), ...relayParts(pointer.relays)]));
}
function neventEncode(pointer) {
  if (!isHex32(pointer.id))
    throw new Error("neventEncode: id must be 64 lowercase hex characters");
  const parts = [tlv(TLV_SPECIAL, hexToBytes(pointer.id)), ...relayParts(pointer.relays)];
  if (pointer.author !== undefined) {
    if (!isHex32(pointer.author))
      throw new Error("neventEncode: author must be 64 lowercase hex characters");
    parts.push(tlv(TLV_AUTHOR, hexToBytes(pointer.author)));
  }
  if (pointer.kind !== undefined)
    parts.push(tlv(TLV_KIND, kindBytes(pointer.kind)));
  return encodeBytes("nevent", concat(parts));
}
function naddrEncode(pointer) {
  if (!isHex32(pointer.pubkey))
    throw new Error("naddrEncode: pubkey must be 64 lowercase hex characters");
  return encodeBytes("naddr", concat([
    tlv(TLV_SPECIAL, utf8ToBytes(pointer.identifier)),
    ...relayParts(pointer.relays),
    tlv(TLV_AUTHOR, hexToBytes(pointer.pubkey)),
    tlv(TLV_KIND, kindBytes(pointer.kind))
  ]));
}
function parseTlv(bytes) {
  const found = new Map;
  let at = 0;
  while (at < bytes.length) {
    if (at + 2 > bytes.length)
      throw new Error("nip19: truncated TLV header");
    const type = bytes[at];
    const length = bytes[at + 1];
    const start = at + 2;
    if (start + length > bytes.length)
      throw new Error("nip19: TLV value runs past the end");
    const list = found.get(type);
    const value = bytes.slice(start, start + length);
    if (list)
      list.push(value);
    else
      found.set(type, [value]);
    at = start + length;
  }
  return found;
}
function decodeRelays(found) {
  const raw = found.get(TLV_RELAY);
  if (!raw || raw.length === 0)
    return;
  return raw.map((b) => new TextDecoder().decode(b));
}
function decodeKind(found) {
  const raw = found.get(TLV_KIND)?.[0];
  if (!raw)
    return;
  if (raw.length !== 4)
    throw new Error("nip19: a kind TLV must be exactly four bytes");
  return (raw[0] << 24 | raw[1] << 16 | raw[2] << 8 | raw[3]) >>> 0;
}
function decodeNip19(value) {
  const trimmed = value.trim().replace(/^nostr:/i, "");
  const { prefix, words } = bech32.decode(trimmed, BECH32_LIMIT);
  const bytes = bech32.fromWords(words);
  switch (prefix) {
    case "npub":
      assertLength(bytes, 32, "npub");
      return { type: "npub", data: bytesToHex(bytes) };
    case "note":
      assertLength(bytes, 32, "note");
      return { type: "note", data: bytesToHex(bytes) };
    case "nsec":
      assertLength(bytes, 32, "nsec");
      return { type: "nsec", data: bytes };
    case "nprofile": {
      const found = parseTlv(bytes);
      const special = found.get(TLV_SPECIAL)?.[0];
      if (!special || special.length !== 32)
        throw new Error("nip19: nprofile has no 32-byte pubkey");
      return { type: "nprofile", data: { pubkey: bytesToHex(special), relays: decodeRelays(found) } };
    }
    case "nevent": {
      const found = parseTlv(bytes);
      const special = found.get(TLV_SPECIAL)?.[0];
      if (!special || special.length !== 32)
        throw new Error("nip19: nevent has no 32-byte event id");
      const author = found.get(TLV_AUTHOR)?.[0];
      if (author && author.length !== 32)
        throw new Error("nip19: nevent author is not 32 bytes");
      return {
        type: "nevent",
        data: {
          id: bytesToHex(special),
          relays: decodeRelays(found),
          author: author ? bytesToHex(author) : undefined,
          kind: decodeKind(found)
        }
      };
    }
    case "naddr": {
      const found = parseTlv(bytes);
      const special = found.get(TLV_SPECIAL)?.[0];
      const author = found.get(TLV_AUTHOR)?.[0];
      const kind = decodeKind(found);
      if (special === undefined)
        throw new Error("nip19: naddr has no identifier");
      if (!author || author.length !== 32)
        throw new Error("nip19: naddr has no 32-byte author");
      if (kind === undefined)
        throw new Error("nip19: naddr has no kind");
      return {
        type: "naddr",
        data: {
          identifier: new TextDecoder().decode(special),
          pubkey: bytesToHex(author),
          kind,
          relays: decodeRelays(found)
        }
      };
    }
    default:
      throw new Error(`nip19: unknown prefix ${JSON.stringify(prefix)}`);
  }
}
function assertLength(bytes, expected, what) {
  if (bytes.length !== expected) {
    throw new Error(`nip19: ${what} must carry ${expected} bytes, found ${bytes.length}`);
  }
}
function tryDecodeNip19(value) {
  if (typeof value !== "string")
    return;
  try {
    return decodeNip19(value);
  } catch {
    return;
  }
}
function toPubkeyHex(value) {
  if (isHex32(value))
    return value;
  const decoded = tryDecodeNip19(value);
  if (!decoded)
    return;
  if (decoded.type === "npub")
    return decoded.data;
  if (decoded.type === "nprofile")
    return decoded.data.pubkey;
  return;
}
function nostrUri(entity) {
  return `nostr:${entity.trim().replace(/^nostr:/i, "")}`;
}
function shorten(entity, keep = 8) {
  if (entity.length <= keep * 2 + 1)
    return entity;
  return `${entity.slice(0, keep)}…${entity.slice(-keep)}`;
}
// core/nostr/listing.ts
var LISTING_KIND = 30402;
var LISTING_D_PREFIX = "fmd:listing:";
var LISTING_TOPIC = "flexmydomain";
var PRICE_CURRENCY = "SATS";
function buildListing(params) {
  const domain = normaliseDomain(params.domain);
  if (!isHex32(params.pubkey))
    throw new Error("buildListing: pubkey must be 64 lowercase hex characters");
  if (!Number.isInteger(params.priceSats) || params.priceSats <= 0) {
    throw new Error(`buildListing: priceSats must be a positive integer, got ${JSON.stringify(params.priceSats)}`);
  }
  if (params.proof.pubkey !== params.pubkey) {
    throw new Error("buildListing: the proof is for a different key than the one publishing this listing");
  }
  if (params.proof.version !== PROOF_VERSION) {
    throw new Error(`buildListing: unsupported proof version ${JSON.stringify(params.proof.version)}`);
  }
  const tags = [
    ["d", LISTING_D_PREFIX + domain],
    ["title", domain],
    ["price", String(params.priceSats), PRICE_CURRENCY],
    ["status", params.status ?? "active"],
    ["t", "domain"],
    ["t", LISTING_TOPIC],
    ["published_at", String(params.publishedAt)],
    ["fmd_domain", domain],
    ["fmd_proof", String(params.proof.iat), params.proof.sig]
  ];
  if (params.summary)
    tags.splice(2, 0, ["summary", params.summary]);
  if (params.rdapSnapshot) {
    tags.push(["fmd_rdap", params.rdapSnapshot.hash, String(params.rdapSnapshot.observedAt)]);
  }
  if (params.registeredAt !== undefined)
    tags.push(["fmd_created", String(params.registeredAt)]);
  for (const arbiter of params.arbiters ?? []) {
    if (!isHex32(arbiter))
      throw new Error(`buildListing: arbiter ${JSON.stringify(arbiter)} is not an x-only pubkey`);
    tags.push(["fmd_arbiter", arbiter]);
  }
  if (params.expiration !== undefined)
    tags.push(["expiration", String(params.expiration)]);
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt ?? params.publishedAt,
    kind: LISTING_KIND,
    tags,
    content: params.description ?? ""
  };
}
function parseListing(event) {
  if (event.kind !== LISTING_KIND)
    return { ok: false, reason: `kind ${event.kind} is not ${LISTING_KIND}` };
  const d = tagValue(event, "d");
  if (!d || !d.startsWith(LISTING_D_PREFIX)) {
    return { ok: false, reason: `d tag ${JSON.stringify(d ?? null)} is not a ${LISTING_D_PREFIX}* identifier` };
  }
  const fromD = tryNormaliseDomain(d.slice(LISTING_D_PREFIX.length));
  if (!fromD.ok)
    return { ok: false, reason: `d tag domain: ${fromD.reason}` };
  if (d !== LISTING_D_PREFIX + fromD.domain)
    return { ok: false, reason: "d tag is not in normalised form" };
  const explicit = tagValue(event, "fmd_domain");
  if (explicit !== undefined && explicit !== fromD.domain) {
    return { ok: false, reason: `fmd_domain ${JSON.stringify(explicit)} disagrees with the d tag` };
  }
  const priceTag = event.tags.find((t) => t[0] === "price");
  if (!priceTag || priceTag.length < 3)
    return { ok: false, reason: "no price tag" };
  if (priceTag[2].toUpperCase() !== PRICE_CURRENCY) {
    return { ok: false, reason: `price is in ${priceTag[2]}; this marketplace prices in ${PRICE_CURRENCY}` };
  }
  if (!/^\d+$/.test(priceTag[1]))
    return { ok: false, reason: "price is not a whole number of sats" };
  const priceSats = Number(priceTag[1]);
  if (!Number.isSafeInteger(priceSats) || priceSats <= 0)
    return { ok: false, reason: "price is out of range" };
  const proofTag = event.tags.find((t) => t[0] === "fmd_proof");
  if (!proofTag || proofTag.length < 3)
    return { ok: false, reason: "no fmd_proof tag" };
  if (!/^\d{1,10}$/.test(proofTag[1]))
    return { ok: false, reason: "fmd_proof iat is not decimal unix seconds" };
  if (!isHex64(proofTag[2]))
    return { ok: false, reason: "fmd_proof sig is not 128 hex characters" };
  const status = tagValue(event, "status") ?? "active";
  if (status !== "active" && status !== "sold")
    return { ok: false, reason: `unknown status ${JSON.stringify(status)}` };
  const rdapTag = event.tags.find((t) => t[0] === "fmd_rdap");
  return {
    ok: true,
    listing: {
      domain: fromD.domain,
      priceSats,
      summary: tagValue(event, "summary") ?? "",
      description: event.content,
      status,
      publishedAt: Number(tagValue(event, "published_at") ?? event.created_at),
      proof: { version: PROOF_VERSION, iat: Number(proofTag[1]), pubkey: event.pubkey, sig: proofTag[2] },
      rdapSnapshot: rdapTag && rdapTag.length >= 3 && /^[0-9a-f]{64}$/.test(rdapTag[1]) ? { hash: rdapTag[1], observedAt: Number(rdapTag[2]) } : undefined,
      registeredAt: numberTag(event, "fmd_created"),
      arbiters: tagValues(event, "fmd_arbiter").filter(isHex32),
      expiration: numberTag(event, "expiration"),
      event
    }
  };
}
function numberTag(event, name) {
  const raw = tagValue(event, name);
  if (raw === undefined || !/^\d+$/.test(raw))
    return;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}
function checkListing(params) {
  const parsed = parseListing(params.event);
  if (!parsed.ok)
    return { ok: false, reason: parsed.reason, selfConsistent: false, zoneConfirmed: false };
  const listing = parsed.listing;
  const digest = proofDigest({ domain: listing.domain, pubkey: params.event.pubkey, iat: listing.proof.iat });
  const selfConsistent = verifyDigestSignature(listing.proof.sig, digest, params.event.pubkey);
  if (!selfConsistent) {
    return {
      ok: false,
      reason: "the embedded proof does not verify for this domain and this key",
      listing,
      selfConsistent: false,
      zoneConfirmed: false
    };
  }
  const expired = listing.expiration !== undefined && params.now !== undefined && params.now > listing.expiration;
  const zoneConfirmed = params.dnsProof?.ok === true;
  if (!zoneConfirmed) {
    return {
      ok: false,
      reason: params.dnsProof ? `DNS: ${params.dnsProof.reason ?? "no record verified"}` : "the zone was not checked",
      listing,
      selfConsistent: true,
      zoneConfirmed: false,
      expired
    };
  }
  if (expired) {
    return { ok: false, reason: "expired", listing, selfConsistent: true, zoneConfirmed: true, expired };
  }
  return { ok: true, listing, selfConsistent: true, zoneConfirmed: true, expired: false };
}
function checkListingAgainstZone(params) {
  const parsed = parseListing(params.event);
  if (!parsed.ok)
    return { ok: false, reason: parsed.reason, selfConsistent: false, zoneConfirmed: false };
  return checkListing({
    event: params.event,
    now: params.now,
    dnsProof: verifyProofRecords({
      domain: parsed.listing.domain,
      pubkey: params.event.pubkey,
      records: params.txtRecords,
      now: params.now
    })
  });
}
function listingAddress(listing, relays) {
  return naddrEncode({
    identifier: LISTING_D_PREFIX + listing.domain,
    pubkey: listing.event.pubkey,
    kind: LISTING_KIND,
    relays
  });
}
function listingFilter(extra = {}) {
  return { kinds: [LISTING_KIND], "#t": [LISTING_TOPIC], ...extra };
}
// core/nostr/profile.ts
var PROFILE_KIND = 0;
var HANDLER_KIND = 31990;
var FOLLOW_SET_KIND = 30000;
var ARBITER_SET_D = "fmd:arbiters";
var WATCHLIST_D = "fmd:watchlist";
function parseProfile(event) {
  if (event.kind !== PROFILE_KIND)
    return;
  let body = {};
  try {
    const parsed = JSON.parse(event.content);
    if (typeof parsed === "object" && parsed !== null)
      body = parsed;
  } catch {}
  const str = (key) => typeof body[key] === "string" ? body[key] : undefined;
  return {
    pubkey: event.pubkey,
    name: str("name"),
    displayName: str("display_name") ?? str("displayName"),
    about: str("about"),
    picture: str("picture"),
    nip05: str("nip05"),
    lud16: str("lud16"),
    website: str("website"),
    identities: event.tags.filter((t) => t[0] === "i" && typeof t[1] === "string" && t[1].includes(":")).map((t) => {
      const at = t[1].indexOf(":");
      return { platform: t[1].slice(0, at), identity: t[1].slice(at + 1), proof: t[2] };
    })
  };
}
function identityProofUrl(identity) {
  if (!identity.proof)
    return;
  switch (identity.platform) {
    case "github":
      return `https://gist.github.com/${identity.identity}/${identity.proof}`;
    case "twitter":
    case "x":
      return `https://twitter.com/${identity.identity}/status/${identity.proof}`;
    case "mastodon":
      return `https://${identity.proof}`;
    case "telegram":
      return `https://t.me/${identity.proof}`;
    default:
      return;
  }
}
function buildHandlerAdvertisement(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildHandlerAdvertisement: pubkey must be 64 lowercase hex characters");
  const tags = [["d", "fmd-client"]];
  for (const kind of params.kinds ?? [LISTING_KIND])
    tags.push(["k", String(kind)]);
  tags.push(["web", params.webUrl, "naddr"]);
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: HANDLER_KIND,
    tags,
    content: JSON.stringify({ name: params.name, about: params.about })
  };
}
function buildArbiterSet(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildArbiterSet: pubkey must be 64 lowercase hex characters");
  const tags = [["d", ARBITER_SET_D], ["title", "Arbiters I accept"]];
  for (const arbiter of params.arbiters) {
    if (!isHex32(arbiter))
      throw new Error(`buildArbiterSet: ${JSON.stringify(arbiter)} is not an x-only pubkey`);
    tags.push(["p", arbiter]);
  }
  return { pubkey: params.pubkey, created_at: params.createdAt, kind: FOLLOW_SET_KIND, tags, content: "" };
}
function parseArbiterSet(event) {
  if (event.kind !== FOLLOW_SET_KIND)
    return;
  if (tagValue(event, "d") !== ARBITER_SET_D)
    return;
  return event.tags.filter((t) => t[0] === "p" && isHex32(t[1])).map((t) => t[1]);
}
function arbiterIntersection(buyer, seller) {
  if (buyer === undefined && seller === undefined)
    return { arbiters: [], noArbiterPossible: true };
  if (buyer === undefined)
    return { arbiters: [...seller ?? []], noArbiterPossible: (seller ?? []).length === 0 };
  if (seller === undefined)
    return { arbiters: [...buyer], noArbiterPossible: buyer.length === 0 };
  const sellerSet = new Set(seller);
  const arbiters = buyer.filter((a) => sellerSet.has(a));
  return { arbiters, noArbiterPossible: buyer.length === 0 && seller.length === 0 };
}
function buildWatchlist(params) {
  const tags = [["d", WATCHLIST_D], ["title", "Domains I am watching"]];
  for (const domain of params.domains)
    tags.push(["t", domain]);
  return { pubkey: params.pubkey, created_at: params.createdAt, kind: FOLLOW_SET_KIND, tags, content: "" };
}
function parseWatchlist(event) {
  if (event.kind !== FOLLOW_SET_KIND)
    return;
  if (tagValue(event, "d") !== WATCHLIST_D)
    return;
  return event.tags.filter((t) => t[0] === "t" && t[1]).map((t) => t[1]);
}
function profileFilter(pubkeys) {
  return [
    { kinds: [PROFILE_KIND], authors: [...pubkeys] },
    { kinds: [FOLLOW_SET_KIND], authors: [...pubkeys], "#d": [ARBITER_SET_D, WATCHLIST_D] }
  ];
}
// core/nostr/attestation.ts
var VERIFY_REQUEST_KIND = 5970;
var VERIFY_RESULT_KIND = 6970;
var JOB_FEEDBACK_KIND = 7000;
function buildVerifyRequest(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildVerifyRequest: pubkey must be 64 lowercase hex characters");
  if (!isHex32(params.claimant))
    throw new Error("buildVerifyRequest: claimant must be 64 lowercase hex characters");
  const domain = normaliseDomain(params.domain);
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: VERIFY_REQUEST_KIND,
    tags: [
      ["i", domain, "text", "", "domain"],
      ["i", params.claimant, "text", "", "claimant"],
      ["output", "application/json"]
    ],
    content: ""
  };
}
function buildAttestation(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildAttestation: pubkey must be 64 lowercase hex characters");
  if (!isHex32(params.claimant))
    throw new Error("buildAttestation: claimant must be 64 lowercase hex characters");
  const domain = normaliseDomain(params.domain);
  const tags = [
    ["fmd_domain", domain],
    ["p", params.claimant],
    ["l", params.verdict, "fmd.verify"],
    ["t", "flexmydomain"]
  ];
  if (params.requestId)
    tags.push(["e", params.requestId]);
  if (params.requester && params.requester !== params.claimant)
    tags.push(["p", params.requester]);
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: VERIFY_RESULT_KIND,
    tags,
    content: JSON.stringify({
      v: 1,
      domain,
      claimant: params.claimant,
      verdict: params.verdict,
      ...params.source ? { source: params.source } : {},
      ...params.iat !== undefined ? { iat: params.iat } : {},
      ...params.dnssec !== undefined ? { dnssec: params.dnssec } : {},
      ...params.resolvers?.length ? { resolvers: [...params.resolvers] } : {},
      observed_at: params.observedAt
    })
  };
}
function parseAttestation(event) {
  if (event.kind !== VERIFY_RESULT_KIND)
    return { ok: false, reason: `kind ${event.kind} is not ${VERIFY_RESULT_KIND}` };
  let body;
  try {
    body = JSON.parse(event.content);
  } catch (err) {
    return { ok: false, reason: `content is not JSON: ${err.message}` };
  }
  const domain = tryNormaliseDomain(body.domain);
  if (!domain.ok)
    return { ok: false, reason: `domain: ${domain.reason}` };
  if (tagValue(event, "fmd_domain") !== domain.domain) {
    return { ok: false, reason: "the fmd_domain tag disagrees with the body" };
  }
  const claimant = body.claimant;
  if (!isHex32(claimant))
    return { ok: false, reason: "no claimant" };
  if (!event.tags.some((t) => t[0] === "p" && t[1] === claimant)) {
    return { ok: false, reason: "the body names a claimant the tags do not" };
  }
  const verdict = body.verdict;
  if (verdict !== "proven" && verdict !== "absent" && verdict !== "unreachable") {
    return { ok: false, reason: `unknown verdict ${JSON.stringify(verdict ?? null)}` };
  }
  const observedAt = typeof body.observed_at === "number" ? body.observed_at : undefined;
  if (observedAt === undefined)
    return { ok: false, reason: "no observation time" };
  return {
    ok: true,
    attestation: {
      verifier: event.pubkey,
      domain: domain.domain,
      claimant,
      verdict,
      source: body.source === "nip05" ? "nip05" : body.source === "dns" ? "dns" : undefined,
      iat: typeof body.iat === "number" ? body.iat : undefined,
      dnssec: typeof body.dnssec === "boolean" ? body.dnssec : undefined,
      resolvers: Array.isArray(body.resolvers) ? body.resolvers.filter((r) => typeof r === "string") : [],
      observedAt,
      event
    }
  };
}
function tally(params) {
  const trusted = new Set(params.trusted);
  const newest = new Map;
  for (const attestation of params.attestations) {
    if (!trusted.has(attestation.verifier))
      continue;
    if (attestation.domain !== params.domain)
      continue;
    if (attestation.claimant !== params.claimant)
      continue;
    if (params.maxAgeSeconds !== undefined && params.now !== undefined && params.now - attestation.observedAt > params.maxAgeSeconds)
      continue;
    const current = newest.get(attestation.verifier);
    if (!current || attestation.observedAt > current.observedAt)
      newest.set(attestation.verifier, attestation);
  }
  const opinions = [...newest.values()];
  const agreeing = opinions.filter((a) => a.verdict === "proven");
  return {
    proven: agreeing.length >= params.threshold && params.threshold > 0,
    agreeing: agreeing.length,
    absent: opinions.filter((a) => a.verdict === "absent").length,
    unreachable: opinions.filter((a) => a.verdict === "unreachable").length,
    verifiers: agreeing.map((a) => a.verifier)
  };
}
function attestationFilter(params) {
  const filter = { kinds: [VERIFY_RESULT_KIND] };
  if (params.domains?.length)
    filter["#fmd_domain"] = [...params.domains];
  if (params.verifiers?.length)
    filter.authors = [...params.verifiers];
  if (params.since !== undefined)
    filter.since = params.since;
  return filter;
}
function buildJobFeedback(params) {
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: JOB_FEEDBACK_KIND,
    tags: [
      ["status", params.status, params.message ?? ""],
      ["e", params.requestId],
      ["p", params.requester]
    ],
    content: params.message ?? ""
  };
}
// core/nostr/badge.ts
var BADGE_DEFINITION_KIND = 30009;
var BADGE_AWARD_KIND = 8;
var PROFILE_BADGES_KIND = 30008;
var PROFILE_BADGES_D = "profile_badges";
function buildBadgeDefinition(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildBadgeDefinition: pubkey must be 64 lowercase hex characters");
  if (!params.badge.slug)
    throw new Error("buildBadgeDefinition: a badge needs a slug");
  const tags = [["d", params.badge.slug], ["name", params.badge.name]];
  if (params.badge.description)
    tags.push(["description", params.badge.description]);
  if (params.badge.image)
    tags.push(["image", params.badge.image]);
  if (params.badge.thumb)
    tags.push(["thumb", params.badge.thumb]);
  return { pubkey: params.pubkey, created_at: params.createdAt, kind: BADGE_DEFINITION_KIND, tags, content: "" };
}
function buildBadgeAward(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildBadgeAward: pubkey must be 64 lowercase hex characters");
  if (params.recipients.length === 0)
    throw new Error("buildBadgeAward: no recipients");
  if (!params.definition.startsWith(`${BADGE_DEFINITION_KIND}:`)) {
    throw new Error(`buildBadgeAward: ${JSON.stringify(params.definition)} is not a badge definition coordinate`);
  }
  const tags = [["a", params.definition]];
  for (const recipient of params.recipients) {
    if (!isHex32(recipient))
      throw new Error(`buildBadgeAward: ${JSON.stringify(recipient)} is not a pubkey`);
    tags.push(["p", recipient]);
  }
  return { pubkey: params.pubkey, created_at: params.createdAt, kind: BADGE_AWARD_KIND, tags, content: "" };
}
function buildProfileBadges(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildProfileBadges: pubkey must be 64 lowercase hex characters");
  const tags = [["d", PROFILE_BADGES_D]];
  for (const badge of params.badges) {
    if (!isHex32(badge.awardId))
      throw new Error("buildProfileBadges: an award id must be 64 lowercase hex characters");
    tags.push(["a", badge.definition], ["e", badge.awardId]);
  }
  return { pubkey: params.pubkey, created_at: params.createdAt, kind: PROFILE_BADGES_KIND, tags, content: "" };
}
function parseBadgeDefinition(event) {
  if (event.kind !== BADGE_DEFINITION_KIND)
    return;
  const slug = tagValue(event, "d");
  const name = tagValue(event, "name");
  if (!slug || !name)
    return;
  return {
    slug,
    name,
    description: tagValue(event, "description"),
    image: tagValue(event, "image"),
    thumb: tagValue(event, "thumb"),
    issuer: event.pubkey,
    address: addressOf(event)
  };
}
function parseBadgeAward(event) {
  if (event.kind !== BADGE_AWARD_KIND)
    return;
  const definition = tagValue(event, "a");
  if (!definition)
    return;
  return {
    definition,
    issuer: event.pubkey,
    recipients: event.tags.filter((t) => t[0] === "p" && isHex32(t[1])).map((t) => t[1])
  };
}
function parseProfileBadges(event) {
  if (event.kind !== PROFILE_BADGES_KIND)
    return [];
  if (tagValue(event, "d") !== PROFILE_BADGES_D)
    return [];
  const pairs = [];
  const tags = event.tags.filter((t) => t[0] === "a" || t[0] === "e");
  for (let i = 0;i < tags.length - 1; i++) {
    if (tags[i][0] === "a" && tags[i + 1][0] === "e" && tags[i][1] && isHex32(tags[i + 1][1])) {
      pairs.push({ definition: tags[i][1], awardId: tags[i + 1][1] });
      i++;
    }
  }
  return pairs;
}
function verifiedBadges(params) {
  const claimed = parseProfileBadges(params.profile);
  const byId = new Map(params.awards.map((a) => [a.id, a]));
  const out = [];
  for (const claim of claimed) {
    const award = byId.get(claim.awardId);
    if (!award)
      continue;
    const parsed = parseBadgeAward(award);
    if (!parsed)
      continue;
    if (parsed.definition !== claim.definition)
      continue;
    if (!parsed.recipients.includes(params.pubkey))
      continue;
    if (!claim.definition.startsWith(`${BADGE_DEFINITION_KIND}:${parsed.issuer}:`))
      continue;
    out.push({ ...claim, issuer: parsed.issuer });
  }
  return out;
}
var FMD_BADGES = {
  verifiedSale: {
    slug: "fmd-verified-sale",
    name: "Verified domain sale",
    description: "Settled a domain sale through a non-custodial escrow, with both trade receipts agreeing and a registry transfer observed in RDAP."
  },
  provenHolder: {
    slug: "fmd-proven-holder",
    name: "Proven domain holder",
    description: "Published a DNS proof of control for at least one domain, verified against two independent resolvers."
  }
};
// core/nostr/zap.ts
var ZAP_REQUEST_KIND = 9734;
var ZAP_RECEIPT_KIND = 9735;
var FLEX_TOPIC = "flexmydomain";
var MSATS_PER_SAT = 1000;
function buildZapRequest(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildZapRequest: pubkey must be 64 lowercase hex characters");
  if (!isHex32(params.recipient))
    throw new Error("buildZapRequest: recipient must be 64 lowercase hex characters");
  if (!Number.isSafeInteger(params.amountMsats) || params.amountMsats <= 0) {
    throw new Error(`buildZapRequest: amountMsats must be a positive integer, got ${params.amountMsats}`);
  }
  if (params.relays.length === 0) {
    throw new Error("buildZapRequest: at least one relay is required, or the receipt reaches nobody");
  }
  const tags = [
    ["relays", ...params.relays],
    ["amount", String(params.amountMsats)],
    ["p", params.recipient]
  ];
  if (params.lnurl)
    tags.push(["lnurl", params.lnurl]);
  if (params.address)
    tags.push(["a", params.address]);
  if (params.eventId)
    tags.push(["e", params.eventId]);
  if (params.flexDomain) {
    tags.push(["fmd_flex", normaliseDomain(params.flexDomain)]);
    tags.push(["t", FLEX_TOPIC]);
  }
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: ZAP_REQUEST_KIND,
    tags,
    content: params.comment ?? ""
  };
}
function verifyZapReceipt(params) {
  const { receipt } = params;
  if (receipt.kind !== ZAP_RECEIPT_KIND)
    return { ok: false, reason: `kind ${receipt.kind} is not ${ZAP_RECEIPT_KIND}` };
  const checked = checkEvent(receipt);
  if (!checked.ok)
    return { ok: false, reason: `receipt: ${checked.reason}` };
  if (!isHex32(params.expectedProvider)) {
    return { ok: false, reason: "no zapper pubkey was supplied for this recipient" };
  }
  if (receipt.pubkey !== params.expectedProvider) {
    return { ok: false, reason: "the receipt was not written by this recipient’s published zapper key" };
  }
  const description = tagValue(receipt, "description");
  if (!description)
    return { ok: false, reason: "no description tag, so there is no zap request to check" };
  let request;
  try {
    request = JSON.parse(description);
  } catch (err) {
    return { ok: false, reason: `description is not JSON: ${err.message}` };
  }
  if (request?.kind !== ZAP_REQUEST_KIND)
    return { ok: false, reason: "the description is not a zap request" };
  const requestChecked = checkEvent(request);
  if (!requestChecked.ok)
    return { ok: false, reason: `zap request: ${requestChecked.reason}` };
  const recipient = tagValue(request, "p");
  if (recipient !== params.recipient) {
    return { ok: false, reason: "the zap request names a different recipient" };
  }
  const bolt11 = tagValue(receipt, "bolt11");
  if (!bolt11)
    return { ok: false, reason: "no bolt11 tag" };
  const invoiceMsats = bolt11AmountMsats(bolt11);
  if (invoiceMsats === undefined)
    return { ok: false, reason: "the bolt11 invoice carries no amount" };
  const requested = Number(tagValue(request, "amount") ?? NaN);
  if (Number.isSafeInteger(requested) && requested !== invoiceMsats) {
    return { ok: false, reason: `the invoice is for ${invoiceMsats} msats but the request claimed ${requested}` };
  }
  return {
    ok: true,
    zap: {
      receipt,
      request,
      sender: request.pubkey,
      recipient,
      amountMsats: invoiceMsats,
      amountSats: Math.floor(invoiceMsats / MSATS_PER_SAT),
      address: tagValue(request, "a") ?? tagValue(receipt, "a"),
      eventId: tagValue(request, "e") ?? tagValue(receipt, "e"),
      flexDomain: flexDomainOf(request),
      comment: request.content,
      at: receipt.created_at
    }
  };
}
function bolt11AmountMsats(invoice) {
  const match = /^ln(bcrt|bc|tb|tbs|sb)(\d+)?([munp])?1/i.exec(invoice.trim().toLowerCase());
  if (!match)
    return;
  const digits = match[2];
  if (!digits)
    return;
  const value = Number(digits);
  if (!Number.isFinite(value))
    return;
  const MSATS_PER_BTC = 100000000000;
  switch (match[3]) {
    case "m":
      return Math.round(value * MSATS_PER_BTC / 1000);
    case "u":
      return Math.round(value * MSATS_PER_BTC / 1e6);
    case "n":
      return Math.round(value * MSATS_PER_BTC / 1e9);
    case "p":
      return Math.round(value * MSATS_PER_BTC / 1000000000000);
    case undefined:
      return value * MSATS_PER_BTC;
    default:
      return;
  }
}
function flexDomainOf(request) {
  const raw = tagValue(request, "fmd_flex");
  if (raw === undefined)
    return;
  const domain = tryNormaliseDomain(raw);
  return domain.ok ? domain.domain : undefined;
}
function rankFlexDomains(zaps, options) {
  const window2 = options.windowSeconds ?? 7 * 86400;
  const cutoff = options.now - window2;
  const seen = new Set;
  const totals = new Map;
  for (const zap of zaps) {
    if (!zap.flexDomain)
      continue;
    if (zap.at < cutoff)
      continue;
    if (seen.has(zap.receipt.id))
      continue;
    seen.add(zap.receipt.id);
    const current = totals.get(zap.flexDomain);
    if (current) {
      current.sats += zap.amountSats;
      current.zaps += 1;
      current.first = Math.min(current.first, zap.at);
      current.last = Math.max(current.last, zap.at);
      current.payers.add(zap.sender);
    } else {
      totals.set(zap.flexDomain, {
        sats: zap.amountSats,
        zaps: 1,
        first: zap.at,
        last: zap.at,
        payers: new Set([zap.sender])
      });
    }
  }
  return [...totals.entries()].map(([domain, t]) => ({ domain, sats: t.sats, zaps: t.zaps, first: t.first, last: t.last, payers: [...t.payers] })).sort((a, b) => b.sats - a.sats || a.first - b.first);
}
function flexZapFilter(recipient, since) {
  const filter = { kinds: [ZAP_RECEIPT_KIND], "#p": [recipient] };
  if (since !== undefined)
    filter.since = since;
  return filter;
}
function rankByZaps(zaps, options = { now: 0 }) {
  const window2 = options.windowSeconds ?? 7 * 86400;
  const cutoff = options.now - window2;
  const seen = new Set;
  const totals = new Map;
  for (const zap of zaps) {
    if (!zap.address)
      continue;
    if (zap.at < cutoff)
      continue;
    if (seen.has(zap.receipt.id))
      continue;
    seen.add(zap.receipt.id);
    const current = totals.get(zap.address);
    if (current) {
      current.sats += zap.amountSats;
      current.zaps += 1;
      current.first = Math.min(current.first, zap.at);
    } else {
      totals.set(zap.address, { sats: zap.amountSats, zaps: 1, first: zap.at });
    }
  }
  return [...totals.entries()].map(([address, t]) => ({ address, ...t })).sort((a, b) => b.sats - a.sats || a.first - b.first);
}
function zapReceiptFilter(params) {
  const filter = { kinds: [ZAP_RECEIPT_KIND] };
  if (params.addresses?.length)
    filter["#a"] = [...params.addresses];
  if (params.recipient)
    filter["#p"] = [params.recipient];
  if (params.since !== undefined)
    filter.since = params.since;
  return filter;
}
// core/nostr/receipt.ts
var RECEIPT_KIND = 1985;
var RECEIPT_NAMESPACE = "fmd.trade";
var TXID_RE = /^[0-9a-f]{64}$/;
var OUTPOINT_RE = /^[0-9a-f]{64}:\d+$/;
function buildReceipt(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildReceipt: pubkey must be 64 lowercase hex characters");
  if (!isHex32(params.counterparty))
    throw new Error("buildReceipt: counterparty must be 64 lowercase hex characters");
  if (params.pubkey === params.counterparty) {
    throw new Error("buildReceipt: a receipt is written about the counterparty, never about yourself");
  }
  if (!OUTPOINT_RE.test(params.funding))
    throw new Error("buildReceipt: funding must be <txid>:<vout>");
  if (!TXID_RE.test(params.settlement))
    throw new Error("buildReceipt: settlement must be a 64-character txid");
  if (!Number.isSafeInteger(params.amountSats) || params.amountSats <= 0) {
    throw new Error("buildReceipt: amountSats must be a positive integer");
  }
  const domain = normaliseDomain(params.domain);
  const tags = [
    ["L", RECEIPT_NAMESPACE],
    ["l", params.outcome, RECEIPT_NAMESPACE],
    ["p", params.counterparty],
    ["fmd_escrow", params.escrowId],
    ["fmd_funding", params.funding],
    ["fmd_settle", params.settlement],
    ["fmd_amount", String(params.amountSats)],
    ["fmd_domain", domain],
    ["fmd_role", params.role]
  ];
  if (params.listing)
    tags.splice(3, 0, ["a", params.listing]);
  if (params.transferSnapshot)
    tags.push(["fmd_transfer", params.transferSnapshot]);
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: RECEIPT_KIND,
    tags,
    content: params.comment ?? ""
  };
}
function parseReceipt(event) {
  if (event.kind !== RECEIPT_KIND)
    return { ok: false, reason: `kind ${event.kind} is not ${RECEIPT_KIND}` };
  if (tagValue(event, "L") !== RECEIPT_NAMESPACE) {
    return { ok: false, reason: "not an fmd.trade label" };
  }
  const label = event.tags.find((t) => t[0] === "l" && t[2] === RECEIPT_NAMESPACE);
  const outcome = label?.[1];
  if (outcome !== "settled" && outcome !== "refunded" && outcome !== "disputed") {
    return { ok: false, reason: `unknown outcome ${JSON.stringify(outcome ?? null)}` };
  }
  const counterparty = tagValue(event, "p");
  if (!isHex32(counterparty))
    return { ok: false, reason: "no counterparty" };
  if (counterparty === event.pubkey)
    return { ok: false, reason: "a receipt about its own author is not evidence" };
  const role = tagValue(event, "fmd_role");
  if (role !== "buyer" && role !== "seller")
    return { ok: false, reason: "no role" };
  const domain = tryNormaliseDomain(tagValue(event, "fmd_domain"));
  if (!domain.ok)
    return { ok: false, reason: `domain: ${domain.reason}` };
  const funding = tagValue(event, "fmd_funding");
  const settlement = tagValue(event, "fmd_settle");
  if (!funding || !OUTPOINT_RE.test(funding))
    return { ok: false, reason: "no funding outpoint" };
  if (!settlement || !TXID_RE.test(settlement))
    return { ok: false, reason: "no settlement txid" };
  const amountSats = Number(tagValue(event, "fmd_amount") ?? NaN);
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0)
    return { ok: false, reason: "no amount" };
  const escrowId = tagValue(event, "fmd_escrow");
  if (!escrowId)
    return { ok: false, reason: "no escrow id" };
  return {
    ok: true,
    receipt: {
      event,
      author: event.pubkey,
      role,
      counterparty,
      outcome,
      domain: domain.domain,
      listing: tagValue(event, "a"),
      escrowId,
      funding,
      settlement,
      amountSats,
      transferSnapshot: tagValue(event, "fmd_transfer"),
      at: event.created_at,
      comment: event.content
    }
  };
}
function pairReceipts(receipts) {
  const byEscrow = new Map;
  for (const receipt of receipts) {
    const group = byEscrow.get(receipt.escrowId);
    if (group)
      group.push(receipt);
    else
      byEscrow.set(receipt.escrowId, [receipt]);
  }
  const trades = [];
  for (const [escrowId, group] of byEscrow) {
    const latest = new Map;
    for (const receipt of group) {
      const current = latest.get(receipt.author);
      if (!current || receipt.at > current.at)
        latest.set(receipt.author, receipt);
    }
    const members = [...latest.values()];
    const buyerSide = members.find((r) => r.role === "buyer");
    const sellerSide = members.find((r) => r.role === "seller");
    const conflicts = [];
    if (buyerSide && sellerSide) {
      if (buyerSide.counterparty !== sellerSide.author)
        conflicts.push("the buyer names a different seller");
      if (sellerSide.counterparty !== buyerSide.author)
        conflicts.push("the seller names a different buyer");
      if (buyerSide.settlement !== sellerSide.settlement)
        conflicts.push("the two receipts name different settlement transactions");
      if (buyerSide.funding !== sellerSide.funding)
        conflicts.push("the two receipts name different funding outpoints");
      if (buyerSide.amountSats !== sellerSide.amountSats)
        conflicts.push("the two receipts disagree about the amount");
      if (buyerSide.domain !== sellerSide.domain)
        conflicts.push("the two receipts name different domains");
      if (buyerSide.outcome !== sellerSide.outcome)
        conflicts.push("the two receipts disagree about the outcome");
    }
    const primary = buyerSide ?? sellerSide ?? members[0];
    trades.push({
      escrowId,
      domain: primary.domain,
      amountSats: primary.amountSats,
      settlement: primary.settlement,
      funding: primary.funding,
      buyer: buyerSide?.author ?? sellerSide?.counterparty,
      seller: sellerSide?.author ?? buyerSide?.counterparty,
      mutual: Boolean(buyerSide && sellerSide) && conflicts.length === 0,
      conflicts,
      hasTransfer: members.some((r) => Boolean(r.transferSnapshot)),
      at: Math.max(...members.map((r) => r.at)),
      receipts: members
    });
  }
  return trades.sort((a, b) => b.at - a.at);
}
function countsTowardReputation(trade) {
  return trade.mutual && trade.receipts[0]?.outcome === "settled" && trade.hasTransfer;
}
function summariseTrades(trades, pubkey) {
  const partners = new Set;
  let verified = 0;
  let satsSettled = 0;
  let unweighted = 0;
  let conflicted = 0;
  let firstTradeAt;
  for (const trade of trades) {
    const involved = trade.buyer === pubkey || trade.seller === pubkey;
    if (!involved)
      continue;
    if (trade.conflicts.length > 0) {
      conflicted += 1;
      continue;
    }
    if (!countsTowardReputation(trade)) {
      unweighted += 1;
      continue;
    }
    verified += 1;
    satsSettled += trade.amountSats;
    const other = trade.buyer === pubkey ? trade.seller : trade.buyer;
    if (other)
      partners.add(other);
    firstTradeAt = firstTradeAt === undefined ? trade.at : Math.min(firstTradeAt, trade.at);
  }
  return {
    verified,
    counterparties: partners.size,
    satsSettled,
    firstTradeAt,
    unweighted,
    conflicted,
    partners: [...partners]
  };
}
function receiptFilter(pubkeys) {
  return [
    { kinds: [RECEIPT_KIND], authors: [...pubkeys] },
    { kinds: [RECEIPT_KIND], "#p": [...pubkeys] }
  ];
}
// node_modules/@noble/ciphers/utils.js
/*! noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com) */
function isBytes4(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abool2(b) {
  if (typeof b !== "boolean")
    throw new Error(`boolean expected, not ${b}`);
}
function anumber4(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes4(value, length, title = "") {
  const bytes = isBytes4(value);
  const len = value?.length;
  const needsLen = length !== undefined;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function aexists2(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput2(out, instance) {
  abytes4(out, undefined, "output");
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean2(...arrays) {
  for (let i = 0;i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView2(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function checkOpts2(defaults, opts) {
  if (opts == null || typeof opts !== "object")
    throw new Error("options must be defined");
  const merged = Object.assign(defaults, opts);
  return merged;
}
function equalBytes(a, b) {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0;i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
var wrapCipher = (params, constructor) => {
  function wrappedCipher(key, ...args) {
    abytes4(key, undefined, "key");
    if (!isLE)
      throw new Error("Non little-endian hardware is not yet supported");
    if (params.nonceLength !== undefined) {
      const nonce = args[0];
      abytes4(nonce, params.varSizeNonce ? undefined : params.nonceLength, "nonce");
    }
    const tagl = params.tagLength;
    if (tagl && args[1] !== undefined)
      abytes4(args[1], undefined, "AAD");
    const cipher = constructor(key, ...args);
    const checkOutput = (fnLength, output) => {
      if (output !== undefined) {
        if (fnLength !== 2)
          throw new Error("cipher output not supported");
        abytes4(output, undefined, "output");
      }
    };
    let called = false;
    const wrCipher = {
      encrypt(data, output) {
        if (called)
          throw new Error("cannot encrypt() twice with same key + nonce");
        called = true;
        abytes4(data);
        checkOutput(cipher.encrypt.length, output);
        return cipher.encrypt(data, output);
      },
      decrypt(data, output) {
        abytes4(data);
        if (tagl && data.length < tagl)
          throw new Error('"ciphertext" expected length bigger than tagLength=' + tagl);
        checkOutput(cipher.decrypt.length, output);
        return cipher.decrypt(data, output);
      }
    };
    return wrCipher;
  }
  Object.assign(wrappedCipher, params);
  return wrappedCipher;
};
function getOutput(expectedLength, out, onlyAligned = true) {
  if (out === undefined)
    return new Uint8Array(expectedLength);
  if (out.length !== expectedLength)
    throw new Error('"output" expected Uint8Array of length ' + expectedLength + ", got: " + out.length);
  if (onlyAligned && !isAligned32(out))
    throw new Error("invalid output, must be aligned");
  return out;
}
function u64Lengths(dataLength, aadLength, isLE2) {
  abool2(isLE2);
  const num2 = new Uint8Array(16);
  const view = createView2(num2);
  view.setBigUint64(0, BigInt(aadLength), isLE2);
  view.setBigUint64(8, BigInt(dataLength), isLE2);
  return num2;
}
function isAligned32(bytes) {
  return bytes.byteOffset % 4 === 0;
}
function copyBytes2(bytes) {
  return Uint8Array.from(bytes);
}

// node_modules/@noble/ciphers/_arx.js
var encodeStr = (str) => Uint8Array.from(str.split(""), (c) => c.charCodeAt(0));
var sigma16 = encodeStr("expand 16-byte k");
var sigma32 = encodeStr("expand 32-byte k");
var sigma16_32 = u32(sigma16);
var sigma32_32 = u32(sigma32);
function rotl(a, b) {
  return a << b | a >>> 32 - b;
}
function isAligned322(b) {
  return b.byteOffset % 4 === 0;
}
var BLOCK_LEN = 64;
var BLOCK_LEN32 = 16;
var MAX_COUNTER = 2 ** 32 - 1;
var U32_EMPTY = Uint32Array.of();
function runCipher(core, sigma, key, nonce, data, output, counter, rounds) {
  const len = data.length;
  const block = new Uint8Array(BLOCK_LEN);
  const b32 = u32(block);
  const isAligned = isAligned322(data) && isAligned322(output);
  const d32 = isAligned ? u32(data) : U32_EMPTY;
  const o32 = isAligned ? u32(output) : U32_EMPTY;
  for (let pos = 0;pos < len; counter++) {
    core(sigma, key, nonce, b32, counter, rounds);
    if (counter >= MAX_COUNTER)
      throw new Error("arx: counter overflow");
    const take = Math.min(BLOCK_LEN, len - pos);
    if (isAligned && take === BLOCK_LEN) {
      const pos32 = pos / 4;
      if (pos % 4 !== 0)
        throw new Error("arx: invalid block position");
      for (let j = 0, posj;j < BLOCK_LEN32; j++) {
        posj = pos32 + j;
        o32[posj] = d32[posj] ^ b32[j];
      }
      pos += BLOCK_LEN;
      continue;
    }
    for (let j = 0, posj;j < take; j++) {
      posj = pos + j;
      output[posj] = data[posj] ^ block[j];
    }
    pos += take;
  }
}
function createCipher(core, opts) {
  const { allowShortKeys, extendNonceFn, counterLength, counterRight, rounds } = checkOpts2({ allowShortKeys: false, counterLength: 8, counterRight: false, rounds: 20 }, opts);
  if (typeof core !== "function")
    throw new Error("core must be a function");
  anumber4(counterLength);
  anumber4(rounds);
  abool2(counterRight);
  abool2(allowShortKeys);
  return (key, nonce, data, output, counter = 0) => {
    abytes4(key, undefined, "key");
    abytes4(nonce, undefined, "nonce");
    abytes4(data, undefined, "data");
    const len = data.length;
    if (output === undefined)
      output = new Uint8Array(len);
    abytes4(output, undefined, "output");
    anumber4(counter);
    if (counter < 0 || counter >= MAX_COUNTER)
      throw new Error("arx: counter overflow");
    if (output.length < len)
      throw new Error(`arx: output (${output.length}) is shorter than data (${len})`);
    const toClean = [];
    let l = key.length;
    let k;
    let sigma;
    if (l === 32) {
      toClean.push(k = copyBytes2(key));
      sigma = sigma32_32;
    } else if (l === 16 && allowShortKeys) {
      k = new Uint8Array(32);
      k.set(key);
      k.set(key, 16);
      sigma = sigma16_32;
      toClean.push(k);
    } else {
      abytes4(key, 32, "arx key");
      throw new Error("invalid key size");
    }
    if (!isAligned322(nonce))
      toClean.push(nonce = copyBytes2(nonce));
    const k32 = u32(k);
    if (extendNonceFn) {
      if (nonce.length !== 24)
        throw new Error(`arx: extended nonce must be 24 bytes`);
      extendNonceFn(sigma, k32, u32(nonce.subarray(0, 16)), k32);
      nonce = nonce.subarray(16);
    }
    const nonceNcLen = 16 - counterLength;
    if (nonceNcLen !== nonce.length)
      throw new Error(`arx: nonce must be ${nonceNcLen} or 16 bytes`);
    if (nonceNcLen !== 12) {
      const nc = new Uint8Array(12);
      nc.set(nonce, counterRight ? 0 : 12 - nonce.length);
      nonce = nc;
      toClean.push(nonce);
    }
    const n32 = u32(nonce);
    runCipher(core, sigma, k32, n32, data, output, counter, rounds);
    clean2(...toClean);
    return output;
  };
}

// node_modules/@noble/ciphers/_poly1305.js
function u8to16(a, i) {
  return a[i++] & 255 | (a[i++] & 255) << 8;
}
class Poly1305 {
  blockLen = 16;
  outputLen = 16;
  buffer = new Uint8Array(16);
  r = new Uint16Array(10);
  h = new Uint16Array(10);
  pad = new Uint16Array(8);
  pos = 0;
  finished = false;
  constructor(key) {
    key = copyBytes2(abytes4(key, 32, "key"));
    const t0 = u8to16(key, 0);
    const t1 = u8to16(key, 2);
    const t2 = u8to16(key, 4);
    const t3 = u8to16(key, 6);
    const t4 = u8to16(key, 8);
    const t5 = u8to16(key, 10);
    const t6 = u8to16(key, 12);
    const t7 = u8to16(key, 14);
    this.r[0] = t0 & 8191;
    this.r[1] = (t0 >>> 13 | t1 << 3) & 8191;
    this.r[2] = (t1 >>> 10 | t2 << 6) & 7939;
    this.r[3] = (t2 >>> 7 | t3 << 9) & 8191;
    this.r[4] = (t3 >>> 4 | t4 << 12) & 255;
    this.r[5] = t4 >>> 1 & 8190;
    this.r[6] = (t4 >>> 14 | t5 << 2) & 8191;
    this.r[7] = (t5 >>> 11 | t6 << 5) & 8065;
    this.r[8] = (t6 >>> 8 | t7 << 8) & 8191;
    this.r[9] = t7 >>> 5 & 127;
    for (let i = 0;i < 8; i++)
      this.pad[i] = u8to16(key, 16 + 2 * i);
  }
  process(data, offset, isLast = false) {
    const hibit = isLast ? 0 : 1 << 11;
    const { h, r } = this;
    const r0 = r[0];
    const r1 = r[1];
    const r2 = r[2];
    const r3 = r[3];
    const r4 = r[4];
    const r5 = r[5];
    const r6 = r[6];
    const r7 = r[7];
    const r8 = r[8];
    const r9 = r[9];
    const t0 = u8to16(data, offset + 0);
    const t1 = u8to16(data, offset + 2);
    const t2 = u8to16(data, offset + 4);
    const t3 = u8to16(data, offset + 6);
    const t4 = u8to16(data, offset + 8);
    const t5 = u8to16(data, offset + 10);
    const t6 = u8to16(data, offset + 12);
    const t7 = u8to16(data, offset + 14);
    let h0 = h[0] + (t0 & 8191);
    let h1 = h[1] + ((t0 >>> 13 | t1 << 3) & 8191);
    let h2 = h[2] + ((t1 >>> 10 | t2 << 6) & 8191);
    let h3 = h[3] + ((t2 >>> 7 | t3 << 9) & 8191);
    let h4 = h[4] + ((t3 >>> 4 | t4 << 12) & 8191);
    let h5 = h[5] + (t4 >>> 1 & 8191);
    let h6 = h[6] + ((t4 >>> 14 | t5 << 2) & 8191);
    let h7 = h[7] + ((t5 >>> 11 | t6 << 5) & 8191);
    let h8 = h[8] + ((t6 >>> 8 | t7 << 8) & 8191);
    let h9 = h[9] + (t7 >>> 5 | hibit);
    let c = 0;
    let d0 = c + h0 * r0 + h1 * (5 * r9) + h2 * (5 * r8) + h3 * (5 * r7) + h4 * (5 * r6);
    c = d0 >>> 13;
    d0 &= 8191;
    d0 += h5 * (5 * r5) + h6 * (5 * r4) + h7 * (5 * r3) + h8 * (5 * r2) + h9 * (5 * r1);
    c += d0 >>> 13;
    d0 &= 8191;
    let d1 = c + h0 * r1 + h1 * r0 + h2 * (5 * r9) + h3 * (5 * r8) + h4 * (5 * r7);
    c = d1 >>> 13;
    d1 &= 8191;
    d1 += h5 * (5 * r6) + h6 * (5 * r5) + h7 * (5 * r4) + h8 * (5 * r3) + h9 * (5 * r2);
    c += d1 >>> 13;
    d1 &= 8191;
    let d2 = c + h0 * r2 + h1 * r1 + h2 * r0 + h3 * (5 * r9) + h4 * (5 * r8);
    c = d2 >>> 13;
    d2 &= 8191;
    d2 += h5 * (5 * r7) + h6 * (5 * r6) + h7 * (5 * r5) + h8 * (5 * r4) + h9 * (5 * r3);
    c += d2 >>> 13;
    d2 &= 8191;
    let d3 = c + h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * (5 * r9);
    c = d3 >>> 13;
    d3 &= 8191;
    d3 += h5 * (5 * r8) + h6 * (5 * r7) + h7 * (5 * r6) + h8 * (5 * r5) + h9 * (5 * r4);
    c += d3 >>> 13;
    d3 &= 8191;
    let d4 = c + h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
    c = d4 >>> 13;
    d4 &= 8191;
    d4 += h5 * (5 * r9) + h6 * (5 * r8) + h7 * (5 * r7) + h8 * (5 * r6) + h9 * (5 * r5);
    c += d4 >>> 13;
    d4 &= 8191;
    let d5 = c + h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1;
    c = d5 >>> 13;
    d5 &= 8191;
    d5 += h5 * r0 + h6 * (5 * r9) + h7 * (5 * r8) + h8 * (5 * r7) + h9 * (5 * r6);
    c += d5 >>> 13;
    d5 &= 8191;
    let d6 = c + h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2;
    c = d6 >>> 13;
    d6 &= 8191;
    d6 += h5 * r1 + h6 * r0 + h7 * (5 * r9) + h8 * (5 * r8) + h9 * (5 * r7);
    c += d6 >>> 13;
    d6 &= 8191;
    let d7 = c + h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3;
    c = d7 >>> 13;
    d7 &= 8191;
    d7 += h5 * r2 + h6 * r1 + h7 * r0 + h8 * (5 * r9) + h9 * (5 * r8);
    c += d7 >>> 13;
    d7 &= 8191;
    let d8 = c + h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4;
    c = d8 >>> 13;
    d8 &= 8191;
    d8 += h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * (5 * r9);
    c += d8 >>> 13;
    d8 &= 8191;
    let d9 = c + h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5;
    c = d9 >>> 13;
    d9 &= 8191;
    d9 += h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0;
    c += d9 >>> 13;
    d9 &= 8191;
    c = (c << 2) + c | 0;
    c = c + d0 | 0;
    d0 = c & 8191;
    c = c >>> 13;
    d1 += c;
    h[0] = d0;
    h[1] = d1;
    h[2] = d2;
    h[3] = d3;
    h[4] = d4;
    h[5] = d5;
    h[6] = d6;
    h[7] = d7;
    h[8] = d8;
    h[9] = d9;
  }
  finalize() {
    const { h, pad } = this;
    const g = new Uint16Array(10);
    let c = h[1] >>> 13;
    h[1] &= 8191;
    for (let i = 2;i < 10; i++) {
      h[i] += c;
      c = h[i] >>> 13;
      h[i] &= 8191;
    }
    h[0] += c * 5;
    c = h[0] >>> 13;
    h[0] &= 8191;
    h[1] += c;
    c = h[1] >>> 13;
    h[1] &= 8191;
    h[2] += c;
    g[0] = h[0] + 5;
    c = g[0] >>> 13;
    g[0] &= 8191;
    for (let i = 1;i < 10; i++) {
      g[i] = h[i] + c;
      c = g[i] >>> 13;
      g[i] &= 8191;
    }
    g[9] -= 1 << 13;
    let mask = (c ^ 1) - 1;
    for (let i = 0;i < 10; i++)
      g[i] &= mask;
    mask = ~mask;
    for (let i = 0;i < 10; i++)
      h[i] = h[i] & mask | g[i];
    h[0] = (h[0] | h[1] << 13) & 65535;
    h[1] = (h[1] >>> 3 | h[2] << 10) & 65535;
    h[2] = (h[2] >>> 6 | h[3] << 7) & 65535;
    h[3] = (h[3] >>> 9 | h[4] << 4) & 65535;
    h[4] = (h[4] >>> 12 | h[5] << 1 | h[6] << 14) & 65535;
    h[5] = (h[6] >>> 2 | h[7] << 11) & 65535;
    h[6] = (h[7] >>> 5 | h[8] << 8) & 65535;
    h[7] = (h[8] >>> 8 | h[9] << 5) & 65535;
    let f = h[0] + pad[0];
    h[0] = f & 65535;
    for (let i = 1;i < 8; i++) {
      f = (h[i] + pad[i] | 0) + (f >>> 16) | 0;
      h[i] = f & 65535;
    }
    clean2(g);
  }
  update(data) {
    aexists2(this);
    abytes4(data);
    data = copyBytes2(data);
    const { buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0;pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        for (;blockLen <= len - pos; pos += blockLen)
          this.process(data, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(buffer, 0, false);
        this.pos = 0;
      }
    }
    return this;
  }
  destroy() {
    clean2(this.h, this.r, this.buffer, this.pad);
  }
  digestInto(out) {
    aexists2(this);
    aoutput2(out, this);
    this.finished = true;
    const { buffer, h } = this;
    let { pos } = this;
    if (pos) {
      buffer[pos++] = 1;
      for (;pos < 16; pos++)
        buffer[pos] = 0;
      this.process(buffer, 0, true);
    }
    this.finalize();
    let opos = 0;
    for (let i = 0;i < 8; i++) {
      out[opos++] = h[i] >>> 0;
      out[opos++] = h[i] >>> 8;
    }
    return out;
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
}
function wrapConstructorWithKey(hashCons) {
  const hashC = (msg, key) => hashCons(key).update(msg).digest();
  const tmp = hashCons(new Uint8Array(32));
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (key) => hashCons(key);
  return hashC;
}
var poly1305 = /* @__PURE__ */ (() => wrapConstructorWithKey((key) => new Poly1305(key)))();

// node_modules/@noble/ciphers/chacha.js
function chachaCore(s, k, n, out, cnt, rounds = 20) {
  let y00 = s[0], y01 = s[1], y02 = s[2], y03 = s[3], y04 = k[0], y05 = k[1], y06 = k[2], y07 = k[3], y08 = k[4], y09 = k[5], y10 = k[6], y11 = k[7], y12 = cnt, y13 = n[0], y14 = n[1], y15 = n[2];
  let x00 = y00, x01 = y01, x02 = y02, x03 = y03, x04 = y04, x05 = y05, x06 = y06, x07 = y07, x08 = y08, x09 = y09, x10 = y10, x11 = y11, x12 = y12, x13 = y13, x14 = y14, x15 = y15;
  for (let r = 0;r < rounds; r += 2) {
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 16);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 12);
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 8);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 7);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 16);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 12);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 8);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 7);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 16);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 12);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 8);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 7);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 16);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 12);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 8);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 7);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 16);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 12);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 8);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 7);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 16);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 12);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 8);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 7);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 16);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 12);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 8);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 7);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 16);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 12);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 8);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 7);
  }
  let oi = 0;
  out[oi++] = y00 + x00 | 0;
  out[oi++] = y01 + x01 | 0;
  out[oi++] = y02 + x02 | 0;
  out[oi++] = y03 + x03 | 0;
  out[oi++] = y04 + x04 | 0;
  out[oi++] = y05 + x05 | 0;
  out[oi++] = y06 + x06 | 0;
  out[oi++] = y07 + x07 | 0;
  out[oi++] = y08 + x08 | 0;
  out[oi++] = y09 + x09 | 0;
  out[oi++] = y10 + x10 | 0;
  out[oi++] = y11 + x11 | 0;
  out[oi++] = y12 + x12 | 0;
  out[oi++] = y13 + x13 | 0;
  out[oi++] = y14 + x14 | 0;
  out[oi++] = y15 + x15 | 0;
}
function hchacha(s, k, i, out) {
  let x00 = s[0], x01 = s[1], x02 = s[2], x03 = s[3], x04 = k[0], x05 = k[1], x06 = k[2], x07 = k[3], x08 = k[4], x09 = k[5], x10 = k[6], x11 = k[7], x12 = i[0], x13 = i[1], x14 = i[2], x15 = i[3];
  for (let r = 0;r < 20; r += 2) {
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 16);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 12);
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 8);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 7);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 16);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 12);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 8);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 7);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 16);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 12);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 8);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 7);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 16);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 12);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 8);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 7);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 16);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 12);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 8);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 7);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 16);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 12);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 8);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 7);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 16);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 12);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 8);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 7);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 16);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 12);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 8);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 7);
  }
  let oi = 0;
  out[oi++] = x00;
  out[oi++] = x01;
  out[oi++] = x02;
  out[oi++] = x03;
  out[oi++] = x12;
  out[oi++] = x13;
  out[oi++] = x14;
  out[oi++] = x15;
}
var chacha20 = /* @__PURE__ */ createCipher(chachaCore, {
  counterRight: false,
  counterLength: 4,
  allowShortKeys: false
});
var xchacha20 = /* @__PURE__ */ createCipher(chachaCore, {
  counterRight: false,
  counterLength: 8,
  extendNonceFn: hchacha,
  allowShortKeys: false
});
var ZEROS16 = /* @__PURE__ */ new Uint8Array(16);
var updatePadded = (h, msg) => {
  h.update(msg);
  const leftover = msg.length % 16;
  if (leftover)
    h.update(ZEROS16.subarray(leftover));
};
var ZEROS32 = /* @__PURE__ */ new Uint8Array(32);
function computeTag(fn, key, nonce, ciphertext, AAD) {
  if (AAD !== undefined)
    abytes4(AAD, undefined, "AAD");
  const authKey = fn(key, nonce, ZEROS32);
  const lengths = u64Lengths(ciphertext.length, AAD ? AAD.length : 0, true);
  const h = poly1305.create(authKey);
  if (AAD)
    updatePadded(h, AAD);
  updatePadded(h, ciphertext);
  h.update(lengths);
  const res = h.digest();
  clean2(authKey, lengths);
  return res;
}
var _poly1305_aead = (xorStream) => (key, nonce, AAD) => {
  const tagLength = 16;
  return {
    encrypt(plaintext, output) {
      const plength = plaintext.length;
      output = getOutput(plength + tagLength, output, false);
      output.set(plaintext);
      const oPlain = output.subarray(0, -tagLength);
      xorStream(key, nonce, oPlain, oPlain, 1);
      const tag = computeTag(xorStream, key, nonce, oPlain, AAD);
      output.set(tag, plength);
      clean2(tag);
      return output;
    },
    decrypt(ciphertext, output) {
      output = getOutput(ciphertext.length - tagLength, output, false);
      const data = ciphertext.subarray(0, -tagLength);
      const passedTag = ciphertext.subarray(-tagLength);
      const tag = computeTag(xorStream, key, nonce, data, AAD);
      if (!equalBytes(passedTag, tag))
        throw new Error("invalid tag");
      output.set(ciphertext.subarray(0, -tagLength));
      xorStream(key, nonce, output, output, 1);
      clean2(tag);
      return output;
    }
  };
};
var chacha20poly1305 = /* @__PURE__ */ wrapCipher({ blockSize: 64, nonceLength: 12, tagLength: 16 }, _poly1305_aead(chacha20));
var xchacha20poly1305 = /* @__PURE__ */ wrapCipher({ blockSize: 64, nonceLength: 24, tagLength: 16 }, _poly1305_aead(xchacha20));

// node_modules/@noble/hashes/hkdf.js
function extract(hash, ikm, salt) {
  ahash(hash);
  if (salt === undefined)
    salt = new Uint8Array(hash.outputLen);
  return hmac(hash, salt, ikm);
}
var HKDF_COUNTER = /* @__PURE__ */ Uint8Array.of(0);
var EMPTY_BUFFER = /* @__PURE__ */ Uint8Array.of();
function expand(hash, prk, info, length = 32, _recycled) {
  ahash(hash);
  anumber(length, "length");
  abytes(prk, undefined, "prk");
  const olen = hash.outputLen;
  if (prk.length < olen)
    throw new Error('"prk" must be at least HashLen octets');
  if (length > 255 * olen)
    throw new Error("Length must be <= 255*HashLen");
  const blocks = Math.ceil(length / olen);
  if (info === undefined)
    info = EMPTY_BUFFER;
  else
    abytes(info, undefined, "info");
  if (!blocks) {
    if (_recycled)
      clean(prk);
    return new Uint8Array;
  }
  const okm = _recycled && blocks === 1 ? prk : new Uint8Array(blocks * olen);
  const { iHash, oHash } = hmac.create(hash, prk);
  const T = _recycled ? prk : new Uint8Array(olen);
  const worker = blocks > 1 ? _recycled?.iHash || hash.create() : undefined;
  for (let counter = 0;counter < blocks - 1; counter++) {
    HKDF_COUNTER[0] = counter + 1;
    const iWork = iHash._cloneInto(worker);
    if (counter)
      iWork.update(T);
    iWork.update(info).update(HKDF_COUNTER).digestInto(T);
    oHash._cloneInto(worker).update(T).digestInto(T);
    okm.set(T, olen * counter);
  }
  HKDF_COUNTER[0] = blocks;
  if (blocks > 1)
    iHash.update(T);
  iHash.update(info).update(HKDF_COUNTER).digestInto(T);
  oHash.update(T).digestInto(T);
  okm.set(T, olen * (blocks - 1));
  iHash.destroy();
  oHash.destroy();
  worker?.destroy();
  if (T !== okm)
    clean(T);
  clean(HKDF_COUNTER);
  if (length === okm.length)
    return okm;
  const res = okm.slice(0, length);
  clean(okm);
  return res;
}

// core/nostr/nip44.ts
var NIP44_VERSION = 2;
var SALT = utf8ToBytes("nip44-v2");
var MIN_PLAINTEXT_BYTES = 1;
var MAX_PLAINTEXT_BYTES = 65535;
function conversationKey(secretKey, peerPublicKeyHex) {
  const shared = secp256k1.getSharedSecret(secretKey, hexToBytes(`02${peerPublicKeyHex}`));
  return extract(sha256, shared.subarray(1, 33), SALT);
}
function messageKeys(conversation, nonce) {
  if (conversation.length !== 32)
    throw new Error("nip44: the conversation key must be 32 bytes");
  if (nonce.length !== 32)
    throw new Error("nip44: the nonce must be 32 bytes");
  const expanded = expand(sha256, conversation, nonce, 76);
  return {
    chachaKey: expanded.subarray(0, 32),
    chachaNonce: expanded.subarray(32, 44),
    hmacKey: expanded.subarray(44, 76)
  };
}
function paddedLength(length) {
  if (!Number.isInteger(length) || length < 1) {
    throw new Error(`nip44: plaintext length must be a positive integer, got ${length}`);
  }
  if (length <= 32)
    return 32;
  const nextPower = 1 << Math.floor(Math.log2(length - 1)) + 1;
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((length - 1) / chunk) + 1);
}
function pad(plaintext) {
  const bytes = utf8ToBytes(plaintext);
  if (bytes.length < MIN_PLAINTEXT_BYTES || bytes.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`nip44: plaintext must be ${MIN_PLAINTEXT_BYTES}..${MAX_PLAINTEXT_BYTES} bytes, got ${bytes.length}`);
  }
  const total = paddedLength(bytes.length);
  const out = new Uint8Array(2 + total);
  out[0] = bytes.length >>> 8 & 255;
  out[1] = bytes.length & 255;
  out.set(bytes, 2);
  return out;
}
function unpad(padded) {
  if (padded.length < 2)
    throw new Error("nip44: padded plaintext is too short");
  const length = padded[0] << 8 | padded[1];
  const bytes = padded.subarray(2, 2 + length);
  if (length < MIN_PLAINTEXT_BYTES || bytes.length !== length) {
    throw new Error("nip44: declared plaintext length does not match the payload");
  }
  if (padded.length !== 2 + paddedLength(length)) {
    throw new Error("nip44: padding length is not the one this plaintext requires");
  }
  return new TextDecoder().decode(bytes);
}
function encrypt(plaintext, conversation, nonce) {
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversation, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext));
  const mac = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
  return base64.encode(concatBytes(Uint8Array.of(NIP44_VERSION), nonce, ciphertext, mac));
}
function decrypt(payload, conversation) {
  if (payload.length === 0)
    throw new Error("nip44: empty payload");
  if (payload[0] === "#")
    throw new Error("nip44: this payload declares an unsupported version");
  let bytes;
  try {
    bytes = base64.decode(payload);
  } catch {
    throw new Error("nip44: payload is not valid base64");
  }
  if (bytes.length < 99)
    throw new Error("nip44: payload is too short to be a v2 message");
  if (bytes[0] !== NIP44_VERSION)
    throw new Error(`nip44: unsupported version ${bytes[0]}`);
  const nonce = bytes.subarray(1, 33);
  const ciphertext = bytes.subarray(33, bytes.length - 32);
  const mac = bytes.subarray(bytes.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversation, nonce);
  const expected = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
  if (!timingSafeEqual(expected, mac)) {
    throw new Error("nip44: the message authentication code does not match");
  }
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0;i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
// core/nostr/nip17.ts
var CHAT_KIND = 14;
var SEAL_KIND = 13;
var GIFT_WRAP_KIND = 1059;
var MAX_TIMESTAMP_JITTER = 2 * 24 * 60 * 60;
function buildRumor(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildRumor: pubkey must be 64 lowercase hex characters");
  if (!isHex32(params.recipient))
    throw new Error("buildRumor: recipient must be 64 lowercase hex characters");
  const tags = [["p", params.recipient], ...params.tags ?? []];
  if (params.subject)
    tags.push(["subject", params.subject]);
  const unsigned = {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: CHAT_KIND,
    tags,
    content: params.content
  };
  return { ...unsigned, id: eventId(unsigned) };
}
function giftWrap(params) {
  const { rumor, senderSecretKey, recipient, entropy } = params;
  if (!isHex32(recipient))
    throw new Error("giftWrap: recipient must be 64 lowercase hex characters");
  const senderPubkey = bytesToHex(schnorr.getPublicKey(senderSecretKey));
  if (rumor.pubkey !== senderPubkey) {
    throw new Error("giftWrap: the rumor claims an author other than the signing key");
  }
  const sealed = signEvent({
    pubkey: senderPubkey,
    created_at: entropy.sealCreatedAt,
    kind: SEAL_KIND,
    tags: [],
    content: encrypt(JSON.stringify(rumor), conversationKey(senderSecretKey, recipient), entropy.sealNonce)
  }, senderSecretKey);
  const ephemeralPubkey = bytesToHex(schnorr.getPublicKey(entropy.ephemeralSecretKey));
  return signEvent({
    pubkey: ephemeralPubkey,
    created_at: entropy.wrapCreatedAt,
    kind: GIFT_WRAP_KIND,
    tags: [["p", recipient]],
    content: encrypt(JSON.stringify(sealed), conversationKey(entropy.ephemeralSecretKey, recipient), entropy.wrapNonce)
  }, entropy.ephemeralSecretKey);
}
function unwrap(wrap, recipientSecretKey) {
  if (wrap.kind !== GIFT_WRAP_KIND)
    return { ok: false, reason: `kind ${wrap.kind} is not ${GIFT_WRAP_KIND}` };
  const outer = checkEvent(wrap);
  if (!outer.ok)
    return { ok: false, reason: `gift wrap: ${outer.reason}` };
  let sealJson;
  try {
    sealJson = decrypt(wrap.content, conversationKey(recipientSecretKey, wrap.pubkey));
  } catch (err) {
    return { ok: false, reason: `gift wrap does not decrypt to this key: ${err.message}` };
  }
  let seal;
  try {
    seal = JSON.parse(sealJson);
  } catch {
    return { ok: false, reason: "the wrapped payload is not JSON" };
  }
  if (seal?.kind !== SEAL_KIND)
    return { ok: false, reason: "the wrapped payload is not a seal" };
  const inner = checkEvent(seal);
  if (!inner.ok)
    return { ok: false, reason: `seal: ${inner.reason}` };
  let rumorJson;
  try {
    rumorJson = decrypt(seal.content, conversationKey(recipientSecretKey, seal.pubkey));
  } catch (err) {
    return { ok: false, reason: `seal does not decrypt: ${err.message}` };
  }
  let rumor;
  try {
    rumor = JSON.parse(rumorJson);
  } catch {
    return { ok: false, reason: "the sealed payload is not JSON" };
  }
  if (rumor?.pubkey !== seal.pubkey) {
    return { ok: false, reason: "the message claims an author the seal was not signed by" };
  }
  if ("sig" in rumor && rumor.sig !== undefined) {
    return { ok: false, reason: "a rumor must not be signed" };
  }
  const expectedId = eventId(rumor);
  if (rumor.id !== expectedId)
    return { ok: false, reason: "the message id does not cover its own content" };
  return { ok: true, rumor, sender: seal.pubkey, sealedAt: seal.created_at };
}
function giftWrapFilter(recipient, since) {
  const filter = { kinds: [GIFT_WRAP_KIND], "#p": [recipient] };
  if (since !== undefined)
    filter.since = since - MAX_TIMESTAMP_JITTER;
  return filter;
}
// core/escrow/tagged.ts
var TAG_TAPLEAF = "TapLeaf";
var TAG_TAPBRANCH = "TapBranch";
var TAG_TAPTWEAK = "TapTweak";
var TAP_LEAF_VERSION = 192;
function taggedHash2(tag, ...msgs) {
  const prefix = sha256(utf8ToBytes(tag));
  return sha256(concatBytes(prefix, prefix, ...msgs));
}
function compactSize(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`compactSize: expected a non-negative integer, got ${describeValue(n)}`);
  }
  if (n <= 252)
    return Uint8Array.of(n);
  if (n <= 65535)
    return Uint8Array.of(253, n & 255, n >>> 8 & 255);
  if (n <= 4294967295) {
    return Uint8Array.of(254, n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255);
  }
  throw new Error(`compactSize: value ${n} exceeds the 32-bit range this encoder supports`);
}
function describeValue(value) {
  if (typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "bigint")
    return `${value}n`;
  if (typeof value === "object" && value !== null)
    return Object.prototype.toString.call(value);
  return String(value);
}
function assertLeafVersion(leafVersion) {
  if (!Number.isInteger(leafVersion) || leafVersion < 0 || leafVersion > 254) {
    throw new Error(`tapLeafHash: leafVersion must be an integer in 0..254, got ${describeValue(leafVersion)}`);
  }
  if ((leafVersion & 1) !== 0) {
    throw new Error(`tapLeafHash: leafVersion must be even: a verifier reads c[0] & 0xfe, so ${leafVersion} can never be committed to`);
  }
  if (leafVersion === 80) {
    throw new Error("tapLeafHash: leafVersion 0x50 is reserved; it collides with the annex marker");
  }
}
function tapLeafHash(script, leafVersion = TAP_LEAF_VERSION) {
  assertLeafVersion(leafVersion);
  return taggedHash2(TAG_TAPLEAF, Uint8Array.of(leafVersion), compactSize(script.length), script);
}
function tapBranchHash(a, b) {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  return taggedHash2(TAG_TAPBRANCH, lo, hi);
}
function tapTweakHash(internalKeyX, merkleRoot) {
  return taggedHash2(TAG_TAPTWEAK, internalKeyX, merkleRoot);
}
function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0;i < n; i++) {
    if (a[i] !== b[i])
      return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
function bytesEqual(a, b) {
  return compareBytes(a, b) === 0;
}

// core/escrow/script.ts
var OP = Object.freeze({
  PUSH32: 32,
  OP_1: 81,
  OP_16: 96,
  CHECKSIG: 172,
  CHECKSIGVERIFY: 173,
  CHECKSEQUENCEVERIFY: 178,
  DROP: 117
});
var XONLY_PUBKEY_BYTES = 32;
var MAX_TIMEOUT_BLOCKS = 65535;
var MIN_TIMEOUT_BLOCKS = 1;
function scriptNum(n) {
  if (!Number.isInteger(n)) {
    throw new Error(`scriptNum: expected an integer, got ${describeValue(n)}`);
  }
  if (n < 0) {
    throw new Error(`scriptNum: negative values are not used by this protocol, got ${describeValue(n)}`);
  }
  if (n === 0)
    return new Uint8Array(0);
  const out = [];
  let v = n;
  while (v > 0) {
    out.push(v & 255);
    v = Math.floor(v / 256);
  }
  if (out[out.length - 1] & 128)
    out.push(0);
  return Uint8Array.from(out);
}
function minimalPushNum(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`minimalPushNum: expected a non-negative integer, got ${describeValue(n)}`);
  }
  if (n >= 1 && n <= 16)
    return Uint8Array.of(OP.OP_1 + n - 1);
  const payload = scriptNum(n);
  if (payload.length > 75) {
    throw new Error(`minimalPushNum: ${n} needs OP_PUSHDATA, which this protocol never uses`);
  }
  return concatBytes(Uint8Array.of(payload.length), payload);
}
function assertXOnly(name, key) {
  if (!(key instanceof Uint8Array))
    throw new Error(`${name}: expected a Uint8Array`);
  if (key.length !== XONLY_PUBKEY_BYTES) {
    throw new Error(`${name}: expected a ${XONLY_PUBKEY_BYTES}-byte x-only pubkey, got ${key.length} bytes`);
  }
}
function pushKey(key) {
  return concatBytes(Uint8Array.of(OP.PUSH32), key);
}
function cooperativeLeaf(firstKey, secondKey) {
  assertXOnly("cooperativeLeaf/firstKey", firstKey);
  assertXOnly("cooperativeLeaf/secondKey", secondKey);
  return concatBytes(pushKey(firstKey), Uint8Array.of(OP.CHECKSIGVERIFY), pushKey(secondKey), Uint8Array.of(OP.CHECKSIG));
}
function timeoutLeaf(timeoutBlocks, payeeKey) {
  assertXOnly("timeoutLeaf/payeeKey", payeeKey);
  assertTimeoutBlocks(timeoutBlocks);
  return concatBytes(minimalPushNum(timeoutBlocks), Uint8Array.of(OP.CHECKSEQUENCEVERIFY, OP.DROP), pushKey(payeeKey), Uint8Array.of(OP.CHECKSIG));
}
function assertTimeoutBlocks(timeoutBlocks) {
  if (typeof timeoutBlocks !== "number" || !Number.isInteger(timeoutBlocks)) {
    throw new Error(`timeoutBlocks: expected an integer, got ${describeValue(timeoutBlocks)}`);
  }
  if (timeoutBlocks < MIN_TIMEOUT_BLOCKS || timeoutBlocks > MAX_TIMEOUT_BLOCKS) {
    throw new Error(`timeoutBlocks: must be in ${MIN_TIMEOUT_BLOCKS}..${MAX_TIMEOUT_BLOCKS} (BIP-68 block range), got ${timeoutBlocks}`);
  }
}
function taprootScriptPubKey(outputKey) {
  assertXOnly("taprootScriptPubKey/outputKey", outputKey);
  return concatBytes(Uint8Array.of(OP.OP_1, OP.PUSH32), outputKey);
}
function timeoutSequence(timeoutBlocks) {
  assertTimeoutBlocks(timeoutBlocks);
  return timeoutBlocks;
}
var RBF_SEQUENCE = 4294967293;

// core/escrow/tree.ts
var NUMS_BYTES = sha256(secp256k1.Point.BASE.toBytes(false));
function numsInternalKey() {
  return Uint8Array.from(NUMS_BYTES);
}
var CURVE_ORDER = secp256k1.Point.Fn.ORDER;
var NETWORK_HRP = Object.freeze({
  mainnet: "bc",
  testnet: "tb",
  signet: "tb",
  regtest: "bcrt"
});
function bytesToNumberBE2(b) {
  let n = 0n;
  for (let i = 0;i < b.length; i++)
    n = n << 8n | BigInt(b[i]);
  return n;
}
function numberToBytesBE3(n, length) {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = length - 1;i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n)
    throw new Error("numberToBytesBE: value does not fit");
  return out;
}
function copy(b) {
  return Uint8Array.from(b);
}
function freezeInPlace(value) {
  Object.freeze(value);
  return value;
}
function validatePubkey(name, key) {
  if (!(key instanceof Uint8Array)) {
    throw new Error(`${name}: expected a Uint8Array x-only pubkey, got ${typeofDescription(key)}`);
  }
  if (key.length !== XONLY_PUBKEY_BYTES) {
    throw new Error(`${name}: expected a ${XONLY_PUBKEY_BYTES}-byte x-only pubkey, got ${key.length} bytes`);
  }
  try {
    schnorr.utils.lift_x(bytesToNumberBE2(key));
  } catch (cause) {
    throw new Error(`${name}: not a valid x-only point on secp256k1`, { cause });
  }
  if (bytesEqual(key, NUMS_BYTES)) {
    throw new Error(`${name}: equals the NUMS internal key, which nobody can sign for`);
  }
  return copy(key);
}
function typeofDescription(v) {
  if (v === null)
    return "null";
  if (v === undefined)
    return "undefined";
  return typeof v;
}
var ALLOWED_PARAMS = [
  "buyer",
  "seller",
  "arbiter",
  "timeoutTo",
  "timeoutBlocks"
];
function validateParams(params) {
  if (params === null || typeof params !== "object") {
    throw new Error("buildTree: expected a params object");
  }
  for (const key of Object.keys(params)) {
    if (!ALLOWED_PARAMS.includes(key)) {
      throw new Error(`buildTree: unknown parameter ${describeValue(key)}; expected only ` + `${ALLOWED_PARAMS.join(", ")}. The arbiter key must arrive as 'arbiter': ` + `under any other name it is dropped and this builds the two-leaf ` + `no-arbiter tree at a different address.`);
    }
  }
  const buyer = validatePubkey("buyer", params.buyer);
  const seller = validatePubkey("seller", params.seller);
  let arbiter;
  if ("arbiter" in params && params.arbiter !== undefined) {
    if (params.arbiter === null) {
      throw new Error("arbiter: omit the property for the no-arbiter tree; got null");
    }
    arbiter = validatePubkey("arbiter", params.arbiter);
  }
  if (bytesEqual(buyer, seller)) {
    throw new Error("buyer and seller must be different keys: leaf A would need only one signer");
  }
  if (arbiter) {
    if (bytesEqual(arbiter, buyer)) {
      throw new Error("arbiter must differ from buyer: leaf C would need only one signer");
    }
    if (bytesEqual(arbiter, seller)) {
      throw new Error("arbiter must differ from seller: leaf B would need only one signer");
    }
  }
  if (params.timeoutTo !== "buyer" && params.timeoutTo !== "seller") {
    throw new Error(`timeoutTo: must be 'buyer' or 'seller', got ${JSON.stringify(params.timeoutTo)}`);
  }
  assertTimeoutBlocks(params.timeoutBlocks);
  return { buyer, seller, arbiter, timeoutTo: params.timeoutTo, timeoutBlocks: params.timeoutBlocks };
}
function leafNode(leaf) {
  return { kind: "leaf", leaf, hash: leaf.hash };
}
function branchNode(left, right) {
  return { kind: "branch", hash: tapBranchHash(left.hash, right.hash), left, right };
}
function collectPaths(node, path, out) {
  if (node.kind === "leaf") {
    out.set(node.leaf.name, path);
    return;
  }
  collectPaths(node.left, [node.right.hash, ...path], out);
  collectPaths(node.right, [node.left.hash, ...path], out);
}
function signatureOrderFor2of2(scriptKeyOrder) {
  return [...scriptKeyOrder].reverse();
}
function deriveOutputKey(internalKeyX, merkleRoot) {
  const tweak = tapTweakHash(internalKeyX, merkleRoot);
  const t = bytesToNumberBE2(tweak);
  if (t >= CURVE_ORDER)
    throw new Error("TapTweak: t >= curve order; this key set is unusable");
  if (t === 0n)
    throw new Error("TapTweak: t == 0; this key set is unusable");
  const P = schnorr.utils.lift_x(bytesToNumberBE2(internalKeyX));
  const Q = P.add(secp256k1.Point.BASE.multiply(t)).toAffine();
  return {
    tweak,
    outputKey: numberToBytesBE3(Q.x, 32),
    parity: (Q.y & 1n) === 0n ? 0 : 1
  };
}
function encodeTaprootAddress(outputKey, hrp) {
  if (outputKey.length !== 32) {
    throw new Error(`encodeTaprootAddress: expected a 32-byte output key, got ${outputKey.length}`);
  }
  return bech32m.encode(hrp, [1, ...bech32m.toWords(outputKey)]);
}
function allAddresses(outputKey) {
  return {
    mainnet: encodeTaprootAddress(outputKey, NETWORK_HRP.mainnet),
    testnet: encodeTaprootAddress(outputKey, NETWORK_HRP.testnet),
    signet: encodeTaprootAddress(outputKey, NETWORK_HRP.signet),
    regtest: encodeTaprootAddress(outputKey, NETWORK_HRP.regtest)
  };
}
function buildTree(params) {
  const p = validateParams(params);
  const timeoutPayee = p.timeoutTo === "buyer" ? p.buyer : p.seller;
  const drafts = [];
  const scriptA = cooperativeLeaf(p.buyer, p.seller);
  drafts.push({
    name: "A",
    role: "cooperative",
    script: scriptA,
    hash: tapLeafHash(scriptA),
    scriptKeyOrder: ["buyer", "seller"],
    sequence: RBF_SEQUENCE
  });
  if (p.arbiter) {
    const scriptB = cooperativeLeaf(p.seller, p.arbiter);
    drafts.push({
      name: "B",
      role: "arbiter-release",
      script: scriptB,
      hash: tapLeafHash(scriptB),
      scriptKeyOrder: ["seller", "arbiter"],
      sequence: RBF_SEQUENCE
    });
    const scriptC = cooperativeLeaf(p.buyer, p.arbiter);
    drafts.push({
      name: "C",
      role: "arbiter-refund",
      script: scriptC,
      hash: tapLeafHash(scriptC),
      scriptKeyOrder: ["buyer", "arbiter"],
      sequence: RBF_SEQUENCE
    });
  }
  const scriptD = timeoutLeaf(p.timeoutBlocks, timeoutPayee);
  drafts.push({
    name: "D",
    role: "timeout",
    script: scriptD,
    hash: tapLeafHash(scriptD),
    scriptKeyOrder: [p.timeoutTo],
    sequence: timeoutSequence(p.timeoutBlocks)
  });
  const byName = new Map(drafts.map((d) => [d.name, leafNode(d)]));
  const shape = p.arbiter ? "arbiter-4leaf" : "no-arbiter-2leaf";
  let root;
  const branches = [];
  if (p.arbiter) {
    const ab = branchNode(byName.get("A"), byName.get("B"));
    const cd = branchNode(byName.get("C"), byName.get("D"));
    root = branchNode(ab, cd);
    branches.push({ label: "branch(A,B)", hash: ab.hash }, { label: "branch(C,D)", hash: cd.hash }, { label: "root = branch(branch(A,B),branch(C,D))", hash: root.hash });
  } else {
    root = branchNode(byName.get("A"), byName.get("D"));
    branches.push({ label: "root = branch(A,D)", hash: root.hash });
  }
  const merkleRoot = root.hash;
  const paths = new Map;
  collectPaths(root, [], paths);
  const { tweak, outputKey, parity } = deriveOutputKey(NUMS_BYTES, merkleRoot);
  const scriptPubKey = taprootScriptPubKey(outputKey);
  const leafList = drafts.map((d) => {
    const merklePath = paths.get(d.name);
    const signatureOrder = d.name === "D" ? d.scriptKeyOrder.slice() : signatureOrderFor2of2(d.scriptKeyOrder);
    const leaf = {
      name: d.name,
      role: d.role,
      script: d.script,
      leafVersion: TAP_LEAF_VERSION,
      hash: d.hash,
      merklePath: freezeInPlace(merklePath),
      controlBlock: concatBytes(Uint8Array.of(TAP_LEAF_VERSION | parity), NUMS_BYTES, ...merklePath),
      scriptKeyOrder: freezeInPlace(d.scriptKeyOrder),
      signatureOrder: freezeInPlace(signatureOrder),
      witnessStack: freezeInPlace([
        ...signatureOrder.map((r) => `sig_${r}`),
        `script_${d.name}`,
        "control_block"
      ]),
      sequence: d.sequence
    };
    return freezeInPlace(leaf);
  });
  freezeInPlace(leafList);
  const leaves = freezeInPlace(Object.fromEntries(leafList.map((l) => [l.name, l])));
  for (const b of branches)
    freezeInPlace(b);
  freezeInPlace(branches);
  const tree = {
    shape,
    params: freezeInPlace({
      buyer: p.buyer,
      seller: p.seller,
      ...p.arbiter ? { arbiter: p.arbiter } : {},
      timeoutTo: p.timeoutTo,
      timeoutBlocks: p.timeoutBlocks
    }),
    leaves,
    leafList,
    branches,
    merkleRoot,
    internalKey: numsInternalKey(),
    tweak,
    outputKey,
    parity,
    scriptPubKey,
    controlBlockLength: leafList[0].controlBlock.length,
    addresses: freezeInPlace(allAddresses(outputKey)),
    txVersion: 2
  };
  return freezeInPlace(tree);
}
var CONTROL_BLOCK_MAX_NODES = 128;
var CONTROL_BLOCK_MAX_SIZE = 33 + 32 * CONTROL_BLOCK_MAX_NODES;

// core/nostr/escrow.ts
var ESCROW_KIND = 30078;
var ESCROW_D_PREFIX = "fmd:escrow:";
var ESCROW_TOPIC = "flexmydomain";
var ESCROW_VERSION = 1;
function deriveEscrowId(params) {
  const preimage = concatBytes(utf8ToBytes("fmd:escrow:v1"), hexToBytes(params.salt), params.buyer, params.seller, params.arbiter ?? new Uint8Array(32), utf8ToBytes(`${params.timeoutTo}:${params.timeoutBlocks}:${params.network}:${params.amountSats}:${normaliseDomain(params.domain)}`));
  return bytesToHex(sha256(preimage)).slice(0, 32);
}
function escrowAddress(params) {
  const tree = buildTree({
    buyer: params.buyer,
    seller: params.seller,
    arbiter: params.arbiter,
    timeoutTo: params.timeoutTo,
    timeoutBlocks: params.timeoutBlocks
  });
  return tree.addresses[params.network];
}
function buildEscrowEvent(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildEscrowEvent: pubkey must be 64 lowercase hex characters");
  if (!/^[0-9a-f]{64}$/.test(params.salt))
    throw new Error("buildEscrowEvent: salt must be 64 lowercase hex characters");
  if (!Number.isSafeInteger(params.amountSats) || params.amountSats <= 0) {
    throw new Error("buildEscrowEvent: amountSats must be a positive integer");
  }
  const domain = normaliseDomain(params.domain);
  const id = deriveEscrowId(params);
  const address = escrowAddress(params);
  const tags = [
    ["d", ESCROW_D_PREFIX + id],
    ["t", ESCROW_TOPIC],
    ["fmd_domain", domain],
    ["p", bytesToHex(params.buyer)],
    ["p", bytesToHex(params.seller)]
  ];
  if (params.arbiter)
    tags.push(["p", bytesToHex(params.arbiter)]);
  if (params.listing)
    tags.push(["a", params.listing]);
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: ESCROW_KIND,
    tags,
    content: JSON.stringify({
      v: ESCROW_VERSION,
      id,
      salt: params.salt,
      buyer_x: bytesToHex(params.buyer),
      seller_x: bytesToHex(params.seller),
      arbiter_x: params.arbiter ? bytesToHex(params.arbiter) : null,
      timeout_to: params.timeoutTo,
      timeout_blocks: params.timeoutBlocks,
      network: params.network,
      address,
      amount_sats: params.amountSats,
      domain,
      ...params.listing ? { listing: params.listing } : {},
      ...params.funding ? { funding: params.funding } : {},
      ...params.commitment ? { commitment: params.commitment } : {},
      ...params.deadlines ? { deadlines: params.deadlines } : {},
      ...params.rdapSnapshots?.length ? { rdap_snapshots: params.rdapSnapshots } : {},
      ...params.settlementTxid ? { settlement_txid: params.settlementTxid } : {}
    })
  };
}
function parseEscrowEvent(event) {
  if (event.kind !== ESCROW_KIND)
    return { ok: false, reason: `kind ${event.kind} is not ${ESCROW_KIND}` };
  const d = tagValue(event, "d");
  if (!d || !d.startsWith(ESCROW_D_PREFIX)) {
    return { ok: false, reason: `d tag ${JSON.stringify(d ?? null)} is not a ${ESCROW_D_PREFIX}* identifier` };
  }
  let body;
  try {
    body = JSON.parse(event.content);
  } catch (err) {
    return { ok: false, reason: `content is not JSON: ${err.message}` };
  }
  const str = (k) => typeof body[k] === "string" ? body[k] : undefined;
  const num2 = (k) => typeof body[k] === "number" && Number.isSafeInteger(body[k]) ? body[k] : undefined;
  const salt = str("salt");
  const buyer = str("buyer_x");
  const seller = str("seller_x");
  const arbiter = str("arbiter_x") ?? undefined;
  const timeoutTo = body.timeout_to === "seller" ? "seller" : body.timeout_to === "buyer" ? "buyer" : undefined;
  const timeoutBlocks = num2("timeout_blocks");
  const network = str("network");
  const address = str("address");
  const amountSats = num2("amount_sats");
  const domain = tryNormaliseDomain(body.domain);
  if (!salt || !/^[0-9a-f]{64}$/.test(salt))
    return { ok: false, reason: "no salt" };
  if (!isHex32(buyer) || !isHex32(seller))
    return { ok: false, reason: "buyer or seller key is malformed" };
  if (arbiter !== undefined && !isHex32(arbiter))
    return { ok: false, reason: "arbiter key is malformed" };
  if (!timeoutTo)
    return { ok: false, reason: "no timeout polarity" };
  if (timeoutBlocks === undefined || timeoutBlocks < 1 || timeoutBlocks > 65535) {
    return { ok: false, reason: "timeout_blocks is out of range" };
  }
  if (!network || !["mainnet", "testnet", "signet", "regtest"].includes(network)) {
    return { ok: false, reason: `unknown network ${JSON.stringify(network ?? null)}` };
  }
  if (!address)
    return { ok: false, reason: "no address" };
  if (amountSats === undefined || amountSats <= 0)
    return { ok: false, reason: "no amount" };
  if (!domain.ok)
    return { ok: false, reason: `domain: ${domain.reason}` };
  const params = {
    salt,
    buyer: hexToBytes(buyer),
    seller: hexToBytes(seller),
    ...arbiter ? { arbiter: hexToBytes(arbiter) } : {},
    timeoutTo,
    timeoutBlocks,
    network,
    amountSats,
    domain: domain.domain
  };
  let derived;
  try {
    derived = escrowAddress(params);
  } catch (err) {
    return { ok: false, reason: `the parameters do not produce a valid output: ${err.message}` };
  }
  if (derived !== address) {
    return {
      ok: false,
      reason: `the stated address is not the one these keys produce (derived ${derived}); do not fund it`
    };
  }
  const id = deriveEscrowId(params);
  if (d !== ESCROW_D_PREFIX + id) {
    return { ok: false, reason: `the d tag does not match the id these parameters derive (${id})` };
  }
  const funding = body.funding;
  const commitment = body.commitment;
  const deadlines = body.deadlines ?? {};
  return {
    ok: true,
    view: {
      version: typeof body.v === "number" ? body.v : 0,
      id,
      author: event.pubkey,
      salt,
      buyer,
      seller,
      arbiter,
      timeoutTo,
      timeoutBlocks,
      network,
      address,
      amountSats,
      domain: domain.domain,
      listing: str("listing"),
      funding: funding && typeof funding.txid === "string" && /^[0-9a-f]{64}$/.test(funding.txid) ? {
        txid: funding.txid,
        vout: Number(funding.vout ?? 0),
        amountSats: Number(funding.amount_sats ?? funding.amountSats ?? 0)
      } : undefined,
      commitment: commitment ? {
        registrarIanaId: commitment.registrarIanaId ?? commitment.registrar_iana_id,
        nameservers: Array.isArray(commitment.nameservers) ? commitment.nameservers : []
      } : undefined,
      deadlines: {
        fundBy: deadlines.fundBy ?? deadlines.fund_by,
        transferBy: deadlines.transferBy ?? deadlines.transfer_by,
        respondBy: deadlines.respondBy ?? deadlines.respond_by
      },
      rdapSnapshots: Array.isArray(body.rdap_snapshots) ? body.rdap_snapshots.filter((h) => typeof h === "string") : [],
      settlementTxid: str("settlement_txid"),
      publishedAt: event.created_at,
      event
    }
  };
}
function compareViews(views) {
  if (views.length === 0)
    return { agreed: true, disagreements: [], participants: [], strangers: [] };
  const first = views[0];
  const members = new Set([first.buyer, first.seller, ...first.arbiter ? [first.arbiter] : []]);
  const participants = views.filter((v) => members.has(v.author));
  const strangers = views.filter((v) => !members.has(v.author));
  const latest = new Map;
  for (const view of participants) {
    const current2 = latest.get(view.author);
    if (!current2 || view.publishedAt > current2.publishedAt)
      latest.set(view.author, view);
  }
  const current = [...latest.values()];
  const fields = [
    ["address", (v) => v.address],
    ["amount", (v) => String(v.amountSats)],
    ["domain", (v) => v.domain],
    ["buyer key", (v) => v.buyer],
    ["seller key", (v) => v.seller],
    ["arbiter key", (v) => v.arbiter ?? "none"],
    ["timeout polarity", (v) => v.timeoutTo],
    ["timelock", (v) => String(v.timeoutBlocks)],
    ["network", (v) => v.network],
    ["funding outpoint", (v) => v.funding ? `${v.funding.txid}:${v.funding.vout}` : "none"],
    ["settlement txid", (v) => v.settlementTxid ?? "none"]
  ];
  const disagreements = [];
  for (const [field, read] of fields) {
    const seen = new Map;
    for (const view of current) {
      const value = read(view);
      const authors = seen.get(value);
      if (authors)
        authors.push(view.author);
      else
        seen.set(value, [view.author]);
    }
    if (seen.size > 1) {
      disagreements.push({
        field,
        values: [...seen.entries()].flatMap(([value, authors]) => authors.map((author) => ({ author, value })))
      });
    }
  }
  return {
    agreed: disagreements.length === 0,
    disagreements,
    participants: current,
    strangers,
    newest: current.sort((a, b) => b.publishedAt - a.publishedAt)[0]
  };
}
function deriveEscrowState(params) {
  if (params.spent) {
    return { state: "settled", reason: "the escrow output has been spent, so the trade is over one way or another" };
  }
  if (params.funded) {
    if (params.transferPending) {
      return { state: "transferring", reason: "the registry shows a transfer underway on this domain" };
    }
    return { state: "funded", reason: "a confirmed payment is sitting in the escrow output" };
  }
  const fundBy = params.view.deadlines.fundBy;
  if (fundBy !== undefined && params.now !== undefined && params.now > fundBy) {
    return { state: "expired", reason: "the funding deadline passed and nothing was paid" };
  }
  return { state: "open", reason: "published, and waiting to be funded" };
}
function escrowFilter(id) {
  return { kinds: [ESCROW_KIND], "#d": [ESCROW_D_PREFIX + id] };
}
function escrowsForFilter(pubkeys) {
  return { kinds: [ESCROW_KIND], "#p": [...pubkeys] };
}
// core/nostr/handshake.ts
var INVITE_PREFIX = "fmdinv1";
var REPLY_PREFIX = "fmdrep1";
var HEX32 = /^[0-9a-f]{64}$/;
var NETWORKS = ["mainnet", "testnet", "signet", "regtest"];
function encode(prefix, value) {
  return prefix + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(value)));
}
function decode(prefix, text) {
  if (typeof text !== "string")
    return { ok: false, reason: "not a string" };
  const trimmed = text.trim().replace(/\s+/g, "");
  if (!trimmed.startsWith(prefix)) {
    return { ok: false, reason: `this should start with "${prefix}"` };
  }
  try {
    const json = new TextDecoder().decode(base64urlnopad.decode(trimmed.slice(prefix.length)));
    const value = JSON.parse(json);
    if (typeof value !== "object" || value === null)
      return { ok: false, reason: "not an object" };
    return { ok: true, value };
  } catch {
    return { ok: false, reason: "it did not decode: a character is missing or wrong" };
  }
}
function readCommitment(raw) {
  if (typeof raw !== "object" || raw === null)
    return;
  const c = raw;
  const nameservers = Array.isArray(c.nameservers) ? c.nameservers.filter((n) => typeof n === "string").map((n) => n.trim().toLowerCase()) : [];
  const registrarIanaId = typeof c.registrarIanaId === "string" && c.registrarIanaId.trim() !== "" ? c.registrarIanaId.trim() : undefined;
  if (!registrarIanaId && nameservers.length === 0)
    return;
  return { registrarIanaId, nameservers };
}
function encodeInvite(invite) {
  if (!HEX32.test(invite.salt))
    throw new Error("encodeInvite: salt must be 64 lowercase hex characters");
  if (!HEX32.test(invite.initiatorKey))
    throw new Error("encodeInvite: initiatorKey must be x-only hex");
  if (invite.arbiter !== undefined && !HEX32.test(invite.arbiter)) {
    throw new Error("encodeInvite: arbiter must be x-only hex");
  }
  if (!Number.isSafeInteger(invite.amountSats) || invite.amountSats <= 0) {
    throw new Error("encodeInvite: amountSats must be a positive integer");
  }
  if (invite.initiatorRole === "buyer" && !invite.commitment) {
    throw new Error("encodeInvite: a buyer must commit to where they will receive the domain");
  }
  return encode(INVITE_PREFIX, {
    v: 1,
    salt: invite.salt,
    domain: normaliseDomain(invite.domain),
    amountSats: invite.amountSats,
    network: invite.network,
    timeoutBlocks: invite.timeoutBlocks,
    timeoutTo: invite.timeoutTo,
    ...invite.arbiter ? { arbiter: invite.arbiter } : {},
    initiatorRole: invite.initiatorRole,
    initiatorKey: invite.initiatorKey,
    ...invite.commitment ? { commitment: invite.commitment } : {}
  });
}
function decodeInvite(text) {
  const parsed = decode(INVITE_PREFIX, text);
  if (!parsed.ok)
    return parsed;
  const v = parsed.value;
  if (v.v !== 1)
    return { ok: false, reason: `unsupported invite version ${String(v.v)}` };
  if (typeof v.salt !== "string" || !HEX32.test(v.salt))
    return { ok: false, reason: "the invite has no valid salt" };
  if (typeof v.initiatorKey !== "string" || !HEX32.test(v.initiatorKey)) {
    return { ok: false, reason: "the invite has no valid escrow key" };
  }
  if (v.arbiter !== undefined && (typeof v.arbiter !== "string" || !HEX32.test(v.arbiter))) {
    return { ok: false, reason: "the arbiter key is malformed" };
  }
  const domain = tryNormaliseDomain(v.domain);
  if (!domain.ok)
    return { ok: false, reason: `domain: ${domain.reason}` };
  const amountSats = Number(v.amountSats);
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0)
    return { ok: false, reason: "the amount is invalid" };
  if (!NETWORKS.includes(v.network))
    return { ok: false, reason: "unknown network" };
  const timeoutBlocks = Number(v.timeoutBlocks);
  if (!Number.isInteger(timeoutBlocks) || timeoutBlocks < 1 || timeoutBlocks > 65535) {
    return { ok: false, reason: "the timelock is out of range" };
  }
  if (v.timeoutTo !== "buyer" && v.timeoutTo !== "seller")
    return { ok: false, reason: "no timeout polarity" };
  if (v.initiatorRole !== "buyer" && v.initiatorRole !== "seller")
    return { ok: false, reason: "no role" };
  const commitment = readCommitment(v.commitment);
  if (v.initiatorRole === "buyer" && !commitment) {
    return { ok: false, reason: "the buyer did not say where they will receive the domain" };
  }
  return {
    ok: true,
    invite: {
      salt: v.salt,
      domain: domain.domain,
      amountSats,
      network: v.network,
      timeoutBlocks,
      timeoutTo: v.timeoutTo,
      arbiter: typeof v.arbiter === "string" ? v.arbiter : undefined,
      initiatorRole: v.initiatorRole,
      initiatorKey: v.initiatorKey,
      commitment
    }
  };
}
function encodeReply(reply) {
  if (!HEX32.test(reply.joinerKey))
    throw new Error("encodeReply: joinerKey must be x-only hex");
  if (!HEX32.test(reply.salt))
    throw new Error("encodeReply: salt must be 64 lowercase hex characters");
  return encode(REPLY_PREFIX, {
    v: 1,
    salt: reply.salt,
    joinerKey: reply.joinerKey,
    ...reply.commitment ? { commitment: reply.commitment } : {}
  });
}
function decodeReply(text, invite) {
  const parsed = decode(REPLY_PREFIX, text);
  if (!parsed.ok)
    return parsed;
  const v = parsed.value;
  if (v.v !== 1)
    return { ok: false, reason: `unsupported reply version ${String(v.v)}` };
  if (typeof v.joinerKey !== "string" || !HEX32.test(v.joinerKey)) {
    return { ok: false, reason: "the reply has no valid escrow key" };
  }
  if (v.salt !== invite.salt) {
    return { ok: false, reason: "this reply answers a different escrow: the salts do not match" };
  }
  if (v.joinerKey === invite.initiatorKey) {
    return { ok: false, reason: "the reply carries your own key back; ask them to join from the invite" };
  }
  if (invite.arbiter && v.joinerKey === invite.arbiter) {
    return { ok: false, reason: "the reply carries the arbiter key, and each party needs its own" };
  }
  const commitment = readCommitment(v.commitment);
  const joinerIsBuyer = invite.initiatorRole === "seller";
  if (joinerIsBuyer && !commitment) {
    return { ok: false, reason: "the buyer did not say where they will receive the domain" };
  }
  return { ok: true, reply: { joinerKey: v.joinerKey, salt: v.salt, commitment } };
}
function resolveHandshake(invite, reply) {
  const buyerKey = invite.initiatorRole === "buyer" ? invite.initiatorKey : reply.joinerKey;
  const sellerKey = invite.initiatorRole === "seller" ? invite.initiatorKey : reply.joinerKey;
  const commitment = invite.initiatorRole === "buyer" ? invite.commitment : reply.commitment;
  if (!commitment)
    throw new Error("resolveHandshake: no transfer commitment from the buyer");
  return {
    salt: invite.salt,
    domain: invite.domain,
    amountSats: invite.amountSats,
    network: invite.network,
    timeoutBlocks: invite.timeoutBlocks,
    timeoutTo: invite.timeoutTo,
    arbiter: invite.arbiter,
    buyerKey,
    sellerKey,
    commitment
  };
}
// core/nostr/deletion.ts
var DELETION_KIND = 5;
function buildDeletion(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildDeletion: pubkey must be 64 lowercase hex characters");
  if (params.events.length === 0)
    throw new Error("buildDeletion: nothing to delete");
  const tags = [];
  const kinds = new Set;
  for (const event of params.events) {
    if (event.pubkey !== params.pubkey) {
      throw new Error("buildDeletion: you can only request deletion of your own events");
    }
    if (event.kind >= 30000 && event.kind < 40000)
      tags.push(["a", addressOf(event)]);
    else
      tags.push(["e", event.id]);
    kinds.add(event.kind);
  }
  for (const kind of kinds)
    tags.push(["k", String(kind)]);
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: DELETION_KIND,
    tags,
    content: params.reason ?? ""
  };
}
function parseDeletion(event) {
  if (event.kind !== DELETION_KIND)
    return;
  return {
    ids: event.tags.filter((t) => t[0] === "e" && t[1]).map((t) => t[1]),
    addresses: event.tags.filter((t) => t[0] === "a" && t[1]).map((t) => t[1]),
    reason: event.content
  };
}
function applyDeletions(events, deletions) {
  const byAuthorIds = new Map;
  const byAuthorAddresses = new Map;
  for (const request of deletions) {
    const parsed = parseDeletion(request);
    if (!parsed)
      continue;
    const ids = byAuthorIds.get(request.pubkey) ?? new Set;
    for (const id of parsed.ids)
      ids.add(id);
    byAuthorIds.set(request.pubkey, ids);
    const addresses = byAuthorAddresses.get(request.pubkey) ?? new Map;
    for (const address of parsed.addresses) {
      const previous = addresses.get(address);
      addresses.set(address, previous === undefined ? request.created_at : Math.max(previous, request.created_at));
    }
    byAuthorAddresses.set(request.pubkey, addresses);
  }
  return events.filter((event) => {
    if (byAuthorIds.get(event.pubkey)?.has(event.id))
      return false;
    const at = byAuthorAddresses.get(event.pubkey)?.get(addressOf(event));
    return at === undefined || event.created_at > at;
  });
}
function deletionFilter(authors) {
  return { kinds: [DELETION_KIND], authors: [...authors] };
}
// core/nostr/relays.ts
var RELAY_LIST_KIND = 10002;
function normaliseRelayUrl(raw) {
  if (typeof raw !== "string")
    return;
  const trimmed = raw.trim();
  if (trimmed === "")
    return;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return;
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "wss:" && protocol !== "ws:")
    return;
  if (url.hostname === "")
    return;
  if (protocol === "wss:" && url.port === "443" || protocol === "ws:" && url.port === "80") {
    url.port = "";
  }
  url.hash = "";
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}
function buildRelayList(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildRelayList: pubkey must be 64 lowercase hex characters");
  const seen = new Set;
  const tags = [];
  for (const entry of params.relays) {
    const url = normaliseRelayUrl(entry.url);
    if (!url)
      throw new Error(`buildRelayList: ${JSON.stringify(entry.url)} is not a relay URL`);
    if (seen.has(url))
      continue;
    seen.add(url);
    if (!entry.read && !entry.write)
      continue;
    if (entry.read && entry.write)
      tags.push(["r", url]);
    else
      tags.push(["r", url, entry.write ? "write" : "read"]);
  }
  return { pubkey: params.pubkey, created_at: params.createdAt, kind: RELAY_LIST_KIND, tags, content: "" };
}
function parseRelayList(event) {
  if (event.kind !== RELAY_LIST_KIND)
    return [];
  const byUrl = new Map;
  for (const tag of event.tags) {
    if (tag[0] !== "r")
      continue;
    const url = normaliseRelayUrl(tag[1]);
    if (!url)
      continue;
    const marker = tag[2]?.toLowerCase();
    const entry = {
      url,
      read: marker !== "write",
      write: marker !== "read"
    };
    const existing = byUrl.get(url);
    byUrl.set(url, existing ? { url, read: existing.read || entry.read, write: existing.write || entry.write } : entry);
  }
  return [...byUrl.values()];
}
var READ_FANOUT = 4;
var WRITE_FANOUT = 5;
function preferOwn(own, fallback, max) {
  const mine = dedupe(own.map(normaliseRelayUrl).filter(isUrl));
  if (mine.length > 0)
    return mine.slice(0, max);
  return dedupe(fallback.map(normaliseRelayUrl).filter(isUrl)).slice(0, max);
}
function writeRelaysFor(list, fallback, max = WRITE_FANOUT) {
  return preferOwn(list.filter((r) => r.write).map((r) => r.url), fallback, max);
}
function readRelaysFor(list, fallback, max = READ_FANOUT) {
  return preferOwn(list.filter((r) => r.write).map((r) => r.url), fallback, max);
}
function inboxRelaysFor(list, fallback, max = READ_FANOUT) {
  return preferOwn(list.filter((r) => r.read).map((r) => r.url), fallback, max);
}
function planAuthorQuery(lists, authors, fallback, max = READ_FANOUT) {
  const plan = new Map;
  for (const author of authors) {
    for (const relay of readRelaysFor(lists.get(author) ?? [], fallback, max)) {
      const group = plan.get(relay);
      if (group)
        group.push(author);
      else
        plan.set(relay, [author]);
    }
  }
  return plan;
}
function relayListFilter(pubkeys) {
  return { kinds: [RELAY_LIST_KIND], authors: [...pubkeys] };
}
function isOwnRelayList(event, pubkey) {
  return event.kind === RELAY_LIST_KIND && event.pubkey === pubkey && tagValue(event, "d") === undefined;
}
var isUrl = (u) => typeof u === "string";
function dedupe(urls) {
  const seen = new Set;
  const out = [];
  for (const url of urls) {
    if (seen.has(url))
      continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
// core/nostr/portfolio.ts
var PORTFOLIO_KIND = 30078;
var PORTFOLIO_D = "fmd:portfolio";
var PORTFOLIO_TOPIC = "flexmydomain";
var PORTFOLIO_VERSION = 1;
function buildPortfolio(params) {
  if (!isHex32(params.pubkey))
    throw new Error("buildPortfolio: pubkey must be 64 lowercase hex characters");
  const seen = new Set;
  const entries = params.entries.map((entry) => {
    const domain = normaliseDomain(entry.domain);
    if (seen.has(domain))
      throw new Error(`buildPortfolio: ${domain} appears twice`);
    seen.add(domain);
    if (entry.source === "dns") {
      if (entry.iat === undefined || !isHex64(entry.sig ?? "")) {
        throw new Error(`buildPortfolio: the DNS entry for ${domain} has no proof attached`);
      }
      const digest = proofDigest({ domain, pubkey: params.pubkey, iat: entry.iat });
      if (!verifyDigestSignature(entry.sig, digest, params.pubkey)) {
        throw new Error(`buildPortfolio: the proof for ${domain} does not verify under this key`);
      }
    }
    return { ...entry, domain };
  });
  entries.sort((a, b) => a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0);
  return {
    pubkey: params.pubkey,
    created_at: params.createdAt,
    kind: PORTFOLIO_KIND,
    tags: [
      ["d", PORTFOLIO_D],
      ["t", PORTFOLIO_TOPIC]
    ],
    content: JSON.stringify({
      v: PORTFOLIO_VERSION,
      domains: entries.map((e) => ({
        domain: e.domain,
        source: e.source,
        first_seen: e.firstSeen,
        ...e.iat !== undefined ? { iat: e.iat } : {},
        ...e.sig !== undefined ? { sig: e.sig } : {},
        ...e.tagline ? { tagline: e.tagline } : {},
        ...e.forSale ? { for_sale: true } : {}
      }))
    })
  };
}
function parsePortfolio(event) {
  if (event.kind !== PORTFOLIO_KIND)
    return { ok: false, reason: `kind ${event.kind} is not ${PORTFOLIO_KIND}` };
  if (tagValue(event, "d") !== PORTFOLIO_D) {
    return { ok: false, reason: `d tag ${JSON.stringify(tagValue(event, "d") ?? null)} is not ${PORTFOLIO_D}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(event.content);
  } catch (err) {
    return { ok: false, reason: `content is not JSON: ${err.message}` };
  }
  if (typeof parsed !== "object" || parsed === null)
    return { ok: false, reason: "content is not an object" };
  const body = parsed;
  const list = Array.isArray(body.domains) ? body.domains : [];
  const entries = [];
  const dropped = [];
  for (const raw of list) {
    const entry = readEntry(raw);
    if ("reason" in entry)
      dropped.push({ entry: raw, reason: entry.reason });
    else
      entries.push(entry.entry);
  }
  return {
    ok: true,
    portfolio: {
      version: typeof body.v === "number" ? body.v : 0,
      pubkey: event.pubkey,
      entries,
      event
    },
    dropped
  };
}
function readEntry(raw) {
  if (typeof raw !== "object" || raw === null)
    return { reason: "not an object" };
  const e = raw;
  const domain = tryNormaliseDomain(e.domain);
  if (!domain.ok)
    return { reason: `domain: ${domain.reason}` };
  const source = e.source === "nip05" ? "nip05" : "dns";
  const iat = typeof e.iat === "number" && Number.isSafeInteger(e.iat) ? e.iat : undefined;
  const sig = isHex64(e.sig) ? e.sig : undefined;
  if (source === "dns" && (iat === undefined || sig === undefined)) {
    return { reason: "a DNS entry with no proof attached" };
  }
  const firstSeen = typeof e.first_seen === "number" && Number.isSafeInteger(e.first_seen) ? e.first_seen : iat ?? 0;
  return {
    entry: {
      domain: domain.domain,
      source,
      iat,
      sig,
      firstSeen,
      tagline: typeof e.tagline === "string" ? e.tagline : undefined,
      forSale: e.for_sale === true
    }
  };
}
function verifyPortfolio(portfolio) {
  return portfolio.entries.map((entry) => {
    if (entry.source === "nip05") {
      return {
        domain: entry.domain,
        proven: false,
        reason: "a NIP-05 proof carries no signature and can only be checked live"
      };
    }
    if (entry.iat === undefined || entry.sig === undefined) {
      return { domain: entry.domain, proven: false, reason: "no proof attached" };
    }
    const digest = proofDigest({ domain: entry.domain, pubkey: portfolio.pubkey, iat: entry.iat });
    const proven = verifyDigestSignature(entry.sig, digest, portfolio.pubkey);
    return {
      domain: entry.domain,
      proven,
      reason: proven ? undefined : "signature does not verify under this portfolio key",
      record: proven ? { version: PROOF_VERSION, iat: entry.iat, pubkey: portfolio.pubkey, sig: entry.sig } : undefined
    };
  });
}
function upsertEntry(entries, entry) {
  const domain = normaliseDomain(entry.domain);
  const existing = entries.find((e) => e.domain === domain);
  const merged = {
    ...entry,
    domain,
    firstSeen: existing ? Math.min(existing.firstSeen, entry.firstSeen) : entry.firstSeen
  };
  return [...entries.filter((e) => e.domain !== domain), merged].sort((a, b) => a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0);
}
function removeEntry(entries, domain) {
  const d = normaliseDomain(domain);
  return entries.filter((e) => e.domain !== d);
}
function portfolioFilter(pubkey) {
  return { kinds: [PORTFOLIO_KIND], authors: [pubkey], "#d": [PORTFOLIO_D], limit: 1 };
}

// core/nostr/index.ts
var DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.oxtr.dev",
  "wss://nostr.mom"
];
// core/escrow/tx.ts
var SIGHASH_EPOCH = 0;
var SIGHASH_DEFAULT = 0;
var EXT_FLAG_SCRIPT_PATH = 1;
var KEY_VERSION = 0;
var NO_CODESEP = 4294967295;
function u322(n) {
  if (!Number.isInteger(n) || n < 0 || n > 4294967295) {
    throw new Error(`u32: expected a uint32, got ${n}`);
  }
  return Uint8Array.of(n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255);
}
function u64(n) {
  if (n < 0n || n > 0xffffffffffffffffn)
    throw new Error(`u64: expected a uint64, got ${n}`);
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0;i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
function outpointBytes(txid, vout) {
  if (!/^[0-9a-f]{64}$/.test(txid))
    throw new Error(`outpoint: txid must be 64 lowercase hex characters, got ${txid}`);
  return concatBytes(hexToBytes(txid).reverse(), u322(vout));
}
function withLength(bytes) {
  return concatBytes(compactSize(bytes.length), bytes);
}
function serializeUnsigned(tx) {
  const parts = [u322(tx.version), compactSize(tx.inputs.length)];
  for (const input of tx.inputs) {
    parts.push(outpointBytes(input.txid, input.vout), compactSize(0), u322(input.sequence));
  }
  parts.push(compactSize(tx.outputs.length));
  for (const output of tx.outputs)
    parts.push(u64(output.amountSats), withLength(output.scriptPubKey));
  parts.push(u322(tx.lockTime));
  return concatBytes(...parts);
}
function serializeSigned(tx) {
  const parts = [
    u322(tx.version),
    Uint8Array.of(0, 1),
    compactSize(tx.inputs.length)
  ];
  for (const input of tx.inputs) {
    parts.push(outpointBytes(input.txid, input.vout), compactSize(0), u322(input.sequence));
  }
  parts.push(compactSize(tx.outputs.length));
  for (const output of tx.outputs)
    parts.push(u64(output.amountSats), withLength(output.scriptPubKey));
  for (const input of tx.inputs) {
    const witness = input.witness ?? [];
    parts.push(compactSize(witness.length));
    for (const item of witness)
      parts.push(withLength(item));
  }
  parts.push(u322(tx.lockTime));
  return concatBytes(...parts);
}
function txid(tx) {
  return bytesToHex(sha256(sha256(serializeUnsigned(tx))).reverse());
}
function taprootSighash(params) {
  const { tx, inputIndex, leafHash } = params;
  const hashType = params.hashType ?? SIGHASH_DEFAULT;
  if (hashType !== SIGHASH_DEFAULT) {
    throw new Error(`taprootSighash: only SIGHASH_DEFAULT is supported, got ${hashType}`);
  }
  if (inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new Error(`taprootSighash: input index ${inputIndex} is out of range`);
  }
  if (leafHash.length !== 32)
    throw new Error("taprootSighash: leafHash must be 32 bytes");
  const shaPrevouts = sha256(concatBytes(...tx.inputs.map((i) => outpointBytes(i.txid, i.vout))));
  const shaAmounts = sha256(concatBytes(...tx.inputs.map((i) => u64(i.amountSats))));
  const shaScriptPubKeys = sha256(concatBytes(...tx.inputs.map((i) => withLength(i.scriptPubKey))));
  const shaSequences = sha256(concatBytes(...tx.inputs.map((i) => u322(i.sequence))));
  const shaOutputs = sha256(concatBytes(...tx.outputs.map((o) => concatBytes(u64(o.amountSats), withLength(o.scriptPubKey)))));
  const sigMsg = concatBytes(Uint8Array.of(hashType), u322(tx.version), u322(tx.lockTime), shaPrevouts, shaAmounts, shaScriptPubKeys, shaSequences, shaOutputs, Uint8Array.of(EXT_FLAG_SCRIPT_PATH << 1), u322(inputIndex), leafHash, Uint8Array.of(KEY_VERSION), u322(NO_CODESEP));
  return taggedHash2("TapSighash", Uint8Array.of(SIGHASH_EPOCH), sigMsg);
}
function p2trScript(outputKey) {
  if (outputKey.length !== 32)
    throw new Error("p2trScript: an output key is 32 bytes");
  return concatBytes(Uint8Array.of(81, 32), outputKey);
}
function vsize(tx) {
  const base = serializeUnsigned(tx).length;
  const total = serializeSigned(tx).length;
  return Math.ceil((base * 3 + total) / 4);
}
// core/escrow/address.ts
var base58check = createBase58check(sha256);
var BASE58_VERSIONS = {
  0: { type: "p2pkh", chain: "mainnet" },
  5: { type: "p2sh", chain: "mainnet" },
  111: { type: "p2pkh", chain: "test" },
  196: { type: "p2sh", chain: "test" }
};
var HRP_CHAIN = { bc: "mainnet", tb: "test", bcrt: "regtest" };
function stripUri(input) {
  let s = input.trim();
  if (/^bitcoin:/i.test(s))
    s = s.slice("bitcoin:".length);
  const query = s.indexOf("?");
  return query === -1 ? s : s.slice(0, query);
}
function decodeSegwit(address) {
  const asBech32 = bech32.decodeUnsafe(address, 90);
  const asBech32m = bech32m.decodeUnsafe(address, 90);
  const decoded = asBech32 ?? asBech32m;
  if (!decoded)
    return;
  const chain2 = HRP_CHAIN[decoded.prefix];
  if (!chain2)
    throw new Error(`"${decoded.prefix}1…" is not a bitcoin address prefix; expected bc1, tb1 or bcrt1.`);
  const [version, ...rest] = decoded.words;
  if (version === undefined || version > 16)
    throw new Error("That address has no valid witness version.");
  const program = bech32.fromWordsUnsafe(rest);
  if (!program)
    throw new Error("That address has invalid padding, so it is corrupt or mistyped.");
  if (version === 0) {
    if (!asBech32)
      throw new Error("A version 0 address must use the bech32 checksum; this one uses bech32m.");
    if (program.length === 20)
      return { type: "p2wpkh", chain: chain2, scriptPubKey: new Uint8Array([0, 20, ...program]) };
    if (program.length === 32)
      return { type: "p2wsh", chain: chain2, scriptPubKey: new Uint8Array([0, 32, ...program]) };
    throw new Error(`A version 0 program is 20 or 32 bytes; this one is ${program.length}.`);
  }
  if (!asBech32m)
    throw new Error("A version 1+ address must use the bech32m checksum (BIP-350); this one uses bech32.");
  if (version === 1) {
    if (program.length !== 32)
      throw new Error(`A taproot program is 32 bytes; this one is ${program.length}.`);
    return { type: "p2tr", chain: chain2, scriptPubKey: new Uint8Array([81, 32, ...program]) };
  }
  throw new Error(`Witness version ${version} is not defined yet, so anyone could spend a payment to it. Use a bc1q or bc1p address.`);
}
function decodeBase58(address) {
  let payload;
  try {
    payload = base58check.decode(address);
  } catch {
    return;
  }
  if (payload.length !== 21)
    throw new Error("That base58 address does not carry a 20-byte hash.");
  const kind = BASE58_VERSIONS[payload[0]];
  if (!kind)
    throw new Error(`Base58 version byte 0x${payload[0].toString(16).padStart(2, "0")} is not a bitcoin address.`);
  const hash = payload.slice(1);
  const scriptPubKey = kind.type === "p2pkh" ? new Uint8Array([118, 169, 20, ...hash, 136, 172]) : new Uint8Array([169, 20, ...hash, 135]);
  return { type: kind.type, chain: kind.chain, scriptPubKey };
}
function decodeAddress(input) {
  const address = stripUri(String(input));
  if (!address)
    throw new Error("Enter an address.");
  const segwit = decodeSegwit(address);
  if (segwit)
    return segwit;
  const legacy = decodeBase58(address);
  if (legacy)
    return legacy;
  if (/^(bc|tb|bcrt)1/i.test(address)) {
    throw new Error("That address fails its checksum: a character is wrong or missing. Copy it again from your wallet.");
  }
  throw new Error("That is not a bitcoin address this page can verify. Copy it again from your wallet.");
}
function chainOf(network) {
  return network === "mainnet" ? "mainnet" : network === "regtest" ? "regtest" : "test";
}
function addressToScript(input, network) {
  const decoded = decodeAddress(input);
  const want = chainOf(network);
  const ok = decoded.chain === want || want === "regtest" && (decoded.type === "p2pkh" || decoded.type === "p2sh") && decoded.chain === "test";
  if (!ok) {
    const prefix = NETWORK_HRP[network];
    throw new Error(`That is a ${decoded.chain === "test" ? "test-network" : decoded.chain} address, and this escrow is on ${network}. ` + `Use an address from a ${network} wallet (${prefix}1…).`);
  }
  return decoded.scriptPubKey;
}
// core/escrow/recovery.ts
var RECOVERY_PREFIX = "fmdrec1";
var VERSION = 1;
var CHECKSUM_BYTES = 4;
var HAS_ARBITER = 1;
var TIMEOUT_TO_SELLER = 2;
var HAS_FUNDING = 4;
function encodeRecovery(recovery) {
  assertKey(recovery.secretKey, 32, "secretKey");
  assertKey(recovery.buyer, 32, "buyer");
  assertKey(recovery.seller, 32, "seller");
  if (recovery.arbiter)
    assertKey(recovery.arbiter, 32, "arbiter");
  if (!Number.isInteger(recovery.timeoutBlocks) || recovery.timeoutBlocks < 1 || recovery.timeoutBlocks > 65535) {
    throw new Error(`encodeRecovery: timeoutBlocks must be 1..65535, got ${recovery.timeoutBlocks}`);
  }
  let flags = 0;
  if (recovery.arbiter)
    flags |= HAS_ARBITER;
  if (recovery.timeoutTo === "seller")
    flags |= TIMEOUT_TO_SELLER;
  if (recovery.funding)
    flags |= HAS_FUNDING;
  const parts = [
    Uint8Array.of(VERSION, flags),
    Uint8Array.of(recovery.timeoutBlocks >>> 8 & 255, recovery.timeoutBlocks & 255),
    recovery.secretKey,
    recovery.buyer,
    recovery.seller
  ];
  if (recovery.arbiter)
    parts.push(recovery.arbiter);
  if (recovery.funding) {
    if (!/^[0-9a-f]{64}$/.test(recovery.funding.txid)) {
      throw new Error("encodeRecovery: the funding txid must be 64 lowercase hex characters");
    }
    parts.push(hexToBytes(recovery.funding.txid), u322(recovery.funding.vout), u64(recovery.funding.amountSats));
  }
  const payload = concatBytes(...parts);
  const checksum2 = sha256(payload).subarray(0, CHECKSUM_BYTES);
  return RECOVERY_PREFIX + base64urlnopad.encode(concatBytes(payload, checksum2));
}
function decodeRecovery(text) {
  if (typeof text !== "string")
    return { ok: false, reason: "not a string" };
  const trimmed = text.trim().replace(/\s+/g, "");
  if (!trimmed.startsWith(RECOVERY_PREFIX)) {
    return { ok: false, reason: `a recovery string starts with "${RECOVERY_PREFIX}"` };
  }
  let bytes;
  try {
    bytes = base64urlnopad.decode(trimmed.slice(RECOVERY_PREFIX.length));
  } catch {
    return { ok: false, reason: "the string is not valid base64url; check for a mistyped character" };
  }
  if (bytes.length < 2 + 2 + 32 * 3 + CHECKSUM_BYTES)
    return { ok: false, reason: "too short to be a recovery string" };
  const payload = bytes.subarray(0, bytes.length - CHECKSUM_BYTES);
  const checksum2 = bytes.subarray(bytes.length - CHECKSUM_BYTES);
  const expected = sha256(payload).subarray(0, CHECKSUM_BYTES);
  if (bytesToHex(checksum2) !== bytesToHex(expected)) {
    return { ok: false, reason: "the checksum does not match: a character is wrong or missing" };
  }
  const version = payload[0];
  if (version !== VERSION)
    return { ok: false, reason: `unsupported recovery version ${version}` };
  const flags = payload[1];
  const timeoutBlocks = payload[2] << 8 | payload[3];
  let at = 4;
  const take = (n) => {
    const slice = payload.subarray(at, at + n);
    at += n;
    return slice;
  };
  const secretKey = take(32);
  const buyer = take(32);
  const seller = take(32);
  const arbiter = flags & HAS_ARBITER ? take(32) : undefined;
  let funding;
  if (flags & HAS_FUNDING) {
    if (payload.length - at < 32 + 4 + 8)
      return { ok: false, reason: "the funding outpoint is truncated" };
    const txid2 = bytesToHex(take(32));
    const voutBytes = take(4);
    const amountBytes = take(8);
    const vout = voutBytes[0] | voutBytes[1] << 8 | voutBytes[2] << 16 | voutBytes[3] << 24;
    let amountSats = 0n;
    for (let i = 7;i >= 0; i--)
      amountSats = amountSats << 8n | BigInt(amountBytes[i]);
    funding = { txid: txid2, vout: vout >>> 0, amountSats };
  }
  if (at !== payload.length)
    return { ok: false, reason: "the recovery string has trailing bytes" };
  return {
    ok: true,
    recovery: {
      version,
      secretKey,
      buyer,
      seller,
      arbiter,
      timeoutTo: flags & TIMEOUT_TO_SELLER ? "seller" : "buyer",
      timeoutBlocks,
      ...funding ? { funding } : {}
    }
  };
}
function rebuildFromRecovery(recovery) {
  const pubkey = schnorr.getPublicKey(recovery.secretKey);
  const hex = bytesToHex(pubkey);
  const role = hex === bytesToHex(recovery.buyer) ? "buyer" : hex === bytesToHex(recovery.seller) ? "seller" : recovery.arbiter && hex === bytesToHex(recovery.arbiter) ? "arbiter" : undefined;
  if (!role) {
    throw new Error("rebuildFromRecovery: the key in this string is not one of the keys in this escrow: " + "the string is for a different escrow, or it is damaged");
  }
  return {
    tree: buildTree({
      buyer: recovery.buyer,
      seller: recovery.seller,
      arbiter: recovery.arbiter,
      timeoutTo: recovery.timeoutTo,
      timeoutBlocks: recovery.timeoutBlocks
    }),
    role,
    pubkey
  };
}
function assertKey(bytes, length, name) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new Error(`encodeRecovery: ${name} must be ${length} bytes`);
  }
}
// core/escrow/spend.ts
function buildSpend(params) {
  const { tree, leaf, outpoint } = params;
  if (params.destinations.length === 0)
    throw new Error("buildSpend: a spend needs at least one destination");
  const outputs = params.destinations.map((d) => {
    const scriptPubKey = d.scriptPubKey ?? (d.outputKey ? p2trScript(d.outputKey) : undefined);
    if (!scriptPubKey)
      throw new Error("buildSpend: every destination needs an output key or a scriptPubKey");
    if (d.amountSats <= 0n)
      throw new Error("buildSpend: a destination amount must be positive");
    if (d.amountSats < 330n)
      throw new Error(`buildSpend: ${d.amountSats} sats is below the P2TR dust limit of 330`);
    return { amountSats: d.amountSats, scriptPubKey };
  });
  const total = outputs.reduce((sum, o) => sum + o.amountSats, 0n);
  if (total > outpoint.amountSats) {
    throw new Error(`buildSpend: outputs total ${total} sats but the input holds ${outpoint.amountSats}`);
  }
  const input = {
    txid: outpoint.txid,
    vout: outpoint.vout,
    amountSats: outpoint.amountSats,
    scriptPubKey: tree.scriptPubKey,
    sequence: leaf.sequence
  };
  return { version: tree.txVersion, inputs: [input], outputs, lockTime: params.lockTime ?? 0 };
}
function feeOf(tx, finalised, leaf) {
  const input = tx.inputs.reduce((sum, i) => sum + i.amountSats, 0n);
  const output = tx.outputs.reduce((sum, o) => sum + o.amountSats, 0n);
  const sats = input - output;
  let vbytes;
  if (finalised)
    vbytes = vsize(tx);
  else {
    if (!leaf)
      throw new Error("feeOf: an unsigned escrow spend is sized by its leaf; pass the leaf being spent");
    vbytes = vsize(withPlaceholderWitness(tx, leaf));
  }
  return { sats, vbytes, satsPerVbyte: Number(sats) / vbytes };
}
function withPlaceholderWitness(tx, leaf) {
  const shaped = [...leaf.signatureOrder.map(() => new Uint8Array(64)), leaf.script, leaf.controlBlock];
  return {
    ...tx,
    inputs: tx.inputs.map((i) => ({ ...i, witness: i.witness ?? shaped }))
  };
}
function sighashFor(tx, leaf, inputIndex = 0) {
  return taprootSighash({ tx, inputIndex, leafHash: leaf.hash, hashType: SIGHASH_DEFAULT });
}
function signSpend(params) {
  const digest = sighashFor(params.tx, params.leaf, params.inputIndex ?? 0);
  return params.auxRand ? schnorr.sign(digest, params.secretKey, params.auxRand) : schnorr.sign(digest, params.secretKey);
}
function escrowPublicKey(secretKey) {
  if (secretKey.length !== 32)
    throw new Error("escrowPublicKey: a secret key is 32 bytes");
  return schnorr.getPublicKey(secretKey);
}
function escrowPublicKeyHex(secretKey) {
  return bytesToHex(escrowPublicKey(secretKey));
}
function verifySpendSignature(params) {
  try {
    return schnorr.verify(params.signature, sighashFor(params.tx, params.leaf, params.inputIndex ?? 0), params.pubkey);
  } catch {
    return false;
  }
}
function finaliseSpend(params) {
  const { tree, leaf, tx } = params;
  const inputIndex = params.inputIndex ?? 0;
  const keys = {
    buyer: tree.params.buyer,
    seller: tree.params.seller,
    arbiter: tree.params.arbiter
  };
  const witness = [];
  for (const role of leaf.signatureOrder) {
    const signature = params.signatures[role];
    if (!signature) {
      throw new Error(`finaliseSpend: leaf ${leaf.name} needs a signature from the ${role} and none was supplied`);
    }
    if (signature.length !== 64) {
      throw new Error(`finaliseSpend: a SIGHASH_DEFAULT signature is 64 bytes, the ${role} gave ${signature.length}`);
    }
    const pubkey = keys[role];
    if (!pubkey)
      throw new Error(`finaliseSpend: this tree has no ${role}`);
    if (!verifySpendSignature({ tx, leaf, signature, pubkey, inputIndex })) {
      throw new Error(`finaliseSpend: the ${role}'s signature does not verify for leaf ${leaf.name}: ` + "it was made for a different transaction, a different leaf, or by a different key");
    }
    witness.push(signature);
  }
  witness.push(leaf.script, leaf.controlBlock);
  const finalised = {
    ...tx,
    inputs: tx.inputs.map((input, i) => i === inputIndex ? { ...input, witness } : input)
  };
  return {
    tx: finalised,
    hex: bytesToHex(serializeSigned(finalised)),
    txid: txid(finalised),
    vbytes: vsize(finalised)
  };
}
function spendWith(params) {
  const tx = buildSpend(params);
  const signatures = {};
  for (const role of params.leaf.signatureOrder) {
    const secretKey = params.secretKeys[role];
    if (!secretKey) {
      throw new Error(`spendWith: leaf ${params.leaf.name} needs the ${role}'s key and none was supplied`);
    }
    signatures[role] = signSpend({ tx, leaf: params.leaf, secretKey, auxRand: params.auxRand });
  }
  return finaliseSpend({ tree: params.tree, leaf: params.leaf, tx, signatures });
}
// core/escrow/transfer.ts
var MIN_POLL_GAP_SECONDS = 1800;
var REQUIRED_AGREEING_POLLS = 2;
function classify(observation, commitment) {
  const { facts } = observation;
  if (fingerprintMatches({ registrarIanaId: facts.registrarIanaId, nameservers: facts.nameservers }, commitment)) {
    return "transferred";
  }
  if (facts.statuses.includes(PENDING_TRANSFER_STATUS))
    return "pending";
  if (facts.statuses.includes(TRANSFER_LOCK_STATUS))
    return "locked";
  return "unlocked";
}
function confirm(observations, commitment, state) {
  const supporting = observations.filter((o) => classify(o, commitment) === state).sort((a, b) => a.at - b.at);
  if (supporting.length < REQUIRED_AGREEING_POLLS)
    return { confirmed: false, evidence: [] };
  for (let i = 0;i < supporting.length; i++) {
    for (let j = i + 1;j < supporting.length; j++) {
      if (supporting[j].at - supporting[i].at >= MIN_POLL_GAP_SECONDS) {
        return {
          confirmed: true,
          since: supporting[i].at,
          evidence: [supporting[i].snapshotHash, supporting[j].snapshotHash]
        };
      }
    }
  }
  return { confirmed: false, evidence: [] };
}
function deriveTransferState(params) {
  const observations = [...params.observations].sort((a, b) => a.at - b.at);
  if (observations.length === 0) {
    return { state: "unknown", confirmed: false, evidence: [], reason: "the registry has not been polled yet" };
  }
  const transferred = confirm(observations, params.commitment, "transferred");
  if (transferred.confirmed) {
    const after = observations.filter((o) => o.at > transferred.since);
    const latest2 = after.slice(-REQUIRED_AGREEING_POLLS);
    const movedBack = latest2.length >= REQUIRED_AGREEING_POLLS && latest2.every((o) => classify(o, params.commitment) !== "transferred") && latest2[latest2.length - 1].at - latest2[0].at >= MIN_POLL_GAP_SECONDS;
    if (movedBack) {
      return {
        state: "reverted",
        confirmed: true,
        since: latest2[0].at,
        evidence: latest2.map((o) => o.snapshotHash),
        reason: "the registry showed the transfer completed and now does not: the name moved back. " + "This is a dispute, not a failure: the buyer may hold both the domain and a claim on the money."
      };
    }
    return {
      state: "transferred",
      confirmed: true,
      since: transferred.since,
      evidence: transferred.evidence,
      reason: "the registry shows the name where the buyer committed to receive it"
    };
  }
  for (const [state, reason] of [
    ["pending", "a transfer is underway; this is the point of no return"],
    ["unlocked", "the transfer lock is off, so the name can be transferred"],
    ["locked", "clientTransferProhibited is present, so the name cannot move yet"]
  ]) {
    const result = confirm(observations, params.commitment, state);
    if (result.confirmed)
      return { state, confirmed: true, since: result.since, evidence: result.evidence, reason };
  }
  const latest = classify(observations[observations.length - 1], params.commitment);
  return {
    state: "unknown",
    confirmed: false,
    evidence: observations.map((o) => o.snapshotHash),
    reason: `the last poll suggests "${latest}", but ${REQUIRED_AGREEING_POLLS} agreeing polls at least ` + `${MIN_POLL_GAP_SECONDS / 60} minutes apart are required before anything moves on it`
  };
}
function transferAllowed(verdict) {
  return verdict.confirmed && (verdict.state === "unlocked" || verdict.state === "pending");
}
function registrantActed(params) {
  const sorted = [...params.observations].sort((a, b) => a.at - b.at);
  const states = sorted.map((o) => classify(o, params.commitment));
  const open = (s) => s === "unlocked" || s === "pending";
  let lockedAt;
  let lockEvidence = [];
  search:
    for (let i = 0;i < sorted.length; i++) {
      if (states[i] !== "locked")
        continue;
      for (let j = i + 1;j < sorted.length; j++) {
        if (states[j] === "locked" && sorted[j].at - sorted[i].at >= MIN_POLL_GAP_SECONDS) {
          lockedAt = sorted[j].at;
          lockEvidence = [sorted[i].snapshotHash, sorted[j].snapshotHash];
          break search;
        }
      }
    }
  if (lockedAt === undefined) {
    return {
      acted: false,
      evidence: [],
      reason: `the registry has not yet been seen with the transfer lock on ` + `(${REQUIRED_AGREEING_POLLS} readings at least ${MIN_POLL_GAP_SECONDS / 60} minutes apart)`
    };
  }
  const latestLocked = states[states.length - 1] === "locked";
  for (let k = 0;k < sorted.length && !latestLocked; k++) {
    if (sorted[k].at <= lockedAt || !open(states[k]))
      continue;
    for (let l = k + 1;l < sorted.length; l++) {
      if (open(states[l]) && sorted[l].at - sorted[k].at >= MIN_POLL_GAP_SECONDS) {
        return {
          acted: true,
          lockedAt,
          unlockedAt: sorted[k].at,
          evidence: [...lockEvidence, sorted[k].snapshotHash, sorted[l].snapshotHash],
          reason: "the registry showed the transfer lock on, then off: a change only the registrant can make"
        };
      }
    }
  }
  return {
    acted: false,
    lockedAt,
    evidence: lockEvidence,
    reason: latestLocked ? "the registry shows the transfer lock on; it has to be seen off before anything is paid" : `the lock has been seen on; it has not yet been seen off in ${REQUIRED_AGREEING_POLLS} readings ` + `at least ${MIN_POLL_GAP_SECONDS / 60} minutes apart`
  };
}
function fundable(params) {
  return params.verdict.confirmed && params.verdict.state === "unlocked" && registrantActed(params).acted;
}
function releasable(verdict) {
  return verdict.confirmed && verdict.state === "transferred";
}
function buildCommitment(params) {
  const nameservers = [...params.nameservers ?? []].map((n) => n.trim().toLowerCase().replace(/\.$/, "")).filter((n) => n !== "").sort();
  if (!params.registrarIanaId && nameservers.length === 0) {
    throw new Error("buildCommitment: a commitment needs a registrar IANA id or at least one nameserver; " + "without one the transfer could never be shown to have completed");
  }
  return { registrarIanaId: params.registrarIanaId, nameservers, committedAt: params.committedAt };
}
// core/escrow/index.ts
function describeTree(tree) {
  return {
    shape: tree.shape,
    internalKey: bytesToHex(tree.internalKey),
    merkleRoot: bytesToHex(tree.merkleRoot),
    tweak: bytesToHex(tree.tweak),
    outputKey: bytesToHex(tree.outputKey),
    parity: tree.parity,
    scriptPubKey: bytesToHex(tree.scriptPubKey),
    controlBlockLength: tree.controlBlockLength,
    txVersion: tree.txVersion,
    addresses: { ...tree.addresses },
    branches: tree.branches.map((b) => ({ label: b.label, hash: bytesToHex(b.hash) })),
    leaves: tree.leafList.map((l) => ({
      name: l.name,
      role: l.role,
      scriptBytes: l.script.length,
      script: bytesToHex(l.script),
      leafHash: bytesToHex(l.hash),
      merklePath: l.merklePath.map(bytesToHex),
      controlBlock: bytesToHex(l.controlBlock),
      witnessStack: l.witnessStack.slice(),
      sequence: `0x${l.sequence.toString(16).padStart(8, "0")} (${l.sequence})`
    }))
  };
}
// net/dns.ts
var DOH_PROVIDERS = [
  { name: "cloudflare", url: "https://cloudflare-dns.com/dns-query" },
  { name: "google", url: "https://dns.google/resolve" }
];
var TXT_TYPE = 16;
async function lookupTxtVia(provider, name, options = {}) {
  const observedAt = options.now ?? Math.floor(Date.now() / 1000);
  const url = `${provider.url}?name=${encodeURIComponent(name)}&type=TXT&cd=false&do=true`;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: options.signal,
      credentials: "omit",
      redirect: "follow"
    });
    const raw = await response.text();
    if (!response.ok) {
      return { provider: provider.name, records: [], status: undefined, dnssec: false, observedAt, raw, error: `HTTP ${response.status}` };
    }
    const body = JSON.parse(raw);
    const records = (body.Answer ?? []).filter((a) => a.type === TXT_TYPE && typeof a.data === "string").map((a) => unquoteTxt(a.data));
    return {
      provider: provider.name,
      records,
      status: typeof body.Status === "number" ? body.Status : undefined,
      dnssec: body.AD === true,
      observedAt,
      raw
    };
  } catch (err) {
    return {
      provider: provider.name,
      records: [],
      status: undefined,
      dnssec: false,
      observedAt,
      error: err.message
    };
  }
}
function unquoteTxt(data) {
  const parts = data.match(/"(?:[^"\\]|\\.)*"/g);
  if (!parts)
    return data.trim();
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}
async function lookupTxt(name, options = {}) {
  const providers = options.providers ?? DOH_PROVIDERS;
  const observations = await Promise.all(providers.map((p) => lookupTxtVia(p, name, options)));
  const answering = observations.filter((o) => o.error === undefined);
  const counts = new Map;
  for (const observation of answering) {
    for (const record of new Set(observation.records)) {
      counts.set(record, (counts.get(record) ?? 0) + 1);
    }
  }
  const agreed = [];
  const disputed = [];
  for (const [record, count] of counts) {
    if (count === answering.length && answering.length > 0)
      agreed.push(record);
    else
      disputed.push(record);
  }
  return {
    name,
    observations,
    agreed: agreed.sort(),
    disputed: disputed.sort(),
    answered: answering.length > 0,
    dnssec: answering.length > 0 && answering.every((o) => o.dnssec)
  };
}
async function fetchNip05(url, options = {}) {
  const observedAt = options.now ?? Math.floor(Date.now() / 1000);
  try {
    const response = await fetch(url, { signal: options.signal, credentials: "omit", headers: { accept: "application/json" } });
    const raw = await response.text();
    if (!response.ok)
      return { ok: false, error: `HTTP ${response.status}`, raw, observedAt };
    return { ok: true, document: JSON.parse(raw), raw, observedAt };
  } catch (err) {
    return { ok: false, error: err.message, observedAt };
  }
}
// net/rdap.ts
var RDAP_BOOTSTRAP_URL2 = "https://data.iana.org/rdap/dns.json";
var bootstrapCache;
async function fetchRdapBootstrap(options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? 86400;
  if (!options.force && bootstrapCache && now - bootstrapCache.at < ttl)
    return bootstrapCache.value;
  const response = await fetch(RDAP_BOOTSTRAP_URL2, { signal: options.signal, credentials: "omit" });
  if (!response.ok)
    throw new Error(`RDAP bootstrap: HTTP ${response.status}`);
  const value = await response.json();
  bootstrapCache = { at: now, value };
  return value;
}
function clearBootstrapCache() {
  bootstrapCache = undefined;
}
async function fetchRdapDomainAt(baseUrl, domain, options = {}) {
  const observedAt = options.now ?? Math.floor(Date.now() / 1000);
  const url = rdapDomainUrl(baseUrl, domain);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/rdap+json, application/json" },
      signal: options.signal,
      credentials: "omit"
    });
    const raw = await response.text();
    if (!response.ok) {
      return { domain, url, ok: false, status: response.status, raw, hash: snapshotHash(raw), observedAt };
    }
    return {
      domain,
      url,
      ok: true,
      status: response.status,
      response: JSON.parse(raw),
      raw,
      hash: snapshotHash(raw),
      observedAt
    };
  } catch (err) {
    return { domain, url, ok: false, status: undefined, observedAt, error: err.message };
  }
}
async function fetchRdapDomain(domain, options = {}) {
  const observedAt = options.now ?? Math.floor(Date.now() / 1000);
  const bootstrap = options.bootstrap ?? await fetchRdapBootstrap(options);
  const bases = rdapBaseUrls(bootstrap, domain);
  if (bases.length === 0) {
    return {
      domain,
      url: "",
      ok: false,
      status: undefined,
      observedAt,
      error: "this TLD publishes no RDAP service",
      bootstrap,
      supported: false
    };
  }
  let last;
  for (const base of bases) {
    const snapshot = await fetchRdapDomainAt(base, domain, { ...options, now: observedAt });
    if (snapshot.ok)
      return { ...snapshot, bootstrap, supported: true };
    if (snapshot.status === 404)
      return { ...snapshot, bootstrap, supported: true };
    last = snapshot;
  }
  return { ...last, bootstrap, supported: true };
}
// net/relay.ts
var DEFAULT_TIMEOUT_MS = 6000;
async function queryRelays(relays, filters, options = {}) {
  const byId = new Map;
  await Promise.all(relays.map(async (relay) => {
    try {
      const { events, complete } = await queryRelayDetailed(relay, filters, options);
      for (const event of events)
        byId.set(event.id, event);
      options.onRelayDone?.(relay, events.length, undefined, complete);
    } catch (err) {
      options.onRelayDone?.(relay, 0, err.message, false);
    }
  }));
  return [...byId.values()].sort((a, b) => b.created_at - a.created_at);
}
async function queryRelay(relay, filters, options = {}) {
  return (await queryRelayDetailed(relay, filters, options)).events;
}
function queryRelayDetailed(relay, filters, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const subId = `fmd-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(relay);
    } catch (err) {
      reject(err);
      return;
    }
    const events = [];
    let settled = false;
    const finish = (error, complete = false) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify(["CLOSE", subId]));
        socket.close();
      } catch {}
      if (error)
        reject(error);
      else
        resolve({ events, complete });
    };
    const onAbort = () => finish(new Error("aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(), timeoutMs);
    socket.onopen = () => socket.send(JSON.stringify(["REQ", subId, ...filters]));
    socket.onerror = () => finish(new Error(`${relay}: connection failed`));
    socket.onclose = () => finish();
    socket.onmessage = (message) => {
      let frame;
      try {
        frame = JSON.parse(typeof message.data === "string" ? message.data : "");
      } catch {
        return;
      }
      if (!Array.isArray(frame))
        return;
      const [type, id, payload] = frame;
      if (id !== subId)
        return;
      if (type === "EVENT") {
        const checked = checkEvent(payload);
        if (checked.ok) {
          events.push(checked.event);
          if (options.limit !== undefined && events.length >= options.limit)
            finish(undefined, true);
        }
        return;
      }
      if (type === "EOSE")
        finish(undefined, true);
      if (type === "CLOSED")
        finish();
    };
  });
}
async function publishToRelays(relays, event, options = {}) {
  const checked = checkEvent(event);
  if (!checked.ok) {
    throw new Error(`publishToRelays: this event does not verify: ${checked.reason}`);
  }
  return Promise.all(relays.map((relay) => publishToRelay(relay, checked.event, options)));
}
function publishToRelay(relay, event, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let socket;
    try {
      socket = new WebSocket(relay);
    } catch (err) {
      resolve({ relay, ok: false, message: err.message });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ relay, ok: false, message: "timed out" }), timeoutMs);
    socket.onopen = () => socket.send(JSON.stringify(["EVENT", event]));
    socket.onerror = () => finish({ relay, ok: false, message: "connection failed" });
    socket.onclose = () => finish({ relay, ok: false, message: "closed before acknowledging" });
    socket.onmessage = (message) => {
      let frame;
      try {
        frame = JSON.parse(typeof message.data === "string" ? message.data : "");
      } catch {
        return;
      }
      if (!Array.isArray(frame))
        return;
      const [type, id, ok, reason] = frame;
      if (type !== "OK" || id !== event.id)
        return;
      finish({ relay, ok: ok === true, message: typeof reason === "string" && reason !== "" ? reason : undefined });
    };
  });
}
function countOnRelay(relay, filters, options = {}) {
  const timeoutMs = options.timeoutMs ?? 4000;
  const subId = `fmd-count-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve) => {
    let socket;
    try {
      socket = new WebSocket(relay);
    } catch {
      resolve(undefined);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    socket.onopen = () => socket.send(JSON.stringify(["COUNT", subId, ...filters]));
    socket.onerror = () => finish(undefined);
    socket.onclose = () => finish(undefined);
    socket.onmessage = (message) => {
      let frame;
      try {
        frame = JSON.parse(typeof message.data === "string" ? message.data : "");
      } catch {
        return;
      }
      if (!Array.isArray(frame))
        return;
      const [type, id, payload] = frame;
      if (type === "NOTICE" || type === "CLOSED")
        finish(undefined);
      if (type !== "COUNT" || id !== subId)
        return;
      finish(typeof payload?.count === "number" ? payload.count : undefined);
    };
  });
}
async function countOnRelays(relays, filters, options = {}) {
  const counts = (await Promise.all(relays.map((r) => countOnRelay(r, filters, options)))).filter((c) => typeof c === "number");
  return counts.length === 0 ? undefined : Math.max(...counts);
}
async function fetchRelayInfo(relay, options = {}) {
  const url = relay.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
  const response = await fetch(url, {
    headers: { accept: "application/nostr+json" },
    signal: options.signal,
    credentials: "omit"
  });
  if (!response.ok)
    throw new Error(`${relay}: HTTP ${response.status}`);
  return response.json();
}
function newestPerAddress(events) {
  const best = new Map;
  for (const event of events) {
    const d = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
    const address = `${event.kind}:${event.pubkey}:${d}`;
    const current = best.get(address);
    if (!current || event.created_at > current.created_at || event.created_at === current.created_at && event.id < current.id) {
      best.set(address, event);
    }
  }
  return [...best.values()];
}
// net/chain.ts
var CHAIN_APIS = Object.freeze({
  mainnet: "https://mempool.space/api",
  signet: "https://mempool.space/signet/api",
  testnet: "https://mempool.space/testnet4/api",
  regtest: "http://localhost:3002/api"
});
var EXPLORERS = Object.freeze({
  mainnet: "https://mempool.space",
  signet: "https://mempool.space/signet",
  testnet: "https://mempool.space/testnet4",
  regtest: "http://localhost:3002"
});
function chainApi(network, base = CHAIN_APIS[network]) {
  const get = async (path) => fetch(`${base}${path}`, { credentials: "omit", headers: { accept: "application/json, text/plain" } });
  return {
    network,
    base,
    explorer: EXPLORERS[network],
    async tipHeight() {
      const response = await get("/blocks/tip/height");
      if (!response.ok)
        throw new Error(`chain: tip height request failed (HTTP ${response.status})`);
      return Number(await response.text());
    },
    async utxos(address) {
      const response = await get(`/address/${encodeURIComponent(address)}/utxo`);
      if (!response.ok)
        throw new Error(`chain: utxo request failed (HTTP ${response.status})`);
      const body = await response.json();
      return body.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        valueSats: BigInt(u.value),
        confirmed: u.status.confirmed,
        blockHeight: u.status.block_height
      }));
    },
    async transaction(txid2) {
      const response = await get(`/tx/${txid2}`);
      if (response.status === 404)
        return;
      if (!response.ok)
        throw new Error(`chain: tx request failed (HTTP ${response.status})`);
      const body = await response.json();
      return {
        txid: body.txid,
        confirmed: body.status.confirmed,
        blockHeight: body.status.block_height,
        vout: body.vout.map((o) => ({
          valueSats: BigInt(o.value),
          scriptPubKey: o.scriptpubkey,
          address: o.scriptpubkey_address
        }))
      };
    },
    async broadcast(hex) {
      const response = await fetch(`${base}/tx`, {
        method: "POST",
        body: hex,
        credentials: "omit",
        headers: { "content-type": "text/plain" }
      });
      const text = (await response.text()).trim();
      if (!response.ok) {
        return { ok: false, reason: text || `HTTP ${response.status}` };
      }
      return { ok: true, txid: text };
    },
    async feeRate() {
      try {
        const response = await fetch(`${base.replace(/\/api$/, "/api/v1")}/fees/recommended`, { credentials: "omit" });
        if (!response.ok)
          throw new Error(String(response.status));
        const body = await response.json();
        return body.halfHourFee ?? 2;
      } catch {
        return network === "mainnet" ? 10 : 2;
      }
    }
  };
}
function findFunding(utxos, requiredSats, minConfirmations = 1, tipHeight) {
  const paid = utxos.filter((u) => u.valueSats >= requiredSats);
  if (paid.length === 0) {
    const best = utxos.reduce((max, u) => u.valueSats > max ? u.valueSats : max, 0n);
    return {
      funded: false,
      candidates: [...utxos],
      reason: utxos.length === 0 ? "nothing has been paid to this address yet" : `the largest single payment is ${best} sats and ${requiredSats} is required. ` + "Partial payments are not added together, so send the full amount in one transaction"
    };
  }
  const confirmed = paid.filter((u) => {
    if (!u.confirmed)
      return false;
    if (minConfirmations <= 1 || tipHeight === undefined || u.blockHeight === undefined)
      return u.confirmed;
    return tipHeight - u.blockHeight + 1 >= minConfirmations;
  });
  if (confirmed.length === 0) {
    return { funded: false, candidates: paid, reason: "the payment is in the mempool but not confirmed yet" };
  }
  const chosen = [...confirmed].sort((a, b) => (a.blockHeight ?? Infinity) - (b.blockHeight ?? Infinity))[0];
  return { funded: true, utxo: chosen };
}
// net/outbox.ts
class RelayDirectory {
  fallback;
  lists = new Map;
  pending = new Map;
  constructor(fallback = DEFAULT_RELAYS) {
    this.fallback = fallback;
  }
  known(pubkey) {
    return this.lists.get(pubkey);
  }
  absorb(events) {
    for (const event of newestPerAddress(events)) {
      const entries = parseRelayList(event);
      if (entries.length > 0)
        this.lists.set(event.pubkey, entries);
    }
  }
  async resolve(pubkeys, options = {}) {
    const missing = [...new Set(pubkeys)].filter((p) => !this.lists.has(p) && !this.pending.has(p));
    if (missing.length > 0) {
      const request = queryRelays(this.fallback, [relayListFilter(missing)], { timeoutMs: 4000, ...options }).then((events) => {
        this.absorb(events);
        for (const pubkey of missing)
          if (!this.lists.has(pubkey))
            this.lists.set(pubkey, []);
        return events;
      }).catch(() => {
        for (const pubkey of missing)
          if (!this.lists.has(pubkey))
            this.lists.set(pubkey, []);
        return [];
      });
      for (const pubkey of missing) {
        this.pending.set(pubkey, request.then(() => this.lists.get(pubkey) ?? []));
      }
    }
    await Promise.all([...new Set(pubkeys)].map((p) => this.pending.get(p) ?? Promise.resolve()));
    for (const pubkey of pubkeys)
      this.pending.delete(pubkey);
    const out = new Map;
    for (const pubkey of new Set(pubkeys))
      out.set(pubkey, this.lists.get(pubkey) ?? []);
    return out;
  }
  writeRelays(pubkey) {
    return writeRelaysFor(this.lists.get(pubkey) ?? [], this.fallback);
  }
  readRelays(pubkey) {
    return readRelaysFor(this.lists.get(pubkey) ?? [], this.fallback);
  }
}
async function publishOutbox(directory, event, options = {}) {
  await directory.resolve([event.pubkey]);
  const relays = [...new Set([...directory.writeRelays(event.pubkey), ...options.extraRelays ?? []])];
  return publishToRelays(relays, event);
}
async function queryOutbox(directory, authors, filter, options = {}) {
  const lists = await directory.resolve(authors, options);
  const plan = planAuthorQuery(lists, authors, directory.fallback);
  const byId = new Map;
  await Promise.all([...plan.entries()].map(async ([relay, group]) => {
    const events = await queryRelays([relay], [{ ...filter, authors: group }], options).catch(() => []);
    for (const event of events)
      byId.set(event.id, event);
  }));
  return [...byId.values()].sort((a, b) => b.created_at - a.created_at);
}
async function queryDiscovery(relays, filters, options = {}) {
  return queryRelays(relays, filters, options);
}
// net/lnurl.ts
function lightningAddressUrl(address) {
  const match = /^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(address.trim().toLowerCase());
  if (!match)
    return;
  return `https://${match[2]}/.well-known/lnurlp/${match[1]}`;
}
async function fetchLnurlPay(addressOrUrl, options = {}) {
  const url = addressOrUrl.startsWith("http") ? addressOrUrl : lightningAddressUrl(addressOrUrl);
  if (!url)
    return { ok: false, reason: `${JSON.stringify(addressOrUrl)} is not a lightning address` };
  let body;
  try {
    const response = await fetch(url, { signal: options.signal, credentials: "omit" });
    if (!response.ok)
      return { ok: false, reason: `HTTP ${response.status}` };
    body = await response.json();
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (body.status === "ERROR")
    return { ok: false, reason: String(body.reason ?? "the provider returned an error") };
  if (typeof body.callback !== "string")
    return { ok: false, reason: "no callback URL" };
  if (typeof body.minSendable !== "number" || typeof body.maxSendable !== "number") {
    return { ok: false, reason: "no sendable range" };
  }
  const nostrPubkey = typeof body.nostrPubkey === "string" ? body.nostrPubkey.toLowerCase() : undefined;
  return {
    ok: true,
    url,
    info: {
      callback: body.callback,
      minSendable: body.minSendable,
      maxSendable: body.maxSendable,
      metadata: typeof body.metadata === "string" ? body.metadata : "",
      allowsNostr: body.allowsNostr === true && /^[0-9a-f]{64}$/.test(nostrPubkey ?? ""),
      nostrPubkey,
      commentAllowed: typeof body.commentAllowed === "number" ? body.commentAllowed : undefined
    }
  };
}
async function requestZapInvoice(params) {
  if (params.zapRequest.kind !== ZAP_REQUEST_KIND) {
    return { ok: false, reason: "that is not a zap request" };
  }
  if (params.amountMsats < params.info.minSendable || params.amountMsats > params.info.maxSendable) {
    return {
      ok: false,
      reason: `this provider accepts ${params.info.minSendable} to ${params.info.maxSendable} msats`
    };
  }
  if (!params.info.allowsNostr) {
    return { ok: false, reason: "this lightning address does not support zaps, so no receipt would be written" };
  }
  const url = new URL(params.info.callback);
  url.searchParams.set("amount", String(params.amountMsats));
  url.searchParams.set("nostr", JSON.stringify(params.zapRequest));
  if (params.lnurl)
    url.searchParams.set("lnurl", params.lnurl);
  try {
    const response = await fetch(url, { signal: params.signal, credentials: "omit" });
    const body = await response.json();
    if (body.status === "ERROR")
      return { ok: false, reason: String(body.reason ?? "the provider refused") };
    if (typeof body.pr !== "string" || body.pr === "")
      return { ok: false, reason: "the provider returned no invoice" };
    return { ok: true, invoice: body.pr };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
var zapperKeys = new Map;
async function zapperKeyFor(lightningAddress, options = {}) {
  if (zapperKeys.has(lightningAddress))
    return zapperKeys.get(lightningAddress);
  const result = await fetchLnurlPay(lightningAddress, options);
  const key = result.ok && result.info.allowsNostr ? result.info.nostrPubkey : undefined;
  zapperKeys.set(lightningAddress, key);
  return key;
}
function clearZapperKeyCache() {
  zapperKeys.clear();
}
// net/verify.ts
async function checkDomainProof(params) {
  const domain = normaliseDomain(params.domain);
  const checkedAt = params.now ?? Math.floor(Date.now() / 1000);
  const lookup = await lookupTxt(proofRecordName(domain), { signal: params.signal, now: checkedAt });
  const dns = verifyProofRecords({
    domain,
    pubkey: params.pubkey,
    records: lookup.agreed,
    now: checkedAt
  });
  let nip05;
  let url;
  if (!dns.ok && !params.dnsOnly) {
    url = nip05DocumentUrl(domain);
    const fetched = await fetchNip05(url, { signal: params.signal, now: checkedAt });
    nip05 = fetched.ok ? verifyNip05({ domain, pubkey: params.pubkey, document: fetched.document }) : { ok: false, reason: fetched.error ?? "no document" };
  }
  return {
    domain,
    pubkey: params.pubkey,
    status: combineProofs({ domain, pubkey: params.pubkey, dns, nip05 }),
    answered: lookup.answered,
    dnssec: lookup.dnssec,
    lookup,
    dns,
    nip05,
    nip05Url: url,
    checkedAt
  };
}
async function checkRegistry(params) {
  const domain = normaliseDomain(params.domain);
  const checkedAt = params.now ?? Math.floor(Date.now() / 1000);
  const snapshot = await fetchRdapDomain(domain, { ...params, now: checkedAt });
  if (!snapshot.supported || !snapshot.ok) {
    return { domain, snapshot, supported: snapshot.supported, checkedAt };
  }
  return {
    domain,
    snapshot,
    supported: true,
    checkedAt,
    eligibility: checkEligibility({
      domain,
      response: snapshot.response,
      now: checkedAt,
      bootstrap: snapshot.bootstrap
    })
  };
}
async function checkDomain(params) {
  const [proof, registry] = await Promise.all([checkDomainProof(params), checkRegistry(params)]);
  return { proof, registry };
}
// net/transfer.ts
async function observe(params) {
  const snapshot = await fetchRdapDomain(params.domain, {
    bootstrap: params.bootstrap,
    signal: params.signal,
    now: params.now
  });
  if (!snapshot.supported) {
    return { reason: "this TLD publishes no RDAP service, so a transfer cannot be verified here" };
  }
  if (!snapshot.ok || snapshot.raw === undefined) {
    return { reason: snapshot.error ?? `the registry did not answer (HTTP ${snapshot.status ?? "none"})` };
  }
  return {
    raw: snapshot.raw,
    observation: {
      at: params.now,
      snapshotHash: snapshot.hash ?? snapshotHash(snapshot.raw),
      facts: parseRdapDomain(snapshot.response)
    }
  };
}
function record(history, observation, max = 200) {
  if (history.some((o) => o.at === observation.at))
    return [...history];
  const next = [...history, observation].sort((a, b) => a.at - b.at);
  if (next.length <= max)
    return next;
  const keepHead = Math.floor(max / 2);
  return [...next.slice(0, keepHead), ...next.slice(next.length - (max - keepHead))];
}
// client/messages.ts
function wrapEntropy(now) {
  const jitter = () => now - Math.floor(Math.random() * MAX_TIMESTAMP_JITTER);
  return {
    ephemeralSecretKey: schnorr.utils.randomSecretKey(),
    sealNonce: crypto.getRandomValues(new Uint8Array(32)),
    wrapNonce: crypto.getRandomValues(new Uint8Array(32)),
    sealCreatedAt: jitter(),
    wrapCreatedAt: jitter()
  };
}
function sealMessage(params) {
  const rumor = buildRumor({
    pubkey: bytesToHex(schnorr.getPublicKey(params.senderSecretKey)),
    recipient: params.recipient,
    content: params.content,
    createdAt: params.now,
    subject: params.subject,
    tags: params.tags
  });
  return giftWrap({
    rumor,
    senderSecretKey: params.senderSecretKey,
    recipient: params.recipient,
    entropy: wrapEntropy(params.now)
  });
}
function readMessages(wraps, recipientSecretKey) {
  const messages = [];
  let unreadable = 0;
  for (const wrap of wraps) {
    const out = unwrap(wrap, recipientSecretKey);
    if (out.ok)
      messages.push({ rumor: out.rumor, sender: out.sender, sealedAt: out.sealedAt, wrap });
    else
      unreadable++;
  }
  messages.sort((a, b) => b.rumor.created_at - a.rumor.created_at);
  return { messages, unreadable };
}
function canSealWith(signer) {
  return Boolean(signer?.secretKey);
}
// client/signer.ts
function hasExtension() {
  return typeof window !== "undefined" && typeof window.nostr?.signEvent === "function";
}
async function waitForExtension(timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (hasExtension())
      return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return hasExtension();
}
function extensionSigner() {
  return {
    async getPublicKey() {
      if (!hasExtension())
        throw new Error("No NIP-07 extension is available in this browser");
      const pubkey = (await window.nostr.getPublicKey()).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pubkey))
        throw new Error("The extension returned something that is not a public key");
      return pubkey;
    },
    async signEvent(unsigned) {
      if (!hasExtension())
        throw new Error("No NIP-07 extension is available in this browser");
      const expected = eventId(unsigned);
      const signed = await window.nostr.signEvent(unsigned);
      if (signed.pubkey?.toLowerCase() !== unsigned.pubkey) {
        throw new Error("The extension signed under a different key than the one it reported");
      }
      if (signed.id !== expected) {
        throw new Error("The extension altered the event before signing it");
      }
      return { ...signed, pubkey: signed.pubkey.toLowerCase() };
    }
  };
}
function localSigner(secretKey) {
  if (secretKey.length !== 32)
    throw new Error("localSigner: a secret key is 32 bytes");
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
  return {
    npub: npubEncode(pubkey),
    backup: () => nsecEncode(secretKey),
    async getPublicKey() {
      return pubkey;
    },
    async signEvent(unsigned) {
      if (unsigned.pubkey !== pubkey)
        throw new Error("localSigner: that event is for a different key");
      const digest = hexToBytes(eventId(unsigned));
      return { ...unsigned, id: bytesToHex(digest), sig: bytesToHex(schnorr.sign(digest, secretKey)) };
    }
  };
}
function generateSecretKey() {
  return schnorr.utils.randomSecretKey();
}
var STORAGE_KEY = "fmd-key-v1";
var PBKDF2_ITERATIONS = 310000;
function hasStoredKey() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}
async function deriveAesKey(passphrase, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey"
  ]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function storeKey(secretKey, passphrase) {
  if (passphrase.length < 8)
    throw new Error("Choose a passphrase of at least 8 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, secretKey));
  const stored = { v: 1, salt: bytesToHex(salt), iv: bytesToHex(iv), ct: bytesToHex(ct) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}
async function loadKey(passphrase) {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw)
    throw new Error("No key is stored in this browser");
  const stored = JSON.parse(raw);
  if (stored.v !== 1)
    throw new Error(`Unknown stored-key version ${stored.v}`);
  const key = await deriveAesKey(passphrase, hexToBytes(stored.salt));
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBytes(stored.iv) }, key, hexToBytes(stored.ct));
  } catch {
    throw new Error("That passphrase does not unlock the stored key");
  }
  const secretKey = new Uint8Array(plain);
  if (secretKey.length !== 32)
    throw new Error("The stored key is not 32 bytes");
  return secretKey;
}
function forgetStoredKey() {
  localStorage.removeItem(STORAGE_KEY);
}
export {
  zapperKeyFor,
  zapReceiptFilter,
  writeRelaysFor,
  wrapEntropy,
  waitForExtension,
  vsize,
  verifyZapReceipt,
  verifySpendSignature,
  verifyProofRecords,
  verifyProofRecord,
  verifyPortfolio,
  verifyNip05,
  verifyEvent,
  verifyDigestSignature,
  verifiedBadges,
  upsertEntry,
  unwrap,
  unquoteTxt,
  txid,
  tryNormaliseDomain,
  tryDecodeNip19,
  transferAllowed,
  toUnicode,
  toPubkeyHex,
  toASCII,
  tldOf,
  tldHasRdap,
  tally,
  tagValues,
  tagValue,
  summariseTrades,
  storeKey,
  splitDomain,
  spendWith,
  snapshotHash,
  signSpend,
  signEvent,
  sighashFor,
  shorten,
  serializeSigned,
  serializeEvent,
  sealMessage,
  resolveHandshake,
  requestZapInvoice,
  removeEntry,
  releasable,
  relayListFilter,
  relayHints,
  registrantActed,
  record,
  receiptFilter,
  rebuildFromRecovery,
  readRelaysFor,
  readMessages,
  rdapDomainUrl,
  rdapBaseUrls,
  rankFlexDomains,
  rankByZaps,
  queryRelays,
  queryRelay,
  queryOutbox,
  queryDiscovery,
  publishToRelays,
  publishToRelay,
  publishOutbox,
  proofRecordName,
  proofMessage,
  proofFromEvent,
  proofEvent,
  proofDigestHex,
  proofDigest,
  proofDTag,
  profileFilter,
  portfolioFilter,
  planAuthorQuery,
  parseWatchlist,
  parseRelayList,
  parseReceipt,
  parseRdapDomain,
  parseProofRecord,
  parseProfileBadges,
  parseProfile,
  parsePortfolio,
  parseNip05Identifier,
  parseListing,
  parseEscrowEvent,
  parseDeletion,
  parseBadgeDefinition,
  parseBadgeAward,
  parseAttestation,
  parseArbiterSet,
  pairReceipts,
  paddedLength,
  observe,
  nsecEncode,
  npubEncode,
  nprofileEncode,
  noteEncode,
  nostrUri,
  normaliseRelayUrl,
  normaliseDomain,
  nip05Url,
  nip05DocumentUrl,
  newestPerAddress,
  neventEncode,
  namesForPubkey,
  naddrEncode,
  lookupTxtVia,
  lookupTxt,
  localSigner,
  loadKey,
  listingFilter,
  listingAddress,
  lightningAddressUrl,
  labelToASCII,
  isReplaceable,
  isOwnRelayList,
  isNormalisedDomain,
  isHex64,
  isHex32,
  isEphemeral,
  isAddressable,
  inboxRelaysFor,
  identityProofUrl,
  hasStoredKey,
  hasExtension,
  giftWrapFilter,
  giftWrap,
  generateSecretKey,
  fundable,
  forgetStoredKey,
  foldStatus,
  flexZapFilter,
  fingerprintOf,
  fingerprintMatches,
  findTag,
  findFunding,
  finaliseSpend,
  fetchRelayInfo,
  fetchRdapDomainAt,
  fetchRdapDomain,
  fetchRdapBootstrap,
  fetchNip05,
  fetchLnurlPay,
  feeOf,
  extensionSigner,
  eventId,
  eventDigest,
  escrowsForFilter,
  escrowPublicKeyHex,
  escrowPublicKey,
  escrowFilter,
  escrowAddress,
  encrypt,
  encodeReply,
  encodeRecovery,
  encodeProofRecord,
  encodeLabel,
  encodeInvite,
  describeTree,
  deriveTransferState,
  deriveEscrowState,
  deriveEscrowId,
  deletionFilter,
  decrypt,
  decodeReply,
  decodeRecovery,
  decodeNip19,
  decodeLabel,
  decodeInvite,
  decodeAddress,
  createProof,
  countsTowardReputation,
  countOnRelays,
  countOnRelay,
  conversationKey,
  compareViews,
  combineProofs,
  clearZapperKeyCache,
  clearBootstrapCache,
  checkRegistry,
  checkListingAgainstZone,
  checkListing,
  checkEvent,
  checkEligibility,
  checkDomainProof,
  checkDomain,
  chainApi,
  canSealWith,
  buildZapRequest,
  buildWatchlist,
  buildVerifyRequest,
  buildTree,
  buildSpend,
  buildRumor,
  buildRelayList,
  buildReceipt,
  buildProfileBadges,
  buildPortfolio,
  buildListing,
  buildJobFeedback,
  buildHandlerAdvertisement,
  buildEscrowEvent,
  buildDeletion,
  buildCommitment,
  buildBadgeDefinition,
  buildBadgeAward,
  buildAttestation,
  buildArbiterSet,
  bolt11AmountMsats,
  attestationFilter,
  arbiterIntersection,
  applyDeletions,
  addressToScript,
  addressOf,
  ZAP_REQUEST_KIND,
  ZAP_RECEIPT_KIND,
  WRITE_FANOUT,
  WATCHLIST_D,
  WARNING_STATUSES,
  VERIFY_RESULT_KIND,
  VERIFY_REQUEST_KIND,
  TRANSFER_LOCK_STATUS,
  TRANSFER_LOCK_DAYS,
  SECONDS_PER_DAY,
  SEAL_KIND,
  RelayDirectory,
  ROOT_NAME,
  REQUIRED_AGREEING_POLLS,
  REPLY_PREFIX,
  RELAY_LIST_KIND,
  REFUSING_STATUSES,
  RECOVERY_PREFIX,
  RECEIPT_NAMESPACE,
  RECEIPT_KIND,
  READ_FANOUT,
  RDAP_BOOTSTRAP_URL,
  RDAP_BOOTSTRAP_URL2 as RDAP_BOOTSTRAP_ENDPOINT,
  PROOF_VERSION,
  PROOF_MESSAGE_PREFIX,
  PROOF_LABEL,
  PROOF_KIND,
  PROOF_D_PREFIX,
  PROFILE_KIND,
  PROFILE_BADGES_KIND,
  PROFILE_BADGES_D,
  PRICE_CURRENCY,
  PORTFOLIO_VERSION,
  PORTFOLIO_TOPIC,
  PORTFOLIO_KIND,
  PORTFOLIO_D,
  PENDING_TRANSFER_STATUS,
  NIP44_VERSION,
  NETWORK_HRP,
  MSATS_PER_SAT,
  MIN_POLL_GAP_SECONDS,
  MIN_PLAINTEXT_BYTES,
  MIN_EXPIRY_DAYS,
  MAX_TIMESTAMP_JITTER,
  MAX_PLAINTEXT_BYTES,
  MAX_LABEL_LENGTH,
  MAX_DOMAIN_LENGTH,
  MAX_CLOCK_SKEW_SECONDS,
  LISTING_TOPIC,
  LISTING_KIND,
  LISTING_D_PREFIX,
  JOB_FEEDBACK_KIND,
  INVITE_PREFIX,
  HANDLER_KIND,
  GIFT_WRAP_KIND,
  FOLLOW_SET_KIND,
  FMD_BADGES,
  FLEX_TOPIC,
  EXPLORERS,
  ESCROW_VERSION,
  ESCROW_TOPIC,
  ESCROW_KIND,
  ESCROW_D_PREFIX,
  DOH_PROVIDERS,
  DELETION_KIND,
  DEFAULT_RELAYS,
  CHAT_KIND,
  CHAIN_APIS,
  BADGE_DEFINITION_KIND,
  BADGE_AWARD_KIND,
  ARBITER_SET_D,
  ACE_PREFIX
};
