/**
 * @jest-environment node
 */

// Tests for memo-compiler helper logic (non-LLM parts)
// The LLM synthesis call is not tested here — integration tests cover that.

import type { SubAgentResult } from '../types';

function makeResult(
  category: SubAgentResult['category'],
  overrides: Partial<SubAgentResult> = {}
): SubAgentResult {
  return {
    category,
    findings: `Sample findings for ${category}`,
    riskFlags: [],
    confidence: 'high',
    searchesPerformed: 5,
    ...overrides,
  };
}

describe('SubAgentResult structure', () => {
  it('has all required fields', () => {
    const result = makeResult('underwriting');
    expect(result.category).toBe('underwriting');
    expect(result.findings).toBeTruthy();
    expect(Array.isArray(result.riskFlags)).toBe(true);
    expect(['high', 'medium', 'low']).toContain(result.confidence);
    expect(typeof result.searchesPerformed).toBe('number');
  });

  it('collects risk flags from all categories', () => {
    const results = [
      makeResult('owner_intel', { riskFlags: ['Lien found: $12,000'] }),
      makeResult('market_intel', { riskFlags: [] }),
      makeResult('public_records', { riskFlags: ['Open permit: unpermitted addition'] }),
      makeResult('underwriting', { riskFlags: ['DSCR below threshold: 1.18'] }),
      makeResult('legal_risk', { riskFlags: [] }),
    ];

    const allFlags = results.flatMap(r => r.riskFlags);
    expect(allFlags).toHaveLength(3);
    expect(allFlags).toContain('Lien found: $12,000');
    expect(allFlags).toContain('DSCR below threshold: 1.18');
  });
});

describe('DSCR calculation', () => {
  // Mirrors the underwriting math from DESIGN.md
  function calcDSCR(
    monthlyRent: number,
    purchasePrice: number,
    ltv: number,
    annualRate = 0.075,
    expenseRatio = 0.40
  ): number {
    const grossAnnual = monthlyRent * 12;
    const effectiveGross = grossAnnual * 0.92; // 8% vacancy
    const noi = effectiveGross * (1 - expenseRatio);
    const loanAmount = purchasePrice * ltv;
    const monthlyRate = annualRate / 12;
    const n = 360; // 30 years
    const monthlyPayment =
      loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, n)) /
      (Math.pow(1 + monthlyRate, n) - 1);
    const annualDebtService = monthlyPayment * 12;
    return noi / annualDebtService;
  }

  it('passes DSCR gate for high-cap-rate market property', () => {
    // $150k property, $2,000/mo rent — realistic in markets like Memphis/Birmingham
    // Rent-to-price ratio ~1.33% makes this pencil at 7.5% / 75% LTV
    const dscr = calcDSCR(2000, 150000, 0.75);
    expect(dscr).toBeGreaterThan(1.25);
  });

  it('fails DSCR gate for overpriced coastal market property', () => {
    // $600k property, $2,500/mo rent — typical coastal market; rent can't support price
    const dscr = calcDSCR(2500, 600000, 0.75);
    expect(dscr).toBeLessThan(1.25);
  });

  it('DSCR improves with lower LTV', () => {
    const dscr65 = calcDSCR(2500, 500000, 0.65);
    const dscr75 = calcDSCR(2500, 500000, 0.75);
    expect(dscr65).toBeGreaterThan(dscr75);
  });
});

describe('Cap rate calculation', () => {
  function calcCapRate(
    monthlyRent: number,
    purchasePrice: number,
    expenseRatio = 0.40
  ): number {
    const grossAnnual = monthlyRent * 12;
    const effectiveGross = grossAnnual * 0.92;
    const noi = effectiveGross * (1 - expenseRatio);
    return (noi / purchasePrice) * 100;
  }

  it('returns correct cap rate for well-priced property', () => {
    // $300k property, $2,500/mo rent
    const capRate = calcCapRate(2500, 300000);
    expect(capRate).toBeGreaterThan(5);
    expect(capRate).toBeLessThan(10);
  });

  it('flags negative leverage when cap rate below debt cost', () => {
    // $700k property, $3,000/mo rent — cap rate will be below 7.5%
    const capRate = calcCapRate(3000, 700000);
    const assumedRate = 7.5;
    expect(capRate).toBeLessThan(assumedRate);
  });
});
