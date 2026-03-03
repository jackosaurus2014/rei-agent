import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.');
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

export const MODELS = {
  MANAGER: 'claude-sonnet-4-6',
  SUB_AGENT: 'claude-haiku-4-5-20251001',
} as const;
