"""
Mission Control MCP Server — Mission Tracker endpoint.

Exposes Mission Control as an MCP server so any MCP-compatible client
(Claude Code, Cursor, Windsurf, Cline, custom agents) can:
  - Plan projects from natural language
  - Create and manage projects and missions
  - Update mission status and submit reports
  - Query unblocked missions and cost summaries
  - Check mission status and read reports
  - List and browse projects/missions

Mount via SSE transport at /mcp on the FastAPI app.
"""

import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone

from mcp.server import Server
import mcp.types as types

import db

log = logging.getLogger("mission-control.mcp-external")

server = Server("mission-control")


# ── Helper: resolve projects dir ──

def _projects_base() -> str:
    base = os.environ.get("MISSION_CONTROL_PROJECTS_DIR")
    if not base:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        base = os.path.join(root, "projects")
    return base


def _slugify(text: str, max_len: int = 40) -> str:
    return re.sub(r'[^a-z0-9]+', '-', text.lower().strip())[:max_len].strip('-')


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Tool Definitions ──

TOOLS = [
    types.Tool(
        name="plan_project",
        description=(
            "Plan a project from a natural language description. "
            "AI breaks the prompt into a project with missions and dependencies. "
            "Returns project ID and mission list."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Natural language description of what to build",
                },
                "project_path": {
                    "type": "string",
                    "description": "Optional filesystem path for the project. Auto-generated if not provided.",
                },
            },
            "required": ["prompt"],
        },
    ),
    types.Tool(
        name="create_project",
        description="Create a new project manually.",
        inputSchema={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Project name"},
                "path": {"type": "string", "description": "Filesystem path for the project. Auto-generated if not provided."},
                "description": {"type": "string", "description": "Project description"},
            },
            "required": ["name"],
        },
    ),
    types.Tool(
        name="create_mission",
        description=(
            "Create a mission (task) in an existing project. "
            "Supports dependencies and priority."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "project_id": {"type": "string", "description": "ID of the project"},
                "title": {"type": "string", "description": "Mission title"},
                "prompt": {"type": "string", "description": "Detailed prompt / instructions"},
                "acceptance_criteria": {"type": "string", "description": "What counts as done"},
                "depends_on": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of mission IDs this depends on",
                },
                "priority": {"type": "integer", "description": "Priority (0=normal, 1=high, 2=critical)"},
                "model": {"type": "string", "description": "Model to use (default: claude-sonnet-4-20250514)"},
            },
            "required": ["project_id", "title", "prompt"],
        },
    ),
    types.Tool(
        name="update_mission_status",
        description=(
            "Update the status of a mission. Optionally create or update a session "
            "with cost and token data."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "mission_id": {"type": "string", "description": "Mission ID"},
                "status": {
                    "type": "string",
                    "description": "New status",
                    "enum": ["draft", "ready", "running", "completed", "failed"],
                },
                "session_id": {
                    "type": "string",
                    "description": "Session ID to create or update. Auto-generated if status is 'running' and not provided.",
                },
                "model": {"type": "string", "description": "Model used for the session"},
                "cost_usd": {"type": "number", "description": "Total cost in USD for the session"},
                "total_tokens": {"type": "integer", "description": "Total tokens used in the session"},
            },
            "required": ["mission_id", "status"],
        },
    ),
    types.Tool(
        name="submit_report",
        description=(
            "Submit a structured report for a mission. Creates a report record "
            "linked to the mission and its latest session."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "mission_id": {"type": "string", "description": "Mission ID"},
                "session_id": {
                    "type": "string",
                    "description": "Session ID. Uses the latest session if not provided.",
                },
                "files_changed": {"type": "string", "description": "Files changed (newline-separated or comma-separated)"},
                "what_done": {"type": "string", "description": "Summary of what was accomplished"},
                "what_open": {"type": "string", "description": "What remains open / incomplete"},
                "what_tested": {"type": "string", "description": "What was tested"},
                "what_untested": {"type": "string", "description": "What was not tested"},
                "next_steps": {"type": "string", "description": "Recommended next steps"},
                "errors_encountered": {"type": "string", "description": "Errors encountered during the mission"},
            },
            "required": ["mission_id", "what_done"],
        },
    ),
    types.Tool(
        name="get_mission_status",
        description=(
            "Get current status and details of a mission including its latest session and report."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "mission_id": {"type": "string", "description": "Mission ID"},
            },
            "required": ["mission_id"],
        },
    ),
    types.Tool(
        name="get_report",
        description=(
            "Get the structured report from a completed mission — "
            "what was done, tested, untested, files changed, errors, and next steps."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "mission_id": {"type": "string", "description": "Mission ID"},
            },
            "required": ["mission_id"],
        },
    ),
    types.Tool(
        name="get_unblocked_missions",
        description=(
            "Get missions whose dependencies are all satisfied (completed) but "
            "that have not yet started. Useful for finding the next work to pick up."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "project_id": {
                    "type": "string",
                    "description": "Optional project ID to scope the query. Returns across all projects if omitted.",
                },
            },
        },
    ),
    types.Tool(
        name="get_cost_summary",
        description=(
            "Get aggregated cost and token data across sessions, optionally scoped "
            "to a project or mission."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "project_id": {"type": "string", "description": "Optional project ID filter"},
                "mission_id": {"type": "string", "description": "Optional mission ID filter"},
            },
        },
    ),
    types.Tool(
        name="get_dashboard",
        description=(
            "Get a high-level dashboard: project count, mission stats by status, "
            "recent activity, and cost totals."
        ),
        inputSchema={
            "type": "object",
            "properties": {},
        },
    ),
    types.Tool(
        name="list_projects",
        description="List all projects.",
        inputSchema={
            "type": "object",
            "properties": {},
        },
    ),
    types.Tool(
        name="list_missions",
        description="List missions in a project, optionally filtered by status.",
        inputSchema={
            "type": "object",
            "properties": {
                "project_id": {"type": "string", "description": "Project ID"},
                "status": {
                    "type": "string",
                    "description": "Filter by status",
                    "enum": ["draft", "ready", "running", "completed", "failed"],
                },
            },
            "required": ["project_id"],
        },
    ),
]


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return TOOLS


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    try:
        result = await _handle_tool(name, arguments)
        return [types.TextContent(type="text", text=json.dumps(result, indent=2, default=str))]
    except Exception as e:
        log.exception(f"MCP tool {name} failed")
        return [types.TextContent(type="text", text=json.dumps({"error": str(e)}))]


