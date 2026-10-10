import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { z } from 'zod';

import { loadGrokBotGatewaySelection } from '../../core/app-session.js';
import {
  OUTCOME_MESSAGES,
  PAIR_MESSAGES,
  WearPairError,
  checkCode,
  pairWithWatch,
  parseTarget,
  preflightSession,
} from '../../core/wear-pair.js';
import { withRedactedErrors } from '../../gbot.js';

export const config = {
  description:
    'Send the selected Grok Bot login to a Wear OS watch on this network (GBWP/1). Type the code the watch shows at the hidden prompt.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      target: { description: 'The watch address shown on its screen, <ip>:<port>', type: 'string' },
      account: {
        description: 'Saved Grok Bot login to send when several are stored (label or id). GBOT_ACCOUNT is ignored here',
        type: 'string',
      },
      code: {
        description: 'Tests only (GROK_BOT_TEST=1): the pairing code. Otherwise gbot asks for it with echo off',
        type: 'string',
      },
    },
    required: ['target'],
    type: 'object',
  },
  positionals: ['target'],
} satisfies CliRouteConfig;

// No length limits here: the CLI shell echoes a rejected value, and --code must never be echoed.
export const inputSchema = z.object({
  account: z.string().min(1).optional(),
  code: z.string().optional(),
  target: z.string(),
}).strict();

const outcomes = ['paired', 'rejected', 'storage-failed', 'unknown'] as const;
type Outcome = (typeof outcomes)[number];

const receiptSchema = z.object({
  account: z.string(),
  exitCode: z.union([z.literal(0), z.literal(5), z.literal(6)]),
  id: z.string(),
  outcome: z.enum(outcomes),
  target: z.string(),
}).strict();

const categories = [
  'usage',
  'typo',
  'invalid-code',
  'account',
  'preflight',
  'unreachable',
  'no-answer',
  'auth',
  'aborted',
  'internal',
] as const;
type Category = (typeof categories)[number];

const failureSchema = z.object({
  category: z.enum(categories),
  error: z.string(),
  exitCode: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(130)]),
}).strict();

export const resultSchema = z.union([receiptSchema, failureSchema]);

type Receipt = z.infer<typeof receiptSchema>;
type Failure = z.infer<typeof failureSchema>;

const EXIT: Record<Category, Failure['exitCode']> = {
  usage: 2,
  typo: 2,
  'invalid-code': 2,
  account: 1,
  preflight: 1,
  unreachable: 3,
  'no-answer': 4,
  auth: 4,
  aborted: 130,
  internal: 1,
};

const RECEIPT_EXIT: Record<Outcome, Receipt['exitCode']> = {
  paired: 0,
  rejected: 5,
  'storage-failed': 5,
  unknown: 6,
};

const KEEP_CODE = 'Nothing was sent, so the code on the watch is still valid.';

const MESSAGES = {
  target:
    'Give the address the watch shows as <ip>:<port>, for example 192.168.1.20:40123: a private IPv4 address ' +
    '(10/8, 172.16/12, 192.168/16, 100.64/10 or 169.254/16) and a port from 1024 to 65535.',
  codeFlag: '--code is accepted only in tests (GROK_BOT_TEST=1). Run gbot wear pair in a terminal and type the code at the prompt.',
  noTerminal: 'Run this in a terminal: gbot wear pair reads the pairing code from the keyboard with echo off.',
  codeFile: 'The pairing code hand-off file is missing or unsafe. Run gbot wear pair again in a terminal.',
  noLogin: 'No saved Grok Bot login. Open the Grok Bot app and sign in once, then run gbot accounts.',
  unusable: 'The selected Grok Bot login could not be read. Run gbot doctor --account <label> for details.',
  internal: 'Pairing failed because of an internal error.',
  preflight: {
    shape: `The selected login's session is malformed, so the watch would reject it. ${KEEP_CODE}`,
    url: `The selected login's gateway URL is not one the watch accepts (https on a Cursor host). ${KEEP_CODE}`,
    token: `The selected login's gateway token is not one the watch accepts. ${KEEP_CODE}`,
    headers: `The selected login's routing headers are not ones the watch accepts. ${KEEP_CODE}`,
    size: `The selected login's session is too large for the watch. ${KEEP_CODE}`,
  } as Record<string, string>,
};

const truthy = (value: string | undefined): boolean => ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());

/** The fork's url-policy testMode(): GROK_BOT_TEST truthy or NODE_ENV=test. */
const testMode = (): boolean => truthy(process.env.GROK_BOT_TEST) || process.env.NODE_ENV === 'test';

/** Control characters, line separators and bidi overrides in a label must not reach the terminal. */
const printable = (text: string): string =>
  Array.from(text, (char) => {
    const c = char.codePointAt(0) ?? 0;
    const hidden = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ||
      (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    return hidden ? '?' : char;
  }).join('');

const failure = (category: Category, error: string): Failure => ({ category, error, exitCode: EXIT[category] });

/**
 * OS secret access. Tests never reach the real Keychain, secret-tool or DPAPI: in test mode the store is disabled,
 * and only GROK_BOT_TEST=1 may hand over a fixture password through GBOT_TEST_KEYCHAIN_PASSWORD.
 */
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

/**
 * Reads and deletes the 0600 file the wrapper (bin/gbot.mjs) wrote after the hidden prompt. Only a regular,
 * private, small file named `code` in a `gbot-pair-*` directory is accepted; anything else is left alone.
 */
const takeCodeFile = (path: string): string | Failure => {
  try {
    if (basename(path) !== 'code' || !basename(dirname(path)).startsWith('gbot-pair-')) return failure('usage', MESSAGES.codeFile);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 128) return failure('usage', MESSAGES.codeFile);
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o077) !== 0) return failure('usage', MESSAGES.codeFile);
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return failure('usage', MESSAGES.codeFile);
    }
    try {
      return readFileSync(path).toString('latin1');
    } finally {
      unlinkSync(path);
    }
  } catch {
    return failure('usage', MESSAGES.codeFile);
  }
};

