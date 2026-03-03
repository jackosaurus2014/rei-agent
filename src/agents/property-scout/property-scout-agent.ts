import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { getAnthropicClient, MODELS } from '../../lib/anthropic-client';
import { runAgentLoop } from '../../lib/agent-loop';
import { withRetry } from '../../lib/retry';
import { logger } from '../../lib/logger';
import { writePropertyScout } from '../../lib/output-writer';
import { computeUnderwriting } from '../../lib/underwriting-calculator';
import { PROPERTY_SCOUT_SYSTEM_PROMPT } from '../../prompts/property-scout-system';
import { WEB_SEARCH_TOOL } from '../../tools/web-search';
import type { PropertyListing } from '../../types';

// ── Options ───────────────────────────────────────────────────────────────────

export interface PropertyScoutOptions {
  cities: string[];
  auto?: boolean;
  maxPrice?: number;
  minPrice?: number;
  propertyType?: string;
  maxListings?: number;
}

// ── Extraction tool ───────────────────────────────────────────────────────────

const PROPERTY_LISTINGS_TOOL: Anthropic.Tool = {
  name: 'submit_property_listings',
  description: 'Submit all investment property listings found during your research for this city.',
  input_schema: {
    type: 'object',
    properties: {
      listings: {
        type: 'array',
        description: 'All property listings found. Include everything, even properties that may not meet investment criteria.',
        items: {
          type: 'object',
          properties: {
            address:   { type: 'string', description: 'Full address, or "Neighborhood, City ST" if no specific address.' },
            city:      { type: 'string', description: 'City name.' },
            state:     { type: 'string', description: '2-letter state code.' },
            zipCode:   { type: 'string', description: 'Zip code, or empty string if unknown.' },
            price:     { type: 'number', description: 'Listed price in dollars.' },
            beds:      { type: 'number', description: 'Number of bedrooms.' },
            baths:     { type: 'number', description: 'Number of bathrooms.' },
            sqft:      { type: 'number', description: 'Square footage. Use 0 if unknown.' },
            estimatedMonthlyRent: {
              type: 'number',
              description: 'Your best estimate of monthly market rent in dollars. Base on any rent data in your research or comparable rentals.',
            },
            source: {
              type: 'string',
              enum: ['zillow', 'redfin', 'realtor', 'auction', 'web', 'wholesale'],
              description: 'Where this listing was found.',
            },
            url:   { type: 'string', description: 'Listing URL if available, otherwise empty string.' },
            notes: { type: 'string', description: 'Property condition, investment thesis, red flags, 1–3 sentences.' },
          },
          required: ['address', 'city', 'state', 'zipCode', 'price', 'beds', 'baths', 'sqft', 'estimatedMonthlyRent', 'source', 'url', 'notes'],
        },
      },
      marketContext: {
        type: 'string',
        description: '2–3 sentence summary of what you found and overall market conditions in this city for investors.',
      },
      searchesPerformed: {
        type: 'number',
        description: 'Approximate number of searches you ran.',
      },
    },
    required: ['listings', 'marketContext', 'searchesPerformed'],
  },
};

// ── Build initial message per city ────────────────────────────────────────────

function buildCityMessage(
  city: string,
  maxPrice: number,
  minPrice: number,
  propertyType: string
): string {
  const [cityName, ...stateParts] = city.split(',').map(s => s.trim());
  const state = stateParts.join(' ') || '';

  return `Find investment property listings in ${city}.

**Target criteria:**
- Property type: ${propertyType.toUpperCase()} (single-family rental or small multifamily 2–4 units)
- Price range: $${minPrice.toLocaleString()} – $${maxPrice.toLocaleString()}
- Goal: Cash-flow positive or near-positive at current market rents

**Run these 4 types of searches:**

1. "${cityName} ${state} investment property for sale under $${maxPrice.toLocaleString()}"
2. "${cityName} ${state} rental property ${propertyType} for sale 2025 cash flow"
3. "${cityName} ${state} foreclosure REO bank owned investment property for sale"
4. "${cityName} ${state} wholesale off-market investment property"

For each listing found, record: address, price, beds/baths, any rent data, and source.
If a listing shows rent or mentions tenant-occupied, note it — that's valuable data.
After all 4 search types, call submit_property_listings with everything you found.`;
}

// ── Extraction per city ───────────────────────────────────────────────────────

