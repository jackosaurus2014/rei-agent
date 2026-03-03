/**
 * REI Agent API Server
 *
 * Lightweight Express server that manages long-running agent jobs and exposes
 * REST endpoints for the Next.js UI to consume.
 *
 * Usage:
 *   npx tsx src/server.ts
 *   # or: npm run serve
 *
 * Runs on port 3001 (Next.js dev runs on 3000).
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { logger } from './lib/logger';

const app = express();
const PORT = Number(process.env.SERVER_PORT ?? 3001);
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? './output';

app.use(cors());
app.use(express.json());

// ── Job store ─────────────────────────────────────────────────────────────────
// In-memory map. Jobs persist for the lifetime of the server process.
// For a production system, replace with Redis or SQLite.

type JobType = 'analyze' | 'market-research' | 'property-scout';
type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
type AgentStatus = 'queued' | 'running' | 'completed' | 'failed';

interface AgentProgress {
  name: string;
  status: AgentStatus;
  startedAt?: string;
  completedAt?: string;
  confidence?: string;
  toolCallCount?: number;
}

interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  input: Record<string, unknown>;
  agents: AgentProgress[];
  outputPath?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

const jobs = new Map<string, Job>();

function updateJob(id: string, updates: Partial<Job>): void {
  const job = jobs.get(id);
  if (job) jobs.set(id, { ...job, ...updates });
}

function updateAgent(jobId: string, agentName: string, updates: Partial<AgentProgress>): void {
  const job = jobs.get(jobId);
  if (!job) return;
  const agents = job.agents.map(a =>
    a.name === agentName ? { ...a, ...updates } : a
  );
  jobs.set(jobId, { ...job, agents });
}

// ── Background job runners ────────────────────────────────────────────────────

async function runAnalysisJob(jobId: string, input: Record<string, unknown>): Promise<void> {
  const AGENT_NAMES = ['Owner Intel', 'Market Intel', 'Public Records', 'Underwriting', 'Legal Risk'];

  try {
    updateJob(jobId, { status: 'running' });

    const { runDealAnalyzer } = await import('./agents/deal-analyzer/deal-analyzer-manager');

    // Monkey-patch the deal analyzer to emit progress events.
    // We do this by overriding the logger to watch for specific log messages.
    const originalInfo = logger.info.bind(logger);
    logger.info = (message: string, meta?: Record<string, unknown>) => {
      originalInfo(message, meta);
      const msgLower = message.toLowerCase();
      // Detect agent start
      const agentStartMap: Record<string, string> = {
        'owner intel agent started': 'Owner Intel',
        'market intel agent started': 'Market Intel',
        'public records agent started': 'Public Records',
        'underwriting agent started': 'Underwriting',
        'legal risk agent started': 'Legal Risk',
      };
      for (const [key, name] of Object.entries(agentStartMap)) {
        if (msgLower.includes(key)) {
          updateAgent(jobId, name, { status: 'running', startedAt: new Date().toISOString() });
        }
      }
      // Detect agent completion
      const agentCompleteMap: Record<string, string> = {
        'owner intel research complete': 'Owner Intel',
        'market intel research complete': 'Market Intel',
        'public records research complete': 'Public Records',
        'underwriting computed': 'Underwriting',
        'legal risk research complete': 'Legal Risk',
      };
      for (const [key, name] of Object.entries(agentCompleteMap)) {
        if (msgLower.includes(key)) {
          updateAgent(jobId, name, {
            status: 'completed',
            completedAt: new Date().toISOString(),
            toolCallCount: typeof meta?.toolCallCount === 'number' ? meta.toolCallCount : undefined,
          });
        }
      }
    };
    const originalError = logger.error.bind(logger);
    logger.error = (message: string, meta?: Record<string, unknown>) => {
      originalError(message, meta);
      const agentFailMap: Record<string, string> = {
        'owner intel agent failed': 'Owner Intel',
        'market intel agent failed': 'Market Intel',
        'public records agent failed': 'Public Records',
        'underwriting agent failed': 'Underwriting',
        'legal risk agent failed': 'Legal Risk',
      };
      for (const [key, name] of Object.entries(agentFailMap)) {
        if (message.toLowerCase().includes(key)) {
          updateAgent(jobId, name, { status: 'failed', completedAt: new Date().toISOString() });
        }
      }
    };

    await runDealAnalyzer({
      address: String(input.address),
      purchasePrice: Number(input.purchasePrice),
      propertyType: (input.propertyType as 'sfr' | 'multifamily' | 'condo') ?? 'sfr',
    });

    // Restore logger
    logger.info = originalInfo;
    logger.error = originalError;

    // Find the output file
    const analysisDir = path.join(OUTPUT_DIR, 'deal-analysis');
    const files = fs.existsSync(analysisDir)
      ? fs.readdirSync(analysisDir).sort().reverse()
      : [];
    const outputPath = files[0] ? path.join(analysisDir, files[0]) : undefined;

    updateJob(jobId, { status: 'completed', completedAt: new Date().toISOString(), outputPath });

    // Mark any still-running agents as completed (fallback for cases we missed)
    const job = jobs.get(jobId);
    if (job) {
      const agents = job.agents.map(a =>
        a.status === 'running' ? { ...a, status: 'completed' as AgentStatus, completedAt: new Date().toISOString() } : a
      );
      jobs.set(jobId, { ...job, agents });
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Analysis job failed', { jobId, error: message });
    updateJob(jobId, { status: 'failed', error: message, completedAt: new Date().toISOString() });
  }
}

async function runMarketResearchJob(jobId: string): Promise<void> {
  try {
    updateJob(jobId, { status: 'running' });
    const { runMarketResearch } = await import('./agents/market-research/market-research-agent');
    await runMarketResearch();

    const mrDir = path.join(OUTPUT_DIR, 'market-research');
    const files = fs.existsSync(mrDir)
      ? fs.readdirSync(mrDir).sort().reverse()
      : [];
    const outputPath = files[0] ? path.join(mrDir, files[0]) : undefined;
    updateJob(jobId, { status: 'completed', completedAt: new Date().toISOString(), outputPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateJob(jobId, { status: 'failed', error: message, completedAt: new Date().toISOString() });
  }
}

async function runPropertyScoutJob(jobId: string, input: Record<string, unknown>): Promise<void> {
  try {
    updateJob(jobId, { status: 'running' });
    const { runPropertyScout } = await import('./agents/property-scout/property-scout-agent');
    await runPropertyScout({
      cities: (input.cities as string[]) ?? [],
      auto: Boolean(input.auto),
      maxPrice: Number(input.maxPrice ?? 400000),
      minPrice: Number(input.minPrice ?? 50000),
      propertyType: String(input.propertyType ?? 'sfr'),
    });

    const scoutDir = path.join(OUTPUT_DIR, 'property-scout');
    const summaryFile = fs.existsSync(scoutDir)
      ? fs.readdirSync(scoutDir).filter(f => f.startsWith('summary')).sort().reverse()[0]
      : undefined;
    const outputPath = summaryFile ? path.join(scoutDir, summaryFile) : undefined;
    updateJob(jobId, { status: 'completed', completedAt: new Date().toISOString(), outputPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateJob(jobId, { status: 'failed', error: message, completedAt: new Date().toISOString() });
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/jobs/analyze
app.post('/api/jobs/analyze', (req, res) => {
  const { address, purchasePrice, propertyType } = req.body as Record<string, unknown>;
  if (!address || !purchasePrice) {
    res.status(400).json({ error: 'address and purchasePrice are required' });
    return;
  }

  const id = randomUUID();
  const job: Job = {
    id,
    type: 'analyze',
    status: 'queued',
    input: { address, purchasePrice, propertyType: propertyType ?? 'sfr' },
    agents: ['Owner Intel', 'Market Intel', 'Public Records', 'Underwriting', 'Legal Risk'].map(name => ({
      name,
      status: 'queued',
    })),
    createdAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  // Fire and forget — job runs in background
  void runAnalysisJob(id, job.input);

  res.json({ id });
});

// POST /api/jobs/market-research
app.post('/api/jobs/market-research', (_req, res) => {
  const id = randomUUID();
  const job: Job = {
    id,
    type: 'market-research',
    status: 'queued',
    input: {},
    agents: [{ name: 'Market Research', status: 'queued' }],
    createdAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  void runMarketResearchJob(id);
  res.json({ id });
});

// POST /api/jobs/property-scout
app.post('/api/jobs/property-scout', (req, res) => {
  const input = req.body as Record<string, unknown>;
  const id = randomUUID();
  const cities = (input.cities as string[]) ?? [];
  const job: Job = {
    id,
    type: 'property-scout',
    status: 'queued',
    input,
    agents: cities.map(c => ({ name: c, status: 'queued' as AgentStatus })),
    createdAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  void runPropertyScoutJob(id, input);
  res.json({ id });
});

// GET /api/jobs
app.get('/api/jobs', (_req, res) => {
  const all = Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  res.json(all);
});

// GET /api/jobs/:id
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(job);
});

// GET /api/output?path=...
// Serves the markdown content of an output file
app.get('/api/output', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    res.status(400).json({ error: 'path query param required' });
    return;
  }
  // Security: only allow files within OUTPUT_DIR
  const resolved = path.resolve(filePath);
  const outputResolved = path.resolve(OUTPUT_DIR);
  if (!resolved.startsWith(outputResolved)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  const content = fs.readFileSync(resolved, 'utf8');
  res.type('text/plain').send(content);
});

// GET /api/output/list?type=deal-analysis|market-research|property-scout
app.get('/api/output/list', (req, res) => {
  const type = (req.query.type as string) ?? '';
  const subDir = type ? path.join(OUTPUT_DIR, type) : OUTPUT_DIR;

  if (!fs.existsSync(subDir)) {
    res.json([]);
    return;
  }

  const files = fs.readdirSync(subDir, { withFileTypes: true })
    .filter(f => f.isFile() && f.name.endsWith('.md'))
    .map(f => ({
      name: f.name,
      path: path.join(subDir, f.name),
      type: type || 'unknown',
      modifiedAt: fs.statSync(path.join(subDir, f.name)).mtime.toISOString(),
    }))
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

  res.json(files);
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', jobs: jobs.size });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info(`REI Agent API server running on http://localhost:${PORT}`);
  logger.info('Endpoints:', {
    health: `GET http://localhost:${PORT}/api/health`,
    jobs: `GET http://localhost:${PORT}/api/jobs`,
    analyze: `POST http://localhost:${PORT}/api/jobs/analyze`,
    marketResearch: `POST http://localhost:${PORT}/api/jobs/market-research`,
    propertyScout: `POST http://localhost:${PORT}/api/jobs/property-scout`,
  });
});
