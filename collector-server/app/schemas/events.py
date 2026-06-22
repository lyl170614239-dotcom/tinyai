from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


ToolName = Literal["codex", "claude", "copilot"]
SourceConfidence = Literal["direct", "derived", "inferred"]
EventType = Literal[
    "task_start",
    "task_end",
    "spec_read",
    "catalog_hit",
    "fallback_search",
    "official_misread",
    "code_change",
    "ai_line_snapshot",
    "commit_snapshot",
    "push_snapshot",
    "user_correction",
    "regenerate",
    "interruption",
    "adoption_snapshot",
    "conversation_snapshot",
    "plugin_heartbeat",
]


class EventIn(BaseModel):
    event_id: str = Field(..., min_length=8, max_length=64)
    task_id: str = Field(..., min_length=8, max_length=64)
    session_id: Optional[str] = Field(default=None, max_length=128)
    tool: ToolName
    event_type: EventType
    occurred_at: datetime
    workspace_path_hash: Optional[str] = Field(default=None, max_length=128)
    payload: dict = Field(default_factory=dict)
    source_confidence: SourceConfidence = "direct"


class BatchIn(BaseModel):
    client_id: str = Field(..., min_length=3, max_length=128)
    plugin_name: str = Field(default="tinyai-observability", max_length=128)
    plugin_version: str = Field(default="0.1.0", max_length=64)
    events: list[EventIn] = Field(..., min_length=1, max_length=200)


class BatchOut(BaseModel):
    accepted: int
    duplicates: int
    task_count: int


class PluginClientOut(BaseModel):
    client_id: str
    tool: str
    plugin_name: Optional[str]
    plugin_version: Optional[str]
    last_seen_at: datetime


class TaskSummaryOut(BaseModel):
    task_id: str
    session_id: Optional[str]
    tool: str
    workspace_path_hash: Optional[str]
    started_at: Optional[datetime]
    ended_at: Optional[datetime]
    result: Optional[str]
    event_count: int


class EventOut(BaseModel):
    event_id: str
    task_id: str
    session_id: Optional[str]
    tool: str
    event_type: str
    occurred_at: datetime
    workspace_path_hash: Optional[str]
    source_confidence: str
    payload: Optional[dict]
