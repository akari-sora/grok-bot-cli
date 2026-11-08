import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { listBots } from '../../core/migration-flow.js';

export const config = {
  description: 'Step 1: list the bots of a Grok Bot login that can be migrated. Read-only.',
  exitCode: 'result',
  render: { maxElapsedMs: 300000 },
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      account: { description: 'Saved Grok Bot login (alias, email, label or id; see gbot accounts)', type: 'string' },
    },
    required: [],
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z.object({ account: z.string().min(1).optional() }).strict();
export const resultSchema = migrationResultSchema;

export default async function bots({ input }: CliRouteProps<typeof inputSchema>) {
  const list = await listBots(input);
  const result = migrationResult({ exitCode: 0, bots: list });
  const text = list.map((b: { id: string; name: string; title: string }) => `${b.name}\n    ${b.id}${b.title ? `\n    title: ${b.title}` : ''}`).join('\n') +
    `\n\n${list.length} bot(s). Next: gbot migrate run --bot NAME --to hermes${input.account ? ' --account ' + input.account : ''}`;
  return <Agent.Result value={result}><Agent.Text>{text}</Agent.Text></Agent.Result>;
}
