#!/usr/bin/env node
/**
 * Generate an animated GIF showcasing Mission Control dashboard.
 * Seeds data incrementally and captures frames to simulate real-time activity.
 * Usage: node scripts/showcase-gif.mjs
 * Output: docs/showcase.gif
 */

import puppeteer from 'puppeteer';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

const PORT = 19381;
const BASE = `http://localhost:${PORT}`;
const FRAME_DIR = mkdtempSync(join(tmpdir(), 'mc-gif-frames-'));
const OUT_GIF = new URL('../docs/showcase.gif', import.meta.url).pathname;

// Fresh temp database
process.env.MC_DATA_DIR = mkdtempSync(join(tmpdir(), 'mc-gif-data-'));

// Start server
const { createServer } = await import('../dist/server.js');
const srv = createServer(PORT, true);
srv.start();
await new Promise(r => setTimeout(r, 1000));

const { accessCode, hookToken } = srv;

async function hookPost(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify(body),
  });
}

async function authedReq(method, path, body, cookie) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
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

if (!cookieVal) { console.error('Auth failed'); process.exit(1); }
console.log('Auth: OK');

// ── Browser setup ──────────────────────────────────────
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await page.setCookie({ name: 'mc_session', value: cookieVal, domain: 'localhost', path: '/' });

let frameNum = 0;
const d = (ms) => new Promise(r => setTimeout(r, ms));
const FPS = 3;

async function capture(wait = 200) {
  await d(wait);
  const name = String(frameNum++).padStart(4, '0');
  await page.screenshot({ path: `${FRAME_DIR}/frame-${name}.png` });
}

// Capture multiple frames rapidly (for animations like radar spin)
async function captureN(n, interval = 333) {
  for (let i = 0; i < n; i++) await capture(interval);
}

// ── Scene 1: Empty dashboard (brief) ───────────────────
await page.goto(`${BASE}/`, { waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
await d(500);
await capture(100);
await capture(400);

// ── Scene 2: First agent appears — Backend developer ───
console.log('Scene 2: Agent 1 — backend auth');
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Read', tool_input: { file_path: '/projects/saas-app/src/auth/middleware.ts' },
  cwd: '/projects/saas-app',
});
await capture(500);

await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Edit', tool_input: { file_path: '/projects/saas-app/src/auth/jwt.ts', old_string: 'TODO', new_string: 'jwt.verify(token, secret)' },
  cwd: '/projects/saas-app',
});
await capture(400);

// ── Scene 3: Second agent — Frontend developer ─────────
console.log('Scene 3: Agent 2 — frontend');
await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Edit', tool_input: { file_path: '/projects/dashboard/src/components/AgentCard.tsx' },
  cwd: '/projects/dashboard',
});
await capture(500);

await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Write', tool_input: { file_path: '/projects/dashboard/src/hooks/useWebSocket.ts' },
  cwd: '/projects/dashboard',
});
await capture(350);

// ── Scene 4: Third + fourth agents ─────────────────────
console.log('Scene 4: Agents 3+4');
await hookPost('/api/events', {
  session_id: 'sess-charlie', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Edit', tool_input: { file_path: '/projects/saas-app/.github/workflows/ci.yml' },
  cwd: '/projects/infra',
});
await capture(400);

await hookPost('/api/events', {
  session_id: 'sess-delta', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Bash', tool_input: { command: 'npx vitest run --coverage' },
  cwd: '/projects/saas-app',
});
await capture(400);

// ── Scene 5: Activity burst — subagents + more tools ───
console.log('Scene 5: Activity burst');
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Bash', tool_input: { command: 'npm test -- --grep auth' },
  cwd: '/projects/saas-app',
});
await d(80);
await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Bash', tool_input: { command: 'npm run dev' },
  cwd: '/projects/dashboard',
});
await capture(400);

await hookPost('/api/events', {
  session_id: 'sess-charlie', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Bash', tool_input: { command: 'docker build -t saas-app:latest .' },
  cwd: '/projects/infra',
});
await d(80);
// Subagent spawns
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'sub-sec', event_type: 'subagent_start',
  tool_name: 'Agent', tool_input: { description: 'Security review of JWT implementation' },
});
await capture(400);

await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'sub-sec', event_type: 'pre_tool_use',
  tool_name: 'Grep', tool_input: { pattern: 'API_KEY|SECRET|password' },
});
await d(80);
await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'sub-tests', event_type: 'subagent_start',
  tool_name: 'Agent', tool_input: { description: 'Write component tests for AgentCard' },
});
await capture(400);

await hookPost('/api/events', {
  session_id: 'sess-delta', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Read', tool_input: { file_path: '/projects/saas-app/coverage/lcov-report/index.html' },
  cwd: '/projects/saas-app',
});
await d(80);
await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Edit', tool_input: { file_path: '/projects/saas-app/src/routes/api.ts' },
  cwd: '/projects/saas-app',
});
await capture(400);

