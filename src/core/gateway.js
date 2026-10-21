import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { AppAuthError, loadAppAccessToken } from "./app-auth.js";
import { cursorClientVersion } from "./client-version.js";
import { ensureSandboxHeaders, headersFromEnsureSandbox, headersFromEnv, mergeGatewayHeaders, normalizeHeaderMap, requestHeaders } from "./headers.js";
import { hasGrokBotGatewaySession, loadGrokBotGatewaySession } from "./app-session.js";
import { AVATAR_COLORS, AVATAR_SHAPES, MAX_GROUP_MEMBERS } from "./store.js";
import { assertAllowedCredentialUrl, redactSecrets } from "./url-policy.js";
import { grokApproval, grokApprovalResponseSchema } from "./grok-approvals.js";

export class GatewayError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = info.status;
    this.method = info.method;
    if (info.code !== undefined) this.code = info.code;
    if (info.effect !== undefined) this.effect = info.effect;
    if (info.failureCode !== undefined) this.failureCode = info.failureCode;
    if (info.kind !== undefined) this.kind = info.kind;
    if (info.wake !== undefined) this.wake = info.wake;
    if (info.failureReason !== undefined) this.failureReason = info.failureReason;
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

function sessionFromApp(account) {
  let loaded;
  try {
    loaded = loadGrokBotGatewaySession({ account });
  } catch (error) {
    // Descriptor present but unusable (e.g. Windows Local State missing). Fall
    // through to CURSOR_ACCESS_TOKEN → EnsureSandBox when that token is set.
    if (accessTokenFromEnv()) return null;
    throw error instanceof Error ? new GatewayError(error.message) : error;
  }
  if (!loaded) return null;
  return {
    gatewayUrl: assertAllowedCredentialUrl(loaded.gatewayUrl, { kind: "gateway" }),
    gatewayToken: loaded.gatewayToken,
    gatewayHeaders: mergeGatewayHeaders(normalizeHeaderMap(loaded.headers), headersFromEnv()),
    ...(loaded.accountScope ? { accountScope: loaded.accountScope } : {}),
  };
}

export function hasGatewayAuth() {
  return Boolean(gatewayOverride() || accessTokenFromEnv() || hasGrokBotGatewaySession());
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
  if (value == null || value === "") return "unknown";
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

function sandboxReady(result) {
  return result?.runState === "RUNNING" && Boolean(result.gatewayUrl) && Boolean(result.gatewayToken);
}

async function ensureSandbox(accessToken, { signal, wake = true, partial = false } = {}) {
  assertGatewayActive(signal);
  const url = assertAllowedCredentialUrl(backendBase(), { kind: "backend" }) + "/aiserver.v1.GrokBotService/EnsureSandBox";
  let res, body;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: gatewayDeadline(signal),
      headers: ensureSandboxHeaders(accessToken),
      // Live on macOS 2026-10-21: {wake:true} with an app login token took a hibernated box to
      // RUNNING in about 10s. {wake:false} only describes it.
      body: JSON.stringify({ wake: Boolean(wake) }),
    });
    body = await readJson(res);
  } catch (error) {
    assertGatewayActive(signal);
    throw error;
  }
  assertGatewayActive(signal);
  if (!res.ok) {
    let detail = body.message || body.error || body.raw || res.statusText;
    if (res.status === 401 && /no longer supported/i.test(String(detail))) {
      const version = cursorClientVersion();
      detail = `${detail} (gbot sent x-cursor-client-version ${version}; set SAND_CLIENT_VERSION to override)`;
    }
    throw new GatewayError("EnsureSandBox failed: " + res.status + " " + redactSecrets(detail), { status: res.status, method: "EnsureSandBox" });
  }
  const fields = sandboxFields(body);
  if ((!fields.gatewayUrl || !fields.gatewayToken) && !partial) {
    throw new GatewayError("EnsureSandBox returned no gatewayUrl/gatewayToken. Auth may be a dashboard API key (those do not work).");
  }
  return { ...fields, runState: normalizeRunState(pick(body, "runState", "run_state")) };
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
  return ensureSandbox(accessToken, { ...options, wake: false, partial: true });
}

