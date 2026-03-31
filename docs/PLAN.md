# Claude Mission Control — Implementation Plan

> Real-time command center dashboard for Claude Code agents.
> Like SHIELD's command center — assign agents to missions, watch them work live, coordinate, and step in when needed.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Browser (Dashboard)                    │
│  WebSocket ←── Real-time events, agent status            │
│  HTTP      ──→ REST API for missions, agents, history    │
└─────────────┬──────────────────────────────┬────────────┘
              │                              │
┌─────────────▼──────────────────────────────▼────────────┐
│            Mission Control Server (Node.js)              │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐     │
│  │ HTTP API │  │WebSocket │  │ Embedded Dashboard │     │
│  └────┬─────┘  └────┬─────┘  └────────────────────┘     │
│       │              │                                    │
│  ┌────▼──────────────▼───────────────────────────────┐   │
│  │              Event Bus (in-memory)                 │   │
│  └────┬──────────────────────────────────────────────┘   │
│       │                                                   │
│  ┌────▼──────────────────────────────────────────────┐   │
│  │           SQLite (better-sqlite3)                  │   │
│  │  agents | missions | events | instructions         │   │
│  └───────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
              ▲
              │ HTTP POST (hook events)
              │
┌─────────────┴───────────────────────────────────────────┐
│          Claude Code Hook (runs in each session)         │
│  PreToolUse:  POST event + GET instructions → stderr     │
│  PostToolUse: POST event                                 │
│  Stop:        POST session-end event                     │
└──────────────────────────────────────────────────────────┘
```

## How Hooks Work

Claude Code hooks receive JSON on stdin:

```typescript
{
  tool_name: "Bash" | "Edit" | "Write" | "Read" | ...,
  tool_input: { command?, file_path?, content?, ... },
  tool_output?: { output? },      // PostToolUse only
  session_id: string,
  agent_id: string,               // "main" or subagent ID
}
```

Environment variables available: `CLAUDE_SESSION_ID`, `CLAUDE_HOOK_EVENT_NAME`, `CLAUDE_MODEL`.

**Instruction injection:** PreToolUse hook GETs pending instructions from the server and writes them to stderr. Claude Code shows stderr as warnings to the agent.

## Data Model

```sql
-- Auto-registered when first event arrives
CREATE TABLE agents (
  id TEXT PRIMARY KEY,                    -- session_id:agent_id
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'main',
  name TEXT,                              -- user-assigned friendly name
  status TEXT DEFAULT 'active',           -- active, idle, disconnected
  cwd TEXT,
  model TEXT,
  current_mission_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- User-created tasks
CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'queued',           -- queued, active, completed, failed, blocked
  priority INTEGER DEFAULT 0,
  assigned_agent_id TEXT,
  depends_on TEXT,                        -- JSON array of mission IDs
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  result TEXT                             -- JSON: outcome summary
);

-- Every hook event
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,               -- pre_tool_use, post_tool_use, stop
  tool_name TEXT,
  tool_input TEXT,                        -- JSON
  tool_output TEXT,                       -- JSON
  mission_id TEXT,
  timestamp TEXT NOT NULL
);

-- Queued messages for agents
CREATE TABLE instructions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_agent_id TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'pending',          -- pending, delivered, expired
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
```

## File Structure

```
claude-mission-control/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
├── NOTICE
├── docs/
│   ├── PLAN.md                     # This file
│   └── RESEARCH.md                 # Competitive research
├── src/
│   ├── index.ts                    # CLI entry point
│   ├── server.ts                   # HTTP + WebSocket server
│   ├── db.ts                       # SQLite schema + queries
│   ├── api/
│   │   ├── events.ts               # POST /api/events (hook endpoint)
│   │   ├── agents.ts               # GET/PATCH /api/agents
│   │   ├── missions.ts             # CRUD /api/missions
│   │   └── instructions.ts         # GET/POST /api/instructions
│   ├── services/
│   │   ├── agent-tracker.ts        # Agent lifecycle (active/idle/disconnected)
│   │   ├── mission-engine.ts       # Mission state machine + dependency DAG
│   │   └── event-bus.ts            # In-memory pub/sub for WebSocket
│   ├── dashboard/
│   │   ├── index.html              # Main HTML shell
│   │   ├── styles.css              # Dark theme styles
│   │   └── app.js                  # Dashboard logic + WebSocket client
│   └── hook/
│       └── mission-control-hook.js # Claude Code hook script
├── scripts/
│   └── install-hooks.ts            # Auto-install hooks into settings.json
└── test/
    ├── db.test.ts
    ├── api/
    │   ├── events.test.ts
    │   ├── missions.test.ts
    │   └── instructions.test.ts
    ├── services/
    │   ├── agent-tracker.test.ts
    │   └── mission-engine.test.ts
    └── hook/
        └── mission-control-hook.test.ts