interface RawListingResult {
  listings: Array<{
    address: string;
    city: string;
    state: string;
    zipCode: string;
    price: number;
    beds: number;
    baths: number;
    sqft: number;
    estimatedMonthlyRent: number;
    source: string;
    url: string;
    notes: string;
  }>;
  marketContext: string;
  searchesPerformed: number;
}

async function extractListings(
  client: Anthropic,
  city: string,
  researchText: string
): Promise<RawListingResult> {
  const response = await withRetry(
    () =>
      client.messages.create({
        model: MODELS.SUB_AGENT,
        max_tokens: 4096,
        system:
          `You are extracting property listing data from research notes for ${city}. ` +
          'Call submit_property_listings with all listings found. ' +
          'If no specific listings were found, return an empty listings array and explain in marketContext.',
        tools: [PROPERTY_LISTINGS_TOOL],
        tool_choice: { type: 'tool', name: 'submit_property_listings' },
        messages: [{ role: 'user', content: `Research notes:\n\n${researchText}` }],
      }),
    { label: `extract-listings-${city}` }
  );

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
  );

  if (!toolBlock) {
    return { listings: [], marketContext: 'Extraction failed — no structured data returned.', searchesPerformed: 0 };
  }

  const raw = toolBlock.input as RawListingResult;
  // Guard against model returning null for array fields despite schema marking them required
  return {
    listings: Array.isArray(raw.listings) ? raw.listings : [],
    marketContext: raw.marketContext ?? 'No market context provided.',
    searchesPerformed: raw.searchesPerformed ?? 0,
  };
}

// ── TypeScript screening ──────────────────────────────────────────────────────

const SCREEN_CAP_RATE_THRESHOLD = 5.5; // pre-screen only, not a hard gate

function screenAndEnrichListings(raw: RawListingResult): {
  listings: PropertyListing[];
  promising: PropertyListing[];
} {
  const annualRate = Number(process.env.ASSUMED_RATE ?? 7.5) / 100;
  const expenseRatio = Number(process.env.EXPENSE_RATIO ?? 0.40);

  const listings: PropertyListing[] = raw.listings.map(r => {
    const underwriting = r.price > 0 && r.estimatedMonthlyRent > 0
      ? computeUnderwriting({
          purchasePrice: r.price,
          monthlyRent: r.estimatedMonthlyRent,
          annualRate,
          expenseRatio,
          vacancyRate: 0.08,
          amortizationYears: 30,
        })
      : null;

    return {
      address: r.address,
      city: r.city,
      state: r.state,
      zipCode: r.zipCode,
      price: r.price,
      beds: r.beds,
      baths: r.baths,
      sqft: r.sqft || undefined,
      estimatedMonthlyRent: r.estimatedMonthlyRent,
      estimatedCapRate: underwriting ? Math.round(underwriting.capRate * 10) / 10 : 0,
      estimatedGRM: underwriting ? Math.round(underwriting.grm * 10) / 10 : 0,
      source: r.source,
      url: r.url || undefined,
      notes: r.notes,
    };
  });

  const promising = listings.filter(l => l.estimatedCapRate >= SCREEN_CAP_RATE_THRESHOLD);

  return { listings, promising };
}

// ── Markdown per city ─────────────────────────────────────────────────────────

