from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
import base64
import gzip
import hashlib
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import (
    AiCodeChange,
    AiLineAttribution,
    AiMessage,
    AiProcessStep,
    AiRequestUsage,
    AiSession,
    AiSpecAccess,
    AiTurn,
    IngestJob,
    NormalizedIngestEvent,
    PluginClient,
    PluginHeartbeat,
    RawEventBlob,
    RawIngestEvent,
)
from ..schemas.events import BatchIn, BatchOut, PluginClientOut
from ..services.ingest_service import (
    ingest_batch,
    list_usernames,
    overview_counts,
)

router = APIRouter(prefix="/api/v1", tags=["ingest"])
_HIDDEN_RELATED_TURN = object()

BEIJING_TZ = timezone(timedelta(hours=8))


def _beijing_iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=BEIJING_TZ)
    else:
        value = value.astimezone(BEIJING_TZ)
    return value.isoformat()


def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    token = get_settings().api_token.strip()
    if not token:
        return
    expected = f"Bearer {token}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="invalid collector token")


@router.post("/events/batch", response_model=BatchOut, dependencies=[Depends(require_token)])
def create_events(batch: BatchIn, db: Session = Depends(get_db)) -> dict:
    return ingest_batch(db, batch)


@router.get("/plugins", response_model=list[PluginClientOut])
def list_plugins(db: Session = Depends(get_db)) -> list[PluginClient]:
    return db.execute(select(PluginClient).order_by(PluginClient.last_seen_at.desc()).limit(100)).scalars().all()


@router.get("/plugin-heartbeats", dependencies=[Depends(require_token)])
def list_plugin_heartbeats(
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
) -> list[dict]:
    rows = db.execute(select(PluginHeartbeat).order_by(PluginHeartbeat.occurred_at.desc()).limit(limit)).scalars().all()
    return [
        {
            "event_id": row.event_id,
            "client_id": row.client_id,
            "plugin_name": row.plugin_name,
            "plugin_version": row.plugin_version,
            "tool": row.tool,
            "username": row.username,
            "user_id": row.user_id,
            "user_email": row.user_email,
            "user_display_name": row.user_display_name,
            "team": row.team,
            "machine_id": row.machine_id,
            "host_hash": row.host_hash,
            "payload": row.payload,
            "occurred_at": _beijing_iso(row.occurred_at),
            "created_at": _beijing_iso(row.created_at),
        }
        for row in rows
    ]


def _latest_datetime(*values: datetime | None) -> datetime | None:
    latest: datetime | None = None
    for value in values:
        if value is None:
            continue
        if latest is None or value > latest:
            latest = value
    return latest


def _tool_rows(rows: list[tuple]) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for row in rows:
        tool = str(row[0] or "unknown")
        result[tool] = {
            "count": int(row[1] or 0),
            "latest_at": _beijing_iso(row[2]) if row[2] else None,
            "_latest_raw": row[2],
        }
    return result


def _version_list(versions: object) -> list[str]:
    return [version for version in str(versions or "").split(",") if version]


def _plugin_source_buckets(rows: list[tuple], *, heartbeat: bool = False) -> dict[str, dict[str, dict]]:
    result: dict[str, dict[str, dict]] = {}
    for row in rows:
        tool = str(row[0] or "unknown")
        plugin_name = str(row[1] or "unknown")
        source = result.setdefault(tool, {}).setdefault(
            plugin_name,
            {
                "plugin_name": plugin_name,
                "registered_clients": 0,
                "active_clients": 0,
                "heartbeat_count": 0,
                "versions": [],
                "latest_at": None,
                "_latest_raw": None,
            },
        )
        if heartbeat:
            _, _, count, latest_at, versions = row
            source["heartbeat_count"] = int(count or 0)
        else:
            _, _, count, active_count, latest_at, versions = row
            source["registered_clients"] = int(count or 0)
            source["active_clients"] = int(active_count or 0)
        source["versions"] = sorted(set(source["versions"] + _version_list(versions)))
        source["_latest_raw"] = _latest_datetime(source["_latest_raw"], latest_at)
        source["latest_at"] = _beijing_iso(source["_latest_raw"]) if source["_latest_raw"] else None
    return result


def _check_status(active_clients: int, sessions: int, count: int, required_when_session: bool = False) -> str:
    if count > 0:
        return "ok"
    if active_clients > 0 and (required_when_session and sessions > 0):
        return "warn"
    if active_clients > 0:
        return "idle"
    return "missing"


