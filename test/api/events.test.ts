import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb, authenticate, authedFetch, hookFetch } from '../helpers';

const tmpDir = setupTestDb();

const { createServer } = await import('../../src/server');

let stop: () => void;
let f: ReturnType<typeof authedFetch>;
let hf: ReturnType<typeof hookFetch>;
const PORT = 14280;
const BASE = `http://localhost:${PORT}`;

beforeAll(async () => {
  const server = createServer(PORT);
  stop = server.stop;
  server.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const cookie = await authenticate(BASE, server.accessCode);
  f = authedFetch(cookie);
  hf = hookFetch(server.hookToken);
});

afterAll(() => {
  stop();
  teardownTestDb(tmpDir);
});

async function post(path: string, body: unknown) {
  return hf(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/events', () => {
  it('accepts a valid event', async () => {
    const res = await post('/api/events', {
      session_id: 'test-sess',
      agent_id: 'main',
      event_type: 'pre_tool_use',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test.ts' },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeGreaterThan(0);
    expect(data.agent_id).toBe('test-sess:main');
  });

  it('rejects missing session_id', async () => {
    const res = await post('/api/events', {
      event_type: 'pre_tool_use',
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing event_type', async () => {
    const res = await post('/api/events', {
      session_id: 'test-sess',
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid JSON', async () => {
    const res = await hf(`${BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json{{{',
    });
    expect(res.status).toBe(400);
  });

  it('accepts subagent events', async () => {
    const res = await post('/api/events', {
      session_id: 'test-sess',
      agent_id: 'sub-abc123',
      event_type: 'subagent_start',
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.agent_id).toBe('test-sess:sub-abc123');
  });
});

describe('GET /api/events', () => {
  it('returns events with default pagination', async () => {
    const res = await f(`${BASE}/api/events`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it('respects limit parameter', async () => {
    const res = await f(`${BASE}/api/events?limit=1`);
    const data = await res.json();
    expect(data.length).toBe(1);
  });
});

describe('auto-mission creation', () => {
  it('creates a mission from cwd when main agent sends first event', async () => {
    const res = await post('/api/events', {
      session_id: 'auto-cwd-sess',
      agent_id: 'main',
      event_type: 'pre_tool_use',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test.ts' },
      cwd: '/projects/my-cool-app',
    });
    expect(res.status).toBe(201);

    const missionsRes = await f(`${BASE}/api/missions`);
    const missions = await missionsRes.json();
    const created = missions.find((m: any) => m.title === 'my-cool-app');
    expect(created).toBeDefined();
    expect(created.status).toBe('active');
  });

  it('creates a mission from subagent_start description', async () => {
    const res = await post('/api/events', {
      session_id: 'auto-sub-sess',
      agent_id: 'main',
      event_type: 'subagent_start',
      tool_input: { description: 'Implement user authentication flow' },
    });
    expect(res.status).toBe(201);

    const missionsRes = await f(`${BASE}/api/missions`);
    const missions = await missionsRes.json();
    const created = missions.find((m: any) => m.title === 'Implement user authentication flow');
    expect(created).toBeDefined();
    expect(created.status).toBe('active');
  });

  it('auto-completes the mission when a Stop event arrives', async () => {
    // First event creates an active mission
    await post('/api/events', {
      session_id: 'auto-stop-sess',
      agent_id: 'main',
      event_type: 'subagent_start',
      tool_input: { description: 'Refactor database layer thoroughly' },
    });

    // Stop event should mark it completed
    await post('/api/events', {
      session_id: 'auto-stop-sess',
      agent_id: 'main',
      event_type: 'stop',
    });

    const missionsRes = await f(`${BASE}/api/missions`);
    const missions = await missionsRes.json();
    const mission = missions.find((m: any) => m.title === 'Refactor database layer thoroughly');
    expect(mission).toBeDefined();
    expect(mission.status).toBe('completed');
  });

  it('does NOT create a mission when description looks like a shell command', async () => {
    const beforeRes = await f(`${BASE}/api/missions`);
    const before = await beforeRes.json();
    const beforeCount = before.length;

    await post('/api/events', {
      session_id: 'auto-junk-sess',
      agent_id: 'main',
      event_type: 'subagent_start',
      tool_input: { description: 'curl https://example.com/api/data' },
    });

    const afterRes = await f(`${BASE}/api/missions`);
    const after = await afterRes.json();
    // No new mission should have been created for junk input
    const junkMission = after.find((m: any) => m.title === 'curl https://example.com/api/data');
    expect(junkMission).toBeUndefined();
    // Count should not have grown (or may have grown by cwd fallback — but no cwd provided here)
    expect(after.length).toBe(beforeCount);
  });
});
