import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { readMailbox } from '../../core/mailbox.js';
import { backendFlagsSchema, openBackendFromInput } from '../_shared.js';

export const config = {
  description: 'Read addressed assistant mailbox packets; optionally poll up to 60 seconds.',
  positionals: ['target'],
  inputJsonSchema: { type: 'object', additionalProperties: false, required: ['target', 'recipient'], properties: {
    target: { type: 'string' }, recipient: { type: 'string' }, topic: { type: 'string' }, after: { type: 'string', description: 'Opaque transcript cursor' },
    limit: { type: 'number', default: 200 }, wait: { type: 'number', default: 0 }, includeUnattributed: { type: 'boolean', default: false, description: 'Accept addressed unknown-role packets with unverified provenance' },
    account: { type: 'string' }, gateway: { type: 'boolean' }, files: { type: 'boolean' }, dir: { type: 'string' },
  } },
} satisfies CliRouteConfig;
export const inputSchema = backendFlagsSchema.extend({
  target: z.string().min(1), recipient: z.string().min(1), topic: z.string().min(1).optional(), after: z.string().min(1).max(1024).optional(),
  limit: z.number().int().min(1).max(200).default(200), wait: z.number().min(0).max(60).default(0), includeUnattributed: z.boolean().default(false),
}).strict();
export const resultSchema = z.record(z.string(), z.json());

export default async function read({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const value = await readMailbox(backend, input.target, { recipient: input.recipient, topic: input.topic ?? null, after: input.after, limit: input.limit, waitSeconds: input.wait, includeUnattributed: input.includeUnattributed });
  return <Agent.Result value={value}><Agent.Text>{JSON.stringify(value)}</Agent.Text></Agent.Result>;
}
