import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { gbotConfigPath } from '../../core/gbot-config.js';

export const config = {
  description: 'Print the gbot config file path. The file is created only when a command writes it.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {},
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z.object({}).strict();
export const resultSchema = z.object({
  path: z.string(),
}).strict();

export default async function configPath(_props: CliRouteProps<typeof inputSchema>) {
  const path = gbotConfigPath();
  return (
    <Agent.Result value={{ path }}>
      <Agent.Text>{path}</Agent.Text>
    </Agent.Result>
  );
}
