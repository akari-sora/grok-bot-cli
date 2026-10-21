import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { grokBotGatewayDescriptorPath } from "../src/core/app-session.js";
import { listAgents, sendPrompt } from "../src/core/gateway.js";

const SUB = "user_synthetic_auto_wake";
const SCOPE = crypto.createHash("sha256").update(SUB).digest("hex");
const TOKEN_MARK = "synthetic-wake-access-do-not-leak";
const OLD_GATEWAY = "old-gateway-token";
const NEW_GATEWAY = "new-gateway-token";
const NETWORK = "synthetic-network-token";

function jwt(expSeconds) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({
    sub: SUB,
    exp: expSeconds,
    iss: "https://authentication.cursor.sh",
    mark: TOKEN_MARK,
  })}.sig`;
}

function withEnv(values, fn) {
  const prev = {};
  for (const key of Object.keys(values)) {
    prev[key] = process.env[key];
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  }
  const restore = () => {
    for (const key of Object.keys(values)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  };
  const result = fn();
  if (result && typeof result.then === "function") return result.finally(restore);
  restore();
  return result;
}

function writeLogin(token) {
  const home = mkdtempSync(join(tmpdir(), "gbot-auto-wake-"));
  const secretsPath = join(dirname(grokBotGatewayDescriptorPath(home, process.platform, {})), "sand-secrets.json");
  mkdirSync(dirname(secretsPath), { recursive: true });
  writeFileSync(secretsPath, JSON.stringify({
    version: 1,
    "cursor-accounts": JSON.stringify({
      active: SCOPE,
      accounts: {
        [SCOPE]: {
          "cursor-access-token": `plaintext:v1:${token}`,
          "cursor-refresh-token": "refresh-secret-do-not-touch",
        },
      },
    }),
  }));
  return home;
}

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

function origin(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const asleep = (res) => {
  res.statusCode = 417;
  res.setHeader("x-anyrun-failure-reason", "pod_hibernated");
  res.end();
};

const runningBody = (gatewayUrl) => ({
  runState: "SAND_BOX_RUN_STATE_RUNNING",
  gatewayUrl,
  gatewayToken: NEW_GATEWAY,
  networkToken: NETWORK,
});

function envFor(home, backend) {
  return {
    HOME: home,
    USERPROFILE: home,
    CURSOR_API_BASE_URL: origin(backend),
    CURSOR_ACCESS_TOKEN: null,
    GROK_BOT_GATEWAY_URL: null,
    GROK_BOT_GATEWAY_TOKEN: null,
    GROK_BOT_GATEWAY_HEADERS: null,
    GBOT_AUTO_WAKE: null,
    GBOT_DEBUG: null,
    GBOT_ACCOUNT: null,
    SAND_CLIENT_VERSION: "9.9.9",
    GBOT_WAKE_POLL_MS: null,
    GBOT_WAKE_TIMEOUT_MS: null,
    GROK_BOT_TEST: "1",
  };
}

function session(gatewayUrl) {
  return { gatewayUrl, gatewayToken: OLD_GATEWAY, accountScope: SCOPE };
}

test("listAgents 417 wakes a hibernated box and retries on the new gateway", async (t) => {
  const calls = [];
  const asleepServer = await listen(async (req, res) => {
    calls.push({ host: "asleep", url: req.url, authorization: req.headers.authorization });
    await readBody(req);
    asleep(res);
  });
  const awakeServer = await listen(async (req, res) => {
    calls.push({
      host: "awake",
      url: req.url,
      authorization: req.headers.authorization,
      network: req.headers["x-anyrun-network-token"],
    });
    await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General", isGroup: false }] }));
  });
  const backend = await listen(async (req, res) => {
    const body = await readBody(req);
    calls.push({ host: "backend", url: req.url, body, version: req.headers["x-cursor-client-version"] });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(runningBody(origin(awakeServer))));
  });
  t.after(() => Promise.all([asleepServer, awakeServer, backend].map((server) => new Promise((resolve) => server.close(resolve)))));
  const home = writeLogin(jwt(Math.floor(Date.now() / 1000) + 3600));
  const rows = await withEnv(envFor(home, backend), () => listAgents(session(origin(asleepServer))));
  assert.equal(rows[0].id, "bot-1");
  const wakes = calls.filter((call) => String(call.url).includes("EnsureSandBox"));
  assert.equal(wakes.length, 1);
  assert.deepEqual(wakes[0].body, { wake: true });
  assert.equal(wakes[0].version, "9.9.9");
  const retried = calls.filter((call) => call.host === "awake" && call.url === "/api/listAgents");
  assert.equal(retried.length, 1);
  assert.equal(retried[0].authorization, `Bearer ${NEW_GATEWAY}`);
  assert.equal(retried[0].network, NETWORK);
  assert.equal(calls.some((call) => JSON.stringify(call).includes(TOKEN_MARK)), false);
});

test("STARTING then RUNNING is polled with wake false about every 3 seconds", async (t) => {
  const bodies = [];
  const times = [];
  const awakeServer = await listen(async (req, res) => {
    await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General" }] }));
  });
  const backend = await listen(async (req, res) => {
    const body = await readBody(req);
    bodies.push(body);
    times.push(Date.now());
    res.setHeader("content-type", "application/json");
    if (bodies.length === 1) {
      res.end(JSON.stringify({ runState: "SAND_BOX_RUN_STATE_STARTING" }));
      return;
    }
    res.end(JSON.stringify(runningBody(origin(awakeServer))));
  });
  t.after(() => Promise.all([awakeServer, backend].map((server) => new Promise((resolve) => server.close(resolve)))));
  const home = writeLogin(jwt(Math.floor(Date.now() / 1000) + 3600));
  const asleepServer = await listen(async (req, res) => {
    await readBody(req);
    asleep(res);
  });
  t.after(() => new Promise((resolve) => asleepServer.close(resolve)));
  const rows = await withEnv(envFor(home, backend), () => listAgents(session(origin(asleepServer))));
  assert.equal(rows.length, 1);
  assert.deepEqual(bodies, [{ wake: true }, { wake: false }]);
  assert.ok(times[1] - times[0] >= 2500, `poll gap ${times[1] - times[0]}ms`);
  assert.ok(times[1] - times[0] < 8000, `poll gap ${times[1] - times[0]}ms`);
});

test("an expired token or a 401 leaves BOX_ASLEEP and does not keep calling EnsureSandBox", async (t) => {
  const ensure = [];
  const backend = await listen(async (req, res) => {
    ensure.push(await readBody(req));
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: "unauthenticated" }));
  });
  const gateway = await listen(async (req, res) => {
    await readBody(req);
    asleep(res);
  });
  t.after(() => Promise.all([backend, gateway].map((server) => new Promise((resolve) => server.close(resolve)))));

  const expiredHome = writeLogin(jwt(Math.floor(Date.now() / 1000) - 120));
  const expired = await withEnv(envFor(expiredHome, backend), () => listAgents(session(origin(gateway))))
    .then(() => assert.fail("expected BOX_ASLEEP"), (error) => error);
  assert.equal(expired.code, "BOX_ASLEEP");
  assert.deepEqual(expired.wake, { attempted: true, error: "EXPIRED" });
  assert.match(expired.message, /auto wake failed: token expired/);
  assert.doesNotMatch(expired.message, new RegExp(TOKEN_MARK));
  assert.equal(ensure.length, 0);

  const liveHome = writeLogin(jwt(Math.floor(Date.now() / 1000) + 3600));
  const denied = await withEnv(envFor(liveHome, backend), () => listAgents(session(origin(gateway))))
    .then(() => assert.fail("expected BOX_ASLEEP"), (error) => error);
  assert.equal(denied.code, "BOX_ASLEEP");
  assert.equal(denied.wake.attempted, true);
  assert.equal(denied.wake.error, "UNAUTHORIZED");
  assert.match(denied.message, /auto wake failed:/);
  assert.equal(ensure.length, 1);
  assert.deepEqual(ensure[0], { wake: true });
});

test("GBOT_AUTO_WAKE=0 does not call the backend", async (t) => {
  const urls = [];
  const backend = await listen(async (req, res) => {
    urls.push(req.url);
    await readBody(req);
    res.statusCode = 500;
    res.end();
  });
  const gateway = await listen(async (req, res) => {
    urls.push(req.url);
    await readBody(req);
    asleep(res);
  });
  t.after(() => Promise.all([backend, gateway].map((server) => new Promise((resolve) => server.close(resolve)))));
  const home = writeLogin(jwt(Math.floor(Date.now() / 1000) + 3600));
  const error = await withEnv({ ...envFor(home, backend), GBOT_AUTO_WAKE: "0" }, () => listAgents(session(origin(gateway))))
    .then(() => assert.fail("expected BOX_ASLEEP"), (err) => err);
  assert.equal(error.code, "BOX_ASLEEP");
  assert.equal(error.wake, undefined);
  assert.deepEqual(urls, ["/api/listAgents"]);
});

test("a GROK_BOT_GATEWAY_URL override is not woken", async (t) => {
  const urls = [];
  const gateway = await listen(async (req, res) => {
    urls.push(req.url);
    await readBody(req);
    asleep(res);
  });
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const base = origin(gateway);
  const home = writeLogin(jwt(Math.floor(Date.now() / 1000) + 3600));
  const error = await withEnv({
    ...envFor(home, gateway),
    GROK_BOT_GATEWAY_URL: base,
    GROK_BOT_GATEWAY_TOKEN: OLD_GATEWAY,
  }, () => listAgents(session(base)))
    .then(() => assert.fail("expected BOX_ASLEEP"), (err) => err);
  assert.equal(error.code, "BOX_ASLEEP");
  assert.equal(error.wake, undefined);
  assert.deepEqual(urls, ["/api/listAgents"]);
});

test("sendPrompt retries the same clientNonce after a 417 and reports an unknown retry", async (t) => {
  const sends = [];
  let sendCount = 0;
  const gateway = await listen(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/api/listAgents") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General", isGroup: false }] }));
      return;
    }
    sends.push({ url: req.url, body, authorization: req.headers.authorization });
    sendCount += 1;
    if (sendCount === 1) return asleep(res);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: "still down" }));
  });
  const awake = await listen(async (req, res) => {
    const body = await readBody(req);
    sends.push({ url: req.url, body, authorization: req.headers.authorization, awake: true });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ accepted: true }));
  });
  const backend = await listen(async (req, res) => {
    await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(runningBody(origin(awake))));
  });
  t.after(() => Promise.all([gateway, awake, backend].map((server) => new Promise((resolve) => server.close(resolve)))));
  const home = writeLogin(jwt(Math.floor(Date.now() / 1000) + 3600));
  const sent = await withEnv(envFor(home, backend), () => sendPrompt(session(origin(gateway)), "General", "hi", { clientNonce: "nonce-wake" }));
  assert.equal(sent.delivery, "accepted");
  assert.equal(sent.clientNonce, "nonce-wake");
  const promptBodies = sends.filter((call) => call.url === "/api/sendPrompt").map((call) => call.body);
  assert.equal(promptBodies.length, 2);
  assert.equal(promptBodies[0].clientNonce, "nonce-wake");
  assert.deepEqual(promptBodies[0], promptBodies[1]);
  assert.equal(sends.filter((call) => call.awake).length, 1);
});

test("a sendPrompt retry whose delivery is unknown stays unknown and keeps the clientNonce", async (t) => {
  const sends = [];
  let unknownSends = 0;
  const unknownGateway = await listen(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/api/listAgents") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General", isGroup: false }] }));
      return;
    }
    unknownSends += 1;
    sends.push(body);
    if (unknownSends === 1) return asleep(res);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: "still down" }));
  });
  const unknownBackend = await listen(async (req, res) => {
    await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(runningBody(origin(unknownGateway))));
  });
  t.after(() => Promise.all([unknownGateway, unknownBackend].map((server) => new Promise((resolve) => server.close(resolve)))));
  const home2 = writeLogin(jwt(Math.floor(Date.now() / 1000) + 3600));
  const error = await withEnv(envFor(home2, unknownBackend), () => sendPrompt(session(origin(unknownGateway)), "General", "hi", { clientNonce: "nonce-unknown" }))
    .then(() => assert.fail("expected unknown delivery"), (err) => err);
  assert.equal(error.delivery, "unknown");
  assert.equal(error.clientNonce, "nonce-unknown");
  assert.equal(sends.length, 2);
  assert.equal(sends[0].clientNonce, "nonce-unknown");
  assert.deepEqual(sends[0], sends[1]);
});

test("concurrent asleep calls share one wake", async (t) => {
  let ensureCount = 0;
  let asleepCount = 0;
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const awake = await listen(async (req, res) => {
    await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General" }] }));
  });
  const backend = await listen(async (req, res) => {
    await readBody(req);
    ensureCount += 1;
    await hold;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(runningBody(origin(awake))));
  });
  const gateway = await listen(async (req, res) => {
    await readBody(req);
    asleepCount += 1;
    asleep(res);
  });
  t.after(() => {
    release();
    return Promise.all([awake, backend, gateway].map((server) => new Promise((resolve) => server.close(resolve))));
  });
  const home = writeLogin(jwt(Math.floor(Date.now() / 1000) + 3600));
  const base = origin(gateway);
  await withEnv(envFor(home, backend), async () => {
    const done = Promise.all([
      listAgents(session(base)),
      listAgents({ ...session(base) }),
    ]);
    const early = done.then(
      () => ({ kind: "done" }),
      (error) => ({ kind: "error", error }),
    );
    const ready = (async () => {
      const start = Date.now();
      while (Date.now() - start < 1500) {
        if (ensureCount === 1 && asleepCount >= 2) return { kind: "ready" };
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { kind: "timeout", ensureCount, asleepCount };
    })();
    const first = await Promise.race([early, ready]);
    if (first.kind !== "ready") {
      assert.fail(first.kind === "error" ? first.error : `callers did not share a wake (${JSON.stringify(first)})`);
    }
    release();
    const [left, right] = await done;
    assert.equal(left[0].id, "bot-1");
    assert.equal(right[0].id, "bot-1");
    assert.equal(ensureCount, 1);
  });
});

test("abort during wake polling rejects and does not send wake false", async (t) => {
  const bodies = [];
  const controller = new AbortController();
  const backend = await listen(async (req, res) => {
    const body = await readBody(req);
    bodies.push(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ runState: "SAND_BOX_RUN_STATE_STARTING" }));
    setImmediate(() => controller.abort());
  });
  const gateway = await listen(async (req, res) => {
    await readBody(req);
    asleep(res);
  });
  t.after(() => Promise.all([backend, gateway].map((server) => new Promise((resolve) => server.close(resolve)))));
  const home = writeLogin(jwt(Math.floor(Date.now() / 1000) + 3600));
  const error = await withEnv(envFor(home, backend), () => listAgents(session(origin(gateway)), { signal: controller.signal }))
    .then(() => assert.fail("expected abort"), (err) => err);
  assert.equal(error.name === "AbortError" || error.reason === "cancelled" || /abort|cancel/i.test(error.message), true);
  assert.deepEqual(bodies, [{ wake: true }]);
});
