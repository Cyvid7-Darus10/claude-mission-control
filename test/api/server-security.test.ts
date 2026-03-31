import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb, authenticate, authedFetch, hookFetch } from '../helpers';

const tmpDir = setupTestDb();

const { createServer } = await import('../../src/server');

let stop: () => void;
let f: ReturnType<typeof authedFetch>;
let hf: ReturnType<typeof hookFetch>;
const PORT = 14284;
const BASE = `http://localhost:${PORT}`;

beforeAll(async () => {
  const server = createServer(PORT, true);
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

describe('authentication', () => {
  it('rejects unauthenticated API requests', async () => {
    const res = await fetch(`${BASE}/api/agents`);
    expect(res.status).toBe(401);
  });

  it('accepts authenticated API requests', async () => {
    const res = await f(`${BASE}/api/dashboard`);
    expect(res.status).toBe(200);
  });

  it('rejects invalid access code', async () => {
    const res = await fetch(`${BASE}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    });
    expect(res.status).toBe(401);
  });

  it('allows POST /api/events with valid hook token', async () => {
    const res = await hf(`${BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'sec-test',
        agent_id: 'main',
        event_type: 'pre_tool_use',
        tool_name: 'Read',
      }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects POST /api/events without hook token (401)', async () => {
    const res = await fetch(`${BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'sec-test',
        agent_id: 'main',
        event_type: 'pre_tool_use',
        tool_name: 'Read',
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe('CORS origin validation', () => {
  it('allows requests with no Origin header', async () => {
    const res = await f(`${BASE}/api/dashboard`);
    expect(res.status).toBe(200);
  });

  it('allows requests from localhost', async () => {
    const res = await f(`${BASE}/api/dashboard`, {
      headers: { Origin: `http://localhost:${PORT}` },
    });
    expect(res.status).toBe(200);
  });

  it('blocks requests from external origins', async () => {
    const res = await fetch(`${BASE}/api/dashboard`, {
      headers: { Origin: 'http://evil.com' },
    });
    expect(res.status).toBe(403);
  });
});

describe('error handling', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await f(`${BASE}/api/nonexistent`);
    expect(res.status).toBe(404);
  });
});

describe('dashboard serving', () => {
  it('serves login page without auth', async () => {
    const res = await fetch(`${BASE}/login`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('redirects / to login when unauthenticated', async () => {
    const res = await fetch(`${BASE}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('serves index.html when authenticated', async () => {
    const res = await f(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves styles.css without auth', async () => {
    const res = await fetch(`${BASE}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });
});

describe('CORS preflight', () => {
  it('handles OPTIONS requests', async () => {
    const res = await fetch(`${BASE}/api/missions`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });
});
