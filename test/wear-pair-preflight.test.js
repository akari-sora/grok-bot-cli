import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SIZES, preflightSession, truncateLabel } from "../src/core/wear-pair.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/session-import-vectors.json", import.meta.url), "utf8")).cases;

/** The route's path for a decrypted descriptor, entered here from the watch's raw JSON (not JSON -> rejected). */
function preflightJson(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "json" };
  }
  return preflightSession(parsed);
}

test("pre-flight agrees with the watch's SessionVault.import on every shared case", () => {
  assert.equal(cases.length, 36, "the shared file has 36 cases (13 accept, 23 reject)");
  assert.equal(cases.filter((c) => c.accept).length, 13);
  for (const c of cases) {
    const result = preflightJson(c.json);
    assert.equal(result.ok, c.accept, `${c.name}: expected ${c.accept ? "accept" : "reject"}, got ${JSON.stringify(result.ok ? "accept" : result.reason)}`);
  }
});

test("pre-flight sends normalized values, as the watch would store them", () => {
  const byName = Object.fromEntries(cases.map((c) => [c.name, preflightJson(c.json)]));
  assert.equal(byName["trailing slash"].session.gatewayUrl, "https://fake-1.us12.cursorvm.com");
  assert.equal(byName["url with surrounding spaces"].session.gatewayUrl, "https://fake-1.us12.cursorvm.com");
  assert.equal(byName["token with surrounding spaces is trimmed"].session.gatewayToken, "fake-gw-token");
  assert.deepEqual(byName["upper-case header name is lower-cased"].session.headers, { "x-anyrun-network-token": "fake-route" });
  assert.equal(byName["long label is truncated, not rejected"].session.label.length, 64);
  assert.deepEqual(byName["no headers"].session.headers, {});
  const ok = byName["cursorvm gateway"];
  assert.equal(
    ok.payload.toString("utf8"),
    '{"gatewayUrl":"https://fake-1.us12.cursorvm.com","gatewayToken":"fake-gw-token","headers":{"x-anyrun-network-token":"fake-route"},"label":"fake@example.com"}',
  );
});

const base = () => ({
  gatewayUrl: "https://fake-1.us12.cursorvm.com",
  gatewayToken: "fake-gw-token",
  headers: { "x-anyrun-network-token": "fake-route" },
  label: "fake@example.com",
});

test("pre-flight URL rules follow the watch's java.net.URI policy", () => {
  const accept = [
    "https://FAKE-1.US12.CURSORVM.COM",
    "HTTPS://fake.cursor.sh",
    "https://fake.cursor.com:443",
    "https://fake.cursor.com:/",
    "https://fake.cursor.com///",
    "https://fake.cursor.com/path/x?y=1#frag",
    "https://1.fake.cursorvm.com",
    "\u001f https://fake.cursor.sh  ",
  ];
  const reject = [
    "https://cursorvm.com",
    "https://fake.cursorvm.com.",
    "https://fake_1.cursorvm.com",
    "https://-fake.cursorvm.com",
    "https://fake-.cursorvm.com",
    "https://fake..cursorvm.com",
    "https://%66ake.cursorvm.com",
    "https://fake.cursorvm.com:0",
    "https://fake.cursorvm.com:65536",
    "https://fake.cursorvm.com:443:1",
    "https://fake.cursorvm.com:x",
    "https://@fake.cursorvm.com",
    "https://fake.cursorvm.com\\@evil.example",
    "https://fake.cursorvm.com/a b",
    // Deliberately stricter than java.net.URI, which allows non-ASCII path characters: never sent.
    "https://fake.cursorvm.com/é",
    "https://fake.cursorvm.com/%zz",
    "https://fake.cursorvm.com#a#b",
    "https://[::1]",
    "https://127.0.0.1",
    "https://localhost",
    "https:fake.cursorvm.com",
    "//fake.cursorvm.com",
    "ftp://fake.cursorvm.com",
    "wss://fake.cursorvm.com",
    "﻿https://fake.cursorvm.com",
    "",
  ];
  for (const url of accept) assert.equal(preflightSession({ ...base(), gatewayUrl: url }).ok, true, JSON.stringify(url));
  for (const url of reject) {
    const result = preflightSession({ ...base(), gatewayUrl: url });
    assert.deepEqual(result, { ok: false, reason: "url" }, JSON.stringify(url));
  }
  assert.equal(preflightSession({ ...base(), gatewayUrl: "https://fake.cursor.com:/" }).session.gatewayUrl, "https://fake.cursor.com:");
});

