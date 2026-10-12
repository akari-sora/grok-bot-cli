import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

import { reconcileDelivery, sendPrompt, sendReceiptFrom } from "../src/core/gateway.js";

const roster = { agents: [{ id: "bot-1", name: "General", isGroup: false }] };
const TOKEN = "gateway-secret-token";

async function mockGateway(t, handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    seen.push({ url: req.url, body });
    const response = await handler(req.url, body);
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
  const port = server.address().port;
  return { session: { gatewayUrl: "http://127.0.0.1:" + port, gatewayToken: TOKEN }, seen };
}

async function sendError(t, response, nonce = "nonce-err") {
  const { session } = await mockGateway(t, (url) => (url === "/api/listAgents" ? roster : response));
  try {
    await sendPrompt(session, "General", "hi", { clientNonce: nonce });
  } catch (error) {
    return error;
  }
  assert.fail("expected sendPrompt to throw");
}

test("sendReceiptFrom accepts the live {accepted:true} receipt or a legacy messageId only", () => {
  // Live Grok Bot cloud gateway (2026-10-10) answers {"accepted":true} with no messageId.
  assert.deepEqual(sendReceiptFrom({ accepted: true }), { accepted: true });
  assert.deepEqual(sendReceiptFrom({ messageId: "m-1" }), { accepted: true, messageId: "m-1" });
  assert.deepEqual(sendReceiptFrom({ accepted: "true" }), { accepted: false });
  assert.deepEqual(sendReceiptFrom({ accepted: false }), { accepted: false });
  assert.deepEqual(sendReceiptFrom({ messageId: "" }), { accepted: false });
  assert.deepEqual(sendReceiptFrom({ messageId: true }), { accepted: false });
  assert.deepEqual(sendReceiptFrom({ ok: true }), { accepted: false });
  assert.deepEqual(sendReceiptFrom("true"), { accepted: false });
  assert.deepEqual(sendReceiptFrom(null), { accepted: false });
});

test("sendPrompt treats the live {accepted:true} answer as accepted", async (t) => {
  const { session } = await mockGateway(t, (url) => (url === "/api/listAgents" ? roster : { accepted: true }));
  const out = await sendPrompt(session, "General", "hi", { clientNonce: "nonce-live" });
  assert.equal(out.delivery, "accepted");
  assert.equal(out.messageId, undefined);
  assert.equal(out.clientNonce, "nonce-live");
});

test("sendPrompt returns the client nonce it sent", async (t) => {
  const { session, seen } = await mockGateway(t, (url) => (url === "/api/listAgents" ? roster : { messageId: "m-1" }));
  const out = await sendPrompt(session, "General", "hi", { clientNonce: "nonce-1" });
  assert.equal(out.clientNonce, "nonce-1");
  assert.equal(out.delivery, "accepted");
  assert.equal(out.messageId, "m-1");
  assert.equal(JSON.parse(JSON.stringify(out)).clientNonce, "nonce-1");
  const sent = seen.find((call) => call.url === "/api/sendPrompt");
  assert.equal(sent.body.clientNonce, "nonce-1");
  assert.equal(sent.body.agentId, "bot-1");
});

test("sendPrompt without a message id stays unknown and still returns the nonce", async (t) => {
  const { session } = await mockGateway(t, (url) => (url === "/api/listAgents" ? roster : { ok: true }));
  const out = await sendPrompt(session, "General", "hi", { clientNonce: "nonce-unknown" });
  assert.equal(out.delivery, "unknown");
  assert.equal(out.messageId, undefined);
  assert.equal(out.clientNonce, "nonce-unknown");
});

test("401 and 403 are auth failures and do not echo the token", async (t) => {
  const denied = await sendError(t, new Response(JSON.stringify({
    message: "denied " + TOKEN,
    failureCode: "auth/denied",
  }), { status: 401, headers: { "content-type": "application/json" } }));
  assert.equal(denied.kind, "auth");
  assert.equal(denied.failureCode, "auth/denied");
  assert.equal(denied.delivery, "rejected");
  assert.equal(denied.clientNonce, "nonce-err");
  assert.doesNotMatch(denied.message, /gateway-secret-token/);

  const forbidden = await sendError(t, new Response(JSON.stringify({ message: "no" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  }));
  assert.equal(forbidden.kind, "auth");
  assert.equal(forbidden.delivery, "rejected");
  assert.equal(forbidden.clientNonce, "nonce-err");
});

test("404 text/plain that could not be routed is a routing failure", async (t) => {
  const error = await sendError(t, new Response("upstream could not be routed", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  }));
  assert.equal(error.kind, "routing");
  assert.equal(error.delivery, "rejected");
  assert.equal(error.failureCode, undefined);
  assert.match(error.message, /could not be routed/);
  assert.doesNotMatch(error.message, /gateway-secret-token/);
});

