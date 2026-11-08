import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { AppAuthError, loadAppAccessToken } from "./app-auth.js";
import { cursorClientVersion, forgetCachedAppVersion } from "./client-version.js";
import { ensureSandboxHeaders, headersFromEnsureSandbox, headersFromEnv, mergeGatewayHeaders, normalizeHeaderMap, requestHeaders } from "./headers.js";
import { hasGrokBotGatewaySession, loadGrokBotGatewaySession } from "./app-session.js";
import { hasSavedAccessToken, resolveGrokBotLogin, workerAccountScope } from "./logins.js";
import { secretStoreOptions } from "./secret-store.js";
import { AVATAR_COLORS, AVATAR_SHAPES, MAX_GROUP_MEMBERS } from "./store.js";
import { assertAllowedCredentialUrl, redactKnownSecrets, redactSecrets } from "./url-policy.js";
import { grokApproval, grokApprovalResponseSchema } from "./grok-approvals.js";

export class GatewayError extends Error {
  constructor(message, info = {}) {
    super(redactSecrets(message));
    this.name = "GatewayError";
    this.status = info.status;
    this.method = info.method;
    if (info.code !== undefined) this.code = info.code;
    if (info.effect !== undefined) this.effect = info.effect;
    if (info.failureCode !== undefined) this.failureCode = info.failureCode;
    if (info.kind !== undefined) this.kind = info.kind;
    if (info.wake !== undefined) this.wake = info.wake;
    if (info.failureReason !== undefined) this.failureReason = info.failureReason;
    if (info.runState !== undefined) this.runState = info.runState;
  }
}

// Reads keep the 30s budget. Sends stay on the 15s fork deadline: a slow send
// is delivery-unknown, and waiting longer only delays the "do not resend" error.
export const GATEWAY_TIMEOUT_MS = 30000;
export const SEND_GATEWAY_TIMEOUT_MS = 15_000;
// Default read cap. `skills list` on a real account passed the old 2 MiB (2026-10-20); the read
// still streams and stops at the cap. GBOT_MAX_RESPONSE_BYTES sets it to a byte count from 64 KiB to
// 64 MiB (peak memory is a few times the cap); any other value is ignored.
export const GATEWAY_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MIN_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

function responseBytesFromEnv(env) {
  const raw = String(env.GBOT_MAX_RESPONSE_BYTES ?? "").trim();
  if (!raw) return { set: false, value: null };
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  const ok = Number.isSafeInteger(n) && n >= MIN_RESPONSE_BYTES && n <= MAX_RESPONSE_BYTES;
  return { set: true, value: ok ? n : null };
}

export function gatewayMaxResponseBytes(env = process.env) {
  return responseBytesFromEnv(env).value ?? GATEWAY_MAX_RESPONSE_BYTES;
}

// Live (2026-10-20): while a login's box is asleep, every gateway call answers 417 Expectation Failed
// with an empty body and `x-anyrun-failure-reason: pod_hibernated` (`proxy-status: anyrun-proxy;
// error=destination_unavailable; details="pod_hibernated"`). Opening the app in the background
// (`open -g -b com.anysphere.sand`) or a bare `grokbot://` (`open -g`) did not wake it; selecting a bot
// of that login in the app did.
const ASLEEP_HINT = " (the Grok Bot box for this login is asleep: open the Grok Bot app and select a bot of this login, or switch the app to this login, then retry)";

function assertGatewayActive(signal) {
  if (signal?.aborted) {
    const error = new GatewayError("Gateway submission cancelled before transmission");
    error.delivery = "rejected";
    error.reason = "cancelled";
    throw error;
  }
}

function gatewayDeadline(signal, timeoutMs = GATEWAY_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isDeadlineError(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError";
}

function backendBase() {
  return (
    process.env.CURSOR_API_BASE_URL ||
    "https://api2.cursor.sh"
  ).replace(/\/$/, "");
}

function accessTokenFromEnv() {
  return (process.env.CURSOR_ACCESS_TOKEN || "").trim();
}

function gatewayTokenFromEnv() {
  return (process.env.GROK_BOT_GATEWAY_TOKEN || "").trim();
}

function gatewayOverride() {
  const token = gatewayTokenFromEnv();
  const url = (process.env.GROK_BOT_GATEWAY_URL || "").trim();
  if (url && token) {
    return {
      gatewayUrl: assertAllowedCredentialUrl(url.replace(/\/$/, ""), { kind: "gateway" }),
      gatewayToken: token,
      gatewayHeaders: headersFromEnv(),
    };
  }
  return null;
}

function toGatewayError(error) {
  if (error instanceof GatewayError) return error;
  if (error instanceof Error) {
    return new GatewayError(error.message, error.code ? { code: error.code } : {});
  }
  return error;
}

function sessionFields(loaded) {
  return {
    gatewayUrl: assertAllowedCredentialUrl(loaded.gatewayUrl, { kind: "gateway" }),
    gatewayToken: loaded.gatewayToken,
    gatewayHeaders: mergeGatewayHeaders(normalizeHeaderMap(loaded.headers), headersFromEnv()),
    ...(loaded.accountScope ? { accountScope: loaded.accountScope } : {}),
  };
}

function descriptorSession(account) {
  const loaded = loadGrokBotGatewaySession({ account, ...secretStoreOptions() });
  return loaded ? sessionFields(loaded) : null;
}

// An implicit app login may fall back to CURSOR_ACCESS_TOKEN only for the read, decrypt,
// and expiry failures listed here. A named selector, a host-policy rejection, an unsupported
// descriptor version, and any other backend error fail closed and must not switch accounts.
// UNSUPPORTED_VERSION is intentionally absent: a descriptor this build cannot read does not
// fall back, including when the login was chosen implicitly.
const IMPLICIT_AUTH_FAILURES = new Set([
  "EXPIRED",
  "DECRYPT_FAILED",
  "NOT_JWT",
  "NO_ACCOUNT",
  "NO_SECRETS_FILE",
  "SCOPE_MISMATCH",
  "UNUSABLE_SESSION",
  "MISSING_ENCRYPTED_PAYLOAD",
  "INCOMPLETE_DESCRIPTOR",
  "UNREADABLE_ENTRIES",
  "EMPTY_ENTRIES",
  "MISSING_SAFE_STORAGE_KEY",
]);

function implicitAuthFallback(error) {
  if (!accessTokenFromEnv()) return false;
  if (error instanceof GatewayError && (error.status || error.method === "EnsureSandBox")) return false;
  if (/Rejected /.test(String(error?.message ?? ""))) return false;
  if (typeof error?.code === "string" && IMPLICIT_AUTH_FAILURES.has(error.code)) return true;
  return /could not decrypt|Safe Storage|bad decrypt/i.test(String(error?.message ?? ""));
}

function scrubOutbound(error, secrets) {
  const message = redactKnownSecrets(error instanceof Error ? error.message : String(error), secrets);
  if (error instanceof GatewayError) {
    if (message === error.message) return error;
    const next = new GatewayError(message, {
      status: error.status,
      method: error.method,
      code: error.code,
      effect: error.effect,
      failureCode: error.failureCode,
      kind: error.kind,
      wake: error.wake,
      failureReason: error.failureReason,
      runState: error.runState,
    });
    if (error.delivery) next.delivery = error.delivery;
    if (error.reason) next.reason = error.reason;
    return next;
  }
  if (error instanceof AppAuthError) return new AppAuthError(error.code, message);
  return new GatewayError(message, error?.code ? { code: error.code } : {});
}

const sessionsByScope = new Map();
const savedLoginSessions = new WeakSet();

function sessionCacheKey(scope) {
  return [
    scope,
    process.env.HOME || "",
    process.env.USERPROFILE || "",
    process.env.GBOT_CONFIG || "",
    process.env.CURSOR_API_BASE_URL || "",
  ].join("\0");
}

function rememberSession(session) {
  if (session?.accountScope && /^[0-9a-f]{64}$/.test(session.accountScope)) {
    savedLoginSessions.add(session);
    sessionsByScope.set(sessionCacheKey(session.accountScope), session);
  }
  return session;
}

function forgetSession(scope) {
  if (scope && /^[0-9a-f]{64}$/.test(scope)) sessionsByScope.delete(sessionCacheKey(scope));
}

function cachedSession(scope) {
  if (!scope || !/^[0-9a-f]{64}$/.test(scope)) return null;
  return sessionsByScope.get(sessionCacheKey(scope)) ?? null;
}

async function sessionFromSavedLogin(scope, signal) {
  const cached = cachedSession(scope);
  if (cached) return cached;
  let loaded;
  try {
    loaded = loadAppAccessToken({ scope, home: homedir(), env: process.env, ...secretStoreOptions() });
  } catch (error) {
    throw scrubOutbound(toGatewayError(error), []);
  }
  let described;
  try {
    described = await describeSandbox(loaded.token, { signal, appLogin: true });
  } catch (error) {
    throw scrubOutbound(error, [loaded.token]);
  }
  const running = described?.runState === "RUNNING" && described.gatewayUrl && described.gatewayToken;
  let sandbox = described;
  if (!running) {
    if (!autoWakeEnabled()) {
      throw new GatewayError(
        "The Grok Bot box for this login is asleep and GBOT_AUTO_WAKE=0.",
        { code: "BOX_ASLEEP", method: "EnsureSandBox", ...(described?.runState ? { runState: described.runState } : {}) },
      );
    }
    try {
      sandbox = await wakeSandbox(loaded.token, { signal, appLogin: true });
    } catch (error) {
      throw scrubOutbound(error, [loaded.token, described?.gatewayToken]);
    }
  }
  return attachBackend(rememberSession({
    gatewayUrl: sandbox.gatewayUrl,
    gatewayToken: sandbox.gatewayToken,
    gatewayHeaders: sandbox.gatewayHeaders,
    accountScope: scope,
  }), { scope, token: loaded.token, expiresAt: loaded.expiresAt });
}

// A descriptor login carries a box gateway token only. When its scope is known and the app saved an
// access token for it, the session also gets the backend. Without one it stays gateway-only, as before.
function withScopedBackend(session) {
  if (!session || typeof session.accountScope !== "string" || !SCOPE_RE.test(session.accountScope)) return session;
  try {
    const loaded = loadAppAccessToken({ scope: session.accountScope, home: homedir(), env: process.env, ...secretStoreOptions() });
    return attachBackend(session, { scope: session.accountScope, token: loaded.token, expiresAt: loaded.expiresAt });
  } catch (error) {
    debug("no backend access token for this login (" + (error?.code || "unreadable") + "); using the box gateway only");
    return session;
  }
}

// Precedence: gateway URL+token override, then --account, GBOT_ACCOUNT_SCOPE, GBOT_ACCOUNT,
// the config default, then the descriptor single entry or its active entry. An invalid
// GBOT_ACCOUNT_SCOPE throws before that override is read. A valid or empty pin does not:
// both gateway override variables still win. A saved-only login
// is used only when it is selected or it is the only login. Descriptor sessions are read again
// on every connect. Only a session built from EnsureSandBox is cached by scope. CURSOR_ACCESS_TOKEN
// is only for no app login, or an implicit login that cannot be read, decrypted, or is expired.
// A selector that misses, an unsupported descriptor version, an unusable selected login, a
// host-policy rejection, and any other backend error do not switch accounts.
async function sessionFromApp(account, signal) {
  let choice;
  try {
    choice = resolveGrokBotLogin({ account, ...secretStoreOptions() });
  } catch (error) {
    throw scrubOutbound(toGatewayError(error), []);
  }
  if (!choice) {
    try {
      return withScopedBackend(descriptorSession(account));
    } catch (error) {
      if (implicitAuthFallback(error)) return null;
      throw scrubOutbound(toGatewayError(error), []);
    }
  }
  try {
    if (choice.hasDescriptorEntry) {
      let session = descriptorSession(choice.id);
      if (!session) {
        throw new GatewayError("The selected Grok Bot login could not be read.", { code: "UNUSABLE_SESSION" });
      }
      // choice.scope is set only when the descriptor's own scope or email proves the account.
      if (choice.scope && !session.accountScope) session = { ...session, accountScope: choice.scope };
      return withScopedBackend(session);
    }
    return await sessionFromSavedLogin(choice.scope, signal);
  } catch (error) {
    if (choice.selectedBy !== "selector" && implicitAuthFallback(error)) return null;
    throw scrubOutbound(error, []);
  }
}

export function hasGatewayAuth() {
  if (gatewayOverride() || accessTokenFromEnv() || hasGrokBotGatewaySession()) return true;
  try {
    return hasSavedAccessToken();
  } catch {
    return false;
  }
}

function raceSignal(promise, signal, onAbort) {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    try { onAbort?.(); } catch { /* already closed */ }
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      try { onAbort?.(); } catch { /* already closed */ }
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function tooLargeMessage(maxBytes) {
  const env = responseBytesFromEnv(process.env);
  let hint = "";
  if (env.set && env.value === null) hint = "; GBOT_MAX_RESPONSE_BYTES was ignored: not a byte count from " + MIN_RESPONSE_BYTES + " to " + MAX_RESPONSE_BYTES;
  else if (maxBytes < MAX_RESPONSE_BYTES) hint = "; set GBOT_MAX_RESPONSE_BYTES to a byte count up to " + MAX_RESPONSE_BYTES + " to read it";
  return "Gateway response too large (over " + maxBytes + " bytes)" + hint;
}

async function readTextCapped(res, maxBytes, signal) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const text = await raceSignal(res.text(), signal);
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new GatewayError(tooLargeMessage(maxBytes));
    }
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await raceSignal(reader.read(), signal, () => reader.cancel());
    if (done) break;
    bytes += value.byteLength ?? value.length;
    if (bytes > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new GatewayError(tooLargeMessage(maxBytes));
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer ?? c, c.byteOffset ?? 0, c.byteLength ?? c.length))).toString("utf8");
}

