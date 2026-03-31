import Database from "better-sqlite3";
import { join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Agent {
  readonly id: string;
  readonly session_id: string;
  readonly agent_id: string;
  readonly name: string | null;
  readonly status: string;
  readonly cwd: string | null;
  readonly model: string | null;
  readonly current_mission_id: string | null;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
}

export interface Mission {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: number;
  readonly assigned_agent_id: string | null;
  readonly depends_on: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly result: string | null;
}

export interface Event {
  readonly id: number;
  readonly agent_id: string | null;
  readonly session_id: string | null;
  readonly event_type: string;
  readonly tool_name: string | null;
  readonly tool_input: string | null;
  readonly tool_output: string | null;
  readonly mission_id: string | null;
  readonly timestamp: string;
}

export interface Instruction {
  readonly id: number;
  readonly target_agent_id: string;
  readonly message: string;
  readonly status: string;
  readonly created_at: string;
  readonly delivered_at: string | null;
}

interface DashboardStats {
  readonly totalAgents: number;
  readonly activeAgents: number;
  readonly idleAgents: number;
  readonly disconnectedAgents: number;
  readonly totalMissions: number;
  readonly queuedMissions: number;
  readonly activeMissions: number;
  readonly completedMissions: number;
  readonly failedMissions: number;
  readonly blockedMissions: number;
  readonly totalEvents: number;
  readonly pendingInstructions: number;
}

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

const DATA_DIR = join(homedir(), ".claude-mission-control");
const DB_PATH = join(DATA_DIR, "data.db");

function openDatabase(): Database.Database {
  mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id              TEXT PRIMARY KEY,
      session_id      TEXT,
      agent_id        TEXT DEFAULT 'main',
      name            TEXT,
      status          TEXT DEFAULT 'active',
      cwd             TEXT,
      model           TEXT,
      current_mission_id TEXT,
      first_seen_at   TEXT,
      last_seen_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS missions (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      description     TEXT,
      status          TEXT DEFAULT 'queued',
      priority        INTEGER DEFAULT 0,
      assigned_agent_id TEXT,
      depends_on      TEXT,
      created_at      TEXT,
      started_at      TEXT,
      completed_at    TEXT,
      result          TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id        TEXT,
      session_id      TEXT,
      event_type      TEXT NOT NULL,
      tool_name       TEXT,
      tool_input      TEXT,
      tool_output     TEXT,
      mission_id      TEXT,
      timestamp       TEXT
    );

    CREATE TABLE IF NOT EXISTS instructions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      target_agent_id TEXT NOT NULL,
      message         TEXT NOT NULL,
      status          TEXT DEFAULT 'pending',
      created_at      TEXT,
      delivered_at    TEXT
    );
  `);

  return db;
}

const db: Database.Database = openDatabase();

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

// -- Events -----------------------------------------------------------------

const stmtInsertEvent = db.prepare(`
  INSERT INTO events (agent_id, session_id, event_type, tool_name, tool_input, tool_output, mission_id, timestamp)
  VALUES (@agent_id, @session_id, @event_type, @tool_name, @tool_input, @tool_output, @mission_id, @timestamp)
`);

export function insertEvent(event: Omit<Event, "id">): Event {
  const info = stmtInsertEvent.run(event);
  return { ...event, id: Number(info.lastInsertRowid) };
}

const stmtGetEvents = db.prepare(`
  SELECT * FROM events ORDER BY id DESC LIMIT @limit OFFSET @offset
`);

export function getEvents(limit = 100, offset = 0): readonly Event[] {
  return stmtGetEvents.all({ limit, offset }) as Event[];
}

// -- Agents -----------------------------------------------------------------

const stmtUpsertAgent = db.prepare(`
  INSERT INTO agents (id, session_id, agent_id, name, status, cwd, model, current_mission_id, first_seen_at, last_seen_at)
  VALUES (@id, @session_id, @agent_id, @name, @status, @cwd, @model, @current_mission_id, @first_seen_at, @last_seen_at)
  ON CONFLICT(id) DO UPDATE SET
    session_id      = COALESCE(@session_id, agents.session_id),
    agent_id        = COALESCE(@agent_id, agents.agent_id),
    name            = COALESCE(@name, agents.name),
    status          = COALESCE(@status, agents.status),
    cwd             = COALESCE(@cwd, agents.cwd),
    model           = COALESCE(@model, agents.model),
    current_mission_id = COALESCE(@current_mission_id, agents.current_mission_id),
    last_seen_at    = COALESCE(@last_seen_at, agents.last_seen_at)
`);

export function upsertAgent(agent: Agent): Agent {
  stmtUpsertAgent.run(agent);
  return agent;
}

const stmtGetAgents = db.prepare("SELECT * FROM agents ORDER BY last_seen_at DESC");

export function getAgents(): readonly Agent[] {
  return stmtGetAgents.all() as Agent[];
}

const stmtGetAgent = db.prepare("SELECT * FROM agents WHERE id = ?");

export function getAgent(id: string): Agent | undefined {
  return (stmtGetAgent.get(id) as Agent) ?? undefined;
}

const stmtUpdateAgent = db.prepare(`
  UPDATE agents
  SET session_id      = COALESCE(@session_id, session_id),
      agent_id        = COALESCE(@agent_id, agent_id),
      name            = COALESCE(@name, name),
      status          = COALESCE(@status, status),
      cwd             = COALESCE(@cwd, cwd),
      model           = COALESCE(@model, model),
      current_mission_id = COALESCE(@current_mission_id, current_mission_id),
      last_seen_at    = COALESCE(@last_seen_at, last_seen_at)
  WHERE id = @id
`);

export function updateAgent(
  id: string,
  fields: Partial<Omit<Agent, "id" | "first_seen_at">>,
): Agent | undefined {
  stmtUpdateAgent.run({
    id,
    session_id: null,
    agent_id: null,
    name: null,
    status: null,
    cwd: null,
    model: null,
    current_mission_id: null,
    last_seen_at: null,
    ...fields,
  });
  return getAgent(id);
}

// -- Missions ---------------------------------------------------------------

const stmtCreateMission = db.prepare(`
  INSERT INTO missions (id, title, description, status, priority, assigned_agent_id, depends_on, created_at, started_at, completed_at, result)
  VALUES (@id, @title, @description, @status, @priority, @assigned_agent_id, @depends_on, @created_at, @started_at, @completed_at, @result)
`);

export function createMission(mission: Mission): Mission {
  stmtCreateMission.run(mission);
  return mission;
}

const stmtGetMissions = db.prepare(
  "SELECT * FROM missions ORDER BY priority DESC, created_at ASC",
);

export function getMissions(): readonly Mission[] {
  return stmtGetMissions.all() as Mission[];
}

const stmtGetMission = db.prepare("SELECT * FROM missions WHERE id = ?");

export function getMission(id: string): Mission | undefined {
  return (stmtGetMission.get(id) as Mission) ?? undefined;
}

const stmtUpdateMission = db.prepare(`
  UPDATE missions
  SET title           = COALESCE(@title, title),
      description     = COALESCE(@description, description),
      status          = COALESCE(@status, status),
      priority        = COALESCE(@priority, priority),
      assigned_agent_id = COALESCE(@assigned_agent_id, assigned_agent_id),
      depends_on      = COALESCE(@depends_on, depends_on),
      started_at      = COALESCE(@started_at, started_at),
      completed_at    = COALESCE(@completed_at, completed_at),
      result          = COALESCE(@result, result)
  WHERE id = @id
`);

export function updateMission(
  id: string,
  fields: Partial<Omit<Mission, "id" | "created_at">>,
): Mission | undefined {
  stmtUpdateMission.run({
    id,
    title: null,
    description: null,
    status: null,
    priority: null,
    assigned_agent_id: null,
    depends_on: null,
    started_at: null,
    completed_at: null,
    result: null,
    ...fields,
  });
  return getMission(id);
}

const stmtDeleteMission = db.prepare("DELETE FROM missions WHERE id = ?");

export function deleteMission(id: string): boolean {
  const info = stmtDeleteMission.run(id);
  return info.changes > 0;
}

// -- Instructions -----------------------------------------------------------

const stmtCreateInstruction = db.prepare(`
  INSERT INTO instructions (target_agent_id, message, status, created_at, delivered_at)
  VALUES (@target_agent_id, @message, @status, @created_at, @delivered_at)
`);

export function createInstruction(
  instruction: Omit<Instruction, "id">,
): Instruction {
  const info = stmtCreateInstruction.run(instruction);
  return { ...instruction, id: Number(info.lastInsertRowid) };
}

const stmtGetPendingInstructions = db.prepare(`
  SELECT * FROM instructions
  WHERE target_agent_id = ? AND status = 'pending'
  ORDER BY created_at ASC
`);

export function getPendingInstructions(
  targetAgentId: string,
): readonly Instruction[] {
  return stmtGetPendingInstructions.all(targetAgentId) as Instruction[];
}

const stmtMarkDelivered = db.prepare(`
  UPDATE instructions SET status = 'delivered', delivered_at = ? WHERE id = ?
`);

const stmtGetInstruction = db.prepare("SELECT * FROM instructions WHERE id = ?");

export function markInstructionDelivered(id: number): Instruction | undefined {
  const now = new Date().toISOString();
  stmtMarkDelivered.run(now, id);
  return (stmtGetInstruction.get(id) as Instruction) ?? undefined;
}

// -- Dashboard stats --------------------------------------------------------

export function getDashboardStats(): DashboardStats {
  const agentCounts = db
    .prepare(
      `SELECT
        COUNT(*)                                                   AS total,
        SUM(CASE WHEN status = 'active'       THEN 1 ELSE 0 END)  AS active,
        SUM(CASE WHEN status = 'idle'         THEN 1 ELSE 0 END)  AS idle,
        SUM(CASE WHEN status = 'disconnected' THEN 1 ELSE 0 END)  AS disconnected
      FROM agents`,
    )
    .get() as { total: number; active: number; idle: number; disconnected: number };

  const missionCounts = db
    .prepare(
      `SELECT
        COUNT(*)                                                    AS total,
        SUM(CASE WHEN status = 'queued'    THEN 1 ELSE 0 END)      AS queued,
        SUM(CASE WHEN status = 'active'    THEN 1 ELSE 0 END)      AS active,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)      AS completed,
        SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END)      AS failed,
        SUM(CASE WHEN status = 'blocked'   THEN 1 ELSE 0 END)      AS blocked
      FROM missions`,
    )
    .get() as {
    total: number;
    queued: number;
    active: number;
    completed: number;
    failed: number;
    blocked: number;
  };

  const eventCount = db
    .prepare("SELECT COUNT(*) AS total FROM events")
    .get() as { total: number };

  const pendingCount = db
    .prepare("SELECT COUNT(*) AS total FROM instructions WHERE status = 'pending'")
    .get() as { total: number };

  return {
    totalAgents: agentCounts.total,
    activeAgents: agentCounts.active,
    idleAgents: agentCounts.idle,
    disconnectedAgents: agentCounts.disconnected,
    totalMissions: missionCounts.total,
    queuedMissions: missionCounts.queued,
    activeMissions: missionCounts.active,
    completedMissions: missionCounts.completed,
    failedMissions: missionCounts.failed,
    blockedMissions: missionCounts.blocked,
    totalEvents: eventCount.total,
    pendingInstructions: pendingCount.total,
  };
}

// db instance is module-private; consumers use named query functions above
