import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { readArchive } from '../src/core/migration.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'gbot.mjs');
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Generated migration CLI timed out')); }, 30000);
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('generated CLI: inspect, read-only export, offline plan/apply/verify and partial failures', { timeout: 120000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gbot-migration-cli-'));
  const calls = [];
  let failTranscript = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const method = req.url.split('/').pop();
    calls.push({ method, body });
    res.setHeader('content-type', 'application/json');
    if (method === 'listAgents') return res.end(JSON.stringify({ agents: [
      { id: 'b-one', name: 'Example bot', description: 'Use approved data.', isGroup: false, memberIds: [] },
      { id: 'g-one', name: 'Example group', isGroup: true, memberIds: ['b-one'] },
    ] }));
    if (method === 'getAgentTranscriptTail') {
      if (failTranscript) { res.statusCode = 503; return res.end('{"error":"synthetic-unavailable"}'); }
      return res.end(JSON.stringify({ entries: [{ id: 'm-one', role: 'user', text: 'Synthetic migration fixture 🐕', timestamp: '2026-11-08T00:00:00Z' }] }));
    }
    if (method === 'getAgentWorkflows') return res.end(JSON.stringify([{ id: 's-one', name: 'Example', description: 'Synthetic skill', source: 'workflow', body: 'Review approved information.' }]));
    res.statusCode = 400; res.end('{"error":"unexpected-method"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CURSOR_ACCESS_TOKEN|GBOT_ACCOUNT|GBOT_ACCOUNT_SCOPE|GBOT_CONFIG|GROK_BOT_GATEWAY_URL|GROK_BOT_GATEWAY_TOKEN|GROK_BOT_GATEWAY_HEADERS)$/.test(key)));
  Object.assign(env, { HOME: dir, USERPROFILE: dir, GROK_BOT_TEST: '1', GBOT_AUTO_WAKE: '0',
    GROK_BOT_GATEWAY_URL: `http://127.0.0.1:${server.address().port}`, GROK_BOT_GATEWAY_TOKEN: 'synthetic-migration-token' });
  for (const command of ['inspect', 'export', 'plan', 'apply', 'verify']) {
    const result = await run(['migrate', command, '--help'], env);
    assert.equal(result.code, 0, command + ': ' + result.stderr);
  }
  assert.equal(calls.length, 0, 'help must not access an account');
  const inventory = await run(['--json', 'migrate', 'inspect'], env);
  assert.equal(inventory.code, 0, inventory.stderr);
  assert.equal(JSON.parse(inventory.stdout).scope, 'source-inventory-only');
  assert.ok(calls.every((call) => call.method === 'listAgents'));
  const archive = join(dir, 'archive'), out = join(dir, 'staged');
  const exported = await run(['--json', 'migrate', 'export', '--out', archive], env);
  assert.equal(exported.code, 0, exported.stderr);
  const summary = JSON.parse(exported.stdout);
  assert.equal(summary.complete, false);
  assert.equal(summary.counts.messages, 2);
  assert.equal(summary.counts.workflowRecords, 1);
  const snap = readArchive(archive).snapshot;
  assert.equal(snap.agents[0].workflows[0].body, 'Review approved information.');
  assert.equal(readFileSync(join(archive, 'snapshot.json'), 'utf8').includes('synthetic-migration-token'), false);
  assert.ok(calls.every((call) => ['listAgents', 'getAgentTranscriptTail', 'getAgentWorkflows'].includes(call.method)), 'no mutation RPC is permitted');
  const reads = calls.length;
  const offline = { ...env };
  delete offline.GROK_BOT_GATEWAY_URL; delete offline.GROK_BOT_GATEWAY_TOKEN;
  for (const args of [
    ['inspect', archive],
    ['plan', archive, '--to', 'openclaw', '--include-skills'],
    ['apply', archive, '--out', out, '--to', 'openclaw', '--include-skills', '--yes'],
    ['verify', archive, '--out', out],
  ]) {
    const result = await run(['--json', 'migrate', ...args], offline);
    assert.equal(result.code, 0, args[0] + ': ' + result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout).exitCode, 0);
  }
  assert.equal(calls.length, reads, 'offline conversion must not contact a provider');
  const again = await run(['migrate', 'apply', archive, '--out', out, '--yes'], offline);
  assert.notEqual(again.code, 0, 'existing target must not be overwritten');
  writeFileSync(join(out, 'REPORT.md'), 'tampered');
  const corrupted = await run(['migrate', 'verify', archive, '--out', out], offline);
  assert.notEqual(corrupted.code, 0);
  failTranscript = true;
  const partial = join(dir, 'partial');
  const failed = await run(['--json', 'migrate', 'export', '--out', partial], env);
  assert.equal(failed.code, 3, failed.stderr + failed.stdout);
  assert.equal(JSON.parse(failed.stdout).counts.failedReads, 2);
  assert.equal(readArchive(partial).snapshot.agents[0].workflows.length, 1, 'useful independent reads remain archived');
});
