import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Live on 2026-10-21: EnsureSandBox rejects x-cursor-client-version 0.20.0 with 401
// "no longer supported" and accepts the installed app's 0.72.1.
export const DEFAULT_SAND_CLIENT_VERSION = "0.72.1";

const VERSION = /^\d+\.\d+\.\d+$/;
const PLIST_VERSION = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/;
const REG_ROOTS = [
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

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
    if (!name || name[1].trim() !== "Grok Bot") continue;
    const found = /^\s*DisplayVersion\s+REG_\w+\s+(.*)$/m.exec(block);
    const version = found ? normalizeClientVersion(found[1]) : null;
    if (version) return version;
  }
  return null;
}

function windowsVersion(execFile) {
  for (const root of REG_ROOTS) {
    let output = "";
    try {
      output = execFile("reg", ["query", root, "/s"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      });
    } catch {
      continue;
    }
    const version = versionFromReg(output);
    if (version) return version;
  }
  return null;
}

function installedVersion({ platform, home, readFile, execFile }) {
  if (platform === "darwin") return macVersion(home, readFile);
  if (platform === "win32") return windowsVersion(execFile);
  return null;
}

let cachedAppVersion;

/**
 * `SAND_CLIENT_VERSION` when it is a `major.minor.patch` (a fourth numeric
 * segment is dropped). Otherwise the installed Grok Bot app, cached for the
 * process, otherwise {@link DEFAULT_SAND_CLIENT_VERSION}. An invalid env value
 * does not fall through to the app.
 */
export function cursorClientVersion({
  env = process.env,
  platform,
  home,
  readFile,
  execFile,
} = {}) {
  const raw = env.SAND_CLIENT_VERSION;
  if (raw != null && String(raw).trim() !== "") {
    return normalizeClientVersion(String(raw)) ?? DEFAULT_SAND_CLIENT_VERSION;
  }
  const injected = platform != null || home != null || readFile != null || execFile != null;
  if (!injected) {
    if (cachedAppVersion === undefined) {
      cachedAppVersion = installedVersion({
        platform: process.platform,
        home: homedir(),
        readFile: readFileSync,
        execFile: execFileSync,
      });
    }
    return cachedAppVersion ?? DEFAULT_SAND_CLIENT_VERSION;
  }
  return installedVersion({
    platform: platform ?? process.platform,
    home: home ?? homedir(),
    readFile: readFile ?? readFileSync,
    execFile: execFile ?? execFileSync,
  }) ?? DEFAULT_SAND_CLIENT_VERSION;
}
