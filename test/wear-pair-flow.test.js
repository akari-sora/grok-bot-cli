import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PAIR_MESSAGES, pairWithWatch, preflightSession } from "../src/core/wear-pair.js";
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

test("abort after M3 was sent resolves unknown, never aborted", async (t) => {
  const controller = new AbortController();
  let sending = 0;
  const { code, fake } = await watch(t, {
    behavior: {
      // The watch has the session; hold the receipt back and abort in that window.
      beforeM4: async () => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      },
    },
  });
  const started = performance.now();
  const result = await pairWithWatch({
    host: fake.host,
    port: fake.port,
    code: code.normalized,
    payload,
    signal: controller.signal,
    onSending: () => { sending += 1; },
  });
  assert.deepEqual(result, { outcome: "unknown" });
  assert.equal(sending, 1, "onSending runs once, just before M3");
  assert.ok(performance.now() - started < 900, "the abort ends the wait at once");
  assert.equal((await fake.result).outcome, "paired", "the watch did store it");
});

test("an error after M3 was sent resolves unknown; onSending errors never stop the send", async (t) => {
  const { code, fake } = await watch(t, { behavior: { omitM4: true } });
  const result = await pairWithWatch({
    host: fake.host,
    port: fake.port,
    code: code.normalized,
    payload,
    onSending: () => { throw new Error("fake hook failure"); },
  });
  assert.deepEqual(result, { outcome: "unknown" });
  assert.equal((await fake.result).payload, payload.toString("utf8"));
});

test("abort before M3 stays aborted and onSending never runs", async (t) => {
  const controller = new AbortController();
  let sending = 0;
  const { code, fake } = await watch(t, {
    behavior: {
      beforeM2: async () => {
        controller.abort();
      },
    },
  });
  await assert.rejects(
    pairWithWatch({ host: fake.host, port: fake.port, code: code.normalized, payload, signal: controller.signal, onSending: () => { sending += 1; } }),
    fails("aborted"),
  );
  assert.equal(sending, 0);
  assert.equal((await fake.result).bytesAfterM2, 0);
});

/** A socket that never connects, to stand in for a SYN that is never answered. */
function hangingSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  return socket;
}

test("abort during a connect that never completes destroys the socket at once", async () => {
  const sockets = [];
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const started = performance.now();
  await assert.rejects(
    pairWithWatch({
      host: "192.168.1.20",
      port: 40000,
      code: randomCode().normalized,
      payload,
      signal: controller.signal,
      timeouts: { connectMs: 60_000 },
      createConnection: (options) => {
        assert.deepEqual({ host: options.host, port: options.port, family: options.family }, { host: "192.168.1.20", port: 40000, family: 4 });
        const socket = hangingSocket();
        sockets.push(socket);
        return socket;
      },
    }),
    fails("aborted"),
  );
  assert.ok(performance.now() - started < 1_000, "returns promptly");
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].destroyed, true, "the connecting socket was destroyed");
});

test("a connect that never completes is unreachable at the connect deadline", async () => {
  const socket = hangingSocket();
  const started = performance.now();
  await assert.rejects(
    pairWithWatch({ host: "192.168.1.20", port: 40000, code: randomCode().normalized, payload, timeouts: { connectMs: 200 }, createConnection: () => socket }),
    fails("unreachable"),
  );
  assert.ok(performance.now() - started < 2_000);
  assert.equal(socket.destroyed, true);
});

test("the no-answer message names a different subnet as a cause", () => {
  assert.match(PAIR_MESSAGES["no-answer"], /different subnet/);
  assert.match(PAIR_MESSAGES["no-answer"], /closes connections from other subnets/);
});
