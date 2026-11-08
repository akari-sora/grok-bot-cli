import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hermes, acceptanceQuestions, applyHermes, buildHermesPlan, verifyHermes } from '../src/core/migration-hermes.js';
import { hasSecret } from '../src/core/migration-redact.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const norm = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const BOT = 'bbbbbbbb-1111-2222-3333-444444444444';
const PAT = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
// The JSON-escaped form of a token cannot be redacted in place: the item holding it is left out.
const ENCODED = '\\u0067hp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
const DEFAULT_SOUL = 'You are Hermes Agent, built by Nous Research. Be direct.';
const AUTO = { id: 'a1', name: 'Hourly scan', prompt: 'Run the scan.', enabled: true, trigger: 'schedule', scheduleCron: '52 9-21 * * 1-5', timezone: 'Asia/Taipei', scheduleText: '', triggerDetails: '' };

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gbot-hermes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

/** History digest as the helper computes it from Hermes' stored messages (role, byte length, text). */
const digest = (messages) => {
  const h = createHash('sha256');
  for (const m of messages) h.update(`${m.role}\n${Buffer.byteLength(m.content)}\n${m.content}\n`);
  return h.digest('hex');
};

/** An opened-archive stand-in: openArchive refuses hostile box paths before a plan could see them. */
function archive({ bot = {}, box = [], transcripts = [], coverage = {}, ...rest } = {}) {
  const blobs = new Map([['REPORT.md', Buffer.from('# report\n')]]);
  const rows = box.map((f, i) => {
    if (f.kind === 'symlink') return f;
    const bytes = Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.text ?? '');
    const path = `box/f${i}`;
    blobs.set(path, bytes);
    return { kind: 'file', reason: 'referenced', mode: 420, boxPath: f.boxPath, ...(f.reason ? { reason: f.reason } : {}), path, size: bytes.length, sha256: sha(bytes) };
  });
  const index = transcripts.map((t, i) => {
    const path = t.sessionId ? `transcript/session-${i}.jsonl` : 'transcript/main.jsonl';
    blobs.set(path.replace(/\.jsonl$/, '.md'), Buffer.from('# history\n'));
    return { sessionId: t.sessionId ?? '', path, rows: t.rows.length, unreadable: t.unreadable ?? 0, gaps: [] };
  });
  const capture = {
    format: 'gbot-migration', version: 2, capturedAt: '2026-11-08T00:00:00.000Z',
    bot: { id: BOT, name: 'Deploy QA · Watch & merge', title: '', instructions: 'Watch aa22396584/telltale and merge green MRs.', kind: 'bot', members: [], ...bot },
    groups: [], sessions: [], automations: [], todos: [], tasks: [], serverMemories: [], serverSkills: [], connectors: [], library: [], skipped: [],
    ...rest, coverage, transcripts: index, box: rows,
  };
  const byPath = new Map(index.map((t, i) => [t.path, transcripts[i].rows]));
  return {
    root: '/archives/deploy-qa', capture,
    read: (p) => { if (!blobs.has(p)) throw new Error('not in the archive: ' + p); return blobs.get(p); },
    transcript: (t) => byPath.get(t.path),
    boxFile: () => null,
  };
}

const PROFILE = 'grok-qa';
const buildPlan = (a, root, opts = {}) => buildHermesPlan(a, { profile: PROFILE, profileDir: join(root, 'profiles', PROFILE), now: () => new Date('2026-11-08T00:00:00Z'), ...opts });

/**
 * A fake `hermes` CLI and runtime. The helper is answered per op in memory (stores keyed by
 * HERMES_HOME), the same JSON contract the real helper speaks.
 */
