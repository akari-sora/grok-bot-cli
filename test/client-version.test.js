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

test("a Windows DisplayVersion 0.72.1.0 becomes 0.72.1", () => {
  const output = [
    "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{gbot}",
    "    DisplayName    REG_SZ    Grok Bot",
    "    DisplayVersion    REG_SZ    0.72.1.0",
    "",
  ].join("\r\n");
  const version = cursorClientVersion({
    env: {},
    platform: "win32",
    execFile: (cmd, args, options) => {
      assert.equal(cmd, "reg");
      assert.ok(args.includes("/s"));
      assert.equal(options.timeout > 0, true);
      return output;
    },
  });
  assert.equal(version, "0.72.1");
  assert.equal(withEnv({ SAND_CLIENT_VERSION: "0.72.1.0" }, () => ensureSandboxHeaders("t")["x-cursor-client-version"]), "0.72.1");
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
