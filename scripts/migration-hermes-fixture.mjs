// Writes a synthetic archive v2 into argv[2] and prints the grok-bot-export.json that the Hermes
// destination generates for it. Used by scripts/verify-hermes-import.py with the official importer.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeArchive, openArchive } from '../src/core/migration-archive.js';
import { buildHermesPlan } from '../src/core/migration-hermes.js';

const out = process.argv[2];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const file = (boxPath, text, reason) => { const bytes = Buffer.from(text); return { boxPath, reason, kind: 'file', size: bytes.length, sha256: sha(bytes), mode: 420, bytes }; };
const id = 'bbbbbbbb-1111-2222-3333-444444444444';
const cap = {
  format: 'gbot-migration', version: 2, capturedAt: '2026-11-08T00:00:00.000Z', source: { platform: 'grok-bot', harness: 'temporal' },
  bot: { id, name: 'Deploy QA · Watch & merge', title: '', instructions: 'Watch aa22396584/telltale; merge green MRs. 繁體中文 🐕', kind: 'bot', members: [] },
  groups: [], sessions: [], transcripts: [], todos: [], tasks: [], serverMemories: [], serverSkills: [], workflows: [], connectors: [], library: [], skipped: [], coverage: {},
  automations: [
    { id: 'a1', name: 'Hourly scan', prompt: 'Run the scan.', enabled: false, trigger: 'schedule', scheduleCron: '52 9-21 * * 1-5', timezone: 'Asia/Taipei', scheduleText: 'hourly', triggerDetails: '' },
    { id: 'a2', name: 'On PR', prompt: 'Review the PR.', enabled: true, trigger: 'github', scheduleCron: '', timezone: null, scheduleText: '', triggerDetails: '[]' },
  ],
  files: [
    file(`/home/box/sand-data/agents/${id}/memory/profile.md`, '# About the user\n- (2026-09-14) The user handle is ImL1s.\n', 'bot-data'),
    file(`/home/box/sand-data/agents/${id}/memory/log/2026-10.md`, '- (2026-10-02) Scan script lives in bin.\n', 'bot-data'),
    file('/home/box/sand-data/workflows/ci-fixer/SKILL.md', '---\nname: ci-fixer\ndescription: Fix red pipelines\n---\n# CI fixer\nSteps 一二三.\n', 'skill'),
    file('/home/box/sand-data/workflows/ci-fixer/run.sh', '#!/bin/sh\necho fix\n', 'skill'),
    file('/home/box/sand-data/workflows/same-name/SKILL.md', '---\nname: same-name\ndescription: Second skill\n---\nBody two.\n', 'skill'),
  ],
};
const { root } = writeArchive(cap, join(out, 'archive'));
const plan = buildHermesPlan(openArchive(root), { profileDir: join(out, 'profile') });
const exportPath = [...plan.docs.keys()].find((p) => p.endsWith('grok-bot-export.json'));
process.stdout.write(plan.docs.get(exportPath).toString('utf8'));