function fakeHermes(root, knobs = {}) {
  mkdirSync(root, { recursive: true });
  const calls = [];
  const homes = new Map();
  const dirOf = (name) => (name === 'default' ? root : join(root, 'profiles', name));
  const state = (home) => {
    if (!homes.has(home)) homes.set(home, { config: {}, memory: [], user: [], jobs: [], sessions: [] });
    return homes.get(home);
  };
  const skillNames = (home) => (existsSync(join(home, 'skills')) ? walk(join(home, 'skills')) : []).filter((f) => f.endsWith('/SKILL.md'))
    .map((f) => /^name:\s*(.+)$/m.exec(readFileSync(f, 'utf8'))?.[1].trim());
  const helper = (req, home) => {
    const s = state(home);
    switch (req.op) {
      case 'preflight': return knobs.preflight ?? { ok: true, versions: { hermes: 'fake' }, default_souls: [DEFAULT_SOUL], import_limits: { session_messages: 10_000, session_bytes: 5 * 1024 * 1024 } };
      case 'memory-add': return { ok: true, results: req.entries.map(({ target, content }) => {
        const list = target === 'user' ? s.user : s.memory;
        if (list.includes(content)) return { target, content, status: 'present' };
        if ([...list, content].join('\n§\n').length > req[target === 'user' ? 'user_char_limit' : 'memory_char_limit']) return { target, content, status: 'refused', error: 'over the limit' };
        list.push(content);
        return { target, content, status: 'added' };
      }) };
      case 'import-history': return { ok: true, results: req.sessions.map((x) => {
        const found = s.sessions.find((y) => y.foreign_id === x.foreign_id);
        if (found) return { foreign_id: x.foreign_id, session_id: found.id, already_imported: true };
        s.sessions.push({ id: 'sid' + s.sessions.length, foreign_id: x.foreign_id, messages: x.messages.map((m) => ({ role: m.role, content: m.content })) });
        return { foreign_id: x.foreign_id, session_id: s.sessions.at(-1).id, already_imported: false };
      }) };
      case 'readback': return {
        ok: true, memory: [...s.memory], user: [...s.user], memory_prompt: s.memory.join('\n§\n'), user_prompt: s.user.join('\n§\n'),
        limits: { memory: Number(s.config['memory.memory_char_limit'] ?? 2200), user: Number(s.config['memory.user_char_limit'] ?? 1375) },
        timezone: s.config.timezone ?? '', cron: s.jobs.map((j) => ({ ...j })), skills: skillNames(home),
        sessions: (req.foreign_ids ?? []).map((fid) => {
          const x = s.sessions.find((y) => y.foreign_id === fid);
          return x ? { foreign_id: fid, session_id: x.id, messages: x.messages.length, digest: digest(x.messages) } : { foreign_id: fid, session_id: null, messages: 0 };
        }),
      };
      default: return { ok: false, error: 'unknown op' };
    }
  };
  const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input ?? '' });
    if (cmd === 'fake-python') {
      const req = JSON.parse(opts.input);
      const res = knobs.helper?.(req) ?? helper(req, opts.env.HERMES_HOME);
      return { code: knobs.helperCode ?? 0, stdout: typeof res === 'string' ? res : JSON.stringify(res), stderr: '' };
    }
    const [a0, a1, a2, a3] = args;
    if (a0 === '--version') return ok('Hermes Agent v0.0.0-fake\n');
    if (a0 === '--print-runtime-command') return ok(JSON.stringify(['fake-python', '-I', '-c', "import runpy; runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)"]));
    if (a0 === 'profile' && a1 === 'list') return ok(['default', ...(existsSync(join(root, 'profiles')) ? readdirSync(join(root, 'profiles')) : [])].join('\n'));
    if (a0 === 'profile' && a1 === 'create') { mkdirSync(dirOf(a2), { recursive: true }); writeFileSync(join(dirOf(a2), 'SOUL.md'), DEFAULT_SOUL); return ok(''); }
    if (a0 === '-p' && a2 === 'config' && a3 === 'path') return ok(join(dirOf(a1), 'config.yaml') + '\n');
    if (a0 === '-p' && a2 === 'config' && a3 === 'set') { state(dirOf(a1)).config[args[4]] = args[5]; return ok(''); }
    if (a0 === '-p' && a2 === 'cron' && a3 === 'create') {
      const rest = args.slice(4), opt = {};
      while (rest[0]?.startsWith('--')) { const flag = rest.shift(); opt[flag] = flag === '--paused' ? true : rest.shift(); }
      const [schedule, prompt] = rest;
      state(dirOf(a1)).jobs.push({ id: 'job' + calls.length, name: opt['--name'], prompt, workdir: opt['--workdir'], schedule: { kind: 'cron', expr: schedule }, state: opt['--paused'] ? 'paused' : 'scheduled' });
      return ok('');
    }
    throw new Error('fake hermes: unexpected ' + args.join(' '));
  };
  return { hermes: new Hermes({ exec, bin: 'hermes' }), calls, dirOf, state: (name) => state(dirOf(name)) };
}

