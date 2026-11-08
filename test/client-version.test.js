import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";

import { clientVersionRuntime, cursorClientVersion, DEFAULT_SAND_CLIENT_VERSION, forgetCachedAppVersion, resetClientVersionCache } from "../src/core/client-version.js";
import { connectGateway } from "../src/core/gateway.js";
import { ensureSandboxHeaders } from "../src/core/headers.js";

function withEnv(values, fn) {
  const prev = {};
  for (const key of Object.keys(values)) {
    prev[key] = process.env[key];
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  }
  const restore = () => {
    for (const key of Object.keys(values)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === "function") return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key>
<string>0.70.2</string>
</dict></plist>`;

function enoent() {
  const error = new Error("ENOENT");
  error.code = "ENOENT";
  return error;
}

// The fixtures below read the installed app (plist or registry): the app's desktop-status.json is absent.
const isDesktopStatus = (file) => String(file).endsWith("desktop-status.json");
const noDesktopStatus = () => {
  throw enoent();
};

test("SAND_CLIENT_VERSION wins over the installed app", () => {
  let reads = 0;
  const version = cursorClientVersion({
    env: { SAND_CLIENT_VERSION: "9.8.7" },
    platform: "darwin",
    home: "/Users/fixture",
    readFile: () => {
      reads += 1;
      return PLIST;
    },
  });
  assert.equal(version, "9.8.7");
  assert.equal(reads, 0);
  assert.equal(withEnv({ SAND_CLIENT_VERSION: "9.8.7" }, () => ensureSandboxHeaders("t")["x-cursor-client-version"]), "9.8.7");
});

test("macOS plist: /Applications then ~/Applications", () => {
  const seen = [];
  const version = cursorClientVersion({
    env: {},
    platform: "darwin",
    home: "/Users/fixture",
    readFile: (path) => {
      seen.push(path);
      if (isDesktopStatus(path) || path === "/Applications/Grok Bot.app/Contents/Info.plist") throw enoent();
      return PLIST;
    },
  });
  assert.equal(version, "0.70.2");
  assert.deepEqual(seen, [
    join("/Users/fixture", "Library/Application Support/Grok Bot", "desktop-status.json"),
    "/Applications/Grok Bot.app/Contents/Info.plist",
    join("/Users/fixture", "Applications/Grok Bot.app/Contents/Info.plist"),
  ]);
});

const REG_APP_ID = "8db316bb-b3e2-5dd2-9554-ecccb62be362";
const LIVE_REG = [
  `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${REG_APP_ID}`,
  "    DisplayName    REG_SZ    Grok Bot 0.72.1",
  "    DisplayVersion    REG_SZ    0.72.1",
  "    Publisher    REG_SZ    SpaceXAI",
  "",
].join("\r\n");

test("Windows registry lookup uses an absolute reg.exe and the live install key", () => {
  const calls = [];
  const version = cursorClientVersion({
    env: { SystemRoot: "D:\\Windows" },
    platform: "win32",
    readFile: noDesktopStatus,
    execFile: (cmd, args, options) => {
      calls.push({ cmd, args, timeout: options.timeout, maxBuffer: options.maxBuffer });
      return LIVE_REG;
    },
  });
  assert.equal(version, "0.72.1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, win32.join("D:\\Windows", "System32", "reg.exe"));
  assert.notEqual(calls[0].cmd, "reg");
  assert.deepEqual(calls[0].args, [
    "query",
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${REG_APP_ID}`,
  ]);
  assert.equal(typeof calls[0].maxBuffer, "number");
  assert.ok(calls[0].maxBuffer >= 1024);
  assert.ok(calls[0].timeout <= 3000 && calls[0].timeout > 0);
  assert.equal(withEnv({ SAND_CLIENT_VERSION: "0.72.1.0" }, () => ensureSandboxHeaders("t")["x-cursor-client-version"]), "0.72.1");
});

