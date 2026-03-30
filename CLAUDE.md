# Claude Mission Control

Mission tracker, dependency scheduler, and dashboard for Claude Code agents.

Claude Code handles agent dispatch, worktree isolation, and execution natively.
Mission Control adds persistence across sessions: mission tracking, dependency DAGs,
cron scheduling, cost tracking, and a web dashboard.

## Architecture

```
backend/
  app.py              FastAPI server + REST API
  mcp_external.py     MCP server (Streamable HTTP + SSE)
  db.py               SQLite schema
  models.py           Pydantic models
  mission_watcher.py  Dependency watcher
  scheduler.py        Cron scheduler
  planner.py          AI project planner
  plugins.py          Hook-based plugin system

frontend/             React 19 + Vite dashboard
```

## MCP Tools

plan_project, create_project, create_mission, update_mission_status,
submit_report, get_mission_status, get_report, get_unblocked_missions,
get_dashboard, list_projects, list_missions, get_cost_summary
