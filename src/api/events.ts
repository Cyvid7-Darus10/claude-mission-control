import type { IncomingMessage, ServerResponse } from 'node:http';
import { insertEvent, getEvents } from '../db.js';
import { agentTracker } from '../services/agent-tracker.js';
import { eventBus } from '../services/event-bus.js';
import { parseBody, sendJson, parseQuery, truncateField } from './utils.js';

/**
 * Handle requests to /api/events
 *
 * POST /api/events — ingest a hook event
 * GET  /api/events — query stored events
 */
export async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  if (method === 'POST') {
    await handlePostEvent(req, res);
    return;
  }

  if (method === 'GET') {
    handleGetEvents(url, res);
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}

async function handlePostEvent(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const {
    session_id,
    agent_id = 'main',
    event_type,
    tool_name = null,
    tool_input = null,
    tool_output = null,
    cwd = null,
    model = null,
  } = body as Record<string, string | null | undefined>;

  if (!session_id || !event_type) {
    sendJson(res, 400, { error: 'Missing required fields: session_id, event_type' });
    return;
  }

  // Composite key: session_id:agent_id
  const compositeId = `${session_id}:${agent_id ?? 'main'}`;
  const now = new Date().toISOString();

  // Store the event
  const inserted = insertEvent({
    agent_id: compositeId,
    session_id: session_id as string,
    event_type: event_type as string,
    tool_name: (tool_name as string) ?? null,
    tool_input: tool_input != null ? truncateField(JSON.stringify(tool_input), 'tool_input') as string : null,
    tool_output: tool_output != null ? truncateField(JSON.stringify(tool_output), 'tool_output') as string : null,
    mission_id: null,
    timestamp: now,
  });

  // Agent tracker is the single owner of agent records — handles upsert,
  // name derivation, status lifecycle, and broadcast.
  agentTracker.trackEvent(inserted, {
    cwd: (cwd as string) ?? null,
    model: (model as string) ?? null,
  });

  // Broadcast to WebSocket clients via event bus
  eventBus.emit('event:new', inserted);

  sendJson(res, 201, { id: inserted.id, agent_id: compositeId });
}

function handleGetEvents(url: string, res: ServerResponse): void {
  const query = parseQuery(url);
  const limit = Math.min(Math.max(parseInt(query.limit ?? '100', 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0);

  // Note: getEvents in db.ts accepts (limit, offset) — agent_id filtering
  // can be added later via a dedicated query if needed.
  const events = getEvents(limit, offset);
  sendJson(res, 200, events);
}
