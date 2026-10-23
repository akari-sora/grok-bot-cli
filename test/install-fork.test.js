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
  assert.doesNotMatch(text, /Write-Error/);
  assert.match(text, /\[Console\]::Error\.WriteLine/);
  assert.doesNotMatch(text, /checkout --detach --/);
  assert.match(text, /checkout --detach \$sha/);
  assert.match(text, /sign in to /);
  assert.match(text, /Test-ReportedMissing/);
  assert.match(text, /Get-Content -Raw -LiteralPath/);
  assert.doesNotMatch(text, /Get-Content\b[^\n]*\s-Path\b/);
  assert.match(text, /\$ErrorActionPreference = "Continue"\r?\n\s*gbot config import \$Config 2>&1/);
  assert.match(text, /\$sha -cnotmatch '\^\[0-9a-f\]\{40\}\(\[0-9a-f\]\{24\}\)\?\$'/);
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
  *" checkout --detach -- "*) exit 128 ;;
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
  assert.match(called, /checkout --detach /);
  assert.doesNotMatch(called, /checkout --detach --/);
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
  *" checkout --detach -- "*) exit 128 ;;
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

test("install-fork.sh exits 3 when import reports a missing login and still checks the others", {
  skip: process.platform === "win32" ? "POSIX shell installer test" : false,
}, () => {
  const bin = mkdtempSync(join(tmpdir(), "gbot-install-exit3-"));
  const log = join(bin, "called");
  const cache = join(bin, "cache", "grok-bot-cli", "src");
  mkdirSync(join(cache, ".git"), { recursive: true });
  fakeBin(bin, "git", `
echo "git $*" >> "${log}"
case " $* " in
  *" checkout --detach -- "*) exit 128 ;;
  *" rev-parse "*) echo "cccccccccccccccccccccccccccccccccccccccc" ;;
esac
exit 0
`);
  fakeBin(bin, "npm", `
echo "npm $*" >> "${log}"
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
  fakeBin(bin, "gbot", `
echo "gbot $*" >> "${log}"
if [ "$1" = "config" ]; then
  echo "sign in to work@example.com in the Grok Bot app"
  exit 3
fi
if [ "$1" = "wake" ]; then
  if [ "$4" = "work" ]; then echo "wake checked work" >> "${log}"; exit 2; fi
  echo "wake checked $4" >> "${log}"
  exit 0
fi
exit 0
`);
  const config = join(bin, "export.json");
  writeFileSync(config, JSON.stringify({
    version: 1,
    default: null,
    aliases: {
      work: { scope: "ab".repeat(32), email: "work@example.com" },
      home: { scope: "cd".repeat(32), email: "home@example.com" },
    },
  }));
  const result = spawnSync("sh", [sh, "--config", config, "v1.2"], {
    encoding: "utf8",
    env: installEnv(bin),
  });
  assert.equal(result.status, 3, result.stderr + result.stdout);
  const called = readFileSync(log, "utf8");
  assert.match(called, /wake checked home/);
  assert.doesNotMatch(called, /wake checked work/);
  assert.match(result.stdout, /some imported logins are not signed in/);
});

test("install-fork.sh exits 3 when the missing-login line is only on stderr", {
  skip: process.platform === "win32" ? "POSIX shell installer test" : false,
}, () => {
  const bin = mkdtempSync(join(tmpdir(), "gbot-install-exit3-err-"));
  const log = join(bin, "called");
  const cache = join(bin, "cache", "grok-bot-cli", "src");
  mkdirSync(join(cache, ".git"), { recursive: true });
  fakeBin(bin, "git", `
echo "git $*" >> "${log}"
case " $* " in
  *" rev-parse "*) echo "dddddddddddddddddddddddddddddddddddddddd" ;;
esac
exit 0
`);
  fakeBin(bin, "npm", `
echo "npm $*" >> "${log}"
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
  fakeBin(bin, "gbot", `
echo "gbot $*" >> "${log}"
if [ "$1" = "config" ]; then
  echo "sign in to work@example.com in the Grok Bot app" >&2
  exit 3
fi
if [ "$1" = "wake" ]; then
  if [ "$4" = "work" ]; then echo "wake checked work" >> "${log}"; exit 2; fi
  echo "wake checked $4" >> "${log}"
  exit 0
fi
exit 0
`);
  const config = join(bin, "export.json");
  writeFileSync(config, JSON.stringify({
    version: 1,
    default: null,
    aliases: {
      work: { scope: "ab".repeat(32), email: "work@example.com" },
      home: { scope: "cd".repeat(32), email: "home@example.com" },
    },
  }));
  const result = spawnSync("sh", [sh, "--config", config, "v1.2"], {
    encoding: "utf8",
    env: installEnv(bin),
  });
  assert.equal(result.status, 3, result.stderr + result.stdout);
  const called = readFileSync(log, "utf8");
  assert.match(called, /wake checked home/);
  assert.doesNotMatch(called, /wake checked work/);
});