// Live `reg query HKCU\...\Uninstall /s /f "Grok Bot" /d` on 2026-10-21.
// `/f /d` prints only values whose data contains "Grok Bot", so DisplayVersion is absent.
const LIVE_REG_SEARCH = [
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\8db316bb-b3e2-5dd2-9554-ecccb62be362",
  "    DisplayName    REG_SZ    Grok Bot 0.72.1",
  "    UninstallString    REG_SZ    \"D:\\APP\\Grok Bot\\Uninstall Grok Bot.exe\" /currentuser",
  "    QuietUninstallString    REG_SZ    \"D:\\APP\\Grok Bot\\Uninstall Grok Bot.exe\" /currentuser /S",
  "    DisplayIcon    REG_SZ    D:\\APP\\Grok Bot\\Grok Bot.exe,0",
  "    Comments    REG_SZ    Grok Bot desktop agent",
  "",
  "End of search: 5 match(es) found.",
  "",
].join("\r\n");

const LIVE_REG_KEY = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\8db316bb-b3e2-5dd2-9554-ecccb62be362";

function windowsLookup(execFile) {
  let clock = 1_000;
  const calls = [];
  const version = cursorClientVersion({
    env: {},
    platform: "win32",
    readFile: noDesktopStatus,
    now: () => clock,
    execFile: (cmd, args, options) => {
      calls.push({ cmd, args, timeout: options.timeout });
      clock += 10;
      return execFile(cmd, args, options);
    },
  });
  return { version, calls };
}

test("Windows /f search queries DisplayVersion on the matching key", () => {
  const versionBlock = [
    LIVE_REG_KEY,
    "    DisplayVersion    REG_SZ    1.2.3",
    "",
  ].join("\r\n");
  const { version, calls } = windowsLookup((_cmd, args) => {
    if (args.includes("/v")) return versionBlock;
    if (args.includes("/f")) return LIVE_REG_SEARCH;
    throw new Error("missing key");
  });
  assert.equal(version, "1.2.3");
  assert.equal(calls[0].cmd, win32.join("C:\\Windows", "System32", "reg.exe"));
  const searched = calls.filter((call) => call.args.includes("/f"));
  assert.equal(searched.length, 1);
  assert.deepEqual(searched[0].args, [
    "query",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "/s",
    "/f",
    "Grok Bot",
    "/d",
  ]);
  const versionQuery = calls.find((call) => call.args.includes("/v"));
  assert.deepEqual(versionQuery.args, ["query", LIVE_REG_KEY, "/v", "DisplayVersion"]);
  assert.ok(calls.every((call) => call.timeout <= 3000 && call.timeout > 0));
});

test("Windows /f search uses the DisplayName suffix when DisplayVersion cannot be read", () => {
  const { version, calls } = windowsLookup((_cmd, args) => {
    if (args.includes("/v")) throw new Error("DisplayVersion query failed");
    if (args.includes("/f")) return LIVE_REG_SEARCH;
    throw new Error("missing key");
  });
  assert.equal(version, "0.72.1");
  assert.equal(calls.filter((call) => call.args.includes("/f")).length, 1);
  assert.deepEqual(
    calls.find((call) => call.args.includes("/v")).args,
    ["query", LIVE_REG_KEY, "/v", "DisplayVersion"],
  );
});

test("Windows registry queries share one 3s budget", () => {
  let clock = 0;
  const timeouts = [];
  cursorClientVersion({
    env: {},
    platform: "win32",
    readFile: noDesktopStatus,
    now: () => clock,
    execFile: (_cmd, _args, options) => {
      timeouts.push(options.timeout);
      clock += 2500;
      throw new Error("slow miss");
    },
  });
  assert.deepEqual(timeouts, [3000, 500]);
});

