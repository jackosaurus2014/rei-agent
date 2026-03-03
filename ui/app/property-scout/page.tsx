'use client';

import { useState, useEffect } from 'react';
import { api, Job, OutputFile } from '../../lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function PropertyScoutPage() {
  const [cities, setCities] = useState('');
  const [maxPrice, setMaxPrice] = useState('400000');
  const [minPrice, setMinPrice] = useState('50000');
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
      const f = await api.listOutputFiles('property-scout');
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cities.trim()) return;
    setRunning(true);
    setError('');
    setJob(null);

    const cityList = cities.split(',').map(c => c.trim()).filter(Boolean);
    try {
      const { id } = await api.startPropertyScout(cityList, Number(maxPrice), Number(minPrice));
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
        setError(j.error ?? 'Scout failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start scout');
    }
    setRunning(false);
    setJob(null);
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Property Scout</h1>
        <p className="text-gray-400 text-sm mt-1">
          Find investment properties in target markets and pre-screen by cap rate.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-5"
      >
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1.5">
            Cities <span className="text-gray-500">(comma-separated, include state)</span>
          </label>
          <input
            type="text"
            value={cities}
            onChange={e => setCities(e.target.value)}
            placeholder="Memphis TN, Indianapolis IN, Kansas City MO"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Max Price</label>
            <input
              type="number"
              value={maxPrice}
              onChange={e => setMaxPrice(e.target.value)}
              min="1"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Min Price</label>
            <input
              type="number"
              value={minPrice}
              onChange={e => setMinPrice(e.target.value)}
              min="1"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        {error && (
          <div className="bg-red-950 border border-red-800 rounded-lg p-3 text-red-300 text-sm">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={running}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 px-6 rounded-lg transition-colors"
        >
          {running ? 'Scouting…' : 'Run Property Scout'}
        </button>
      </form>

      {/* Live status while running */}
      {running && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm space-y-1">
          <div className="text-blue-400 font-medium animate-pulse">Scout in progress</div>
          {job?.agents.map(a => (
            <div key={a.name} className="flex items-center gap-2 text-xs text-gray-400">
              <span
                className={
                  a.status === 'running'
                    ? 'text-blue-400'
                    : a.status === 'completed'
                    ? 'text-green-400'
                    : 'text-gray-600'
                }
              >
                {a.status === 'running' ? '⟳' : a.status === 'completed' ? '✓' : '○'}
              </span>
              {a.name}: <span className="capitalize">{a.status}</span>
            </div>
          ))}
          {!job && <div className="text-xs text-gray-500">Starting…</div>}
        </div>
      )}

      {/* File selector */}
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

      {/* Scout report content */}
      {content ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        </div>
      ) : (
        !running && (
          <div className="text-center text-gray-500 py-16">
            <p className="text-lg mb-2">No scout reports yet.</p>
            <p className="text-sm">
              Enter target cities above to find and pre-screen investment properties.
            </p>
          </div>
        )
      )}
    </div>
  );
}
