import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { secretFiles } from "./app-auth.js";
import {
  decryptGrokBotSafeStorage,
  grokBotGatewayDescriptorPath,
  hasGrokBotGatewaySession,
  listGrokBotGatewayAccountSources,
  maskLoginSecrets,
} from "./app-session.js";
import {
  GbotConfigError,
  emptyGbotConfig,
  isReservedAliasName,
  readGbotConfig,
  writeGbotConfig,
} from "./gbot-config.js";
import { printableText } from "./url-policy.js";
import { secretStoreOptions } from "./secret-store.js";

const SCOPE = /^[0-9a-f]{64}$/;
const PREFIX = /^[0-9a-f]{8,}$/i;
const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const SCOPE_FIELDS = ["scope", "accountScope", "accountId", "userId", "sub"];

function selectionError(code, message) {
  const error = new Error(message);
  error.name = "GrokBotGatewaySessionError";
  error.code = code;
  return error;
}

function loginLines(rows) {
  return rows.map((row) => "  " + printableText(row.label) + (row.lastSaved ? " (last saved)" : "")).join("\n");
}

function listed(rows) {
  return "Saved logins:\n" + loginLines(rows);
}

export function shortScope(scope) {
  return String(scope).slice(0, 8);
}

function once(fn) {
  let done = false;
  let value;
  let failure;
  return (...args) => {
    if (!done) {
      done = true;
      try {
        value = fn(...args);
      } catch (error) {
        failure = error;
      }
    }
    if (failure) throw failure;
    return value;
  };
}

function baseOptions(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const secret = options.getKeychainPassword || options.unprotectData ? {} : secretStoreOptions(env);
  return { ...options, env, platform, home, ...secret };
}

