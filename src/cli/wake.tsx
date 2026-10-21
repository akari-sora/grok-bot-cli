import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { AppAuthError, loadAppAccessToken } from '../core/app-auth.js';
import { loadGrokBotGatewaySelection } from '../core/app-session.js';
import { describeSandbox, GatewayError, listAgents, wakeSandbox } from '../core/gateway.js';
import { withRedactedErrors } from '../gbot.js';

export const config = {
  description: 'Wake the Grok Bot box for a saved login, or report its run state.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      account: {
        description: 'Saved Grok Bot login (label or id). Overrides GBOT_ACCOUNT',
        type: 'string',
      },
      check: {
        description: 'Report the run state without waking the box',
        type: 'boolean',
      },
    },
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  account: z.string().min(1).optional(),
  check: z.boolean().optional(),
}).strict();

const runStates = ['RUNNING', 'HIBERNATED', 'STARTING', 'unknown'] as const;
type RunState = (typeof runStates)[number];

const okSchema = z.object({
  account: z.string(),
  after: z.enum(runStates),
  before: z.enum(runStates),
  exitCode: z.literal(0),
  seconds: z.number(),
}).strict();

const failSchema = z.object({
  account: z.string().optional(),
  after: z.enum(runStates).optional(),
  before: z.enum(runStates).optional(),
  error: z.string(),
  exitCode: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  seconds: z.number().optional(),
}).strict();

export const resultSchema = z.union([okSchema, failSchema]);

type WakeResult = z.infer<typeof resultSchema>;

const truthy = (value: string | undefined): boolean => ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
const testMode = (): boolean => truthy(process.env.GROK_BOT_TEST) || process.env.NODE_ENV === 'test';

/** Same test-mode secret store as `gbot wear pair`: never the real Keychain unless this is a real run. */
const secretStore = () => {
  if (!testMode()) return {};
  const fixture = process.env.GROK_BOT_TEST === '1' ? process.env.GBOT_TEST_KEYCHAIN_PASSWORD : undefined;
  return {
    getKeychainPassword: (): string => {
      if (typeof fixture === 'string' && fixture) return fixture;
      throw new Error('The OS secret store is disabled in test mode.');
    },
    unprotectData: (): Buffer => {
      throw new Error('The OS secret store is disabled in test mode.');
    },
  };
};

const printable = (text: string): string =>
  Array.from(text, (char) => {
    const c = char.codePointAt(0) ?? 0;
    const hidden = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ||
      (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    return hidden ? '?' : char;
  }).join('');

const asState = (value: unknown): RunState =>
  typeof value === 'string' && (runStates as readonly string[]).includes(value) ? value as RunState : 'unknown';

const secondsOf = (started: number): number => Math.round((Date.now() - started) / 100) / 10;

const scrub = (message: string, secret?: string): string => {
  const leaked = (secret && secret.length >= 8 && message.includes(secret)) || message.includes('eyJ');
  return leaked
    ? 'Could not wake the Grok Bot box. Open the Grok Bot app and sign in to that login once.'
    : message;
};

const textOf = (value: WakeResult): string => {
  const lines = [
    value.account ? `account: ${printable(value.account)}` : '',
    value.before ? `before: ${value.before}` : '',
    value.after ? `after: ${value.after}` : '',
    value.seconds != null ? `seconds: ${value.seconds}` : '',
    'error' in value ? value.error : '',
  ].filter(Boolean);
  return lines.join('\n');
};

async function wake(input: z.infer<typeof inputSchema>, signal: AbortSignal): Promise<WakeResult> {
  const started = Date.now();
  const account = input.account || process.env.GBOT_ACCOUNT?.trim() || undefined;
  let selection;
  try {
    selection = loadGrokBotGatewaySelection({ account, ...secretStore() });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const message = error instanceof Error ? error.message : 'Could not read the saved Grok Bot login.';
    return code === 'AMBIGUOUS_ENTRIES' || code === 'UNKNOWN_ACCOUNT'
      ? { error: scrub(message), exitCode: 2 }
      : { error: scrub(message), exitCode: 3 };
  }
  if (!selection) {
    return { error: 'No saved Grok Bot login. Open the Grok Bot app and sign in once.', exitCode: 3 };
  }
  const label = printable(String(selection.label));
  const scope = selection.session.accountScope;
  if (!scope) {
    return {
      account: label,
      error: 'This saved login has no account scope gbot can wake. Open the Grok Bot app and sign in to that login once.',
      exitCode: 3,
      seconds: secondsOf(started),
    };
  }
  let token = '';
  try {
    token = loadAppAccessToken({ scope, ...secretStore() }).token;
  } catch (error) {
    const message = error instanceof AppAuthError
      ? error.message
      : 'Could not read the saved Grok Bot login. Open the Grok Bot app and sign in to that login once.';
    return { account: label, error: scrub(message), exitCode: 3, seconds: secondsOf(started) };
  }
  let before: RunState;
  try {
    before = asState((await describeSandbox(token, { signal })).runState);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read the Grok Bot box.';
    return { account: label, error: scrub(message, token), exitCode: 3, seconds: secondsOf(started) };
  }
  if (input.check) {
    return { account: label, before, after: before, exitCode: 0, seconds: secondsOf(started) };
  }
  let woke;
  try {
    woke = await wakeSandbox(token, { signal });
  } catch (error) {
    const timedOut = error instanceof GatewayError && error.code === 'WAKE_TIMEOUT';
    const message = error instanceof Error ? error.message : 'Could not wake the Grok Bot box.';
    return {
      account: label,
      before,
      after: timedOut ? 'STARTING' : before,
      error: scrub(message, token),
      exitCode: timedOut ? 4 : 3,
      seconds: secondsOf(started),
    };
  }
  try {
    await listAgents({
      gatewayUrl: woke.gatewayUrl,
      gatewayToken: woke.gatewayToken,
      gatewayHeaders: woke.gatewayHeaders,
    }, { signal });
  } catch {
    return {
      account: label,
      before,
      after: 'RUNNING',
      error: 'The box reported running, but gbot could not list bots on it.',
      exitCode: 3,
      seconds: secondsOf(started),
    };
  }
  return {
    account: label,
    before,
    after: asState(woke.runState),
    exitCode: 0,
    seconds: secondsOf(started),
  };
}

export default async function wakeCommand({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const value = await withRedactedErrors(async () => {
    try {
      return await wake(input, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not wake the Grok Bot box.';
      return { error: scrub(message), exitCode: 3 as const };
    }
  });
  return (
    <Agent.Result value={value}>
      <Agent.Text>{textOf(value)}</Agent.Text>
    </Agent.Result>
  );
}
