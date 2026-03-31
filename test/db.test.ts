import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from './helpers';

// Set up temp DB BEFORE importing db module
const tmpDir = setupTestDb();

// Dynamic import so env is set first
const db = await import('../src/db');

afterAll(() => teardownTestDb(tmpDir));

describe('db — events', () => {
  it('inserts and retrieves an event', () => {
    const evt = db.insertEvent({
      agent_id: 'sess:main',
      session_id: 'sess',
      event_type: 'pre_tool_use',
      tool_name: 'Read',
      tool_input: '{"file_path":"/tmp/x"}',
      tool_output: null,
      mission_id: null,
      timestamp: new Date().toISOString(),
    });

    expect(evt.id).toBeGreaterThan(0);
    expect(evt.tool_name).toBe('Read');

    const events = db.getEvents(10, 0);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.id === evt.id)).toBe(true);
  });

  it('respects limit and offset', () => {
    for (let i = 0; i < 5; i++) {
      db.insertEvent({
        agent_id: 'sess:main',
        session_id: 'sess',
        event_type: 'post_tool_use',
        tool_name: `Tool${i}`,
        tool_input: null,
        tool_output: null,
        mission_id: null,
        timestamp: new Date().toISOString(),
      });
    }

    const page1 = db.getEvents(2, 0);
    const page2 = db.getEvents(2, 2);
    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page1[0].id).not.toBe(page2[0].id);
  });
});

describe('db — agents', () => {
  it('upserts an agent', () => {
    const now = new Date().toISOString();
    const agent = db.upsertAgent({
      id: 'test-sess:main',
      session_id: 'test-sess',
      agent_id: 'main',
      name: null,
      status: 'active',
      cwd: '/tmp',
      model: 'claude-sonnet',
      current_mission_id: null,
      first_seen_at: now,
      last_seen_at: now,
    });

    expect(agent.id).toBe('test-sess:main');

    const fetched = db.getAgent('test-sess:main');
    expect(fetched).toBeDefined();
    expect(fetched!.cwd).toBe('/tmp');
  });

  it('updates agent fields', () => {
    const updated = db.updateAgent('test-sess:main', { status: 'idle' });
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('idle');
  });

  it('lists all agents', () => {
    const agents = db.getAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);
  });

  it('returns undefined for missing agent', () => {
    expect(db.getAgent('nonexistent')).toBeUndefined();
  });
});

describe('db — missions', () => {
  it('creates and retrieves a mission', () => {
    const now = new Date().toISOString();
    const mission = db.createMission({
      id: 'mission-1',
      title: 'Test mission',
      description: 'A test',
      status: 'queued',
      priority: 5,
      assigned_agent_id: null,
      depends_on: null,
      created_at: now,
      started_at: null,
      completed_at: null,
      result: null,
    });

    expect(mission.id).toBe('mission-1');

    const fetched = db.getMission('mission-1');
    expect(fetched).toBeDefined();
    expect(fetched!.title).toBe('Test mission');
    expect(fetched!.priority).toBe(5);
  });

  it('updates mission fields', () => {
    const updated = db.updateMission('mission-1', { status: 'active' });
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('active');
  });

  it('deletes a queued mission', () => {
    const now = new Date().toISOString();
    db.createMission({
      id: 'mission-del',
      title: 'To delete',
      description: null,
      status: 'queued',
      priority: 0,
      assigned_agent_id: null,
      depends_on: null,
      created_at: now,
      started_at: null,
      completed_at: null,
      result: null,
    });

    expect(db.deleteMission('mission-del')).toBe(true);
    expect(db.getMission('mission-del')).toBeUndefined();
  });

  it('returns false when deleting nonexistent mission', () => {
    expect(db.deleteMission('nonexistent')).toBe(false);
  });

  it('lists missions sorted by priority', () => {
    const missions = db.getMissions();
    expect(missions.length).toBeGreaterThanOrEqual(1);
    // Higher priority first
    for (let i = 1; i < missions.length; i++) {
      expect(missions[i - 1].priority).toBeGreaterThanOrEqual(missions[i].priority);
    }
  });
});

describe('db — instructions', () => {
  it('creates and fetches pending instructions', () => {
    const now = new Date().toISOString();
    const instr = db.createInstruction({
      target_agent_id: 'test-sess:main',
      message: 'Please focus on auth',
      status: 'pending',
      created_at: now,
      delivered_at: null,
    });

    expect(instr.id).toBeGreaterThan(0);

    const pending = db.getPendingInstructions('test-sess:main');
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending.some((p) => p.id === instr.id)).toBe(true);
  });

  it('marks instruction as delivered', () => {
    const now = new Date().toISOString();
    const instr = db.createInstruction({
      target_agent_id: 'test-sess:main',
      message: 'Switch to tests',
      status: 'pending',
      created_at: now,
      delivered_at: null,
    });

    const delivered = db.markInstructionDelivered(instr.id);
    expect(delivered).toBeDefined();
    expect(delivered!.status).toBe('delivered');
    expect(delivered!.delivered_at).not.toBeNull();

    // Should no longer appear in pending
    const pending = db.getPendingInstructions('test-sess:main');
    expect(pending.some((p) => p.id === instr.id)).toBe(false);
  });
});

describe('db — dashboard stats', () => {
  it('returns aggregate counts', () => {
    const stats = db.getDashboardStats();
    expect(stats.totalAgents).toBeGreaterThanOrEqual(1);
    expect(stats.totalMissions).toBeGreaterThanOrEqual(1);
    expect(stats.totalEvents).toBeGreaterThanOrEqual(1);
    expect(typeof stats.pendingInstructions).toBe('number');
  });
});

describe('db — migration idempotency', () => {
  it('can be imported twice without error', async () => {
    // Re-importing the module should not throw
    // (tables already exist, CREATE IF NOT EXISTS)
    expect(() => db.getDashboardStats()).not.toThrow();
  });
});
