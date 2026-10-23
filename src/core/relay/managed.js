import { spawn } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { digest, readRelayProfileFile, relayLocation } from "./profile.js";
import { readStoredRelayProfile, relayProfileMismatchError } from "./stored-profile.js";
import { relayRequest } from "./control.js";
import { redactSecrets } from "../url-policy.js";

/** @param {{pluginRoot?: string, moduleUrl?: string}} options */
export async function resolveRelayWorker({
  pluginRoot,
  moduleUrl = import.meta.url,
} = {}) {
  const roots = [];
  if (pluginRoot) roots.push(pluginRoot);
  let path = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 5; i++) {
    roots.push(path);
    path = dirname(path);
  }
  for (const candidate of new Set(roots)) {
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(join(candidate, "agent-bundle.manifest.json"), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const relative = "scripts/gbot-relay.mjs";
    const file = manifest.files?.find((f) => f.path === relative);
    if (
      manifest.application?.name !== "gbot" ||
      !file ||
      !manifest.executables?.scripts?.some((s) => s.path === relative)
    )
      continue;
    const root = await realpath(candidate),
      worker = join(root, relative),
      stat = await lstat(worker);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (await realpath(worker)) !== worker
    )
      throw Error("Relay worker must be a regular packaged script");
    if (
      stat.size !== file.bytes ||
      digest(await readFile(worker)) !== file.sha256
    )
      throw Error("Packaged relay worker checksum mismatch");
    return worker;
  }
  throw Error(
    "Packaged relay worker not found; rebuild or reinstall the plugin",
  );
}
const unavailable = (error) => ["ENOENT", "ECONNREFUSED"].includes(error.code);
export async function ensureRelayWorker(options = {}) {
  const location = relayLocation(options);
  try {
    return await relayRequest(location, "hello", {}, { timeoutMs: 1500 });
  } catch (error) {
    if (!unavailable(error)) throw error;
  }
  await assertStoredProfile(location);
  const workerPath = await resolveRelayWorker(options);
  const child = spawn(process.execPath, [workerPath], {
    detached: true,
    stdio: "ignore",
    env: {
      ...location.env,
      GROK_BOT_RELAY_DIR: location.stateDir,
      ...(location.accountScope ? { GBOT_ACCOUNT_SCOPE: location.accountScope } : {}),
    },
    cwd: dirname(workerPath),
  });
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.unref();
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (spawnError) throw spawnError;
    if (options.signal?.aborted)
      throw Error("Relay startup cancelled before submission");
    try {
      return await relayRequest(
        location,
        "hello",
        {},
        { timeoutMs: 1000, signal: options.signal },
      );
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw Error(
    "Relay worker startup failed or timed out; no untracked send was attempted. Inspect bridge status and the relay owner lock.",
  );
}
async function assertStoredProfile(location) {
  const stored = await readStoredRelayProfile(location.stateDir);
  if (stored && stored !== location.profile) throw relayProfileMismatchError();
}

function stoppedWorker(profile) {
  return {
    worker: {
      state: "stopped",
      profile,
      supervised: false,
    },
    reason:
      "Worker is not running. Start a route or tracked send to resume saved routes.",
  };
}

async function profileInDirectory(dir) {
  let fromFile;
  try {
    fromFile = await readRelayProfileFile(dir);
  } catch (error) {
    if (/symlink|owned regular file|invalid/i.test(error.message)) throw error;
    fromFile = null;
  }
  if (fromFile) return fromFile;
  return await readStoredRelayProfile(dir);
}

async function listOwnedRelayDirectories(env) {
  const root = join(env.HOME || env.USERPROFILE || homedir(), ".grok-bot-cli", "relay");
  let names;
  try {
    names = await readdir(root);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const rows = [];
  for (const name of names) {
    const stateDir = join(root, name);
    let stat;
    try {
      stat = await lstat(stateDir);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    if (process.getuid && stat.uid !== process.getuid()) continue;
    let profile;
    try {
      profile = await profileInDirectory(stateDir);
    } catch (error) {
      rows.push({
        stateDir,
        profile: null,
        worker: { state: "unreadable", supervised: false },
        reason: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
      continue;
    }
    if (!profile) continue;
    let worker = { state: "stopped", profile, supervised: false };
    if (process.platform !== "win32") {
      try {
        const reply = await relayRequest(
          { stateDir, profile, accountScope: "", env },
          "hello",
          {},
          { timeoutMs: 750 },
        );
        worker = reply.worker ?? worker;
      } catch (error) {
        if (!unavailable(error)) worker = { state: "unavailable", profile, supervised: false };
      }
    }
    rows.push({ stateDir, profile, worker });
  }
  return rows;
}

async function unmanagedAccountRelay(method, input, options, cause) {
  const env = options.env ?? process.env;
  const explicit = options.stateDir || env.GROK_BOT_RELAY_DIR;
  const reason = redactSecrets(cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
  if (!explicit) {
    if (method === "stop") {
      throw new Error(
        "Login resolution failed, so bridge stop will not choose a worker. Set GROK_BOT_RELAY_DIR to the state directory to stop.",
      );
    }
    return {
      accountResolution: "failed",
      selected: null,
      reason,
      directories: await listOwnedRelayDirectories(env),
    };
  }
  const stateDir = explicit;
  const profile = await profileInDirectory(stateDir);
  if (!profile) {
    throw new Error("Relay profile file is missing; refusing to guess an account");
  }
  const location = relayLocation({
    env,
    stateDir,
    profile,
    accountScope: "",
  });
  try {
    const reply = await relayRequest(location, method, input, {
      signal: options.signal,
      requestId: input.requestId ?? randomUUID(),
    });
    return { ...reply, accountResolution: "failed", stateDir };
  } catch (error) {
    if (method === "status" && unavailable(error)) {
      return { ...stoppedWorker(profile), accountResolution: "failed", stateDir };
    }
    throw error;
  }
}

export async function managedOperation(method, input, options = {}) {
  let location;
  try {
    location = relayLocation(options);
  } catch (error) {
    if (error?.code === "INVALID_ACCOUNT_SCOPE") throw error;
    if (!["status", "stop"].includes(method)) throw error;
    if (/Windows is unsupported/.test(String(error?.message))) throw error;
    return await unmanagedAccountRelay(method, input, options, error);
  }
  const requestId = input.requestId ?? randomUUID();
  if (!["status", "stop", "respond"].includes(method))
    await ensureRelayWorker(options);
  try {
    return await relayRequest(location, method, input, {
      signal: options.signal,
      requestId,
    });
  } catch (error) {
    if (unavailable(error)) {
      await assertStoredProfile(location);
      if (method === "status") return stoppedWorker(location.profile);
    }
    // Never retry a disconnected mutation. Its durable request ID is the recovery handle.
    throw error;
  }
}
