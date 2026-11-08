import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { captureToArchive } from '../../core/migration-flow.js';
import { coverageText } from '../../core/migration-text.js';

export const config = {
  description: 'Step 2: capture one bot completely (all history pages, memory, skills, routines, tasks, files) into a verified archive. Read-only on Grok Bot.',
  exitCode: 'result',
  render: { maxElapsedMs: 3600000 },
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      account: { description: 'Saved Grok Bot login (see gbot accounts)', type: 'string' },
      bot: { description: 'Bot name or id (see gbot migrate bots)', type: 'string' },
      out: { description: 'New archive directory (default ~/.grok-bot-cli/migrations/<bot>-<time>)', type: 'string' },
      maxFileMb: { description: 'Largest box file to copy, in MiB (default 8)', type: 'number' },
      timeZone: { description: 'IANA time zone for routine times (default: this computer)', type: 'string' },
    },
    required: ['bot'],
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  account: z.string().min(1).optional(),
  bot: z.string().min(1),
  out: z.string().min(1).optional(),
  maxFileMb: z.number().positive().max(1024).optional(),
  timeZone: z.string().min(1).optional(),
}).strict();
export const resultSchema = migrationResultSchema;

export default async function capture({ input }: CliRouteProps<typeof inputSchema>) {
  const captured = await captureToArchive(input);
  const failed = Object.values(captured.coverage).some((c: any) => c.status === 'failed');
  const result = migrationResult({ exitCode: failed ? 3 : 0, ...captured });
  return <Agent.Result value={result}><Agent.Text>{`Archive: ${captured.archive} (${captured.files} files, every file SHA-256 checked)\n\n${coverageText(captured.coverage)}`}</Agent.Text></Agent.Result>;
}
