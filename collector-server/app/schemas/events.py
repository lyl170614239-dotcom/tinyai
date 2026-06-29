from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_serializer


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
    "turn_snapshot",
    "conversation_snapshot",
    "agent_process_snapshot",
    "agent_activity",
    "file_read",
    "plugin_heartbeat",
]


BEIJING_TZ = timezone(timedelta(hours=8))


def beijing_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=BEIJING_TZ)
    else:
        value = value.astimezone(BEIJING_TZ)
    return value.isoformat()


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
    username: str = Field(default="unknown", max_length=128)
    user_id: Optional[str] = Field(default=None, max_length=128)
    user_email: Optional[str] = Field(default=None, max_length=256)
    user_display_name: Optional[str] = Field(default=None, max_length=128)
    team: Optional[str] = Field(default=None, max_length=128)
    machine_id: Optional[str] = Field(default=None, max_length=128)
    host_hash: Optional[str] = Field(default=None, max_length=128)
    model: Optional[str] = Field(default=None, max_length=128)


class BatchIn(BaseModel):
    client_id: str = Field(..., min_length=3, max_length=128)
    plugin_name: str = Field(default="tinyai-observability", max_length=128)
    plugin_version: str = Field(default="0.1.0", max_length=64)
    username: str = Field(default="unknown", max_length=128)
    user_id: Optional[str] = Field(default=None, max_length=128)
    user_email: Optional[str] = Field(default=None, max_length=256)
    user_display_name: Optional[str] = Field(default=None, max_length=128)
    team: Optional[str] = Field(default=None, max_length=128)
    machine_id: Optional[str] = Field(default=None, max_length=128)
    host_hash: Optional[str] = Field(default=None, max_length=128)
    model: Optional[str] = Field(default=None, max_length=128)
    events: list[EventIn] = Field(..., min_length=1, max_length=200)


class BatchEventOut(BaseModel):
    event_id: str
    event_type: str
    status: Literal["accepted", "duplicate", "failed"]
    reason: Optional[str] = None


class BatchOut(BaseModel):
    accepted: int
    duplicates: int
    failed: int = 0
    task_count: int
    events: list[BatchEventOut] = Field(default_factory=list)


class PluginClientOut(BaseModel):
    client_id: str
    tool: str
    plugin_name: Optional[str]
    plugin_version: Optional[str]
    username: Optional[str]
    user_id: Optional[str]
    user_email: Optional[str]
    user_display_name: Optional[str]
    team: Optional[str]
    machine_id: Optional[str]
    last_seen_at: datetime

    @field_serializer("last_seen_at")
    def serialize_last_seen_at(self, value: datetime) -> str:
        return beijing_iso(value) or ""
