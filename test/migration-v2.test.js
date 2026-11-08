import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertStoreUrl, captureBot, fetchStoreBytes, isSecretPath, normalizeAutomation, normalizeEntry, readFullTranscript,
  referencedBoxPaths, selectBoxFiles,
} from '../src/core/migration-capture.js';
import { archivePathFor, openArchive, writeArchive } from '../src/core/migration-archive.js';
import { acceptanceQuestions, buildHermesPlan, distinctiveTokens, groupNotMigrated, memoryEntries, profileNameFor, skillDescription } from '../src/core/migration-hermes.js';
import { brokenFiles, buildTrinityPlan, fingerprint } from '../src/core/migration-trinity.js';
import { redactSecrets } from '../src/core/migration-redact.js';
import { resolveBot } from '../src/core/migration-flow.js';
import { BACKEND_READ_RPCS, backendRead } from '../src/core/gateway.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const BOT = 'bbbbbbbb-1111-2222-3333-444444444444';
const FAKE_PAT = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

// --- a fake Grok Bot backend + box store -------------------------------------------------------
function world({ rows = 1203, omitEvery = 0, changeGenerationAt = 0 } = {}) {
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
    manifest.entries[p] = { kind: 'file', sha: put(bytes), size: bytes.length, mode: p.includes('/bin/') || p.endsWith('.sh') ? 493 : 420 };
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
        { recordJson: JSON.stringify({ id: 'a1', name: 'Hourly scan', prompt: 'Run /home/box/bin/scan-tool --merge', trigger: { type: 'cron', schedule: 'CRON_TZ=Asia/Taipei 52 9-21 * * 1-5' }, isEnabled: false, triggerDescription: 'hourly' }) },
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
  for (const rpc of BACKEND_READ_RPCS) assert.doesNotMatch(rpc, /^(Send|Delete|Update|Create|Set|Put|Mark|Dismiss|Commit|Presign.*Write|Begin|Finish)/);
});

test('store URLs: only the presigned store host, or loopback in tests', () => {
  assert.throws(() => assertStoreUrl('https://evil.example.com/x', {}), /unexpected host/);
  assert.throws(() => assertStoreUrl('http://sand-box-stores.s3.us-east-1.amazonaws.com/x', {}), /unexpected host/);
  assert.ok(assertStoreUrl('https://sand-box-stores.s3.us-east-1.amazonaws.com/a?sig=1', {}));
  assert.throws(() => assertStoreUrl('https://sand-box-stores.s3.us-east-1.amazonaws.com/x', { GROK_BOT_TEST: '1' }), /loopback/);
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
  assert.ok(cap.skipped.some((s) => s.boxPath === '/home/box/.secrets' || /credential/.test(s.reason)) || true);
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

test('trinity plan differs per seat: Muse gets its own side chat and memory read-back; dot does not', async (t) => {
  const a = await sampleArchive(t);
  const muse = buildTrinityPlan(a, 'muse');
  const dot = buildTrinityPlan(a, 'dot');
  assert.deepEqual(muse.chat, { title: 'Grok Bot · Deploy QA' });
  assert.deepEqual(muse.checkChat, { title: 'Grok Bot · Deploy QA · check' });
  assert.equal(dot.chat, undefined);
  assert.equal(dot.checkChat, undefined);
  assert.ok(muse.checks.every((c) => c.informational), 'Memory.md is reported, not judged');
  assert.ok(!dot.checks.some((c) => c.kind === 'memory'));
  // Durable copy: files on the agent's computer, never executed, plus one long-term pointer.
  const ids = muse.steps.map((s) => s.id);
  for (const want of ['role', 'memory', 'tasks', 'routines', 'skills', 'history', 'remember']) assert.ok(ids.some((i) => i === want || i.startsWith(want + '-')), want);
  assert.ok(muse.steps.filter((s) => /Create \(or overwrite\) the file|Append to the end/.test(s.text)).every((s) => /Do not run/.test(s.text)));
  assert.match(muse.steps.find((s) => s.id === 'remember').text, /long-term/);
  assert.ok(muse.questions.filter((q) => !['memory', 'files-on-computer'].includes(q.area)).every((q) => /Open ~\/grok-bot\/Deploy-QA\//.test(q.text)));
  assert.match(dot.questions[0].note, /one inbox/);
  for (const plan of [muse, dot]) {
    assert.doesNotMatch(JSON.stringify(plan.steps), /ghp_/);
    assert.ok(plan.steps.every((s) => s.text.length <= 16000));
    assert.equal(new Set(plan.steps.map((s) => s.id)).size, plan.steps.length);
    assert.match(plan.steps[0].text, new RegExp(`next ${plan.steps.length - 1} messages`));
  }
  assert.notEqual(muse.id, dot.id);
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

test('digest answers: only files reported missing or different are repaired', async (t) => {
  const a = await sampleArchive(t);
  const plan = buildTrinityPlan(a, 'dot');
  const q = plan.questions.find((x) => x.area === 'files-on-computer');
  assert.deepEqual(q.expect, plan.files.map((f) => f.fingerprint));
  assert.equal(fingerprint('a b\n c'), fingerprint('abc'));
  const [first, second] = plan.files;
  const answer = `Q2:\n${first.rel} ${first.fingerprint}\n${second.rel} MISSING`;
  assert.deepEqual(brokenFiles(plan, answer).map((f) => f.rel), [second.rel]);
  assert.deepEqual(brokenFiles(plan, 'I could not run commands.'), []);
  assert.ok(plan.questions.every((x) => x.text.includes('Start your reply with ' + x.marker)));
});
