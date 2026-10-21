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
// 417 Expectation Failed with an empty body and these proxy headers. Selecting a bot of that login in the app woke it.
const HIBERNATED_HEADERS = {
  "proxy-status": 'anyrun-proxy; error=destination_unavailable; details="pod_hibernated"',
  "x-anyrun-error-source": "anyrun-proxy",
  "x-anyrun-failure-reason": "pod_hibernated",
};
const asleep = () => new Response("", { status: 417, statusText: "Expectation Failed", headers: HIBERNATED_HEADERS });

test("417 from the gateway is an asleep box, with a wake hint and no token", async (t) => {
  const session = await mockGateway(t, asleep);
  const error = await listAgents(session).then(() => assert.fail("expected listAgents to throw"), (e) => e);
  assert.equal(error.status, 417);
  assert.equal(error.kind, "asleep");
  assert.equal(error.code, "BOX_ASLEEP");
  assert.match(error.message, /^listAgents failed: 417 /);
  assert.match(error.message, /asleep/);
  assert.match(error.message, /Grok Bot app/);
  assert.doesNotMatch(error.message, /CURSOR_ACCESS_TOKEN/);
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

test("response cap: default 16 MiB; GBOT_MAX_RESPONSE_BYTES is a byte count from 64 KiB to 64 MiB, else ignored", () => {
  const MiB = 1024 * 1024;
  assert.equal(GATEWAY_MAX_RESPONSE_BYTES, 16 * MiB);
  assert.equal(gatewayMaxResponseBytes({}), 16 * MiB);
  assert.equal(gatewayMaxResponseBytes({ GBOT_MAX_RESPONSE_BYTES: String(2 * MiB) }), 2 * MiB);
  assert.equal(gatewayMaxResponseBytes({ GBOT_MAX_RESPONSE_BYTES: " 3145728 " }), 3 * MiB);
  assert.equal(gatewayMaxResponseBytes({ GBOT_MAX_RESPONSE_BYTES: "65536" }), 64 * 1024);
  assert.equal(gatewayMaxResponseBytes({ GBOT_MAX_RESPONSE_BYTES: String(64 * MiB) }), 64 * MiB);
  for (const bad of ["", "abc", "0", "1", "65535", String(64 * MiB + 1), "1073741824", "99999999999999999999", "-5", "1.5", "1e9", "0x100", "32M"]) {
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
  assert.match(error.message, /too large \(over 1048576 bytes\); set GBOT_MAX_RESPONSE_BYTES to a byte count up to 67108864/);
});

test("an ignored GBOT_MAX_RESPONSE_BYTES is named in the too-large error", async (t) => {
  const session = await mockGateway(t, () => new Response("x".repeat(GATEWAY_MAX_RESPONSE_BYTES + 8), { status: 200 }));
  const error = await withEnvAsync({ GBOT_MAX_RESPONSE_BYTES: "32M" }, () => listAgents(session))
    .then(() => assert.fail("expected the read to throw"), (e) => e);
  assert.match(error.message, /over 16777216 bytes\); GBOT_MAX_RESPONSE_BYTES was ignored: not a byte count from 65536 to 67108864/);
});

test("a 417 that echoes the token is redacted", async (t) => {
  const session = await mockGateway(t, () => new Response(JSON.stringify({ message: "sleeping " + TOKEN }), {
    status: 417,
    headers: { "content-type": "application/json" },
  }));
  const error = await listAgents(session).then(() => assert.fail("expected listAgents to throw"), (e) => e);
  assert.equal(error.code, "BOX_ASLEEP");
  assert.match(error.message, /<redacted>/);
  assert.doesNotMatch(error.message, /gateway-secret-token/);
});

test("a send while every call answers 417 is rejected before the prompt is sent", async (t) => {
  const seen = [];
  const session = await mockGateway(t, (url) => { seen.push(url); return asleep(); });
  const error = await sendPrompt(session, "General", "hi", { clientNonce: "nonce-all-asleep" })
    .then(() => assert.fail("expected sendPrompt to throw"), (e) => e);
  assert.deepEqual(seen, ["/api/listAgents"]);
  assert.equal(error.code, "BOX_ASLEEP");
  assert.equal(error.delivery, "rejected");
  assert.equal(error.clientNonce, "nonce-all-asleep");
});

test("a 417 with another failureCode stays a client failure; a sleep failureCode is asleep", async (t) => {
  const reply = (code) => new Response(JSON.stringify({ message: "no", failureCode: code }), {
    status: 417,
    headers: { "content-type": "application/json" },
  });
  const other = await listAgents(await mockGateway(t, () => reply("x/other"))).then(() => assert.fail("expected throw"), (e) => e);
  assert.equal(other.kind, "client");
  assert.equal(other.code, undefined);
  assert.doesNotMatch(other.message, /asleep/);
  const sleeping = await listAgents(await mockGateway(t, () => reply("gateway/box-asleep"))).then(() => assert.fail("expected throw"), (e) => e);
  assert.equal(sleeping.kind, "asleep");
  assert.equal(sleeping.code, "BOX_ASLEEP");
});

test("a 417 the proxy marks pod_hibernated is asleep even with another failureCode", async (t) => {
  const session = await mockGateway(t, () => new Response(JSON.stringify({ message: "no", failureCode: "x/other" }), {
    status: 417,
    headers: { "content-type": "application/json", "x-anyrun-failure-reason": "pod_hibernated" },
  }));
  const error = await listAgents(session).then(() => assert.fail("expected throw"), (e) => e);
  assert.equal(error.kind, "asleep");
  assert.equal(error.code, "BOX_ASLEEP");
  assert.equal(error.failureCode, "x/other");
});
