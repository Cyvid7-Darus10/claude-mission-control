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
│  PreToolUse:      POST event + GET instructions → stderr │
│  PostToolUse:     POST event                             │
│  SubagentStart:   POST subagent spawn event              │
│  SubagentStop:    POST subagent end event                │
│  Stop:            POST session-end event                 │
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
  event_type TEXT NOT NULL,               -- pre_tool_use, post_tool_use, subagent_start, subagent_stop, stop
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
| 5 | `src/services/agent-tracker.ts` | Auto-register agents from events, status transitions (active→idle→disconnected). Deterministic color assignment per agent: `(hash << 5) + hash + charCode` mod 10-color palette — same agent always gets the same color across refreshes |
| 6 | `src/api/events.ts` | `POST /api/events` receives hook data, upserts agent, stores event, broadcasts. Accepts 5 event types: `pre_tool_use`, `post_tool_use`, `subagent_start`, `subagent_stop`, `stop` |
| 7 | `src/hook/mission-control-hook.js` | Plain JS hook: POST event, GET instructions → stderr. Never crashes, 2s timeout. Registered for 5 hook types: `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop` |

### Phase 3: Mission Board + Dependency DAG

| Step | File | What |
|------|------|------|
| 8 | `src/services/mission-engine.ts` | State machine (queued→active→completed/failed), dependency resolution, cycle detection |
| 9 | `src/api/missions.ts` | CRUD + assign agent + complete/fail + list blocked/ready |
| 10 | `src/api/instructions.ts` | POST to queue message, GET to deliver (atomic read+mark) |

### Phase 4: Dashboard UI — Terminal-Style Web Interface

**Design philosophy:** Palantir Gotham meets SHIELD command center. Data-dense, grid-based, feels like intelligence software. Speed and smoothness are the top priority. No flashy UI frameworks — raw performance.

**Design references:**
- **Palantir Gotham/Foundry** — dark grid layout, data density, blue/cyan accent on dark gray, thin borders, information hierarchy through brightness not size
- **Bloomberg Terminal** — maximum data per pixel, keyboard-first, no wasted space
- **SHIELD Helicarrier** — status panels, agent tracking, mission coordination

**Visual style:**
- Monospace font (`JetBrains Mono` / `Fira Code` / `monospace`)
- Background: `#0d1117` (Palantir dark), panels: `#161b22`, borders: `#30363d`
- Primary text: `#e6edf3`, secondary: `#8b949e`, accent: `#58a6ff` (blue), success: `#3fb950` (green), warning: `#d29922` (amber), danger: `#f85149` (red)
- Thin 1px borders between panels — no rounded corners, no shadows
- Data density: multiple columns, compact rows, no padding waste
- Status indicators: `●` online (green), `○` idle (amber), `✕` failed (red), `◌` offline (gray)
- Subtle glow on active/focused elements (`box-shadow: 0 0 4px rgba(88,166,255,0.3)`)
- Header bar with system stats: agent count, mission count, events/sec, uptime
- No animations > 100ms, no loading spinners — instant state transitions

**Layout:**
```
┌─ MISSION CONTROL ──────────────────────────── 3 agents ● 5 missions ─┐
├──────────────┬───────────────────────────────────────────────────────-─┤
│ > AGENTS     │ > MISSIONS                                             │
│              │                                                        │
│ ● alpha      │ [QUEUED]  Auth middleware         priority: HIGH        │
│   editing    │ [ACTIVE]  API routes        ← alpha  02:34 elapsed     │
│   auth.ts    │ [ACTIVE]  Unit tests        ← bravo  01:12 elapsed     │
│              │ [DONE]    Project setup      completed 5m ago           │
│ ● bravo      │ [BLOCKED] E2E tests         waiting on: API routes     │
│   running    │                                                        │
│   npm test   │─────────────────────────────────────────────────────────│
│              │ > TIMELINE                                              │
│ ○ charlie    │                                                        │
│   idle 45s   │ 12:34:02 alpha  EDIT  src/middleware/auth.ts            │
│              │ 12:34:01 bravo  BASH  npm test --coverage               │
│──────────────│ 12:33:58 alpha  READ  package.json                     │
│ > SEND MSG   │ 12:33:55 alpha  BASH  git status                       │
│ to: alpha    │ 12:33:50 charlie READ src/routes/payments.ts           │
│ > _          │ 12:33:48 alpha  WRITE src/types/auth.d.ts              │
└──────────────┴────────────────────────────────────────────────────────┘
```