/** A profile the user made themselves (not by this migration). */
function userProfile(fake, soul = DEFAULT_SOUL) {
  const dir = fake.dirOf(PROFILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SOUL.md'), soul);
  return dir;
}

/** Every string and byte of a plan that can reach the profile or a command. */
function planText(plan) {
  const { files, skills, docs, ...rest } = plan;
  return [JSON.stringify(rest),
    ...[...files, ...skills.flatMap((s) => s.files)].map((f) => f.dest + '\n' + f.bytes.toString('latin1')),
    ...[...docs].map(([path, bytes]) => path + '\n' + bytes.toString('latin1'))].join('\n');
}

const area = (result, name) => result.checks.find((c) => c.area === name);
const stepOf = (applied, name) => applied.steps.find((s) => s.step === name);

test('a: no token reaches the profile: AGENTS.md, custom-SOUL memory, name and title, binaries, encoded values', async (t) => {
  const root = tmp(t);
  const a = archive({
    bot: { name: 'Deploy ' + PAT + ' · QA', title: 'Ops ' + PAT, instructions: 'Merge green MRs with ' + PAT + '.' },
    todos: [{ id: 't1', content: 'Rotate ' + PAT, status: 'pending' }, { id: 't2', content: 'Use ' + ENCODED, status: 'pending' }],
    automations: [
      { ...AUTO, name: 'Scan ' + PAT, prompt: 'Run with ' + PAT },
      { ...AUTO, id: 'a3', name: 'Encoded', prompt: 'Run with ' + ENCODED },
      { ...AUTO, id: 'a2', name: 'On PR', prompt: 'Review it', trigger: 'github', scheduleCron: '', timezone: null, triggerDetails: JSON.stringify([{ type: 'github', secret: PAT }]) },
    ],
    connectors: [{ name: 'Linear ' + PAT }],
    groups: [{ name: 'Room ' + PAT, members: [] }],
    box: [
      { boxPath: `/home/box/sand-data/agents/${BOT}/memory/profile.md`, reason: 'bot-data', text: '- The user handle is ImL1s.\n- Key ' + PAT + '\n- Encoded ' + ENCODED + '\n' },
      { boxPath: '/home/box/notes.txt', text: 'deploy key ' + PAT + '\n' },
      { boxPath: '/home/box/blob.bin', bytes: Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(PAT)]) },
      { boxPath: '/home/box/enc.json', text: '{"t":"' + ENCODED + '"}' },
      { boxPath: '/home/box/' + PAT + '.txt', text: 'named after a token' },
      { boxPath: '/home/box/sand-data/workflows/fixer/SKILL.md', reason: 'skill', text: '---\nname: fixer\ndescription: Fix pipeline7 jobs\n---\nUse ' + PAT + '\n' },
    ],
    transcripts: [{ rows: [{ seq: 1, role: 'user', text: 'hello ' + PAT, timestampMs: 1 }, { seq: 2, role: 'assistant', text: 'ok', timestampMs: 2 }, { seq: 3, role: 'user', text: 'see ' + ENCODED, timestampMs: 3 }] }],
  });
  const plan = buildPlan(a, root);
  assert.ok(!hasSecret(planText(plan)), 'nothing in the plan holds a token');
  const left = (re) => assert.ok(plan.notMigrated.some((n) => re.test(`${n.item} | ${n.reason}`)), String(re));
  left(/^\/home\/box\/blob\.bin \| binary/);
  left(/^\/home\/box\/enc\.json \| .*encoded/);
  left(/^\/home\/box\/\[redacted\]\.txt \| its path holds a token/);
  left(/^open task t2 \|/);
  left(/^routine "Encoded" \|/);
  left(/^a memory entry in .*profile\.md \|/);
  left(/^1 message\(s\) of the main conversation \|/);
  assert.ok(!plan.files.some((f) => /blob\.bin|enc\.json|redacted/.test(f.boxPath)));
  assert.ok(plan.memory.some((m) => m.includes('Rotate [redacted]')));
  assert.equal(plan.cron.length, 1);
  assert.equal(plan.history[0].messages.length, 2);

  // Into a profile whose SOUL.md the user customized: the role goes to MEMORY.md, redacted.
  const fake = fakeHermes(root);
  userProfile(fake, 'You are my own assistant.');
  await applyHermes(fake.hermes, a, plan, { allowExisting: true });
  assert.ok(fake.state(PROFILE).memory.some((m) => m.startsWith('Grok Bot role for ') && m.includes('[redacted]')));
  assert.match(readFileSync(join(plan.base, 'AGENTS.md'), 'utf8'), /Rotate \[redacted\]/);
  for (const file of walk(root)) assert.ok(!hasSecret(readFileSync(file).toString('latin1')), file);
  for (const c of fake.calls) assert.ok(!hasSecret(c.args.join('\n') + c.input), c.args.slice(0, 4).join(' '));
});

