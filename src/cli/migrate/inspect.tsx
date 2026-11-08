import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { MigrationError, captureSnapshot, snapshotSummary, verifyMigration } from '../../core/migration.js';
import { openMigrationSource } from '../../core/migration-source.js';

export const config = {
  description: 'Inspect source inventory or verify an offline archive; never sends a model prompt.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      account: { description: 'Saved Grok Bot login; never exported as a credential', type: 'string' },
      dir: { description: 'Explicit on-disk agents directory (profiles only)', type: 'string' },
      files: { description: 'Read local profiles only; no history or skills', type: 'boolean' },
      archive: { description: 'Existing offline archive instead of a live source', type: 'string' },
    },
    required: [],
    type: 'object',
  },
  positionals: ['archive'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  account: z.string().min(1).optional(),
  dir: z.string().min(1).optional(),
  files: z.boolean().default(false),
  archive: z.string().min(1).optional(),
}).strict();
export const resultSchema = migrationResultSchema;

export default async function inspect({ input }: CliRouteProps<typeof inputSchema>) {
  let value: unknown;
  if (input.archive) {
    if (input.account || input.dir || input.files) throw new MigrationError('An offline archive cannot be combined with source flags.');
    value = verifyMigration(input.archive);
  } else {
    const source = await openMigrationSource(input);
    // Inventory does not call transcript/workflow readers. The file mode bypass is only in-memory.
    const snapshot = await captureSnapshot({ ...source, mode: 'files' });
    snapshot.source.mode = source.mode;
    value = { ...snapshotSummary(snapshot), scope: 'source-inventory-only', exitCode: 0 };
  }
  const result = migrationResult(value);
  return <Agent.Result value={result}><Agent.Text>{JSON.stringify(result, null, 2)}</Agent.Text></Agent.Result>;
}
