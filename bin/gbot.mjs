#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const real = fileURLToPath(new URL("../dist/bin/gbot.mjs", import.meta.url));
let argv = process.argv.slice(2);
const leading = [];
while (argv[0] === "--json" || argv[0] === "--ndjson") leading.push(argv.shift());
if (leading.length > 0) argv = [...argv, ...leading];

const visible = argv.slice(0, argv.indexOf("--") === -1 ? argv.length : argv.indexOf("--"));
const env = { ...process.env };
let scratch;
if (visible.includes("--stdin")) {
  // The rendered command runs in a worker that does not receive this process's
  // stdin. Capture it here, before that worker starts, and hand over a private file.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  scratch = mkdtempSync(join(tmpdir(), "gbot-stdin-"));
  const file = join(scratch, "message");
  writeFileSync(file, Buffer.concat(chunks), { mode: 0o600 });
  env.GBOT_STDIN_FILE = file;
}

if (argv.includes("--json")) env.GBOT_JSON = "1";

const child = spawn(process.execPath, [real, ...argv], {
  env,
  stdio: ["ignore", "inherit", "inherit"],
});
const stop = (signal) => child.kill(signal);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code, signal) => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
