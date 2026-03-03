import { withRetry } from '../lib/retry';
import { logger } from '../lib/logger';
import { webSearch } from './web-search';

export interface PropertyData {
  address: string;
  owner?: string;
  assessedValue?: number;
  lastSalePrice?: number;
  lastSaleDate?: string;
  yearBuilt?: number;
  sqft?: number;
  beds?: number;
  baths?: number;
  zoning?: string;
  taxAmount?: number;
  source: 'attom' | 'web';
}

export interface RentalComp {
  address: string;
  beds: number;
  baths: number;
  monthlyRent: number;
  distance?: string;
  source: string;
}

// Phase 1: Web search fallback (no paid API needed)
// Phase 3: Uncomment ATTOM block below when ATTOM_API_KEY is available

export async function fetchPropertyData(address: string): Promise<PropertyData> {
  logger.debug('fetch_property_data', { address });

  // Phase 3 upgrade point: ATTOM API
  // if (process.env.ATTOM_API_KEY) {
  //   return fetchFromAttom(address);
  // }

  // Phase 1: Use web search to find property data
  const results = await webSearch(`${address} property records owner tax assessment`, 3);
  return {
    address,
    source: 'web',
    // Agent LLM will parse the web search results for structured data
  };
}

export async function fetchRentalComps(
  address: string,
  beds: number,
  city: string
): Promise<RentalComp[]> {
  logger.debug('fetch_rental_comps', { address, beds, city });

  // Phase 2 upgrade point: RentCast API
  // if (process.env.RENTCAST_API_KEY) {
  //   return fetchFromRentcast(address, beds);
  // }

  // Phase 1: Return empty array — agent will use web_search tool directly
  return [];
}

// Anthropic tool definition
export const FETCH_PROPERTY_DATA_TOOL = {
  name: 'fetch_property_data',
  description:
    'Fetch property details for a specific address including owner, assessed value, ' +
    'last sale price, year built, and basic property characteristics.',
  input_schema: {
    type: 'object' as const,
    properties: {
      address: {
        type: 'string',
        description: 'Full property address including city, state, and zip code.',
      },
    },
    required: ['address'],
  },
};
