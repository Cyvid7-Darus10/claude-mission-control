import asyncio
import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import db
from models import ProjectCreate, ProjectUpdate, MissionCreate, MissionUpdate
import mission_watcher
import scheduler

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
log = logging.getLogger("mission-control")


# ──────────────────────────────────────────────
# Lifespan
# ──────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app):
    await db.init_db()
    await mission_watcher.start_watcher()
    await scheduler.start_scheduler()
    from plugins import load_plugins
    load_plugins()
    log.info("Mission Control API started — DB at %s", db.DB_PATH)
    yield
    await scheduler.stop_scheduler()
    await mission_watcher.stop_watcher()
    log.info("Mission Control API shutting down")


app = FastAPI(title="Mission Control API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ──────────────────────────────────────────────
# MCP Server — External integration endpoint
# ──────────────────────────────────────────────

from mcp.server.sse import SseServerTransport
from mcp.server.streamable_http import StreamableHTTPServerTransport
from mcp_external import server as mcp_server
from starlette.routing import Route, Mount

_mcp_sse = SseServerTransport("/messages/")


class _McpSseEndpoint:
    async def __call__(self, scope, receive, send):
        try:
            async with _mcp_sse.connect_sse(scope, receive, send) as streams:
                await mcp_server.run(
                    streams[0], streams[1],
                    mcp_server.create_initialization_options(),
                )
        except Exception:
            log.exception("MCP SSE session error")


class _McpPostEndpoint:
    async def __call__(self, scope, receive, send):
        try:
            await _mcp_sse.handle_post_message(scope, receive, send)
        except Exception:
            log.exception("MCP POST handler error")


_http_transports: dict[str, StreamableHTTPServerTransport] = {}
_http_ready: dict[str, asyncio.Event] = {}


async def _ensure_http_transport(session_id: str) -> StreamableHTTPServerTransport:
    if session_id in _http_transports:
        await _http_ready[session_id].wait()
        return _http_transports[session_id]

    transport = StreamableHTTPServerTransport(mcp_session_id=session_id)
    _http_transports[session_id] = transport
    _http_ready[session_id] = asyncio.Event()

    async def _run_server():
        try:
            async with transport.connect() as streams:
                _http_ready[session_id].set()
                await mcp_server.run(
                    streams[0], streams[1],
                    mcp_server.create_initialization_options(),
                )
        except Exception:
            log.exception("MCP HTTP session error")
        finally:
            _http_transports.pop(session_id, None)
            _http_ready.pop(session_id, None)

    asyncio.create_task(_run_server())
    await _http_ready[session_id].wait()
    return transport


class _McpHttpEndpoint:
    async def __call__(self, scope, receive, send):
        import uuid as _uuid
        from starlette.requests import Request

        request = Request(scope, receive, send)
        session_id = request.headers.get("mcp-session-id")

        if request.method == "DELETE":
            if session_id and session_id in _http_transports:
                transport = _http_transports.pop(session_id)
                _http_ready.pop(session_id, None)
                await transport.terminate()
            return

        if not session_id:
            session_id = str(_uuid.uuid4())
        transport = await _ensure_http_transport(session_id)
        await transport.handle_request(scope, receive, send)


app.mount("/mcp", Mount(path="", routes=[
    Route("/", endpoint=_McpHttpEndpoint(), methods=["GET", "POST", "DELETE"]),
    Route("/sse", endpoint=_McpSseEndpoint()),
    Route("/messages/", endpoint=_McpPostEndpoint(), methods=["POST"]),
]))


# ──────────────────────────────────────────────
# Projects
# ──────────────────────────────────────────────

@app.get("/api/projects")
async def list_projects():
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            """SELECT p.*,
                      COUNT(m.id) AS mission_count,
                      SUM(CASE WHEN m.status='running' THEN 1 ELSE 0 END) AS running_count,
                      SUM(CASE WHEN m.status='completed' THEN 1 ELSE 0 END) AS completed_count
               FROM projects p
               LEFT JOIN missions m ON m.project_id = p.id
               GROUP BY p.id
               ORDER BY p.created_at DESC"""
        )
        return [dict(r) for r in rows]
    finally:
        await conn.close()


@app.post("/api/projects", status_code=201)
async def create_project(body: ProjectCreate):
    if not os.path.isdir(body.path):
        raise HTTPException(400, f"Path does not exist: {body.path}")
    pid = str(uuid.uuid4())
    conn = await db.get_db()
    try:
        await conn.execute(
            "INSERT INTO projects (id, name, path, description) VALUES (?, ?, ?, ?)",
            (pid, body.name, body.path, body.description),
        )
        await conn.commit()
        row = await conn.execute_fetchall("SELECT * FROM projects WHERE id=?", (pid,))
        return dict(row[0])
    finally:
        await conn.close()


