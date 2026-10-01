import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openBackend } from "../src/core/commands.js";

const CLEARED = [
  "CURSOR_ACCESS_TOKEN",
  "GROK_BOT_GATEWAY_URL",
  "GROK_BOT_GATEWAY_TOKEN",
  "GROK_BOT_AGENTS_DIR",
  "XDG_CONFIG_HOME",
];

async function withEmptyHome(fn) {
  const saved = { ...process.env };
  const home = mkdtempSync(join(tmpdir(), "gbot-first-run-"));
  try {
    for (const name of CLEARED) delete process.env[name];
    Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming") });
    await fn(home);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

test("a first run without a Grok Bot login says to sign in, on every OS", async () => {
  await withEmptyHome(async (home) => {
    await assert.rejects(openBackend({}), (err) => {
      assert.match(err.message, /No Grok Bot login found/);
      assert.match(err.message, /gbot accounts/);
      assert.doesNotMatch(err.message, /Library|agents directory/);
      assert.equal(err.message.includes(home), false);
      return true;
    });
  });
});

test("an explicit --files run keeps the agents-directory error", async () => {
  await withEmptyHome(async () => {
    await assert.rejects(openBackend({ files: true }), /Could not find a Grok Bot agents directory/);
  });
});
