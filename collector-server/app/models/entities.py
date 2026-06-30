from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.orm import Mapped, mapped_column

from ..database import Base


class PluginClient(Base):
    __tablename__ = "plugin_clients"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    client_id: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    tool: Mapped[str] = mapped_column(String(32), nullable=False)
    plugin_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    plugin_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    username: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    user_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    user_email: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    user_display_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    team: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    machine_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    host_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_plugin_clients_last_seen", "last_seen_at"),
    )


class PluginHeartbeat(Base):
    __tablename__ = "plugin_heartbeats"

    event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    client_id: Mapped[str] = mapped_column(String(128), nullable=False)
    plugin_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    plugin_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    tool: Mapped[str] = mapped_column(String(32), nullable=False)
    username: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    user_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    user_email: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    user_display_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    team: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    machine_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    host_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_plugin_heartbeats_recent", "occurred_at"),
        Index("ix_plugin_heartbeats_client_time", "client_id", "occurred_at"),
        Index("ix_plugin_heartbeats_user_time", "user_id", "occurred_at"),
        Index("ix_plugin_heartbeats_team_time", "team", "occurred_at"),
        Index("ix_plugin_heartbeats_plugin_time", "plugin_name", "plugin_version", "occurred_at"),
    )


class RawIngestEvent(Base):
    __tablename__ = "raw_ingest_events"

    event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    client_id: Mapped[str] = mapped_column(String(128), nullable=False)
    plugin_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    plugin_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    tool: Mapped[str] = mapped_column(String(32), nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    session_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    task_id: Mapped[str] = mapped_column(String(64), nullable=False)
    source_confidence: Mapped[str] = mapped_column(String(24), nullable=False)
    username: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    user_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    user_email: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    user_display_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    team: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    machine_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    host_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    raw_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_raw_ingest_session_time", "session_id", "occurred_at"),
        Index("ix_raw_ingest_type_time", "event_type", "occurred_at"),
        Index("ix_raw_ingest_client_time", "client_id", "occurred_at"),
        Index("ix_raw_ingest_user_time", "user_id", "occurred_at"),
        Index("ix_raw_ingest_team_time", "team", "occurred_at"),
        Index("ix_raw_ingest_machine_time", "machine_id", "occurred_at"),
        Index("ix_raw_ingest_plugin_version_time", "plugin_name", "plugin_version", "occurred_at"),
        Index("ix_raw_ingest_created_at", "created_at"),
        Index("ix_raw_ingest_created_event", "created_at", "event_id"),
    )


class RawEventBlob(Base):
    __tablename__ = "raw_event_blobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    raw_event_id: Mapped[str] = mapped_column(String(64), ForeignKey("raw_ingest_events.event_id", ondelete="CASCADE"), nullable=False)
    blob_key: Mapped[str] = mapped_column(String(512), nullable=False)
    part_index: Mapped[int] = mapped_column(Integer, nullable=False)
    part_count: Mapped[int] = mapped_column(Integer, nullable=False)
    encoding: Mapped[str] = mapped_column(String(64), nullable=False, default="gzip+base64")
    value_type: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    sha256: Mapped[str] = mapped_column(String(128), nullable=False)
    original_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    compressed_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    content_base64: Mapped[str] = mapped_column(LONGTEXT, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("raw_event_id", "blob_key", "part_index", name="uq_raw_blob_event_key_part"),
        Index("ix_raw_event_blobs_event", "raw_event_id"),
    )


class IngestJob(Base):
    __tablename__ = "ingest_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    raw_event_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("raw_ingest_events.event_id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    next_run_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    locked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    locked_by: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("ix_ingest_jobs_status_next_run", "status", "next_run_at"),
        Index("ix_ingest_jobs_raw_event", "raw_event_id"),
        Index("ix_ingest_jobs_locked", "status", "locked_at"),
    )


class NormalizedIngestEvent(Base):
    __tablename__ = "normalized_ingest_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    raw_event_id: Mapped[str] = mapped_column(String(64), nullable=False)
    tool: Mapped[str] = mapped_column(String(32), nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    session_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    task_id: Mapped[str] = mapped_column(String(64), nullable=False)
    parser_name: Mapped[str] = mapped_column(String(64), nullable=False)
    parser_version: Mapped[str] = mapped_column(String(32), nullable=False)
    parse_status: Mapped[str] = mapped_column(String(24), nullable=False, default="success")
    normalized_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    warnings: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("raw_event_id", "parser_version", name="uq_normalized_raw_parser"),
        Index("ix_normalized_session", "session_id"),
        Index("ix_normalized_status", "parse_status"),
    )


