import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startFakeWatch } from "./helpers/fake-watch.js";
import { ENTRY_A, SECRETS, cliEnv, descriptor, randomCode, writeDescriptor } from "./helpers/wear-pair-fixture.js";

// The wrapper (bin/gbot.mjs) around the worker: --code refusal, signals after spawn, and `unknown` after M3.
// Run `npm run build` first.
const WRAPPER = fileURLToPath(new URL("../bin/gbot.mjs", import.meta.url));
const SENTINEL = pathToFileURL(fileURLToPath(new URL("./helpers/child-sentinel.mjs", import.meta.url))).href;
const skip = process.platform === "win32" ? "POSIX signals and macOS/Linux-shaped fixtures" : false;
const platform = process.platform === "linux" ? "linux" : "darwin";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "gbot-wear-signals-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const scratch = join(root, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  writeDescriptor(home, { [ENTRY_A]: descriptor() }, { platform });
  const sentinel = join(root, "sentinel");
  const env = (extra = {}) => cliEnv(home, {
    TMPDIR: scratch,
    NODE_OPTIONS: `--import="${SENTINEL}"`,
    WEAR_SENTINEL_FILE: sentinel,
    ...extra,
  });
  return { env, scratch, sentinel, pairDirs: () => readdirSync(scratch).filter((name) => name.startsWith("gbot-pair-")) };
}

function start(args, env) {
  const child = spawn(process.execPath, [WRAPPER, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr })));
  return { child, done };
}

function assertNoSecrets(result, code) {
  const output = (result.stdout + result.stderr).toLowerCase();
  for (const secret of [SECRETS.token, SECRETS.route, SECRETS.password, SECRETS.host, code.data, code.normalized, code.display]) {
    assert.equal(output.includes(secret.toLowerCase()), false, `output leaks ${secret.slice(0, 12)}…`);
  }
}

test("a production --code is refused by the wrapper before any worker starts", { skip }, async (t) => {
  const f = setup(t);
  const code = randomCode();
  for (const [args, extra] of [
    [["wear", "pair", "192.168.1.20:40123", "--code", code.display, "--json"], { GROK_BOT_TEST: "" }],
    [["wear", "pair", "192.168.1.20:40123", `--code=${code.normalized}`], { GROK_BOT_TEST: "", NODE_ENV: "test" }],
    [["--json", "wear", "pair", "127.0.0.1:40123", "--code", code.normalized], { GROK_BOT_TEST: "true" }],
  ]) {
    const result = await start(args, f.env(extra)).done;
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /--code is accepted only in tests \(GROK_BOT_TEST=1\)/);
    if (args.includes("--json")) assert.equal(JSON.parse(result.stdout).category, "usage");
    assert.equal(existsSync(f.sentinel), false, "the worker never started");
    assert.deepEqual(f.pairDirs(), []);
    assertNoSecrets(result, code);
  }
  // Control: in test mode the worker does start (so the sentinel would have caught a leak above).
  const allowed = await start(["wear", "pair", "192.168.1.20:40123", "--code", "fake", "--json"], f.env()).done;
  assert.equal(allowed.status, 2, allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).category, "invalid-code");
  assert.match(readFileSync(f.sentinel, "utf8"), /worker started/);
});

async function interrupted(t, { signal, afterM3, json = true }) {
  const f = setup(t);
  const code = randomCode();
  let run;
  let resolveSent;
  const signalled = new Promise((resolve) => { resolveSent = resolve; });
  const hold = () => new Promise((resolve) => setTimeout(resolve, 5_000));
  const fire = async () => {
    run.child.kill(signal);
    resolveSent();
    await hold();
  };
  const fake = await startFakeWatch({
    codeData: code.data,
    behavior: afterM3 ? { beforeM4: fire } : { beforeM2: fire, silent: true },
  });
  t.after(() => fake.close());
  run = start(["wear", "pair", `127.0.0.1:${fake.port}`, "--code", code.normalized, ...(json ? ["--json"] : [])], f.env());
  await signalled;
  const result = await run.done;
  assertNoSecrets(result, code);
  assert.deepEqual(f.pairDirs(), [], "the wrapper removed its pairing directory");
  return { result, fake, port: fake.port };
}

for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`${signal} after spawn, before the session is sent: cancelled (${status})`, { skip, timeout: 30_000 }, async (t) => {
    const { result } = await interrupted(t, { signal, afterM3: false });
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, "", "no receipt");
  });
}

test("SIGHUP after spawn, before the session is sent: the wrapper ends by SIGHUP and cleans up", { skip, timeout: 30_000 }, async (t) => {
  const { result } = await interrupted(t, { signal: "SIGHUP", afterM3: false });
  assert.ok(result.signal === "SIGHUP" || result.status === 129, `ended with ${result.signal ?? result.status}`);
  assert.equal(result.stdout, "");
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`${signal} after the session was sent: unknown (exit 6), never cancelled`, { skip, timeout: 30_000 }, async (t) => {
    const { result, port, fake } = await interrupted(t, { signal, afterM3: true });
    assert.equal(result.status, 6, `${result.signal ?? ""} ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), {
      account: "fake-wear@example.com",
      exitCode: 6,
      id: ENTRY_A,
      outcome: "unknown",
      target: `127.0.0.1:${port}`,
    });
    assert.equal((await fake.result).outcome, "paired", "the watch did store it");
  });
}

test("Ctrl-C after the session was sent prints the unknown text in text mode", { skip, timeout: 30_000 }, async (t) => {
  const { result } = await interrupted(t, { signal: "SIGINT", afterM3: true, json: false });
  assert.equal(result.status, 6, result.stderr);
  assert.match(result.stdout, /Sent; no confirmation\. Check the watch screen\./);
});
