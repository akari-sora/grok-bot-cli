import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { grokBotGatewayDescriptorPath } from "../src/core/app-session.js";

const CLI = fileURLToPath(new URL("../dist/bin/gbot.mjs", import.meta.url));

function encryptDarwinDescriptor(value) {
  const key = crypto.pbkdf2Sync("demo-password", "saltysalt", 1003, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]).toString("base64");
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "gbot-accounts-"));
  const descriptorPath = grokBotGatewayDescriptorPath(home, "darwin", {});
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, JSON.stringify({
    version: 2,
    entries: {
      abcdef0123456789aa: {
        encrypted: encryptDarwinDescriptor({
          baseUrl: "https://box.example",
          token: "gateway-token",
          headers: {},
        }),
        savedAtMs: 1,
      },
      abcdef9999999999bb: {
        encrypted: encryptDarwinDescriptor({
          baseUrl: "https://other.example",
          token: "other-token",
          headers: {},
          email: "second@example.com",
        }),
        savedAtMs: 2,
      },
    },
  }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, GROK_BOT_TEST: "1" };
  delete env.GBOT_ACCOUNT;
  for (const key of Object.keys(env)) {
    if (/^(GROK_BOT_|CURSOR_|SAND_)/.test(key) && key !== "GROK_BOT_TEST") delete env[key];
  }
  return { env };
}

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
}

test("gbot accounts lists labels and doctor requires a choice", {
  skip: process.platform !== "darwin" && "fixture descriptors are macOS-shaped",
}, () => {
  const { env } = fixture();
  const listed = run(["accounts", "--json"], env);
  assert.equal(listed.status, 0, listed.stderr);
  const payload = JSON.parse(listed.stdout);
  assert.deepEqual(payload.accounts.map((row) => ({ label: row.label, lastSaved: row.lastSaved })), [
    { label: "abcdef0123456789aa", lastSaved: false },
    { label: "abcdef9999999999bb", lastSaved: true },
  ]);
  assert.doesNotMatch(listed.stdout + listed.stderr, /gateway-token|other-token|box\.example|second@example\.com/);

  const ambiguous = run(["doctor", "--json"], env);
  assert.equal(ambiguous.status, 0, ambiguous.stderr);
  const doctor = JSON.parse(ambiguous.stdout);
  assert.equal(doctor.grokBotAppSession.usable, false);
  assert.match(doctor.grokBotAppSession.error, /--account <label>/);
  assert.doesNotMatch(ambiguous.stdout, /gateway-token|other-token/);

  const chosen = run(["doctor", "--account", "abcdef9999999999bb", "--json"], env);
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.doesNotMatch(chosen.stderr, /Unknown option/);
  const chosenDoctor = JSON.parse(chosen.stdout);
  assert.equal(chosenDoctor.grokBotAppSession.usable, false);
  assert.notEqual(chosenDoctor.grokBotAppSession.code, "AMBIGUOUS_ENTRIES");
  assert.doesNotMatch(chosen.stdout + chosen.stderr, /other-token|gateway-token/);
});

function fixtureV3() {
  const home = mkdtempSync(join(tmpdir(), "gbot-accounts-v3-"));
  const descriptorPath = grokBotGatewayDescriptorPath(home, "darwin", {});
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, JSON.stringify({
    version: 3,
    entries: {
      "8b7f0d1600000000000000000000000000000000000000000000000000000001": {
        encrypted: encryptDarwinDescriptor({
          baseUrl: "https://box.example",
          token: "gateway-token",
          headers: {},
        }),
        savedAtMs: 1,
      },
      "9c8e1f2700000000000000000000000000000000000000000000000000000002": {
        encrypted: encryptDarwinDescriptor({
          baseUrl: "https://other.example",
          token: "other-token",
          headers: {},
        }),
        savedAtMs: 2,
      },
    },
  }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, GROK_BOT_TEST: "1" };
  delete env.GBOT_ACCOUNT;
  for (const key of Object.keys(env)) {
    if (/^(GROK_BOT_|CURSOR_|SAND_)/.test(key) && key !== "GROK_BOT_TEST") delete env[key];
  }
  return { env };
}

test("gbot accounts handles version 3 descriptor and selects by id prefix", {
  skip: process.platform !== "darwin" && "fixture descriptors are macOS-shaped",
}, () => {
  const { env } = fixtureV3();
  const listed = run(["accounts", "--json"], env);
  assert.equal(listed.status, 0, listed.stderr);
  const payload = JSON.parse(listed.stdout);
  assert.deepEqual(payload.accounts.map((row) => ({ label: row.label, lastSaved: row.lastSaved })), [
    { label: "8b7f0d1600000000000000000000000000000000000000000000000000000001", lastSaved: false },
    { label: "9c8e1f2700000000000000000000000000000000000000000000000000000002", lastSaved: true },
  ]);
  assert.doesNotMatch(listed.stdout + listed.stderr, /gateway-token|other-token|box\.example/);

  const ambiguous = run(["doctor", "--json"], env);
  assert.equal(ambiguous.status, 0, ambiguous.stderr);
  const doctor = JSON.parse(ambiguous.stdout);
  assert.equal(doctor.grokBotAppSession.usable, false);
  assert.match(doctor.grokBotAppSession.error, /--account <label>/);
  assert.doesNotMatch(ambiguous.stdout, /gateway-token|other-token/);

  const chosen = run(["doctor", "--account", "8b7f0d16", "--json"], env);
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.doesNotMatch(chosen.stderr, /Unknown option/);
  const chosenDoctor = JSON.parse(chosen.stdout);
  assert.equal(chosenDoctor.grokBotAppSession.usable, false);
  assert.notEqual(chosenDoctor.grokBotAppSession.code, "AMBIGUOUS_ENTRIES");
  assert.doesNotMatch(chosen.stdout + chosen.stderr, /other-token|gateway-token/);
});
