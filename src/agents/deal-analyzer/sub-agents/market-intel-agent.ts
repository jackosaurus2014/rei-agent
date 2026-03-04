import { getAnthropicClient, MODELS } from '../../../lib/anthropic-client';
import { runAgentLoop } from '../../../lib/agent-loop';
import { extractSubAgentResult } from '../../../lib/extract-result';
import { logger } from '../../../lib/logger';
import { MARKET_INTEL_SYSTEM_PROMPT } from '../../../prompts/market-intel-system';
import { WEB_SEARCH_TOOL } from '../../../tools/web-search';
import { FETCH_PROPERTY_DATA_TOOL } from '../../../tools/property-data';
import type { SubAgentResult } from '../../../types';

const TOOLS = [
  WEB_SEARCH_TOOL,
  FETCH_PROPERTY_DATA_TOOL,
];

function buildInitialMessage(address: string, purchasePrice: number): string {
  const fmt = (n: number) => `$${n.toLocaleString()}`;

  return `Analyze the submarket conditions for this property and evaluate whether the market supports the investment.

**Property Address**: ${address}
**Asking / Purchase Price**: ${fmt(purchasePrice)}

Please research:
1. Comparable sales — find 3–6 recent sales (last 12 months) of similar properties within 1 mile. Is ${fmt(purchasePrice)} justified by comps?
2. Current rental rates — what does a property like this rent for in this specific zip code / neighborhood?
3. Market cap rates — what are typical cap rates for this property type here?
4. Vacancy rates — what is the rental vacancy rate in this area vs. the metro average?
5. Submarket trend — is this area growing, stable, or declining?
6. Crime statistics for the zip code / neighborhood
7. School quality — GreatSchools ratings for schools serving this address
8. Rent growth over the last 3 years

Start with: "${address} comparable sales Zillow Redfin 2024 2025"`;
}

export async function runMarketIntelAgent(
  address: string,
  purchasePrice: number
): Promise<SubAgentResult> {
  logger.info('Market Intel agent started', { address, purchasePrice });

  const client = getAnthropicClient();

  // ── Phase 1: Research loop ─────────────────────────────────────────────────
  // Agent researches comps, rents, vacancy, trends, crime, and schools.

  const { text, toolCallCount } = await runAgentLoop(client, {
    model: MODELS.SUB_AGENT,
    systemPrompt: MARKET_INTEL_SYSTEM_PROMPT,
    initialMessage: buildInitialMessage(address, purchasePrice),
    tools: TOOLS,
    agentLabel: 'market-intel',
    maxTokensPerCall: 8192,  // prevent max_tokens truncation mid-research
  });

  logger.info('Market Intel research complete', { address, toolCallCount });

  // ── Phase 2: Structured extraction ────────────────────────────────────────

  return extractSubAgentResult('market_intel', address, text, toolCallCount);
}
