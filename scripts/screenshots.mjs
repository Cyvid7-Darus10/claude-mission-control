#!/usr/bin/env node
/**
 * Take dashboard screenshots for README with seeded test data.
 * Self-contained: starts server, seeds data, captures, stops.
 * Usage: node scripts/screenshots.mjs
 */

import puppeteer from 'puppeteer';
import { mkdirSync } from 'fs';

const PORT = 19380;
const BASE = `http://localhost:${PORT}`;
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

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

const sessions = [
  { sid: 'sess-alpha', cwd: '/Users/cyrus/project/mission-control', tools: ['Edit', 'Bash', 'Read', 'Write'] },
  { sid: 'sess-bravo', cwd: '/Users/cyrus/project/api-service', tools: ['Bash', 'Grep', 'Edit'] },
  { sid: 'sess-charlie', cwd: '/Users/cyrus/project/web-frontend', tools: ['Read', 'Glob', 'Edit'] },
];

const files = ['src/server.ts', 'src/db.ts', 'src/api/events.ts', 'package.json', 'src/index.ts', 'test/db.test.ts', 'src/dashboard/app.js', 'src/hook/hook.js'];

// Main agents + subagents
for (const s of sessions) {
  for (let i = 0; i < 5; i++) {
    const tool = s.tools[i % s.tools.length];
    const file = files[Math.floor(Math.random() * files.length)];
    await hookPost('/api/events', {
      session_id: s.sid, agent_id: 'main', event_type: 'pre_tool_use',
      tool_name: tool,
      tool_input: tool === 'Bash' ? { command: 'npm run build && npm test' } : { file_path: s.cwd + '/' + file },
      cwd: s.cwd,
    });
    await new Promise(r => setTimeout(r, 30));
  }
}

// Subagents for alpha
for (const subId of ['sub-build-fix', 'sub-code-review']) {
  for (let i = 0; i < 3; i++) {
    await hookPost('/api/events', {
      session_id: 'sess-alpha', agent_id: subId, event_type: 'pre_tool_use',
      tool_name: i === 0 ? 'Read' : 'Edit',
      tool_input: { file_path: '/Users/cyrus/project/mission-control/src/' + files[i] },
    });
    await new Promise(r => setTimeout(r, 30));
  }
}

// Missions
const m1 = await authedReq('POST', '/api/missions', { title: 'Auth middleware', description: 'Implement JWT authentication for all API routes', priority: 8 }, cookie).then(r => r.json());
const m2 = await authedReq('POST', '/api/missions', { title: 'REST API routes', description: 'Build CRUD endpoints for missions and agents' }, cookie).then(r => r.json());
const m3 = await authedReq('POST', '/api/missions', { title: 'Unit tests', description: '80%+ coverage with vitest', priority: 5 }, cookie).then(r => r.json());
const m4 = await authedReq('POST', '/api/missions', { title: 'E2E tests', description: 'Playwright end-to-end tests', depends_on: [m2.id] }, cookie).then(r => r.json());
const m5 = await authedReq('POST', '/api/missions', { title: 'Dashboard polish', description: 'Palantir styling and mobile responsive' }, cookie).then(r => r.json());

await authedReq('PATCH', `/api/missions/${m1.id}`, { status: 'active', assigned_agent_id: 'sess-alpha:main' }, cookie);
await authedReq('PATCH', `/api/missions/${m2.id}`, { status: 'active', assigned_agent_id: 'sess-bravo:main' }, cookie);
await authedReq('PATCH', `/api/missions/${m3.id}`, { status: 'completed', result: 'All 107 tests passing' }, cookie);

// Instruction
await authedReq('POST', '/api/instructions', { target_agent_id: 'sess-alpha:main', message: 'Focus on JWT validation, skip OAuth for now' }, cookie);

// Trigger a security event (sensitive file access)
await hookPost('/api/events', {
  session_id: 'sess-charlie', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Read', tool_input: { file_path: '/Users/cyrus/.env.local' },
});

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

// Dashboard
await shot('dashboard');

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
