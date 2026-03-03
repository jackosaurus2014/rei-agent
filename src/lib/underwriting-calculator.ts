/**
 * Underwriting Calculator
 *
 * Pure TypeScript financial math — no LLM involvement.
 * All inputs are explicit; all outputs are deterministic.
 * Unit-tested in src/__tests__/underwriting-calculator.test.ts
 */

export interface UnderwritingInputs {
  purchasePrice: number;
  monthlyRent: number;
  annualRate: number;       // decimal, e.g. 0.075 for 7.5%
  expenseRatio: number;     // decimal, e.g. 0.40 for 40%
  vacancyRate: number;      // decimal, e.g. 0.08 for 8%
  amortizationYears: number; // e.g. 30
}

export interface LeverageScenario {
  ltv: number;              // decimal, e.g. 0.75
  ltvPercent: number;       // whole number, e.g. 75
  loanAmount: number;
  downPayment: number;
  monthlyPayment: number;
  annualDebtService: number;
  dscr: number;
  monthlyCashFlow: number;
  annualCashFlow: number;
  cashOnCash: number;       // percentage, e.g. 8.5 for 8.5%
}

export interface UnderwritingResults {
  // ── Inputs (echoed for reference) ──
  purchasePrice: number;
  estimatedMonthlyRent: number;
  annualRate: number;
  annualRatePercent: number;
  expenseRatio: number;
  vacancyRate: number;

  // ── Income analysis ──
  annualGrossRent: number;
  effectiveGrossIncome: number;   // after vacancy
  operatingExpenses: number;
  noi: number;                    // net operating income

  // ── Unlevered returns ──
  capRate: number;                // percentage, e.g. 6.8 for 6.8%
  grm: number;                    // gross rent multiplier

  // ── Levered scenarios ──
  scenarios: {
    ltv65: LeverageScenario;
    ltv70: LeverageScenario;
    ltv75: LeverageScenario;
  };

  // ── Gate evaluations ──
  assumedRatePercent: number;
  minDscr: number;
  capRatePassesGate: boolean;     // cap rate > debt cost
  dscrPassesGate: boolean;        // DSCR at 75% LTV > minDscr
}

// ── Core math ────────────────────────────────────────────────────────────────

/**
 * Monthly mortgage payment using standard amortization formula.
 * P × [r(1+r)^n] / [(1+r)^n - 1]
 */
export function calcMonthlyPayment(
  principal: number,
  annualRate: number,
  amortizationYears: number
): number {
  if (annualRate === 0) return principal / (amortizationYears * 12);
  const r = annualRate / 12;
  const n = amortizationYears * 12;
  const factor = Math.pow(1 + r, n);
  return principal * (r * factor) / (factor - 1);
}

/**
 * Compute all underwriting metrics from inputs.
 */
export function computeUnderwriting(inputs: UnderwritingInputs): UnderwritingResults {
  const {
    purchasePrice,
    monthlyRent,
    annualRate,
    expenseRatio,
    vacancyRate,
    amortizationYears,
  } = inputs;

  // ── Income ──
  const annualGrossRent = monthlyRent * 12;
  const effectiveGrossIncome = annualGrossRent * (1 - vacancyRate);
  const operatingExpenses = effectiveGrossIncome * expenseRatio;
  const noi = effectiveGrossIncome - operatingExpenses;

  // ── Unlevered ──
  const capRate = (noi / purchasePrice) * 100;
  const grm = purchasePrice / annualGrossRent;

  // ── Levered scenarios ──
  function buildScenario(ltv: number): LeverageScenario {
    const loanAmount = purchasePrice * ltv;
    const downPayment = purchasePrice - loanAmount;
    const monthlyPayment = calcMonthlyPayment(loanAmount, annualRate, amortizationYears);
    const annualDebtService = monthlyPayment * 12;
    const dscr = noi / annualDebtService;
    const annualCashFlow = noi - annualDebtService;
    const monthlyCashFlow = annualCashFlow / 12;
    const cashOnCash = (annualCashFlow / downPayment) * 100;

    return {
      ltv,
      ltvPercent: Math.round(ltv * 100),
      loanAmount: Math.round(loanAmount),
      downPayment: Math.round(downPayment),
      monthlyPayment: Math.round(monthlyPayment),
      annualDebtService: Math.round(annualDebtService),
      dscr: Math.round(dscr * 100) / 100,
      monthlyCashFlow: Math.round(monthlyCashFlow),
      annualCashFlow: Math.round(annualCashFlow),
      cashOnCash: Math.round(cashOnCash * 10) / 10,
    };
  }

  const assumedRatePercent = annualRate * 100;
  const minDscr = Number(process.env.MIN_DSCR ?? 1.25);
  const ltv75 = buildScenario(0.75);

  return {
    purchasePrice,
    estimatedMonthlyRent: monthlyRent,
    annualRate,
    annualRatePercent: Math.round(assumedRatePercent * 10) / 10,
    expenseRatio,
    vacancyRate,
    annualGrossRent: Math.round(annualGrossRent),
    effectiveGrossIncome: Math.round(effectiveGrossIncome),
    operatingExpenses: Math.round(operatingExpenses),
    noi: Math.round(noi),
    capRate: Math.round(capRate * 100) / 100,
    grm: Math.round(grm * 10) / 10,
    scenarios: {
      ltv65: buildScenario(0.65),
      ltv70: buildScenario(0.70),
      ltv75,
    },
    assumedRatePercent,
    minDscr,
    capRatePassesGate: capRate > assumedRatePercent,
    dscrPassesGate: ltv75.dscr >= minDscr,
  };
}

