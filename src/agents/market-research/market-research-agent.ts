import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient, MODELS } from '../../lib/anthropic-client';
import { runAgentLoop } from '../../lib/agent-loop';
import { withRetry } from '../../lib/retry';
import { logger } from '../../lib/logger';
import { scoreCities, getRawFactors, type CityRawData } from '../../lib/city-scorer';
import { writeCityRankings } from '../../lib/output-writer';
import { MARKET_RESEARCH_SYSTEM_PROMPT } from '../../prompts/market-research-system';
import { WEB_SEARCH_TOOL } from '../../tools/web-search';
import type { CityScore } from '../../types';

// ── Extraction tool ───────────────────────────────────────────────────────────

const CITY_RANKINGS_TOOL: Anthropic.Tool = {
  name: 'submit_city_rankings',
  description: 'Submit the collected research data for all 30 candidate cities. Include every city you researched, even those with incomplete data.',
  input_schema: {
    type: 'object',
    properties: {
      cities: {
        type: 'array',
        description: 'Array of city research results. Include all 30 cities.',
        items: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description: 'City name, e.g. "Memphis"',
            },
            state: {
              type: 'string',
              description: '2-letter state code, e.g. "TN"',
            },
            populationGrowthPct: {
              type: ['number', 'null'],
              description: 'Annual population growth %, e.g. 1.8 for 1.8%. Null if not found.',
            },
            jobGrowthPct: {
              type: ['number', 'null'],
              description: 'Annual job/employment growth %. Null if not found.',
            },
            wageGrowthPct: {
              type: ['number', 'null'],
              description: 'Annual wage growth %. Null if not found.',
            },
            rentGrowthPct: {
              type: ['number', 'null'],
              description: 'Annual rent growth % (YoY change). Null if not found.',
            },
            medianGRM: {
              type: ['number', 'null'],
              description: 'Median gross rent multiplier (price / annual rent). E.g. 11.2. Null if not found.',
            },
            crimeIndexVsNational: {
              type: ['number', 'null'],
              description: 'Crime rate vs national average. 1.0 = national avg, 0.7 = 30% below, 1.5 = 50% above. Null if not found.',
            },
            avgSchoolRating: {
              type: ['number', 'null'],
              description: 'Average GreatSchools rating 1–10 for the metro. Null if not found.',
            },
            landlordFriendlyScore: {
              type: ['number', 'null'],
              description: 'Landlord friendliness 1–10 (10 = very easy to landlord, 1 = rent control/slow evictions). Null if not found.',
            },
            dataQuality: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: 'high = 3+ reliable sources, medium = 1-2 sources, low = estimated',
            },
            notes: {
              type: 'string',
              description: '1–2 sentences of market context useful for investors.',
            },
          },
          required: ['city', 'state', 'dataQuality', 'notes'],
        },
      },
    },
    required: ['cities'],
  },
};

// ── Initial message ───────────────────────────────────────────────────────────

function buildInitialMessage(): string {
  return `Please research the following 30 US cities for real estate investment potential.

For each city, collect data on 8 scoring factors:
1. Population growth % (annual)
2. Job growth % (annual)
3. Wage growth % (annual)
4. Rent growth % (annual YoY change)
5. Median GRM (gross rent multiplier = price / annual rent)
6. Crime index vs national (1.0 = national avg)
7. Average school rating (1–10 scale)
8. Landlord-friendliness score (1–10)

**The 30 candidate cities:**
Sun Belt: Phoenix AZ, Tampa FL, Jacksonville FL, Orlando FL, Charlotte NC, Nashville TN, Atlanta GA, Dallas TX, Houston TX, San Antonio TX
Midwest: Indianapolis IN, Columbus OH, Cincinnati OH, Kansas City MO, Memphis TN, St. Louis MO, Cleveland OH, Detroit MI, Milwaukee WI
Southeast: Birmingham AL, Huntsville AL, Savannah GA, Augusta GA
Southwest: Las Vegas NV, Tucson AZ, Albuquerque NM
Northwest: Boise ID, Spokane WA
Other: Pittsburgh PA, Baltimore MD

**Research strategy — start broad, then targeted:**
1. "best cities real estate investment 2024 2025 cash flow GRM price to rent ratio"
2. "US metros population growth 2024 Sun Belt Midwest fastest growing"
3. "BLS metro area employment job growth 2024"
4. "Zillow rent growth by city 2024 rent index"
5. "best states landlords eviction laws 2024 landlord friendly"
6. Then targeted searches for individual cities where data is missing

After researching all cities, call submit_city_rankings with all data. Use null for factors you could not find — do not guess.`;
}

