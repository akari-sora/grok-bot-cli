import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { decryptGrokBotSafeStorage, grokBotGatewayDescriptorPath } from "./app-session.js";

export class AppAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AppAuthError";
    this.code = code;
  }
}

const SIGN_IN = "Open the Grok Bot app and sign in to that login once.";
const MESSAGES = {
  NO_SECRETS_FILE: `No saved Grok Bot login file was found. ${SIGN_IN}`,
  UNSUPPORTED_VERSION: `This Grok Bot app login file is not a supported version. ${SIGN_IN}`,
  NO_ACCOUNT: `No saved Grok Bot login matches this account. ${SIGN_IN}`,
  DECRYPT_FAILED: `Could not decrypt the saved Grok Bot login. ${SIGN_IN}`,
  EXPIRED: "The saved Grok Bot login has expired. Open the Grok Bot app and sign in to that login once so it can refresh.",
  SCOPE_MISMATCH: `The saved Grok Bot login does not match this account. ${SIGN_IN}`,
  NOT_JWT: `The saved Grok Bot login is not a usable access token. ${SIGN_IN}`,
};

const SCOPE = /^[0-9a-f]{64}$/;
const LEGACY = /^scoped:v1:([0-9a-f]{64}):([\s\S]+)$/;
const ISSUER = "https://authentication.cursor.sh";

function fail(code) {
  return new AppAuthError(code, MESSAGES[code]);
}

function isScope(value) {
  return typeof value === "string" && SCOPE.test(value);
}

function parseAccounts(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function accessTokenValue(secrets, accounts, scope) {
  const entry = accounts?.accounts?.[scope];
  const current = entry?.["cursor-access-token"];
  if (typeof current === "string" && current) return current;
  const legacy = secrets["cursor-access-token"];
  if (typeof legacy !== "string") return null;
  const match = LEGACY.exec(legacy);
  if (match && match[1] === scope) return match[2];
  return null;
}

function reveal(value, options) {
  if (value.startsWith("plaintext:v1:")) return value.slice("plaintext:v1:".length);
  try {
    return decryptGrokBotSafeStorage(value, options);
  } catch {
    throw fail("DECRYPT_FAILED");
  }
}

function readPayload(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw fail("NOT_JWT");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw fail("NOT_JWT");
  }
  if (
    !payload
    || typeof payload !== "object"
    || payload.iss !== ISSUER
    || typeof payload.sub !== "string"
    || !payload.sub
    || typeof payload.exp !== "number"
    || !Number.isFinite(payload.exp)
  ) throw fail("NOT_JWT");
  return payload;
}

/**
 * The Grok Bot app's saved access token for one login. Never reads the refresh
 * token and never writes the app's files. `scope` defaults to `cursor-accounts.active`.
 *
 * @param {object} [options]
 * @param {string} [options.scope]
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.home]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {() => string} [options.getKeychainPassword]
 * @param {(data: Buffer) => Buffer} [options.unprotectData]
 * @param {() => number} [options.now]
 * @param {typeof readFileSync} [options.readFile]
 * @returns {{ token: string, scope: string, expiresAt: number }}
 */
export function loadAppAccessToken({
  scope,
  platform = process.platform,
  home = homedir(),
  env = process.env,
  getKeychainPassword,
  unprotectData,
  now = () => Date.now(),
  readFile = readFileSync,
} = {}) {
  const path = join(dirname(grokBotGatewayDescriptorPath(home, platform, env)), "sand-secrets.json");
  let text;
  try {
    text = readFile(path, "utf8");
  } catch {
    throw fail("NO_SECRETS_FILE");
  }
  let secrets;
  try {
    secrets = JSON.parse(text);
  } catch {
    throw fail("UNSUPPORTED_VERSION");
  }
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets) || secrets.version !== 1) {
    throw fail("UNSUPPORTED_VERSION");
  }
  const accounts = parseAccounts(secrets["cursor-accounts"]);
  const resolved = scope == null || scope === "" ? accounts?.active : scope;
  if (!isScope(resolved)) throw fail("NO_ACCOUNT");
  const stored = accessTokenValue(secrets, accounts, resolved);
  if (!stored) throw fail("NO_ACCOUNT");
  const token = reveal(stored, {
    platform,
    home,
    env,
    ...(getKeychainPassword ? { getKeychainPassword } : {}),
    ...(unprotectData ? { unprotectData } : {}),
  });
  const payload = readPayload(token);
  const actual = crypto.createHash("sha256").update(payload.sub).digest("hex");
  if (actual !== resolved) throw fail("SCOPE_MISMATCH");
  if (!(payload.exp * 1000 > now() + 60_000)) throw fail("EXPIRED");
  return { token, scope: resolved, expiresAt: payload.exp * 1000 };
}
