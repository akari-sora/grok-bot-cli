import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Live on 2026-10-21: EnsureSandBox rejects x-cursor-client-version 0.20.0 with 401
// "no longer supported" and accepts the installed app's 0.72.1.
export const DEFAULT_SAND_CLIENT_VERSION = "0.72.1";

const VERSION = /^\d+\.\d+\.\d+$/;
const PLIST_VERSION = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/;
const GROK_BOT_DISPLAY_NAME = /^Grok Bot(\s|$)/;
// electron-builder app id. Live on the owner's Windows machine, 2026-10-21:
// DisplayName "Grok Bot 0.72.1", DisplayVersion "0.72.1", Publisher "SpaceXAI".
const REG_APP_ID = "8db316bb-b3e2-5dd2-9554-ecccb62be362";
const REG_ROOTS = [
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];
const REG_BUDGET_MS = 3000;
const REG_MAX_BUFFER = 1024 * 1024;

export function normalizeClientVersion(raw) {
  const trimmed = String(raw ?? "").trim();
  const fourPart = /^(\d+\.\d+\.\d+)\.\d+$/.exec(trimmed);
  const candidate = fourPart ? fourPart[1] : trimmed;
  return VERSION.test(candidate) ? candidate : null;
}

function macVersion(home, readFile) {
  const paths = [
    "/Applications/Grok Bot.app/Contents/Info.plist",
    path.join(home, "Applications/Grok Bot.app/Contents/Info.plist"),
  ];
  for (const path of paths) {
    let text = "";
    try {
      text = readFile(path, "utf8");
    } catch {
      continue;
    }
    const match = PLIST_VERSION.exec(String(text));
    const version = match ? normalizeClientVersion(match[1]) : null;
    if (version) return version;
  }
  return null;
}

const DISPLAY_NAME_LINE = /^\s*DisplayName\s+REG_\w+\s+(.*)$/m;
const DISPLAY_VERSION_LINE = /^\s*DisplayVersion\s+REG_\w+\s+(.*)$/m;
const DISPLAY_NAME_VERSION = /^Grok Bot\s+(\d+\.\d+\.\d+(?:\.\d+)?)$/;

function regBlocks(output) {
  return String(output).split(/\r?\n(?=HKEY_)/);
}

function versionFromValue(output) {
  const found = DISPLAY_VERSION_LINE.exec(String(output));
  return found ? normalizeClientVersion(found[1]) : null;
}

function versionFromDisplayName(displayName) {
  const match = DISPLAY_NAME_VERSION.exec(String(displayName).trim());
  return match ? normalizeClientVersion(match[1]) : null;
}

function versionFromReg(output) {
  for (const block of regBlocks(output)) {
    const name = DISPLAY_NAME_LINE.exec(block);
    if (!name || !GROK_BOT_DISPLAY_NAME.test(name[1].trim())) continue;
    const version = versionFromValue(block);
    if (version) return version;
  }
  return null;
}

// `/f /d` lists only values whose data matches, so DisplayVersion is not in that output.
// The key path is the HKEY line above a matching DisplayName.
function installFromSearch(output) {
  for (const block of regBlocks(output)) {
    const name = DISPLAY_NAME_LINE.exec(block);
    if (!name || !GROK_BOT_DISPLAY_NAME.test(name[1].trim())) continue;
    const key = /^(HKEY_\S+)/.exec(block);
    if (!key) continue;
    return { key: key[1], displayName: name[1].trim() };
  }
  return null;
}

function regExe(env) {
  // Absolute path: a bare `reg` is resolved from the current directory first.
  // win32.join so the path is correct when this file is loaded on macOS or Linux too.
  return path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
}

