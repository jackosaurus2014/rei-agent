# API Setup Guide

This guide covers how to obtain each API key needed for the REI Agent System,
ordered from required to optional, with cost-efficient recommendations.

---

## Phase 1 — Required (Start Here)

### 1. Anthropic API Key
**Cost**: Pay-per-use (~$0.30–$0.80 per full deal analysis with current model settings)
**URL**: https://console.anthropic.com/

1. Create an account at console.anthropic.com
2. Go to **API Keys** → **Create Key**
3. Copy the key and add to `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

---

### 2. Tavily Search API
**Cost**: 1,000 free searches/month. After that, ~$0.001/search (Pay-as-you-go).
At 30–50 searches/deal analysis, the free tier covers 20–33 deal analyses/month.
**URL**: https://tavily.com/

1. Sign up at tavily.com
2. Go to **API Keys** in your dashboard
3. Copy the key and add to `.env`:
   ```
   TAVILY_API_KEY=tvly-...
   ```

**Why Tavily over Google/Bing?** Tavily returns clean extracted content (not
just URLs), is optimized for LLM consumption, and is significantly cheaper than
alternatives for the same quality.

---

## Phase 2 — Recommended (Better Rental Data)

### 3. RentCast API
**Cost**: Free tier: 50 API calls/month. Starter: $19/mo for 1,000 calls.
**When to add**: Once you want structured, reliable rental comp data instead of
relying on web search to find rent estimates.
**URL**: https://rentcast.io/

1. Sign up at rentcast.io
2. Go to **Account** → **API Keys**
3. Copy the key and add to `.env`:
   ```
   RENTCAST_API_KEY=...
   ```

**What it provides**: Average rent by zip/city/bed count, vacancy rates, rent
trend data, rental comps for specific addresses. Used by `UnderwritingAgent`
and `MarketIntelAgent`.

---

## Phase 3 — Scale (Authoritative Property Data)

### 4. ATTOM Data API
**Cost**: Free trial available. Production: $199/mo for the base plan.
**When to add**: When doing 50+ deals/month and you need authoritative ownership
history, lien data, deed transfers, and tax assessments without relying on
web search.
**URL**: https://www.attomdata.com/

1. Sign up at attomdata.com → **Developer Portal**
2. Request API access (usually approved within 1 business day)
3. Copy the key and add to `.env`:
   ```
   ATTOM_API_KEY=...
   ```

**What it provides**: Property detail, ownership history, deed transfers,
foreclosure status, tax assessment, AVM (automated valuation), lien data.
Used by `OwnerIntelAgent` and `PublicRecordsAgent`.

---

## Free APIs (No Cost)

### 5. U.S. Census Bureau API
**Cost**: Free. No usage limits for standard queries.
**URL**: https://api.census.gov/data/key_signup.html

1. Register at the URL above
2. You'll receive a key by email
3. Add to `.env`:
   ```
   CENSUS_API_KEY=...
   ```

**What it provides**: Official population, demographic, income, and housing
data at the city/metro/zip level. Used by `MarketResearchAgent` for population
and wage growth data.

**Note**: The agent works without this key (falls back to Tavily web search for
census data), but having the key provides faster and more accurate results.

---

### 6. EPA ECHO API
**Cost**: Free. No key required.
**URL**: https://echo.epa.gov/

No setup needed. The `LegalRiskAgent` queries this API directly at
`https://echo.epa.gov/echo/facility_search.json` to check for Superfund sites
and environmental compliance issues near a property.

---

## Setting Up Your .env File

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Then fill in the keys you have. For Phase 1 MVP, you only need:
```
ANTHROPIC_API_KEY=sk-ant-...
TAVILY_API_KEY=tvly-...
```

The system will log warnings (not errors) when optional API keys are missing,
and will fall back to web search for that data.

---

## Cost Estimation Calculator

| Scenario | Tavily Searches | Anthropic Tokens (est.) | Total Cost |
|---|---|---|---|
| 1 deal analysis | ~40 searches | ~80K tokens | ~$0.50 |
| 10 deal analyses | ~400 searches | ~800K tokens | ~$5.00 |
| Market research run | ~30 searches | ~60K tokens | ~$0.40 |
| Property scout (1 city) | ~20 searches | ~40K tokens | ~$0.25 |
| Full pipeline (1 city + 5 deals) | ~250 searches | ~500K tokens | ~$3.50 |

Estimates assume Phase 1 setup (Tavily + Anthropic only).
Tavily free tier (1,000/mo) covers the first ~20–25 deal analyses per month at no cost.
