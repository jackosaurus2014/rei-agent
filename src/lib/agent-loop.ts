import Anthropic from '@anthropic-ai/sdk';
import { logger } from './logger';
import { withRetry } from './retry';
import { webSearch } from '../tools/web-search';
import { fetchPropertyData } from '../tools/property-data';
import { lookupPublicRecords, checkEnvironmental, type RecordType } from '../tools/public-records';

export type ToolName =
  | 'web_search'
  | 'fetch_property_data'
  | 'lookup_public_records'
  | 'check_environmental';

export interface AgentLoopOptions {
  model: string;
  systemPrompt: string;
  initialMessage: string;
  tools: Anthropic.Tool[];
  maxIterations?: number;
  agentLabel?: string;
}

/**
 * Core agentic tool-use loop.
 * Runs until the model returns stop_reason='end_turn' or maxIterations is exceeded.
 * Returns the final text response from the model.
 */
export async function runAgentLoop(
  client: Anthropic,
  options: AgentLoopOptions
): Promise<{ text: string; iterationsUsed: number; toolCallCount: number }> {
  const {
    model,
    systemPrompt,
    initialMessage,
    tools,
    maxIterations = Number(process.env.AGENT_MAX_ITERATIONS ?? 15),
    agentLabel = 'agent',
  } = options;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: initialMessage },
  ];

  let toolCallCount = 0;

  for (let i = 0; i < maxIterations; i++) {
    logger.debug(`${agentLabel} loop iteration ${i + 1}`, { model });

    const response = await withRetry(
      () =>
        client.messages.create({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          tools,
          messages,
        }),
      { label: `${agentLabel} messages.create` }
    );

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === 'text'
      );
      logger.debug(`${agentLabel} finished`, {
        iterations: i + 1,
        toolCalls: toolCallCount,
      });
      return {
        text: textBlock?.text ?? '',
        iterationsUsed: i + 1,
        toolCallCount,
      };
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUseBlocks.map(async (block) => {
          toolCallCount++;
          logger.debug(`${agentLabel} tool call`, { tool: block.name, input: block.input });

          let result: unknown;
          try {
            result = await executeTool(block.name as ToolName, block.input as Record<string, unknown>);
          } catch (err) {
            result = {
              error: true,
              message: err instanceof Error ? err.message : String(err),
            };
            logger.warn(`${agentLabel} tool error`, {
              tool: block.name,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          return {
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: JSON.stringify(result),
          };
        })
      );

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // stop_reason: 'max_tokens' or unexpected
    logger.warn(`${agentLabel} unexpected stop_reason`, {
      stop_reason: response.stop_reason,
      iteration: i + 1,
    });
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === 'text'
    );
    return {
      text: textBlock?.text ?? '',
      iterationsUsed: i + 1,
      toolCallCount,
    };
  }

  throw new Error(
    `${agentLabel} exceeded max iterations (${maxIterations}). Increase AGENT_MAX_ITERATIONS in .env if needed.`
  );
}

/**
 * Dispatches a tool call by name to the appropriate implementation.
 */
async function executeTool(
  name: ToolName,
  input: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case 'web_search':
      return webSearch(
        input.query as string,
        (input.max_results as number | undefined) ?? 5
      );

    case 'fetch_property_data':
      return fetchPropertyData(input.address as string);

    case 'lookup_public_records':
      return lookupPublicRecords(
        input.address as string,
        input.type as RecordType
      );

    case 'check_environmental':
      return checkEnvironmental(
        input.address as string,
        (input.radius_miles as number | undefined) ?? 0.5
      );

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
