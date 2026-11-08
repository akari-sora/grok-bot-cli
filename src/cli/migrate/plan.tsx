import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { planMigration } from '../../core/migration.js';
import { MIGRATION_TARGETS } from '../../core/migration-targets.js';

export const config = {
  description: 'Preview a destination package offline; never writes or sends messages.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      archive: { description: 'Verified gbot migration archive directory', type: 'string' },
      to: { description: 'Destination format; see migrate targets', enum: ['openclaw', 'hermes', 'muse', 'dot', 'portable'], default: 'openclaw', type: 'string' },
      includeSkills: { description: 'Include observed user workflow text in native skills or handoff packets', type: 'boolean' },
    },
    required: ['archive'],
    type: 'object',
  },
  positionals: ['archive'],
} satisfies CliRouteConfig;

// The config above must be literal for agent-bundle; the generated-CLI tests cover every registry entry.
export const inputSchema = z.object({
  archive: z.string().min(1),
  to: z.enum(MIGRATION_TARGETS).default('openclaw'),
  includeSkills: z.boolean().default(false),
}).strict();
export const resultSchema = migrationResultSchema;

export default async function plan({ input }: CliRouteProps<typeof inputSchema>) {
  const result = migrationResult(planMigration(input.archive, { to: input.to, includeSkills: input.includeSkills }));
  return <Agent.Result value={result}><Agent.Text>{JSON.stringify(result, null, 2)}</Agent.Text></Agent.Result>;
}
