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
  return rememberSession({
    gatewayUrl: sandbox.gatewayUrl,
    gatewayToken: sandbox.gatewayToken,
    gatewayHeaders: sandbox.gatewayHeaders,
    accountScope: scope,
  });
}

// Precedence: gateway URL+token override, then --account, GBOT_ACCOUNT_SCOPE, GBOT_ACCOUNT,
// the config default, then the descriptor single entry or its active entry. A saved-only login
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
      return descriptorSession(account);
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
      return session;
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
  return { gatewayUrl: sandbox.gatewayUrl, gatewayToken: sandbox.gatewayToken, gatewayHeaders: sandbox.gatewayHeaders };
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
      const fresh = await sessionFromSavedLogin(session.accountScope, options.signal);
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

export async function listAgents(session, { signal } = {}) {
  const data = await gatewayCall(session, "listAgents", {}, { signal });
  return unwrapList(data).map(asRecord).filter((r) => r && r.id);
}

function resolveFromList(records, ref) {
  const needle = String(ref).trim().toLowerCase();
  const byId = records.find((r) => r.id.toLowerCase() === needle);
  if (byId) return byId;
  const matches = records.filter((r) => r.name.toLowerCase() === needle || r.title.toLowerCase() === needle);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new GatewayError("No bot or group named \"" + ref + "\"");
  throw new GatewayError("Ambiguous name \"" + ref + "\"");
}

