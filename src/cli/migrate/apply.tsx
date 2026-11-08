import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { applyMigration } from '../../core/migration.js';
import { MIGRATION_TARGETS } from '../../core/migration-targets.js';

export const config = {
  description: 'Create a new destination package after --yes; no live agent activation or message delivery.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      archive: { description: 'Verified gbot migration archive directory', type: 'string' },
      to: { description: 'Destination format; see migrate targets', enum: ['openclaw', 'hermes', 'muse', 'dot', 'portable'], default: 'openclaw', type: 'string' },
      includeSkills: { description: 'Include observed user workflow text in native skills or handoff packets', type: 'boolean' },
      out: { description: 'New output directory, not an existing agent home', type: 'string' },
      yes: { description: 'Confirm the reviewed local conversion', type: 'boolean' },
    },
    required: ['archive', 'out'],
    type: 'object',
  },
  positionals: ['archive'],
} satisfies CliRouteConfig;

// The config above must be literal for agent-bundle; the generated-CLI tests cover every registry entry.
export const inputSchema = z.object({
  archive: z.string().min(1),
  to: z.enum(MIGRATION_TARGETS).default('openclaw'),
  includeSkills: z.boolean().default(false),
  out: z.string().min(1),
  yes: z.boolean().default(false),
}).strict();
export const resultSchema = migrationResultSchema;

export default async function apply({ input }: CliRouteProps<typeof inputSchema>) {
  const result = migrationResult(applyMigration(input.archive, { out: input.out, to: input.to, includeSkills: input.includeSkills, yes: input.yes }));
  return <Agent.Result value={result}><Agent.Text>{JSON.stringify(result, null, 2)}</Agent.Text></Agent.Result>;
}
