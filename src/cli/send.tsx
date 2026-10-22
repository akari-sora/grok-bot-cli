import { Agent, agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import {
  grokSendOperation,
  assertManagedSendOptions,
  routeFields,
  relayResultSchema,
} from '../core/relay/routes.js';
import { buildEnvelope, withEnvelopeHeader } from '../core/codex-bridge.js';
import { outcomeFromError } from '../core/codex/contract.js';
import { saveHistory } from '../core/history.js';
import { readCommandStdin } from '../core/stdin-message.js';
import { StoreError } from '../core/store.js';
import {
  backendFlagsSchema,
  failureDocumentSchema,
  openBackendFromInput,
} from './_shared.js';

export const config = {
  description: 'Send a message to a Grok Bot bot or group by name or id.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      replyMode: { type: 'string', enum: ['auto', 'manual'] },
      codexThreadId: { type: 'string' },
      bindingId: { type: 'string' },
      expectedCwd: { type: 'string' },
      requestId: { type: 'string' },
      correlationId: {
        description: 'Stable correlation id for multi-hop replies',
        type: 'string',
      },
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      envelope: { description: 'Prepend the [gbot …] header', type: 'boolean' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      account: { description: 'Saved Grok Bot login. Uses --account, then GBOT_ACCOUNT, then the config default, then the descriptor single or active entry', type: 'string' },
      historyDir: {
        description: 'Directory containing history.jsonl',
        type: 'string',
      },
      hop: {
        description: 'Hop count; refused at GROK_BOT_MAX_HOPS',
        type: 'number',
      },
      message: { items: { type: 'string' }, type: 'array' },
      stdin: {
        default: false,
        description: 'Read the message from stdin instead of the process arguments',
        type: 'boolean',
      },
      noHistory: {
        description: 'Skip local history for this command',
        type: 'boolean',
      },
      replyTo: {
        description: 'Prior message id this send replies to',
        type: 'string',
      },
      target: { type: 'string' },
    },
    required: ['target'],
    type: 'object',
  },
  positionals: ['target', 'message'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema
  .extend({
    ...routeFields,
    replyMode: z.enum(['auto', 'manual']).optional(),
    correlationId: z.string().min(1).optional(),
    envelope: z.boolean().default(false),
    historyDir: z.string().min(1).optional(),
    hop: z.number().int().min(0).optional(),
    message: z.array(z.string()).optional(),
    noHistory: z.boolean().default(false),
    replyTo: z.string().min(1).optional(),
    stdin: z.boolean().default(false),
    target: z.string().min(1),
  })
  .strict()
  .refine(
    (input) => !(input.stdin && (input.message?.length ?? 0) > 0),
    '--stdin cannot be combined with a positional message.',
  )
  .refine(
    (input) => input.stdin || (input.message?.length ?? 0) > 0,
    'gbot send <bot-or-group> <message> or --stdin',
  );

const receiptSchema = z
  .object({
    clientNonce: z.string().min(1).optional(),
    correlationId: z.string(),
    delivery: z.enum(['accepted', 'unknown']),
    envelopeId: z.string(),
    exitCode: z.literal(0),
    hop: z.number().int().min(0),
    id: z.string(),
    kind: z.enum(['bot', 'group']),
    maxHops: z.number().int().min(0),
    messageId: z.string().optional(),
    name: z.string(),
    replyTo: z.string().optional(),
    result: z.record(z.string(), z.json()),
  })
  .strict();

// Refusals and gateway failures are the same flat document `codex send` emits.
export const resultSchema = z.union([
  receiptSchema,
  failureDocumentSchema,
  relayResultSchema,
]);

const messageFromInput = async (
  input: { stdin?: boolean; message?: string[] },
): Promise<string> => {
  const parts = input.message ?? [];
  if (input.stdin && parts.length > 0) {
    throw new StoreError('--stdin cannot be combined with a positional message.');
  }
  if (input.stdin) return readCommandStdin();
  if (parts.length === 0) throw new StoreError('gbot send <bot-or-group> <message> or --stdin');
  return parts.join(' ').trim();
};

const deliver = async (
  input: z.infer<typeof inputSchema>,
  message: string,
): Promise<z.infer<typeof receiptSchema>> => {
  const envelope = buildEnvelope({
    correlationId: input.correlationId,
    envelope: input.envelope,
    hop: input.hop,
    replyTo: input.replyTo,
  });
  const backend = await openBackendFromInput(input);
  const out = await backend.send(
    input.target,
    withEnvelopeHeader(message, envelope),
  );
  saveHistory(out, {
    dir: input.historyDir,
    disabled: input.noHistory,
    event: 'send',
    prompt: message,
  });
  return {
    id: out.target.id,
    name: out.target.name,
    kind: out.target.isGroup ? ('group' as const) : ('bot' as const),
    result: out.result,
    delivery:
      out.delivery === 'accepted'
        ? ('accepted' as const)
        : ('unknown' as const),
    ...(typeof out.messageId === 'string' ? { messageId: out.messageId } : {}),
    ...(typeof out.clientNonce === 'string' ? { clientNonce: out.clientNonce } : {}),
    envelopeId: envelope.messageId,
    correlationId: envelope.correlationId,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    hop: envelope.hop,
    maxHops: envelope.maxHops,
    exitCode: 0 as const,
  };
};

export default async function send({
  input,
}: CliRouteProps<typeof inputSchema>) {
  let value:
    z.infer<typeof receiptSchema> | z.infer<typeof failureDocumentSchema>;
  try {
    const message = await messageFromInput(input);
    if (input.replyMode === 'auto' || input.codexThreadId || input.bindingId) {
      assertManagedSendOptions(input);
      if (input.files)
        throw Error('Automatic routes require the gateway backend');
      const out = await grokSendOperation(
        {
          target: input.target,
          message,
          replyMode: input.replyMode ?? 'auto',
          codexThreadId: input.codexThreadId,
          bindingId: input.bindingId,
          expectedCwd: input.expectedCwd,
          requestId: input.requestId,
          hop: input.hop,
          correlationId: input.correlationId,
        },
        await agent(),
      );
      return (
        <Agent.Result
          value={{ ...out, exitCode: out.delivery === 'rejected' ? 1 : 0 }}
        >
          <Agent.Text>{`Delivery ${out.delivery}; inspect codex bridge status for automatic reply delivery.`}</Agent.Text>
        </Agent.Result>
      );
    }
    value = await deliver(input, message);
  } catch (error) {
    value = outcomeFromError(error);
  }
  const nonce = typeof value.clientNonce === 'string' && value.clientNonce.length > 0
    ? value.clientNonce
    : undefined;
  const shownTarget = /[\s"]/.test(input.target) ? JSON.stringify(input.target) : input.target;
  const hint = nonce ? ` Confirm with gbot reconcile ${shownTarget} --nonce ${nonce}` : '';
  const text = value.exitCode === 0
    ? (value.delivery === 'unknown' && nonce
      ? `Sent to ${value.kind} ${value.name} (${value.id}); delivery unknown; nonce ${nonce}.${hint}`
      : `Sent to ${value.kind} ${value.name} (${value.id})${value.messageId ? ` message ${value.messageId}` : ''}; envelope ${value.envelopeId}`)
    : (value.delivery === 'unknown' && nonce
      ? `${value.error}\nnonce ${nonce}.${hint}`
      : value.error);
  return (
    <Agent.Result value={value}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
