import { destinationFiles } from '../src/core/migration-targets.js';
const agents = ['first', 'second'].map((id) => ({
  id, kind: 'bot', name: '同名 Researcher', title: '', instructions: 'Only research approved tasks. 🐕', members: [],
  transcript: { coverage: 'tail-only', limit: 200, messages: [] }, workflowsCoverage: 'observed-only',
  workflows: [{ id: 'same-id', name: 'Research', description: 'Use sources.', source: 'workflow', body: 'Inspect the approved source. 漢字', schedule: null }],
}));
const snapshot = { version: 1, capturedAt: '2026-11-08T00:00:00.000Z', source: { platform: 'grok-bot', mode: 'gateway', rosterCoverage: 'returned-only' }, agents, errors: [] };
process.stdout.write(destinationFiles(snapshot, { to: 'hermes', includeSkills: true }).get('grok-bot-export.json'));
