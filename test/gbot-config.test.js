import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readFileSync as readPackage } from "node:fs";
import {
  exportAccountConfig,
  gbotConfigPath,
  importAccountConfig,
  readGbotConfig,
} from "../src/core/gbot-config.js";
import { defineAlias, removeAlias, resolveGrokBotLogin, setDefaultAccount } from "../src/core/logins.js";
import { grokBotGatewayDescriptorPath } from "../src/core/app-session.js";
import { mkdirSync, writeFileSync as writeSecrets } from "node:fs";
import { dirname } from "node:path";

const VERSION = JSON.parse(readPackage(new URL("../package.json", import.meta.url), "utf8")).version;

function jwt(sub) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({
    sub,
    exp: 1_800_000_000,
    iss: "https://authentication.cursor.sh",
    mark: "synthetic-config-token-do-not-leak",
  })}.sig`;
}

function scopeFor(sub) {
  return crypto.createHash("sha256").update(sub).digest("hex");
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "gbot-config-"));
  const configDir = join(home, ".config");
  const scope = scopeFor("user_synthetic_config");
  const other = scopeFor("user_synthetic_config_other");
  const descriptorPath = grokBotGatewayDescriptorPath(home, "darwin", {});
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeSecrets(join(dirname(descriptorPath), "sand-secrets.json"), JSON.stringify({
    version: 1,
    "cursor-accounts": JSON.stringify({
      active: scope,
      accounts: {
        [scope]: {
          "cursor-access-token": `plaintext:v1:${jwt("user_synthetic_config")}`,
          "cursor-refresh-token": "refresh-secret-do-not-touch",
          "cursor-account-profile": `plaintext:v1:${JSON.stringify({ email: "Owner@Example.com", name: "Owner", avatar: "" })}`,
        },
        [other]: {
          "cursor-access-token": `plaintext:v1:${jwt("user_synthetic_config_other")}`,
          "cursor-refresh-token": "refresh-secret-do-not-touch",
          "cursor-account-profile": `plaintext:v1:${JSON.stringify({ email: "other@example.com", name: "Other", avatar: "" })}`,
        },
      },
    }),
  }));
  const env = { HOME: home, XDG_CONFIG_HOME: configDir };
  const base = {
    platform: "darwin",
    home,
    env,
    getKeychainPassword: () => {
      throw new Error("keychain should not be read");
    },
    now: () => 1_700_000_000_000,
  };
  return { home, configDir, scope, other, env, base };
}

test("config path follows XDG, APPDATA, and GBOT_CONFIG, and reading does not create the file", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-config-path-"));
  assert.equal(
    gbotConfigPath({ platform: "darwin", home, env: {} }),
    join(home, ".config", "grok-bot-cli", "config.json"),
  );
  assert.equal(
    gbotConfigPath({ platform: "linux", home, env: { XDG_CONFIG_HOME: join(home, "xdg") } }),
    join(home, "xdg", "grok-bot-cli", "config.json"),
  );
  assert.equal(
    gbotConfigPath({ platform: "win32", home, env: { APPDATA: join(home, "AppData", "Roaming") } }),
    join(home, "AppData", "Roaming", "grok-bot-cli", "config.json"),
  );
  const override = join(home, "custom.json");
  assert.equal(
    gbotConfigPath({ platform: "darwin", home, env: { GBOT_CONFIG: override } }),
    override,
  );
  assert.equal(existsSync(join(home, ".config", "grok-bot-cli", "config.json")), false);
  const empty = readGbotConfig({ platform: "darwin", home, env: {} });
  assert.equal(empty.version, 1);
  assert.equal(empty.default, null);
  assert.deepEqual(Object.keys(empty.aliases), []);
  assert.equal(existsSync(join(home, ".config", "grok-bot-cli", "config.json")), false);
});

test("alias, default, export, and import round-trip without tokens", () => {
  const { base, scope, other, configDir } = fixture();
  assert.throws(() => defineAlias({ ...base, name: "Bad Name", selector: "owner@example.com" }), (error) => {
    assert.equal(error.exitCode, 2);
    return true;
  });
  defineAlias({ ...base, name: "work", selector: "owner@example.com" });
  const written = join(configDir, "grok-bot-cli", "config.json");
  const mode = statSync(written).mode & 0o777;
  if (process.platform !== "win32") assert.equal(mode, 0o600);
  assert.equal(readdirSync(join(configDir, "grok-bot-cli")).some((name) => name.endsWith(".tmp") || name.includes(".tmp")), false);
  const onDisk = JSON.parse(readFileSync(written, "utf8"));
  assert.equal(onDisk.aliases.work.scope, scope);
  assert.equal(onDisk.aliases.work.email, "Owner@Example.com");
  assert.equal(JSON.stringify(onDisk).includes("refresh-secret"), false);
  assert.equal(JSON.stringify(onDisk).includes("synthetic-config-token"), false);

  defineAlias({ ...base, name: "laptop", selector: other });
  setDefaultAccount({ ...base, name: "work" });
  assert.equal(resolveGrokBotLogin(base).scope, scope);

  const exported = exportAccountConfig(base);
  assert.equal(exported.gbotVersion, VERSION);
  assert.equal(exported.default, "work");
  assert.equal(exported.aliases.laptop.email, "other@example.com");
  assert.equal(JSON.stringify(exported).includes("plaintext:"), false);

  removeAlias({ ...base, name: "work" });
  const after = readGbotConfig(base);
  assert.equal(after.aliases.work, undefined);
  assert.equal(after.default, null);
  assert.equal(after.aliases.laptop.scope, other);

  const file = join(base.home, "export.json");
  writeFileSync(file, JSON.stringify({
    version: 1,
    gbotVersion: "0.0.0",
    default: "phone",
    aliases: {
      laptop: { scope: other, email: "other@example.com" },
      phone: { scope: "a".repeat(64), email: "phone@example.com" },
    },
  }));
  const merged = importAccountConfig({ ...base, file });
  assert.equal(merged.exitCode, 3);
  assert.match(merged.messages.join("\n"), /sign in to phone@example.com in the Grok Bot app/);
  assert.equal(readGbotConfig(base).aliases.phone.scope, "a".repeat(64));
  assert.equal(readGbotConfig(base).aliases.laptop.scope, other);
  assert.equal(readGbotConfig(base).default, "phone");

  const replaced = importAccountConfig({
    ...base,
    file,
    replace: true,
  });
  assert.equal(replaced.exitCode, 3);
  assert.equal(readGbotConfig(base).aliases.work, undefined);
  assert.equal(Object.keys(readGbotConfig(base).aliases).sort().join(), "laptop,phone");
});

test("import rejects a bad file without writing and accepts a complete replace", () => {
  const { base } = fixture();
  defineAlias({ ...base, name: "work", selector: "owner@example.com" });
  const before = readFileSync(gbotConfigPath(base), "utf8");
  const bad = join(base.home, "bad.json");
  writeFileSync(bad, JSON.stringify({ version: 1, aliases: { nope: { scope: "zz", token: "secret" } }, default: null }));
  const rejected = importAccountConfig({ ...base, file: bad });
  assert.equal(rejected.exitCode, 2);
  assert.equal(readFileSync(gbotConfigPath(base), "utf8"), before);
  assert.equal(rejected.messages.join("\n").includes("secret"), false);

  chmodSync(bad, 0o600);
  const missing = importAccountConfig({ ...base, file: join(base.home, "missing.json") });
  assert.equal(missing.exitCode, 2);
});

test("setDefault --clear and a selector that matches two logins keep the error style", () => {
  const { base, scope } = fixture();
  defineAlias({ ...base, name: "work", selector: scope });
  setDefaultAccount({ ...base, name: "work" });
  setDefaultAccount({ ...base, clear: true });
  assert.equal(readGbotConfig(base).default, null);
  assert.throws(() => defineAlias({ ...base, name: "ambiguous", selector: scope.slice(0, 1) }), (error) => {
    assert.equal(error.code, "UNKNOWN_ACCOUNT");
    assert.match(error.message, /--account <label>/);
    return true;
  });
});
