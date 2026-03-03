import { getAnthropicClient, MODELS } from '../../../lib/anthropic-client';
import { runAgentLoop } from '../../../lib/agent-loop';
import { extractSubAgentResult } from '../../../lib/extract-result';
import { logger } from '../../../lib/logger';
import { PUBLIC_RECORDS_SYSTEM_PROMPT } from '../../../prompts/public-records-system';
import { WEB_SEARCH_TOOL } from '../../../tools/web-search';
import { LOOKUP_PUBLIC_RECORDS_TOOL, CHECK_ENVIRONMENTAL_TOOL } from '../../../tools/public-records';
import type { SubAgentResult } from '../../../types';

// Public Records is the most tool-rich sub-agent:
// - web_search for city portals, assessor sites, code enforcement, flood maps
// - lookup_public_records for structured zoning/permit/tax queries
// - check_environmental for the real-time EPA ECHO API call
const TOOLS = [
  WEB_SEARCH_TOOL,
  LOOKUP_PUBLIC_RECORDS_TOOL,
  CHECK_ENVIRONMENTAL_TOOL,
];

function buildInitialMessage(address: string): string {
  return `Research the public records for this property. I need a complete picture of its legal status, compliance, and any outstanding issues.

**Property Address**: ${address}

Please research all of the following:
1. **Zoning** — current classification and whether the current use is conforming
2. **Permits** — full permit history; any open, expired, or unpermitted work?
3. **Code violations** — any open enforcement cases?
4. **Property taxes** — assessed value, annual tax, any delinquencies?
5. **Flood zone** — FEMA designation (Zone X = safe, Zone AE/A/VE = mandatory flood insurance)
6. **HOA** — is there an HOA? Are dues current? Does it permit rentals?
7. **Certificate of occupancy** — valid C/O for all structures and units?
8. **Environmental** — use the check_environmental tool for EPA-regulated sites nearby

Start with the lookup_public_records tool for zoning, then permits, then web search for the rest.
Also run check_environmental for "${address}".`;
}

export async function runPublicRecordsAgent(address: string): Promise<SubAgentResult> {
  logger.info('Public Records agent started', { address });

  const client = getAnthropicClient();

  // ── Phase 1: Research loop ─────────────────────────────────────────────────
  // Agent checks zoning, permits, taxes, flood zone, HOA, code violations.
  // Also triggers the real EPA ECHO API call via check_environmental tool.

  const { text, toolCallCount } = await runAgentLoop(client, {
    model: MODELS.SUB_AGENT,
    systemPrompt: PUBLIC_RECORDS_SYSTEM_PROMPT,
    initialMessage: buildInitialMessage(address),
    tools: TOOLS,
    agentLabel: 'public-records',
  });

  logger.info('Public Records research complete', { address, toolCallCount });

  // ── Phase 2: Structured extraction ────────────────────────────────────────

  return extractSubAgentResult('public_records', address, text, toolCallCount);
}
