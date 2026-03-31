#!/usr/bin/env node
/**
 * Take dashboard screenshots for README with seeded test data.
 * Self-contained: starts server, seeds data, captures, stops.
 * Usage: node scripts/screenshots.mjs
 */

import puppeteer from 'puppeteer';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PORT = 19380;
const BASE = `http://localhost:${PORT}`;
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// Use a fresh temp database so screenshots have clean data
process.env.MC_DATA_DIR = mkdtempSync(join(tmpdir(), 'mc-screenshots-'));

// Start server
const { createServer } = await import('../dist/server.js');
const srv = createServer(PORT, true);
srv.start();
await new Promise(r => setTimeout(r, 800));

const { accessCode, hookToken } = srv;

async function hookPost(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${hookToken}` },
    body: JSON.stringify(body),
  });
}

async function authedReq(method, path, body, cookie) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Authenticate
const authRes = await fetch(`${BASE}/api/auth`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: accessCode }),
});
const setCookie = authRes.headers.get('set-cookie') || '';
const cookie = setCookie.split(';')[0];
const cookieVal = cookie.split('=')[1];
console.log('Auth:', cookie ? 'OK' : 'FAILED');

// ── Seed data ───────────────────────────────────────────
// Realistic multi-project scenario: 4 agents across 3 projects with subagents.

const d = (ms) => new Promise(r => setTimeout(r, ms));

// ── Agent 1: Backend developer working on auth ──
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Read', tool_input: { file_path: '/projects/saas-app/src/auth/middleware.ts' },
  cwd: '/projects/saas-app',
});
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Edit', tool_input: { file_path: '/projects/saas-app/src/auth/jwt.ts', old_string: 'TODO', new_string: 'jwt.verify(token, secret)' },
  cwd: '/projects/saas-app',
});
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Bash', tool_input: { command: 'npm test -- --grep auth' },
  cwd: '/projects/saas-app',
});
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Edit', tool_input: { file_path: '/projects/saas-app/src/routes/api.ts' },
  cwd: '/projects/saas-app',
});

// Subagent: security review
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'sub-sec', event_type: 'subagent_start',
  tool_name: 'Agent', tool_input: { description: 'Security review of JWT implementation' },
});
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'sub-sec', event_type: 'pre_tool_use',
  tool_name: 'Grep', tool_input: { pattern: 'API_KEY|SECRET|password' },
});

// ── Agent 2: Frontend developer on React dashboard ──
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Edit', tool_input: { file_path: '/projects/dashboard/src/components/AgentCard.tsx' },
  cwd: '/projects/dashboard',
});
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Write', tool_input: { file_path: '/projects/dashboard/src/hooks/useWebSocket.ts' },
  cwd: '/projects/dashboard',
});
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Bash', tool_input: { command: 'npm run dev' },
  cwd: '/projects/dashboard',
});

// Subagent: writing tests
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'sub-tests', event_type: 'subagent_start',
  tool_name: 'Agent', tool_input: { description: 'Write component tests for AgentCard' },
});
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'sub-tests', event_type: 'pre_tool_use',
  tool_name: 'Write', tool_input: { file_path: '/projects/dashboard/test/AgentCard.test.tsx' },
});

// ── Agent 3: DevOps — CI/CD pipeline (completed) ──
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-charlie', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Edit', tool_input: { file_path: '/projects/saas-app/.github/workflows/ci.yml' },
  cwd: '/projects/infra',
});
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-charlie', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Bash', tool_input: { command: 'docker build -t saas-app:latest .' },
  cwd: '/projects/infra',
});
// Session ended — auto-completes mission
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-charlie', agent_id: 'main', event_type: 'stop',
  cwd: '/projects/infra',
});

// ── Agent 4: Test runner ──
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-delta', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Bash', tool_input: { command: 'npx vitest run --coverage' },
  cwd: '/projects/saas-app',
});
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-delta', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Read', tool_input: { file_path: '/projects/saas-app/coverage/lcov-report/index.html' },
  cwd: '/projects/saas-app',
});

// ── Instruction (shows in instruct panel) ──
await authedReq('POST', '/api/instructions', {
  target_agent_id: 'sess-alpha:main',
  message: 'Skip OAuth for now — focus on JWT refresh tokens',
}, cookie);

// ── Security event (sensitive file access) ──
await d(50);
await hookPost('/api/events', {
  session_id: 'sess-delta', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Read', tool_input: { file_path: '/projects/saas-app/.env.production' },
  cwd: '/projects/saas-app',
});

await d(300);

console.log('Data seeded.');
await new Promise(r => setTimeout(r, 500));

// ── Screenshots ─────────────────────────────────────────

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

async function shot(name, opts = {}) {
  const page = await browser.newPage();
  await page.setViewport(opts.viewport || { width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.setCookie({ name: 'mc_session', value: cookieVal, domain: 'localhost', path: '/' });

  await page.goto(`${BASE}${opts.url || '/'}`, { waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 400));

  if (opts.action) await opts.action(page);
  await new Promise(r => setTimeout(r, opts.delay || 400));

  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: !!opts.fullPage });
  console.log(`  ${name}.png`);
  await page.close();
}

// Login
await shot('login', { url: '/login' });

// Dashboard — click an agent to show instruct panel, then move mouse away to hide tooltip
await shot('dashboard', {
  action: async (p) => {
    const agents = await p.$$('.agent-row');
    if (agents.length > 1) {
      await agents[1].click();
      await new Promise(r => setTimeout(r, 200));
    }
    // Move mouse to center of page to dismiss any tooltip
    await p.mouse.move(720, 450);
    await new Promise(r => setTimeout(r, 300));
  },
});

// Security panel
await shot('security', {
  action: async (p) => {
    const btn = await p.$('#security-btn');
    if (btn) { await btn.click(); await new Promise(r => setTimeout(r, 500)); }
  }
});

// Help overlay
await shot('help', {
  action: async (p) => {
    const btn = await p.$('#help-btn') || await p.$('.kbd-hint');
    if (btn) { await btn.click(); await new Promise(r => setTimeout(r, 300)); }
    else { await p.keyboard.press('?'); await new Promise(r => setTimeout(r, 300)); }
  }
});

// Mobile views
const mob = { width: 375, height: 812, deviceScaleFactor: 2 };

await shot('mobile-login', { viewport: mob, url: '/login' });
await shot('mobile-agents', { viewport: mob });
await shot('mobile-missions', {
  viewport: mob,
  action: async (p) => {
    const btn = await p.$('[data-tab="missions"]');
    if (btn) { await btn.click(); await new Promise(r => setTimeout(r, 200)); }
  }
});
await shot('mobile-timeline', {
  viewport: mob,
  action: async (p) => {
    const btn = await p.$('[data-tab="timeline"]');
    if (btn) { await btn.click(); await new Promise(r => setTimeout(r, 200)); }
  }
});

await browser.close();
srv.stop();
console.log('\nDone! Screenshots in docs/screenshots/');
process.exit(0);
