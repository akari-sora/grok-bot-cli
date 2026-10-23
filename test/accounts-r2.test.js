import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { grokBotGatewayDescriptorPath, loadGrokBotGatewaySelection } from "../src/core/app-session.js";
import { outcomeFromError } from "../src/core/codex/contract.js";
import { connectGateway, listAgents, sendPrompt } from "../src/core/gateway.js";
import {
  importAccountConfig,
  readGbotConfig,
  writeGbotConfig,
} from "../src/core/gbot-config.js";
import * as logins from "../src/core/logins.js";

const {
  defineAlias,
  formatLoginCatalog,
  listLoginCatalog,
  resolveGrokBotLogin,
  setDefaultAccount,
} = logins;

function workerAccountScope(env) {
  if (typeof logins.workerAccountScope !== "function") {
    throw new Error("workerAccountScope is not exported");
  }
  return logins.workerAccountScope(env);
}
import { relayLocation, relayProfile, resolveRelayAccountScope } from "../src/core/relay/profile.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const TOKEN_MARK = "synthetic-r2-token-do-not-leak";
const GATEWAY_TOKEN = "synthetic-gateway-token-do-not-leak";
const NETWORK_TOKEN = "synthetic-network-token-do-not-leak";

function jwt(sub, exp = 1_800_000_000) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({
    sub,
    exp,
    iss: "https://authentication.cursor.sh",
    mark: TOKEN_MARK,
  })}.sig`;
}

function scopeFor(sub) {
  return crypto.createHash("sha256").update(sub).digest("hex");
}

function encrypt(text, password = "demo-password") {
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([Buffer.from("v10"), cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

function encryptForPlatform(text, platform = process.platform, password = "demo-password") {
  const linux = platform === "linux";
  const key = crypto.pbkdf2Sync(password, "saltysalt", linux ? 1 : 1003, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([
    Buffer.from(linux ? "v11" : "v10"),
    cipher.update(text, "utf8"),
    cipher.final(),
  ]).toString("base64");
}

function homeWith({ secrets, descriptor } = {}, platform = "darwin") {
  const home = mkdtempSync(join(tmpdir(), "gbot-r2-"));
  const descriptorPath = grokBotGatewayDescriptorPath(home, platform, {});
  mkdirSync(dirname(descriptorPath), { recursive: true });
  if (secrets !== undefined) writeFileSync(join(dirname(descriptorPath), "sand-secrets.json"), JSON.stringify(secrets));
  if (descriptor !== undefined) writeFileSync(descriptorPath, JSON.stringify(descriptor));
  return home;
}

function accountsDoc(entries, active) {
  return {
    version: 1,
    "cursor-accounts": JSON.stringify({ active, accounts: entries }),
  };
}

function savedEntry(token, email) {
  return {
    "cursor-access-token": `plaintext:v1:${token}`,
    "cursor-refresh-token": "refresh-secret-do-not-touch",
    ...(email === undefined ? {} : {
      "cursor-account-profile": `plaintext:v1:${JSON.stringify({ email, name: "Synthetic", avatar: "" })}`,
    }),
  };
}

function descriptorEntry(payload) {
  return { encrypted: encrypt(JSON.stringify(payload)), savedAtMs: 1 };
}

function options(home, extra = {}) {
  return {
    platform: "darwin",
    home,
    env: { HOME: home, GROK_BOT_TEST: "1", ...(extra.env ?? {}) },
    getKeychainPassword: () => "demo-password",
    now: () => 1_700_000_000_000,
    ...extra,
  };
}

function withEnv(values, fn) {
  const prev = {};
  for (const key of Object.keys(values)) {
    prev[key] = process.env[key];
    const value = values[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
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
  if (result && typeof result.then === "function") return result.finally(restore);
  restore();
  return result;
}

function gatewayEnv(home, extra = {}) {
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: null,
    XDG_CONFIG_HOME: null,
    GROK_BOT_TEST: "1",
    CURSOR_API_BASE_URL: "http://127.0.0.1:1340",
    CURSOR_ACCESS_TOKEN: null,
    GBOT_ACCOUNT: null,
    GBOT_CONFIG: null,
    GBOT_ACCOUNT_SCOPE: null,
    GROK_BOT_GATEWAY_URL: null,
    GROK_BOT_GATEWAY_TOKEN: null,
    GROK_BOT_ALLOW_ANY_GATEWAY: null,
    GBOT_AUTO_WAKE: null,
    ...extra,
  };
}

function assertClean(text, secrets) {
  const blob = String(text);
  for (const secret of secrets) {
    assert.equal(blob.includes(secret), false, blob);
  }
}

test("EnsureSandBox errors redact the app, gateway, and network tokens", async (t) => {
  const home = homeWith();
  const appToken = jwt("user_synthetic_r2_leak");
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        message: `backend said ${appToken} ${GATEWAY_TOKEN} ${NETWORK_TOKEN}`,
        gatewayToken: GATEWAY_TOKEN,
        anyrunNetworkToken: NETWORK_TOKEN,
      }), { status: 500 });
    }
    throw new Error(`network down ${appToken}`);
  });
  await withEnv(gatewayEnv(home, { CURSOR_ACCESS_TOKEN: appToken }), async () => {
    await assert.rejects(connectGateway(), (error) => {
      const packed = JSON.stringify({ error: error.message });
      assertClean(error.message, [appToken, TOKEN_MARK, GATEWAY_TOKEN, NETWORK_TOKEN]);
      assertClean(packed, [appToken, TOKEN_MARK, GATEWAY_TOKEN, NETWORK_TOKEN]);
      assertClean(error.stack, [appToken, TOKEN_MARK, GATEWAY_TOKEN, NETWORK_TOKEN]);
      return true;
    });
    await assert.rejects(connectGateway(), (error) => {
      assertClean(error.message + JSON.stringify({ error: error.message }) + error.stack, [appToken, TOKEN_MARK]);
      return true;
    });
  });
});

test("two accounts in one process each hit their own gateway", async (t) => {
  const subA = "user_synthetic_r2_a";
  const subB = "user_synthetic_r2_b";
  const scopeA = scopeFor(subA);
  const scopeB = scopeFor(subB);
  const tokenA = jwt(subA);
  const tokenB = jwt(subB);
  const home = homeWith({
    secrets: accountsDoc({
      [scopeA]: savedEntry(tokenA, "a@example.com"),
      [scopeB]: savedEntry(tokenB, "b@example.com"),
    }, scopeA),
  }, process.platform);
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = String(url);
    seen.push(target);
    if (target.includes("EnsureSandBox")) {
      const bearer = String(init?.headers?.authorization ?? "");
      const gatewayUrl = bearer.includes(tokenA) ? "http://127.0.0.1:1401" : "http://127.0.0.1:1402";
      return new Response(JSON.stringify({
        runState: "SAND_BOX_RUN_STATE_RUNNING",
        gatewayUrl,
        gatewayToken: bearer.includes(tokenA) ? "gateway-a" : "gateway-b",
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ agents: [] }), { status: 200 });
  });
  await withEnv(gatewayEnv(home), async () => {
    const first = await connectGateway({ account: scopeA });
    const second = await connectGateway({ account: scopeB });
    const third = await connectGateway({ account: scopeA });
    assert.equal(first.gatewayUrl, "http://127.0.0.1:1401");
    assert.equal(second.gatewayUrl, "http://127.0.0.1:1402");
    assert.equal(third.gatewayUrl, "http://127.0.0.1:1401");
    assert.equal(seen.filter((url) => url.includes("EnsureSandBox")).length, 2);
    await listAgents(first).catch(() => {});
    await listAgents(second).catch(() => {});
    assert.ok(seen.some((url) => url.startsWith("http://127.0.0.1:1401/")));
    assert.ok(seen.some((url) => url.startsWith("http://127.0.0.1:1402/")));
    assert.equal(
      relayProfile({ GROK_BOT_TEST: "1", GBOT_ACCOUNT: "work", GBOT_CONFIG: "/tmp/a.json" }, scopeA),
      relayProfile({ GROK_BOT_TEST: "1", GBOT_ACCOUNT: "a@example.com", GBOT_CONFIG: "/tmp/b.json" }, scopeA),
    );
    assert.notEqual(relayProfile({ GROK_BOT_TEST: "1" }, scopeA), relayProfile({ GROK_BOT_TEST: "1" }, scopeB));
    process.env.GBOT_ACCOUNT_SCOPE = scopeA;
    const pinned = await connectGateway();
    assert.equal(pinned.gatewayUrl, "http://127.0.0.1:1401");
    assert.equal(seen.filter((url) => url.includes("EnsureSandBox")).length, 2);
  });
});

test("a relay binding records the scope relayLocation resolved", {
  skip: process.platform === "win32" ? "Unix relay sockets are unsupported on win32" : false,
}, async (t) => {
  const { fakeAppServer } = await import("./helpers/codex-server.js");
  const { openRelayEngine } = await import("../src/core/relay/engine.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const scope = "a".repeat(64);
  const dir = await mkdtemp(join(tmpdir(), "relay-r3-scope-"));
  const fake = await fakeAppServer({
    initialize: (_, ok) => ok({}),
    "thread/resume": (p, ok) => ok({
      thread: { id: p.threadId, cwd: process.cwd(), status: { type: "idle" } },
      cwd: process.cwd(),
    }),
    "thread/turns/list": (_, ok) => ok({ data: [], nextCursor: null }),
    "thread/items/list": (_, ok) => ok({ data: [], nextCursor: null }),
  });
  const gateway = {
    resolve: async (ref) => ({ id: ref, name: "Fixture" }),
    tail: async () => ({ entries: [] }),
    send: async () => ({ delivery: "unknown" }),
  };
  const env = {
    HOME: dir,
    USERPROFILE: dir,
    CODEX_HOME: fake.home,
    GROK_BOT_TEST: "1",
    GBOT_ACCOUNT_SCOPE: scope,
    GROK_BOT_RELAY_DIR: dir,
  };
  const located = relayLocation({ env });
  const engine = await openRelayEngine({
    stateDir: located.stateDir,
    profile: located.profile,
    env: located.env,
    accountScope: located.accountScope,
    gateway,
    clock: () => 1000,
  });
  t.after(async () => {
    await engine.close().catch(() => {});
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });
  const binding = await engine.startBinding({
    grokTarget: "target",
    codexThreadId: "thread",
    requestId: "link-scope",
  });
  assert.equal(binding.accountScope, scope);
  const status = await engine.tick();
  assert.equal(status.state, "running");
  assert.equal(status.reason, null);
});

test("an old-format pinned relay directory is Relay profile mismatch, not a paused adoption", {
  skip: process.platform === "win32" ? "Unix relay sockets are unsupported on win32" : false,
}, async (t) => {
  const { fakeAppServer } = await import("./helpers/codex-server.js");
  const { openRelayEngine } = await import("../src/core/relay/engine.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const scope = "c".repeat(64);
  const other = "d".repeat(64);
  const dir = await mkdtemp(join(tmpdir(), "relay-r3-old-"));
  const fake = await fakeAppServer({
    initialize: (_, ok) => ok({}),
    "thread/resume": (p, ok) => ok({
      thread: { id: p.threadId, cwd: process.cwd(), status: { type: "idle" } },
      cwd: process.cwd(),
    }),
    "thread/turns/list": (_, ok) => ok({ data: [], nextCursor: null }),
    "thread/items/list": (_, ok) => ok({ data: [], nextCursor: null }),
  });
  const gateway = {
    resolve: async (ref) => ({ id: ref, name: "Fixture" }),
    tail: async () => ({ entries: [] }),
    send: async () => ({ delivery: "unknown" }),
  };
  const env = {
    HOME: dir,
    USERPROFILE: dir,
    CODEX_HOME: fake.home,
    GROK_BOT_TEST: "1",
    GBOT_ACCOUNT_SCOPE: scope,
    GROK_BOT_RELAY_DIR: dir,
  };
  const located = relayLocation({ env });
  assert.equal(located.stateDir, resolve(dir));
  assert.equal(located.accountScope, scope);
  assert.equal(located.profile, relayProfile(located.env, scope));
  const legacyProfile = "legacy-pinned-profile";
  assert.notEqual(legacyProfile, located.profile);
  const legacyEnv = { CODEX_HOME: fake.home, GROK_BOT_TEST: "1" };
  const legacy = await openRelayEngine({
    stateDir: dir,
    profile: legacyProfile,
    env: legacyEnv,
    gateway,
    clock: () => 1000,
  });
  t.after(async () => {
    await legacy.close().catch(() => {});
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });
  const binding = await legacy.startBinding({
    grokTarget: "target",
    codexThreadId: "thread",
    requestId: "link-old",
  });
  assert.equal(binding.accountScope, undefined);
  await legacy.close();
  await assert.rejects(
    openRelayEngine({
      stateDir: located.stateDir,
      profile: located.profile,
      env: located.env,
      accountScope: located.accountScope,
      gateway,
      clock: () => 1000,
    }),
    /Relay profile mismatch/,
  );
  const unchanged = await openRelayEngine({
    stateDir: dir,
    profile: legacyProfile,
    env: legacyEnv,
    gateway,
    clock: () => 1000,
  });
  t.after(async () => { await unchanged.close().catch(() => {}); });
  const status = unchanged.status();
  assert.equal(status.state, "running");
  assert.equal(status.reason, null);
  assert.equal(status.bindings.find((row) => row.id === binding.id).accountScope, undefined);
  await unchanged.close();
  const otherLocated = relayLocation({ env: { ...env, GBOT_ACCOUNT_SCOPE: other } });
  assert.notEqual(otherLocated.profile, located.profile);
  await assert.rejects(
    openRelayEngine({
      stateDir: dir,
      profile: otherLocated.profile,
      env: otherLocated.env,
      accountScope: otherLocated.accountScope,
      gateway,
      clock: () => 1000,
    }),
    /Relay profile mismatch/,
  );
});

test("no account uses the descriptor's single entry when another saved login exists", () => {
  const described = scopeFor("user_synthetic_r2_described");
  const extra = scopeFor("user_synthetic_r2_extra");
  const home = homeWith({
    secrets: accountsDoc({
      [described]: savedEntry(jwt("user_synthetic_r2_described"), "described@example.com"),
      [extra]: savedEntry(jwt("user_synthetic_r2_extra"), "extra@example.com"),
    }, extra),
    descriptor: {
      version: 2,
      entries: {
        [described]: descriptorEntry({
          baseUrl: "https://box.example",
          token: "descriptor-gateway-token",
          headers: {},
          name: "Desk",
        }),
      },
    },
  });
  const choice = resolveGrokBotLogin(options(home));
  assert.equal(choice.scope, described);
  assert.equal(choice.selectedBy, "implicit");
  assert.equal(choice.label, "Desk");
});

test("a missing selector does not fall back to CURSOR_ACCESS_TOKEN, and an expired implicit login does", async (t) => {
  const sub = "user_synthetic_r2_expired";
  const scope = scopeFor(sub);
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: savedEntry(jwt(sub, 1_000_000_000), "expired@example.com"),
    }, scope),
  }, process.platform);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(String(init?.headers?.authorization ?? ""));
    return new Response(JSON.stringify({
      runState: "SAND_BOX_RUN_STATE_RUNNING",
      gatewayUrl: "http://127.0.0.1:1410",
      gatewayToken: "from-env",
    }), { status: 200 });
  });
  await withEnv(gatewayEnv(home, { CURSOR_ACCESS_TOKEN: "cursor-access-token-synthetic" }), async () => {
    await assert.rejects(connectGateway({ account: "missing@example.com" }), (error) => {
      assert.equal(error.code, "UNKNOWN_ACCOUNT");
      return true;
    });
    assert.equal(calls.length, 0);
    calls.length = 0;
    await assert.rejects(connectGateway({ account: scope }), (error) => {
      assert.equal(error.code, "EXPIRED");
      return true;
    });
    assert.equal(calls.length, 0);
    const session = await connectGateway();
    assert.equal(session.gatewayUrl, "http://127.0.0.1:1410");
    assert.ok(calls.some((header) => header.includes("cursor-access-token-synthetic")));
    assert.equal(calls.some((header) => header.includes(TOKEN_MARK)), false);
  });
});

test("prototype alias names are rejected and do not affect lookup", async () => {
  const { isReservedAliasName } = await import("../src/core/gbot-config.js");
  assert.equal(typeof isReservedAliasName, "function");
  assert.equal(isReservedAliasName("__proto__"), true);
  assert.equal(isReservedAliasName("constructor"), true);
  assert.equal(isReservedAliasName("prototype"), true);
  assert.equal(isReservedAliasName("toString"), true);
  const home = homeWith({
    secrets: accountsDoc({
      [scopeFor("user_synthetic_r2_proto")]: savedEntry(jwt("user_synthetic_r2_proto"), "proto@example.com"),
    }, scopeFor("user_synthetic_r2_proto")),
  });
  const base = options(home);
  assert.throws(() => defineAlias({ ...base, name: "constructor", selector: "proto@example.com" }), (error) => {
    assert.equal(error.exitCode, 2);
    return true;
  });
  const file = join(home, "proto.json");
  writeFileSync(file, `{"version":1,"default":null,"aliases":{"__proto__":{"scope":"${"a".repeat(64)}","email":"a@example.com"},"constructor":{"scope":"${"b".repeat(64)}"}}}
