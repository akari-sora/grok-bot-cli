import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { grokBotGatewayDescriptorPath } from "../src/core/app-session.js";
import { connectGateway } from "../src/core/gateway.js";
import {
  formatLoginCatalog,
  listLoginCatalog,
  listSavedLogins,
  resolveGrokBotLogin,
} from "../src/core/logins.js";

const NOW = 1_700_000_000_000;
const REFRESH = "refresh-secret-do-not-touch";
const TOKEN_MARK = "synthetic-login-token-do-not-leak";

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

function encrypt(text, password = "demo-password", platform = "darwin") {
  const linux = platform === "linux";
  const key = crypto.pbkdf2Sync(password, "saltysalt", linux ? 1 : 1003, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([Buffer.from(linux ? "v11" : "v10"), cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

function homeWith({ secrets, descriptor } = {}, platform = "darwin") {
  const home = mkdtempSync(join(tmpdir(), "gbot-logins-"));
  const descriptorPath = grokBotGatewayDescriptorPath(home, platform, {});
  mkdirSync(dirname(descriptorPath), { recursive: true });
  if (secrets !== undefined) writeFileSync(join(dirname(descriptorPath), "sand-secrets.json"), JSON.stringify(secrets));
  if (descriptor !== undefined) writeFileSync(descriptorPath, JSON.stringify(descriptor));
  return home;
}

function accountsDoc(entries, active) {
  return {
    version: 1,
    "cursor-accounts": JSON.stringify({
      active,
      accounts: entries,
    }),
  };
}

function entry(token, profile) {
  return {
    "cursor-access-token": token,
    "cursor-refresh-token": REFRESH,
    ...(profile === undefined ? {} : { "cursor-account-profile": profile }),
  };
}

function profile(email, name = "Synthetic") {
  return `plaintext:v1:${JSON.stringify({ email, name, avatar: "https://cdn.example/a.png" })}`;
}

function options(home, extra = {}) {
  return {
    platform: "darwin",
    home,
    env: { HOME: home, ...(extra.env ?? {}) },
    getKeychainPassword: () => {
      throw new Error("keychain should not be read");
    },
    now: () => NOW,
    ...extra,
  };
}

function assertNoSecrets(value) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(REFRESH), false, text);
  assert.equal(text.includes(TOKEN_MARK), false, text);
  assert.equal(text.includes("plaintext:v1:"), false, text);
}

test("lists every saved login, including one whose profile cannot be decrypted", () => {
  const activeSub = "user_synthetic_active";
  const otherSub = "user_synthetic_other";
  const brokenSub = "user_synthetic_broken_profile";
  const active = scopeFor(activeSub);
  const other = scopeFor(otherSub);
  const broken = scopeFor(brokenSub);
  const home = homeWith({
    secrets: accountsDoc({
      [active]: entry(`plaintext:v1:${jwt(activeSub)}`, profile("Active.User@Example.com")),
      [other]: entry(`plaintext:v1:${jwt(otherSub)}`, profile("other@example.com")),
      [broken]: entry(`plaintext:v1:${jwt(brokenSub)}`, encrypt(JSON.stringify({ email: "hidden@example.com" }))),
    }, active),
  });
  const rows = listSavedLogins(options(home));
  assert.deepEqual(rows.map((row) => ({
    scope: row.scope,
    label: row.label,
    email: row.email,
    appActive: row.appActive,
  })), [
    { scope: active, label: "Active.User@Example.com", email: "Active.User@Example.com", appActive: true },
    { scope: other, label: "other@example.com", email: "other@example.com", appActive: false },
    { scope: broken, label: broken.slice(0, 8), email: null, appActive: false },
  ]);
  assertNoSecrets(rows);
});

test("catalog unions descriptor entries with saved logins and formats the accounts text", () => {
  const sub = "user_synthetic_catalog";
  const scope = scopeFor(sub);
  const onlyDescriptor = "abcdef0123456789aa";
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: entry(`plaintext:v1:${jwt(sub)}`, profile("saved@example.com")),
    }, scope),
    descriptor: {
      version: 2,
      entries: {
        [onlyDescriptor]: {
          encrypted: encrypt(JSON.stringify({
            baseUrl: "https://box.example",
            token: "gateway-token",
            headers: {},
          })),
          savedAtMs: 10,
        },
      },
    },
  });
  const rows = listLoginCatalog(options(home, {
    getKeychainPassword: () => "demo-password",
  }));
  const saved = rows.find((row) => row.id === scope);
  const described = rows.find((row) => row.id === onlyDescriptor);
  assert.equal(saved.email, "saved@example.com");
  assert.equal(saved.appActive, true);
  assert.equal(saved.hasDescriptorEntry, false);
  assert.equal(saved.label, "saved@example.com");
  assert.equal(described.hasDescriptorEntry, true);
  assert.equal(described.appActive, false);
  assert.equal(described.email, null);
  assert.equal(described.label, onlyDescriptor);
  const text = formatLoginCatalog(rows);
  assert.match(text, /saved@example.com \(app active\)/);
  assert.match(text, /no app session; gbot builds one from the saved login/);
  assert.match(text, new RegExp(onlyDescriptor));
  assertNoSecrets(text);
  assert.equal(text.includes("gateway-token"), false);
  assert.equal(text.includes("box.example"), false);
});

