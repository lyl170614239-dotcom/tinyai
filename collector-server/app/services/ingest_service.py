from __future__ import annotations

from collections import Counter
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import AgentEvent, CodeChangeSnapshot, PluginClient, SpecAccessEvent, TaskSession
from ..schemas.events import BatchIn, EventIn
from .redaction_service import redact_payload


SPEC_EVENT_TYPES = {"spec_read", "catalog_hit", "fallback_search", "official_misread"}
CODE_EVENT_TYPES = {"code_change", "adoption_snapshot", "commit_snapshot", "push_snapshot"}


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _upsert_plugin(db: Session, batch: BatchIn) -> None:
    first_tool = batch.events[0].tool
    client = db.execute(select(PluginClient).where(PluginClient.client_id == batch.client_id)).scalar_one_or_none()
    if client:
        client.tool = first_tool
        client.plugin_name = batch.plugin_name
        client.plugin_version = batch.plugin_version
        client.last_seen_at = datetime.utcnow()
    else:
        db.add(
            PluginClient(
                client_id=batch.client_id,
                tool=first_tool,
                plugin_name=batch.plugin_name,
                plugin_version=batch.plugin_version,
            )
        )


def _upsert_task(db: Session, event: EventIn) -> None:
    task = db.get(TaskSession, event.task_id)
    occurred = _naive(event.occurred_at)
    payload = event.payload or {}
    if not task:
        task = TaskSession(
            task_id=event.task_id,
            session_id=event.session_id,
            tool=event.tool,
            workspace_path_hash=event.workspace_path_hash,
            source_confidence=event.source_confidence,
        )
        db.add(task)
    if event.event_type == "task_start":
        task.started_at = occurred
    elif event.event_type == "task_end":
        task.ended_at = occurred
        task.result = str(payload.get("result") or payload.get("status") or "unknown")[:64]
    if not task.started_at:
        task.started_at = occurred
    task.session_id = task.session_id or event.session_id
    task.workspace_path_hash = task.workspace_path_hash or event.workspace_path_hash


def _insert_spec_access(db: Session, event: EventIn) -> None:
    payload = event.payload or {}
    db.add(
        SpecAccessEvent(
            event_id=event.event_id,
            task_id=event.task_id,
            tool=event.tool,
            spec_scope=str(payload.get("spec_scope") or "unknown")[:32],
            doc_path=str(payload.get("doc_path")) if payload.get("doc_path") else None,
            via_catalog=bool(payload.get("via_catalog")),
            matched_by=payload.get("matched_by") if isinstance(payload.get("matched_by"), list) else None,
            fallback_used=bool(payload.get("fallback_used")),
            confidence=event.source_confidence,
            occurred_at=_naive(event.occurred_at),
        )
    )


def _insert_code_snapshot(db: Session, event: EventIn) -> None:
    payload = event.payload or {}
    db.add(
        CodeChangeSnapshot(
            event_id=event.event_id,
            task_id=event.task_id,
            tool=event.tool,
            files_changed=int(payload.get("files_changed") or 0),
            lines_added=int(payload.get("lines_added") or 0),
            lines_deleted=int(payload.get("lines_deleted") or 0),
            retained_lines=payload.get("retained_lines") if isinstance(payload.get("retained_lines"), int) else None,
            adoption_rate=float(payload["adoption_rate"]) if isinstance(payload.get("adoption_rate"), (int, float)) else None,
            snapshot_kind=str(payload.get("snapshot_kind") or event.event_type)[:32],
            occurred_at=_naive(event.occurred_at),
        )
    )


def ingest_batch(db: Session, batch: BatchIn) -> dict:
    _upsert_plugin(db, batch)
    accepted = 0
    duplicates = 0
    task_ids: set[str] = set()

    for event in batch.events:
        task_ids.add(event.task_id)
        if db.get(AgentEvent, event.event_id):
            duplicates += 1
            continue
        _upsert_task(db, event)
        agent_event = AgentEvent(
            event_id=event.event_id,
            task_id=event.task_id,
            session_id=event.session_id,
            tool=event.tool,
            event_type=event.event_type,
            occurred_at=_naive(event.occurred_at),
            workspace_path_hash=event.workspace_path_hash,
            source_confidence=event.source_confidence,
            payload=redact_payload(
                event.payload,
                allow_full_conversation_text=event.event_type == "conversation_snapshot" and event.payload.get("include_text") is True,
            ),
        )
        db.add(agent_event)
        db.flush()
        if event.event_type in SPEC_EVENT_TYPES:
            _insert_spec_access(db, event)
        if event.event_type in CODE_EVENT_TYPES:
            _insert_code_snapshot(db, event)
        accepted += 1

    db.commit()
    return {"accepted": accepted, "duplicates": duplicates, "task_count": len(task_ids)}


def recent_tasks(db: Session, limit: int = 50) -> list[dict]:
    rows = db.execute(
        select(TaskSession, func.count(AgentEvent.event_id).label("event_count"))
        .outerjoin(AgentEvent, AgentEvent.task_id == TaskSession.task_id)
        .group_by(TaskSession.task_id)
        .order_by(TaskSession.updated_at.desc())
        .limit(limit)
    ).all()
    return [
        {
            "task_id": task.task_id,
            "session_id": task.session_id,
            "tool": task.tool,
            "workspace_path_hash": task.workspace_path_hash,
            "started_at": task.started_at,
            "ended_at": task.ended_at,
            "result": task.result,
            "event_count": event_count,
        }
        for task, event_count in rows
    ]


def overview_counts(db: Session) -> dict[str, int]:
    rows = db.execute(select(AgentEvent.event_type, func.count()).group_by(AgentEvent.event_type)).all()
    return dict(Counter({event_type: count for event_type, count in rows}))
