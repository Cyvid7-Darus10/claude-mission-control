import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  getMissions,
  getMission,
  updateMission,
  deleteMission,
  getEvents,
} from '../db.js';
import {
  createMission as engineCreateMission,
  MissionEngineError,
} from '../services/mission-engine.js';
import { eventBus } from '../services/event-bus.js';
import { parseBody, sendJson, extractId, parseQuery } from './utils.js';

/**
 * Handle requests to /api/missions and /api/missions/:id
 *
 * GET    /api/missions          — list all missions (optional ?status= filter)
 * POST   /api/missions          — create a new mission
 * GET    /api/missions/:id      — single mission with events
 * PATCH  /api/missions/:id      — update status, assign agent, complete/fail with result
 * DELETE /api/missions/:id      — delete if status is queued
 */
export async function handleMissions(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = (req.url ?? '/').split('?')[0];

  // Collection routes: /api/missions
  if (url === '/api/missions' || url === '/api/missions/') {
    if (method === 'GET') {
      const query = parseQuery(req.url ?? '');
      const allMissions = getMissions();

      // Optional status filter
      const filtered = query.status
        ? allMissions.filter((m) => m.status === query.status)
        : allMissions;

      sendJson(res, 200, filtered);
      return;
    }

    if (method === 'POST') {
      await handleCreateMission(req, res);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Individual routes: /api/missions/:id
  const missionId = extractId(url, '/api/missions/');
  if (!missionId) {
    sendJson(res, 400, { error: 'Missing mission ID' });
    return;
  }

  if (method === 'GET') {
    const mission = getMission(missionId);
    if (!mission) {
      sendJson(res, 404, { error: 'Mission not found' });
      return;
    }
    // Include related events — filter from recent events by mission_id
    const allEvents = getEvents(500, 0);
    const missionEvents = allEvents.filter((e) => e.mission_id === missionId);
    sendJson(res, 200, { ...mission, events: missionEvents });
    return;
  }

  if (method === 'PATCH') {
    await handleUpdateMission(missionId, req, res);
    return;
  }

  if (method === 'DELETE') {
    handleDeleteMission(missionId, res);
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}

async function handleCreateMission(
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

  const { title, description, depends_on, priority } = body;

  if (typeof title !== 'string' || title.trim().length === 0) {
    sendJson(res, 400, { error: 'Missing or invalid field: title' });
    return;
  }

  // Validate depends_on is an array of strings if provided
  if (depends_on != null) {
    if (!Array.isArray(depends_on) || !depends_on.every((d) => typeof d === 'string')) {
      sendJson(res, 400, { error: 'depends_on must be an array of mission IDs' });
      return;
    }
  }

  const id = randomUUID();

  try {
    const mission = engineCreateMission({
      id,
      title: title.trim(),
      description: typeof description === 'string' ? description.trim() : null,
      priority: typeof priority === 'number' ? priority : 0,
      depends_on: Array.isArray(depends_on) ? depends_on : null,
    });

    sendJson(res, 201, mission);
  } catch (err) {
    if (err instanceof MissionEngineError) {
      sendJson(res, 400, { error: err.message });
    } else {
      throw err;
    }
  }
}

async function handleUpdateMission(
  missionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const existing = getMission(missionId);
  if (!existing) {
    sendJson(res, 404, { error: 'Mission not found' });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const fields: Record<string, unknown> = {};
  const now = new Date().toISOString();

  // Update status with appropriate timestamps
  if (typeof body.status === 'string') {
    const validStatuses = ['queued', 'active', 'completed', 'failed', 'blocked'];
    if (!validStatuses.includes(body.status)) {
      sendJson(res, 400, {
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      });
      return;
    }
    fields.status = body.status;

    if (body.status === 'active' && !existing.started_at) {
      fields.started_at = now;
    }
    if (body.status === 'completed' || body.status === 'failed') {
      fields.completed_at = now;
    }
  }

  // Assign agent
  if (body.assigned_agent_id !== undefined) {
    fields.assigned_agent_id =
      typeof body.assigned_agent_id === 'string' ? body.assigned_agent_id : null;
  }

  // Store result (completion/failure summary)
  if (body.result !== undefined) {
    fields.result = typeof body.result === 'string' ? body.result : JSON.stringify(body.result);
  }

  // Update title if provided
  if (typeof body.title === 'string' && body.title.trim().length > 0) {
    fields.title = body.title.trim();
  }

  // Update description if provided
  if (body.description !== undefined) {
    fields.description =
      typeof body.description === 'string' ? body.description.trim() : null;
  }

  // Update priority if provided
  if (typeof body.priority === 'number') {
    fields.priority = body.priority;
  }

  if (Object.keys(fields).length === 0) {
    sendJson(res, 400, { error: 'No valid fields to update' });
    return;
  }

  const updated = updateMission(missionId, fields);
  if (!updated) {
    sendJson(res, 500, { error: 'Failed to update mission' });
    return;
  }

  eventBus.emit('mission:update', updated);
  sendJson(res, 200, updated);
}

function handleDeleteMission(missionId: string, res: ServerResponse): void {
  const existing = getMission(missionId);
  if (!existing) {
    sendJson(res, 404, { error: 'Mission not found' });
    return;
  }

  if (existing.status !== 'queued') {
    sendJson(res, 409, {
      error: 'Can only delete missions with status "queued"',
    });
    return;
  }

  const deleted = deleteMission(missionId);
  if (!deleted) {
    sendJson(res, 500, { error: 'Failed to delete mission' });
    return;
  }

  sendJson(res, 200, { id: missionId, deleted: true });
}