test("resolveLogin matches an email, a scope prefix, and reports more than one match", () => {
  const first = scopeFor("user_synthetic_first");
  const second = scopeFor("user_synthetic_second");
  const home = homeWith({
    secrets: accountsDoc({
      [first]: entry(`plaintext:v1:${jwt("user_synthetic_first")}`, profile("First@Example.com")),
      [second]: entry(`plaintext:v1:${jwt("user_synthetic_second")}`, profile("second@example.com")),
    }, first),
  });
  const base = options(home);
  assert.equal(resolveGrokBotLogin({ ...base, account: "first@example.com" }).scope, first);
  assert.equal(resolveGrokBotLogin({ ...base, env: { ...base.env, GBOT_ACCOUNT: second.slice(0, 8) } }).scope, second);
  assert.throws(() => resolveGrokBotLogin(base), (error) => {
    assert.equal(error.code, "AMBIGUOUS_ENTRIES");
    assert.match(error.message, /--account <label>/);
    assert.match(error.message, /GBOT_ACCOUNT=<label>/);
    assert.match(error.message, /First@Example.com/);
    assertNoSecrets(error.message);
    return true;
  });
  assert.throws(() => resolveGrokBotLogin({ ...base, account: first.slice(0, 2) }), (error) => {
    assert.equal(error.code, "UNKNOWN_ACCOUNT");
    assert.match(error.message, /--account <label>/);
    return true;
  });
});

test("a saved login with no descriptor entry becomes a gateway session and is not written down", async () => {
  const sub = "user_synthetic_nodescriptor";
  const scope = scopeFor(sub);
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: entry(`plaintext:v1:${jwt(sub)}`, profile("nodescriptor@example.com")),
    }, scope),
  }, process.platform);
  const secretsPath = join(dirname(grokBotGatewayDescriptorPath(home, process.platform, {})), "sand-secrets.json");
  const before = readFileSync(secretsPath);
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (calls.length === 1) {
      return new Response(JSON.stringify({ runState: "SAND_BOX_RUN_STATE_HIBERNATED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      runState: "SAND_BOX_RUN_STATE_RUNNING",
      gatewayUrl: "http://127.0.0.1:1341",
      gatewayToken: "from-ensure",
      anyrunNetworkToken: "route-token",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const session = await withEnv({
      HOME: home,
      APPDATA: null,
      XDG_CONFIG_HOME: null,
      USERPROFILE: home,
      CURSOR_API_BASE_URL: "http://127.0.0.1:1340",
      CURSOR_ACCESS_TOKEN: null,
      GROK_BOT_GATEWAY_URL: null,
      GROK_BOT_GATEWAY_TOKEN: null,
      GROK_BOT_ALLOW_ANY_GATEWAY: "1",
      GBOT_ACCOUNT: null,
      GBOT_CONFIG: null,
      SAND_CLIENT_VERSION: "9.9.9",
      GROK_BOT_TEST: "1",
    }, () => connectGateway());
    assert.equal(session.accountScope, scope);
    assert.equal(session.gatewayUrl, "http://127.0.0.1:1341");
    assert.equal(session.gatewayToken, "from-ensure");
    assert.equal(session.gatewayHeaders["x-anyrun-network-token"], "route-token");
    assert.deepEqual(calls[0], { wake: false });
    assert.equal(calls.some((body) => body.wake === true), true);
    assert.deepEqual(readFileSync(secretsPath), before);
    assert.equal(readdirSync(dirname(secretsPath)).includes("gateway-descriptor.json"), false);
    const appDir = dirname(secretsPath);
    for (const name of readdirSync(appDir)) {
      assert.equal(name.includes("from-ensure"), false);
      const body = readFileSync(join(appDir, name), "utf8");
      assert.equal(body.includes("from-ensure"), false);
      assert.equal(body.includes(TOKEN_MARK), false);
    }
  } finally {
    globalThis.fetch = previous;
  }
});

test("a descriptor entry for the same scope is used as-is and does not call EnsureSandBox", { skip: process.platform === "win32" ? "CBC fixture; Windows DPAPI is covered in app-session.test.js" : false }, async () => {
  const sub = "user_synthetic_hasdescriptor";
  const scope = scopeFor(sub);
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: entry(`plaintext:v1:${jwt(sub)}`, profile("has@example.com")),
    }, scope),
    descriptor: {
      version: 2,
      entries: {
        [scope]: {
          encrypted: encrypt(JSON.stringify({
            baseUrl: "http://127.0.0.1:1341",
            token: "gateway-token-kept",
            headers: { "x-anyrun-network-token": "route-kept" },
            email: "has@example.com",
          }), "demo-password", process.platform),
          savedAtMs: 4,
        },
      },
    },
  }, process.platform);
  let calls = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("EnsureSandBox should not run");
  };
  try {
    const session = await withEnv({
      HOME: home,
      APPDATA: null,
      XDG_CONFIG_HOME: null,
      USERPROFILE: home,
      CURSOR_ACCESS_TOKEN: null,
      GROK_BOT_GATEWAY_URL: null,
      GROK_BOT_GATEWAY_TOKEN: null,
      GBOT_ACCOUNT: null,
      GBOT_CONFIG: null,
      GROK_BOT_TEST: "1",
      GBOT_TEST_KEYCHAIN_PASSWORD: "demo-password",
    }, () => connectGateway());
    assert.equal(calls, 0);
    assert.equal(session.gatewayUrl, "http://127.0.0.1:1341");
    assert.equal(session.gatewayToken, "gateway-token-kept");
    assert.equal(session.accountScope, scope);
  } finally {
    globalThis.fetch = previous;
  }
});

