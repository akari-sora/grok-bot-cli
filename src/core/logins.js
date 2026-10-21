import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { secretFiles } from "./app-auth.js";
import {
  decryptGrokBotSafeStorage,
  grokBotGatewayDescriptorPath,
  hasGrokBotGatewaySession,
  listGrokBotGatewayAccounts,
} from "./app-session.js";
import {
  GbotConfigError,
  readGbotConfig,
  writeGbotConfig,
} from "./gbot-config.js";
import { secretStoreOptions } from "./secret-store.js";

const SCOPE = /^[0-9a-f]{64}$/;
const PREFIX = /^[0-9a-f]{8,}$/i;
const NAME = /^[A-Za-z0-9_-]{1,32}$/;

function selectionError(code, message) {
  const error = new Error(message);
  error.name = "GrokBotGatewaySessionError";
  error.code = code;
  return error;
}

function loginLines(rows) {
  return rows.map((row) => "  " + row.label + (row.lastSaved ? " (last saved)" : "")).join("\n");
}

function listed(rows) {
  return "Saved logins:\n" + loginLines(rows);
}

export function shortScope(scope) {
  return String(scope).slice(0, 8);
}

function baseOptions(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const secret = options.getKeychainPassword || options.unprotectData ? {} : secretStoreOptions(env);
  return { ...options, env, platform, home, ...secret };
}

function revealText(value, options) {
  if (typeof value !== "string" || !value) return null;
  if (value.startsWith("plaintext:v1:")) return value.slice("plaintext:v1:".length);
  try {
    return decryptGrokBotSafeStorage(value, options);
  } catch {
    return null;
  }
}

function profileEmail(stored, options) {
  const text = revealText(stored, options);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const email = typeof parsed?.email === "string" ? parsed.email.trim() : "";
    if (!email || email.length > 120 || /^https?:\/\//i.test(email)) return null;
    return email;
  } catch {
    return null;
  }
}

function readSecrets(options) {
  const path = join(dirname(grokBotGatewayDescriptorPath(options.home, options.platform, options.env)), "sand-secrets.json");
  let text;
  try {
    text = (options.readFile ?? secretFiles.readFileSync)(path, "utf8");
  } catch {
    return null;
  }
  try {
    const secrets = JSON.parse(text);
    if (!secrets || typeof secrets !== "object" || Array.isArray(secrets) || secrets.version !== 1) return null;
    const accounts = JSON.parse(secrets["cursor-accounts"]);
    if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return null;
    return accounts;
  } catch {
    return null;
  }
}

/**
 * Every login stored in the app's `cursor-accounts` map. The refresh token is never read.
 * A profile that cannot be decrypted is still listed; its label is the first 8 hex characters of the scope.
 *
 * @returns {{ scope: string, label: string, email: string | null, appActive: boolean, hasToken: boolean }[]}
 */
export function listSavedLogins(options = {}) {
  const opts = baseOptions(options);
  const accounts = readSecrets(opts);
  if (!accounts || !accounts.accounts || typeof accounts.accounts !== "object") return [];
  const rows = [];
  for (const scope of Object.keys(accounts.accounts)) {
    if (!SCOPE.test(scope)) continue;
    const record = accounts.accounts[scope];
    const entry = record && typeof record === "object" ? record : {};
    const email = profileEmail(entry["cursor-account-profile"], opts);
    const token = entry["cursor-access-token"];
    rows.push({
      scope,
      label: email || shortScope(scope),
      email,
      appActive: accounts.active === scope,
      hasToken: typeof token === "string" && token.length > 0,
    });
  }
  return rows;
}

function descriptorRows(options) {
  if (!hasGrokBotGatewaySession(options)) return [];
  return listGrokBotGatewayAccounts(options);
}

function aliasByScope(config) {
  const names = new Map();
  for (const [name, alias] of Object.entries(config.aliases ?? {})) {
    const list = names.get(alias.scope) ?? [];
    list.push(name);
    names.set(alias.scope, list);
  }
  return names;
}

function aliasLabel(names) {
  if (!names || names.length === 0) return null;
  return [...names].sort().join(", ");
}

/**
 * Descriptor entries plus saved app logins. Existing descriptor fields stay (`id`, `label`,
 * `lastSaved`, `savedAtMs`, `usable`). Saved logins add `email`, `alias`, `appActive`,
 * and `hasDescriptorEntry`.
 */
export function listLoginCatalog(options = {}) {
  const opts = baseOptions(options);
  const config = readGbotConfig(opts);
  const aliases = aliasByScope(config);
  const described = descriptorRows(opts);
  const saved = listSavedLogins(opts);
  const savedByScope = new Map(saved.map((row) => [row.scope, row]));
  const rows = [];
  const seen = new Set();
  for (const row of described) {
    const login = SCOPE.test(row.id) ? savedByScope.get(row.id) : undefined;
    seen.add(row.id);
    const email = login?.email ?? null;
    rows.push({
      id: row.id,
      scope: SCOPE.test(row.id) ? row.id : null,
      label: email || row.label,
      email,
      appActive: Boolean(login?.appActive),
      hasDescriptorEntry: true,
      lastSaved: row.lastSaved,
      ...(row.savedAtMs !== undefined ? { savedAtMs: row.savedAtMs } : {}),
      usable: row.usable,
      alias: aliasLabel(SCOPE.test(row.id) ? aliases.get(row.id) : undefined),
    });
  }
  for (const login of saved) {
    if (seen.has(login.scope)) continue;
    rows.push({
      id: login.scope,
      scope: login.scope,
      label: login.label,
      email: login.email,
      appActive: login.appActive,
      hasDescriptorEntry: false,
      lastSaved: false,
      usable: login.hasToken,
      alias: aliasLabel(aliases.get(login.scope)),
    });
  }
  return rows;
}

