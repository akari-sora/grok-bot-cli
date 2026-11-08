import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureSnapshot, exportSnapshot, applyMigration, verifyMigration } from '../src/core/migration.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gbot-migration-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, 'archive');
  const snapshot = await captureSnapshot({
    records: [{ id: 'one', name: 'Example', isGroup: false, memberIds: [] }], mode: 'files',
    now: () => new Date('2026-11-08T00:00:00.000Z'),
  });
  exportSnapshot(snapshot, archive);
  const before = new Map(readdirSync(archive).map((name) => [name, readFileSync(join(archive, name))]));
  const unchanged = () => {
    assert.deepEqual(readdirSync(archive), [...before.keys()]);
    for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(archive, name)), bytes);
    assert.equal(verifyMigration(archive).verified, true);
  };
  return { root, archive, unchanged };
}

test('nested staging destination is rejected before changing the source archive', async (t) => {
  const { archive, unchanged } = await fixture(t);
  assert.throws(() => applyMigration(archive, { out: join(archive, 'staged'), yes: true }), /outside the source archive/);
  unchanged();
});

test('source and destination cannot be the same archive', async (t) => {
  const { archive, unchanged } = await fixture(t);
  assert.throws(() => applyMigration(archive, { out: archive, yes: true }), /outside the source archive/);
  unchanged();
});

test('symlinked ancestor cannot hide an output nested inside the archive', { skip: process.platform === 'win32' ? 'Creating symlinks requires Windows privileges' : false }, async (t) => {
  const { root, archive, unchanged } = await fixture(t);
  const alias = join(root, 'alias');
  symlinkSync(root, alias, 'dir');
  const out = join(alias, 'archive', 'staged');
  assert.throws(() => applyMigration(archive, { out, yes: true }), /outside the source archive/);
  unchanged();
});
