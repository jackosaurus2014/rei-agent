import { logger } from '../../lib/logger';
import { writeDealMemo } from '../../lib/output-writer';
import { compileMemo } from './memo-compiler';
import { runOwnerIntelAgent } from './sub-agents/owner-intel-agent';
import { runMarketIntelAgent } from './sub-agents/market-intel-agent';
import { runPublicRecordsAgent } from './sub-agents/public-records-agent';
import { runUnderwritingAgent } from './sub-agents/underwriting-agent';
import { runLegalRiskAgent } from './sub-agents/legal-risk-agent';
import type { DealInput, SubAgentResult, SubAgentCategory } from '../../types';

// ── Fallback result when a sub-agent fails ───────────────────────────────────

function cleanErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Strip raw JSON API error bodies — only keep the human-readable message field
  try {
    const match = raw.match(/"message":"([^"]+)"/);
    if (match) return match[1];
  } catch {
    // ignore parse errors
  }
  // Truncate at first newline or JSON brace to avoid dumping stack/JSON into memo
  return raw.split(/[\n{]/)[0].trim();
}

function failedSubAgentResult(category: SubAgentCategory, error: unknown): SubAgentResult {
  const message = cleanErrorMessage(error);
  return {
    category,
    findings: `**Unable to retrieve data** — ${message}\n\nManual verification required for this section.`,
    riskFlags: ['Data retrieval failed — manual verification required'],
    confidence: 'low',
    searchesPerformed: 0,
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function runDealAnalyzer(input: DealInput): Promise<void> {
  const { address, purchasePrice, propertyType } = input;

  logger.info('Deal Analyzer started', { address, purchasePrice, propertyType });
  const startTime = Date.now();

  // ── Step 1: Run 5 sub-agents sequentially ────────────────────────────────
  // TODO: Switch back to Promise.all() parallel execution once the account
  // reaches Anthropic API Tier 2 ($40 cumulative spend → 80K tokens/min).
  // Sequential is ~8-10 min/analysis vs ~2-3 min parallel, but avoids 429s
  // on Tier 1 (50K tokens/min) when multiple agents run simultaneously.
  //
  // Each agent is wrapped in try/catch so a failure doesn't abort the full
  // analysis — failed agents return a structured fallback result.

  logger.info('Running 5 sub-agents sequentially...', { address });

  const ownerIntel = await runOwnerIntelAgent(address).catch((err) => {
    logger.error('Owner Intel agent failed', { error: err.message });
    return failedSubAgentResult('owner_intel', err);
  });

  const marketIntel = await runMarketIntelAgent(address, purchasePrice).catch((err) => {
    logger.error('Market Intel agent failed', { error: err.message });
    return failedSubAgentResult('market_intel', err);
  });

  const publicRecords = await runPublicRecordsAgent(address).catch((err) => {
    logger.error('Public Records agent failed', { error: err.message });
    return failedSubAgentResult('public_records', err);
  });

  const underwriting = await runUnderwritingAgent(address, purchasePrice, propertyType).catch((err) => {
    logger.error('Underwriting agent failed', { error: err.message });
    return failedSubAgentResult('underwriting', err);
  });

  const legalRisk = await runLegalRiskAgent(address).catch((err) => {
    logger.error('Legal Risk agent failed', { error: err.message });
    return failedSubAgentResult('legal_risk', err);
  });

  const subAgentTime = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`All sub-agents completed in ${subAgentTime}s`, {
    ownerIntel: ownerIntel.confidence,
    marketIntel: marketIntel.confidence,
    publicRecords: publicRecords.confidence,
    underwriting: underwriting.confidence,
    legalRisk: legalRisk.confidence,
  });

  // Log any red flags found
  const allFlags = [
    ...ownerIntel.riskFlags,
    ...marketIntel.riskFlags,
    ...publicRecords.riskFlags,
    ...underwriting.riskFlags,
    ...legalRisk.riskFlags,
  ];
  if (allFlags.length > 0) {
    logger.warn(`${allFlags.length} red flag(s) identified`, { flags: allFlags });
  }

  // ── Step 2: Compile investment memo ───────────────────────────────────────

  logger.info('Synthesizing investment memo...', { address });

  const memo = await compileMemo(
    { ownerIntel, marketIntel, publicRecords, underwriting, legalRisk },
    address,
    purchasePrice
  );

  // ── Step 3: Write output file ─────────────────────────────────────────────

  const outputPath = writeDealMemo(memo.rawMarkdown, address);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  // ── Step 4: Print summary to terminal ─────────────────────────────────────

  printSummary(memo.verdict, address, purchasePrice, allFlags, outputPath, totalTime);
}

// ── Terminal summary ─────────────────────────────────────────────────────────

function printSummary(
  verdict: string,
  address: string,
  purchasePrice: number,
  flags: string[],
  outputPath: string,
  totalTime: string
): void {
  const COLORS: Record<string, string> = {
    'STRONG BUY': '\x1b[32m',  // green
    'BUY': '\x1b[32m',          // green
    'CONDITIONAL': '\x1b[33m',  // yellow
    'PASS': '\x1b[31m',         // red
    'IMMEDIATE PASS': '\x1b[31m', // red
  };
  const RESET = '\x1b[0m';
  const BOLD = '\x1b[1m';
  const color = COLORS[verdict] ?? '';

  process.stdout.write(`
${BOLD}══════════════════════════════════════════════════════${RESET}
${BOLD}  DEAL ANALYSIS COMPLETE${RESET}
${BOLD}══════════════════════════════════════════════════════${RESET}

  Property:  ${address}
  Price:     $${purchasePrice.toLocaleString()}
  Time:      ${totalTime}s

  ${BOLD}VERDICT: ${color}${verdict}${RESET}

${flags.length > 0 ? `  Red Flags (${flags.length}):\n${flags.map(f => `    ⚠️  ${f}`).join('\n')}\n` : '  Red Flags: None\n'}
  Output:    ${outputPath}

${BOLD}══════════════════════════════════════════════════════${RESET}
`);
}