function windowsVersion(execFile, env = process.env, now = Date.now) {
  const exe = regExe(env);
  const started = now();
  const query = (args) => {
    const timeout = REG_BUDGET_MS - (now() - started);
    if (timeout <= 0) {
      const error = new Error("registry lookup budget exceeded");
      error.code = "ETIMEDOUT";
      throw error;
    }
    return execFile(exe, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: REG_MAX_BUFFER,
      windowsHide: true,
    });
  };
  for (const root of REG_ROOTS) {
    try {
      const version = versionFromReg(query(["query", `${root}\\${REG_APP_ID}`]));
      if (version) return version;
    } catch {
      // Missing key or a spent budget. Try the next root.
    }
  }
  for (const root of REG_ROOTS) {
    let listed;
    try {
      listed = query(["query", root, "/s", "/f", "Grok Bot", "/d"]);
    } catch {
      // ENOBUFS, timeout, or no match. A spent budget stops the rest.
      continue;
    }
    const install = installFromSearch(listed);
    if (!install) continue;
    try {
      const version = versionFromValue(query(["query", install.key, "/v", "DisplayVersion"]));
      if (version) return version;
    } catch {
      // The follow-up failed, or the shared budget was already gone.
    }
    const named = versionFromDisplayName(install.displayName);
    if (named) return named;
  }
  return null;
}

function installedVersion({ platform, home, readFile, execFile, env, now }) {
  if (platform === "darwin") return macVersion(home, readFile);
  if (platform === "win32") return windowsVersion(execFile, env, now);
  return null;
}

let cachedAppVersion;
let versionSource;
let lastAppRereadAt = 0;
const APP_VERSION_REREAD_MS = 10 * 60 * 1000;

// Property lookup so a test can stub the installed-app read without touching the real disk or registry.
export const clientVersionRuntime = {
  now: () => Date.now(),
  platform: () => process.platform,
  home: () => homedir(),
  readFile: readFileSync,
  execFile: execFileSync,
};

/** Drop cache, source, and the re-read clock. Tests use this between cases. */
export function resetClientVersionCache() {
  cachedAppVersion = undefined;
  versionSource = undefined;
  lastAppRereadAt = 0;
}

/**
 * Drop the cached installed version so the next call reads the app again.
 * Only an installed-app value is dropped (not `SAND_CLIENT_VERSION`, not the
 * built-in default), and at most once per 10 minutes.
 */
export function forgetCachedAppVersion() {
  if (versionSource !== "app") return false;
  const now = clientVersionRuntime.now();
  if (lastAppRereadAt !== 0 && now - lastAppRereadAt < APP_VERSION_REREAD_MS) return false;
  cachedAppVersion = undefined;
  versionSource = undefined;
  lastAppRereadAt = now;
  return true;
}

function envClientVersion(env) {
  const raw = env.SAND_CLIENT_VERSION;
  if (raw == null || String(raw).trim() === "") return null;
  const version = normalizeClientVersion(String(raw));
  return { version: version ?? DEFAULT_SAND_CLIENT_VERSION, source: version ? "env" : "default" };
}

/**
 * `SAND_CLIENT_VERSION` when it is a `major.minor.patch` (a fourth numeric
 * segment is dropped). Otherwise the installed Grok Bot app, cached for the
 * process, otherwise {@link DEFAULT_SAND_CLIENT_VERSION}. An invalid env value
 * does not fall through to the app. A 401 "no longer supported" drops the
 * cache only when this call's value came from the installed app, and at most
 * once per 10 minutes, so a long-running relay or MCP does not re-run the
 * Windows registry lookup on every rejection.
 */
export function cursorClientVersion({
  env = process.env,
  platform,
  home,
  readFile,
  execFile,
  now,
} = {}) {
  const fromEnv = envClientVersion(env);
  const injected = platform != null || home != null || readFile != null || execFile != null || now != null;
  if (fromEnv) {
    if (!injected) versionSource = fromEnv.source;
    return fromEnv.version;
  }
  if (!injected) {
    if (cachedAppVersion === undefined) {
      cachedAppVersion = installedVersion({
        platform: clientVersionRuntime.platform(),
        home: clientVersionRuntime.home(),
        readFile: clientVersionRuntime.readFile,
        execFile: clientVersionRuntime.execFile,
        env: process.env,
        now: clientVersionRuntime.now,
      });
    }
    versionSource = cachedAppVersion ? "app" : "default";
    return cachedAppVersion ?? DEFAULT_SAND_CLIENT_VERSION;
  }
  return installedVersion({
    platform: platform ?? process.platform,
    home: home ?? homedir(),
    readFile: readFile ?? readFileSync,
    execFile: execFile ?? execFileSync,
    env,
    now: now ?? Date.now,
  }) ?? DEFAULT_SAND_CLIENT_VERSION;
}
