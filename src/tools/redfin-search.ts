import { withRetry } from '../lib/retry';
import { logger } from '../lib/logger';
import { webSearch } from './web-search';

export interface RedfinListing {
  address: string;
  city: string;
  state: string;
  zipCode: string;
  price: number;
  beds: number;
  baths: number;
  sqft: number;
  url: string;
  daysOnMarket: number;
  propertyType: string; // 'Single Family Residential' | 'Multi-Family (2-4 Unit)' | etc.
}

// ── Hardcoded city → Redfin region ID lookup ──────────────────────────────────
// These IDs come from the Redfin city page URL pattern:
//   https://www.redfin.com/city/{regionId}/{state}/{cityName}
// region_type=6 = city, region_type=2 = zip code
//
// To add a city: search "site:redfin.com/city {CityName} {State}" and look for
// a URL like redfin.com/city/12345/...

const CITY_REGION_IDS: Record<string, { id: string; type: number }> = {
  // Alabama
  'Birmingham, AL': { id: '1823', type: 6 },
  'Huntsville, AL': { id: '9408', type: 6 },
  // Georgia
  'Atlanta, GA':    { id: '30756', type: 6 },
  'Augusta, GA':    { id: '36058', type: 6 },
  'Savannah, GA':   { id: '17651', type: 6 },
  // Florida
  'Jacksonville, FL': { id: '8907', type: 6 },
  'Orlando, FL':    { id: '13655', type: 6 },
  'Tampa, FL':      { id: '18142', type: 6 },
  // Tennessee
  'Memphis, TN':    { id: '12260', type: 6 },
  'Nashville, TN':  { id: '13415', type: 6 },
  // Indiana
  'Indianapolis, IN': { id: '9170', type: 6 },
  // Ohio
  'Cincinnati, OH': { id: '3879', type: 6 },
  'Cleveland, OH':  { id: '4145', type: 6 },
  'Columbus, OH':   { id: '4664', type: 6 },
  // Missouri (Kansas City not reliably found — falls back to dynamic lookup)
  // North Carolina
  'Charlotte, NC':  { id: '3105', type: 6 },
  // Texas
  'Houston, TX':    { id: '8903', type: 6 },
  'San Antonio, TX': { id: '16657', type: 6 },
  // Michigan
  'Detroit, MI':    { id: '5665', type: 6 },
  // Wisconsin
  'Milwaukee, WI':  { id: '35759', type: 6 },
  // Pennsylvania
  'Pittsburgh, PA': { id: '15702', type: 6 },
  // Maryland
  'Baltimore, MD':  { id: '1073', type: 6 },
  // Nevada
  'Las Vegas, NV':  { id: '10201', type: 6 },
  // Arizona
  'Tucson, AZ':     { id: '19459', type: 6 },
  // New Mexico
  'Albuquerque, NM': { id: '513', type: 6 },
  // Idaho
  'Boise, ID':      { id: '2287', type: 6 },
};

