# REI Agent System — Design Document

**Version**: 1.0.0
**Created**: 2026-03-02
**Stack**: TypeScript + Node.js + Anthropic SDK + Tavily

---

## Purpose

An AI-powered real estate investment analysis system that operates as three
coordinated CLI agents:

1. **Market Research Agent** — Identifies and ranks the top 25 US cities for
   SFR/multifamily investment over a 3-10 year horizon.
2. **Property Scout Agent** — Searches investment property listings in the top
   markets and evaluates price vs. anticipated rental income.
3. **Deal Analyzer Agent** — Conducts deep-dive due diligence on a specific
   address using 5 parallel specialized sub-agents, producing a structured
   investment memo.

---

## Usage

```bash
# Step 1: Run market research (produces top-25 cities ranking)
npx tsx src/index.ts market-research

# Step 2: Scout properties in specific cities
npx tsx src/index.ts property-scout --cities "Phoenix,Tampa,Austin"
npx tsx src/index.ts property-scout --auto  # reads last market-research output

# Step 3: Analyze a specific deal
npx tsx src/index.ts analyze --address "123 Main St, Phoenix AZ 85001" --price 450000 --type sfr
```

---

## Cost-Efficient Architecture

### Model Selection

| Agent | Model | Cost/1M tokens (in/out) | Rationale |
|---|---|---|---|
| Market Research Manager | claude-sonnet-4-6 | $3/$15 | Synthesis of many data signals |
| Property Scout Manager | claude-sonnet-4-6 | $3/$15 | Multi-market evaluation |
| Deal Analyzer Manager | claude-sonnet-4-6 | $3/$15 | Final memo synthesis |
| Owner Intel Sub-Agent | claude-haiku-4-5 | $0.80/$4 | Focused search, no heavy reasoning |
| Market Intel Sub-Agent | claude-haiku-4-5 | $0.80/$4 | Focused comp analysis |
| Public Records Sub-Agent | claude-haiku-4-5 | $0.80/$4 | Focused record retrieval |
| Underwriting Sub-Agent | claude-haiku-4-5 | $0.80/$4 | Structured math + data |
| Legal Risk Sub-Agent | claude-haiku-4-5 | $0.80/$4 | Pattern recognition |

**Estimated cost per full deal analysis: ~$0.30–$0.80** (vs $2–5 with opus everywhere)

### API Cost Strategy

| Phase | APIs | Monthly Cost | When to Upgrade |
|---|---|---|---|
| Phase 1 (MVP) | Anthropic + Tavily | ~$0 + usage | Start here |
| Phase 2 | + RentCast | +$19/mo | When you want structured rental data |
| Phase 3 | + ATTOM | +$199/mo | When doing 50+ deals/month or need authoritative ownership data |

**Tavily**: 1,000 free searches/month. At 30–50 searches/deal analysis, that's
20–30 free deal analyses per month before paying (~$0.001/search after free tier).

---

## Agent Tool Use Loop Pattern

All agents use the same agentic loop — NOT one-shot LLM calls:

```typescript
async function runAgentLoop(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  initialMessage: string,
  tools: Anthropic.Tool[],
  maxIterations = 15
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: initialMessage }
  ];

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock?.text ?? '';
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const result = await executeTool(block.name, block.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }
  }
  throw new Error(`Agent exceeded max iterations (${maxIterations})`);
}
```

---

## Deal Analyzer: Parallel Sub-Agent Pattern

```typescript
// deal-analyzer-manager.ts (simplified)
const [ownerIntel, marketIntel, publicRecords, underwriting, legalRisk] =
  await Promise.all([
    runOwnerIntelAgent(address, client),
    runMarketIntelAgent(address, purchasePrice, client),
    runPublicRecordsAgent(address, client),
    runUnderwritingAgent(address, purchasePrice, client),
    runLegalRiskAgent(address, client),
  ]);

const memo = await compileInvestmentMemo(
  { ownerIntel, marketIntel, publicRecords, underwriting, legalRisk },
  address,
  purchasePrice,
  client
);
```

All 5 sub-agents run simultaneously. Total time ≈ time of slowest sub-agent,
not the sum of all five.

---

## Data Flow

```
CLI: npx tsx src/index.ts analyze --address "..." --price 450000
│
└── DealAnalyzerManager (claude-sonnet-4-6)
    │
    ├── [Promise.all] 5 sub-agents in parallel
    │   │
    │   ├── OwnerIntelAgent (claude-haiku-4-5)
    │   │   ├── web_search("123 Main St Phoenix owner records")
    │   │   ├── web_search("owner name LLC search Arizona")
    │   │   └── → SubAgentResult { category: 'owner_intel', findings, riskFlags }
    │   │
    │   ├── MarketIntelAgent (claude-haiku-4-5)
    │   │   ├── web_search("Phoenix 85001 comparable sales 2024")
    │   │   ├── web_search("Phoenix rental market cap rates 2024")
    │   │   └── → SubAgentResult { category: 'market_intel', findings, riskFlags }
    │   │
    │   ├── PublicRecordsAgent (claude-haiku-4-5)
    │   │   ├── web_search("123 Main St Phoenix zoning permits")
    │   │   ├── web_search("Maricopa County property history violations")
    │   │   └── → SubAgentResult { category: 'public_records', findings, riskFlags }
    │   │
    │   ├── UnderwritingAgent (claude-haiku-4-5)
    │   │   ├── web_search("Phoenix 85001 average rent 3bed 2024")
    │   │   ├── Calculates: NOI, Cap Rate, DSCR @ 65/70/75% LTV
    │   │   └── → SubAgentResult { category: 'underwriting', findings, riskFlags, data }
    │   │
    │   └── LegalRiskAgent (claude-haiku-4-5)
    │       ├── web_search("123 Main St Phoenix court records lawsuits")
    │       ├── web_search("Phoenix 85001 Superfund environmental EPA")
    │       └── → SubAgentResult { category: 'legal_risk', findings, riskFlags }
    │
    ├── memo-compiler.ts → assembles 5 results + asks manager LLM for verdict
    └── output-writer.ts → output/deal-analysis/123-main-st-phoenix-2026-03-02.md
```

