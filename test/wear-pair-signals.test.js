import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    // An option is never taken as the --account value, and --code counts anywhere: after --help or after `--`.
    [["wear", "pair", "--account", "--code", code.normalized, "192.168.1.20:40123"], { GROK_BOT_TEST: "" }],
    [["wear", "pair", "--account", `--code=${code.normalized}`, "192.168.1.20:40123"], { GROK_BOT_TEST: "" }],
    [["wear", "pair", "--help", "--code", code.normalized], { GROK_BOT_TEST: "" }],
    [["wear", "pair", "192.168.1.20:40123", "--", "--code", code.normalized], { GROK_BOT_TEST: "" }],
    // And before `wear pair`.
    [["--code", code.normalized, "wear", "pair", "192.168.1.20:40123"], { GROK_BOT_TEST: "" }],
    [["--json", `--code=${code.normalized}`, "wear", "pair", "192.168.1.20:40123"], { GROK_BOT_TEST: "" }],
    // Between `wear` and `pair`, after other options, and on any other command.
    [["wear", "--code", code.normalized, "pair", "192.168.1.20:40123"], { GROK_BOT_TEST: "" }],
    [["-x", "v", "--code", code.normalized, "wear", "pair", "192.168.1.20:40123"], { GROK_BOT_TEST: "" }],
    [["send", "fake-bot", "--code", code.normalized], { GROK_BOT_TEST: "" }],
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
    assert.match(result.stderr, /The session was already sent; the watch may have stored it\./);
    assert.equal((await fake.result).outcome, "paired", "the watch did store it");
  });
}

test("Ctrl-C after the session was sent prints the unknown text in text mode", { skip, timeout: 30_000 }, async (t) => {
  const { result } = await interrupted(t, { signal: "SIGINT", afterM3: true, json: false });
  assert.equal(result.status, 6, result.stderr);
  assert.match(result.stdout, /Sent; no confirmation\. Check the watch screen\./);
});

/** Children of `pid`: POSIX ps, or /proc where ps is absent (slim Linux images). */
function childrenOf(pid) {
  let pairs;
  try {
    pairs = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
  } catch (error) {
    if (error.code !== "ENOENT" || process.platform !== "linux") throw error;
    pairs = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat;
      try {
        stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch {
        continue; // exited while listing
      }
      // Field 4 is the parent pid; the command name in parentheses may contain spaces.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      pairs.push([Number(entry), Number(fields[1])]);
    }
  }
  return pairs.filter(([, ppid]) => ppid === pid).map(([child]) => child);
}

test("the worker killed (SIGKILL) after the session was sent: the wrapper still reports unknown (exit 6)", { skip, timeout: 30_000 }, async (t) => {
  const f = setup(t);
  const code = randomCode();
  let run;
  const fake = await startFakeWatch({
    codeData: code.data,
    behavior: {
      beforeM4: async () => {
        const workers = childrenOf(run.child.pid);
        assert.equal(workers.length, 1, "one worker process");
        process.kill(workers[0], "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      },
    },
  });
  t.after(() => fake.close());
  run = start(["wear", "pair", `127.0.0.1:${fake.port}`, "--code", code.normalized, "--json"], f.env());
  const result = await run.done;
  assert.equal(result.status, 6, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, "unknown");
  assert.match(result.stderr, /The session was already sent; the watch may have stored it\./);
  assert.deepEqual(f.pairDirs(), []);
  assertNoSecrets(result, code);
});

// Root ignores directory permission bits, so a read-only directory blocks nothing there.
const rootSkip = process.getuid?.() === 0 ? "root bypasses directory permission bits" : false;

for (const [name, block, caseSkip] of [
  ["the directory is read-only", (dir) => chmodSync(dir, 0o500), rootSkip],
  ["`sent` already exists", (dir) => writeFileSync(join(dir, "sent"), "fake-blocker", { mode: 0o600 }), false],
]) {
  test(`the send cannot be recorded (${name}): nothing is sent, exit 1`, { skip: skip || caseSkip, timeout: 30_000 }, async (t) => {
    const f = setup(t);
    const code = randomCode();
    const fake = await startFakeWatch({
      codeData: code.data,
      behavior: {
        // M1 arrived, so the worker has checked its directory; break it before M3 would be recorded.
        beforeM2: async () => {
          const dirs = f.pairDirs();
          assert.equal(dirs.length, 1);
          block(join(f.scratch, dirs[0]));
        },
      },
    });
    t.after(() => fake.close());
    const result = await start(["wear", "pair", `127.0.0.1:${fake.port}`, "--code", code.normalized, "--json"], f.env()).done;
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      category: "record-failed",
      error: "Could not record the send; nothing was sent. Generate a new code on the watch and try again.",
      exitCode: 1,
    });
    const seen = await fake.result;
    assert.equal(seen.outcome, "network-error");
    assert.equal(seen.bytesAfterM2, 0, "no M3 reached the watch");
    assert.equal(seen.payload, undefined);
    assert.doesNotMatch(result.stderr, /already sent/);
    for (const dir of f.pairDirs()) chmodSync(join(f.scratch, dir), 0o700);
    assert.deepEqual(f.pairDirs(), [], "the wrapper removed its pairing directory");
    assertNoSecrets(result, code);
  });
}