test('a: the last gate refuses a plan that still holds a token, before anything changes', async (t) => {
  const root = tmp(t);
  const a = archive();
  const plan = buildPlan(a, root);
  plan.memory.push('leaked ' + PAT);
  const fake = fakeHermes(root);
  await assert.rejects(applyHermes(fake.hermes, a, plan), /token-shaped/);
  assert.ok(!fake.calls.some((c) => c.args[0] === 'profile' && c.args[1] === 'create'));
  assert.ok(!existsSync(plan.profileDir));
});

test('b: destinations are validated relative paths that stay inside the workspace or the skills folder', async (t) => {
  const root = tmp(t);
  const a = archive({ box: [
    { boxPath: '/../../../../../tmp/x', text: 'escape' },
    { boxPath: '/home/box/sand-data/workflows/../SKILL.md', reason: 'skill', text: '---\nname: x\n---\n' },
    { boxPath: '/home/box/sand-data/workflows/ok/SKILL.md', reason: 'skill', text: '---\nname: ok\ndescription: fine\n---\n' },
    { boxPath: '/home/box/sand-data/workflows/ok/../../../../../tmp/y', reason: 'skill', text: 'escape too' },
    { boxPath: '/home/box/a\0b', text: 'nul' },
    { boxPath: '/home/box/fine.txt', text: 'fine' },
  ] });
  const plan = buildPlan(a, root);
  assert.deepEqual(plan.files.map((f) => f.boxPath), ['/home/box/sand-data/workflows/ok/SKILL.md', '/home/box/fine.txt']);
  for (const f of plan.files) assert.ok(f.dest.startsWith(plan.boxRoot + '/'), f.dest);
  assert.deepEqual(plan.skills.map((s) => [s.slug, s.files.map((f) => f.rel)]), [['ok', ['SKILL.md']]]);
  const refused = plan.notMigrated.filter((n) => /unsafe destination path/.test(n.reason)).map((n) => n.item);
  assert.deepEqual(refused.sort(), [
    '/../../../../../tmp/x', '/home/box/a\0b', '/home/box/sand-data/workflows/../SKILL.md', '/home/box/sand-data/workflows/ok/../../../../../tmp/y',
    'skill file /home/box/sand-data/workflows/ok/../../../../../tmp/y', 'skill folder ".."',
  ].sort());

  const fake = fakeHermes(root);
  await applyHermes(fake.hermes, a, plan);
  assert.ok(!existsSync(join(root, 'tmp')), 'nothing was written outside the profile');
  assert.deepEqual(readdirSync(join(plan.profileDir, 'skills')), ['grok-bot-imports']);
  assert.deepEqual(readdirSync(join(plan.profileDir, 'skills', 'grok-bot-imports')), ['ok']);
});