class AiSession(Base):
    __tablename__ = "ai_sessions"

    session_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    external_session_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    task_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    client_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    plugin_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    plugin_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    tool: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="active")
    title: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    username: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    user_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    user_email: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    user_display_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    team: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    machine_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    host_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    model: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_activity_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("ix_ai_sessions_tool_external_user", "tool", "external_session_id", "user_id"),
        Index("ix_ai_sessions_user", "username"),
        Index("ix_ai_sessions_activity", "last_activity_at"),
        Index("ix_ai_sessions_recent", "last_activity_at", "created_at"),
        Index("ix_ai_sessions_user_activity", "user_id", "last_activity_at"),
        Index("ix_ai_sessions_team_activity", "team", "last_activity_at"),
        Index("ix_ai_sessions_machine_activity", "machine_id", "last_activity_at"),
        Index("ix_ai_sessions_client_activity", "client_id", "last_activity_at"),
        Index("ix_ai_sessions_tool_activity", "tool", "last_activity_at"),
    )


class AiTurn(Base):
    __tablename__ = "ai_turns"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(128), ForeignKey("ai_sessions.session_id", ondelete="CASCADE"), nullable=False)
    task_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False)
    request_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    response_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="in_progress")
    user_message_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    assistant_message_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    __table_args__ = (
        UniqueConstraint("session_id", "request_id", "response_id", name="uq_ai_turns_session_request_response"),
        Index("ix_ai_turns_session_index", "session_id", "turn_index"),
        Index("ix_ai_turns_session_created", "session_id", "created_at"),
        Index("ix_ai_turns_request", "session_id", "request_id"),
    )


class AiMessage(Base):
    __tablename__ = "ai_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(128), ForeignKey("ai_sessions.session_id", ondelete="CASCADE"), nullable=False)
    task_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    turn_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("ai_turns.id", ondelete="SET NULL"), nullable=True)
    message_index: Mapped[int] = mapped_column(Integer, nullable=False)
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[Optional[str]] = mapped_column(LONGTEXT, nullable=True)
    text_len: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    text_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    raw_event_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    raw_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    source_key: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("session_id", "message_index", name="uq_ai_messages_session_index"),
        UniqueConstraint("session_id", "source_key", name="uq_ai_messages_session_source_key"),
        Index("ix_ai_messages_session_turn", "session_id", "turn_index", "message_index"),
        Index("ix_ai_messages_role", "role"),
        Index("ix_ai_messages_raw_event", "raw_event_id"),
        Index("ix_ai_messages_source_key", "session_id", "source_key"),
    )


class AiRequestUsage(Base):
    __tablename__ = "ai_request_usage"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(128), ForeignKey("ai_sessions.session_id", ondelete="CASCADE"), nullable=False)
    task_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    turn_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("ai_turns.id", ondelete="SET NULL"), nullable=True)
    turn_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    request_id: Mapped[str] = mapped_column(String(256), nullable=False)
    request_index: Mapped[int] = mapped_column(Integer, nullable=False)
    model: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    prompt_tokens: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    output_tokens: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    completion_tokens: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    elapsed_ms: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    copilot_credits: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    credits_source: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    occurred_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    raw_event_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    raw_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("session_id", "request_id", name="uq_ai_request_usage_session_request"),
        Index("ix_ai_request_usage_session_index", "session_id", "request_index"),
        Index("ix_ai_request_usage_turn", "turn_id"),
        Index("ix_ai_request_usage_model", "model"),
    )


class AiProcessStep(Base):
    __tablename__ = "ai_process_steps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(128), ForeignKey("ai_sessions.session_id", ondelete="CASCADE"), nullable=False)
    task_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    turn_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("ai_turns.id", ondelete="SET NULL"), nullable=True)
    turn_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    request_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    response_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    step_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    step_index: Mapped[int] = mapped_column(Integer, nullable=False)
    step_type: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    content: Mapped[Optional[str]] = mapped_column(LONGTEXT, nullable=True)
    content_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    tool_name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    tool_call_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    actor_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    actor_type: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    parent_tool_call_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    raw_event_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    raw_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    status: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("session_id", "request_id", "step_id", name="uq_ai_steps_session_request_step"),
        Index("ix_ai_steps_session_turn", "session_id", "turn_index", "step_index"),
        Index("ix_ai_steps_request", "session_id", "request_id"),
        Index("ix_ai_steps_type", "step_type"),
    )


