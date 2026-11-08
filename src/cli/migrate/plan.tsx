import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { planMigration } from '../../core/migration.js';

export const config = {
  description: 'Preview an offline OpenClaw workspace conversion without writing or contacting a provider.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      archive: { description: 'Verified gbot migration archive directory', type: 'string' },
      to: { description: 'Offline staging target', enum: ['openclaw'], default: 'openclaw', type: 'string' },
      includeSkills: { description: 'Explicitly stage user workflow text as loadable skills; review before activation', type: 'boolean' },
    },
    required: ['archive'],
    type: 'object',
  },
  positionals: ['archive'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  archive: z.string().min(1),
  to: z.literal('openclaw').default('openclaw'),
  includeSkills: z.boolean().default(false),
}).strict();
export const resultSchema = migrationResultSchema;

export default async function plan({ input }: CliRouteProps<typeof inputSchema>) {
  const result = migrationResult(planMigration(input.archive, { to: input.to, includeSkills: input.includeSkills }));
  return <Agent.Result value={result}><Agent.Text>{JSON.stringify(result, null, 2)}</Agent.Text></Agent.Result>;
}
