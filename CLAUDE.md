# REI Agent System — Project Context

## Purpose
CLI-driven AI agent system for real estate investment analysis.
Three top-level agents: Market Research, Property Scout, Deal Analyzer.

## Stack
- TypeScript + Node.js (no framework — pure CLI)
- Anthropic SDK (`@anthropic-ai/sdk`) — claude-sonnet-4-6 for managers, claude-haiku-4-5 for sub-agents
- Tavily SDK (`@tavily/core`) — web search tool
- Zod — input/output validation
- Jest + ts-node — testing

## Key Commands
```bash
# Run agents
npx tsx src/index.ts market-research
npx tsx src/index.ts property-scout --cities "Phoenix,Tampa"
npx tsx src/index.ts analyze --address "123 Main St, Phoenix AZ 85001" --price 450000

# Development
npm test                  # Run Jest suite
npx tsc --noEmit         # Type check only
```

## Architecture: 3 Top-Level Agents

### 1. Market Research Agent (`src/agents/market-research/`)
- Model: claude-sonnet-4-6
- Entry: `market-research-agent.ts`
- Output: `output/market-research/top-25-cities-DATE.md`
- Ranks US cities using weighted scoring: population, jobs, wages, rent growth, GRM, crime, schools

### 2. Property Scout Agent (`src/agents/property-scout/`)
- Model: claude-sonnet-4-6
- Entry: `property-scout-agent.ts`
- Output: `output/property-scout/{city}-listings-DATE.md`
- Finds investment properties using web search + property APIs

### 3. Deal Analyzer (`src/agents/deal-analyzer/`)
- Manager Model: claude-sonnet-4-6 (`deal-analyzer-manager.ts`)
- 5 Sub-Agents: claude-haiku-4-5 (in `sub-agents/`)
  - `owner-intel-agent.ts` — ownership, title, LLC, liens
  - `market-intel-agent.ts` — comps, cap rates, submarket trends
  - `public-records-agent.ts` — zoning, permits, history
  - `underwriting-agent.ts` — DSCR, cap rate, cash flow
  - `legal-risk-agent.ts` — litigation, environmental, compliance
- Parallelism: All 5 sub-agents run with `Promise.all()`
- Output: `output/deal-analysis/{address}-memo-DATE.md`

## Critical Patterns

### Anthropic Client (NEVER instantiate at module level)
```typescript
// src/lib/anthropic-client.ts — lazy init pattern
import Anthropic from '@anthropic-ai/sdk';
let _client: Anthropic | null = null;
export function getAnthropicClient(): Anthropic {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}
```

### Agent Tool Use Loop Pattern
All agents use the tool_use loop (not one-shot messages). See `DESIGN.md` for
the full loop pattern. Max iterations default: 15. Tools are defined in `src/tools/`.

### SubAgentResult Type (deal-analyzer contract)
```typescript
interface SubAgentResult {
  category: 'owner_intel' | 'market_intel' | 'public_records' | 'underwriting' | 'legal_risk';
  findings: string;           // Markdown prose findings
  riskFlags: string[];        // List of red flags (empty array = none)
  data?: Record<string, unknown>; // Structured data (numbers for underwriting)
  confidence: 'high' | 'medium' | 'low';
  searchesPerformed: number;
}
```

### Investment Verdict Logic (memo-compiler.ts)
- STRONG BUY: all gates pass + 3+ positive factors
- BUY: all gates pass
- CONDITIONAL: soft concerns, needs follow-up
- PASS: any hard gate fails
- IMMEDIATE PASS: critical red flag

Hard gates: cap rate > debt cost, DSCR > 1.25, no title defects, no active litigation

### Logger
```typescript
import { logger } from './lib/logger';
logger.info('Agent started', { agent: 'market-research' });
logger.error('Tool failed', { tool: 'web_search', error: err.message });
```
Use logger everywhere. Never use console.log/error directly.

## API Priority (Cost Efficiency)
- Phase 1 (MVP): ANTHROPIC_API_KEY + TAVILY_API_KEY only
- Phase 2: Add RENTCAST_API_KEY ($19/mo) for structured rental comps
- Phase 3: Add ATTOM_API_KEY ($199/mo) for authoritative ownership data

## Investment Thresholds (hardcoded in underwriting-agent.ts)
- DSCR minimum: 1.25
- LTV scenarios: 65%, 70%, 75%
- Assumed interest rate: env `ASSUMED_RATE` or default 7.5%
- Amortization: 30 years
- Operating expense ratio: 40% of gross rent

## Output Files
All output written to `./output/` (gitignored).
Three subdirectories: `market-research/`, `property-scout/`, `deal-analysis/`
File naming: `{slug}-YYYY-MM-DD.md`