@router.get("/runtime/status")
def runtime_status(db: Session = Depends(get_db)) -> dict:
    now = datetime.now(BEIJING_TZ).replace(tzinfo=None)
    active_since = now - timedelta(minutes=30)

    client_rows = db.execute(
        select(
            PluginClient.tool,
            func.count(PluginClient.client_id),
            func.sum(case((PluginClient.last_seen_at >= active_since, 1), else_=0)),
            func.max(PluginClient.last_seen_at),
            func.group_concat(func.distinct(PluginClient.plugin_version)),
        )
        .group_by(PluginClient.tool)
    ).all()
    client_source_rows = db.execute(
        select(
            PluginClient.tool,
            PluginClient.plugin_name,
            func.count(PluginClient.client_id),
            func.sum(case((PluginClient.last_seen_at >= active_since, 1), else_=0)),
            func.max(PluginClient.last_seen_at),
            func.group_concat(func.distinct(PluginClient.plugin_version)),
        )
        .group_by(PluginClient.tool, PluginClient.plugin_name)
    ).all()
    heartbeat_rows = db.execute(
        select(
            PluginHeartbeat.tool,
            func.count(PluginHeartbeat.event_id),
            func.max(PluginHeartbeat.occurred_at),
            func.group_concat(func.distinct(PluginHeartbeat.plugin_version)),
        )
        .group_by(PluginHeartbeat.tool)
    ).all()
    heartbeat_source_rows = db.execute(
        select(
            PluginHeartbeat.tool,
            PluginHeartbeat.plugin_name,
            func.count(PluginHeartbeat.event_id),
            func.max(PluginHeartbeat.occurred_at),
            func.group_concat(func.distinct(PluginHeartbeat.plugin_version)),
        )
        .group_by(PluginHeartbeat.tool, PluginHeartbeat.plugin_name)
    ).all()
    session_rows = _tool_rows(db.execute(
        select(AiSession.tool, func.count(AiSession.session_id), func.max(AiSession.last_activity_at))
        .group_by(AiSession.tool)
    ).all())
    turn_rows = _tool_rows(db.execute(
        select(AiSession.tool, func.count(AiTurn.id), func.max(AiTurn.completed_at))
        .join(AiSession, AiTurn.session_id == AiSession.session_id)
        .group_by(AiSession.tool)
    ).all())
    tool_step_rows = _tool_rows(db.execute(
        select(AiSession.tool, func.count(AiProcessStep.id), func.max(AiProcessStep.occurred_at))
        .join(AiSession, AiProcessStep.session_id == AiSession.session_id)
        .where(
            or_(
                AiProcessStep.tool_name.is_not(None),
                AiProcessStep.tool_call_id.is_not(None),
                AiProcessStep.step_type.like("%tool%"),
            )
        )
        .group_by(AiSession.tool)
    ).all())
    code_rows = _tool_rows(db.execute(
        select(AiSession.tool, func.count(AiCodeChange.id), func.max(AiCodeChange.occurred_at))
        .join(AiSession, AiCodeChange.session_id == AiSession.session_id)
        .where(AiCodeChange.is_effective.is_(True))
        .group_by(AiSession.tool)
    ).all())
    spec_rows = _tool_rows(db.execute(
        select(AiSession.tool, func.count(AiSpecAccess.id), func.max(AiSpecAccess.occurred_at))
        .join(AiSession, AiSpecAccess.session_id == AiSession.session_id)
        .group_by(AiSession.tool)
    ).all())

    clients_by_tool: dict[str, dict] = {}
    for tool, count, active_count, latest_at, versions in client_rows:
        clients_by_tool[str(tool or "unknown")] = {
            "registered_clients": int(count or 0),
            "active_clients": int(active_count or 0),
            "latest_at": _beijing_iso(latest_at) if latest_at else None,
            "_latest_raw": latest_at,
            "versions": _version_list(versions),
        }

    heartbeats_by_tool: dict[str, dict] = {}
    for tool, count, latest_at, versions in heartbeat_rows:
        heartbeats_by_tool[str(tool or "unknown")] = {
            "heartbeat_count": int(count or 0),
            "latest_at": _beijing_iso(latest_at) if latest_at else None,
            "_latest_raw": latest_at,
            "versions": _version_list(versions),
        }
    plugin_sources_by_tool = _plugin_source_buckets(client_source_rows)
    heartbeat_sources_by_tool = _plugin_source_buckets(heartbeat_source_rows, heartbeat=True)
    for tool, source_map in heartbeat_sources_by_tool.items():
        target_map = plugin_sources_by_tool.setdefault(tool, {})
        for plugin_name, heartbeat_source in source_map.items():
            target = target_map.setdefault(plugin_name, heartbeat_source)
            if target is heartbeat_source:
                continue
            target["heartbeat_count"] = heartbeat_source["heartbeat_count"]
            target["versions"] = sorted(set(target["versions"] + heartbeat_source["versions"]))
            target["_latest_raw"] = _latest_datetime(target["_latest_raw"], heartbeat_source["_latest_raw"])
            target["latest_at"] = _beijing_iso(target["_latest_raw"]) if target["_latest_raw"] else None

    preferred_tools = ["copilot", "claude", "codex"]
    observed_tools = sorted(
        set(preferred_tools)
        | set(clients_by_tool)
        | set(heartbeats_by_tool)
        | set(session_rows)
        | set(turn_rows)
        | set(tool_step_rows)
        | set(code_rows)
        | set(spec_rows)
    )

    tools: list[dict] = []
    for tool in observed_tools:
        client = clients_by_tool.get(tool, {"registered_clients": 0, "active_clients": 0, "latest_at": None, "_latest_raw": None, "versions": []})
        heartbeat = heartbeats_by_tool.get(tool, {"heartbeat_count": 0, "latest_at": None, "_latest_raw": None, "versions": []})
        sessions = session_rows.get(tool, {"count": 0, "latest_at": None, "_latest_raw": None})
        turns = turn_rows.get(tool, {"count": 0, "latest_at": None, "_latest_raw": None})
        tool_steps = tool_step_rows.get(tool, {"count": 0, "latest_at": None, "_latest_raw": None})
        code = code_rows.get(tool, {"count": 0, "latest_at": None, "_latest_raw": None})
        specs = spec_rows.get(tool, {"count": 0, "latest_at": None, "_latest_raw": None})
        active_clients = int(client["active_clients"])
        session_count = int(sessions["count"])

        heartbeat_status = "ok" if heartbeat["latest_at"] and (heartbeat["_latest_raw"] >= active_since) else ("idle" if heartbeat["latest_at"] else "missing")
        session_status = _check_status(active_clients, session_count, session_count, required_when_session=True)
        tool_step_status = _check_status(active_clients, session_count, int(tool_steps["count"]), required_when_session=True)
        code_status = _check_status(active_clients, session_count, int(code["count"]))
        spec_status = _check_status(active_clients, session_count, int(specs["count"]))
        latest_raw = _latest_datetime(
            client.get("_latest_raw"),
            heartbeat.get("_latest_raw"),
            sessions.get("_latest_raw"),
            turns.get("_latest_raw"),
            tool_steps.get("_latest_raw"),
            code.get("_latest_raw"),
            specs.get("_latest_raw"),
        )
        check_statuses = [heartbeat_status, session_status, tool_step_status]
        has_any_signal = any([
            int(client["registered_clients"]),
            int(heartbeat["heartbeat_count"]),
            session_count,
            int(turns["count"]),
            int(tool_steps["count"]),
            int(code["count"]),
            int(specs["count"]),
        ])
        if not has_any_signal:
            overall = "missing"
        elif all(status == "ok" for status in check_statuses):
            overall = "ok"
        elif active_clients == 0:
            overall = "idle"
        else:
            overall = "warn"
        tools.append({
            "tool": tool,
            "status": overall,
            "latest_activity_at": _beijing_iso(latest_raw) if latest_raw else None,
            "versions": sorted(set(client["versions"] + heartbeat["versions"])),
            "plugin_sources": sorted(
                [
                    {key: value for key, value in source.items() if key != "_latest_raw"}
                    for source in plugin_sources_by_tool.get(tool, {}).values()
                ],
                key=lambda source: str(source.get("latest_at") or ""),
                reverse=True,
            ),
            "registered_clients": int(client["registered_clients"]),
            "active_clients": active_clients,
            "heartbeat_count": int(heartbeat["heartbeat_count"]),
            "session_count": session_count,
            "turn_count": int(turns["count"]),
            "tool_step_count": int(tool_steps["count"]),
            "code_change_count": int(code["count"]),
            "spec_access_count": int(specs["count"]),
            "checks": [
                {
                    "key": "heartbeat",
                    "label": "插件心跳",
                    "status": heartbeat_status,
                    "count": int(heartbeat["heartbeat_count"]),
                    "latest_at": heartbeat["latest_at"],
                    "note": "证明采集插件在线，不等于业务日志已经采到",
                },
                {
                    "key": "sessions",
                    "label": "会话日志",
                    "status": session_status,
                    "count": session_count,
                    "latest_at": sessions["latest_at"],
                    "note": "用户提问和 AI 回答的主链路",
                },
                {
                    "key": "tool_steps",
                    "label": "工具调用",
                    "status": tool_step_status,
                    "count": int(tool_steps["count"]),
                    "latest_at": tool_steps["latest_at"],
                    "note": "读取文件、运行命令、编辑文件等过程数据",
                },
                {
                    "key": "code_changes",
                    "label": "代码变更",
                    "status": code_status,
                    "count": int(code["count"]),
                    "latest_at": code["latest_at"],
                    "note": "没有写代码的对话可以为 0",
                },
                {
                    "key": "spec_accesses",
                    "label": "知识库访问",
                    "status": spec_status,
                    "count": int(specs["count"]),
                    "latest_at": specs["latest_at"],
                    "note": "没有读取 openspec/specs 的对话可以为 0",
                },
            ],
        })

    tools.sort(key=lambda row: (preferred_tools.index(row["tool"]) if row["tool"] in preferred_tools else 99, row["tool"]))
    return {
        "generated_at": _beijing_iso(now),
        "active_window_minutes": 30,
        "tools": tools,
    }


