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
      via: { description: 'Muse/dot delivery: auto (default: an attached zip when it fits, then Google Drive when a remote is set, then chat), upload, drive, or chat (file by file)', enum: ['auto', 'upload', 'drive', 'chat'], type: 'string' },
      driveRemote: { description: 'rclone remote for your Google Drive, for --via drive (default: GBOT_DRIVE_REMOTE)', type: 'string' },
      driveFolder: { description: 'Google Drive folder for the bundle (default gbot-migrations)', type: 'string' },
      keepDrive: { description: 'Keep the Drive copy after a verified migration (default: removed)', type: 'boolean' },
      history: { description: 'Muse/dot history: full, recent:N or none (default: upload full, chat recent:30)', type: 'string' },
      folder: { description: 'Muse/dot folder on the agent\'s computer (default ~/grok-bot/<bot>)', type: 'string' },
      activateRoutines: { description: 'Create schedules that were on in Grok Bot as active; Grok Bot keeps running them (default: Hermes paused, Muse/dot notes only; by default nothing in Grok Bot changes)', type: 'boolean' },
      moveRoutines: { description: 'Move the routines that are on in Grok Bot (or only those --routines names), with a short gap and never both running: created paused at the destination, then once the import check passes paused in Grok Bot (SetGrokBotAgentAutomationEnabled; needs the bot\'s login, see --account), then turned on at the destination; a routine that cannot be turned on there is turned back on in Grok Bot', type: 'boolean' },
      routines: { description: 'With --activate-routines or --move-routines, only these routines: comma-separated ids or exact names of routines that are on in Grok Bot. The others stay as by default (Hermes: created paused; Muse/dot: notes only) and are never paused in Grok Bot', type: 'string' },
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
  via: z.enum(['auto', 'upload', 'drive', 'chat']).default('auto'),
  driveRemote: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*:$/).optional(),
  driveFolder: z.string().regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/).optional(),
  keepDrive: z.boolean().default(false),
  history: z.string().regex(/^(full|none|recent(:\d{1,5})?)$/).optional(),
  folder: z.string().min(1).optional(),
  activateRoutines: z.boolean().default(false),
  moveRoutines: z.boolean().default(false),
  routines: z.string().min(1).optional(),
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