`);
  const imported = importAccountConfig({ ...base, file });
  assert.equal(imported.exitCode, 2);
  const empty = readGbotConfig(base);
  assert.equal(Object.getPrototypeOf(empty.aliases), null);
  assert.throws(() => resolveGrokBotLogin({ ...base, account: "constructor" }), (error) => error.code === "UNKNOWN_ACCOUNT");
});

test("a failed rename keeps the previous config", async () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-r2-rename-"));
  const base = { platform: "darwin", home, env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") } };
  writeGbotConfig({
    version: 1,
    aliases: { work: { scope: "ab".repeat(32), email: "work@example.com" } },
    default: "work",
  }, base);
  const path = join(home, ".config", "grok-bot-cli", "config.json");
  const before = readFileSync(path, "utf8");
  const { writeIo } = await import("../src/core/gbot-config.js");
  assert.equal(typeof writeIo?.renameSync, "function");
  const original = writeIo.renameSync;
  writeIo.renameSync = () => {
    throw new Error("rename failed");
  };
  try {
    assert.throws(() => writeGbotConfig({
      version: 1,
      aliases: { work: { scope: "cd".repeat(32), email: "other@example.com" } },
      default: "work",
    }, base), /rename failed/);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(readdirSync(dirname(path)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    writeIo.renameSync = original;
  }
});

test("a profile email does not replace the descriptor label", () => {
  const sub = "user_synthetic_r2_label";
  const scope = scopeFor(sub);
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: savedEntry(jwt(sub), "work@example.com"),
    }, scope),
    descriptor: {
      version: 2,
      entries: {
        [scope]: descriptorEntry({
          baseUrl: "https://box.example",
          token: "descriptor-gateway-token",
          headers: {},
          name: "Work",
        }),
      },
    },
  });
  const [row] = listLoginCatalog(options(home));
  assert.equal(row.label, "Work");
  assert.equal(row.email, "work@example.com");
  assert.equal(resolveGrokBotLogin({ ...options(home), account: "Work" }).scope, scope);
  const text = formatLoginCatalog([row]);
  assert.match(text, /Work/);
  assert.match(text, /email work@example.com/);
});

test("a v1 descriptor and its saved login are one account", () => {
  const sub = "user_synthetic_r2_v1";
  const scope = scopeFor(sub);
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: savedEntry(jwt(sub), "v1@example.com"),
    }, scope),
    descriptor: {
      version: 1,
      encrypted: encrypt(JSON.stringify({
        baseUrl: "https://box.example",
        token: "descriptor-gateway-token",
        headers: {},
        name: "Legacy",
        accountScope: scope,
      })),
    },
  });
  const rows = listLoginCatalog(options(home));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "default");
  assert.equal(rows[0].scope, scope);
  assert.equal(resolveGrokBotLogin(options(home)).id, "default");
});

test("secret labels are masked in the account catalog and the wake selection", () => {
  const sub = "user_synthetic_r2_mask";
  const scope = scopeFor(sub);
  const secret = "gateway-token-secret";
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: savedEntry(jwt(sub), "mask@example.com"),
    }, scope),
    descriptor: {
      version: 2,
      entries: {
        [scope]: descriptorEntry({
          baseUrl: "https://box.example",
          token: secret,
          headers: {},
          email: secret,
        }),
      },
    },
  });
  const rows = listLoginCatalog(options(home));
  assert.equal(rows[0].label, "login 1");
  assertClean(formatLoginCatalog(rows), [secret]);
  const selection = loadGrokBotGatewaySelection({ ...options(home), account: scope });
  assert.equal(selection.label, "login 1");
  assertClean(JSON.stringify({ label: selection.label, id: selection.id }), [secret]);
});

test("GBOT_AUTO_WAKE=0 does not wake a saved-only login", async (t) => {
  const sub = "user_synthetic_r2_asleep";
  const scope = scopeFor(sub);
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: savedEntry(jwt(sub), "asleep@example.com"),
    }, scope),
  }, process.platform);
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ runState: "SAND_BOX_RUN_STATE_HIBERNATED" }), { status: 200 });
  });
  await withEnv(gatewayEnv(home, { GBOT_AUTO_WAKE: "0" }), async () => {
    await assert.rejects(connectGateway({ account: scope }), /GBOT_AUTO_WAKE=0/);
  });
  assert.deepEqual(bodies, [{ wake: false }]);
});

test("token presence does not decrypt, and one password read serves the catalog", async () => {
  const sub = "user_synthetic_r2_key";
  const scope = scopeFor(sub);
  let reads = 0;
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: {
        "cursor-access-token": encrypt(jwt(sub)),
        "cursor-refresh-token": encrypt("refresh-secret-do-not-touch"),
        "cursor-account-profile": encrypt(JSON.stringify({ email: "key@example.com" })),
      },
    }, scope),
    descriptor: {
      version: 2,
      entries: {
        [scope]: descriptorEntry({
          baseUrl: "https://box.example",
          token: "descriptor-gateway-token",
          headers: {},
          name: "Key",
        }),
      },
    },
  });
  const base = options(home, {
    getKeychainPassword: () => {
      reads += 1;
      return "demo-password";
    },
  });
  const { hasSavedAccessToken } = await import("../src/core/logins.js");
  assert.equal(typeof hasSavedAccessToken, "function");
  assert.equal(hasSavedAccessToken({ ...base, getKeychainPassword: () => { throw new Error("decrypt"); } }), true);
  const before = reads;
  listLoginCatalog(base);
  assert.equal(reads - before, 1);
});

test("merge keeps a local default when the file's default is null", () => {
  const scope = "ab".repeat(32);
  const home = mkdtempSync(join(tmpdir(), "gbot-r2-merge-"));
  const base = {
    platform: "darwin",
    home,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GROK_BOT_TEST: "1" },
    getKeychainPassword: () => { throw new Error("keychain"); },
  };
  writeGbotConfig({
    version: 1,
    aliases: { work: { scope, email: "work@example.com" } },
    default: "work",
  }, base);
  const file = join(home, "incoming.json");
  writeFileSync(file, JSON.stringify({
    version: 1,
    default: null,
    aliases: { phone: { scope: "cd".repeat(32), email: "phone@example.com" } },
  }));
  const merged = importAccountConfig({ ...base, file });
  assert.equal(merged.exitCode, 3);
  assert.equal(readGbotConfig(base).default, "work");
  assert.equal(readGbotConfig(base).aliases.phone.email, "phone@example.com");
});

test("a broken config fails closed unless the selector matches a login", () => {
  const sub = "user_synthetic_r2_broken";
  const scope = scopeFor(sub);
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: savedEntry(jwt(sub), "broken@example.com"),
    }, scope),
    descriptor: {
      version: 2,
      entries: {
        [scope]: descriptorEntry({
          baseUrl: "https://box.example",
          token: "descriptor-gateway-token",
          headers: {},
          name: "Broken",
        }),
      },
    },
  });
  const configDir = join(home, ".config", "grok-bot-cli");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), "{");
  const base = options(home);
  assert.throws(() => resolveGrokBotLogin(base), (error) => error.name === "GbotConfigError" && error.exitCode === 2);
  assert.equal(resolveGrokBotLogin({ ...base, account: "Broken" }).scope, scope);
  const file = join(home, "ok.json");
  writeFileSync(file, JSON.stringify({
    version: 1,
    default: null,
    aliases: { work: { scope, email: "broken@example.com" } },
  }));
  assert.equal(importAccountConfig({ ...base, file }).exitCode, 2);
  assert.equal(importAccountConfig({ ...base, file, replace: true }).exitCode, 0);
  writeFileSync(file, JSON.stringify({
    version: 1,
    default: null,
    aliases: { work: { scope, email: "bad\u0007@example.com" } },
    gbotVersion: 12,
  }));
  const rejected = importAccountConfig({ ...base, file, replace: true });
  assert.equal(rejected.exitCode, 2);
  assert.equal(rejected.messages.join("\n").includes("\u0007"), false);
});

test("imported and profile emails cannot inject control characters", () => {
  const sub = "user_synthetic_r2_ctrl";
  const scope = scopeFor(sub);
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: savedEntry(jwt(sub), "a\u0007@example.com"),
    }, scope),
  });
  const [row] = listLoginCatalog(options(home));
  assert.equal(String(row.email).includes("\u0007"), false);
  assert.match(row.email, /a\?@example.com/);
  assert.equal(formatLoginCatalog([row]).includes("\u0007"), false);
});

test("doctor and wear pair resolve alias selectors in the command source", () => {
  const doctor = readFileSync(join(root, "src/cli/doctor.tsx"), "utf8");
  const wear = readFileSync(join(root, "src/cli/wear/pair.tsx"), "utf8");
  const wake = readFileSync(join(root, "src/cli/wake.tsx"), "utf8");
  assert.match(doctor, /resolveGrokBotLogin/);
  assert.match(doctor, /Does not use the config default/);
  assert.match(wear, /resolveGrokBotLogin/);
  assert.match(wear, /config default are ignored/);
  assert.match(wake, /code === 'INVALID'/);
  assert.match(readFileSync(join(root, "src/cli/accounts.tsx"), "utf8"), /shownId/);
});

test("an explicit config default that misses does not use another login", () => {
  const scope = scopeFor("user_synthetic_r2_default");
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: savedEntry(jwt("user_synthetic_r2_default"), "real@example.com"),
    }, scope),
  });
  const base = options(home, { env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GROK_BOT_TEST: "1" } });
  writeGbotConfig({
    version: 1,
    aliases: { gone: { scope: "e".repeat(64), email: "gone@example.com" } },
    default: "gone",
  }, base);
  assert.throws(() => resolveGrokBotLogin(base), (error) => error.code === "UNKNOWN_ACCOUNT");
  assert.throws(() => setDefaultAccount({ ...base, name: "toString" }), (error) => error.exitCode === 2);
});

function sealedDescriptor(payload, platform = process.platform) {
  return { encrypted: encryptForPlatform(JSON.stringify(payload), platform) };
}

test("a rewritten descriptor is used on the next connectGateway", {
  skip: process.platform === "win32" ? "CBC fixture; Windows DPAPI is covered in app-session.test.js" : false,
}, async () => {
  const platform = process.platform;
  const scope = scopeFor("user_synthetic_r2_rewrite");
  const home = homeWith({
    descriptor: {
      version: 2,
      entries: {
        [scope]: {
          ...sealedDescriptor({
            baseUrl: "http://127.0.0.1:1341",
            token: "descriptor-token-old",
            headers: {},
            name: "Desk",
          }, platform),
          savedAtMs: 1,
        },
      },
    },
  }, platform);
  const path = grokBotGatewayDescriptorPath(home, platform, {});
  await withEnv(gatewayEnv(home, { GBOT_TEST_KEYCHAIN_PASSWORD: "demo-password" }), async () => {
    const first = await connectGateway();
    assert.equal(first.gatewayToken, "descriptor-token-old");
    writeFileSync(path, JSON.stringify({
      version: 2,
      entries: {
        [scope]: {
          ...sealedDescriptor({
            baseUrl: "http://127.0.0.1:1341",
            token: "descriptor-token-new",
            headers: {},
            name: "Desk",
          }, platform),
          savedAtMs: 2,
        },
      },
    }));
    const second = await connectGateway();
    assert.equal(second.gatewayToken, "descriptor-token-new");
  });
});

test("a saved-login session is rebuilt once after 401", async (t) => {
  const sub = "user_synthetic_r2_refresh";
  const scope = scopeFor(sub);
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: savedEntry(jwt(sub), "refresh@example.com"),
    }, scope),
  }, process.platform);
  const ensured = [];
  let gatewayCalls = 0;
  let failFresh = false;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = String(url);
    if (target.includes("EnsureSandBox")) {
      ensured.push(JSON.parse(init.body));
      const token = ensured.length === 1 ? "gateway-stale" : ensured.length === 2 ? "gateway-fresh" : "gateway-again";
      return new Response(JSON.stringify({
        runState: "SAND_BOX_RUN_STATE_RUNNING",
        gatewayUrl: "http://127.0.0.1:1410",
        gatewayToken: token,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    gatewayCalls += 1;
    const bearer = String(init?.headers?.authorization ?? "");
    if (bearer.includes("gateway-stale") || (failFresh && bearer.includes("gateway-fresh")) || bearer.includes("gateway-again")) {
      return new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
    }
    if (bearer.includes("could-not-route")) {
      return new Response("request could not be routed", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return new Response(JSON.stringify({ agents: [] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await withEnv(gatewayEnv(home), async () => {
    const session = await connectGateway();
    assert.equal(session.gatewayToken, "gateway-stale");
    const agents = await listAgents(session);
    assert.deepEqual(agents, []);
    assert.equal(session.gatewayToken, "gateway-fresh");
    assert.equal(ensured.length, 2);
    assert.equal(gatewayCalls, 2);
    failFresh = true;
    await assert.rejects(listAgents(session), (error) => error.status === 401 && error.kind === "auth");
    assert.equal(ensured.length, 3);
    assert.equal(gatewayCalls, 4);
    assert.equal(session.gatewayToken, "gateway-again");
  });
});

test("a saved-login session is rebuilt once after a routing failure", async (t) => {
  const sub = "user_synthetic_r2_route";
  const scope = scopeFor(sub);
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: savedEntry(jwt(sub), "route@example.com"),
    }, scope),
  }, process.platform);
  const ensured = [];
  let gatewayCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = String(url);
    if (target.includes("EnsureSandBox")) {
      ensured.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        runState: "SAND_BOX_RUN_STATE_RUNNING",
        gatewayUrl: "http://127.0.0.1:1411",
        gatewayToken: ensured.length === 1 ? "gateway-moved" : "gateway-moved-ok",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    gatewayCalls += 1;
    const bearer = String(init?.headers?.authorization ?? "");
    if (bearer.includes("gateway-moved-ok")) {
      return new Response(JSON.stringify({ agents: [{ id: "bot-1", name: "Bot" }] }), { status: 200 });
    }
    return new Response("the request could not be routed", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  });
  await withEnv(gatewayEnv(home), async () => {
    const session = await connectGateway();
    const agents = await listAgents(session);
    assert.equal(agents.length, 1);
    assert.equal(session.gatewayToken, "gateway-moved-ok");
    assert.equal(ensured.length, 2);
    assert.equal(gatewayCalls, 2);
  });
});

function savedLoginHome(sub, email) {
  return homeWith({
    secrets: accountsDoc({
      [scopeFor(sub)]: savedEntry(jwt(sub), email),
    }, scopeFor(sub)),
  }, process.platform);
}

function runningSandbox(token, port) {
  return new Response(JSON.stringify({
    runState: "SAND_BOX_RUN_STATE_RUNNING",
    gatewayUrl: `http://127.0.0.1:${port}`,
    gatewayToken: token,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("a 401 whose saved-login rebuild fails stays delivery rejected for gbot send", async (t) => {
  const sub = "user_synthetic_r3_send_reject";
  const home = savedLoginHome(sub, "reject@example.com");
  const ensured = [];
  const prompts = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = String(url);
    if (target.includes("EnsureSandBox")) {
      ensured.push(JSON.parse(init.body));
      if (ensured.length === 1) return runningSandbox("gateway-stale-send", 1420);
      return new Response("sandbox down", { status: 500, headers: { "content-type": "text/plain" } });
    }
    const body = init?.body ? JSON.parse(init.body) : {};
    if (target.endsWith("/api/listAgents")) {
      return new Response(JSON.stringify({ agents: [{ id: "bot-1", name: "Bot" }] }), { status: 200 });
    }
    prompts.push(body);
    return new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
  });
  await withEnv(gatewayEnv(home), async () => {
    const session = await connectGateway();
    await assert.rejects(sendPrompt(session, "Bot", "hello", { clientNonce: "nonce-reject" }), (error) => {
      const outcome = outcomeFromError(error);
      assert.equal(error.status, 401);
      assert.equal(error.kind, "auth");
      assert.equal(error.delivery, "rejected");
      assert.equal(outcome.delivery, "rejected");
      assert.equal(error.clientNonce, "nonce-reject");
      assert.doesNotMatch(error.message, /delivery unknown/);
      assert.equal(error.rebuildError.includes("synthetic-r2-token-do-not-leak"), false);
      return true;
    });
  });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].clientNonce, "nonce-reject");
  assert.equal(ensured.length, 2);
});

