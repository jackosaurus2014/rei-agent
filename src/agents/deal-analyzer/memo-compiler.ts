import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient, MODELS } from '../../lib/anthropic-client';
import { withRetry } from '../../lib/retry';
import { logger } from '../../lib/logger';
import type { SubAgentResult, InvestmentMemo, Verdict } from '../../types';

export interface AllSubAgentResults {
  ownerIntel: SubAgentResult;
  marketIntel: SubAgentResult;
  publicRecords: SubAgentResult;
  underwriting: SubAgentResult;
  legalRisk: SubAgentResult;
}

// ── Structured verdict tool (forces Claude to return typed JSON) ─────────────

const VERDICT_TOOL: Anthropic.Tool = {
  name: 'generate_investment_verdict',
  description: 'Generate a structured investment verdict and recommendation based on all sub-agent findings.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['STRONG BUY', 'BUY', 'CONDITIONAL', 'PASS', 'IMMEDIATE PASS'],
        description: 'Overall investment verdict.',
      },
      keyReasons: {
        type: 'array',
        items: { type: 'string' },
        description: '3–5 concise bullet points explaining the verdict. Start each with a capital letter.',
      },
      riskFactors: {
        type: 'array',
        items: { type: 'string' },
        description: 'All material risks identified. Empty array if none.',
      },
      finalRecommendation: {
        type: 'string',
        description:
          '2–3 paragraph professional narrative recommendation. Explain the verdict rationale, ' +
          'key risks, and any conditions or next steps for due diligence.',
      },
    },
    required: ['verdict', 'keyReasons', 'riskFactors', 'finalRecommendation'],
  },
};

// ── System prompt for the synthesis step ────────────────────────────────────

function buildSynthesisPrompt(): string {
  return `You are a senior real estate acquisitions analyst synthesizing findings from a multi-agent due diligence team.

Your job is to review the findings from 5 specialized research agents and produce a clear, professional investment verdict.

Investment criteria (hard gates — any failure = PASS or IMMEDIATE PASS):
1. Cap rate must exceed current debt cost (use 7.5% as benchmark if not specified)
2. DSCR must be above 1.25 at 75% LTV, 30-year amortization
3. No unresolved title defects or contested ownership
4. No active litigation naming the property or owner as defendant
5. No Superfund sites or known environmental contamination on or near the property

Verdict definitions:
- STRONG BUY: All gates pass AND 3+ positive market/financial factors
- BUY: All gates pass, mixed but acceptable scoring factors
- CONDITIONAL: All gates pass but 1–2 soft concerns that need follow-up
- PASS: Any hard gate fails. Financials don't support the price.
- IMMEDIATE PASS: Critical red flag (fraud, contamination, title dispute, major litigation)

Be direct. Acquisitions teams don't need diplomatic hedging — they need clear verdicts backed by evidence.
When data is missing or uncertain, note it as a risk factor rather than assuming it's fine.`;
}

function buildSynthesisMessage(
  address: string,
  purchasePrice: number,
  results: AllSubAgentResults
): string {
  const fmt = (n: number) => `$${n.toLocaleString()}`;

  return `Please synthesize the following due diligence findings into an investment verdict.

PROPERTY: ${address}
PURCHASE PRICE: ${fmt(purchasePrice)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OWNER INTELLIGENCE (confidence: ${results.ownerIntel.confidence})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${results.ownerIntel.findings}

Red flags: ${results.ownerIntel.riskFlags.length === 0 ? 'None identified' : results.ownerIntel.riskFlags.join('; ')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MARKET INTELLIGENCE (confidence: ${results.marketIntel.confidence})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${results.marketIntel.findings}

Red flags: ${results.marketIntel.riskFlags.length === 0 ? 'None identified' : results.marketIntel.riskFlags.join('; ')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PUBLIC RECORDS (confidence: ${results.publicRecords.confidence})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${results.publicRecords.findings}

Red flags: ${results.publicRecords.riskFlags.length === 0 ? 'None identified' : results.publicRecords.riskFlags.join('; ')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UNDERWRITING (confidence: ${results.underwriting.confidence})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${results.underwriting.findings}

Red flags: ${results.underwriting.riskFlags.length === 0 ? 'None identified' : results.underwriting.riskFlags.join('; ')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEGAL RISK (confidence: ${results.legalRisk.confidence})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${results.legalRisk.findings}

Red flags: ${results.legalRisk.riskFlags.length === 0 ? 'None identified' : results.legalRisk.riskFlags.join('; ')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Now generate your investment verdict using the generate_investment_verdict tool.`;
}

