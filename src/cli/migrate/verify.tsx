import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { verifyMigration } from '../../core/migration.js';

export const config = {
  description: 'Verify archive integrity and optionally compare staged files against the source; not a runtime test.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      archive: { description: 'Existing gbot migration archive', type: 'string' },
      out: { description: 'Previously staged OpenClaw directory to verify', type: 'string' },
    },
    required: ['archive'],
    type: 'object',
  },
  positionals: ['archive'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  archive: z.string().min(1),
  out: z.string().min(1).optional(),
}).strict();
export const resultSchema = migrationResultSchema;

export default async function verify({ input }: CliRouteProps<typeof inputSchema>) {
  const result = migrationResult(verifyMigration(input.archive, { out: input.out }));
  return <Agent.Result value={result}><Agent.Text>{JSON.stringify(result, null, 2)}</Agent.Text></Agent.Result>;
}