@router.get("/ingest-jobs", dependencies=[Depends(require_token)])
def list_ingest_jobs(
    status: Optional[str] = Query(default=None, max_length=24),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
) -> dict:
    query = select(IngestJob).order_by(IngestJob.updated_at.desc(), IngestJob.id.desc()).limit(limit)
    if status:
        query = query.where(IngestJob.status == status)
    rows = db.execute(query).scalars().all()
    counts = dict(db.execute(select(IngestJob.status, func.count()).group_by(IngestJob.status)).all())
    return {
        "counts": counts,
        "jobs": [
            {
                "id": row.id,
                "raw_event_id": row.raw_event_id,
                "event_type": row.event_type,
                "status": row.status,
                "attempts": row.attempts,
                "max_attempts": row.max_attempts,
                "next_run_at": _beijing_iso(row.next_run_at),
                "locked_at": _beijing_iso(row.locked_at) if row.locked_at else None,
                "locked_by": row.locked_by,
                "last_error": row.last_error,
                "created_at": _beijing_iso(row.created_at),
                "updated_at": _beijing_iso(row.updated_at),
            }
            for row in rows
        ],
    }


@router.get("/users")
def list_users(db: Session = Depends(get_db)) -> list[str]:
    return list_usernames(db)


def _message_out(message: AiMessage) -> dict:
    return {
        "id": message.id,
        "message_index": message.message_index,
        "turn_index": message.turn_index,
        "role": message.role,
        "content": message.content,
        "text_len": message.text_len,
        "text_hash": message.text_hash,
        "raw_event_id": message.raw_event_id,
        "raw_path": message.raw_path,
        "source_key": message.source_key,
        "occurred_at": _beijing_iso(message.occurred_at),
    }


def _dedupe_session_messages(messages: list[AiMessage]) -> list[AiMessage]:
    """Hide duplicate logical chat messages produced by overlapping snapshot sources.

    Claude/Codex/Copilot adapters may receive both a whole-session snapshot and
    per-turn snapshots. The raw events are intentionally preserved, but the
    product timeline should show one logical user/assistant message per turn.
    """
    seen: set[tuple[int, str, str]] = set()
    deduped: list[AiMessage] = []
    for message in messages:
        content_key = " ".join((message.content or "").split())
        if not content_key:
            content_key = message.text_hash or ""
        key = (message.turn_index, message.role, content_key)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(message)
    return deduped


