import test from 'node:test';
import assert from 'node:assert/strict';
import { isSecretPath, isUnsafeBoxPath, readFullTranscript, selectBoxFiles } from '../src/core/migration-capture.js';

// A transcript server that never returns more than `cap` rows, whatever limit is asked for.
function cappedServer(total, cap, { mutate } = {}) {
  let calls = 0;
  const rpc = async (_name, body) => {
    calls++;
    const before = body.beforeSeq === undefined ? total + 1 : Number(body.beforeSeq);
    const seqs = [];
    for (let s = before - 1; s >= 1 && seqs.length < Math.min(cap, body.limit); s--) seqs.push(s);
    return { generation: '7', entries: seqs.map((s) => ({ seq: String(s), entryKind: 'message', body: { role: 'user', text: mutate?.(s, calls) ?? `m${s}` } })) };
  };
  return { rpc, calls: () => calls };
}

test('a server that caps pages below the requested limit still yields every row', async () => {
  const server = cappedServer(1203, 500);
  const r = await readFullTranscript({ rpc: server.rpc, readBlobs: async () => new Map(), agentId: 'b1' });
  assert.equal(r.entries.length, 1203);
  assert.equal(r.firstSeq, 1);
  assert.equal(r.lastSeq, 1203);
  assert.deepEqual(r.gaps, []);
});

test('paging stops at an empty page when seq 1 is gone', async () => {
  const rows = [5, 4, 3, 2];
  const rpc = async (_n, body) => ({ generation: '1', entries: rows.filter((s) => body.beforeSeq === undefined || s < Number(body.beforeSeq)).map((s) => ({ seq: String(s), body: { text: 'x' } })) });
  const r = await readFullTranscript({ rpc, readBlobs: async () => new Map(), agentId: 'b1' });
  assert.equal(r.entries.length, 4);
  assert.equal(r.firstSeq, 2);
});

test('a row that changes between pages is an error, not silently kept', async () => {
  let call = 0;
  const rpc = async (_n, body) => {
    call++;
    // The second page repeats seq 3 with other content.
    if (body.beforeSeq === undefined) return { generation: '1', entries: [4, 3].map((s) => ({ seq: String(s), body: { text: 'a' + s } })) };
    return { generation: '1', entries: [{ seq: '3', body: { text: 'changed' } }, { seq: '2', body: { text: 'a2' } }] };
  };
  await assert.rejects(readFullTranscript({ rpc, readBlobs: async () => new Map(), agentId: 'b1' }), /changed during the read/);
  assert.ok(call >= 2);
});

test('credential files: more names, and the same bytes under an ordinary name', () => {
  for (const p of ['home/box/.npmrc', 'home/box/.pypirc', 'home/box/.config/rclone/rclone.conf', 'home/box/.azure/x.json', 'home/box/.pgpass', 'home/box/kubeconfig.yaml', 'home/box/vault.kdbx'])
    assert.ok(isSecretPath(p), p);
  const entries = {
    'home/box/.ssh/id_ed25519': { kind: 'file', sha: 'a'.repeat(64), size: 10 },
    'home/box/notes/key-backup.txt': { kind: 'file', sha: 'a'.repeat(64), size: 10 },
    'home/box/notes/ok.md': { kind: 'file', sha: 'b'.repeat(64), size: 10 },
    'home/box/notes/../../etc/passwd': { kind: 'file', sha: 'c'.repeat(64), size: 10 },
  };
  const picks = selectBoxFiles(entries, { agentId: 'x', referenced: ['/home/box/notes/key-backup.txt', '/home/box/notes/ok.md', '/home/box/notes/'] }).map((p) => p.path);
  assert.deepEqual(picks, ['home/box/notes/ok.md']);
  assert.ok(isUnsafeBoxPath('home/box/notes/../../etc/passwd'));
  assert.ok(isUnsafeBoxPath('/abs'));
  assert.ok(!isUnsafeBoxPath('home/box/a/b.c'));
});

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openArchive, writeArchive } from '../src/core/migration-archive.js';

const minimalCapture = (boxPath) => {
  const bytes = Buffer.from('hello');
  return { format: 'gbot-migration', version: 2, capturedAt: '2026-11-08T00:00:00.000Z', source: {}, bot: { id: 'b1', name: 'B' },
    groups: [], sessions: [], transcripts: [], automations: [], todos: [], tasks: [], serverMemories: [], serverSkills: [], connectors: [], library: [],
    files: [{ boxPath, reason: 'referenced', kind: 'file', size: 5, sha256: createHash('sha256').update(bytes).digest('hex'), mode: null, bytes }], skipped: [], coverage: {} };
};

test('hostile box paths: refused when writing, and when a tampered capture.json is opened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbot-archive-'));
  assert.throws(() => writeArchive(minimalCapture('/home/box/../../../tmp/x'), join(dir, 'bad')), /Unsafe box path/);
  const { root } = writeArchive(minimalCapture('/home/box/ok.txt'), join(dir, 'good'));
  assert.equal(openArchive(root).capture.box[0].boxPath, '/home/box/ok.txt');
  // Rewrite capture.json (and its digest) so it points the file somewhere else.
  const capPath = join(root, 'capture.json');
  const tampered = JSON.parse(readFileSync(capPath, 'utf8'));
  tampered.box[0].boxPath = '/home/box/../../etc/x';
  const bytes = Buffer.from(JSON.stringify(tampered));
  chmodSync(capPath, 0o600); writeFileSync(capPath, bytes);
  const manPath = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manPath, 'utf8'));
  const row = manifest.files.find((f) => f.path === 'capture.json');
  row.bytes = bytes.length; row.sha256 = createHash('sha256').update(bytes).digest('hex');
  chmodSync(manPath, 0o600); writeFileSync(manPath, JSON.stringify(manifest));
  assert.throws(() => openArchive(root), /Unsafe box path in capture.json/);
});

test('projects.json is read only when selection would allow it: not when its bytes are a key', () => {
  const key = { kind: 'file', sha: 'e'.repeat(64), size: 10 };
  const pj = 'home/box/sand-data/agents/b1/projects.json';
  assert.deepEqual(selectBoxFiles({ [pj]: key, 'home/box/.ssh/id_ed25519': key }, { agentId: 'b1', referenced: ['/' + pj] }), []);
  assert.ok(isSecretPath('home/box/.claude/.credentials.json'));
});
