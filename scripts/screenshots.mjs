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
// Each session gets ONE initial event (triggers auto-mission) then a few follow-ups.
// No manual mission creation — auto-missions handle it.

// 3 main agents in different projects
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Edit', tool_input: { file_path: '/projects/mission-control/src/server.ts' },
  cwd: '/projects/mission-control',
});
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Bash', tool_input: { command: 'npm test --coverage' },
  cwd: '/projects/mission-control',
});

await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Edit', tool_input: { file_path: '/projects/api-service/src/routes/auth.ts' },
  cwd: '/projects/api-service',
});
await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Read', tool_input: { file_path: '/projects/api-service/package.json' },
  cwd: '/projects/api-service',
});

await hookPost('/api/events', {
  session_id: 'sess-charlie', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Bash', tool_input: { command: 'npx playwright test' },
  cwd: '/projects/web-frontend',
});

// 2 subagents with descriptive names
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'sub-security-review', event_type: 'subagent_start',
  tool_name: 'Agent', tool_input: { description: 'Security review of auth module' },
});
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'sub-security-review', event_type: 'pre_tool_use',
  tool_name: 'Grep', tool_input: { pattern: 'API_KEY|SECRET' },
});

await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'sub-test-writer', event_type: 'subagent_start',
  tool_name: 'Agent', tool_input: { description: 'Write unit tests for routes' },
});
await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'sub-test-writer', event_type: 'pre_tool_use',
  tool_name: 'Write', tool_input: { file_path: '/projects/api-service/test/auth.test.ts' },
});

// Complete one agent's session to show a completed mission
await hookPost('/api/events', {
  session_id: 'sess-charlie', agent_id: 'main', event_type: 'stop',
  cwd: '/projects/web-frontend',
});

// Instruction to show in the instruct panel
await authedReq('POST', '/api/instructions', {
  target_agent_id: 'sess-alpha:main',
  message: 'Focus on JWT validation, skip OAuth for now',
}, cookie);

// Trigger a security event
await hookPost('/api/events', {
  session_id: 'sess-charlie', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Read', tool_input: { file_path: '/Users/cyrus/.env.local' },
});

await new Promise(r => setTimeout(r, 200));

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
