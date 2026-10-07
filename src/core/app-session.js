import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Chromium OSCrypt: "v10" = fixed password (macOS: the Keychain password; Linux: "peanuts"),
// "v11" = Linux Secret Service password. macOS stretches with 1003 PBKDF2 rounds, Linux with 1.
// Windows v10 uses AES-256-GCM with a DPAPI-wrapped key from Local State (not PBKDF2).
const SAFE_STORAGE_PREFIX_V10 = "v10";
const SAFE_STORAGE_PREFIX_V11 = "v11";
const SAFE_STORAGE_PREFIX_V10_BUF = Buffer.from(SAFE_STORAGE_PREFIX_V10);
const LINUX_BASIC_TEXT_PASSWORD = "peanuts";
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);

class GrokBotGatewaySessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GrokBotGatewaySessionError";
    this.code = code;
  }
}

const IDENTITY_KEYS = ["email", "displayName", "name", "label", "accountName"];

function accountSelector({ account, env = process.env } = {}) {
  if (typeof account === "string" && account.trim()) return account.trim();
  return String(env.GBOT_ACCOUNT ?? "").trim();
}

function identityLabel(descriptor) {
  if (!descriptor || typeof descriptor !== "object") return "";
  for (const key of IDENTITY_KEYS) {
    const value = descriptor[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 120 || /^https?:\/\//i.test(trimmed)) continue;
    return trimmed;
  }
  return "";
}

function savedEntries(wrapped) {
  if (
    wrapped.version != null &&
    wrapped.version !== 1 &&
    wrapped.version !== 2 &&
    wrapped.version !== 3
  ) {
    throw new GrokBotGatewaySessionError(
      "UNSUPPORTED_VERSION",
      `Unsupported Grok Bot gateway descriptor version ${wrapped.version}.`,
    );
  }
  if (wrapped.version === 2 || wrapped.version === 3) {
    return Object.entries(wrapped.entries ?? {}).map(([id, entry]) => ({
      id,
      encrypted: entry?.encrypted,
      savedAtMs: typeof entry?.savedAtMs === "number" ? entry.savedAtMs : undefined,
    }));
  }
  return [{ id: "default", encrypted: wrapped.encrypted }];
}

function markLastSaved(rows) {
  const stamped = rows.filter((row) => typeof row.savedAtMs === "number");
  const newest = stamped.reduce((max, row) => Math.max(max, row.savedAtMs), -Infinity);
  const marked = rows.length > 1 && stamped.length > 0;
  return rows.map((row) => ({
    ...row,
    lastSaved: marked && row.savedAtMs === newest,
  }));
}

function loginLines(rows) {
  return rows.map((row) => "  " + row.label + (row.lastSaved ? " (last saved)" : "")).join("\n");
}

function ambiguousMessage(rows) {
  return [
    "Grok Bot gateway descriptor has multiple saved gateway entries and no active entry selection.",
    "Choose one with --account <label> or GBOT_ACCOUNT=<label>.",
    "Saved logins:",
    loginLines(rows),
  ].join("\n");
}

function matchesSelector(row, selector) {
  if (row.label === selector || row.id === selector) return true;
  if (row.label.includes("@") && row.label.toLowerCase() === selector.toLowerCase()) return true;
  return /^[0-9a-f]{8,}$/i.test(selector)
    && row.id.toLowerCase().startsWith(selector.toLowerCase())
    && row.id.length > selector.length;
}

function chooseSavedEntry(rows, selector) {
  if (rows.length === 0) {
    throw new GrokBotGatewaySessionError(
      "EMPTY_ENTRIES",
      "Grok Bot gateway descriptor has no saved gateway entries.",
    );
  }
  const visible = markLastSaved(rows);
  if (!selector) {
    if (visible.length === 1) return visible[0];
    throw new GrokBotGatewaySessionError("AMBIGUOUS_ENTRIES", ambiguousMessage(visible));
  }
  const matches = visible.filter((row) => matchesSelector(row, selector));
  if (matches.length === 1) return matches[0];
  const listed = "Saved logins:\n" + loginLines(visible);
  if (matches.length === 0) {
    throw new GrokBotGatewaySessionError(
      "UNKNOWN_ACCOUNT",
      `No saved Grok Bot login matches "${selector}". Choose one with --account <label> or GBOT_ACCOUNT=<label>.\n${listed}`,
    );
  }
  throw new GrokBotGatewaySessionError(
    "AMBIGUOUS_ENTRIES",
    `More than one saved Grok Bot login matches "${selector}". Choose one with --account <label> or GBOT_ACCOUNT=<label>.\n${listed}`,
  );
}

function decorateEntries(entries, decrypt) {
  return entries.map((entry) => {
    if (typeof entry.encrypted !== "string" || !entry.encrypted) {
      return { ...entry, label: entry.id };
    }
    try {
      const descriptor = JSON.parse(decrypt(entry.encrypted));
      return { ...entry, label: identityLabel(descriptor) || entry.id, descriptor };
    } catch (error) {
      return { ...entry, label: entry.id, decryptError: error };
    }
  });
}

function assertEncrypted(entry) {
  if (typeof entry?.encrypted !== "string" || !entry.encrypted) {
    throw new GrokBotGatewaySessionError(
      "MISSING_ENCRYPTED_PAYLOAD",
      "Grok Bot gateway descriptor is missing an encrypted payload.",
    );
  }
  return entry.encrypted;
}

function safeStorageKey(password, platform) {
  const iterations = platform === "linux" ? 1 : 1003;
  return crypto.pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
}

export function decryptSafeStorageString(encryptedBase64, password, platform = "darwin") {
  const encrypted = Buffer.from(encryptedBase64, "base64");
  const prefix = encrypted.subarray(0, 3).toString("latin1");
  const linuxBasicText = platform === "linux" && prefix === SAFE_STORAGE_PREFIX_V10;
  const keyring = prefix === SAFE_STORAGE_PREFIX_V10 || (platform === "linux" && prefix === SAFE_STORAGE_PREFIX_V11);
  if (!keyring) {
    throw new Error("Unsupported Grok Bot Safe Storage format.");
  }

  const key = safeStorageKey(linuxBasicText ? LINUX_BASIC_TEXT_PASSWORD : password, platform);
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    key,
    Buffer.alloc(16, 32),
  );
  return Buffer.concat([
    decipher.update(encrypted.subarray(3)),
    decipher.final(),
  ]).toString("utf8");
}