def _dedupe_session_turns(turns: list[AiTurn]) -> list[AiTurn]:
    """Return one display turn per logical request, preferring the most complete row."""
    open_statuses = {"in_progress", "incomplete", "active", "idle", "streaming"}

    def score(turn: AiTurn) -> tuple[int, int, int, int, int, int, datetime, datetime, int]:
        status = str(turn.status or "").lower()
        return (
            int(status not in open_statuses),
            int(bool(turn.completed_at)),
            int(bool(turn.assistant_message_id)),
            int(bool(turn.user_message_id)),
            int(bool(turn.response_id)),
            int(bool(turn.request_id)),
            turn.completed_at or datetime.min,
            turn.created_at or datetime.min,
            turn.id or 0,
        )

    by_request: dict[str, AiTurn] = {}
    no_request: list[AiTurn] = []
    for turn in turns:
        if not turn.request_id:
            no_request.append(turn)
            continue
        existing = by_request.get(turn.request_id)
        if existing is None or score(turn) > score(existing):
            by_request[turn.request_id] = turn

    by_index: dict[int, AiTurn] = {}
    for turn in [*by_request.values(), *no_request]:
        existing = by_index.get(turn.turn_index)
        if existing is None:
            by_index[turn.turn_index] = turn
            continue
        if score(turn) > score(existing):
            by_index[turn.turn_index] = turn
    return [by_index[index] for index in sorted(by_index)]


def _step_out(step: AiProcessStep) -> dict:
    return {
        "id": step.id,
        "step_id": step.step_id,
        "step_index": step.step_index,
        "turn_index": step.turn_index,
        "request_id": step.request_id,
        "response_id": step.response_id,
        "step_type": step.step_type,
        "title": step.title,
        "content": step.content,
        "tool_call_id": step.tool_call_id,
        "tool_name": step.tool_name,
        "actor_path": step.actor_path,
        "actor_type": step.actor_type,
        "parent_tool_call_id": step.parent_tool_call_id,
        "raw_event_id": step.raw_event_id,
        "raw_path": step.raw_path,
        "status": step.status,
        "occurred_at": _beijing_iso(step.occurred_at),
    }


def _code_change_out(change: AiCodeChange) -> dict:
    return _code_change_out_with_line_attrs(change, [])


def _line_number_for_attr(line: dict, line_type: str) -> int | None:
    raw = line.get("old_line") if line_type == "removed" else line.get("new_line")
    try:
        number = int(raw)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _line_attr_key(event_id: str | None, file_path: str | None, line_no: int | None) -> tuple[str, str, int] | None:
    if not event_id or not file_path or not line_no:
        return None
    return (str(event_id), str(file_path), int(line_no))


def _apply_line_attr_to_line(line: dict, attr: AiLineAttribution) -> None:
    line.setdefault("attribution", "ai" if attr.last_editor == "ai" else "human")
    line.setdefault("origin_author", attr.origin_author)
    line.setdefault("last_editor", attr.last_editor)
    line.setdefault("classification", attr.classification)
    line.setdefault("matched_ai_event_id", attr.origin_event_id or attr.last_event_id)
    line.setdefault("source_snapshot_kind", attr.source_snapshot_kind)


def _annotated_diff_json(change: AiCodeChange, line_attrs: list[AiLineAttribution]) -> dict | None:
    if not isinstance(change.diff_json, dict):
        return change.diff_json
    diff_json = copy.deepcopy(change.diff_json)
    by_line = {
        key: attr
        for attr in line_attrs
        if (key := _line_attr_key(attr.last_event_id, attr.file_path, attr.line_no))
    }
    if not by_line:
        return diff_json

    base_file_path = str(change.file_path or diff_json.get("file_path") or "")
    for hunk in diff_json.get("hunks") if isinstance(diff_json.get("hunks"), list) else []:
        if not isinstance(hunk, dict):
            continue
        hunk_file_path = str(hunk.get("file_path") or base_file_path)
        for line in hunk.get("lines") if isinstance(hunk.get("lines"), list) else []:
            if not isinstance(line, dict):
                continue
            line_type = str(line.get("line_type") or line.get("type") or "")
            key = _line_attr_key(change.event_id, hunk_file_path, _line_number_for_attr(line, line_type))
            attr = by_line.get(key) if key else None
            if attr:
                _apply_line_attr_to_line(line, attr)

    for change_record in diff_json.get("changes") if isinstance(diff_json.get("changes"), list) else []:
        if not isinstance(change_record, dict):
            continue
        record_file_path = str(change_record.get("file_path") or base_file_path)
        for line in change_record.get("added_lines") if isinstance(change_record.get("added_lines"), list) else []:
            if not isinstance(line, dict):
                continue
            key = _line_attr_key(change.event_id, record_file_path, _line_number_for_attr(line, "added"))
            attr = by_line.get(key) if key else None
            if attr:
                _apply_line_attr_to_line(line, attr)
        for key_name in ("removed_lines", "deleted_lines"):
            for line in change_record.get(key_name) if isinstance(change_record.get(key_name), list) else []:
                if not isinstance(line, dict):
                    continue
                key = _line_attr_key(change.event_id, record_file_path, _line_number_for_attr(line, "removed"))
                attr = by_line.get(key) if key else None
                if attr:
                    _apply_line_attr_to_line(line, attr)
    return diff_json