test('c: a marker from --into-existing, or from another bot, never makes a later run owned', async (t) => {
  const root = tmp(t);
  const fake = fakeHermes(root);
  userProfile(fake);
  const v1 = archive({ box: [{ boxPath: '/home/box/a.txt', text: 'one' }] });
  const plan = buildPlan(v1, root);
  await applyHermes(fake.hermes, v1, plan, { allowExisting: true });
  const markerPath = join(plan.base, '.gbot-migration.json');
  assert.equal(JSON.parse(readFileSync(markerPath, 'utf8')).createdProfile, false);
  await assert.rejects(applyHermes(fake.hermes, v1, buildPlan(v1, root)), /already exists/);
  // With the flag the profile is only extended: a changed file is a conflict, never a repair.
  const v2 = archive({ box: [{ boxPath: '/home/box/a.txt', text: 'two' }] });
  const dest = join(plan.boxRoot, 'home', 'box', 'a.txt');
  const applied = await applyHermes(fake.hermes, v2, buildPlan(v2, root), { allowExisting: true });
  assert.equal(readFileSync(dest, 'utf8'), 'one');
  assert.deepEqual(stepOf(applied, 'files').conflicts, [dest]);
  // A marker another bot wrote in a profile it created is not this bot's.
  writeFileSync(markerPath, JSON.stringify({ botId: 'cccccccc-0000-0000-0000-000000000000', createdProfile: true, files: {} }));
  await assert.rejects(applyHermes(fake.hermes, v2, buildPlan(v2, root)), /already exists/);
});

test('c: a repair needs the digest the migration recorded; a file the user edited stays and is a conflict', async (t) => {
  const root = tmp(t);
  const fake = fakeHermes(root);
  const v1 = archive({ box: [{ boxPath: '/home/box/f.txt', text: 'v1 f' }, { boxPath: '/home/box/g.txt', text: 'v1 g' }] });
  const p1 = buildPlan(v1, root);
  await applyHermes(fake.hermes, v1, p1);
  const f = join(p1.boxRoot, 'home', 'box', 'f.txt'), g = join(p1.boxRoot, 'home', 'box', 'g.txt');
  writeFileSync(f, 'edited by the user');
  const v2 = archive({ box: [{ boxPath: '/home/box/f.txt', text: 'v2 f' }, { boxPath: '/home/box/g.txt', text: 'v2 g' }] });
  const applied = await applyHermes(fake.hermes, v2, buildPlan(v2, root));
  assert.equal(readFileSync(f, 'utf8'), 'edited by the user');
  assert.equal(readFileSync(g, 'utf8'), 'v2 g');
  assert.deepEqual(stepOf(applied, 'files').conflicts, [f]);
});

test('c: hardlinked files and symlinked parents are refused; nothing is written outside', async (t) => {
  const root = tmp(t);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const fake = fakeHermes(root);
  const v1 = archive({ box: [{ boxPath: '/home/box/g.txt', text: 'v1' }, { boxPath: '/home/box/sub/h.txt', text: 'h1' }] });
  const p1 = buildPlan(v1, root);
  await applyHermes(fake.hermes, v1, p1);

  const g = join(p1.boxRoot, 'home', 'box', 'g.txt');
  writeFileSync(join(outside, 'victim'), 'v1');
  rmSync(g);
  linkSync(join(outside, 'victim'), g);
  const v2 = archive({ box: [{ boxPath: '/home/box/g.txt', text: 'v2' }, { boxPath: '/home/box/sub/h.txt', text: 'h1' }] });
  await assert.rejects(applyHermes(fake.hermes, v2, buildPlan(v2, root)), /link/);
  assert.equal(readFileSync(join(outside, 'victim'), 'utf8'), 'v1');

  rmSync(g);
  writeFileSync(g, 'v1');
  rmSync(join(p1.boxRoot, 'home', 'box', 'sub'), { recursive: true });
  symlinkSync(outside, join(p1.boxRoot, 'home', 'box', 'sub'));
  const v3 = archive({ box: [{ boxPath: '/home/box/g.txt', text: 'v1' }, { boxPath: '/home/box/sub/new.txt', text: 'new' }] });
  await assert.rejects(applyHermes(fake.hermes, v3, buildPlan(v3, root)), /link/);
  assert.ok(!existsSync(join(outside, 'new.txt')));
});

