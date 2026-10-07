import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

delete process.env.GBOT_ACCOUNT;

import {
  decryptSafeStorageString,
  decryptWindowsSafeStorageString,
  grokBotGatewayDescriptorPath,
  hasGrokBotGatewaySession,
  inspectGrokBotGatewaySession,
  listGrokBotGatewayAccounts,
  loadGrokBotGatewaySession,
} from "../src/core/app-session.js";

const ENCRYPTED_DESCRIPTOR =
  "djEwddBm+U69UF2IJtIUtedNqMB3bQt7HsRw7MLWRkw/IfnMK+c4czCXq82JKPNsdsP3Bp2fX8HoGPZFsa7k+JOmbIkBanQwl4yiy9v7iOA+mE4rtGqYbYD9jJc+/9YnhcGjvSxCxD8fKbJLbHifTwroGQ==";
const ENCRYPTED_INCOMPLETE_DESCRIPTOR =
  "djEwddBm+U69UF2IJtIUtedNqMB3bQt7HsRw7MLWRkw/IfnWb2TrPAofoKysOC2KnKLJ";
const WINDOWS_KEY = Buffer.from("demo-safe-storage-key-32-bytes!!");
const WINDOWS_ENCRYPTED_DESCRIPTOR =
  "djEwZGVtby1ub25jZTEyUN+Gpc6/+RfJzyx52epPxU9Qlzo9TQNAJD6QHtsCaTCTBxssiBtRPJzcylXxQTjOJdPlxMjVIjlxWhW7WfcfxPjJiVIr8J3dZZA7J1dF9uSYG6iDLXHAotC+0gDB7k81WdJmrbloEC+sslxz+AeU6VW3B5E5yYepIfkEdw==";
const WINDOWS_LOCAL_STATE = {
  os_crypt: { encrypted_key: Buffer.from("DPAPIdemo-dpapi-blob").toString("base64") },
};

function writeWrappedDescriptor(wrapped) {
  const home = mkdtempSync(join(tmpdir(), "gbot-home-"));
  const descriptorPath = join(
    home,
    "Library/Application Support/Grok Bot/gateway-descriptor.json",
  );
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, JSON.stringify(wrapped));
  return home;
}

function writeWindowsAppData(
  localState,
  appData = mkdtempSync(join(tmpdir(), "gbot-appdata-")),
) {
  const dir = join(appData, "Grok Bot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "gateway-descriptor.json"),
    JSON.stringify({ version: 2, entries: { primary: { encrypted: WINDOWS_ENCRYPTED_DESCRIPTOR } } }),
  );
  writeFileSync(join(dir, "Local State"), JSON.stringify(localState));
  return appData;
}

function unprotectDemoKey(blob) {
  assert.equal(blob.toString("utf8"), "demo-dpapi-blob");
  return WINDOWS_KEY;
}

test("decrypts an Electron Safe Storage v10 string", () => {
  const clear = decryptSafeStorageString(
    ENCRYPTED_DESCRIPTOR,
    "demo-password",
  );

  assert.deepEqual(JSON.parse(clear), {
    baseUrl: "https://box.example",
    token: "gateway-token",
    headers: { "x-anyrun-network-token": "route-token" },
  });
});

test("loads the signed-in Grok Bot gateway without manual tokens", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-home-"));
  const descriptorPath = join(
    home,
    "Library/Application Support/Grok Bot/gateway-descriptor.json",
  );
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(
    descriptorPath,
    JSON.stringify({ version: 1, encrypted: ENCRYPTED_DESCRIPTOR }),
  );

  const session = loadGrokBotGatewaySession({
    platform: "darwin",
    home,
    getKeychainPassword: () => "demo-password",
  });

  assert.deepEqual(session, {
    gatewayUrl: "https://box.example",
    gatewayToken: "gateway-token",
    headers: { "x-anyrun-network-token": "route-token" },
  });
});