def _code_change_out_with_line_attrs(change: AiCodeChange, line_attrs: list[AiLineAttribution]) -> dict:
    return {
        "id": change.id,
        "session_id": change.session_id,
        "task_id": change.task_id,
        "event_id": change.event_id,
        "turn_index": change.turn_index,
        "request_id": change.request_id,
        "response_id": change.response_id,
        "file_path": change.file_path,
        "change_type": change.change_type,
        "snapshot_kind": change.snapshot_kind,
        "diff_hash": change.diff_hash,
        "lines_added": change.lines_added,
        "lines_deleted": change.lines_deleted,
        "is_effective": change.is_effective,
        "superseded_by_event_id": change.superseded_by_event_id,
        "diff_json": _annotated_diff_json(change, line_attrs),
        "occurred_at": _beijing_iso(change.occurred_at),
    }


def _code_changes_out_with_attrs(db: Session, changes: list[AiCodeChange]) -> list[dict]:
    event_ids = [change.event_id for change in changes if change.event_id]
    line_attrs = (
        db.execute(select(AiLineAttribution).where(AiLineAttribution.last_event_id.in_(event_ids))).scalars().all()
        if event_ids
        else []
    )
    line_attrs_by_event: dict[str, list[AiLineAttribution]] = {}
    for attr in line_attrs:
        if attr.last_event_id:
            line_attrs_by_event.setdefault(attr.last_event_id, []).append(attr)
    return [
        _code_change_out_with_line_attrs(change, line_attrs_by_event.get(change.event_id or "", []))
        for change in changes
    ]


def _spec_access_out(access: AiSpecAccess) -> dict:
    return {
        "id": access.id,
        "turn_index": access.turn_index,
        "spec_scope": access.spec_scope,
        "doc_path": access.doc_path,
        "access_type": access.access_type,
        "access_source": access.access_source,
        "matched_doc_count": access.matched_doc_count,
        "matched_docs": access.matched_docs,
        "via_catalog": access.via_catalog,
        "matched_by": access.matched_by,
        "confidence": access.confidence,
        "occurred_at": _beijing_iso(access.occurred_at),
    }


def _request_usage_out(usage: AiRequestUsage) -> dict:
    return {
        "id": usage.id,
        "turn_index": usage.turn_index,
        "request_id": usage.request_id,
        "request_index": usage.request_index,
        "model": usage.model,
        "prompt_tokens": usage.prompt_tokens,
        "output_tokens": usage.output_tokens,
        "completion_tokens": usage.completion_tokens,
        "elapsed_ms": usage.elapsed_ms,
        "copilot_credits": usage.copilot_credits,
        "credits_source": usage.credits_source,
        "occurred_at": _beijing_iso(usage.occurred_at) if usage.occurred_at else None,
        "raw_event_id": usage.raw_event_id,
        "raw_path": usage.raw_path,
    }


@router.get("/sessions/recent")
def list_recent_sessions(
    limit: int = Query(50, ge=1, le=200),
    username: Optional[str] = Query(default=None, max_length=256),
    db: Session = Depends(get_db),
) -> list[dict]:
    query = select(AiSession).order_by(AiSession.last_activity_at.desc(), AiSession.created_at.desc()).limit(limit)
    if username:
        query = query.where(_identity_filter_for_session(username))
    candidates = [session for session in db.execute(query).scalars().all() if _is_user_chat_session(session)]
    candidate_ids = [session.session_id for session in candidates]
    sessions_with_user_messages = set(
        db.execute(
            select(AiMessage.session_id)
            .where(AiMessage.session_id.in_(candidate_ids))
            .where(AiMessage.role == "user")
            .group_by(AiMessage.session_id)
        ).scalars().all()
    ) if candidate_ids else set()
    sessions = [session for session in candidates if session.session_id in sessions_with_user_messages]
    return [
        {
            "session_id": session.session_id,
            "external_session_id": session.external_session_id,
            "task_id": session.task_id,
            "tool": session.tool,
            "status": session.status,
            "title": session.title,
            "model": session.model,
            "username": session.username,
            "user_id": session.user_id,
            "user_email": session.user_email,
            "user_display_name": session.user_display_name,
            "team": session.team,
            "started_at": _beijing_iso(session.started_at) if session.started_at else None,
            "last_activity_at": _beijing_iso(session.last_activity_at) if session.last_activity_at else None,
        }
        for session in sessions
    ]


def _identity_filter_for_session(identity: str):
    cleaned = identity.strip()
    candidates = {cleaned}
    if "<" in cleaned and cleaned.endswith(">"):
        name, email = cleaned.rsplit("<", 1)
        candidates.add(name.strip())
        candidates.add(email[:-1].strip())
    candidates = {candidate for candidate in candidates if candidate}
    return or_(
        AiSession.username.in_(candidates),
        AiSession.user_id.in_(candidates),
        AiSession.user_email.in_(candidates),
        AiSession.user_display_name.in_(candidates),
    )


def _is_user_chat_session(session: AiSession) -> bool:
    values = [
        session.session_id,
        session.external_session_id,
        session.task_id,
        session.title,
    ]
    if any(str(value or "").startswith("commit-") for value in values):
        return False
    if str(session.task_id or "").startswith("git-commit-"):
        return False
    title = str(session.title or "").lower()
    if "commit" in title and not session.started_at:
        return False
    return True


def _related_session_ids(session: AiSession) -> set[str]:
    ids = {session.session_id}
    for value in (session.external_session_id, session.task_id):
        if value:
            ids.add(value)
    for value in list(ids):
        if value.startswith("copilot-local-"):
            ids.add(value.removeprefix("copilot-local-"))
        else:
            ids.add(f"copilot-local-{value}"[:64])
    return {value for value in ids if value}


