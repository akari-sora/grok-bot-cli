import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { grokBotGatewayDescriptorPath, loadGrokBotGatewaySession } from "../src/core/app-session.js";
import { loadAppAccessToken } from "../src/core/app-auth.js";

// Same Chromium OSCrypt as encryptEntry in test/helpers/wear-pair-fixture.js (macOS v10,
// PBKDF2-SHA1, 1003 rounds, salt "saltysalt", AES-128-CBC, IV of 16 spaces), but the
// plaintext is the token itself. encryptEntry JSON-encodes its argument, which a JWT is not.
function encryptToken(text, password = "demo-password") {
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(text, "utf8"),
    cipher.final(),
  ]).toString("base64");
}

const NOW = 1_700_000_000_000;
const SUB = "user_synthetic_app_auth";
const SCOPE = crypto.createHash("sha256").update(SUB).digest("hex");
const OTHER_SCOPE = crypto.createHash("sha256").update("user_other_synthetic").digest("hex");
const TOKEN_MARK = "synthetic-access-token-do-not-leak";

function jwt({ sub = SUB, exp = 1_800_000_000, iss = "https://authentication.cursor.sh" } = {}) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({ sub, exp, iss, mark: TOKEN_MARK })}.sig`;
}

function homeWith(body) {
  const home = mkdtempSync(join(tmpdir(), "gbot-app-auth-"));
  const secretsPath = join(dirname(grokBotGatewayDescriptorPath(home, "darwin", {})), "sand-secrets.json");
  mkdirSync(dirname(secretsPath), { recursive: true });
  if (body !== undefined) writeFileSync(secretsPath, JSON.stringify(body));
  return home;
}

function accountsFile(tokenValue, { active = SCOPE, scope = SCOPE, extra = {} } = {}) {
  return {
    version: 1,
    "cursor-accounts": JSON.stringify({
      active,
      accounts: {
        [scope]: {
          "cursor-access-token": tokenValue,
          "cursor-refresh-token": "refresh-secret-do-not-touch",
          ...extra,
        },
      },
    }),
  };
}

function load(home, extra = {}) {
  return loadAppAccessToken({
    platform: "darwin",
    home,
    env: {},
    getKeychainPassword: () => {
      throw new Error("keychain should not be read for this fixture");
    },
    now: () => NOW,
    ...extra,
  });
}

function assertClean(error, extra = []) {
  assert.equal(error.name, "AppAuthError");
  for (const secret of [TOKEN_MARK, "refresh-secret-do-not-touch", jwt(), ...extra]) {
    assert.equal(error.message.includes(secret), false, error.message);
  }
}

test("loads an encrypted app access token for an explicit scope", () => {
  const token = jwt();
  const home = homeWith(accountsFile(encryptToken(token)));
  let passwordReads = 0;
  const loaded = load(home, {
    scope: SCOPE,
    getKeychainPassword: () => {
      passwordReads += 1;
      return "demo-password";
    },
  });
  assert.equal(loaded.token, token);
  assert.equal(loaded.scope, SCOPE);
  assert.equal(loaded.expiresAt, 1_800_000_000_000);
  assert.equal(passwordReads, 1);
});

test("accepts a plaintext:v1 access token and uses cursor-accounts.active when scope is omitted", () => {
  const token = jwt();
  const home = homeWith(accountsFile(`plaintext:v1:${token}`));
  const loaded = load(home);
  assert.equal(loaded.token, token);
  assert.equal(loaded.scope, SCOPE);
});

test("uses the legacy scoped cursor-access-token when cursor-accounts has no entry for the scope", () => {
  const token = jwt();
  const home = homeWith({
    version: 1,
    "cursor-accounts": JSON.stringify({ active: OTHER_SCOPE, accounts: {} }),
    "cursor-access-token": `scoped:v1:${SCOPE}:${encryptToken(token)}`,
  });
  const loaded = load(home, {
    scope: SCOPE,
    getKeychainPassword: () => "demo-password",
  });
  assert.equal(loaded.token, token);
  assert.equal(loaded.scope, SCOPE);
});

test("missing secrets file", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-app-auth-missing-"));
  assert.throws(() => load(home), (error) => {
    assert.equal(error.code, "NO_SECRETS_FILE");
    assert.match(error.message, /sign in to that login once/i);
    assertClean(error);
    return true;
  });
});

test("version other than 1 does not wake", () => {
  const home = homeWith({ version: 2, "cursor-accounts": JSON.stringify({ active: SCOPE, accounts: {} }) });
  assert.throws(() => load(home), (error) => {
    assert.equal(error.code, "UNSUPPORTED_VERSION");
    assert.match(error.message, /sign in/i);
    assertClean(error);
    return true;
  });
});

test("unknown scope", () => {
  const home = homeWith(accountsFile(`plaintext:v1:${jwt()}`, { scope: OTHER_SCOPE, active: OTHER_SCOPE }));
  assert.throws(() => load(home, { scope: SCOPE }), (error) => {
    assert.equal(error.code, "NO_ACCOUNT");
    assert.match(error.message, /sign in to that login once/i);
    assertClean(error);
    return true;
  });
});

test("expired token, including one inside the 60 second skew", () => {
  for (const exp of [1_600_000_000, Math.floor(NOW / 1000) + 60]) {
    const token = jwt({ exp });
    const home = homeWith(accountsFile(`plaintext:v1:${token}`));
    assert.throws(() => load(home), (error) => {
      assert.equal(error.code, "EXPIRED");
      assert.match(error.message, /sign in to that login once/i);
      assertClean(error, [token]);
      return true;
    });
  }
});

test("sub hash mismatch", () => {
  const token = jwt({ sub: "user_not_this_scope" });
  const home = homeWith(accountsFile(`plaintext:v1:${token}`));
  assert.throws(() => load(home, { scope: SCOPE }), (error) => {
    assert.equal(error.code, "SCOPE_MISMATCH");
    assert.match(error.message, /sign in to that login once/i);
    assertClean(error, [token]);
    return true;
  });
});

test("non-JWT access token", () => {
  const home = homeWith(accountsFile("plaintext:v1:not-a-jwt"));
  assert.throws(() => load(home), (error) => {
    assert.equal(error.code, "NOT_JWT");
    assert.match(error.message, /sign in to that login once/i);
    assert.doesNotMatch(error.message, /not-a-jwt/);
    return true;
  });
});

test("a 64-hex descriptor entry id is the session account scope", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-scope-"));
  const descriptorPath = grokBotGatewayDescriptorPath(home, "darwin", {});
  mkdirSync(dirname(descriptorPath), { recursive: true });
  const encrypted = encryptToken(JSON.stringify({
    baseUrl: "https://box.example",
    token: "gateway-token",
    headers: {},
  }));
  writeFileSync(descriptorPath, JSON.stringify({
    version: 3,
    entries: {
      [SCOPE]: { encrypted, savedAtMs: 1 },
      primary: { encrypted, savedAtMs: 2 },
    },
  }));
  const scoped = loadGrokBotGatewaySession({
    platform: "darwin",
    home,
    env: {},
    account: SCOPE,
    getKeychainPassword: () => "demo-password",
  });
  assert.equal(scoped.accountScope, SCOPE);
  const unscoped = loadGrokBotGatewaySession({
    platform: "darwin",
    home,
    env: {},
    account: "primary",
    getKeychainPassword: () => "demo-password",
  });
  assert.equal(unscoped.accountScope, undefined);
});
