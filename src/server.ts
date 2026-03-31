import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { getDashboardStats, getAgents as dbGetAgents, getEvents as dbGetEvents } from './db';
import { eventBus } from './services/event-bus';
import { handleEvents } from './api/events';
import { handleAgents } from './api/agents';
import { handleMissions } from './api/missions';
import { handleInstructions } from './api/instructions';
import { sendJson } from './api/utils';

const DASHBOARD_DIR = path.resolve(__dirname, 'dashboard');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

function serveDashboardFile(filePath: string, res: http.ServerResponse): void {
  const absPath = path.join(DASHBOARD_DIR, filePath);
  const ext = path.extname(absPath);
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(content),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Not Found');
  }
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export function createServer(port: number = 4280): { start: () => void; stop: () => void } {
  const server = http.createServer(async (req, res) => {
    setCorsHeaders(res);

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

      if (method === 'GET' && url === '/api/dashboard') {
        const stats = getDashboardStats();
        sendJson(res, 200, stats);
        return;
      }

      // 404 fallback
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      console.error(`[server] Error handling ${method} ${url}:`, message);
      sendJson(res, 500, { error: message });
    }
  });

  // WebSocket server on the same HTTP server
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket) => {
    // Send current state on connect
    const agents = dbGetAgents();
    const recentEvents = dbGetEvents(50);

    ws.send(JSON.stringify({ type: 'agents', data: agents }));
    ws.send(JSON.stringify({ type: 'events', data: recentEvents }));

    // Forward event bus events to this WebSocket client
    const handler = (eventName: string, data: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: eventName, data }));
      }
    };

    eventBus.on('agent:update', (d) => handler('agent:update', d));
    eventBus.on('event:new', (d) => handler('event:new', d));
    eventBus.on('mission:update', (d) => handler('mission:update', d));
    eventBus.on('instruction:new', (d) => handler('instruction:new', d));

    ws.on('close', () => {
      eventBus.removeAllListeners();
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
