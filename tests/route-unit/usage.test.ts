import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@rstest/core';
import { invokeCli } from 'agent-bundle/test';

/**
 * `gbot usage` against a loopback Cursor API (`CURSOR_API_BASE_URL` + `CURSOR_ACCESS_TOKEN`): one
 * DashboardService/GetSandUsageStatus read and nothing else (no EnsureSandBox, no GrokBotService call).
 */
const USAGE_PATH = '/aiserver.v1.DashboardService/GetSandUsageStatus';
const ACCESS = 'synthetic-usage-access-do-not-leak';
const DAY_MS = 86_400_000;

interface Call {
  readonly body: unknown;
  readonly headers: IncomingHttpHeaders;
  readonly path: string;
}

const calls: Call[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let server: Server;
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

// The live answer of 2026-11-09 (account A), trimmed, with a synthetic user id.
const status = (overrides: Record<string, unknown> = {}) => ({
  currentPeriodStart: new Date(Date.now() - DAY_MS).toISOString(),
  nextResetTimestampUtc: new Date(Date.now() + 6 * DAY_MS).toISOString(),
  usagePercent: 16.57550320426031,
  hasAvailableUsage: true,
  hasNonZeroIncludedLimit: true,
  upgradeRecommendation: { visible: false },
  onDemandSettings: { visible: true, eligible: true, dashboardUrl: 'https://cursor.com/dashboard/spending?for=grok%7Cuser_SYNTHETIC0001' },
  grokPlanLabel: 'Grok Bot Plan',
  cursorPlanName: 'Ultra',
  isUnified: true,
  billingBrand: 'SAND_BILLING_BRAND_GROK',
  unifiedBillingUrl: 'https://cursor.com/v2/billing?host=desktop&entrypoint=grok_bot_billing',
  ...overrides,
});

const noUserId = (out: { stdout: string; stderr: string }) => {
  for (const text of [out.stdout, out.stderr]) {
    expect(text).not.toContain('dashboardUrl');
    expect(text).not.toContain('user_SYNTHETIC0001');
    expect(text).not.toContain('cursor.com');
    expect(text).not.toContain(ACCESS);
  }
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url ?? '';
    const text = await readBody(req);
    calls.push({ body: text ? JSON.parse(text) as unknown : {}, headers: req.headers, path });
    const known = path === USAGE_PATH;
    res.writeHead(known ? reply.status : 501, { 'content-type': 'application/json' });
    res.end(JSON.stringify(known ? reply.body : { code: 'unimplemented', message: 'no fake for ' + path }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const key of envKeys) savedEnv[key] = process.env[key];
  const home = mkdtempSync(join(tmpdir(), 'gbot-usage-'));
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'),
    CURSOR_API_BASE_URL: base,
    CURSOR_ACCESS_TOKEN: ACCESS,
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
  reply = { status: 200, body: status() };
});

describe('gbot usage', () => {
  it('reads GetSandUsageStatus once with {} and the access token, and nothing else', async () => {
    const out = await invokeCli(['usage', '--json']);
    expect(out.exitCode).toBe(0);
    expect(calls.map((call) => call.path)).toEqual([USAGE_PATH]);
    expect(calls[0]?.body).toEqual({});
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(calls[0]?.headers['x-cursor-client-version']).toBe('9.9.9');
  });

  it('--json has the usage fields, exitCode 0, and never the dashboard URL', async () => {
    const body = status();
    reply = { status: 200, body };
    const out = await invokeCli(['usage', '--json']);
    expect(out.exitCode).toBe(0);
    expect(out.value).toEqual({
      account: null,
      usagePercent: 16.57550320426031,
      periodStart: body.currentPeriodStart,
      resetsAt: body.nextResetTimestampUtc,
      hasAvailableUsage: true,
      plan: 'Ultra',
      planLabel: 'Grok Bot Plan',
      unified: true,
      onDemandEligible: true,
      exitCode: 0,
    });
    noUserId(out);
  });

  it('prints one line: percent, local reset time, plan and on-demand; no migrate hint under 80%', async () => {
    const out = await invokeCli(['usage']);
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^Grok Bot usage: 16\.6% of this week's included usage\. Resets \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(local time\), in 6 days\. Plan: Ultra \(unified\)\. On-demand: eligible\.$/,
    );
    expect(out.stdout).not.toContain('gbot migrate');
    noUserId(out);
  });

  it('adds the migrate hint at 80% or more, and when no usage is available', async () => {
    reply = { status: 200, body: status({ usagePercent: 80 }) };
    const high = await invokeCli(['usage']);
    expect(high.exitCode).toBe(0);
    expect(high.stdout.trim().split('\n')).toEqual([
      expect.stringContaining('80.0% of this week'),
      'Moving bots elsewhere: gbot migrate (docs/migration.md).',
    ]);
    noUserId(high);
    // Connect JSON leaves out false: no hasAvailableUsage is false.
    const { hasAvailableUsage: _omitted, ...exhausted } = status({ usagePercent: 40, isUnified: false, onDemandSettings: { visible: true } });
    reply = { status: 200, body: exhausted };
    const empty = await invokeCli(['usage']);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain('Plan: Ultra. On-demand: not eligible.');
    expect(empty.stdout.trim().split('\n').at(-1)).toBe('Moving bots elsewhere: gbot migrate (docs/migration.md).');
    const json = await invokeCli(['usage', '--json']);
    expect(json.value).toMatchObject({ usagePercent: 40, hasAvailableUsage: false, unified: false, onDemandEligible: false });
  });

  it('a backend failure exits 1 without the token; an unknown --account exits 2 and reads nothing', async () => {
    reply = { status: 401, body: { code: 'unauthenticated', message: `bad token ${ACCESS}` } };
    const failed = await invokeCli(['usage', '--json']);
    expect(failed.exitCode).toBe(1);
    expect(failed.value).toMatchObject({ code: 'unauthenticated', exitCode: 1 });
    expect(String((failed.value as { error?: unknown }).error)).toContain('GetSandUsageStatus failed: 401');
    noUserId(failed);
    calls.length = 0;
    const unknown = await invokeCli(['usage', '--account', 'nobody', '--json']);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.value).toMatchObject({ code: 'UNKNOWN_ACCOUNT', exitCode: 2 });
    expect(calls).toHaveLength(0);
  });
});
