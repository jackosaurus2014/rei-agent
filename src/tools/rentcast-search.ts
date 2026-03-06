import { withRetry } from '../lib/retry';
import { logger } from '../lib/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RentCastListing {
  id: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  propertyType: string;
  beds: number;
  baths: number;
  sqft: number;
  yearBuilt: number;
  price: number;
  status: string;
  daysOnMarket: number;
  listedDate: string;
  url: string;
  mlsName: string;
  mlsNumber: string;
}

export interface RentEstimate {
  rent: number;
  rentRangeLow: number;
  rentRangeHigh: number;
}

export interface MarketRents {
  rent1br: number;
  rent2br: number;
  rent3br: number;
  rent4br: number;
  source: 'rentcast-market';
}

// ── Shared fetch ──────────────────────────────────────────────────────────────

const BASE = 'https://api.rentcast.io/v1';
const MAX_DOM = 270;  // ignore listings stale beyond this threshold

function apiKey(): string {
  const key = process.env.RENTCAST_API_KEY;
  if (!key) throw new Error('RENTCAST_API_KEY not set — add it to .env');
  return key;
}

async function rentcastGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  ).toString();
  const url = `${BASE}${path}?${qs}`;
  logger.debug('RentCast request', { path, params });

  const res = await fetch(url, {
    headers: { 'X-Api-Key': apiKey(), 'Accept': 'application/json' },
  });

  if (res.status === 401) {
    throw new Error(
      'RentCast API key inactive. Activate your subscription at https://app.rentcast.io/app/api'
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`RentCast HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

// ── Sale listings ─────────────────────────────────────────────────────────────

type RawListing = {
  id?: string;
  formattedAddress?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  yearBuilt?: number;
  price?: number;
  status?: string;
  daysOnMarket?: number;
  listedDate?: string;
  mlsName?: string;
  mlsNumber?: string;
};

export async function searchActiveListings(
  city: string,
  state: string,
  minPrice: number,
  maxPrice: number
): Promise<RentCastListing[]> {
  return withRetry(
    async () => {
      const raw = await rentcastGet<RawListing[]>('/listings/sale', {
        city,
        state,
        status: 'Active',
        // price range in "min-max" format per RentCast docs
        price: `${minPrice}-${maxPrice}`,
        // Filter to investment-relevant types
        propertyType: 'Single Family,Multi-Family',
        limit: 500,
      });

      if (!Array.isArray(raw)) {
        logger.warn('RentCast listings: unexpected response shape', { city, state });
        return [];
      }

      logger.info('RentCast listings received', { city, state, count: raw.length });

      return raw
        .filter(r => {
          const dom = r.daysOnMarket ?? 0;
          return dom <= MAX_DOM;
        })
        .map(r => ({
          id: r.id ?? '',
          address: r.formattedAddress ?? `${r.addressLine1 ?? ''}, ${r.city ?? city}, ${r.state ?? state} ${r.zipCode ?? ''}`.trim(),
          city: r.city ?? city,
          state: r.state ?? state,
          zipCode: r.zipCode ?? '',
          propertyType: r.propertyType ?? 'Single Family',
          beds: r.bedrooms ?? 0,
          baths: r.bathrooms ?? 0,
          sqft: r.squareFootage ?? 0,
          yearBuilt: r.yearBuilt ?? 0,
          price: r.price ?? 0,
          status: r.status ?? 'Active',
          daysOnMarket: r.daysOnMarket ?? 0,
          listedDate: r.listedDate ?? '',
          url: r.mlsNumber
            ? `https://www.redfin.com/search#listing-type=1&mls-listing-id=${r.mlsNumber}`
            : '',
          mlsName: r.mlsName ?? '',
          mlsNumber: r.mlsNumber ?? '',
        }))
        .filter(l => l.price > 0);
    },
    { label: `rentcast-listings-${city}-${state}` }
  );
}

// ── Rent AVM ──────────────────────────────────────────────────────────────────

