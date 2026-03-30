<div align="center">

# Claude Mission Control

**Multi-agent orchestration for Claude Code — dispatch parallel agents in isolated git worktrees.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11+-blue)](https://python.org)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple)](https://modelcontextprotocol.io)

Dispatch Claude Code agents to work on coding tasks in parallel. Each agent runs in an isolated git worktree, submits structured reports, and auto-chains to the next mission when dependencies are met.

Improved fork of [claude-devfleet](https://github.com/LEC-AI/claude-devfleet).

</div>

---

## Why Claude Mission Control?

Working on a large feature? Instead of one agent doing everything sequentially, split the work:

```
You: "Build a REST API with auth, CRUD endpoints, and tests"

Claude Mission Control:
  Agent 1 → auth module (worktree: devfleet/auth)
  Agent 2 → CRUD endpoints (worktree: devfleet/crud, depends on: Agent 1)
  Agent 3 → test suite (worktree: devfleet/tests, depends on: Agent 1 + 2)

All agents auto-merge on success. You get a structured report.
```

---

## Quick Start

### One-Command Start

```bash
git clone https://github.com/Cyvid7-Darus10/claude-mission-control.git
cd claude-mission-control
./start.sh
```

- **UI:** http://localhost:3100
- **API:** http://localhost:18801
- **API Docs:** http://localhost:18801/docs

### Connect to Claude Code

```bash
claude mcp add claude-mission-control --transport http http://localhost:18801/mcp
```

Then in Claude Code:

```
"Use claude-mission-control to plan a project: build a REST API with auth and tests"
```

---

## How It Works

```mermaid
sequenceDiagram
    participant U as You
    participant C as Claude Code
    participant F as Claude Mission Control
    participant A1 as Agent 1
    participant A2 as Agent 2

    U->>C: "Build a REST API with auth and tests"
    C->>F: plan_project(prompt)
    F-->>C: Project + mission DAG
    C->>U: Here's the plan. Approve?
    U->>C: Yes
    C->>F: dispatch_mission(M1: auth)
    F->>A1: Spawn in isolated worktree
    A1-->>F: Done → auto-merge
    F->>A2: Auto-dispatch M2 (depends_on M1 met)
    A2-->>F: Done → auto-merge
    C->>F: get_report(M2)
    F-->>C: files_changed, what_done, next_steps
    C-->>U: All done. Here's what was built.
```

---

## Architecture

```mermaid
graph TB
    subgraph Clients["MCP Clients"]
        CC["Claude Code"]
        CU["Cursor"]
        WS["Windsurf"]
    end

    subgraph Fleet["Claude Mission Control (port 18801)"]
        API["FastAPI + MCP Server"]
        DB["SQLite"]
        SDK["SDK Engine"]
        WATCH["Mission Watcher"]
        SCHED["Scheduler"]
    end

    subgraph Agents["Agent Pool (max 3)"]
        A1["Agent 1"] --> WT1["Git Worktree"]
        A2["Agent 2"] --> WT2["Git Worktree"]
        A3["Agent 3"] --> WT3["Git Worktree"]
    end

    CC -->|MCP| API
    CU -->|MCP| API
    WS -->|MCP| API
    API --> SDK
    API --> DB
    SDK --> A1 & A2 & A3
    WATCH -->|"auto-dispatch"| SDK
    SCHED -->|"cron"| WATCH
```

---

## Features

### Core

| Feature | Description |
|---------|-------------|
| **Mission Dispatch** | Create tasks, dispatch Claude agents autonomously |
| **Git Worktree Isolation** | Each agent gets its own branch, auto-merged on success |
| **Live Streaming** | Real-time terminal output via SSE |
| **Structured Reports** | Agents report: files changed, what's done, what's open, next steps |
| **AI Planner** | Describe what you want → Claude creates a project with chained missions |
| **Session Resume** | Resume failed sessions with full conversation context |

### Multi-Agent Orchestration

| Feature | Description |
|---------|-------------|
| **Dependency DAG** | Missions depend on other missions; auto-dispatch when deps are met |
| **Sub-Mission Delegation** | Agents create sub-missions via MCP, dispatched to other agents |
| **Parallel Auto-Loop** | Planner generates parallel tasks, dispatches multiple agents simultaneously |
| **Scheduled Agents** | Cron schedules for recurring tasks (nightly tests, daily reviews) |
| **Mission Events** | Full audit log: auto_dispatched, dependency_met, dispatch_failed |

### MCP Tools

Any MCP-compatible client can use these tools:

| Tool | Description |
|------|-------------|
| `plan_project` | Natural language → project with chained missions |
| `create_project` | Create a project manually |
| `create_mission` | Add a mission with dependencies and auto-dispatch |
| `dispatch_mission` | Send an agent to work on a mission |
| `get_mission_status` | Check progress (preferred over `wait_for_mission`) |
| `get_report` | Read structured report |
| `cancel_mission` | Cancel a running mission |
| `get_dashboard` | Overview: running agents, stats, recent activity |
| `list_projects` | Browse all projects |
| `list_missions` | List missions, filter by status |

### Agent Intelligence

Each dispatched agent automatically gets two MCP servers:

**Context Server** — what the agent needs to know:
- Mission requirements and acceptance criteria
- Project info and recent history
- Reports from previous sessions
- What other agents are working on

**Tools Server** — what the agent can do:
- Submit structured end-of-mission reports
- Create sub-missions for other agents
- Request code review (auto-dispatched after completion)
- Check sub-mission progress

---

## Setup

### Prerequisites

- Python 3.11+
- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed

### Option A: One-Command (Recommended)

```bash
git clone https://github.com/Cyvid7-Darus10/claude-mission-control.git
cd claude-mission-control
./start.sh
```

### Option B: Manual

```bash
git clone https://github.com/Cyvid7-Darus10/claude-mission-control.git
cd claude-mission-control

# Backend
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
cd backend && uvicorn app:app --host 0.0.0.0 --port 18801 --reload

# Frontend (separate terminal)
cd frontend && npm install && npm run dev
```

### Option C: Docker

```bash
docker compose up -d
# UI: http://localhost:3101
# API: http://localhost:18801
```

### Connect Your Editor

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add claude-mission-control --transport http http://localhost:18801/mcp
```

</details>

<details>
<summary><b>Cursor</b></summary>

Add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "claude-mission-control": {
      "type": "http",
      "url": "http://localhost:18801/mcp"
    }
  }
}
```

</details>

<details>
<summary><b>Windsurf / Cline</b></summary>

Add to your MCP settings:
```json
{
  "claude-mission-control": {
    "type": "http",
    "url": "http://localhost:18801/mcp"
  }
}
```

</details>

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVFLEET_DB` | `data/devfleet.db` | SQLite database path |
| `DEVFLEET_MAX_AGENTS` | `3` | Max concurrent agents |
| `DEVFLEET_ENGINE` | `sdk` | Dispatch engine (`sdk` or `cli`) |
| `DEVFLEET_WATCHER_INTERVAL` | `5` | Mission watcher poll interval (seconds) |
| `DEVFLEET_SCHEDULER_INTERVAL` | `60` | Scheduler check interval (seconds) |
| `DEVFLEET_PROJECTS_DIR` | `projects/` | Base directory for planner-created projects |

---

## Plugins

Extend Claude Mission Control with custom tools and hooks. Drop a Python file into `plugins/`:

```python
# plugins/slack_notify.py
def register(registry):
    @registry.hook("post_complete")
    async def notify_slack(mission, report):
        import httpx
        await httpx.AsyncClient().post(WEBHOOK, json={
            "text": f"Mission '{mission['title']}' done! Files: {report['files_changed']}"
        })
```

Hook events: `pre_dispatch`, `post_complete`, `post_fail`, `pre_plan`, `post_plan`

Plugin tools automatically appear as MCP tools.

---

## Port Map

| Service | Port |
|---------|------|
| Claude Mission Control UI (local) | 3100 |
| Claude Mission Control UI (Docker) | 3101 |
| Claude Mission Control API + MCP | 18801 |

---

## Credits

- **[claude-devfleet](https://github.com/LEC-AI/claude-devfleet)** by LEC-AI — Original multi-agent orchestration platform. The foundation.

## License

Apache 2.0 — See [LICENSE](LICENSE)

---

<div align="center">

Made by [Cyrus David Pastelero](https://github.com/Cyvid7-Darus10)

</div>