test("a describe that is already RUNNING is not followed by wake", async () => {
  const sub = "user_synthetic_running";
  const scope = scopeFor(sub);
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: entry(`plaintext:v1:${jwt(sub)}`, profile("running@example.com")),
    }, scope),
  }, process.platform);
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      runState: "SAND_BOX_RUN_STATE_RUNNING",
      gatewayUrl: "http://127.0.0.1:1341",
      gatewayToken: "already",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const session = await withEnv({
      HOME: home,
      APPDATA: null,
      XDG_CONFIG_HOME: null,
      USERPROFILE: home,
      CURSOR_API_BASE_URL: "http://127.0.0.1:1340",
      CURSOR_ACCESS_TOKEN: null,
      GROK_BOT_GATEWAY_URL: null,
      GROK_BOT_GATEWAY_TOKEN: null,
      GBOT_ACCOUNT: null,
      GBOT_CONFIG: null,
      SAND_CLIENT_VERSION: "9.9.9",
      GROK_BOT_TEST: "1",
    }, () => connectGateway());
    assert.deepEqual(calls, [{ wake: false }]);
    assert.equal(session.accountScope, scope);
    assert.equal(session.gatewayToken, "already");
  } finally {
    globalThis.fetch = previous;
  }
});

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
  try {
    const result = fn();
    if (result && typeof result.then === "function") return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test("app login token is not sent to a non-Cursor host even when ALLOW_ANY is set", async () => {
  const sub = "user_synthetic_host";
  const scope = scopeFor(sub);
  const home = homeWith({
    secrets: accountsDoc({
      [scope]: entry(`plaintext:v1:${jwt(sub)}`, profile("host@example.com")),
    }, scope),
  }, process.platform);
  await withEnv({
    HOME: home,
    APPDATA: null,
    XDG_CONFIG_HOME: null,
    USERPROFILE: home,
    CURSOR_API_BASE_URL: "https://evil.example",
    GROK_BOT_ALLOW_ANY_GATEWAY: "1",
    CURSOR_ACCESS_TOKEN: null,
    GROK_BOT_GATEWAY_URL: null,
    GROK_BOT_GATEWAY_TOKEN: null,
    GBOT_ACCOUNT: null,
    GBOT_CONFIG: null,
    GROK_BOT_TEST: null,
    NODE_ENV: null,
  }, async () => {
    await assert.rejects(connectGateway(), (error) => {
      assert.equal(error.name, "GatewayError");
      assert.equal(String(error.message).includes(TOKEN_MARK), false);
      assert.match(error.message, /app login token is only sent to https Cursor API hosts/);
      return true;
    });
  });
});