test("loads a version 2 Grok Bot gateway entry", () => {
  const home = writeWrappedDescriptor({
    version: 2,
    entries: {
      primary: {
        encrypted: ENCRYPTED_DESCRIPTOR,
        savedAtMs: 1_787_000_000_000,
      },
    },
  });

  const session = loadGrokBotGatewaySession({
    platform: "darwin",
    home,
    getKeychainPassword: () => "demo-password",
  });

  assert.deepEqual(session, {
    gatewayUrl: "https://box.example",
    gatewayToken: "gateway-token",
    headers: { "x-anyrun-network-token": "route-token" },
  });
});

test("rejects a version 2 descriptor with no entries", () => {
  const home = writeWrappedDescriptor({ version: 2, entries: {} });

  assert.throws(
    () => loadGrokBotGatewaySession({
      platform: "darwin",
      home,
      getKeychainPassword: () => "demo-password",
    }),
    (error) => {
      assert.equal(error.name, "GrokBotGatewaySessionError");
      assert.equal(error.code, "EMPTY_ENTRIES");
      assert.match(error.message, /no saved gateway entries/i);
      return true;
    },
  );
});

test("rejects a version 2 descriptor with ambiguous entries", () => {
  const home = writeWrappedDescriptor({
    version: 2,
    entries: {
      first: { encrypted: ENCRYPTED_DESCRIPTOR, savedAtMs: 1 },
      second: { encrypted: ENCRYPTED_DESCRIPTOR, savedAtMs: 2 },
    },
  });

  assert.throws(
    () => loadGrokBotGatewaySession({
      platform: "darwin",
      home,
      getKeychainPassword: () => "demo-password",
    }),
    (error) => {
      assert.equal(error.name, "GrokBotGatewaySessionError");
      assert.equal(error.code, "AMBIGUOUS_ENTRIES");
      assert.match(error.message, /multiple saved gateway entries/i);
      assert.match(error.message, /--account <label>/);
      assert.match(error.message, /GBOT_ACCOUNT=<label>/);
      assert.match(error.message, /first/);
      assert.match(error.message, /second/);
      assert.match(error.message, /last saved/);
      assert.doesNotMatch(error.message, /gateway-token|djEw/);
      return true;
    },
  );
});

test("loads a version 3 Grok Bot gateway entry", () => {
  const home = writeWrappedDescriptor({
    version: 3,
    entries: {
      primary: {
        encrypted: ENCRYPTED_DESCRIPTOR,
        savedAtMs: 1_787_000_000_000,
      },
    },
  });

  const session = loadGrokBotGatewaySession({
    platform: "darwin",
    home,
    getKeychainPassword: () => "demo-password",
  });

  assert.deepEqual(session, {
    gatewayUrl: "https://box.example",
    gatewayToken: "gateway-token",
    headers: { "x-anyrun-network-token": "route-token" },
  });
});

test("rejects a version 3 descriptor with ambiguous entries", () => {
  const home = writeWrappedDescriptor({
    version: 3,
    entries: {
      first: { encrypted: ENCRYPTED_DESCRIPTOR, savedAtMs: 1 },
      second: { encrypted: ENCRYPTED_DESCRIPTOR, savedAtMs: 2 },
    },
  });

  assert.throws(
    () => loadGrokBotGatewaySession({
      platform: "darwin",
      home,
      getKeychainPassword: () => "demo-password",
    }),
    (error) => {
      assert.equal(error.name, "GrokBotGatewaySessionError");
      assert.equal(error.code, "AMBIGUOUS_ENTRIES");
      assert.match(error.message, /multiple saved gateway entries/i);
      assert.match(error.message, /--account <label>/);
      assert.match(error.message, /GBOT_ACCOUNT=<label>/);
      assert.match(error.message, /first/);
      assert.match(error.message, /second/);
      assert.match(error.message, /last saved/);
      assert.doesNotMatch(error.message, /gateway-token|djEw/);
      return true;
    },
  );
});

function encryptDarwinDescriptor(value, password = "demo-password") {
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]).toString("base64");
}

const SECOND_LOGIN = encryptDarwinDescriptor({
  baseUrl: "https://other.example",
  token: "other-token",
  headers: {},
  email: "second@example.com",
});

function twoLogins() {
  return writeWrappedDescriptor({
    version: 2,
    entries: {
      abcdef0123456789aa: { encrypted: ENCRYPTED_DESCRIPTOR, savedAtMs: 10 },
      abcdef9999999999bb: { encrypted: SECOND_LOGIN, savedAtMs: 20 },
    },
  });
}