const GIS_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/csv, application/json, */*',
  'Referer': 'https://www.redfin.com/',
  'X-Requested-With': 'XMLHttpRequest',
};

// ── Region resolution ─────────────────────────────────────────────────────────

function normalizeCity(city: string): string {
  // Already "City, ST" format — just trim
  if (/,\s*[A-Z]{2}$/.test(city)) return city.trim();
  // Convert "City ST" → "City, ST"
  return city.replace(/\s+([A-Z]{2})$/, ', $1').trim();
}

async function resolveRegion(city: string): Promise<{ id: string; type: number } | null> {
  const normalized = normalizeCity(city);

  // Check hardcoded table first
  if (CITY_REGION_IDS[normalized]) {
    logger.debug('Redfin region from lookup table', { city: normalized, ...CITY_REGION_IDS[normalized] });
    return CITY_REGION_IDS[normalized];
  }

  // Dynamic lookup via web search
  const [cityName, state] = normalized.split(',').map(s => s.trim());
  logger.debug('Redfin region dynamic lookup', { city: normalized });

  try {
    const results = await webSearch(`site:redfin.com/city ${cityName} ${state}`, 3);
    for (const r of results) {
      const m = r.url.match(/redfin\.com\/city\/(\d+)\//);
      if (m) {
        logger.info('Redfin region found via search', { city: normalized, regionId: m[1] });
        return { id: m[1], type: 6 };
      }
    }
  } catch {
    // Non-fatal — fall through to null
  }

  logger.warn('Redfin: could not resolve region, will fall back to web search', { city: normalized });
  return null;
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

function parseGisCsv(csv: string): RedfinListing[] {
  const lines = csv.split('\n').filter(l => l.startsWith('MLS Listing'));
  const results: RedfinListing[] = [];

  for (const line of lines) {
    // CSV fields (0-indexed):
    // 0:SALE TYPE 1:SOLD DATE 2:PROPERTY TYPE 3:ADDRESS 4:CITY 5:STATE 6:ZIP
    // 7:PRICE 8:BEDS 9:BATHS 10:LOCATION 11:SQ FT 12:LOT SIZE 13:YEAR BUILT
    // 14:DAYS ON MARKET 15:$/SQFT 16:HOA/MONTH 17:STATUS 18:NEXT OPEN START
    // 19:NEXT OPEN END 20:URL 21:SOURCE 22:MLS# 23:FAV 24:INTERESTED
    // 25:LATITUDE 26:LONGITUDE
    const fields = parseCSVLine(line);
    if (fields.length < 21) continue;

    const price = parseFloat(fields[7]?.replace(/[^0-9.]/g, '') ?? '0');
    const beds = parseInt(fields[8] ?? '0', 10);
    const baths = parseFloat(fields[9] ?? '0');
    const sqft = parseInt(fields[11]?.replace(/[^0-9]/g, '') ?? '0', 10);
    const dom = parseInt(fields[14] ?? '0', 10);
    const url = fields[20]?.replace(/^"|"$/g, '').trim() ?? '';
    const propertyType = fields[2]?.replace(/^"|"$/g, '').trim() ?? '';
    const city = fields[4]?.replace(/^"|"$/g, '').trim() ?? '';
    const state = fields[5]?.replace(/^"|"$/g, '').trim() ?? '';
    const zip = fields[6]?.replace(/^"|"$/g, '').trim() ?? '';
    const address = fields[3]?.replace(/^"|"$/g, '').trim() ?? '';
    const fullAddress = `${address}, ${city}, ${state} ${zip}`.trim();

    if (price <= 0 || !address) continue;

    results.push({
      address: fullAddress,
      city,
      state,
      zipCode: zip,
      price,
      beds: isNaN(beds) ? 0 : beds,
      baths: isNaN(baths) ? 0 : baths,
      sqft: isNaN(sqft) ? 0 : sqft,
      url,
      daysOnMarket: isNaN(dom) ? 0 : dom,
      propertyType,
    });
  }

  return results;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ── Public search function ────────────────────────────────────────────────────

export async function searchRedfinListings(
  city: string,
  minPrice: number,
  maxPrice: number,
  maxResults = 100
): Promise<RedfinListing[]> {
  return withRetry(
    async () => {
      const region = await resolveRegion(city);
      if (!region) return [];

      const params = new URLSearchParams({
        al: '1',
        region_id: region.id,
        region_type: String(region.type),
        status: '1',       // active only
        uipt: '1,4',       // SFR(1) + multifamily(4)
        num: String(maxResults),
        min_price: String(minPrice),
        max_price: String(maxPrice),
        v: '8',
      });

      const url = `https://www.redfin.com/stingray/api/gis-csv?${params.toString()}`;
      logger.debug('Redfin GIS-CSV request', { city, regionId: region.id });

      const res = await fetch(url, { headers: GIS_HEADERS });
      if (!res.ok) {
        throw new Error(`Redfin GIS HTTP ${res.status}`);
      }

      const csv = await res.text();
      const listings = parseGisCsv(csv);
      logger.info('Redfin GIS-CSV results', { city, count: listings.length });
      return listings;
    },
    { label: `redfin-search-${city}` }
  );
}
