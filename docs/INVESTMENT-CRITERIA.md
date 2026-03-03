# Investment Criteria Reference

This document explains the investment criteria used by the Deal Analyzer agent
to evaluate properties and produce verdicts.

---

## Hard Gates (Pass/Fail)

These are non-negotiable. If any hard gate fails, the verdict is PASS or
IMMEDIATE PASS regardless of other factors.

### 1. Cap Rate > Current Debt Cost
The property's capitalization rate must exceed the interest rate on the debt
used to finance it. If you're borrowing at 7.5%, the cap rate must be above
7.5% to avoid negative leverage (where debt hurts, not helps, your returns).

**Why it matters**: Negative leverage means every dollar of debt you add
*reduces* your returns. It means you're overpaying for the income stream.

**How calculated**:
```
Cap Rate = NOI / Purchase Price × 100
NOI = Effective Gross Income - Operating Expenses
```

### 2. DSCR > 1.25 at Standard Leverage (75% LTV)
Debt Service Coverage Ratio must exceed 1.25 when underwritten at 75% LTV.
This means the property generates 25% more income than needed to cover the
mortgage payment, providing a buffer for vacancies, repairs, and rate changes.

**Why 1.25?** Most commercial lenders require 1.20–1.25 DSCR to approve a
loan. Underwriting to 1.25 ensures you can actually finance the deal, not just
that it pencils on paper.

**How calculated**:
```
DSCR = NOI / Annual Debt Service
Annual Debt Service = Monthly Payment × 12
```

### 3. No Unresolved Title Defects
The property must have clean, marketable title. Any of the following are
automatic disqualifiers:
- Active mechanic's liens
- Disputed ownership / competing claims
- Unresolved estate issues
- Clouded title from prior fraudulent transfer
- Undisclosed easements that materially impair use

### 4. No Active Litigation Naming the Property or Owner
Active lawsuits naming the seller or property are red flags that can:
- Cloud title and delay/prevent closing
- Result in judgment liens attaching to the property
- Indicate undisclosed property defects (construction defect suits, etc.)
- Signal a distressed seller who may not disclose problems

### 5. No Superfund / Environmental Contamination
Properties within 0.5 miles of an EPA-listed Superfund site or with known
environmental contamination (underground storage tanks, industrial contamination)
are disqualified. Environmental remediation costs can exceed the property value.

---

## Scoring Factors (Advisory)

These factors inform the verdict and recommendation but don't automatically
disqualify a deal on their own.

### Submarket Trend
- **Growing**: Population and job growth above metro average → Favorable
- **Stable**: Average growth → Neutral
- **Declining**: Population loss, job contraction → Negative

A declining submarket can turn a mathematically sound deal into a long-term
value trap. Even strong cash flow today doesn't help if rents trend down 2%/yr
for the next decade.

### Rent Growth Trajectory
3-year rent CAGR for the submarket:
- > 4%/yr: Strong positive
- 2–4%/yr: Positive
- 0–2%/yr: Neutral
- Declining: Negative

### Vacancy Rate vs. Metro Average
- Submarket vacancy < metro avg: Positive (strong rental demand)
- Submarket vacancy = metro avg: Neutral
- Submarket vacancy > metro avg: Negative (soft rental market)

### Days on Market / Price Cuts
Indicators of seller motivation:
- 60+ days on market with price cuts: Potential motivated seller (good for negotiation)
- Priced above recent comps: May need to negotiate down
- Recent price cuts to near comp level: Fair market pricing

### School District Quality
- Top 20% statewide: Strong positive (attracts quality tenants, supports rents)
- Average: Neutral
- Below average: Minor negative (slightly harder to attract quality tenants)

School quality has a larger impact on SFR/small multifamily than on large
multifamily or commercial properties.

### Crime Index vs. Metro Average
- Significantly below average: Positive
- Near average: Neutral
- Significantly above average: Negative (impacts tenant quality, vacancy, insurance costs)

---

## Verdict Definitions

### STRONG BUY
All 5 hard gates pass AND 3 or more scoring factors are positive.
The deal is financially sound, legally clean, and in a favorable market.
Proceed to detailed due diligence with high confidence.

### BUY
All 5 hard gates pass. Scoring factors are mixed or neutral but nothing
materially negative. A solid deal worth pursuing.

### CONDITIONAL
All hard gates pass but there are 1–2 soft concerns (e.g., DSCR is 1.26 —
technically passing but thin; submarket is stable but not growing; one factor
needs follow-up verification). Proceed with additional due diligence on the
flagged items.

### PASS
One or more hard gates fail. The deal does not meet minimum investment criteria
at the current price/terms. May revisit if:
- Price is renegotiated (cap rate/DSCR issues)
- Seller resolves title/legal issues before close

### IMMEDIATE PASS
A critical red flag that makes the deal uninvestable regardless of other factors:
- Active title fraud or ownership dispute
- Known environmental contamination on-site
- Property subject to pending condemnation
- Seller involved in active bankruptcy that clouds title

Do not pursue. Do not waste further due diligence resources.

---

## Underwriting Assumptions

These defaults are used when specific data isn't available for a property.
Override via environment variables in `.env`.

| Assumption | Default | Env Var |
|---|---|---|
| Interest rate | 7.5% | ASSUMED_RATE |
| Amortization | 30 years | — |
| Vacancy rate | 8% | — |
| Operating expense ratio | 40% of gross rent | EXPENSE_RATIO |
| LTV scenarios | 65%, 70%, 75% | — |
| Minimum DSCR | 1.25 | MIN_DSCR |

**Expense ratio breakdown** (40% total):
- Vacancy/credit loss: 8%
- Property management: 10%
- Maintenance/repairs: 12%
- Insurance: 5%
- Property taxes: 5%

*Note: Property taxes vary significantly by state/county. The 5% default is a
rough estimate. Always verify actual tax amounts from the county assessor.*

---

## Risk-Adjusted Return Profile

The Deal Analyzer evaluates the overall risk-adjusted return by considering:

1. **Absolute return**: Is the cash-on-cash return acceptable for the risk?
   - < 4% CoC: Weak (below most alternative investments)
   - 4–6% CoC: Acceptable
   - 6–8% CoC: Good
   - > 8% CoC: Strong

2. **Risk factors that justify lower return thresholds**:
   - New construction / turnkey (lower maintenance risk)
   - Long-term tenant in place
   - Strong market fundamentals

3. **Risk factors that require higher return thresholds**:
   - Older construction (deferred maintenance risk)
   - Tertiary market
   - Higher crime area
   - Single-tenant SFR (binary vacancy risk)

The Legal Risk and Owner Intel agents specifically look for asymmetric downside
risks — scenarios where you could lose most or all of your investment — and flag
these as highest priority in the memo.
