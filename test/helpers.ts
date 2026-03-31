import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Create a fresh temp directory for MC_DATA_DIR.
 * Must be called BEFORE importing any src/ modules (they read env on import).
 */
export function setupTestDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-test-'));
  process.env.MC_DATA_DIR = dir;
  return dir;
}

/**
 * Clean up the temp directory.
 */
export function teardownTestDb(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Authenticate with the server and return the session cookie string.
 * Use this in test beforeAll after starting the server.
 */
export async function authenticate(base: string, accessCode: string): Promise<string> {
  const res = await fetch(`${base}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: accessCode }),
    redirect: 'manual',
  });
  if (!res.ok) {
    throw new Error(`Auth failed: ${res.status}`);
  }
  // Extract Set-Cookie header
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/mc_session=([^;]+)/);
  if (!match) {
    throw new Error('No session cookie returned');
  }
  return `mc_session=${match[1]}`;
}

/**
 * Create an authenticated fetch wrapper.
 */
export function authedFetch(cookie: string) {
  return function (url: string, opts?: RequestInit): Promise<Response> {
    const headers = new Headers(opts?.headers);
    headers.set('Cookie', cookie);
    return fetch(url, { ...opts, headers });
  };
}