async def _handle_tool(name: str, args: dict) -> dict:
    conn = await db.get_db()
    try:
        if name == "plan_project":
            return await _plan_project(args, conn)
        elif name == "create_project":
            return await _create_project(args, conn)
        elif name == "create_mission":
            return await _create_mission(args, conn)
        elif name == "update_mission_status":
            return await _update_mission_status(args, conn)
        elif name == "submit_report":
            return await _submit_report(args, conn)
        elif name == "get_mission_status":
            return await _get_mission_status(args, conn)
        elif name == "get_report":
            return await _get_report(args, conn)
        elif name == "get_unblocked_missions":
            return await _get_unblocked_missions(args, conn)
        elif name == "get_cost_summary":
            return await _get_cost_summary(args, conn)
        elif name == "get_dashboard":
            return await _get_dashboard(conn)
        elif name == "list_projects":
            return await _list_projects(conn)
        elif name == "list_missions":
            return await _list_missions(args, conn)
        else:
            return {"error": f"Unknown tool: {name}"}
    finally:
        await conn.close()


# ── Tool Implementations ──

async def _plan_project(args: dict, conn) -> dict:
    from planner import plan_project

    prompt = args["prompt"]
    project_path = args.get("project_path")
    if not project_path:
        slug = _slugify(prompt)
        project_path = os.path.join(_projects_base(), slug)

    result = await plan_project(prompt, project_path)
    return {
        "project_id": result["project"]["id"],
        "project_name": result["project"]["name"],
        "project_path": project_path,
        "missions": [
            {
                "id": m["id"],
                "number": m["mission_number"],
                "title": m["title"],
                "depends_on": m["depends_on"],
            }
            for m in result["missions"]
        ],
        "hint": "Use update_mission_status to mark missions as running/completed as you work through them.",
    }


