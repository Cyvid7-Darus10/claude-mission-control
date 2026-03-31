import type { IncomingMessage, ServerResponse } from 'node:http';
import { getUsageStats, getAgentUsageStats } from '../db.js';
import { sendJson, parseQuery } from './utils.js';

/**
 * Handle requests to /api/usage
 *
 * GET /api/usage              — return global usage statistics
 * GET /api/usage?agent=<id>   — return usage statistics scoped to one agent
 */
export async function handleUsage(
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
  // hours=0 means "all time"; max 8760 (1 year)
  const rawHours = parseInt(query.hours ?? '24', 10);
  const hours = Number.isNaN(rawHours) ? 24 : Math.min(Math.max(rawHours, 0), 8760);

  const agentId = query.agent ?? null;

  const stats = agentId
    ? getAgentUsageStats(agentId, hours)
    : getUsageStats(hours);

  sendJson(res, 200, stats);
}
