import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PAIR_CODE_MAX,
  UNKNOWN_OUTCOME_TEXT,
  makePairDir,
  readHiddenCode,
  readSentMarker,
  unknownOutcomeOutput,
  wearPairPlan,
  writeCodeHandoff,
} from "../bin/gbot.mjs";
import { startFakeWatch } from "./helpers/fake-watch.js";
import { cliEnv, descriptor, ENTRY_A, randomCode, writeDescriptor } from "./helpers/wear-pair-fixture.js";

const WRAPPER = fileURLToPath(new URL("../bin/gbot.mjs", import.meta.url));

/** A stand-in for a TTY ReadStream: records raw-mode switches and lets the test type bytes. */
function fakeTty({ failRaw = false } = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.modes = [];
  input.setRawMode = (mode) => {
    if (failRaw) throw new Error("fake: not a terminal");
    input.isRaw = mode;
    input.modes.push(mode);
    return input;
  };
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => { printed += chunk; });
  return { input, output, printed: () => printed };
}

async function typeInto(bytes, options) {
  const tty = fakeTty(options);
  const pending = readHiddenCode({ input: tty.input, output: tty.output, prompt: "code: " });
  for (const chunk of bytes) {
    if (chunk === null) tty.input.end();
    else tty.input.write(Buffer.from(chunk, "latin1"));
  }
  const result = await pending;
  return { result, tty };
}

const codeOf = (result) => (result.code ? result.code.toString("latin1") : undefined);

test("hidden prompt: CR and LF submit, raw mode is restored, nothing is echoed", async () => {
  for (const end of ["\r", "\n", "\r\n"]) {
    const { result, tty } = await typeInto([`7QF3-MXPZ${end}`]);
    assert.equal(result.status, "ok");
    assert.equal(codeOf(result), "7QF3-MXPZ");
    assert.deepEqual(tty.input.modes, [true, false]);
    assert.equal(tty.input.isRaw, false);
    assert.equal(tty.printed(), "code: \n");
  }
});

test("hidden prompt: raw mode is on before the prompt is shown", async () => {
  const tty = fakeTty();
  let rawWhenPrompted;
  tty.output.write = ((write) => (chunk, ...rest) => {
    if (rawWhenPrompted === undefined) rawWhenPrompted = tty.input.isRaw;
    return write.call(tty.output, chunk, ...rest);
  })(tty.output.write);
  const pending = readHiddenCode({ input: tty.input, output: tty.output, prompt: "code: " });
  tty.input.write("A\r");
  await pending;
  assert.equal(rawWhenPrompted, true);
});

test("hidden prompt: DEL and BS erase, other control bytes are ignored, chunks join", async () => {
  const { result } = await typeInto(["ABX\x7fC", "\x08D\x1b\x01", "E\r"]);
  assert.equal(codeOf(result), "ABDE");
});

test("hidden prompt: Ctrl-C interrupts and restores the terminal", async () => {
  const { result, tty } = await typeInto(["ABC\x03DEF\r"]);
  assert.deepEqual(result, { status: "interrupt" });
  assert.deepEqual(tty.input.modes, [true, false]);
});

test("hidden prompt: Ctrl-D and end of input abort", async () => {
  for (const bytes of [["AB\x04"], ["AB", null]]) {
    const { result, tty } = await typeInto(bytes);
    assert.deepEqual(result, { status: "eof" });
    assert.equal(tty.input.isRaw, false);
  }
});

test(`hidden prompt: at most ${PAIR_CODE_MAX} characters`, async () => {
  const exact = await typeInto(["A".repeat(PAIR_CODE_MAX) + "\r"]);
  assert.equal(codeOf(exact.result), "A".repeat(PAIR_CODE_MAX));
  const long = await typeInto(["A".repeat(PAIR_CODE_MAX + 1)]);
  assert.deepEqual(long.result, { status: "too-long" });
  assert.equal(long.tty.input.isRaw, false);
  const erased = await typeInto(["A".repeat(PAIR_CODE_MAX) + "\x7fB\r"]);
  assert.equal(codeOf(erased.result), "A".repeat(PAIR_CODE_MAX - 1) + "B");
});

test("hidden prompt: a stream that cannot go raw aborts", async () => {
  const { result } = await typeInto([], { failRaw: true });
  assert.deepEqual(result, { status: "eof" });
});

