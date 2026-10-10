// Synthetic Grok Bot descriptors for `gbot wear pair` tests. Every secret is fake and only ever encrypted with a
// fixture password that the tests inject; nothing here reads a real descriptor or the OS secret store.
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { grokBotGatewayDescriptorPath } from "../../src/core/app-session.js";
import { codeCheckSymbol } from "../../src/core/wear-pair.js";

export const SECRETS = Object.freeze({
  password: "fake-keychain-password-wp-19d4",
  token: "fake-gateway-token-wp-7f3a91",
  route: "fake-routing-secret-wp-52c8",
  host: "fake-wp-pod.us12.cursorvm.com",
});

/** Chromium OSCrypt as the Grok Bot app writes it: macOS v10 (1003 rounds), Linux v11 (1 round). */
export function encryptEntry(value, password = SECRETS.password, platform = "darwin") {
  const linux = platform === "linux";
  const key = crypto.pbkdf2Sync(password, "saltysalt", linux ? 1 : 1003, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([
    Buffer.from(linux ? "v11" : "v10"),
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]).toString("base64");
}

export function descriptor(overrides = {}) {
  return {
    baseUrl: `https://${SECRETS.host}/`,
    token: SECRETS.token,
    headers: { "X-Anyrun-Network-Token": SECRETS.route },
    email: "fake-wear@example.com",
    ...overrides,
  };
}

/** Writes a version 3 descriptor with `entries` ({ id: plaintext descriptor }) under `home`. */
export function writeDescriptor(home, entries, { platform = "darwin", password = SECRETS.password } = {}) {
  const path = grokBotGatewayDescriptorPath(home, platform, {});
  mkdirSync(dirname(path), { recursive: true });
  let savedAtMs = 0;
  const wrapped = { version: 3, entries: {} };
  for (const [id, value] of Object.entries(entries)) {
    savedAtMs += 1;
    wrapped.entries[id] = { encrypted: encryptEntry(value, password, platform), savedAtMs };
  }
  writeFileSync(path, JSON.stringify(wrapped));
  return path;
}

export const ENTRY_A = "8b7f0d1600000000000000000000000000000000000000000000000000000a01";
export const ENTRY_B = "9c8e1f2700000000000000000000000000000000000000000000000000000b02";

/** A random, valid pairing code: `{ data, normalized, display }`. */
export function randomCode() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let data = "";
  for (const byte of crypto.randomBytes(12)) data += alphabet[byte % 32];
  const check = codeCheckSymbol(data);
  return { data, normalized: data + check, display: `${data.slice(0, 4)}-${data.slice(4, 8)}-${data.slice(8, 12)}-${check}` };
}

/** The same code with a wrong check symbol. */
export function typoOf(code) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const check = code.normalized[12];
  const wrong = alphabet[(alphabet.indexOf(check) + 1) % 32];
  return code.data + wrong;
}

/** A clean environment for a spawned gbot: temporary HOME, test mode, no inherited credentials or selection. */
export function cliEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) {
    if (/^(GROK_BOT_|CURSOR_|SAND_|GBOT_)/.test(key) || key === "XDG_CONFIG_HOME" || key === "NODE_ENV") delete env[key];
  }
  delete env.NODE_TEST_CONTEXT;
  return { ...env, GROK_BOT_TEST: "1", GBOT_TEST_KEYCHAIN_PASSWORD: SECRETS.password, ...extra };
}