@app.get("/api/projects/{pid}")
async def get_project(pid: str):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall("SELECT * FROM projects WHERE id=?", (pid,))
        if not rows:
            raise HTTPException(404, "Project not found")
        project = dict(rows[0])
        missions = await conn.execute_fetchall(
            "SELECT * FROM missions WHERE project_id=? ORDER BY priority DESC, created_at DESC",
            (pid,),
        )
        project["missions"] = [dict(m) for m in missions]
        return project
    finally:
        await conn.close()


@app.put("/api/projects/{pid}")
async def update_project(pid: str, body: ProjectUpdate):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall("SELECT * FROM projects WHERE id=?", (pid,))
        if not rows:
            raise HTTPException(404, "Project not found")
        updates = body.model_dump(exclude_none=True)
        if not updates:
            return dict(rows[0])
        if "path" in updates and not os.path.isdir(updates["path"]):
            raise HTTPException(400, f"Path does not exist: {updates['path']}")
        sets = ", ".join(f"{k}=?" for k in updates)
        vals = list(updates.values()) + [pid]
        await conn.execute(f"UPDATE projects SET {sets} WHERE id=?", vals)
        await conn.commit()
        row = await conn.execute_fetchall("SELECT * FROM projects WHERE id=?", (pid,))
        return dict(row[0])
    finally:
        await conn.close()


@app.delete("/api/projects/{pid}")
async def delete_project(pid: str):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall("SELECT * FROM projects WHERE id=?", (pid,))
        if not rows:
            raise HTTPException(404, "Project not found")
        await conn.execute("DELETE FROM projects WHERE id=?", (pid,))
        await conn.commit()
        return {"ok": True}
    finally:
        await conn.close()


# ──────────────────────────────────────────────
# Missions
# ──────────────────────────────────────────────

@app.get("/api/missions")
async def list_missions(
    project_id: str = Query(None),
    status: str = Query(None),
    tag: str = Query(None),
    parent_mission_id: str = Query(None),
):
    conn = await db.get_db()
    try:
        query = """SELECT m.*, p.name AS project_name
                   FROM missions m
                   JOIN projects p ON p.id = m.project_id
                   WHERE 1=1"""
        params = []
        if project_id:
            query += " AND m.project_id=?"
            params.append(project_id)
        if status:
            query += " AND m.status=?"
            params.append(status)
        if parent_mission_id:
            query += " AND m.parent_mission_id=?"
            params.append(parent_mission_id)
        query += " ORDER BY m.priority DESC, m.created_at DESC"
        rows = await conn.execute_fetchall(query, params)
        results = []
        for r in rows:
            d = dict(r)
            if tag:
                tags = json.loads(d.get("tags", "[]"))
                if tag not in tags:
                    continue
            results.append(d)
        return results
    finally:
        await conn.close()


