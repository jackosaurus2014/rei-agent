'use client';

import { useState, useEffect, use } from 'react';
import { api, Job, AgentProgress } from '../../../lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [job, setJob] = useState<Job | null>(null);
  const [memo, setMemo] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const j = await api.getJob(id);
        if (!active) return;
        setJob(j);

        if (j.status === 'completed' && j.outputPath && !memo) {
          try {
            const content = await api.getOutputContent(j.outputPath);
            if (active) setMemo(content);
          } catch { /* ok */ }
        }

        if (j.status !== 'completed' && j.status !== 'failed') {
          setTimeout(poll, 3000);
        }
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load job');
      }
    }

    poll();
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error) {
    return <div className="text-red-400 p-4 bg-red-950 border border-red-800 rounded-lg">{error}</div>;
  }
  if (!job) {
    return <div className="text-gray-500 py-8 text-center">Loading…</div>;
  }

  const verdict = extractVerdict(memo);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">
          {String(job.input.address ?? 'Analysis')}
        </h1>
        <p className="text-gray-400 text-sm mt-1">
          ${Number(job.input.purchasePrice).toLocaleString()} ·{' '}
          {String(job.input.propertyType ?? 'sfr').toUpperCase()} ·{' '}
          <span className="capitalize">{job.status}</span>
        </p>
      </div>

      {/* Agent progress cards */}
      <div className="grid grid-cols-5 gap-3">
        {job.agents.map(agent => (
          <AgentCard key={agent.name} agent={agent} />
        ))}
      </div>

      {/* Verdict badge */}
      {verdict && (
        <div className="flex items-center gap-3">
          <span className="text-gray-400 text-sm">Verdict:</span>
          <VerdictBadge verdict={verdict} />
        </div>
      )}

      {/* Error display */}
      {job.status === 'failed' && job.error && (
        <div className="bg-red-950 border border-red-800 rounded-lg p-4 text-red-300 text-sm">
          {job.error}
        </div>
      )}

      {/* Running placeholder */}
      {job.status === 'running' && !memo && (
        <div className="text-center text-gray-500 py-12">
          <div className="text-4xl mb-3 animate-pulse">⟳</div>
          <p>Agents are gathering data… this takes 8–12 minutes.</p>
          <p className="text-xs mt-1 text-gray-600">This page polls every 3 seconds.</p>
        </div>
      )}

      {/* Investment memo */}
      {memo && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Investment Memo</h2>
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{memo}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentProgress }) {
  const icons: Record<AgentProgress['status'], string> = {
    queued: '○',
    running: '⟳',
    completed: '✓',
    failed: '✗',
  };
  const borders: Record<AgentProgress['status'], string> = {
    queued: 'border-gray-700 text-gray-500',
    running: 'border-blue-600 text-blue-400',
    completed: 'border-green-700 text-green-400',
    failed: 'border-red-700 text-red-400',
  };
  return (
    <div className={`border rounded-lg p-3 text-center ${borders[agent.status]}`}>
      <div className={`text-xl mb-1 ${agent.status === 'running' ? 'animate-spin inline-block' : ''}`}>
        {icons[agent.status]}
      </div>
      <div className="text-xs font-medium text-gray-300 leading-tight">{agent.name}</div>
      <div className="text-xs mt-1 capitalize text-gray-500">{agent.status}</div>
      {agent.toolCallCount !== undefined && (
        <div className="text-xs text-gray-600 mt-0.5">{agent.toolCallCount} calls</div>
      )}
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const styles: Record<string, string> = {
    'STRONG BUY': 'bg-green-800 text-green-100 border-green-600',
    'BUY': 'bg-emerald-800 text-emerald-100 border-emerald-600',
    'CONDITIONAL BUY': 'bg-yellow-800 text-yellow-100 border-yellow-600',
    'PASS': 'bg-red-900 text-red-200 border-red-700',
  };
  const cls = styles[verdict] ?? 'bg-gray-700 text-gray-200 border-gray-600';
  return (
    <span className={`px-3 py-1 rounded-full border text-sm font-bold ${cls}`}>
      {verdict}
    </span>
  );
}

function extractVerdict(memo: string): string {
  if (!memo) return '';
  const match = memo.match(/\*\*(STRONG BUY|CONDITIONAL BUY|BUY|PASS)\*\*|(?:^|\s)(STRONG BUY|CONDITIONAL BUY|BUY|PASS)(?:\s|$)/m);
  if (match) return match[1] ?? match[2] ?? '';
  return '';
}
