import http from 'node:http';
import crypto from 'node:crypto';
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
import { agentTracker } from './services/agent-tracker';

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

// Private/local network IP ranges (RFC 1918 + link-local)
// RFC-1918 private IP pattern with proper 0-255 octet validation
const OCTET = '(?:\\d|[1-9]\\d|1\\d{2}|2[0-4]\\d|25[0-5])';
const PRIVATE_IP_PATTERN = new RegExp(
  `^http:\\/\\/(10\\.${OCTET}\\.${OCTET}\\.${OCTET}|172\\.(?:1[6-9]|2\\d|3[01])\\.${OCTET}\\.${OCTET}|192\\.168\\.${OCTET}\\.${OCTET}|169\\.254\\.${OCTET}\\.${OCTET}):\\d+$`
);

function isOriginAllowed(origin: string | undefined, port: number): boolean {
  // No Origin header = same-origin request or CLI/programmatic — allow
  if (!origin) return true;
  // Exact localhost matches
  if (getAllowedOrigins(port).includes(origin)) return true;
  // Allow any private/local network IP (same WiFi)
  if (PRIVATE_IP_PATTERN.test(origin)) return true;
  return false;
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
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(port: number = 4280, bindLocal: boolean = false): { start: () => void; stop: () => void; accessCode: string; hookToken: string } {
  // C2 fix: Use CSPRNG for access code
  const accessCode = String(crypto.randomInt(100_000, 1_000_000));
  // H1/H2 fix: Shared secret for hook endpoints
  const hookToken = crypto.randomBytes(24).toString('hex');
  const validSessions = new Set<string>();

  // C1 fix: Rate limiting on auth endpoint (per IP)
  const authAttempts = new Map<string, { count: number; resetAt: number }>();
  const AUTH_MAX_ATTEMPTS = 5;
  const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

  function checkAuthRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = authAttempts.get(ip);
    if (!entry || now > entry.resetAt) {
      authAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
      return true;
    }
    entry.count++;
    return entry.count <= AUTH_MAX_ATTEMPTS;
  }

  // L1 fix: Cap concurrent sessions
  const MAX_SESSIONS = 20;

  function parseCookies(req: http.IncomingMessage): Record<string, string> {
    const cookies: Record<string, string> = {};
    const header = req.headers.cookie || '';
    header.split(';').forEach((c) => {
      const [key, ...rest] = c.trim().split('=');
      if (key) cookies[key] = rest.join('=');
    });
    return cookies;
  }

  function isAuthenticated(req: http.IncomingMessage): boolean {
    const cookies = parseCookies(req);
    const token = cookies['mc_session'];
    return token ? validSessions.has(token) : false;
  }

  // H1/H2 fix: Validate hook token (constant-time comparison via crypto)
  function isHookAuthenticated(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization ?? '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (provided.length !== hookToken.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(hookToken));
    } catch {
      return false;
    }
  }

  function setSessionCookie(res: http.ServerResponse, token: string): void {
    res.setHeader('Set-Cookie', `mc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  }

  // H3 fix: Security headers on every response
  function setSecurityHeaders(res: http.ServerResponse): void {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data:");
  }

  const server = http.createServer(async (req, res) => {
    // H3: Apply security headers to all responses
    setSecurityHeaders(res);

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
      // ── Auth routes (no auth required) ──
      if (method === 'POST' && url === '/api/auth') {
        const clientIp = req.socket.remoteAddress ?? 'unknown';

        // C1 fix: Rate limit auth attempts
        if (!checkAuthRateLimit(clientIp)) {
          emitSecurityEvent(1, 'AUTH', 'critical', 'Auth rate limit exceeded — IP locked out', clientIp);
          sendJson(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
          return;
        }

        const { parseBody } = await import('./api/utils');
        const body = await parseBody(req);
        const code = typeof body.code === 'string' ? body.code.trim() : '';

        // Constant-time comparison for access code
        const codeMatch = code.length === accessCode.length &&
          crypto.timingSafeEqual(Buffer.from(code), Buffer.from(accessCode));

        if (codeMatch) {
          const token = crypto.randomBytes(32).toString('hex');
          // L1 fix: Evict oldest session if at capacity
          if (validSessions.size >= MAX_SESSIONS) {
            const oldest = validSessions.values().next().value;
            if (oldest) validSessions.delete(oldest);
          }
          validSessions.add(token);
          setSessionCookie(res, token);
          sendJson(res, 200, { ok: true });
        } else {
          emitSecurityEvent(1, 'AUTH', 'warn', 'Invalid access code attempt', clientIp);
          sendJson(res, 401, { error: 'Invalid access code' });
        }
        return;
      }

      // ── Hook endpoints: authenticated by hook token, not cookies ──
      if (url.startsWith('/api/events') && method === 'POST') {
        if (!isHookAuthenticated(req)) {
          emitSecurityEvent(2, 'HOOK AUTH', 'critical', 'Rejected unauthenticated event POST', req.socket.remoteAddress ?? 'unknown');
          sendJson(res, 401, { error: 'Invalid hook token' });
          return;
        }
        await handleEvents(req, res);
        return;
      }
      // Hook fetches pending instructions via GET during PreToolUse
      if (url.startsWith('/api/instructions/') && method === 'GET') {
        if (!isHookAuthenticated(req)) {
          emitSecurityEvent(2, 'HOOK AUTH', 'warn', 'Rejected unauthenticated instruction poll', req.socket.remoteAddress ?? 'unknown');
          sendJson(res, 401, { error: 'Invalid hook token' });
          return;
        }
        await handleInstructions(req, res);
        return;
      }

      // ── Public routes (no auth required) ──
      const urlPath = url.split('?')[0]; // Strip query string for matching

      // Login page
      if (method === 'GET' && (urlPath === '/login' || urlPath === '/login.html')) {
        serveDashboardFile('login.html', res);
        return;
      }
      // Static assets needed by login page
      if (method === 'GET' && urlPath === '/styles.css') {
        serveDashboardFile('styles.css', res);
        return;
      }
      // Favicon (no auth, return 204 if missing)
      if (method === 'GET' && urlPath === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      // ── Auth check for everything else ──
      if (!isAuthenticated(req)) {
        if (method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
          // Redirect to login
          res.writeHead(302, { 'Location': '/login' });
          res.end();
          return;
        }
        // API calls without auth
        sendJson(res, 401, { error: 'Unauthorized — access code required' });
        return;
      }

      // ── Dashboard routes (authenticated) ──
      if (method === 'GET' && (url === '/' || url === '/index.html')) {
        serveDashboardFile('index.html', res);
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

      // API routes (authenticated)
      if (url.startsWith('/api/events')) {
        if (method === 'GET') {
          await handleEvents(req, res);
          return;
        }
      }

      if (url.startsWith('/api/agents')) {
        if (method === 'GET' || method === 'PATCH' || method === 'DELETE') {
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
      if (!isOriginAllowed(origin, port)) {
        emitSecurityEvent(3, 'WS ORIGIN', 'critical', 'Rejected WebSocket from unauthorized origin', origin ?? 'unknown');
        return false;
      }
      // Check auth cookie for WebSocket too
      if (!isAuthenticated(req)) {
        emitSecurityEvent(1, 'AUTH', 'warn', 'Rejected unauthenticated WebSocket', req.socket.remoteAddress ?? 'unknown');
        return false;
      }
      return true;
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
    const onInstructionDelivered = (d: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'instruction:delivered', data: d }));
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
    eventBus.on('instruction:delivered', onInstructionDelivered);
    eventBus.on('security:event', onSecurityEvent);

    ws.on('close', () => {
      eventBus.off('agent:update', onAgentUpdate);
      eventBus.off('event:new', onEventNew);
      eventBus.off('mission:update', onMissionUpdate);
      eventBus.off('instruction:new', onInstructionNew);
      eventBus.off('instruction:delivered', onInstructionDelivered);
      eventBus.off('security:event', onSecurityEvent);
    });

    ws.on('error', (err) => {
      console.error('[ws] Client error:', err.message);
    });
  });

  return {
    start(): void {
      const host = bindLocal ? '127.0.0.1' : '0.0.0.0';
      server.listen(port, host, () => {
        agentTracker.start();
      });
    },
    stop(): void {
      agentTracker.stop();
      wss.clients.forEach((client) => client.close());
      wss.close();
      server.close();
    },
    accessCode,
    hookToken,
  };
}