function buildCityMarkdown(
  city: string,
  context: string,
  listings: PropertyListing[],
  promising: PropertyListing[]
): string {
  const today = new Date().toISOString().split('T')[0];

  const tableRows = listings.map(l =>
    `| ${l.address} | $${l.price.toLocaleString()} | ${l.beds}BR/${l.baths}BA | $${l.estimatedMonthlyRent.toLocaleString()}/mo | ${l.estimatedCapRate > 0 ? `${l.estimatedCapRate}%` : 'N/A'} | ${l.estimatedGRM > 0 ? `${l.estimatedGRM}x` : 'N/A'} | ${l.source} |`
  ).join('\n');

  const promisingSection = promising.length > 0
    ? `## Pre-Screened Opportunities (Est. Cap Rate ≥ ${SCREEN_CAP_RATE_THRESHOLD}%)

${promising.map(l => `### ${l.address}
- **Price**: $${l.price.toLocaleString()}
- **Beds/Baths**: ${l.beds}BR/${l.baths}BA${l.sqft ? ` · ${l.sqft.toLocaleString()} sqft` : ''}
- **Est. Monthly Rent**: $${l.estimatedMonthlyRent.toLocaleString()}/mo
- **Est. Cap Rate**: ${l.estimatedCapRate}%  |  **Est. GRM**: ${l.estimatedGRM}x
- **Source**: ${l.source}${l.url ? ` · [Listing](${l.url})` : ''}
- **Notes**: ${l.notes}

*To run full deal analysis:*
\`npx tsx src/index.ts analyze --address "${l.address}" --price ${l.price} --type sfr\`
`).join('\n---\n\n')}`
    : `## Pre-Screened Opportunities\n\nNo listings met the ${SCREEN_CAP_RATE_THRESHOLD}% estimated cap rate threshold. Review all listings above and verify rent assumptions manually.`;

  return `# Investment Properties: ${city} — ${today}

## Market Summary

${context}

---

## All Listings Found (${listings.length} total)

| Address | Price | Beds | Est. Rent | Est. Cap Rate | GRM | Source |
|---------|-------|------|-----------|---------------|-----|--------|
${tableRows || '| _No listings found_ | — | — | — | — | — | — |'}

---

${promisingSection}

---

## Next Steps

1. Run full deal analysis on any promising listing:
   \`npx tsx src/index.ts analyze --address "ADDRESS" --price PRICE --type sfr\`
2. Verify rent assumptions with local property managers or Zillow rent estimates
3. Confirm listings are still active before making offers

---

*Generated by REI Agent System. Not financial advice. Verify all data independently.*
*Scout date: ${today}*`;
}

// ── Auto-load cities from latest market research ──────────────────────────────

function loadCitiesFromMarketResearch(): string[] {
  const outputDir = process.env.OUTPUT_DIR ?? './output';
  const dir = path.join(outputDir, 'market-research');

  if (!fs.existsSync(dir)) {
    logger.error('No market research output found. Run market-research first or pass --cities.');
    return [];
  }

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse(); // most recent first

  if (files.length === 0) {
    logger.error('No market research files found in output/market-research/');
    return [];
  }

  const latest = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  logger.info('Auto-loading cities from latest market research', { file: files[0] });

  // Parse top 10 cities from the rankings table
  // Table format: | Rank | **City, ST** | Score | ...
  const cities: string[] = [];
  const tableRegex = /^\|\s*(\d+)\s*\|\s*\*\*([^,]+),\s*([A-Z]{2})\*\*/gm;
  let match;
  while ((match = tableRegex.exec(latest)) !== null && cities.length < 10) {
    cities.push(`${match[2].trim()}, ${match[3].trim()}`);
  }

  if (cities.length === 0) {
    logger.warn('Could not parse cities from market research file — check format');
  } else {
    logger.info('Auto-loaded cities', { cities });
  }

  return cities;
}

// ── Summary markdown (across all cities) ─────────────────────────────────────

function buildSummaryMarkdown(
  allPromising: Array<{ city: string; listing: PropertyListing }>,
  citiesSearched: string[],
  outputPaths: string[]
): string {
  const today = new Date().toISOString().split('T')[0];

  const sorted = [...allPromising].sort((a, b) => b.listing.estimatedCapRate - a.listing.estimatedCapRate);

  const rows = sorted.map(({ city, listing }) =>
    `| ${city} | ${listing.address} | $${listing.price.toLocaleString()} | ${listing.beds}BR/${listing.baths}BA | $${listing.estimatedMonthlyRent.toLocaleString()}/mo | **${listing.estimatedCapRate}%** | ${listing.estimatedGRM}x |`
  ).join('\n');

  const analyzeCommands = sorted.slice(0, 5).map(({ listing }) =>
    `npx tsx src/index.ts analyze --address "${listing.address}" --price ${listing.price} --type sfr`
  ).join('\n');

  return `# Property Scout Summary — ${today}

**Cities searched**: ${citiesSearched.join(', ')}
**Total pre-screened**: ${allPromising.length} listings (est. cap rate ≥ ${SCREEN_CAP_RATE_THRESHOLD}%)

---

## Top Opportunities (Ranked by Est. Cap Rate)

| City | Address | Price | Beds | Est. Rent | Est. Cap Rate | GRM |
|------|---------|-------|------|-----------|---------------|-----|
${rows || '| _None found_ | — | — | — | — | — | — |'}

---

## Run Full Analysis on Top Candidates

\`\`\`bash
${analyzeCommands || '# No promising listings found — adjust search criteria'}
\`\`\`

---

## Individual City Reports

${outputPaths.map((p, i) => `- ${citiesSearched[i]}: \`${p}\``).join('\n')}

