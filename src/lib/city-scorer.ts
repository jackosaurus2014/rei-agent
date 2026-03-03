/**
 * city-scorer.ts
 *
 * Pure TypeScript city scoring. No LLM arithmetic.
 *
 * Takes raw factor data from the market research agent and applies:
 * 1. Min-max normalization per factor (→ 0–100 scale)
 * 2. Inversion for "lower is better" factors (crimeIndex, grossRentMultiplier)
 * 3. Weighted composite score
 * 4. Sorting + ranking
 */

import type { CityScore } from '../types';

// ── Raw data shape returned by the extraction tool ───────────────────────────

export interface CityRawData {
  city: string;
  state: string;           // 2-letter, e.g. "TN"
  populationGrowthPct: number | null;   // annual %, e.g. 1.8 for 1.8%
  jobGrowthPct: number | null;          // annual %
  wageGrowthPct: number | null;         // annual %
  rentGrowthPct: number | null;         // annual % change in rents
  medianGRM: number | null;             // price / annual rent, e.g. 11.2 — lower = better
  crimeIndexVsNational: number | null;  // 1.0 = national avg, 0.7 = 30% below — lower = better
  avgSchoolRating: number | null;       // 1–10 GreatSchools average
  landlordFriendlyScore: number | null; // 1–10 subjective score
  dataQuality: 'high' | 'medium' | 'low';
  notes: string;
}

// ── Scoring weights ───────────────────────────────────────────────────────────

const WEIGHTS: Record<string, number> = {
  populationGrowth:    0.20,
  jobGrowth:           0.20,
  wageGrowth:          0.10,
  rentGrowth:          0.15,
  grossRentMultiplier: 0.15,  // inverted
  crimeIndex:          0.10,  // inverted
  schoolQuality:       0.05,
  landlordFriendliness: 0.05,
};

// ── Normalization helpers ─────────────────────────────────────────────────────

function minMaxNormalize(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 50); // all equal → midpoint
  return values.map(v => ((v - min) / (max - min)) * 100);
}

function invertedMinMaxNormalize(values: number[]): number[] {
  // Lower raw value → higher score
  return minMaxNormalize(values).map(v => 100 - v);
}

// ── Main scoring function ─────────────────────────────────────────────────────

export function scoreCities(rawData: CityRawData[]): CityScore[] {
  // Discard cities with too many null factors — they can't be scored reliably.
  // Threshold is 5 (must have at least 3 real data points out of 8); nulls are
  // filled with the column median before scoring so partial data is usable.
  const viable = rawData.filter(c => {
    const nullCount = [
      c.populationGrowthPct, c.jobGrowthPct, c.wageGrowthPct,
      c.rentGrowthPct, c.medianGRM, c.crimeIndexVsNational,
      c.avgSchoolRating, c.landlordFriendlyScore,
    ].filter(v => v === null).length;
    return nullCount <= 5;
  });

  if (viable.length === 0) return [];

  // Fill nulls with column median before normalizing
  function fillNull(values: (number | null)[]): number[] {
    const valid = values.filter((v): v is number => v !== null);
    const median = valid.length > 0
      ? valid.sort((a, b) => a - b)[Math.floor(valid.length / 2)]
      : 0;
    return values.map(v => v ?? median);
  }

  const pop   = fillNull(viable.map(c => c.populationGrowthPct));
  const job   = fillNull(viable.map(c => c.jobGrowthPct));
  const wage  = fillNull(viable.map(c => c.wageGrowthPct));
  const rent  = fillNull(viable.map(c => c.rentGrowthPct));
  const grm   = fillNull(viable.map(c => c.medianGRM));
  const crime = fillNull(viable.map(c => c.crimeIndexVsNational));
  const school = fillNull(viable.map(c => c.avgSchoolRating));
  const ll    = fillNull(viable.map(c => c.landlordFriendlyScore));

  const normPop    = minMaxNormalize(pop);
  const normJob    = minMaxNormalize(job);
  const normWage   = minMaxNormalize(wage);
  const normRent   = minMaxNormalize(rent);
  const normGRM    = invertedMinMaxNormalize(grm);    // lower GRM = higher score
  const normCrime  = invertedMinMaxNormalize(crime);  // lower crime = higher score
  const normSchool = minMaxNormalize(school);
  const normLL     = minMaxNormalize(ll);

  const scored: CityScore[] = viable.map((c, i) => {
    const composite =
      normPop[i]    * WEIGHTS.populationGrowth +
      normJob[i]    * WEIGHTS.jobGrowth +
      normWage[i]   * WEIGHTS.wageGrowth +
      normRent[i]   * WEIGHTS.rentGrowth +
      normGRM[i]    * WEIGHTS.grossRentMultiplier +
      normCrime[i]  * WEIGHTS.crimeIndex +
      normSchool[i] * WEIGHTS.schoolQuality +
      normLL[i]     * WEIGHTS.landlordFriendliness;

    return {
      city: c.city,
      state: c.state,
      metro: `${c.city}, ${c.state}`,
      score: Math.round(composite * 10) / 10,
      rank: 0, // assigned after sorting
      factors: {
        populationGrowth:    Math.round(normPop[i] * 10) / 10,
        jobGrowth:           Math.round(normJob[i] * 10) / 10,
        wageGrowth:          Math.round(normWage[i] * 10) / 10,
        rentGrowth:          Math.round(normRent[i] * 10) / 10,
        grossRentMultiplier: Math.round(normGRM[i] * 10) / 10,
        crimeIndex:          Math.round(normCrime[i] * 10) / 10,
        schoolQuality:       Math.round(normSchool[i] * 10) / 10,
        landlordFriendliness: Math.round(normLL[i] * 10) / 10,
      },
      summary: c.notes || '',
    };
  });

  // Sort descending, assign ranks, return top 25
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 25)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}

// ── Raw factor helpers for markdown output ────────────────────────────────────

export function getRawFactors(raw: CityRawData): Record<string, string> {
  const fmt = (v: number | null, suffix: string) =>
    v === null ? 'N/A' : `${v > 0 ? '+' : ''}${v.toFixed(1)}${suffix}`;
  return {
    'Population Growth': fmt(raw.populationGrowthPct, '%/yr'),
    'Job Growth':        fmt(raw.jobGrowthPct, '%/yr'),
    'Wage Growth':       fmt(raw.wageGrowthPct, '%/yr'),
    'Rent Growth':       fmt(raw.rentGrowthPct, '%/yr'),
    'Median GRM':        raw.medianGRM === null ? 'N/A' : `${raw.medianGRM.toFixed(1)}x`,
    'Crime vs National': raw.crimeIndexVsNational === null ? 'N/A'
      : raw.crimeIndexVsNational < 1
        ? `${Math.round((1 - raw.crimeIndexVsNational) * 100)}% below avg`
        : `${Math.round((raw.crimeIndexVsNational - 1) * 100)}% above avg`,
    'School Quality':    raw.avgSchoolRating === null ? 'N/A' : `${raw.avgSchoolRating}/10`,
    'Landlord Score':    raw.landlordFriendlyScore === null ? 'N/A' : `${raw.landlordFriendlyScore}/10`,
    'Data Quality':      raw.dataQuality,
  };
}
