import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createInstruction,
  getPendingInstructions,
  markInstructionDelivered,
} from '../db.js';
import { eventBus } from '../services/event-bus.js';
import { parseBody, sendJson, extractId, FIELD_LIMITS } from './utils.js';

/**
 * Handle requests to /api/instructions
 *
 * POST /api/instructions           — create a new instruction for an agent
 * GET  /api/instructions/:agentId  — get pending instructions and mark as delivered (atomic)
 *                                    Called by the hook script during PreToolUse.
 */
export async function handleInstructions(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = (req.url ?? '/').split('?')[0];

  // POST /api/instructions
  if (method === 'POST' && (url === '/api/instructions' || url === '/api/instructions/')) {
    await handleCreateInstruction(req, res);
    return;
  }

  // GET /api/instructions/:agentId
  if (method === 'GET') {
    const agentId = extractId(url, '/api/instructions/');
    if (!agentId) {
      sendJson(res, 400, { error: 'Missing agent ID' });
      return;
    }

    // Atomic: fetch pending then mark each as delivered
    const pending = getPendingInstructions(agentId);

    for (const instruction of pending) {
      markInstructionDelivered(instruction.id);
    }

    sendJson(res, 200, pending);
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}

async function handleCreateInstruction(
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

  const { target_agent_id, message } = body;

  if (typeof target_agent_id !== 'string' || target_agent_id.trim().length === 0) {
    sendJson(res, 400, { error: 'Missing or invalid field: target_agent_id' });
    return;
  }

  if (typeof message !== 'string' || message.trim().length === 0) {
    sendJson(res, 400, { error: 'Missing or invalid field: message' });
    return;
  }

  if (message.length > FIELD_LIMITS.message) {
    sendJson(res, 400, { error: `message exceeds maximum length of ${FIELD_LIMITS.message} characters` });
    return;
  }

  const now = new Date().toISOString();
  const instruction = createInstruction({
    target_agent_id: target_agent_id.trim(),
    message: message.trim(),
    status: 'pending',
    created_at: now,
    delivered_at: null,
  });

  eventBus.emit('instruction:new', instruction);
  sendJson(res, 201, instruction);
}
