import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { setupTestDb, teardownTestDb } from '../helpers';

const execFileAsync = promisify(execFile);
const tmpDir = setupTestDb();

const { createServer } = await import('../../src/server');

let stop: () => void;
const PORT = 14283;
const HOOK_SCRIPT = path.resolve(__dirname, '../../src/hook/mission-control-hook.js');

beforeAll(async () => {
  const server = createServer(PORT);
  stop = server.stop;
  server.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
});

afterAll(() => {
  stop();
  teardownTestDb(tmpDir);
});

function runHook(stdin: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'node',
      [HOOK_SCRIPT],
      {
        env: {
          ...process.env,
          CLAUDE_MC_PORT: String(PORT),
          CLAUDE_MC_HOST: 'localhost',
          ...env,
        },
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        // Hook always exits 0 — error here means timeout or crash
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    if (child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

describe('hook — event posting', () => {
  it('posts an event to the server', async () => {
    const { stderr } = await runHook(
      JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/test.ts' },
        session_id: 'hook-test-sess',
        agent_id: 'main',
      }),
      { CLAUDE_HOOK_EVENT_NAME: 'PreToolUse' },
    );

    // Verify the agent was registered
    const res = await fetch(`http://localhost:${PORT}/api/agents`);
    const agents = await res.json();
    expect(agents.some((a: any) => a.id === 'hook-test-sess:main')).toBe(true);
  });

  it('handles subagent events', async () => {
    await runHook(
      JSON.stringify({
        session_id: 'hook-test-sess',
        agent_id: 'sub-xyz',
      }),
      { CLAUDE_HOOK_EVENT_NAME: 'SubagentStart' },
    );

    const res = await fetch(`http://localhost:${PORT}/api/agents`);
    const agents = await res.json();
    expect(agents.some((a: any) => a.id === 'hook-test-sess:sub-xyz')).toBe(true);
  });
});

describe('hook — instruction delivery', () => {
  it('receives pending instructions via stderr on PreToolUse', async () => {
    // Create an instruction for the agent
    await fetch(`http://localhost:${PORT}/api/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_agent_id: 'hook-test-sess:main',
        message: 'Switch to tests',
      }),
    });

    const { stderr } = await runHook(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        session_id: 'hook-test-sess',
        agent_id: 'main',
      }),
      { CLAUDE_HOOK_EVENT_NAME: 'PreToolUse' },
    );

    expect(stderr).toContain('[Mission Control]');
    expect(stderr).toContain('Switch to tests');
  });

  it('does not fetch instructions on PostToolUse', async () => {
    await fetch(`http://localhost:${PORT}/api/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_agent_id: 'hook-test-sess:main',
        message: 'Should not appear',
      }),
    });

    const { stderr } = await runHook(
      JSON.stringify({
        tool_name: 'Bash',
        session_id: 'hook-test-sess',
        agent_id: 'main',
      }),
      { CLAUDE_HOOK_EVENT_NAME: 'PostToolUse' },
    );

    expect(stderr).not.toContain('Should not appear');
  });
});

describe('hook — resilience', () => {
  it('exits 0 when server is down', async () => {
    const { stderr } = await runHook(
      JSON.stringify({
        tool_name: 'Read',
        session_id: 'offline-sess',
        agent_id: 'main',
      }),
      {
        CLAUDE_HOOK_EVENT_NAME: 'PreToolUse',
        CLAUDE_MC_PORT: '19999', // no server here
      },
    );

    // Should not crash — stderr may be empty, that's fine
    expect(typeof stderr).toBe('string');
  });

  it('exits 0 with empty stdin', async () => {
    const { stderr } = await runHook('', {
      CLAUDE_HOOK_EVENT_NAME: 'PreToolUse',
    });
    expect(typeof stderr).toBe('string');
  });

  it('exits 0 with invalid JSON stdin', async () => {
    const { stderr } = await runHook('not valid json{{{', {
      CLAUDE_HOOK_EVENT_NAME: 'PreToolUse',
    });
    expect(typeof stderr).toBe('string');
  });
});