test("a saved-login sendPrompt rebuild retries once with the same client nonce", async (t) => {
  const sub = "user_synthetic_r3_send_retry";
  const home = savedLoginHome(sub, "retry@example.com");
  const ensured = [];
  const prompts = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = String(url);
    if (target.includes("EnsureSandBox")) {
      ensured.push(JSON.parse(init.body));
      return runningSandbox(ensured.length === 1 ? "gateway-send-stale" : "gateway-send-fresh", 1421);
    }
    const body = init?.body ? JSON.parse(init.body) : {};
    const bearer = String(init?.headers?.authorization ?? "");
    if (target.endsWith("/api/listAgents")) {
      return new Response(JSON.stringify({ agents: [{ id: "bot-1", name: "Bot" }] }), { status: 200 });
    }
    prompts.push({ body, bearer });
    if (bearer.includes("gateway-send-fresh")) {
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }
    return new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
  });
  await withEnv(gatewayEnv(home), async () => {
    const session = await connectGateway();
    const sent = await sendPrompt(session, "Bot", "hello", { clientNonce: "nonce-retry" });
    assert.equal(sent.delivery, "accepted");
    assert.equal(sent.clientNonce, "nonce-retry");
  });
  assert.equal(ensured.length, 2);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].body.clientNonce, "nonce-retry");
  assert.equal(prompts[1].body.clientNonce, "nonce-retry");
  assert.match(prompts[1].bearer, /gateway-send-fresh/);
});