test("install-fork.sh checks out a branch ref and a tag ref with real git", {
  skip: process.platform === "win32" ? "POSIX shell installer test" : false,
}, () => {
  const gitBin = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  assert.ok(gitBin, "real git is required");
  const bin = mkdtempSync(join(tmpdir(), "gbot-install-realgit-"));
  const seed = join(bin, "seed");
  const remote = join(bin, "origin.git");
  const log = join(bin, "called");
  const gitLog = join(bin, "git.log");
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Synthetic",
    GIT_AUTHOR_EMAIL: "synthetic@example.com",
    GIT_COMMITTER_NAME: "Synthetic",
    GIT_COMMITTER_EMAIL: "synthetic@example.com",
  };
  const git = (args) => {
    const result = spawnSync(gitBin, args, { encoding: "utf8", env: gitEnv });
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
    return result;
  };
  git(["init", "-b", "main", seed]);
  writeFileSync(join(seed, "README"), "synthetic fixture\n");
  git(["-C", seed, "add", "README"]);
  git(["-C", seed, "-c", "commit.gpgsign=false", "commit", "-m", "seed"]);
  git(["-C", seed, "tag", "vSynthetic"]);
  const tagSha = git(["-C", seed, "rev-parse", "HEAD"]).stdout.trim();
  git(["-C", seed, "checkout", "-b", "relay-line"]);
  writeFileSync(join(seed, "BRANCH"), "branch fixture\n");
  git(["-C", seed, "add", "BRANCH"]);
  git(["-C", seed, "-c", "commit.gpgsign=false", "commit", "-m", "branch"]);
  const branchSha = git(["-C", seed, "rev-parse", "HEAD"]).stdout.trim();
  assert.notEqual(branchSha, tagSha);
  assert.match(branchSha, /^[0-9a-f]{40}$/);
  git(["clone", "--bare", seed, remote]);
  const fileRemote = `file://${remote}`;
  writeFileSync(join(bin, "git-rewrite.cjs"), `
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const from = "https://gitlab.com/aa22396584/grok-bot-cli.git";
const args = process.argv.slice(2).map((arg) => arg === from ? process.env.GBOT_INSTALL_REMOTE : arg);
appendFileSync(process.env.GBOT_GIT_LOG, args.join(" ") + "\\n");
const result = spawnSync(process.env.GBOT_REAL_GIT, args, { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
`);
  fakeBin(bin, "git", `exec node "${join(bin, "git-rewrite.cjs")}" "$@"`);
  fakeBin(bin, "npm", `
echo "npm $*" >> "${log}"
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
  fakeBin(bin, "gbot", `echo "gbot $*" >> "${log}"\nexit 0`);
  const installEnvForGit = installEnv(bin, {
    GBOT_REAL_GIT: gitBin,
    GBOT_INSTALL_REMOTE: fileRemote,
    GBOT_GIT_LOG: gitLog,
  });
  const branch = spawnSync("sh", [sh, "relay-line"], { encoding: "utf8", env: installEnvForGit });
  assert.equal(branch.status, 0, branch.stderr + branch.stdout);
  assert.match(readFileSync(log, "utf8"), /^npm ci$/m);
  const cache = join(bin, "cache", "grok-bot-cli", "src");
  const branchHead = spawnSync(gitBin, ["-C", cache, "rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(branchHead.stdout.trim(), branchSha);
  assert.match(branch.stdout, new RegExp(`resolved commit ${branchSha}`));
  const tagged = spawnSync("sh", [sh, "vSynthetic"], { encoding: "utf8", env: installEnvForGit });
  assert.equal(tagged.status, 0, tagged.stderr + tagged.stdout);
  const tagHead = spawnSync(gitBin, ["-C", cache, "rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(tagHead.stdout.trim(), tagSha);
  assert.match(tagged.stdout, new RegExp(`resolved commit ${tagSha}`));
  const recorded = readFileSync(gitLog, "utf8");
  assert.match(recorded, /rev-parse --verify --quiet refs\/remotes\/origin\/relay-line\^\{commit\}/);
  assert.match(recorded, /rev-parse --verify --quiet refs\/tags\/vSynthetic\^\{commit\}/);
  assert.match(recorded, new RegExp(`checkout --detach ${branchSha}`));
  assert.match(recorded, new RegExp(`checkout --detach ${tagSha}`));
  assert.doesNotMatch(recorded, /checkout --detach --/);
  git(["-C", remote, "config", "uploadpack.allowReachableSHA1InWant", "true"]);
  const shaRef = spawnSync("sh", [sh, tagSha], { encoding: "utf8", env: installEnvForGit });
  assert.equal(shaRef.status, 0, shaRef.stderr + shaRef.stdout);
  const shaHead = spawnSync(gitBin, ["-C", cache, "rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(shaHead.stdout.trim(), tagSha);
  const recordedSha = readFileSync(gitLog, "utf8");
  assert.match(recordedSha, new RegExp(`fetch origin -- ${tagSha}`));
  assert.match(recordedSha, new RegExp(`checkout --detach ${tagSha}`));
  assert.doesNotMatch(recordedSha, /checkout --detach --/);
});