// ── Formatted findings text ───────────────────────────────────────────────────

export function buildUnderwritingFindings(
  results: UnderwritingResults,
  marketContext: string,
  rentRange: { low: number; high: number }
): string {
  const fmt = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const fmtPct = (n: number) => `${n.toFixed(2)}%`;
  const fmtRatio = (n: number) => n.toFixed(2);
  const pass = (b: boolean) => (b ? '✓ PASS' : '✗ FAIL');

  const { scenarios } = results;

  const scenarioRow = (s: LeverageScenario) =>
    `| ${s.ltvPercent}% | ${fmt(s.loanAmount)} | ${fmt(s.downPayment)} | ${fmt(s.monthlyPayment)}/mo | ${fmtRatio(s.dscr)} | ${fmt(s.monthlyCashFlow)}/mo | ${s.cashOnCash.toFixed(1)}% |`;

  return `## Rent Research

${marketContext}

**Estimated Monthly Rent**: ${fmt(results.estimatedMonthlyRent)}/mo
**Rent Range (market comps)**: ${fmt(rentRange.low)} – ${fmt(rentRange.high)}/mo

---

## Income Analysis

| Line Item | Annual | Monthly |
|---|---|---|
| Gross Rent (0% vacancy) | ${fmt(results.annualGrossRent)} | ${fmt(results.estimatedMonthlyRent)} |
| Vacancy Allowance (${Math.round(results.vacancyRate * 100)}%) | (${fmt(results.annualGrossRent * results.vacancyRate)}) | — |
| Effective Gross Income | ${fmt(results.effectiveGrossIncome)} | ${fmt(results.effectiveGrossIncome / 12)} |
| Operating Expenses (${Math.round(results.expenseRatio * 100)}%) | (${fmt(results.operatingExpenses)}) | — |
| **Net Operating Income** | **${fmt(results.noi)}** | **${fmt(results.noi / 12)}** |

---

## Unlevered Returns

| Metric | Value |
|---|---|
| Cap Rate | ${fmtPct(results.capRate)} |
| Gross Rent Multiplier | ${results.grm.toFixed(1)}x |
| Assumed Debt Cost | ${fmtPct(results.annualRatePercent)} |
| **Cap Rate vs Debt Cost** | **${pass(results.capRatePassesGate)}** |

---

## Leverage Analysis (${fmtPct(results.annualRatePercent)} rate, 30yr am)

| LTV | Loan | Down Payment | Payment | DSCR | Cash Flow | CoC |
|---|---|---|---|---|---|---|
${scenarioRow(scenarios.ltv65)}
${scenarioRow(scenarios.ltv70)}
${scenarioRow(scenarios.ltv75)}

**DSCR at 75% LTV: ${fmtRatio(scenarios.ltv75.dscr)} — ${pass(results.dscrPassesGate)}** (threshold: ${results.minDscr})

---

## Gate Summary

| Gate | Result | Value | Threshold |
|---|---|---|---|
| Cap Rate > Debt Cost | ${pass(results.capRatePassesGate)} | ${fmtPct(results.capRate)} | > ${fmtPct(results.annualRatePercent)} |
| DSCR ≥ ${results.minDscr} (75% LTV) | ${pass(results.dscrPassesGate)} | ${fmtRatio(scenarios.ltv75.dscr)} | ≥ ${results.minDscr} |`;
}

// ── Risk flags from computed numbers ─────────────────────────────────────────

export function buildUnderwritingRiskFlags(results: UnderwritingResults): string[] {
  const flags: string[] = [];
  const { scenarios } = results;

  if (!results.capRatePassesGate) {
    flags.push(
      `Negative leverage: cap rate ${results.capRate.toFixed(2)}% is below debt cost ${results.annualRatePercent.toFixed(2)}% — borrowing hurts returns`
    );
  }

  if (!results.dscrPassesGate) {
    flags.push(
      `DSCR at 75% LTV is ${scenarios.ltv75.dscr.toFixed(2)} — below the ${results.minDscr} threshold; property does not cash flow at standard leverage`
    );
  }

  if (scenarios.ltv70.dscr < results.minDscr) {
    flags.push(
      `DSCR fails at 70% LTV (${scenarios.ltv70.dscr.toFixed(2)}) — deal only pencils at 65% LTV or lower, requiring larger down payment`
    );
  }

  if (scenarios.ltv75.monthlyCashFlow < 0) {
    flags.push(
      `Negative monthly cash flow at 75% LTV: ${scenarios.ltv75.monthlyCashFlow < 0 ? '-' : '+'}$${Math.abs(scenarios.ltv75.monthlyCashFlow).toLocaleString()}/mo — property is cash-flow negative`
    );
  }

  if (results.grm > 20) {
    flags.push(
      `High gross rent multiplier: ${results.grm.toFixed(1)}x — price is ${results.grm.toFixed(1)} years of gross rent; typical investor threshold is 12–16x`
    );
  }

  return flags;
}
