import { getAnthropicClient, MODELS } from '../../../lib/anthropic-client';
import { runAgentLoop } from '../../../lib/agent-loop';
import { extractSubAgentResult } from '../../../lib/extract-result';
import { logger } from '../../../lib/logger';
import { LEGAL_RISK_SYSTEM_PROMPT } from '../../../prompts/legal-risk-system';
import { WEB_SEARCH_TOOL } from '../../../tools/web-search';
import { LOOKUP_PUBLIC_RECORDS_TOOL } from '../../../tools/public-records';
import type { SubAgentResult } from '../../../types';

const TOOLS = [
  WEB_SEARCH_TOOL,
  LOOKUP_PUBLIC_RECORDS_TOOL,
];

function buildInitialMessage(address: string): string {
  return `Research the legal risks for this property. I need to know about any active litigation, tenant disputes, criminal history, environmental liability, and regulatory exposure.

**Property Address**: ${address}

Please research all of the following:
1. **Active litigation** — search court records for lawsuits naming this property address or its owner
2. **Landlord-tenant history** — eviction filings, habitability complaints, fair housing issues
3. **Criminal activity** — any drug lab, violent crime, or condemnation history at this address
4. **Environmental indicators** — prior commercial/industrial use, underground storage tanks, contamination records
5. **Insurance/casualty history** — fire, flood, or structural damage incidents
6. **Regulatory compliance** — rental licensing requirements, rent control applicability
7. **Easements and title risks** — any easements that materially impair use

Start with: "${address} lawsuit court records" and "${address} owner litigation [state]"

When a search returns no results for a risk category, state that clearly — "no active litigation found" is a positive finding.`;
}

export async function runLegalRiskAgent(address: string): Promise<SubAgentResult> {
  logger.info('Legal Risk agent started', { address });

  const client = getAnthropicClient();

  // ── Phase 1: Research loop ─────────────────────────────────────────────────
  // Agent searches court records, criminal history, environmental indicators,
  // casualty history, and regulatory compliance records.

  const { text, toolCallCount } = await runAgentLoop(client, {
    model: MODELS.SUB_AGENT,
    systemPrompt: LEGAL_RISK_SYSTEM_PROMPT,
    initialMessage: buildInitialMessage(address),
    tools: TOOLS,
    agentLabel: 'legal-risk',
  });

  logger.info('Legal Risk research complete', { address, toolCallCount });

  // ── Phase 2: Structured extraction ────────────────────────────────────────

  return extractSubAgentResult('legal_risk', address, text, toolCallCount);
}
