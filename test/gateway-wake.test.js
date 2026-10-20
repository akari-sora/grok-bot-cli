import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

import { GATEWAY_MAX_RESPONSE_BYTES, gatewayMaxResponseBytes, listAgents, sendPrompt } from "../src/core/gateway.js";

const roster = { agents: [{ id: "bot-1", name: "General", isGroup: false }] };
const TOKEN = "gateway-secret-token";

async function mockGateway(t, handler) {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    const response = await handler(req.url);
    if (response instanceof Response) {
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { gatewayUrl: "http://127.0.0.1:" + server.address().port, gatewayToken: TOKEN };
}

async function withEnvAsync(values, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(values)) {
    prev[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(values)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

// Live (2026-10-20): while the Grok Bot box of a login is asleep, every gateway call answers
// 417 Expectation Failed. Opening the app and selecting a bot (or switching to that login) woke it.
const asleep = () => new Response("", { status: 417, statusText: "Expectation Failed" });

test("417 from the gateway is an asleep box, with a wake hint and no token", async (t) => {
  const session = await mockGateway(t, asleep);
  const error = await listAgents(session).then(() => assert.fail("expected listAgents to throw"), (e) => e);
  assert.equal(error.status, 417);
  assert.equal(error.kind, "asleep");
  assert.equal(error.code, "BOX_ASLEEP");
  assert.match(error.message, /^listAgents failed: 417 /);
  assert.match(error.message, /asleep/);
  assert.match(error.message, /Grok Bot app/);
  assert.doesNotMatch(error.message, /gateway-secret-token/);
});

test("a send to an asleep box is rejected, not delivery unknown", async (t) => {
  const session = await mockGateway(t, (url) => (url === "/api/listAgents" ? roster : asleep()));
  const error = await sendPrompt(session, "General", "hi", { clientNonce: "nonce-asleep" })
    .then(() => assert.fail("expected sendPrompt to throw"), (e) => e);
  assert.equal(error.kind, "asleep");
  assert.equal(error.code, "BOX_ASLEEP");
  assert.equal(error.delivery, "rejected");
  assert.equal(error.clientNonce, "nonce-asleep");
  assert.doesNotMatch(error.message, /delivery unknown/);
});

test("other 4xx stay client failures without the asleep code", async (t) => {
  const session = await mockGateway(t, () => new Response(JSON.stringify({ message: "busy" }), {
    status: 409,
    headers: { "content-type": "application/json" },
  }));
  const error = await listAgents(session).then(() => assert.fail("expected listAgents to throw"), (e) => e);
  assert.equal(error.kind, "client");
  assert.equal(error.code, undefined);
  assert.doesNotMatch(error.message, /asleep/);
});

test("response cap: default is 16 MiB; GBOT_MAX_RESPONSE_BYTES overrides within 64 KiB..256 MiB", () => {
  const MiB = 1024 * 1024;
  assert.equal(GATEWAY_MAX_RESPONSE_BYTES, 16 * MiB);
  assert.equal(gatewayMaxResponseBytes({}), 16 * MiB);
  assert.equal(gatewayMaxResponseBytes({ GBOT_MAX_RESPONSE_BYTES: String(2 * MiB) }), 2 * MiB);
  assert.equal(gatewayMaxResponseBytes({ GBOT_MAX_RESPONSE_BYTES: " 3145728 " }), 3 * MiB);
  assert.equal(gatewayMaxResponseBytes({ GBOT_MAX_RESPONSE_BYTES: "1" }), 64 * 1024);
  assert.equal(gatewayMaxResponseBytes({ GBOT_MAX_RESPONSE_BYTES: String(1024 * MiB) }), 256 * MiB);
  for (const bad of ["", "abc", "0", "-5", "1.5", "1e9", "0x100"]) {
    assert.equal(gatewayMaxResponseBytes({ GBOT_MAX_RESPONSE_BYTES: bad }), 16 * MiB, bad);
  }
});

test("a 3 MiB roster reads by default and is refused under a 1 MiB cap with the variable named", async (t) => {
  const big = { agents: [{ id: "bot-1", name: "General", isGroup: false, description: "x".repeat(3 * 1024 * 1024) }] };
  const session = await mockGateway(t, () => big);
  const rows = await withEnvAsync({ GBOT_MAX_RESPONSE_BYTES: null }, () => listAgents(session));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description.length, 3 * 1024 * 1024);
  const error = await withEnvAsync({ GBOT_MAX_RESPONSE_BYTES: String(1024 * 1024) }, () => listAgents(session))
    .then(() => assert.fail("expected the capped read to throw"), (e) => e);
  assert.match(error.message, /too large \(over 1048576 bytes\)/);
  assert.match(error.message, /GBOT_MAX_RESPONSE_BYTES/);
});
