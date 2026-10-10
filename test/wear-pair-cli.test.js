import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { closedPort, startFakeWatch } from "./helpers/fake-watch.js";
import { ENTRY_A, ENTRY_B, SECRETS, cliEnv, descriptor, randomCode, typoOf, writeDescriptor } from "./helpers/wear-pair-fixture.js";

// End to end through the real wrapper (bin/gbot.mjs -> dist/bin/gbot.mjs). Run `npm run build` first.
const WRAPPER = fileURLToPath(new URL("../bin/gbot.mjs", import.meta.url));
const skip = process.platform === "win32" ? "fixture descriptors are macOS/Linux-shaped" : false;
const platform = process.platform === "linux" ? "linux" : "darwin";

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRAPPER, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function setup(t, entries = { [ENTRY_A]: descriptor() }) {
  const home = mkdtempSync(join(tmpdir(), "gbot-wear-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeDescriptor(home, entries, { platform });
  return home;
}

function assertNoSecrets(result, code) {
  const output = result.stdout + result.stderr;
  for (const secret of [SECRETS.token, SECRETS.route, SECRETS.password, SECRETS.host, code.data, code.normalized, code.display, "x-anyrun-network-token"]) {
    assert.equal(output.toLowerCase().includes(secret.toLowerCase()), false, `output leaks ${secret.slice(0, 12)}…`);
  }
}

const expectedPayload = (label = "fake-wear@example.com") => JSON.stringify({
  gatewayUrl: `https://${SECRETS.host}`,
  gatewayToken: SECRETS.token,
  headers: { "x-anyrun-network-token": SECRETS.route },
  label,
});

async function pairing(t, behavior = {}) {
  const code = randomCode();
  const fake = await startFakeWatch({ codeData: code.data, behavior });
  t.after(() => fake.close());
  return { code, fake, target: `127.0.0.1:${fake.port}` };
}

test("wear pair --json pairs through the wrapper and prints only the receipt", { skip }, async (t) => {
  const home = setup(t);
  const { code, fake, target } = await pairing(t);
  // GBOT_ACCOUNT is ignored (the only saved login is used), and so are the gateway overrides and the access token:
  // only the desktop app's saved session is ever sent, and nothing mints a new one.
  const result = await run(["wear", "pair", target, "--code", code.display, "--json"], cliEnv(home, {
    GBOT_ACCOUNT: "fake-nobody",
    GROK_BOT_GATEWAY_URL: "https://fake-override.cursor.sh",
    GROK_BOT_GATEWAY_TOKEN: "fake-override-token",
    GROK_BOT_GATEWAY_HEADERS: JSON.stringify({ "x-anyrun-network-token": "fake-override-route" }),
    CURSOR_ACCESS_TOKEN: "fake-access-token",
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    account: "fake-wear@example.com",
    exitCode: 0,
    id: ENTRY_A,
    outcome: "paired",
    target,
  });
  assert.match(result.stderr, new RegExp(`fake-wear@example\\.com to the watch at ${target.replaceAll(".", "\\.")}`));
  const seen = await fake.result;
  assert.equal(seen.payload, expectedPayload());
  assertNoSecrets(result, code);
});

test("wear pair --json leading and --ndjson / text modes leak nothing", { skip }, async (t) => {
  const home = setup(t);
  for (const mode of [["--json", "lead"], ["--ndjson"], []]) {
    const { code, fake, target } = await pairing(t);
    const args = mode[1] === "lead" ? ["--json", "wear", "pair", target, "--code", code.normalized] : ["wear", "pair", target, "--code", code.normalized, ...mode];
    const result = await run(args, cliEnv(home));
    assert.equal(result.status, 0, `${mode.join(" ")}: ${result.stderr}`);
    if (mode[0] === "--ndjson") {
      const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(JSON.stringify(lines).includes('"outcome":"paired"'), result.stdout);
    } else if (mode[0] === "--json") {
      assert.equal(JSON.parse(result.stdout).outcome, "paired");
    } else {
      assert.match(result.stdout, /Paired fake-wear@example\.com with the watch at 127\.0\.0\.1:\d+\./);
    }
    assert.equal((await fake.result).outcome, "paired");
    assertNoSecrets(result, code);
  }
});

test("wear pair failures map to fixed messages and exit codes without leaking", { skip }, async (t) => {
  const home = setup(t);
  const cases = [
    { name: "typo", setup: async () => { const p = await pairing(t); return { ...p, typed: typoOf(p.code) }; }, status: 2, category: "typo", connections: 0 },
    { name: "not a code", setup: async () => { const p = await pairing(t); return { ...p, typed: "fake" }; }, status: 2, category: "invalid-code", connections: 0 },
    { name: "wrong code", setup: async () => { const p = await pairing(t); return { ...p, typed: randomCode().display }; }, status: 4, category: "auth", connections: 1, error: /Wrong code, or this is not your watch/ },
    { name: "tampered M2", setup: () => pairing(t, { tamperM2: "tag" }), status: 4, category: "auth", connections: 1 },
    { name: "rejected", setup: () => pairing(t, { status: 1 }), status: 5, outcome: "rejected" },
    { name: "storage failed", setup: () => pairing(t, { status: 2 }), status: 5, outcome: "storage-failed" },
    { name: "no receipt", setup: () => pairing(t, { omitM4: true }), status: 6, outcome: "unknown" },
    {
      name: "unreachable",
      setup: async () => { const code = randomCode(); return { code, fake: null, target: `127.0.0.1:${await closedPort()}` }; },
      status: 3,
      category: "unreachable",
      error: /same Wi-Fi network.*isolate clients.*Local Network/s,
    },
  ];
  for (const c of cases) {
    const { code, fake, target, typed } = await c.setup();
    const result = await run(["wear", "pair", target, "--code", typed ?? code.normalized, "--json"], cliEnv(home));
    assert.equal(result.status, c.status, `${c.name}: ${result.stdout} ${result.stderr}`);
    const value = JSON.parse(result.stdout);
    if (c.outcome) {
      assert.deepEqual(value, { account: "fake-wear@example.com", exitCode: c.status, id: ENTRY_A, outcome: c.outcome, target }, c.name);
    } else {
      assert.equal(value.category, c.category, c.name);
      assert.equal(value.exitCode, c.status, c.name);
      assert.deepEqual(Object.keys(value).sort(), ["category", "error", "exitCode"], c.name);
      if (c.error) assert.match(value.error, c.error, c.name);
    }
    if (fake && c.connections !== undefined) assert.equal(fake.connections(), c.connections, c.name);
    if (c.connections === 0) assert.doesNotMatch(result.stderr, /Sending Grok Bot login/, `${c.name}: nothing announced`);
    assertNoSecrets(result, code);
  }
});

test("wear pair with several logins requires --account and lists labels only", { skip }, async (t) => {
  const home = setup(t, {
    [ENTRY_A]: descriptor(),
    [ENTRY_B]: descriptor({ email: "fake-second@example.com", token: SECRETS.token + "-b" }),
  });
  const { code, fake, target } = await pairing(t);
  const ambiguous = await run(["wear", "pair", target, "--code", code.normalized, "--json"], cliEnv(home, { GBOT_ACCOUNT: "fake-second@example.com" }));
  assert.equal(ambiguous.status, 2, ambiguous.stderr);
  const value = JSON.parse(ambiguous.stdout);
  assert.equal(value.category, "usage");
  assert.match(value.error, /--account <label>/);
  assert.match(value.error, /fake-wear@example\.com\n {2}fake-second@example\.com \(last saved\)/);
  assert.doesNotMatch(value.error, /GBOT_ACCOUNT/);
  assert.equal(fake.connections(), 0);
  assertNoSecrets(ambiguous, code);

  const chosen = await run(["wear", "pair", target, "--account", "fake-second@example.com", "--code", code.normalized, "--json"], cliEnv(home));
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.equal(JSON.parse(chosen.stdout).id, ENTRY_B);
  assert.equal((await fake.result).payload, expectedPayload("fake-second@example.com").replace(SECRETS.token, SECRETS.token + "-b"));
  assert.doesNotMatch(chosen.stdout + chosen.stderr, new RegExp(SECRETS.token));
});

test("wear pair refuses bad input before Keychain or network access", { skip }, async (t) => {
  const home = setup(t);
  const code = randomCode();
  const port = await closedPort();
  const cases = [
    { args: ["wear", "pair", "8.8.8.8:40000", "--code", code.normalized, "--json"], env: {}, error: /private IPv4 address/ },
    { args: ["wear", "pair", "watch.local:40000", "--code", code.normalized, "--json"], env: {}, error: /<ip>:<port>/ },
    // --code is refused outside GROK_BOT_TEST=1, without echoing it (NODE_ENV=test keeps loopback allowed).
    { args: ["wear", "pair", `127.0.0.1:${port}`, "--code", code.normalized, "--json"], env: { GROK_BOT_TEST: "", NODE_ENV: "test" }, error: /--code is accepted only in tests/ },
    // Not a terminal and no --code: nothing to read the code from.
    { args: ["wear", "pair", `127.0.0.1:${port}`, "--json"], env: {}, error: /Run this in a terminal/ },
  ];
  for (const c of cases) {
    const result = await run(c.args, cliEnv(home, c.env));
    assert.equal(result.status, 2, `${c.args.join(" ")}: ${result.stdout} ${result.stderr}`);
    const value = JSON.parse(result.stdout);
    assert.equal(value.category, "usage");
    assert.match(value.error, c.error);
    assert.doesNotMatch(result.stderr, /Sending Grok Bot login/);
    assertNoSecrets(result, code);
  }
});

test("wear pair stops on a session the watch would reject (pre-flight), before connecting", { skip }, async (t) => {
  const home = setup(t, { [ENTRY_A]: descriptor({ baseUrl: "https://fake-evil.example" }) });
  const { code, fake, target } = await pairing(t);
  const result = await run(["wear", "pair", target, "--code", code.normalized, "--json"], cliEnv(home));
  assert.equal(result.status, 1, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.category, "preflight");
  assert.match(value.error, /gateway URL is not one the watch accepts.*still valid/s);
  assert.doesNotMatch(result.stdout + result.stderr, /fake-evil/);
  assert.equal(fake.connections(), 0);
  assertNoSecrets(result, code);
});

test("wear pair never reads the OS secret store in test mode", { skip }, async (t) => {
  const home = setup(t);
  const { code, fake, target } = await pairing(t);
  const env = cliEnv(home);
  delete env.GBOT_TEST_KEYCHAIN_PASSWORD;
  const result = await run(["wear", "pair", target, "--code", code.normalized, "--json"], env);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).category, "account");
  assert.equal(fake.connections(), 0);
  assertNoSecrets(result, code);
});

test("wear pair --help does not prompt and documents the command", { skip }, async (t) => {
  const home = setup(t);
  const result = await run(["wear", "pair", "--help"], cliEnv(home));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wear pair/);
  assert.match(result.stdout, /--account/);
  assert.doesNotMatch(result.stderr, /Pairing code/);
});
