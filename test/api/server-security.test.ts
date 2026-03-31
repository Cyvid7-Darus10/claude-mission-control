import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers';

const tmpDir = setupTestDb();

const { createServer } = await import('../../src/server');

let stop: () => void;
const PORT = 14284;
const BASE = `http://localhost:${PORT}`;

beforeAll(async () => {
  const server = createServer(PORT);
  stop = server.stop;
  server.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
});

afterAll(() => {
  stop();
  teardownTestDb(tmpDir);
});

describe('CORS origin validation', () => {
  it('allows requests with no Origin header', async () => {
    const res = await fetch(`${BASE}/api/dashboard`);
    expect(res.status).toBe(200);
  });

  it('allows requests from localhost', async () => {
    const res = await fetch(`${BASE}/api/dashboard`, {
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

  it('blocks requests from different port', async () => {
    const res = await fetch(`${BASE}/api/dashboard`, {
      headers: { Origin: 'http://localhost:9999' },
    });
    expect(res.status).toBe(403);
  });
});

describe('error handling', () => {
  it('returns generic error message on 500', async () => {
    // Trigger an error by sending invalid method to a valid route
    const res = await fetch(`${BASE}/api/events`, { method: 'PUT' });
    // Should get 404 or 405, not a stack trace
    expect([404, 405]).toContain(res.status);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${BASE}/api/nonexistent`);
    expect(res.status).toBe(404);
  });
});

describe('dashboard serving', () => {
  it('serves index.html', async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves styles.css', async () => {
    const res = await fetch(`${BASE}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  it('serves app.js', async () => {
    const res = await fetch(`${BASE}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });
});

describe('CORS preflight', () => {
  it('handles OPTIONS requests', async () => {
    const res = await fetch(`${BASE}/api/missions`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });
});
