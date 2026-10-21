import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
    join(home, "Applications/Grok Bot.app/Contents/Info.plist"),
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

function versionFromReg(output) {
  const blocks = String(output).split(/\r?\n(?=HKEY_)/);
  for (const block of blocks) {
    const name = /^\s*DisplayName\s+REG_\w+\s+(.*)$/m.exec(block);
    if (!name || !GROK_BOT_DISPLAY_NAME.test(name[1].trim())) continue;
    const found = /^\s*DisplayVersion\s+REG_\w+\s+(.*)$/m.exec(block);
    const version = found ? normalizeClientVersion(found[1]) : null;
    if (version) return version;
  }
  return null;
}

function regExe(env) {
  // Absolute path: a bare `reg` is resolved from the current directory first.
  return join(env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
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
    try {
      const version = versionFromReg(query(["query", root, "/s", "/f", "Grok Bot", "/d"]));
      if (version) return version;
    } catch {
      // ENOBUFS, timeout, or no match. A spent budget stops the rest.
    }
  }
  return null;
}

function installedVersion({ platform, home, readFile, execFile, env, now }) {
  if (platform === "darwin") return macVersion(home, readFile);
  if (platform === "win32") return windowsVersion(execFile, env, now);
  return null;
}

let cachedAppVersion;

/** Drop the per-process installed-version cache so the next call reads the app again. */
export function forgetCachedAppVersion() {
  cachedAppVersion = undefined;
}

/**
 * `SAND_CLIENT_VERSION` when it is a `major.minor.patch` (a fourth numeric
 * segment is dropped). Otherwise the installed Grok Bot app, cached for the
 * process, otherwise {@link DEFAULT_SAND_CLIENT_VERSION}. An invalid env value
 * does not fall through to the app. A long-running relay or MCP keeps the
 * version it read first until EnsureSandBox answers 401 "no longer supported",
 * which clears this cache so the next call reads the app again.
 */
export function cursorClientVersion({
  env = process.env,
  platform,
  home,
  readFile,
  execFile,
  now,
} = {}) {
  const raw = env.SAND_CLIENT_VERSION;
  if (raw != null && String(raw).trim() !== "") {
    return normalizeClientVersion(String(raw)) ?? DEFAULT_SAND_CLIENT_VERSION;
  }
  const injected = platform != null || home != null || readFile != null || execFile != null || now != null;
  if (!injected) {
    if (cachedAppVersion === undefined) {
      cachedAppVersion = installedVersion({
        platform: process.platform,
        home: homedir(),
        readFile: readFileSync,
        execFile: execFileSync,
        env: process.env,
        now: Date.now,
      });
    }
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