// ── Underwriting table builder (from structured data) ───────────────────────

interface UnderwritingNumbers {
  estimatedMonthlyRent?: number;
  annualGrossRent?: number;
  noi?: number;
  capRate?: number;
  dscrAt65?: number;
  dscrAt70?: number;
  dscrAt75?: number;
  cashFlowAt65?: number;
  cashFlowAt70?: number;
  cashFlowAt75?: number;
  grm?: number;
  cashOnCashAt75?: number;
}

function buildUnderwritingTable(underwriting: SubAgentResult, purchasePrice: number): string {
  const d = (underwriting.data ?? {}) as UnderwritingNumbers;

  const fmt = (n: number | undefined, prefix = '$') =>
    n != null ? `${prefix}${Math.round(n).toLocaleString()}` : 'N/A';
  const fmtPct = (n: number | undefined) => (n != null ? `${n.toFixed(2)}%` : 'N/A');
  const fmtRatio = (n: number | undefined) => (n != null ? n.toFixed(2) : 'N/A');

  const assumedRate = Number(process.env.ASSUMED_RATE ?? 7.5);
  const minDscr = Number(process.env.MIN_DSCR ?? 1.25);

  const capRatePass =
    d.capRate != null
      ? d.capRate > assumedRate
        ? '✓'
        : '✗'
      : '?';

  const dscrPass =
    d.dscrAt75 != null
      ? d.dscrAt75 >= minDscr
        ? '✓'
        : '✗'
      : '?';

  const ltvRows = ([65, 70, 75] as const)
    .map((ltv) => {
      const dscr = d[`dscrAt${ltv}` as keyof UnderwritingNumbers] as number | undefined;
      const cf = d[`cashFlowAt${ltv}` as keyof UnderwritingNumbers] as number | undefined;
      const loan = purchasePrice * (ltv / 100);
      return `| ${ltv}% | ${fmt(loan)} | — | ${fmtRatio(dscr)} | ${fmt(cf)}/mo |`;
    })
    .join('\n');

  return `
## Underwriting Summary

| Metric | Value | Threshold | Pass? |
|---|---|---|---|
| Cap Rate | ${fmtPct(d.capRate)} | > ${assumedRate}% (debt cost) | ${capRatePass} |
| DSCR (75% LTV) | ${fmtRatio(d.dscrAt75)} | > ${minDscr} | ${dscrPass} |
| Cash-on-Cash (75%) | ${fmtPct(d.cashOnCashAt75)} | Advisory | — |
| Gross Rent Multiplier | ${d.grm != null ? d.grm.toFixed(1) : 'N/A'} | Advisory | — |
| Est. Monthly Rent | ${fmt(d.estimatedMonthlyRent)} | — | — |
| NOI (annual) | ${fmt(d.noi)} | — | — |

### Leverage Scenarios
| LTV | Loan Amount | Payment/mo | DSCR | Monthly CF |
|---|---|---|---|---|
${ltvRows}
`.trim();
}

// ── Markdown memo template ───────────────────────────────────────────────────

