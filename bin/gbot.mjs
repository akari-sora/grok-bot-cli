#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------------------------
// `gbot wear pair`: the pairing code is typed here, at a hidden prompt, because the rendered command runs in a
// worker without this process's stdin. It never goes into argv or an environment value: the worker gets the path
// of a 0600 file in a fresh 0700 directory (GBOT_PAIR_CODE_FILE), reads it and deletes it, and this process
// removes the directory on every exit path it can handle: normal exit, errors, SIGINT, SIGTERM and SIGHUP (SIGKILL
// or power loss can leave it behind). `--code` is for tests only and is refused here, anywhere on a `wear pair`
// command line and before any worker starts, unless GROK_BOT_TEST=1. The same directory (GBOT_PAIR_STATE_DIR) receives `sent` from the worker just before the
// session leaves the computer; if the worker then ends without its own result (Ctrl-C, a signal, a crash), this
// process reports `unknown` (exit 6) instead of "cancelled".
// These helpers are exported for tests; importing this file runs nothing.

export const PAIR_CODE_MAX = 32;
const PAIR_PROMPT = "Pairing code shown on the watch (input hidden): ";
export const CODE_FLAG_REFUSED =
  "--code is accepted only in tests (GROK_BOT_TEST=1). Run gbot wear pair in a terminal and type the code at the prompt.";
export const UNKNOWN_OUTCOME_TEXT = "Sent; no confirmation. Check the watch screen.";
export const ALREADY_SENT_NOTICE = "The session was already sent; the watch may have stored it.";
const PAIR_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

const truthy = (value) => ["1", "true", "yes"].includes(String(value ?? "").trim().toLowerCase());

/** The fork's url-policy testMode(): GROK_BOT_TEST truthy or NODE_ENV=test. */
export function pairTestMode(env = process.env) {
  return truthy(env.GROK_BOT_TEST) || env.NODE_ENV === "test";
}

const OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
const TARGET_PATTERN = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}:([1-9][0-9]{0,4})$`);

/**
 * Same rules as parseTarget in src/core/wear-pair.js (src/ is not shipped, so the wrapper keeps its own copy; a test
 * checks that both agree): a dotted-decimal private, CGNAT or link-local IPv4 literal and a port 1024-65535.
 */
export function parseWearTarget(text, { allowLoopback = false } = {}) {
  if (typeof text !== "string" || text.length > 21) return null;
  const match = TARGET_PATTERN.exec(text);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const port = Number(match[5]);
  if (port < 1024 || port > 65535) return null;
  const [a, b] = octets;
  const allowed =
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 127 && allowLoopback === true);
  if (!allowed) return null;
  const host = octets.join(".");
  return { host, port, target: `${host}:${port}` };
}

/**
 * Where `wear pair` starts in argv, or -1. Only options (and a bare word right after a `--option`, which may be its
 * value) may come before it, so `gbot --code X wear pair …` counts, while `gbot send Bot wear pair` (a message) does
 * not.
 */
function wearPairIndex(argv) {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === "wear" && argv[i + 1] === "pair") return i;
    const token = argv[i];
    if (token === "--") return -1;
    if (token.startsWith("-")) continue;
    const previous = argv[i - 1];
    if (previous !== undefined && previous.startsWith("--") && !previous.includes("=")) continue;
    return -1;
  }
  return -1;
}

/**
 * What the wrapper does for `gbot wear pair`: null for any other command; `{ code: true }` when `--code` or
 * `--code=…` appears anywhere on the command line (before or after `wear pair`, after --help, after --account or
 * after `--`; tests only, refused here outside GROK_BOT_TEST=1); null when other options come before `wear pair`
 * (the CLI shell rejects them; nothing to prepare); `{ help: true }` for --help; otherwise `{ prompt }`, true when the
 * address is a valid watch address (an invalid one is reported by the worker before anyone types a code).
 */
export function wearPairPlan(argv, env = process.env) {
  const at = wearPairIndex(argv);
  if (at === -1) return null;
  if (argv.some((token) => token === "--code" || token.startsWith("--code="))) return { code: true, prompt: false };
  if (at !== 0) return null;
  const end = argv.indexOf("--");
  const visible = argv.slice(2, end === -1 ? argv.length : end);
  if (visible.includes("--help") || visible.includes("-h")) return { help: true, prompt: false };
  let target;
  for (let i = 0; i < visible.length; i += 1) {
    const token = visible[i];
    if (token === "--account") {
      // Never take an option-looking token as the account value.
      if (visible[i + 1] !== undefined && !visible[i + 1].startsWith("-")) i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (target === undefined) target = token;
  }
  if (target === undefined && end !== -1) target = argv[end + 1];
  return { prompt: parseWearTarget(target, { allowLoopback: pairTestMode(env) }) !== null };
}

/**
 * Reads the code from a TTY in raw mode, so nothing is echoed. CR or LF submits; DEL/BS erases one character;
 * Ctrl-C (0x03) interrupts; Ctrl-D (0x04) or the end of input aborts; other control bytes are ignored; more than
 * `maxLength` characters aborts. The terminal mode is restored on every path. Resolves
 * `{ status: "ok", code: Buffer }` or `{ status: "interrupt" | "eof" | "too-long" }`.
 */
export function readHiddenCode({ input = process.stdin, output = process.stderr, prompt = PAIR_PROMPT, maxLength = PAIR_CODE_MAX } = {}) {
  return new Promise((resolve) => {
    const bytes = [];
    const wasRaw = input.isRaw === true;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      input.removeListener("error", onEnd);
      try {
        input.setRawMode(wasRaw);
      } catch {
        // The terminal went away; nothing left to restore.
      }
      input.pause();
      bytes.fill(0);
      output.write("\n");
      resolve(result);
    };
    const onData = (chunk) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      for (const byte of data) {
        if (byte === 0x03) return finish({ status: "interrupt" });
        if (byte === 0x04) return finish({ status: "eof" });
        if (byte === 0x0d || byte === 0x0a) return finish({ status: "ok", code: Buffer.from(bytes) });
        if (byte === 0x7f || byte === 0x08) {
          bytes.pop();
          continue;
        }
        if (byte < 0x20) continue;
        if (bytes.length >= maxLength) return finish({ status: "too-long" });
        bytes.push(byte);
      }
      return undefined;
    };
    const onEnd = () => finish({ status: "eof" });
    // Echo goes off before the prompt appears, so nothing typed after it is ever echoed.
    try {
      input.setRawMode(true);
    } catch {
      return finish({ status: "eof" });
    }
    output.write(prompt);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onEnd);
    input.once("error", onEnd);
    input.resume();
    return undefined;
  });
}

/** A fresh private (0700) `gbot-pair-*` directory for one `wear pair` run. */
export function makePairDir(parent = tmpdir()) {
  return mkdtempSync(join(parent, "gbot-pair-"));
}

/** Writes the code to `<dir>/code` with mode 0600 (never over an existing file) and returns the path. */
export function writeCodeHandoff(dir, code) {
  const file = join(dir, "code");
  writeFileSync(file, code, { mode: 0o600, flag: "wx" });
  return file;
}

/** The `{ account, id, target }` the worker recorded just before sending the session, or null. */
export function readSentMarker(dir) {
  try {
    const value = JSON.parse(readFileSync(join(dir, "sent"), "utf8"));
    const { account, id, target } = value ?? {};
    if ([account, id, target].every((field) => typeof field === "string")) return { account, id, target };
  } catch {
    // No marker: the session was not sent.
  }
  return null;
}

/** The `unknown` result in the output mode the user asked for (same value as the route's receipt). */
export function unknownOutcomeOutput(sent, visible) {
  const value = { account: sent.account, exitCode: 6, id: sent.id, outcome: "unknown", target: sent.target };
  if (visible.includes("--ndjson")) {
    const document = { root: { children: [{ kind: "text", text: UNKNOWN_OUTCOME_TEXT }], kind: "result" }, status: "success", value, version: 1 };
    return `${JSON.stringify({ document, sequence: 0, type: "complete" })}\n`;
  }
  if (visible.includes("--json")) return `${JSON.stringify(value)}\n`;
  return `${UNKNOWN_OUTCOME_TEXT}\n`;
}

// ---------------------------------------------------------------------------------------------------------------

async function main() {
  const real = fileURLToPath(new URL("../dist/bin/gbot.mjs", import.meta.url));
  let argv = process.argv.slice(2);
  const leading = [];
  while (argv[0] === "--json" || argv[0] === "--ndjson") leading.push(argv.shift());
  if (leading.length > 0) argv = [...argv, ...leading];

  const visible = argv.slice(0, argv.indexOf("--") === -1 ? argv.length : argv.indexOf("--"));
  const env = { ...process.env };
  // Only this wrapper may name a code file or pairing directory, and only for the run it prepared.
  delete env.GBOT_PAIR_CODE_FILE;
  delete env.GBOT_PAIR_STATE_DIR;
  const scratch = [];
  const cleanup = () => {
    while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  // A hung-up terminal must not turn a write into an uncaught exception.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  const plan = wearPairPlan(argv, process.env);
  if (plan?.code && process.env.GROK_BOT_TEST !== "1") {
    // Refused before any worker starts: a production --code never travels further than this process.
    if (visible.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ category: "usage", error: CODE_FLAG_REFUSED, exitCode: 2 })}\n`);
    }
    process.stderr.write(`${CODE_FLAG_REFUSED}\n`);
    process.exit(2);
  }
  let pairDir;
  if (plan && !plan.help) {
    try {
      pairDir = makePairDir();
    } catch {
      process.stderr.write("Could not create a private temporary directory for pairing. Nothing was sent.\n");
      process.exit(1);
    }
    scratch.push(pairDir);
    env.GBOT_PAIR_STATE_DIR = pairDir;
  }
  if (plan?.prompt && process.stdin.isTTY) {
    const restoreAndExit = (code) => {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Not a TTY any more.
      }
      cleanup();
      process.exit(code);
    };
    const onPromptSignal = (signal) => restoreAndExit(128 + (constants.signals[signal] ?? 0));
    for (const signal of PAIR_SIGNALS) process.on(signal, onPromptSignal);
    const answer = await readHiddenCode({ input: process.stdin, output: process.stderr });
    for (const signal of PAIR_SIGNALS) process.removeListener(signal, onPromptSignal);
    if (answer.status === "interrupt") restoreAndExit(130);
    if (answer.status !== "ok") {
      process.stderr.write(
        answer.status === "too-long"
          ? `The pairing code is too long (at most ${PAIR_CODE_MAX} characters). Nothing was sent.\n`
          : "No pairing code was entered. Nothing was sent.\n",
      );
      restoreAndExit(2);
    }
    try {
      env.GBOT_PAIR_CODE_FILE = writeCodeHandoff(pairDir, answer.code);
    } catch {
      process.stderr.write("Could not hand the pairing code to gbot (temporary directory not writable). Nothing was sent.\n");
      restoreAndExit(1);
    } finally {
      answer.code.fill(0);
    }
  }

  if (visible.includes("--stdin")) {
    // The rendered command runs in a worker that does not receive this process's
    // stdin. Capture it here, before that worker starts, and hand over a private file.
    const chunks = [];
    // Windows consoles leave stdin paused until it is resumed.
    process.stdin.resume();
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const dir = mkdtempSync(join(tmpdir(), "gbot-stdin-"));
    scratch.push(dir);
    const file = join(dir, "message");
    writeFileSync(file, Buffer.concat(chunks), { mode: 0o600 });
    env.GBOT_STDIN_FILE = file;
  }

  if (argv.includes("--json")) env.GBOT_JSON = "1";

  const child = spawn(process.execPath, [real, ...argv], {
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const forwarded = ["SIGINT", "SIGTERM", ...(plan ? ["SIGHUP"] : [])];
  const stop = (signal) => {
    // A pending pairing code is useless once the user aborts: remove it now, not after the worker exits. The
    // directory stays until the worker exits, so its `sent` marker can still be read.
    if (env.GBOT_PAIR_CODE_FILE) rmSync(env.GBOT_PAIR_CODE_FILE, { force: true });
    try {
      child.kill(signal);
    } catch {
      child.kill();
    }
  };
  for (const signal of forwarded) process.on(signal, stop);
  child.on("error", () => {
    cleanup();
    process.stderr.write("Could not start gbot.\n");
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    const sent = pairDir ? readSentMarker(pairDir) : null;
    cleanup();
    if (sent && (signal !== null || ![0, 5, 6].includes(code))) {
      // The session already left the computer; whatever ended the worker, the honest result is "unknown". The
      // worker's runtime may already have printed "Aborted." on stderr; this line follows it.
      process.stderr.write(`${ALREADY_SENT_NOTICE}\n`);
      process.stdout.write(unknownOutcomeOutput(sent, visible), () => process.exit(6));
      return;
    }
    if (signal) {
      // Re-raise the worker's signal on this process; our own handlers must go first or it would not exit.
      for (const name of forwarded) process.removeAllListeners(name);
      process.exitCode = 128 + (constants.signals[signal] ?? 0);
      // Windows rejects some signals with EINVAL; still exit.
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
      return;
    }
    process.exit(code ?? 1);
  });
}

// Run only as the executable (also through npm's bin symlink); importing this file for tests runs nothing.
// import.meta.main exists on every Node this package supports (engines >= 22.19.0); older Nodes leave it
// undefined and still run.
if (import.meta.main !== false) await main();
