import { logger } from '../lib/logger';
import { withRetry } from '../lib/retry';

export type RecordType = 'ownership' | 'zoning' | 'permits' | 'liens' | 'tax_history';

export interface PublicRecord {
  type: RecordType;
  address: string;
  data: string;       // Raw text — agent LLM parses for insights
  source: string;
}

export async function lookupPublicRecords(
  address: string,
  type: RecordType
): Promise<PublicRecord> {
  logger.debug('lookup_public_records', { address, type });

  // EPA ECHO — free environmental data
  if (type === 'zoning' || type === 'permits') {
    return {
      type,
      address,
      data: `Web search required for ${type} data. Use web_search tool with: "${address} ${type} county records"`,
      source: 'web_fallback',
    };
  }

  // For liens: Phase 1 uses web search, Phase 3 uses ATTOM
  return {
    type,
    address,
    data: `Use web_search tool to find ${type} records for: ${address}`,
    source: 'web_fallback',
  };
}

export async function checkEnvironmental(address: string, radiusMiles = 0.5): Promise<string> {
  logger.debug('check_environmental', { address, radiusMiles });

  // EPA ECHO API — free, no key required
  try {
    const encoded = encodeURIComponent(address);
    const url = `https://echo.epa.gov/echo/facility_search.json?address=${encoded}&p_radius=${radiusMiles}&output=JSON`;

    const response = await withRetry(
      () => fetch(url).then(r => r.json()) as Promise<Record<string, unknown>>,
      { label: 'epa_echo' }
    );

    const results = response?.Results as Record<string, unknown> | undefined;
    const facilities = (results?.Facilities as unknown[]) ?? [];
    if (facilities.length === 0) {
      return `No EPA-regulated facilities found within ${radiusMiles} miles of ${address}.`;
    }

    const summary = facilities
      .slice(0, 5)
      .map((f) => { const fac = f as Record<string, string>; return `- ${fac.FacilityName} (${fac.FacilityCity}, ${fac.FacilityState}) — ${fac.SICCodes ?? 'Unknown type'}`; })
      .join('\n');

    return `Found ${facilities.length} EPA-regulated facilities within ${radiusMiles} miles:\n${summary}`;
  } catch {
    return `EPA ECHO lookup unavailable. Recommend manual check at echo.epa.gov for ${address}.`;
  }
}

// Anthropic tool definitions
export const LOOKUP_PUBLIC_RECORDS_TOOL = {
  name: 'lookup_public_records',
  description:
    'Look up public records for a property address including ownership history, ' +
    'zoning classification, building permits, liens, and tax history.',
  input_schema: {
    type: 'object' as const,
    properties: {
      address: {
        type: 'string',
        description: 'Full property address.',
      },
      type: {
        type: 'string',
        enum: ['ownership', 'zoning', 'permits', 'liens', 'tax_history'],
        description: 'Type of public record to retrieve.',
      },
    },
    required: ['address', 'type'],
  },
};

export const CHECK_ENVIRONMENTAL_TOOL = {
  name: 'check_environmental',
  description:
    'Check EPA ECHO database for environmental compliance issues, Superfund sites, ' +
    'and regulated facilities near a property address.',
  input_schema: {
    type: 'object' as const,
    properties: {
      address: {
        type: 'string',
        description: 'Full property address.',
      },
      radius_miles: {
        type: 'number',
        description: 'Search radius in miles (default 0.5).',
      },
    },
    required: ['address'],
  },
};
