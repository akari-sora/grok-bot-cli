import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@rstest/core';
import { invokeCli } from 'agent-bundle/test';

/**
 * `gbot bots template` against a loopback Cursor API (`CURSOR_API_BASE_URL` + `CURSOR_ACCESS_TOKEN`):
 * EnsureSandBox, the server roster, GetGrokBotTemplateForSourceAgent and SendGrokBotUserMessage.
 * Nothing leaves the machine and no app login is read.
 */
const SERVICE = '/aiserver.v1.GrokBotService/';
const BOT = '11111111-2222-4333-8444-555555555555';

interface Call {
  readonly body: Record<string, unknown>;
  readonly path: string;
}

const calls: Call[] = [];
const templates: unknown[] = [];
let server: Server;
let base = '';
const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
  'HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME', 'CURSOR_API_BASE_URL', 'CURSOR_ACCESS_TOKEN', 'SAND_CLIENT_VERSION',
  'GROK_BOT_GATEWAY_URL', 'GROK_BOT_GATEWAY_TOKEN', 'GROK_BOT_GATEWAY_HEADERS', 'GBOT_ACCOUNT', 'GBOT_ACCOUNT_SCOPE', 'GBOT_CONFIG',
] as const;

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    req.on('end', () => resolve(text));
  });

const answer = (path: string): unknown => {
  switch (path) {
    case `${SERVICE}EnsureSandBox`:
      return { runState: 'SAND_BOX_RUN_STATE_RUNNING', gatewayUrl: base, gatewayToken: 'synthetic-box-token' };
    case `${SERVICE}GetGrokBotRuntimeCapabilities`:
      return { capabilities: { durableIdentityEnabled: true } };
    case `${SERVICE}ListGrokBotAgents`:
      return { agents: [{ agentId: BOT, id: '7', name: 'Move to Hermes', kind: 'GROK_BOT_AGENT_KIND_AGENT', harness: 'temporal' }] };
    case `${SERVICE}GetGrokBotTemplateForSourceAgent`:
      return templates.length > 1 ? templates.shift() : templates[0];
    case `${SERVICE}SendGrokBotUserMessage`:
      return { dispatched: true, delivery: 'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL' };
    case '/api/listAgents':
      return { agents: [] };
    default:
      return undefined;
  }
};

const shared = {
  template: {
    shareId: 'share-abc',
    name: 'Move to Hermes',
    sourceAgentId: BOT,
    updatedAtMs: '1762600000000',
    published: true,
    activeVersion: 1,
    visibility: 'GROK_BOT_TEMPLATE_VISIBILITY_PUBLIC',
  },
};

const sends = () => calls.filter((call) => call.path === `${SERVICE}SendGrokBotUserMessage`);
const reads = () => calls.filter((call) => call.path === `${SERVICE}GetGrokBotTemplateForSourceAgent`);

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url ?? '';
    const text = await readBody(req);
    calls.push({ body: text ? JSON.parse(text) as Record<string, unknown> : {}, path });
    const payload = answer(path);
    res.writeHead(payload === undefined ? 501 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload ?? { code: 'unimplemented', message: 'no fake for ' + path }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const key of envKeys) savedEnv[key] = process.env[key];
  const home = mkdtempSync(join(tmpdir(), 'gbot-bots-template-'));
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    CURSOR_API_BASE_URL: base,
    CURSOR_ACCESS_TOKEN: 'synthetic-template-access-do-not-leak',
    SAND_CLIENT_VERSION: '9.9.9',
  });
});

afterAll(async () => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  calls.length = 0;
  templates.length = 0;
});

describe('gbot bots template', () => {
  it('--status reads the template and prints the link on its own line, without sending', async () => {
    templates.push(shared);
    const json = await invokeCli(['bots', 'template', 'Move to Hermes', '--status', '--json']);
    expect(json.exitCode).toBe(0);
    expect(json.value).toMatchObject({
      id: BOT,
      kind: 'bot',
      exitCode: 0,
      hasTeam: false,
      template: { shareId: 'share-abc', link: 'https://x.ai/bot/share-abc', published: true, updatedAtMs: 1762600000000 },
    });
    const text = await invokeCli(['bots', 'template', BOT, '--status']);
    expect(text.exitCode).toBe(0);
    expect(text.stdout.split('\n')).toContain('https://x.ai/bot/share-abc');
    templates.length = 0;
    templates.push({ hasTeam: true, exportPolicy: 'all' });
    const none = await invokeCli(['bots', 'template', BOT, '--status']);
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toContain('has no template yet');
    expect(reads().map((call) => call.body)).toEqual(Array(3).fill({ sourceAgentId: BOT }));
    expect(sends()).toHaveLength(0);
  });

  it('sends once and exits 3 with a --status hint when the template does not appear within --wait', async () => {
    templates.push({});
    const out = await invokeCli(['bots', 'template', 'Move to Hermes', '--wait', '0', '--json']);
    expect(out.exitCode).toBe(3);
    expect(out.value).toMatchObject({ id: BOT, action: 'created', delivery: 'accepted', template: null, exitCode: 3 });
    expect(String((out.value as { hint?: unknown }).hint)).toContain('gbot bots template "Move to Hermes" --status');
    expect(sends()).toHaveLength(1);
    expect(sends()[0]?.body).toMatchObject({
      agentId: BOT,
      text: 'Create a public template of yourself that I can share with somebody else',
      initiator: 'GROK_BOT_USER_MESSAGE_INITIATOR_TEMPLATE_SHARE',
      messageId: (out.value as { clientNonce?: unknown }).clientNonce,
    });
    expect(reads()).toHaveLength(1);
  });

  it('exits 0 and prints the link once the template appears', async () => {
    templates.push({}, shared);
    const out = await invokeCli(['bots', 'template', BOT, '--wait', '1']);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim().split('\n').at(-1)).toBe('https://x.ai/bot/share-abc');
    expect(sends()).toHaveLength(1);
    expect(reads()).toHaveLength(2);
  });
});
