import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { MIGRATION_TARGETS, targetCapability } from '../../core/migration-targets.js';

export const config = {
  description: 'List migration targets, their real scope and whether Trinity is needed; entirely offline.',
  exitCode: 'result',
  inputJsonSchema: { additionalProperties: false, properties: {}, type: 'object' },
} satisfies CliRouteConfig;
export const inputSchema = z.object({}).strict();
export const resultSchema = migrationResultSchema;
export default async function targets() {
  const result = migrationResult({ exitCode: 0, targets: MIGRATION_TARGETS.map(targetCapability) });
  return <Agent.Result value={result}><Agent.Text>{JSON.stringify(result, null, 2)}</Agent.Text></Agent.Result>;
}
