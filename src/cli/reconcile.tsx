import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { backendFlagsSchema, openBackendFromInput } from './_shared.js';

export const config = {
  description: 'Check whether a send client nonce is in the live transcript tail. Does not resend.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      account: { description: 'Saved Grok Bot login to use when several are stored. No default; overrides GBOT_ACCOUNT', type: 'string' },
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      nonce: { description: 'clientNonce from the send that reported unknown delivery', type: 'string' },
      target: { description: 'Bot or group name or id', type: 'string' },
    },
    required: ['target', 'nonce'],
    type: 'object',
  },
  positionals: ['target'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema.extend({
  nonce: z.string().min(1),
  target: z.string().min(1),
}).strict();

export const resultSchema = z.object({
  clientNonce: z.string(),
  entryId: z.string().optional(),
  id: z.string(),
  kind: z.enum(['bot', 'group']),
  name: z.string(),
  scanned: z.number().int().nonnegative().optional(),
  seq: z.number().optional(),
  status: z.enum(['delivered', 'not-found-in-tail']),
}).strict();

export default async function reconcile({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const found = await backend.reconcile(input.target, input.nonce);
  const entryId = 'entryId' in found && typeof found.entryId === 'string' && found.entryId.length > 0
    ? found.entryId
    : undefined;
  const seq = 'seq' in found && typeof found.seq === 'number' ? found.seq : undefined;
  const scanned = 'scanned' in found && typeof found.scanned === 'number' ? found.scanned : undefined;
  const value = {
    id: found.target.id,
    name: found.target.name,
    kind: found.target.isGroup ? 'group' as const : 'bot' as const,
    clientNonce: found.clientNonce,
    status: found.status === 'delivered' ? 'delivered' as const : 'not-found-in-tail' as const,
    ...(entryId ? { entryId } : {}),
    ...(seq !== undefined ? { seq } : {}),
    ...(scanned !== undefined ? { scanned } : {}),
  };
  const text = value.status === 'delivered'
    ? `Delivered nonce ${value.clientNonce} to ${value.kind} ${value.name} (${value.id})${value.entryId ? ` entry ${value.entryId}` : ''}${value.seq !== undefined ? ` seq ${value.seq}` : ''}.`
    : `Nonce ${value.clientNonce} was not found in the last ${value.scanned ?? 0} transcript entries for ${value.kind} ${value.name} (${value.id}). Nothing was resent.`;
  return (
    <Agent.Result value={value}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
