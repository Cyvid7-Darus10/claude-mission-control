import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Collect request body chunks and parse as JSON.
 * Returns parsed object or throws on invalid JSON.
 */
export function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON response with the given status code.
 */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/**
 * Extract an ID segment from a URL path after a given prefix.
 *
 * Example:
 *   extractId('/api/missions/abc123', '/api/missions/') => 'abc123'
 *   extractId('/api/missions/abc123/events', '/api/missions/') => 'abc123'
 *   extractId('/api/missions', '/api/missions/') => null
 */
export function extractId(url: string, prefix: string): string | null {
  if (!url.startsWith(prefix)) {
    return null;
  }
  const rest = url.slice(prefix.length);
  if (rest.length === 0) {
    return null;
  }
  // Take everything up to the next '/' or '?' or end of string
  const match = rest.match(/^([^/?]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Parse query parameters from a URL string.
 */
export function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) {
    return {};
  }
  const params: Record<string, string> = {};
  const searchParams = new URLSearchParams(url.slice(idx + 1));
  for (const [key, value] of searchParams) {
    params[key] = value;
  }
  return params;
}