@app.post("/api/missions", status_code=201)
async def create_mission(body: MissionCreate):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall("SELECT id FROM projects WHERE id=?", (body.project_id,))
        if not rows:
            raise HTTPException(400, "Project not found")
        mid = str(uuid.uuid4())
        schedule_enabled = 1 if body.schedule_cron else 0
        num_rows = await conn.execute_fetchall(
            "SELECT COALESCE(MAX(mission_number), 0) + 1 AS next_num FROM missions WHERE project_id=?",
            (body.project_id,),
        )
        next_num = num_rows[0][0] if num_rows else 1
        await conn.execute(
            """INSERT INTO missions (id, project_id, title, detailed_prompt, acceptance_criteria,
               priority, tags, model, max_turns, max_budget_usd, allowed_tools, mission_type,
               parent_mission_id, depends_on, auto_dispatch, schedule_cron, schedule_enabled, mission_number)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (mid, body.project_id, body.title, body.detailed_prompt,
             body.acceptance_criteria, body.priority, json.dumps(body.tags),
             body.model, body.max_turns, body.max_budget_usd,
             body.allowed_tools or "", body.mission_type,
             body.parent_mission_id, json.dumps(body.depends_on),
             1 if body.auto_dispatch else 0, body.schedule_cron, schedule_enabled, next_num),
        )
        await conn.commit()
        row = await conn.execute_fetchall(
            "SELECT m.*, p.name AS project_name FROM missions m JOIN projects p ON p.id=m.project_id WHERE m.id=?",
            (mid,),
        )
        return dict(row[0])
    finally:
        await conn.close()


@app.get("/api/missions/{mid}")
async def get_mission(mid: str):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            "SELECT m.*, p.name AS project_name, p.path AS project_path FROM missions m JOIN projects p ON p.id=m.project_id WHERE m.id=?",
            (mid,),
        )
        if not rows:
            raise HTTPException(404, "Mission not found")
        mission = dict(rows[0])

        sessions = await conn.execute_fetchall(
            "SELECT * FROM agent_sessions WHERE mission_id=? ORDER BY started_at DESC",
            (mid,),
        )
        mission["sessions"] = [dict(s) for s in sessions]

        reports = await conn.execute_fetchall(
            "SELECT * FROM reports WHERE mission_id=? ORDER BY created_at DESC LIMIT 1",
            (mid,),
        )
        mission["latest_report"] = dict(reports[0]) if reports else None

        children = await conn.execute_fetchall(
            "SELECT id, title, status, mission_type FROM missions WHERE parent_mission_id=? ORDER BY created_at",
            (mid,),
        )
        mission["children"] = [dict(c) for c in children]

        return mission
    finally:
        await conn.close()


@app.get("/api/missions/{mid}/children")
async def list_children(mid: str):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            """SELECT m.*, p.name AS project_name
               FROM missions m
               JOIN projects p ON p.id = m.project_id
               WHERE m.parent_mission_id=?
               ORDER BY m.priority DESC, m.created_at""",
            (mid,),
        )
        return [dict(r) for r in rows]
    finally:
        await conn.close()


@app.put("/api/missions/{mid}")
async def update_mission(mid: str, body: MissionUpdate):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall("SELECT * FROM missions WHERE id=?", (mid,))
        if not rows:
            raise HTTPException(404, "Mission not found")
        updates = body.model_dump(exclude_none=True)
        if not updates:
            return dict(rows[0])
        if "tags" in updates:
            updates["tags"] = json.dumps(updates["tags"])
        if "depends_on" in updates:
            updates["depends_on"] = json.dumps(updates["depends_on"])
        if "auto_dispatch" in updates:
            updates["auto_dispatch"] = 1 if updates["auto_dispatch"] else 0
        if "schedule_enabled" in updates:
            updates["schedule_enabled"] = 1 if updates["schedule_enabled"] else 0
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        sets = ", ".join(f"{k}=?" for k in updates)
        vals = list(updates.values()) + [mid]
        await conn.execute(f"UPDATE missions SET {sets} WHERE id=?", vals)
        await conn.commit()
        row = await conn.execute_fetchall(
            "SELECT m.*, p.name AS project_name FROM missions m JOIN projects p ON p.id=m.project_id WHERE m.id=?",
            (mid,),
        )
        return dict(row[0])
    finally:
        await conn.close()


@app.delete("/api/missions/{mid}")
async def delete_mission(mid: str):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall("SELECT status FROM missions WHERE id=?", (mid,))
        if not rows:
            raise HTTPException(404, "Mission not found")
        if dict(rows[0])["status"] == "running":
            raise HTTPException(400, "Cannot delete a running mission — cancel it first")
        await conn.execute("DELETE FROM missions WHERE id=?", (mid,))
        await conn.commit()
        return {"ok": True}
    finally:
        await conn.close()


@app.get("/api/missions/{mid}/events")
async def list_mission_events(mid: str, limit: int = Query(20)):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            "SELECT * FROM mission_events WHERE mission_id=? ORDER BY created_at DESC LIMIT ?",
            (mid, limit),
        )
        return [dict(r) for r in rows]
    finally:
        await conn.close()


# ──────────────────────────────────────────────
# Generate Next Mission from Report
# ──────────────────────────────────────────────

@app.post("/api/missions/{mid}/generate-next")
async def generate_next_mission(mid: str):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            "SELECT m.*, p.name AS project_name FROM missions m JOIN projects p ON p.id=m.project_id WHERE m.id=?",
            (mid,),
        )
        if not rows:
            raise HTTPException(404, "Mission not found")
        mission = dict(rows[0])

        reports = await conn.execute_fetchall(
            "SELECT * FROM reports WHERE mission_id=? ORDER BY created_at DESC LIMIT 1",
            (mid,),
        )
        if not reports:
            raise HTTPException(400, "No report found for this mission")
        report = dict(reports[0])

        what_open = report.get("what_open", "").strip()
        what_untested = report.get("what_untested", "").strip()
        next_steps = report.get("next_steps", "").strip()
        what_done = report.get("what_done", "").strip()
        errors = report.get("errors_encountered", "").strip()

        title_line = ""
        for line in (next_steps or what_open or "").split("\n"):
            cleaned = line.strip().lstrip("-\u2022* ")
            if cleaned:
                title_line = cleaned
                break
        new_title = title_line[:80] if title_line else f"Continue: {mission['title']}"

        prompt_parts = [f"## Context from Previous Mission: {mission['title']}\n"]
        if what_done:
            prompt_parts.append(f"### Already Completed\n{what_done}\n")
        if errors and errors.lower() not in ("none", "- none", "n/a", ""):
            prompt_parts.append(f"### Errors from Previous Session (fix these first)\n{errors}\n")
        if what_open and what_open.lower() not in ("none", "- none", "n/a", ""):
            prompt_parts.append(f"### Open Items to Complete\n{what_open}\n")
        if what_untested and what_untested.lower() not in ("none", "- none", "n/a", ""):
            prompt_parts.append(f"### Needs Testing\n{what_untested}\n")

        prompt_parts.append("## Your Task\n")
        if next_steps:
            prompt_parts.append(next_steps)
        elif what_open:
            prompt_parts.append(f"Complete the remaining open items:\n{what_open}")
        else:
            prompt_parts.append("Review the completed work and add tests/improvements as needed.")

        criteria_parts = []
        if what_untested and what_untested.lower() not in ("none", "- none", "n/a", ""):
            criteria_parts.append(f"Test coverage for:\n{what_untested}")
        if what_open and what_open.lower() not in ("none", "- none", "n/a", ""):
            criteria_parts.append(f"Complete:\n{what_open}")

        new_id = str(uuid.uuid4())
        tags = mission.get("tags", "[]")
        num_rows = await conn.execute_fetchall(
            "SELECT COALESCE(MAX(mission_number), 0) + 1 AS next_num FROM missions WHERE project_id=?",
            (mission["project_id"],),
        )
        next_num = num_rows[0][0] if num_rows else 1
        await conn.execute(
            """INSERT INTO missions (id, project_id, title, detailed_prompt, acceptance_criteria, priority, tags, mission_number)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (new_id, mission["project_id"], new_title,
             "\n".join(prompt_parts),
             "\n".join(criteria_parts) if criteria_parts else "",
             mission.get("priority", 0), tags, next_num),
        )
        await conn.commit()

        row = await conn.execute_fetchall(
            "SELECT m.*, p.name AS project_name FROM missions m JOIN projects p ON p.id=m.project_id WHERE m.id=?",
            (new_id,),
        )
        return dict(row[0])
    finally:
        await conn.close()