test("a sendPrompt 5xx is not rebuilt or resent", async (t) => {
  const sub = "user_synthetic_r3_send_5xx";
  const home = savedLoginHome(sub, "five@example.com");
  const ensured = [];
  const prompts = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = String(url);
    if (target.includes("EnsureSandBox")) {
      ensured.push(JSON.parse(init.body));
      return runningSandbox("gateway-send-5xx", 1422);
    }
    const body = init?.body ? JSON.parse(init.body) : {};
    if (target.endsWith("/api/listAgents")) {
      return new Response(JSON.stringify({ agents: [{ id: "bot-1", name: "Bot" }] }), { status: 200 });
    }
    prompts.push(body);
    return new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } });
  });
  await withEnv(gatewayEnv(home), async () => {
    const session = await connectGateway();
    await assert.rejects(sendPrompt(session, "Bot", "hello", { clientNonce: "nonce-5xx" }), (error) => {
      assert.equal(error.delivery, "unknown");
      assert.equal(error.status, 503);
      return true;
    });
  });
  assert.equal(prompts.length, 1);
  assert.equal(ensured.length, 1);
});

test("a relay records delivery rejected when a 401 rebuild fails", {
  skip: process.platform === "win32" ? "Unix relay sockets are unsupported on win32" : false,
}, async (t) => {
  const { fakeAppServer } = await import("./helpers/codex-server.js");
  const { openRelayEngine } = await import("../src/core/relay/engine.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const sub = "user_synthetic_r3_relay_reject";
  const home = savedLoginHome(sub, "relay-reject@example.com");
  const dir = await mkdtemp(join(tmpdir(), "relay-r3-reject-"));
  const ensured = [];
  const prompts = [];
  const fake = await fakeAppServer({
    initialize: (_, ok) => ok({}),
    "thread/resume": (p, ok) => ok({
      thread: { id: p.threadId, cwd: process.cwd(), status: { type: "idle" } },
      cwd: process.cwd(),
    }),
    "thread/turns/list": (_, ok) => ok({ data: [], nextCursor: null }),
    "thread/items/list": (_, ok) => ok({ data: [], nextCursor: null }),
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = String(url);
    if (target.includes("EnsureSandBox")) {
      ensured.push(JSON.parse(init.body));
      if (ensured.length === 1) return runningSandbox("gateway-relay-stale", 1423);
      return new Response("sandbox down", { status: 500, headers: { "content-type": "text/plain" } });
    }
    const body = init?.body ? JSON.parse(init.body) : {};
    if (target.endsWith("/api/listAgents")) {
      return new Response(JSON.stringify({ agents: [{ id: "bot-1", name: "Bot" }] }), { status: 200 });
    }
    prompts.push(body);
    return new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
  });
  const gateway = {
    resolve: async (ref) => ({ id: ref, name: "Fixture" }),
    tail: async () => ({ entries: [] }),
    send: (id, text, extra) => sendPrompt(extra.session, id, text, extra),
  };
  let engine;
  t.after(async () => {
    await engine?.close().catch(() => {});
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });
  await withEnv(gatewayEnv(home, { CODEX_HOME: fake.home }), async () => {
    const session = await connectGateway();
    gateway.send = (id, text, extra) => sendPrompt(session, id, text, extra);
    engine = await openRelayEngine({
      stateDir: dir,
      profile: "relay-r3-reject",
      env: { CODEX_HOME: fake.home, GROK_BOT_TEST: "1" },
      gateway,
      clock: () => 1000,
    });
    const binding = await engine.startBinding({
      grokTarget: "bot-1",
      codexThreadId: "thread",
      requestId: "link-reject",
    });
    const receipt = await engine.sendToGrok({
      bindingId: binding.id,
      message: "hello",
      requestId: "send-reject",
    });
    assert.equal(receipt.delivery, "rejected");
    assert.notEqual(receipt.reason, "delivery-unknown");
  });
  assert.equal(prompts.length, 1);
  assert.equal(ensured.length, 2);
});

test("a v1 descriptor that contradicts the only saved login is not merged", {
  skip: process.platform === "win32" ? "CBC fixture; Windows DPAPI is covered in app-session.test.js" : false,
}, async (t) => {
  const platform = process.platform;
  const savedSub = "user_synthetic_r2_contradict";
  const savedScope = scopeFor(savedSub);
  const otherScope = "e".repeat(64);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("descriptor session must not call EnsureSandBox");
  });
  const emailHome = homeWith({
    secrets: accountsDoc({
      [savedScope]: savedEntry(jwt(savedSub), "saved@example.com"),
    }, savedScope),
    descriptor: {
      version: 1,
      ...sealedDescriptor({
        baseUrl: "http://127.0.0.1:1341",
        token: "descriptor-email-token",
        headers: {},
        name: "Legacy",
        email: "other@example.com",
      }, platform),
    },
  }, platform);
  const emailRows = listLoginCatalog(options(emailHome, { platform }));
  assert.equal(emailRows.length, 2);
  const emailDescriptor = emailRows.find((row) => row.id === "default");
  const emailSaved = emailRows.find((row) => row.id === savedScope);
  assert.equal(emailDescriptor.scope, null);
  assert.equal(emailSaved.scope, savedScope);
  await withEnv(gatewayEnv(emailHome, { GBOT_TEST_KEYCHAIN_PASSWORD: "demo-password" }), async () => {
    const session = await connectGateway();
    assert.equal(session.gatewayToken, "descriptor-email-token");
    assert.equal(session.accountScope, undefined);
  });

  const scopeHome = homeWith({
    secrets: accountsDoc({
      [savedScope]: savedEntry(jwt(savedSub), "saved@example.com"),
    }, savedScope),
    descriptor: {
      version: 1,
      ...sealedDescriptor({
        baseUrl: "http://127.0.0.1:1341",
        token: "descriptor-scope-token",
        headers: {},
        name: "Legacy",
        accountScope: otherScope,
      }, platform),
    },
  }, platform);
  const scopeRows = listLoginCatalog(options(scopeHome, { platform }));
  assert.equal(scopeRows.length, 2);
  assert.equal(scopeRows.find((row) => row.id === "default").scope, otherScope);
  assert.equal(scopeRows.find((row) => row.id === savedScope).scope, savedScope);
  await withEnv(gatewayEnv(scopeHome, { GBOT_TEST_KEYCHAIN_PASSWORD: "demo-password" }), async () => {
    const session = await connectGateway();
    assert.equal(session.gatewayToken, "descriptor-scope-token");
    assert.equal(session.accountScope, otherScope);
    assert.notEqual(session.accountScope, savedScope);
  });
});

