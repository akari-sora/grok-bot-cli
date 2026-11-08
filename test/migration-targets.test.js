import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MIGRATION_TARGETS, HANDOFF_PAYLOAD_BYTES, targetCapability, splitHandoff, destinationFiles } from '../src/core/migration-targets.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const agent = (id, kind = 'bot') => ({ id, kind, name: '同名角色', title: '', instructions: 'Only work on the selected task. 🐕', members: [],
  transcript: { coverage: 'tail-only', limit: 200, messages: [{ id: 'm1', role: 'user', text: '歷史資料', timestamp: null }] },
  workflowsCoverage: 'observed-only', workflows: [
    { id: 'same/../workflow', name: 'Research', description: 'Check sources', source: 'workflow', body: 'Research approved topics.', schedule: null },
    { id: 'p1', name: 'Plugin', description: '', source: 'plugin', body: 'Plugin text', schedule: null },
    { id: 'a1', name: 'Routine', description: '', source: 'automation', body: 'Scheduled work', schedule: '0 9 * * *' },
  ] });
const sample = () => ({ version: 1, capturedAt: '2026-11-08T00:00:00.000Z', source: { platform: 'grok-bot', mode: 'gateway', rosterCoverage: 'returned-only' }, agents: [agent('one'), agent('two'), agent('room', 'group')], errors: [] });
const filesFor = (to, opts = {}) => destinationFiles(sample(), { to, ...opts });
const payload = (text) => JSON.parse(text.slice(text.indexOf('{')));