test("404 JSON unknown method is unsupported, not routing", async (t) => {
  const error = await sendError(t, new Response(JSON.stringify({
    failureCode: "gateway/unknown-method",
    error: "The request could not be routed",
  }), { status: 404, headers: { "content-type": "application/json" } }));
  assert.equal(error.kind, "unsupported");
  assert.equal(error.failureCode, "gateway/unknown-method");
  assert.equal(error.delivery, "rejected");
});

test("HTTP 5xx is a server failure with unknown delivery", async (t) => {
  const error = await sendError(t, new Response(JSON.stringify({
    message: "down " + TOKEN,
    failureCode: "gateway/unavailable",
  }), { status: 503, headers: { "content-type": "application/json" } }));
  assert.equal(error.kind, "server");
  assert.equal(error.failureCode, "gateway/unavailable");
  assert.equal(error.delivery, "unknown");
  assert.equal(error.effect, "unknown");
  assert.equal(error.clientNonce, "nonce-err");
  assert.doesNotMatch(error.message, /gateway-secret-token/);
  assert.match(error.message, /<redacted>/);
});

test("other 4xx is a client failure and surfaces failureCode", async (t) => {
  const error = await sendError(t, new Response(JSON.stringify({
    message: "busy " + TOKEN,
    failureCode: "send/agent-unavailable",
  }), { status: 409, headers: { "content-type": "application/json" } }));
  assert.equal(error.kind, "client");
  assert.equal(error.failureCode, "send/agent-unavailable");
  assert.equal(error.delivery, "rejected");
  assert.doesNotMatch(error.message, /gateway-secret-token/);
});

test("reconcileDelivery finds the user entry with that nonce and does not resend", async (t) => {
  const { session, seen } = await mockGateway(t, (url) => {
    if (url === "/api/listAgents") return roster;
    if (url === "/api/getAgentTranscriptTail") {
      return {
        entries: [
          { id: "assistant-copy", role: "assistant", clientNonce: "nonce-hit", seq: 1 },
          { id: "other", role: "user", clientNonce: "nonce-hit-extra", seq: 2 },
          { id: "hit", role: "user", clientNonce: "nonce-hit", seq: 3 },
        ],
      };
    }
    return { messageId: "should-not-send" };
  });
  const found = await reconcileDelivery(session, "General", "nonce-hit");
  assert.equal(found.status, "delivered");
  assert.equal(found.entryId, "hit");
  assert.equal(found.seq, 3);
  assert.equal(found.clientNonce, "nonce-hit");
  assert.equal(found.target.id, "bot-1");
  assert.equal(seen.some((call) => call.url === "/api/sendPrompt"), false);
  const tails = seen.filter((call) => call.url === "/api/getAgentTranscriptTail");
  assert.equal(tails.length, 1);
  assert.equal(tails[0].body.limit, 200);
  assert.equal(tails[0].body.id, "bot-1");
});

test("reconcileDelivery misses assistant copies and prefix nonces without resending", async (t) => {
  const { session, seen } = await mockGateway(t, (url) => {
    if (url === "/api/listAgents") return roster;
    return {
      entries: [
        { id: "assistant-copy", role: "assistant", clientNonce: "missing", seq: 1 },
        { id: "prefix", role: "user", clientNonce: "missing-extra", seq: 2 },
      ],
    };
  });
  const found = await reconcileDelivery(session, "General", "missing");
  assert.equal(found.status, "not-found-in-tail");
  assert.equal(found.scanned, 2);
  assert.equal(found.clientNonce, "missing");
  assert.equal(found.target.name, "General");
  assert.equal(seen.some((call) => call.url === "/api/sendPrompt"), false);
});

test("reconcileDelivery requires a client nonce and does not call the gateway", async (t) => {
  const { session, seen } = await mockGateway(t, () => roster);
  await assert.rejects(reconcileDelivery(session, "General", ""), /clientNonce is required/);
  assert.equal(seen.length, 0);
});
