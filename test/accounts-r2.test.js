import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { grokBotGatewayDescriptorPath, loadGrokBotGatewaySelection } from "../src/core/app-session.js";
import { connectGateway, listAgents } from "../src/core/gateway.js";
import {
  importAccountConfig,
  readGbotConfig,
  writeGbotConfig,
} from "../src/core/gbot-config.js";
import {
  defineAlias,
  formatLoginCatalog,
  listLoginCatalog,
  resolveGrokBotLogin,
  setDefaultAccount,
} from "../src/core/logins.js";
import { relayLocation, relayProfile } from "../src/core/relay/profile.js";

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
    assert.notEqual(relayProfile({ GROK_BOT_TEST: "1" }, scopeA), relayProfile({ GROK_BOT_TEST: "1" }, scopeB));
    process.env.GBOT_ACCOUNT_SCOPE = scopeA;
    const pinned = await connectGateway();
    assert.equal(pinned.gatewayUrl, "http://127.0.0.1:1401");
    assert.equal(seen.filter((url) => url.includes("EnsureSandBox")).length, 2);
  });
});

test("a relay binding stays on the account that created it", { skip: process.platform === "win32" ? "Unix relay sockets are unsupported on win32" : false }, async (t) => {
  const { fakeAppServer } = await import("./helpers/codex-server.js");
  const { openRelayEngine } = await import("../src/core/relay/engine.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const scopeA = "a".repeat(64);
  const scopeB = "b".repeat(64);
  const dir = await mkdtemp(join(tmpdir(), "relay-r2-"));
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
  const env = { CODEX_HOME: fake.home, GROK_BOT_TEST: "1" };
  const engineA = await openRelayEngine({
    stateDir: dir,
    profile: "fixture-a",
    env,
    gateway,
    accountScope: scopeA,
    clock: () => 1000,
  });
  t.after(async () => {
    await engineA.close().catch(() => {});
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });
  const binding = await engineA.startBinding({
    grokTarget: "target",
    codexThreadId: "thread",
    requestId: "link-a",
  });
  assert.equal(binding.accountScope, scopeA);
  await engineA.close();
  const engineB = await openRelayEngine({
    stateDir: dir,
    profile: "fixture-a",
    env,
    gateway,
    accountScope: scopeB,
    clock: () => 1000,
  });
  t.after(async () => { await engineB.close().catch(() => {}); });
  await assert.rejects(engineB.tick(), /different Grok Bot account/);
  const located = relayLocation({
    stateDir: dir,
    env: { ...env, GBOT_ACCOUNT_SCOPE: scopeA },
    accountScope: scopeA,
  });
  assert.equal(located.accountScope, scopeA);
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
