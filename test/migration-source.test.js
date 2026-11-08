import test from 'node:test';
import assert from 'node:assert/strict';
import { readMigrationWorkflows, openMigrationSource } from '../src/core/migration-source.js';

const session = { gatewayUrl: 'http://127.0.0.1:1340', gatewayToken: 'test-only-migration-token' };
function reply(t, body, status = 200) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  });
  return calls;
}
test('workflow reader preserves observed bodies, omits credentials and uses only the read endpoint', async (t) => {
  const calls = reply(t, { workflows: [{ id: 's1', name: 'Skill', source: 'workflow', body: 'Full body', token: 'must-not-copy', trigger: { schedule: '0 9 * * *' } }] });
  const value = await readMigrationWorkflows(session, 'b1');
  assert.deepEqual(value, [{ id: 's1', name: 'Skill', description: '', source: 'workflow', body: 'Full body', schedule: '0 9 * * *' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:1340/api/getAgentWorkflows');
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: 'b1' });
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.method, 'POST');
});
test('array workflow response and numeric source ids are preserved explicitly', async (t) => {
  reply(t, [{ id: 12, name: 'Metadata only', markdown: 'Unverified field is not guessed' }]);
  assert.deepEqual(await readMigrationWorkflows(session, 'b1'), [{ id: '12', name: 'Metadata only', description: '', source: 'unknown', body: null, schedule: null }]);
});
for (const data of [{}, { workflows: {} }, [null], [{ id: {} }], 'not-json']) {
  test('workflow protocol drift is not silently treated as an empty library: ' + JSON.stringify(data), async (t) => {
    reply(t, data);
    await assert.rejects(readMigrationWorkflows(session, 'b1'), /workflow|Workflow/);
  });
}
test('HTTP error bodies and echoed credentials are not propagated', async (t) => {
  const calls = reply(t, 'secret=do-not-report', 401);
  await assert.rejects(readMigrationWorkflows(session, 'b1'), (e) => /HTTP 401/.test(e.message) && !e.message.includes('do-not-report'));
  assert.equal(calls.length, 1); // No retry, send, fallback or automatic consent.
});
test('workflow response cap applies to streamed bodies', async (t) => {
  const previous = process.env.GBOT_MAX_RESPONSE_BYTES;
  process.env.GBOT_MAX_RESPONSE_BYTES = '65536';
  t.after(() => { if (previous === undefined) delete process.env.GBOT_MAX_RESPONSE_BYTES; else process.env.GBOT_MAX_RESPONSE_BYTES = previous; });
  reply(t, 'x'.repeat(65537));
  await assert.rejects(readMigrationWorkflows(session, 'b1'), /read budget/);
});
test('workflow host policy refuses foreign hosts before fetch', async (t) => {
  const calls = reply(t, []);
  await assert.rejects(readMigrationWorkflows({ ...session, gatewayUrl: 'https://foreign.example' }, 'b1'), /Rejected|loopback/);
  assert.equal(calls.length, 0);
});
test('invalid owner fails before fetch', async (t) => {
  const calls = reply(t, []);
  await assert.rejects(readMigrationWorkflows(session, ''), /owner id/);
  assert.equal(calls.length, 0);
});
test('local files cannot silently ignore an explicit account selection', async () => {
  await assert.rejects(openMigrationSource({ account: 'example', files: true }), /cannot be combined/);
});
test('gateway override cannot silently override the requested migration account', async (t) => {
  const keys = ['GROK_BOT_GATEWAY_URL', 'GROK_BOT_GATEWAY_TOKEN'];
  const previous = keys.map((key) => process.env[key]);
  keys.forEach((key, i) => { process.env[key] = i ? 'test-only-token' : session.gatewayUrl; });
  t.after(() => keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
  await assert.rejects(openMigrationSource({ account: 'example' }), /Remove gateway overrides/);
});