test("wrapper prompts only for `wear pair <valid ip:port>` without --help or --code", () => {
  const prod = {};
  const testEnv = { GROK_BOT_TEST: "1" };
  assert.equal(wearPairPlan(["send", "x"], prod), null);
  assert.equal(wearPairPlan(["wear"], prod), null);
  assert.deepEqual(wearPairPlan(["wear", "pair", "192.168.1.5:40000"], prod), { prompt: true });
  assert.deepEqual(wearPairPlan(["wear", "pair", "192.168.1.5:40000", "--account", "fake@example.com", "--json"], prod), { prompt: true });
  assert.deepEqual(wearPairPlan(["wear", "pair", "--account", "fake@example.com", "192.168.1.5:40000"], prod), { prompt: true });
  assert.deepEqual(wearPairPlan(["wear", "pair", "--", "192.168.1.5:40000"], prod), { prompt: true });
  assert.deepEqual(wearPairPlan(["wear", "pair", "192.168.1.5:40000", "--help"], prod), { help: true, prompt: false });
  assert.deepEqual(wearPairPlan(["wear", "pair", "-h"], prod), { help: true, prompt: false });
  assert.deepEqual(wearPairPlan(["wear", "pair", "192.168.1.5:40000", "--code", "fake"], testEnv), { code: true, prompt: false });
  assert.deepEqual(wearPairPlan(["wear", "pair", "192.168.1.5:40000", "--code=fake"], prod), { code: true, prompt: false });
  assert.deepEqual(wearPairPlan(["wear", "pair", "--", "--code"], prod), { prompt: false }, "after -- it is a positional");
  assert.deepEqual(wearPairPlan(["wear", "pair"], prod), { prompt: false });
  assert.deepEqual(wearPairPlan(["wear", "pair", "8.8.8.8:40000"], prod), { prompt: false });
  assert.deepEqual(wearPairPlan(["wear", "pair", "--account", "192.168.1.5:40000"], prod), { prompt: false });
  assert.deepEqual(wearPairPlan(["wear", "pair", "127.0.0.1:40000"], prod), { prompt: false });
  assert.deepEqual(wearPairPlan(["wear", "pair", "127.0.0.1:40000"], testEnv), { prompt: true });
  assert.deepEqual(wearPairPlan(["wear", "pair", "127.0.0.1:40000"], { NODE_ENV: "test" }), { prompt: true });
});

test("code hand-off: 0600 file in a fresh 0700 directory, never overwritten", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "gbot-wear-handoff-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = makePairDir(parent);
  const file = writeCodeHandoff(dir, Buffer.from("fake-code"));
  assert.match(dir, /gbot-pair-[^/\\]+$/);
  assert.equal(file, join(dir, "code"));
  assert.equal(readFileSync(file, "latin1"), "fake-code");
  if (process.platform !== "win32") {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  assert.throws(() => writeCodeHandoff(dir, Buffer.from("fake-other")), /EEXIST/);
  assert.notEqual(makePairDir(parent), dir);
});

test("sent marker and the wrapper's unknown result in every output mode", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "gbot-wear-sent-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = makePairDir(parent);
  assert.equal(readSentMarker(dir), null);
  writeFileSync(join(dir, "sent"), "fake-not-json");
  assert.equal(readSentMarker(dir), null);
  writeFileSync(join(dir, "sent"), JSON.stringify({ account: "fake@example.com", id: 7, target: "192.168.1.5:40000" }));
  assert.equal(readSentMarker(dir), null, "every field must be a string");
  const sent = { account: "fake@example.com", id: "fake-id", target: "192.168.1.5:40000" };
  writeFileSync(join(dir, "sent"), JSON.stringify(sent));
  assert.deepEqual(readSentMarker(dir), sent);
  const value = { account: sent.account, exitCode: 6, id: sent.id, outcome: "unknown", target: sent.target };
  assert.deepEqual(JSON.parse(unknownOutcomeOutput(sent, ["wear", "pair", "--json"])), value);
  const event = JSON.parse(unknownOutcomeOutput(sent, ["wear", "pair", "--ndjson"]));
  assert.equal(event.type, "complete");
  assert.deepEqual(event.document.value, value);
  assert.equal(unknownOutcomeOutput(sent, ["wear", "pair"]), `${UNKNOWN_OUTCOME_TEXT}\n`);
  assert.equal(UNKNOWN_OUTCOME_TEXT, "Sent; no confirmation. Check the watch screen.");
});

test("importing the wrapper runs nothing", () => {
  // This file imported bin/gbot.mjs above; had main() run, it would have spawned dist/bin/gbot.mjs and exited.
  assert.equal(typeof readHiddenCode, "function");
});

// --- One real pseudo-terminal run through script(1) ---------------------------------------------------------------