**Key interactions:**
- Arrow keys / vim keys to navigate between panels
- `Tab` to switch focus between Agents / Missions / Timeline
- `Enter` on agent to filter timeline to that agent
- `n` to create new mission (inline form, no modal)
- `i` to send instruction (type in bottom panel)
- `q` to quit (with confirmation)
- All keyboard-driven, mouse optional

| Step | File | What |
|------|------|------|
| 11 | `src/dashboard/*` | Terminal-style embedded web UI with: |
| | | — **Agent panel** with `●○✕◌` status indicators |
| | | — **Mission list** with status tags `[QUEUED] [ACTIVE] [DONE] [FAILED] [BLOCKED]` |
| | | — **Color-coded timeline** (each agent = different color) |
| | | — **Instruction input** (bottom panel, type and send) |
| | | — **Stuck agent alerts** (blinking `! STUCK` after 2 min of no events) |
| | | — **Tool-call loop detection** (same tool+input 3+ times in a row → `! LOOP` indicator) |
| | | — **Dependency indicators** (`waiting on: ...` shown inline) |
| | | — **Keyboard navigation** (arrow keys, tab, vim keys) |
| | | — **Sub-100ms render** — no React, no virtual DOM, direct DOM manipulation |

### Phase 5: Hook Installation + CLI

| Step | File | What |
|------|------|------|
| 12 | `scripts/install-hooks.ts` | Read/modify `~/.claude/settings.json`, backup before write |
| 13 | `src/index.ts` (enhance) | Subcommands: `start` (default), `install`, `uninstall`, `status`. Flags: `--port`, `--open` |

### Phase 6: Agents API + Refinements

| Step | File | What |
|------|------|------|
| 14 | `src/api/agents.ts` | GET/PATCH agents, rename, event history per agent |
| 15 | `src/services/agent-tracker.ts` (enhance) | 10s interval timer for idle/disconnect detection, auto-fail orphaned missions. Event buffer: max 500 events in dashboard (drop oldest 10 on overflow), configurable DB retention (default 7 days, `DELETE FROM events WHERE timestamp < ?` on startup) |

### Phase 7: Tests

| Step | File | What |
|------|------|------|
| 16 | `test/db.test.ts` | CRUD ops, migration idempotency |
| 17 | `test/api/*.test.ts` | API endpoint tests with valid/invalid payloads |
| 18 | `test/services/*.test.ts` | Agent status transitions, mission state machine, cycle detection |
| 19 | `test/hook/*.test.ts` | Hook with mock server, server-down resilience, stdin passthrough |

## Dashboard UI Design

**Style:** Terminal-aesthetic web UI. Monospace only, black background, green/amber/cyan text, box-drawing borders. No rounded corners, no shadows, no gradients. Speed is everything — sub-100ms renders, direct DOM manipulation, no framework.

```
┌─ MISSION CONTROL ──────────────────────────── 3 agents ● 5 missions ─┐
├──────────────┬───────────────────────────────────────────────────────-─┤
│ > AGENTS     │ > MISSIONS                                             │
│              │                                                        │
│ ● alpha      │ [QUEUED]  Auth middleware         priority: HIGH        │
│   editing    │ [ACTIVE]  API routes        ← alpha  02:34 elapsed     │
│   auth.ts    │ [ACTIVE]  Unit tests        ← bravo  01:12 elapsed     │
│              │ [DONE]    Project setup      completed 5m ago           │
│ ● bravo      │ [BLOCKED] E2E tests         waiting on: API routes     │
│   running    │                                                        │
│   npm test   │────────────────────────────────────────────────────────│
│              │ > TIMELINE                                              │
│ ○ charlie    │                                                        │
│   idle 45s   │ 12:34:02 alpha  EDIT  src/middleware/auth.ts            │
│              │ 12:34:01 bravo  BASH  npm test --coverage               │
│──────────────│ 12:33:58 alpha  READ  package.json                     │
│ > SEND MSG   │ 12:33:55 alpha  BASH  git status                       │
│ to: alpha    │ 12:33:50 charlie READ src/routes/payments.ts           │
│ > _          │ 12:33:48 alpha  WRITE src/types/auth.d.ts              │
└──────────────┴────────────────────────────────────────────────────────┘
```

