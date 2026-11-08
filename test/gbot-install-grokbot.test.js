// `gbot-install install grokbot` (agent-bundle 0.4.0, upstream def7ad4) against a temporary copy of the
// Grok Bot plugin folders: GROK_BOT_AGENT_DATA_DIR, GROK_BOT_HOME and HOME point into a temp dir, so the
// real ~/.grokbot and Grok Bot data are never read or written. Runs the built dist/bin/gbot-install.js.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const INSTALLER = fileURLToPath(new URL("../dist/bin/gbot-install.js", import.meta.url));
// Grok Bot names each marketplace clone folder by its 40-hex commit.
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PSTACK_MANIFEST = { name: "scriptedalchemy-plugins", plugins: [{ name: "pstack", source: "pstack" }] };

function grokBotFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gbot-install-grokbot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const agentData = join(root, "agent-data");
  const clone = join(agentData, "plugins", "marketplaces", "github.com", "scriptedalchemy", "plugins", COMMIT);
  const cache = join(agentData, "plugins", "cache", "scriptedalchemy-plugins");
  // What Grok Bot keeps after it installed one plugin (pstack) from scriptedalchemy/plugins.
  for (const dir of [home, join(clone, ".git"), join(clone, ".cursor-plugin"), join(clone, "pstack"), join(cache, "pstack", COMMIT)]) {
    mkdirSync(dir, { recursive: true });
  }
  const manifest = join(clone, ".cursor-plugin", "marketplace.json");
  writeFileSync(manifest, JSON.stringify(PSTACK_MANIFEST, null, 2) + "\n");
  writeFileSync(join(cache, "pstack", COMMIT, ".cache-complete"), "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(GROK_BOT_|CODEX_HOME$|CLAUDE_CONFIG_DIR$|XDG_)/.test(key)));
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    GROK_BOT_HOME: join(home, ".grokbot"),
    GROK_BOT_AGENT_DATA_DIR: agentData,
  });
  const run = (...args) => {
    const out = spawnSync(process.execPath, [INSTALLER, ...args], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    return out.stdout.trim() ? JSON.parse(out.stdout) : null;
  };
  return { home, clone, cache, manifest, run };
}

test("install grokbot sideloads gbot into Grok Bot's scriptedalchemy/plugins clone and cache; uninstall removes only that", (t) => {
  const { home, clone, cache, manifest, run } = grokBotFixture(t);
  const installed = run("install", "grokbot", "--json");
  assert.equal(installed.host, "grokbot");
  assert.equal(installed.state, "staged");
  assert.ok(existsSync(join(home, ".grokbot", "agent-bundle", "marketplaces", "gbot")), "staged under GROK_BOT_HOME");
  assert.equal(installed.sideload.state, "written");
  assert.equal(installed.sideload.repo, "scriptedalchemy/plugins");
  assert.equal(installed.sideload.slug, "scriptedalchemy-plugins");
  assert.equal(installed.sideload.commit, COMMIT, "the clone Grok Bot already has, never an invented commit");
  assert.ok(existsSync(join(cache, "gbot", COMMIT, ".cache-complete")));
  assert.ok(existsSync(join(clone, "gbot", ".agent-bundle-sideload.json")));
  const listed = JSON.parse(readFileSync(manifest, "utf8")).plugins;
  assert.deepEqual(listed.map((entry) => [entry.name, entry.source]), [["pstack", "pstack"], ["gbot", "gbot"]]);

  assert.equal(run("install", "grokbot", "--json").sideload.state, "unchanged");

  run("uninstall", "grokbot", "--json");
  assert.equal(existsSync(join(cache, "gbot")), false);
  assert.equal(existsSync(join(clone, "gbot")), false);
  assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")), PSTACK_MANIFEST);
  assert.ok(existsSync(join(cache, "pstack", COMMIT, ".cache-complete")), "Grok Bot's own plugin is kept");
  assert.ok(existsSync(join(clone, "pstack")));
});

test("install grokbot --no-sideload stages only and leaves Grok Bot's folders alone", (t) => {
  const { cache, clone, manifest, run } = grokBotFixture(t);
  const installed = run("install", "grokbot", "--json", "--no-sideload");
  assert.equal(installed.state, "staged");
  assert.equal(installed.sideload.state, "skipped");
  assert.equal(existsSync(join(cache, "gbot")), false);
  assert.equal(existsSync(join(clone, "gbot")), false);
  assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")), PSTACK_MANIFEST);
});
