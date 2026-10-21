import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { grokBotGatewayDescriptorPath } from "./app-session.js";

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const SCOPE = /^[0-9a-f]{64}$/;
const ALLOWED = new Set(["version", "aliases", "default", "gbotVersion"]);

// The copied MCP bundle's import.meta.url is not this source file, so the relative
// package.json read fails there. The fallback matches package.json "version".
function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.11.2";
  }
}

export const GBOT_PACKAGE_VERSION = readPackageVersion();

export class GbotConfigError extends Error {
  constructor(message, { exitCode = 2, code = "INVALID" } = {}) {
    super(message);
    this.name = "GbotConfigError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

export function emptyGbotConfig() {
  return { version: 1, aliases: {}, default: null };
}

export function gbotConfigPath({
  platform = process.platform,
  home = homedir(),
  env = process.env,
} = {}) {
  const override = typeof env.GBOT_CONFIG === "string" ? env.GBOT_CONFIG.trim() : "";
  if (override) return override;
  if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "grok-bot-cli", "config.json");
  }
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(configHome, "grok-bot-cli", "config.json");
}

function invalid(message) {
  return new GbotConfigError(message);
}

export function validateGbotConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("Config must be a JSON object.");
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED.has(key)) throw invalid(`Config has an unknown field "${key}".`);
  }
  if (value.version !== undefined && value.version !== 1) throw invalid("Config version must be 1.");
  if (!value.aliases || typeof value.aliases !== "object" || Array.isArray(value.aliases)) {
    throw invalid("Config aliases must be an object.");
  }
  if (!(value.default === null || typeof value.default === "string")) {
    throw invalid("Config default must be an alias name or null.");
  }
  const aliases = {};
  for (const [name, alias] of Object.entries(value.aliases)) {
    if (!NAME.test(name)) throw invalid(`Alias name "${name}" must match ${NAME}.`);
    if (!alias || typeof alias !== "object" || Array.isArray(alias)) {
      throw invalid(`Alias "${name}" must be an object.`);
    }
    for (const key of Object.keys(alias)) {
      if (key !== "scope" && key !== "email") throw invalid(`Alias "${name}" has an unknown field "${key}".`);
    }
    if (typeof alias.scope !== "string" || !SCOPE.test(alias.scope)) {
      throw invalid(`Alias "${name}" needs a 64-character hex scope.`);
    }
    const stored = { scope: alias.scope };
    if (alias.email !== undefined) {
      if (typeof alias.email !== "string" || !alias.email.trim() || alias.email.length > 120) {
        throw invalid(`Alias "${name}" has an unusable email.`);
      }
      stored.email = alias.email.trim();
    }
    aliases[name] = stored;
  }
  if (value.default !== null && !aliases[value.default]) {
    throw invalid(`Config default "${value.default}" is not an alias.`);
  }
  return { version: 1, aliases, default: value.default };
}

export function readGbotConfig(options = {}) {
  const path = gbotConfigPath(options);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return emptyGbotConfig();
    throw invalid("Could not read the gbot config file.");
  }
  try {
    return validateGbotConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof GbotConfigError) throw error;
    throw invalid("Config file is not valid JSON.");
  }
}

export function writeGbotConfig(document, options = {}) {
  const stored = validateGbotConfig(document);
  const path = gbotConfigPath(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { writeFileSync(path, readFileSync(tmp)); } catch { /* keep the original error */ }
    throw error;
  }
  try { chmodSync(path, 0o600); } catch { /* Windows may refuse the Unix mode */ }
  return stored;
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* Windows may refuse the Unix mode */ }
}

export function exportAccountConfig(options = {}) {
  const current = readGbotConfig(options);
  const doc = {
    version: 1,
    aliases: current.aliases,
    default: current.default,
    gbotVersion: GBOT_PACKAGE_VERSION,
  };
  if (typeof options.out === "string" && options.out.trim()) writePrivateJson(options.out.trim(), doc);
  return doc;
}

function signedInScopes(options) {
  try {
    const path = join(
      dirname(grokBotGatewayDescriptorPath(options.home ?? homedir(), options.platform ?? process.platform, options.env ?? process.env)),
      "sand-secrets.json",
    );
    const secrets = JSON.parse(readFileSync(path, "utf8"));
    const accounts = JSON.parse(secrets["cursor-accounts"]);
    return new Set(Object.keys(accounts?.accounts ?? {}).filter((key) => SCOPE.test(key)));
  } catch {
    return new Set();
  }
}

export function importAccountConfig({ file, replace = false, ...options } = {}) {
  if (typeof file !== "string" || !file.trim()) {
    return { exitCode: 2, messages: ["import needs a file."] };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const missing = error && error.code === "ENOENT";
    return { exitCode: 2, messages: [missing ? "Config import file was not found." : "Config import file is not valid JSON."] };
  }
  let incoming;
  try {
    incoming = validateGbotConfig(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Config import file is invalid.";
    return { exitCode: 2, messages: [message] };
  }
  const current = replace ? emptyGbotConfig() : readGbotConfig(options);
  const aliases = replace ? incoming.aliases : { ...current.aliases, ...incoming.aliases };
  const stored = validateGbotConfig({
    version: 1,
    aliases,
    default: incoming.default,
  });
  writeGbotConfig(stored, options);
  const signedIn = signedInScopes(options);
  const messages = [];
  for (const [name, alias] of Object.entries(stored.aliases)) {
    if (signedIn.has(alias.scope)) continue;
    const who = alias.email || name;
    messages.push(`sign in to ${who} in the Grok Bot app`);
  }
  return { exitCode: messages.length ? 3 : 0, messages };
}