async function readJson(res, signal) {
  const text = await readTextCapped(res, gatewayMaxResponseBytes(), signal);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== "") return obj[key];
  }
  return undefined;
}

const RUN_STATE = {
  SAND_BOX_RUN_STATE_RUNNING: "RUNNING",
  SAND_BOX_RUN_STATE_HIBERNATED: "HIBERNATED",
  SAND_BOX_RUN_STATE_STARTING: "STARTING",
};

function normalizeRunState(value) {
  // Omitted runState stays unset. Callers treat gateway fields with no runState as the
  // historical EnsureSandBox success shape. An unrecognized value is `unknown`.
  if (value == null || value === "") return undefined;
  return RUN_STATE[String(value)] || "unknown";
}

function positiveTestMs(env, name) {
  const test = /^(1|true|yes)$/i.test(String(env.GROK_BOT_TEST ?? "").trim());
  if (!test) return null;
  const n = Number(String(env[name] ?? "").trim());
  return Number.isSafeInteger(n) && n >= 1 && n <= 90_000 ? n : null;
}

/** 90s budget and 3s poll. Tests (`GROK_BOT_TEST`) may shorten both. */
export function sandboxWakeBudget(env = process.env) {
  return {
    timeoutMs: positiveTestMs(env, "GBOT_WAKE_TIMEOUT_MS") ?? 90_000,
    intervalMs: positiveTestMs(env, "GBOT_WAKE_POLL_MS") ?? 3_000,
  };
}

function sandboxFields(body) {
  const gatewayUrl = pick(body, "gatewayUrl", "gateway_url");
  const gatewayToken = pick(body, "gatewayToken", "gateway_token");
  if (!gatewayUrl || !gatewayToken) return {};
  return {
    gatewayUrl: assertAllowedCredentialUrl(String(gatewayUrl).replace(/\/$/, ""), { kind: "gateway" }),
    gatewayToken: String(gatewayToken),
    gatewayHeaders: mergeGatewayHeaders(headersFromEnsureSandbox(body), headersFromEnv()),
  };
}

/** @returns {result is NonNullable<Awaited<ReturnType<typeof ensureSandbox>>>} */
function sandboxReady(result) {
  const hasGateway = Boolean(result?.gatewayUrl) && Boolean(result?.gatewayToken);
  if (!hasGateway) return false;
  // Gateway fields and no runState is the historical success body. An explicit
  // `unknown` is not ready, even when it names a gateway.
  return result.runState == null || result.runState === "RUNNING";
}

async function ensureSandbox(accessToken, { signal, wake = true, appLogin = false, timeoutMs } = {}) {
  assertGatewayActive(signal);
  // The app login token is an account credential gbot reads itself. ALLOW_ANY stays a
  // break-glass for gateway hosts and a user-supplied CURSOR_ACCESS_TOKEN only.
  const url = assertAllowedCredentialUrl(backendBase(), { kind: "backend", ignoreAllowAny: appLogin }) + "/aiserver.v1.GrokBotService/EnsureSandBox";
  let res, body;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: gatewayDeadline(signal, timeoutMs ?? GATEWAY_TIMEOUT_MS),
      headers: ensureSandboxHeaders(accessToken),
      // Live on macOS 2026-10-21: {wake:true} with an app login token took a hibernated box to
      // RUNNING in about 10s. {wake:false} only describes it.
      body: JSON.stringify({ wake: Boolean(wake) }),
    });
    body = await readJson(res);
  } catch (error) {
    assertGatewayActive(signal);
    const secrets = collectSandboxSecrets(accessToken, null);
    if (isDeadlineError(error) || signal?.aborted) {
      if (error instanceof Error) {
        const redacted = redactKnownSecrets(error.message, secrets);
        if (redacted !== error.message) error.message = redacted;
      }
      throw error;
    }
    throw scrubOutbound(error, secrets);
  }
  assertGatewayActive(signal);
  const secrets = collectSandboxSecrets(accessToken, body);
  if (!res.ok) {
    let detail = body.message || body.error || body.raw || res.statusText;
    if (res.status === 401 && /no longer supported/i.test(String(detail))) {
      const version = cursorClientVersion();
      detail = `${detail} (gbot sent x-cursor-client-version ${version}; set SAND_CLIENT_VERSION to override)`;
      // cursorClientVersion() just above recorded whether this value came from the app.
      // Forget drops that cache only for an installed-app value, at most once per 10 minutes.
      forgetCachedAppVersion();
    }
    throw new GatewayError("EnsureSandBox failed: " + res.status + " " + redactKnownSecrets(detail, secrets), { status: res.status, method: "EnsureSandBox" });
  }
  try {
    const fields = sandboxFields(body);
    return { ...fields, runState: normalizeRunState(pick(body, "runState", "run_state")) };
  } catch (error) {
    throw scrubOutbound(error, secrets);
  }
}

function collectSandboxSecrets(accessToken, body) {
  const secrets = [];
  const add = (value) => {
    if (typeof value === "string" && value.length >= 8 && !secrets.includes(value)) secrets.push(value);
  };
  add(accessToken);
  if (!body || typeof body !== "object") return secrets;
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string" && /token|authorization|cookie/i.test(key)) add(value);
  }
  const headers = body.headers || body.gatewayHeaders || body.gateway_headers;
  if (headers && typeof headers === "object") {
    for (const value of Object.values(headers)) add(value);
  }
  return secrets;
}

function abortableSleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function describeSandbox(accessToken, options = {}) {
  return ensureSandbox(accessToken, { ...options, wake: false });
}

const ENSURE_CALL_CAP_MS = 30_000;

function wakeFailureError(result, { timedOut = false } = {}) {
  const starting = result?.runState === "STARTING";
  return new GatewayError(
    starting ? "The Grok Bot box is still starting." : "The Grok Bot box did not start.",
    {
      code: timedOut ? "WAKE_TIMEOUT" : "WAKE_FAILED",
      method: "EnsureSandBox",
      ...(result?.runState ? { runState: result.runState } : {}),
    },
  );
}

// Poll STARTING, RUNNING that still has no gateway fields, and an explicit `unknown`
// that names gateway fields. `unknown` plus a gateway is not ready: the host named a
// gateway but not a known running state, so keep polling instead of applying the session.
// A missing runState is not `unknown`; with gateway fields it is ready.
function shouldPollSandbox(result) {
  const hasGateway = Boolean(result?.gatewayUrl) && Boolean(result?.gatewayToken);
  if (result?.runState === "unknown" && hasGateway) return true;
  if (result?.runState === "STARTING") return true;
  if (result?.runState === "RUNNING" && !hasGateway) return true;
  return false;
}

/** @param {string} accessToken
 * @param {{ signal?: AbortSignal, timeoutMs?: number, intervalMs?: number, appLogin?: boolean, now?: () => number }} [options]
 */
export async function wakeSandbox(accessToken, { signal, timeoutMs, intervalMs, appLogin = false, now = Date.now } = {}) {
  const budget = sandboxWakeBudget();
  const timeout = timeoutMs ?? budget.timeoutMs;
  const interval = intervalMs ?? budget.intervalMs;
  const callCap = positiveTestMs(process.env, "GBOT_WAKE_CALL_CAP_MS") ?? ENSURE_CALL_CAP_MS;
  const started = now();
  const left = () => timeout - (now() - started);
  const call = async (wake) => {
    const remaining = left();
    if (remaining <= 0) return null;
    try {
      return await ensureSandbox(accessToken, {
        signal,
        wake,
        appLogin,
        timeoutMs: Math.min(callCap, remaining),
      });
    } catch (error) {
      if (signal?.aborted || error?.reason === "cancelled") throw error;
      if (isDeadlineError(error)) return null;
      throw error;
    }
  };
  const budgetExpired = (result) => {
    throw wakeFailureError(result, { timedOut: true });
  };
  let result = await call(true);
  // The first request was wake:true even when that call hit its own deadline.
  let wakePosts = 1;
  while (!sandboxReady(result)) {
    if (result?.runState === "HIBERNATED") {
      if (left() <= 0) budgetExpired(result);
      if (wakePosts >= 2) throw wakeFailureError(result);
      const remaining = left();
      await abortableSleep(Math.min(interval, remaining), signal);
      const again = await call(true);
      wakePosts += 1;
      if (again) {
        result = again;
        continue;
      }
      if (left() <= 0) budgetExpired(result);
      // The extra wake:true timed out. The HIBERNATED body is stale, so keep polling.
      result = null;
    } else if (result && !shouldPollSandbox(result)) {
      throw wakeFailureError(result);
    } else {
      const remaining = left();
      if (remaining <= 0) budgetExpired(result);
      await abortableSleep(Math.min(interval, remaining), signal);
    }
    const polled = await call(false);
    if (!polled) {
      if (left() <= 0) budgetExpired(result);
      continue;
    }
    result = polled;
  }
  return result;
}