---

*Cap rate estimates use ${(Number(process.env.ASSUMED_RATE ?? 7.5)).toFixed(1)}% interest rate assumption and ${(Number(process.env.EXPENSE_RATIO ?? 0.40) * 100).toFixed(0)}% expense ratio. Full analysis required before any offer.*
*Generated by REI Agent System · ${today}*`;
}

// ── Terminal summary ──────────────────────────────────────────────────────────

function printSummary(
  citiesSearched: string[],
  allPromising: Array<{ city: string; listing: PropertyListing }>,
  summaryPath: string,
  elapsed: string
): void {
  const BOLD = '\x1b[1m';
  const GREEN = '\x1b[32m';
  const RESET = '\x1b[0m';

  const topDeals = [...allPromising]
    .sort((a, b) => b.listing.estimatedCapRate - a.listing.estimatedCapRate)
    .slice(0, 5);

  process.stdout.write(`
${BOLD}══════════════════════════════════════════════════════${RESET}
${BOLD}  PROPERTY SCOUT COMPLETE${RESET}
${BOLD}══════════════════════════════════════════════════════${RESET}

  Cities searched:      ${citiesSearched.length}
  Promising listings:   ${allPromising.length}
  Time:                 ${elapsed}s

${topDeals.length > 0 ? `  ${BOLD}Top Opportunities:${RESET}
${topDeals.map(({ city, listing }) =>
  `  ${GREEN}${listing.estimatedCapRate}% cap${RESET}  ${listing.address} (${city}) — $${listing.price.toLocaleString()}`
).join('\n')}` : '  No listings met the pre-screen threshold. Review city reports for details.'}

  Summary: ${summaryPath}

${BOLD}══════════════════════════════════════════════════════${RESET}
`);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runPropertyScout(options: PropertyScoutOptions): Promise<void> {
  const {
    auto = false,
    maxPrice = 400000,
    minPrice = 50000,
    propertyType = 'sfr',
    maxListings = 8,
  } = options;

  let { cities } = options;

  if (auto || cities.length === 0) {
    cities = loadCitiesFromMarketResearch();
    if (cities.length === 0) {
      process.exit(1);
    }
  }

  logger.info('Property Scout started', { cities, maxPrice, minPrice, propertyType });
  const startTime = Date.now();

  const client = getAnthropicClient();
  const outputPaths: string[] = [];
  const allPromising: Array<{ city: string; listing: PropertyListing }> = [];

  // ── Per-city sequential research ──────────────────────────────────────────
  // Sequential to avoid rate limits (same pattern as deal-analyzer sub-agents)
  // TODO: Switch to parallel at Tier 2 ($40 cumulative API spend)

  for (const city of cities) {
    logger.info('Scouting city', { city });

    const { text, toolCallCount } = await runAgentLoop(client, {
      model: MODELS.SUB_AGENT,
      systemPrompt: PROPERTY_SCOUT_SYSTEM_PROMPT,
      initialMessage: buildCityMessage(city, maxPrice, minPrice, propertyType),
      tools: [WEB_SEARCH_TOOL],
      agentLabel: `scout-${city.replace(/\s+/g, '-').toLowerCase()}`,
      maxIterations: 20,
    });

    logger.info('Scout research complete', { city, toolCallCount });

    const raw = await extractListings(client, city, text);
    logger.info('Listings extracted', { city, count: raw.listings.length });

    const { listings, promising } = screenAndEnrichListings(raw);

    // Enforce maxListings limit on output (keep all for analysis, cap for display)
    const displayListings = listings.slice(0, maxListings);
    const displayPromising = promising.filter(p => displayListings.includes(p));

    const cityMarkdown = buildCityMarkdown(city, raw.marketContext, displayListings, displayPromising);
    const outputPath = writePropertyScout(cityMarkdown, city);
    outputPaths.push(outputPath);

    for (const listing of promising) {
      allPromising.push({ city, listing });
    }

    logger.info('City scouting complete', {
      city,
      listingsFound: listings.length,
      promising: promising.length,
      outputPath,
    });
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const summaryMarkdown = buildSummaryMarkdown(allPromising, cities, outputPaths);
  const summaryPath = writePropertyScout(summaryMarkdown, 'summary');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  printSummary(cities, allPromising, summaryPath, elapsed);
}
