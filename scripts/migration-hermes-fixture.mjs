// Writes a synthetic archive v2 into argv[2], then
//   (no flag)          prints the grok-bot-export.json the Hermes destination bundles, for the
//                      official importer contract;
//   --hermes BIN       imports it twice through gbot's own path (applyHermes + verifyHermes, the
//                      helper ops over `BIN --print-runtime-command`) and prints both reports;
//   --real BIN HOME    runs the helper store ops twice and gbot's `cron create` once against the installed
//                      Hermes with HERMES_HOME=HOME (a scratch home under the Hermes root, not a registered
//                      profile) and prints what Hermes read back next to what the plan expects.
// Used by scripts/verify-hermes-import.py.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeArchive, openArchive } from '../src/core/migration-archive.js';
import { Hermes, applyHermes, buildHermesPlan, cronCreateArgs, inspectHermes, summarizeHermesPlan, verifyHermes } from '../src/core/migration-hermes.js';

const [, , out, flag, bin, scratchHome] = process.argv;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const file = (boxPath, text, reason) => { const bytes = Buffer.from(text); return { boxPath, reason, kind: 'file', size: bytes.length, sha256: sha(bytes), mode: 420, bytes }; };
const entries = (texts) => texts.map(([role, text], i) => {
  const message = { seq: i + 1, role, text, timestampMs: 1790000000000 + i * 1000 };
  return { message, row: { seq: String(i + 1) }, body: { role, content: text } };
});
const transcript = (sessionId, texts) => ({ sessionId, entries: entries(texts), pages: 1, generation: 1, firstSeq: 1, lastSeq: texts.length, unreadable: 0, gaps: [] });
const id = 'bbbbbbbb-1111-2222-3333-444444444444';
const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const cap = {
  format: 'gbot-migration', version: 2, capturedAt: '2026-11-08T00:00:00.000Z', source: { platform: 'grok-bot', harness: 'temporal' },
  bot: { id, name: 'Deploy QA · Watch & merge', title: '', instructions: 'Watch aa22396584/telltale; merge green MRs. 繁體中文 🐕', kind: 'bot', members: [] },
  groups: [], sessions: [{ sessionId: 'side-1' }], todos: [], tasks: [], serverMemories: [], serverSkills: [], connectors: [], library: [], skipped: [], coverage: {},
  transcripts: [
    transcript('', [['user', 'Merge !65 once green'], ['assistant', 'Merged !65.'], ['user', 'Deploy key is ' + token]]),
    transcript('side-1', [['user', 'Side question about stage-3'], ['assistant', 'Side answer']]),
  ],
  automations: [
    { id: 'a1', name: 'Hourly scan', prompt: 'Run the scan.', enabled: false, trigger: 'schedule', scheduleCron: '52 9-21 * * 1-5', timezone: 'Asia/Taipei', scheduleText: 'hourly', triggerDetails: '' },
    { id: 'a2', name: 'On PR', prompt: 'Review the PR.', enabled: true, trigger: 'github', scheduleCron: '', timezone: null, scheduleText: '', triggerDetails: '[]' },
  ],
  files: [
    file(`/home/box/sand-data/agents/${id}/memory/profile.md`, '# About the user\n- (2026-09-14) The user handle is ImL1s.\n', 'bot-data'),
    file(`/home/box/sand-data/agents/${id}/memory/log/2026-10.md`, `- (2026-10-02) Scan script lives in bin.\n- (2026-10-03) Old deploy key ${token}\n`, 'bot-data'),
    file('/home/box/sand-data/workflows/ci-fixer/SKILL.md', '---\nname: ci-fixer\ndescription: Fix red pipelines\n---\n# CI fixer\nSteps 一二三.\n', 'skill'),
    file('/home/box/sand-data/workflows/ci-fixer/run.sh', '#!/bin/sh\necho fix\n', 'skill'),
    file('/home/box/sand-data/workflows/same-name/SKILL.md', '---\nname: same-name\ndescription: Second skill\n---\nBody two.\n', 'skill'),
  ],
};
const { root } = writeArchive(cap, join(out, 'archive'));
const archive = openArchive(root);
if (flag === '--hermes') {
  const hermes = new Hermes({ bin });
  const once = async () => {
    const dest = await inspectHermes(hermes, { profile: 'grok-deploy-qa' });
    const plan = buildHermesPlan(archive, { profile: 'grok-deploy-qa', profileDir: dest.profileDir });
    const summary = summarizeHermesPlan(plan, dest);
    const applied = await applyHermes(hermes, archive, plan);
    return { profileDir: applied.profileDir, summary, steps: applied.steps, verify: await verifyHermes(hermes, archive, plan), sessions: plan.history.length };
  };
  const first = await once();
  process.stdout.write(JSON.stringify({ first, second: await once() }));
} else if (flag === '--real') {
  const hermes = new Hermes({ bin });
  const home = scratchHome;
  const preflight = await hermes.preflight(await hermes.rootDir());
  const plan = buildHermesPlan(archive, { profile: 'grok-contract', profileDir: home });
  for (const s of plan.skills) for (const f of s.files) { mkdirSync(dirname(f.dest), { recursive: true }); writeFileSync(f.dest, f.bytes); }
  const entries = [...plan.user.map((content) => ({ target: 'user', content })), ...plan.memory.map((content) => ({ target: 'memory', content }))];
  const sessions = plan.history.map(({ digest, ...s }) => ({ ...s, path: plan.historyPath, cwd: home }));
  const once = async () => ({
    memory: (await hermes.helper('memory-add', { memory_char_limit: plan.limits.memory, user_char_limit: plan.limits.user, entries }, { home })).results.map((r) => r.status),
    history: (await hermes.helper('import-history', { profile: 'grok-contract', sessions }, { home })).results.map((r) => r.already_imported),
  });
  const first = await once(), second = await once();
  // gbot's own cron arguments; HERMES_HOME selects the scratch home instead of `-p PROFILE`.
  const [job] = plan.cron;
  mkdirSync(plan.base, { recursive: true });
  await hermes.run(cronCreateArgs(plan, job).slice(2), { env: { HERMES_HOME: home }, timeoutMs: 120_000 });
  const rb = await hermes.helper('readback', { foreign_ids: plan.history.map((s) => s.foreign_id), history_path: plan.historyPath, grok_sessions: true }, { home });
  process.stdout.write(JSON.stringify({ versions: preflight.versions, first, second,
    readback: { memory: rb.memory, user: rb.user, limits: rb.limits, timezone: rb.timezone, cron: rb.cron, skills: rb.skills, sessions: rb.sessions, grok_sessions: rb.grok_sessions },
    expected: { memory: plan.memory, user: plan.user, sessions: plan.history.map((s) => ({ foreign_id: s.foreign_id, messages: s.messages.length, digest: s.digest })),
      job: { tag: job.tag, schedule: job.schedule, prompt: job.prompt, workdir: plan.base } } }));
} else {
  const plan = buildHermesPlan(archive, { profileDir: join(out, 'profile') });
  const exportPath = [...plan.docs.keys()].find((p) => p.endsWith('grok-bot-export.json'));
  process.stdout.write(plan.docs.get(exportPath).toString('utf8'));
}
