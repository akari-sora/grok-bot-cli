import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CODE_ALPHABET,
  ClientHandshake,
  SIZES,
  WearPairError,
  buildSessionPayload,
  checkCode,
  codeCheckSymbol,
  deriveKeys,
  frame,
  hkdfExpand,
  hkdfExtract,
  isValidPublicKey,
  normalizeCode,
  parseTarget,
  transcriptHash,
} from "../src/core/wear-pair.js";
import { parseWearTarget } from "../bin/gbot.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const vectors = JSON.parse(readFileSync(fixture("gbwp1-vectors.json"), "utf8"));
const hex = (value) => Buffer.from(value, "hex");
const unframe = (wire) => {
  const bytes = hex(wire);
  assert.equal(bytes.readUInt16BE(0), bytes.length - 2, "vector frame length");
  return bytes.subarray(2);
};

test("vector files are byte-identical copies of the watch repository's", () => {
  const lines = readFileSync(fixture("wear-pair-vectors.sha256"), "utf8").split("\n").filter((line) => /^[0-9a-f]{64} {2}/.test(line));
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const [sum, name] = line.split(/ {2}/);
    assert.equal(crypto.createHash("sha256").update(readFileSync(fixture(name))).digest("hex"), sum, name);
  }
  assert.equal(vectors.protocol, "GBWP/1");
  assert.equal(vectors.alphabet, CODE_ALPHABET);
});

test("HKDF-SHA256 matches RFC 5869 test cases 1 and 3 and node:crypto hkdfSync", () => {
  assert.equal(vectors.hkdfRfc5869.length, 2);
  for (const v of vectors.hkdfRfc5869) {
    const prk = hkdfExtract(hex(v.salt), hex(v.ikm));
    assert.equal(prk.toString("hex"), v.prk);
    assert.equal(hkdfExpand(prk, hex(v.info), v.length).toString("hex"), v.okm);
    assert.equal(Buffer.from(crypto.hkdfSync("sha256", hex(v.ikm), hex(v.salt), hex(v.info), v.length)).toString("hex"), v.okm);
  }
  assert.throws(() => hkdfExpand(Buffer.alloc(32), Buffer.alloc(0), 0), RangeError);
  assert.throws(() => hkdfExpand(Buffer.alloc(32), Buffer.alloc(0), 255 * 32 + 1), RangeError);
});

for (const v of vectors.vectors) {
  test(`GBWP/1 vector "${v.name}": M1, keys, tagW, M3 and M4 match byte for byte`, () => {
    assert.equal(normalizeCode(v.code), v.codeData + v.code.at(-1));
    const handshake = new ClientHandshake({ codeData: v.codeData, privateKey: hex(v.computerPrivate), nonce: hex(v.computerNonce) });
    const m1 = handshake.m1();
    assert.equal(m1.length, SIZES.m1);
    assert.equal(frame(m1).toString("hex"), v.m1);
    assert.equal(m1.subarray(5, 70).toString("hex"), v.computerPublic);

    // The key schedule, step by step, from the vector's own values.
    const th = transcriptHash(m1, hex(v.watchPublic), hex(v.watchNonce));
    assert.equal(th.toString("hex"), v.transcriptHash);
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.setPrivateKey(hex(v.computerPrivate));
    const raw = ecdh.computeSecret(hex(v.watchPublic));
    const shared = Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
    assert.equal(shared.toString("hex"), v.ecdhX);
    assert.equal(hkdfExtract(Buffer.from("GBWP1 code " + v.codeData, "ascii"), shared).toString("hex"), v.prk);
    const keys = deriveKeys(shared, v.codeData, th);
    assert.deepEqual(
      { "tag watch": keys.tagWatch.toString("hex"), "tag computer": keys.tagComputer.toString("hex"), enc: keys.enc.toString("hex"), ack: keys.ack.toString("hex") },
      v.keys,
    );

    const m2 = unframe(v.m2);
    assert.equal(m2.length, SIZES.m2);
    assert.equal(m2.subarray(81).toString("hex"), v.tagWatch);
    handshake.acceptM2(m2);

    const m3 = handshake.sealM3(Buffer.from(v.payload, "utf8"), { iv: hex(v.iv) });
    assert.equal(frame(m3).toString("hex"), v.m3);
    assert.equal(m3.subarray(0, 32).toString("hex"), v.tagComputer);
    assert.equal(m3.length, SIZES.m3Overhead + Buffer.byteLength(v.payload));

    const m4 = unframe(v.m4);
    assert.equal(m4.subarray(1).toString("hex"), v.tagAck);
    assert.equal(handshake.openM4(m4), v.status);
  });
}

