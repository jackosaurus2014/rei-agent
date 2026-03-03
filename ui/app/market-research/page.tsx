'use client';

import { useState, useEffect } from 'react';
import { api, Job, OutputFile } from '../../lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function MarketResearchPage() {
  const [files, setFiles] = useState<OutputFile[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [content, setContent] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadFiles();
  }, []);

  async function loadFiles() {
    try {
      const f = await api.listOutputFiles('market-research');
      setFiles(f);
      if (f.length > 0) {
        setSelectedFile(f[0].path);
        loadContent(f[0].path);
      }
    } catch { /* ok */ }
  }

  async function loadContent(path: string) {
    setContent('');
    try {
      const c = await api.getOutputContent(path);
      setContent(c);
    } catch { /* ok */ }
  }

  async function runResearch() {
    setRunning(true);
    setError('');
    setJob(null);
    try {
      const { id } = await api.startMarketResearch();
      let j: Job = await api.getJob(id);
      setJob(j);
      while (j.status !== 'completed' && j.status !== 'failed') {
        await new Promise(r => setTimeout(r, 3000));
        j = await api.getJob(id);
        setJob(j);
      }
      if (j.status === 'completed') {
        await loadFiles();
      } else {
        setError(j.error ?? 'Research failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start research');
    }
    setRunning(false);
    setJob(null);
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Market Research</h1>
          <p className="text-gray-400 text-sm mt-1">
            Top 25 US cities ranked for SFR/multifamily investment potential.
          </p>
        </div>
        <button
          onClick={runResearch}
          disabled={running}
          className="shrink-0 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          {running ? 'Running…' : 'Run New Research'}
        </button>
      </div>

      {/* Live status while running */}
      {running && job && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm space-y-1">
          <div className="text-blue-400 font-medium">Research in progress</div>
          {job.agents.map(a => (
            <div key={a.name} className="flex items-center gap-2 text-xs text-gray-400">
              <span className={a.status === 'running' ? 'text-blue-400' : a.status === 'completed' ? 'text-green-400' : 'text-gray-600'}>
                {a.status === 'running' ? '⟳' : a.status === 'completed' ? '✓' : '○'}
              </span>
              {a.name}: <span className="capitalize">{a.status}</span>
            </div>
          ))}
        </div>
      )}

      {running && !job && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-blue-400 animate-pulse">
          Starting research agent…
        </div>
      )}

      {error && (
        <div className="bg-red-950 border border-red-800 rounded-lg p-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* File selector when multiple reports exist */}
      {files.length > 1 && (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-400">Report:</span>
          <select
            value={selectedFile}
            onChange={e => {
              setSelectedFile(e.target.value);
              loadContent(e.target.value);
            }}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white focus:outline-none focus:border-blue-500"
          >
            {files.map(f => (
              <option key={f.path} value={f.path}>
                {f.name} — {new Date(f.modifiedAt).toLocaleDateString()}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Report content */}
      {content ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        </div>
      ) : (
        !running && (
          <div className="text-center text-gray-500 py-16">
            <p className="text-lg mb-2">No market research reports yet.</p>
            <p className="text-sm">Click &ldquo;Run New Research&rdquo; to rank the top 25 US cities.</p>
          </div>
        )
      )}
    </div>
  );
}
