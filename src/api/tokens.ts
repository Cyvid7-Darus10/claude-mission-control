import type { IncomingMessage, ServerResponse } from 'node:http';
import { scanSessions } from '../services/session-scanner.js';
import { sendJson, parseQuery } from './utils.js';

/**
 * Handle requests to /api/tokens
 *
 * GET /api/tokens — return real token usage from Claude Code JSONL logs
 */
export async function handleTokens(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  if (method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const query = parseQuery(url);
  const rawHours = parseInt(query.hours ?? '0', 10);
  const hours = Number.isNaN(rawHours) ? 0 : Math.max(rawHours, 0);

  const summary = scanSessions(hours);
  sendJson(res, 200, summary);
}
