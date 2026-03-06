import { webSearch } from './web-search';
import { logger } from '../lib/logger';
import type { MarketRents } from './rentcast-search';

// ── Rent price extraction ──────────────────────────────────────────────────────
//
// Strategy: two-pass extraction
//   Pass 1 (strict)  — dollar amount immediately followed by per-month indicator
//   Pass 2 (loose)   — bare dollar amount in realistic rental range
//                       (only used when pass 1 finds nothing in a block of text)

const RENT_WITH_PERIOD_RE = /\$\s*([\d,]{3,6})\s*(?:\/\s*mo(?:nth)?|per\s*mo(?:nth)?|monthly)/gi;
const RENT_BARE_RE         = /\$\s*([\d,]{3,5})/gi;

const MIN_RENT = 400;
const MAX_RENT = 5_000;

function parseDollar(raw: string): number {
  return parseInt(raw.replace(/,/g, ''), 10);
}

function extractRentPrices(text: string): number[] {
  const prices: number[] = [];

  // Pass 1: strict — "/mo", "per month", "monthly"
  RENT_WITH_PERIOD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RENT_WITH_PERIOD_RE.exec(text)) !== null) {
    const n = parseDollar(m[1]);
    if (n >= MIN_RENT && n <= MAX_RENT) prices.push(n);
  }

  // Pass 2: loose — only when pass 1 yielded nothing
  if (prices.length === 0) {
    RENT_BARE_RE.lastIndex = 0;
    while ((m = RENT_BARE_RE.exec(text)) !== null) {
      const n = parseDollar(m[1]);
      if (n >= MIN_RENT && n <= MAX_RENT) prices.push(n);
    }
  }

  return prices;
}

// ── Statistics ─────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ── Bedroom ratios (from RealPage / Yardi national averages) ──────────────────

const R1_OF_R3 = 0.68;
const R2_OF_R3 = 0.84;
const R4_OF_R3 = 1.18;

// ── National fallback (when search finds nothing) ─────────────────────────────

const NATIONAL_FALLBACK: MarketRents = {
  rent1br: 950,
  rent2br: 1_200,
  rent3br: 1_450,
  rent4br: 1_700,
  source: 'fallback',
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Estimates market rents for a city by scraping active rental listings via
 * web search and extracting prices with regex — no LLM call required.
 *
 * Runs two searches in parallel:
 *   • "3 bedroom house for rent {city} {state}"   → 3BR anchor
 *   • "2 bedroom apartment for rent {city} {state}" → 2BR cross-check
 *
 * Missing bedroom counts are derived from empirical bedroom ratios.
 * Returns a MarketRents object compatible with the RentCast pipeline.
 */
export async function estimateMarketRents(
  cityName: string,
  state: string
): Promise<MarketRents> {
  const loc = `${cityName} ${state}`.trim();

  const queries = [
    `3 bedroom house for rent ${loc}`,
    `2 bedroom apartment for rent ${loc} per month`,
  ];

  logger.debug('Rental comps: searching', { cityName, state });

  const settled = await Promise.allSettled(
    queries.map(q => webSearch(q, 5))
  );

  const prices3br: number[] = [];
  const prices2br: number[] = [];

  if (settled[0].status === 'fulfilled') {
    for (const r of settled[0].value) {
      prices3br.push(...extractRentPrices(`${r.title} ${r.snippet} ${r.content}`));
    }
  } else {
    logger.warn('Rental comps: 3BR search failed', { error: String(settled[0].reason) });
  }

  if (settled[1].status === 'fulfilled') {
    for (const r of settled[1].value) {
      prices2br.push(...extractRentPrices(`${r.title} ${r.snippet} ${r.content}`));
    }
  } else {
    logger.warn('Rental comps: 2BR search failed', { error: String(settled[1].reason) });
  }

  const rent3br = median(prices3br);
  const rent2br = median(prices2br);
  const compCount = prices3br.length + prices2br.length;

  logger.info('Rental comps extracted', {
    cityName, state,
    prices3br: prices3br.length, rent3br,
    prices2br: prices2br.length, rent2br,
    compCount,
  });

  if (rent3br === 0 && rent2br === 0) {
    logger.warn('Rental comps: no prices found, using national fallback', { cityName, state });
    return NATIONAL_FALLBACK;
  }

  // Derive whichever anchor is missing
  const anchor3 = rent3br > 0 ? rent3br : Math.round(rent2br / R2_OF_R3);
  const anchor2 = rent2br > 0 ? rent2br : Math.round(anchor3 * R2_OF_R3);

  return {
    rent1br: Math.round(anchor3 * R1_OF_R3),
    rent2br: anchor2,
    rent3br: anchor3,
    rent4br: Math.round(anchor3 * R4_OF_R3),
    source: 'rental-comps',
  };
}
