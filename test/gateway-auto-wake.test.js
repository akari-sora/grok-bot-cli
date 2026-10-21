import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { grokBotGatewayDescriptorPath } from "../src/core/app-session.js";
import { listAgents, sendPrompt, wakeSandbox } from "../src/core/gateway.js";
import { shouldSkipUnixOnlyTests } from "./helpers/win32-test.js";

const SUB = "user_synthetic_auto_wake";
const SCOPE = crypto.createHash("sha256").update(SUB).digest("hex");
const TOKEN_MARK = "synthetic-wake-access-do-not-leak";
const OLD_GATEWAY = "old-gateway-token";
const NEW_GATEWAY = "new-gateway-token";
const NETWORK = "synthetic-network-token";

function jwt(expSeconds, sub = SUB) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({
    sub,
    exp: expSeconds,
    iss: "https://authentication.cursor.sh",
    mark: TOKEN_MARK,
  })}.sig`;
}

function scopeFor(sub) {
  return crypto.createHash("sha256").update(sub).digest("hex");
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
  const gateway = await listen(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/api/listAgents") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General", isGroup: false }] }));
      return;
    }
    sends.push({ url: req.url, body, authorization: req.headers.authorization });
    asleep(res);
  });
  const awake = await listen(async (req, res) => {
    const body = await readBody(req);
    sends.push({ url: req.url, body, authorization: req.headers.authorization, awake: true });
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: "still down" }));
  });
  const backend = await listen(async (req, res) => {
    await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(runningBody(origin(awake))));
  });
  t.after(() => Promise.all([gateway, awake, backend].map((server) => new Promise((resolve) => server.close(resolve)))));
  const home = writeLogin(jwt(Math.floor(Date.now() / 1000) + 3600));
  const error = await withEnv(envFor(home, backend), () => sendPrompt(session(origin(gateway)), "General", "hi", { clientNonce: "nonce-wake" }))
    .then(() => assert.fail("expected unknown delivery"), (err) => err);
  assert.equal(error.delivery, "unknown");
  assert.equal(error.effect, "unknown");
  assert.equal(error.clientNonce, "nonce-wake");
  assert.match(error.message, /delivery unknown/);
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
  assert.equal(error.name, "GatewayError");
  assert.equal(error.delivery, "rejected");
  assert.equal(error.reason, "cancelled");
  assert.deepEqual(bodies, [{ wake: true }]);
});

function writeScopedLogin(sub) {
  const scope = scopeFor(sub);
  const home = mkdtempSync(join(tmpdir(), "gbot-auto-wake-"));
  const secretsPath = join(dirname(grokBotGatewayDescriptorPath(home, process.platform, {})), "sand-secrets.json");
  mkdirSync(dirname(secretsPath), { recursive: true });
  writeFileSync(secretsPath, JSON.stringify({
    version: 1,
    "cursor-accounts": JSON.stringify({
      active: scope,
      accounts: {
        [scope]: {
          "cursor-access-token": `plaintext:v1:${jwt(Math.floor(Date.now() / 1000) + 3600, sub)}`,
          "cursor-refresh-token": "refresh-secret-do-not-touch",
        },
      },
    }),
  }));
  return { home, scope };
}

function sessionFor(gatewayUrl, scope) {
  return { gatewayUrl, gatewayToken: OLD_GATEWAY, accountScope: scope };
}

async function countSecretReads() {
  let secretFiles;
  let osSecretCommands;
  try {
    ({ secretFiles } = await import("../src/core/app-auth.js"));
    ({ osSecretCommands } = await import("../src/core/app-session.js"));
  } catch {
    return { counts: { readFile: 0, keychain: 0 }, available: false, restore() {} };
  }
  if (typeof secretFiles?.readFileSync !== "function" || typeof osSecretCommands?.execFileSync !== "function") {
    return { counts: { readFile: 0, keychain: 0 }, available: false, restore() {} };
  }
  const origRead = secretFiles.readFileSync;
  const origExec = osSecretCommands.execFileSync;
  const counts = { readFile: 0, keychain: 0 };
  secretFiles.readFileSync = (path, ...args) => {
    if (String(path).includes("sand-secrets.json")) counts.readFile += 1;
    return origRead(path, ...args);
  };
  osSecretCommands.execFileSync = (cmd, ...args) => {
    if (/security|secret-tool|powershell/i.test(String(cmd))) counts.keychain += 1;
    return origExec(cmd, ...args);
  };
  return {
    counts,
    available: true,
    restore() {
      secretFiles.readFileSync = origRead;
      osSecretCommands.execFileSync = origExec;
    },
  };
}

async function waitFor(pred, label) {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function closeServers(servers) {
  return Promise.all(servers.map((server) => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  })));
}

test("an already-aborted sendPrompt does not read the login or reject unhandled", async (t) => {
  const rejections = [];
  const onRejection = (reason) => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  const counted = await countSecretReads();
  t.after(() => {
    process.off("unhandledRejection", onRejection);
    counted.restore();
  });
  const sub = "user_synthetic_abort_inflight";
  const { home, scope } = writeScopedLogin(sub);
  const controller = new AbortController();
  const prompts = [];
  const gateway = await listen(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/api/listAgents") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General", isGroup: false }] }));
      return;
    }
    prompts.push(body);
    controller.abort();
    asleep(res);
  });
  const backend = await listen(async (req, res) => {
    await readBody(req);
    res.statusCode = 500;
    res.end("backend should not be called");
  });
  t.after(() => closeServers([gateway, backend]));
  const error = await withEnv(envFor(home, backend), () => sendPrompt(sessionFor(origin(gateway), scope), "General", "hi", {
    signal: controller.signal,
    clientNonce: "nonce-already-aborted",
  })).then(() => assert.fail("expected cancel"), (err) => err);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(rejections.length, 0);
  assert.equal(error.name, "GatewayError");
  assert.equal(error.delivery, "rejected");
  assert.equal(error.reason, "cancelled");
  assert.equal(error.clientNonce, "nonce-already-aborted");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].clientNonce, "nonce-already-aborted");
  assert.equal(counted.available, true);
  assert.equal(counted.counts.readFile, 0);
  assert.equal(counted.counts.keychain, 0);
});

test("sendPrompt aborted during STARTING polling is rejected as cancelled", async (t) => {
  const sub = "user_synthetic_abort_poll";
  const { home, scope } = writeScopedLogin(sub);
  const controller = new AbortController();
  const prompts = [];
  const bodies = [];
  const gateway = await listen(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/api/listAgents") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General", isGroup: false }] }));
      return;
    }
    prompts.push(body);
    asleep(res);
  });
  const backend = await listen(async (req, res) => {
    bodies.push(await readBody(req));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ runState: "SAND_BOX_RUN_STATE_STARTING" }));
    setTimeout(() => controller.abort(), 30);
  });
  t.after(() => closeServers([gateway, backend]));
  const error = await withEnv(envFor(home, backend), () => sendPrompt(sessionFor(origin(gateway), scope), "General", "hi", {
    signal: controller.signal,
    clientNonce: "nonce-poll-abort",
  })).then(() => assert.fail("expected cancel"), (err) => err);
  assert.equal(error.name, "GatewayError");
  assert.equal(error.delivery, "rejected");
  assert.equal(error.reason, "cancelled");
  assert.equal(error.clientNonce, "nonce-poll-abort");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].clientNonce, "nonce-poll-abort");
  assert.deepEqual(bodies, [{ wake: true }]);
  assert.doesNotMatch(error.message, /delivery unknown/);
});

test("the relay records a send aborted during wake polling as cancelled", {
  skip: shouldSkipUnixOnlyTests() ? "Unix sockets and Codex routes are unsupported on win32" : false,
}, async (t) => {
  const sub = "user_synthetic_relay_abort";
  const { home, scope } = writeScopedLogin(sub);
  const prompts = [];
  const bodies = [];
  let engine;
  let binding;
  const gateway = await listen(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/api/listAgents") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General", isGroup: false }] }));
      return;
    }
    prompts.push(body);
    asleep(res);
  });
  const backend = await listen(async (req, res) => {
    bodies.push(await readBody(req));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ runState: "SAND_BOX_RUN_STATE_STARTING" }));
    setTimeout(() => {
      engine?.stopBinding({ bindingId: binding.id }).catch(() => {});
    }, 40);
  });
  const { fakeAppServer } = await import("./helpers/codex-server.js");
  const { openRelayEngine } = await import("../src/core/relay/engine.js");
  const fake = await fakeAppServer({
    initialize: (_, ok) => ok({}),
    "thread/resume": (params, ok) => ok({
      thread: { id: params.threadId, cwd: "/tmp", status: { type: "idle" } },
    }),
    "thread/turns/list": (_, ok) => ok({ data: [], nextCursor: null }),
    "thread/items/list": (_, ok) => ok({ data: [], nextCursor: null }),
  });
  const dir = mkdtempSync(join(tmpdir(), "gbot-wake-relay-"));
  let seen;
  t.after(async () => {
    await engine?.close().catch(() => {});
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
    await closeServers([gateway, backend]);
  });
  const receipt = await withEnv(envFor(home, backend), async () => {
    engine = await openRelayEngine({
      stateDir: dir,
      profile: "wake-abort",
      env: { CODEX_HOME: fake.home, GROK_BOT_MAX_HOPS: "4", GROK_BOT_TEST: "1" },
      clock: () => 1000,
      gateway: {
        resolve: async (ref) => ({ id: "bot-1", name: String(ref) }),
        tail: async () => ({ entries: [] }),
        send: async (id, text, extra) => {
          try {
            return await sendPrompt(sessionFor(origin(gateway), scope), id, text, extra);
          } catch (error) {
            seen = error;
            throw error;
          }
        },
      },
    });
    binding = await engine.startBinding({
      grokTarget: "General",
      codexThreadId: "thread-wake",
      requestId: "wake-abort-binding",
    });
    return engine.sendToGrok({
      bindingId: binding.id,
      message: "wake abort",
      requestId: "wake-abort-send",
    });
  });
  assert.equal(seen?.name, "GatewayError");
  assert.equal(seen.delivery, "rejected");
  assert.equal(seen.reason, "cancelled");
  assert.equal(prompts.length, 1);
  assert.equal(seen.clientNonce, prompts[0].clientNonce);
  assert.equal(receipt.delivery, "rejected");
  assert.equal(receipt.reason, "cancelled");
  assert.equal(receipt.clientId, seen.clientNonce);
  assert.deepEqual(bodies, [{ wake: true }]);
});

test("one aborted waiter is cancelled at once while the other wake succeeds", async (t) => {
  const sub = "user_synthetic_share_abort";
  const { home, scope } = writeScopedLogin(sub);
  let ensures = 0;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let asleepSeen = 0;
  let releaseAsleep;
  const asleepGate = new Promise((resolve) => { releaseAsleep = resolve; });
  const awake = await listen(async (req, res) => {
    await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General" }] }));
  });
  const backend = await listen(async (req, res) => {
    await readBody(req);
    ensures += 1;
    await hold;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(runningBody(origin(awake))));
  });
  const gateway = await listen(async (req, res) => {
    await readBody(req);
    asleepSeen += 1;
    if (asleepSeen >= 2) releaseAsleep();
    await asleepGate;
    asleep(res);
  });
  t.after(() => {
    release();
    releaseAsleep();
    return closeServers([awake, backend, gateway]);
  });
  const ac = new AbortController();
  const base = origin(gateway);
  await withEnv(envFor(home, backend), async () => {
    const left = listAgents(sessionFor(base, scope), { signal: ac.signal });
    const right = listAgents(sessionFor(base, scope));
    await asleepGate;
    await waitFor(() => ensures === 1, "shared ensure");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    ac.abort();
    const error = await left.then(() => assert.fail("expected cancel"), (err) => err);
    assert.ok(Date.now() - started < 500, "aborted waiter should reject at once");
    assert.equal(error.reason, "cancelled");
    assert.equal(error.delivery, "rejected");
    assert.equal(ensures, 1);
    release();
    const rows = await right;
    assert.equal(rows[0].id, "bot-1");
    assert.equal(ensures, 1);
  });
});

test("a new caller starts a fresh wake after every waiter aborted", async (t) => {
  const sub = "user_synthetic_fresh_wake";
  const { home, scope } = writeScopedLogin(sub);
  let ensures = 0;
  const awake = await listen(async (req, res) => {
    await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General" }] }));
  });
  const backend = await listen(async (req, res) => {
    await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(runningBody(origin(awake))));
  });
  const gateway = await listen(async (req, res) => {
    await readBody(req);
    asleep(res);
  });
  const original = globalThis.fetch;
  const backendOrigin = origin(backend);
  // The first EnsureSandBox ignores abort and never answers, so an implementation
  // that keeps the aborted job reuses it instead of calling EnsureSandBox again.
  globalThis.fetch = (url, options) => {
    if (String(url).startsWith(backendOrigin)) {
      ensures += 1;
      if (ensures === 1) return new Promise(() => {});
    }
    return original(url, options);
  };
  t.after(() => {
    globalThis.fetch = original;
    return closeServers([awake, backend, gateway]);
  });
  const ac = new AbortController();
  const base = origin(gateway);
  await withEnv(envFor(home, backend), async () => {
    const first = listAgents(sessionFor(base, scope), { signal: ac.signal });
    await waitFor(() => ensures === 1, "first ensure");
    ac.abort();
    const error = await Promise.race([
      first.then(() => "resolved", (err) => err),
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 500)),
    ]);
    assert.equal(error.reason, "cancelled");
    const rows = await listAgents(sessionFor(base, scope));
    assert.equal(rows[0].id, "bot-1");
    assert.equal(ensures, 2);
  });
});

test("ALLOW_ANY does not send the app login token to a non-cursor host", async (t) => {
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    urls.push(target);
    if (target.includes("evil.example")) throw new Error("fetched evil.example");
    return original(url, options);
  };
  t.after(() => { globalThis.fetch = original; });
  const sub = "user_synthetic_allow_any";
  const { home, scope } = writeScopedLogin(sub);
  const gateway = await listen(async (req, res) => {
    await readBody(req);
    asleep(res);
  });
  t.after(() => closeServers([gateway]));
  await withEnv({
    ...envFor(home, gateway),
    GROK_BOT_TEST: null,
    NODE_ENV: null,
    GROK_BOT_ALLOW_ANY_GATEWAY: "1",
    CURSOR_API_BASE_URL: "https://evil.example",
  }, async () => {
    const error = await listAgents(sessionFor(origin(gateway), scope))
      .then(() => assert.fail("expected refusal"), (err) => err);
    assert.equal(error.code, "BOX_ASLEEP");
    assert.equal(error.wake.attempted, true);
    assert.match(error.message, /evil\.example/);
    assert.equal(urls.some((url) => url.includes("evil.example")), false);
    urls.length = 0;
    const direct = await wakeSandbox("synthetic-app-token", { appLogin: true })
      .then(() => assert.fail("expected refusal"), (err) => err);
    assert.match(direct.message, /evil\.example/);
    assert.equal(urls.some((url) => url.includes("evil.example")), false);
  });
});

test("a user-supplied CURSOR_ACCESS_TOKEN still follows ALLOW_ANY", async (t) => {
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({
      runState: "SAND_BOX_RUN_STATE_RUNNING",
      gatewayUrl: "https://box.cursorvm.com",
      gatewayToken: "box-token",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = original; });
  await withEnv({
    GROK_BOT_TEST: null,
    NODE_ENV: null,
    GROK_BOT_ALLOW_ANY_GATEWAY: "1",
    CURSOR_API_BASE_URL: "https://evil.example",
    SAND_CLIENT_VERSION: "9.9.9",
  }, () => wakeSandbox("synthetic-user-token"));
  assert.match(urls[0], /^https:\/\/evil\.example\//);
});

test("sendPrompt does not resend a bare 417", async (t) => {
  const sub = "user_synthetic_bare_417";
  const { home, scope } = writeScopedLogin(sub);
  const urls = [];
  const gateway = await listen(async (req, res) => {
    await readBody(req);
    urls.push(req.url);
    if (req.url === "/api/listAgents") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General", isGroup: false }] }));
      return;
    }
    res.statusCode = 417;
    res.end();
  });
  const backend = await listen(async (req, res) => {
    urls.push(req.url);
    await readBody(req);
    res.statusCode = 500;
    res.end();
  });
  t.after(() => closeServers([gateway, backend]));
  const error = await withEnv(envFor(home, backend), () => sendPrompt(sessionFor(origin(gateway), scope), "General", "hi", {
    clientNonce: "nonce-bare",
  })).then(() => assert.fail("expected rejection"), (err) => err);
  assert.equal(error.code, "BOX_ASLEEP");
  assert.equal(error.delivery, "rejected");
  assert.equal(error.clientNonce, "nonce-bare");
  assert.equal(error.wake, undefined);
  assert.deepEqual(urls.filter((url) => String(url).includes("EnsureSandBox")), []);
  assert.equal(urls.filter((url) => url === "/api/sendPrompt").length, 1);
});

test("sendPrompt with pod_hibernated wakes and resends once", async (t) => {
  const sub = "user_synthetic_pod_resend";
  const { home, scope } = writeScopedLogin(sub);
  const prompts = [];
  let ensures = 0;
  const gateway = await listen(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/api/listAgents") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General", isGroup: false }] }));
      return;
    }
    prompts.push(body);
    asleep(res);
  });
  const awake = await listen(async (req, res) => {
    const body = await readBody(req);
    prompts.push(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ accepted: true }));
  });
  const backend = await listen(async (req, res) => {
    await readBody(req);
    ensures += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(runningBody(origin(awake))));
  });
  t.after(() => closeServers([gateway, awake, backend]));
  const sent = await withEnv(envFor(home, backend), () => sendPrompt(sessionFor(origin(gateway), scope), "General", "hi", {
    clientNonce: "nonce-pod",
  }));
  assert.equal(sent.delivery, "accepted");
  assert.equal(sent.clientNonce, "nonce-pod");
  assert.equal(ensures, 1);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].clientNonce, "nonce-pod");
  assert.deepEqual(prompts[0], prompts[1]);
});

test("listAgents still wakes on a bare 417", async (t) => {
  const sub = "user_synthetic_bare_list";
  const { home, scope } = writeScopedLogin(sub);
  let ensures = 0;
  const awake = await listen(async (req, res) => {
    await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General" }] }));
  });
  const backend = await listen(async (req, res) => {
    await readBody(req);
    ensures += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(runningBody(origin(awake))));
  });
  const gateway = await listen(async (req, res) => {
    await readBody(req);
    res.statusCode = 417;
    res.end();
  });
  t.after(() => closeServers([awake, backend, gateway]));
  const rows = await withEnv(envFor(home, backend), () => listAgents(sessionFor(origin(gateway), scope)));
  assert.equal(rows[0].id, "bot-1");
  assert.equal(ensures, 1);
});

test("a retry that is still asleep says the wake ran", async (t) => {
  const sub = "user_synthetic_still_asleep";
  const { home, scope } = writeScopedLogin(sub);
  const gateway = await listen(async (req, res) => {
    await readBody(req);
    asleep(res);
  });
  const backend = await listen(async (req, res) => {
    await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(runningBody(origin(gateway))));
  });
  t.after(() => closeServers([gateway, backend]));
  const error = await withEnv(envFor(home, backend), () => listAgents(sessionFor(origin(gateway), scope)))
    .then(() => assert.fail("expected asleep"), (err) => err);
  assert.equal(error.code, "BOX_ASLEEP");
  assert.deepEqual(error.wake, { attempted: true, woke: true });
  assert.match(error.message, /auto wake ran, but the box is still asleep/);
});

test("a bad gateway override does not mask BOX_ASLEEP", async (t) => {
  const sub = "user_synthetic_bad_override";
  const { home, scope } = writeScopedLogin(sub);
  const urls = [];
  const gateway = await listen(async (req, res) => {
    urls.push(req.url);
    await readBody(req);
    asleep(res);
  });
  t.after(() => closeServers([gateway]));
  const error = await withEnv({
    ...envFor(home, gateway),
    GROK_BOT_GATEWAY_URL: "https://evil.example",
    GROK_BOT_GATEWAY_TOKEN: "override-token",
  }, () => listAgents(sessionFor(origin(gateway), scope)))
    .then(() => assert.fail("expected BOX_ASLEEP"), (err) => err);
  assert.equal(error.code, "BOX_ASLEEP");
  assert.equal(error.wake, undefined);
  assert.doesNotMatch(error.message, /Rejected/);
  assert.deepEqual(urls, ["/api/listAgents"]);
});

test("a 401 no longer supported stays CLIENT_VERSION_REJECTED", async (t) => {
  const sub = "user_synthetic_version_rejected";
  const { home, scope } = writeScopedLogin(sub);
  const backend = await listen(async (req, res) => {
    await readBody(req);
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: "This version of Grok Bot is no longer supported." }));
  });
  const gateway = await listen(async (req, res) => {
    await readBody(req);
    asleep(res);
  });
  t.after(() => closeServers([backend, gateway]));
  const error = await withEnv({
    ...envFor(home, backend),
    SAND_CLIENT_VERSION: "0.20.0",
  }, () => listAgents(sessionFor(origin(gateway), scope)))
    .then(() => assert.fail("expected BOX_ASLEEP"), (err) => err);
  assert.equal(error.code, "BOX_ASLEEP");
  assert.equal(error.wake.error, "CLIENT_VERSION_REJECTED");
  assert.match(error.message, /0\.20\.0/);
  assert.match(error.message, /SAND_CLIENT_VERSION/);
  assert.match(error.message, /client version rejected/);
  assert.doesNotMatch(error.message, /auto wake failed: unauthorized/);
});

test("a wake EnsureSandBox call stays inside the remaining budget", async (t) => {
  const sub = "user_synthetic_wake_budget";
  const { home, scope } = writeScopedLogin(sub);
  const backend = await listen(async (_req, res) => {
    await new Promise(() => {});
    res.end();
  });
  const gateway = await listen(async (req, res) => {
    await readBody(req);
    asleep(res);
  });
  t.after(() => closeServers([backend, gateway]));
  const started = Date.now();
  const error = await withEnv({
    ...envFor(home, backend),
    GBOT_WAKE_TIMEOUT_MS: "400",
  }, () => listAgents(sessionFor(origin(gateway), scope)))
    .then(() => assert.fail("expected wake failure"), (err) => err);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `wake waited ${elapsed}ms`);
  assert.equal(error.code, "BOX_ASLEEP");
  assert.equal(error.wake.attempted, true);
  assert.equal(error.wake.error === "WAKE_FAILED" || error.wake.error === "WAKE_TIMEOUT", true);
});

test("HIBERNATED after wake true is sent once more and then fails", async (t) => {
  const sub = "user_synthetic_hibernated";
  const { home, scope } = writeScopedLogin(sub);
  const bodies = [];
  const backend = await listen(async (req, res) => {
    bodies.push(await readBody(req));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ runState: "SAND_BOX_RUN_STATE_HIBERNATED" }));
  });
  const gateway = await listen(async (req, res) => {
    await readBody(req);
    asleep(res);
  });
  t.after(() => closeServers([backend, gateway]));
  const started = Date.now();
  const error = await withEnv({
    ...envFor(home, backend),
    GBOT_WAKE_TIMEOUT_MS: "8000",
  }, () => listAgents(sessionFor(origin(gateway), scope)))
    .then(() => assert.fail("expected wake failure"), (err) => err);
  assert.deepEqual(bodies, [{ wake: true }, { wake: true }]);
  assert.equal(error.wake.error, "WAKE_FAILED");
  assert.ok(Date.now() - started < 1500, "hibernated wake should fail fast");
});

test("unknown without gateway fields fails fast and unknown with fields is polled", async (t) => {
  const sub = "user_synthetic_unknown_state";
  const { home, scope } = writeScopedLogin(sub);
  const bareBodies = [];
  const bareBackend = await listen(async (req, res) => {
    bareBodies.push(await readBody(req));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ runState: "NOPE" }));
  });
  const bareGateway = await listen(async (req, res) => {
    await readBody(req);
    asleep(res);
  });
  t.after(() => closeServers([bareBackend, bareGateway]));
  const bare = await withEnv(envFor(home, bareBackend), () => listAgents(sessionFor(origin(bareGateway), scope)))
    .then(() => assert.fail("expected wake failure"), (err) => err);
  assert.deepEqual(bareBodies, [{ wake: true }]);
  assert.equal(bare.wake.error, "WAKE_FAILED");

  const sub2 = "user_synthetic_unknown_fields";
  const second = writeScopedLogin(sub2);
  const bodies = [];
  const awake = await listen(async (req, res) => {
    await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General" }] }));
  });
  const backend = await listen(async (req, res) => {
    const body = await readBody(req);
    bodies.push(body);
    res.setHeader("content-type", "application/json");
    if (bodies.length === 1) {
      res.end(JSON.stringify({
        runState: "NOPE",
        gatewayUrl: origin(awake),
        gatewayToken: NEW_GATEWAY,
      }));
      return;
    }
    res.end(JSON.stringify(runningBody(origin(awake))));
  });
  const gateway = await listen(async (req, res) => {
    await readBody(req);
    asleep(res);
  });
  t.after(() => closeServers([awake, backend, gateway]));
  const rows = await withEnv({
    ...envFor(second.home, backend),
    GBOT_WAKE_POLL_MS: "20",
  }, () => listAgents(sessionFor(origin(gateway), second.scope)));
  assert.equal(rows[0].id, "bot-1");
  assert.deepEqual(bodies.map((body) => body.wake), [true, false]);
});
