import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { getDashboardStats, getAgents as dbGetAgents, getEvents as dbGetEvents, getMissions as dbGetMissions } from './db';
import { eventBus, type SecurityEvent } from './services/event-bus';
import { handleEvents } from './api/events';
import { handleAgents } from './api/agents';
import { handleMissions } from './api/missions';
import { handleInstructions } from './api/instructions';
import { handleUsage } from './api/usage';
import { handleTokens } from './api/tokens';
import { sendJson } from './api/utils';

// ---------------------------------------------------------------------------
// Security event helpers
// ---------------------------------------------------------------------------

function emitSecurityEvent(
  layer: number,
  layerName: string,
  severity: SecurityEvent['severity'],
  message: string,
  detail: string | null = null,
): void {
  const event: SecurityEvent = {
    layer,
    layerName,
    severity,
    message,
    detail,
    timestamp: new Date().toISOString(),
  };
  eventBus.emit('security:event', event);
}

const DASHBOARD_DIR = path.resolve(__dirname, 'dashboard');
const MAX_WS_CLIENTS = 50;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Security: Origin validation
// ---------------------------------------------------------------------------

function getAllowedOrigins(port: number): readonly string[] {
  return [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ];
}

function isOriginAllowed(origin: string | undefined, port: number): boolean {
  // No Origin header = same-origin request or CLI/programmatic — allow
  if (!origin) return true;
  return getAllowedOrigins(port).includes(origin);
}

// ---------------------------------------------------------------------------
// Dashboard file serving (with path traversal guard)
// ---------------------------------------------------------------------------

function serveDashboardFile(filePath: string, res: http.ServerResponse): void {
  const absPath = path.join(DASHBOARD_DIR, filePath);

  // L2: Prevent path traversal — resolved path must stay inside DASHBOARD_DIR
  if (!absPath.startsWith(DASHBOARD_DIR + path.sep) && absPath !== DASHBOARD_DIR) {
    emitSecurityEvent(2, 'PATH TRAVERSAL', 'critical', 'Blocked path traversal attempt', filePath);
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  const ext = path.extname(absPath);
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(content),
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

// ---------------------------------------------------------------------------
// CORS headers (origin-validated, not wildcard)
// ---------------------------------------------------------------------------

function setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse, port: number): boolean {
  const origin = req.headers.origin as string | undefined;

  if (origin && !isOriginAllowed(origin, port)) {
    emitSecurityEvent(1, 'ORIGIN', 'critical', 'Blocked request from unauthorized origin', origin);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return false;
  }

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(port: number = 4280): { start: () => void; stop: () => void } {
  const server = http.createServer(async (req, res) => {
    // Validate origin before processing any request
    if (!setCorsHeaders(req, res, port)) return;

    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Dashboard routes
      if (method === 'GET' && (url === '/' || url === '/index.html')) {
        serveDashboardFile('index.html', res);
        return;
      }
      if (method === 'GET' && url === '/styles.css') {
        serveDashboardFile('styles.css', res);
        return;
      }
      if (method === 'GET' && url === '/app.js') {
        serveDashboardFile('app.js', res);
        return;
      }
      if (method === 'GET' && url === '/security.js') {
        serveDashboardFile('security.js', res);
        return;
      }

      // API routes
      if (url.startsWith('/api/events')) {
        if (method === 'POST' || method === 'GET') {
          await handleEvents(req, res);
          return;
        }
      }

      if (url.startsWith('/api/agents')) {
        if (method === 'GET' || method === 'PATCH') {
          await handleAgents(req, res);
          return;
        }
      }

      if (url.startsWith('/api/missions')) {
        if (method === 'GET' || method === 'POST' || method === 'PATCH' || method === 'DELETE') {
          await handleMissions(req, res);
          return;
        }
      }

      if (url.startsWith('/api/instructions')) {
        if (method === 'GET' || method === 'POST') {
          await handleInstructions(req, res);
          return;
        }
      }

      if (url.startsWith('/api/usage')) {
        if (method === 'GET') {
          await handleUsage(req, res);
          return;
        }
      }

      if (url.startsWith('/api/tokens')) {
        if (method === 'GET') {
          await handleTokens(req, res);
          return;
        }
      }

      if (method === 'GET' && url === '/api/dashboard') {
        const stats = getDashboardStats();
        sendJson(res, 200, stats);
        return;
      }

      // 404 fallback
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      // M1: Log full error server-side, return generic message to client
      console.error(`[server] Error handling ${method} ${url}:`, err);
      sendJson(res, 500, { error: 'Internal Server Error' });
    }
  });

  // Handle port-in-use before WSS attaches (WSS re-emits server errors)
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ERROR: Port ${port} is already in use.`);
      console.error(`  Try: kill $(lsof -ti :${port}) or use --port <number>\n`);
      process.exit(1);
    }
    throw err;
  });

  // WebSocket server with origin validation and connection limit
  const wss = new WebSocketServer({
    server,
    verifyClient: ({ req }: { req: http.IncomingMessage }) => {
      const origin = req.headers.origin as string | undefined;
      const allowed = isOriginAllowed(origin, port);
      if (!allowed) {
        emitSecurityEvent(3, 'WS ORIGIN', 'critical', 'Rejected WebSocket from unauthorized origin', origin ?? 'unknown');
      }
      return allowed;
    },
  });

  wss.on('connection', (ws: WebSocket) => {
    // M4: Reject if too many concurrent connections
    if (wss.clients.size > MAX_WS_CLIENTS) {
      emitSecurityEvent(4, 'CONN LIMIT', 'warn', 'Rejected WebSocket — connection limit reached', `${wss.clients.size}/${MAX_WS_CLIENTS}`);
      ws.close(1013, 'Too many connections');
      return;
    }

    // Send current state on connect
    const agents = dbGetAgents();
    const recentEvents = dbGetEvents(50);
    const missions = dbGetMissions();

    ws.send(JSON.stringify({ type: 'agents', data: agents }));
    ws.send(JSON.stringify({ type: 'events', data: recentEvents }));
    ws.send(JSON.stringify({ type: 'missions', data: missions }));

    // Forward event bus events to this WebSocket client
    const onAgentUpdate = (d: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'agent:update', data: d }));
      }
    };
    const onEventNew = (d: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'event:new', data: d }));
      }
    };
    const onMissionUpdate = (d: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'mission:update', data: d }));
      }
    };
    const onInstructionNew = (d: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'instruction:new', data: d }));
      }
    };
    const onSecurityEvent = (d: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'security:event', data: d }));
      }
    };

    eventBus.on('agent:update', onAgentUpdate);
    eventBus.on('event:new', onEventNew);
    eventBus.on('mission:update', onMissionUpdate);
    eventBus.on('instruction:new', onInstructionNew);
    eventBus.on('security:event', onSecurityEvent);

    ws.on('close', () => {
      eventBus.off('agent:update', onAgentUpdate);
      eventBus.off('event:new', onEventNew);
      eventBus.off('mission:update', onMissionUpdate);
      eventBus.off('instruction:new', onInstructionNew);
      eventBus.off('security:event', onSecurityEvent);
    });

    ws.on('error', (err) => {
      console.error('[ws] Client error:', err.message);
    });
  });

  return {
    start(): void {
      server.listen(port, () => {
        // Server started — caller handles banner
      });
    },
    stop(): void {
      wss.clients.forEach((client) => client.close());
      wss.close();
      server.close();
    },
  };
}