export async function connectGateway({ signal, account } = {}) {
  assertGatewayActive(signal);
  // Invalid GBOT_ACCOUNT_SCOPE fails closed before the override. A valid pin still loses to it.
  const pinned = workerAccountScope();
  const override = gatewayOverride();
  if (override) return override;
  const selected = typeof account === "string" && account.trim()
    ? account.trim()
    : (pinned || undefined);
  const fromApp = await sessionFromApp(selected, signal);
  if (fromApp) return fromApp;
  const token = accessTokenFromEnv();
  if (!token) {
    throw new GatewayError("Set CURSOR_ACCESS_TOKEN, or GROK_BOT_GATEWAY_URL + GROK_BOT_GATEWAY_TOKEN. Do not use a Cursor dashboard API key.");
  }
  let sandbox;
  try {
    sandbox = await wakeSandbox(token, { signal });
  } catch (error) {
    if (error instanceof GatewayError && error.code === "WAKE_FAILED" && error.runState == null) {
      throw new GatewayError("EnsureSandBox returned no gatewayUrl/gatewayToken. Auth may be a dashboard API key (those do not work).");
    }
    throw error;
  }
  return attachBackend(
    { gatewayUrl: sandbox.gatewayUrl, gatewayToken: sandbox.gatewayToken, gatewayHeaders: sandbox.gatewayHeaders },
    { env: true },
  );
}

function redactDetail(detail, session) {
  let text = redactSecrets(String(detail ?? "").slice(0, 300));
  const secrets = [];
  if (typeof session?.gatewayToken === "string") secrets.push(session.gatewayToken);
  const headers = session?.gatewayHeaders;
  if (headers && typeof headers === "object") {
    for (const value of Object.values(headers)) {
      if (typeof value === "string") secrets.push(value);
    }
  }
  for (const secret of secrets) {
    if (secret.length >= 8) text = text.split(secret).join("<redacted>");
  }
  return text;
}

// Live gateway failures are distinct: auth, a moved box, an unknown method, and a down server.
function failureKind(status, contentType, data, failureReason) {
  const failureCode = data && typeof data.failureCode === "string" && data.failureCode
    ? data.failureCode
    : undefined;
  const type = String(contentType || "").toLowerCase();
  let kind;
  if (failureCode === "gateway/unknown-method") kind = "unsupported";
  else if (status === 401 || status === 403) kind = "auth";
  else if (
    status === 404
    && type.includes("text/plain")
    && data
    && typeof data.raw === "string"
    && data.raw.includes("could not be routed")
  ) kind = "routing";
  // A 417 is an asleep box when the proxy says pod_hibernated, when neither the proxy nor the body names a
  // reason (the live answer always had the header), or when the failureCode says so. A 417 whose proxy
  // reason is something else stays a client failure.
  else if (
    status === 417
    && (/^pod_hibernated$/i.test(failureReason ?? "") || (!failureReason && !failureCode) || /sleep|hibernat/i.test(failureCode ?? ""))
  ) kind = "asleep";
  else if (status >= 500) kind = "server";
  else if (status >= 400 && status < 500) kind = "client";
  return { failureCode, kind };
}

function autoWakeEnabled() {
  return String(process.env.GBOT_AUTO_WAKE ?? "").trim() !== "0";
}

function overrideEnvConfigured() {
  return Boolean((process.env.GROK_BOT_GATEWAY_URL || "").trim() && (process.env.GROK_BOT_GATEWAY_TOKEN || "").trim());
}

function canAutoWake(session) {
  if (typeof session?.accountScope !== "string" || !/^[0-9a-f]{64}$/.test(session.accountScope)) return false;
  if (!autoWakeEnabled()) return false;
  // Both env vars set means an override, even when the URL would throw in gatewayOverride().
  if (overrideEnvConfigured()) return false;
  return true;
}

function wakeReason(code) {
  switch (code) {
    case "EXPIRED": return "token expired";
    case "NO_SECRETS_FILE": return "no saved login";
    case "UNSUPPORTED_VERSION": return "unsupported login file";
    case "NO_ACCOUNT": return "no saved login for this account";
    case "DECRYPT_FAILED": return "could not decrypt the login";
    case "SCOPE_MISMATCH": return "login does not match this account";
    case "NOT_JWT": return "saved login is not usable";
    case "WAKE_TIMEOUT": return "timed out";
    case "UNAUTHORIZED": return "unauthorized";
    default: return "backend error";
  }
}

function wakeFailure(error) {
  if (error instanceof AppAuthError) return { code: error.code, reason: wakeReason(error.code) };
  if (error instanceof GatewayError && error.status === 401 && /no longer supported/i.test(error.message)) {
    const hint = /\(gbot sent x-cursor-client-version [^)]*\)/.exec(error.message);
    return {
      code: "CLIENT_VERSION_REJECTED",
      reason: hint ? `client version rejected ${hint[0]}` : "client version rejected",
    };
  }
  if (error instanceof GatewayError && (error.status === 401 || error.status === 403)) {
    return { code: "UNAUTHORIZED", reason: "unauthorized" };
  }
  if (error?.code === "WAKE_TIMEOUT" || error?.code === "WAKE_FAILED") {
    return { code: error.code, reason: wakeReason(error.code) };
  }
  if (error instanceof Error && /Rejected backend URL/.test(error.message)) {
    return { code: "WAKE_FAILED", reason: error.message };
  }
  return { code: "WAKE_FAILED", reason: "backend error" };
}

function cancelledSubmission() {
  const error = new GatewayError("Gateway submission cancelled before transmission");
  error.delivery = "rejected";
  error.reason = "cancelled";
  return error;
}

function sleepEvidence(error) {
  return /^pod_hibernated$/i.test(String(error?.failureReason ?? ""))
    || /sleep|hibernat/i.test(String(error?.failureCode ?? ""));
}

const wakesByScope = new Map();

function wakeShared(scope, signal) {
  // An already-aborted caller must not create a job or read the login. The job
  // promise is always caught so a wake can never surface as an unhandledRejection.
  if (signal?.aborted) return Promise.reject(cancelledSubmission());
  let job = wakesByScope.get(scope);
  if (!job || job.controller.signal.aborted) {
    const controller = new AbortController();
    const created = { controller, waiters: new Set(), promise: null };
    // Register before the async function starts. loadAppAccessToken throws
    // synchronously, and that finally would otherwise run before the map insert
    // and leave the rejected job in place for the next caller.
    wakesByScope.set(scope, created);
    created.promise = (async () => {
      try {
        const loaded = await loadAppAccessToken({
          scope,
          home: homedir(),
          env: process.env,
          ...secretStoreOptions(),
        });
        const result = await wakeSandbox(loaded.token, { signal: controller.signal, appLogin: true });
        if (process.env.GBOT_DEBUG) console.error("gbot: woke asleep box");
        return result;
      } finally {
        if (wakesByScope.get(scope) === created) wakesByScope.delete(scope);
      }
    })();
    created.promise.catch(() => {});
    job = created;
  }
  const waiter = {};
  job.waiters.add(waiter);
  let left = false;
  const leave = (abortJob) => {
    if (left) return;
    left = true;
    job.waiters.delete(waiter);
    if (abortJob && job.waiters.size === 0) {
      if (wakesByScope.get(scope) === job) wakesByScope.delete(scope);
      job.controller.abort();
    }
  };
  return raceSignal(job.promise, signal, () => leave(true)).finally(() => leave(false));
}

function applySandbox(session, sandbox) {
  session.gatewayUrl = sandbox.gatewayUrl;
  session.gatewayToken = sandbox.gatewayToken;
  session.gatewayHeaders = sandbox.gatewayHeaders;
}

// A bare 417 is still BOX_ASLEEP. Only these reads wake without sleep evidence.
// Every other gateway method, including sendPrompt, needs failureReason pod_hibernated
// or a failureCode matching sleep/hibernat. There are no other read-only gateway methods.
const BARE_417_WAKE_METHODS = new Set([
  "listAgents",
  "getAgentThread",
  "getAgentTranscriptTail",
  "getAgentWorkflows",
]);

function canRetryAsleep(method, error, session, options) {
  if (options.allowWake === false || error?.code !== "BOX_ASLEEP" || !canAutoWake(session)) return false;
  if (!BARE_417_WAKE_METHODS.has(method) && !sleepEvidence(error)) return false;
  return true;
}

function staleSavedSession(error) {
  return error instanceof GatewayError && (error.kind === "auth" || error.kind === "routing");
}

async function gatewayCall(session, method, body = {}, options = {}) {
  try {
    return await performGatewayCall(session, method, body, options);
  } catch (error) {
    if (
      !options.refreshedSession
      && savedLoginSessions.has(session)
      && staleSavedSession(error)
    ) {
      forgetSession(session.accountScope);
      let fresh;
      try {
        fresh = await sessionFromSavedLogin(session.accountScope, options.signal);
      } catch (rebuildError) {
        // The gateway already refused this call. A failed rebuild must not replace that
        // rejection, or sendPrompt records a definite miss as delivery unknown.
        if (error && typeof error === "object" && error.cause === undefined && rebuildError instanceof Error) {
          error.cause = rebuildError;
        }
        throw error;
      }
      applySandbox(session, fresh);
      rememberSession(session);
      return await gatewayCall(session, method, body, { ...options, refreshedSession: true });
    }
    if (!canRetryAsleep(method, error, session, options)) throw error;
    let sandbox;
    try {
      sandbox = await wakeShared(session.accountScope, options.signal);
    } catch (wakeError) {
      if (options.signal?.aborted) throw cancelledSubmission();
      if (!(error instanceof GatewayError)) throw wakeError;
      const failure = wakeFailure(wakeError);
      error.message += ` (auto wake failed: ${failure.reason})`;
      error.wake = { attempted: true, error: failure.code };
      throw error;
    }
    applySandbox(session, sandbox);
    try {
      return await gatewayCall(session, method, body, { ...options, allowWake: false });
    } catch (retryError) {
      if (retryError instanceof GatewayError && retryError.code === "BOX_ASLEEP") {
        if (!String(retryError.message).includes("auto wake ran")) {
          retryError.message += " (auto wake ran, but the box is still asleep)";
        }
        retryError.wake = { attempted: true, woke: true };
      }
      throw retryError;
    }
  }
}

