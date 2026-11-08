import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, lstatSync, symlinkSync, linkSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureSnapshot, validateSnapshot, snapshotSummary, exportSnapshot, readArchive, planMigration, applyMigration, verifyMigration, MAX_MIGRATION_BYTES } from '../src/core/migration.js';

const now = () => new Date('2026-11-08T00:00:00.000Z');
const records = [
  { id: 'bot/../one', name: '研究員\n測試', description: 'Work only on approved tasks.', isGroup: false, memberIds: [], gatewayToken: 'never-copy-credential' },
  { id: 'room-two', name: 'Project', description: '', isGroup: true, memberIds: ['bot/../one'] },
];
const messages = [
  { id: 'm1', role: 'user', text: '測試 UTF-8 🐕', timestamp: '2026-11-07T12:00:00Z', authorization: 'never-copy-credential' },
  { id: 'm2', role: 'assistant', text: 'Recorded.', timestamp: null },
];
const workflows = [
  { id: 'skill/../one', name: '研究: "data"\n---', description: 'Use sources.', source: 'workflow', body: 'Read approved sources.\n', schedule: null, token: 'never-copy-credential' },
  { id: 'plugin-one', name: 'plugin', description: '', source: 'plugin', body: 'Do not activate me.', schedule: null },
  { id: 'routine-one', name: 'daily', description: '', source: 'automation', body: 'Notify me.', schedule: '0 9 * * *' },
  { id: 'missing-one', name: 'missing', description: '', source: 'workflow', body: null, schedule: null },
];
async function sample(options = {}) {
  return captureSnapshot({ records, transcript: async () => messages, workflows: async () => workflows, now, ...options });
}
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gbot-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function archived(t, options = {}) {
  const root = temp(t), archive = join(root, 'archive'), out = join(root, 'staged');
  const snapshot = await sample(options);
  exportSnapshot(snapshot, archive);
  return { root, archive, out, snapshot };
}
function rehash(root, path, content) {
  writeFileSync(join(root, path), content);
  const file = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const row = manifest.files.find((v) => v.path === path);
  row.bytes = Buffer.byteLength(content);
  row.sha256 = createHash('sha256').update(content).digest('hex');
  writeFileSync(file, JSON.stringify(manifest));
}

test('capture projects only allowlisted fields and labels limited coverage', async () => {
  const snapshot = await sample();
  assert.equal(JSON.stringify(snapshot).includes('never-copy-credential'), false);
  assert.equal(snapshot.source.rosterCoverage, 'returned-only');
  assert.equal(snapshot.agents[0].transcript.coverage, 'tail-only');
  assert.equal(snapshot.agents[1].workflowsCoverage, 'not-applicable');
  assert.equal(snapshotSummary(snapshot).complete, false);
  assert.equal(snapshotSummary(snapshot).counts.messages, 4);
  assert.equal(snapshotSummary(snapshot).counts.missingWorkflowBodies, 1);
});
test('capture calls each bot workflow reader separately, not group reader', async () => {
  const seen = [];
  await sample({ records: [...records, { ...records[0], id: 'another' }], workflows: async (id) => { seen.push(id); return []; } });
  assert.deepEqual(seen, ['bot/../one', 'another']);
});
test('capture retains useful data after independent read failures without leaking errors', async (t) => {
  const snapshot = await sample({ transcript: async (id) => { if (id === records[0].id) throw Error('token=private-value'); return messages; } });
  assert.equal(snapshot.agents[0].transcript.coverage, 'unavailable');
  assert.equal(snapshot.agents[1].transcript.messages.length, 2);
  assert.equal(snapshot.agents[0].workflows.length, 4);
  assert.equal(JSON.stringify(snapshot).includes('private-value'), false);
  assert.deepEqual(snapshot.errors, [{ agentId: records[0].id, area: 'transcript', code: 'READ_FAILED' }]);
  const path = join(temp(t), 'partial');
  assert.equal(exportSnapshot(snapshot, path).exitCode, 3);
  assert.equal(verifyMigration(path).exitCode, 3);
  assert.throws(() => applyMigration(path, { out: path + '-out', yes: true }), /failed reads/);
});
test('file-only capture never calls remote readers', async () => {
  const noRead = async () => { throw Error('must not call'); };
  const snapshot = await sample({ mode: 'files', transcript: noRead, workflows: noRead });
  assert.equal(snapshot.agents[0].workflowsCoverage, 'unavailable');
  assert.equal(snapshot.errors.length, 0);
});
for (const bad of [null, {}, [{ id: 'x', role: 'system', text: 'x' }], Array(201).fill(messages[0])]) {
  test('invalid transcript shape is a visible failed item: ' + JSON.stringify(bad).slice(0, 60), async () => {
    const snapshot = await sample({ transcript: async () => bad });
    assert.equal(snapshot.errors.filter((e) => e.code === 'INVALID_DATA').length, 2);
    assert.equal(snapshot.agents[0].transcript.messages.length, 0);
  });
}
for (const bad of [null, {}, [null], [{ ...workflows[0], body: {} }], [workflows[0], workflows[0]]]) {
  test('invalid workflow shape cannot be exported as success: ' + JSON.stringify(bad).slice(0, 60), async () => {
    const snapshot = await sample({ workflows: async () => bad });
    assert.equal(snapshot.errors[0].code, 'INVALID_DATA');
    assert.equal(snapshot.agents[0].workflowsCoverage, 'unavailable');
  });
}
test('duplicate identities fail before remote reads', async () => {
  let called = false;
  await assert.rejects(sample({ records: [records[0], records[0]], transcript: async () => { called = true; return []; } }), /duplicate/);
  assert.equal(called, false);
});
for (const limit of [0, 201, 1.5, NaN]) test('capture rejects invalid limit ' + limit, async () => {
  await assert.rejects(sample({ limit }), /Invalid capture/);
});