// Windows Chromium Safe Storage: "v10" + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag.
export function decryptWindowsSafeStorageString(encryptedBase64, key) {
  const encrypted = Buffer.from(encryptedBase64, "base64");
  if (!encrypted.subarray(0, 3).equals(SAFE_STORAGE_PREFIX_V10_BUF)) {
    throw new Error("Unsupported Grok Bot Safe Storage format.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    encrypted.subarray(3, 15),
  );
  decipher.setAuthTag(encrypted.subarray(-16));
  return Buffer.concat([
    decipher.update(encrypted.subarray(15, -16)),
    decipher.final(),
  ]).toString("utf8");
}

function grokBotAppDataPath(home, platform, env = {}) {
  if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData/Roaming");
    return join(appData, "Grok Bot");
  }
  if (platform === "linux") {
    const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
    return join(configHome, "Grok Bot");
  }
  return join(home, "Library/Application Support/Grok Bot");
}

export function grokBotGatewayDescriptorPath(home = homedir(), platform = process.platform, env = process.env) {
  return join(grokBotAppDataPath(home, platform, env), "gateway-descriptor.json");
}

function sessionEnv({ env = process.env, appData } = {}) {
  // Windows tests pass appData directly; empty string clears APPDATA to exercise the home fallback.
  if (appData !== undefined) return { ...env, APPDATA: appData };
  return env;
}

export function hasGrokBotGatewaySession({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  appData,
} = {}) {
  return (
    SUPPORTED_PLATFORMS.has(platform) &&
    existsSync(grokBotGatewayDescriptorPath(home, platform, sessionEnv({ env, appData })))
  );
}

function readKeychainPassword(platform = process.platform) {
  if (platform === "linux") {
    return execFileSync(
      "secret-tool",
      ["lookup", "xdg:schema", "chrome_libsecret_os_crypt_password_v2", "application", "Grok Bot"],
      { encoding: "utf8" },
    ).trimEnd();
  }
  return execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "Grok Bot Safe Storage"],
    { encoding: "utf8" },
  ).trimEnd();
}

function unprotectWithDpapi(blob) {
  const script =
    "Add-Type -AssemblyName System.Security; " +
    "$blob = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
    "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser'))";
  const out = execFileSync(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input: blob.toString("base64"), encoding: "utf8" },
  );
  return Buffer.from(out.trim(), "base64");
}