async function performGatewayCall(session, method, body = {}, { signal } = {}) {
  assertGatewayActive(signal);
  const base = assertAllowedCredentialUrl(session.gatewayUrl, { kind: "gateway" });
  const url = base + "/api/" + method;
  // Cancellation can abort read/auth preflights. Once a prompt request starts,
  // observe its actual receipt (or timeout) instead of losing certainty on stop.
  const prompt = method === "sendPrompt";
  const timeoutMs = prompt ? SEND_GATEWAY_TIMEOUT_MS : GATEWAY_TIMEOUT_MS;
  const deadline = gatewayDeadline(prompt ? undefined : signal, timeoutMs);
  const options = {
    method: "POST",
    redirect: "error",
    signal: deadline,
    headers: requestHeaders(session),
    body: JSON.stringify(body),
  };
  assertGatewayActive(signal); // Final synchronous boundary before transmission.
  let res, data;
  try {
    res = await fetch(url, options);
    data = await readJson(res, deadline);
  } catch (error) {
    if (!prompt) assertGatewayActive(signal);
    if (error instanceof GatewayError) throw error;
    if (isDeadlineError(error)) {
      throw new GatewayError(
        prompt
          ? method + " timed out after " + timeoutMs + "ms; delivery is unknown. Do not resend automatically."
          : method + " timed out after " + timeoutMs + "ms.",
        { method, code: "GATEWAY_TIMEOUT", ...(prompt ? { effect: "unknown" } : {}) },
      );
    }
    // Fetch failures can echo the request URL. Keep the method and nothing else.
    throw new GatewayError(method + " request failed.", { method, code: "GATEWAY_REQUEST_FAILED" });
  }
  if (!prompt) assertGatewayActive(signal);
  if (!res.ok) {
    const detail = data.message || data.error || data.raw || res.statusText;
    const failureReason = String(res.headers.get("x-anyrun-failure-reason") ?? "").trim().slice(0, 64) || undefined;
    const classified = failureKind(res.status, res.headers.get("content-type"), data, failureReason);
    const asleep = classified.kind === "asleep";
    throw new GatewayError(method + " failed: " + res.status + " " + redactDetail(detail, session) + (asleep ? ASLEEP_HINT : ""), {
      status: res.status,
      method,
      ...(asleep ? { code: "BOX_ASLEEP" } : {}),
      ...(classified.kind ? { kind: classified.kind } : {}),
      ...(classified.failureCode ? { failureCode: classified.failureCode } : {}),
      ...(failureReason ? { failureReason } : {}),
    });
  }
  return data;
}

// ---------------------------------------------------------------------------------------------
// Backend RPCs (Grok Bot 0.78.x).
//
// Since the 0.78.4 desktop app (2026-11-03) every bot of a login is server-hosted (`harness:
// "temporal"`). The app sends messages, creates and edits rooms, deletes bots and sets sidebar
// state through aiserver.v1.GrokBotService/<Rpc> (Connect JSON, unary) with the account access
// token. Live on 2026-11-05 the box gateway answered 502 "A Sand box session is not permitted on
// this endpoint." to sendPrompt, createGroup and setAgentHiddenFromSidebar; its listAgents kept bots
// the backend had deleted and showed a room the backend had just created only minutes later;
// deleteAgent answered 200 and deleted nothing; and updateAgent without `editedFields` changed only
// the box copy (with it, an avatar edit reached the server and a title edit did not).
//
// connectGateway attaches the access token source to the session here. It is kept out of the
// session object so it never serializes. A session without one (GROK_BOT_GATEWAY_URL + token, or a
// descriptor login gbot cannot read an access token for) keeps the gateway calls.
// ---------------------------------------------------------------------------------------------
const SCOPE_RE = /^[0-9a-f]{64}$/;
const GROK_BOT_SERVICE = "/aiserver.v1.GrokBotService/";
const ROOM_TIMEOUT_MS = 45_000;
const ROOM_MEMBERS_TIMEOUT_MS = 20_000;
const backendAuths = new WeakMap();

function debug(message) {
  if (process.env.GBOT_DEBUG) console.error("gbot: " + message);
}

/** @param {any} session @param {{ scope?: string, token?: string, expiresAt?: number, env?: boolean }} auth */
function attachBackend(session, auth) {
  backendAuths.set(session, { ...auth });
  return session;
}

/**
 * A backend-only session for read-only tools (migration capture). The login and its saved access
 * token are resolved from local files only: unlike connectGateway it never describes, wakes or
 * otherwise touches the box, so reading a bot does not change the source account.
 * @param {{ account?: string }} [options]
 */
export function backendOnlySession({ account } = {}) {
  if (gatewayOverride()) {
    throw new GatewayError("Remove GROK_BOT_GATEWAY_URL and GROK_BOT_GATEWAY_TOKEN: reading the backend needs a Grok Bot app login.", { code: "NO_ACCESS_TOKEN" });
  }
  const pinned = workerAccountScope();
  const selected = typeof account === "string" && account.trim() ? account.trim() : (pinned || undefined);
  let choice;
  try {
    choice = resolveGrokBotLogin({ account: selected, ...secretStoreOptions() });
  } catch (error) {
    throw scrubOutbound(toGatewayError(error), []);
  }
  let scope = choice?.scope;
  if (!scope && (choice?.hasDescriptorEntry || !choice)) {
    try { scope = descriptorSession(choice ? choice.id : selected)?.accountScope; } catch { /* no readable descriptor */ }
  }
  if (typeof scope === "string" && SCOPE_RE.test(scope)) {
    let loaded;
    try {
      loaded = loadAppAccessToken({ scope, home: homedir(), env: process.env, ...secretStoreOptions() });
    } catch (error) {
      throw scrubOutbound(toGatewayError(error), []);
    }
    return attachBackend({ accountScope: scope }, { scope, token: loaded.token, expiresAt: loaded.expiresAt });
  }
  if (!choice && !selected && accessTokenFromEnv()) return attachBackend({}, { env: true });
  throw new GatewayError("This login has no saved Grok Bot access token. Sign in to the Grok Bot app (0.78+) on this computer, then try again.", { code: "NO_ACCESS_TOKEN" });
}

/** True when connectGateway gave this session an access token for the backend RPCs. */
export function hasBackend(session) {
  return Boolean(session) && typeof session === "object" && backendAuths.has(session);
}

function backendCredential(session) {
  const auth = backendAuths.get(session);
  if (!auth) throw new GatewayError("This session has no Grok Bot access token for the backend.", { code: "NO_ACCESS_TOKEN" });
  if (auth.env) {
    const token = accessTokenFromEnv();
    if (!token) throw new GatewayError("CURSOR_ACCESS_TOKEN is no longer set.", { code: "NO_ACCESS_TOKEN" });
    return { token, appLogin: false };
  }
  // The app refreshes its saved token; read it again when the copy in memory is about to expire.
  if (!(auth.expiresAt > Date.now() + 60_000)) {
    let loaded;
    try {
      loaded = loadAppAccessToken({ scope: auth.scope, home: homedir(), env: process.env, ...secretStoreOptions() });
    } catch (error) {
      throw scrubOutbound(toGatewayError(error), []);
    }
    auth.token = loaded.token;
    auth.expiresAt = loaded.expiresAt;
  }
  return { token: auth.token, appLogin: true };
}

// The access token this session would send, for redacting server text that echoes it.
function backendSecrets(session) {
  const auth = backendAuths.get(session);
  const token = auth?.env ? accessTokenFromEnv() : auth?.token;
  return typeof token === "string" && token ? [token] : [];
}

// Server-supplied text for an error: secrets redacted first, then bounded.
function serverText(text, secrets) {
  return redactKnownSecrets(String(text ?? ""), secrets).slice(0, 300);
}

// Connect error bodies say little in `message` ("Error"); the reason is in details[].debug.details.
function connectDetail(data) {
  const details = Array.isArray(data?.details) ? data.details : [];
  for (const item of details) {
    const text = item?.debug?.details?.detail || item?.debug?.details?.title;
    if (typeof text === "string" && text) return text;
  }
  return undefined;
}

function backendFailure(rpc, res, data, token) {
  const code = typeof data?.code === "string" && data.code ? data.code : undefined;
  // Redact the whole text before cutting it: a cut can split the token and defeat the match.
  let detail = redactKnownSecrets(String(connectDetail(data) || data?.message || data?.raw || res.statusText || ""), [token]).slice(0, 300);
  if (res.status === 401 && /no longer supported/i.test(detail)) {
    detail += ` (gbot sent x-cursor-client-version ${cursorClientVersion()}; set SAND_CLIENT_VERSION to override)`;
    forgetCachedAppVersion();
  }
  const auth = res.status === 401 || res.status === 403 || code === "unauthenticated" || code === "permission_denied";
  return new GatewayError(rpc + " failed: " + res.status + (code ? " " + code : "") + " " + detail, {
    status: res.status,
    method: rpc,
    kind: auth ? "auth" : res.status >= 500 ? "server" : "client",
    ...(code ? { code } : {}),
  });
}

/**
 * One unary GrokBotService call. `send` marks a call that may land: the caller's signal stops it only
 * before transmission, and a timeout or transport loss says the effect is unknown.
 * @param {any} session
 * @param {string} rpc
 * @param {Record<string, unknown>} [body]
 * @param {{ signal?: AbortSignal, timeoutMs?: number, headers?: Record<string, string>, send?: boolean }} [options]
 */
async function backendCall(session, rpc, body = {}, { signal, timeoutMs = GATEWAY_TIMEOUT_MS, headers = {}, send = false } = {}) {
  assertGatewayActive(signal);
  let token, url;
  try {
    const credential = backendCredential(session);
    token = credential.token;
    // The app login token is an account credential gbot reads itself, like EnsureSandBox.
    url = assertAllowedCredentialUrl(backendBase(), { kind: "backend", ignoreAllowAny: credential.appLogin }) + GROK_BOT_SERVICE + rpc;
  } catch (error) {
    const failed = scrubOutbound(error, token ? [token] : []);
    // Nothing left the machine.
    if (send && failed && typeof failed === "object") failed.delivery = "rejected";
    throw failed;
  }
  const deadline = gatewayDeadline(send ? undefined : signal, timeoutMs);
  assertGatewayActive(signal); // Final synchronous boundary before transmission.
  let res, data;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: deadline,
      headers: { ...ensureSandboxHeaders(token), ...headers },
      body: JSON.stringify(body),
    });
    data = await readJson(res, deadline);
  } catch (error) {
    if (!send) assertGatewayActive(signal);
    if (error instanceof GatewayError) throw scrubOutbound(error, [token]);
    if (isDeadlineError(error)) {
      throw new GatewayError(
        send
          ? rpc + " timed out after " + timeoutMs + "ms; delivery is unknown. Do not resend automatically."
          : rpc + " timed out after " + timeoutMs + "ms.",
        { method: rpc, code: "GATEWAY_TIMEOUT", ...(send ? { effect: "unknown" } : {}) },
      );
    }
    // Fetch failures can echo the request URL. Keep the RPC name and nothing else.
    throw new GatewayError(rpc + " request failed.", { method: rpc, code: "GATEWAY_REQUEST_FAILED" });
  }
  if (!send) assertGatewayActive(signal);
  if (!res.ok) throw backendFailure(rpc, res, data, token);
  return data;
}

// Read-only backend RPCs the migration source may call. Anything that sends, writes, deletes or
// changes state is absent on purpose, so a migration read can never modify the source account.
export const BACKEND_READ_RPCS = Object.freeze([
  "ListGrokBotAgents",
  "ListGrokBotAgentSessions",
  "ListGrokBotTranscriptEntries",
  "ListGrokBotUserBotMemories",
  "ListGrokBotAgentSkills",
  "ListGrokBotAgentRoutines",
  "ListGrokBotAgentAutomations",
  "ListGrokBotAgentTasks",
  "ListGrokBotAgentTodos",
  "ListGrokBotTasks",
  "ListGrokBotSubagents",
  "ListGrokBotAgentFiles",
  "ListGrokBotUserStoreFiles",
  "ListGrokBotLibraryDocs",
  "GetGrokBotAgentPlugins",
  "ResolveGrokBotAttachmentReads",
  "ReadGrokBotAgentAttachmentChunk",
  "GetGrokBotRuntimeCapabilities",
  "ListSandBoxStoreObjects",
  "StatSandBoxStoreObject",
  "PresignSandBoxStoreReads",
]);

