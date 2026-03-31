#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createServer } from './server';

const VERSION = '0.1.0';
const DATA_DIR = path.join(os.homedir(), '.claude-mission-control');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): {
  command: 'start' | 'install' | 'uninstall';
  port: number;
  open: boolean;
} {
  const args = argv.slice(2);
  let command: 'start' | 'install' | 'uninstall' = 'start';
  let port = 4280;
  let open = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'install') {
      command = 'install';
    } else if (arg === 'uninstall') {
      command = 'uninstall';
    } else if (arg === 'start') {
      command = 'start';
    } else if (arg === '--port' && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
        port = parsed;
      }
      i++;
    } else if (arg === '--open') {
      open = true;
    }
  }

  return { command, port, open };
}

// ---------------------------------------------------------------------------
// Hook install / uninstall
// ---------------------------------------------------------------------------

interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

interface HookEntry {
  matcher?: string;
  hooks?: { type: string; command: string; async?: boolean; timeout?: number }[];
  type?: string;
  command?: string;
  description?: string;
  [key: string]: unknown;
}

const SETTINGS_PATH = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? '~',
  '.claude',
  'settings.json',
);

const HOOK_MARKER = 'Mission Control';

function getHookScriptPath(): string {
  // Resolve the hook script relative to the installed package
  return path.resolve(__dirname, '..', 'src', 'hook', 'mission-control-hook.js');
}

function readSettings(): ClaudeSettings {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return {};
  }
  const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
  if (raw.trim().length === 0) {
    return {};
  }
  // Let JSON.parse throw on corrupt files — caller sees the error
  // rather than silently overwriting the user's settings
  return JSON.parse(raw) as ClaudeSettings;
}

function writeSettings(settings: ClaudeSettings): void {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function backupSettings(): void {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return;
  }
  const backupPath = SETTINGS_PATH + '.backup';
  fs.copyFileSync(SETTINGS_PATH, backupPath);
  console.log(`  Backup: ${backupPath}`);
}

