import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sh = join(root, "scripts", "install-fork.sh");
const ps1 = join(root, "scripts", "install-fork.ps1");

test("install-fork.sh --dry-run prints the install steps and does not run git or npm", () => {
  const bin = mkdtempSync(join(tmpdir(), "gbot-install-bin-"));
  const log = join(bin, "called");
  const fake = `#!/bin/sh
echo "$0 $*" >> "${log}"
exit 99
`;
  writeFileSync(join(bin, "git"), fake);
  writeFileSync(join(bin, "npm"), fake);
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);
  const config = join(bin, "export.json");
  writeFileSync(config, JSON.stringify({
    version: 1,
    default: "work",
    aliases: { work: { scope: "ab".repeat(32), email: "work@example.com" } },
    gbotVersion: "0.11.2",
  }));
  const result = spawnSync("sh", [sh, "--dry-run", "--config", config, "v0.11.2-iml1s.4"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: bin, XDG_CACHE_HOME: join(bin, "cache") },
  });
  assert.equal(result.status, 0, result.stderr);
  const text = result.stdout;
  assert.match(text, /gitlab\.com\/aa22396584\/grok-bot-cli\.git/);
  assert.match(text, /grok-bot-cli\/src/);
  assert.match(text, /v0\.11\.2-iml1s\.4/);
  assert.match(text, /npm ci/);
  assert.match(text, /npm pack/);
  assert.match(text, /npm install -g/);
  assert.match(text, /gbot --version/);
  assert.match(text, /gbot accounts/);
  assert.match(text, /gbot config import/);
  assert.match(text, /gbot wake --check --account work/);
  const called = existsSync(log) ? readFileSync(log, "utf8").trim() : "";
  assert.equal(called, "", "dry-run must not invoke git or npm");
});

test("install-fork.ps1 names the same steps and refuses Administrator without -AllowRoot", () => {
  const text = readFileSync(ps1, "utf8");
  for (const step of [
    "gitlab.com/aa22396584/grok-bot-cli.git",
    "grok-bot-cli",
    "npm ci",
    "npm pack",
    "npm install -g",
    "gbot --version",
    "gbot accounts",
    "config import",
    "wake --check",
    "AllowRoot",
    "dry-run",
    "Administrator",
  ]) {
    assert.equal(text.includes(step), true, step);
  }
});
