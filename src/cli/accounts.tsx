import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { formatLoginCatalog, listLoginCatalog, defineAlias, removeAlias, setDefaultAccount } from '../core/logins.js';

export const config = {
  description: 'List saved Grok Bot logins, or manage aliases: gbot accounts alias <name> <selector>, unalias <name>, default <name>, default --clear.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      action: {
        description: 'alias, unalias, or default. Omit to list logins.',
        type: 'string',
      },
      name: { description: 'Alias name', type: 'string' },
      selector: { description: 'Email, label, id, or id prefix of at least 8 hex characters', type: 'string' },
      clear: { description: 'With default, clear the default alias', type: 'boolean' },
    },
    type: 'object',
  },
  positionals: ['action', 'name', 'selector'],
} satisfies CliRouteConfig;

const accountSchema = z.object({
  id: z.string(),
  label: z.string(),
  lastSaved: z.boolean(),
  savedAtMs: z.number().optional(),
  usable: z.boolean(),
  email: z.string().nullable(),
  alias: z.string().nullable(),
  appActive: z.boolean(),
  hasDescriptorEntry: z.boolean(),
}).strict();

export const inputSchema = z.object({
  action: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
  clear: z.boolean().optional(),
}).strict();

export const resultSchema = z.object({
  exitCode: z.union([z.literal(0), z.literal(2)]),
  accounts: z.array(accountSchema).optional(),
  name: z.string().optional(),
  scope: z.string().optional(),
  default: z.string().nullable().optional(),
  error: z.string().optional(),
}).strict();

type AccountsResult = z.infer<typeof resultSchema>;

const publicRow = (row: ReturnType<typeof listLoginCatalog>[number]): z.infer<typeof accountSchema> => ({
  id: row.shownId || row.id,
  label: row.label,
  lastSaved: row.lastSaved,
  ...(row.savedAtMs !== undefined ? { savedAtMs: row.savedAtMs } : {}),
  usable: row.usable,
  email: row.email,
  alias: row.alias,
  appActive: row.appActive,
  hasDescriptorEntry: row.hasDescriptorEntry,
});

function usage(error: string): AccountsResult {
  return { exitCode: 2, error };
}

function caught(error: unknown): AccountsResult | null {
  if (!error || typeof error !== 'object') return null;
  const code = 'code' in error ? String(error.code) : '';
  const exitCode = 'exitCode' in error && typeof error.exitCode === 'number' ? error.exitCode : undefined;
  if (exitCode !== 2 && code !== 'AMBIGUOUS_ENTRIES' && code !== 'UNKNOWN_ACCOUNT' && code !== 'INVALID') return null;
  const message = error instanceof Error ? error.message : 'Could not update the gbot account config.';
  return { exitCode: 2, error: message };
}

function runAction(input: z.infer<typeof inputSchema>): AccountsResult {
  const action = input.action;
  if (!action) {
    if (input.name || input.selector || input.clear) {
      return usage('gbot accounts lists logins. To change aliases, use alias, unalias, or default.');
    }
    try {
      const rows = listLoginCatalog().map(publicRow);
      return { exitCode: 0, accounts: rows };
    } catch (error) {
      return caught(error) ?? { exitCode: 2, error: error instanceof Error ? error.message : 'Could not read the gbot account config.' };
    }
  }
  if (action === 'alias') {
    if (!input.name || !input.selector || input.clear) return usage('Usage: gbot accounts alias <name> <selector>');
    try {
      const saved = defineAlias({ name: input.name, selector: input.selector });
      return { exitCode: 0, name: saved.name, scope: saved.scope };
    } catch (error) {
      return caught(error) ?? { exitCode: 2, error: error instanceof Error ? error.message : 'Could not save the alias.' };
    }
  }
  if (action === 'unalias') {
    if (!input.name || input.selector || input.clear) return usage('Usage: gbot accounts unalias <name>');
    try {
      removeAlias({ name: input.name });
      return { exitCode: 0, name: input.name };
    } catch (error) {
      return caught(error) ?? { exitCode: 2, error: error instanceof Error ? error.message : 'Could not remove the alias.' };
    }
  }
  if (action === 'default') {
    if (input.selector || (input.clear && input.name) || (!input.clear && !input.name)) {
      return usage('Usage: gbot accounts default <name> | gbot accounts default --clear');
    }
    try {
      setDefaultAccount({ name: input.name, clear: Boolean(input.clear) });
      return { exitCode: 0, default: input.clear ? null : input.name ?? null };
    } catch (error) {
      return caught(error) ?? { exitCode: 2, error: error instanceof Error ? error.message : 'Could not set the default alias.' };
    }
  }
  return usage('Usage: gbot accounts [alias <name> <selector> | unalias <name> | default <name> | default --clear]');
}

export default async function accounts({ input }: CliRouteProps<typeof inputSchema>) {
  const value = runAction(input);
  const text = value.accounts
    ? formatLoginCatalog(value.accounts)
    : value.error
      ? value.error
      : value.name && value.scope
        ? `Alias ${value.name} saved.`
        : value.name
          ? `Alias ${value.name} removed.`
          : value.default
            ? `Default login is ${value.default}.`
            : 'Default login cleared.';
  return (
    <Agent.Result value={value}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