test("selects a saved login by key, unique prefix, email, or GBOT_ACCOUNT", () => {
  const home = twoLogins();
  const options = {
    platform: "darwin",
    home,
    getKeychainPassword: () => "demo-password",
  };
  assert.equal(
    loadGrokBotGatewaySession({ ...options, account: "abcdef0123456789aa" }).gatewayUrl,
    "https://box.example",
  );
  assert.equal(
    loadGrokBotGatewaySession({ ...options, account: "abcdef01234567" }).gatewayUrl,
    "https://box.example",
  );
  assert.equal(
    loadGrokBotGatewaySession({ ...options, account: "second@example.com" }).gatewayUrl,
    "https://other.example",
  );
  assert.equal(
    loadGrokBotGatewaySession({ ...options, env: { GBOT_ACCOUNT: "abcdef9999999999bb" } }).gatewayUrl,
    "https://other.example",
  );
  assert.equal(
    loadGrokBotGatewaySession({
      ...options,
      account: "abcdef0123456789aa",
      env: { GBOT_ACCOUNT: "second@example.com" },
    }).gatewayUrl,
    "https://box.example",
  );
});

test("lists saved logins without credential values", () => {
  const home = twoLogins();
  const accounts = listGrokBotGatewayAccounts({
    platform: "darwin",
    home,
    getKeychainPassword: () => "demo-password",
  });
  assert.deepEqual(accounts, [
    { id: "abcdef0123456789aa", label: "abcdef0123456789aa", savedAtMs: 10, lastSaved: false, usable: true },
    { id: "abcdef9999999999bb", label: "second@example.com", savedAtMs: 20, lastSaved: true, usable: true },
  ]);
  assert.doesNotMatch(JSON.stringify(accounts), /other-token|gateway-token|https:|djEw/);
});

test("a single saved login still loads when no account is chosen", () => {
  const home = writeWrappedDescriptor({
    version: 2,
    entries: { only: { encrypted: ENCRYPTED_DESCRIPTOR, savedAtMs: 1 } },
  });
  const session = loadGrokBotGatewaySession({
    platform: "darwin",
    home,
    env: {},
    getKeychainPassword: () => "demo-password",
  });
  assert.equal(session.gatewayUrl, "https://box.example");
});

test("a single saved login in version 3 loads when no account is chosen", () => {
  const home = writeWrappedDescriptor({
    version: 3,
    entries: { "8b7f0d1600000000000000000000000000000000000000000000000000000001": { encrypted: ENCRYPTED_DESCRIPTOR, savedAtMs: 1 } },
  });
  const session = loadGrokBotGatewaySession({
    platform: "darwin",
    home,
    env: {},
    getKeychainPassword: () => "demo-password",
  });
  assert.equal(session.gatewayUrl, "https://box.example");
});

test("selects a version 3 saved login by 64-char hex id prefix or full id", () => {
  const id1 = "8b7f0d1600000000000000000000000000000000000000000000000000000001";
  const id2 = "9c8e1f2700000000000000000000000000000000000000000000000000000002";
  const home = writeWrappedDescriptor({
    version: 3,
    entries: {
      [id1]: { encrypted: ENCRYPTED_DESCRIPTOR, savedAtMs: 10 },
      [id2]: { encrypted: SECOND_LOGIN, savedAtMs: 20 },
    },
  });
  const options = {
    platform: "darwin",
    home,
    getKeychainPassword: () => "demo-password",
  };
  assert.equal(
    loadGrokBotGatewaySession({ ...options, account: id1 }).gatewayUrl,
    "https://box.example",
  );
  assert.equal(
    loadGrokBotGatewaySession({ ...options, account: "8b7f0d16" }).gatewayUrl,
    "https://box.example",
  );
  assert.equal(
    loadGrokBotGatewaySession({ ...options, account: "9c8e1f27" }).gatewayUrl,
    "https://other.example",
  );
});

