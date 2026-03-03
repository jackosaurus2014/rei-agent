import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient, MODELS } from './anthropic-client';
import { withRetry } from './retry';
import { logger } from './logger';
import type { SubAgentResult, SubAgentCategory, Confidence } from '../types';

// ── Extraction tool (forces structured JSON output from research text) ────────

const SUBMIT_FINDINGS_TOOL: Anthropic.Tool = {
  name: 'submit_findings',
  description:
    'Submit structured findings after completing research. ' +
    'Call this once when your research is complete.',
  input_schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'string',
        description:
          'Complete research findings written as professional markdown prose. ' +
          'Include all relevant facts, data points, and observations. ' +
          'Use headers, bullet points, and bold text for clarity.',
      },
      riskFlags: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Specific red flags or concerns that could affect the investment. ' +
          'Each flag should be a concise, actionable statement (e.g., "Active mechanic lien: $18,500 filed 2024-01-15"). ' +
          'Use an empty array if no red flags were found.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          'How confident you are in the completeness and accuracy of the findings. ' +
          'high = found strong primary sources; medium = some data gaps; low = limited data available.',
      },
    },
    required: ['findings', 'riskFlags', 'confidence'],
  },
};

// ── Extraction prompt ─────────────────────────────────────────────────────────

function buildExtractionPrompt(category: SubAgentCategory, address: string): string {
  const categoryLabels: Record<SubAgentCategory, string> = {
    owner_intel: 'ownership, title, liens, and legal encumbrances',
    market_intel: 'submarket conditions, comparables, and rental market data',
    public_records: 'zoning, permits, property history, and code compliance',
    underwriting: 'financial analysis including cap rate, DSCR, and cash flow',
    legal_risk: 'litigation, environmental issues, and legal compliance',
  };

  return (
    `You are extracting structured findings from real estate research. ` +
    `The research covers ${categoryLabels[category]} for the property at: ${address}\n\n` +
    `Review the research notes below and call submit_findings with:\n` +
    `- findings: Clean, professional markdown narrative of what was found\n` +
    `- riskFlags: Any specific red flags that could affect the investment (empty array if none)\n` +
    `- confidence: Your confidence in the completeness of the data\n\n` +
    `Be precise with red flags — only flag things that are concrete concerns, ` +
    `not hypothetical risks. If data was unavailable, note it in findings but ` +
    `do not list "data unavailable" as a risk flag.`
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Takes raw research text from the agent loop and extracts a typed SubAgentResult
 * using a single forced tool-use call to Claude Haiku.
 *
 * All 5 sub-agents share this utility — it keeps the extraction logic DRY
 * and ensures consistent SubAgentResult structure across all agents.
 */
export async function extractSubAgentResult(
  category: SubAgentCategory,
  address: string,
  researchText: string,
  toolCallCount: number
): Promise<SubAgentResult> {
  logger.debug(`Extracting structured result for ${category}`, { address });

  const client = getAnthropicClient();

  const response = await withRetry(
    () =>
      client.messages.create({
        model: MODELS.SUB_AGENT,
        max_tokens: 2048,
        system: buildExtractionPrompt(category, address),
        tools: [SUBMIT_FINDINGS_TOOL],
        tool_choice: { type: 'tool', name: 'submit_findings' },
        messages: [
          {
            role: 'user',
            content: `Here are the research notes:\n\n${researchText}`,
          },
        ],
      }),
    { label: `extract-result(${category})` }
  );

  const toolUseBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
  );

  if (!toolUseBlock) {
    // Fallback if extraction call fails unexpectedly
    logger.warn(`extract-result: no tool_use block returned for ${category}`);
    return {
      category,
      findings: researchText || 'No findings available.',
      riskFlags: [],
      confidence: 'low',
      searchesPerformed: toolCallCount,
    };
  }

  const { findings, riskFlags, confidence } = toolUseBlock.input as {
    findings: string;
    riskFlags: string[] | null | undefined;
    confidence: Confidence;
  };

  // Guard against the model returning null/undefined for array fields despite
  // the schema marking them as required — observed in production with Haiku.
  const safeRiskFlags = Array.isArray(riskFlags) ? riskFlags : [];

  logger.debug(`Extraction complete for ${category}`, {
    riskFlagCount: safeRiskFlags.length,
    confidence,
  });

  return {
    category,
    findings: findings ?? 'No findings available.',
    riskFlags: safeRiskFlags,
    confidence: confidence ?? 'low',
    searchesPerformed: toolCallCount,
  };
}