def _turn_index_for_time(turns: list[AiTurn], occurred_at: datetime, fallback: int | None) -> int | None:
    if fallback is not None:
        return fallback
    candidate: AiTurn | None = None
    for turn in turns:
        if turn.created_at <= occurred_at and (candidate is None or turn.created_at >= candidate.created_at):
            candidate = turn
    return candidate.turn_index if candidate else None


def _display_turn_index_for_record(turns: list[AiTurn], record: object, occurred_at: datetime | None = None) -> int | None | object:
    turn_id = getattr(record, "turn_id", None)
    if turn_id is not None:
        for turn in turns:
            if turn.id == turn_id:
                return turn.turn_index
        return _HIDDEN_RELATED_TURN

    request_id = getattr(record, "request_id", None)
    response_id = getattr(record, "response_id", None)
    if request_id or response_id:
        for turn in turns:
            if request_id and turn.request_id != request_id:
                continue
            if response_id and turn.response_id != response_id:
                continue
            return turn.turn_index
        return _HIDDEN_RELATED_TURN

    fallback = getattr(record, "turn_index", None)
    if fallback is not None:
        matches = [turn for turn in turns if turn.turn_index == fallback]
        if len(matches) == 1:
            return fallback
        return None

    if occurred_at is not None:
        return _turn_index_for_time(turns, occurred_at, None)
    return None


def _code_change_display_key(change: AiCodeChange) -> tuple[str, str, str, str]:
    diff_json = change.diff_json if isinstance(change.diff_json, dict) else {}
    file_path = str(change.file_path or diff_json.get("file_path") or "").replace("\\", "/")
    marker = "openspec/specs/"
    marker_index = file_path.find(marker)
    if marker_index >= 0:
        file_path = file_path[marker_index:]
    return (
        str(change.request_id or ""),
        str(change.response_id or ""),
        file_path,
        str(change.turn_index or ""),
    )


def _code_change_display_priority(change: AiCodeChange) -> int:
    snapshot_kind = str(change.snapshot_kind or change.change_type or "").lower()
    priorities = {
        "copilot_turn_workspace_diff": 30,
        "copilot_turn_tool_patch": 20,
        "copilot_turn_editor_delta": 10,
        "claude_turn_workspace_diff": 30,
        "claude_turn_bash_delta": 25,
        "claude_turn_tool_patch": 20,
        "claude_turn_editor_delta": 10,
        "codex_turn_workspace_diff": 30,
        "codex_turn_tool_patch": 20,
        "codex_turn_editor_delta": 10,
    }
    return priorities.get(snapshot_kind, 0)


def _is_turn_code_snapshot(change: AiCodeChange) -> bool:
    snapshot_kind = str(change.snapshot_kind or change.change_type or "").lower()
    return snapshot_kind in {
        "copilot_turn_workspace_diff",
        "copilot_turn_tool_patch",
        "copilot_turn_editor_delta",
        "claude_turn_workspace_diff",
        "claude_turn_bash_delta",
        "claude_turn_tool_patch",
        "claude_turn_editor_delta",
        "codex_turn_workspace_diff",
        "codex_turn_tool_patch",
        "codex_turn_editor_delta",
    }


def _is_displayable_code_change(change: AiCodeChange) -> bool:
    if change.file_path:
        return True
    if (change.lines_added or 0) > 0 or (change.lines_deleted or 0) > 0:
        return True
    diff_json = change.diff_json if isinstance(change.diff_json, dict) else {}
    if diff_json.get("file_path"):
        return True
    try:
        files_changed = int(diff_json.get("files_changed") or 0)
    except (TypeError, ValueError):
        files_changed = 0
    if files_changed > 0:
        return True
    return False


def _preferred_code_changes(changes: list[AiCodeChange]) -> list[AiCodeChange]:
    effective_changes = [
        change
        for change in changes
        if getattr(change, "is_effective", True) is not False and _is_displayable_code_change(change)
    ]
    winners: dict[tuple[str, str, str, str], AiCodeChange] = {}
    for change in effective_changes:
        if not _is_turn_code_snapshot(change):
            continue
        key = _code_change_display_key(change)
        current = winners.get(key)
        if current is None:
            winners[key] = change
            continue
        current_rank = (_code_change_display_priority(current), current.occurred_at or datetime.min, current.id or 0)
        candidate_rank = (_code_change_display_priority(change), change.occurred_at or datetime.min, change.id or 0)
        if candidate_rank > current_rank:
            winners[key] = change

    winner_ids = {id(change) for change in winners.values()}
    return [
        change
        for change in effective_changes
        if not _is_turn_code_snapshot(change) or id(change) in winner_ids
    ]


@router.get("/code-changes")
def list_code_changes(
    kind: Optional[str] = Query(default=None, pattern="^(commit|ai_evidence|all)?$"),
    username: Optional[str] = Query(default=None, max_length=256),
    limit: int = Query(200, ge=1, le=1000),
    db: Session = Depends(get_db),
) -> dict:
    query = select(AiCodeChange).order_by(AiCodeChange.occurred_at.desc(), AiCodeChange.id.desc()).limit(limit)
    query = query.where(AiCodeChange.is_effective.is_(True))
    if kind == "commit":
        query = query.where(AiCodeChange.change_type == "commit_snapshot")
    elif kind == "ai_evidence":
        query = query.where(AiCodeChange.snapshot_kind.in_([
            "copilot_turn_workspace_diff",
            "copilot_turn_tool_patch",
            "copilot_turn_editor_delta",
            "claude_turn_workspace_diff",
            "claude_turn_bash_delta",
            "claude_turn_tool_patch",
            "claude_turn_editor_delta",
            "codex_turn_workspace_diff",
            "codex_turn_tool_patch",
            "codex_turn_editor_delta",
        ]))
    if username:
        query = query.join(AiSession, AiSession.session_id == AiCodeChange.session_id)
        query = query.where(_identity_filter_for_session(username))
    changes = db.execute(query).scalars().all()
    return {
        "code_changes": _code_changes_out_with_attrs(db, changes),
        "limit": limit,
        "kind": kind or "all",
        "username_filter": username,
    }