// Hold on busy dashboard
await capture(500);
await capture(400);

// ── Scene 6: Click agent to show details panel ─────────
console.log('Scene 6: Select agent');
const agents = await page.$$('.agent-row');
if (agents.length >= 1) {
  await agents[0].click();
  await capture(500);
  await capture(400);
}

// ── Scene 7: Type an instruction to the agent ──────────
console.log('Scene 7: Send instruction');
const cmdInput = await page.$('#command-input');
if (cmdInput) {
  await cmdInput.click();
  await d(200);
  // Type character by character for visual effect
  await page.type('#command-input', 'Focus on JWT refresh tokens', { delay: 50 });
  await capture(100);  // mid-typing
  await capture(400);  // typed
  // Press Enter to send
  await page.keyboard.press('Enter');
  await capture(500);
}

// Also create the instruction server-side so it shows in log
await authedReq('POST', '/api/instructions', {
  target_agent_id: 'sess-alpha:main',
  message: 'Skip OAuth for now — focus on JWT refresh tokens',
}, cookie);
await capture(400);

// ── Scene 8: Security event triggers warning ───────────
console.log('Scene 8: Security alert — .env access');
// Trigger multiple security events for more drama
await hookPost('/api/events', {
  session_id: 'sess-delta', agent_id: 'main', event_type: 'pre_tool_use',
  tool_name: 'Read', tool_input: { file_path: '/projects/saas-app/.env.production' },
  cwd: '/projects/saas-app',
});
await capture(400);

await hookPost('/api/events', {
  session_id: 'sess-alpha', agent_id: 'sub-sec', event_type: 'pre_tool_use',
  tool_name: 'Read', tool_input: { file_path: '/projects/saas-app/secrets/database.key' },
  cwd: '/projects/saas-app',
});
await capture(300);

// ── Scene 9: Open Security Radar panel ─────────────────
console.log('Scene 9: Open radar');
const secBtn = await page.$('#security-btn');
if (secBtn) {
  await secBtn.click();
  await d(300);
  // Capture multiple frames to show radar sweep animation
  await captureN(6, 350);  // ~2s of radar spinning
}

// Close security panel
const secClose = await page.$('#security-close');
if (secClose) {
  await secClose.click();
  await capture(400);
}

// ── Scene 10: Open Help overlay ────────────────────────
console.log('Scene 10: Help overlay');
await page.keyboard.press('?');
await capture(500);
await capture(500);
await capture(400);
// Close help
await page.keyboard.press('Escape');
await capture(300);

// ── Scene 11: Agent completes — DevOps finishes ────────
console.log('Scene 11: Agent completes');
await hookPost('/api/events', {
  session_id: 'sess-charlie', agent_id: 'main', event_type: 'stop',
  cwd: '/projects/infra',
});
await capture(500);

// More activity keeps flowing
await hookPost('/api/events', {
  session_id: 'sess-bravo', agent_id: 'sub-tests', event_type: 'pre_tool_use',
  tool_name: 'Write', tool_input: { file_path: '/projects/dashboard/test/AgentCard.test.tsx' },
});
await capture(400);

// ── Scene 12: Final panorama ───────────────────────────
console.log('Scene 12: Final hold');
// Deselect agent, clean view
await page.mouse.move(720, 450);
await page.click('#main-grid');
await capture(400);
await capture(600);
await capture(600);

console.log(`\nCaptured ${frameNum} frames in ${FRAME_DIR}`);

// ── Compile GIF with ffmpeg (two-pass for quality) ─────
console.log('Compiling GIF with ffmpeg...');

try {
  const palettePath = join(FRAME_DIR, 'palette.png');
  const inputPattern = join(FRAME_DIR, 'frame-%04d.png');
  const filters = `fps=${FPS},scale=900:-1:flags=lanczos`;

  // Pass 1: generate optimised palette
  execFileSync('ffmpeg', [
    '-y', '-framerate', String(FPS),
    '-i', inputPattern,
    '-vf', `${filters},palettegen=max_colors=256:stats_mode=diff`,
    palettePath,
  ], { stdio: 'inherit' });

  // Pass 2: encode GIF with palette
  execFileSync('ffmpeg', [
    '-y', '-framerate', String(FPS),
    '-i', inputPattern,
    '-i', palettePath,
    '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    OUT_GIF,
  ], { stdio: 'inherit' });

  console.log(`\nGIF saved to ${OUT_GIF}`);
} catch (e) {
  console.error('ffmpeg failed:', e.message);
  console.log(`Frames are in ${FRAME_DIR} — compile manually with ffmpeg`);
}

// Cleanup
await browser.close();
srv.stop();

try { rmSync(FRAME_DIR, { recursive: true }); } catch {}
try { rmSync(process.env.MC_DATA_DIR, { recursive: true }); } catch {}

console.log('Done!');
process.exit(0);