test('archive round trip preserves UTF-8, identities and exact instructions', async (t) => {
  const { archive, snapshot } = await archived(t);
  assert.deepEqual(readArchive(archive).snapshot, snapshot);
  assert.equal(verifyMigration(archive).verified, true);
  assert.equal(verifyMigration(archive).runtimeVerified, false);
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(archive).mode & 0o777, 0o700);
    for (const path of readdirSync(archive)) assert.equal(lstatSync(join(archive, path)).mode & 0o777, 0o600);
  }
});
test('plan is deterministic and read-only; apply verifies every generated file', async (t) => {
  const { root, archive, out } = await archived(t);
  const before = readdirSync(root);
  const plan = planMigration(archive);
  assert.deepEqual(planMigration(archive), plan);
  assert.deepEqual(readdirSync(root), before);
  assert.equal(plan.runtimeActivated, false);
  assert.equal(plan.files.some((f) => f.path.includes('/skills/')), false);
  assert.equal(applyMigration(archive, { out, yes: true }).verified, true);
  assert.equal(verifyMigration(archive, { out }).scope, 'staged-file-integrity');
  for (const row of plan.files) {
    const content = readFileSync(join(out, row.path));
    assert.equal(content.length, row.bytes);
    assert.equal(createHash('sha256').update(content).digest('hex'), row.sha256);
    assert.equal(row.path.includes('..'), false);
    assert.equal(row.path.includes('研究'), false);
  }
});
test('explicit skills option stages only user workflows with valid bodies', async (t) => {
  const { archive, out } = await archived(t);
  const plan = planMigration(archive, { includeSkills: true });
  const skills = plan.files.filter((f) => f.path.endsWith('/SKILL.md'));
  assert.equal(skills.length, 1);
  applyMigration(archive, { out, includeSkills: true, yes: true });
  const content = readFileSync(join(out, skills[0].path), 'utf8');
  assert.match(content, /^---\nname: "grok-[a-f0-9]{24}"\ndescription: "/);
  assert.match(content, /Read approved sources/);
  assert.equal(verifyMigration(archive, { out }).verified, true);
});
test('identical source skill names do not overwrite different IDs', async (t) => {
  const { archive } = await archived(t, { workflows: async () => [workflows[0], { ...workflows[0], id: 'second-id' }] });
  assert.equal(planMigration(archive, { includeSkills: true }).files.filter((f) => f.path.endsWith('/SKILL.md')).length, 2);
});
test('apply refuses without confirmation before reading an archive', () => {
  assert.throws(() => applyMigration('/does/not/exist', { out: '/also/missing' }), /requires --yes/);
});
test('apply refuses a group-only export', async (t) => {
  const { archive, out } = await archived(t, { records: [records[1]] });
  assert.throws(() => applyMigration(archive, { out, yes: true }), /no bots/);
});
for (const to of ['hermes', '', '../openclaw']) test('unsupported target fails closed: ' + to, async (t) => {
  const { archive } = await archived(t);
  assert.throws(() => planMigration(archive, { to }), /Only/);
});
test('archive and destination are create-only, including empty directories', async (t) => {
  const { archive, out, snapshot } = await archived(t);
  const original = readFileSync(join(archive, 'snapshot.json'));
  assert.throws(() => exportSnapshot(snapshot, archive), /EEXIST/);
  assert.deepEqual(readFileSync(join(archive, 'snapshot.json')), original);
  mkdirSync(out);
  assert.throws(() => applyMigration(archive, { out, yes: true }), /EEXIST/);
  assert.deepEqual(readdirSync(out), []);
});
test('repeating apply does not overwrite modified destination files', async (t) => {
  const { archive, out } = await archived(t);
  applyMigration(archive, { out, yes: true });
  writeFileSync(join(out, 'REPORT.md'), 'operator data');
  assert.throws(() => applyMigration(archive, { out, yes: true }), /EEXIST/);
  assert.equal(readFileSync(join(out, 'REPORT.md'), 'utf8'), 'operator data');
});
test('archive byte tampering is detected', async (t) => {
  const { archive } = await archived(t);
  writeFileSync(join(archive, 'snapshot.json'), '{}');
  assert.throws(() => readArchive(archive), /checksum/);
});
test('staging byte tampering is detected', async (t) => {
  const { archive, out } = await archived(t);
  applyMigration(archive, { out, yes: true });
  writeFileSync(join(out, 'REPORT.md'), 'altered');
  assert.throws(() => verifyMigration(archive, { out }), /checksum/);
});
test('recomputing a destination checksum cannot hide a different conversion', async (t) => {
  const { archive, out } = await archived(t);
  applyMigration(archive, { out, yes: true });
  rehash(out, 'REPORT.md', 'false migration report');
  assert.throws(() => verifyMigration(archive, { out }), /differs from source/);
});
for (const path of ['../outside', '/tmp/outside', 'C:\\outside', 'bots/../../outside', 'bots//bad', 'bots/CON/data', '__proto__']) {
  test('hostile manifest path rejected: ' + path, async (t) => {
    const { archive } = await archived(t);
    const file = join(archive, 'manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.files[0].path = path;
    writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => readArchive(archive), /Invalid migration file index/);
  });
}
for (const change of [
  (s) => { s.version = 2; },
  (s) => { s.accessToken = 'not-allowed'; },
  (s) => { s.source.rosterCoverage = 'complete'; },
  (s) => { s.agents[0].transcript.coverage = 'complete'; },
  (s) => { s.agents[0].workflows[0].token = 'not-allowed'; },
  (s) => { s.agents[0].transcript.messages[0].cookie = 'not-allowed'; },
]) test('modified unsupported archive schema fails closed: ' + change.toString().slice(9, 60), async (t) => {
  const { archive, snapshot } = await archived(t);
  change(snapshot);
  rehash(archive, 'snapshot.json', JSON.stringify(snapshot));
  assert.throws(() => readArchive(archive), /Invalid|Unsupported/);
});
test('extra active skill cannot hide outside the manifest', async (t) => {
  const { archive, out } = await archived(t);
  applyMigration(archive, { out, yes: true });
  mkdirSync(join(out, 'unexpected'));
  writeFileSync(join(out, 'unexpected', 'SKILL.md'), 'malicious');
  assert.throws(() => verifyMigration(archive, { out }), /Unexpected directory/);
});
test('extra archive file is not silently trusted', async (t) => {
  const { archive } = await archived(t);
  writeFileSync(join(archive, 'credentials.json'), '{}');
  assert.throws(() => readArchive(archive), /Unexpected file/);
});
for (const kind of ['archive', 'staging']) test('interrupted publication without manifest is refused: ' + kind, async (t) => {
  const { archive, out } = await archived(t);
  if (kind === 'staging') applyMigration(archive, { out, yes: true });
  rmSync(join(kind === 'archive' ? archive : out, 'manifest.json'));
  assert.throws(() => verifyMigration(archive, kind === 'staging' ? { out } : {}), /ENOENT/);
});
test('oversized archive file is rejected before unbounded reading', async (t) => {
  const { archive } = await archived(t);
  truncateSync(join(archive, 'snapshot.json'), MAX_MIGRATION_BYTES + 1);
  assert.throws(() => readArchive(archive), /oversized/);
});
test('a directory is not accepted as an archive data file', async (t) => {
  const { archive } = await archived(t);
  rmSync(join(archive, 'snapshot.json'));
  mkdirSync(join(archive, 'snapshot.json'));
  assert.throws(() => readArchive(archive), /regular/);
});
test('symlink source, destination and data files are refused', { skip: process.platform === 'win32' ? 'Creating symlinks requires Windows privileges' : false }, async (t) => {
  const { root, archive, out } = await archived(t);
  const alias = join(root, 'alias');
  symlinkSync(archive, alias, 'dir');
  assert.throws(() => readArchive(alias), /symlink/);
  symlinkSync(archive, out, 'dir');
  assert.throws(() => applyMigration(archive, { out, yes: true }), /EEXIST/);
  const outside = join(root, 'outside.json');
  writeFileSync(outside, '{}');
  rmSync(join(archive, 'snapshot.json'));
  symlinkSync(outside, join(archive, 'snapshot.json'));
  assert.throws(() => readArchive(archive), /regular/);
  assert.equal(readFileSync(outside, 'utf8'), '{}');
});
test('hardlinked data is refused', async (t) => {
  const { root, archive } = await archived(t);
  linkSync(join(archive, 'snapshot.json'), join(root, 'second-link'));
  assert.throws(() => readArchive(archive), /regular/);
});
test('UTF-8 decoding errors cannot become silently changed source text', async (t) => {
  const { archive } = await archived(t);
  const file = join(archive, 'manifest.json');
  writeFileSync(file, Buffer.from([123, 255, 125]));
  assert.throws(() => readArchive(archive), /UTF-8/);
});
