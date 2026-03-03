'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, Job } from '../lib/api';

export default function DashboardPage() {
  const router = useRouter();
  const [address, setAddress] = useState('');
  const [price, setPrice] = useState('');
  const [propertyType, setPropertyType] = useState('sfr');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [recentJobs, setRecentJobs] = useState<Job[]>([]);

  useEffect(() => {
    api.listJobs()
      .then(jobs => setRecentJobs(jobs.filter(j => j.type === 'analyze')))
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!address.trim() || !price) return;
    setSubmitting(true);
    setError('');
    try {
      const { id } = await api.startAnalysis(address.trim(), Number(price), propertyType);
      router.push(`/analysis/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start analysis');
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Deal Analyzer</h1>
        <p className="text-gray-400 text-sm">
          Run a full AI-powered investment analysis on any property.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-5"
      >
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1.5">
            Property Address
          </label>
          <input
            type="text"
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="123 Main St, Memphis TN 38103"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              Purchase Price
            </label>
            <input
              type="number"
              value={price}
              onChange={e => setPrice(e.target.value)}
              placeholder="250000"
              min="1"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              Property Type
            </label>
            <select
              value={propertyType}
              onChange={e => setPropertyType(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            >
              <option value="sfr">SFR (Single Family)</option>
              <option value="multifamily">Multifamily</option>
              <option value="condo">Condo</option>
            </select>
          </div>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 px-6 rounded-lg transition-colors"
        >
          {submitting ? 'Starting analysis…' : 'Analyze Property'}
        </button>
      </form>

      {recentJobs.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-white mb-3">Recent Analyses</h2>
          <div className="space-y-2">
            {recentJobs.slice(0, 8).map(job => (
              <a
                key={job.id}
                href={`/analysis/${job.id}`}
                className="flex items-center justify-between bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-lg px-4 py-3 transition-colors group"
              >
                <div>
                  <p className="text-white text-sm font-medium group-hover:text-blue-400 transition-colors">
                    {String(job.input.address ?? 'Unknown address')}
                  </p>
                  <p className="text-gray-500 text-xs mt-0.5">
                    ${Number(job.input.purchasePrice).toLocaleString()} ·{' '}
                    {new Date(job.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <StatusBadge status={job.status} />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Job['status'] }) {
  const styles: Record<Job['status'], string> = {
    queued: 'bg-gray-700 text-gray-300',
    running: 'bg-blue-900 text-blue-300',
    completed: 'bg-green-900 text-green-300',
    failed: 'bg-red-900 text-red-300',
  };
  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${styles[status]}`}>
      {status}
    </span>
  );
}