export async function resolveRef(session, ref, { signal } = {}) {
  return resolveFromList(await listAgents(session, { signal }), ref);
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

export async function updateAgent(session, ref, patch = {}) {
  const rec = await resolveRef(session, ref);
  if (patch.name !== undefined && !String(patch.name).trim()) {
    throw new GatewayError("Name cannot be blank.");
  }
  const profile = {
    name: patch.name !== undefined ? String(patch.name).trim() : rec.name,
    description: patch.description !== undefined ? String(patch.description) : rec.description,
  };
  if (patch.title !== undefined) profile.title = String(patch.title);
  if (patch.avatarShape !== undefined) profile.avatarShape = assertAvatar("shape", patch.avatarShape, AVATAR_SHAPES);
  if (patch.avatarColor !== undefined) profile.avatarColor = assertAvatar("color", patch.avatarColor, AVATAR_COLORS);
  await gatewayCall(session, "updateAgent", { id: rec.id, profile });
  if (patch.notifyOnAgentUpdates !== undefined) {
    await gatewayCall(session, "setAgentNotifyOnUpdates", { id: rec.id, isEnabled: Boolean(patch.notifyOnAgentUpdates) });
  }
  if (patch.hiddenFromSidebar !== undefined) {
    await gatewayCall(session, "setAgentHiddenFromSidebar", { id: rec.id, isHidden: Boolean(patch.hiddenFromSidebar) });
  }
  const fresh = (await listAgents(session)).find((r) => r.id === rec.id);
  return fresh || rec;
}

export async function deleteAgent(session, ref) {
  const rec = await resolveRef(session, ref);
  await gatewayCall(session, "deleteAgent", { id: rec.id });
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

async function anyBotId(session) {
  const bot = (await listAgents(session)).find((r) => !r.isGroup);
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

export async function createGroup(session, input) {
  const records = await listAgents(session);
  const memberAgentIds = normalizeMemberIds(records, input.memberIds || []);
  const data = await gatewayCall(session, "createGroup", {
    name: input.name,
    description: input.description || "",
    memberAgentIds,
  });
  const rec = unwrapOne(data);
  const extras = {};
  if (input.title) extras.title = input.title;
  if (input.avatarShape) extras.avatarShape = input.avatarShape;
  if (input.avatarColor) extras.avatarColor = input.avatarColor;
  if (Object.keys(extras).length && rec?.id) return updateAgent(session, rec.id, extras);
  return rec;
}

export async function setGroupMembers(session, groupRef, memberRefs) {
  const records = await listAgents(session);
  const group = resolveFromList(records, groupRef);
  if (!group.isGroup) throw new GatewayError(`"${group.name}" is a bot, not a group.`);
  const memberAgentIds = normalizeMemberIds(records, memberRefs);
  const data = await gatewayCall(session, "setGroupMembers", {
    id: group.id,
    memberAgentIds,
  });
  return unwrapOne(data) || { ...group, memberIds: memberAgentIds, isGroup: true };
}

export async function addGroupMember(session, groupRef, memberRef) {
  const records = await listAgents(session);
  const group = resolveFromList(records, groupRef);
  if (!group.isGroup) throw new GatewayError(`"${group.name}" is a bot, not a group.`);
  const member = resolveFromList(records, memberRef);
  const next = [...new Set([...group.memberIds, member.id])];
  return setGroupMembers(session, group.id, next);
}

export async function removeGroupMember(session, groupRef, memberRef) {
  const records = await listAgents(session);
  const group = resolveFromList(records, groupRef);
  if (!group.isGroup) throw new GatewayError(`"${group.name}" is a bot, not a group.`);
  const member = resolveFromList(records, memberRef);
  const next = group.memberIds.filter((id) => id !== member.id);
  return setGroupMembers(session, group.id, next);
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
  let data;
  try {
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
    if (err instanceof GatewayError && err.delivery === "unknown" && !/delivery unknown/.test(err.message)) {
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

export async function getTranscriptTail(session, ref, limit = 40) {
  const rec = await resolveRef(session, ref);
  const bounded = Math.min(Math.max(Math.trunc(limit) || 40, 1), 200);
  const data = await gatewayCall(session, "getAgentTranscriptTail", { id: rec.id, limit: bounded });
  return { target: rec, transcript: data };
}

// Read the transcript tail for the nonce this send used. Never calls sendPrompt.
export async function reconcileDelivery(session, ref, clientNonce) {
  if (typeof clientNonce !== "string" || clientNonce.length === 0) {
    throw new GatewayError("A clientNonce is required to reconcile a delivery.");
  }
  const tail = await getTranscriptTail(session, ref, 200);
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
    };
  }
  return {
    target: tail.target,
    clientNonce,
    status: "not-found-in-tail",
    scanned: entries.length,
  };
}

export async function getThread(session, ref, rootId) {
  const rec = await resolveRef(session, ref);
  const data = await gatewayCall(session, "getAgentThread", { id: rec.id, rootId });
  return { target: rec, thread: data };
}

export async function listGrokApprovals(session, ref) {
  const { target, transcript } = await getTranscriptTail(session, ref, 200);
  if (!Array.isArray(transcript?.entries) || transcript.entries.length > 200) throw new GatewayError("Invalid approval transcript coverage");
  return {
    target: { id: target.id, name: target.name },
    approvals: transcript.entries.map(grokApproval).filter(Boolean),
    coverage: "Latest 200 transcript entries only; older requests require the owning Grok UI.",
  };
}

export async function respondGrokApproval(session, ref, input) {
  const { entryId, requestId, decision } = grokApprovalResponseSchema.parse({ ...input, target: ref });
  const { target, approvals } = await listGrokApprovals(session, ref);
  const matches = approvals.filter(card => card.entryId === entryId && card.requestId === requestId);
  if (matches.length !== 1) throw new GatewayError("Stale, foreign or unsupported Grok approval; refresh pending requests or use the owning Grok UI");
  const approval = matches[0];
  if (decision === "accept" && approval.truncated) throw new GatewayError("Approval details are truncated; acceptance requires the owning Grok UI");
  const local = approval.type === "local-tool-permission";
  await gatewayCall(session, local ? "resolveLocalToolPermission" : "resolveAutoReviewApproval", {
    agentId: target.id, entryId, requestId,
    resolution: local ? (decision === "accept" ? "allow-once" : "deny") : (decision === "accept" ? "approved" : "denied"),
  });
  return { target, entryId, requestId, decision, delivery: "accepted" };
}
