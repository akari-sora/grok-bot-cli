import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { importMigration } from '../../core/migration-flow.js';
import { importText } from '../../core/migration-text.js';

export const config = {
  description: 'Step 4: import the archive into the destination, read it back and run acceptance checks. Needs --yes.',
  exitCode: 'result',
  render: { maxElapsedMs: 14400000 },
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      archive: { description: 'Archive from gbot migrate capture', type: 'string' },
      to: { description: 'Destination', enum: ['hermes', 'muse', 'dot'], type: 'string' },
      account: { description: 'Saved Grok Bot login of the bot, for --move-routines (see gbot accounts)', type: 'string' },
      profile: { description: 'Hermes profile name (default grok-<bot>)', type: 'string' },
      skills: { description: 'Skills: all, none, or for Muse/dot also index (names only) or a comma-separated list (default: all; Muse/dot by chat: index)', type: 'string' },
      via: { description: 'Muse/dot delivery: auto (default: an attached zip when it fits, then Google Drive when a remote is set, then chat), upload, drive, or chat (file by file)', enum: ['auto', 'upload', 'drive', 'chat'], type: 'string' },
      driveRemote: { description: 'rclone remote for your Google Drive, for --via drive (default: GBOT_DRIVE_REMOTE)', type: 'string' },
      driveFolder: { description: 'Google Drive folder for the bundle (default gbot-migrations)', type: 'string' },
      keepDrive: { description: 'Keep the Drive copy after a verified migration (default: removed)', type: 'boolean' },
      history: { description: 'Muse/dot history: full, recent:N or none (default: upload full, chat recent:30)', type: 'string' },
      folder: { description: 'Muse/dot folder on the agent\'s computer (default ~/grok-bot/<bot>)', type: 'string' },
      activateRoutines: { description: 'Create schedules that were on in Grok Bot as active; Grok Bot keeps running them (default: Hermes paused, Muse/dot notes only; by default nothing in Grok Bot changes)', type: 'boolean' },
      moveRoutines: { description: 'Move the routines that are on in Grok Bot (or only those --routines names): create them active at the destination (implies --activate-routines), then pause them in Grok Bot once the import check passes (SetGrokBotAgentAutomationEnabled; needs the bot\'s login, see --account)', type: 'boolean' },
      routines: { description: 'With --activate-routines or --move-routines, only these routines: comma-separated ids or exact names of routines that are on in Grok Bot. The others stay as by default (Hermes: created paused; Muse/dot: notes only) and are never paused in Grok Bot', type: 'string' },
      yes: { description: 'Confirm the previewed import', type: 'boolean' },
      accept: { description: 'Run the behavioral acceptance checks (default on; uses the destination model)', type: 'boolean' },
      intoExisting: { description: 'Add to an existing Hermes profile this migration did not create', type: 'boolean' },
    },
    required: ['archive', 'to'],
    type: 'object',
  },
  positionals: ['archive'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  archive: z.string().min(1),
  to: z.enum(['hermes', 'muse', 'dot']),
  account: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
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

export default async function importRoute({ input }: CliRouteProps<typeof inputSchema>) {
  const r = await importMigration(input);
  const result = migrationResult(r);
  return <Agent.Result value={result}><Agent.Text>{importText(r)}</Agent.Text></Agent.Result>;
}
