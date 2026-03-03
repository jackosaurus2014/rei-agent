import { getAnthropicClient, MODELS } from '../../../lib/anthropic-client';
import { runAgentLoop } from '../../../lib/agent-loop';
import { extractSubAgentResult } from '../../../lib/extract-result';
import { logger } from '../../../lib/logger';
import { OWNER_INTEL_SYSTEM_PROMPT } from '../../../prompts/owner-intel-system';
import { WEB_SEARCH_TOOL } from '../../../tools/web-search';
import { FETCH_PROPERTY_DATA_TOOL } from '../../../tools/property-data';
import { LOOKUP_PUBLIC_RECORDS_TOOL } from '../../../tools/public-records';
import type { SubAgentResult } from '../../../types';

const TOOLS = [
  WEB_SEARCH_TOOL,
  FETCH_PROPERTY_DATA_TOOL,
  LOOKUP_PUBLIC_RECORDS_TOOL,
];

function buildInitialMessage(address: string): string {
  return `Research the ownership, title history, liens, and legal encumbrances for this property:

**Property Address**: ${address}

Please research:
1. Who is the current owner? (individual, LLC, trust, estate?)
2. Title history — when was it last sold, for how much?
3. If LLC-owned: state of formation, managing members, active status
4. Bankruptcy search for the owner or LLC
5. All liens: tax liens, mechanic's liens, judgment liens, HOA liens
6. Any lis pendens or notices of default

Use the web_search tool to find county assessor records, deed history, LLC filings, and court records.
Start with: "${address} property owner records"`;
}

export async function runOwnerIntelAgent(address: string): Promise<SubAgentResult> {
  logger.info('Owner Intel agent started', { address });

  const client = getAnthropicClient();

  // ── Phase 1: Research loop ─────────────────────────────────────────────────
  // Agent searches for ownership data, lien records, LLC filings, bankruptcies.
  // Runs until it has gathered enough data or hits maxIterations.

  const { text, toolCallCount } = await runAgentLoop(client, {
    model: MODELS.SUB_AGENT,
    systemPrompt: OWNER_INTEL_SYSTEM_PROMPT,
    initialMessage: buildInitialMessage(address),
    tools: TOOLS,
    agentLabel: 'owner-intel',
  });

  logger.info('Owner Intel research complete', { address, toolCallCount });

  // ── Phase 2: Structured extraction ────────────────────────────────────────
  // Convert the agent's free-form research text into a typed SubAgentResult.
  // Uses a single forced tool-use call to Haiku — cheap and fast.

  return extractSubAgentResult('owner_intel', address, text, toolCallCount);
}
