import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { makePacket, sendMailbox } from '../../core/mailbox.js';
import { readCommandStdin } from '../../core/stdin-message.js';
import { outcomeFromError } from '../../core/codex/contract.js';
import { backendFlagsSchema, openBackendFromInput } from '../_shared.js';

export const config = {
  description: 'Send a plain mailbox packet to a bot conversation.',
  exitCode: 'result',
  positionals: ['target', 'message'],
  inputJsonSchema: { type: 'object', additionalProperties: false, required: ['target', 'from'], properties: {
    target: { type: 'string' }, from: { type: 'string', description: 'Sender label' }, to: { type: 'string', description: 'Optional recipient label' },
    topic: { type: 'string' }, replyTo: { type: 'string', description: 'Packet id being answered' },
    message: { type: 'array', items: { type: 'string' } }, stdin: { type: 'boolean', default: false },
    account: { type: 'string' }, gateway: { type: 'boolean' }, files: { type: 'boolean' }, dir: { type: 'string' },
  } },
} satisfies CliRouteConfig;
export const inputSchema = backendFlagsSchema.extend({
  target: z.string().min(1), from: z.string().min(1), to: z.string().min(1).optional(), topic: z.string().min(1).optional(),
  replyTo: z.string().min(1).optional(), message: z.array(z.string()).optional(), stdin: z.boolean().default(false),
}).strict().refine((v) => v.stdin !== Boolean(v.message?.length), 'Use one message or --stdin.');
export const resultSchema = z.record(z.string(), z.json());

export default async function send({ input }: CliRouteProps<typeof inputSchema>) {
  try {
    const body = input.stdin ? await readCommandStdin() : (input.message ?? []).join(' ');
    const packet = makePacket({ from: input.from, to: input.to ?? null, topic: input.topic ?? null, replyTo: input.replyTo ?? null, body });
    const backend = await openBackendFromInput(input);
    const result = await sendMailbox(backend, input.target, packet);
    const value = { ...result, exitCode: 0 };
    return <Agent.Result value={value}><Agent.Text>{JSON.stringify(value)}</Agent.Text></Agent.Result>;
  } catch (error) {
    const value = outcomeFromError(error);
    return <Agent.Result value={value}><Agent.Text>{value.error}</Agent.Text></Agent.Result>;
  }
}
