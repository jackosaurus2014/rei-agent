type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m',  // green
  warn: '\x1b[33m',  // yellow
  error: '\x1b[31m', // red
};

const RESET = '\x1b[0m';

function getMinLevel(): number {
  const env = process.env.LOG_LEVEL as LogLevel | undefined;
  return LEVELS[env ?? 'info'] ?? LEVELS.info;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < getMinLevel()) return;

  const timestamp = new Date().toISOString();
  const color = COLORS[level];
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';

  process.stderr.write(`${color}[${level.toUpperCase()}]${RESET} ${timestamp} ${message}${metaStr}\n`);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
  info:  (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
  warn:  (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
};