/**
 * One read-only backend RPC (allowlisted above) with the session's access token.
 * @param {any} session @param {string} rpc @param {Record<string, unknown>} [body]
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 */
export async function backendRead(session, rpc, body = {}, { signal, timeoutMs } = {}) {
  if (!BACKEND_READ_RPCS.includes(rpc)) throw new GatewayError(rpc + " is not a read-only migration RPC.", { code: "RPC_NOT_ALLOWED" });
  return backendCall(session, rpc, body, { signal, ...(timeoutMs ? { timeoutMs } : {}) });
}

const ROOM_KIND = "GROK_BOT_AGENT_KIND_ROOM";

/**
 * A ListGrokBotAgents / CreateGrokBotRoom / UpdateGrokBotAgent agent in gbot's record shape. `agentId`
 * (uuid) is the id every other call takes; the numeric `id` is kept as `serverId` for UpdateGrokBotAgent.
 * `client` is a GrokBotAgentClientState: undefined leaves the sidebar fields out, null means the server
 * has no state for the agent. proto3 JSON leaves false out. Like the app, notify comes from the client
 * state only once that state has been written (`updatedAtMs` > 0); until then it shows on.
 */
function serverRecord(agent, client) {
  const isGroup = agent.kind === ROOM_KIND;
  const members = Array.isArray(agent.memberAgentIds) ? agent.memberAgentIds.map(String) : [];
  const written = Boolean(client) && Number(client.updatedAtMs) > 0;
  return {
    id: String(agent.agentId),
    name: agent.name || "",
    title: agent.title || "",
    description: agent.description || "",
    avatarShape: agent.avatarShape || "",
    avatarColor: agent.avatarColor || "",
    ...(client === undefined ? {} : {
      notifyOnAgentUpdates: written ? client.notifyOnUpdatesEnabled === true : true,
      hiddenFromSidebar: client ? client.hiddenFromSidebar === true : false,
    }),
    isGroup,
    memberIds: isGroup ? members : [],
    ...(agent.id ? { serverId: String(agent.id) } : {}),
    // "temporal" for a server-hosted bot. The app routes some calls (auto-review approvals) by it.
    harness: String(agent.harness || ""),
  };
}

// Box rows the server does not list. resolveFromList prefers a server record over one of these, and
// sends, edits and deletes for them stay on the box gateway.
const boxOnlyRecords = new WeakSet();
// Rosters the server cut short (ListGrokBotAgentsResponse.truncated). A name could match one bot here
// while the bot meant is past the cut, so resolveFromList matches only ids in them.
const truncatedRosters = new WeakSet();
// Rosters read from the box because the server roster is off for this login.
const boxFallbackRosters = new WeakSet();
// Every agentId and legacyAgentId the server listed, per roster.
const serverIdsOf = new WeakMap();

// The box roster, read alongside the server's. It does not retry an asleep box (no 417 wake), and a
// failure leaves the server roster on its own (GBOT_DEBUG says why). A saved login whose box answers
// 401/403 or "could not be routed" still rebuilds its session first, and that rebuild can wake the box.
function boxRows(session, signal) {
  return gatewayCall(session, "listAgents", {}, { signal, allowWake: false }).then(unwrapList, (error) => {
    if (signal?.aborted) throw error;
    debug("box roster unavailable, using the server roster only: " + (error instanceof Error ? error.message : String(error)));
    return [];
  });
}

function boxOnly(rows, listed) {
  const out = [];
  for (const row of rows) {
    const rec = asRecord(row);
    // A temporal row the server does not list is stale: live, a bot the backend deleted stayed here.
    if (!rec?.id || listed.has(rec.id) || row?.harness === "temporal") continue;
    boxOnlyRecords.add(rec);
    out.push(rec);
  }
  return out;
}

// Notify and hidden for every agent of the login (an empty agentIds list answers all of them). Display
// only, so a failure leaves those fields out instead of failing the command.
function clientStates(session, signal) {
  return backendCall(session, "ListGrokBotAgentStatuses", { agentIds: [] }, { signal }).then((data) => {
    const clients = new Map();
    for (const status of Array.isArray(data?.statuses) ? data.statuses : []) {
      if (status?.agentId) clients.set(String(status.agentId), status.client ?? null);
    }
    return clients;
  }, (error) => {
    if (signal?.aborted) throw error;
    debug("ListGrokBotAgentStatuses failed, leaving notify and hidden out: " + (error instanceof Error ? error.message : String(error)));
    return undefined;
  });
}

// Whether the login's server roster is on, decided as the app's isServerRosterEnabled does:
// GetGrokBotRuntimeCapabilities().capabilities.durableIdentityEnabled === true, with FailedPrecondition
// from that call meaning off. Any other error from it, and any error from ListGrokBotAgents itself, fails
// the lookup: a guessed roster could point a send or a delete at the wrong bot. The answer is kept for
// the session, so it costs one call; an error is not kept.
const serverRosterModes = new WeakMap();
const boxRosterNotices = new WeakSet();

function serverRosterOn(session, signal) {
  let known = serverRosterModes.get(session);
  if (!known) {
    known = backendCall(session, "GetGrokBotRuntimeCapabilities", {}, { signal }).then(
      (data) => data?.capabilities?.durableIdentityEnabled === true,
      (error) => {
        if (error instanceof GatewayError && error.code === "failed_precondition") return false;
        serverRosterModes.delete(session);
        throw error;
      },
    );
    serverRosterModes.set(session, known);
  }
  return known;
}

function noteBoxRoster(session) {
  if (boxRosterNotices.has(session)) return;
  boxRosterNotices.add(session);
  console.error("gbot: the server roster is off for this login (GetGrokBotRuntimeCapabilities); using the box roster and the box gateway.");
}

async function gatewayRoster(session, signal) {
  const data = await gatewayCall(session, "listAgents", {}, { signal });
  return unwrapList(data).map(asRecord).filter((r) => r && r.id);
}

/**
 * The roster. With a backend session the server is the source of truth for every agent it lists
 * (any harness), and box rows are added only for non-temporal agents the server does not list.
 * Without one, or when the server roster is off for the login, it is the box gateway's listAgents.
 * @param {any} session
 * @param {{ signal?: AbortSignal, clientState?: boolean }} [options]
 */
async function roster(session, { signal, clientState = false } = {}) {
  if (!hasBackend(session)) return gatewayRoster(session, signal);
  const onRead = serverRosterOn(session, signal);
  const listRead = backendCall(session, "ListGrokBotAgents", {}, { signal });
  const statesRead = clientState ? clientStates(session, signal) : Promise.resolve(undefined);
  const boxRead = boxRows(session, signal);
  const abandon = () => {
    for (const read of [listRead, statesRead, boxRead]) read.catch(() => {});
  };
  let on;
  try {
    on = await onRead;
  } catch (error) {
    abandon();
    throw error;
  }
  if (!on) {
    abandon();
    noteBoxRoster(session);
    // The box is the only roster here, so this read may wake it, as before 0.78.x.
    const records = (await gatewayRoster(session, signal)).map((rec) => ({ ...rec, roster: "box" }));
    for (const rec of records) boxOnlyRecords.add(rec);
    boxFallbackRosters.add(records);
    return records;
  }
  let data;
  try {
    data = await listRead;
  } catch (error) {
    abandon();
    throw error;
  }
  const [clients, box] = await Promise.all([statesRead, boxRead]);
  const listed = new Set();
  const records = [];
  for (const agent of Array.isArray(data?.agents) ? data.agents : []) {
    // Like the app, a server row without an agentId is not a bot gbot can address.
    if (!agent || typeof agent.agentId !== "string" || !agent.agentId) continue;
    listed.add(agent.agentId);
    if (typeof agent.legacyAgentId === "string" && agent.legacyAgentId) listed.add(agent.legacyAgentId);
    records.push(serverRecord(agent, clients === undefined ? undefined : (clients.get(agent.agentId) ?? null)));
  }
  const truncated = data?.truncated === true;
  // A cut list cannot tell a box-only bot from a server bot past the cut, so box rows are left out.
  const all = truncated ? records : [...records, ...boxOnly(box, listed)];
  serverIdsOf.set(all, listed);
  if (truncated) {
    debug("ListGrokBotAgents says truncated; names will not resolve, ids still do, box-only rows are left out");
    truncatedRosters.add(all);
  }
  return all;
}

async function setClientState(session, agentId, state) {
  return backendCall(session, "SetGrokBotAgentClientState", { agentId, ...state });
}

/** A GrokBotSendStatus name ("ACCEPTED", "PENDING", "UNSPECIFIED", ...), or "" when the read failed. */
async function sendStatus(session, agentId, clientNonce, signal) {
  try {
    const data = await backendCall(session, "GetGrokBotSendStatus", { agentId, messageId: clientNonce }, {
      signal,
      timeoutMs: SEND_GATEWAY_TIMEOUT_MS,
    });
    return {
      // proto3 JSON leaves the zero value out.
      status: String(data?.status || "UNSPECIFIED").replace(/^GROK_BOT_SEND_STATUS_/, ""),
      ...(typeof data?.echoEntryId === "string" && data.echoEntryId ? { echoEntryId: data.echoEntryId } : {}),
      ...(typeof data?.rejectionCode === "string" && data.rejectionCode ? { rejectionCode: data.rejectionCode } : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    debug("GetGrokBotSendStatus failed: " + (error instanceof Error ? error.message : String(error)));
    return { status: "" };
  }
}

function deviceTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && /^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(zone) ? zone : "";
  } catch {
    return "";
  }
}

const ACCEPTED_DELIVERIES = new Set([
  "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_BOX",
  "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL",
  // messageId is the idempotency key: the same nonce again is the message already there.
  "GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE",
]);
const REFUSED_DELIVERY = "GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED";

function refusedSend(refusal, rec, secrets) {
  const message = typeof refusal?.message === "string" && refusal.message ? serverText(refusal.message, secrets) : "the message was refused";
  const failureCode = typeof refusal?.failureCode === "string" && refusal.failureCode ? refusal.failureCode : undefined;
  const error = new GatewayError("SendGrokBotUserMessage refused: " + message, {
    method: "SendGrokBotUserMessage",
    code: "SEND_REFUSED",
    ...(failureCode ? { failureCode } : {}),
  });
  error.delivery = "rejected";
  error.targetId = rec.id;
  return error;
}

// Connect codes that do not prove the server turned the message away: it may have landed.
const MAYBE_LANDED_CODES = new Set(["canceled", "deadline_exceeded", "unavailable", "unknown", "internal"]);

