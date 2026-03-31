import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../helpers';

const tmpDir = setupTestDb();

const db = await import('../../src/db');
const { agentTracker } = await import('../../src/services/agent-tracker');

afterAll(() => {
  agentTracker.stop();
  teardownTestDb(tmpDir);
});

describe('agent-tracker — trackEvent', () => {
  it('registers a new agent from an event', () => {
    const evt = db.insertEvent({
      agent_id: 'sess1:main',
      session_id: 'sess1',
      event_type: 'pre_tool_use',
      tool_name: 'Bash',
      tool_input: JSON.stringify({ command: 'ls', cwd: '/home/user' }),
      tool_output: null,
      mission_id: null,
      timestamp: new Date().toISOString(),
    });

    const agent = agentTracker.trackEvent(evt);
    expect(agent.id).toBe('sess1:main');
    expect(agent.status).toBe('active');
  });

  it('updates last_seen_at on subsequent events', () => {
    const agent1 = db.getAgent('sess1:main');
    expect(agent1).toBeDefined();

    // Small delay to ensure different timestamp
    const evt2 = db.insertEvent({
      agent_id: 'sess1:main',
      session_id: 'sess1',
      event_type: 'post_tool_use',
      tool_name: 'Bash',
      tool_input: null,
      tool_output: '{"output":"done"}',
      mission_id: null,
      timestamp: new Date().toISOString(),
    });

    agentTracker.trackEvent(evt2);
    const agent2 = db.getAgent('sess1:main');
    expect(agent2).toBeDefined();
    expect(new Date(agent2!.last_seen_at).getTime()).toBeGreaterThanOrEqual(
      new Date(agent1!.last_seen_at).getTime(),
    );
  });
});

describe('agent-tracker — sweep', () => {
  it('transitions active → idle after threshold', () => {
    const now = new Date();

    // Create an agent with last_seen_at 90 seconds ago
    const twoMinAgo = new Date(now.getTime() - 90_000).toISOString();
    db.upsertAgent({
      id: 'old-agent:main',
      session_id: 'old-agent',
      agent_id: 'main',
      name: null,
      status: 'active',
      cwd: null,
      model: null,
      current_mission_id: null,
      first_seen_at: twoMinAgo,
      last_seen_at: twoMinAgo,
    });

    agentTracker.sweep();

    const agent = db.getAgent('old-agent:main');
    expect(agent).toBeDefined();
    expect(agent!.status).toBe('idle');
  });

  it('transitions idle → disconnected after threshold', () => {
    const now = new Date();
    const tenMinAgo = new Date(now.getTime() - 600_000).toISOString();

    db.upsertAgent({
      id: 'gone-agent:main',
      session_id: 'gone-agent',
      agent_id: 'main',
      name: null,
      status: 'active',
      cwd: null,
      model: null,
      current_mission_id: null,
      first_seen_at: tenMinAgo,
      last_seen_at: tenMinAgo,
    });

    agentTracker.sweep();

    const agent = db.getAgent('gone-agent:main');
    expect(agent).toBeDefined();
    expect(agent!.status).toBe('disconnected');
  });

  it('does not change recently active agents', () => {
    agentTracker.sweep();
    const agent = db.getAgent('sess1:main');
    expect(agent).toBeDefined();
    expect(agent!.status).toBe('active');
  });
});

describe('agent-tracker — start/stop', () => {
  it('can start and stop without error', () => {
    expect(() => {
      agentTracker.start();
      agentTracker.stop();
    }).not.toThrow();
  });

  it('start is idempotent', () => {
    agentTracker.start();
    agentTracker.start(); // second call should not throw
    agentTracker.stop();
  });
});