test("an unknown account lists the labels and does not open that login", () => {
  const home = twoLogins();
  assert.throws(
    () => loadGrokBotGatewaySession({
      platform: "darwin",
      home,
      account: "missing",
      getKeychainPassword: () => "demo-password",
    }),
    (error) => {
      assert.equal(error.code, "UNKNOWN_ACCOUNT");
      assert.match(error.message, /second@example.com/);
      assert.match(error.message, /--account <label>/);
      assert.doesNotMatch(error.message, /other-token|gateway-token/);
      return true;
    },
  );
});

test("rejects a gateway entry without an encrypted payload", () => {
  const home = writeWrappedDescriptor({
    version: 2,
    entries: { primary: { savedAtMs: 1 } },
  });

  assert.throws(
    () => loadGrokBotGatewaySession({
      platform: "darwin",
      home,
      getKeychainPassword: () => "demo-password",
    }),
    (error) => {
      assert.equal(error.name, "GrokBotGatewaySessionError");
      assert.equal(error.code, "MISSING_ENCRYPTED_PAYLOAD");
      assert.match(error.message, /missing an encrypted payload/i);
      return true;
    },
  );
});

test("rejects an unsupported gateway descriptor version", () => {
  const home = writeWrappedDescriptor({
    version: 4,
    encrypted: ENCRYPTED_DESCRIPTOR,
  });

  assert.throws(
    () => loadGrokBotGatewaySession({
      platform: "darwin",
      home,
      getKeychainPassword: () => "demo-password",
    }),
    (error) => {
      assert.equal(error.name, "GrokBotGatewaySessionError");
      assert.equal(error.code, "UNSUPPORTED_VERSION");
      assert.match(error.message, /unsupported .*gateway descriptor version 4/i);
      return true;
    },
  );
});

test("rejects an incomplete decrypted gateway descriptor", () => {
  const home = writeWrappedDescriptor({
    version: 2,
    entries: { primary: { encrypted: ENCRYPTED_INCOMPLETE_DESCRIPTOR } },
  });

  assert.throws(
    () => loadGrokBotGatewaySession({
      platform: "darwin",
      home,
      getKeychainPassword: () => "demo-password",
    }),
    (error) => {
      assert.equal(error.name, "GrokBotGatewaySessionError");
      assert.equal(error.code, "INCOMPLETE_DESCRIPTOR");
      assert.match(error.message, /decrypted .*gateway descriptor is incomplete/i);
      return true;
    },
  );
});

test("reports a present but unusable Grok Bot app session", () => {
  const home = writeWrappedDescriptor({ version: 2, entries: {} });

  const status = inspectGrokBotGatewaySession({
    platform: "darwin",
    home,
    getKeychainPassword: () => "demo-password",
  });

  assert.deepEqual(status, {
    present: true,
    usable: false,
    code: "EMPTY_ENTRIES",
    error: "Grok Bot gateway descriptor has no saved gateway entries.",
  });
});

function encryptLinuxSafeStorage(clear, prefix, password) {
  // Chromium OSCrypt on Linux: PBKDF2-SHA1, "saltysalt", ONE iteration, AES-128-CBC, IV = 16 spaces.
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([
    Buffer.from(prefix, "latin1"),
    cipher.update(clear, "utf8"),
    cipher.final(),
  ]).toString("base64");
}

const LINUX_DESCRIPTOR = JSON.stringify({
  baseUrl: "https://box.example/",
  token: "gateway-token",
  headers: { "x-anyrun-network-token": "route-token" },
});

function writeLinuxDescriptor(encrypted, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "gbot-home-"));
  const descriptorPath = grokBotGatewayDescriptorPath(home, "linux", env);
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, JSON.stringify({ version: 2, entries: { primary: { encrypted } } }));
  return home;
}

test("loads a Linux v11 descriptor with the Secret Service password", () => {
  const home = writeLinuxDescriptor(
    encryptLinuxSafeStorage(LINUX_DESCRIPTOR, "v11", "keyring-password"),
  );
  let platformAsked = null;

  const session = loadGrokBotGatewaySession({
    platform: "linux",
    home,
    env: {},
    getKeychainPassword: (platform) => {
      platformAsked = platform;
      return "keyring-password";
    },
  });

  assert.equal(platformAsked, "linux");
  assert.deepEqual(session, {
    gatewayUrl: "https://box.example",
    gatewayToken: "gateway-token",
    headers: { "x-anyrun-network-token": "route-token" },
  });
});

