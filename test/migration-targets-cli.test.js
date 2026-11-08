import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSnapshot, exportSnapshot, applyMigration, verifyMigration } from '../src/core/migration.js';
import { MIGRATION_TARGETS } from '../src/core/migration-targets.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gbot-multi-target-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, 'archive');
  const snapshot = await captureSnapshot({ mode: 'files', records: [
    { id: 'b1', name: 'Same name', description: 'Inspect approved material. 漢字🐕', isGroup: false, memberIds: [] },
    { id: 'b2', name: 'Same name', description: 'Write only the selected report.', isGroup: false, memberIds: [] },
  ], now: () => new Date('2026-11-08T00:00:00.000Z') });
  exportSnapshot(snapshot, archive);
  const env = { ...process.env, HOME: root, USERPROFILE: root, GBOT_AUTO_WAKE: '0',
    CURSOR_ACCESS_TOKEN: '', GBOT_ACCOUNT: '', GBOT_ACCOUNT_SCOPE: '', GBOT_CONFIG: '',
    GROK_BOT_GATEWAY_URL: '', GROK_BOT_GATEWAY_TOKEN: '' };
  const run = (args) => {
    const result = spawnSync(process.execPath, [join(repo, 'bin/gbot.mjs'), '--json', 'migrate', ...args],
      { cwd: repo, env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  return { root, archive, run };
}

test('public CLI lists target capabilities without a source login', async (t) => {
  const { run } = await fixture(t);
  const result = run(['targets']);
  assert.deepEqual(result.targets.map((row) => row.target), [...MIGRATION_TARGETS]);
  assert.equal(result.targets.find((row) => row.target === 'muse').automaticDelivery, false);
});
for (const to of MIGRATION_TARGETS) test('public CLI plan/apply/verify: ' + to, { timeout: 90000 }, async (t) => {
  const { root, archive, run } = await fixture(t);
  const before = readFileSync(join(archive, 'snapshot.json'));
  const out = join(root, to);
  const plan = run(['plan', archive, '--to', to, '--include-skills']);
  assert.equal(plan.target, to);
  assert.equal(plan.complete, false);
  assert.equal(plan.memoryRestored, false);
  assert.equal(run(['apply', archive, '--to', to, '--out', out, '--include-skills', '--yes']).verified, true);
  const verified = run(['verify', archive, '--out', out]);
  assert.equal(verified.target, to);
  assert.equal(verified.runtimeVerified, false);
  assert.deepEqual(readFileSync(join(archive, 'snapshot.json')), before);
  assert.deepEqual(readdirSync(archive).sort(), ['REPORT.md', 'manifest.json', 'snapshot.json']);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, `gbot-${to}-staging`);
  assert.deepEqual(Object.keys(manifest), ['format', 'version', 'sourceDigest', 'includeSkills', 'files']);
});
for (const to of ['hermes', 'muse', 'dot', 'portable']) test('target identity tampering is rejected: ' + to, async (t) => {
  const { root, archive } = await fixture(t);
  const out = join(root, to);
  applyMigration(archive, { to, out, yes: true });
  const path = join(out, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.format = to === 'dot' ? 'gbot-muse-staging' : 'gbot-dot-staging';
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => verifyMigration(archive, { out }), /Invalid|differs|Unexpected/);
});
