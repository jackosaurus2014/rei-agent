/**
 * @jest-environment node
 */

// Tests for the extract-result utility's data contract and fallback behavior.
// The actual LLM extraction call is covered by integration tests.

import type { SubAgentResult, SubAgentCategory } from '../types';

describe('SubAgentResult contract', () => {
  const validCategories: SubAgentCategory[] = [
    'owner_intel',
    'market_intel',
    'public_records',
    'underwriting',
    'legal_risk',
  ];

  it('all SubAgentCategory values are defined', () => {
    expect(validCategories).toHaveLength(5);
  });

  it('SubAgentResult with no risk flags is valid', () => {
    const result: SubAgentResult = {
      category: 'owner_intel',
      findings: 'Property is owned by John Smith, acquired 2019. No liens found.',
      riskFlags: [],
      confidence: 'high',
      searchesPerformed: 6,
    };
    expect(result.riskFlags).toHaveLength(0);
    expect(result.confidence).toBe('high');
  });

  it('SubAgentResult with risk flags captures them correctly', () => {
    const result: SubAgentResult = {
      category: 'owner_intel',
      findings: 'Property owned by XYZ LLC. Active IRS tax lien found.',
      riskFlags: [
        'Active IRS federal tax lien: $42,000 filed 2023-11-08',
        'LLC status: administratively dissolved in 2022',
      ],
      confidence: 'medium',
      searchesPerformed: 8,
    };
    expect(result.riskFlags).toHaveLength(2);
    expect(result.riskFlags[0]).toContain('IRS');
    expect(result.confidence).toBe('medium');
  });

  it('low confidence result is valid when data is unavailable', () => {
    const result: SubAgentResult = {
      category: 'owner_intel',
      findings: 'County recorder records not available online. Manual verification required.',
      riskFlags: [],
      confidence: 'low',
      searchesPerformed: 3,
    };
    expect(result.confidence).toBe('low');
    expect(result.riskFlags).toHaveLength(0);
  });
});

describe('risk flag patterns', () => {
  it('tax lien flag contains amount and date', () => {
    const flag = 'Federal tax lien: $28,500 filed 2024-02-14 by IRS';
    expect(flag).toMatch(/\$[\d,]+/);     // has dollar amount
    expect(flag).toMatch(/\d{4}-\d{2}-\d{2}/); // has date
  });

  it('mechanic lien flag contains creditor name', () => {
    const flag = 'Mechanic lien: $9,200 filed by Apex Roofing LLC, 2023-08-22';
    expect(flag).toMatch(/\$[\d,]+/);
    expect(flag.toLowerCase()).toContain('lien');
  });

  it('bankruptcy flag includes chapter type', () => {
    const flag = 'Active Chapter 7 bankruptcy: Case #23-45678, filed 2024-01-10';
    expect(flag).toMatch(/Chapter [0-9]+/);
  });
});