function shareReaders(options) {
  const next = { ...options };
  if (typeof options.getKeychainPassword === "function") {
    next.getKeychainPassword = once(options.getKeychainPassword);
  }
  if (typeof options.unprotectData === "function") next.unprotectData = once(options.unprotectData);
  return next;
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
 * Every login stored in the app's `cursor-accounts` map. The refresh token is never decrypted.
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

/** True when a saved access token exists. Does not decrypt profiles or read the OS secret store. */
export function hasSavedAccessToken(options = {}) {
  const opts = baseOptions(options);
  const accounts = readSecrets(opts);
  if (!accounts?.accounts || typeof accounts.accounts !== "object") return false;
  return Object.keys(accounts.accounts).some((scope) => {
    if (!SCOPE.test(scope)) return false;
    const token = accounts.accounts[scope]?.["cursor-access-token"];
    return typeof token === "string" && token.length > 0;
  });
}

function aliasByScope(config) {
  const names = new Map();
  for (const name of Object.keys(config.aliases ?? {})) {
    const alias = config.aliases[name];
    if (!alias || typeof alias.scope !== "string") continue;
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

function descriptorScope(row) {
  if (SCOPE.test(row.id)) return row.id;
  const descriptor = row.descriptor;
  if (!descriptor || typeof descriptor !== "object") return null;
  for (const key of SCOPE_FIELDS) {
    const value = descriptor[key];
    if (typeof value === "string" && SCOPE.test(value)) return value;
  }
  return null;
}

function descriptorEmail(row) {
  const value = row.descriptor?.email;
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (!email || email.length > 120 || !email.includes("@") || /^https?:\/\//i.test(email)) return null;
  return email;
}

function savedForDescriptor(row, describedCount, saved, savedByScope) {
  const scope = descriptorScope(row);
  // A descriptor that names a scope never merges by email. A different saved login
  // for that email stays its own row, and its scope is not attached here.
  if (scope) return savedByScope.has(scope) ? savedByScope.get(scope) : null;
  const email = descriptorEmail(row);
  if (email) {
    const found = saved.filter((item) => item.email && item.email.toLowerCase() === email.toLowerCase());
    if (found.length === 1) return found[0];
  }
  // A legacy v1 descriptor (id "default") merges with the only saved login only when
  // the descriptor itself has neither a scope nor an email. Contradicting evidence stays two rows.
  if (!email && row.id === "default" && describedCount === 1 && saved.length === 1) return saved[0];
  return null;
}

/** Scope for wake and caching. The unverified v1 fallback does not prove an account. */
function provenDescriptorScope(row, login) {
  const own = descriptorScope(row);
  // A descriptor scope only merges the saved login with that same scope, or none.
  if (own) return own;
  const email = descriptorEmail(row);
  if (email && login?.scope && login.email && login.email.toLowerCase() === email.toLowerCase()) return login.scope;
  return null;
}

/**
 * Internal account pin set by gbot for its own relay and MCP workers.
 * Empty means unset. Any other value that is not 64 lowercase hex characters is an error.
 */
export function workerAccountScope(env = process.env) {
  const raw = env?.GBOT_ACCOUNT_SCOPE;
  if (raw == null || raw === "") return "";
  const value = String(raw);
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw selectionError(
      "INVALID_ACCOUNT_SCOPE",
      "GBOT_ACCOUNT_SCOPE must be exactly 64 lowercase hex characters.",
    );
  }
  return value;
}

function readConfigForCatalog(options) {
  if (options.config) return options.config;
  return readGbotConfig(options);
}

/**
 * Descriptor entries plus saved app logins. `label` stays the descriptor label when there is one
 * (masked to `login <n>` when that label aliases a secret). `email` is a separate field.
 * Saved logins add `alias`, `appActive`, and `hasDescriptorEntry`.
 */
export function listLoginCatalog(options = {}) {
  const opts = shareReaders(baseOptions(options));
  const config = readConfigForCatalog(opts);
  const aliases = aliasByScope(config);
  const described = hasGrokBotGatewaySession(opts) ? listGrokBotGatewayAccountSources(opts) : [];
  const saved = listSavedLogins(opts);
  const savedByScope = new Map(saved.map((row) => [row.scope, row]));
  const drafts = [];
  const consumed = new Set();
  for (const row of described) {
    const login = savedForDescriptor(row, described.length, saved, savedByScope);
    const scope = provenDescriptorScope(row, login);
    if (login?.scope) consumed.add(login.scope);
    else if (scope) consumed.add(scope);
    const email = login?.email ?? descriptorEmail(row);
    drafts.push({
      id: row.id,
      scope,
      label: row.label,
      descriptorLabel: row.label,
      email,
      appActive: Boolean(login?.appActive),
      hasDescriptorEntry: true,
      lastSaved: row.lastSaved,
      ...(row.savedAtMs !== undefined ? { savedAtMs: row.savedAtMs } : {}),
      usable: row.usable,
      alias: aliasLabel(scope ? aliases.get(scope) : undefined),
      descriptor: row.descriptor,
    });
  }
  for (const login of saved) {
    if (consumed.has(login.scope)) continue;
    drafts.push({
      id: login.scope,
      scope: login.scope,
      label: login.label,
      descriptorLabel: null,
      email: login.email,
      appActive: login.appActive,
      hasDescriptorEntry: false,
      lastSaved: false,
      usable: login.hasToken,
      alias: aliasLabel(aliases.get(login.scope)),
      descriptor: null,
    });
  }
  return maskLoginSecrets(drafts).map((row) => ({
    id: row.id,
    scope: row.scope,
    label: printableText(row.shownLabel || row.label),
    descriptorLabel: row.descriptorLabel ? printableText(row.descriptorLabel) : null,
    shownId: row.shownId || row.id,
    email: row.email ? printableText(row.email) : null,
    appActive: row.appActive,
    hasDescriptorEntry: row.hasDescriptorEntry,
    lastSaved: row.lastSaved,
    ...(row.savedAtMs !== undefined ? { savedAtMs: row.savedAtMs } : {}),
    usable: row.usable,
    alias: row.alias,
  }));
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
    const label = printableText(row.label);
    const visibleId = printableText(row.shownId || row.id);
    const head = label === visibleId ? `${label}${suffix}` : `${label}${suffix}\n  id ${visibleId}`;
    const email = row.email && printableText(row.email) !== label ? `\n  email ${printableText(row.email)}` : "";
    return row.alias ? `${head}${email}\n  alias ${printableText(row.alias)}` : `${head}${email}`;
  }).join("\n");
}

function ownAlias(aliases, selector) {
  if (!aliases || typeof selector !== "string" || isReservedAliasName(selector) || !Object.hasOwn(aliases, selector)) {
    return null;
  }
  const alias = aliases[selector];
  if (!alias || typeof alias !== "object" || typeof alias.scope !== "string") return null;
  return alias;
}

function matches(row, selector, aliases) {
  if (row.label === selector || row.id === selector || row.shownId === selector || row.descriptorLabel === selector) {
    return true;
  }
  if (row.scope && row.scope.toLowerCase() === selector.toLowerCase()) return true;
  if (row.email && row.email.toLowerCase() === selector.toLowerCase()) return true;
  if (typeof row.label === "string" && row.label.includes("@") && row.label.toLowerCase() === selector.toLowerCase()) {
    return true;
  }
  if (typeof row.descriptorLabel === "string" && row.descriptorLabel.includes("@")
    && row.descriptorLabel.toLowerCase() === selector.toLowerCase()) {
    return true;
  }
  const alias = ownAlias(aliases, selector);
  if (alias && row.scope && alias.scope.toLowerCase() === row.scope.toLowerCase()) return true;
  if (PREFIX.test(selector)) {
    const needle = selector.toLowerCase();
    const id = String(row.id).toLowerCase();
    if (id.startsWith(needle) && id.length > needle.length) return true;
    const shown = String(row.shownId || "").toLowerCase();
    if (shown.startsWith(needle) && shown.length > needle.length && shown !== id) return true;
    if (row.scope && row.scope.toLowerCase().startsWith(needle) && row.scope.length > needle.length) return true;
  }
  return false;
}

function flagSelector(options) {
  return typeof options.account === "string" ? options.account.trim() : "";
}

function envSelector(options) {
  return String(options.env?.GBOT_ACCOUNT ?? "").trim();
}

function tag(row, selectedBy) {
  return row ? { ...row, selectedBy } : null;
}

function implicitRow(rows) {
  if (rows.length === 0) return null;
  const described = rows.filter((row) => row.hasDescriptorEntry);
  if (described.length === 1) return described[0];
  const active = described.filter((row) => row.appActive);
  if (described.length > 1 && active.length === 1) return active[0];
  if (described.length === 0 && rows.length === 1) return rows[0];
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

export function resolveGrokBotLogin(options = {}) {
  const opts = baseOptions(options);
  let config;
  let configError = null;
  try {
    config = readGbotConfig(opts);
  } catch (error) {
    configError = error;
    config = emptyGbotConfig();
  }
  const rows = listLoginCatalog({ ...opts, config });
  const flagged = flagSelector(opts);
  const fromEnv = flagged ? "" : envSelector(opts);
  const explicit = flagged || fromEnv;
  if (configError && !explicit) throw configError;
  let selector = explicit;
  let selectedBy = explicit ? "selector" : "implicit";
  if (!selector && typeof config.default === "string" && config.default) {
    selector = config.default;
    selectedBy = "selector";
  }
  if (!selector) return tag(implicitRow(rows), "implicit");
  const found = rows.filter((row) => matches(row, selector, config.aliases));
  if (found.length === 1) return tag(found[0], selectedBy);
  if (configError) throw configError;
  if (found.length === 0) {
    throw selectionError(
      "UNKNOWN_ACCOUNT",
      `No saved Grok Bot login matches "${printableText(selector)}". Choose one with --account <label> or GBOT_ACCOUNT=<label>.\n${listed(rows)}`,
    );
  }
  throw selectionError(
    "AMBIGUOUS_ENTRIES",
    `More than one saved Grok Bot login matches "${printableText(selector)}". Choose one with --account <label> or GBOT_ACCOUNT=<label>.\n${listed(rows)}`,
  );
}

function copyAliasMap(aliases, name, alias) {
  const next = Object.create(null);
  for (const key of Object.keys(aliases ?? {})) next[key] = aliases[key];
  if (name) next[name] = alias;
  return next;
}

export function defineAlias({ name, selector, ...options }) {
  if (typeof name !== "string" || isReservedAliasName(name) || !NAME.test(name)) {
    throw new GbotConfigError("Alias names must match ^[A-Za-z0-9_-]{1,32}$ and must not be a prototype key.");
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
    aliases: copyAliasMap(current.aliases, name, alias),
    default: current.default,
  }, options);
  return { name, scope: chosen.scope };
}

export function removeAlias({ name, ...options }) {
  if (typeof name !== "string" || isReservedAliasName(name) || !NAME.test(name)) {
    throw new GbotConfigError("Alias names must match ^[A-Za-z0-9_-]{1,32}$ and must not be a prototype key.");
  }
  const current = readGbotConfig(options);
  if (!Object.hasOwn(current.aliases, name)) throw new GbotConfigError(`No alias named "${name}".`);
  const aliases = copyAliasMap(current.aliases);
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
  if (typeof name !== "string" || isReservedAliasName(name) || !Object.hasOwn(current.aliases, name)) {
    throw new GbotConfigError(`No alias named "${name ?? ""}".`);
  }
  writeGbotConfig({ version: 1, aliases: current.aliases, default: name }, options);
}
