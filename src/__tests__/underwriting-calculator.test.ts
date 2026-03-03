/**
 * @jest-environment node
 */

import {
  calcMonthlyPayment,
  computeUnderwriting,
  buildUnderwritingRiskFlags,
  type UnderwritingInputs,
} from '../lib/underwriting-calculator';

const BASE_INPUTS: UnderwritingInputs = {
  purchasePrice: 300000,
  monthlyRent: 2200,
  annualRate: 0.075,
  expenseRatio: 0.40,
  vacancyRate: 0.08,
  amortizationYears: 30,
};

// ── calcMonthlyPayment ────────────────────────────────────────────────────────

describe('calcMonthlyPayment', () => {
  it('computes standard 30yr payment correctly', () => {
    // $200k loan at 7.5% for 30 years ≈ $1,398/mo
    const payment = calcMonthlyPayment(200000, 0.075, 30);
    expect(payment).toBeCloseTo(1398.43, 0);
  });

  it('scales linearly with principal', () => {
    const p1 = calcMonthlyPayment(100000, 0.075, 30);
    const p2 = calcMonthlyPayment(200000, 0.075, 30);
    expect(p2).toBeCloseTo(p1 * 2, 1);
  });

  it('higher rate means higher payment', () => {
    const low = calcMonthlyPayment(200000, 0.065, 30);
    const high = calcMonthlyPayment(200000, 0.085, 30);
    expect(high).toBeGreaterThan(low);
  });

  it('longer amortization means lower payment', () => {
    const p15 = calcMonthlyPayment(200000, 0.075, 15);
    const p30 = calcMonthlyPayment(200000, 0.075, 30);
    expect(p30).toBeLessThan(p15);
  });

  it('handles zero rate without crashing', () => {
    const payment = calcMonthlyPayment(120000, 0, 30);
    expect(payment).toBeCloseTo(333.33, 1);
  });
});

// ── computeUnderwriting ───────────────────────────────────────────────────────

describe('computeUnderwriting — income analysis', () => {
  it('computes annual gross rent correctly', () => {
    const r = computeUnderwriting(BASE_INPUTS);
    expect(r.annualGrossRent).toBe(2200 * 12); // 26,400
  });

  it('applies vacancy rate to gross rent', () => {
    const r = computeUnderwriting(BASE_INPUTS);
    expect(r.effectiveGrossIncome).toBe(Math.round(26400 * 0.92));
  });

  it('applies expense ratio to effective gross income', () => {
    const r = computeUnderwriting(BASE_INPUTS);
    expect(r.operatingExpenses).toBe(Math.round(r.effectiveGrossIncome * 0.40));
  });

  it('NOI = EGI - operating expenses', () => {
    const r = computeUnderwriting(BASE_INPUTS);
    expect(r.noi).toBe(r.effectiveGrossIncome - r.operatingExpenses);
  });
});

describe('computeUnderwriting — cap rate and GRM', () => {
  it('cap rate = NOI / purchase price × 100', () => {
    const r = computeUnderwriting(BASE_INPUTS);
    const expectedCapRate = (r.noi / BASE_INPUTS.purchasePrice) * 100;
    expect(r.capRate).toBeCloseTo(expectedCapRate, 1);
  });

  it('GRM = purchase price / annual gross rent', () => {
    const r = computeUnderwriting(BASE_INPUTS);
    expect(r.grm).toBeCloseTo(300000 / 26400, 1);
  });
});