// SendGrokBotUserMessage, the call the 0.78.x app makes. Same delivery rules as the gateway send:
// a definite answer is accepted or rejected; a timeout, transport loss, 408, 499 (canceled), 5xx, or a
// Connect code in MAYBE_LANDED_CODES stays unknown and is never resent. Like the app, an unknown send
// asks GetGrokBotSendStatus for the same nonce, but only to settle the answer: unlike the app, gbot
// never resends after NOT_FOUND.
async function backendSend(session, rec, prompt, extra, clientNonce) {
  const body = {
    agentId: rec.id,
    messageId: clientNonce,
    text: prompt,
    sentAtMs: String(Date.now()),
    source: "GROK_BOT_CLIENT_SURFACE_DESKTOP",
    initiator: "GROK_BOT_USER_MESSAGE_INITIATOR_USER",
    sendSource: "GROK_BOT_SEND_SOURCE_CHAT",
    ...(extra.replyToId ? { replyToId: extra.replyToId } : {}),
  };
  const zone = deviceTimeZone();
  const accepted = (data) => ({
    target: rec,
    result: data && typeof data === "object" ? data : {},
    delivery: "accepted",
    clientNonce,
  });
  let data;
  try {
    data = await backendCall(session, "SendGrokBotUserMessage", body, {
      send: true,
      signal: extra.signal,
      timeoutMs: SEND_GATEWAY_TIMEOUT_MS,
      headers: zone ? { "x-cursor-timezone": zone } : {},
    });
  } catch (err) {
    if (err && typeof err === "object" && err.delivery == null) {
      // 408, 499, 5xx and the Connect codes above may have landed. Any other 4xx is a rejection.
      const answeredNo = err instanceof GatewayError && err.status != null && err.status < 500
        && err.status !== 408 && err.status !== 499 && !MAYBE_LANDED_CODES.has(String(err.code ?? ""));
      err.delivery = answeredNo ? "rejected" : "unknown";
    }
    if (err?.delivery === "unknown" && !extra.signal?.aborted) {
      const status = await sendStatus(session, rec.id, clientNonce, undefined);
      if (status.status === "ACCEPTED") {
        return accepted({ status: "GROK_BOT_SEND_STATUS_ACCEPTED", ...(status.echoEntryId ? { echoEntryId: status.echoEntryId } : {}) });
      }
      if (status.status === "REJECTED") {
        // A fresh error: the transport one says "delivery is unknown" and carries its timeout or 5xx.
        const rejected = refusedSend({
          failureCode: status.rejectionCode,
          message: "GetGrokBotSendStatus says rejected after " + (err.code || (err.status ? "HTTP " + err.status : "a transport failure")),
        }, rec, backendSecrets(session));
        rejected.cause = err;
        throw rejected;
      }
    }
    throw err;
  }
  const delivery = String(data?.delivery ?? "");
  if (ACCEPTED_DELIVERIES.has(delivery)) return accepted(data);
  if (delivery === REFUSED_DELIVERY) throw refusedSend(data?.refusal, rec, backendSecrets(session));
  // UNSPECIFIED, or a value this build does not know: the server did not say. Settle it if it can.
  const status = await sendStatus(session, rec.id, clientNonce, undefined);
  if (status.status === "ACCEPTED") return accepted(data);
  if (status.status === "REJECTED") throw refusedSend({ failureCode: status.rejectionCode, message: "GetGrokBotSendStatus says rejected" }, rec, backendSecrets(session));
  return { target: rec, result: data && typeof data === "object" ? data : {}, delivery: "unknown", clientNonce };
}

function asRecord(agent) {
  if (!agent) return null;
  const id = agent.id || agent.agentId;
  const memberIds = agent.memberIds || agent.memberAgentIds || [];
  const notify = agent.notifyOnUpdatesEnabled ?? agent.notifyOnAgentUpdates;
  const hidden = agent.isHiddenFromSidebar ?? agent.hiddenFromSidebar;
  return {
    id,
    name: agent.name || "",
    title: agent.title || "",
    description: agent.description || "",
    avatarShape: agent.avatarShape || "",
    avatarColor: agent.avatarColor || "",
    ...(notify !== undefined ? { notifyOnAgentUpdates: Boolean(notify) } : {}),
    ...(hidden !== undefined ? { hiddenFromSidebar: Boolean(hidden) } : {}),
    isGroup: agent.isGroup === true || (agent.isGroup == null && Array.isArray(memberIds) && memberIds.length > 0),
    memberIds: Array.isArray(memberIds) ? memberIds : [],
  };
}

function assertAvatar(kind, value, allowed) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  if (!allowed.includes(trimmed)) {
    throw new GatewayError("Unknown avatar " + kind + " \"" + value + "\". Use: " + allowed.join(" "));
  }
  return trimmed;
}

function unwrapList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.agents)) return data.agents;
  if (data.agent) return [data.agent];
  return [];
}

function unwrapOne(data) {
  return asRecord(data.agent || data);
}

/** Every bot and group, with the sidebar settings (notify, hidden). */
export async function listAgents(session, { signal } = {}) {
  return roster(session, { signal, clientState: true });
}

function resolveFromList(records, ref) {
  const needle = String(ref ?? "").trim().toLowerCase();
  if (!needle) throw new GatewayError("A bot or group name or id is required.");
  const byId = records.find((r) => r.id.toLowerCase() === needle);
  if (byId) return byId;
  if (truncatedRosters.has(records)) {
    throw new GatewayError(
      "The server sent only part of the bot list (truncated), so \"" + ref + "\" is not matched by name. Use the bot or group id.",
      { code: "ROSTER_TRUNCATED" },
    );
  }
  const ambiguous = (why) => new GatewayError("Ambiguous name \"" + ref + "\"" + (why ? " (" + why + ")" : "") + ". Use the id.");
  const one = (found, why) => {
    if (found.length > 1) throw ambiguous(why);
    return found[0] ?? null;
  };
  const exact = (r) => r.name.toLowerCase() === needle || (r.title !== "" && r.title.toLowerCase() === needle);
  // ListGrokBotAgents shows a titled bot as "name · title" with no title (live 2026-11-05). The folded
  // rule matches either half: the plain name, the title (all after the first " · "), or the last title.
  const folded = (r) => {
    if (r.title) return false;
    const parts = r.name.toLowerCase().split(" · ");
    return parts.length > 1 && (parts[0] === needle || parts.slice(1).join(" · ") === needle || parts.at(-1) === needle);
  };
  const server = records.filter((r) => !boxOnlyRecords.has(r));
  const box = records.filter((r) => boxOnlyRecords.has(r));
  const serverExact = one(server.filter(exact));
  if (serverExact) return serverExact;
  const boxExact = box.filter(exact);
  const serverFolded = server.filter(folded);
  // A server bot found only through its folded name and a box-only bot with exactly that name may be
  // two bots or one: refuse to guess (a delete cannot be undone).
  if (serverFolded.length > 0 && boxExact.length > 0) throw ambiguous("a server bot and a box-only bot match");
  const found = one(serverFolded) ?? one(boxExact) ?? one(box.filter(folded));
  if (found) return found;
  throw new GatewayError("No bot or group named \"" + ref + "\"");
}

/** @param {any} session @param {string} ref @param {{ signal?: AbortSignal, clientState?: boolean }} [options] */
export async function resolveRef(session, ref, { signal, clientState = false } = {}) {
  return resolveFromList(await roster(session, { signal, clientState }), ref);
}

export async function createAgent(session, input) {
  const data = await gatewayCall(session, "createAgent", {
    name: input.name,
    description: input.description || "",
    title: input.title || "",
    avatarShape: assertAvatar("shape", input.avatarShape, AVATAR_SHAPES),
    avatarColor: assertAvatar("color", input.avatarColor, AVATAR_COLORS),
    origin: "user",
  });
  return unwrapOne(data);
}

function profileChanges(patch) {
  if (patch.name !== undefined && !String(patch.name).trim()) {
    throw new GatewayError("Name cannot be blank.");
  }
  const changes = {};
  if (patch.name !== undefined) changes.name = String(patch.name).trim();
  if (patch.description !== undefined) changes.description = String(patch.description);
  if (patch.title !== undefined) changes.title = String(patch.title);
  if (patch.avatarShape !== undefined) changes.avatarShape = assertAvatar("shape", patch.avatarShape, AVATAR_SHAPES);
  if (patch.avatarColor !== undefined) changes.avatarColor = assertAvatar("color", patch.avatarColor, AVATAR_COLORS);
  return changes;
}

// The box keeps its own copy of a bot and passes an edit on to the server only for the fields named
// in `editedFields`, as the app sends them. Live (2026-11-05) an avatar edit arrived about 3 s later;
// a title edit had not arrived 30 s later. Used only without the backend, or for a box-only bot.
async function gatewayUpdate(session, rec, patch, changes) {
  const edited = Object.keys(changes);
  if (edited.length > 0) {
    const profile = { name: rec.name, description: rec.description, ...changes };
    await gatewayCall(session, "updateAgent", { id: rec.id, profile, editedFields: edited });
  }
  if (patch.notifyOnAgentUpdates !== undefined) {
    await gatewayCall(session, "setAgentNotifyOnUpdates", { id: rec.id, isEnabled: Boolean(patch.notifyOnAgentUpdates) });
  }
  if (patch.hiddenFromSidebar !== undefined) {
    await gatewayCall(session, "setAgentHiddenFromSidebar", { id: rec.id, isHidden: Boolean(patch.hiddenFromSidebar) });
  }
}

