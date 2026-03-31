#!/usr/bin/env node
'use strict';

/**
 * Claude Code Hook Script — Mission Control
 *
 * Runs inside Claude Code's hook system on PreToolUse, PostToolUse, and Stop events.
 * Plain JavaScript, no dependencies, uses only Node.js built-ins.
 *
 * Behavior:
 *   1. Reads JSON from stdin
 *   2. POSTs the event to the Mission Control server (fire-and-forget, 2s timeout)
 *   3. On PreToolUse: GETs pending instructions and writes them to stderr
 *   4. NEVER crashes, NEVER blocks Claude Code — all errors are silently caught
 *   5. Always exits 0
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MC_HOST = process.env.CLAUDE_MC_HOST || 'localhost';
const MC_PORT = parseInt(process.env.CLAUDE_MC_PORT || '4280', 10);
const TIMEOUT_MS = 2000;

// Read hook token from file (written by server on startup)
let HOOK_TOKEN = '';
try {
  const tokenPath = path.join(os.homedir(), '.claude-mission-control', 'hook-token');
  HOOK_TOKEN = fs.readFileSync(tokenPath, 'utf-8').trim();
} catch {
  // Token file not found — server may not be running
}

/**
 * Make an HTTP request with a timeout. Returns parsed JSON or null on failure.
 */
function httpRequest(method, path, body) {
  return new Promise((resolve) => {
    try {
      const options = {
        hostname: MC_HOST,
        port: MC_PORT,
        path,
        method,
        headers: {},
        timeout: TIMEOUT_MS,
      };

      // Authenticate with hook token
      if (HOOK_TOKEN) {
        options.headers['Authorization'] = 'Bearer ' + HOOK_TOKEN;
      }

      let payload = null;
      if (body != null) {
        payload = JSON.stringify(body);
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf-8');
            resolve(raw.length > 0 ? JSON.parse(raw) : null);
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      if (payload != null) {
        req.write(payload);
      }
      req.end();
    } catch {
      resolve(null);
    }
  });
}

/**
 * Read all of stdin as a string.
 */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', () => resolve(''));
    // If stdin is already ended (no pipe), resolve immediately
    if (process.stdin.readableEnded) {
      resolve('');
    }
  });
}

async function main() {
  // 1. Read JSON from stdin
  let stdinData = {};
  try {
    const raw = await readStdin();
    if (raw.length > 0) {
      stdinData = JSON.parse(raw);
    }
  } catch {
    // Invalid JSON on stdin — proceed with empty object
  }

  // 2. Determine event context from environment + stdin
  const eventType = process.env.CLAUDE_HOOK_EVENT_NAME || stdinData.hook_event_name || 'unknown';
  const sessionId = process.env.CLAUDE_SESSION_ID || stdinData.session_id || process.ppid?.toString() || 'unknown';
  const model = process.env.CLAUDE_MODEL || stdinData.model || null;
  const cwd = process.cwd();

  // 3. Extract agent_id from stdin JSON (default 'main')
  const agentId = stdinData.agent_id || 'main';
  const compositeId = `${sessionId}:${agentId}`;

  // 4. Build the event payload
  const event = {
    session_id: sessionId,
    agent_id: agentId,
    event_type: eventType,
    tool_name: stdinData.tool_name || null,
    tool_input: stdinData.tool_input || null,
    tool_output: stdinData.tool_output || null,
    cwd,
    model,
  };

  // 5. POST event to Mission Control (fire-and-forget)
  const postPromise = httpRequest('POST', '/api/events', event);

  // 6. For PreToolUse: fetch and display pending instructions
  if (eventType === 'PreToolUse') {
    // Wait for POST to complete first so the agent is registered
    await postPromise;

    const instructions = await httpRequest(
      'GET',
      `/api/instructions/${encodeURIComponent(compositeId)}`,
      null,
    );

    if (Array.isArray(instructions) && instructions.length > 0) {
      for (const instruction of instructions) {
        // Write to stderr — Claude Code surfaces stderr as warnings to the agent
        process.stderr.write(
          `[Mission Control] ${instruction.message}\n`,
        );
      }
    }
  } else {
    // For non-PreToolUse events, just await the POST
    await postPromise;
  }
}

// Run and always exit 0
main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
