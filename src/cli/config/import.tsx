import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { importAccountConfig } from '../../core/gbot-config.js';

export const config = {
  description: 'Import aliases from a JSON file. Merges unless --replace. Exit 2 is invalid input. Exit 3 means some logins are not signed in on this machine.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      file: { description: 'JSON file from gbot config export', type: 'string' },
      replace: { description: 'Replace aliases and the default instead of merging', type: 'boolean' },
    },
    required: ['file'],
    type: 'object',
  },
  positionals: ['file'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  file: z.string().min(1),
  replace: z.boolean().optional(),
}).strict();

export const resultSchema = z.object({
  exitCode: z.union([z.literal(0), z.literal(2), z.literal(3)]),
  messages: z.array(z.string()),
}).strict();

export default async function configImport({ input }: CliRouteProps<typeof inputSchema>) {
  const result = importAccountConfig({ file: input.file, replace: Boolean(input.replace) });
  const text = result.exitCode === 0
    ? 'Imported gbot config.'
    : result.messages.join('\n');
  return (
    <Agent.Result value={result}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
