const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface AgentProgress {
  name: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  startedAt?: string;
  completedAt?: string;
  confidence?: string;
  toolCallCount?: number;
}

export interface Job {
  id: string;
  type: 'analyze' | 'market-research' | 'property-scout';
  status: 'queued' | 'running' | 'completed' | 'failed';
  input: Record<string, unknown>;
  agents: AgentProgress[];
  outputPath?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface OutputFile {
  name: string;
  path: string;
  type: string;
  modifiedAt: string;
}

async function post<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function get<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${BASE}${endpoint}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  startAnalysis: (address: string, purchasePrice: number, propertyType: string) =>
    post<{ id: string }>('/api/jobs/analyze', { address, purchasePrice, propertyType }),

  startMarketResearch: () =>
    post<{ id: string }>('/api/jobs/market-research', {}),

  startPropertyScout: (cities: string[], maxPrice: number, minPrice: number) =>
    post<{ id: string }>('/api/jobs/property-scout', { cities, maxPrice, minPrice }),

  getJob: (id: string) => get<Job>(`/api/jobs/${id}`),

  listJobs: () => get<Job[]>('/api/jobs'),

  listOutputFiles: (type: string) => get<OutputFile[]>(`/api/output/list?type=${type}`),

  getOutputContent: async (filePath: string): Promise<string> => {
    const res = await fetch(`${BASE}/api/output?path=${encodeURIComponent(filePath)}`, {
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Could not load output: ${res.status}`);
    return res.text();
  },
};
