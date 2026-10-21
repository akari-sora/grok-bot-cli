import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cursorClientVersion, DEFAULT_SAND_CLIENT_VERSION } from "../src/core/client-version.js";
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
      if (path === "/Applications/Grok Bot.app/Contents/Info.plist") {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      return PLIST;
    },
  });
  assert.equal(version, "0.70.2");
  assert.deepEqual(seen, [
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
    execFile: (cmd, args, options) => {
      calls.push({ cmd, args, timeout: options.timeout, maxBuffer: options.maxBuffer });
      return LIVE_REG;
    },
  });
  assert.equal(version, "0.72.1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, join("D:\\Windows", "System32", "reg.exe"));
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

test("Windows registry falls back to a narrow Grok Bot search within one 3s budget", () => {
  let clock = 5_000;
  const calls = [];
  const fallback = [
    "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\custom",
    "    DisplayName    REG_SZ    Grok Bot 0.72.1",
    "    DisplayVersion    REG_SZ    1.2.3",
    "    Publisher    REG_SZ    SpaceXAI",
    "",
  ].join("\r\n");
  const version = cursorClientVersion({
    env: {},
    platform: "win32",
    now: () => clock,
    execFile: (cmd, args, options) => {
      calls.push({ cmd, args, timeout: options.timeout });
      clock += 100;
      if (args.includes("/f")) return fallback;
      throw new Error("missing key");
    },
  });
  assert.equal(version, "1.2.3");
  assert.equal(calls[0].cmd, join("C:\\Windows", "System32", "reg.exe"));
  const searched = calls.find((call) => call.args.includes("/f"));
  assert.ok(searched);
  assert.deepEqual(searched.args, [
    "query",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "/s",
    "/f",
    "Grok Bot",
    "/d",
  ]);
  assert.ok(calls.every((call) => call.timeout <= 3000 && call.timeout > 0));
});

test("Windows registry queries share one 3s budget", () => {
  let clock = 0;
  const timeouts = [];
  cursorClientVersion({
    env: {},
    platform: "win32",
    now: () => clock,
    execFile: (_cmd, _args, options) => {
      timeouts.push(options.timeout);
      clock += 2500;
      throw new Error("slow miss");
    },
  });
  assert.deepEqual(timeouts, [3000, 500]);
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
  assert.equal(cursorClientVersion({
    env: {},
    platform: "linux",
    readFile: () => {
      throw new Error("plist is not consulted on linux");
    },
  }), "0.72.1");
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
