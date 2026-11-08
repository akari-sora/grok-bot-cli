import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { captureSnapshot, exportSnapshot } from '../../core/migration.js';
import { openMigrationSource } from '../../core/migration-source.js';

export const config = {
  description: 'Export a private limited snapshot; read failures retain the archive and exit 3.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      account: { description: 'Saved Grok Bot login; never exported as a credential', type: 'string' },
      dir: { description: 'Explicit on-disk agents directory (profiles only)', type: 'string' },
      files: { description: 'Read local profiles only; no history or skills', type: 'boolean' },
      out: { description: 'New archive directory; existing directories are refused', type: 'string' },
      limit: { description: 'Trailing messages per bot or group, not full history', default: 200, type: 'number' },
    },
    required: ['out'],
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  account: z.string().min(1).optional(),
  dir: z.string().min(1).optional(),
  files: z.boolean().default(false),
  out: z.string().min(1),
  limit: z.number().int().min(1).max(200).default(200),
}).strict();
export const resultSchema = migrationResultSchema;

export default async function exportArchive({ input }: CliRouteProps<typeof inputSchema>) {
  const source = await openMigrationSource(input);
  const snapshot = await captureSnapshot({ ...source, limit: input.limit });
  const result = migrationResult(exportSnapshot(snapshot, input.out));
  return <Agent.Result value={result}><Agent.Text>{JSON.stringify(result, null, 2)}</Agent.Text></Agent.Result>;
}