---

## Investment Criteria

### Hard Gates (any failure = PASS or IMMEDIATE PASS)

| Gate | Threshold | Agent |
|---|---|---|
| Cap Rate vs Debt Cost | Cap rate > current rate | Underwriting |
| DSCR | > 1.25 at 75% LTV | Underwriting |
| Title Defects | None | Owner Intel |
| Active Litigation | None naming property/owner | Legal Risk |
| Environmental | No Superfund within 0.5mi | Legal Risk |

### Scoring Factors (advisory)

| Factor | Weight |
|---|---|
| Submarket trend (growing/stable/declining) | High |
| 3-year rent growth trajectory | Medium |
| Vacancy rate vs metro average | Medium |
| Days on market / price cuts | Medium |
| School district quality | Low |
| Crime index vs metro average | Medium |

### Verdict Options

| Verdict | Condition |
|---|---|
| STRONG BUY | All gates pass + 3+ positive factors |
| BUY | All gates pass |
| CONDITIONAL | Soft concerns, 1–2 near-misses on gates |
| PASS | Any hard gate fails |
| IMMEDIATE PASS | Critical red flag (active fraud, contamination, title dispute) |

---

## Underwriting Math

```
Gross Rent (annual) = monthly_rent × 12
Effective Gross Income = Gross Rent × (1 - vacancy_rate)  // default vacancy 8%
Operating Expenses = Effective Gross Income × expense_ratio  // default 40%
NOI = Effective Gross Income - Operating Expenses

Cap Rate = NOI / purchase_price × 100

// Debt Service (30yr am)
Monthly Payment = P × [r(1+r)^n] / [(1+r)^n - 1]
  where P = loan_amount, r = annual_rate/12, n = 360

Annual Debt Service = Monthly Payment × 12
DSCR = NOI / Annual Debt Service

Cash Flow = NOI - Annual Debt Service
Cash-on-Cash = Cash Flow / equity_invested × 100
GRM = purchase_price / (monthly_rent × 12)
```

---

## Market Research Scoring Model

### Weights

| Factor | Weight | Source |
|---|---|---|
| Population Growth (5yr CAGR) | 20% | Census API + Tavily |
| Job Growth (5yr) | 20% | BLS data via Tavily |
| Wage Growth (5yr CAGR) | 10% | BLS data via Tavily |
| Rent Growth Trajectory (3yr) | 15% | RentCast or Tavily |
| Gross Rent Multiplier (city avg) | 15% | RentCast or Tavily |
| Crime Index (lower = better) | 10% | FBI UCR via Tavily |
| School Quality | 5% | GreatSchools via Tavily |
| Landlord-Friendliness | 5% | Eviction law research via Tavily |

### Formula
```
normalized_score = (value - min_in_pool) / (max_in_pool - min_in_pool) × 100
city_score = Σ(normalized_score × weight)
```

---

## Investment Memo Template

```markdown
# Investment Analysis: {address}
**Date**: {date} | **Price**: ${price} | **Type**: {SFR|Multifamily}

## VERDICT: {STRONG BUY | BUY | CONDITIONAL | PASS | IMMEDIATE PASS}

### Key Reasons
- {reason 1}
- {reason 2}

### Risk Factors
- {risk 1}

---

## Underwriting

| Metric | Value | Threshold | Pass? |
|---|---|---|---|
| Cap Rate | X.X% | > debt cost | ✓/✗ |
| DSCR (75% LTV) | X.XX | > 1.25 | ✓/✗ |
| Cash-on-Cash | X.X% | Advisory | — |
| GRM | XX.X | Advisory | — |

### Leverage Scenarios
| LTV | Loan | Payment/mo | NOI/mo | DSCR | Monthly CF |
|---|---|---|---|---|---|
| 65% | $XXX,XXX | $X,XXX | $X,XXX | X.XX | +/-$XXX |
| 70% | $XXX,XXX | $X,XXX | $X,XXX | X.XX | +/-$XXX |
| 75% | $XXX,XXX | $X,XXX | $X,XXX | X.XX | +/-$XXX |

## Owner Intelligence
{findings}
**Red Flags**: {none | list}

## Market Intelligence
{findings}
**Submarket Trend**: {growing | stable | declining}

## Public Records
**Zoning**: {classification} | **Open Permits**: {none | list}

## Legal Risk
**Litigation**: {none | list} | **Environmental**: {clear | concerns}

## Final Recommendation
{manager agent synthesis paragraph}

---
*REI Agent System — Not financial advice. Verify independently.*
```

---

## Error Handling

- All tool calls wrapped in `retry.ts` (3 attempts, exponential backoff: 2s/4s/8s)
- Sub-agent failures are caught individually — a failed sub-agent returns
  `{ findings: "Unable to retrieve — manual verification required", riskFlags: [], confidence: 'low' }`
  rather than crashing the full analysis
- The manager still compiles the memo with whatever data is available

---

## File Naming Convention

```
output/market-research/top-25-cities-2026-03-02.md
output/property-scout/phoenix-az-listings-2026-03-02.md
output/deal-analysis/123-main-st-phoenix-az-85001-2026-03-02.md
```
