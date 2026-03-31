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
  readonly subtasks: string | null; // JSON: [{id, title, done}]
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

const DATA_DIR = process.env.MC_DATA_DIR || join(homedir(), ".claude-mission-control");
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

    -- subtasks: JSON array of {id, title, done} for progress tracking
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

  // Migration: add subtasks column to missions (JSON array of {id, title, done})
  try {
    db.exec(`ALTER TABLE missions ADD COLUMN subtasks TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Usage summary table — persists aggregated daily stats even after raw events are purged
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      date            TEXT PRIMARY KEY,
      tool_calls      INTEGER DEFAULT 0,
      total_events    INTEGER DEFAULT 0,
      sessions        INTEGER DEFAULT 0,
      unique_tools    INTEGER DEFAULT 0,
      unique_agents   INTEGER DEFAULT 0,
      estimated_cost  REAL DEFAULT 0
    );
  `);

  // Event retention: purge raw events older than configured days.
  // Before purging, roll up old events into usage_daily so historical cost data persists.
  const RETENTION_DAYS = parseInt(process.env.MC_EVENT_RETENTION_DAYS || '90', 10);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Roll up events that will be purged into usage_daily
  const costPerCall = parseFloat(process.env.MC_COST_PER_TOOL_CALL || '0.003');
  db.prepare(`
    INSERT INTO usage_daily (date, tool_calls, total_events, sessions, unique_tools, unique_agents, estimated_cost)
    SELECT
      strftime('%Y-%m-%d', timestamp) AS date,
      SUM(CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN 1 ELSE 0 END),
      COUNT(*),
      COUNT(DISTINCT session_id),
      COUNT(DISTINCT CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN tool_name END),
      COUNT(DISTINCT agent_id),
      SUM(CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN 1 ELSE 0 END) * @cost
    FROM events
    WHERE timestamp < @cutoff
    GROUP BY date
    ON CONFLICT(date) DO UPDATE SET
      tool_calls     = MAX(usage_daily.tool_calls, excluded.tool_calls),
      total_events   = MAX(usage_daily.total_events, excluded.total_events),
      sessions       = MAX(usage_daily.sessions, excluded.sessions),
      unique_tools   = MAX(usage_daily.unique_tools, excluded.unique_tools),
      unique_agents  = MAX(usage_daily.unique_agents, excluded.unique_agents),
      estimated_cost = MAX(usage_daily.estimated_cost, excluded.estimated_cost)
  `).run({ cutoff, cost: costPerCall });

  const purged = db.prepare('DELETE FROM events WHERE timestamp < ?').run(cutoff);
  if (purged.changes > 0) {
    console.log(`  [db] Purged ${purged.changes} events older than ${RETENTION_DAYS} days (stats preserved in usage_daily)`);
  }

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
  // Return the actual DB row (reflects COALESCE results, not the input)
  return getAgent(agent.id) ?? agent;
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

export function deleteAgent(id: string): boolean {
  const result = db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteDisconnectedAgents(): number {
  const result = db.prepare("DELETE FROM agents WHERE status = 'disconnected'").run();
  return result.changes;
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

// -- Usage stats --------------------------------------------------------------

interface ToolUsageStat {
  readonly tool_name: string;
  readonly count: number;
}

interface AgentUsageStat {
  readonly agent_id: string;
  readonly count: number;
}

interface HourlyUsageStat {
  readonly hour: string;
  readonly count: number;
}

interface SessionCostStat {
  readonly session_id: string;
  readonly agent_count: number;
  readonly tool_calls: number;
  readonly first_event: string;
  readonly last_event: string;
  readonly duration_seconds: number;
  readonly estimated_cost: number;
}

interface DailyCostStat {
  readonly date: string;
  readonly tool_calls: number;
  readonly sessions: number;
  readonly estimated_cost: number;
}

interface UsageStats {
  readonly period: string;
  readonly hoursBack: number;
  readonly toolUsage: readonly ToolUsageStat[];
  readonly agentUsage: readonly AgentUsageStat[];
  readonly hourlyActivity: readonly HourlyUsageStat[];
  readonly sessionCosts: readonly SessionCostStat[];
  readonly dailyCosts: readonly DailyCostStat[];
  readonly totalEvents: number;
  readonly totalToolCalls: number;
  readonly totalSessions: number;
  readonly uniqueTools: number;
  readonly uniqueAgents: number;
  readonly totalEstimatedCost: number;
  readonly costPerToolCall: number;
}

// All queries accept a @since param so every stat is scoped to the same window.
// For "all time" we pass a very old date.

const stmtToolUsageFiltered = db.prepare(`
  SELECT tool_name, COUNT(*) AS count
  FROM events
  WHERE tool_name IS NOT NULL AND tool_name != '' AND timestamp >= @since
  GROUP BY tool_name
  ORDER BY count DESC
  LIMIT 20
`);

const stmtAgentUsageFiltered = db.prepare(`
  SELECT agent_id, COUNT(*) AS count
  FROM events
  WHERE agent_id IS NOT NULL AND timestamp >= @since
  GROUP BY agent_id
  ORDER BY count DESC
  LIMIT 20
`);

const stmtHourlyActivity = db.prepare(`
  SELECT strftime('%Y-%m-%dT%H:00:00', timestamp) AS hour, COUNT(*) AS count
  FROM events
  WHERE timestamp >= @since
  GROUP BY hour
  ORDER BY hour ASC
`);

const stmtTotalEventsFiltered = db.prepare(`
  SELECT COUNT(*) AS total FROM events WHERE timestamp >= @since
`);

const stmtTotalToolCallsFiltered = db.prepare(`
  SELECT COUNT(*) AS total FROM events
  WHERE tool_name IS NOT NULL AND tool_name != '' AND timestamp >= @since
`);

const stmtTotalSessionsFiltered = db.prepare(`
  SELECT COUNT(DISTINCT session_id) AS total FROM events
  WHERE session_id IS NOT NULL AND timestamp >= @since
`);

const stmtUniqueToolsFiltered = db.prepare(`
  SELECT COUNT(DISTINCT tool_name) AS total FROM events
  WHERE tool_name IS NOT NULL AND tool_name != '' AND timestamp >= @since
`);

const stmtUniqueAgentsFiltered = db.prepare(`
  SELECT COUNT(DISTINCT agent_id) AS total FROM events
  WHERE agent_id IS NOT NULL AND timestamp >= @since
`);

const stmtSessionCostsFiltered = db.prepare(`
  SELECT
    session_id,
    COUNT(DISTINCT agent_id) AS agent_count,
    SUM(CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN 1 ELSE 0 END) AS tool_calls,
    MIN(timestamp) AS first_event,
    MAX(timestamp) AS last_event
  FROM events
  WHERE session_id IS NOT NULL AND timestamp >= @since
  GROUP BY session_id
  ORDER BY MAX(timestamp) DESC
  LIMIT 20
`);

// Daily costs from live events (for days still in the events table)
const stmtDailyCostsFromEvents = db.prepare(`
  SELECT
    strftime('%Y-%m-%d', timestamp) AS date,
    SUM(CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN 1 ELSE 0 END) AS tool_calls,
    COUNT(*) AS total_events,
    COUNT(DISTINCT session_id) AS sessions
  FROM events
  WHERE timestamp >= @since
  GROUP BY date
  ORDER BY date ASC
`);

// Daily costs from persisted usage_daily (for historical data beyond retention)
const stmtDailyCostsFromSummary = db.prepare(`
  SELECT date, tool_calls, total_events, sessions, estimated_cost
  FROM usage_daily
  WHERE date >= @sinceDate
  ORDER BY date ASC
`);

// Totals from persisted usage_daily
const stmtSummaryTotals = db.prepare(`
  SELECT
    COALESCE(SUM(tool_calls), 0) AS tool_calls,
    COALESCE(SUM(total_events), 0) AS total_events,
    COALESCE(SUM(sessions), 0) AS sessions,
    COALESCE(SUM(estimated_cost), 0) AS estimated_cost
  FROM usage_daily
  WHERE date >= @sinceDate
`);

// Configurable cost per tool call (default: $0.003 — rough estimate for a typical
// Claude API round-trip with tool use, ~1K input + 500 output tokens at Sonnet rates)
const COST_PER_TOOL_CALL = parseFloat(process.env.MC_COST_PER_TOOL_CALL || '0.003');

const ALL_TIME_SINCE = '1970-01-01T00:00:00.000Z';
const ALL_TIME_DATE = '1970-01-01';

function periodLabel(hoursBack: number): string {
  if (hoursBack === 0) return 'all';
  if (hoursBack <= 24) return '24h';
  if (hoursBack <= 168) return '7d';
  if (hoursBack <= 720) return '30d';
  return hoursBack + 'h';
}

/**
 * Flush today's live events into usage_daily so the summary stays current.
 * Called periodically and before reads.
 */
function flushCurrentDayToSummary(): void {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO usage_daily (date, tool_calls, total_events, sessions, unique_tools, unique_agents, estimated_cost)
    SELECT
      @today,
      SUM(CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN 1 ELSE 0 END),
      COUNT(*),
      COUNT(DISTINCT session_id),
      COUNT(DISTINCT CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN tool_name END),
      COUNT(DISTINCT agent_id),
      SUM(CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN 1 ELSE 0 END) * @cost
    FROM events
    WHERE strftime('%Y-%m-%d', timestamp) = @today
    ON CONFLICT(date) DO UPDATE SET
      tool_calls     = excluded.tool_calls,
      total_events   = excluded.total_events,
      sessions       = excluded.sessions,
      unique_tools   = excluded.unique_tools,
      unique_agents  = excluded.unique_agents,
      estimated_cost = excluded.estimated_cost
  `).run({ today, cost: COST_PER_TOOL_CALL });
}

export function getUsageStats(hoursBack = 24): UsageStats {
  // Flush current day so usage_daily is up to date
  flushCurrentDayToSummary();

  const since = hoursBack === 0
    ? ALL_TIME_SINCE
    : new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  const sinceDate = hoursBack === 0
    ? ALL_TIME_DATE
    : since.slice(0, 10);

  // Live event queries (tool breakdown, agent breakdown, hourly, sessions)
  const toolUsage = stmtToolUsageFiltered.all({ since }) as ToolUsageStat[];
  const agentUsage = stmtAgentUsageFiltered.all({ since }) as AgentUsageStat[];
  const hourlyActivity = stmtHourlyActivity.all({ since }) as HourlyUsageStat[];

  const rawSessions = stmtSessionCostsFiltered.all({ since }) as Array<{
    session_id: string;
    agent_count: number;
    tool_calls: number;
    first_event: string;
    last_event: string;
  }>;

  const sessionCosts: SessionCostStat[] = rawSessions.map((s) => {
    const start = new Date(s.first_event).getTime();
    const end = new Date(s.last_event).getTime();
    const durationSeconds = Math.max(0, Math.round((end - start) / 1000));
    return {
      session_id: s.session_id,
      agent_count: s.agent_count,
      tool_calls: s.tool_calls,
      first_event: s.first_event,
      last_event: s.last_event,
      duration_seconds: durationSeconds,
      estimated_cost: parseFloat((s.tool_calls * COST_PER_TOOL_CALL).toFixed(4)),
    };
  });

  // Merge daily costs: live events + persisted summaries.
  // usage_daily has the authoritative totals (including today via flush).
  const rawSummaryDaily = stmtDailyCostsFromSummary.all({ sinceDate }) as Array<{
    date: string;
    tool_calls: number;
    total_events: number;
    sessions: number;
    estimated_cost: number;
  }>;

  // For days still in events table, compute from live data
  const rawLiveDaily = stmtDailyCostsFromEvents.all({ since }) as Array<{
    date: string;
    tool_calls: number;
    total_events: number;
    sessions: number;
  }>;

  // Merge: prefer live data for recent days (more accurate), summary for old days
  const liveDaySet = new Set(rawLiveDaily.map((d) => d.date));
  const mergedDailyMap = new Map<string, DailyCostStat>();

  // Add summary days first (old data beyond retention)
  for (const d of rawSummaryDaily) {
    if (!liveDaySet.has(d.date)) {
      mergedDailyMap.set(d.date, {
        date: d.date,
        tool_calls: d.tool_calls,
        sessions: d.sessions,
        estimated_cost: parseFloat(d.estimated_cost.toFixed(4)),
      });
    }
  }

  // Add/override with live event data
  for (const d of rawLiveDaily) {
    mergedDailyMap.set(d.date, {
      date: d.date,
      tool_calls: d.tool_calls,
      sessions: d.sessions,
      estimated_cost: parseFloat((d.tool_calls * COST_PER_TOOL_CALL).toFixed(4)),
    });
  }

  const dailyCosts = Array.from(mergedDailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Totals: sum from merged daily data (covers both live + historical)
  const summaryTotals = stmtSummaryTotals.get({ sinceDate }) as {
    tool_calls: number;
    total_events: number;
    sessions: number;
    estimated_cost: number;
  };

  // For live-data-only totals (tool/agent/session breakdown only covers retained events)
  const liveEvents = (stmtTotalEventsFiltered.get({ since }) as { total: number }).total;
  const liveToolCalls = (stmtTotalToolCallsFiltered.get({ since }) as { total: number }).total;

  // Use the larger of summary vs live (summary includes historical)
  const totalEvents = Math.max(summaryTotals.total_events, liveEvents);
  const totalToolCalls = Math.max(summaryTotals.tool_calls, liveToolCalls);
  const totalSessions = summaryTotals.sessions;
  const uniqueTools = (stmtUniqueToolsFiltered.get({ since }) as { total: number }).total;
  const uniqueAgents = (stmtUniqueAgentsFiltered.get({ since }) as { total: number }).total;

  const totalEstimatedCost = parseFloat((totalToolCalls * COST_PER_TOOL_CALL).toFixed(4));

  return {
    period: periodLabel(hoursBack),
    hoursBack,
    toolUsage,
    agentUsage,
    hourlyActivity,
    sessionCosts,
    dailyCosts,
    totalEvents,
    totalToolCalls,
    totalSessions,
    uniqueTools,
    uniqueAgents,
    totalEstimatedCost,
    costPerToolCall: COST_PER_TOOL_CALL,
  };
}

// -- Agent-scoped usage stats -------------------------------------------------

export function getAgentUsageStats(agentId: string, hoursBack = 24): UsageStats {
  const since = hoursBack === 0
    ? ALL_TIME_SINCE
    : new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  const toolUsage = db.prepare(`
    SELECT tool_name, COUNT(*) AS count
    FROM events
    WHERE tool_name IS NOT NULL AND tool_name != '' AND agent_id = @agentId AND timestamp >= @since
    GROUP BY tool_name ORDER BY count DESC LIMIT 20
  `).all({ agentId, since }) as ToolUsageStat[];

  const hourlyActivity = db.prepare(`
    SELECT strftime('%Y-%m-%dT%H:00:00', timestamp) AS hour, COUNT(*) AS count
    FROM events
    WHERE agent_id = @agentId AND timestamp >= @since
    GROUP BY hour ORDER BY hour ASC
  `).all({ agentId, since }) as HourlyUsageStat[];

  const totalEvents = (db.prepare(
    `SELECT COUNT(*) AS total FROM events WHERE agent_id = @agentId AND timestamp >= @since`
  ).get({ agentId, since }) as { total: number }).total;

  const totalToolCalls = (db.prepare(
    `SELECT COUNT(*) AS total FROM events WHERE tool_name IS NOT NULL AND tool_name != '' AND agent_id = @agentId AND timestamp >= @since`
  ).get({ agentId, since }) as { total: number }).total;

  const uniqueTools = (db.prepare(
    `SELECT COUNT(DISTINCT tool_name) AS total FROM events WHERE tool_name IS NOT NULL AND tool_name != '' AND agent_id = @agentId AND timestamp >= @since`
  ).get({ agentId, since }) as { total: number }).total;

  const totalEstimatedCost = parseFloat((totalToolCalls * COST_PER_TOOL_CALL).toFixed(4));

  return {
    period: periodLabel(hoursBack),
    hoursBack,
    toolUsage,
    agentUsage: [{ agent_id: agentId, count: totalEvents }],
    hourlyActivity,
    sessionCosts: [],
    dailyCosts: [],
    totalEvents,
    totalToolCalls,
    totalSessions: 1,
    uniqueTools,
    uniqueAgents: 1,
    totalEstimatedCost,
    costPerToolCall: COST_PER_TOOL_CALL,
  };
}

// db instance is module-private; consumers use named query functions above