@router.get("/sessions/{session_id}/detail")
def get_session_detail(session_id: str, db: Session = Depends(get_db)) -> dict:
    session = db.get(AiSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")

    related_ids = _related_session_ids(session)
    turns = _dedupe_session_turns(
        db.execute(select(AiTurn).where(AiTurn.session_id == session_id).order_by(AiTurn.turn_index.asc(), AiTurn.id.asc())).scalars().all()
    )
    messages = _dedupe_session_messages(
        db.execute(select(AiMessage).where(AiMessage.session_id == session_id).order_by(AiMessage.message_index.asc())).scalars().all()
    )
    steps = db.execute(
        select(AiProcessStep)
        .where(or_(AiProcessStep.session_id.in_(related_ids), AiProcessStep.task_id.in_(related_ids)))
        .order_by(AiProcessStep.step_index.asc())
    ).scalars().all()
    code_change_ids = db.execute(
        select(AiCodeChange.id)
        .where(or_(AiCodeChange.session_id.in_(related_ids), AiCodeChange.task_id.in_(related_ids)))
        .order_by(AiCodeChange.occurred_at.asc(), AiCodeChange.id.asc())
    ).scalars().all()
    code_changes_by_id = {
        change.id: change
        for change in db.execute(select(AiCodeChange).where(AiCodeChange.id.in_(code_change_ids))).scalars().all()
    } if code_change_ids else {}
    code_changes = [code_changes_by_id[change_id] for change_id in code_change_ids if change_id in code_changes_by_id]
    code_event_ids = [change.event_id for change in code_changes if change.event_id]
    line_attrs = (
        db.execute(select(AiLineAttribution).where(AiLineAttribution.last_event_id.in_(code_event_ids))).scalars().all()
        if code_event_ids
        else []
    )
    line_attrs_by_event: dict[str, list[AiLineAttribution]] = {}
    for attr in line_attrs:
        if attr.last_event_id:
            line_attrs_by_event.setdefault(attr.last_event_id, []).append(attr)
    spec_accesses = db.execute(
        select(AiSpecAccess)
        .where(or_(AiSpecAccess.session_id.in_(related_ids), AiSpecAccess.task_id.in_(related_ids)))
        .order_by(AiSpecAccess.occurred_at.asc())
    ).scalars().all()
    request_usage = db.execute(
        select(AiRequestUsage)
        .where(or_(AiRequestUsage.session_id.in_(related_ids), AiRequestUsage.task_id.in_(related_ids)))
        .order_by(AiRequestUsage.request_index.asc())
    ).scalars().all()

    messages_by_turn: dict[int, list[AiMessage]] = {}
    for message in messages:
        turn_index = _display_turn_index_for_record(turns, message, message.occurred_at)
        if turn_index is not _HIDDEN_RELATED_TURN and turn_index is not None:
            messages_by_turn.setdefault(turn_index, []).append(message)
    steps_by_turn: dict[int | None, list[AiProcessStep]] = {}
    for step in steps:
        turn_index = _display_turn_index_for_record(turns, step, step.occurred_at)
        if turn_index is _HIDDEN_RELATED_TURN:
            continue
        steps_by_turn.setdefault(turn_index, []).append(step)
    code_by_turn: dict[int | None, list[AiCodeChange]] = {}
    for change in code_changes:
        turn_index = _display_turn_index_for_record(turns, change, change.occurred_at)
        if turn_index is _HIDDEN_RELATED_TURN:
            continue
        code_by_turn.setdefault(turn_index, []).append(change)
    code_by_turn = {turn_index: _preferred_code_changes(changes) for turn_index, changes in code_by_turn.items()}
    specs_by_turn: dict[int | None, list[AiSpecAccess]] = {}
    for access in spec_accesses:
        turn_index = _display_turn_index_for_record(turns, access, access.occurred_at)
        if turn_index is _HIDDEN_RELATED_TURN:
            continue
        specs_by_turn.setdefault(turn_index, []).append(access)
    usage_by_turn: dict[int | None, list[AiRequestUsage]] = {}
    for usage in request_usage:
        fallback_turn = usage.request_index + 1
        usage_turn_index = _display_turn_index_for_record(turns, usage, usage.occurred_at)
        if usage_turn_index is _HIDDEN_RELATED_TURN:
            continue
        usage_by_turn.setdefault(usage_turn_index if usage_turn_index is not None else fallback_turn, []).append(usage)

    usage_totals = {
        "prompt_tokens": sum(usage.prompt_tokens or 0 for usage in request_usage),
        "output_tokens": sum(usage.output_tokens or 0 for usage in request_usage),
        "completion_tokens": sum(usage.completion_tokens or 0 for usage in request_usage),
        "elapsed_ms": sum(usage.elapsed_ms or 0 for usage in request_usage),
        "copilot_credits": round(sum(usage.copilot_credits or 0 for usage in request_usage), 3),
    }
    models_used: dict[str, int] = {}
    for usage in request_usage:
        if usage.model:
            models_used[usage.model] = models_used.get(usage.model, 0) + 1

    return {
        "session_id": session.session_id,
        "external_session_id": session.external_session_id,
        "task_id": session.task_id,
        "tool": session.tool,
        "username": session.username,
        "user_id": session.user_id,
        "user_email": session.user_email,
        "user_display_name": session.user_display_name,
        "team": session.team,
        "status": session.status,
        "title": session.title,
        "model": session.model,
        "usage_totals": usage_totals,
        "models_used": models_used,
        "started_at": _beijing_iso(session.started_at) if session.started_at else None,
        "last_activity_at": _beijing_iso(session.last_activity_at) if session.last_activity_at else None,
        "turns": [
            {
                "id": turn.id,
                "turn_index": turn.turn_index,
                "request_id": turn.request_id,
                "response_id": turn.response_id,
                "status": turn.status,
                "created_at": _beijing_iso(turn.created_at),
                "completed_at": _beijing_iso(turn.completed_at) if turn.completed_at else None,
                "user_messages": [_message_out(message) for message in messages_by_turn.get(turn.turn_index, []) if message.role == "user"],
                "assistant_messages": [_message_out(message) for message in messages_by_turn.get(turn.turn_index, []) if message.role == "assistant"],
                "other_messages": [_message_out(message) for message in messages_by_turn.get(turn.turn_index, []) if message.role not in {"user", "assistant"}],
                "process_steps": [_step_out(step) for step in steps_by_turn.get(turn.turn_index, [])],
                "code_changes": [
                    _code_change_out_with_line_attrs(change, line_attrs_by_event.get(change.event_id or "", []))
                    for change in code_by_turn.get(turn.turn_index, [])
                ],
                "spec_accesses": [_spec_access_out(access) for access in specs_by_turn.get(turn.turn_index, [])],
                "request_usage": _request_usage_out(usage_by_turn[turn.turn_index][-1]) if usage_by_turn.get(turn.turn_index) else None,
            }
            for turn in turns
        ],
        "unassigned_process_steps": [_step_out(step) for step in steps_by_turn.get(None, [])],
        "unassigned_code_changes": [
            _code_change_out_with_line_attrs(change, line_attrs_by_event.get(change.event_id or "", []))
            for change in code_by_turn.get(None, [])
        ],
        "unassigned_spec_accesses": [_spec_access_out(access) for access in specs_by_turn.get(None, [])],
        "unassigned_request_usage": [
            _request_usage_out(usage)
            for turn_index, usages in usage_by_turn.items()
            if turn_index is None or turn_index not in {turn.turn_index for turn in turns}
            for usage in usages
        ],
    }


@router.get("/sessions/{session_id}/raw-events")
def get_session_raw_events(session_id: str, db: Session = Depends(get_db)) -> list[dict]:
    rows = db.execute(
        select(RawIngestEvent)
        .where(RawIngestEvent.session_id == session_id)
        .order_by(RawIngestEvent.occurred_at.asc(), RawIngestEvent.created_at.asc())
    ).scalars().all()
    return [
        {
            "event_id": row.event_id,
            "event_type": row.event_type,
            "tool": row.tool,
            "task_id": row.task_id,
            "source_confidence": row.source_confidence,
            "occurred_at": _beijing_iso(row.occurred_at),
            "raw_json": row.raw_json,
        }
        for row in rows
    ]


@router.get("/raw-events/{event_id}/blobs/{blob_key}", dependencies=[Depends(require_token)])
def get_raw_event_blob(event_id: str, blob_key: str, db: Session = Depends(get_db)) -> dict:
    rows = db.execute(
        select(RawEventBlob)
        .where(RawEventBlob.raw_event_id == event_id)
        .where(RawEventBlob.blob_key == blob_key)
        .order_by(RawEventBlob.part_index.asc())
    ).scalars().all()
    if not rows:
        raise HTTPException(status_code=404, detail="blob not found")
    expected_parts = rows[0].part_count
    if len(rows) != expected_parts or [row.part_index for row in rows] != list(range(expected_parts)):
        raise HTTPException(status_code=409, detail="blob chunks are incomplete")
    compressed = base64.b64decode("".join(row.content_base64 for row in rows).encode("ascii"))
    if len(compressed) != rows[0].compressed_bytes:
        raise HTTPException(status_code=409, detail="blob compressed length mismatch")
    if rows[0].encoding != "gzip+base64":
        raise HTTPException(status_code=415, detail="unsupported blob encoding")
    raw = gzip.decompress(compressed)
    digest = hashlib.sha256(raw).hexdigest()
    if digest != rows[0].sha256:
        raise HTTPException(status_code=409, detail="blob sha256 mismatch")
    return {
        "event_id": event_id,
        "blob_key": blob_key,
        "encoding": rows[0].encoding,
        "value_type": rows[0].value_type,
        "sha256": digest,
        "original_bytes": len(raw),
        "compressed_bytes": len(compressed),
        "content": raw.decode("utf-8"),
    }


@router.get("/sessions/{session_id}/normalized-events")
def get_session_normalized_events(session_id: str, db: Session = Depends(get_db)) -> list[dict]:
    rows = db.execute(
        select(NormalizedIngestEvent)
        .where(NormalizedIngestEvent.session_id == session_id)
        .order_by(NormalizedIngestEvent.created_at.asc())
    ).scalars().all()
    return [
        {
            "id": row.id,
            "raw_event_id": row.raw_event_id,
            "event_type": row.event_type,
            "tool": row.tool,
            "parser_name": row.parser_name,
            "parser_version": row.parser_version,
            "parse_status": row.parse_status,
            "warnings": row.warnings,
            "error": row.error,
            "normalized_json": row.normalized_json,
        }
        for row in rows
    ]


@router.get("/overview")
def get_overview(db: Session = Depends(get_db)) -> dict:
    return {"event_counts": overview_counts(db)}
