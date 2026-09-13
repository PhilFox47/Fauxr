import { db, nowIso } from './db/index.js';

export type LogScope = 'director' | 'actor' | 'image' | 'scheduler' | 'api' | 'app' | 'generator';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const MAX_LOG_ROWS = 5000;
let writes = 0;

export function log(
  level: LogLevel,
  scope: LogScope,
  message: string,
  payload: unknown = {},
): void {
  try {
    db.prepare('INSERT INTO logs (ts, level, scope, message, payload) VALUES (?, ?, ?, ?, ?)').run(
      nowIso(),
      level,
      scope,
      message,
      JSON.stringify(payload ?? {}),
    );
  } catch (err) {
    console.error('log write failed', err);
  }
  if (level === 'error') console.error(`[${scope}] ${message}`);
  else if (level === 'warn') console.warn(`[${scope}] ${message}`);
  else console.log(`[${scope}] ${message}`);

  if (++writes % 200 === 0) {
    db.prepare(
      'DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?',
    ).run(MAX_LOG_ROWS);
  }
}

export const logger = {
  debug: (s: LogScope, m: string, p?: unknown) => log('debug', s, m, p),
  info: (s: LogScope, m: string, p?: unknown) => log('info', s, m, p),
  warn: (s: LogScope, m: string, p?: unknown) => log('warn', s, m, p),
  error: (s: LogScope, m: string, p?: unknown) => log('error', s, m, p),
};
