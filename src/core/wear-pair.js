/**
 * GBWP/1: the computer side of `gbot wear pair`.
 *
 * Sends one Grok Bot gateway session to a Wear OS watch on the LAN over a channel authenticated by the 60-bit
 * pairing code shown on the watch (ECDH P-256, HKDF-SHA256, HMAC-SHA256, AES-256-GCM). The byte layout is fixed by
 * the grok-bot-watch repository's known-answer vectors (copied to test/fixtures/gbwp1-vectors.json):
 *
 *   M1 C→W  86 B    "GBWP" || 0x01 || C_pub (65) || C_nonce (16)
 *   M2 W→C  113 B   W_pub (65) || W_nonce (16) || tagW (32)
 *   M3 C→W  60+N B  tagC (32) || iv (12) || ciphertext (N) || gcmTag (16),   1 <= N <= 16384
 *   M4 W→C  33 B    status (1) || tagA (32)
 *
 * Every message is framed as `u16 big-endian length || body`.
 *
 * Self-contained on purpose: this module imports Node built-ins only and no other module of this package. The
 * grok-bot-watch repository vendors an exact copy (pinned by SHA-256) for its Kotlin server <-> Node client test.
 * Nothing here logs, and errors carry a fixed category and message only (never peer data, keys, the code or the
 * session).
 */
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import net from "node:net";

export const PROTOCOL = "GBWP/1";

const MAGIC = Buffer.from("GBWP", "ascii");
const VERSION = 1;

export const SIZES = Object.freeze({
  publicKey: 65,
  nonce: 16,
  tag: 32,
  iv: 12,
  gcmTag: 16,
  m1: 86,
  m2: 113,
  m3Overhead: 60,
  m4: 33,
  maxPayload: 16 * 1024,
  maxFrame: 32 * 1024,
});

/** Absolute phase deadlines in milliseconds; a deadline is never extended by trickled bytes. */
export const DEFAULT_TIMEOUTS = Object.freeze({
  /** TCP connect. */
  connectMs: 5_000,
  /** Writing M1, and writing M3. */
  writeMs: 5_000,
  /** M2 must be complete this long after M1 was sent. */
  m2Ms: 15_000,
  /** M4 must be complete this long after M3 was sent. */
  m4Ms: 20_000,
});

export const STATUS = Object.freeze({ ok: 0, rejected: 1, storage: 2 });

/** Fixed user-facing text for every failure category; nothing variable is ever appended. */
export const PAIR_MESSAGES = Object.freeze({
  typo: "The code has a typo (check the last character).",
  "invalid-code": "That is not a pairing code. Type the 13 characters shown on the watch, like ABCD-EFGH-JKMN-P.",
  unreachable:
    "Could not reach the watch. Check that this computer and the watch are on the same Wi-Fi network, that the " +
    "network does not isolate clients from each other, and (macOS) that this terminal app is allowed under " +
    "System Settings > Privacy & Security > Local Network. If the watch already shows a failure, generate a new code.",
  "no-answer":
    "The watch did not answer (version mismatch or it is busy), or this computer is on a different subnet than the " +
    "watch (the watch closes connections from other subnets). Generate a new code on the watch and try again.",
  auth: "Wrong code, or this is not your watch. Generate a new code on the watch; never reuse an old one.",
  payload: "The session is too large or malformed for the watch.",
  usage: "Invalid pairing request.",
  aborted: "Pairing was cancelled.",
});

export const OUTCOME_MESSAGES = Object.freeze({
  paired: "Paired. The watch stored the session.",
  rejected: "The watch rejected the session. Generate a new code on the watch and try again.",
  "storage-failed": "The watch could not store the session. Generate a new code on the watch and try again.",
  unknown: "Sent; no confirmation. Check the watch screen.",
});

