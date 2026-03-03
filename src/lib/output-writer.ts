import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? './output';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function writeDealMemo(content: string, address: string): string {
  const dir = join(OUTPUT_DIR, 'deal-analysis');
  mkdirSync(dir, { recursive: true });
  const filename = `${slugify(address)}-${today()}.md`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, content, 'utf8');
  return filepath;
}

export function writeCityRankings(content: string): string {
  const dir = join(OUTPUT_DIR, 'market-research');
  mkdirSync(dir, { recursive: true });
  const filepath = join(dir, `top-25-cities-${today()}.md`);
  writeFileSync(filepath, content, 'utf8');
  return filepath;
}

export function writePropertyScout(content: string, city: string): string {
  const dir = join(OUTPUT_DIR, 'property-scout');
  mkdirSync(dir, { recursive: true });
  const filepath = join(dir, `${slugify(city)}-listings-${today()}.md`);
  writeFileSync(filepath, content, 'utf8');
  return filepath;
}