```

## Implementation Phases

### Phase 1: Foundation — Server, Database, Event Ingestion

| Step | File | What |
|------|------|------|
| 1 | `package.json`, `tsconfig.json` | npm package with `bin: claude-mission-control`, deps: `better-sqlite3`, `ws` |
| 2 | `src/db.ts` | SQLite init at `~/.claude-mission-control/data.db`, all CRUD helpers |
| 3 | `src/services/event-bus.ts` | Typed EventEmitter: `agent:update`, `event:new`, `mission:update` |
| 4 | `src/server.ts`, `src/index.ts` | HTTP server (no Express), WebSocket on same port, serves dashboard |

### Phase 2: Agent Tracking + Hook Script

| Step | File | What |
|------|------|------|
| 5 | `src/services/agent-tracker.ts` | Auto-register agents from events, status transitions (active→idle→disconnected) |
| 6 | `src/api/events.ts` | `POST /api/events` receives hook data, upserts agent, stores event, broadcasts |
| 7 | `src/hook/mission-control-hook.js` | Plain JS hook: POST event, GET instructions → stderr. Never crashes, 2s timeout |

### Phase 3: Mission Board + Dependency DAG

| Step | File | What |
|------|------|------|
| 8 | `src/services/mission-engine.ts` | State machine (queued→active→completed/failed), dependency resolution, cycle detection |
| 9 | `src/api/missions.ts` | CRUD + assign agent + complete/fail + list blocked/ready |
| 10 | `src/api/instructions.ts` | POST to queue message, GET to deliver (atomic read+mark) |

### Phase 4: Dashboard UI

| Step | File | What |
|------|------|------|
| 11 | `src/dashboard/*` | Dark mode embedded UI with: |
| | | — **Kanban mission board** (Queued → Active → Done → Failed columns) |
| | | — **Agent panel** with status badges (green/yellow/gray) |
| | | — **Color-coded activity timeline** (each agent = different color lane) |
| | | — **Agent decision graph** (toggle: node visualization of tool calls) |
| | | — **Instruction panel** (send messages to agents) |
| | | — **Stuck agent alerts** (no progress > 2 min) |
| | | — **Per-mission cost tracking** with model breakdown |
| | | — **Dependency arrows** between mission cards |
| | | — **Anti-pattern detection** (correction spirals, repeated prompts) |

### Phase 5: Hook Installation + CLI

| Step | File | What |
|------|------|------|
| 12 | `scripts/install-hooks.ts` | Read/modify `~/.claude/settings.json`, backup before write |
| 13 | `src/index.ts` (enhance) | Subcommands: `start` (default), `install`, `uninstall`, `status`. Flags: `--port`, `--open` |

### Phase 6: Agents API + Refinements

| Step | File | What |
|------|------|------|
| 14 | `src/api/agents.ts` | GET/PATCH agents, rename, event history per agent |
| 15 | `src/services/agent-tracker.ts` (enhance) | 10s interval timer for idle/disconnect detection, auto-fail orphaned missions |

### Phase 7: Tests

| Step | File | What |
|------|------|------|
| 16 | `test/db.test.ts` | CRUD ops, migration idempotency |
| 17 | `test/api/*.test.ts` | API endpoint tests with valid/invalid payloads |
| 18 | `test/services/*.test.ts` | Agent status transitions, mission state machine, cycle detection |
| 19 | `test/hook/*.test.ts` | Hook with mock server, server-down resilience, stdin passthrough |

## Dashboard UI Design

```
┌──────────────────────────────────────────────────────────────────┐
│  MISSION CONTROL                    3 agents ● 5 missions  12:34│
├──────────┬───────────────────────────────────────────────────────┤
│          │  QUEUED        ACTIVE         DONE         FAILED     │
│ AGENTS   │ ┌──────┐     ┌──────┐      ┌──────┐     ┌──────┐    │
│          │ │Auth  │────→│API   │      │Setup │     │      │    │
│ ● Alpha  │ │module│     │routes│      │done  │     │      │    │
│   auth.ts│ └──────┘     └──┬───┘      └──────┘     └──────┘    │
│          │ ┌──────┐        │                                     │
│ ● Bravo  │ │Tests │←───────┘                                     │
│   npm tst│ │suite │                                              │
│          │ └──────┘                                              │
│ ○ Charlie│                                                       │
│   idle   │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
│          │  TIMELINE                                             │
│          │  12:34:02 ● Alpha  Edit src/auth.ts                   │
│ ──────── │  12:34:01 ● Bravo  Bash npm test                     │
│ + Send   │  12:33:58 ● Alpha  Read package.json                 │
│ Message  │  12:33:55 ● Alpha  Bash git status                   │
│          │  12:33:50 ○ Charlie Read src/routes.ts                │
└──────────┴───────────────────────────────────────────────────────┘
```

## Inspiration Sources

| Feature | Inspired By | Stars |
|---------|------------|-------|
| Kanban mission board | MeisnerDan/mission-control | 317 |
| Color-coded timeline | disler/observability | 1,300 |
| Agent decision graph | agent-flow | 524 |
| Anti-pattern detection | agenttop | 42 |
| Stuck agent alerts | agenttop | 42 |
| Cost forensics | sniffly | 1,191 |
| Confidence scoring | builderz-labs/mission-control | 3,600 |
| Hook-based architecture | disler/observability | 1,300 |

## Tech Stack

| Component | Choice | Why |
|-----------|--------|-----|
| Runtime | Node.js + TypeScript | Single language, npm publishable |
| HTTP | Node.js `http` module | Zero deps, simple routing |
| WebSocket | `ws` | Battle-tested, lightweight |
| Database | `better-sqlite3` | Synchronous, embedded, no server |
| Dashboard | Vanilla HTML/CSS/JS | No build step, embedded in package |
| Testing | `vitest` | Fast, TypeScript-native |
| Package | npm with `bin` field | `npx claude-mission-control` |

## npm Package

```json
{
  "name": "claude-mission-control",
  "version": "1.0.0",
  "bin": { "claude-mission-control": "./dist/index.js" },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "ws": "^8.0.0"
  }
}
```

## Hook Configuration

Installed into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/mission-control-hook.js\"",
        "async": true,
        "timeout": 5
      }],
      "description": "Mission Control: report activity + receive instructions"
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/mission-control-hook.js\"",
        "async": true,
        "timeout": 5
      }],
      "description": "Mission Control: report tool results"
    }],
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/mission-control-hook.js\"",
        "async": true,
        "timeout": 5
      }],
      "description": "Mission Control: report session end"
    }]
  }
}
```

## Success Criteria

- [ ] `npx claude-mission-control` starts server on port 4280
- [ ] `claude-mission-control install` adds hooks to settings.json
- [ ] Agent appears on dashboard within 1 second of first tool call
- [ ] Every tool call shows in activity timeline in real-time
- [ ] Kanban board with drag-drop mission management
- [ ] Dependency arrows between mission cards
- [ ] Send instruction from dashboard → agent receives it via stderr
- [ ] Agents show correct status: active (green), idle (yellow), disconnected (gray)
- [ ] Stuck agent alert after 2 min of no activity
- [ ] Data persists across server restarts
- [ ] WebSocket auto-reconnects after server restart
- [ ] Hook never crashes or blocks Claude Code
- [ ] 80%+ test coverage
