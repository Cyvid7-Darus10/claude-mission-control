from pydantic import BaseModel
from typing import Optional, List


class ProjectCreate(BaseModel):
    name: str
    path: str
    description: str = ""


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    path: Optional[str] = None
    description: Optional[str] = None


class MissionCreate(BaseModel):
    project_id: str
    title: str
    detailed_prompt: str
    acceptance_criteria: str = ""
    priority: int = 0
    tags: List[str] = []
    parent_mission_id: Optional[str] = None
    depends_on: List[str] = []
    auto_dispatch: bool = False
    schedule_cron: Optional[str] = None


class MissionUpdate(BaseModel):
    title: Optional[str] = None
    detailed_prompt: Optional[str] = None
    acceptance_criteria: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[int] = None
    tags: Optional[List[str]] = None
    parent_mission_id: Optional[str] = None
    depends_on: Optional[List[str]] = None
    auto_dispatch: Optional[bool] = None
    schedule_cron: Optional[str] = None
    schedule_enabled: Optional[bool] = None


class SessionCreate(BaseModel):
    mission_id: str
    model: str = "claude-opus-4-6"
    claude_session_id: Optional[str] = None


class SessionUpdate(BaseModel):
    status: Optional[str] = None
    total_cost_usd: Optional[float] = None
    total_tokens: Optional[int] = None
    ended_at: Optional[str] = None


class ReportCreate(BaseModel):
    mission_id: str
    session_id: str
    files_changed: str = ""
    what_done: str = ""
    what_open: str = ""
    what_tested: str = ""
    what_untested: str = ""
    next_steps: str = ""
    errors_encountered: str = ""