test('c: SOUL.md is replaced only when it is exactly Hermes\' default, not a customized copy that starts like it', async (t) => {
  const root = tmp(t);
  const a = archive();
  const custom = DEFAULT_SOUL + '\n\nAlways answer in French.';
  const fake = fakeHermes(root);
  const dir = userProfile(fake, custom);
  const applied = await applyHermes(fake.hermes, a, buildPlan(a, root), { allowExisting: true });
  assert.equal(readFileSync(join(dir, 'SOUL.md'), 'utf8'), custom);
  assert.equal(stepOf(applied, 'soul').status, 'kept-existing');

  const root2 = tmp(t);
  const fake2 = fakeHermes(root2);
  const dir2 = userProfile(fake2, '\n' + DEFAULT_SOUL + '\n');
  const plan2 = buildPlan(a, root2);
  const applied2 = await applyHermes(fake2.hermes, a, plan2, { allowExisting: true });
  assert.equal(stepOf(applied2, 'soul').status, 'written');
  assert.equal(readFileSync(join(dir2, 'SOUL.md'), 'utf8'), plan2.soul);
  assert.equal(readFileSync(join(dir2, 'SOUL.md.bak.grok-bot'), 'utf8'), '\n' + DEFAULT_SOUL + '\n');
});

test('d: cron jobs match the source automation id; verify checks schedule, time zone and state', async (t) => {
  const root = tmp(t);
  const a = archive({ automations: [AUTO] });
  const fake = fakeHermes(root);
  userProfile(fake);
  // The user already has a job with the same display name: it is not this migration's and stays.
  fake.state(PROFILE).jobs.push({ id: 'mine', name: 'Deploy QA · Watch & merge: Hourly scan', prompt: 'mine', schedule: { kind: 'cron', expr: '0 0 * * *' }, state: 'scheduled' });
  const plan = buildPlan(a, root);
  await applyHermes(fake.hermes, a, plan, { allowExisting: true });
  await applyHermes(fake.hermes, a, plan, { allowExisting: true });
  const jobs = fake.state(PROFILE).jobs;
  assert.equal(jobs.length, 2, 'created once, next to the user job');
  assert.equal(jobs.find((j) => j.id === 'mine').prompt, 'mine');
  const schedules = async (p = plan) => area(await verifyHermes(fake.hermes, a, p), 'schedules');
  assert.ok((await schedules()).ok);
  const ours = jobs.find((j) => j.id !== 'mine');
  ours.schedule = { kind: 'cron', expr: '0 1 * * *' };
  assert.match((await schedules()).issues.join('\n'), /schedule is 0 1 \* \* \*/);
  ours.schedule = { kind: 'cron', expr: AUTO.scheduleCron };
  fake.state(PROFILE).config.timezone = 'UTC';
  assert.match((await schedules()).issues.join('\n'), /time zone is UTC/);
  fake.state(PROFILE).config.timezone = 'Asia/Taipei';
  // With --activate-routines the job must be active; a paused one fails.
  const active = await schedules(buildPlan(a, root, { activateRoutines: true }));
  assert.equal(active.ok, false);
  assert.match(active.issues.join('\n'), /paused, expected scheduled/);
});

test('e: side conversations become sessions too; verify compares message content, not only counts', async (t) => {
  const root = tmp(t);
  const a = archive({ transcripts: [
    { rows: [{ seq: 1, role: 'user', text: 'main q' }, { seq: 2, role: 'assistant', text: 'main a' }] },
    { sessionId: 'side-1', rows: [{ seq: 1, role: 'user', text: 'side q' }, { seq: 2, role: 'assistant', text: 'side a' }] },
  ] });
  const plan = buildPlan(a, root);
  assert.deepEqual(plan.history.map((s) => s.messages.map((m) => m.content)), [['main q', 'main a'], ['side q', 'side a']]);
  assert.equal(new Set(plan.history.map((s) => s.foreign_id)).size, 2);
  const fake = fakeHermes(root);
  await applyHermes(fake.hermes, a, plan);
  assert.ok(area(await verifyHermes(fake.hermes, a, plan), 'history').ok);
  fake.state(PROFILE).sessions[1].messages[1].content = 'side a (edited)';
  const history = area(await verifyHermes(fake.hermes, a, plan), 'history');
  assert.equal(history.ok, false);
  assert.match(history.issues.join('\n'), /content differs/);
});

