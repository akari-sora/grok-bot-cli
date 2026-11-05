import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { backendFlagsSchema, openBackendFromInput } from './_shared.js';

export const config = {
  description: 'Check whether a send client nonce landed: the backend send status, then the live transcript tail. Does not resend.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      account: { description: 'Saved Grok Bot login. Uses --account, then GBOT_ACCOUNT, then the config default, then the descriptor single or active entry', type: 'string' },
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
  rejectionCode: z.string().optional(),
  roster: z.literal('box').optional(),
  sendStatus: z.string().optional(),
  seq: z.number().optional(),
  status: z.enum(['delivered', 'pending', 'rejected', 'not-found-in-tail']),
  tailError: z.string().optional(),
}).strict();

const STATUSES = ['delivered', 'pending', 'rejected', 'not-found-in-tail'] as const;
type Status = typeof STATUSES[number];
const asStatus = (status: string): Status => (STATUSES as readonly string[]).includes(status) ? status as Status : 'not-found-in-tail';

export default async function reconcile({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const found = await backend.reconcile(input.target, input.nonce);
  const entryId = 'entryId' in found && typeof found.entryId === 'string' && found.entryId.length > 0
    ? found.entryId
    : undefined;
  const seq = 'seq' in found && typeof found.seq === 'number' ? found.seq : undefined;
  const scanned = 'scanned' in found && typeof found.scanned === 'number' ? found.scanned : undefined;
  const sendStatus = 'sendStatus' in found && typeof found.sendStatus === 'string' && found.sendStatus ? found.sendStatus : undefined;
  const tailError = 'tailError' in found && typeof found.tailError === 'string' && found.tailError ? found.tailError : undefined;
  const rejectionCode = 'rejectionCode' in found && typeof found.rejectionCode === 'string' && found.rejectionCode
    ? found.rejectionCode
    : undefined;
  const value = {
    id: found.target.id,
    name: found.target.name,
    kind: found.target.isGroup ? 'group' as const : 'bot' as const,
    clientNonce: found.clientNonce,
    status: asStatus(found.status),
    ...(entryId ? { entryId } : {}),
    ...(seq !== undefined ? { seq } : {}),
    ...(scanned !== undefined ? { scanned } : {}),
    ...(sendStatus ? { sendStatus } : {}),
    ...(rejectionCode ? { rejectionCode } : {}),
    ...(tailError ? { tailError } : {}),
    ...(found.target.roster === 'box' ? { roster: 'box' as const } : {}),
  };
  const who = `${value.kind} ${value.name} (${value.id})`;
  const text = value.status === 'delivered'
    ? `Delivered nonce ${value.clientNonce} to ${who}${value.entryId ? ` entry ${value.entryId}` : ''}${value.seq !== undefined ? ` seq ${value.seq}` : ''}.`
    : value.status === 'pending'
      ? `Nonce ${value.clientNonce} for ${who} ${value.tailError ? `could not be checked in the transcript (${value.tailError})` : 'is not in the transcript yet'}, and ${value.sendStatus === 'UNAVAILABLE' ? 'its send status could not be read' : `the server says ${value.sendStatus}`}: it may still land. Do not resend.`
      : value.status === 'rejected'
        ? `The server rejected nonce ${value.clientNonce} for ${who}${value.rejectionCode ? ` (${value.rejectionCode})` : ''}. It was not delivered. Nothing was resent.`
        : `Nonce ${value.clientNonce} was not found in the last ${value.scanned ?? 0} transcript entries for ${who}${value.sendStatus === 'NOT_FOUND' ? ', and the server has no record of it' : ''}. Nothing was resent.`;
  return (
    <Agent.Result value={value}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
