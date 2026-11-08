import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertStoreUrl, captureBot, fetchStoreBytes, isSecretPath, normalizeAutomation, normalizeEntry, readFullTranscript,
  referencedBoxPaths, selectBoxFiles,
} from '../src/core/migration-capture.js';
import { archivePathFor, openArchive, writeArchive } from '../src/core/migration-archive.js';
import { acceptanceQuestions, buildHermesPlan, distinctiveTokens, groupNotMigrated, memoryEntries, profileNameFor, skillDescription } from '../src/core/migration-hermes.js';
import { brokenUnits, buildTrinityPlan, digestVerdict, trinityOptions } from '../src/core/migration-trinity.js';
import { inflateRawSync } from 'node:zlib';
import { hasSecret } from '../src/core/migration-redact.js';
import { redactSecrets } from '../src/core/migration-redact.js';
import { checkMigration, importMigration, previewMigration, resolveBot } from '../src/core/migration-flow.js';
import { coverageText, importText } from '../src/core/migration-text.js';
import { BACKEND_READ_RPCS, backendRead } from '../src/core/gateway.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const BOT = 'bbbbbbbb-1111-2222-3333-444444444444';
const FAKE_PAT = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

// --- a fake Grok Bot backend + box store -------------------------------------------------------
function world({ rows = 1203, omitEvery = 0, changeGenerationAt = 0, unreadable = [] } = {}) {
  const blobs = new Map();
  const put = (bytes) => { const h = sha(bytes); blobs.set(h, bytes); return h; };
  const entries = [];
  for (let seq = 1; seq <= rows; seq++) {
    if (seq % 50 === 0) continue; // server-deleted rows leave gaps
    const body = seq % 2
      ? { kind: 'message', id: 'u' + seq, role: 'user', content: `request #${seq}` + (seq === 7 ? ' token ' + FAKE_PAT : ''), timestampMs: 1790000000000 + seq }
      : { kind: 'send-message', id: 's' + seq, message: { type: 'text', content: `reply ${seq}` }, timestampMs: 1790000000000 + seq };
    const raw = Buffer.from(JSON.stringify(body));
    if (omitEvery && seq % omitEvery === 0) entries.push({ seq: String(seq), entryKind: body.kind, blobHash: put(raw), bodyOmitted: true });
    else entries.push({ seq: String(seq), entryKind: body.kind, body: raw.toString('base64'), entryId: body.id });
  }
  const box = {
    [`home/box/sand-data/agents/${BOT}/memory/profile.md`]: '# About the user\n<!-- c -->\n- (2026-09-14) The user handle is ImL1s.\n- (2026-09-15) Prefers GitLab repo aa22396584/telltale.\n',
    [`home/box/sand-data/agents/${BOT}/memory/log/2026-10.md`]: '# Memory log\n- (2026-10-02) Scan script lives at /home/box/bin/scan-tool.\n',
    'home/box/sand-data/user-memory/by-agent/other-bot/profile.md': '- (2026-09-20) Shared: user timezone Asia/Taipei.\n',
    'home/box/sand-data/workflows/ci-fixer/SKILL.md': '---\nname: ci-fixer\ndescription: >-\n  Use when a pipeline7 job is red.\n---\n# CI fixer\nSteps.\n',
    'home/box/sand-data/workflows/ci-fixer/run.sh': '#!/bin/sh\necho fix\n',
    'home/box/bin/scan-tool': '#!/usr/bin/env python3\nPROJECTS = ["proj-alpha9"]\n',
    'home/box/.secrets/gitlab.env': 'GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx\n',
    'home/box/sand-data/box-secrets.json': '{}',
  };
  const manifest = { version: 2, updatedAtMs: 1794000000000, entries: {} };
  for (const [p, text] of Object.entries(box)) {
    const bytes = Buffer.from(text);
    // An `unreadable` path is listed in the manifest, but its blob does not match the digest.
    const digest = unreadable.includes(p) ? sha(bytes) : put(bytes);
    if (unreadable.includes(p)) blobs.set(digest, Buffer.from('not these bytes'));
    manifest.entries[p] = { kind: 'file', sha: digest, size: bytes.length, mode: p.includes('/bin/') || p.endsWith('.sh') ? 493 : 420 };
  }
  manifest.entries['home/box/link'] = { kind: 'symlink', target: '/elsewhere' };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  let generationCalls = 0;
  const calls = [];
  const rpc = async (name, body) => {
    calls.push(name);
    assert.ok(BACKEND_READ_RPCS.includes(name), 'only read RPCs: ' + name);
    switch (name) {
      case 'ListGrokBotAgents': return { agents: [
        { agentId: BOT, name: 'Deploy QA · Watch & merge', description: 'Watch aa22396584/telltale and merge green MRs. Key ' + FAKE_PAT, kind: 'GROK_BOT_AGENT_KIND_AGENT', harness: 'temporal' },
        { agentId: 'room-1', name: 'Ops room', kind: 'GROK_BOT_AGENT_KIND_ROOM', memberAgentIds: [BOT, 'peer'] },
        { agentId: 'peer', name: 'Peer', kind: 'GROK_BOT_AGENT_KIND_AGENT' },
      ] };
      case 'ListGrokBotTranscriptEntries': {
        generationCalls++;
        const before = body.beforeSeq ? Number(body.beforeSeq) : Infinity;
        const page = entries.filter((e) => Number(e.seq) < before).slice(-body.limit);
        const generation = changeGenerationAt && generationCalls >= changeGenerationAt ? 2 : 1;
        return { entries: page, generation };
      }
      case 'ListGrokBotAgentAutomations': return { automations: [
        { recordJson: JSON.stringify({ id: 'a1', name: 'Hourly scan', prompt: 'Run /home/box/bin/scan-tool --merge (login in ~/.secrets/gitlab.env)', trigger: { type: 'cron', schedule: 'CRON_TZ=Asia/Taipei 52 9-21 * * 1-5' }, isEnabled: false, triggerDescription: 'hourly' }) },
        { recordJson: JSON.stringify({ id: 'a2', name: 'On PR', prompt: 'Review the PR', trigger: { type: 'group', listeners: [{ type: 'github', repo: 'x/y', events: ['pr-opened'] }] }, isEnabled: true }) },
      ] };
      case 'ListGrokBotAgentRoutines': throw new Error('ListGrokBotAgentRoutines failed: 404 not_found');
      case 'ListGrokBotAgentTodos': return { todos: [
        { id: 't1', content: 'After user undrafts !65: squash-merge', status: 'TODO_STATUS_PENDING' },
        { id: 't2', content: 'old', status: 'TODO_STATUS_COMPLETED' },
      ] };
      case 'ListGrokBotUserBotMemories': throw new Error('403 permission_denied');
      case 'PresignSandBoxStoreReads': return { instructions: body.relPaths.map((relPath) => ({ relPath, url: 'http://127.0.0.1/store/' + relPath })) };
      default: return {};
    }
  };
  const fetchImpl = async (url, opts = {}) => {
    const rel = new URL(url).pathname.replace(/^\/store\//, '');
    const bytes = rel === 'manifest.json' ? manifestBytes : blobs.get(rel.replace(/^blobs\//, ''));
    if (!bytes) return new Response(null, { status: 404 });
    const range = /bytes=(\d+)-(\d+)/.exec(opts.headers?.Range ?? '');
    if (range) {
      const [a, b] = [Number(range[1]), Math.min(Number(range[2]), bytes.length - 1)];
      return new Response(bytes.subarray(a, b + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${bytes.length}`, etag: '"m1"' } });
    }
    return new Response(bytes, { status: 200 });
  };
  const io = {
    rpc, fetchImpl,
    presignMany: async (paths) => new Map(paths.map((p) => [p, 'http://127.0.0.1/store/' + p])),
    presign: async (p) => 'http://127.0.0.1/store/' + p,
  };
  return { io, calls, rows: entries.length };
}

test('the migration source may only call allowlisted read RPCs', async () => {
  await assert.rejects(backendRead({}, 'SendGrokBotUserMessage', {}), /not a read-only migration RPC/);
  await assert.rejects(backendRead({}, 'DeleteGrokBotAgent', {}), /not a read-only/);
  for (const rpc of BACKEND_READ_RPCS) assert.doesNotMatch(rpc, /^(Send|Delete|Update|Create|Set|Put|Mark|Dismiss|Commit|Presign.*Write|Begin|Finish|Activate)/);
});

test('store URLs: only the presigned store host, or loopback in tests', () => {
  assert.throws(() => assertStoreUrl('https://evil.example.com/x', {}), /unexpected host/);
  assert.throws(() => assertStoreUrl('http://sand-box-stores.s3.us-east-1.amazonaws.com/x', {}), /unexpected host/);
  assert.ok(assertStoreUrl('https://sand-box-stores.s3.us-east-1.amazonaws.com/a?sig=1', {}));
  assert.throws(() => assertStoreUrl('https://sand-box-stores.s3.us-east-1.amazonaws.com/x', { GROK_BOT_TEST: '1' }), /loopback/);
  // Template recipes (GetGrokBotTemplateVersion) are read from their own bucket, and only from it.
  assert.ok(assertStoreUrl('https://grok-bot-templates.s3.us-east-1.amazonaws.com/r?sig=1', {}, 'grok-bot-templates'));
  assert.throws(() => assertStoreUrl('https://grok-bot-templates.s3.us-east-1.amazonaws.com/r', {}), /unexpected host/);
  assert.throws(() => assertStoreUrl('https://sand-box-stores.s3.us-east-1.amazonaws.com/r', {}, 'grok-bot-templates'), /unexpected host/);
});

test('fetchStoreBytes enforces the byte cap', async () => {
  const fetchImpl = async () => new Response(Buffer.alloc(100), { status: 200 });
  await assert.rejects(fetchStoreBytes('http://127.0.0.1/x', { cap: 10, fetchImpl }), /budget/);
});

test('full transcript: every page, omitted bodies from blobs, gaps reported, beyond 500 rows', async () => {
  const w = world({ rows: 1203, omitEvery: 7 });
  const t = await readFullTranscript({ rpc: w.io.rpc, agentId: BOT, readBlobs: async (hashes) => {
    const out = new Map();
    for (const h of hashes) { const r = await w.io.fetchImpl('http://127.0.0.1/store/blobs/' + h); out.set(h, Buffer.from(await r.arrayBuffer())); }
    return out;
  } });
  assert.equal(t.entries.length, w.rows);
  assert.ok(t.pages >= 3);
  assert.equal(t.unreadable, 0);
  assert.equal(t.firstSeq, 1);
  assert.equal(t.lastSeq, 1203);
  assert.equal(t.gaps.length, 24);
  assert.deepEqual(t.entries.map((e) => e.message.seq), [...t.entries.map((e) => e.message.seq)].sort((a, b) => a - b));
  assert.equal(t.entries.find((e) => e.message.seq === 14).message.text, 'reply 14');
});

test('a transcript that changes generation mid-read is refused, not silently mixed', async () => {
  const w = world({ rows: 1200, changeGenerationAt: 2 });
  await assert.rejects(readFullTranscript({ rpc: w.io.rpc, agentId: BOT, readBlobs: async () => new Map() }), /changed generation/);
});

test('entries normalize user, assistant send-message and events', () => {
  assert.equal(normalizeEntry({ seq: '3', entryKind: 'message' }, { role: 'user', content: 'hi', timestampMs: 5 }).role, 'user');
  assert.equal(normalizeEntry({ seq: '4', entryKind: 'send-message' }, { message: { type: 'text', content: 'yo' } }).text, 'yo');
  assert.equal(normalizeEntry({ seq: '5', entryKind: 'event' }, { event: { type: 'x' } }).role, 'event');
});

test('automations: cron with CRON_TZ splits zone, listeners stay event triggers', () => {
  const a = normalizeAutomation({ id: 'a', name: 'n', prompt: 'p', trigger: { type: 'cron', schedule: 'CRON_TZ=Asia/Taipei 0 9 * * 1-5' }, isEnabled: false });
  assert.deepEqual([a.trigger, a.scheduleCron, a.timezone, a.enabled], ['schedule', '0 9 * * 1-5', 'Asia/Taipei', false]);
  const e = normalizeAutomation({ id: 'b', name: 'n', prompt: 'p', trigger: { type: 'group', listeners: [{ type: 'github' }] }, isEnabled: true });
  assert.equal(e.trigger, 'github');
  assert.equal(e.scheduleCron, '');
});

test('credential paths are never selected, even when a prompt names them', () => {
  for (const p of ['home/box/.secrets/a.env', 'home/box/.config/glab-cli/config.yml', 'home/box/sand-data/box-secrets.json', 'home/box/.ssh/id_ed25519', 'x/api-token.txt', 'home/box/.aws/credentials'])
    assert.ok(isSecretPath(p), p);
  assert.ok(!isSecretPath('home/box/bin/deploy-qa-scan'));
  const refs = referencedBoxPaths(['run ~/.secrets/x.env and /home/box/bin/tool and /workspace/notes/a.md', '/home/box/a/../b']);
  assert.deepEqual(refs, ['/home/box/.secrets/x.env', '/home/box/bin/tool', '/workspace/notes/a.md']);
  const entries = { 'home/box/.secrets/x.env': { kind: 'file', sha: 'a'.repeat(64), size: 1 }, 'home/box/bin/tool': { kind: 'file', sha: 'b'.repeat(64), size: 1 } };
  assert.deepEqual(selectBoxFiles(entries, { agentId: 'q', referenced: refs }).map((p) => p.path), ['home/box/bin/tool']);
});

test('captureBot reads everything, records gaps and writes a verifiable archive', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gbot-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const w = world({ rows: 620, omitEvery: 9 });
  const cap = await captureBot(w.io, { agentId: BOT, timeZone: 'Asia/Taipei', now: () => new Date('2026-11-08T00:00:00Z') });
  assert.equal(cap.coverage.transcript.status, 'complete');
  assert.equal(cap.coverage.transcript.rows, w.rows);
  assert.equal(cap.coverage.serverMemories.status, 'unavailable');
  assert.equal(cap.coverage.routines.status, 'not-applicable');
  assert.equal(cap.groups[0].name, 'Ops room');
  const paths = cap.files.map((f) => f.boxPath);
  assert.ok(paths.includes('/home/box/bin/scan-tool'), 'script named by a routine and by memory');
  assert.ok(paths.includes('/home/box/sand-data/user-memory/by-agent/other-bot/profile.md'), 'shared user memory of other bots');
  assert.ok(paths.includes('/home/box/sand-data/workflows/ci-fixer/run.sh'), 'whole skill folder');
  assert.ok(!paths.some((p) => /secrets/.test(p)));
  assert.ok(cap.skipped.some((s) => s.boxPath === '/home/box/.secrets/gitlab.env' && /credential/.test(s.reason)), 'a credential path a routine names is reported');
  assert.ok(!w.calls.some((c) => /Send|Update|Delete|Create/.test(c)));

  const { root, manifest } = writeArchive(cap, join(dir, 'archive'));
  assert.ok(manifest.files.length > 5);
  const a = openArchive(root);
  assert.equal(a.capture.bot.id, BOT);
  assert.equal(a.transcript(a.capture.transcripts[0]).length, w.rows);
  // Tamper with one captured file: the archive no longer opens.
  const row = manifest.files.find((f) => f.path.endsWith('scan-tool'));
  writeFileSync(join(root, ...row.path.split('/')), 'tampered', { flag: 'r+' });
  assert.throws(() => openArchive(root), /checksum mismatch/);
  assert.throws(() => writeArchive(cap, join(dir, 'archive')), /EEXIST/);
});

async function sampleArchive(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gbot-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const w = world({ rows: 80 });
  const cap = await captureBot(w.io, { agentId: BOT, now: () => new Date('2026-11-08T00:00:00Z') });
  return openArchive(writeArchive(cap, join(dir, 'a')).root);
}

test('Hermes plan: role, user facts incl. shared shards, open tasks, paused cron, history, secrets redacted', async (t) => {
  const a = await sampleArchive(t);
  const plan = buildHermesPlan(a, { profileDir: '/tmp/hermes/profiles/grok-deploy-qa', now: () => new Date('2026-11-08T00:00:00Z') });
  assert.equal(plan.profile, 'grok-deploy-qa');
  assert.match(plan.soul, /You are Deploy QA/);
  assert.doesNotMatch(JSON.stringify({ ...plan, docs: undefined, files: undefined, skills: undefined }), /ghp_/);
  assert.ok(plan.redactedSecrets >= 2);
  assert.ok(plan.user.some((u) => u.includes('Asia/Taipei')), 'shared user memory from another bot');
  assert.ok(plan.memory.some((m) => m.startsWith('Open task carried over') && m.includes('!65')));
  assert.equal(plan.cron.length, 1);
  assert.equal(plan.cron[0].paused, true);
  assert.equal(plan.cron[0].timezone, 'Asia/Taipei');
  assert.deepEqual(plan.unscheduled, ['On PR']);
  assert.equal(plan.history[0].messages.length, 80 - 1);
  assert.ok(plan.history[0].messages.every((m) => !m.content.includes('ghp_')));
  assert.equal(plan.skills.length, 1);
  assert.ok(plan.notMigrated.some((n) => /group chat "Ops room"/.test(n.item)));
  const qs = acceptanceQuestions(a, plan);
  assert.deepEqual(qs.map((q) => q.area), ['role', 'user-facts', 'schedules', 'open-tasks', 'history', 'skills', 'files']);
  assert.ok(qs.find((q) => q.area === 'skills').expect[0].includes('pipeline7'));
});

test('keywords skip dates, URLs and common product names; YAML folded descriptions parse', () => {
  assert.deepEqual(distinctiveTokens('Watch GitLab repo aa22396584/telltale; see https://x.example/zz9 on 2026-10-16T21:54:00+08:00'), ['aa22396584']);
  assert.deepEqual(distinctiveTokens('After user undrafts !65: squash-merge and use the built-in connector for deploy-qa-scan'), ['!65', 'deploy-qa-scan']);
  assert.equal(skillDescription('---\nname: a\ndescription: |\n  line one\n  line two\nx: 1\n---'), 'line one line two');
  assert.deepEqual(memoryEntries('# h\n<!-- note -->\n- a\n- b\n'), ['a', 'b']);
  assert.equal(profileNameFor({ name: '醫美雷達', id: '83f9be4d-aaaa' }), 'grok-83f9be4d');
});

test('secret redaction covers provider token formats', () => {
  const r = redactSecrets(`x ${FAKE_PAT} glpat-abcdefghijklmnopqrst sk-ant-abcdefghijklmnop1234 AKIAABCDEFGHIJKLMNOP Bearer abcdefghijklmnopqrstuvwxyz123 1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789a`);
  assert.equal(r.count, 6);
  assert.doesNotMatch(r.text, /ghp_|glpat-|sk-ant|AKIA|Bearer a/);
  // Inside JSON a newline is the two characters \n: the token follows the letter n.
  const json = redactSecrets(JSON.stringify({ text: '[t0u]\n' + FAKE_PAT + '\nok', other: 'task-abcdefghijklmnopqrstuv' }));
  assert.equal(json.count, 1);
  assert.match(json.text, /task-abcdefghijklmnopqrstuv/);
});

test('bot selection by id, full name, short name; ambiguity is an error', () => {
  const agents = [{ agentId: 'a', name: 'Deploy QA · Watch & merge' }, { agentId: 'b', name: 'Main' }, { agentId: 'c', name: 'Main' }, { agentId: 'r', name: 'Room', kind: 'GROK_BOT_AGENT_KIND_ROOM' }];
  assert.equal(resolveBot(agents, 'deploy qa').agentId, 'a');
  assert.equal(resolveBot(agents, 'A').agentId, 'a');
  assert.throws(() => resolveBot(agents, 'main'), /Several bots/);
  assert.throws(() => resolveBot(agents, 'room'), /No bot named/);
});

test('archive paths are safe even for hostile box names', () => {
  for (const p of ['/home/box/../etc/passwd', '/home/box/a b/c?d', '/home/box/' + 'x'.repeat(300)]) {
    const out = archivePathFor(p);
    assert.match(out, /^box\//);
    assert.ok(!out.includes('..'));
  }
});

test('wizard: only `gbot migrate` or `gbot migrate wizard` starts it; choices parse strictly', async () => {
  const { migrateWizardRequested, parseChoice } = await import('../bin/gbot.mjs');
  assert.ok(migrateWizardRequested(['migrate']));
  assert.ok(migrateWizardRequested(['migrate', 'wizard']));
  assert.ok(!migrateWizardRequested(['migrate', 'bots']));
  assert.ok(!migrateWizardRequested(['send', 'migrate']));
  assert.ok(!migrateWizardRequested(['migrate', '--json']), 'machine output never starts the guided flow');
  assert.deepEqual(parseChoice('2', 3), [1]);
  assert.deepEqual(parseChoice('1,3', 3, { multiple: true }), [0, 2]);
  assert.deepEqual(parseChoice('2-3', 3, { multiple: true }), [1, 2]);
  assert.deepEqual(parseChoice('all', 2, { multiple: true }), [0, 1]);
  for (const bad of ['', '0', '4', '1,2', 'x', '1.5']) assert.equal(parseChoice(bad, 3), null, bad);
});

test('not-migrated lines are grouped for the terminal', () => {
  const grouped = groupNotMigrated([
    { item: '/home/box/a', reason: 'larger than 8 bytes (41943040)', alternative: 'x' },
    { item: '/home/box/b', reason: 'larger than 8 bytes (100)', alternative: 'x' },
    { item: '/home/box/.secrets/t', reason: 'credential path; never exported', alternative: 'y' },
    { item: 'routine "a"', reason: 'event trigger (github)', alternative: 'z' },
  ]);
  assert.equal(grouped.length, 3);
  assert.match(grouped.find((g) => /large/.test(g.item)).item, /2 large file\(s\), up to 40 MiB/);
});


/** The entries of a zip written by migration-zip.js (stored or deflated, no data descriptors). */
function unzip(buf) {
  const out = new Map();
  for (let at = 0; buf.readUInt32LE(at) === 0x04034b50;) {
    const method = buf.readUInt16LE(at + 8), size = buf.readUInt32LE(at + 18), nameLen = buf.readUInt16LE(at + 26), extra = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const data = buf.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 30 + nameLen + extra + size;
  }
  return out;
}

const bundleIn = (t, a) => join(dirname(a.root), 'bundle-' + Math.random().toString(36).slice(2) + '.zip');

test('Muse and dot get one handoff folder: a zip by default, the same folder file by file with --via chat', async (t) => {
  const a = await sampleArchive(t);
  const muse = buildTrinityPlan(a, 'muse', { bundlePath: bundleIn(t, a) });
  const dot = buildTrinityPlan(a, 'dot', { bundlePath: bundleIn(t, a) });
  assert.deepEqual(muse.chat, { title: 'Grok Bot · Deploy QA' });
  assert.deepEqual(muse.checkChat, { title: 'Grok Bot · Deploy QA · check' });
  assert.equal(dot.chat, undefined);
  assert.ok(muse.checks.every((c) => c.informational), 'Memory.md is reported, not judged');
  assert.ok(!dot.checks.some((c) => c.kind === 'memory'));
  for (const plan of [muse, dot]) {
    assert.equal(plan.delivery.via, 'upload');
    assert.deepEqual(plan.steps.map((s) => s.id), ['bundle', 'remember']);
    assert.match(plan.steps[0].text, /Do not run, import, compile, install/);
    assert.match(plan.steps[1].text, /long-term/);
    const files = unzip(readFileSync(plan.steps[0].attach[0].path));
    for (const want of ['README.md', 'ROLE.md', 'MEMORY.md', 'TASKS.md', 'ROUTINES.md', 'SKILLS.md', 'HISTORY.md', 'MANIFEST.txt']) assert.ok(files.has(want), want);
    assert.ok([...files.keys()].some((k) => k.startsWith('skills/')), 'whole skill folders');
    assert.ok([...files.keys()].some((k) => k.startsWith('box/')), 'the files it used');
    assert.deepEqual(files.get('MANIFEST.txt').toString('utf8').trim().split('\n'), [...files.keys()].filter((k) => k !== 'MANIFEST.txt').sort());
    assert.match(files.get('HISTORY.md').toString('utf8'), /all of them/);
    for (const [name, bytes] of files) assert.ok(!hasSecret(bytes.toString('latin1')), 'token in ' + name);
    assert.equal(plan.delivery.files, files.size);
  }
  assert.match(dot.questions[0].note, /one inbox/);
  assert.notEqual(muse.id, dot.id);
  // Same archive and options: the same bundle bytes and plan id (a resumed run recognises it).
  assert.equal(buildTrinityPlan(a, 'dot', { bundlePath: bundleIn(t, a) }).id, dot.id);

  const chat = buildTrinityPlan(a, 'dot', { via: 'chat' });
  assert.equal(chat.delivery.via, 'chat');
  assert.equal(chat.steps[0].id, 'intro');
  assert.equal(chat.steps.at(-1).id, 'remember');
  assert.ok(chat.steps.every((s) => !s.attach));
  const fileSteps = chat.steps.filter((s) => /Create \(or overwrite\) the file|Append to the end/.test(s.text));
  assert.ok(fileSteps.length >= 6 && fileSteps.every((s) => /Do not run/.test(s.text)));
  assert.ok(chat.steps.every((s) => s.text.length <= 16000 && !/…\[cut\]/.test(s.text)), 'long lines are split, never cut');
  assert.ok(chat.notMigrated.some((n) => /older messages/.test(n.item)), 'recent history only, and said so');
  assert.ok(chat.notMigrated.some((n) => /skill bodies/.test(n.item)));
});

test('acceptance: every answer starts with its marker and needs a keyword the question does not contain', async (t) => {
  const a = await sampleArchive(t);
  const n = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  for (const plan of [buildTrinityPlan(a, 'muse', { bundlePath: bundleIn(t, a) }), buildTrinityPlan(a, 'dot', { via: 'chat' })]) {
    assert.ok(plan.questions.length >= 5);
    plan.questions.forEach((q, i) => {
      assert.equal(q.marker, `Q${i + 1}:`);
      assert.ok(q.text.endsWith('Start your reply with ' + q.marker));
      for (const e of q.expect) assert.ok(!n(q.text).includes(n(e)), `${q.area}: "${e}" is already in the question`);
      for (const e of q.expect) assert.ok(!hasSecret(e) && !/redacted/.test(e), `${q.area}: keyword from unredacted text`);
    });
  }
});

test('the digest check: shell-safe, and only parts reported missing or different are repaired', async (t) => {
  const a = await sampleArchive(t);
  for (const via of ['upload', 'chat']) {
    const plan = buildTrinityPlan(a, 'dot', { via, bundlePath: bundleIn(t, a), folder: '~/grok-bot/x' });
    const q = plan.questions.find((x) => x.area === 'files-on-computer');
    const command = q.text.split('\n\n')[1].split('\nStart your reply')[0];
    const [, code, arg] = /^python3 -c '([^']*)' ([A-Za-z0-9+/=]+)$/s.exec(command) ?? [];
    assert.ok(code && arg, 'one single-quoted program and one base64 argument');
    assert.deepEqual(JSON.parse(Buffer.from(arg, 'base64').toString('utf8')).root, '~/grok-bot/x');
    assert.deepEqual(q.expect, plan.delivery.units.map((u) => u.digest));
    const col = via === 'upload' ? 1 : 2;
    const line = (u, digest) => (col === 1 ? `${u.unit} ${digest} zzzzzzzzzzzz` : `${u.unit} zzzzzzzzzzzz ${digest}`);
    const [first, second, third] = plan.delivery.units;
    const answer = ['Q2:', line(first, first.digest), `${second.unit} MISSING 1`, line(third, 'ffffffffffff')].join('\n');
    assert.deepEqual(brokenUnits(plan, answer).map((u) => u.unit), [second.unit, third.unit]);
    assert.deepEqual(brokenUnits(plan, 'I could not run commands.'), []);
    if (via === 'upload') assert.deepEqual(second.ids, ['bundle']);
  }
});

test('the plan written for trinity has only trinity-migration-plan v1 fields; options are checked', async (t) => {
  const a = await sampleArchive(t);
  const { delivery, ...wire } = buildTrinityPlan(a, 'muse', { bundlePath: bundleIn(t, a) });
  assert.ok(delivery.units.length > 0);
  const allowed = ['format', 'version', 'id', 'seat', 'title', 'chat', 'checkChat', 'source', 'steps', 'checks', 'questions', 'notMigrated'];
  assert.deepEqual(Object.keys(wire).filter((k) => !allowed.includes(k)), []);
  for (const bad of [{ via: 'fax' }, { history: 'recent:x' }, { skills: 'a;b' }, { folder: '~/../etc' }, { folder: "~/it's" }]) assert.throws(() => trinityOptions(bad), /--/);
  assert.throws(() => buildTrinityPlan(a, 'dot', { skills: 'no-such-skill', bundlePath: bundleIn(t, a) }), /No skill named/);
});

test('round 2: folder per bot id, tokens out of file names, files only by zip, capture gaps listed', async (t) => {
  const a = await sampleArchive(t);
  const tok = 'ghp_' + 'Z'.repeat(36);
  // A hostile name cannot leave ~/grok-bot, and two bots with one name do not share a folder.
  a.capture.bot.name = '..';
  const hostile = buildTrinityPlan(a, 'dot', { bundlePath: bundleIn(t, a) });
  assert.match(hostile.delivery.folder, /^~\/grok-bot\/bot-[A-Za-z0-9]{1,8}$/);
  a.capture.bot.name = 'Deploy QA · Watch & merge';
  const one = buildTrinityPlan(a, 'dot', { bundlePath: bundleIn(t, a) }).delivery.folder;
  a.capture.bot = { ...a.capture.bot, id: 'ffffffff-0000-4000-8000-000000000000' };
  assert.notEqual(buildTrinityPlan(a, 'dot', { bundlePath: bundleIn(t, a) }).delivery.folder, one);
  // A token in a file name is renamed in the zip and in MANIFEST.txt alike.
  const row = a.capture.box.find((b) => b.kind === 'file' && b.reason === 'referenced');
  row.boxPath = `/home/box/notes/${tok}.txt`;
  a.capture.coverage = { ...a.capture.coverage, libraryDocs: { status: 'failed', reason: 'boom' } };
  const plan = buildTrinityPlan(a, 'muse', { bundlePath: bundleIn(t, a) });
  const files = unzip(readFileSync(plan.steps[0].attach[0].path));
  assert.ok(![...files.keys()].some((k) => k.includes('ghp_')));
  assert.deepEqual(files.get('MANIFEST.txt').toString('utf8').trim().split('\n'), [...files.keys()].filter((k) => k !== 'MANIFEST.txt').sort());
  assert.match(plan.steps[0].attach[0].sha256, /^[0-9a-f]{64}$/);
  assert.ok(plan.notMigrated.some((n) => n.item === 'Grok Bot libraryDocs' && /failed/.test(n.reason)));
  assert.ok(!JSON.stringify(plan.notMigrated).includes('ghp_'));
  // Chat delivery never retypes files.
  const chat = buildTrinityPlan(a, 'dot', { via: 'chat' });
  assert.ok(!chat.steps.some((s) => / box\//.test(s.text.split('\n')[0])));
  assert.ok(chat.notMigrated.some((n) => /byte for byte only in a zip/.test(n.reason)));
  assert.equal(new Set(chat.steps.map((s) => s.id)).size, chat.steps.length);
});

test('digest answers are judged row by row: every part once, right column, a marker on the first row is fine', () => {
  const plan = { delivery: { via: 'upload', units: [{ unit: 'ROLE.md', digest: 'a'.repeat(12) }, { unit: 'box', digest: 'b'.repeat(12) }] } };
  assert.equal(digestVerdict(plan, `Q2: ROLE.md ${'a'.repeat(12)} x\nbox ${'b'.repeat(12)} y`).ok, true);
  assert.deepEqual(digestVerdict(plan, `${'a'.repeat(12)} ${'b'.repeat(12)}`).unknown, ['ROLE.md', 'box'], 'digests without their rows prove nothing');
  assert.deepEqual(digestVerdict(plan, `Q2: ROLE.md MISSING 1\nbox ${'b'.repeat(12)} y`).broken, ['ROLE.md']);
  assert.deepEqual(digestVerdict(plan, `ROLE.md x ${'a'.repeat(12)}\nbox ${'b'.repeat(12)} y`).broken, ['ROLE.md'], 'the exact column for a zip');
});

test('round 3: chat never retypes skill scripts; the memory question needs the folder; missing references are listed', async (t) => {
  const a = await sampleArchive(t);
  const md = a.capture.box.find((b) => b.kind === 'file' && b.reason === 'skill' && b.boxPath.endsWith('/SKILL.md'));
  const slug = md.boxPath.split('/').at(-2);
  if (!a.capture.box.some((b) => b.boxPath === `/home/box/sand-data/workflows/${slug}/run.sh`)) a.capture.box.push({ ...md, boxPath: `/home/box/sand-data/workflows/${slug}/run.sh` });
  a.capture.coverage = { ...a.capture.coverage, boxStore: { ...(a.capture.coverage.boxStore ?? {}), status: 'partial', unresolvedReferences: ['/home/box/bin/missing-worker9'] } };
  const chat = buildTrinityPlan(a, 'dot', { via: 'chat', skills: 'all' });
  assert.ok(!chat.steps.some((s) => s.text.includes(`skills/${slug}/run.sh`)));
  assert.ok(chat.notMigrated.some((n) => n.item === `skill file ${slug}/run.sh` && /Markdown/.test(n.reason)));
  assert.ok(chat.steps.some((s) => s.text.includes(`skills/${slug}/SKILL.md`)));
  assert.ok(chat.notMigrated.some((n) => n.item === '/home/box/bin/missing-worker9'));
  const memory = chat.questions.find((q) => q.area === 'memory');
  assert.deepEqual(memory.expect, [chat.delivery.folder.replace(/^~\//, '')]);
  assert.match(memory.expect[0], /-[A-Za-z0-9]{8}$/, 'the bot-id suffix is not in the question');
  const upload = buildTrinityPlan(a, 'dot', { bundlePath: bundleIn(t, a) });
  assert.ok(!upload.notMigrated.some((n) => /run\.sh/.test(n.item)), 'a zip carries the script byte for byte');
});

test('round 4: a long UTF-16 memory file never reaches a Muse/dot message or zip', async (t) => {
  const a = await sampleArchive(t);
  const tok = 'ghp_' + 'Q'.repeat(36);
  const row = a.capture.box.find((b) => b.kind === 'file' && /\/memory\/profile\.md$/.test(b.boxPath));
  const bytes = Buffer.from('中'.repeat(4096) + '\n- Key ' + tok + '\n', 'utf16le');
  const read = a.read.bind(a);
  a.read = (p) => (p === row.path ? bytes : read(p));
  const chat = buildTrinityPlan(a, 'dot', { via: 'chat' });
  assert.ok(!chat.steps.some((s) => hasSecret(s.text.replace(/\0/g, ''))));
  const zip = unzip(readFileSync(buildTrinityPlan(a, 'dot', { bundlePath: bundleIn(t, a) }).steps[0].attach[0].path));
  for (const [name, b] of zip) assert.ok(!hasSecret(b.toString('latin1').replace(/\0/g, '')), name);
});

test('--via drive: the zip goes through Google Drive (rclone, MD5-checked) and the agent fetches it', async (t) => {
  const a = await sampleArchive(t);
  assert.throws(() => buildTrinityPlan(a, 'dot', { via: 'drive' }), /--drive-remote/);
  const plan = buildTrinityPlan(a, 'dot', { via: 'drive', driveRemote: 'gdrive:', bundlePath: bundleIn(t, a) });
  assert.equal(plan.delivery.via, 'drive');
  assert.deepEqual(plan.steps.map((s) => s.id), ['bundle', 'remember']);
  assert.ok(!plan.steps[0].attach, 'nothing attached');
  const { name } = plan.delivery.bundle.drive;
  assert.match(name, new RegExp(`-${plan.delivery.bundle.sha256.slice(0, 16)}\\.zip$`), 'the name binds the bytes');
  assert.match(plan.steps[0].text, new RegExp(`Google Drive connector, download the file ${name.replace(/[.]/g, '\\.')} from my Google Drive folder gbot-migrations`));
  assert.deepEqual(plan.delivery.units.map((u) => u.ids), plan.delivery.units.map(() => ['bundle']));

  // The run: upload when Drive does not have the bytes, check the MD5, deliver, then remove the Drive copy.
  const { importTrinity } = await import('../src/core/migration-trinity.js');
  const { createHash } = await import('node:crypto');
  const calls = [];
  let onDrive = '';
  const exec = async (bin, args, opts = {}) => {
    calls.push([bin, ...args]);
    if (bin === 'rclone' && args[0] === 'md5sum') return { code: onDrive ? 0 : 3, stdout: onDrive ? `${onDrive}  x\n` : '', stderr: '' };
    if (bin === 'rclone' && args[0] === 'rcat') { onDrive = createHash('md5').update(opts.input).digest('hex'); return { code: 0, stdout: '', stderr: '' }; }
    if (bin === 'rclone' && args[0] === 'deletefile') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'migrate' && args[1] === '--help') return { code: 0, stdout: '--check-only --redo', stderr: '' };
    return { code: 0, stdout: JSON.stringify({ ok: true, steps: [{ id: 'bundle', state: 'replied', ok: true }, { id: 'remember', state: 'replied', ok: true }], checks: [], questions: [], state_path: '/tmp/x', stopped: null }), stderr: '' };
  };
  const r = await importTrinity({ archive: a.root, to: 'dot', via: 'drive', driveRemote: 'gdrive:', accept: false, exec, bin: 'trinity-cli' });
  const verbs = calls.filter((c) => c[0] === 'rclone').map((c) => c[1]);
  assert.deepEqual(verbs, ['md5sum', 'rcat', 'md5sum', 'deletefile']);
  assert.match(calls.find((c) => c[1] === 'rcat').at(-1), /^gdrive:gbot-migrations\/grok-bot-.*\.zip$/);
  assert.equal(r.driveCopy, null, 'removed after a verified migration');
  const send = calls.findIndex((c) => c[1] === '--json');
  assert.ok(send > calls.findIndex((c) => c[1] === 'rcat'), 'the agent is asked only after the upload is proven');

  // Round 6: the bundle replaced by another valid zip after the plan was built never reaches Drive or the agent.
  // The zip is content-addressed next to the archive: the same bytes give the same path.
  const zipPath = buildTrinityPlan(a, 'dot', { via: 'drive', driveRemote: 'gdrive:' }).delivery.bundle.path;
  const original = readFileSync(zipPath);
  calls.length = 0; onDrive = '';
  const swap = async (bin, args, opts = {}) => {
    if (args[0] === 'migrate' && args[1] === '--help') writeFileSync(zipPath, Buffer.concat([original, Buffer.from('x')]));
    return exec(bin, args, opts);
  };
  try {
    await assert.rejects(importTrinity({ archive: a.root, to: 'dot', via: 'drive', driveRemote: 'gdrive:', accept: false, exec: swap, bin: 'trinity-cli' }),
      /not the bundle this plan was built from/);
  } finally { writeFileSync(zipPath, original); }
  assert.ok(!calls.some((c) => c[1] === 'rcat'), 'nothing uploaded');
  assert.ok(!calls.some((c) => c[1] === '--json'), 'nothing sent to the agent');
  assert.throws(() => buildTrinityPlan(a, 'dot', { via: 'drive', driveRemote: '--config:' }), /--drive-remote/);
});

// --- --move-routines to Muse / Your dot ----------------------------------------------------------
/** The sample bot with "Hourly scan" on (scheduled), "On PR" on (event) and "Nightly report" off (scheduled), plus `more`. */
async function routinesArchive(t, more = []) {
  const dir = mkdtempSync(join(tmpdir(), 'gbot-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const w = world({ rows: 40 });
  const cap = await captureBot(w.io, { agentId: BOT, now: () => new Date('2026-11-08T00:00:00Z') });
  const [scan, onPr] = cap.automations;
  cap.automations = [{ ...scan, enabled: true }, { ...onPr, enabled: true }, { ...scan, id: 'a3', name: 'Nightly report', scheduleCron: '0 2 * * *', enabled: false },
    ...more.map((m) => ({ ...scan, ...m }))];
  return openArchive(writeArchive(cap, join(dir, 'a')).root);
}

/**
 * trinity-cli migrate as JSON: every step replied; the schedules read-back and the questions as asked.
 * `schedulesOk(names)` decides a schedules read-back; `log` records each run in order with the switch.
 */
function fakeTrinity({ schedulesOk = true, questionsOk = true, log = [] } = {}) {
  const calls = [];
  const okFor = typeof schedulesOk === 'function' ? schedulesOk : () => schedulesOk;
  const exec = async (bin, args) => {
    calls.push(args);
    if (args[0] === 'migrate' && args[1] === '--help') return { code: 0, stdout: '--check-only --redo', stderr: '' };
    const plan = JSON.parse(readFileSync(args[3], 'utf8'));
    log.push(`trinity ${args.includes('--check-only') ? 'check' : 'send'} ${plan.steps.map((x) => x.id).join(',')}`);
    const checks = plan.checks.map((c) => {
      const ok = c.informational ? null : c.kind !== 'schedules' || okFor(c.contains);
      return { id: c.id, kind: c.kind, state: 'ok', ok, informational: Boolean(c.informational), found: true, expected: c.contains, hits: ok === false ? [] : c.contains };
    });
    const questions = args.includes('--no-questions') ? [] : [{ area: 'memory', ok: questionsOk, expect: ['grok-bot'], hits: questionsOk ? ['grok-bot'] : [], answer: 'Q1: ~/grok-bot/...' }];
    const ok = checks.every((c) => c.ok !== false) && questions.every((q) => q.ok);
    return { code: 0, stdout: JSON.stringify({ ok, steps: plan.steps.map((x) => ({ id: x.id, state: 'replied', ok: true })), checks, questions, state_path: '/tmp/x', stopped: null }), stderr: '' };
  };
  return { calls, exec, log };
}

function fakeSwitch(onCall = () => {}, log = []) {
  const calls = [];
  return { calls, setEnabled: async (agentId, id, isEnabled) => { calls.push([agentId, id, isEnabled]); log.push(`grok ${id} ${isEnabled ? 'on' : 'off'}`); onCall(id, isEnabled); return { id, enabled: isEnabled }; } };
}

test('move to Your dot: switched over with a gap: the schedule is asked for only after the Grok Bot copy is paused', async (t) => {
  const a = await routinesArchive(t);
  const log = [];
  const tri = fakeTrinity({ log });
  const control = fakeSwitch(() => {}, log);
  const r = await importMigration({ archive: a.root, to: 'dot', yes: true, moveRoutines: true, exec: tri.exec, routineSwitch: control, onProgress: () => {} });
  const plan = JSON.parse(readFileSync(r.plan, 'utf8'));
  assert.deepEqual(plan.steps.map((x) => x.id), ['bundle', 'remember'], 'the folder first, without any schedule');
  assert.ok(!plan.checks.some((c) => c.kind === 'schedules'));
  assert.deepEqual(log, ['trinity send bundle,remember', 'grok a1 off', 'trinity send schedule-a1'], 'Grok Bot copy paused, then the schedule created: never both running');
  assert.deepEqual(control.calls, [[BOT, 'a1', false]], 'not the event trigger, not the routine that is off');
  assert.equal(r.exitCode, 0);
  assert.equal(r.sourceRoutines.status, 'paused');
  assert.deepEqual(r.switchOver.map((x) => [x.id, x.destination, x.source, x.rolledBack]), [['a1', 'on', 'paused', false]]);
  assert.deepEqual(r.routines.map((x) => [x.id, x.atDestination, x.inGrokBot, x.rolledBack]), [['a1', 'on', 'paused', false]]);
  const switchPlan = JSON.parse(readFileSync(r.switchOver[0].plan, 'utf8'));
  assert.deepEqual([switchPlan.steps.map((x) => x.id), switchPlan.checks], [['schedule-a1'], [{ id: 'schedules', kind: 'schedules', contains: ['Hourly scan'] }]]);
  assert.match(switchPlan.steps[0].text, /^Create a recurring scheduled task named "Hourly scan" that runs on cron "52 9-21 \* \* 1-5" in Asia\/Taipei/);
  assert.deepEqual(JSON.parse(readFileSync(r.report, 'utf8')).switchOver, r.switchOver, 'the report file has it too');
  assert.equal(JSON.parse(readFileSync(r.report, 'utf8')).switchPlans, undefined, 'gbot bookkeeping stays out of the report');
  assert.match(importText(r), /✓ paused a1 "Hourly scan" \(52 9-21 \* \* 1-5 Asia\/Taipei\)\n {2}Turn one back on in the Grok Bot app: Routines → toggle\./);
  assert.match(importText(r), /\n {2}✓ a1 "Hourly scan" \(52 9-21 \* \* 1-5 Asia\/Taipei\): paused in Grok Bot, then on in Your dot\n/);

  // check plans the same destination: the folder and, for the moved routine, its schedule.
  const checkLog = [];
  const checked = await checkMigration({ archive: a.root, to: 'dot', moveRoutines: true, exec: fakeTrinity({ log: checkLog }).exec, onProgress: () => {} });
  assert.deepEqual(checkLog, ['trinity check bundle,remember', 'trinity check schedule-a1']);
  assert.equal(checked.exitCode, 0);
  assert.ok(checked.verify.checks.some((c) => c.area === 'schedule "Hourly scan" read-back' && c.ok));
  assert.equal(control.calls.length, 1, 'check never touches Grok Bot');
});

test('move to Your dot: a schedule that does not read back is rolled back in Grok Bot', async (t) => {
  const a = await routinesArchive(t);
  const log = [];
  const tri = fakeTrinity({ log, schedulesOk: () => false });
  const control = fakeSwitch(() => {}, log);
  const r = await importMigration({ archive: a.root, to: 'dot', yes: true, moveRoutines: true, exec: tri.exec, routineSwitch: control, onProgress: () => {} });
  assert.deepEqual(log, ['trinity send bundle,remember', 'grok a1 off', 'trinity send schedule-a1', 'grok a1 on']);
  assert.equal(r.exitCode, 3);
  assert.deepEqual(r.switchOver.map((x) => [x.id, x.destination, x.source, x.rolledBack]), [['a1', 'off', 'on again', true]]);
  assert.match(importText(r), /✗ a1 "Hourly scan" \(52 9-21 \* \* 1-5 Asia\/Taipei\): paused in Grok Bot, but not turned on in Your dot \(the schedules read-back does not show it\); rolled back: it runs in Grok Bot again/);
});

test('move to Muse or Your dot: nothing is paused or scheduled unless the folder read back and the acceptance passed', async (t) => {
  const a = await routinesArchive(t);
  for (const [to, knobs, accept] of [['muse', { questionsOk: false }, true], ['dot', {}, false]]) {
    const log = [];
    const tri = fakeTrinity({ ...knobs, log });
    const control = fakeSwitch(() => {}, log);
    const r = await importMigration({ archive: a.root, to, yes: true, accept, moveRoutines: true, exec: tri.exec, routineSwitch: control, onProgress: () => {} });
    assert.deepEqual(control.calls, [], `${to} ${JSON.stringify(knobs)} accept=${accept}: no write to Grok Bot`);
    assert.ok(!log.some((x) => /schedule-/.test(x)), 'no schedule is created at the destination');
    assert.equal(r.exitCode, 3);
    assert.equal(r.sourceRoutines.reason, 'source routines left on: verification did not pass');
    assert.deepEqual(r.sourceRoutines.routines.map((x) => [x.id, x.result]), [['a1', 'left-on']]);
    assert.deepEqual(r.routines.map((x) => [x.id, x.atDestination, x.inGrokBot]), [['a1', 'off', 'left on']]);
    assert.match(importText(r), /✗ source routines left on: verification did not pass/);
  }
});

test('move to Muse or Your dot: the preview for each choice', async (t) => {
  const a = await routinesArchive(t);
  const kept = await previewMigration({ archive: a.root, to: 'dot' });
  assert.match(kept.summary, /\nGrok Bot routines that are on \(1\); nothing in Grok Bot changes:\n {2}- a1 "Hourly scan" \(52 9-21 \* \* 1-5 Asia\/Taipei\): not scheduled in Your dot \(kept in ROUTINES\.md\); Grok Bot keeps running it\n {2}To run them in Your dot too: --activate-routines \(they may run twice\)\. To move them \(switched over once the import check passes; never both running\): --move-routines\. Add --routines id,id to do either for only some\.$/);
  assert.deepEqual(kept.plan.scheduled, []);
  const both = await previewMigration({ archive: a.root, to: 'dot', activateRoutines: true });
  assert.match(both.summary, /\nGrok Bot routines that are on \(1\); nothing in Grok Bot changes:\n {2}- a1 "Hourly scan" \(52 9-21 \* \* 1-5 Asia\/Taipei\): on in Your dot; Grok Bot keeps running it too, so it may run twice\n {2}Both copies run until one is turned off, so each may run twice; --move-routines switches them over instead \(never both running\)\.$/);
  const moved = await previewMigration({ archive: a.root, to: 'dot', moveRoutines: true });
  assert.match(moved.summary, /\nGrok Bot routines that are on \(1\):\n {2}- a1 "Hourly scan" \(52 9-21 \* \* 1-5 Asia\/Taipei\): moved: once the import check passes it is paused in Grok Bot, then turned on in Your dot \(a short gap; never both running\)\n {2}Turn one back on in the Grok Bot app: Routines → toggle\.$/);
  assert.deepEqual(moved.plan.scheduled.map((x) => x.id), ['a1']);
  assert.notEqual(moved.plan.id, both.plan.id, 'a move sends the schedule later: another plan than --activate-routines');
  assert.notEqual(moved.plan.id, kept.plan.id);
});

test('routines to Your dot: --routines limits what is scheduled there and paused in Grok Bot; the selection is part of the plan id', async (t) => {
  const a = await routinesArchive(t, [{ id: 'a4', name: 'Morning digest', scheduleCron: '0 8 * * *', enabled: true }]);
  const log = [];
  const tri = fakeTrinity({ log });
  const control = fakeSwitch(() => {}, log);
  const r = await importMigration({ archive: a.root, to: 'dot', yes: true, moveRoutines: true, routines: 'a4', exec: tri.exec, routineSwitch: control, onProgress: () => {} });
  const plan = JSON.parse(readFileSync(r.plan, 'utf8'));
  assert.deepEqual(plan.steps.map((x) => x.id), ['bundle', 'remember']);
  assert.deepEqual(log, ['trinity send bundle,remember', 'grok a4 off', 'trinity send schedule-a4'], 'only the routine named with --routines');
  assert.deepEqual(control.calls, [[BOT, 'a4', false]], '"Hourly scan" is on but not named: never paused');
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.routines.map((x) => [x.id, x.atDestination, x.inGrokBot]), [['a1', 'off', 'unchanged'], ['a4', 'on', 'paused']]);
  assert.deepEqual(JSON.parse(readFileSync(r.report, 'utf8')).routines, r.routines, 'the report file has it too');
  assert.ok(plan.notMigrated.some((n) => n.item === 'routine "Hourly scan"' && /it was on in Grok Bot/.test(n.reason)));
  assert.ok(!plan.notMigrated.some((n) => n.item === 'routine "Morning digest"'));
  const text = importText(r);
  assert.match(text, /\nGrok Bot routines that were on \(2\):\n {2}- a1 "Hourly scan" \(52 9-21 \* \* 1-5 Asia\/Taipei\): not scheduled in Your dot \(kept in ROUTINES\.md\); Grok Bot keeps running it\n {2}- a4 "Morning digest" \(0 8 \* \* \* Asia\/Taipei\): on in Your dot; paused in Grok Bot\n/);

  // Plan identity: the selection changes the plan; an id and a name for the same routine agree.
  const id = async (opts) => (await previewMigration({ archive: a.root, to: 'dot', ...opts })).plan.id;
  const some = await id({ activateRoutines: true, routines: 'a4' });
  assert.equal(some, await id({ activateRoutines: true, routines: 'Morning digest' }));
  assert.notEqual(some, await id({ activateRoutines: true }));
  assert.notEqual(some, await id({ activateRoutines: true, routines: 'a1' }));
  assert.notEqual(some, await id({}));
  assert.equal(await id({ activateRoutines: true }), await id({ activateRoutines: true, routines: 'a1,a4' }), 'naming every routine that is on is the same plan as naming none');
  assert.notEqual(await id({ moveRoutines: true, routines: 'a4' }), await id({ moveRoutines: true }));

  // check with the same selection hands trinity the same plan as the import, and pauses nothing.
  const checkTri = fakeTrinity();
  const checked = await checkMigration({ archive: a.root, to: 'dot', moveRoutines: true, routines: 'a4', exec: checkTri.exec, onProgress: () => {} });
  assert.ok(checkTri.calls.some((c) => c.includes('--check-only')), 'only the fake trinity-cli is run');
  assert.equal(JSON.parse(readFileSync(checked.plan, 'utf8')).id, plan.id);
  assert.equal(control.calls.length, 1);
  await assert.rejects(checkMigration({ archive: a.root, to: 'dot', moveRoutines: true, routines: 'a9', onProgress: () => {} }),
    /^MigrationError: --routines: no routine that is on in Grok Bot has the id or name "a9"\. Routines that are on in Grok Bot: a1 "Hourly scan" \(52 9-21 \* \* 1-5 Asia\/Taipei\), a4 "Morning digest" \(0 8 \* \* \* Asia\/Taipei\)\.$/);
});

test('routines to Muse or Your dot: by default nothing in Grok Bot changes (no SetGrokBotAgentAutomationEnabled call)', async (t) => {
  const a = await routinesArchive(t);
  for (const [to, flags] of [['dot', {}], ['muse', {}], ['dot', { activateRoutines: true }]]) {
    const tri = fakeTrinity();
    const control = fakeSwitch();
    const r = await importMigration({ archive: a.root, to, yes: true, ...flags, exec: tri.exec, routineSwitch: control, onProgress: () => {} });
    assert.deepEqual(control.calls, [], `${to} ${JSON.stringify(flags)}: no write to Grok Bot`);
    assert.equal(r.exitCode, 0);
    assert.equal(r.sourceRoutines, undefined);
    assert.deepEqual(r.routines.map((x) => [x.id, x.inGrokBot]), [['a1', 'unchanged']]);
    assert.match(importText(r), /\nGrok Bot routines that were on \(1\); nothing in Grok Bot was changed:\n/);
  }
});

test('wizard: three routine choices, default 1 changes nothing in Grok Bot; 2 and 3 can name some routines', async () => {
  const { parseChoice, routineArgs, routinesPick, routinesQuestion } = await import('../bin/gbot.mjs');
  assert.deepEqual(routinesQuestion(2, 'Your dot'), [
    'Routines that are on in Grok Bot (2):',
    '1. Keep them off in Your dot; Grok Bot keeps running them (nothing in Grok Bot changes)',
    '2. Run them in both: turn them on in Your dot and leave Grok Bot running them (they may run twice)',
    '3. Move them: once the check passes, pause them in Grok Bot, then turn them on in Your dot (a short gap; never both running)',
  ]);
  const on = [{ id: 'a1', name: 'Hourly scan', schedule: '52 9-21 * * 1-5', timezone: 'Asia/Taipei' }, { id: 'a4', name: 'Morning digest', schedule: '0 8 * * *', timezone: null },
    { id: 'a7', name: 'Weekly', schedule: '0 9 * * 1', timezone: 'UTC' }];
  assert.deepEqual(routinesPick(on), ['1. Hourly scan (52 9-21 * * 1-5 Asia/Taipei)', '2. Morning digest (0 8 * * *)', '3. Weekly (0 9 * * 1 UTC)']);
  // 1 (or Enter): no option at all, so the import never opens the routine switch.
  assert.deepEqual(routineArgs(0, 'work', on), { preview: [], import: [] });
  assert.deepEqual(routineArgs(0, 'work', on, [0]), { preview: [], import: [] }, 'a selection never applies to 1');
  // Enter at the second question (null) or every routine picked: all of them, no --routines.
  assert.deepEqual(routineArgs(1, 'work', on, null), { preview: ['--activate-routines'], import: ['--activate-routines'] });
  assert.deepEqual(routineArgs(2, 'work', on, null), { preview: ['--move-routines'], import: ['--move-routines', '--account', 'work'] });
  assert.deepEqual(routineArgs(2, 'work', on, parseChoice('all', 3, { multiple: true })), { preview: ['--move-routines'], import: ['--move-routines', '--account', 'work'] });
  // "1,3": those routines, by id.
  const picked = parseChoice('1,3', 3, { multiple: true });
  assert.deepEqual(routineArgs(1, 'work', on, picked), { preview: ['--activate-routines', '--routines', 'a1,a7'], import: ['--activate-routines', '--routines', 'a1,a7'] });
  assert.deepEqual(routineArgs(2, 'work', on, picked), { preview: ['--move-routines', '--routines', 'a1,a7'], import: ['--move-routines', '--routines', 'a1,a7', '--account', 'work'] });
  assert.equal(parseChoice('4', 3), null, 'the first question has three choices');
  assert.equal(parseChoice('1,5', 3, { multiple: true }), null);
});

// --- memory coverage -------------------------------------------------------------------------------
const OWN_LOG = `home/box/sand-data/agents/${BOT}/memory/log/2026-10.md`;
const MEMORY_FILES = [`home/box/sand-data/agents/${BOT}/memory/profile.md`, OWN_LOG, 'home/box/sand-data/user-memory/by-agent/other-bot/profile.md'];
const captureNow = (unreadable) => captureBot(world({ rows: 40, unreadable }).io, { agentId: BOT, now: () => new Date('2026-11-08T00:00:00Z') });

test('memory coverage: complete only when every memory file the store lists was read', async () => {
  const all = await captureNow([]);
  assert.equal(all.coverage.memory.status, 'complete');
  assert.equal(all.coverage.memory.missing, undefined);
  assert.deepEqual([all.coverage.memory.own, all.coverage.memory.sharedUser], [2, 1]);

  const one = await captureNow([OWN_LOG]);
  assert.equal(one.coverage.memory.status, 'partial', 'one memory file read, one left out');
  assert.deepEqual(one.coverage.memory.missing, [{ boxPath: '/' + OWN_LOG, reason: 'blob unreadable or digest mismatch' }]);
  assert.match(coverageText(one.coverage), new RegExp(`~ memory +partial — .*1 of 3 memory file\\(s\\) not read: /${OWN_LOG.replace(/[.]/g, '\\.')} \\(blob unreadable or digest mismatch\\)`));

  const none = await captureNow(MEMORY_FILES);
  assert.equal(none.coverage.memory.status, 'failed', 'no memory file read');
  assert.deepEqual(none.coverage.memory.missing.map((m) => m.boxPath), MEMORY_FILES.map((f) => '/' + f).sort());
});

test('memory coverage: a memory file left out is named in the preview, notMigrated and the import report', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gbot-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = openArchive(writeArchive(await captureNow([OWN_LOG]), join(dir, 'a')).root);
  const left = (n) => n.item === '/' + OWN_LOG && n.reason === 'blob unreadable or digest mismatch';
  assert.ok(buildHermesPlan(a, { profile: 'grok-qa', profileDir: join(dir, 'p') }).notMigrated.some(left), 'Hermes');
  assert.ok(buildTrinityPlan(a, 'dot', { bundlePath: join(dir, 'b.zip') }).notMigrated.some(left), 'Your dot');
  const preview = await previewMigration({ archive: a.root, to: 'dot' });
  assert.match(preview.summary, new RegExp(`- /${OWN_LOG.replace(/[.]/g, '\\.')}: blob unreadable or digest mismatch`));
  const r = await importMigration({ archive: a.root, to: 'dot', yes: true, exec: fakeTrinity().exec, onProgress: () => {} });
  assert.deepEqual(r.memoryNotCaptured, [{ boxPath: '/' + OWN_LOG, reason: 'blob unreadable or digest mismatch' }]);
  assert.match(importText(r), new RegExp(`\nMemory files not captured, so not migrated \\(1\\):\n {2}- /${OWN_LOG.replace(/[.]/g, '\\.')}: blob unreadable or digest mismatch\n`));
});