test('f: memory limits count existing entries and the SOUL fallback; schedule notes are written', async (t) => {
  const root = tmp(t);
  const a = archive({
    bot: { instructions: 'Review every merge request. '.repeat(10) },
    automations: [AUTO],
    box: [{ boxPath: `/home/box/sand-data/agents/${BOT}/memory/log/2026-10.md`, reason: 'bot-data', text: '- one fact\n- two fact\n' }],
  });
  const plan = buildPlan(a, root);
  assert.ok(plan.memory.some((m) => /became Hermes cron jobs|migrated as Hermes cron jobs/.test(m)), 'the schedule note is a memory entry');
  const fake = fakeHermes(root);
  userProfile(fake, 'You are my own assistant.');
  fake.state(PROFILE).memory.push('x'.repeat(2000));
  const applied = await applyHermes(fake.hermes, a, plan, { allowExisting: true });
  assert.deepEqual(stepOf(applied, 'memory').refused, []);
  assert.ok(Number(fake.state(PROFILE).config['memory.memory_char_limit']) > 2200);
  assert.ok(fake.state(PROFILE).memory.some((m) => m.startsWith('Grok Bot role for ')));
  const verified = await verifyHermes(fake.hermes, a, plan);
  assert.ok(area(verified, 'memory').ok);
  assert.ok(area(verified, 'role').ok, 'the role is in MEMORY.md');
});

test('g: the helper must exit 0 with {"ok":true}; a capability preflight runs before any change', async (t) => {
  const root = tmp(t);
  await assert.rejects(fakeHermes(root, { helperCode: 17 }).hermes.helper('readback', {}, { home: root }), /exit 17/);
  await assert.rejects(fakeHermes(root, { helper: () => 'Traceback (most recent call last):' }).hermes.helper('readback', {}, { home: root }), /failed/);
  const old = fakeHermes(root, { preflight: { ok: false, error: 'this Hermes lacks hermes_state.SessionDB.import_foreign_history' } });
  const a = archive();
  await assert.rejects(applyHermes(old.hermes, a, buildPlan(a, root)), /lacks hermes_state/);
  assert.ok(!old.calls.some((c) => c.args[0] === 'profile' && c.args[1] === 'create'), 'refused before the profile was created');
});