test("a descriptor scope that matches another login's email is not merged or attached", {
  skip: process.platform === "win32" ? "CBC fixture; Windows DPAPI is covered in app-session.test.js" : false,
}, async (t) => {
  const platform = process.platform;
  const savedSub = "user_synthetic_r3_same_email";
  const savedScope = scopeFor(savedSub);
  const ownScope = "f".repeat(64);
  const email = "same@example.com";
  let ensured = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (!String(url).includes("EnsureSandBox")) throw new Error(`unexpected ${url}`);
    ensured += 1;
    return runningSandbox("saved-login-gateway", 1424);
  });
  const home = homeWith({
    secrets: accountsDoc({
      [savedScope]: savedEntry(jwt(savedSub), email),
    }, savedScope),
    descriptor: {
      version: 1,
      ...sealedDescriptor({
        baseUrl: "http://127.0.0.1:1341",
        token: "descriptor-own-token",
        headers: {},
        name: "Legacy",
        email,
        accountScope: ownScope,
      }, platform),
    },
  }, platform);
  const rows = listLoginCatalog(options(home, { platform }));
  assert.equal(rows.length, 2);
  const described = rows.find((row) => row.id === "default");
  const saved = rows.find((row) => row.id === savedScope);
  assert.equal(described.scope, ownScope);
  assert.notEqual(described.scope, savedScope);
  assert.equal(saved.scope, savedScope);
  assert.equal(saved.email, email);
  await withEnv(gatewayEnv(home, { GBOT_TEST_KEYCHAIN_PASSWORD: "demo-password" }), async () => {
    const implicit = await connectGateway();
    assert.equal(implicit.gatewayToken, "descriptor-own-token");
    assert.equal(implicit.accountScope, ownScope);
    assert.notEqual(implicit.accountScope, savedScope);
    const selected = await connectGateway({ account: savedScope });
    assert.equal(selected.gatewayToken, "saved-login-gateway");
    assert.equal(selected.accountScope, savedScope);
  });
  assert.equal(ensured, 1);
});