test("the session payload builder produces the vectors' payload bytes", () => {
  for (const v of vectors.vectors) {
    const parsed = JSON.parse(v.payload);
    assert.equal(buildSessionPayload(parsed).toString("utf8"), v.payload);
  }
});

test("the leading-zero and edge-coordinate vectors exercise fixed-width encodings", () => {
  const lz = vectors.vectors.find((v) => v.name === "leading-zero-shared-secret");
  assert.ok(lz.ecdhX.startsWith("00"));
  const edge = vectors.vectors.find((v) => v.name === "edge-coordinates");
  assert.equal(edge.watchPublic.slice(2, 4), "00");
});

const freshVector = () => vectors.vectors[0];
const handshakeFor = (v) => new ClientHandshake({ codeData: v.codeData, privateKey: hex(v.computerPrivate), nonce: hex(v.computerNonce) });

test("a tampered M2 fails authentication and no M3 can be built", () => {
  const v = freshVector();
  const fields = { "watch key": 10, "watch nonce": 70, tagW: 100 };
  for (const [field, index] of Object.entries(fields)) {
    const m2 = Buffer.from(unframe(v.m2));
    m2[index] ^= 0x01;
    const handshake = handshakeFor(v);
    assert.throws(() => handshake.acceptM2(m2), (error) => error instanceof WearPairError && error.category === "auth", field);
    assert.throws(() => handshake.sealM3(Buffer.from(v.payload)), /before a verified M2/, field);
  }
});

test("M2 with the wrong size is not an answer; the wrong code fails tagW", () => {
  const v = freshVector();
  const m2 = unframe(v.m2);
  for (const body of [m2.subarray(0, SIZES.m2 - 1), Buffer.concat([m2, Buffer.alloc(1)])]) {
    assert.throws(() => handshakeFor(v).acceptM2(body), (error) => error.category === "no-answer");
  }
  const otherData = v.codeData.slice(0, 11) + (v.codeData[11] === "0" ? "1" : "0");
  const wrong = new ClientHandshake({ codeData: otherData, privateKey: hex(v.computerPrivate), nonce: hex(v.computerNonce) });
  assert.throws(() => wrong.acceptM2(m2), (error) => error.category === "auth");
});

test("a tampered or truncated M4 and an unknown status are not a receipt", () => {
  const v = freshVector();
  const sealed = () => {
    const handshake = handshakeFor(v);
    handshake.acceptM2(unframe(v.m2));
    handshake.sealM3(Buffer.from(v.payload, "utf8"), { iv: hex(v.iv) });
    return handshake;
  };
  const m4 = Buffer.from(unframe(v.m4));
  assert.equal(sealed().openM4(m4), 0);
  const flippedTag = Buffer.from(m4);
  flippedTag[32] ^= 0x01;
  assert.equal(sealed().openM4(flippedTag), null);
  const flippedStatus = Buffer.from(m4);
  flippedStatus[0] = 1;
  assert.equal(sealed().openM4(flippedStatus), null, "status is bound by tagA");
  assert.equal(sealed().openM4(m4.subarray(0, 32)), null);
  // A different M3 (other IV) changes tagA: the receipt is bound to the M3 actually sent.
  const other = handshakeFor(v);
  other.acceptM2(unframe(v.m2));
  other.sealM3(Buffer.from(v.payload, "utf8"), { iv: Buffer.alloc(12, 7) });
  assert.equal(other.openM4(m4), null);
});

