import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { runMigration } from '../../core/migration-flow.js';
import { coverageText, importText } from '../../core/migration-text.js';

export const config = {
  description: 'Whole flow for one bot: capture, show the destination diff, and with --yes import, read back and accept.',
  exitCode: 'result',
  render: { maxElapsedMs: 14400000 },
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      account: { description: 'Saved Grok Bot login (see gbot accounts)', type: 'string' },
      bot: { description: 'Bot name or id (see gbot migrate bots)', type: 'string' },
      to: { description: 'Destination', enum: ['hermes', 'muse', 'dot'], type: 'string' },
      profile: { description: 'Hermes profile name (default grok-<bot>)', type: 'string' },
      out: { description: 'New archive directory', type: 'string' },
      maxFileMb: { description: 'Largest box file to copy, in MiB (default 8)', type: 'number' },
      skills: { description: 'Skill library: all (default) or none', enum: ['all', 'none'], type: 'string' },
      yes: { description: 'Import after showing the diff', type: 'boolean' },
      accept: { description: 'Run the behavioral acceptance checks (default on)', type: 'boolean' },
      intoExisting: { description: 'Add to an existing Hermes profile this migration did not create', type: 'boolean' },
    },
    required: ['bot', 'to'],
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  account: z.string().min(1).optional(),
  bot: z.string().min(1),
  to: z.enum(['hermes', 'muse', 'dot']),
  profile: z.string().min(1).optional(),
  out: z.string().min(1).optional(),
  maxFileMb: z.number().positive().max(1024).optional(),
  skills: z.enum(['all', 'none']).default('all'),
  yes: z.boolean().default(false),
  accept: z.boolean().default(true),
  intoExisting: z.boolean().default(false),
}).strict();
export const resultSchema = migrationResultSchema;

export default async function run({ input }: CliRouteProps<typeof inputSchema>) {
  const r: any = await runMigration(input);
  const result = migrationResult(r);
  const text = [`Archive: ${r.captured.archive}`, coverageText(r.captured.coverage), '', r.preview.summary,
    r.stage === 'preview' ? `\nNothing was imported. Review the diff above, then run:\n  ${r.next}` : '\n' + importText(r.imported)].join('\n');
  return <Agent.Result value={result}><Agent.Text>{text}</Agent.Text></Agent.Result>;
}