// UpdateGrokBotAgent takes the numeric server id and, with partialUpdate, only the changed fields.
// It edits a room the server just created (the box listed it only minutes later), it changes the
// title (the box did not pass that on), and its change is already on the server roster, so the read
// back below is current. The server shows a bot's title in its name ("name · title"). Notify and
// hidden are per-viewer client state; the app also mirrors notify to the box, so gbot does too, best
// effort.
async function backendUpdate(session, rec, patch, changes) {
  if (Object.keys(changes).length > 0) {
    if (!rec.serverId) throw new GatewayError("The server listed no numeric id for \"" + rec.name + "\", so its profile cannot be updated.");
    await backendCall(session, "UpdateGrokBotAgent", { id: rec.serverId, ...changes, partialUpdate: true });
  }
  if (patch.notifyOnAgentUpdates !== undefined) {
    const isEnabled = Boolean(patch.notifyOnAgentUpdates);
    await setClientState(session, rec.id, { notifyOnUpdatesEnabled: isEnabled });
    try {
      await gatewayCall(session, "setAgentNotifyOnUpdates", { id: rec.id, isEnabled }, { allowWake: false });
    } catch (error) {
      debug("box notify mirror failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (patch.hiddenFromSidebar !== undefined) {
    await setClientState(session, rec.id, { hiddenFromSidebar: Boolean(patch.hiddenFromSidebar) });
  }
}

export async function updateAgent(session, ref, patch = {}) {
  const rec = await resolveRef(session, ref);
  const changes = profileChanges(patch);
  // Notify and hidden need only the uuid; the profile needs the numeric server id.
  if (hasBackend(session) && !boxOnlyRecords.has(rec)) await backendUpdate(session, rec, patch, changes);
  else await gatewayUpdate(session, rec, patch, changes);
  const fresh = (await listAgents(session)).find((r) => r.id === rec.id);
  return fresh || rec;
}

export async function deleteAgent(session, ref) {
  const rec = await resolveRef(session, ref);
  if (!hasBackend(session) || boxOnlyRecords.has(rec)) {
    await gatewayCall(session, "deleteAgent", { id: rec.id });
    return rec;
  }
  try {
    await backendCall(session, "DeleteGrokBotAgent", { id: rec.id });
  } catch (error) {
    // Like the app: already gone is done. PermissionDenied and the rest stay errors.
    if (!(error instanceof GatewayError && error.code === "not_found")) throw error;
  }
  return rec;
}

// Grok Bot keeps one skill library per box. Every bot reads the same list, and the
// workflow RPCs take any bot id only to say whose automations ride along.
const SKILL_MAX_BODY_LENGTH = 100000;
const SKILL_SOURCES = { workflow: "your library", managed: "team-managed", plugin: "a plugin", automation: "a scheduled automation" };

function asSkill(skill) {
  return {
    id: String(skill.id),
    name: skill.name || "",
    description: skill.description || "",
    source: String(skill.source || "workflow"),
    ...(skill.sourceRef ? { sourceRef: String(skill.sourceRef) } : {}),
    ...(skill.pluginId ? { pluginId: String(skill.pluginId) } : {}),
  };
}

function asSkills(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.workflows) ? data.workflows : [];
  return list.filter((s) => s && s.id).map(asSkill);
}

// The library is the box's, so the id must be a bot the box knows. With a backend session it must
// also be one the server lists: the box roster can still hold a bot the server deleted.
async function anyBotId(session) {
  const box = unwrapList(await gatewayCall(session, "listAgents", {})).map(asRecord).filter((r) => r && r.id && !r.isGroup);
  let bot = box[0];
  if (hasBackend(session)) {
    // Only ids the server listed (agentId or legacyAgentId), never a box-only row. When the server
    // roster is off, the box roster is all there is.
    const listed = serverIdsOf.get(await roster(session));
    if (listed) bot = box.find((r) => listed.has(r.id));
  }
  if (!bot) throw new GatewayError("Skills need at least one bot. Run gbot bots create first.");
  return bot.id;
}

export async function listSkills(session) {
  return asSkills(await gatewayCall(session, "getAgentWorkflows", { id: await anyBotId(session) }));
}

export async function addSkill(session, markdown) {
  const text = String(markdown);
  if (!text.trim()) throw new GatewayError("Skill markdown is empty.");
  if (text.length > SKILL_MAX_BODY_LENGTH) {
    throw new GatewayError(`Skill markdown is ${text.length} characters. Grok Bot truncates bodies over ${SKILL_MAX_BODY_LENGTH}; shorten it.`);
  }
  const id = await anyBotId(session);
  let data;
  try {
    data = await gatewayCall(session, "importAgentWorkflowText", { id, markdown: text });
  } catch (error) {
    if (error instanceof GatewayError && /response too large/.test(error.message)) {
      throw new GatewayError("Grok Bot echoed a skill list too large to read; the import may still have landed. Run gbot skills list (raise GBOT_MAX_RESPONSE_BYTES if that is too large too).");
    }
    throw error;
  }
  const imported = data.result?.imported?.[0];
  if (!imported) {
    const reason = data.result?.skipped?.[0]?.reason || "rejected";
    throw new GatewayError(`Grok Bot did not import the skill (${reason}). It needs a name, a non-empty body, and library room.`);
  }
  return asSkills(data).find((s) => s.id === String(imported.id)) ?? asSkill(imported);
}

export async function removeSkill(session, skillRef) {
  const id = await anyBotId(session);
  const skills = asSkills(await gatewayCall(session, "getAgentWorkflows", { id }));
  const needle = String(skillRef).trim().toLowerCase();
  const matches = skills.filter((s) => s.id.toLowerCase() === needle || s.name.toLowerCase() === needle);
  if (matches.length === 0) throw new GatewayError(`No skill "${skillRef}".`);
  if (matches.length > 1) throw new GatewayError(`Ambiguous skill name "${skillRef}". Use the id.`);
  if (matches[0].source !== "workflow") {
    const kind = SKILL_SOURCES[matches[0].source] || matches[0].source;
    throw new GatewayError(`"${matches[0].name}" is ${kind}, not a library skill. Manage it where it came from.`);
  }
  await gatewayCall(session, "deleteAgentWorkflow", { id, workflowId: matches[0].id });
  return matches[0];
}

function normalizeMemberIds(records, memberRefs) {
  const memberIds = new Set();
  for (const ref of memberRefs) {
    const rec = resolveFromList(records, ref);
    if (rec.isGroup) {
      throw new GatewayError(`Cannot add group "${rec.name}" as a member. Nested groups are not allowed.`);
    }
    memberIds.add(rec.id);
  }
  if (memberIds.size === 0) {
    throw new GatewayError("A group needs at least one existing member agent.");
  }
  if (memberIds.size > MAX_GROUP_MEMBERS) {
    throw new GatewayError(`A group can have at most ${MAX_GROUP_MEMBERS} members.`);
  }
  return [...memberIds];
}

// CreateGrokBotRoom, as the app creates a server-hosted room. `agentId` is a fresh v4 nonce; the
// server echoed it live, but the answer's agentId is the one used. The request has no title or
// avatar, so those go through updateAgent (UpdateGrokBotAgent edits rooms; live 2026-11-05).
async function createRoom(session, input, memberAgentIds) {
  let data;
  try {
    data = await backendCall(session, "CreateGrokBotRoom", {
      agentId: randomUUID(),
      name: input.name,
      description: input.description || "",
      memberAgentIds,
      humanMemberUserIds: [],
    }, { timeoutMs: ROOM_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof GatewayError && (error.code === "GATEWAY_TIMEOUT" || error.code === "GATEWAY_REQUEST_FAILED" || (error.status ?? 0) >= 500)) {
      error.message += " The group may have been created; run gbot groups list before trying again.";
    }
    throw error;
  }
  if (!data?.agent || data.agent.kind !== ROOM_KIND) throw new GatewayError("CreateGrokBotRoom did not return a room.");
  if (typeof data.agent.agentId !== "string" || !data.agent.agentId) {
    throw new GatewayError("CreateGrokBotRoom returned a room without an id. The group may have been created; run gbot groups list before trying again.");
  }
  return serverRecord(data.agent);
}

export async function createGroup(session, input) {
  // Check everything before anything is created.
  const extras = {};
  if (input.title) extras.title = String(input.title);
  const avatarShape = assertAvatar("shape", input.avatarShape, AVATAR_SHAPES);
  const avatarColor = assertAvatar("color", input.avatarColor, AVATAR_COLORS);
  if (avatarShape) extras.avatarShape = avatarShape;
  if (avatarColor) extras.avatarColor = avatarColor;
  const records = await roster(session);
  const memberAgentIds = normalizeMemberIds(records, input.memberIds || []);
  const onBackend = hasBackend(session) && !boxFallbackRosters.has(records);
  const rec = onBackend
    ? await createRoom(session, input, memberAgentIds)
    : unwrapOne(await gatewayCall(session, "createGroup", {
      name: input.name,
      description: input.description || "",
      memberAgentIds,
    }));
  if (!Object.keys(extras).length || !rec?.id) return rec;
  try {
    if (!onBackend) return await updateAgent(session, rec.id, extras);
    // The room's numeric id is in the CreateGrokBotRoom answer; no second roster read.
    if (!rec.serverId) throw new GatewayError("The server returned no numeric id for the new room, so it cannot be updated yet.");
    const data = await backendCall(session, "UpdateGrokBotAgent", { id: rec.serverId, ...extras, partialUpdate: true });
    return data?.agent ? serverRecord(data.agent) : { ...rec, ...extras };
  } catch (error) {
    if (error instanceof Error) {
      error.message += " The group was created (id " + rec.id + ") without its title or avatar; set them with gbot groups update " + rec.id + ".";
    }
    throw error;
  }
}

export async function setGroupMembers(session, groupRef, memberRefs) {
  const records = await roster(session);
  const group = resolveFromList(records, groupRef);
  if (!group.isGroup) throw new GatewayError(`"${group.name}" is a bot, not a group.`);
  return applyMembers(session, records, group, memberRefs);
}

async function applyMembers(session, records, group, memberRefs) {
  const memberAgentIds = normalizeMemberIds(records, memberRefs);
  if (hasBackend(session) && !boxOnlyRecords.has(group)) {
    const data = await backendCall(session, "SetGrokBotRoomMembers", { agentId: group.id, memberAgentIds }, {
      timeoutMs: ROOM_MEMBERS_TIMEOUT_MS,
    });
    // Like the app: the answer must be the room asked for.
    const room = data?.agent;
    if (!room || room.agentId !== group.id || room.kind !== ROOM_KIND) {
      throw new GatewayError(
        "SetGrokBotRoomMembers answered " + (room ? "for a different room" : "without the room")
          + "; the members may have changed. Check gbot groups get " + group.id + ".",
        { method: "SetGrokBotRoomMembers", code: "ROOM_MISMATCH" },
      );
    }
    return serverRecord(room);
  }
  const data = await gatewayCall(session, "setGroupMembers", {
    id: group.id,
    memberAgentIds,
  });
  return unwrapOne(data) || { ...group, memberIds: memberAgentIds, isGroup: true };
}

export async function addGroupMember(session, groupRef, memberRef) {
  const records = await roster(session);
  const group = resolveFromList(records, groupRef);
  if (!group.isGroup) throw new GatewayError(`"${group.name}" is a bot, not a group.`);
  const member = resolveFromList(records, memberRef);
  const next = [...new Set([...group.memberIds, member.id])];
  return applyMembers(session, records, group, next);
}

export async function removeGroupMember(session, groupRef, memberRef) {
  const records = await roster(session);
  const group = resolveFromList(records, groupRef);
  if (!group.isGroup) throw new GatewayError(`"${group.name}" is a bot, not a group.`);
  const member = resolveFromList(records, memberRef);
  const next = group.memberIds.filter((id) => id !== member.id);
  return applyMembers(session, records, group, next);
}

// Live hosts answer `{ "accepted": true }` (no messageId); older hosts returned a `messageId`.
// Either one is a confirmed receipt. Anything else (`{ok:true}`, `"true"`, a missing body) stays
// unconfirmed: the caller must reconcile by clientNonce before any resend.
export function sendReceiptFrom(data) {
  if (!data || typeof data !== "object") return { accepted: false };
  const messageId = typeof data.messageId === "string" && data.messageId ? data.messageId : undefined;
  if (data.accepted === true || messageId) return { accepted: true, ...(messageId ? { messageId } : {}) };
  return { accepted: false };
}

function transcriptRows(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray(data.entries)) return data.entries;
  return [];
}

/**
 * @param {any} session
 * @param {string} ref
 * @param {string} prompt
 * @param {{ signal?: AbortSignal, clientNonce?: string, replyToId?: string }} [extra]
 * @returns {Promise<{ target: any, result: Record<string, any>, delivery: "accepted" | "unknown", messageId?: string, clientNonce: string }>}
 */
export async function sendPrompt(session, ref, prompt, extra = {}) {
  assertGatewayActive(extra.signal);
  // Keep this roster check. Live (2026-10-10): sendPrompt to an agentId that is not on the roster
  // answers 409 send/agent-unavailable yet still creates an empty placeholder bot named "New Agent".
  let rec;
  try {
    rec = await resolveRef(session, ref, { signal: extra.signal });
  } catch (err) {
    // The prompt was never transmitted (roster lookup failed, e.g. an asleep box): a definite rejection.
    if (err && typeof err === "object") {
      if (err.delivery == null) err.delivery = "rejected";
      if (err.clientNonce == null && extra.clientNonce) err.clientNonce = extra.clientNonce;
    }
    throw err;
  }
  const body = {
    agentId: rec.id,
    prompt,
    clientNonce: extra.clientNonce || randomUUID(),
  };
  if (extra.replyToId) body.replyToId = extra.replyToId;
  // Never fall back to the gateway from here: a backend send that may have landed must not be sent twice.
  const viaBackend = hasBackend(session) && !boxOnlyRecords.has(rec);
  let data;
  try {
    if (viaBackend) return await backendSend(session, rec, prompt, extra, body.clientNonce);
    data = await gatewayCall(session, "sendPrompt", body, { signal: extra.signal });
  } catch (err) {
    // Delivery states: the server answered no (rejected) vs the request may have landed (unknown).
    // Never retry an unknown delivery blindly; read the thread first.
    if (err && err.delivery == null) {
      // 408 and 5xx may have landed. A definite 4xx answer is a rejection.
      const answeredNo = err instanceof GatewayError
        && err.status != null
        && err.status < 500
        && err.status !== 408;
      err.delivery = answeredNo ? "rejected" : "unknown";
    }
    if (err && err.delivery === "unknown") err.effect = err.effect || "unknown";
    if (err && err.targetId == null) err.targetId = rec.id;
    if (err && typeof err === "object" && err.clientNonce == null) err.clientNonce = body.clientNonce;
    if (err instanceof GatewayError && err.delivery === "unknown" && !/delivery (is )?unknown/.test(err.message)) {
      err.message += " (delivery unknown; check the thread before resending)";
    }
    throw err;
  }
  const receipt = sendReceiptFrom(data);
  const messageId = receipt.messageId;
  // Only a confirmed receipt counts as accepted; anything else is unknown, never a silent accept.
  // ponytail: full send/execution correlation envelope stays in #37.
  return {
    target: rec,
    result: data && typeof data === "object" ? data : {},
    delivery: receipt.accepted ? "accepted" : "unknown",
    ...(messageId ? { messageId } : {}),
    clientNonce: body.clientNonce,
  };
}

async function transcriptTail(session, rec, limit) {
  const bounded = Math.min(Math.max(Math.trunc(limit) || 40, 1), 200);
  const data = await gatewayCall(session, "getAgentTranscriptTail", { id: rec.id, limit: bounded });
  return { target: rec, transcript: data };
}

export async function getTranscriptTail(session, ref, limit = 40) {
  return transcriptTail(session, await resolveRef(session, ref), limit);
}

// Settled by GetGrokBotSendStatus for the nonce (the backend send's messageId), then by the transcript tail.
// Never sends anything. ACCEPTED is delivered and REJECTED is rejected. When the tail does not show the
// message either, only NOT_FOUND is "not-found-in-tail". Every other answer (PENDING, UNKNOWN_DURABILITY,
// UNSPECIFIED, a value newer than this build) and a status read that failed ("UNAVAILABLE") are
// "pending": the message may still land, so the caller must not resend.

export async function reconcileDelivery(session, ref, clientNonce) {
  if (typeof clientNonce !== "string" || clientNonce.length === 0) {
    throw new GatewayError("A clientNonce is required to reconcile a delivery.");
  }
  const rec = await resolveRef(session, ref);
  let backend = null;
  if (hasBackend(session) && !boxOnlyRecords.has(rec)) {
    backend = await sendStatus(session, rec.id, clientNonce, undefined);
    if (backend.status === "ACCEPTED") {
      return { target: rec, clientNonce, status: "delivered", entryId: backend.echoEntryId ?? "", sendStatus: "ACCEPTED" };
    }
    if (backend.status === "REJECTED") {
      return {
        target: rec,
        clientNonce,
        status: "rejected",
        sendStatus: "REJECTED",
        ...(backend.rejectionCode ? { rejectionCode: backend.rejectionCode } : {}),
      };
    }
  }
  const sendStatusField = backend ? { sendStatus: backend.status || "UNAVAILABLE" } : {};
  let tail;
  try {
    tail = await transcriptTail(session, rec, 200);
  } catch (error) {
    // The server has a status for the nonce that is neither ACCEPTED nor REJECTED nor NOT_FOUND, so it
    // may still land: keep that answer rather than lose it to a box that is asleep or failing. With no
    // status (none read, or NOT_FOUND) nothing is known, so the error stands.
    if (!backend?.status || backend.status === "NOT_FOUND") throw error;
    const code = error instanceof GatewayError && typeof error.code === "string" && error.code ? error.code : "TAIL_READ_FAILED";
    debug("reconcile: transcript tail failed (" + code + "); keeping the server's " + backend.status);
    return { target: rec, clientNonce, status: "pending", ...sendStatusField, tailError: code };
  }
  const entries = transcriptRows(tail?.transcript);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    if (entry.role !== "user" || entry.clientNonce !== clientNonce) continue;
    const entryId = typeof entry.id === "string"
      ? entry.id
      : (typeof entry.entryId === "string" ? entry.entryId : "");
    return {
      target: tail.target,
      clientNonce,
      status: "delivered",
      entryId,
      ...(typeof entry.seq === "number" ? { seq: entry.seq } : {}),
      ...sendStatusField,
    };
  }
  return {
    target: tail.target,
    clientNonce,
    status: backend && backend.status !== "NOT_FOUND" ? "pending" : "not-found-in-tail",
    scanned: entries.length,
    ...sendStatusField,
  };
}