test("every rejected public key in the vector file is refused before ECDH", () => {
  const names = Object.keys(vectors.badPublicKeys);
  assert.deepEqual(names.sort(), ["all-zero", "compressed-prefix", "hybrid-prefix", "off-curve", "too-long", "truncated", "x-equals-p", "zero-prefix"].sort());
  for (const [name, key] of Object.entries(vectors.badPublicKeys)) {
    assert.equal(isValidPublicKey(hex(key)), false, name);
  }
  for (const v of vectors.vectors) {
    assert.equal(isValidPublicKey(hex(v.computerPublic)), true);
    assert.equal(isValidPublicKey(hex(v.watchPublic)), true);
  }
  const v = freshVector();
  const m2 = Buffer.from(unframe(v.m2));
  for (const name of ["zero-prefix", "compressed-prefix", "hybrid-prefix", "off-curve", "x-equals-p", "all-zero"]) {
    const bad = Buffer.concat([hex(vectors.badPublicKeys[name]), m2.subarray(65)]);
    assert.throws(() => handshakeFor(v).acceptM2(bad), (error) => error.category === "auth", name);
  }
});

test("fresh key, nonce and IV per attempt", () => {
  const a = new ClientHandshake({ codeData: "7QF3MXPZR2D4" });
  const b = new ClientHandshake({ codeData: "7QF3MXPZR2D4" });
  assert.notEqual(a.m1().toString("hex"), b.m1().toString("hex"));
  assert.notEqual(a.m1().subarray(5, 70).toString("hex"), b.m1().subarray(5, 70).toString("hex"));
  assert.notEqual(a.m1().subarray(70).toString("hex"), b.m1().subarray(70).toString("hex"));
  assert.throws(() => new ClientHandshake({ codeData: "7QF3MXPZR2D" }), TypeError);
  assert.throws(() => new ClientHandshake({ codeData: "7QF3MXPZR2DU" }), TypeError);
});

test("framing writes u16 big-endian lengths within 1..32768", () => {
  assert.equal(frame(Buffer.alloc(86)).readUInt16BE(0), 86);
  assert.equal(frame(Buffer.alloc(32768)).readUInt16BE(0), 32768);
  assert.throws(() => frame(Buffer.alloc(0)), RangeError);
  assert.throws(() => frame(Buffer.alloc(32769)), RangeError);
});

test("code entry matches every code vector, and only a wrong check symbol is a typo", () => {
  for (const c of vectors.codes) {
    assert.equal(normalizeCode(c.input), c.normalized, JSON.stringify(c.input));
  }
  const [good] = vectors.codes;
  assert.deepEqual(checkCode(good.input), { code: good.normalized });
  assert.deepEqual(checkCode("Q7F3MXPZR2D40"), { error: "typo" }, "adjacent swap");
  assert.deepEqual(checkCode("7QF3MAPZR2D40"), { error: "typo" }, "one wrong symbol");
  for (const input of ["7QF3MXPZR2D4", "7QF3MXPZR2D400", "7QFUMXPZR2D40", "7QFÉMXPZR2D40", "", "7QF3_MXPZ_R2D4_0", "-".repeat(33)]) {
    assert.deepEqual(checkCode(input), { error: "invalid-code" }, JSON.stringify(input));
  }
  assert.deepEqual(checkCode(undefined), { error: "invalid-code" });
  // Up to 32 characters of separators are fine, 33 are not (the watch's limit).
  const spaced = "7QF3 - MXPZ - R2D4 - 0" + " ".repeat(10);
  assert.equal(spaced.length, 32);
  assert.equal(normalizeCode(spaced), good.normalized);
  assert.equal(normalizeCode(spaced + " "), null);
});

