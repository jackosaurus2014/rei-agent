import { withRetry } from '../lib/retry';
import { logger } from '../lib/logger';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content: string;
}

// ── Tavily ────────────────────────────────────────────────────────────────────

type TavilyClientType = { search: (query: string, options?: Record<string, unknown>) => Promise<{ results: SearchResult[] }> };

let _tavilyClient: TavilyClientType | null = null;

async function getTavilyClient(): Promise<TavilyClientType> {
  if (!_tavilyClient) {
    const key = process.env.TAVILY_API_KEY;
    if (!key) throw new Error('TAVILY_API_KEY is not set. See docs/API-SETUP.md.');
    const { tavily } = await import('@tavily/core');
    _tavilyClient = tavily({ apiKey: key }) as unknown as TavilyClientType;
  }
  return _tavilyClient;
}

async function tavilySearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const client = await getTavilyClient();
  const response = await client.search(query, {
    max_results: maxResults,
    search_depth: 'advanced',
    include_raw_content: false,
  });
  return response.results ?? [];
}

// ── Brave Search ──────────────────────────────────────────────────────────────

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  extra_snippets?: string[];
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

async function braveSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) throw new Error('BRAVE_SEARCH_API_KEY is not set');

  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(maxResults, 20)));

  const res = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': key,
    },
  });

  if (!res.ok) {
    throw new Error(`Brave Search HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as BraveResponse;
  return (data.web?.results ?? []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description ?? '',
    content: [r.description, ...(r.extra_snippets ?? [])].filter(Boolean).join(' '),
  }));
}

// ── Provider detection ────────────────────────────────────────────────────────

function isTavilyQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('exceeds your plan') || msg.includes('set usage limit');
}

// ── Public search function (Tavily → Brave fallback) ─────────────────────────

export async function webSearch(
  query: string,
  maxResults: number = Number(process.env.MAX_SEARCH_RESULTS ?? 5)
): Promise<SearchResult[]> {
  logger.debug('web_search', { query, maxResults });

  return withRetry(
    async () => {
      // Try Tavily first
      if (process.env.TAVILY_API_KEY) {
        try {
          return await tavilySearch(query, maxResults);
        } catch (err) {
          if (isTavilyQuotaError(err)) {
            logger.warn('Tavily quota exceeded — falling back to Brave Search', {
              query: query.slice(0, 60),
            });
            // Fall through to Brave
          } else {
            throw err; // Non-quota Tavily error — let retry handle it
          }
        }
      }

      // Brave fallback
      if (process.env.BRAVE_SEARCH_API_KEY) {
        return await braveSearch(query, maxResults);
      }

      throw new Error(
        'All search providers exhausted. Set BRAVE_SEARCH_API_KEY as a fallback for when Tavily quota is exceeded.'
      );
    },
    { label: `web_search(${query.slice(0, 40)})` }
  );
}

// Anthropic tool definition for this tool
export const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description:
    'Search the web for real estate data, market information, property records, and research. ' +
    'Returns title, URL, snippet, and content for each result.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'The search query. Be specific — include city, year, and topic.',
      },
      max_results: {
        type: 'number',
        description: 'Number of results to return (default 5, max 10).',
      },
    },
    required: ['query'],
  },
};