function readWindowsSafeStorageKey(home, env, unprotectData) {
  const path = join(grokBotAppDataPath(home, "win32", env), "Local State");
  const encryptedKey = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")).os_crypt?.encrypted_key
    : null;
  const blob = Buffer.from(
    typeof encryptedKey === "string" ? encryptedKey : "",
    "base64",
  );
  if (blob.subarray(0, 5).toString("latin1") !== "DPAPI") {
    throw new GrokBotGatewaySessionError(
      "MISSING_SAFE_STORAGE_KEY",
      "Grok Bot Local State has no Safe Storage key.",
    );
  }
  return unprotectData(blob.subarray(5));
}

export function listGrokBotGatewayAccounts(options = {}) {
  if (!hasGrokBotGatewaySession(options)) return [];
  const {
    platform = process.platform,
    home = homedir(),
    env = process.env,
    appData,
    getKeychainPassword = readKeychainPassword,
    unprotectData = unprotectWithDpapi,
  } = options;
  const effectiveEnv = sessionEnv({ env, appData });
  const path = grokBotGatewayDescriptorPath(home, platform, effectiveEnv);
  const wrapped = JSON.parse(readFileSync(path, "utf8"));
  const decrypt = (encrypted) => decryptEntry(encrypted, {
    platform,
    home,
    env: effectiveEnv,
    getKeychainPassword,
    unprotectData,
  });
  const rows = decorateEntries(savedEntries(wrapped), decrypt).map((row) => ({
    ...row,
    usable: row.descriptor != null && !row.decryptError,
  }));
  return markLastSaved(rows).map((row) => ({
    id: row.id,
    label: row.label,
    ...(row.savedAtMs !== undefined ? { savedAtMs: row.savedAtMs } : {}),
    lastSaved: row.lastSaved,
    usable: row.usable,
  }));
}

function decryptEntry(encrypted, { platform, home, env, getKeychainPassword, unprotectData }) {
  if (platform === "win32") {
    return decryptWindowsSafeStorageString(
      encrypted,
      readWindowsSafeStorageKey(home, env, unprotectData),
    );
  }
  const prefix = Buffer.from(encrypted, "base64").subarray(0, 3).toString("latin1");
  const needsKeychain = !(platform === "linux" && prefix === SAFE_STORAGE_PREFIX_V10);
  return decryptSafeStorageString(
    encrypted,
    needsKeychain ? getKeychainPassword(platform) : LINUX_BASIC_TEXT_PASSWORD,
    platform,
  );
}

export function loadGrokBotGatewaySession({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  appData,
  account,
  getKeychainPassword = readKeychainPassword,
  unprotectData = unprotectWithDpapi,
} = {}) {
  if (!SUPPORTED_PLATFORMS.has(platform)) return null;

  const effectiveEnv = sessionEnv({ env, appData });
  const path = grokBotGatewayDescriptorPath(home, platform, effectiveEnv);
  if (!existsSync(path)) return null;

  const wrapped = JSON.parse(readFileSync(path, "utf8"));
  const decrypt = (encrypted) => decryptEntry(encrypted, {
    platform,
    home,
    env: effectiveEnv,
    getKeychainPassword,
    unprotectData,
  });
  const selected = chooseSavedEntry(
    decorateEntries(savedEntries(wrapped), decrypt),
    accountSelector({ account, env }),
  );
  if (selected.decryptError) throw selected.decryptError;
  const descriptor = selected.descriptor ?? JSON.parse(decrypt(assertEncrypted(selected)));
  if (!descriptor.baseUrl || !descriptor.token) {
    throw new GrokBotGatewaySessionError(
      "INCOMPLETE_DESCRIPTOR",
      "Decrypted Grok Bot gateway descriptor is incomplete.",
    );
  }

  return {
    gatewayUrl: String(descriptor.baseUrl).replace(/\/$/, ""),
    gatewayToken: String(descriptor.token),
    headers: descriptor.headers ?? {},
  };
}

export function inspectGrokBotGatewaySession(options = {}) {
  if (!hasGrokBotGatewaySession(options)) {
    return { present: false, usable: false };
  }
  try {
    loadGrokBotGatewaySession(options);
    return { present: true, usable: true };
  } catch (error) {
    return {
      present: true,
      usable: false,
      code: error instanceof GrokBotGatewaySessionError ? error.code : "UNUSABLE_SESSION",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
