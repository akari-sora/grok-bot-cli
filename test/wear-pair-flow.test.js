import assert from "node:assert/strict";
import test from "node:test";

import { pairWithWatch, preflightSession } from "../src/core/wear-pair.js";
import { closedPort, startFakeWatch } from "./helpers/fake-watch.js";
import { randomCode, typoOf } from "./helpers/wear-pair-fixture.js";

const session = preflightSession({
  gatewayUrl: "https://fake-flow.us12.cursorvm.com",
  gatewayToken: "fake-flow-token",
  headers: { "x-anyrun-network-token": "fake-flow-route" },
  label: "fake-flow@example.com",
});
assert.equal(session.ok, true);
const payload = session.payload;

async function watch(t, options = {}) {
  const code = randomCode();
  const fake = await startFakeWatch({ codeData: code.data, ...options });
  t.after(() => fake.close());
  return { code, fake };
}

const fails = (category) => (error) => {
  assert.equal(error.name, "WearPairError");
  assert.equal(error.category, category);
  assert.deepEqual(Object.keys(error).sort(), ["category", "name"], "no data rides on the error");
  return true;
};

test("success: the watch stores exactly the payload and the receipt verifies", async (t) => {
  const { code, fake } = await watch(t);
  const result = await pairWithWatch({ host: fake.host, port: fake.port, code: code.display, payload });
  assert.deepEqual(result, { outcome: "paired" });
  const seen = await fake.result;
  assert.equal(seen.outcome, "paired");
  assert.equal(seen.payload, payload.toString("utf8"));
  assert.equal(fake.connections(), 1);
});

test("lower-case input with spaces and I/L/O aliases still pairs", async (t) => {
  const { code, fake } = await watch(t);
  const typed = code.display.toLowerCase().replaceAll("-", " ").replaceAll("1", "l").replaceAll("0", "o");
  assert.deepEqual(await pairWithWatch({ host: fake.host, port: fake.port, code: typed, payload }), { outcome: "paired" });
});

test("a typo is reported before any connection", async (t) => {
  const { code, fake } = await watch(t);
  await assert.rejects(pairWithWatch({ host: fake.host, port: fake.port, code: typoOf(code), payload }), fails("typo"));
  await assert.rejects(pairWithWatch({ host: fake.host, port: fake.port, code: "fake", payload }), fails("invalid-code"));
  assert.equal(fake.connections(), 0);
});

test("wrong code: tagW fails and the client stops before M3", async (t) => {
  const { fake } = await watch(t);
  const other = randomCode();
  await assert.rejects(pairWithWatch({ host: fake.host, port: fake.port, code: other.normalized, payload }), fails("auth"));
  const seen = await fake.result;
  assert.equal(seen.outcome, "network-error");
  assert.equal(seen.bytesAfterM2, 0, "nothing was sent after M2");
  assert.equal(seen.payload, undefined);
});

for (const tamper of ["tag", "nonce", "key"]) {
  test(`tampered M2 (${tamper}): authentication fails and nothing is sent`, async (t) => {
    const { code, fake } = await watch(t, { behavior: { tamperM2: tamper } });
    await assert.rejects(pairWithWatch({ host: fake.host, port: fake.port, code: code.normalized, payload }), fails("auth"));
    assert.equal((await fake.result).bytesAfterM2, 0);
  });
}

for (const tamper of ["length", "trailing"]) {
  test(`malformed M2 (${tamper}): the watch did not answer, nothing is sent`, async (t) => {
    const { code, fake } = await watch(t, { behavior: { tamperM2: tamper } });
    await assert.rejects(pairWithWatch({ host: fake.host, port: fake.port, code: code.normalized, payload }), fails("no-answer"));
    assert.equal((await fake.result).bytesAfterM2, 0);
  });
}

test("silent watch: the M2 deadline ends the attempt", async (t) => {
  const { code, fake } = await watch(t, { behavior: { silent: true } });
  const started = performance.now();
  await assert.rejects(
    pairWithWatch({ host: fake.host, port: fake.port, code: code.normalized, payload, timeouts: { m2Ms: 300 } }),
    fails("no-answer"),
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 250 && elapsed < 3_000, `elapsed ${elapsed}`);
});