test('capabilities distinguish file staging, native input and context-only handoff', () => {
  assert.deepEqual(MIGRATION_TARGETS, ['openclaw', 'hermes', 'muse', 'dot', 'portable']);
  assert.equal(targetCapability('hermes').trinity, 'not-required');
  assert.equal(targetCapability('hermes').roleStrategy, 'skills-in-one-agent');
  assert.equal(targetCapability('muse').scope, 'context-handoff-package');
  assert.equal(targetCapability('dot').automaticDelivery, false);
  for (const target of MIGRATION_TARGETS) assert.equal(targetCapability(target).memoryRestored, false);
});
for (const bad of ['unknown', '../muse', '__proto__', '', null]) test('reject unknown target ' + bad, () => {
  assert.throws(() => targetCapability(bad), /Unsupported/);
});
test('legacy OpenClaw conversion remains separate to avoid breaking v1 hashes', () => {
  assert.throws(() => filesFor('openclaw'), /legacy/);
});
test('Hermes produces one native bundle with task roles as skills, not persona/memory clones', () => {
  const files = filesFor('hermes');
  const data = JSON.parse(files.get('grok-bot-export.json'));
  assert.equal(data.format, 'grok-bot-export');
  assert.equal(data.version, 1);
  assert.equal(data.bots.length, 1);
  const bot = data.bots[0];
  assert.equal(bot.instructions, '');
  for (const field of ['memories', 'user_facts', 'apps', 'routines']) assert.deepEqual(bot[field], []);
  assert.equal(bot.skills.length, 2);
  assert.ok(bot.skills.every((skill) => skill.name.startsWith('grok-role-')));
  assert.ok(bot.skills.every((skill) => skill.instructions.includes('Only work on the selected task. 🐕')));
});
test('duplicate names and repeated workflow ids across bots remain distinct native skill ids', () => {
  const files = filesFor('hermes', { includeSkills: true });
  const skills = JSON.parse(files.get('grok-bot-export.json')).bots[0].skills;
  assert.equal(skills.length, 4);
  assert.equal(new Set(skills.map((row) => row.name)).size, 4);
  assert.ok(skills.every((row) => /^[a-z0-9-]+$/.test(row.name)));
  assert.equal(skills.some((row) => /Plugin text|Scheduled work/.test(row.instructions)), false);
});
test('role map preserves the original names and ids without relying on names for identity', () => {
  const map = JSON.parse(filesFor('hermes').get('ROLE-MAP.json'));
  assert.deepEqual(map.map((row) => row.sourceId), ['one', 'two']);
  assert.equal(map[0].originalName, '同名角色');
  assert.notEqual(map[0].roleSkill, map[1].roleSkill);
});
test('empty role instructions are explicit, not invented', () => {
  const s = sample(); s.agents[0].instructions = '';
  const files = destinationFiles(s, { to: 'hermes' });
  assert.equal(JSON.parse(files.get('ROLE-MAP.json'))[0].roleSkill, null);
  assert.equal(JSON.parse(files.get('grok-bot-export.json')).bots[0].skills.length, 1);
});
for (const to of ['hermes', 'muse', 'dot', 'portable']) test(to + ' retains the complete observed snapshot, including groups and schedules', () => {
  assert.deepEqual(JSON.parse(filesFor(to).get('archive/snapshot.json')), sample());
  assert.match(filesFor(to).get('REPORT.md'), /Hermes|handoff|Portable/);
});
for (const to of ['muse', 'dot']) {
  test(to + ' packets reconstruct exact observed data, with explicit source and ordered digests', () => {
    const s = sample(); s.agents[0].instructions = '漢字🐕\n'.repeat(5000);
    const files = destinationFiles(s, { to });
    const index = JSON.parse(files.get('handoff/index.json'));
    assert.equal(index.sent, false);
    assert.equal(index.deliveries.length, 2);
    for (const delivery of index.deliveries) {
      const fragments = delivery.parts.map((part, i) => {
        const p = payload(files.get(part.path));
        assert.equal(p.part, i + 1);
        assert.equal(p.total, delivery.parts.length);
        assert.equal(p.target, to);
        assert.equal(p.sourceId, delivery.sourceId);
        assert.equal(p.fragmentDigest, hash(p.payload));
        assert.equal(part.payloadSha256, p.fragmentDigest);
        assert.ok(Buffer.byteLength(p.payload) <= HANDOFF_PAYLOAD_BYTES);
        assert.equal(part.payloadBytes, Buffer.byteLength(p.payload));
        return p.payload;
      });
      const combined = fragments.join('');
      assert.equal(hash(combined), delivery.payloadDigest);
      assert.equal(Buffer.byteLength(combined), delivery.payloadBytes);
      const restored = JSON.parse(combined);
      const original = s.agents.find((a) => a.id === delivery.sourceId);
      assert.equal(restored.instructions, original.instructions);
      assert.deepEqual(restored.transcript, original.transcript);
      assert.ok(restored.workflows.every((w) => w.body === null));
      assert.equal(restored.workflowBodiesIncluded, false);
    }
  });
  test(to + ' workflow bodies require explicit inclusion', () => {
    const files = filesFor(to, { includeSkills: true });
    const d = JSON.parse(files.get('handoff/index.json')).deliveries[0];
    const restored = JSON.parse(d.parts.map((part) => payload(files.get(part.path)).payload).join(''));
    assert.equal(restored.workflows[0].body, 'Research approved topics.');
    assert.equal(restored.workflowBodiesIncluded, true);
  });
}
test('handoff does not execute a transport or generate a bulk auto-send script', () => {
  const files = filesFor('muse');
  assert.equal([...files.keys()].some((path) => /\.(sh|ps1|py|js|mjs)$/.test(path)), false);
  assert.match(files.get('REPORT.md'), /child-process argv/);
  assert.match(files.get('REPORT.md'), /not an idempotent retry/);
  assert.match(files.get('REPORT.md'), /not proof of durable memory/);
});
for (const text of ['', '🐕'.repeat(4097), '\u0000\r\n```json\n{"x":"y"}', '漢e\u0301🐈'.repeat(5000)]) {
  test('Unicode splitting round trip: ' + JSON.stringify(text.slice(0, 30)), () => {
    const parts = splitHandoff(text, 97);
    assert.equal(parts.join(''), text);
    assert.ok(parts.every((part) => Buffer.byteLength(part) <= 97));
    assert.ok(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part)));
  });
}
for (const cap of [0, 3, 1.5, 8193, NaN]) test('invalid chunk budget ' + cap, () => {
  assert.throws(() => splitHandoff('x', cap), /Invalid/);
});
test('all destination files are deterministic and use safe metadata-independent paths', () => {
  const s = sample(); s.agents[0].id = '../../CON:evil'; s.agents[0].name = '`$(rm -rf ~)`';
  for (const to of ['hermes', 'muse', 'dot', 'portable']) {
    const first = destinationFiles(s, { to });
    assert.deepEqual([...destinationFiles(s, { to })], [...first]);
    assert.ok([...first.keys()].every((path) => !path.includes('..') && !path.includes('$') && !path.includes('CON')));
  }
});