function buildMemoMarkdown(
  address: string,
  purchasePrice: number,
  verdict: Verdict,
  keyReasons: string[],
  riskFactors: string[],
  results: AllSubAgentResults,
  finalRecommendation: string
): string {
  const date = new Date().toISOString().slice(0, 10);
  const fmt = (n: number) => `$${n.toLocaleString()}`;
  const emojiVerdict: Record<Verdict, string> = {
    'STRONG BUY': '🟢',
    'BUY': '🟢',
    'CONDITIONAL': '🟡',
    'PASS': '🔴',
    'IMMEDIATE PASS': '🔴',
  };

  const reasonsStr = keyReasons.map(r => `- ${r}`).join('\n');
  const risksStr = riskFactors.length > 0
    ? riskFactors.map(r => `- ${r}`).join('\n')
    : '- None identified';

  const allFlags = [
    ...results.ownerIntel.riskFlags,
    ...results.marketIntel.riskFlags,
    ...results.publicRecords.riskFlags,
    ...results.underwriting.riskFlags,
    ...results.legalRisk.riskFlags,
  ];
  const flagsSummary = allFlags.length > 0
    ? allFlags.map(f => `- ⚠️ ${f}`).join('\n')
    : '- None';

  return `# Investment Analysis: ${address}

**Date**: ${date}
**Purchase Price**: ${fmt(purchasePrice)}
**Generated by**: REI Agent System v1.0

---

## ${emojiVerdict[verdict]} VERDICT: ${verdict}

### Key Reasons
${reasonsStr}

### Risk Factors
${risksStr}

---

${buildUnderwritingTable(results.underwriting, purchasePrice)}

---

## Owner Intelligence
*Confidence: ${results.ownerIntel.confidence} | Searches: ${results.ownerIntel.searchesPerformed}*

${results.ownerIntel.findings}

**Red Flags**: ${results.ownerIntel.riskFlags.length === 0 ? 'None identified' : results.ownerIntel.riskFlags.map(f => `\n- ${f}`).join('')}

---

## Market Intelligence
*Confidence: ${results.marketIntel.confidence} | Searches: ${results.marketIntel.searchesPerformed}*

${results.marketIntel.findings}

**Red Flags**: ${results.marketIntel.riskFlags.length === 0 ? 'None identified' : results.marketIntel.riskFlags.map(f => `\n- ${f}`).join('')}

---

## Public Records
*Confidence: ${results.publicRecords.confidence} | Searches: ${results.publicRecords.searchesPerformed}*

${results.publicRecords.findings}

**Red Flags**: ${results.publicRecords.riskFlags.length === 0 ? 'None identified' : results.publicRecords.riskFlags.map(f => `\n- ${f}`).join('')}

---

## Underwriting Detail
*Confidence: ${results.underwriting.confidence} | Searches: ${results.underwriting.searchesPerformed}*

${results.underwriting.findings}

---

## Legal Risk Assessment
*Confidence: ${results.legalRisk.confidence} | Searches: ${results.legalRisk.searchesPerformed}*

${results.legalRisk.findings}

**Red Flags**: ${results.legalRisk.riskFlags.length === 0 ? 'None identified' : results.legalRisk.riskFlags.map(f => `\n- ${f}`).join('')}

---

## All Red Flags (Summary)

${flagsSummary}

---

## Final Recommendation

${finalRecommendation}

---

*Generated by REI Agent System. This is not financial advice.*
*Verify all data independently before making investment decisions.*
*Analysis date: ${date}*
`;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function compileMemo(
  results: AllSubAgentResults,
  address: string,
  purchasePrice: number
): Promise<InvestmentMemo> {
  logger.info('Compiling investment memo', { address });

  const client = getAnthropicClient();

  // Single Claude call with forced tool use to get structured verdict
  const response = await withRetry(
    () =>
      client.messages.create({
        model: MODELS.MANAGER,
        max_tokens: 2048,
        system: buildSynthesisPrompt(),
        tools: [VERDICT_TOOL],
        tool_choice: { type: 'tool', name: 'generate_investment_verdict' },
        messages: [
          {
            role: 'user',
            content: buildSynthesisMessage(address, purchasePrice, results),
          },
        ],
      }),
    { label: 'memo-compiler synthesis' }
  );

  // Extract the structured tool call result
  const toolUseBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
  );

  if (!toolUseBlock) {
    throw new Error('Memo compiler: Claude did not return a tool_use block as expected.');
  }

  const { verdict, keyReasons, riskFactors, finalRecommendation } =
    toolUseBlock.input as {
      verdict: Verdict;
      keyReasons: string[];
      riskFactors: string[];
      finalRecommendation: string;
    };

  logger.info('Verdict determined', { verdict, address });

  const rawMarkdown = buildMemoMarkdown(
    address,
    purchasePrice,
    verdict,
    keyReasons,
    riskFactors,
    results,
    finalRecommendation
  );

  return {
    address,
    date: new Date().toISOString().slice(0, 10),
    purchasePrice,
    verdict,
    keyReasons,
    riskFactors,
    ownerIntel: results.ownerIntel,
    marketIntel: results.marketIntel,
    publicRecords: results.publicRecords,
    underwriting: results.underwriting,
    legalRisk: results.legalRisk,
    finalRecommendation,
    rawMarkdown,
  };
}
