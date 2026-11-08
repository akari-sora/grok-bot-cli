import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { migrationResult, migrationResultSchema } from '../../core/migration-route.js';
import { previewMigration } from '../../core/migration-flow.js';

export const config = {
  description: 'Step 3: show what an import would create at the destination and what cannot move. Changes nothing.',
  exitCode: 'result',
  render: { maxElapsedMs: 600000 },
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      archive: { description: 'Archive from gbot migrate capture', type: 'string' },
      to: { description: 'Destination', enum: ['hermes', 'muse', 'dot'], type: 'string' },
      profile: { description: 'Hermes profile name (default grok-<bot>)', type: 'string' },
      skills: { description: 'Skills: all, none, or for Muse/dot also index (names only) or a comma-separated list (default: all; Muse/dot by chat: index)', type: 'string' },
      via: { description: 'Muse/dot delivery: auto (default: an attached zip when it fits, then Google Drive when a remote is set, then chat), upload, drive, or chat (file by file)', enum: ['auto', 'upload', 'drive', 'chat'], type: 'string' },
      driveRemote: { description: 'rclone remote for your Google Drive, for --via drive (default: GBOT_DRIVE_REMOTE)', type: 'string' },
      driveFolder: { description: 'Google Drive folder for the bundle (default gbot-migrations)', type: 'string' },
      history: { description: 'Muse/dot history: full, recent:N or none (default: upload full, chat recent:30)', type: 'string' },
      folder: { description: 'Muse/dot folder on the agent\'s computer (default ~/grok-bot/<bot>)', type: 'string' },
      activateRoutines: { description: 'Create schedules that were on in Grok Bot as active; Grok Bot keeps running them (default: Hermes paused, Muse/dot notes only; by default nothing in Grok Bot changes)', type: 'boolean' },
      moveRoutines: { description: 'Show the import with --move-routines: routines on in Grok Bot (or only those --routines names) created active here and paused in Grok Bot after the check (changes nothing now)', type: 'boolean' },
      routines: { description: 'With --activate-routines or --move-routines, only these routines: comma-separated ids or exact names of routines that are on in Grok Bot. The others stay as by default (Hermes: created paused; Muse/dot: notes only) and are never paused in Grok Bot', type: 'string' },
    },
    required: ['archive', 'to'],
    type: 'object',
  },
  positionals: ['archive'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  archive: z.string().min(1),
  to: z.enum(['hermes', 'muse', 'dot']),
  profile: z.string().min(1).optional(),
  skills: z.string().regex(/^(all|index|none|[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*)$/).optional(),
  via: z.enum(['auto', 'upload', 'drive', 'chat']).default('auto'),
  driveRemote: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*:$/).optional(),
  driveFolder: z.string().regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/).optional(),
  history: z.string().regex(/^(full|none|recent(:\d{1,5})?)$/).optional(),
  folder: z.string().min(1).optional(),
  activateRoutines: z.boolean().default(false),
  moveRoutines: z.boolean().default(false),
  routines: z.string().min(1).optional(),
}).strict();
export const resultSchema = migrationResultSchema;

export default async function preview({ input }: CliRouteProps<typeof inputSchema>) {
  const p = await previewMigration(input);
  const result = migrationResult(p);
  // The guided `gbot migrate` asks for confirmation itself; plain use prints the next command.
  const routines = (input.moveRoutines ? ' --move-routines' : input.activateRoutines ? ' --activate-routines' : '') + (input.routines ? ' --routines ' + JSON.stringify(input.routines) : '');
  const next = process.env.GBOT_WIZARD ? '' : `\n\nNext: gbot migrate import ${JSON.stringify(input.archive)} --to ${input.to}${input.profile ? ' --profile ' + input.profile : ''}${routines} --yes`;
  return <Agent.Result value={result}><Agent.Text>{p.summary + next}</Agent.Text></Agent.Result>;
}
