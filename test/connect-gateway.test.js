import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { grokBotGatewayDescriptorPath } from "../src/core/app-session.js";
import { connectGateway, hasGatewayAuth } from "../src/core/gateway.js";

function withEnv(values, fn) {
  const prev = {};
  for (const key of Object.keys(values)) {
    prev[key] = process.env[key];
    const v = values[key];
    if (v == null) delete process.env[key];
    else process.env[key] = v;
  }
  const restore = () => {
    for (const key of Object.keys(values)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  // Keep the variables set until an async body settles.
  if (result && typeof result.then === "function") return result.finally(restore);
  restore();
  return result;
}

function writeBrokenAppSession() {
  const home = mkdtempSync(join(tmpdir(), "gbot-connect-home-"));
  const env =
    process.platform === "linux"
      ? { XDG_CONFIG_HOME: join(home, ".config") }
      : process.platform === "win32"
        ? { APPDATA: join(home, "AppData/Roaming") }
        : {};
  const descriptorPath = grokBotGatewayDescriptorPath(home, process.platform, {
    ...process.env,
    ...env,
    HOME: home,
  });
  mkdirSync(dirname(descriptorPath), { recursive: true });
  // Present but unusable — empty v2 entries (and no Local State on Windows).
  writeFileSync(descriptorPath, JSON.stringify({ version: 2, entries: {} }));
  return { home, env };
}

test("unusable app session falls through to CURSOR_ACCESS_TOKEN EnsureSandBox", async (t) => {
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    t.skip("app session platforms only");
    return;
  }

  const { home, env } = writeBrokenAppSession();
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), body: options.body });
    return new Response(
      JSON.stringify({
        runState: "SAND_BOX_RUN_STATE_RUNNING",
        gatewayUrl: "http://127.0.0.1:1341",
        gatewayToken: "from-ensure",
      }),
      { status: 200 },
    );
  });

  await withEnv(
    {
      HOME: home,
      USERPROFILE: home,
      CURSOR_ACCESS_TOKEN: "cursor-access-token",
      CURSOR_API_BASE_URL: "http://127.0.0.1:1340",
      SAND_BACKEND_URL: "https://ignored.invalid",
      GROK_BOT_GATEWAY_URL: null,
      GROK_BOT_GATEWAY_TOKEN: null,
      GROK_BOT_ALLOW_ANY_GATEWAY: null,
      GROK_BOT_ALLOW_LOCAL_GATEWAY: null,
      ...env,
    },
    async () => {
      const session = await connectGateway();
      assert.equal(session.gatewayUrl, "http://127.0.0.1:1341");
      assert.equal(session.gatewayToken, "from-ensure");
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /EnsureSandBox/);
      // The app's EnsureSandBoxRequest has `wake` (2) and `supports_asleep_box` (3). gbot needs an awake box
      // and cannot show an asleep state, so it asks for wake only.
      assert.deepEqual(JSON.parse(calls[0].body), { wake: true });
    },
  );
});

test("removed token and gateway env aliases do not select gateway auth", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-connect-alias-home-"));
  withEnv(
    {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      APPDATA: join(home, "AppData/Roaming"),
      CURSOR_ACCESS_TOKEN: null,
      GROK_BOT_GATEWAY_URL: null,
      GROK_BOT_GATEWAY_TOKEN: null,
      GROK_BOT_ACCESS_TOKEN: "removed",
      SAND_ACCESS_TOKEN: "removed",
      SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1340",
      SAND_HOST_GATEWAY_TOKEN: "removed",
      SAND_GATEWAY_TOKEN: "removed",
    },
    () => assert.equal(hasGatewayAuth(), false),
  );
});

test("CURSOR_ACCESS_TOKEN polls a STARTING box instead of reporting a dashboard API key", async (t) => {
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    t.skip("app session platforms only");
    return;
  }
  const { home, env } = writeBrokenAppSession();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    const body = calls === 1
      ? { runState: "SAND_BOX_RUN_STATE_STARTING" }
      : {
        runState: "SAND_BOX_RUN_STATE_RUNNING",
        gatewayUrl: "http://127.0.0.1:1341",
        gatewayToken: "from-ensure",
      };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  await withEnv({
    HOME: home,
    USERPROFILE: home,
    CURSOR_ACCESS_TOKEN: "cursor-access-token",
    CURSOR_API_BASE_URL: "http://127.0.0.1:1340",
    GROK_BOT_GATEWAY_URL: null,
    GROK_BOT_GATEWAY_TOKEN: null,
    GROK_BOT_ALLOW_ANY_GATEWAY: null,
    SAND_CLIENT_VERSION: "9.9.9",
    GBOT_WAKE_POLL_MS: "1",
    GBOT_WAKE_TIMEOUT_MS: "5000",
    GROK_BOT_TEST: "1",
    ...env,
  }, async () => {
    const session = await connectGateway();
    assert.equal(session.gatewayToken, "from-ensure");
    assert.equal(calls, 2);
  });
});

test("unusable app session without access token surfaces the session error", async (t) => {
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    t.skip("app session platforms only");
    return;
  }

  const { home, env } = writeBrokenAppSession();
  await withEnv(
    {
      HOME: home,
      USERPROFILE: home,
      CURSOR_ACCESS_TOKEN: null,
      GROK_BOT_GATEWAY_URL: null,
      GROK_BOT_GATEWAY_TOKEN: null,
      ...env,
    },
    async () => {
      await assert.rejects(
        connectGateway(),
        (error) => {
          assert.equal(error.name, "GatewayError");
          assert.match(error.message, /no saved gateway entries/i);
          return true;
        },
      );
    },
  );
});