const takeCode = (input: z.infer<typeof inputSchema>, fromFile: string | Failure | undefined): string | Failure => {
  if (input.code !== undefined) {
    if (process.env.GROK_BOT_TEST !== '1') return failure('usage', MESSAGES.codeFlag);
    return input.code;
  }
  return fromFile ?? failure('usage', MESSAGES.noTerminal);
};

type Login = { label: string; lastSaved: boolean };

const loginList = (logins: unknown): string =>
  Array.isArray(logins)
    ? (logins as Login[]).map((row) => `  ${printable(String(row.label))}${row.lastSaved ? ' (last saved)' : ''}`).join('\n')
    : '';

const accountFailure = (error: unknown, account: string | undefined): Failure => {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
  const logins = error && typeof error === 'object' && 'logins' in error ? (error as { logins: unknown }).logins : undefined;
  if (code === 'AMBIGUOUS_ENTRIES') {
    const lead = account ? 'More than one saved Grok Bot login matches --account.' : 'Several Grok Bot logins are saved.';
    return failure('usage', `${lead} Choose one with --account <label>:\n${loginList(logins)}`);
  }
  if (code === 'UNKNOWN_ACCOUNT') {
    return failure('usage', `No saved Grok Bot login matches --account. Saved logins:\n${loginList(logins)}`);
  }
  if (code === 'EMPTY_ENTRIES') return failure('account', MESSAGES.noLogin);
  return failure('account', MESSAGES.unusable);
};

const pair = async (input: z.infer<typeof inputSchema>, signal: AbortSignal): Promise<Receipt | Failure> => {
  // The hand-off file is read and deleted first, whatever fails next.
  const file = process.env.GBOT_PAIR_CODE_FILE;
  const fromFile = typeof file === 'string' && file ? takeCodeFile(file) : undefined;

  const target = parseTarget(input.target, { allowLoopback: testMode() });
  if (!target) return failure('usage', MESSAGES.target);

  const code = takeCode(input, fromFile);
  if (typeof code !== 'string') return code;

  // A typo is reported before any Keychain or network access, so it does not burn the code.
  const checked = checkCode(code);
  if (checked.code === undefined) return failure(checked.error, PAIR_MESSAGES[checked.error]);

  // GBOT_ACCOUNT is ignored for pairing; the rest of the environment locates the descriptor.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GBOT_ACCOUNT;
  let selection: ReturnType<typeof loadGrokBotGatewaySelection>;
  try {
    selection = loadGrokBotGatewaySelection({ account: input.account, env, ...secretStore() });
  } catch (error) {
    return accountFailure(error, input.account);
  }
  if (!selection) return failure('account', MESSAGES.noLogin);
  const label = String(selection.label);
  const id = String(selection.id);

  const checkedSession = preflightSession({ ...selection.session, label });
  if (!checkedSession.ok) {
    return failure('preflight', MESSAGES.preflight[String(checkedSession.reason)] ?? MESSAGES.preflight.shape);
  }

  // Only the label and the target, so the user can still abort; never the token, headers, host or code.
  process.stderr.write(`Sending Grok Bot login ${printable(label)} to the watch at ${target.target} (Ctrl-C to abort).\n`);

  try {
    const { outcome } = await pairWithWatch({
      host: target.host,
      port: target.port,
      code: checked.code,
      payload: checkedSession.payload,
      signal,
    });
    const known = (outcomes as readonly string[]).includes(outcome) ? (outcome as Outcome) : 'unknown';
    return { account: label, exitCode: RECEIPT_EXIT[known], id, outcome: known, target: target.target };
  } catch (error) {
    if (error instanceof WearPairError) {
      const category = (categories as readonly string[]).includes(error.category) ? (error.category as Category) : 'internal';
      return failure(category, category === 'internal' ? MESSAGES.internal : PAIR_MESSAGES[category as keyof typeof PAIR_MESSAGES] ?? MESSAGES.internal);
    }
    return failure('internal', MESSAGES.internal);
  }
};

const textOf = (value: Receipt | Failure): string => {
  if ('error' in value) return value.error;
  if (value.outcome === 'paired') return `Paired ${printable(value.account)} with the watch at ${value.target}.`;
  return OUTCOME_MESSAGES[value.outcome];
};

export default async function wearPair({ input, signal }: CliRouteProps<typeof inputSchema>) {
  // pair() returns fixed documents for every expected failure; withRedactedErrors is a second layer only.
  const value = await withRedactedErrors(async () => {
    try {
      return await pair(input, signal);
    } catch {
      return failure('internal', MESSAGES.internal);
    }
  });
  return (
    <Agent.Result value={value}>
      <Agent.Text>{textOf(value)}</Agent.Text>
    </Agent.Result>
  );
}
