import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { checkMigration } from '../../core/migration-flow.js';
import { importText } from '../../core/migration-text.js';

export const config = {
  description: 'Read an imported destination back and compare it with the archive; --accept also asks the migrated agent.',
  exitCode: 'result',
  render: { maxElapsedMs: 14400000 },
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      archive: { description: 'Archive from gbot migrate capture', type: 'string' },
      to: { description: 'Destination', enum: ['hermes', 'muse', 'dot'], type: 'string' },
      profile: { description: 'Hermes profile name (default grok-<bot>)', type: 'string' },
      skills: { description: 'Skill library used at import: all (default) or none', enum: ['all', 'none'], type: 'string' },
      activateRoutines: { description: 'Same value as at import', type: 'boolean' },
      accept: { description: 'Also run the behavioral acceptance checks', type: 'boolean' },
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
  activateRoutines: z.boolean().default(false),
  accept: z.boolean().default(false),
}).strict();
export const resultSchema = migrationResultSchema;

export default async function check({ input }: CliRouteProps<typeof inputSchema>) {
  const r = await checkMigration(input);
  const result = migrationResult(r);
  return <Agent.Result value={result}><Agent.Text>{importText(r)}</Agent.Text></Agent.Result>;
}