test("GBOT_ACCOUNT_SCOPE accepts only 64 lowercase hex characters", async () => {
  const sub = "user_synthetic_r2_scopepin";
  const scope = scopeFor(sub);
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: savedEntry(jwt(sub), "pin@example.com"),
    }, scope),
  }, process.platform);
  await withEnv(gatewayEnv(home, { GBOT_ACCOUNT_SCOPE: "not-a-scope" }), async () => {
    await assert.rejects(connectGateway({ account: scope }), (error) => error.code === "INVALID_ACCOUNT_SCOPE");
  });
  assert.equal(workerAccountScope({ GBOT_ACCOUNT_SCOPE: scope }), scope);
  assert.throws(() => workerAccountScope({ GBOT_ACCOUNT_SCOPE: "A".repeat(64) }), (error) => error.code === "INVALID_ACCOUNT_SCOPE");
  assert.throws(() => workerAccountScope({ GBOT_ACCOUNT_SCOPE: `${scope} ` }), (error) => error.code === "INVALID_ACCOUNT_SCOPE");
  assert.equal(workerAccountScope({}), "");
});

test("relay account resolution fails closed on an unexpected login error", () => {
  const home = homeWith({
    descriptor: { version: 99, encrypted: "not-used" },
  }, process.platform);
  assert.throws(() => resolveRelayAccountScope({
    HOME: home,
    USERPROFILE: home,
    GROK_BOT_TEST: "1",
    GBOT_TEST_KEYCHAIN_PASSWORD: "demo-password",
  }), (error) => error.code === "UNSUPPORTED_VERSION");
});
