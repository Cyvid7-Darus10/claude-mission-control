import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb, authenticate, authedFetch, hookFetch } from '../helpers';

const tmpDir = setupTestDb();

const { createServer } = await import('../../src/server');

let stop: () => void;
let f: ReturnType<typeof authedFetch>;
let hf: ReturnType<typeof hookFetch>;
const PORT = 14282;
const BASE = `http://localhost:${PORT}`;

beforeAll(async () => {
  const server = createServer(PORT, true);
  stop = server.stop;
  server.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const cookie = await authenticate(BASE, server.accessCode);
  f = authedFetch(cookie);
  hf = hookFetch(server.hookToken);
  // Register an agent so instructions have a target (POST /api/events requires hook token)
  await hf(`${BASE}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: 'inst-sess',
      agent_id: 'main',
      event_type: 'pre_tool_use',
      tool_name: 'Read',
    }),
  });
});

afterAll(() => {
  stop();
  teardownTestDb(tmpDir);
});

describe('POST /api/instructions', () => {
  it('creates an instruction', async () => {
    const res = await f(`${BASE}/api/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_agent_id: 'inst-sess:main',
        message: 'Focus on auth module',
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.message).toBe('Focus on auth module');
    expect(data.status).toBe('pending');
  });

  it('rejects missing target_agent_id', async () => {
    const res = await f(`${BASE}/api/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing message', async () => {
    const res = await f(`${BASE}/api/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_agent_id: 'inst-sess:main' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects message exceeding limit', async () => {
    const res = await f(`${BASE}/api/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_agent_id: 'inst-sess:main',
        message: 'x'.repeat(10_001),
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/instructions/:agentId', () => {
  it('delivers pending instructions and marks them', async () => {
    // Create two instructions
    await f(`${BASE}/api/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_agent_id: 'inst-sess:main',
        message: 'Instruction 1',
      }),
    });
    await f(`${BASE}/api/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_agent_id: 'inst-sess:main',
        message: 'Instruction 2',
      }),
    });

    // Fetch pending
    const res = await hf(`${BASE}/api/instructions/inst-sess%3Amain`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(2);

    // Fetching again should return empty (already delivered)
    const res2 = await hf(`${BASE}/api/instructions/inst-sess%3Amain`);
    const data2 = await res2.json();
    expect(data2.length).toBe(0);
  });

  it('returns empty for unknown agent', async () => {
    const res = await hf(`${BASE}/api/instructions/unknown-agent`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(0);
  });
});
