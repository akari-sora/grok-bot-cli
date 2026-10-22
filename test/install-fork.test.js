import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sh = join(root, "scripts", "install-fork.sh");
const ps1 = join(root, "scripts", "install-fork.ps1");

test("install-fork.sh --dry-run prints the install steps and does not run git or npm", {
  skip: process.platform === "win32" ? "POSIX shell installer test" : false,
}, () => {
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
  assert.match(text, /-DryRun/);
  assert.match(text, /--dry-run/);
  assert.doesNotMatch(text, />\s*(dirty|sha|pack)\.txt\b/i, "must not overwrite fixed files in the caller or checkout");
  assert.match(text, /\[IO\.Path\]::GetTempPath\(\)/);
  assert.match(text, /\[guid\]::NewGuid\(\)/);
  assert.match(text, /npm pack --pack-destination \$packDir/);
  assert.match(text, /Remove-Item -LiteralPath \$packDir -Recurse -Force/);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line) || /^\s*["']/.test(line)) continue;
    if (!/^\s*(git|npm|gbot)\b/.test(line)) continue;
    const window = lines.slice(i, i + 4).join("\n");
    assert.match(window, /\$LASTEXITCODE/, line.trim());
  }
});

function fakeBin(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function installEnv(bin, extra = {}) {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: bin,
    XDG_CACHE_HOME: join(bin, "cache"),
    ...extra,
  };
}

test("install-fork.sh resolves a relative config, rejects a bad ref, and keeps -- as the ref", {
  skip: process.platform === "win32" ? "POSIX shell installer test" : false,
}, () => {
  const bin = mkdtempSync(join(tmpdir(), "gbot-install-rel-"));
  const log = join(bin, "called");
  fakeBin(bin, "git", `echo "git $*" >> "${log}"\nexit 99`);
  fakeBin(bin, "npm", `echo "npm $*" >> "${log}"\nexit 99`);
  const cwd = join(bin, "work");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "gbot-accounts.json"), JSON.stringify({
    version: 1,
    default: null,
    aliases: { work: { scope: "ab".repeat(32), email: "work@example.com" } },
  }));
  const relative = spawnSync("sh", [sh, "--dry-run", "--config", "gbot-accounts.json", "v0.11.2-iml1s.4"], {
    cwd,
    encoding: "utf8",
    env: installEnv(bin),
  });
  assert.equal(relative.status, 0, relative.stderr);
  assert.match(relative.stdout, new RegExp(join(cwd, "gbot-accounts.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(existsSync(log) ? readFileSync(log, "utf8").trim() : "", "");

  const dashed = spawnSync("sh", [sh, "--dry-run", "--", "v1.2"], {
    encoding: "utf8",
    env: installEnv(bin),
  });
  assert.equal(dashed.status, 0, dashed.stderr);
  assert.match(dashed.stdout, /v1\.2/);
  assert.doesNotMatch(dashed.stdout, /checkout main/);

  for (const ref of ["-rf", "--output=evil"]) {
    const bad = spawnSync("sh", [sh, "--", ref], { encoding: "utf8", env: installEnv(bin) });
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /invalid ref/);
  }
  assert.equal(existsSync(log) ? readFileSync(log, "utf8").trim() : "", "");
  assert.ok(statSync(sh).mode & 0o111, "install-fork.sh is executable");
});