function buildHookEntries(): { event: string; entry: HookEntry }[] {
  const hookScript = getHookScriptPath();
  return [
    {
      event: 'PreToolUse',
      entry: {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node "${hookScript}"`,
            async: true,
            timeout: 5,
          },
        ],
        description: 'Mission Control: report tool use and fetch instructions',
      },
    },
    {
      event: 'PostToolUse',
      entry: {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node "${hookScript}"`,
            async: true,
            timeout: 5,
          },
        ],
        description: 'Mission Control: report tool completion',
      },
    },
    {
      event: 'SubagentStart',
      entry: {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node "${hookScript}"`,
            async: true,
            timeout: 5,
          },
        ],
        description: 'Mission Control: report subagent spawn',
      },
    },
    {
      event: 'SubagentStop',
      entry: {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node "${hookScript}"`,
            async: true,
            timeout: 5,
          },
        ],
        description: 'Mission Control: report subagent end',
      },
    },
    {
      event: 'Stop',
      entry: {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node "${hookScript}"`,
            async: true,
            timeout: 5,
          },
        ],
        description: 'Mission Control: report session end',
      },
    },
  ];
}

function installHooks(): void {
  console.log('\n  Installing Mission Control hooks...\n');
  backupSettings();

  const settings = readSettings();
  const hooks = settings.hooks ?? {};

  for (const { event, entry } of buildHookEntries()) {
    const existing: HookEntry[] = hooks[event] ?? [];

    // Remove any previous Mission Control entries (idempotent)
    const filtered = existing.filter(
      (h) => !(h.description && h.description.includes(HOOK_MARKER)),
    );

    // Add the new entry
    filtered.push(entry);
    hooks[event] = filtered;
  }

  settings.hooks = hooks;
  writeSettings(settings);

  console.log('  Hooks installed:');
  console.log('    - PreToolUse     -> report events + fetch instructions');
  console.log('    - PostToolUse    -> report tool completion');
  console.log('    - SubagentStart  -> report subagent spawn');
  console.log('    - SubagentStop   -> report subagent end');
  console.log('    - Stop           -> report session end');
  console.log(`\n  Settings: ${SETTINGS_PATH}\n`);
}

function uninstallHooks(): void {
  console.log('\n  Uninstalling Mission Control hooks...\n');

  const settings = readSettings();
  const hooks = settings.hooks;

  if (!hooks) {
    console.log('  No hooks found in settings.\n');
    return;
  }

  let removed = 0;

  for (const event of Object.keys(hooks)) {
    const entries: HookEntry[] = hooks[event] ?? [];
    const filtered = entries.filter(
      (h) => !(h.description && h.description.includes(HOOK_MARKER)),
    );
    removed += entries.length - filtered.length;

    if (filtered.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = filtered;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = hooks;
  }

  writeSettings(settings);
  console.log(`  Removed ${removed} hook(s).\n`);
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  const bin =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';

  const args =
    process.platform === 'win32' ? ['/c', 'start', url] : [url];

  execFile(bin, args, () => {
    // Ignore errors — browser open is best-effort
  });
}

function printBanner(port: number, accessCode: string, hookToken: string, localOnly: boolean): void {
  // Get local network IP for sharing
  let localIp = 'unknown';
  try {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === 'IPv4' && !net.internal) {
          localIp = net.address;
          break;
        }
      }
      if (localIp !== 'unknown') break;
    }
  } catch {}

  const localUrl = `http://localhost:${port}`;
  const networkUrl = `http://${localIp}:${port}`;

  console.log('');
  console.log('  \x1b[2m{ SENTINEL }\x1b[0m  \x1b[1mMISSION CONTROL\x1b[0m v' + VERSION);
  console.log('  \x1b[2m─────────────────────────────────────────\x1b[0m');
  console.log('');
  console.log('  \x1b[2mLocal:\x1b[0m       ' + localUrl);
  if (!localOnly) {
    console.log('  \x1b[2mNetwork:\x1b[0m     ' + networkUrl);
  } else {
    console.log('  \x1b[2mNetwork:\x1b[0m     \x1b[2mdisabled (--local mode)\x1b[0m');
  }
  console.log('');
  console.log('  \x1b[2mAccess Code:\x1b[0m  \x1b[1m\x1b[33m' + accessCode + '\x1b[0m');
  console.log('');

  // QR code for quick mobile access (includes access code in URL)
  if (!localOnly) {
    const qrUrl = `${networkUrl}/login?code=${accessCode}`;
    console.log('  \x1b[2mScan to connect (auto-authenticates):\x1b[0m');
    console.log('');
    try {
      const qr = require('qrcode-terminal');
      qr.generate(qrUrl, { small: true }, function (code: string) {
        // Indent each line
        code.split('\n').forEach((line: string) => {
          console.log('    ' + line);
        });
        console.log('');
        console.log('  \x1b[2mOr share: ' + qrUrl + '\x1b[0m');
        printBannerFooter();
      });
      return; // async — footer printed in callback
    } catch {
      // qrcode-terminal not available — skip QR
      console.log('  \x1b[2mShare: ' + qrUrl + '\x1b[0m');
    }
  }

  printBannerFooter();
}

function printBannerFooter(): void {
  console.log('');
  console.log('  \x1b[2m─────────────────────────────────────────\x1b[0m');
  console.log('  Hooks: Listening for Claude Code events');
  console.log('  Press \x1b[1mCtrl+C\x1b[0m to stop.');
  console.log('');
}

function startServer(port: number, shouldOpen: boolean, localOnly: boolean): void {
  const { start, stop, accessCode, hookToken } = createServer(port, localOnly);

  process.on('SIGINT', () => {
    console.log('\n  Shutting down...');
    stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    stop();
    process.exit(0);
  });

  start();
  printBanner(port, accessCode, hookToken, localOnly);

  // Write hook token to a file the hook script can read
  const tokenPath = path.join(DATA_DIR, 'hook-token');
  fs.writeFileSync(tokenPath, hookToken, { mode: 0o600 });

  if (shouldOpen) {
    openBrowser(`http://localhost:${port}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { command, port, open } = parseArgs(process.argv);
const localOnly = process.argv.includes('--local');

switch (command) {
  case 'install':
    installHooks();
    break;
  case 'uninstall':
    uninstallHooks();
    break;
  case 'start':
    startServer(port, open, localOnly);
    break;
}
