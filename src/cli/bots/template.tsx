import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { outcomeFromError } from '../../core/codex/contract.js';
import { backendFlagsSchema, failureDocumentSchema, openBackendFromInput } from '../_shared.js';

export const config = {
  description: 'Share a server-hosted bot as a Grok Bot template (x.ai/bot link), as the Grok Bot app does; --status shows the template, --show reviews a version, --publish publishes it.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      account: { description: 'Saved Grok Bot login. Uses --account, then GBOT_ACCOUNT, then the config default, then the descriptor single or active entry', type: 'string' },
      ref: { description: 'Bot id or name', type: 'string' },
      publish: { description: 'Publish a template version (ActivateGrokBotTemplateVersion), as confirming the app\'s review card does', type: 'boolean' },
      show: { description: 'Show a template version\'s recipe (instructions, memory, skills, routines, plugins); sends nothing', type: 'boolean' },
      status: { description: 'Show the current template and link; sends nothing', type: 'boolean' },
      templateVersion: { description: 'Template version for --show or --publish (default: the newest template card in the bot\'s chat, else the active version)', type: 'number' },
      wait: { description: 'Seconds to wait for the template after the message (default 600; 0 does not wait)', type: 'number' },
    },
    required: ['ref'],
    type: 'object',
  },
  positionals: ['ref'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema
  .extend({
    publish: z.boolean().optional(),
    ref: z.string().min(1),
    show: z.boolean().optional(),
    status: z.boolean().optional(),
    templateVersion: z.number().int().min(1).optional(),
    wait: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((input) => [input.status, input.show, input.publish].filter(Boolean).length <= 1, 'Use one of --status, --show and --publish.')
  .refine((input) => !((input.status || input.show || input.publish) && input.wait !== undefined), '--wait applies to sending, not to --status, --show or --publish.')
  .refine((input) => input.templateVersion === undefined || Boolean(input.show || input.publish), '--template-version applies to --show and --publish.');

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

// The recipe as the gateway parsed it (the app's recipe schema, checked there).
const recipeSchema = z.object({
  gettingStarted: z.object({ skill: z.string() }).optional(),
  memory: z.array(z.object({ content: z.string(), createdAt: z.string().optional(), kind: z.string().optional() })),
  plugins: z.array(z.object({ description: z.string().optional(), name: z.string(), pluginId: z.string() })),
  profile: z.object({ avatarColor: z.string().optional(), avatarShape: z.string().optional(), description: z.string(), name: z.string() }),
  routines: z.array(z.object({ content: z.string(), description: z.string(), name: z.string(), slug: z.string() })),
  skills: z.array(z.object({ content: z.string(), description: z.string(), name: z.string() })),
});

const versionFromSchema = z.enum(['option', 'card', 'active']);
const asVersionFrom = (from: string): z.infer<typeof versionFromSchema> => (from === 'card' || from === 'active' ? from : 'option');

const showSchema = z.object({
  ...botFields,
  active: z.boolean(),
  createdAtMs: z.number().optional(),
  exitCode: z.literal(0),
  link: z.string(),
  recipe: recipeSchema,
  shareId: z.string(),
  version: z.number(),
  versionFrom: versionFromSchema,
  visibility: z.string(),
}).strict();

const publishedSchema = z.object({
  ...botFields,
  exitCode: z.literal(0),
  template: templateSchema,
  version: z.number(),
  versionFrom: versionFromSchema,
}).strict();

export const resultSchema = z.union([statusSchema, sharedSchema, notYetSchema, showSchema, publishedSchema, failureDocumentSchema]);

type Template = z.infer<typeof templateSchema>;
type Recipe = z.infer<typeof recipeSchema>;
type Value = z.infer<typeof resultSchema>;
type Outcome = { readonly text: string; readonly value: Value };

const DEFAULT_WAIT_SECONDS = 600;

const describe = (template: Template): string =>
  `${template.published ? 'published' : 'not published'}${template.visibility ? `, ${template.visibility}` : ''}${template.activeVersion ? `, version ${template.activeVersion}` : ''}`;

const whoOf = (target: { readonly id: string; readonly name: string }): string => `bot ${target.name} (${target.id})`;

const firstLine = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};

const recipeText = (recipe: Recipe): string[] => {
  const list = (label: string, names: string[]) => `${label} (${names.length})${names.map((name) => `\n  ${name}`).join('')}`;
  return [
    `Name: ${recipe.profile.name}`,
    `Description: ${recipe.profile.description.trim()}`,
    list('Memory', recipe.memory.map((item) => `${item.kind ?? 'memory'}: ${firstLine(item.content)}`)),
    list('Skills', recipe.skills.map((skill) => skill.name)),
    list('Routines', recipe.routines.map((routine) => `${routine.name} (${routine.slug})`)),
    list('Plugins', recipe.plugins.map((plugin) => `${plugin.name} (${plugin.pluginId})`)),
    `Getting started: ${recipe.gettingStarted ? `skill ${recipe.gettingStarted.skill}` : 'none'}`,
  ];
};

const run = async (input: z.infer<typeof inputSchema>, signal: AbortSignal): Promise<Outcome> => {
  const backend = await openBackendFromInput(input);
  if (input.status) {
    const found = await backend.template(input.ref, { signal });
    const who = whoOf(found.target);
    return {
      value: {
        id: found.target.id,
        kind: 'bot',
        name: found.target.name,
        template: found.template,
        ...(found.exportPolicy ? { exportPolicy: found.exportPolicy } : {}),
        hasTeam: found.hasTeam,
        exitCode: 0,
      },
      text: found.template
        ? `Template of ${who}: ${found.template.name || found.template.shareId} (${describe(found.template)})\n${found.template.link}`
        : `${who[0]!.toUpperCase()}${who.slice(1)} has no template yet.`,
    };
  }
  if (input.show) {
    const found = await backend.templateVersion(input.ref, { signal, version: input.templateVersion });
    return {
      value: {
        id: found.target.id,
        kind: 'bot',
        name: found.target.name,
        shareId: found.template.shareId,
        link: found.template.link,
        version: found.version,
        versionFrom: asVersionFrom(found.versionFrom),
        active: found.active,
        ...(found.createdAtMs !== undefined ? { createdAtMs: found.createdAtMs } : {}),
        visibility: found.visibility,
        recipe: found.recipe,
        exitCode: 0,
      },
      text: [
        `Template ${found.template.shareId} of ${whoOf(found.target)}, version ${found.version} (${found.active ? 'active' : 'not active'}${found.visibility ? `, ${found.visibility}` : ''})`,
        ...recipeText(found.recipe),
        found.template.link,
      ].join('\n'),
    };
  }
  if (input.publish) {
    const out = await backend.publishTemplate(input.ref, { signal, version: input.templateVersion });
    return {
      value: {
        id: out.target.id,
        kind: 'bot',
        name: out.target.name,
        version: out.version,
        versionFrom: asVersionFrom(out.versionFrom),
        template: out.template,
        exitCode: 0,
      },
      text: `Published version ${out.version} of the template of ${whoOf(out.target)}: ${describe(out.template)}\n${out.template.link}`,
    };
  }
  const waitSeconds = input.wait ?? DEFAULT_WAIT_SECONDS;
  const out = await backend.shareTemplate(input.ref, { signal, waitSeconds });
  const action = out.action === 'updated' ? 'updated' as const : 'created' as const;
  const delivery = out.delivery === 'accepted' ? 'accepted' as const : 'unknown' as const;
  const fields = { id: out.target.id, kind: 'bot' as const, name: out.target.name, action, clientNonce: out.clientNonce, delivery };
  const who = whoOf(out.target);
  if (out.template) {
    return {
      value: { ...fields, template: out.template, exitCode: 0 },
      text: `Template of ${who} ${action}: ${out.template.name || out.template.shareId} (${describe(out.template)})\n${out.template.link}`,
    };
  }
  const shown = /[\s"]/.test(input.ref) ? JSON.stringify(input.ref) : input.ref;
  const hint = `No ${action === 'updated' ? 'newer ' : ''}template within ${waitSeconds} s. Check later with gbot bots template ${shown} --status; sending again would ask the bot again.`;
  return {
    value: { ...fields, template: null, hint, exitCode: 3 },
    text: `Asked ${who} to ${action === 'updated' ? 'update' : 'create'} its template (delivery ${delivery}, nonce ${out.clientNonce}).\n${hint}`,
  };
};

export default async function botsTemplate({ input, signal }: CliRouteProps<typeof inputSchema>) {
  let outcome: Outcome;
  try {
    outcome = await run(input, signal);
  } catch (error) {
    const value: z.infer<typeof failureDocumentSchema> = outcomeFromError(error);
    const nonce = typeof value.clientNonce === 'string' && value.clientNonce ? value.clientNonce : '';
    outcome = { value, text: nonce ? `${value.error}\nnonce ${nonce}` : value.error };
  }
  return (
    <Agent.Result value={outcome.value}>
      <Agent.Text>{outcome.text}</Agent.Text>
    </Agent.Result>
  );
}
