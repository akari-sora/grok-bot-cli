import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nodeTest from "node:test";
import win32Test, { UNIX_ONLY_SKIP_REASON, UNIX_ONLY_TEST_FILES } from "./helpers/win32-test.js";

const test = nodeTest;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("unix-only suites are exactly the files that import the Windows skip helper", () => {
  if (process.platform === "win32") assert.notEqual(win32Test, nodeTest);
  else assert.equal(win32Test, nodeTest);
  const listed = new Set(UNIX_ONLY_TEST_FILES);
  const files = readdirSync(join(root, "test")).filter((name) => name.endsWith(".test.js"));
  for (const name of files) {
    const rel = `test/${name}`;
    const source = readFileSync(join(root, rel), "utf8");
    assert.equal(/import test from ['"]\.\/helpers\/win32-test\.js['"]/.test(source), listed.has(rel), rel);
  }
  const fork = readFileSync(join(root, "FORK.md"), "utf8");
  for (const rel of UNIX_ONLY_TEST_FILES) assert.equal(fork.includes(`\`${rel}\``), true, rel);
  assert.match(fork, /Windows limitations/);
  assert.match(fork, /Windows 限制/);
  assert.match(fork, new RegExp(UNIX_ONLY_SKIP_REASON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Windows collection skips unix-only tests and still runs portable files", () => {
  const env = { ...process.env, GBOT_UNIT_SKIP_UNIX_ONLY: "1", GROK_BOT_TEST: "1" };
  delete env.NODE_TEST_CONTEXT;
  const skipped = spawnSync(process.execPath, ["--test", "test/claude-channel.test.js"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
  assert.match(skipped.stdout, /# skipped 3/);
  assert.match(skipped.stdout, /# fail 0/);
  assert.match(skipped.stdout, /private Claude channel delivers correlated replies/);
  assert.match(skipped.stdout, new RegExp(UNIX_ONLY_SKIP_REASON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const portable = spawnSync(process.execPath, ["--test", "test/codex-commands.test.js"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(portable.status, 0, portable.stdout + portable.stderr);
  assert.match(portable.stdout, /# pass 2/);
  assert.match(portable.stdout, /# skipped 0/);
});