test("install-fork.sh installs from a private pack directory twice and propagates a failed step", {
  skip: process.platform === "win32" ? "POSIX shell installer test" : false,
}, () => {
  const bin = mkdtempSync(join(tmpdir(), "gbot-install-pack-"));
  const log = join(bin, "called");
  const cache = join(bin, "cache", "grok-bot-cli", "src");
  mkdirSync(cache, { recursive: true });
  mkdirSync(join(cache, ".git"));
  fakeBin(bin, "git", `
echo "git $*" >> "${log}"
case " $* " in
  *" status --porcelain "*)
    if [ -e "${join(cache, "pack.txt")}" ] || find "${cache}" -maxdepth 1 -name '*.tgz' -print -quit | grep -q .; then
      echo "?? installer-artifact"
    fi
    ;;
  *" rev-parse "*) echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ;;
esac
exit 0
`);
  fakeBin(bin, "npm", `
echo "npm $*" >> "${log}"
case "$1" in
  pack)
    destination=.
    shift
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--pack-destination" ]; then destination=$2; shift 2; else shift; fi
    done
    echo "grok-bot-cli-9.9.9.tgz"
    printf packed > "$destination/grok-bot-cli-9.9.9.tgz"
    ;;
esac
exit 0
`);
  fakeBin(bin, "gbot", `echo "gbot $*" >> "${log}"\nexit 0`);
  const caller = join(bin, "caller");
  mkdirSync(caller);
  writeFileSync(join(caller, "dirty.txt"), "keep dirty");
  writeFileSync(join(caller, "sha.txt"), "keep sha");
  writeFileSync(join(caller, "pack.txt"), "keep pack");
  for (let attempt = 0; attempt < 2; attempt++) {
    const packed = spawnSync("sh", [sh, "v1.2"], { cwd: caller, encoding: "utf8", env: installEnv(bin) });
    assert.equal(packed.status, 0, packed.stderr + packed.stdout);
    assert.match(packed.stdout, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  }
  const called = readFileSync(log, "utf8");
  assert.match(called, /npm pack --pack-destination \/.*grok-bot-cli-pack\./);
  assert.match(called, /npm install -g \/.*grok-bot-cli-pack\..*\/grok-bot-cli-9\.9\.9\.tgz/);
  assert.equal(readFileSync(join(caller, "dirty.txt"), "utf8"), "keep dirty");
  assert.equal(readFileSync(join(caller, "sha.txt"), "utf8"), "keep sha");
  assert.equal(readFileSync(join(caller, "pack.txt"), "utf8"), "keep pack");
  assert.equal(existsSync(join(cache, "grok-bot-cli-9.9.9.tgz")), false);
  assert.equal(existsSync(join(cache, "pack.txt")), false);

  const failBin = mkdtempSync(join(tmpdir(), "gbot-install-fail-"));
  const failLog = join(failBin, "called");
  fakeBin(failBin, "git", `echo "git $*" >> "${failLog}"\nexit 1`);
  fakeBin(failBin, "npm", `echo "npm $*" >> "${failLog}"\nexit 0`);
  const failed = spawnSync("sh", [sh, "v1.2"], { encoding: "utf8", env: installEnv(failBin) });
  assert.notEqual(failed.status, 0);
  const failCalled = existsSync(failLog) ? readFileSync(failLog, "utf8") : "";
  assert.doesNotMatch(failCalled, /^npm /m);

  const importBin = mkdtempSync(join(tmpdir(), "gbot-install-import-"));
  const importLog = join(importBin, "called");
  const importCache = join(importBin, "cache", "grok-bot-cli", "src");
  mkdirSync(join(importCache, ".git"), { recursive: true });
  fakeBin(importBin, "git", `
echo "git $*" >> "${importLog}"
case " $* " in
  *" rev-parse "*) echo "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ;;
esac
exit 0
`);
  fakeBin(importBin, "npm", `
echo "npm $*" >> "${importLog}"
case "$1" in
  pack)
    destination=.; shift
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--pack-destination" ]; then destination=$2; shift 2; else shift; fi
    done
    echo "grok-bot-cli-9.9.9.tgz"; printf packed > "$destination/grok-bot-cli-9.9.9.tgz"
    ;;
esac
exit 0
`);
  fakeBin(importBin, "gbot", `
echo "gbot $*" >> "${importLog}"
if [ "$1" = "accounts" ]; then exit 1; fi
if [ "$1" = "config" ]; then exit 1; fi
exit 0
`);
  const config = join(importBin, "export.json");
  writeFileSync(config, JSON.stringify({
    version: 1,
    default: null,
    aliases: { work: { scope: "ab".repeat(32), email: "work@example.com" } },
  }));
  const imported = spawnSync("sh", [sh, "--config", config, "v1.2"], {
    encoding: "utf8",
    env: installEnv(importBin),
  });
  assert.equal(imported.status, 1, imported.stderr);
  const importCalled = readFileSync(importLog, "utf8");
  assert.match(importCalled, /gbot accounts/);
  assert.match(importCalled, /gbot config import/);
});

test("install-fork.sh refuses and preserves a legacy tarball in the cache", {
  skip: process.platform === "win32" ? "POSIX shell installer test" : false,
}, () => {
  const bin = mkdtempSync(join(tmpdir(), "gbot-install-legacy-"));
  const log = join(bin, "called");
  const cache = join(bin, "cache", "grok-bot-cli", "src");
  const legacy = join(cache, "grok-bot-cli-legacy.tgz");
  mkdirSync(join(cache, ".git"), { recursive: true });
  writeFileSync(legacy, "preserve these bytes");
  fakeBin(bin, "git", `
echo "git $*" >> "${log}"
case " $* " in
  *" status --porcelain "*) echo "?? grok-bot-cli-legacy.tgz" ;;
esac
exit 0
`);
  fakeBin(bin, "npm", `echo "npm $*" >> "${log}"\nexit 99`);
  fakeBin(bin, "gbot", `echo "gbot $*" >> "${log}"\nexit 99`);

  const result = spawnSync("sh", [sh, "v1.2"], { encoding: "utf8", env: installEnv(bin) });
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stderr, /cache is dirty; refusing to overwrite/);
  assert.equal(readFileSync(legacy, "utf8"), "preserve these bytes");
  assert.doesNotMatch(readFileSync(log, "utf8"), /^(npm|gbot) /m);
});
