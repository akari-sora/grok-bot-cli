import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { codexSocketPath } from "../codex-bridge.js";
import { grokBotGatewayDescriptorPath } from "../app-session.js";
import { resolveGrokBotLogin, workerAccountScope } from "../logins.js";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");

const SCOPE = /^[0-9a-f]{64}$/;

/** Resolved account scope for this process, or "" when no app login is selected. */
export function resolveRelayAccountScope(env = process.env) {
  const pinned = workerAccountScope(env);
  if (pinned) return pinned;
  const home = env.HOME || env.USERPROFILE;
  if (!home) return "";
  const choice = resolveGrokBotLogin({ env, home, platform: process.platform });
  return choice?.scope || "";
}

// Endpoint and caller overrides are hashed. Account identity is the resolved scope only:
// raw GBOT_ACCOUNT, GBOT_CONFIG, and GBOT_ACCOUNT_SCOPE are not hashed, so two selectors
// for the same account share one worker and one duplicate-binding check.
export function relayProfile(env = process.env, accountScope = "") {
  const keys = [
    "GROK_BOT_GATEWAY_URL",
    "SAND_HOST_GATEWAY_URL",
    "SAND_HOST_PORT",
    "GROK_BOT_GATEWAY_TOKEN",
    "SAND_HOST_GATEWAY_TOKEN",
    "SAND_GATEWAY_TOKEN",
    "CURSOR_ACCESS_TOKEN",
    "GROK_BOT_ACCESS_TOKEN",
    "SAND_ACCESS_TOKEN",
    "GROK_BOT_GATEWAY_HEADERS",
    "SAND_BACKEND_URL",
    "CURSOR_API_BASE_URL",
    "SAND_BOX_NAMESPACE",
    "SAND_CLIENT_VERSION",
    "GROK_BOT_CODEX_THREADS",
    "GROK_BOT_MAX_HOPS",
    "GROK_BOT_CODEX_EXPERIMENTAL",
    "GROK_BOT_ALLOW_LOCAL_GATEWAY",
    "GROK_BOT_ALLOW_ANY_GATEWAY",
    "GROK_BOT_TEST",
    "NODE_ENV",
    // Secret Service credentials depend on the caller's desktop session.
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
  ];
  const scope = typeof accountScope === "string" ? accountScope : "";
  return digest(
    JSON.stringify([
      resolve(codexSocketPath(env)),
      grokBotGatewayDescriptorPath(homedir(), process.platform, env),
      scope,
      ...keys.map((key) => [key, env[key] ?? ""]),
    ]),
  );
}
const PROFILE_FILE = "profile";
const PROFILE_TEMP = /^profile\.\d+\.[0-9a-f]{8}\.tmp$/;

/** Drop profile.<pid>.<hex>.tmp left behind when a write dies before rename. */
export async function removeStaleProfileTemps(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!PROFILE_TEMP.test(name)) continue;
    const tempPath = join(dir, name);
    let info;
    try {
      info = await lstat(tempPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (info.isDirectory()) continue;
    await unlink(tempPath);
  }
}

function assertProfileText(profile) {
  if (typeof profile !== "string" || profile.length < 1 || profile.length > 512 || /[\0\r\n]/.test(profile)) {
    throw new Error("Relay profile file is invalid");
  }
}

async function profileFileStat(dir) {
  const path = join(dir, PROFILE_FILE);
  try {
    return { path, stat: await lstat(path) };
  } catch (error) {
    if (error.code === "ENOENT") return { path, stat: null };
    throw error;
  }
}

function ownedProfileFile(stat) {
  if (!stat) return;
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || (process.getuid && stat.uid !== process.getuid())
    || stat.size > 1024
  ) {
    throw new Error("Relay profile file must be an owned regular file, never a symlink");
  }
}

/** Plain profile hash for stop/status when login resolution cannot recompute it. */
export async function writeRelayProfileFile(dir, profile) {
  assertProfileText(profile);
  const { path, stat } = await profileFileStat(dir);
  ownedProfileFile(stat);
  await removeStaleProfileTemps(dir);
  // Temp file plus rename. Truncating the destination first leaves an empty
  // file if the process dies before the write, and that empty file fails every
  // later status list.
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.write(profile, 0, "utf8");
    await file.sync();
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  await chmod(path, 0o600);
}

export async function readRelayProfileFile(dir) {
  const { path, stat } = await profileFileStat(dir);
  if (!stat) return null;
  ownedProfileFile(stat);
  const text = (await readFile(path, "utf8")).trim();
  assertProfileText(text);
  return text;
}

export function relayLocation({
  env = process.env,
  stateDir,
  profile,
  accountScope,
} = {}) {
  const scope = accountScope !== undefined ? accountScope : resolveRelayAccountScope(env);
  const pinned = typeof scope === "string" && SCOPE.test(scope) ? scope : "";
  const effectiveEnv = { ...env };
  if (pinned) effectiveEnv.GBOT_ACCOUNT_SCOPE = pinned;
  const resolvedProfile = profile ?? relayProfile(effectiveEnv, pinned);
  if (process.platform === "win32")
    throw Error(
      "Codex relay requires Unix-domain sockets; Windows is unsupported.",
    );
  const dir = resolve(
    stateDir ??
      env.GROK_BOT_RELAY_DIR ??
      join(homedir(), ".grok-bot-cli", "relay", resolvedProfile.slice(0, 24)),
  );
  // macOS Unix sockets cannot use arbitrarily long installation/state paths.
  const socketDir =
    Buffer.byteLength(join(dir, "control.sock")) < 100
      ? dir
      : join(
          "/tmp",
          `gbot-relay-${process.getuid()}`,
          digest(dir).slice(0, 24),
        );
  return {
    stateDir: dir,
    profile: resolvedProfile,
    accountScope: pinned,
    env: effectiveEnv,
    socketDir,
    socketPath: join(socketDir, "control.sock"),
  };
}
