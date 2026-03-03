import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'REI Agent',
  description: 'AI-powered real estate investment analysis',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full bg-gray-950">
      <body className="h-full text-gray-100 antialiased">
        <div className="min-h-full flex flex-col">
          <nav className="border-b border-gray-800 bg-gray-900 sticky top-0 z-10">
            <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-6">
              <Link href="/" className="text-white font-bold text-lg tracking-tight">
                REI Agent
              </Link>
              <div className="flex items-center gap-4 text-sm">
                <Link href="/" className="text-gray-400 hover:text-white transition-colors">
                  Dashboard
                </Link>
                <Link href="/market-research" className="text-gray-400 hover:text-white transition-colors">
                  Market Research
                </Link>
                <Link href="/property-scout" className="text-gray-400 hover:text-white transition-colors">
                  Property Scout
                </Link>
              </div>
            </div>
          </nav>
          <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
            {children}
          </main>
          <footer className="border-t border-gray-800 text-center py-4 text-xs text-gray-600">
            REI Agent — Not financial advice. Verify all data independently.
          </footer>
        </div>
      </body>
    </html>
  );
}