test("loads a Linux v10 (basic_text) descriptor without touching the keyring", () => {
  const home = writeLinuxDescriptor(
    encryptLinuxSafeStorage(LINUX_DESCRIPTOR, "v10", "peanuts"),
  );
  let keychainRead = false;

  const session = loadGrokBotGatewaySession({
    platform: "linux",
    home,
    env: {},
    getKeychainPassword: () => {
      keychainRead = true;
      return "unused";
    },
  });

  assert.equal(keychainRead, false);
  assert.equal(session.gatewayToken, "gateway-token");
});

test("honours XDG_CONFIG_HOME for the Linux descriptor", () => {
  const configHome = mkdtempSync(join(tmpdir(), "gbot-xdg-"));
  const env = { XDG_CONFIG_HOME: configHome };
  writeLinuxDescriptor(encryptLinuxSafeStorage(LINUX_DESCRIPTOR, "v10", "peanuts"), env);

  assert.equal(hasGrokBotGatewaySession({ platform: "linux", home: "/tmp/unused", env }), true);
  assert.equal(
    grokBotGatewayDescriptorPath("/tmp/unused", "linux", env),
    join(configHome, "Grok Bot/gateway-descriptor.json"),
  );
});

test("rejects a wrong Secret Service password on Linux as unusable", () => {
  const home = writeLinuxDescriptor(
    encryptLinuxSafeStorage(LINUX_DESCRIPTOR, "v11", "keyring-password"),
  );

  const status = inspectGrokBotGatewaySession({
    platform: "linux",
    home,
    env: {},
    getKeychainPassword: () => "wrong-password",
  });

  assert.equal(status.present, true);
  assert.equal(status.usable, false);
  assert.equal(status.code, "UNUSABLE_SESSION");
});

test("does not probe app credentials on unsupported platforms", () => {
  let keychainRead = false;

  const session = loadGrokBotGatewaySession({
    platform: "freebsd",
    home: "/tmp/unused",
    getKeychainPassword: () => {
      keychainRead = true;
      return "unused";
    },
  });

  assert.equal(session, null);
  assert.equal(keychainRead, false);
});

test("decrypts a Windows Electron Safe Storage v10 string", () => {
  const clear = decryptWindowsSafeStorageString(
    WINDOWS_ENCRYPTED_DESCRIPTOR,
    WINDOWS_KEY,
  );

  assert.deepEqual(JSON.parse(clear), {
    baseUrl: "https://box.example",
    token: "gateway-token",
    headers: { "x-anyrun-network-token": "route-token" },
  });
});

test("loads the signed-in Grok Bot gateway on Windows", () => {
  const appData = writeWindowsAppData(WINDOWS_LOCAL_STATE);

  const session = loadGrokBotGatewaySession({
    platform: "win32",
    home: "/tmp/unused",
    appData,
    unprotectData: unprotectDemoKey,
  });

  assert.deepEqual(session, {
    gatewayUrl: "https://box.example",
    gatewayToken: "gateway-token",
    headers: { "x-anyrun-network-token": "route-token" },
  });
});

test("falls back to AppData/Roaming under home when APPDATA is unset", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-home-"));
  writeWindowsAppData(WINDOWS_LOCAL_STATE, join(home, "AppData/Roaming"));

  const session = loadGrokBotGatewaySession({
    platform: "win32",
    home,
    appData: "",
    unprotectData: unprotectDemoKey,
  });

  assert.equal(session.gatewayUrl, "https://box.example");
});

test("reports a Windows app session without a Safe Storage key", () => {
  const appData = writeWindowsAppData({ os_crypt: {} });

  const status = inspectGrokBotGatewaySession({
    platform: "win32",
    home: "/tmp/unused",
    appData,
    unprotectData: unprotectDemoKey,
  });

  assert.deepEqual(status, {
    present: true,
    usable: false,
    code: "MISSING_SAFE_STORAGE_KEY",
    error: "Grok Bot Local State has no Safe Storage key.",
  });
});