test("Luhn mod 32 detects single-symbol errors and adjacent swaps except 0<->Z", () => {
  const data = "7QF3MXPZR2D4";
  const check = codeCheckSymbol(data);
  for (let i = 0; i < data.length; i += 1) {
    for (const c of CODE_ALPHABET) {
      if (c === data[i]) continue;
      assert.notEqual(codeCheckSymbol(data.slice(0, i) + c + data.slice(i + 1)), check);
    }
  }
  let undetected = [];
  for (const a of CODE_ALPHABET) {
    for (const b of CODE_ALPHABET) {
      if (a === b) continue;
      const original = "7QF3MXPZR2" + a + b;
      const swapped = "7QF3MXPZR2" + b + a;
      if (codeCheckSymbol(original) === codeCheckSymbol(swapped)) undetected.push(a + b);
    }
  }
  undetected = undetected.sort();
  assert.deepEqual(undetected, ["0Z", "Z0"], "the only undetected adjacent swap is 0<->Z");
});

const TARGETS = [
  ["192.168.1.139:40123", "192.168.1.139:40123"],
  ["10.0.0.1:1024", "10.0.0.1:1024"],
  ["10.255.255.255:65535", "10.255.255.255:65535"],
  ["172.16.0.1:40000", "172.16.0.1:40000"],
  ["172.31.255.254:40000", "172.31.255.254:40000"],
  ["100.64.0.1:40000", "100.64.0.1:40000"],
  ["100.127.255.255:40000", "100.127.255.255:40000"],
  ["169.254.10.20:40000", "169.254.10.20:40000"],
  ["192.168.0.0:40000", "192.168.0.0:40000"],
  ["172.15.0.1:40000", null],
  ["172.32.0.1:40000", null],
  ["100.63.0.1:40000", null],
  ["100.128.0.1:40000", null],
  ["169.253.1.1:40000", null],
  ["8.8.8.8:40000", null],
  ["0.0.0.0:40000", null],
  ["255.255.255.255:40000", null],
  ["127.0.0.1:40000", null],
  ["192.168.1.139:1023", null],
  ["192.168.1.139:65536", null],
  ["192.168.1.139:0", null],
  ["192.168.1.139:040123", null],
  ["192.168.01.139:40123", null],
  ["192.168.1.0139:40123", null],
  ["192.168.1.256:40123", null],
  ["0300.0250.1.139:40123", null],
  ["0xc0.0xa8.1.139:40123", null],
  ["3232235915:40123", null],
  ["192.168.395:40123", null],
  ["192.168.1:40123", null],
  ["192.168.1.139", null],
  ["192.168.1.139:", null],
  [" 192.168.1.139:40123", null],
  ["192.168.1.139:40123 ", null],
  ["192.168.1.139:40123\n", null],
  ["192.168.1.139:+4012", null],
  ["192.168.1.139:4e4", null],
  ["١٩٢.168.1.139:40123", null],
  ["watch.local:40123", null],
  ["localhost:40123", null],
  ["[fe80::1]:40123", null],
  ["fe80::1:40123", null],
  ["http://192.168.1.139:40123", null],
  ["", null],
];

test("the watch address parser accepts only private dotted-decimal IPv4 literals and ports 1024-65535", () => {
  for (const [input, expected] of TARGETS) {
    assert.equal(parseTarget(input)?.target ?? null, expected, JSON.stringify(input));
  }
  assert.equal(parseTarget(undefined), null);
  assert.deepEqual(parseTarget("192.168.1.139:40123"), { host: "192.168.1.139", port: 40123, target: "192.168.1.139:40123" });
  assert.equal(parseTarget("127.0.0.1:40000", { allowLoopback: true })?.target, "127.0.0.1:40000");
  assert.equal(parseTarget("127.255.0.1:40000", { allowLoopback: true })?.target, "127.255.0.1:40000");
  assert.equal(parseTarget("127.0.0.1:40000", { allowLoopback: "1" }), null, "only a real boolean enables loopback");
});

test("the wrapper's address check agrees with the core parser on every case", () => {
  for (const [input] of TARGETS) {
    for (const allowLoopback of [false, true]) {
      assert.deepEqual(parseWearTarget(input, { allowLoopback }), parseTarget(input, { allowLoopback }), JSON.stringify(input));
    }
  }
});

test("wear-pair.js imports Node built-ins only (it is vendored into the watch repository)", () => {
  const source = readFileSync(new URL("../src/core/wear-pair.js", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^node:/, specifier);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /console\.|process\.std(out|err)/, "the protocol module never logs");
});
