import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { applyMigration } from '../../core/migration.js';

export const config = {
  description: 'Stage new OpenClaw workspaces after --yes; never activates agents or changes existing state.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      archive: { description: 'Verified gbot migration archive directory', type: 'string' },
      to: { description: 'Offline staging target', enum: ['openclaw'], default: 'openclaw', type: 'string' },
      includeSkills: { description: 'Explicitly stage user workflow text as loadable skills; review before activation', type: 'boolean' },
      out: { description: 'New staging directory, not an existing OpenClaw home', type: 'string' },
      yes: { description: 'Confirm the reviewed staging plan', type: 'boolean' },
    },
    required: ['archive', 'out'],
    type: 'object',
  },
  positionals: ['archive'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  archive: z.string().min(1),
  to: z.literal('openclaw').default('openclaw'),
  includeSkills: z.boolean().default(false),
  out: z.string().min(1),
  yes: z.boolean().default(false),
}).strict();
export const resultSchema = migrationResultSchema;

export default async function apply({ input }: CliRouteProps<typeof inputSchema>) {
  const result = migrationResult(applyMigration(input.archive, { out: input.out, to: input.to, includeSkills: input.includeSkills, yes: input.yes }));
  return <Agent.Result value={result}><Agent.Text>{JSON.stringify(result, null, 2)}</Agent.Text></Agent.Result>;
}