test("a trickled M2 does not extend the absolute M2 deadline", async (t) => {
  const { code, fake } = await watch(t, { behavior: { trickleMs: 40 } });
  const started = performance.now();
  await assert.rejects(
    pairWithWatch({ host: fake.host, port: fake.port, code: code.normalized, payload, timeouts: { m2Ms: 400 } }),
    fails("no-answer"),
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2_000, `elapsed ${elapsed} (115 bytes at 40 ms would take 4.6 s)`);
});

test("missing M4: the outcome is unknown", async (t) => {
  const { code, fake } = await watch(t, { behavior: { omitM4: true } });
  const result = await pairWithWatch({ host: fake.host, port: fake.port, code: code.normalized, payload, timeouts: { m4Ms: 2_000 } });
  assert.deepEqual(result, { outcome: "unknown" });
  assert.equal((await fake.result).outcome, "paired", "the watch did store it; only the receipt is missing");
});

test("M4 deadline: a watch that never answers after M3 is unknown", async (t) => {
  const code = randomCode();
  // Hold M4 back: the fake watch answers only after the client gave up.
  const fake = await startFakeWatch({ codeData: code.data, behavior: { omitM4: true } });
  t.after(() => fake.close());
  const started = performance.now();
  const result = await pairWithWatch({ host: fake.host, port: fake.port, code: code.normalized, payload, timeouts: { m4Ms: 300 } });
  assert.deepEqual(result, { outcome: "unknown" });
  assert.ok(performance.now() - started < 3_000);
});

for (const [status, outcome] of [[1, "rejected"], [2, "storage-failed"], [0, "paired"]]) {
  test(`authenticated status ${status} -> ${outcome}`, async (t) => {
    const { code, fake } = await watch(t, { behavior: { status } });
    assert.deepEqual(await pairWithWatch({ host: fake.host, port: fake.port, code: code.normalized, payload }), { outcome });
  });
}

test("the watch rejects a session it would not import (status 1)", async (t) => {
  const { code, fake } = await watch(t);
  const bad = Buffer.from(JSON.stringify({ gatewayUrl: "https://evil.example", gatewayToken: "fake", headers: {}, label: "" }));
  assert.deepEqual(await pairWithWatch({ host: fake.host, port: fake.port, code: code.normalized, payload: bad }), { outcome: "rejected" });
});

test("a closed port is unreachable", async () => {
  const port = await closedPort();
  await assert.rejects(pairWithWatch({ host: "127.0.0.1", port, code: randomCode().normalized, payload }), fails("unreachable"));
});

test("the code is spent after one handshake (later connections are refused)", async (t) => {
  const { code, fake } = await watch(t);
  assert.deepEqual(await pairWithWatch({ host: fake.host, port: fake.port, code: code.normalized, payload }), { outcome: "paired" });
  await assert.rejects(pairWithWatch({ host: fake.host, port: fake.port, code: code.normalized, payload }), fails("unreachable"));
});

test("bad arguments are refused without I/O", async () => {
  const code = randomCode().normalized;
  await assert.rejects(pairWithWatch({ host: "watch.local", port: 40000, code, payload }), fails("usage"));
  await assert.rejects(pairWithWatch({ host: "127.0.0.1", port: 70000, code, payload }), fails("usage"));
  await assert.rejects(pairWithWatch({ host: "127.0.0.1", port: 40000, code, payload: Buffer.alloc(0) }), fails("payload"));
  await assert.rejects(pairWithWatch({ host: "127.0.0.1", port: 40000, code, payload: Buffer.alloc(16 * 1024 + 1, 0x61) }), fails("payload"));
  await assert.rejects(pairWithWatch({ host: "127.0.0.1", port: 40000, code, payload: "fake" }), fails("payload"));
});

test("an abort signal stops the attempt", async (t) => {
  const { code, fake } = await watch(t, { behavior: { silent: true } });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pairWithWatch({ host: fake.host, port: fake.port, code: code.normalized, payload, signal: controller.signal }), fails("aborted"));
});
