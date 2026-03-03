import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient, MODELS } from '../../../lib/anthropic-client';
import { runAgentLoop } from '../../../lib/agent-loop';
import { withRetry } from '../../../lib/retry';
import { logger } from '../../../lib/logger';
import { UNDERWRITING_SYSTEM_PROMPT } from '../../../prompts/underwriting-system';
import { WEB_SEARCH_TOOL } from '../../../tools/web-search';
import {
  computeUnderwriting,
  buildUnderwritingFindings,
  buildUnderwritingRiskFlags,
} from '../../../lib/underwriting-calculator';
import type { SubAgentResult } from '../../../types';

// ── Rent extraction tool ──────────────────────────────────────────────────────
// Forced tool call that extracts a numeric rent estimate from research text.
// The LLM returns the number; TypeScript does all the math from there.

const RENT_ESTIMATE_TOOL: Anthropic.Tool = {
  name: 'submit_rent_estimate',
  description: 'Submit the estimated monthly rent based on your rental market research.',
  input_schema: {
    type: 'object',
    properties: {
      monthlyRentEstimate: {
        type: 'number',
        description: 'Best single estimate of monthly rent in dollars (e.g. 1850).',
      },
      rentRangeLow: {
        type: 'number',
        description: 'Conservative (low end) monthly rent estimate in dollars.',
      },
      rentRangeHigh: {
        type: 'number',
        description: 'Optimistic (high end) monthly rent estimate in dollars.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          'high = 3+ comparable rentals found; medium = 1–2 comps or metro-level data; low = limited local data.',
      },
      marketContext: {
        type: 'string',
        description:
          'Brief 2–3 sentence summary of the rental market findings: what comps were found, ' +
          'what sources were used, and any relevant rent trend context.',
      },
    },
    required: [
      'monthlyRentEstimate',
      'rentRangeLow',
      'rentRangeHigh',
      'confidence',
      'marketContext',
    ],
  },
};

interface RentEstimate {
  monthlyRentEstimate: number;
  rentRangeLow: number;
  rentRangeHigh: number;
  confidence: 'high' | 'medium' | 'low';
  marketContext: string;
}

// ── Rent extraction ───────────────────────────────────────────────────────────

async function extractRentEstimate(
  client: Anthropic,
  address: string,
  purchasePrice: number,
  researchText: string
): Promise<RentEstimate> {
  const response = await withRetry(
    () =>
      client.messages.create({
        model: MODELS.SUB_AGENT,
        max_tokens: 1024,
        system:
          `You are extracting a rental rate estimate from research notes. ` +
          `The property is at: ${address} (asking price: $${purchasePrice.toLocaleString()}). ` +
          `Review the research and call submit_rent_estimate with your best rent estimate.`,
        tools: [RENT_ESTIMATE_TOOL],
        tool_choice: { type: 'tool', name: 'submit_rent_estimate' },
        messages: [{ role: 'user', content: `Research notes:\n\n${researchText}` }],
      }),
    { label: 'extract-rent-estimate' }
  );

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
  );

  if (!toolBlock) {
    logger.warn('Rent extraction: no tool_use block, using conservative fallback');
    // Conservative fallback: use 0.7% of purchase price as monthly rent estimate
    // (below the 1% rule, intentionally conservative)
    const fallback = Math.round(purchasePrice * 0.007);
    return {
      monthlyRentEstimate: fallback,
      rentRangeLow: Math.round(fallback * 0.9),
      rentRangeHigh: Math.round(fallback * 1.1),
      confidence: 'low',
      marketContext: 'Rental data unavailable — estimate based on 0.7% of purchase price. Manual verification required.',
    };
  }

  return toolBlock.input as RentEstimate;
}

// ── Initial message ───────────────────────────────────────────────────────────

function buildInitialMessage(address: string, purchasePrice: number): string {
  return `Find the current market rent for this property:

**Property Address**: ${address}
**Purchase Price**: $${purchasePrice.toLocaleString()}

I need to know: what will this property rent for on the open market today?

Search for:
1. Active rental listings in the same zip code and neighborhood for similar properties
2. Recently rented comparables
3. Market rent estimates from Zillow, Redfin, or rental data providers

Start with: "${address} for rent" and then "[zip code] [beds] bedroom for rent 2025"`;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runUnderwritingAgent(
  address: string,
  purchasePrice: number
): Promise<SubAgentResult> {
  logger.info('Underwriting agent started', { address, purchasePrice });

  const client = getAnthropicClient();

  // ── Phase 1: Research loop — find market rent ─────────────────────────────

  const { text, toolCallCount } = await runAgentLoop(client, {
    model: MODELS.SUB_AGENT,
    systemPrompt: UNDERWRITING_SYSTEM_PROMPT,
    initialMessage: buildInitialMessage(address, purchasePrice),
    tools: [WEB_SEARCH_TOOL],
    agentLabel: 'underwriting',
  });

  logger.info('Underwriting rent research complete', { address, toolCallCount });

  // ── Phase 2: Extract numeric rent estimate ────────────────────────────────

  const rentEstimate = await extractRentEstimate(client, address, purchasePrice, text);

  logger.info('Rent estimate extracted', {
    address,
    rent: rentEstimate.monthlyRentEstimate,
    confidence: rentEstimate.confidence,
  });

  // ── Phase 3: Compute all financial metrics in TypeScript ──────────────────
  // No LLM arithmetic — exact numbers every time.

  const annualRate = Number(process.env.ASSUMED_RATE ?? 7.5) / 100;
  const expenseRatio = Number(process.env.EXPENSE_RATIO ?? 0.40);

  const results = computeUnderwriting({
    purchasePrice,
    monthlyRent: rentEstimate.monthlyRentEstimate,
    annualRate,
    expenseRatio,
    vacancyRate: 0.08,
    amortizationYears: 30,
  });

  logger.info('Underwriting computed', {
    capRate: results.capRate,
    dscrAt75: results.scenarios.ltv75.dscr,
    capRatePass: results.capRatePassesGate,
    dscrPass: results.dscrPassesGate,
  });

  // ── Phase 4: Build SubAgentResult ─────────────────────────────────────────

  const findings = buildUnderwritingFindings(results, rentEstimate.marketContext, {
    low: rentEstimate.rentRangeLow,
    high: rentEstimate.rentRangeHigh,
  });

  const riskFlags = buildUnderwritingRiskFlags(results);

  return {
    category: 'underwriting',
    findings,
    riskFlags,
    confidence: rentEstimate.confidence,
    searchesPerformed: toolCallCount,
    data: {
      // These field names match the UnderwritingNumbers interface in memo-compiler.ts
      estimatedMonthlyRent: results.estimatedMonthlyRent,
      annualGrossRent: results.annualGrossRent,
      noi: results.noi,
      capRate: results.capRate,
      dscrAt65: results.scenarios.ltv65.dscr,
      dscrAt70: results.scenarios.ltv70.dscr,
      dscrAt75: results.scenarios.ltv75.dscr,
      cashFlowAt65: results.scenarios.ltv65.monthlyCashFlow,
      cashFlowAt70: results.scenarios.ltv70.monthlyCashFlow,
      cashFlowAt75: results.scenarios.ltv75.monthlyCashFlow,
      grm: results.grm,
      cashOnCashAt75: results.scenarios.ltv75.cashOnCash,
    },
  };
}