test("Windows /f search keeps a key path that contains spaces when DisplayName has no version", () => {
  const key = "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Grok Bot_is1";
  const search = [
    key,
    "    DisplayName    REG_SZ    Grok Bot",
    "",
  ].join("\r\n");
  let queried = "";
  const version = cursorClientVersion({
    env: {},
    platform: "win32",
    readFile: noDesktopStatus,
    execFile: (_cmd, args) => {
      if (args.includes("/f")) return search;
      if (args.includes("/v")) {
        queried = args[1];
        if (args[1] !== key) throw new Error("wrong key");
        return [key, "    DisplayVersion    REG_SZ    1.2.3", ""].join("\r\n");
      }
      throw new Error("missing key");
    },
  });
  assert.equal(queried, key);
  assert.equal(version, "1.2.3");
});

test("a DisplayName that does not start with Grok Bot is ignored", () => {
  const output = [
    `HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${REG_APP_ID}`,
    "    DisplayName    REG_SZ    Grok BotExtra",
    "    DisplayVersion    REG_SZ    9.9.9",
    "",
  ].join("\r\n");
  const version = cursorClientVersion({
    env: {},
    platform: "win32",
    readFile: noDesktopStatus,
    execFile: () => output,
  });
  assert.equal(version, "0.72.1");
});

test("invalid client versions fall back to the built-in default", () => {
  assert.equal(DEFAULT_SAND_CLIENT_VERSION, "0.72.1");
  let reads = 0;
  assert.equal(cursorClientVersion({
    env: { SAND_CLIENT_VERSION: "nope" },
    platform: "darwin",
    readFile: () => {
      reads += 1;
      return PLIST;
    },
  }), "0.72.1");
  assert.equal(reads, 0);
  assert.equal(cursorClientVersion({
    env: {},
    platform: "darwin",
    home: "/Users/fixture",
    readFile: () => "<key>CFBundleShortVersionString</key><string>beta</string>",
  }), "0.72.1");
  const linuxReads = [];
  assert.equal(cursorClientVersion({
    env: {},
    platform: "linux",
    home: "/home/fixture",
    readFile: (file) => {
      linuxReads.push(file);
      throw enoent();
    },
  }), "0.72.1");
  // Linux has no plist or registry: only the app's desktop-status.json.
  assert.deepEqual(linuxReads, [join("/home/fixture", ".config", "Grok Bot", "desktop-status.json")]);
  assert.equal(withEnv({ SAND_CLIENT_VERSION: "nope" }, () => ensureSandboxHeaders("t")["x-cursor-client-version"]), "0.72.1");
});

