import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { insertEvent, getEvents, getMissions, updateMission } from '../db.js';
import { agentTracker } from '../services/agent-tracker.js';
import { createMission as engineCreateMission, MissionEngineError } from '../services/mission-engine.js';
import { eventBus } from '../services/event-bus.js';
import { parseBody, sendJson, parseQuery, truncateField } from './utils.js';

// Track which agents already have auto-created missions (avoid duplicates per session)
const agentMissionCreated = new Set<string>();

/**
 * Auto-create a mission from agent activity.
 * - SubagentStart: uses the description field (if it looks like a real task)
 * - Stop: marks the agent's mission as completed
 */

/** Returns true if text looks like a command, path, URL, or other junk — not a mission title. */
function looksLikeJunk(text: string): boolean {
  const t = text.toLowerCase();
  // Starts with a shell command
  if (/^(curl|ls|cat|rm|cd|cp|mv|git|npm|npx|node|python|pip|docker|ssh|wget|grep|find|mkdir|chmod|kill|lsof|echo|sed|awk)\s/.test(t)) return true;
  // Contains path separators, pipes, redirects
  if (t.includes('|') || t.includes('>') || t.includes('2>/dev/null')) return true;
  // Starts with a path
  if (t.startsWith('/') || t.startsWith('~/') || t.startsWith('./')) return true;
  // Contains URLs
  if (t.includes('http://') || t.includes('https://')) return true;
  // Contains file extensions suggesting it's a file path
  if (/\.(ts|js|json|md|css|html|py|go|rs|sh|yml|yaml|toml)\b/.test(t) && t.includes('/')) return true;
  // Looks like "project — command" pattern
  if (/\s—\s/.test(text) && looksLikeJunk(text.split('—')[1]?.trim() || '')) return true;
  return false;
}

function autoMission(
  compositeId: string,
  eventType: string,
  toolName: string | null,
  toolInput: unknown,
  cwd: string | null,
): void {
  try {
    // On Stop: complete any active mission for this agent
    const eventLower = eventType.toLowerCase();
    if (eventLower === 'stop') {
      const missions = getMissions();
      for (const m of missions) {
        if (m.assigned_agent_id === compositeId && m.status === 'active') {
          updateMission(m.id, { status: 'completed', completed_at: new Date().toISOString() });
          eventBus.emit('mission:update', { ...m, status: 'completed', completed_at: new Date().toISOString() });
        }
      }
      agentMissionCreated.delete(compositeId);
      return;
    }

    // Don't create duplicate missions for the same agent
    if (agentMissionCreated.has(compositeId)) return;

    // Also check DB — handles server restarts where in-memory set is empty
    const existingMissions = getMissions();

    // Skip if this exact agent already has an active mission
    const hasActiveMission = existingMissions.some(
      (m) => m.assigned_agent_id === compositeId && (m.status === 'active' || m.status === 'queued')
    );
    if (hasActiveMission) {
      agentMissionCreated.add(compositeId);
      return;
    }

    let title: string | null = null;

    // SubagentStart: use description
    // Only create missions from meaningful sources:
    // 1. SubagentStart — has a human-written description
    // 2. Agent tool — spawning a subagent with a description
    // Main agent tool calls (Read, Bash, etc.) are too low-level to be missions.

    if (eventLower === 'subagent_start' || eventLower === 'subagentstart' || toolName === 'Agent') {
      let input: Record<string, unknown> = {};
      if (typeof toolInput === 'string') {
        try { input = JSON.parse(toolInput) as Record<string, unknown>; } catch {}
      } else if (toolInput && typeof toolInput === 'object') {
        input = toolInput as Record<string, unknown>;
      }
      // Extract candidate title from description or prompt
      var candidate = '';
      if (typeof input.description === 'string' && input.description.length > 0) {
        candidate = input.description.trim();
      } else if (typeof input.prompt === 'string' && input.prompt.length > 0) {
        candidate = input.prompt.trim();
      }

      // Filter out titles that look like commands, paths, or junk
      if (candidate.length >= 10 && !looksLikeJunk(candidate)) {
        title = candidate.length > 80 ? candidate.slice(0, 77) + '...' : candidate;
      }
    }

    // Main agent: create mission from project folder name
    // This gives every session a mission without noisy tool-level details
    if (!title && cwd) {
      const project = cwd.split('/').filter(Boolean).pop();
      if (project && project.length >= 2) {
        title = project;
      }
    }

    if (!title) return;

    // Cap title length
    if (title.length > 100) title = title.slice(0, 97) + '...';

    // Deduplicate by title — don't create if same title exists in any status
    const titleExists = existingMissions.some(
      (m) => m.title === title
    );
    if (titleExists) {
      agentMissionCreated.add(compositeId);
      return;
    }

    agentMissionCreated.add(compositeId);

    const mission = engineCreateMission({
      id: crypto.randomUUID(),
      title,
      description: null,
      priority: 0,
    });

    // Assign the agent and mark active
    updateMission(mission.id, {
      assigned_agent_id: compositeId,
      status: 'active',
      started_at: new Date().toISOString(),
    });

    eventBus.emit('mission:update', {
      ...mission,
      assigned_agent_id: compositeId,
      status: 'active',
      started_at: new Date().toISOString(),
    });
  } catch (err) {
    // Never let auto-mission creation break event processing
    if (!(err instanceof MissionEngineError)) {
      console.error('[auto-mission] Error:', err);
    }
  }
}

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

  // Auto-create mission from agent activity
  autoMission(
    compositeId,
    event_type as string,
    (tool_name as string) ?? null,
    tool_input,
    (cwd as string) ?? null,
  );

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
