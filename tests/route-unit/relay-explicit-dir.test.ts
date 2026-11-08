import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import { invokeCli, invokeMcpTool } from 'agent-bundle/test';

import { grokBotGatewayDescriptorPath } from '../../src/core/app-session.js';
import { openRelayEngine } from '../../src/core/relay/engine.js';
import { runRelayWorker } from '../../src/core/relay/worker.js';

const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'GROK_BOT_RELAY_DIR',
  'GROK_BOT_TEST',
  'GBOT_ACCOUNT',
  'GBOT_ACCOUNT_SCOPE',
  'GBOT_CONFIG',
  'GROK_BOT_GATEWAY_URL',
  'GROK_BOT_GATEWAY_TOKEN',
  'CODEX_HOME',
  'GBOT_TEST_KEYCHAIN_PASSWORD',
] as const;

function pushEnv(values: Record<string, string | undefined>) {
  const prev: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    prev[key] = process.env[key];
    const value = values[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const key of ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  };
}

describe('explicit relay directory CLI and MCP results', () => {
  it('prints Relay profile mismatch from managed bridge status', async () => {
    if (process.platform === 'win32') return;
    const home = await mkdtemp(join(tmpdir(), 'relay-cli-mismatch-'));
    const dir = await mkdtemp(join(tmpdir(), 'relay-cli-mismatch-dir-'));
    const gateway = {
      resolve: async (ref: string) => ({ id: ref, name: 'Fixture' }),
      tail: async () => ({ entries: [] }),
      send: async () => ({ delivery: 'rejected' }),
    };
    const legacy = await openRelayEngine({
      stateDir: dir,
      profile: 'legacy-pinned-profile',
      env: { CODEX_HOME: join(home, 'codex'), GROK_BOT_TEST: '1' },
      gateway,
      clock: () => 1,
    });
    await legacy.close();
    const restore = pushEnv({
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      XDG_CONFIG_HOME: home,
      CODEX_HOME: join(home, 'codex'),
      GROK_BOT_TEST: '1',
      GROK_BOT_RELAY_DIR: dir,
      GBOT_ACCOUNT_SCOPE: 'c'.repeat(64),
      GBOT_ACCOUNT: undefined,
      GBOT_CONFIG: undefined,
      GROK_BOT_GATEWAY_URL: undefined,
      GROK_BOT_GATEWAY_TOKEN: undefined,
    });
    try {
      const status = await invokeCli(['codex', 'bridge', 'status', '--json']);
      expect(status.exitCode).toBe(1);
      expect(status.stdout).toContain('Relay profile mismatch');
      expect(status.stdout).toContain('other than an upgrade');
      expect(status.stdout).toContain('gbot codex bridge stop --worker');
      expect(status.stdout).not.toContain('startup failed or timed out');
      expect(status.stdout).not.toContain('Worker is not running');
      expect(status.value).toMatchObject({ exitCode: 1 });
      expect(String((status.value as { error?: unknown }).error)).toMatch(/^Relay profile mismatch/);
    } finally {
      restore();
      await rm(home, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validates explicit-dir stop and status on the CLI and MCP', async () => {
    if (process.platform === 'win32') return;
    const home = await mkdtemp(join(tmpdir(), 'relay-cli-explicit-'));
    // Use the same platform paths as pushEnv below. On Linux, {} writes under
    // ~/.config while XDG_CONFIG_HOME=home makes the CLI read home/Grok Bot.
    const descriptorEnv = { APPDATA: home, XDG_CONFIG_HOME: home };
    const descriptor = grokBotGatewayDescriptorPath(home, process.platform, descriptorEnv);
    await mkdir(dirname(descriptor), { recursive: true });
    await writeFile(descriptor, JSON.stringify({ version: 99, encrypted: 'not-used' }));
    const dirA = join(home, '.grok-bot-cli', 'relay', 'worker-a');
    const dirB = join(home, '.grok-bot-cli', 'relay', 'worker-b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const env = {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, 'codex'),
      GROK_BOT_TEST: '1',
      GBOT_TEST_KEYCHAIN_PASSWORD: 'demo-password',
    };
    const openEngine = async () => ({
      status: () => ({ state: 'running', bindings: [], receipts: [] }),
      tick: async () => {},
      close: async () => {},
    });
    const workerA = await runRelayWorker({
      stateDir: dirA,
      profile: 'a'.repeat(64),
      accountScope: '1'.repeat(64),
      env,
      openEngine,
    });
    const workerB = await runRelayWorker({
      stateDir: dirB,
      profile: 'b'.repeat(64),
      accountScope: '2'.repeat(64),
      env,
      openEngine,
    });
    const restore = pushEnv({
      ...env,
      ...descriptorEnv,
      GROK_BOT_RELAY_DIR: dirA,
      GBOT_ACCOUNT: undefined,
      GBOT_ACCOUNT_SCOPE: undefined,
      GBOT_CONFIG: undefined,
      GROK_BOT_GATEWAY_URL: undefined,
      GROK_BOT_GATEWAY_TOKEN: undefined,
    });
    try {
      expect(grokBotGatewayDescriptorPath(home, process.platform, process.env)).toBe(descriptor);
      const cliStatus = await invokeCli(['codex', 'bridge', 'status', '--json']);
      expect(cliStatus.exitCode).toBe(0);
      expect(cliStatus.value).toMatchObject({
        accountResolution: 'failed',
        stateDir: dirA,
        exitCode: 0,
      });
      expect(Object.hasOwn(cliStatus.value as object, 'directories')).toBe(false);

      const mcpStatus = await invokeMcpTool('gbot_bridge_status', {
        input: {},
        server: 'grok-bot',
      });
      expect(mcpStatus.isError).toBe(false);
      expect(mcpStatus.structuredContent).toMatchObject({
        accountResolution: 'failed',
        stateDir: dirA,
      });
      expect(Object.hasOwn(mcpStatus.structuredContent as object, 'directories')).toBe(false);

      const cliStop = await invokeCli(['codex', 'bridge', 'stop', '--worker', '--json']);
      expect(cliStop.exitCode).toBe(0);
      expect(Object.hasOwn(cliStop.value as object, 'directories')).toBe(false);
      await workerA.closed;

      process.env.GROK_BOT_RELAY_DIR = dirB;
      const mcpStop = await invokeMcpTool('gbot_bridge_stop', {
        input: { worker: true },
        server: 'grok-bot',
      });
      expect(mcpStop.isError).toBe(false);
      expect(Object.hasOwn(mcpStop.structuredContent as object, 'directories')).toBe(false);
      await workerB.closed;
    } finally {
      restore();
      await workerA.close().catch(() => {});
      await workerB.close().catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  });
});