test("EnsureSandBox 401 no longer supported names the version gbot sent", async () => {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const header = req.headers["x-cursor-client-version"];
      assert.equal(header, "0.20.0");
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        code: "unauthenticated",
        message: "This version of Grok Bot is no longer supported. Update Grok Bot from cursor.com/sand to continue.",
      }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const home = mkdtempSync(join(tmpdir(), "gbot-client-version-"));
  try {
    await withEnv({
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(home, ".config"),
      CURSOR_ACCESS_TOKEN: "cursor-access-token",
      CURSOR_API_BASE_URL: `http://127.0.0.1:${port}`,
      GROK_BOT_GATEWAY_URL: null,
      GROK_BOT_GATEWAY_TOKEN: null,
      SAND_CLIENT_VERSION: "0.20.0",
      GBOT_ACCOUNT: null,
      GROK_BOT_TEST: "1",
    }, async () => {
      await assert.rejects(connectGateway(), (error) => {
        assert.equal(error.name, "GatewayError");
        assert.equal(error.status, 401);
        assert.match(error.message, /0\.20\.0/);
        assert.match(error.message, /SAND_CLIENT_VERSION/);
        assert.match(error.message, /no longer supported/);
        assert.doesNotMatch(error.message, /cursor-access-token/);
        return true;
      });
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function stubInstalledApp(readFile, now = () => 5_000_000, { handlesDesktopStatus = false } = {}) {
  const saved = {
    now: clientVersionRuntime.now,
    platform: clientVersionRuntime.platform,
    home: clientVersionRuntime.home,
    readFile: clientVersionRuntime.readFile,
    execFile: clientVersionRuntime.execFile,
  };
  resetClientVersionCache();
  clientVersionRuntime.now = now;
  clientVersionRuntime.platform = () => "darwin";
  clientVersionRuntime.home = () => "/Users/fixture";
  clientVersionRuntime.readFile = (file, encoding) => {
    if (isDesktopStatus(file) && !handlesDesktopStatus) throw enoent();
    return readFile(file, encoding);
  };
  clientVersionRuntime.execFile = () => {
    throw new Error("registry is not consulted for this fixture");
  };
  return () => {
    Object.assign(clientVersionRuntime, saved);
    resetClientVersionCache();
  };
}

async function rejectedVersionServer() {
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "This version of Grok Bot is no longer supported." }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

function versionEnv(home, port, extra = {}) {
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData/Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    CURSOR_ACCESS_TOKEN: "cursor-access-token",
    CURSOR_API_BASE_URL: `http://127.0.0.1:${port}`,
    GROK_BOT_GATEWAY_URL: null,
    GROK_BOT_GATEWAY_TOKEN: null,
    SAND_CLIENT_VERSION: null,
    GBOT_ACCOUNT: null,
    GROK_BOT_TEST: "1",
    ...extra,
  };
}

test("a 401 re-reads an installed app version at most once per 10 minutes", async () => {
  let reads = 0;
  let now = 5_000_000;
  const restore = stubInstalledApp(() => {
    reads += 1;
    return PLIST;
  }, () => now);
  const server = await rejectedVersionServer();
  const home = mkdtempSync(join(tmpdir(), "gbot-client-reread-"));
  const env = versionEnv(home, server.address().port);
  try {
    await withEnv({ SAND_CLIENT_VERSION: null }, async () => {
      assert.equal(cursorClientVersion(), "0.70.2");
      assert.equal(reads, 1);
      await withEnv(env, () => assert.rejects(connectGateway()));
      assert.equal(cursorClientVersion(), "0.70.2");
      assert.equal(reads, 2);
      await withEnv(env, () => assert.rejects(connectGateway()));
      assert.equal(cursorClientVersion(), "0.70.2");
      assert.equal(reads, 2);
      now += 10 * 60 * 1000;
      await withEnv(env, () => assert.rejects(connectGateway()));
      assert.equal(cursorClientVersion(), "0.70.2");
      assert.equal(reads, 3);
    });
  } finally {
    restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a 401 does not drop a cached app version when the rejected version came from the environment", async () => {
  let reads = 0;
  const restore = stubInstalledApp(() => {
    reads += 1;
    return PLIST;
  });
  const server = await rejectedVersionServer();
  const home = mkdtempSync(join(tmpdir(), "gbot-client-env-"));
  try {
    await withEnv({ SAND_CLIENT_VERSION: null }, async () => {
      assert.equal(cursorClientVersion(), "0.70.2");
      assert.equal(reads, 1);
      await withEnv(versionEnv(home, server.address().port, { SAND_CLIENT_VERSION: "0.20.0" }), () => assert.rejects(connectGateway()));
      assert.equal(reads, 1);
      assert.equal(cursorClientVersion(), "0.70.2");
      assert.equal(reads, 1);
    });
  } finally {
    restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a 401 does not re-read when the cached version is the built-in default", async () => {
  let reads = 0;
  const restore = stubInstalledApp(() => {
    reads += 1;
    return "<plist></plist>";
  });
  const server = await rejectedVersionServer();
  const home = mkdtempSync(join(tmpdir(), "gbot-client-default-"));
  try {
    await withEnv({ SAND_CLIENT_VERSION: null }, async () => {
      assert.equal(cursorClientVersion(), "0.72.1");
      assert.equal(reads, 2);
      await withEnv(versionEnv(home, server.address().port), () => assert.rejects(connectGateway()));
      assert.equal(cursorClientVersion(), "0.72.1");
      assert.equal(reads, 2);
    });
  } finally {
    restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

// desktop-status.json as the running app wrote it on macOS, 2026-11-08.
const DESKTOP_STATUS = JSON.stringify({ version: 1, pid: 45359, appVersion: "0.77.0", startedAtMs: 1793071044901, signedIn: true });

for (const [platform, home, env, statusPath] of [
  ["darwin", "/Users/fixture", {}, join("/Users/fixture", "Library/Application Support/Grok Bot", "desktop-status.json")],
  ["linux", "/home/fixture", {}, join("/home/fixture", ".config", "Grok Bot", "desktop-status.json")],
  ["linux", "/home/fixture", { XDG_CONFIG_HOME: "/xdg" }, join("/xdg", "Grok Bot", "desktop-status.json")],
  ["win32", "C:\\Users\\fixture", { APPDATA: "D:\\Roaming" }, join("D:\\Roaming", "Grok Bot", "desktop-status.json")],
]) {
  test(`${platform}${env.XDG_CONFIG_HOME ? " (XDG_CONFIG_HOME)" : ""}: the app's desktop-status.json comes before the plist and the registry`, () => {
    const reads = [];
    let registry = 0;
    const version = cursorClientVersion({
      env,
      platform,
      home,
      readFile: (file) => {
        reads.push(file);
        if (file === statusPath) return DESKTOP_STATUS;
        throw enoent();
      },
      execFile: () => {
        registry += 1;
        throw new Error("the registry is not consulted when desktop-status.json has the version");
      },
    });
    assert.equal(version, "0.77.0");
    assert.deepEqual(reads, [statusPath]);
    assert.equal(registry, 0);
  });
}

test("an unusable desktop-status.json falls through to the plist, the registry, or the default", () => {
  const statusPath = join("/Users/fixture", "Library/Application Support/Grok Bot", "desktop-status.json");
  for (const status of [
    "not json",
    "null",
    "[]",
    JSON.stringify({ version: 1 }),
    JSON.stringify({ appVersion: 77 }),
    JSON.stringify({ appVersion: "0.78.0-beta.1" }),
    JSON.stringify({ appVersion: "" }),
  ]) {
    const reads = [];
    const version = cursorClientVersion({
      env: {},
      platform: "darwin",
      home: "/Users/fixture",
      readFile: (file) => {
        reads.push(file);
        return file === statusPath ? status : PLIST;
      },
    });
    assert.equal(version, "0.70.2", status);
    assert.deepEqual(reads, [statusPath, "/Applications/Grok Bot.app/Contents/Info.plist"], status);
  }
  const win = cursorClientVersion({
    env: { APPDATA: "D:\\Roaming" },
    platform: "win32",
    readFile: () => "{",
    execFile: () => LIVE_REG,
  });
  assert.equal(win, "0.72.1");
  assert.equal(cursorClientVersion({
    env: {},
    platform: "linux",
    home: "/home/fixture",
    readFile: () => JSON.stringify({ appVersion: "latest" }),
  }), DEFAULT_SAND_CLIENT_VERSION);
  // A fourth numeric part is dropped, as for every other source.
  assert.equal(cursorClientVersion({
    env: {},
    platform: "linux",
    home: "/home/fixture",
    readFile: () => JSON.stringify({ appVersion: "0.77.0.12" }),
  }), "0.77.0");
});

test("a version from desktop-status.json is an installed-app value: cached, and dropped on a 401", () => {
  let reads = 0;
  const restore = stubInstalledApp((file) => {
    if (isDesktopStatus(file)) {
      reads += 1;
      return DESKTOP_STATUS;
    }
    throw new Error("the plist is not read when desktop-status.json has the version");
  }, () => 5_000_000, { handlesDesktopStatus: true });
  try {
    withEnv({ SAND_CLIENT_VERSION: null }, () => {
      assert.equal(cursorClientVersion(), "0.77.0");
      assert.equal(cursorClientVersion(), "0.77.0");
      assert.equal(reads, 1);
      assert.equal(forgetCachedAppVersion(), true);
      assert.equal(cursorClientVersion(), "0.77.0");
      assert.equal(reads, 2);
    });
  } finally {
    restore();
  }
});
