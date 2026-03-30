"""
Mission Watcher — Dependency readiness engine.

Background task that polls for missions marked auto_dispatch=1 whose
dependencies are satisfied, then marks them as "ready" for external dispatch.

This is the coordination layer for multi-agent mission tracking:
- Missions with depends_on wait until all dependencies complete
- When dependencies are met, the mission status is set to "ready"
- Emits mission_events for observability
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone

import db

log = logging.getLogger("devfleet.mission_watcher")

_watcher_task: asyncio.Task | None = None
POLL_INTERVAL = int(os.environ.get("DEVFLEET_WATCHER_INTERVAL", "5"))


async def _find_eligible_missions() -> list[dict]:
    """Find auto_dispatch missions whose dependencies are all completed."""
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            """SELECT m.*, p.path AS project_path, p.name AS project_name
               FROM missions m
               JOIN projects p ON p.id = m.project_id
               WHERE m.auto_dispatch = 1
                 AND m.status = 'draft'
                 AND NOT EXISTS (
                   SELECT 1 FROM json_each(m.depends_on) dep
                   WHERE dep.value NOT IN (
                     SELECT id FROM missions WHERE status = 'completed'
                   )
                 )
               ORDER BY m.priority DESC, m.created_at ASC""",
        )
        return [dict(r) for r in rows]
    finally:
        await conn.close()


async def _emit_event(mission_id: str, event_type: str, source_mission_id: str | None = None, data: dict | None = None):
    """Record a mission event for observability."""
    conn = await db.get_db()
    try:
        await conn.execute(
            "INSERT INTO mission_events (mission_id, event_type, source_mission_id, data) VALUES (?, ?, ?, ?)",
            (mission_id, event_type, source_mission_id, json.dumps(data or {})),
        )
        await conn.commit()
    except Exception as e:
        log.warning("Failed to emit event %s for %s: %s", event_type, mission_id, e)
    finally:
        await conn.close()


async def _mark_ready(mission: dict):
    """Mark a single eligible mission as ready."""
    mission_id = mission["id"]
    now = datetime.now(timezone.utc).isoformat()

    conn = await db.get_db()
    try:
        await conn.execute(
            "UPDATE missions SET status='ready', updated_at=? WHERE id=?",
            (now, mission_id),
        )
        await conn.commit()
    finally:
        await conn.close()

    await _emit_event(mission_id, "unblocked", data={"previous_status": "draft"})
    log.info("Mission '%s' (%s) marked ready — dependencies satisfied", mission["title"], mission_id)


async def _watch_loop():
    """Main polling loop — find eligible missions and mark them ready."""
    log.info("Mission watcher started (poll every %ds)", POLL_INTERVAL)

    while True:
        try:
            eligible = await _find_eligible_missions()
            for mission in eligible:
                try:
                    await _mark_ready(mission)
                except Exception as e:
                    log.error("Failed to mark mission %s as ready: %s", mission["id"], e)
                    await _emit_event(mission["id"], "unblock_failed", data={"error": str(e)})

        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.error("Mission watcher error: %s", e)

        await asyncio.sleep(POLL_INTERVAL)


async def start_watcher():
    """Start the mission watcher background task."""
    global _watcher_task
    if _watcher_task and not _watcher_task.done():
        return
    _watcher_task = asyncio.create_task(_watch_loop())
    log.info("Mission watcher started")


async def stop_watcher():
    """Stop the mission watcher."""
    global _watcher_task
    if _watcher_task and not _watcher_task.done():
        _watcher_task.cancel()
        try:
            await _watcher_task
        except asyncio.CancelledError:
            pass
    _watcher_task = None
    log.info("Mission watcher stopped")


def get_watcher_status() -> dict:
    """Get the watcher status."""
    return {
        "active": _watcher_task is not None and not _watcher_task.done(),
        "poll_interval": POLL_INTERVAL,
    }
