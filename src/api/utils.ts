import type { IncomingMessage, ServerResponse } from 'node:http';
import { eventBus } from '../services/event-bus';

const MAX_BODY_BYTES = 1_048_576; // 1 MB

/**
 * Collect request body chunks and parse as JSON.
 * Rejects if body exceeds MAX_BODY_BYTES or contains invalid JSON.
 */
export function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        eventBus.emit('security:event', {
          layer: 5,
          layerName: 'PAYLOAD SIZE',
          severity: 'warn' as const,
          message: 'Blocked oversized request body',
          detail: `${totalBytes} bytes (max ${MAX_BODY_BYTES})`,
          timestamp: new Date().toISOString(),
        });
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
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
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Field length limits
// ---------------------------------------------------------------------------

export const FIELD_LIMITS = {
  title: 500,
  description: 5_000,
  message: 10_000,
  result: 10_000,
  tool_input: 100_000,
  tool_output: 100_000,
} as const;

/**
 * Truncate a string field to the configured max length.
 * Returns the original value if within limits or if not a string.
 */
export function truncateField(value: unknown, field: keyof typeof FIELD_LIMITS): unknown {
  if (typeof value !== 'string') return value;
  const max = FIELD_LIMITS[field];
  if (value.length > max) {
    eventBus.emit('security:event', {
      layer: 6,
      layerName: 'FIELD LIMIT',
      severity: 'info' as const,
      message: `Truncated ${field} field`,
      detail: `${value.length} chars → ${max} max`,
      timestamp: new Date().toISOString(),
    });
    return value.slice(0, max);
  }
  return value;
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
