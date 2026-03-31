import type { IncomingMessage, ServerResponse } from 'node:http';
import { getAgents, getAgent, updateAgent, deleteAgent, deleteDisconnectedAgents, getEvents } from '../db.js';
import { parseBody, sendJson, extractId, parseQuery } from './utils.js';

/**
 * Handle requests to /api/agents and /api/agents/:id
 *
 * GET    /api/agents            — list all agents with status, current mission, last activity
 * GET    /api/agents/:id        — single agent detail
 * PATCH  /api/agents/:id        — update agent name (friendly label)
 * GET    /api/agents/:id/events — event history for agent
 */
export async function handleAgents(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = (req.url ?? '/').split('?')[0];

  // GET /api/agents
  if (method === 'GET' && (url === '/api/agents' || url === '/api/agents/')) {
    const agents = getAgents();
    sendJson(res, 200, agents);
    return;
  }

  // Extract agent ID from path
  const agentId = extractId(url, '/api/agents/');

  if (!agentId) {
    sendJson(res, 400, { error: 'Missing agent ID' });
    return;
  }

  // GET /api/agents/:id/events
  if (method === 'GET' && url.endsWith('/events')) {
    const query = parseQuery(req.url ?? '');
    const limit = Math.min(Math.max(parseInt(query.limit ?? '100', 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0);

    // Use the general getEvents with limit/offset
    // Filter by agent_id in application layer since db.getEvents doesn't support it directly
    const allEvents = getEvents(limit, offset);
    const filtered = allEvents.filter((e) => e.agent_id === agentId);
    sendJson(res, 200, filtered);
    return;
  }

  // GET /api/agents/:id
  if (method === 'GET') {
    const agent = getAgent(agentId);
    if (!agent) {
      sendJson(res, 404, { error: 'Agent not found' });
      return;
    }
    sendJson(res, 200, agent);
    return;
  }

  // PATCH /api/agents/:id
  if (method === 'PATCH') {
    const agent = getAgent(agentId);
    if (!agent) {
      sendJson(res, 404, { error: 'Agent not found' });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await parseBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      sendJson(res, 400, { error: 'Missing or invalid field: name' });
      return;
    }

    const updated = updateAgent(agentId, { name: body.name.trim() });
    if (!updated) {
      sendJson(res, 500, { error: 'Failed to update agent' });
      return;
    }
    sendJson(res, 200, updated);
    return;
  }

  // DELETE /api/agents/:id
  if (method === 'DELETE') {
    // Special: "disconnected" deletes all disconnected agents
    if (agentId === 'disconnected') {
      const count = deleteDisconnectedAgents();
      sendJson(res, 200, { deleted: count });
      return;
    }
    const deleted = deleteAgent(agentId);
    if (!deleted) {
      sendJson(res, 404, { error: 'Agent not found' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}