**Color system (Palantir-inspired):**
```
Background:     #0d1117     (deep dark)
Panel bg:       #161b22     (slightly lighter)
Panel border:   #30363d     (thin gray lines)
Primary text:   #e6edf3     (bright white)
Secondary text: #8b949e     (muted gray)
Accent/focus:   #58a6ff     (Palantir blue)
Success:        #3fb950     (green)
Warning:        #d29922     (amber)
Danger:         #f85149     (red)
Glow:           rgba(88,166,255,0.3)  (focus ring)
```

**Typography:**
- Font: `JetBrains Mono` / `Fira Code` / `monospace`
- Header labels: 11px uppercase, letter-spacing 1px, secondary color
- Data values: 13px, primary color
- Timestamps: 11px, secondary color

**Keyboard navigation:**
- `Tab` — cycle focus: Agents → Missions → Timeline → Command
- `↑↓` / `jk` — navigate within focused panel
- `Enter` — select agent (filters timeline), expand mission details
- `n` — new mission (inline form, no modal)
- `i` — focus command input
- `/` — search/filter events
- `q` — quit (with confirmation)
- Mouse clicks work too but keyboard is primary

**Palantir-style details:**
- Panel headers are uppercase 11px with subtle bottom border
- Active panel has blue left border accent (2px)
- Focused rows have subtle blue background (`#161b22` → `#1c2333`)
- Data tables use alternating row opacity for readability
- Status dots pulse gently for active agents (CSS animation)
- Header bar shows live stats: `3 AGENTS  ●  5 MISSIONS  ●  142 EVENTS  ●  UPTIME 02:34:12`

## Inspiration Sources

| Feature | Inspired By | Stars | How We Use It |
|---------|------------|-------|---------------|
| Mission list with states | MeisnerDan/mission-control | 317 | Queued/Active/Done/Failed/Blocked status tags with dependency tracking |
| Color-coded timeline | disler/observability | 1,300 | Deterministic color hash per agent — same agent always same color |
| 5-event hook architecture | disler/observability | 1,300 | PreToolUse, PostToolUse, SubagentStart, SubagentStop, Stop |
| Subagent lifecycle tracking | disler/observability | 1,300 | SubagentStart/Stop hooks give visibility into spawned subagents |
| Tool-call loop detection | agenttop + builderz-labs | 42 / 3,600 | Same tool+input 3+ times in a row → `! LOOP` alert |
| Stuck agent alerts | agenttop | 42 | No events for 2+ min → blinking `! STUCK` indicator |
| Event buffer management | disler/observability | 1,300 | Max 500 in dashboard (drop oldest 10), 7-day DB retention |
| Instruction injection | Original (our design) | — | PreToolUse hook GETs instructions, writes to stderr |

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
    "SubagentStart": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/mission-control-hook.js\"",
        "async": true,
        "timeout": 5
      }],
      "description": "Mission Control: report subagent spawn"
    }],
    "SubagentStop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node \"/path/to/mission-control-hook.js\"",
        "async": true,
        "timeout": 5
      }],
      "description": "Mission Control: report subagent end"
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
- [ ] Tool-call loop detection: `! LOOP` when same tool+input 3+ times in a row
- [ ] Subagents appear on dashboard when spawned (via SubagentStart hook)
- [ ] Each agent gets a consistent color across page refreshes (deterministic hash)
- [ ] Event buffer capped at 500 in dashboard, 7-day DB retention
- [ ] Data persists across server restarts
- [ ] WebSocket auto-reconnects after server restart
- [ ] Hook never crashes or blocks Claude Code
- [ ] 80%+ test coverage
