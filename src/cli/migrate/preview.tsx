import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { previewMigration } from '../../core/migration-flow.js';

export const config = {
  description: 'Step 3: show what an import would create at the destination and what cannot move. Changes nothing.',
  exitCode: 'result',
  render: { maxElapsedMs: 600000 },
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      archive: { description: 'Archive from gbot migrate capture', type: 'string' },
      to: { description: 'Destination', enum: ['hermes', 'muse', 'dot'], type: 'string' },
      profile: { description: 'Hermes profile name (default grok-<bot>)', type: 'string' },
      skills: { description: 'Skill library: all (default) or none', enum: ['all', 'none'], type: 'string' },
    },
    required: ['archive', 'to'],
    type: 'object',
  },
  positionals: ['archive'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  archive: z.string().min(1),
  to: z.enum(['hermes', 'muse', 'dot']),
  profile: z.string().min(1).optional(),
  skills: z.enum(['all', 'none']).default('all'),
}).strict();
export const resultSchema = migrationResultSchema;

export default async function preview({ input }: CliRouteProps<typeof inputSchema>) {
  const p = await previewMigration(input);
  const result = migrationResult(p);
  return <Agent.Result value={result}><Agent.Text>{p.summary + `\n\nNext: gbot migrate import ${JSON.stringify(input.archive)} --to ${input.to}${input.profile ? ' --profile ' + input.profile : ''} --yes`}</Agent.Text></Agent.Result>;
}
