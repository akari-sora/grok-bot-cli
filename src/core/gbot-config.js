import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { grokBotGatewayDescriptorPath } from "./app-session.js";
import { printableText } from "./url-policy.js";

const NAME = /^[A-Za-z0-9_-]{1,32}$/;

// A failed rename must leave the previous file. Tests replace renameSync to force that failure.
export const writeIo = {
  renameSync: (from, to) => fs.renameSync(from, to),
};
const SCOPE = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const ALLOWED = new Set(["version", "aliases", "default", "gbotVersion"]);

// The copied MCP bundle's import.meta.url is not this source file, so the relative
// package.json read fails there. The fallback matches package.json "version".
function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
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

export function isReservedAliasName(name) {
  return name === "__proto__" || name === "constructor" || name === "prototype"
    || Object.hasOwn(Object.prototype, name);
}

export function emptyGbotConfig() {
  return { version: 1, aliases: Object.create(null), default: null };
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

function copyAliases(source) {
  const aliases = Object.create(null);
  if (!source || typeof source !== "object") return aliases;
  for (const name of Object.keys(source)) {
    aliases[name] = source[name];
  }
  return aliases;
}

function storedEmail(name, email) {
  if (typeof email !== "string" || !email.trim() || email.length > 120 || CONTROL.test(email) || !EMAIL.test(email.trim())) {
    throw invalid(`Alias "${name}" has an unusable email.`);
  }
  return email.trim();
}

export function validateGbotConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("Config must be a JSON object.");
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED.has(key)) throw invalid(`Config has an unknown field "${key}".`);
  }
  if (value.version !== undefined && value.version !== 1) throw invalid("Config version must be 1.");
  if (value.gbotVersion !== undefined && (typeof value.gbotVersion !== "string" || CONTROL.test(value.gbotVersion))) {
    throw invalid("Config gbotVersion must be a string.");
  }
  if (!value.aliases || typeof value.aliases !== "object" || Array.isArray(value.aliases)) {
    throw invalid("Config aliases must be an object.");
  }
  if (!(value.default === null || typeof value.default === "string")) {
    throw invalid("Config default must be an alias name or null.");
  }
  const aliases = Object.create(null);
  for (const name of Object.keys(value.aliases)) {
    const alias = value.aliases[name];
    if (isReservedAliasName(name) || !NAME.test(name)) {
      throw invalid(`Alias name "${name}" must match ${NAME} and must not be a prototype key.`);
    }
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
    if (alias.email !== undefined) stored.email = storedEmail(name, alias.email);
    aliases[name] = stored;
  }
  if (value.default !== null && (isReservedAliasName(value.default) || !Object.hasOwn(aliases, value.default))) {
    throw invalid(`Config default "${value.default}" is not an alias.`);
  }
  return { version: 1, aliases, default: value.default };
}

export function readGbotConfig(options = {}) {
  const path = gbotConfigPath(options);
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
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

// Same-directory temp file, mode 0600, fsync, rename, then fsync the directory.
// A failed rename leaves the previous file in place.
function writeAtomicFile(path, contents) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    const data = Buffer.from(contents);
    let offset = 0;
    while (offset < data.length) offset += fs.writeSync(fd, data, offset);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* the original file is untouched */ }
    throw error;
  }
  fs.closeSync(fd);
  try {
    writeIo.renameSync(tmp, path);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* keep the previous file */ }
    throw error;
  }
  try { fs.chmodSync(path, 0o600); } catch { /* Windows may refuse the Unix mode */ }
  try {
    const dirfd = fs.openSync(dirname(path), "r");
    try { fs.fsyncSync(dirfd); } catch { /* directory fsync is not supported here */ }
    fs.closeSync(dirfd);
  } catch { /* directory fsync is not supported here */ }
}

export function writeGbotConfig(document, options = {}) {
  const stored = validateGbotConfig(document);
  const path = gbotConfigPath(options);
  writeAtomicFile(path, `${JSON.stringify(stored, null, 2)}\n`);
  return stored;
}

function writePrivateJson(path, value) {
  writeAtomicFile(path, `${JSON.stringify(value, null, 2)}\n`);
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
    const secrets = JSON.parse(fs.readFileSync(path, "utf8"));
    const accounts = JSON.parse(secrets["cursor-accounts"]);
    return new Set(Object.keys(accounts?.accounts ?? {}).filter((key) => SCOPE.test(key)));
  } catch {
    return new Set();
  }
}

/** @param {{ file?: string, replace?: boolean, home?: string, platform?: string, env?: NodeJS.ProcessEnv }} [options] */
export function importAccountConfig({ file, replace = false, ...options } = {}) {
  if (typeof file !== "string" || !file.trim()) {
    return { exitCode: 2, messages: ["import needs a file."] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const missing = error && error.code === "ENOENT";
    return { exitCode: 2, messages: [missing ? "Config import file was not found." : "Config import file is not valid JSON."] };
  }
  let incoming;
  try {
    incoming = validateGbotConfig(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Config import file is invalid.";
    return { exitCode: 2, messages: [printableText(message)] };
  }
  let current;
  try {
    current = replace ? emptyGbotConfig() : readGbotConfig(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the gbot config file.";
    return { exitCode: 2, messages: [printableText(message)] };
  }
  const aliases = copyAliases(replace ? incoming.aliases : undefined);
  if (!replace) {
    for (const name of Object.keys(current.aliases)) aliases[name] = current.aliases[name];
    for (const name of Object.keys(incoming.aliases)) aliases[name] = incoming.aliases[name];
  }
  const defaultName = replace || incoming.default !== null ? incoming.default : current.default;
  let stored;
  try {
    stored = validateGbotConfig({ version: 1, aliases, default: defaultName });
    writeGbotConfig(stored, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Config import file is invalid.";
    return { exitCode: 2, messages: [printableText(message)] };
  }
  const signedIn = signedInScopes(options);
  const messages = [];
  for (const name of Object.keys(stored.aliases)) {
    const alias = stored.aliases[name];
    if (signedIn.has(alias.scope)) continue;
    const who = printableText(alias.email || name);
    messages.push(`sign in to ${who} in the Grok Bot app`);
  }
  return { exitCode: messages.length ? 3 : 0, messages };
}
