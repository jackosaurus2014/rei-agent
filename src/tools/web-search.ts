import { withRetry } from '../lib/retry';
import { logger } from '../lib/logger';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content: string;
}

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

export async function webSearch(
  query: string,
  maxResults: number = Number(process.env.MAX_SEARCH_RESULTS ?? 5)
): Promise<SearchResult[]> {
  logger.debug('web_search', { query, maxResults });

  return withRetry(
    async () => {
      const client = await getTavilyClient();
      const response = await client.search(query, {
        max_results: maxResults,
        search_depth: 'advanced',
        include_raw_content: false,
      });
      return response.results ?? [];
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