const scriptPath = ["/usr/bin/script", "/bin/script"].find((path) => existsSync(path));
const ptySkip =
  process.platform === "win32" ? "script(1) pseudo-terminal test is Unix-only"
    : !scriptPath ? "script(1) is not installed; skipping the pseudo-terminal test"
      : process.platform !== "darwin" && process.platform !== "linux" ? "script(1) flags are only known for macOS and Linux"
        : false;

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/** Command lines and environments of this user's processes (best effort). */
function processTable() {
  if (process.platform === "darwin") return execFileSync("ps", ["-axEww", "-o", "command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const parts = [];
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    for (const file of ["cmdline", "environ"]) {
      try {
        parts.push(readFileSync(`/proc/${pid}/${file}`, "latin1"));
      } catch {
        // Not ours, or already gone.
      }
    }
  }
  return parts.join("\n");
}

test("pseudo-terminal: hidden input, terminal restored, hand-off file deleted, code never in argv/env/output", { skip: ptySkip, timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gbot-wear-pty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const scratch = join(root, "tmp");
  for (const dir of [home, scratch]) mkdirSync(dir, { recursive: true });
  writeDescriptor(home, { [ENTRY_A]: descriptor() }, { platform: process.platform === "linux" ? "linux" : "darwin" });

  const code = randomCode();
  const observed = {};
  const fake = await startFakeWatch({
    codeData: code.data,
    behavior: {
      // Runs once the CLI has read the code, loaded the login and sent M1: inspect what is on disk and in ps.
      beforeM2: async () => {
        try {
          const dirs = readdirSync(scratch).filter((name) => name.startsWith("gbot-pair-"));
          observed.dirs = dirs.length;
          observed.dirMode = dirs.length === 1 ? statSync(join(scratch, dirs[0])).mode & 0o777 : null;
          observed.files = dirs.length === 1 ? readdirSync(join(scratch, dirs[0])) : null;
          const table = processTable();
          observed.inProcessTable = [code.data, code.normalized, code.display].some((value) => table.includes(value));
          observed.handoffVisible = table.includes("GBOT_PAIR_CODE_FILE");
        } catch (error) {
          observed.error = String(error?.code ?? error?.name ?? "error");
        }
      },
    },
  });
  t.after(() => fake.close());

  const command = `${shellQuote(process.execPath)} ${shellQuote(WRAPPER)} wear pair 127.0.0.1:${fake.port}; echo "gbot-exit=$?"; stty -a; echo wear-pty-done`;
  // script(1) on macOS refuses a socket as stdin (Node's pipes are sockets), so `cat` feeds it through a real pipe.
  const run = process.platform === "darwin"
    ? `exec ${shellQuote(scriptPath)} -q /dev/null /bin/sh -c "$WEAR_PTY_COMMAND"`
    : `exec ${shellQuote(scriptPath)} -q -e -c "$WEAR_PTY_COMMAND" /dev/null`;
  const child = spawn("/bin/sh", ["-c", `cat | ${run}`], {
    env: { ...cliEnv(home, { TMPDIR: scratch }), WEAR_PTY_COMMAND: command },
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so a hung run can be killed as a whole and never keeps the test runner alive.
    detached: true,
  });
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  let output = "";
  let typed = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const onOutput = (chunk) => {
    output += chunk;
    if (!typed && output.includes("Pairing code shown on the watch")) {
      typed = true;
      // Lower case with separators, typed at the hidden prompt, then Enter (CR, as a terminal sends it).
      child.stdin.write(code.display.toLowerCase() + "\r");
    }
    if (output.includes("wear-pty-done")) child.stdin.end();
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);
  const status = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(typed, true, `the prompt never appeared:\n${output}`);
  assert.equal(observed.error, undefined, "inspection failed");
  assert.match(output, /gbot-exit=0/, output);
  assert.match(output, /Paired fake-wear@example\.com with the watch at 127\.0\.0\.1:\d+\./);
  const lower = output.toLowerCase();
  for (const value of [code.data, code.normalized, code.display]) {
    assert.equal(lower.includes(value.toLowerCase()), false, "the code was echoed or printed");
  }
  // Terminal restored: canonical mode and echo are back on after gbot exits.
  assert.match(output, /(^|\s)icanon(\s|$)/m);
  assert.doesNotMatch(output, /(^|\s)-icanon(\s|$)/m);
  assert.match(output, /(^|\s)echo(\s|$)/m);
  assert.doesNotMatch(output, /(^|\s)-echo(\s|$)/m);
  assert.equal(status, 0);

  assert.equal((await fake.result).outcome, "paired");
  assert.deepEqual(observed.files, [], "the worker deleted the 0600 code file before connecting");
  assert.equal(observed.dirs, 1);
  assert.equal(observed.dirMode, 0o700);
  assert.equal(observed.inProcessTable, false, "the code is in no process's argv or environment");
  if (process.platform === "darwin") assert.equal(observed.handoffVisible, true, "ps shows environments, so the check above is meaningful");
  assert.deepEqual(readdirSync(scratch).filter((name) => name.startsWith("gbot-pair-")), [], "the wrapper removed its directory");
});