// ── Extraction ────────────────────────────────────────────────────────────────

async function extractCityData(
  client: Anthropic,
  researchText: string
): Promise<CityRawData[]> {
  const response = await withRetry(
    () =>
      client.messages.create({
        model: MODELS.SUB_AGENT,
        max_tokens: 8192,
        system:
          'You are extracting structured city research data from research notes. ' +
          'Call submit_city_rankings with the data for all cities found in the research. ' +
          'Include every city you can find data for. Use null for missing values — never guess.',
        tools: [CITY_RANKINGS_TOOL],
        tool_choice: { type: 'tool', name: 'submit_city_rankings' },
        messages: [{ role: 'user', content: `Research notes:\n\n${researchText}` }],
      }),
    { label: 'extract-city-rankings' }
  );

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
  );

  if (!toolBlock) {
    logger.warn('City extraction: no tool_use block returned');
    return [];
  }

  const { cities } = toolBlock.input as { cities: CityRawData[] };
  return cities ?? [];
}

// ── Markdown builder ──────────────────────────────────────────────────────────

function buildMarkdown(ranked: CityScore[], rawData: CityRawData[]): string {
  const today = new Date().toISOString().split('T')[0];
  const rawByCity = new Map(rawData.map(r => [`${r.city}-${r.state}`, r]));

  const rows = ranked
    .map(c => {
      const raw = rawByCity.get(`${c.city}-${c.state}`);
      const grm    = raw?.medianGRM != null ? `${raw.medianGRM.toFixed(1)}x` : 'N/A';
      const crime  = raw?.crimeIndexVsNational != null ? raw.crimeIndexVsNational.toFixed(2) : 'N/A';
      const school = raw?.avgSchoolRating != null ? `${raw.avgSchoolRating.toFixed(1)}/10` : 'N/A';
      const pop    = raw?.populationGrowthPct != null ? `+${raw.populationGrowthPct.toFixed(1)}%` : 'N/A';
      const job    = raw?.jobGrowthPct != null ? `+${raw.jobGrowthPct.toFixed(1)}%` : 'N/A';
      return `| ${c.rank} | **${c.city}, ${c.state}** | ${c.score.toFixed(1)} | ${pop} | ${job} | ${grm} | ${crime} | ${school} |`;
    })
    .join('\n');

  const profilesTop10 = ranked.slice(0, 10).map(c => {
    const raw = rawByCity.get(`${c.city}-${c.state}`);
    const rawFactors = raw ? getRawFactors(raw) : {};
    const factorLines = Object.entries(rawFactors)
      .map(([k, v]) => `- **${k}**: ${v}`)
      .join('\n');

    return `### #${c.rank} — ${c.city}, ${c.state} &nbsp; *(Score: ${c.score.toFixed(1)})*

${c.summary || '_No additional notes._'}

**Raw data:**
${factorLines}

**Normalized scores (0–100, higher = better):**
Pop Growth: ${c.factors.populationGrowth} · Job Growth: ${c.factors.jobGrowth} · Wage Growth: ${c.factors.wageGrowth} · Rent Growth: ${c.factors.rentGrowth} · GRM: ${c.factors.grossRentMultiplier} · Crime: ${c.factors.crimeIndex} · Schools: ${c.factors.schoolQuality} · Landlord: ${c.factors.landlordFriendliness}
`;
  }).join('\n---\n\n');

  return `# Top 25 US Cities for Real Estate Investment

**Date**: ${today}
**Methodology**: Weighted scoring of 8 factors across 30 candidate cities

---

## Rankings

| Rank | City | Score | Pop Growth | Job Growth | GRM | Crime Index | Schools |
|------|------|-------|------------|------------|-----|-------------|---------|
${rows}

*Score: 0–100 weighted composite. GRM = price / annual rent (lower = better cash flow). Crime Index: 1.0 = national average.*

---

## Top 10 City Profiles

${profilesTop10}

---

## Full Rankings #11–25

| Rank | City | Score |
|------|------|-------|
${ranked.slice(10).map(c => `| ${c.rank} | ${c.city}, ${c.state} | ${c.score.toFixed(1)} |`).join('\n')}

---

## Scoring Methodology

| Factor | Weight | Direction |
|--------|--------|-----------|
| Population Growth | 20% | Higher = better |
| Job Growth | 20% | Higher = better |
| Wage Growth | 10% | Higher = better |
| Rent Growth | 15% | Higher = better |
| Gross Rent Multiplier | 15% | **Lower = better** (inverted) |
| Crime Index | 10% | **Lower = better** (inverted) |
| School Quality | 5% | Higher = better |
| Landlord Friendliness | 5% | Higher = better |

All factors are min-max normalized (0–100) across the 30 candidate cities before weighting. A score of 100 on a factor means that city performed best among the 30 candidates on that metric — it is a relative, not absolute, score.

---

*Generated by REI Agent System. Verify all data independently before making investment decisions.*
*Research date: ${today}*`;
}