test('h: every captured area with data is mapped or reported, and nothing is cut short', () => {
  const longRole = 'Role line. '.repeat(800);
  const longMessage = 'm'.repeat(20_000);
  const a = archive({
    bot: { instructions: longRole },
    transcripts: [
      { rows: [{ seq: 1, role: 'user', text: longMessage }, { seq: 2, role: 'event', text: '{"tool":"x"}' }], unreadable: 2 },
      { sessionId: 'side-1', rows: [{ seq: 1, role: 'user', text: 'side question' }] },
    ],
    todos: [{ id: 't1', content: 'open one', status: 'pending' }, { id: 't2', content: 'done one', status: 'completed' }],
    tasks: [{ source: 'task', id: 'k1' }],
    subagents: [{ id: 'sa1', name: 'reviewer', status: 'running' }],
    serverFiles: [{ path: 'a.txt', size: 1 }, { path: 'b.txt', size: 2 }, { path: 'c.txt', size: 3 }],
    serverMemories: [{ id: 'm1', text: 'Server-side fact: deploys at noon.' }],
    serverSkills: [{ id: 's1', name: 'fixer', source: 'user' }, { id: 's2', name: 'web-search', source: 'managed' }],
    library: [{ title: 'Runbook', url: 'https://docs.example/runbook', provider: 'drive', kind: 'doc' }],
    connectors: [{ name: 'Linear' }],
    groups: [{ name: 'Ops room', members: [] }],
    skipped: [{ boxPath: '/home/box/.secrets/x.env', reason: 'credential path; never exported (sign in again on the destination)' }, { boxPath: '/home/box/big.iso', reason: 'larger than 8 bytes (100)', size: 100 }],
    coverage: {
      subagents: { status: 'complete', running: 1 }, serverFiles: { status: 'complete', count: 3 },
      boxStore: { status: 'partial', unresolvedReferences: ['/home/box/missing.sh'] },
      routines: { status: 'failed', reason: '500 internal' }, sessions: { status: 'unavailable', reason: '403 permission_denied' },
    },
    box: [
      { boxPath: '/home/box/sand-data/workflows/fixer/SKILL.md', reason: 'skill', text: '---\nname: fixer\ndescription: Fix\n---\n' },
      { boxPath: '/home/box/link', kind: 'symlink', target: '/elsewhere' },
    ],
  });
  const plan = buildPlan(a, '/r');
  const reported = (re) => assert.ok(plan.notMigrated.some((n) => re.test(n.item)), String(re));
  assert.ok(plan.soul.includes(longRole.trim()), 'the whole role');
  assert.equal(plan.history[0].messages[0].content, longMessage, 'the whole message');
  assert.equal(plan.history.length, 2, 'the side conversation is a session');
  reported(/^1 row\(s\) of the main conversation that are not user or assistant text$/);
  reported(/^2 unreadable row\(s\) of the main conversation$/);
  assert.ok(plan.memory.some((m) => m.includes('open one')));
  reported(/^1 finished todo\(s\)$/);
  reported(/^1 Grok Bot task record\(s\)$/);
  reported(/^1 Grok Bot subagent\(s\): reviewer$/);
  assert.ok(plan.memory.includes('Server-side fact: deploys at noon.'));
  reported(/^skill "web-search"$/);
  assert.ok(!plan.notMigrated.some((n) => n.item === 'skill "fixer"'), 'a server skill with a migrated folder is mapped');
  reported(/^1 library document\(s\): Runbook$/);
  reported(/^3 file\(s\) in the Grok Bot file list$/);
  reported(/^connector "Linear"$/);
  reported(/^group chat "Ops room"$/);
  reported(/^\/home\/box\/\.secrets\/x\.env$/);
  reported(/^\/home\/box\/big\.iso$/);
  reported(/^\/home\/box\/link$/);
  reported(/^\/home\/box\/missing\.sh$/);
  reported(/^routines$/);
  reported(/^sessions$/);
  // An older archive has the counts in coverage only.
  const older = archive({ coverage: { subagents: { status: 'complete', running: 2 }, serverFiles: { status: 'complete', count: 4 } } });
  const olderItems = buildPlan(older, '/r').notMigrated.map((n) => n.item);
  assert.ok(olderItems.includes('2 Grok Bot subagent(s)') && olderItems.includes('4 file(s) in the Grok Bot file list'));
});

test('i: acceptance never counts a keyword the question already contains', () => {
  const a = archive({
    bot: { name: 'Scout · helper' },
    automations: [{ ...AUTO, enabled: false }],
    todos: [{ id: 't1', content: 'Ship release-train-42 after QA', status: 'pending' }],
    transcripts: [{ rows: [
      { seq: 1, role: 'user', text: 'Deploy ticket42 to stage-3 cluster' },
      { seq: 2, role: 'assistant', text: 'done' },
      { seq: 3, role: 'user', text: 'thanks' },
    ] }],
    box: [
      { boxPath: '/home/box/sand-data/workflows/fixer9/SKILL.md', reason: 'skill', text: '---\nname: fixer9\ndescription: Use fixer9 for pipeline7 jobs\n---\n' },
      { boxPath: '/home/box/bin/deploy-qa-scan', text: '#!/bin/sh\n# deploy-qa-scan\nPROJECT=proj-alpha9\n' },
    ],
  });
  const qs = acceptanceQuestions(a, buildPlan(a, '/r'));
  for (const q of qs) for (const alt of q.expect.flat()) assert.ok(!norm(q.prompt).includes(norm(alt)), `${q.area}: "${alt}" is in the question`);
  const history = qs.find((q) => q.area === 'history');
  assert.match(history.prompt, /ticket42/);
  assert.deepEqual(history.expect, ['stage-3']);
  assert.deepEqual(qs.find((q) => q.area === 'skills').expect, ['pipeline7']);
  assert.deepEqual(qs.find((q) => q.area === 'files').expect, ['proj-alpha9']);
  assert.ok(qs.find((q) => q.area === 'schedules').expect.some((e) => Array.isArray(e) && e.includes('paused')));
});