export async function getThread(session, ref, rootId) {
  const rec = await resolveRef(session, ref);
  const data = await gatewayCall(session, "getAgentThread", { id: rec.id, rootId });
  return { target: rec, thread: data };
}

async function pendingApprovals(session, rec) {
  const { transcript } = await transcriptTail(session, rec, 200);
  if (!Array.isArray(transcript?.entries) || transcript.entries.length > 200) throw new GatewayError("Invalid approval transcript coverage");
  return transcript.entries.map(grokApproval).filter(Boolean);
}

export async function listGrokApprovals(session, ref) {
  const rec = await resolveRef(session, ref);
  return {
    target: { id: rec.id, name: rec.name },
    approvals: await pendingApprovals(session, rec),
    coverage: "Latest 200 transcript entries only; older requests require the owning Grok UI.",
  };
}

// The 0.78.4 app resolves cards through the backend: its dispatcher maps resolveLocalToolPermission to
// ResolveGrokBotLocalToolPermission and resolveAutoReviewApproval to ResolveGrokBotAutoReviewApproval
// (approvalPlatform defaults to "desktop"). Its routing table gives auto-review the "temporal" scope:
// the backend gets it only for a temporal bot (or a card whose session it knows, which gbot does not
// track), and other bots go to the box gateway. A local-tool card goes to the backend for any bot, and a
// non-temporal bot moves on to the box gateway when the backend answers unimplemented. Mapped from the
// app, not live-tested: a real pending card is needed. gbot grants once or declines only; ALWAYS and
// NEVER are never sent.
//
// Both answers carry `dispatched`. The app treats any answer without a refusal as done; gbot reports
// `accepted` only when dispatched is true and `unknown` otherwise, so a card left pending is not called
// accepted.
async function resolveApprovalOnBackend(session, rec, approval, entryId, requestId, accept) {
  if (approval.type === "local-tool-permission") {
    const data = await backendCall(session, "ResolveGrokBotLocalToolPermission", {
      agentId: rec.id,
      entryId,
      requestId,
      resolution: accept
        ? "GROK_BOT_LOCAL_TOOL_PERMISSION_CARD_RESOLUTION_ALLOW_ONCE"
        : "GROK_BOT_LOCAL_TOOL_PERMISSION_CARD_RESOLUTION_DENY",
    });
    // Like the app: a refusal is the answer.
    if (data?.refusal) {
      const { message, failureCode } = data.refusal;
      const reason = typeof message === "string" && message ? serverText(message, backendSecrets(session)) : "the card was not resolved";
      const error = new GatewayError("ResolveGrokBotLocalToolPermission refused: " + reason, {
        method: "ResolveGrokBotLocalToolPermission",
        code: "APPROVAL_REFUSED",
        ...(typeof failureCode === "string" && failureCode ? { failureCode } : {}),
      });
      error.delivery = "rejected";
      throw error;
    }
    return data ?? {};
  }
  // The auto-review request has no entry id; the app sends only these fields (approvedCommand and
  // mcpElicitationContent are for edited commands and forms, which gbot does not offer).
  return (await backendCall(session, "ResolveGrokBotAutoReviewApproval", {
    agentId: rec.id,
    requestId,
    resolution: accept
      ? "GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_APPROVED"
      : "GROK_BOT_AUTO_REVIEW_APPROVAL_RESOLUTION_DENIED",
    approvalPlatform: "desktop",
  })) ?? {};
}

/**
 * @param {any} session
 * @param {string} ref
 * @param {{ entryId: string, requestId: string, decision: string }} input
 * @returns {Promise<Record<string, string | boolean | { id: string, name: string }>>}
 */
export async function respondGrokApproval(session, ref, input) {
  const { entryId, requestId, decision } = grokApprovalResponseSchema.parse({ ...input, target: ref });
  const rec = await resolveRef(session, ref);
  const approvals = await pendingApprovals(session, rec);
  const target = { id: rec.id, name: rec.name };
  const matches = approvals.filter(card => card.entryId === entryId && card.requestId === requestId);
  if (matches.length !== 1) throw new GatewayError("Stale, foreign or unsupported Grok approval; refresh pending requests or use the owning Grok UI");
  const approval = matches[0];
  if (decision === "accept" && approval.truncated) throw new GatewayError("Approval details are truncated; acceptance requires the owning Grok UI");
  const local = approval.type === "local-tool-permission";
  const temporal = rec.harness === "temporal";
  const onBox = () => gatewayCall(session, local ? "resolveLocalToolPermission" : "resolveAutoReviewApproval", {
    agentId: target.id, entryId, requestId,
    resolution: local ? (decision === "accept" ? "allow-once" : "deny") : (decision === "accept" ? "approved" : "denied"),
  });
  if (!hasBackend(session) || boxOnlyRecords.has(rec) || (!local && !temporal)) {
    await onBox();
    return { target, entryId, requestId, decision, delivery: "accepted", via: "box" };
  }
  let data;
  try {
    data = await resolveApprovalOnBackend(session, rec, approval, entryId, requestId, decision === "accept");
  } catch (error) {
    // The app's next step for a non-temporal bot: the backend does not handle its card.
    if (!(local && !temporal && error instanceof GatewayError && error.code === "unimplemented")) throw error;
    await onBox();
    return { target, entryId, requestId, decision, delivery: "accepted", via: "box" };
  }
  const workflowId = typeof data.workflowId === "string" && data.workflowId ? { workflowId: data.workflowId } : {};
  if (data.dispatched === true) return { target, entryId, requestId, decision, delivery: "accepted", via: "backend", dispatched: true, ...workflowId };
  return {
    target, entryId, requestId, decision, delivery: "unknown", via: "backend", dispatched: false, ...workflowId,
    note: "The server answered without dispatching it (dispatched: false). Check the card in the Grok Bot app before deciding again.",
  };
}
