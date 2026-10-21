import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { grokBotGatewayDescriptorPath } from "../src/core/app-session.js";
import { encryptEntry, SECRETS } from "./helpers/wear-pair-fixture.js";

const CLI = fileURLToPath(new URL("../dist/bin/gbot.mjs", import.meta.url));
const SUB = "user_synthetic_wake_cli";
const SCOPE = crypto.createHash("sha256").update(SUB).digest("hex");
const TOKEN_MARK = "synthetic-wake-cli-token-do-not-leak";
const GATEWAY_TOKEN = "synthetic-wake-cli-gateway-token";
const NETWORK = "synthetic-wake-cli-network-token";

function jwt(expSeconds) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({
    sub: SUB,
    exp: expSeconds,
    iss: "https://authentication.cursor.sh",
    mark: TOKEN_MARK,
  })}.sig`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text ? JSON.parse(text) : {});
    });
    req.on("error", reject);
  });
}

async function fixture(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const home = mkdtempSync(join(tmpdir(), "gbot-wake-cli-"));
  const platform = process.platform === "win32" ? "darwin" : process.platform;
  const descriptorPath = grokBotGatewayDescriptorPath(home, platform, {});
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, JSON.stringify({
    version: 3,
    entries: {
      [SCOPE]: {
        encrypted: encryptEntry({
          baseUrl: "https://fake-wake.example",
          token: "descriptor-gateway-token-unused",
          headers: {},
          email: "wake-cli@example.com",
        }, SECRETS.password, platform === "linux" ? "linux" : "darwin"),
        savedAtMs: 1,
      },
    },
  }));
  writeFileSync(join(dirname(descriptorPath), "sand-secrets.json"), JSON.stringify({
    version: 1,
    "cursor-accounts": JSON.stringify({
      active: SCOPE,
      accounts: {
        [SCOPE]: { "cursor-access-token": `plaintext:v1:${jwt(Math.floor(Date.now() / 1000) + 3600)}` },
      },
    }),
  }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, GROK_BOT_TEST: "1", GBOT_TEST_KEYCHAIN_PASSWORD: SECRETS.password };
  delete env.GBOT_ACCOUNT;
  delete env.NODE_ENV;
  for (const key of Object.keys(env)) {
    if (/^(GROK_BOT_|CURSOR_|SAND_|GBOT_)/.test(key) && key !== "GROK_BOT_TEST" && key !== "GBOT_TEST_KEYCHAIN_PASSWORD") delete env[key];
  }
  env.CURSOR_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  env.SAND_CLIENT_VERSION = "9.9.9";
  return {
    env,
    server,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function run(args, env) {
  // The mock server lives in this process. spawnSync would freeze its event loop
  // and the child would wait forever for a response.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function assertNoSecrets(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  assert.equal(text.includes(TOKEN_MARK), false);
  assert.equal(text.includes(GATEWAY_TOKEN), false);
  assert.equal(text.includes(NETWORK), false);
  assert.equal(text.includes("descriptor-gateway-token-unused"), false);
}

test("gbot wake --check prints the run state and does not wake", {
  skip: process.platform === "win32" && "fixture descriptors are not DPAPI-shaped",
}, async () => {
  const bodies = [];
  const fx = await fixture(async (req, res) => {
    bodies.push(await readBody(req));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ runState: "SAND_BOX_RUN_STATE_HIBERNATED" }));
  });
  try {
    const result = await run(["wake", "--check"], fx.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /account: wake-cli@example.com/);
    assert.match(result.stdout, /before: HIBERNATED/);
    assert.match(result.stdout, /after: HIBERNATED/);
    assert.match(result.stdout, /seconds: \d/);
    assert.deepEqual(bodies, [{ wake: false }]);
    assertNoSecrets(result);

    const json = await run(["wake", "--check", "--json"], fx.env);
    assert.equal(json.status, 0, json.stderr);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.account, "wake-cli@example.com");
    assert.equal(payload.before, "HIBERNATED");
    assert.equal(payload.after, "HIBERNATED");
    assert.equal(payload.exitCode, 0);
    assert.equal(typeof payload.seconds, "number");
    assertNoSecrets(json);
  } finally {
    await fx.close();
  }
});

test("gbot wake reports running after EnsureSandBox and one listAgents", {
  skip: process.platform === "win32" && "fixture descriptors are not DPAPI-shaped",
}, async () => {
  const bodies = [];
  let listed = 0;
  const fx = await fixture(async (req, res) => {
    const body = await readBody(req);
    if (String(req.url).includes("EnsureSandBox")) {
      bodies.push(body);
      res.setHeader("content-type", "application/json");
      if (body.wake === false) {
        res.end(JSON.stringify({ runState: "SAND_BOX_RUN_STATE_HIBERNATED" }));
        return;
      }
      res.end(JSON.stringify({
        runState: "SAND_BOX_RUN_STATE_RUNNING",
        gatewayUrl: `http://127.0.0.1:${fx.server.address().port}`,
        gatewayToken: GATEWAY_TOKEN,
        networkToken: NETWORK,
      }));
      return;
    }
    listed += 1;
    assert.equal(req.headers.authorization, `Bearer ${GATEWAY_TOKEN}`);
    assert.equal(req.headers["x-anyrun-network-token"], NETWORK);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ agents: [{ id: "bot-1", name: "General" }] }));
  });
  try {
    const result = await run(["wake", "--json"], fx.env);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.before, "HIBERNATED");
    assert.equal(payload.after, "RUNNING");
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.account, "wake-cli@example.com");
    assert.deepEqual(bodies.map((body) => body.wake), [false, true]);
    assert.equal(listed, 1);
    assertNoSecrets(result);
  } finally {
    await fx.close();
  }
});

test("gbot wake exits 3 when the backend rejects the token and 4 when the box stays starting", {
  skip: process.platform === "win32" && "fixture descriptors are not DPAPI-shaped",
}, async () => {
  const denied = await fixture(async (req, res) => {
    const body = await readBody(req);
    if (body.wake === true) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "unauthenticated" }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ runState: "SAND_BOX_RUN_STATE_HIBERNATED" }));
  });
  try {
    const result = await run(["wake", "--json"], denied.env);
    assert.equal(result.status, 3, result.stdout + result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.exitCode, 3);
    assert.equal(typeof payload.error, "string");
    assertNoSecrets(result);
  } finally {
    await denied.close();
  }

  const starting = await fixture(async (req, res) => {
    await readBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ runState: "SAND_BOX_RUN_STATE_STARTING" }));
  });
  try {
    const result = await run(["wake", "--json"], {
      ...starting.env,
      GBOT_WAKE_TIMEOUT_MS: "200",
      GBOT_WAKE_POLL_MS: "50",
    });
    assert.equal(result.status, 4, result.stdout + result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.exitCode, 4);
    assert.equal(payload.after, "STARTING");
    assertNoSecrets(result);
  } finally {
    await starting.close();
  }
});

test("gbot wake rejects an unknown flag with exit 2", {
  skip: process.platform === "win32" && "fixture descriptors are not DPAPI-shaped",
}, () => {
  const result = spawnSync(process.execPath, [CLI, "wake", "--nope"], { encoding: "utf8", env: { ...process.env, GROK_BOT_TEST: "1" } });
  assert.equal(result.status, 2, result.stderr);
});
