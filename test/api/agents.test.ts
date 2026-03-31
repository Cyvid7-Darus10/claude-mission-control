import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb, authenticate, authedFetch } from '../helpers';

const tmpDir = setupTestDb();

const { createServer } = await import('../../src/server');

let stop: () => void;
let f: ReturnType<typeof authedFetch>;
const PORT = 14285;
const BASE = `http://localhost:${PORT}`;

beforeAll(async () => {
  const server = createServer(PORT);
  stop = server.stop;
  server.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const cookie = await authenticate(BASE, server.accessCode);
  f = authedFetch(cookie);

  // Register agents via hook endpoint (unauthed)
  await fetch(`${BASE}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: 'agent-test-sess',
      agent_id: 'main',
      event_type: 'pre_tool_use',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test.ts' },
      cwd: '/projects/my-app',
    }),
  });
});

afterAll(() => {
  stop();
  teardownTestDb(tmpDir);
});

describe('GET /api/agents', () => {
  it('lists all agents', async () => {
    const res = await f(`${BASE}/api/agents`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/agents/:id', () => {
  it('returns a single agent', async () => {
    const res = await f(`${BASE}/api/agents/agent-test-sess%3Amain`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe('agent-test-sess:main');
  });

  it('returns 404 for nonexistent agent', async () => {
    const res = await f(`${BASE}/api/agents/nonexistent`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/agents/:id', () => {
  it('renames an agent', async () => {
    const res = await f(`${BASE}/api/agents/agent-test-sess%3Amain`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My Custom Name' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('My Custom Name');
  });

  it('rejects empty name', async () => {
    const res = await f(`${BASE}/api/agents/agent-test-sess%3Amain`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for nonexistent agent', async () => {
    const res = await f(`${BASE}/api/agents/nonexistent`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/agents/:id/events', () => {
  it('returns event history for an agent', async () => {
    const res = await f(`${BASE}/api/agents/agent-test-sess%3Amain/events`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });
});
