import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLiveCapture, openRoutineSwitch } from '../src/core/migration-source.js';

function withEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

function isolatedHome(t, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gbot-migration-source-'));
  withEnv(t, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(home, '.config'),
    GROK_BOT_TEST: '1', CURSOR_API_BASE_URL: 'http://127.0.0.1:1350', CURSOR_ACCESS_TOKEN: null, GROK_BOT_GATEWAY_URL: null,
    GROK_BOT_GATEWAY_TOKEN: null, GBOT_ACCOUNT: null, GBOT_ACCOUNT_SCOPE: null, GBOT_CONFIG: null, ...extra });
}

test('gateway override cannot silently override the requested migration account', async (t) => {
  isolatedHome(t, { GROK_BOT_GATEWAY_URL: 'http://127.0.0.1:1340', GROK_BOT_GATEWAY_TOKEN: 'test-only-token' });
  await assert.rejects(openLiveCapture({ account: 'example' }), /Remove gateway overrides/);
  await assert.rejects(openLiveCapture({}), /app login/);
});

test('opening the source never contacts the box: no describe, no wake, only allowlisted reads', async (t) => {
  isolatedHome(t, { CURSOR_ACCESS_TOKEN: 'synthetic-access-do-not-leak' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? String(options.body) : '' });
    return new Response(JSON.stringify({ agents: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const io = await openLiveCapture({});
  assert.equal(calls.length, 0, 'opening must not make a request');
  await io.rpc('ListGrokBotAgents', {});
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /GrokBotService\/ListGrokBotAgents$/);
  assert.ok(!calls.some((c) => /EnsureSandBox|DescribeSandBox|wake/i.test(c.url + c.body)));
  await assert.rejects(io.rpc('SendGrokBotMessage', {}), /not a read-only migration RPC/);
  await assert.rejects(io.rpc('EnsureSandBox', { wake: true }), /not a read-only migration RPC/);
  assert.equal(calls.length, 1);
});

test('a login without a saved access token is refused before any request', async (t) => {
  isolatedHome(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(String(url)); return new Response('{}'); });
  await assert.rejects(openLiveCapture({}), /no saved Grok Bot access token/);
  assert.equal(calls.length, 0);
});

test('the routine switch sends the app\'s SetGrokBotAgentAutomationEnabled body and reads the routine from the answer', async (t) => {
  isolatedHome(t, { CURSOR_ACCESS_TOKEN: 'synthetic-access-do-not-leak', TZ: 'Europe/Berlin' });
  const calls = [];
  const record = (id, isEnabled) => ({ recordJson: JSON.stringify({ id, name: 'Hourly scan', prompt: 'p', trigger: { type: 'cron', schedule: '0 9 * * *' }, isEnabled }), automationId: 'srv-' + id });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(String(options.body)) });
    return new Response(JSON.stringify({ automations: [record('a0', true), { recordJson: 'not json' }, record('a1', false)] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const control = openRoutineSwitch({});
  assert.equal(calls.length, 0, 'opening it makes no request');
  const now = await control.setEnabled('bot-1', 'a1', false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/aiserver\.v1\.GrokBotService\/SetGrokBotAgentAutomationEnabled$/);
  assert.deepEqual(calls[0].body, { agentId: 'bot-1', automationId: 'a1', isEnabled: false, timeZone: 'Europe/Berlin' });
  assert.equal(now.id, 'a1');
  assert.equal(now.enabled, false);
  assert.equal(await control.setEnabled('bot-1', 'missing', false), null, 'not in the answer');
  assert.ok(!calls.some((c) => /EnsureSandBox|DescribeSandBox|wake/i.test(c.url)), 'the box is not touched');
  // The capture IO still cannot make this write.
  const io = await openLiveCapture({});
  await assert.rejects(io.rpc('SetGrokBotAgentAutomationEnabled', {}), /not a read-only migration RPC/);
});

test('the routine switch needs a login with a saved access token, before any request', async (t) => {
  isolatedHome(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(String(url)); return new Response('{}'); });
  assert.throws(() => openRoutineSwitch({}), /no saved Grok Bot access token/);
  isolatedHome(t, { GROK_BOT_GATEWAY_URL: 'http://127.0.0.1:1340', GROK_BOT_GATEWAY_TOKEN: 'test-only-token' });
  assert.throws(() => openRoutineSwitch({ account: 'example' }), /Remove gateway overrides/);
  assert.equal(calls.length, 0);
});
