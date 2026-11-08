import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { outcomeFromError } from '../../core/codex/contract.js';
import { backendFlagsSchema, failureDocumentSchema, openBackendFromInput } from '../_shared.js';

export const config = {
  description: 'Share a server-hosted bot as a Grok Bot template (x.ai/bot link), as the Grok Bot app does, or show its current template with --status.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      account: { description: 'Saved Grok Bot login. Uses --account, then GBOT_ACCOUNT, then the config default, then the descriptor single or active entry', type: 'string' },
      ref: { description: 'Bot id or name', type: 'string' },
      status: { description: 'Show the current template and link; sends nothing', type: 'boolean' },
      wait: { description: 'Seconds to wait for the template after the message (default 600; 0 does not wait)', type: 'number' },
    },
    required: ['ref'],
    type: 'object',
  },
  positionals: ['ref'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema
  .extend({
    ref: z.string().min(1),
    status: z.boolean().optional(),
    wait: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((input) => !(input.status && input.wait !== undefined), '--wait applies to sending, not to --status.');

const templateSchema = z.object({
  activeVersion: z.number(),
  link: z.string(),
  name: z.string(),
  published: z.boolean(),
  shareId: z.string(),
  updatedAtMs: z.number(),
  visibility: z.string(),
}).strict();

const botFields = {
  id: z.string(),
  kind: z.literal('bot'),
  name: z.string(),
};

const statusSchema = z.object({
  ...botFields,
  exitCode: z.literal(0),
  exportPolicy: z.string().optional(),
  hasTeam: z.boolean(),
  template: templateSchema.nullable(),
}).strict();

const sharedSchema = z.object({
  ...botFields,
  action: z.enum(['created', 'updated']),
  clientNonce: z.string(),
  delivery: z.enum(['accepted', 'unknown']),
  exitCode: z.literal(0),
  template: templateSchema,
}).strict();

const notYetSchema = z.object({
  ...botFields,
  action: z.enum(['created', 'updated']),
  clientNonce: z.string(),
  delivery: z.enum(['accepted', 'unknown']),
  exitCode: z.literal(3),
  hint: z.string(),
  template: z.null(),
}).strict();

export const resultSchema = z.union([statusSchema, sharedSchema, notYetSchema, failureDocumentSchema]);

type Template = z.infer<typeof templateSchema>;
type Value = z.infer<typeof resultSchema>;

const DEFAULT_WAIT_SECONDS = 600;

const describe = (template: Template): string =>
  `${template.published ? 'published' : 'not published'}${template.visibility ? `, ${template.visibility}` : ''}${template.activeVersion ? `, version ${template.activeVersion}` : ''}`;

const run = async (input: z.infer<typeof inputSchema>, signal: AbortSignal): Promise<Value> => {
  const backend = await openBackendFromInput(input);
  if (input.status) {
    const found = await backend.template(input.ref, { signal });
    return {
      id: found.target.id,
      kind: 'bot',
      name: found.target.name,
      template: found.template,
      ...(found.exportPolicy ? { exportPolicy: found.exportPolicy } : {}),
      hasTeam: found.hasTeam,
      exitCode: 0,
    };
  }
  const waitSeconds = input.wait ?? DEFAULT_WAIT_SECONDS;
  const out = await backend.shareTemplate(input.ref, { signal, waitSeconds });
  const action = out.action === 'updated' ? 'updated' as const : 'created' as const;
  const delivery = out.delivery === 'accepted' ? 'accepted' as const : 'unknown' as const;
  const fields = { id: out.target.id, kind: 'bot' as const, name: out.target.name, action, clientNonce: out.clientNonce, delivery };
  if (out.template) return { ...fields, template: out.template, exitCode: 0 };
  const shown = /[\s"]/.test(input.ref) ? JSON.stringify(input.ref) : input.ref;
  return {
    ...fields,
    template: null,
    hint: `No ${action === 'updated' ? 'newer ' : ''}template within ${waitSeconds} s. Check later with gbot bots template ${shown} --status; sending again would ask the bot again.`,
    exitCode: 3,
  };
};

const textOf = (value: Value): string => {
  if (value.exitCode === 1) {
    const nonce = typeof value.clientNonce === 'string' && value.clientNonce ? value.clientNonce : '';
    return nonce ? `${value.error}\nnonce ${nonce}` : value.error;
  }
  const who = `bot ${value.name} (${value.id})`;
  if (value.exitCode === 3) {
    return `Asked ${who} to ${value.action === 'updated' ? 'update' : 'create'} its template (delivery ${value.delivery}, nonce ${value.clientNonce}).\n${value.hint}`;
  }
  if (!('action' in value)) {
    return value.template
      ? `Template of ${who}: ${value.template.name || value.template.shareId} (${describe(value.template)})\n${value.template.link}`
      : `${who[0]!.toUpperCase()}${who.slice(1)} has no template yet.`;
  }
  return `Template of ${who} ${value.action}: ${value.template.name || value.template.shareId} (${describe(value.template)})\n${value.template.link}`;
};

export default async function botsTemplate({ input, signal }: CliRouteProps<typeof inputSchema>) {
  let value: Value;
  try {
    value = await run(input, signal);
  } catch (error) {
    value = outcomeFromError(error);
  }
  return (
    <Agent.Result value={value}>
      <Agent.Text>{textOf(value)}</Agent.Text>
    </Agent.Result>
  );
}
