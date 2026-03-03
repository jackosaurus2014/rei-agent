// ============================================================
// Shared types used across all agents
// ============================================================

export type SubAgentCategory =
  | 'owner_intel'
  | 'market_intel'
  | 'public_records'
  | 'underwriting'
  | 'legal_risk';

export type Confidence = 'high' | 'medium' | 'low';

export type Verdict =
  | 'STRONG BUY'
  | 'BUY'
  | 'CONDITIONAL'
  | 'PASS'
  | 'IMMEDIATE PASS';

export interface SubAgentResult {
  category: SubAgentCategory;
  findings: string;           // Markdown prose findings
  riskFlags: string[];        // Red flags (empty = none found)
  data?: Record<string, unknown>; // Structured data (numbers for underwriting)
  confidence: Confidence;
  searchesPerformed: number;
}

export interface DealInput {
  address: string;
  purchasePrice: number;
  propertyType: 'sfr' | 'multifamily' | 'condo';
  bedrooms?: number;
  units?: number;             // For multifamily
  askingRent?: number;        // Monthly asking rent (optional — agents will research if not provided)
}

export interface InvestmentMemo {
  address: string;
  date: string;
  purchasePrice: number;
  verdict: Verdict;
  keyReasons: string[];
  riskFactors: string[];
  ownerIntel: SubAgentResult;
  marketIntel: SubAgentResult;
  publicRecords: SubAgentResult;
  underwriting: SubAgentResult;
  legalRisk: SubAgentResult;
  finalRecommendation: string;
  rawMarkdown: string;
}

export interface CityScore {
  city: string;
  state: string;
  metro: string;
  score: number;              // 0–100 weighted score
  rank: number;
  factors: {
    populationGrowth: number;
    jobGrowth: number;
    wageGrowth: number;
    rentGrowth: number;
    grossRentMultiplier: number;
    crimeIndex: number;       // Lower = better (inverted for scoring)
    schoolQuality: number;
    landlordFriendliness: number;
  };
  summary: string;
}

export interface PropertyListing {
  address: string;
  city: string;
  state: string;
  zipCode: string;
  price: number;
  beds: number;
  baths: number;
  sqft?: number;
  estimatedMonthlyRent: number;
  estimatedCapRate: number;
  estimatedGRM: number;
  source: string;             // 'zillow' | 'redfin' | 'realtor' | 'web'
  url?: string;
  notes: string;
}
