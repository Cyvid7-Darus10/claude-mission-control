import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb, authenticate, authedFetch, hookFetch } from '../helpers';

const tmpDir = setupTestDb();

const { createServer } = await import('../../src/server');

let stop: () => void;
let f: ReturnType<typeof authedFetch>;
const PORT = 14286;
const BASE = `http://localhost:${PORT}`;

beforeAll(async () => {
  const server = createServer(PORT, true);
  stop = server.stop;
  server.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const cookie = await authenticate(BASE, server.accessCode);
  f = authedFetch(cookie);
  const hf = hookFetch(server.hookToken);

  // Seed some events (requires hook token)
  for (let i = 0; i < 5; i++) {
    await hf(`${BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'usage-sess',
        agent_id: 'main',
        event_type: 'pre_tool_use',
        tool_name: ['Read', 'Edit', 'Bash', 'Grep', 'Write'][i],
        tool_input: { file_path: `/tmp/file${i}.ts` },
      }),
    });
  }
});

afterAll(() => {
  stop();
  teardownTestDb(tmpDir);
});

describe('GET /api/usage', () => {
  it('returns global usage stats', async () => {
    const res = await f(`${BASE}/api/usage`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalToolCalls).toBeGreaterThanOrEqual(5);
    expect(data.toolUsage).toBeDefined();
    expect(Array.isArray(data.toolUsage)).toBe(true);
    expect(data.period).toBeDefined();
  });

  it('respects hours parameter', async () => {
    const res = await f(`${BASE}/api/usage?hours=1`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalToolCalls).toBeGreaterThanOrEqual(5);
  });

  it('supports all-time (hours=0)', async () => {
    const res = await f(`${BASE}/api/usage?hours=0`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.period).toBe('all');
  });

  it('filters by agent', async () => {
    const res = await f(`${BASE}/api/usage?agent=usage-sess%3Amain`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalToolCalls).toBeGreaterThanOrEqual(5);
    expect(data.uniqueAgents).toBe(1);
  });

  it('returns zero for unknown agent', async () => {
    const res = await f(`${BASE}/api/usage?agent=nonexistent`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalToolCalls).toBe(0);
  });
});