export async function wakeSandbox(accessToken, { signal, timeoutMs, intervalMs } = {}) {
  const budget = sandboxWakeBudget();
  const timeout = timeoutMs ?? budget.timeoutMs;
  const interval = intervalMs ?? budget.intervalMs;
  const started = Date.now();
  let result = await ensureSandbox(accessToken, { signal, wake: true, partial: true });
  while (!sandboxReady(result)) {
    const elapsed = Date.now() - started;
    if (elapsed >= timeout) {
      const error = new GatewayError(
        result.runState === "STARTING" ? "The Grok Bot box is still starting." : "The Grok Bot box did not start.",
        { code: result.runState === "STARTING" ? "WAKE_TIMEOUT" : "WAKE_FAILED", method: "EnsureSandBox" },
      );
      error.runState = result.runState;
      throw error;
    }
    await abortableSleep(Math.min(interval, Math.max(0, timeout - elapsed)), signal);
    result = await ensureSandbox(accessToken, { signal, wake: false, partial: true });
  }
  return result;
}

export async function connectGateway({ signal, account } = {}) {
  assertGatewayActive(signal);
  const override = gatewayOverride();
  if (override) return override;
  const fromApp = sessionFromApp(account);
  if (fromApp) return fromApp;
  const token = accessTokenFromEnv();
  if (!token) {
    throw new GatewayError("Set CURSOR_ACCESS_TOKEN, or GROK_BOT_GATEWAY_URL + GROK_BOT_GATEWAY_TOKEN. Do not use a Cursor dashboard API key.");
  }
  const sandbox = await ensureSandbox(token, { signal, wake: true });
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

function canAutoWake(session) {
  if (!autoWakeEnabled()) return false;
  if (gatewayOverride()) return false;
  return typeof session?.accountScope === "string" && /^[0-9a-f]{64}$/.test(session.accountScope);
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
  if (error instanceof GatewayError && (error.status === 401 || error.status === 403)) {
    return { code: "UNAUTHORIZED", reason: "unauthorized" };
  }
  if (error?.code === "WAKE_TIMEOUT" || error?.code === "WAKE_FAILED") {
    return { code: error.code, reason: wakeReason(error.code) };
  }
  return { code: "WAKE_FAILED", reason: "backend error" };
}

function isCallerAbort(_error, signal) {
  return Boolean(signal?.aborted);
}

const wakesByScope = new Map();

function wakeShared(scope, signal) {
  let job = wakesByScope.get(scope);
  if (!job) {
    const controller = new AbortController();
    job = { controller, waiters: new Set(), promise: null };
    job.promise = (async () => {
      const loaded = await loadAppAccessToken({ scope, home: homedir(), env: process.env });
      const result = await wakeSandbox(loaded.token, { signal: controller.signal });
      if (process.env.GBOT_DEBUG) console.error("gbot: woke asleep box");
      return result;
    })().finally(() => {
      if (wakesByScope.get(scope) === job) wakesByScope.delete(scope);
    });
    wakesByScope.set(scope, job);
  }
  const waiter = {};
  job.waiters.add(waiter);
  const onAbort = () => {
    job.waiters.delete(waiter);
    if (job.waiters.size === 0) job.controller.abort(signal?.reason);
  };
  if (signal?.aborted) {
    onAbort();
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  return job.promise.then((result) => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError");
    }
    return result;
  }).finally(() => {
    signal?.removeEventListener("abort", onAbort);
    job.waiters.delete(waiter);
  });
}

function applySandbox(session, sandbox) {
  session.gatewayUrl = sandbox.gatewayUrl;
  session.gatewayToken = sandbox.gatewayToken;
  session.gatewayHeaders = sandbox.gatewayHeaders;
}

async function gatewayCall(session, method, body = {}, options = {}) {
  try {
    return await performGatewayCall(session, method, body, options);
  } catch (error) {
    if (options.allowWake === false || error?.code !== "BOX_ASLEEP" || !canAutoWake(session)) throw error;
    let sandbox;
    try {
      sandbox = await wakeShared(session.accountScope, options.signal);
    } catch (wakeError) {
      if (isCallerAbort(wakeError, options.signal)) throw wakeError;
      const failure = wakeFailure(wakeError);
      error.message += ` (auto wake failed: ${failure.reason})`;
      error.wake = { attempted: true, error: failure.code };
      throw error;
    }
    applySandbox(session, sandbox);
    return gatewayCall(session, method, body, { ...options, allowWake: false });
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
    if (err && err.delivery === "unknown" && err instanceof Error && !/delivery unknown/.test(err.message)) {
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