describe('computeUnderwriting — leverage scenarios', () => {
  it('LTV 75% loan amount is 75% of purchase price', () => {
    const r = computeUnderwriting(BASE_INPUTS);
    expect(r.scenarios.ltv75.loanAmount).toBe(Math.round(300000 * 0.75));
  });

  it('down payment + loan = purchase price', () => {
    const r = computeUnderwriting(BASE_INPUTS);
    for (const s of Object.values(r.scenarios)) {
      expect(s.loanAmount + s.downPayment).toBe(BASE_INPUTS.purchasePrice);
    }
  });

  it('DSCR = NOI / annual debt service', () => {
    const r = computeUnderwriting(BASE_INPUTS);
    const s75 = r.scenarios.ltv75;
    const expectedDscr = r.noi / s75.annualDebtService;
    expect(s75.dscr).toBeCloseTo(expectedDscr, 1);
  });

  it('DSCR improves at lower LTV', () => {
    const r = computeUnderwriting(BASE_INPUTS);
    expect(r.scenarios.ltv65.dscr).toBeGreaterThan(r.scenarios.ltv75.dscr);
    expect(r.scenarios.ltv70.dscr).toBeGreaterThan(r.scenarios.ltv75.dscr);
  });

  it('cash flow = NOI - annual debt service (monthly)', () => {
    const r = computeUnderwriting(BASE_INPUTS);
    const s75 = r.scenarios.ltv75;
    const expectedMonthlyCF = (r.noi - s75.annualDebtService) / 12;
    expect(s75.monthlyCashFlow).toBeCloseTo(expectedMonthlyCF, 0);
  });

  it('cash-on-cash = annual cash flow / down payment × 100', () => {
    const r = computeUnderwriting(BASE_INPUTS);
    const s75 = r.scenarios.ltv75;
    const expectedCoC = (s75.annualCashFlow / s75.downPayment) * 100;
    expect(s75.cashOnCash).toBeCloseTo(expectedCoC, 0);
  });
});

describe('computeUnderwriting — gate evaluations', () => {
  it('flags negative leverage when cap rate < rate', () => {
    // $500k, $2,000/mo — cap rate will be well below 7.5%
    const r = computeUnderwriting({ ...BASE_INPUTS, purchasePrice: 500000, monthlyRent: 2000 });
    expect(r.capRatePassesGate).toBe(false);
  });

  it('passes cap rate gate on high-yield property', () => {
    // $150k, $1,800/mo — cap rate ~8%+
    const r = computeUnderwriting({ ...BASE_INPUTS, purchasePrice: 150000, monthlyRent: 1800 });
    expect(r.capRatePassesGate).toBe(true);
  });

  it('fails DSCR gate on weak cash flow at 75% LTV', () => {
    const r = computeUnderwriting({ ...BASE_INPUTS, purchasePrice: 450000, monthlyRent: 2200 });
    expect(r.dscrPassesGate).toBe(false);
  });

  it('passes DSCR gate on strong cash flow property', () => {
    // $150k purchase, $2,000/mo rent
    const r = computeUnderwriting({ ...BASE_INPUTS, purchasePrice: 150000, monthlyRent: 2000 });
    expect(r.dscrPassesGate).toBe(true);
  });
});

// ── buildUnderwritingRiskFlags ────────────────────────────────────────────────

describe('buildUnderwritingRiskFlags', () => {
  it('returns no flags for a passing deal', () => {
    const r = computeUnderwriting({ ...BASE_INPUTS, purchasePrice: 150000, monthlyRent: 2000 });
    const flags = buildUnderwritingRiskFlags(r);
    expect(flags).toHaveLength(0);
  });

  it('flags negative leverage', () => {
    const r = computeUnderwriting({ ...BASE_INPUTS, purchasePrice: 500000, monthlyRent: 2000 });
    const flags = buildUnderwritingRiskFlags(r);
    expect(flags.some(f => f.toLowerCase().includes('negative leverage'))).toBe(true);
  });

  it('flags DSCR failure', () => {
    const r = computeUnderwriting({ ...BASE_INPUTS, purchasePrice: 450000, monthlyRent: 2200 });
    const flags = buildUnderwritingRiskFlags(r);
    expect(flags.some(f => f.toLowerCase().includes('dscr'))).toBe(true);
  });

  it('flags negative cash flow separately from DSCR', () => {
    const r = computeUnderwriting({ ...BASE_INPUTS, purchasePrice: 600000, monthlyRent: 2200 });
    const flags = buildUnderwritingRiskFlags(r);
    expect(flags.some(f => f.toLowerCase().includes('cash flow'))).toBe(true);
  });

  it('flags high GRM', () => {
    // $600k / ($2,200 × 12) = GRM of 22.7x
    const r = computeUnderwriting({ ...BASE_INPUTS, purchasePrice: 600000, monthlyRent: 2200 });
    const flags = buildUnderwritingRiskFlags(r);
    expect(flags.some(f => f.toLowerCase().includes('gross rent multiplier'))).toBe(true);
  });
});
