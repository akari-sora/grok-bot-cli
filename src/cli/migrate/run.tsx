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
      skills: { description: 'Skills: all, none, or for Muse/dot also index (names only) or a comma-separated list (default: all; Muse/dot by chat: index)', type: 'string' },
      via: { description: 'Muse/dot delivery: auto (default: one zip upload when it fits), upload, or chat (file by file)', enum: ['auto', 'upload', 'chat'], type: 'string' },
      history: { description: 'Muse/dot history: full, recent:N or none (default: upload full, chat recent:30)', type: 'string' },
      folder: { description: 'Muse/dot folder on the agent\'s computer (default ~/grok-bot/<bot>)', type: 'string' },
      activateRoutines: { description: 'Create schedules that were on in Grok Bot as active (default: Hermes paused, Muse/dot notes only)', type: 'boolean' },
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
  skills: z.string().regex(/^(all|index|none|[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*)$/).optional(),
  via: z.enum(['auto', 'upload', 'chat']).default('auto'),
  history: z.string().regex(/^(full|none|recent(:\d{1,5})?)$/).optional(),
  folder: z.string().min(1).optional(),
  activateRoutines: z.boolean().default(false),
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
