import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { inspectGrokBotGatewaySession } from '../core/app-session.js';
import { hasGatewayAuth } from '../core/gateway.js';
import { resolveGrokBotLogin } from '../core/logins.js';
import {
  defaultCandidateRoots,
  looksLikeAgentsRoot,
  resolveAgentsRoot,
  StoreError,
} from '../core/store.js';
import { backendFlagsSchema } from './_shared.js';

export const config = {
  description: 'Show which agents root and auth sources gbot can see.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      account: { description: 'Saved Grok Bot login (alias, email, label, or id). Overrides GBOT_ACCOUNT. Does not use the config default', type: 'string' },
    },
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema;
export const resultSchema = z.object({
  candidates: z.array(z.string()),
  found: z.array(z.string()),
  gatewayAuthPresent: z.boolean(),
  grokBotAppSession: z.record(z.string(), z.json()),
  note: z.string(),
  resolved: z.string().nullable(),
}).strict();

function inspectDoctorSession(account: string | undefined) {
  const selector = (account ?? '').trim() || String(process.env.GBOT_ACCOUNT ?? '').trim();
  if (!selector) return inspectGrokBotGatewaySession({});
  try {
    const choice = resolveGrokBotLogin({ account: selector });
    if (!choice) return { present: false, usable: false };
    if (!choice.hasDescriptorEntry) {
      return choice.usable
        ? { present: true, usable: true }
        : { present: true, usable: false, code: 'UNUSABLE_SESSION', error: 'This saved login has no usable descriptor entry.' };
    }
    return inspectGrokBotGatewaySession({ account: choice.id });
  } catch (error) {
    return {
      present: true,
      usable: false,
      code: error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'UNUSABLE_SESSION',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default async function doctor({ input }: CliRouteProps<typeof inputSchema>) {
  const candidates = defaultCandidateRoots().filter((c): c is string => typeof c === 'string');
  const found = candidates.filter(looksLikeAgentsRoot);
  let resolved: string | null = null;
  try {
    resolved = resolveAgentsRoot(input.dir);
  } catch (err) {
    if (!(err instanceof StoreError)) throw err;
  }
  const note = 'Live roster is on the box. Prefer CURSOR_ACCESS_TOKEN then EnsureSandBox then POST gateway /api/*.';
  const gatewayAuthPresent = hasGatewayAuth();
  const grokBotAppSession = inspectDoctorSession(input.account);
  const sessionJson = {
    present: grokBotAppSession.present,
    usable: grokBotAppSession.usable,
    ...(grokBotAppSession.error === undefined ? {} : { error: grokBotAppSession.error }),
    ...('code' in grokBotAppSession && grokBotAppSession.code != null
      ? { code: grokBotAppSession.code }
      : {}),
  };
  const value = { resolved, found, candidates, gatewayAuthPresent, grokBotAppSession: sessionJson, note };
  const sessionLine = grokBotAppSession.usable
    ? 'Grok Bot app session: usable'
    : grokBotAppSession.present
    ? `Grok Bot app session: present but unusable: ${grokBotAppSession.error}`
    : 'Grok Bot app session: not found';
  const text = [
    `resolved: ${resolved ?? '(none)'}`,
    `gateway auth: ${gatewayAuthPresent ? 'present' : 'no'}`,
    sessionLine,
    'found:',
    found.length ? found.map((p) => `  ${p}`).join('\n') : '  (none)',
    'candidates:',
    ...candidates.map((c) => `  ${c}`),
    note,
  ].join('\n');
  return (
    <Agent.Result value={value}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