class AiCodeChange(Base):
    __tablename__ = "ai_code_changes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(128), nullable=False)
    task_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    turn_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    turn_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    request_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    response_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    event_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    file_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    change_type: Mapped[str] = mapped_column(String(64), nullable=False, default="code_change")
    snapshot_kind: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    diff_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    lines_added: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lines_deleted: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_effective: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    superseded_by_event_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    diff_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_ai_code_changes_session", "session_id"),
        Index("ix_ai_code_changes_event", "event_id"),
        Index("ix_ai_code_changes_request", "session_id", "request_id"),
        Index("ix_ai_code_changes_effective", "session_id", "is_effective"),
        Index("ix_ai_code_changes_effective_time", "is_effective", "occurred_at", "id"),
        Index("ix_ai_code_changes_type_effective_time", "change_type", "is_effective", "occurred_at", "id"),
    )


class AiLineAttribution(Base):
    __tablename__ = "ai_line_attributions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_path_hash: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    client_id: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    username: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    user_id: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    machine_id: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    host_hash: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    session_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    request_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    response_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    line_no: Mapped[int] = mapped_column(Integer, nullable=False)
    text_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    text_preview: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    origin_author: Mapped[str] = mapped_column(String(32), nullable=False, default="unknown")
    last_editor: Mapped[str] = mapped_column(String(32), nullable=False, default="unknown")
    classification: Mapped[str] = mapped_column(String(64), nullable=False, default="unknown")
    origin_event_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    last_event_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    source_snapshot_kind: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index(
            "ix_ai_line_attr_scope_file_line",
            "workspace_path_hash",
            "machine_id",
            "user_id",
            "file_path",
            "line_no",
            mysql_length={"file_path": 191},
        ),
        Index(
            "ix_ai_line_attr_scope_file_hash",
            "workspace_path_hash",
            "machine_id",
            "user_id",
            "file_path",
            "text_hash",
            mysql_length={"file_path": 191},
        ),
        Index("ix_ai_line_attr_event", "last_event_id"),
        Index("ix_ai_line_attr_classification", "classification"),
    )


class LineAttributionJob(Base):
    __tablename__ = "line_attribution_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code_change_id: Mapped[int] = mapped_column(Integer, ForeignKey("ai_code_changes.id", ondelete="CASCADE"), nullable=False, unique=True)
    event_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    session_id: Mapped[str] = mapped_column(String(128), nullable=False)
    task_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    snapshot_kind: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    file_path: Mapped[Optional[str]] = mapped_column(String(1024), nullable=True)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    locked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    locked_by: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    next_run_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("ix_line_attr_jobs_status_next", "status", "next_run_at"),
        Index("ix_line_attr_jobs_session", "session_id"),
        Index("ix_line_attr_jobs_event", "event_id"),
    )


class AiSpecAccess(Base):
    __tablename__ = "ai_spec_accesses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(128), nullable=False)
    task_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    turn_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    turn_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    event_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    spec_scope: Mapped[str] = mapped_column(String(32), nullable=False, default="unknown")
    doc_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    access_type: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    access_source: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    matched_doc_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    matched_docs: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    via_catalog: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    matched_by: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    confidence: Mapped[str] = mapped_column(String(24), nullable=False, default="derived")
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_ai_spec_accesses_session", "session_id"),
        Index("ix_ai_spec_accesses_event", "event_id"),
    )


class AiSpecDocument(Base):
    __tablename__ = "ai_spec_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_path_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    client_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    username: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    user_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    machine_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    host_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    spec_scope: Mapped[str] = mapped_column(String(32), nullable=False, default="project")
    doc_path: Mapped[str] = mapped_column(String(512), nullable=False)
    file_name: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    line_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    content_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    mtime_ms: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    exists: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    metadata_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    source_event_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("workspace_path_hash", "doc_path", name="uq_ai_spec_documents_workspace_doc"),
        Index("ix_ai_spec_documents_workspace", "workspace_path_hash"),
        Index("ix_ai_spec_documents_user", "user_id"),
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
