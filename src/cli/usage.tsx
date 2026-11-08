import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { backendOnlySession, usageStatus } from '../core/gateway.js';
import { resolveGrokBotLogin, workerAccountScope } from '../core/logins.js';
import { secretStoreOptions } from '../core/secret-store.js';
import { withRedactedErrors } from '../gbot.js';

export const config = {
  description: 'Show this week\'s Grok Bot usage, when it resets and the plan (DashboardService GetSandUsageStatus). Read-only: it does not wake the box.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      account: { description: 'Saved Grok Bot login. Uses --account, then GBOT_ACCOUNT, then the config default, then the descriptor single or active entry', type: 'string' },
    },
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  account: z.string().min(1).optional(),
}).strict();

const okSchema = z.object({
  account: z.string().nullable(),
  usagePercent: z.number(),
  periodStart: z.string().nullable(),
  resetsAt: z.string().nullable(),
  hasAvailableUsage: z.boolean(),
  plan: z.string().nullable(),
  planLabel: z.string().nullable(),
  unified: z.boolean(),
  onDemandEligible: z.boolean(),
  exitCode: z.literal(0),
}).strict();

const failSchema = z.object({
  code: z.string().optional(),
  error: z.string(),
  exitCode: z.union([z.literal(1), z.literal(2)]),
}).strict();

export const resultSchema = z.union([okSchema, failSchema]);

type Ok = z.infer<typeof okSchema>;
type Value = z.infer<typeof resultSchema>;

// The same login selection errors `gbot accounts` and `gbot wake` exit 2 on.
const SELECTION_CODES = new Set(['AMBIGUOUS_ENTRIES', 'UNKNOWN_ACCOUNT', 'INVALID', 'INVALID_ACCOUNT_SCOPE']);

const MIGRATE_HINT = 'Moving bots elsewhere: gbot migrate (docs/migration.md).';

const pad = (n: number): string => String(n).padStart(2, '0');

const localTime = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

const fromNow = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return minutes <= 1 ? 'in about a minute' : `in ${minutes} minutes`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
  return `in ${Math.round(ms / 86_400_000)} days`;
};

const resetText = (resetsAt: string): string => {
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return `Resets ${resetsAt}.`;
  const left = at - Date.now();
  return `Resets ${localTime(new Date(at))} (local time)${left > 0 ? `, ${fromNow(left)}` : ''}.`;
};

const textOf = (value: Ok): string => {
  const plan = value.plan ?? value.planLabel;
  const line = [
    `Grok Bot usage${value.account ? ` (${value.account})` : ''}: ${value.usagePercent.toFixed(1)}% of this week's included usage.`,
    value.resetsAt ? resetText(value.resetsAt) : '',
    plan ? `Plan: ${plan}${value.unified ? ' (unified)' : ''}.` : '',
    `On-demand: ${value.onDemandEligible ? 'eligible' : 'not eligible'}.`,
  ].filter(Boolean).join(' ');
  return value.usagePercent >= 80 || !value.hasAvailableUsage ? `${line}\n${MIGRATE_HINT}` : line;
};

const run = async (input: z.infer<typeof inputSchema>, signal: AbortSignal): Promise<Ok> => {
  // The login backendOnlySession picks, resolved here for its name. Local files only.
  const choice = resolveGrokBotLogin({ account: input.account ?? (workerAccountScope() || undefined), ...secretStoreOptions() });
  const session = backendOnlySession({ account: input.account });
  const usage = await usageStatus(session, { signal });
  return { account: choice ? choice.alias || choice.label : null, ...usage, exitCode: 0 };
};

const failure = (error: unknown): Value => {
  const fields = error && typeof error === 'object' ? error as { code?: unknown; exitCode?: unknown } : {};
  const code = typeof fields.code === 'string' && fields.code ? fields.code : undefined;
  const selection = fields.exitCode === 2 || (code !== undefined && SELECTION_CODES.has(code));
  return {
    error: error instanceof Error ? error.message : 'Could not read Grok Bot usage.',
    ...(code ? { code } : {}),
    exitCode: selection ? 2 : 1,
  };
};

export default async function usage({ input, signal }: CliRouteProps<typeof inputSchema>) {
  let value: Value;
  try {
    value = await withRedactedErrors(() => run(input, signal));
  } catch (error) {
    value = failure(error);
  }
  return (
    <Agent.Result value={value}>
      <Agent.Text>{value.exitCode === 0 ? textOf(value) : value.error}</Agent.Text>
    </Agent.Result>
  );
}
