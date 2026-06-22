from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base


class PluginClient(Base):
    __tablename__ = "plugin_clients"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    client_id: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    tool: Mapped[str] = mapped_column(String(32), nullable=False)
    plugin_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    plugin_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class TaskSession(Base):
    __tablename__ = "task_sessions"

    task_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    tool: Mapped[str] = mapped_column(String(32), nullable=False)
    workspace_path_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    result: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    source_confidence: Mapped[str] = mapped_column(String(24), nullable=False, default="direct")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    events = relationship("AgentEvent", back_populates="task", lazy="noload")


class AgentEvent(Base):
    __tablename__ = "agent_events"

    event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(64), ForeignKey("task_sessions.task_id", ondelete="CASCADE"), nullable=False)
    session_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    tool: Mapped[str] = mapped_column(String(32), nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    workspace_path_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    source_confidence: Mapped[str] = mapped_column(String(24), nullable=False)
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    task = relationship("TaskSession", back_populates="events", lazy="noload")

    __table_args__ = (
        Index("ix_agent_events_task_time", "task_id", "occurred_at"),
        Index("ix_agent_events_tool_time", "tool", "occurred_at"),
        Index("ix_agent_events_type_time", "event_type", "occurred_at"),
    )


class SpecAccessEvent(Base):
    __tablename__ = "spec_access_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(String(64), ForeignKey("agent_events.event_id", ondelete="CASCADE"), nullable=False)
    task_id: Mapped[str] = mapped_column(String(64), nullable=False)
    tool: Mapped[str] = mapped_column(String(32), nullable=False)
    spec_scope: Mapped[str] = mapped_column(String(32), nullable=False, default="unknown")
    doc_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    via_catalog: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    matched_by: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    fallback_used: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    confidence: Mapped[str] = mapped_column(String(24), nullable=False, default="direct")
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    __table_args__ = (
        UniqueConstraint("event_id", name="uq_spec_access_event_id"),
        Index("ix_spec_access_task", "task_id"),
        Index("ix_spec_access_scope_time", "spec_scope", "occurred_at"),
    )


class CodeChangeSnapshot(Base):
    __tablename__ = "code_change_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(String(64), ForeignKey("agent_events.event_id", ondelete="CASCADE"), nullable=False)
    task_id: Mapped[str] = mapped_column(String(64), nullable=False)
    tool: Mapped[str] = mapped_column(String(32), nullable=False)
    files_changed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lines_added: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lines_deleted: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    retained_lines: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    adoption_rate: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    snapshot_kind: Mapped[str] = mapped_column(String(32), nullable=False, default="task_end")
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    __table_args__ = (
        UniqueConstraint("event_id", name="uq_code_snapshot_event_id"),
        Index("ix_code_snapshot_task", "task_id"),
    )


class PullRequestAttribution(Base):
    __tablename__ = "pull_request_attributions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    delivery_id: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    repository_full_name: Mapped[str] = mapped_column(String(256), nullable=False)
    repository_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    pr_number: Mapped[int] = mapped_column(Integer, nullable=False)
    pr_node_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    sender_login: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    head_sha: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    base_sha: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    commit_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_lines_added: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_lines_deleted: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_files_changed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ai_commit_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ai_lines_added: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ai_lines_deleted: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ai_files_changed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ai_code_ratio: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    matched_commit_shas: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    unmatched_commit_shas: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    attribution_method: Mapped[str] = mapped_column(String(64), nullable=False, default="pr_commit_snapshot_intersection")
    confidence: Mapped[str] = mapped_column(String(24), nullable=False, default="derived")
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_pr_attr_repo_pr_time", "repository_full_name", "pr_number", "occurred_at"),
        Index("ix_pr_attr_head_sha", "head_sha"),
    )


class UploadFailure(Base):
    __tablename__ = "upload_failures"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    client_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    tool: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
