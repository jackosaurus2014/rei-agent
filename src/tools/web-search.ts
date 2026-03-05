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

// ── Exa ───────────────────────────────────────────────────────────────────────

let _exaClient: import('exa-js').default | null = null;

async function getExaClient(): Promise<import('exa-js').default> {
  if (!_exaClient) {
    const key = process.env.EXA_API_KEY;
    if (!key) throw new Error('EXA_API_KEY is not set');
    const Exa = (await import('exa-js')).default;
    _exaClient = new Exa(key);
  }
  return _exaClient;
}

async function exaSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const client = await getExaClient();
  const response = await client.searchAndContents(query, {
    numResults: maxResults,
    text: { maxCharacters: 1000 },  // compact — enough context without burning credits
  });
  return (response.results ?? []).map(r => ({
    title: r.title ?? '',
    url: r.url,
    snippet: r.text?.slice(0, 300) ?? '',
    content: r.text ?? '',
  }));
}

// ── Provider detection ────────────────────────────────────────────────────────

function isTavilyQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('exceeds your plan') || msg.includes('set usage limit');
}

// ── Public search function (Tavily → Exa fallback) ───────────────────────────

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
            logger.warn('Tavily quota exceeded — falling back to Exa', {
              query: query.slice(0, 60),
            });
            // Fall through to Exa
          } else {
            throw err; // Non-quota error — let retry handle it
          }
        }
      }

      // Exa fallback
      if (process.env.EXA_API_KEY) {
        return await exaSearch(query, maxResults);
      }

      throw new Error(
        'All search providers exhausted. Set EXA_API_KEY as a fallback for when Tavily quota is exceeded.'
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