async def _create_project(args: dict, conn) -> dict:
    pid = str(uuid.uuid4())
    name = args["name"]
    path = args.get("path") or os.path.join(_projects_base(), _slugify(name))
    description = args.get("description", "")

    os.makedirs(path, exist_ok=True)

    await conn.execute(
        "INSERT INTO projects (id, name, path, description) VALUES (?, ?, ?, ?)",
        (pid, name, path, description),
    )
    await conn.commit()

    return {"id": pid, "name": name, "path": path, "description": description}


async def _create_mission(args: dict, conn) -> dict:
    mid = str(uuid.uuid4())

    # Verify project exists
    row = await conn.execute("SELECT id FROM projects WHERE id = ?", (args["project_id"],))
    if not await row.fetchone():
        return {"error": f"Project {args['project_id']} not found"}

    # Get next mission number
    cur = await conn.execute(
        "SELECT COALESCE(MAX(mission_number), 0) + 1 FROM missions WHERE project_id = ?",
        (args["project_id"],),
    )
    next_num = (await cur.fetchone())[0]

    depends_on = json.dumps(args.get("depends_on", []))

    await conn.execute(
        """INSERT INTO missions
           (id, project_id, title, detailed_prompt, acceptance_criteria,
            depends_on, priority, model, mission_number, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')""",
        (
            mid,
            args["project_id"],
            args["title"],
            args["prompt"],
            args.get("acceptance_criteria", ""),
            depends_on,
            args.get("priority", 0),
            args.get("model", "claude-sonnet-4-20250514"),
            next_num,
        ),
    )
    await conn.commit()

    return {
        "id": mid,
        "mission_number": next_num,
        "title": args["title"],
        "project_id": args["project_id"],
        "depends_on": args.get("depends_on", []),
        "status": "draft",
    }


async def _update_mission_status(args: dict, conn) -> dict:
    mid = args["mission_id"]
    new_status = args["status"]

    # Verify mission exists
    cur = await conn.execute("SELECT * FROM missions WHERE id = ?", (mid,))
    mission = await cur.fetchone()
    if not mission:
        return {"error": f"Mission {mid} not found"}
    mission = dict(mission)

    now = _now_iso()

    # Update mission status
    await conn.execute(
        "UPDATE missions SET status = ?, updated_at = ? WHERE id = ?",
        (new_status, now, mid),
    )

    session_id = args.get("session_id")
    session_result = None

    # If transitioning to running, create a session if one doesn't exist
    if new_status == "running":
        if not session_id:
            session_id = str(uuid.uuid4())
        model = args.get("model") or mission.get("model") or "claude-sonnet-4-20250514"
        # Check if session already exists
        cur = await conn.execute("SELECT id FROM agent_sessions WHERE id = ?", (session_id,))
        existing = await cur.fetchone()
        if existing:
            # Update existing session
            updates = ["status = 'running'"]
            params = []
            if args.get("model"):
                updates.append("model = ?")
                params.append(args["model"])
            if args.get("cost_usd") is not None:
                updates.append("total_cost_usd = ?")
                params.append(args["cost_usd"])
            if args.get("total_tokens") is not None:
                updates.append("total_tokens = ?")
                params.append(args["total_tokens"])
            params.append(session_id)
            await conn.execute(
                f"UPDATE agent_sessions SET {', '.join(updates)} WHERE id = ?",
                params,
            )
        else:
            # Create new session
            await conn.execute(
                "INSERT INTO agent_sessions (id, mission_id, model, status) VALUES (?, ?, ?, 'running')",
                (session_id, mid, model),
            )
        session_result = {"session_id": session_id, "model": model}

    # If transitioning to completed or failed, finalize the session
    elif new_status in ("completed", "failed"):
        if session_id:
            target_sid = session_id
        else:
            # Find the latest running session
            cur = await conn.execute(
                "SELECT id FROM agent_sessions WHERE mission_id = ? ORDER BY started_at DESC LIMIT 1",
                (mid,),
            )
            row = await cur.fetchone()
            target_sid = row["id"] if row else None

        if target_sid:
            session_status = "completed" if new_status == "completed" else "failed"
            updates = [f"status = '{session_status}'", f"ended_at = '{now}'"]
            params = []
            if args.get("cost_usd") is not None:
                updates.append("total_cost_usd = ?")
                params.append(args["cost_usd"])
            if args.get("total_tokens") is not None:
                updates.append("total_tokens = ?")
                params.append(args["total_tokens"])
            params.append(target_sid)
            await conn.execute(
                f"UPDATE agent_sessions SET {', '.join(updates)} WHERE id = ?",
                params,
            )
            session_result = {"session_id": target_sid, "status": session_status}

    await conn.commit()

    result = {
        "mission_id": mid,
        "status": new_status,
        "updated_at": now,
    }
    if session_result:
        result["session"] = session_result

    return result