/** A pairing failure with a fixed category; its message comes from PAIR_MESSAGES and never includes data. */
export class WearPairError extends Error {
  constructor(category) {
    super(PAIR_MESSAGES[category] ?? "Pairing failed.");
    this.name = "WearPairError";
    this.category = category;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pairing code: 12 Crockford base32 data symbols (60 bits) + 1 Luhn mod 32 check symbol, shown XXXX-XXXX-XXXX-C.

export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_DATA_LENGTH = 12;
const CODE_INPUT_MAX = 32;

/**
 * Luhn mod N (N = 32) check symbol over the data symbols. It detects every single-symbol error and every adjacent
 * transposition except one: swapping adjacent `0` and `Z` (values 0 and 31) leaves the check symbol unchanged,
 * exactly like `09` <-> `90` in decimal Luhn. That swap is caught by the watch instead (wrong code -> no pairing).
 */
export function codeCheckSymbol(data) {
  const n = CODE_ALPHABET.length;
  let factor = 2;
  let sum = 0;
  for (let i = data.length - 1; i >= 0; i -= 1) {
    let addend = factor * CODE_ALPHABET.indexOf(data[i]);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / n) + (addend % n);
    sum += addend;
  }
  return CODE_ALPHABET[(n - (sum % n)) % n];
}

/**
 * Classifies typed input like the watch's `PairingCode.normalize`: ASCII only, `-` and spaces dropped, upper case,
 * `I`/`L` read as `1` and `O` as `0`, exactly 13 symbols. Returns `{ code }` (the 13 normalized symbols),
 * `{ error: "typo" }` when only the check symbol is wrong, or `{ error: "invalid-code" }` for anything else.
 */
/**
 * @param {unknown} input
 * @returns {{ code: string, error?: undefined } | { code?: undefined, error: "typo" | "invalid-code" }}
 */
export function checkCode(input) {
  if (typeof input !== "string" || input.length > CODE_INPUT_MAX) return { error: "invalid-code" };
  let symbols = "";
  for (let i = 0; i < input.length; i += 1) {
    const unit = input.charCodeAt(i);
    if (unit > 0x7e) return { error: "invalid-code" };
    const raw = input[i];
    if (raw === "-" || raw === " ") continue;
    let c = raw.toUpperCase();
    if (c === "I" || c === "L") c = "1";
    else if (c === "O") c = "0";
    if (!CODE_ALPHABET.includes(c)) return { error: "invalid-code" };
    symbols += c;
  }
  if (symbols.length !== CODE_DATA_LENGTH + 1) return { error: "invalid-code" };
  if (codeCheckSymbol(symbols.slice(0, CODE_DATA_LENGTH)) !== symbols[CODE_DATA_LENGTH]) return { error: "typo" };
  return { code: symbols };
}

/** The 13 normalized symbols, or null (same contract as the watch's `PairingCode.normalize`). */
export function normalizeCode(input) {
  return checkCode(input).code ?? null;
}

function isCodeData(data) {
  if (typeof data !== "string" || data.length !== CODE_DATA_LENGTH) return false;
  for (const c of data) if (!CODE_ALPHABET.includes(c)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Watch address: `<dotted-decimal IPv4>:<port>` on a private, CGNAT or link-local network.

const OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
const TARGET_PATTERN = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}:([1-9][0-9]{0,4})$`);

/**
 * Parses the address the watch shows. Accepts only a dotted-decimal IPv4 literal (four octets 0-255 without leading
 * zeros; no octal, hex, short or single-integer forms, no hostnames, no IPv6) and a port 1024-65535 without leading
 * zeros, in 10/8, 172.16/12, 192.168/16, 100.64/10 or 169.254/16. Loopback (127/8) only with `allowLoopback`
 * (tests). Returns `{ host, port, target }` or null.
 */
export function parseTarget(text, { allowLoopback = false } = {}) {
  if (typeof text !== "string" || text.length > 21) return null;
  const match = TARGET_PATTERN.exec(text);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const port = Number(match[5]);
  if (port < 1024 || port > 65535) return null;
  const [a, b] = octets;
  const allowed =
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 127 && allowLoopback === true);
  if (!allowed) return null;
  const host = octets.join(".");
  return { host, port, target: `${host}:${port}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Session pre-flight: the watch's SessionVault.import with the production UrlPolicy (GATEWAY), as fixed rules. No
// environment variable loosens them, and there is no test-mode exception.

const MAX_TOKEN_CHARS = 4096;
const MAX_HEADERS = 8;
const MAX_LABEL_UNITS = 64;
const HEADER_NAME = /^x-[a-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "host", "content-type"]);

const SPACE_SEPARATOR = /^\p{Zs}$/u;

/** Kotlin/JVM `Char.isWhitespace()`: TAB, LF, VT, FF, CR, U+001C..U+001F, U+2028, U+2029 and every Zs space. */
function isKotlinWhitespace(unit) {
  const c = unit.charCodeAt(0);
  return (c >= 0x09 && c <= 0x0d) || (c >= 0x1c && c <= 0x1f) || c === 0x2028 || c === 0x2029 || SPACE_SEPARATOR.test(unit);
}

/** Kotlin's `String.trim()` (differs from JavaScript's: U+FEFF is kept, U+001C..U+001F are removed). */
function kotlinTrim(value) {
  let start = 0;
  let end = value.length;
  while (start < end && isKotlinWhitespace(value[start])) start += 1;
  while (end > start && isKotlinWhitespace(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

const URL_PARTS = /^([^:/?#]+):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const PATH = /^(?:[A-Za-z0-9\-_.!~*'();/:@&=+$,]|%[0-9A-Fa-f]{2})*$/;
const URIC = /^(?:[A-Za-z0-9\-_.!~*'();/?:@&=+$,[\]]|%[0-9A-Fa-f]{2})*$/;
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * `UrlPolicy(allowLocalGateway = false, allowAnyGateway = false).assertAllowedCredentialUrl(url, GATEWAY)` as the
 * watch runs it on `java.net.URI`: https only, a server authority without userinfo, a port 1..65535 when one is
 * given, and a host equal to cursor.sh / cursor.com or ending in .cursor.sh / .cursor.com / .cursorvm.com. Returns
 * the URL without trailing slashes, or null. Deliberately stricter than java.net.URI in one place: non-ASCII
 * characters in the path, query or fragment are rejected (a gateway URL never has them).
 */
function watchGatewayUrl(url) {
  const parts = URL_PARTS.exec(url);
  if (!parts) return null;
  const [, scheme, authority, path, query, fragment] = parts;
  if (!SCHEME.test(scheme) || !PATH.test(path)) return null;
  if (query !== undefined && !URIC.test(query)) return null;
  if (fragment !== undefined && !URIC.test(fragment)) return null;
  if (authority.includes("@")) return null;
  const hostPort = /^([^:]+)(?::([0-9]*))?$/.exec(authority);
  if (!hostPort) return null;
  const [, host, port] = hostPort;
  const labels = host.split(".");
  if (!labels.every((label) => HOST_LABEL.test(label))) return null;
  if (labels.length > 1 && !/^[A-Za-z]/.test(labels[labels.length - 1])) return null;
  if (port) {
    const number = Number(port);
    if (!(number >= 1 && number <= 65535)) return null;
  }
  if (scheme.toLowerCase() !== "https") return null;
  const h = host.toLowerCase();
  const allowed =
    h === "cursor.sh" ||
    h === "cursor.com" ||
    h.endsWith(".cursor.sh") ||
    h.endsWith(".cursor.com") ||
    h.endsWith(".cursorvm.com");
  if (!allowed) return null;
  return url.replace(/\/+$/, "");
}

function isVisibleAscii(value) {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

/** What the watch's HTTP client sends unchanged: TAB or 0x20..0x7E, no leading/trailing space or TAB. */
function isValidHeaderValue(value) {
  if (value.length === 0 || value.length > MAX_TOKEN_CHARS) return false;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c !== 0x09 && (c < 0x20 || c > 0x7e)) return false;
  }
  const first = value[0];
  const last = value[value.length - 1];
  return first !== " " && first !== "\t" && last !== " " && last !== "\t";
}

/** At most `max` UTF-16 code units, cut at a code point boundary (never half a surrogate pair). */
export function truncateLabel(label, max = MAX_LABEL_UNITS) {
  let out = "";
  for (const codePoint of label) {
    if (out.length + codePoint.length > max) break;
    out += codePoint;
  }
  return out;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Checks a session `{ gatewayUrl, gatewayToken, headers?, label? }` with the watch's import rules and builds the
 * exact payload to send. Returns `{ ok: true, session, payload }` with normalized values (trimmed URL without
 * trailing slashes, trimmed token, lower-case header names, label cut to 64 UTF-16 units) and the UTF-8 JSON
 * payload, or `{ ok: false, reason }` with reason `shape`, `url`, `token`, `headers` or `size`.
 */
/**
 * @param {unknown} session
 * @returns {{ ok: true, payload: Buffer, session: { gatewayUrl: string, gatewayToken: string,
 *   headers: Record<string, string>, label: string } } | { ok: false, reason: "shape" | "url" | "token" | "headers" | "size" }}
 */
export function preflightSession(session) {
  if (!isPlainObject(session)) return { ok: false, reason: "shape" };
  const { gatewayUrl, gatewayToken } = session;
  const rawHeaders = session.headers === undefined ? {} : session.headers;
  const rawLabel = session.label === undefined ? "" : session.label;
  if (typeof gatewayUrl !== "string" || typeof gatewayToken !== "string" || typeof rawLabel !== "string") {
    return { ok: false, reason: "shape" };
  }
  if (!isPlainObject(rawHeaders)) return { ok: false, reason: "shape" };
  const headerEntries = Object.entries(rawHeaders);
  if (headerEntries.some(([, value]) => typeof value !== "string")) return { ok: false, reason: "shape" };

  const url = watchGatewayUrl(kotlinTrim(gatewayUrl));
  if (url === null) return { ok: false, reason: "url" };
  const token = kotlinTrim(gatewayToken);
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS || !isVisibleAscii(token)) return { ok: false, reason: "token" };
  if (headerEntries.length > MAX_HEADERS) return { ok: false, reason: "headers" };
  const headers = new Map();
  for (const [key, value] of headerEntries) {
    const name = kotlinTrim(key).toLowerCase();
    if (FORBIDDEN_HEADERS.has(name) || !HEADER_NAME.test(name)) return { ok: false, reason: "headers" };
    if (!isValidHeaderValue(value)) return { ok: false, reason: "headers" };
    headers.set(name, value);
  }
  const normalized = {
    gatewayUrl: url,
    gatewayToken: token,
    headers: Object.fromEntries(headers),
    label: truncateLabel(rawLabel),
  };
  const payload = buildSessionPayload(normalized);
  if (payload.length > SIZES.maxPayload) return { ok: false, reason: "size" };
  return { ok: true, session: normalized, payload };
}

/** The M3 plaintext: compact UTF-8 JSON with the keys in this order. */
export function buildSessionPayload({ gatewayUrl, gatewayToken, headers, label }) {
  return Buffer.from(JSON.stringify({ gatewayUrl, gatewayToken, headers, label }), "utf8");
}

// ---------------------------------------------------------------------------------------------------------------
// Primitives.

const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function toBigInt(bytes) {
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

/**
 * True when `bytes` is a canonical uncompressed P-256 point: 65 bytes, prefix 0x04, both coordinates below p, and
 * y^2 = x^3 - 3x + b (mod p). P-256 has cofactor 1, so any such point is in the prime-order group.
 */
export function isValidPublicKey(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SIZES.publicKey || bytes[0] !== 0x04) return false;
  const x = toBigInt(bytes.subarray(1, 33));
  const y = toBigInt(bytes.subarray(33, 65));
  if (x >= P256_P || y >= P256_P) return false;
  const lhs = (y * y) % P256_P;
  const rhs = ((((x * x) % P256_P) * x) % P256_P + (P256_P - 3n) * x + P256_B) % P256_P;
  return lhs === rhs;
}

function sha256(...parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function hmac(key, ...parts) {
  const mac = crypto.createHmac("sha256", key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

/** HKDF-Extract (RFC 5869) with SHA-256; an empty salt means 32 zero bytes. */
export function hkdfExtract(salt, ikm) {
  return hmac(salt.length === 0 ? Buffer.alloc(32) : salt, ikm);
}

/** HKDF-Expand (RFC 5869) with SHA-256. */
export function hkdfExpand(prk, info, length) {
  if (!Number.isInteger(length) || length < 1 || length > 255 * 32) throw new RangeError("HKDF length");
  const out = Buffer.alloc(length);
  let block = Buffer.alloc(0);
  for (let offset = 0, counter = 1; offset < length; offset += 32, counter += 1) {
    block = hmac(prk, block, info, Buffer.from([counter]));
    block.copy(out, offset, 0, Math.min(32, length - offset));
  }
  return out;
}

/** `th = SHA-256(M1 body || W_pub || W_nonce)`. */
export function transcriptHash(m1, watchPublic, watchNonce) {
  return sha256(m1, watchPublic, watchNonce);
}

/** The four 32-byte keys from the 32-byte ECDH x-coordinate, the 12 code data symbols and th. */
export function deriveKeys(sharedSecret, codeData, th) {
  const prk = hkdfExtract(Buffer.from("GBWP1 code " + codeData, "ascii"), sharedSecret);
  const expand = (label) => hkdfExpand(prk, Buffer.concat([Buffer.from("GBWP1 " + label, "ascii"), th]), 32);
  const keys = {
    tagWatch: expand("tag watch"),
    tagComputer: expand("tag computer"),
    enc: expand("enc"),
    ack: expand("ack"),
  };
  prk.fill(0);
  return keys;
}

export const tagWatch = (keys, th) => hmac(keys.tagWatch, Buffer.from("W"), th);
export const tagComputer = (keys, th) => hmac(keys.tagComputer, Buffer.from("C"), th);
export const tagAck = (keys, th, m3, status) => hmac(keys.ack, Buffer.from("A"), th, sha256(m3), Buffer.from([status]));

/** Constant-time comparison; unequal lengths are simply unequal. */
export function constantTimeEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** `u16 big-endian length || body`. */
export function frame(body) {
  if (body.length < 1 || body.length > SIZES.maxFrame) throw new RangeError("frame length");
  const header = Buffer.alloc(2);
  header.writeUInt16BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function leftPad32(bytes) {
  if (bytes.length === 32) return Buffer.from(bytes);
  if (bytes.length > 32) throw new RangeError("shared secret length");
  return Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]);
}

function wipeKeys(keys) {
  if (!keys) return;
  for (const key of Object.values(keys)) key.fill(0);
}

// ---------------------------------------------------------------------------------------------------------------
// Handshake state machine (no I/O): M1 -> acceptM2 -> sealM3 -> openM4.

/**
 * One client attempt. `privateKey` (32-byte scalar), `nonce` and the `iv` given to sealM3 exist for known-answer
 * tests only; production uses a fresh key, nonce and IV per attempt.
 */
export class ClientHandshake {
  #codeData;
  #ecdh;
  #m1;
  #th = null;
  #keys = null;
  #m3Hash = null;
  #state = "m1";

  /** @param {{ codeData: string, privateKey?: Uint8Array, nonce?: Uint8Array }} options */
  constructor({ codeData, privateKey, nonce }) {
    if (!isCodeData(codeData)) throw new TypeError("code data must be 12 pairing-code symbols");
    this.#codeData = codeData;
    this.#ecdh = crypto.createECDH("prime256v1");
    if (privateKey !== undefined) this.#ecdh.setPrivateKey(Buffer.from(privateKey));
    else this.#ecdh.generateKeys();
    const ownNonce = nonce === undefined ? crypto.randomBytes(SIZES.nonce) : Buffer.from(nonce);
    if (ownNonce.length !== SIZES.nonce) throw new RangeError("nonce length");
    const publicKey = this.#ecdh.getPublicKey(null, "uncompressed");
    this.#m1 = Buffer.concat([MAGIC, Buffer.from([VERSION]), publicKey, ownNonce]);
  }

  /** M1 body (86 bytes). */
  m1() {
    return Buffer.from(this.#m1);
  }

  /**
   * Validates M2 and derives the keys. Throws WearPairError `no-answer` for a body of the wrong size and `auth` for
   * an invalid public key or a tagW that does not verify (wrong code, or not the watch). Only after this returns may
   * M3 be built.
   */
  acceptM2(body) {
    if (this.#state !== "m1") throw new Error("M2 out of order");
    if (!(body instanceof Uint8Array) || body.length !== SIZES.m2) throw new WearPairError("no-answer");
    const watchPublic = Buffer.from(body.subarray(0, 65));
    const watchNonce = Buffer.from(body.subarray(65, 81));
    const tag = Buffer.from(body.subarray(81, 113));
    if (!isValidPublicKey(watchPublic)) {
      this.#state = "failed";
      throw new WearPairError("auth");
    }
    let shared;
    try {
      shared = leftPad32(this.#ecdh.computeSecret(watchPublic));
    } catch {
      this.#state = "failed";
      throw new WearPairError("auth");
    }
    const th = transcriptHash(this.#m1, watchPublic, watchNonce);
    const keys = deriveKeys(shared, this.#codeData, th);
    shared.fill(0);
    if (!constantTimeEqual(tag, tagWatch(keys, th))) {
      wipeKeys(keys);
      this.#state = "failed";
      throw new WearPairError("auth");
    }
    this.#th = th;
    this.#keys = keys;
    this.#state = "m2";
  }

  /** M3 body: tagC || iv || AES-256-GCM(k_enc, iv, aad = th, payload) || gcmTag. `k_enc` seals exactly one message. */
  sealM3(payload, { iv } = {}) {
    if (this.#state !== "m2") throw new Error("M3 before a verified M2");
    if (!(payload instanceof Uint8Array) || payload.length < 1 || payload.length > SIZES.maxPayload) {
      throw new WearPairError("payload");
    }
    const nonce = iv === undefined ? crypto.randomBytes(SIZES.iv) : Buffer.from(iv);
    if (nonce.length !== SIZES.iv) throw new RangeError("iv length");
    const cipher = crypto.createCipheriv("aes-256-gcm", this.#keys.enc, nonce, { authTagLength: SIZES.gcmTag });
    cipher.setAAD(this.#th);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const m3 = Buffer.concat([tagComputer(this.#keys, this.#th), nonce, ciphertext, cipher.getAuthTag()]);
    this.#keys.enc.fill(0);
    this.#m3Hash = sha256(m3);
    this.#state = "m3";
    return m3;
  }

  /** The authenticated status from M4 (0 ok, 1 rejected, 2 storage), or null when M4 is not valid. */
  openM4(body) {
    if (this.#state !== "m3") throw new Error("M4 before M3");
    this.#state = "done";
    if (!(body instanceof Uint8Array) || body.length !== SIZES.m4) return null;
    const status = body[0];
    const expected = hmac(this.#keys.ack, Buffer.from("A"), this.#th, this.#m3Hash, Buffer.from([status]));
    if (!constantTimeEqual(Buffer.from(body.subarray(1)), expected)) return null;
    return status === STATUS.ok || status === STATUS.rejected || status === STATUS.storage ? status : null;
  }

  /** Drops the derived keys (best effort; JavaScript cannot promise full zeroization). */
  wipe() {
    wipeKeys(this.#keys);
    this.#keys = null;
    this.#ecdh = null;
    this.#state = "done";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Transport.

class FrameReader {
  #socket;
  #buffer = Buffer.alloc(0);
  #limit;
  #ended = false;
  #overflow = false;
  #wake = null;

  constructor(socket, limit) {
    this.#socket = socket;
    this.#limit = limit;
    socket.on("data", (chunk) => {
      if (this.#overflow) return;
      if (this.#buffer.length + chunk.length > this.#limit) {
        // More than the expected frame: trailing bytes or a wrong length. Stop buffering.
        this.#overflow = true;
        this.#buffer = Buffer.alloc(0);
      } else {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
      }
      this.#wake?.();
    });
    const ended = () => {
      this.#ended = true;
      this.#wake?.();
    };
    socket.on("end", ended);
    socket.on("close", ended);
    socket.on("error", ended);
  }

  /**
   * Reads one frame whose body is exactly `size` bytes, by an absolute deadline `ms` from now. The length header is
   * checked before the body is collected; a different length, extra bytes, the peer closing, or the deadline
   * rejects. Buffering is capped at the expected frame.
   */
  read(size, ms) {
    this.#limit = 2 + size;
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, body) => {
        clearTimeout(timer);
        this.#wake = null;
        if (error) reject(error);
        else resolve(body);
      };
      const check = () => {
        if (this.#overflow) return finish(new Error("frame"));
        const buffered = this.#buffer;
        if (buffered.length >= 2 && buffered.readUInt16BE(0) !== size) return finish(new Error("frame"));
        if (buffered.length === 2 + size) {
          this.#buffer = Buffer.alloc(0);
          return finish(null, Buffer.from(buffered.subarray(2)));
        }
        if (this.#ended) return finish(new Error("closed"));
        return undefined;
      };
      timer = setTimeout(() => finish(new Error("deadline")), ms);
      this.#wake = check;
      check();
    });
  }

  /** The next frame may be at most `size` bytes of body (bytes arriving early are kept within that bound). */
  expect(size) {
    this.#limit = 2 + size;
  }
}

/** TCP connect with an absolute deadline; an abort destroys the connecting socket at once. */
function connect(createConnection, host, port, ms, signal) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port, family: 4, noDelay: true });
    let settled = false;
    let timer;
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onAbort = () => done(new Error("aborted"));
    timer = setTimeout(() => done(new Error("deadline")), ms);
    socket.once("connect", () => done(null));
    socket.once("error", () => done(new Error("connect")));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function write(socket, bytes, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deadline")), ms);
    socket.write(bytes, (error) => {
      clearTimeout(timer);
      if (error) reject(new Error("write"));
      else resolve();
    });
  });
}

function outcomeOf(status) {
  if (status === STATUS.ok) return "paired";
  if (status === STATUS.rejected) return "rejected";
  if (status === STATUS.storage) return "storage-failed";
  return "unknown";
}

/**
 * Runs one GBWP/1 attempt against the watch at `host:port` (an IPv4 literal) and sends `payload` (the UTF-8 JSON
 * from preflightSession). The code is checked before any network I/O; M3 is sent only after tagW verifies; there
 * are no retries. Resolves `{ outcome }` with outcome `paired`, `rejected`, `storage-failed` or `unknown`. Throws
 * WearPairError with category `typo` / `invalid-code` (before any I/O), `unreachable` (connect failed),
 * `no-answer` (no well-formed M2 in time), `auth` (bad tagW or watch key), `payload`, `usage`, or `aborted` (the
 * signal fired before the session was sent).
 *
 * Once the M3 write has started the session may have reached the watch, so from then on nothing throws: an abort,
 * a write or read error, a deadline or an invalid M4 all resolve `{ outcome: "unknown" }`. `onSending` (optional)
 * is called synchronously just before that write; its exceptions are ignored.
 */
/**
 * @param {{ host: string, port: number, code: string, payload: Uint8Array,
 *   timeouts?: Partial<{ connectMs: number, writeMs: number, m2Ms: number, m4Ms: number }>, signal?: AbortSignal,
 *   onSending?: () => void, createConnection?: (options: net.NetConnectOpts) => net.Socket }} options
 * @returns {Promise<{ outcome: "paired" | "rejected" | "storage-failed" | "unknown" }>}
 */
export async function pairWithWatch({
  host,
  port,
  code,
  payload,
  timeouts = {},
  signal,
  onSending,
  createConnection = net.createConnection,
}) {
  const checked = checkCode(code);
  if (checked.error) throw new WearPairError(checked.error);
  if (typeof host !== "string" || net.isIPv4(host) === false || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new WearPairError("usage");
  }
  if (!(payload instanceof Uint8Array) || payload.length < 1 || payload.length > SIZES.maxPayload) {
    throw new WearPairError("payload");
  }
  if (signal?.aborted) throw new WearPairError("aborted");
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const handshake = new ClientHandshake({ codeData: checked.code.slice(0, CODE_DATA_LENGTH) });
  let socket;
  const onAbort = () => socket?.destroy();
  signal?.addEventListener("abort", onAbort, { once: true });
  const fail = (category) => new WearPairError(signal?.aborted ? "aborted" : category);
  try {
    try {
      socket = await connect(createConnection, host, port, limits.connectMs, signal);
    } catch {
      throw fail("unreachable");
    }
    if (signal?.aborted) throw fail("aborted");
    const reader = new FrameReader(socket, 2 + SIZES.m2);
    try {
      await write(socket, frame(handshake.m1()), limits.writeMs);
    } catch {
      throw fail("no-answer");
    }
    let m2;
    try {
      m2 = await reader.read(SIZES.m2, limits.m2Ms);
    } catch {
      throw fail("no-answer");
    }
    handshake.acceptM2(m2);
    reader.expect(SIZES.m4);
    const m3 = handshake.sealM3(payload);
    if (signal?.aborted) throw fail("aborted");
    // From here the session may leave the computer: every ending is a result, `unknown` unless M4 verifies.
    try {
      onSending?.();
    } catch {
      // The hook is advisory (the CLI records that the session was sent); it never stops the send.
    }
    try {
      await write(socket, frame(m3), limits.writeMs);
    } catch {
      return { outcome: "unknown" };
    }
    // An abort now destroys the socket, so the read below fails (-> unknown) unless a complete M4 already arrived.
    let m4;
    try {
      m4 = await reader.read(SIZES.m4, limits.m4Ms);
    } catch {
      return { outcome: "unknown" };
    }
    return { outcome: outcomeOf(handshake.openM4(m4)) };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    socket?.destroy();
    handshake.wipe();
  }
}