# ──────────────────────────────────────────────
# Submit Report for a Mission
# ──────────────────────────────────────────────

class ReportSubmit(BaseModel):
    session_id: str | None = None
    what_done: str = ""
    what_open: str = ""
    what_untested: str = ""
    errors_encountered: str = ""
    next_steps: str = ""
    confidence: float | None = None


@app.post("/api/missions/{mid}/report", status_code=201)
async def submit_report(mid: str, body: ReportSubmit):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall("SELECT id FROM missions WHERE id=?", (mid,))
        if not rows:
            raise HTTPException(404, "Mission not found")
        rid = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        await conn.execute(
            """INSERT INTO reports (id, mission_id, session_id, what_done, what_open,
               what_untested, errors_encountered, next_steps, confidence, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (rid, mid, body.session_id, body.what_done, body.what_open,
             body.what_untested, body.errors_encountered, body.next_steps,
             body.confidence, now),
        )
        await conn.commit()
        row = await conn.execute_fetchall("SELECT * FROM reports WHERE id=?", (rid,))
        return dict(row[0])
    finally:
        await conn.close()


# ──────────────────────────────────────────────
# Sessions
# ──────────────────────────────────────────────

class SessionCreate(BaseModel):
    mission_id: str
    model: str = "claude-sonnet-4-6"
    claude_session_id: str | None = None


class SessionUpdate(BaseModel):
    status: str | None = None
    total_cost_usd: float | None = None
    total_tokens: int | None = None
    ended_at: str | None = None


@app.get("/api/sessions")
async def list_sessions(mission_id: str = Query(None), status: str = Query(None)):
    conn = await db.get_db()
    try:
        query = """SELECT s.*, m.title AS mission_title, p.name AS project_name
                   FROM agent_sessions s
                   JOIN missions m ON m.id = s.mission_id
                   JOIN projects p ON p.id = m.project_id
                   WHERE 1=1"""
        params = []
        if mission_id:
            query += " AND s.mission_id=?"
            params.append(mission_id)
        if status:
            query += " AND s.status=?"
            params.append(status)
        query += " ORDER BY s.started_at DESC"
        rows = await conn.execute_fetchall(query, params)
        return [dict(r) for r in rows]
    finally:
        await conn.close()


@app.get("/api/sessions/{sid}")
async def get_session(sid: str):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            """SELECT s.*, m.title AS mission_title, m.id AS mission_id, m.mission_number
               FROM agent_sessions s
               JOIN missions m ON m.id = s.mission_id
               WHERE s.id=?""",
            (sid,),
        )
        if not rows:
            raise HTTPException(404, "Session not found")
        session = dict(rows[0])
        reports = await conn.execute_fetchall(
            "SELECT * FROM reports WHERE session_id=?", (sid,)
        )
        session["report"] = dict(reports[0]) if reports else None
        return session
    finally:
        await conn.close()


@app.post("/api/sessions", status_code=201)
async def create_session(body: SessionCreate):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall("SELECT id FROM missions WHERE id=?", (body.mission_id,))
        if not rows:
            raise HTTPException(400, "Mission not found")
        sid = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        await conn.execute(
            "INSERT INTO agent_sessions (id, mission_id, model, claude_session_id, started_at) VALUES (?, ?, ?, ?, ?)",
            (sid, body.mission_id, body.model, body.claude_session_id or "", now),
        )
        await conn.commit()
        row = await conn.execute_fetchall("SELECT * FROM agent_sessions WHERE id=?", (sid,))
        return dict(row[0])
    finally:
        await conn.close()


@app.put("/api/sessions/{sid}")
async def update_session(sid: str, body: SessionUpdate):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall("SELECT * FROM agent_sessions WHERE id=?", (sid,))
        if not rows:
            raise HTTPException(404, "Session not found")
        updates = body.model_dump(exclude_none=True)
        if not updates:
            return dict(rows[0])
        sets = ", ".join(f"{k}=?" for k in updates)
        vals = list(updates.values()) + [sid]
        await conn.execute(f"UPDATE agent_sessions SET {sets} WHERE id=?", vals)
        await conn.commit()
        row = await conn.execute_fetchall("SELECT * FROM agent_sessions WHERE id=?", (sid,))
        return dict(row[0])
    finally:
        await conn.close()


# ──────────────────────────────────────────────
# Reports
# ──────────────────────────────────────────────

@app.get("/api/reports")
async def list_reports(project_id: str = Query(None), mission_id: str = Query(None)):
    conn = await db.get_db()
    try:
        query = """SELECT r.*, m.title AS mission_title, p.name AS project_name
                   FROM reports r
                   JOIN missions m ON m.id = r.mission_id
                   JOIN projects p ON p.id = m.project_id
                   WHERE 1=1"""
        params = []
        if mission_id:
            query += " AND r.mission_id=?"
            params.append(mission_id)
        if project_id:
            query += " AND m.project_id=?"
            params.append(project_id)
        query += " ORDER BY r.created_at DESC"
        rows = await conn.execute_fetchall(query, params)
        return [dict(r) for r in rows]
    finally:
        await conn.close()


@app.get("/api/reports/{rid}")
async def get_report(rid: str):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            """SELECT r.*, m.title AS mission_title, p.name AS project_name
               FROM reports r
               JOIN missions m ON m.id = r.mission_id
               JOIN projects p ON p.id = m.project_id
               WHERE r.id=?""",
            (rid,),
        )
        if not rows:
            raise HTTPException(404, "Report not found")
        return dict(rows[0])
    finally:
        await conn.close()


# ──────────────────────────────────────────────
# Dashboard
# ──────────────────────────────────────────────

@app.get("/api/dashboard/stats")
async def dashboard_stats():
    conn = await db.get_db()
    try:
        projects = await conn.execute_fetchall("SELECT COUNT(*) AS c FROM projects")
        missions_by_status = await conn.execute_fetchall(
            "SELECT status, COUNT(*) AS c FROM missions GROUP BY status"
        )
        sessions_running = await conn.execute_fetchall(
            "SELECT COUNT(*) AS c FROM agent_sessions WHERE status='running'"
        )
        recent_reports = await conn.execute_fetchall(
            """SELECT r.id, r.created_at, r.what_done, r.what_open,
                      m.title AS mission_title, p.name AS project_name
               FROM reports r
               JOIN missions m ON m.id = r.mission_id
               JOIN projects p ON p.id = m.project_id
               ORDER BY r.created_at DESC LIMIT 10"""
        )
        recent_sessions = await conn.execute_fetchall(
            """SELECT s.id, s.status, s.started_at, s.ended_at,
                      m.title AS mission_title, p.name AS project_name
               FROM agent_sessions s
               JOIN missions m ON m.id = s.mission_id
               JOIN projects p ON p.id = m.project_id
               ORDER BY s.started_at DESC LIMIT 10"""
        )
        return {
            "total_projects": dict(projects[0])["c"],
            "missions_by_status": {dict(r)["status"]: dict(r)["c"] for r in missions_by_status},
            "running_sessions": dict(sessions_running[0])["c"],
            "recent_reports": [dict(r) for r in recent_reports],
            "recent_sessions": [dict(r) for r in recent_sessions],
        }
    finally:
        await conn.close()


# ──────────────────────────────────────────────
# Plan — Basic project planner
# ──────────────────────────────────────────────

from planner import plan_project


class PlanRequest(BaseModel):
    prompt: str
    project_path: str | None = None


@app.post("/api/plan", status_code=201)
async def api_plan_project(body: PlanRequest):
    project_path = body.project_path
    if not project_path:
        import re
        slug = re.sub(r'[^a-z0-9]+', '-', body.prompt.lower().strip())[:40].strip('-')
        projects_base = os.environ.get("MISSION_CONTROL_PROJECTS_DIR")
        if not projects_base:
            app_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            projects_base = os.path.join(app_root, "projects")
        project_path = os.path.join(projects_base, slug)

    try:
        result = await plan_project(body.prompt, project_path)
        return result
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        log.exception("Plan failed")
        raise HTTPException(500, f"Planning failed: {e}")


# ──────────────────────────────────────────────
# Scheduling
# ──────────────────────────────────────────────

class ScheduleRequest(BaseModel):
    cron: str
    enabled: bool = True


@app.post("/api/missions/{mid}/schedule")
async def set_schedule(mid: str, body: ScheduleRequest):
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall("SELECT id FROM missions WHERE id=?", (mid,))
        if not rows:
            raise HTTPException(404, "Mission not found")
        await conn.execute(
            "UPDATE missions SET schedule_cron=?, schedule_enabled=?, updated_at=? WHERE id=?",
            (body.cron, 1 if body.enabled else 0, datetime.now(timezone.utc).isoformat(), mid),
        )
        await conn.commit()
        return {"ok": True, "mission_id": mid, "cron": body.cron, "enabled": body.enabled}
    finally:
        await conn.close()


@app.delete("/api/missions/{mid}/schedule")
async def remove_schedule(mid: str):
    conn = await db.get_db()
    try:
        await conn.execute(
            "UPDATE missions SET schedule_enabled=0, updated_at=? WHERE id=?",
            (datetime.now(timezone.utc).isoformat(), mid),
        )
        await conn.commit()
        return {"ok": True}
    finally:
        await conn.close()


@app.get("/api/schedules")
async def list_schedules():
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            """SELECT m.id, m.title, m.schedule_cron, m.schedule_enabled,
                      m.last_scheduled_at, m.mission_type, m.project_id,
                      p.name AS project_name
               FROM missions m
               JOIN projects p ON p.id = m.project_id
               WHERE m.schedule_cron IS NOT NULL AND m.schedule_cron != ''
               ORDER BY m.schedule_enabled DESC, m.title"""
        )
        return [dict(r) for r in rows]
    finally:
        await conn.close()


# ──────────────────────────────────────────────
# System Status
# ──────────────────────────────────────────────

@app.get("/api/system/status")
async def system_status():
    return {
        "mission_watcher": mission_watcher.get_watcher_status(),
        "scheduler": scheduler.get_scheduler_status(),
    }


# ──────────────────────────────────────────────
# Plugins
# ──────────────────────────────────────────────

@app.get("/api/plugins")
async def api_list_plugins():
    from plugins import registry
    return {
        "loaded": registry.loaded_plugins,
        "custom_tools": [{"name": t.name, "description": t.description} for t in registry.tools],
        "hooks": {k: len(v) for k, v in registry._hooks.items() if v},
    }
