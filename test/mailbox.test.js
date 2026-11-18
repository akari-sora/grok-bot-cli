import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePacket, decodePacket, makePacket, sendMailbox, readMailbox, MAILBOX_HEADER } from '../src/core/mailbox.js';

const packet = (overrides = {}) => makePacket({ id: 'packet-1', from: 'alpha', to: 'beta', topic: 'work', body: 'plain data', ...overrides });
const entry = (id, role, text) => ({ id, role, text });
const target = { id: 'bot-id', name: 'demo-bot', isGroup: false };
const backendFor = (entries) => ({ resolve: async () => target, transcript: async () => ({ target, transcript: { entries } }) });

test('protocol round-trips text and rejects header, duplicate keys and malformed labels', () => {
  const encoded = encodePacket(packet());
  assert.deepEqual(decodePacket(encoded), packet());
  assert.equal(decodePacket('prefix ' + encoded), null);
  assert.deepEqual(decodePacket(encoded + '\n'), packet());
  assert.deepEqual(decodePacket(MAILBOX_HEADER + JSON.stringify({ body: 'plain data', replyTo: null, topic: 'work', to: 'beta', from: 'alpha', id: 'packet-1' }, null, 2)), packet());
  assert.equal(decodePacket(MAILBOX_HEADER + '{"id":"x","id":"y","from":"alpha","to":null,"topic":null,"replyTo":null,"body":"data"}'), null);
  assert.throws(() => packet({ to: '../beta' }));
  assert.throws(() => packet({ body: 'x'.repeat(48 * 1024 + 1) }));
  assert.throws(() => encodePacket(packet({ body: '\n'.repeat(40000) })), /Encoded mailbox packet/);
  assert.equal(decodePacket(MAILBOX_HEADER + '{"id":"x"}'), null);
});

test('only assistant packets to selected recipient and topic are returned; user echo is ignored', async () => {
  const good = encodePacket(packet());
  const entries = [entry('1','user',good), entry('2','assistant',encodePacket(packet({ to: 'other' }))), entry('3','assistant',encodePacket(packet({ topic: 'other' }))), entry('4','assistant',good), entry('5','unknown',good), entry('6','assistant','ordinary text')];
  const result = await readMailbox(backendFor(entries), 'demo', { recipient: 'beta', topic: 'work' });
  assert.deepEqual(result.messages.map((x) => x.entryId), ['4']);
  assert.equal(result.cursor, '6');
  assert.equal(result.gapReset, false);
});

test('target mismatch, ambiguous role, missing transcript and cursor gap fail closed or report gap', async () => {
  const good = encodePacket(packet());
  await assert.rejects(readMailbox({ ...backendFor([]), resolve: async () => ({ id: 'different' }) }, 'demo', { recipient: 'beta' }), /target mismatch/);
  await assert.rejects(readMailbox({ ...backendFor([]), transcript: async () => ({ target, transcript: {} }) }, 'demo', { recipient: 'beta' }), /Invalid mailbox transcript/);
  const result = await readMailbox(backendFor([{ id: '1', role: 'assistant', message: { role: 'user', content: good } }]), 'demo', { recipient: 'beta', after: 'missing' });
  assert.equal(result.gapReset, true); assert.deepEqual(result.messages, []);
});

test('bounded wait advances cursor and returns a new addressed packet', async () => {
  let ms = 0; let polls = 0;
  const backend = { resolve: async () => target, transcript: async () => ({ target, transcript: { entries: ++polls === 1 ? [entry('1','user','noise')] : [entry('1','user','noise'), entry('2','assistant',encodePacket(packet()))] } }) };
  const out = await readMailbox(backend, 'demo', { recipient: 'beta', waitSeconds: 3, now: () => ms, sleep: async (step) => { ms += step; } });
  assert.equal(polls, 2); assert.equal(out.cursor, '2'); assert.equal(out.messages.length, 1); assert.equal(out.timedOut, false);
  const empty = await readMailbox(backendFor([]), 'demo', { recipient: 'beta', waitSeconds: 2, now: () => ms, sleep: async (step) => { ms += step; } });
  assert.equal(empty.timedOut, true); assert.equal(ms, 3000);
});

test('send preserves delivery ambiguity and does not claim reply', async () => {
  let sent;
  const out = await sendMailbox({ send: async (target, data) => { sent = {target,data}; return { delivery: 'unknown', clientNonce: 'nonce' }; } }, 'demo', packet());
  assert.equal(sent.target, 'demo'); assert.deepEqual(decodePacket(sent.data), packet());
  assert.equal(out.delivery, 'unknown'); assert.equal(out.replyReceived, false); assert.equal(out.clientNonce, 'nonce');
});


test('unattributed opt-in requires addressed non-self packet and excludes user role evidence', async () => {
  const incoming = encodePacket(packet());
  const entries = [entry('1', 'unknown', incoming), entry('2', 'user', incoming),
    entry('3', 'unknown', encodePacket(packet({ to: null }))),
    entry('4', 'unknown', encodePacket(packet({ from: 'beta' }))),
    { id: '5', role: 'assistant', message: { role: 'user', content: incoming } }];
  const base = await readMailbox(backendFor(entries), 'demo', { recipient: 'beta' });
  assert.equal(base.messages.length, 0);
  const out = await readMailbox(backendFor(entries), 'demo', { recipient: 'beta', includeUnattributed: true });
  assert.deepEqual(out.messages.map((m) => [m.entryId, m.provenance]), [['1', 'unattributed']]);
});
