import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { importMigration } from '../../core/migration-flow.js';
import { importText } from '../../core/migration-text.js';

export const config = {
  description: 'Step 4: import the archive into the destination, read it back and run acceptance checks. Needs --yes.',
  exitCode: 'result',
  render: { maxElapsedMs: 14400000 },
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      archive: { description: 'Archive from gbot migrate capture', type: 'string' },
      to: { description: 'Destination', enum: ['hermes', 'muse', 'dot'], type: 'string' },
      profile: { description: 'Hermes profile name (default grok-<bot>)', type: 'string' },
      skills: { description: 'Skill library: all (default) or none', enum: ['all', 'none'], type: 'string' },
      yes: { description: 'Confirm the previewed import', type: 'boolean' },
      accept: { description: 'Run the behavioral acceptance checks (default on; uses the destination model)', type: 'boolean' },
      intoExisting: { description: 'Add to an existing Hermes profile this migration did not create', type: 'boolean' },
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
  yes: z.boolean().default(false),
  accept: z.boolean().default(true),
  intoExisting: z.boolean().default(false),
}).strict();
export const resultSchema = migrationResultSchema;

export default async function importRoute({ input }: CliRouteProps<typeof inputSchema>) {
  const r = await importMigration(input);
  const result = migrationResult(r);
  return <Agent.Result value={result}><Agent.Text>{importText(r)}</Agent.Text></Agent.Result>;
}
