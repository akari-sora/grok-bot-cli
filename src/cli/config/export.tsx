import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { exportAccountConfig } from '../../core/gbot-config.js';

export const config = {
  description: 'Write aliases and the default login as JSON. Includes emails. Never includes tokens.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      out: { description: 'File to write. Omit to print the JSON.', type: 'string' },
    },
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  out: z.string().min(1).optional(),
}).strict();

const aliasSchema = z.object({
  scope: z.string(),
  email: z.string().optional(),
}).strict();

export const resultSchema = z.object({
  version: z.literal(1),
  aliases: z.record(z.string(), aliasSchema),
  default: z.string().nullable(),
  gbotVersion: z.string(),
}).strict();

export default async function configExport({ input }: CliRouteProps<typeof inputSchema>) {
  const doc = exportAccountConfig({ out: input.out });
  const text = input.out ? `Wrote ${input.out}` : JSON.stringify(doc, null, 2);
  return (
    <Agent.Result value={doc}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
