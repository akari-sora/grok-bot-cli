import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { listGrokBotGatewayAccounts } from '../core/app-session.js';

export const config = {
  description: 'List saved Grok Bot logins without printing credentials.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {},
    type: 'object',
  },
} satisfies CliRouteConfig;

const accountSchema = z.object({
  id: z.string(),
  label: z.string(),
  lastSaved: z.boolean(),
  savedAtMs: z.number().optional(),
  usable: z.boolean(),
}).strict();

export const inputSchema = z.object({}).strict();
export const resultSchema = z.object({
  accounts: z.array(accountSchema),
}).strict();

const formatAccount = (row: z.infer<typeof accountSchema>): string => {
  const notes = [
    row.lastSaved ? 'last saved' : '',
    row.usable ? '' : 'unusable',
  ].filter(Boolean);
  const suffix = notes.length ? ` (${notes.join(', ')})` : '';
  return row.label === row.id ? `${row.label}${suffix}` : `${row.label}${suffix}\n  id ${row.id}`;
};

export default async function accounts(_props: CliRouteProps<typeof inputSchema>) {
  const rows = listGrokBotGatewayAccounts();
  const text = rows.length === 0
    ? 'No saved Grok Bot logins. Open the Grok Bot app and sign in once.'
    : rows.map(formatAccount).join('\n');
  return (
    <Agent.Result value={{ accounts: rows }}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