type RawRentEstimate = {
  rent?: number;
  rentRangeLow?: number;
  rentRangeHigh?: number;
  price?: number;          // some endpoints return 'price' instead of 'rent'
  priceLow?: number;
  priceHigh?: number;
};

export async function getRentEstimate(
  address: string,
  city: string,
  state: string,
  beds: number,
  baths: number,
  sqft: number
): Promise<RentEstimate | null> {
  return withRetry(
    async () => {
      const params: Record<string, string | number> = {
        address: `${address}, ${city}, ${state}`,
      };
      if (beds > 0)  params.bedrooms = beds;
      if (baths > 0) params.bathrooms = baths;
      if (sqft > 0)  params.squareFootage = sqft;

      const raw = await rentcastGet<RawRentEstimate>('/avm/rent/long-term', params);

      const rent = raw.rent ?? raw.price ?? 0;
      if (rent <= 0) return null;

      return {
        rent,
        rentRangeLow:  raw.rentRangeLow  ?? raw.priceLow  ?? Math.round(rent * 0.9),
        rentRangeHigh: raw.rentRangeHigh ?? raw.priceHigh ?? Math.round(rent * 1.1),
      };
    },
    { label: `rentcast-rent-avm-${address.slice(0, 30)}` }
  ).catch(err => {
    logger.warn('RentCast rent AVM failed', {
      address,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
}

// ── Market rents (bulk — one call per city) ───────────────────────────────────

type RawMarket = {
  // RentCast market stats — field names vary; handle both observed patterns
  rentalData?: {
    averageRent?: number;
    averageRentsByBedrooms?: Record<string, number>;
    medianRent?: number;
  };
  // flat structure (some tiers)
  averageRent?: number;
  averageRentsByBedrooms?: Record<string, number>;
};

const NATIONAL_FALLBACK: MarketRents = {
  rent1br: 950,
  rent2br: 1200,
  rent3br: 1450,
  rent4br: 1700,
  source: 'rentcast-market',
};

export async function getMarketRents(
  city: string,
  state: string,
  zipCode?: string
): Promise<MarketRents> {
  const result = await withRetry(
    async () => {
      const params: Record<string, string> = zipCode
        ? { zipCode }
        : { city, state };

      const raw = await rentcastGet<RawMarket>('/markets', params);

      // Normalize — RentCast may nest or flatten depending on plan
      const byBed: Record<string, number> =
        raw?.rentalData?.averageRentsByBedrooms ??
        raw?.averageRentsByBedrooms ??
        {};

      const get = (key: string, fallback: number) =>
        byBed[key] ?? byBed[key.replace('br', '')] ?? fallback;

      const baseRent =
        raw?.rentalData?.averageRent ??
        raw?.rentalData?.medianRent ??
        raw?.averageRent ??
        0;

      if (!baseRent && Object.keys(byBed).length === 0) {
        logger.warn('RentCast markets returned no rent data', { city, state });
        return null;
      }

      // Build lookup from by-bedroom data or estimate from base rent
      const r3 = get('3br', 0) || get('3', 0) || Math.round(baseRent);
      const r2 = get('2br', 0) || get('2', 0) || Math.round(r3 * 0.84);
      const r1 = get('1br', 0) || get('1', 0) || Math.round(r3 * 0.68);
      const r4 = get('4br', 0) || get('4', 0) || Math.round(r3 * 1.18);

      logger.info('RentCast market rents', { city, state, r1, r2, r3, r4 });
      return { rent1br: r1, rent2br: r2, rent3br: r3, rent4br: r4, source: 'rentcast-market' as const };
    },
    { label: `rentcast-markets-${city}-${state}` }
  ).catch(err => {
    logger.warn('RentCast market stats failed', {
      city,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  return result ?? NATIONAL_FALLBACK;
}

// ── Availability check ────────────────────────────────────────────────────────

export function isRentCastAvailable(): boolean {
  return Boolean(process.env.RENTCAST_API_KEY);
}