test("pre-flight ignores the CLI's own escape hatches and test mode", () => {
  const saved = { ...process.env };
  try {
    process.env.GROK_BOT_ALLOW_ANY_GATEWAY = "1";
    process.env.GROK_BOT_ALLOW_LOCAL_GATEWAY = "1";
    process.env.GROK_BOT_TEST = "1";
    for (const url of ["https://evil.example", "http://127.0.0.1:8080", "https://localhost"]) {
      assert.equal(preflightSession({ ...base(), gatewayUrl: url }).ok, false, url);
    }
  } finally {
    for (const key of ["GROK_BOT_ALLOW_ANY_GATEWAY", "GROK_BOT_ALLOW_LOCAL_GATEWAY", "GROK_BOT_TEST"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("pre-flight token, header and shape rules", () => {
  const reject = (patch, reason) => assert.deepEqual(preflightSession({ ...base(), ...patch }), { ok: false, reason }, JSON.stringify(patch));
  reject({ gatewayToken: "﻿fake" }, "token");
  reject({ gatewayToken: "fake\u007f" }, "token");
  reject({ gatewayToken: "   " }, "token");
  assert.equal(preflightSession({ ...base(), gatewayToken: "\u001cfake　" }).session.gatewayToken, "fake");
  reject({ headers: { "x-a": "v\u007f" } }, "headers");
  reject({ headers: { "x-a": "v\t" } }, "headers");
  reject({ headers: { "x-a": "v".repeat(4097) } }, "headers");
  reject({ headers: { ["x-" + "a".repeat(65)]: "v" } }, "headers");
  reject({ headers: { "proxy-authorization": "v" } }, "headers");
  reject({ headers: { "content-type": "v" } }, "headers");
  reject({ headers: { "x-é": "v" } }, "headers");
  assert.deepEqual(preflightSession({ ...base(), headers: { " X-Route ": "v" } }).session.headers, { "x-route": "v" });
  assert.deepEqual(preflightSession({ ...base(), headers: { "x-a": "1", "X-A": "2" } }).session.headers, { "x-a": "2" });
  reject({ headers: { "x-a": 1 } }, "shape");
  reject({ headers: null }, "shape");
  reject({ headers: ["x-a"] }, "shape");
  reject({ gatewayToken: 123 }, "shape");
  reject({ gatewayUrl: undefined }, "shape");
  reject({ label: null }, "shape");
  assert.equal(preflightSession(null).ok, false);
  assert.equal(preflightSession("fake").ok, false);
  const noLabel = base();
  delete noLabel.label;
  delete noLabel.headers;
  assert.deepEqual(preflightSession(noLabel).session, { gatewayUrl: noLabel.gatewayUrl, gatewayToken: noLabel.gatewayToken, headers: {}, label: "" });
});

test("pre-flight refuses a session whose payload would not fit in one M3", () => {
  const headers = {};
  for (let i = 0; i < 8; i += 1) headers[`x-h${i}`] = "v".repeat(4096);
  assert.deepEqual(preflightSession({ ...base(), headers }), { ok: false, reason: "size" });
  const fits = preflightSession({ ...base(), headers: { "x-h0": "v".repeat(4096), "x-h1": "v".repeat(4096), "x-h2": "v".repeat(4096) } });
  assert.equal(fits.ok, true);
  assert.ok(fits.payload.length <= SIZES.maxPayload);
});

test("labels are cut to 64 UTF-16 units at a code point boundary", () => {
  assert.equal(truncateLabel("a".repeat(70)), "a".repeat(64));
  const emoji = "a".repeat(63) + "😀b";
  assert.equal(truncateLabel(emoji), "a".repeat(63));
  assert.equal(truncateLabel("a".repeat(62) + "😀b"), "a".repeat(62) + "😀");
  assert.equal(truncateLabel("短".repeat(70)).length, 64);
  assert.equal(preflightSession({ ...base(), label: emoji }).session.label, "a".repeat(63));
});