export function formatLoginCatalog(rows) {
  if (!rows.length) return "No saved Grok Bot logins. Open the Grok Bot app and sign in once.";
  return rows.map((row) => {
    const notes = [
      row.appActive ? "(app active)" : "",
      row.lastSaved ? "(last saved)" : "",
      row.hasDescriptorEntry ? "" : "(no app session; gbot builds one from the saved login)",
      row.usable ? "" : "(unusable)",
    ].filter(Boolean);
    const suffix = notes.length ? ` ${notes.join(" ")}` : "";
    const head = row.label === row.id ? `${row.label}${suffix}` : `${row.label}${suffix}\n  id ${row.id}`;
    return row.alias ? `${head}\n  alias ${row.alias}` : head;
  }).join("\n");
}

function matches(row, selector, aliases) {
  if (row.label === selector || row.id === selector) return true;
  if (row.scope && row.scope.toLowerCase() === selector.toLowerCase()) return true;
  if (row.email && row.email.toLowerCase() === selector.toLowerCase()) return true;
  if (typeof row.label === "string" && row.label.includes("@") && row.label.toLowerCase() === selector.toLowerCase()) {
    return true;
  }
  const alias = aliases?.[selector];
  if (alias && row.scope && alias.scope.toLowerCase() === row.scope.toLowerCase()) return true;
  if (PREFIX.test(selector)) {
    const needle = selector.toLowerCase();
    const id = String(row.id).toLowerCase();
    if (id.startsWith(needle) && id.length > needle.length) return true;
    if (row.scope && row.scope.toLowerCase().startsWith(needle) && row.scope.length > needle.length) return true;
  }
  return false;
}

function selectorFrom(options, config) {
  if (typeof options.account === "string" && options.account.trim()) return options.account.trim();
  const fromEnv = String(options.env?.GBOT_ACCOUNT ?? "").trim();
  if (fromEnv) return fromEnv;
  return typeof config.default === "string" ? config.default : "";
}

export function resolveGrokBotLogin(options = {}) {
  const opts = baseOptions(options);
  const config = readGbotConfig(opts);
  const selector = selectorFrom(opts, config);
  const rows = listLoginCatalog(opts);
  if (!selector) {
    if (rows.length === 1) return rows[0];
    if (rows.length === 0) return null;
    throw selectionError(
      "AMBIGUOUS_ENTRIES",
      [
        "Grok Bot gateway descriptor has multiple saved gateway entries and no active entry selection.",
        "Choose one with --account <label> or GBOT_ACCOUNT=<label>.",
        "Saved logins:",
        loginLines(rows),
      ].join("\n"),
    );
  }
  const found = rows.filter((row) => matches(row, selector, config.aliases));
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    throw selectionError(
      "UNKNOWN_ACCOUNT",
      `No saved Grok Bot login matches "${selector}". Choose one with --account <label> or GBOT_ACCOUNT=<label>.\n${listed(rows)}`,
    );
  }
  throw selectionError(
    "AMBIGUOUS_ENTRIES",
    `More than one saved Grok Bot login matches "${selector}". Choose one with --account <label> or GBOT_ACCOUNT=<label>.\n${listed(rows)}`,
  );
}

export function defineAlias({ name, selector, ...options }) {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new GbotConfigError("Alias names must match ^[A-Za-z0-9_-]{1,32}$.");
  }
  if (typeof selector !== "string" || !selector.trim()) {
    throw new GbotConfigError("alias needs a login selector.");
  }
  const chosen = resolveGrokBotLogin({ ...options, account: selector.trim() });
  if (!chosen?.scope) {
    throw new GbotConfigError("That login has no account scope gbot can store as an alias.");
  }
  const current = readGbotConfig(options);
  const alias = { scope: chosen.scope };
  if (chosen.email) alias.email = chosen.email;
  writeGbotConfig({
    version: 1,
    aliases: { ...current.aliases, [name]: alias },
    default: current.default,
  }, options);
  return { name, scope: chosen.scope };
}

export function removeAlias({ name, ...options }) {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new GbotConfigError("Alias names must match ^[A-Za-z0-9_-]{1,32}$.");
  }
  const current = readGbotConfig(options);
  if (!current.aliases[name]) throw new GbotConfigError(`No alias named "${name}".`);
  const aliases = { ...current.aliases };
  delete aliases[name];
  writeGbotConfig({
    version: 1,
    aliases,
    default: current.default === name ? null : current.default,
  }, options);
}

export function setDefaultAccount({ name, clear = false, ...options }) {
  const current = readGbotConfig(options);
  if (clear) {
    writeGbotConfig({ version: 1, aliases: current.aliases, default: null }, options);
    return;
  }
  if (typeof name !== "string" || !current.aliases[name]) {
    throw new GbotConfigError(`No alias named "${name ?? ""}".`);
  }
  writeGbotConfig({ version: 1, aliases: current.aliases, default: name }, options);
}