// ── Terminal summary ──────────────────────────────────────────────────────────

function printSummary(ranked: CityScore[], outputPath: string, elapsed: string): void {
  const BOLD = '\x1b[1m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const RESET = '\x1b[0m';

  process.stdout.write(`
${BOLD}══════════════════════════════════════════════════════${RESET}
${BOLD}  MARKET RESEARCH COMPLETE${RESET}
${BOLD}══════════════════════════════════════════════════════${RESET}

  Cities ranked: ${ranked.length}
  Time:          ${elapsed}s

  ${BOLD}Top 10 Markets:${RESET}
${ranked.slice(0, 10).map(c => {
    const color = c.rank <= 3 ? GREEN : c.rank <= 7 ? YELLOW : '';
    return `  ${color}#${String(c.rank).padEnd(2)} ${`${c.city}, ${c.state}`.padEnd(20)} Score: ${c.score.toFixed(1)}${RESET}`;
  }).join('\n')}

  Output: ${outputPath}

${BOLD}══════════════════════════════════════════════════════${RESET}
`);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runMarketResearch(): Promise<void> {
  logger.info('Market Research agent started');
  const startTime = Date.now();

  const client = getAnthropicClient();

  // ── Phase 1: Research loop ─────────────────────────────────────────────────
  // Extended loop (maxIterations: 50) gives the agent room for 40–60 searches
  // across 30 cities. Agent uses bulk searches first, then targeted fill-ins.

  const { text, toolCallCount } = await runAgentLoop(client, {
    model: MODELS.SUB_AGENT,
    systemPrompt: MARKET_RESEARCH_SYSTEM_PROMPT,
    initialMessage: buildInitialMessage(),
    tools: [WEB_SEARCH_TOOL],
    agentLabel: 'market-research',
    maxIterations: 50,
  });

  logger.info('Market research loop complete', { toolCallCount });

  // ── Phase 2: Structured extraction ────────────────────────────────────────

  logger.info('Extracting city data from research text...');
  const rawData = await extractCityData(client, text);
  logger.info('City data extracted', { citiesFound: rawData.length });

  if (rawData.length === 0) {
    logger.error('No city data could be extracted — check research output');
    process.exit(1);
  }

  // ── Phase 3: TypeScript scoring (no LLM math) ────────────────────────────

  logger.info('Computing weighted city scores...');
  const ranked = scoreCities(rawData);
  logger.info('Scoring complete', { citiesRanked: ranked.length });

  // ── Phase 4: Build and write output ──────────────────────────────────────

  const markdown = buildMarkdown(ranked, rawData);
  const outputPath = writeCityRankings(markdown);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  printSummary(ranked, outputPath, elapsed);
}