async def _submit_report(args: dict, conn) -> dict:
    mid = args["mission_id"]

    # Verify mission exists
    cur = await conn.execute("SELECT id FROM missions WHERE id = ?", (mid,))
    if not await cur.fetchone():
        return {"error": f"Mission {mid} not found"}

    # Resolve session ID
    session_id = args.get("session_id")
    if not session_id:
        cur = await conn.execute(
            "SELECT id FROM agent_sessions WHERE mission_id = ? ORDER BY started_at DESC LIMIT 1",
            (mid,),
        )
        row = await cur.fetchone()
        if not row:
            # Create a placeholder session so the report has a valid FK
            session_id = str(uuid.uuid4())
            await conn.execute(
                "INSERT INTO agent_sessions (id, mission_id, status) VALUES (?, ?, 'completed')",
                (session_id, mid),
            )
        else:
            session_id = row["id"]

    report_id = str(uuid.uuid4())
    await conn.execute(
        """INSERT INTO reports
           (id, session_id, mission_id, files_changed, what_done, what_open,
            what_tested, what_untested, next_steps, errors_encountered)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            report_id,
            session_id,
            mid,
            args.get("files_changed", ""),
            args.get("what_done", ""),
            args.get("what_open", ""),
            args.get("what_tested", ""),
            args.get("what_untested", ""),
            args.get("next_steps", ""),
            args.get("errors_encountered", ""),
        ),
    )
    await conn.commit()

    return {
        "report_id": report_id,
        "mission_id": mid,
        "session_id": session_id,
        "status": "submitted",
    }


async def _get_mission_status(args: dict, conn) -> dict:
    mid = args["mission_id"]

    cur = await conn.execute("SELECT * FROM missions WHERE id = ?", (mid,))
    mission = await cur.fetchone()
    if not mission:
        return {"error": f"Mission {mid} not found"}
    mission = dict(mission)

    # Get latest session
    cur = await conn.execute(
        "SELECT * FROM agent_sessions WHERE mission_id = ? ORDER BY started_at DESC LIMIT 1",
        (mid,),
    )
    session = await cur.fetchone()

    result = {
        "id": mission["id"],
        "title": mission["title"],
        "status": mission["status"],
        "mission_number": mission["mission_number"],
        "depends_on": json.loads(mission["depends_on"] or "[]"),
        "priority": mission["priority"],
        "project_id": mission["project_id"],
    }

    if session:
        session = dict(session)
        result["session"] = {
            "id": session["id"],
            "status": session["status"],
            "started_at": session["started_at"],
            "ended_at": session["ended_at"],
            "total_cost_usd": session["total_cost_usd"],
            "total_tokens": session["total_tokens"],
        }

    return result


async def _get_report(args: dict, conn) -> dict:
    mid = args["mission_id"]

    cur = await conn.execute(
        "SELECT * FROM reports WHERE mission_id = ? ORDER BY created_at DESC LIMIT 1",
        (mid,),
    )
    report = await cur.fetchone()
    if not report:
        return {"error": f"No report found for mission {mid}", "hint": "The mission may not have completed yet."}

    report = dict(report)
    return {
        "mission_id": mid,
        "report_id": report["id"],
        "files_changed": report["files_changed"],
        "what_done": report["what_done"],
        "what_open": report["what_open"],
        "what_tested": report["what_tested"],
        "what_untested": report["what_untested"],
        "next_steps": report["next_steps"],
        "errors_encountered": report["errors_encountered"],
        "created_at": report["created_at"],
    }


async def _get_unblocked_missions(args: dict, conn) -> dict:
    """Find missions in draft/ready status whose dependencies are all completed."""
    project_id = args.get("project_id")

    if project_id:
        cur = await conn.execute(
            "SELECT * FROM missions WHERE project_id = ? AND status IN ('draft', 'ready') ORDER BY priority DESC, mission_number",
            (project_id,),
        )
    else:
        cur = await conn.execute(
            "SELECT * FROM missions WHERE status IN ('draft', 'ready') ORDER BY priority DESC, mission_number",
        )

    rows = await cur.fetchall()
    unblocked = []

    for row in rows:
        m = dict(row)
        deps = json.loads(m["depends_on"] or "[]")

        if not deps:
            # No dependencies — always unblocked
            unblocked.append(m)
            continue

        # Check if all dependencies are completed
        placeholders = ",".join("?" for _ in deps)
        dep_cur = await conn.execute(
            f"SELECT COUNT(*) FROM missions WHERE id IN ({placeholders}) AND status = 'completed'",
            deps,
        )
        completed_count = (await dep_cur.fetchone())[0]

        if completed_count == len(deps):
            unblocked.append(m)

    return {
        "missions": [
            {
                "id": m["id"],
                "title": m["title"],
                "status": m["status"],
                "mission_number": m["mission_number"],
                "project_id": m["project_id"],
                "depends_on": json.loads(m["depends_on"] or "[]"),
                "priority": m["priority"],
            }
            for m in unblocked
        ],
        "count": len(unblocked),
    }


async def _get_cost_summary(args: dict, conn) -> dict:
    """Aggregate cost and token data across sessions."""
    mission_id = args.get("mission_id")
    project_id = args.get("project_id")

    if mission_id:
        cur = await conn.execute(
            "SELECT COUNT(*) as session_count, "
            "COALESCE(SUM(total_cost_usd), 0) as total_cost_usd, "
            "COALESCE(SUM(total_tokens), 0) as total_tokens "
            "FROM agent_sessions WHERE mission_id = ?",
            (mission_id,),
        )
        row = dict(await cur.fetchone())
        row["scope"] = "mission"
        row["mission_id"] = mission_id
        return row

    elif project_id:
        cur = await conn.execute(
            "SELECT COUNT(*) as session_count, "
            "COALESCE(SUM(s.total_cost_usd), 0) as total_cost_usd, "
            "COALESCE(SUM(s.total_tokens), 0) as total_tokens "
            "FROM agent_sessions s "
            "JOIN missions m ON s.mission_id = m.id "
            "WHERE m.project_id = ?",
            (project_id,),
        )
        row = dict(await cur.fetchone())
        row["scope"] = "project"
        row["project_id"] = project_id

        # Per-mission breakdown
        cur = await conn.execute(
            "SELECT m.id, m.title, m.mission_number, "
            "COUNT(s.id) as session_count, "
            "COALESCE(SUM(s.total_cost_usd), 0) as cost_usd, "
            "COALESCE(SUM(s.total_tokens), 0) as tokens "
            "FROM missions m "
            "LEFT JOIN agent_sessions s ON s.mission_id = m.id "
            "WHERE m.project_id = ? "
            "GROUP BY m.id ORDER BY m.mission_number",
            (project_id,),
        )
        row["missions"] = [dict(r) for r in await cur.fetchall()]
        return row

    else:
        # Global summary
        cur = await conn.execute(
            "SELECT COUNT(*) as session_count, "
            "COALESCE(SUM(total_cost_usd), 0) as total_cost_usd, "
            "COALESCE(SUM(total_tokens), 0) as total_tokens "
            "FROM agent_sessions",
        )
        row = dict(await cur.fetchone())
        row["scope"] = "global"

        # Per-project breakdown
        cur = await conn.execute(
            "SELECT p.id, p.name, "
            "COUNT(s.id) as session_count, "
            "COALESCE(SUM(s.total_cost_usd), 0) as cost_usd, "
            "COALESCE(SUM(s.total_tokens), 0) as tokens "
            "FROM projects p "
            "LEFT JOIN missions m ON m.project_id = p.id "
            "LEFT JOIN agent_sessions s ON s.mission_id = m.id "
            "GROUP BY p.id ORDER BY cost_usd DESC",
        )
        row["projects"] = [dict(r) for r in await cur.fetchall()]
        return row


async def _get_dashboard(conn) -> dict:
    # Project count
    cur = await conn.execute("SELECT COUNT(*) FROM projects")
    project_count = (await cur.fetchone())[0]

    # Mission stats by status
    cur = await conn.execute(
        "SELECT status, COUNT(*) as cnt FROM missions GROUP BY status"
    )
    mission_stats = {row["status"]: row["cnt"] for row in await cur.fetchall()}

    # Total cost
    cur = await conn.execute(
        "SELECT COALESCE(SUM(total_cost_usd), 0) as cost, COALESCE(SUM(total_tokens), 0) as tokens "
        "FROM agent_sessions"
    )
    cost_row = dict(await cur.fetchone())

    # Recent completions (last 5)
    cur = await conn.execute(
        "SELECT m.id, m.title, m.status, m.updated_at, s.total_cost_usd "
        "FROM missions m LEFT JOIN agent_sessions s ON m.id = s.mission_id "
        "WHERE m.status IN ('completed', 'failed') "
        "ORDER BY m.updated_at DESC LIMIT 5"
    )
    recent = [dict(r) for r in await cur.fetchall()]

    # Unblocked count (missions ready to start)
    unblocked_result = await _get_unblocked_missions({}, conn)

    return {
        "projects": project_count,
        "missions": mission_stats,
        "total_cost_usd": cost_row["cost"],
        "total_tokens": cost_row["tokens"],
        "unblocked_missions": unblocked_result["count"],
        "recent_activity": recent,
    }


async def _list_projects(conn) -> dict:
    cur = await conn.execute("SELECT id, name, path, description, created_at FROM projects ORDER BY created_at DESC")
    rows = await cur.fetchall()
    return {
        "projects": [dict(r) for r in rows],
        "count": len(rows),
    }


async def _list_missions(args: dict, conn) -> dict:
    pid = args["project_id"]
    status = args.get("status")

    if status:
        cur = await conn.execute(
            "SELECT id, title, status, mission_number, depends_on, priority, created_at, updated_at "
            "FROM missions WHERE project_id = ? AND status = ? ORDER BY mission_number",
            (pid, status),
        )
    else:
        cur = await conn.execute(
            "SELECT id, title, status, mission_number, depends_on, priority, created_at, updated_at "
            "FROM missions WHERE project_id = ? ORDER BY mission_number",
            (pid,),
        )

    rows = await cur.fetchall()
    missions = []
    for r in rows:
        m = dict(r)
        m["depends_on"] = json.loads(m["depends_on"] or "[]")
        missions.append(m)

    return {"missions": missions, "count": len(missions)}
