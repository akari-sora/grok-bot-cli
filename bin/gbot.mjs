#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------------------------
// `gbot wear pair`: the pairing code is typed here, at a hidden prompt, because the rendered command runs in a
// worker without this process's stdin. It never goes into argv or an environment value: the worker gets the path
// of a 0600 file in a fresh 0700 directory (GBOT_PAIR_CODE_FILE), reads it and deletes it, and this process
// removes the directory on every exit path it can handle (SIGKILL or power loss can leave it behind).
// These helpers are exported for tests; importing this file runs nothing.

export const PAIR_CODE_MAX = 32;
const PAIR_PROMPT = "Pairing code shown on the watch (input hidden): ";

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
 * Whether this invocation is `gbot wear pair` and needs the hidden prompt. No prompt for --help, for --code
 * (tests; the worker refuses it outside GROK_BOT_TEST=1), or when the address is missing or invalid (the worker
 * reports that before anyone types a code).
 */
export function wearPairPlan(argv, env = process.env) {
  if (argv[0] !== "wear" || argv[1] !== "pair") return null;
  const end = argv.indexOf("--");
  const visible = argv.slice(2, end === -1 ? argv.length : end);
  if (visible.includes("--help") || visible.includes("-h")) return { prompt: false };
  let target;
  for (let i = 0; i < visible.length; i += 1) {
    const token = visible[i];
    if (token === "--code" || token.startsWith("--code=")) return { prompt: false };
    if (token === "--account") {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (target === undefined) target = token;
  }
  if (target === undefined && end !== -1) target = argv[end + 1];
  if (!parseWearTarget(target, { allowLoopback: pairTestMode(env) })) return { prompt: false };
  return { prompt: true };
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

/** Writes the code to `<fresh 0700 dir>/code` with mode 0600 and returns both paths. */
export function writeCodeHandoff(code, parent = tmpdir()) {
  const dir = mkdtempSync(join(parent, "gbot-pair-"));
  const file = join(dir, "code");
  try {
    writeFileSync(file, code, { mode: 0o600, flag: "wx" });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, file };
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
  // Only this wrapper may name a code file, and only for the invocation it prompted for.
  delete env.GBOT_PAIR_CODE_FILE;
  const scratch = [];
  const cleanup = () => {
    while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true });
  };
  process.on("exit", cleanup);

  const plan = wearPairPlan(argv, process.env);
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
    const onSigint = () => restoreAndExit(130);
    const onSigterm = () => restoreAndExit(143);
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    const answer = await readHiddenCode({ input: process.stdin, output: process.stderr });
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
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
      const handoff = writeCodeHandoff(answer.code);
      scratch.push(handoff.dir);
      env.GBOT_PAIR_CODE_FILE = handoff.file;
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
  const stop = (signal) => {
    // A pending pairing code is useless once the user aborts; remove it now, not after the worker exits.
    if (env.GBOT_PAIR_CODE_FILE) cleanup();
    try {
      child.kill(signal);
    } catch {
      child.kill();
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("error", () => {
    cleanup();
    process.stderr.write("Could not start gbot.\n");
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    cleanup();
    if (signal) {
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
