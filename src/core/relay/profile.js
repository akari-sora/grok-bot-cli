import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { codexSocketPath } from "../codex-bridge.js";
import { grokBotGatewayDescriptorPath } from "../app-session.js";
import { resolveGrokBotLogin } from "../logins.js";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");

const SCOPE = /^[0-9a-f]{64}$/;

/** Resolved account scope for this process, or "" when no app login is selected. */
export function resolveRelayAccountScope(env = process.env) {
  const pinned = String(env.GBOT_ACCOUNT_SCOPE ?? "").trim();
  if (SCOPE.test(pinned)) return pinned;
  const home = env.HOME || env.USERPROFILE;
  if (!home) return "";
  try {
    const choice = resolveGrokBotLogin({ env, home, platform: process.platform });
    return choice?.scope || "";
  } catch (error) {
    if (error?.code === "AMBIGUOUS_ENTRIES" || error?.code === "UNKNOWN_ACCOUNT" || error?.name === "GbotConfigError") {
      throw error;
    }
    return "";
  }
}

// Only explicit overrides are hashed. The resolved account scope is part of the worker identity.
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
    "GBOT_CONFIG",
    "GBOT_ACCOUNT",
    "GBOT_ACCOUNT_SCOPE",
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
