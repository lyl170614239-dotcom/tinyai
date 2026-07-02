from __future__ import annotations

import base64
from collections import Counter
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
import re
from typing import Any

from dateutil import parser as date_parser
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.orm import Session

from ..identity import clean_identity, normalize_plugin_user_id
from ..models import (
    AiCodeChange,
    AiLineAttribution,
    AiMessage,
    AiProcessStep,
    AiRequestUsage,
    AiSession,
    AiSpecAccess,
    AiSpecDocument,
    AiTurn,
    IngestJob,
    LineAttributionJob,
    NormalizedIngestEvent,
    PluginClient,
    PluginHeartbeat,
    RawEventBlob,
    RawIngestEvent,
)
from ..config import get_settings
from ..schemas.events import BatchIn, EventIn
from .normalization_service import PARSER_VERSION, normalize_event


IDENTITY_FIELDS = ("username", "user_id", "user_display_name", "team", "machine_id", "host_hash")
PLUGIN_CLIENT_IDENTITY_FIELDS = ("username", "user_id", "user_display_name", "team", "machine_id", "host_hash", "model")
BEIJING_TZ = timezone(timedelta(hours=8))
_last_cleanup_at: datetime | None = None
MUTABLE_CODE_SNAPSHOT_KINDS = {
    "code_change",
    "copilot_turn_editor_delta",
    "copilot_turn_workspace_diff",
    "claude_turn_editor_delta",
    "claude_turn_tool_patch",
    "claude_turn_workspace_diff",
    "claude_turn_bash_delta",
    "codex_turn_editor_delta",
    "codex_turn_tool_patch",
    "codex_turn_workspace_diff",
    "codex_mcp_auto_capture",
    "workspace_diff_current",
    "workspace_diff",
    "vscode_text_change",
    "task_end",
    "tool_edit",
}
PROPOSED_ONLY_CODE_SNAPSHOT_KINDS = {
    "copilot_turn_tool_patch",
}
PRODUCT_FULL_LINE_ATTRIBUTION_LIMIT = 5_000
AI_TURN_CODE_SNAPSHOT_KINDS = {
    "copilot_turn_editor_delta",
    "copilot_turn_workspace_diff",
    "claude_turn_tool_patch",
    "claude_turn_editor_delta",
    "claude_turn_workspace_diff",
    "claude_turn_bash_delta",
    "codex_turn_tool_patch",
    "codex_turn_editor_delta",
    "codex_turn_workspace_diff",
    "codex_mcp_auto_capture",
}
AI_TURN_TOOL_PATCH_SNAPSHOT_KINDS = {
    "claude_turn_tool_patch",
    "codex_turn_tool_patch",
}
AI_TURN_EDITOR_DELTA_SNAPSHOT_KINDS = {
    "copilot_turn_editor_delta",
    "claude_turn_editor_delta",
    "codex_turn_editor_delta",
}


def _local_now() -> datetime:
    return datetime.now(BEIJING_TZ).replace(tzinfo=None)


def _cleanup_ingest_history_if_due(db: Session) -> None:
    global _last_cleanup_at
    settings = get_settings()
    now = _local_now()
    if _last_cleanup_at and (now - _last_cleanup_at).total_seconds() < settings.ingest_cleanup_interval_seconds:
        return
    raw_cutoff = now - timedelta(days=max(1, settings.raw_retention_days))
    normalized_cutoff = now - timedelta(days=max(1, settings.normalized_retention_days))
    db.execute(delete(RawIngestEvent).where(RawIngestEvent.created_at < raw_cutoff).where(RawIngestEvent.event_type != "turn_snapshot"))
    db.execute(delete(NormalizedIngestEvent).where(NormalizedIngestEvent.created_at < normalized_cutoff))
    _last_cleanup_at = now


def _naive(dt: datetime) -> datetime:
    if dt.tzinfo:
        return dt.astimezone(BEIJING_TZ).replace(tzinfo=None)
    return dt


def _parse_time(value: Any, fallback: datetime) -> datetime:
    if isinstance(value, datetime):
        return _naive(value)
    if isinstance(value, str) and value:
        try:
            return _naive(date_parser.isoparse(value))
        except (TypeError, ValueError):
            return _naive(fallback)
    return _naive(fallback)


def _clean_identity(value: str | None) -> str | None:
    return clean_identity(value)


def _plugin_client_identity(identity: dict[str, str | None], model: str | None = None) -> dict[str, str | None]:
    username = _clean_identity(identity.get("username")) or _clean_identity(identity.get("user_display_name")) or "unknown"
    user_id = normalize_plugin_user_id(
        username=username,
        user_id=identity.get("user_id"),
        user_display_name=identity.get("user_display_name"),
    )
    return {
        "username": username,
        "user_id": user_id,
        "user_display_name": _clean_identity(identity.get("user_display_name")),
        "team": _clean_identity(identity.get("team")),
        "machine_id": _clean_identity(identity.get("machine_id")),
        "host_hash": _clean_identity(identity.get("host_hash")),
        "model": _clean_identity(model),
    }


def _identity_from_batch(batch: BatchIn) -> dict[str, str | None]:
    first = batch.events[0]
    identity: dict[str, str | None] = {}
    for field in IDENTITY_FIELDS:
        identity[field] = _clean_identity(getattr(batch, field, None)) or _clean_identity(getattr(first, field, None))
    identity["username"] = identity["username"] or "unknown"
    return identity


def _identity_from_event(event: EventIn) -> dict[str, str | None]:
    identity = {field: _clean_identity(getattr(event, field, None)) for field in IDENTITY_FIELDS}
    identity["username"] = identity["username"] or "unknown"
    return identity


def _normalized_product_identity(identity: dict[str, str | None]) -> dict[str, str | None]:
    normalized = dict(identity)
    normalized["username"] = _clean_identity(identity.get("username")) or _clean_identity(identity.get("user_display_name")) or "unknown"
    normalized["user_id"] = normalize_plugin_user_id(
        username=normalized["username"],
        user_id=identity.get("user_id"),
        user_display_name=identity.get("user_display_name"),
    )
    return normalized


def _event_session_id(event: EventIn) -> str | None:
    if event.session_id:
        return event.session_id
    payload = event.payload or {}
    value = payload.get("session_id") or payload.get("sessionId")
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned[:128] if cleaned else None
    return None


def _product_session_id(event: EventIn, payload: dict[str, Any]) -> str:
    return _event_session_id(event) or event.task_id


def _apply_identity(target: Any, identity: dict[str, str | None], fields: tuple[str, ...] = IDENTITY_FIELDS) -> None:
    for field in fields:
        value = identity.get(field)
        if not value:
            continue
        current = _clean_identity(getattr(target, field, None))
        if not current:
            setattr(target, field, value)
    if _clean_identity(identity.get("user_display_name")) and _clean_identity(getattr(target, "username", None)) in {None, "unknown"}:
        setattr(target, "username", identity["user_display_name"])


def _apply_plugin_client_identity(target: PluginClient, identity: dict[str, str | None]) -> None:
    for field in PLUGIN_CLIENT_IDENTITY_FIELDS:
        value = identity.get(field)
        if not value:
            continue
        if field == "username" and value == "unknown" and _clean_identity(getattr(target, "username", None)):
            continue
        setattr(target, field, value)


def _find_plugin_client_by_identity(db: Session, tool: str, plugin_name: str, identity: dict[str, str | None]) -> PluginClient | None:
    user_id = identity.get("user_id")
    if not user_id:
        return None

    base_conditions = [
        PluginClient.tool == tool,
        PluginClient.plugin_name == plugin_name,
        PluginClient.user_id == user_id,
    ]
    machine_id = identity.get("machine_id")
    host_hash = identity.get("host_hash")
    if machine_id:
        device_condition = PluginClient.machine_id == machine_id
        if host_hash:
            device_condition = or_(
                device_condition,
                (PluginClient.machine_id.is_(None) & (PluginClient.host_hash == host_hash)),
            )
        return db.execute(select(PluginClient).where(*base_conditions).where(device_condition)).scalars().first()
    if host_hash:
        return db.execute(select(PluginClient).where(*base_conditions).where(PluginClient.host_hash == host_hash)).scalars().first()
    return None


def _batch_is_plugin_heartbeat_only(batch: BatchIn) -> bool:
    return bool(batch.events) and all(event.event_type == "plugin_heartbeat" for event in batch.events)


def _plugin_client_has_metadata_change(client: PluginClient, tool: str, plugin_name: str, plugin_version: str, identity: dict[str, str | None]) -> bool:
    if client.tool != tool or client.plugin_name != plugin_name or client.plugin_version != plugin_version:
        return True
    for field in PLUGIN_CLIENT_IDENTITY_FIELDS:
        value = identity.get(field)
        if value and _clean_identity(getattr(client, field, None)) != value:
            return True
    return False


def _plugin_client_update_is_throttled(client: PluginClient, now: datetime, identity: dict[str, str | None], tool: str, plugin_name: str, plugin_version: str) -> bool:
    settings = get_settings()
    interval = max(0, settings.plugin_client_heartbeat_update_min_interval_seconds)
    if interval <= 0:
        return False
    if _plugin_client_has_metadata_change(client, tool, plugin_name, plugin_version, identity):
        return False
    last_seen_at = getattr(client, "last_seen_at", None)
    if not last_seen_at:
        return False
    return (now - _naive(last_seen_at)).total_seconds() < interval


def _identity_display(row: Any) -> str | None:
    display_name = _clean_identity(getattr(row, "user_display_name", None))
    return display_name or _clean_identity(getattr(row, "user_id", None)) or _clean_identity(getattr(row, "username", None))


def _identity_filter(model: Any, identity: str):
    cleaned = identity.strip()
    candidates = {cleaned}
    if "<" in cleaned and cleaned.endswith(">"):
        name, email = cleaned.rsplit("<", 1)
        candidates.add(name.strip())
        candidates.add(email[:-1].strip())
    candidates = {candidate for candidate in candidates if candidate}
    return or_(
        model.username.in_(candidates),
        model.user_id.in_(candidates),
        model.user_display_name.in_(candidates),
    )


def _upsert_plugin(db: Session, batch: BatchIn, *, throttle_heartbeat: bool = False) -> None:
    first_tool = batch.events[0].tool
    model = batch.model or batch.events[0].model
    identity = _plugin_client_identity(_identity_from_batch(batch), model)
    client = db.execute(select(PluginClient).where(PluginClient.client_id == batch.client_id)).scalar_one_or_none()
    if not client:
        client = _find_plugin_client_by_identity(db, first_tool, batch.plugin_name, identity)
    if client:
        now = _local_now()
        if throttle_heartbeat and _plugin_client_update_is_throttled(client, now, identity, first_tool, batch.plugin_name, batch.plugin_version):
            return
        client.client_id = batch.client_id
        client.tool = first_tool
        client.plugin_name = batch.plugin_name
        client.plugin_version = batch.plugin_version
        client.last_seen_at = now
        _apply_plugin_client_identity(client, identity)
    else:
        client = PluginClient(
            client_id=batch.client_id,
            tool=first_tool,
            plugin_name=batch.plugin_name,
            plugin_version=batch.plugin_version,
            model=identity.get("model"),
            last_seen_at=_local_now(),
        )
        _apply_plugin_client_identity(client, identity)
        db.add(client)


def _is_install_smoke_batch(batch: BatchIn) -> bool:
    if not batch.events:
        return False
    for event in batch.events:
        payload = event.payload or {}
        if event.event_type != "plugin_heartbeat":
            return False
        if payload.get("smoke_test") is not True:
            return False
        if payload.get("source") != "install-tinyai-observability":
            return False
    return True


def _recent_plugin_heartbeat_exists(db: Session, batch: BatchIn, event: EventIn, payload: dict[str, Any]) -> bool:
    if payload.get("smoke_test") is True:
        return False
    interval = max(0, get_settings().plugin_heartbeat_min_interval_seconds)
    if interval <= 0:
        return False
    event_time = _naive(event.occurred_at)
    cutoff = event_time - timedelta(seconds=interval)
    return db.execute(
        select(PluginHeartbeat.event_id)
        .where(PluginHeartbeat.client_id == batch.client_id)
        .where(PluginHeartbeat.tool == event.tool)
        .where(PluginHeartbeat.plugin_name == batch.plugin_name)
        .where(PluginHeartbeat.plugin_version == batch.plugin_version)
        .where(PluginHeartbeat.occurred_at >= cutoff)
        .where(PluginHeartbeat.occurred_at <= event_time)
        .limit(1)
    ).scalar_one_or_none() is not None


def _insert_plugin_heartbeat(db: Session, batch: BatchIn, event: EventIn, payload: dict[str, Any]) -> tuple[bool, str | None]:
    if db.get(PluginHeartbeat, event.event_id):
        return False, "heartbeat_event_id_exists"
    if _recent_plugin_heartbeat_exists(db, batch, event, payload):
        return False, "heartbeat_rate_limited"
    identity = _normalized_product_identity(_identity_from_event(event))
    values = dict(
        event_id=event.event_id,
        client_id=batch.client_id,
        plugin_name=batch.plugin_name,
        plugin_version=batch.plugin_version,
        tool=event.tool,
        username=identity["username"],
        user_id=identity["user_id"],
        user_display_name=identity["user_display_name"],
        team=identity["team"],
        machine_id=identity["machine_id"],
        host_hash=identity["host_hash"],
        payload=payload,
        occurred_at=_naive(event.occurred_at),
    )
    if db.get_bind().dialect.name == "mysql":
        result = db.execute(mysql_insert(PluginHeartbeat.__table__).prefix_with("IGNORE").values(**values))
        return (True, None) if result.rowcount else (False, "heartbeat_event_id_exists")
    db.add(PluginHeartbeat(**values))
    return True, None


def _raw_event_json(batch: BatchIn, event: EventIn, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "batch": {
            "client_id": batch.client_id,
            "plugin_name": batch.plugin_name,
            "plugin_version": batch.plugin_version,
            "username": batch.username,
            "user_id": batch.user_id,
            "user_display_name": batch.user_display_name,
            "team": batch.team,
            "machine_id": batch.machine_id,
            "host_hash": batch.host_hash,
            "model": batch.model,
        },
        "event": {
            **event.model_dump(mode="json"),
            "payload": payload,
        },
    }


def _insert_raw_ingest_event(db: Session, batch: BatchIn, event: EventIn, payload: dict[str, Any]) -> bool:
    if db.get(RawIngestEvent, event.event_id):
        return False
    identity = _normalized_product_identity(_identity_from_event(event))
    values = dict(
        event_id=event.event_id,
        client_id=batch.client_id,
        plugin_name=batch.plugin_name,
        plugin_version=batch.plugin_version,
        tool=event.tool,
        event_type=event.event_type,
        session_id=_event_session_id(event),
        task_id=event.task_id,
        source_confidence=event.source_confidence,
        username=identity["username"],
        user_id=identity["user_id"],
        user_display_name=identity["user_display_name"],
        team=identity["team"],
        machine_id=identity["machine_id"],
        host_hash=identity["host_hash"],
        raw_json=_raw_event_json(batch, event, payload),
        occurred_at=_naive(event.occurred_at),
    )
    if db.get_bind().dialect.name == "mysql":
        result = db.execute(mysql_insert(RawIngestEvent.__table__).prefix_with("IGNORE").values(**values))
        return bool(result.rowcount)
    db.add(RawIngestEvent(**values))
    return True


def _extract_raw_event_blobs(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    sanitized = dict(payload)
    raw_blobs = sanitized.pop("raw_event_blobs", [])
    blobs = [item for item in raw_blobs if isinstance(item, dict)] if isinstance(raw_blobs, list) else []
    return sanitized, blobs


def _decode_blob_chunks(blob: dict[str, Any]) -> Any:
    chunks = blob.get("chunks")
    if not isinstance(chunks, list) or not chunks:
        raise ValueError("invalid raw_event_blobs payload")
    compressed = base64.b64decode("".join(str(chunk) for chunk in chunks).encode("ascii"))
    if int(blob.get("compressed_bytes") or 0) and len(compressed) != int(blob.get("compressed_bytes") or 0):
        raise ValueError("raw_event_blob compressed length mismatch")
    if str(blob.get("encoding") or "gzip+base64") != "gzip+base64":
        raise ValueError("unsupported raw_event_blob encoding")
    raw = gzip.decompress(compressed)
    expected_sha = str(blob.get("sha256") or "")
    if expected_sha and hashlib.sha256(raw).hexdigest() != expected_sha:
        raise ValueError("raw_event_blob sha256 mismatch")
    text = raw.decode("utf-8")
    return json.loads(text) if str(blob.get("value_type") or "") == "json" else text


def _decode_blob_rows(rows: list[RawEventBlob]) -> dict[str, Any]:
    by_key: dict[str, list[RawEventBlob]] = {}
    for row in rows:
        by_key.setdefault(row.blob_key, []).append(row)
    decoded: dict[str, Any] = {}
    for blob_key, parts in by_key.items():
        ordered = sorted(parts, key=lambda item: item.part_index)
        if [row.part_index for row in ordered] != list(range(ordered[0].part_count)):
            raise ValueError("raw_event_blob chunks are incomplete")
        decoded[blob_key] = _decode_blob_chunks(
            {
                "chunks": [row.content_base64 for row in ordered],
                "encoding": ordered[0].encoding,
                "value_type": ordered[0].value_type,
                "sha256": ordered[0].sha256,
                "compressed_bytes": ordered[0].compressed_bytes,
            }
        )
    return decoded


def _decode_inline_blobs(blobs: list[dict[str, Any]]) -> dict[str, Any]:
    decoded: dict[str, Any] = {}
    for blob in blobs:
        blob_key = str(blob.get("blob_key") or blob.get("blob_ref") or "").strip()
        if not blob_key:
            continue
        decoded[blob_key] = _decode_blob_chunks(blob)
    return decoded


def _rehydrate_blob_refs(value: Any, decoded_blobs: dict[str, Any], key: str | None = None) -> Any:
    if isinstance(value, list):
        return [_rehydrate_blob_refs(item, decoded_blobs) for item in value]
    if not isinstance(value, dict):
        return value
    if key == "text_blob_ref":
        return value
    blob_ref = value.get("blob_ref")
    if isinstance(blob_ref, str) and blob_ref in decoded_blobs:
        return decoded_blobs[blob_ref]
    return {child_key: _rehydrate_blob_refs(child, decoded_blobs, child_key) for child_key, child in value.items()}


def _insert_raw_event_blobs(db: Session, event_id: str, blobs: list[dict[str, Any]]) -> None:
    if not blobs:
        return
    db.execute(delete(RawEventBlob).where(RawEventBlob.raw_event_id == event_id))
    for blob in blobs:
        blob_key = str(blob.get("blob_key") or blob.get("blob_ref") or "").strip()
        chunks = blob.get("chunks")
        if not blob_key or not isinstance(chunks, list) or not chunks:
            raise ValueError("invalid raw_event_blobs payload")
        part_count = len(chunks)
        for index, chunk in enumerate(chunks):
            if not isinstance(chunk, str):
                raise ValueError("invalid raw_event_blobs chunk")
            db.add(
                RawEventBlob(
                    raw_event_id=event_id,
                    blob_key=blob_key[:512],
                    part_index=index,
                    part_count=part_count,
                    encoding=str(blob.get("encoding") or "gzip+base64")[:64],
                    value_type=str(blob.get("value_type") or "")[:32] or None,
                    sha256=str(blob.get("sha256") or "")[:128],
                    original_bytes=int(blob.get("original_bytes") or 0),
                    compressed_bytes=int(blob.get("compressed_bytes") or 0),
                    content_base64=chunk,
                )
            )


def _enqueue_ingest_job(db: Session, event: EventIn) -> None:
    if db.execute(select(IngestJob).where(IngestJob.raw_event_id == event.event_id)).scalar_one_or_none():
        return
    settings = get_settings()
    db.add(
        IngestJob(
            raw_event_id=event.event_id,
            event_type=event.event_type,
            status="pending",
            attempts=0,
            max_attempts=max(1, settings.ingest_job_max_attempts),
            next_run_at=_local_now(),
        )
    )


def _event_payload_from_raw(db: Session, row: RawIngestEvent) -> tuple[EventIn, dict[str, Any]]:
    raw_json = row.raw_json if isinstance(row.raw_json, dict) else {}
    raw_event = raw_json.get("event") if isinstance(raw_json.get("event"), dict) else {}
    payload = raw_event.get("payload") if isinstance(raw_event.get("payload"), dict) else {}
    blob_rows = db.execute(select(RawEventBlob).where(RawEventBlob.raw_event_id == row.event_id)).scalars().all()
    rehydrated_payload = _rehydrate_blob_refs(payload, _decode_blob_rows(blob_rows)) if blob_rows else payload
    event = EventIn(**{**raw_event, "payload": rehydrated_payload})
    return event, rehydrated_payload


def _insert_normalized_event(db: Session, event: EventIn, normalized: dict[str, Any], parse_status: str = "success", error: str | None = None) -> None:
    existing = (
        db.execute(
            select(NormalizedIngestEvent)
            .where(NormalizedIngestEvent.raw_event_id == event.event_id)
            .where(NormalizedIngestEvent.parser_version == PARSER_VERSION)
        )
        .scalar_one_or_none()
    )
    if existing:
        existing.normalized_json = normalized
        existing.parse_status = parse_status
        existing.error = error
        existing.warnings = {"warnings": normalized.get("warnings") or []}
        return

    session = normalized.get("session") if isinstance(normalized.get("session"), dict) else {}
    db.add(
        NormalizedIngestEvent(
            raw_event_id=event.event_id,
            tool=event.tool,
            event_type=event.event_type,
            session_id=str(session.get("session_id") or _event_session_id(event) or "")[:128] or None,
            task_id=event.task_id,
            parser_name=f"{event.tool}_normalizer",
            parser_version=PARSER_VERSION,
            parse_status=parse_status,
            normalized_json=normalized,
            warnings={"warnings": normalized.get("warnings") or []},
            error=error,
        )
    )


def _json_bytes(value: Any) -> int:
    try:
        return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):
        return 0


def _compact_code_change_for_json(change: dict[str, Any]) -> dict[str, Any]:
    total_lines = int(change.get("lines_added") or 0) + int(change.get("lines_deleted") or 0)
    if total_lines <= PRODUCT_FULL_LINE_ATTRIBUTION_LIMIT and _json_bytes(change) <= 64 * 1024:
        return change
    compact = dict(change)
    line_stats = compact.get("line_stats") if isinstance(compact.get("line_stats"), dict) else {}
    compact["line_detail_policy"] = str(compact.get("line_detail_policy") or "summary_only")
    compact["line_detail_truncated"] = True
    compact["line_detail_limit"] = PRODUCT_FULL_LINE_ATTRIBUTION_LIMIT
    compact["line_attribution_summary"] = {
        "file_path": _normalize_code_path(compact.get("file_path")),
        "total_added_lines": int(compact.get("lines_added") or 0),
        "total_deleted_lines": int(compact.get("lines_deleted") or 0),
        "captured_added_line_count": int(line_stats.get("captured_added_line_count") or compact.get("captured_added_line_count") or 0),
        "captured_deleted_line_count": int(line_stats.get("captured_deleted_line_count") or compact.get("captured_deleted_line_count") or 0),
        "full_line_detail_stored_in_json": False,
    }
    for heavy_key in ("hunks", "changes", "patch", "diff", "raw_json", "line_attribution"):
        compact.pop(heavy_key, None)
    compact["product_detail_policy"] = "line_attribution_summary_only"
    return compact


def _compact_normalized_for_storage(normalized: dict[str, Any]) -> dict[str, Any]:
    compact = dict(normalized)
    raw_changes = compact.get("code_changes")
    if isinstance(raw_changes, list):
        compact["code_changes"] = [_compact_code_change_for_json(change) if isinstance(change, dict) else change for change in raw_changes]
    return compact


def _read_normalized_event(db: Session, event_id: str) -> dict[str, Any]:
    row = db.execute(
        select(NormalizedIngestEvent)
        .where(NormalizedIngestEvent.raw_event_id == event_id)
        .where(NormalizedIngestEvent.parser_version == PARSER_VERSION)
    ).scalar_one()
    return dict(row.normalized_json) if row.normalized_json else {}


def _upsert_ai_session(db: Session, event: EventIn, payload: dict[str, Any], normalized: dict[str, Any]) -> AiSession:
    session_data = normalized.get("session") if isinstance(normalized.get("session"), dict) else {}
    session_id = str(session_data.get("session_id") or _product_session_id(event, payload))[:128]
    identity = _normalized_product_identity(_identity_from_event(event))
    occurred = _naive(event.occurred_at)
    started = _parse_time(session_data.get("started_at"), event.occurred_at)
    last_activity = _parse_time(session_data.get("last_activity_at"), event.occurred_at)
    session = db.get(AiSession, session_id)
    if not session:
        session = AiSession(
            session_id=session_id,
            external_session_id=str(session_data.get("external_session_id") or session_id)[:128],
            task_id=event.task_id,
            client_id=str(payload.get("client_id") or "")[:128] or None,
            plugin_name=str(payload.get("plugin_name") or "")[:128] or None,
            plugin_version=str(payload.get("plugin_version") or "")[:64] or None,
            tool=event.tool,
            status="active",
            started_at=started,
            last_activity_at=last_activity,
        )
        db.add(session)
        db.flush()
    else:
        session.task_id = session.task_id or event.task_id
        if payload.get("client_id"):
            session.client_id = str(payload.get("client_id"))[:128]
        if payload.get("plugin_name"):
            session.plugin_name = str(payload.get("plugin_name"))[:128]
        if payload.get("plugin_version"):
            session.plugin_version = str(payload.get("plugin_version"))[:64]
        session.external_session_id = session.external_session_id or str(session_data.get("external_session_id") or session_id)[:128]
        session.started_at = min(session.started_at, started) if session.started_at else started
        session.last_activity_at = max(session.last_activity_at, last_activity) if session.last_activity_at else last_activity
        if event.event_type == "task_end":
            session.status = "completed"

    snapshot_status = str(session_data.get("status") or "").lower()
    if event.tool == "copilot" and event.event_type in {"conversation_snapshot", "turn_snapshot"} and snapshot_status in {"active", "idle", "completed"}:
        session.status = snapshot_status

    session.username = identity["username"] or "unknown"
    session.user_id = identity["user_id"]
    session.user_display_name = identity["user_display_name"]
    session.team = identity["team"]
    session.machine_id = identity["machine_id"]
    session.host_hash = identity["host_hash"]
    if event.model:
        session.model = event.model[:128]
    normalized_title = session_data.get("title") or payload.get("title")
    if normalized_title:
        session.title = str(normalized_title)[:256]
    normalized_model = session_data.get("model") or payload.get("resolved_model")
    if normalized_model:
        session.model = str(normalized_model)[:128]
    return session


def _upsert_turn(
    db: Session,
    session_id: str,
    task_id: str,
    turn_index: int,
    created_at: datetime,
    request_id: str | None = None,
    response_id: str | None = None,
    *,
    tool: str | None = None,
    status: str | None = None,
) -> AiTurn:
    turn = None
    preserve_existing_turn_index = False
    if request_id and response_id:
        turn = (
            db.execute(
                select(AiTurn)
                .where(AiTurn.session_id == session_id)
                .where(AiTurn.request_id == request_id)
                .where(AiTurn.response_id == response_id)
            )
            .scalar_one_or_none()
        )
    if not turn and tool == "claude" and request_id:
        # Claude Code can emit several snapshots for the same user request while
        # the JSONL file is still being written. Those snapshots may carry
        # different response_id values and, when captured by hook offsets, a
        # segment-relative turn_index. The logical turn boundary is the user
        # request_id, so merge the later complete snapshot into the existing
        # request row instead of creating "turn 1/2" duplicates for a real
        # "turn 3/4".
        candidates = (
            db.execute(
                select(AiTurn)
                .where(AiTurn.session_id == session_id)
                .where(AiTurn.request_id == request_id)
                .order_by(
                    AiTurn.status.in_(["in_progress", "incomplete", "active", "idle"]).desc(),
                    AiTurn.turn_index.desc(),
                    AiTurn.id.asc(),
                )
            )
            .scalars()
            .all()
        )
        if candidates:
            turn = candidates[0]
            # Keep an established full-session index when the incoming snapshot
            # is segment-relative (for example 1/2). If a later full-file scan
            # carries a larger index for the same request, let it correct a
            # previously stored segment-relative index.
            preserve_existing_turn_index = turn.turn_index > 0 and turn.turn_index >= turn_index
    if not turn:
        turn_query = (
            select(AiTurn)
            .where(AiTurn.session_id == session_id)
            .where(AiTurn.turn_index == turn_index)
        )
        if request_id:
            turn_query = turn_query.where(or_(AiTurn.request_id.is_(None), AiTurn.request_id == request_id))
        if response_id:
            turn_query = turn_query.where(or_(AiTurn.response_id.is_(None), AiTurn.response_id == response_id))
        turn = (
            db.execute(
                turn_query.order_by(AiTurn.request_id.is_(None).asc(), AiTurn.response_id.is_(None).asc(), AiTurn.id.asc()).limit(1)
            )
            .scalar_one_or_none()
        )
    if not turn:
        turn = AiTurn(
            session_id=session_id,
            task_id=task_id,
            turn_index=turn_index,
            request_id=request_id,
            response_id=response_id,
            status="in_progress",
            created_at=created_at,
        )
        db.add(turn)
        db.flush()
    else:
        previous_turn_index = turn.turn_index
        if request_id and response_id and not preserve_existing_turn_index:
            turn.created_at = created_at
        else:
            turn.created_at = min(turn.created_at, created_at)
        if not preserve_existing_turn_index:
            turn.turn_index = turn_index
            if previous_turn_index != turn_index:
                for model in (AiMessage, AiProcessStep, AiCodeChange, AiSpecAccess, AiRequestUsage):
                    db.execute(update(model).where(model.turn_id == turn.id).values(turn_index=turn_index))
        turn.task_id = turn.task_id or task_id
        if request_id:
            turn.request_id = request_id
        if response_id:
            normalized_status = str(status or "").lower()
            if (
                not turn.response_id
                or normalized_status == "completed"
                or (turn.status in {"in_progress", "incomplete", "active", "idle"} and normalized_status not in _OPEN_TURN_STATUSES)
            ):
                turn.response_id = response_id
    return turn


_OPEN_TURN_STATUSES = {"in_progress", "incomplete", "active", "idle", "streaming"}


def _normalized_turn_status(value: Any) -> str:
    status = str(value or "").strip().lower()
    if status in {"", "done", "success"}:
        return "completed"
    if status in {"active", "streaming"}:
        return "in_progress"
    return status[:24]


def _is_open_turn_status(status: str | None) -> bool:
    return str(status or "").strip().lower() in _OPEN_TURN_STATUSES


def _upsert_ai_message(db: Session, event: EventIn, session_id: str, message: dict[str, Any], turn: AiTurn | None) -> AiMessage:
    message_index = int(message.get("message_index") or 0)
    source_key = str(message.get("source_key") or "")[:256] or None
    occurred = _parse_time(message.get("occurred_at"), event.occurred_at)
    content = str(message.get("content") or "")
    content_storage = str(message.get("content_storage") or ("blob_preview" if message.get("blob_ref") else "inline"))[:24]
    text_hash = (
        str(message.get("content_hash") or "")[:128]
        if content_storage == "blob_preview"
        else (hashlib.sha256(content.encode("utf-8")).hexdigest() if content else str(message.get("content_hash") or "")[:128])
    )
    blob_ref = str(message.get("blob_ref") or "")[:512] or None
    blob_encoding = str(message.get("blob_encoding") or "")[:64] or None
    blob_original_bytes = int(message.get("blob_original_bytes")) if message.get("blob_original_bytes") is not None else None
    blob_compressed_bytes = int(message.get("blob_compressed_bytes")) if message.get("blob_compressed_bytes") is not None else None
    blob_sha256 = str(message.get("blob_sha256") or "")[:128] or None
    role = str(message.get("role") or "message")[:32]
    turn_index = turn.turn_index if turn else int(message.get("turn_index") or 0)
    existing = None
    if source_key:
        existing = (
            db.execute(
                select(AiMessage)
                .where(AiMessage.session_id == session_id)
                .where(AiMessage.source_key == source_key)
            )
            .scalar_one_or_none()
        )
    if not existing and not source_key:
        existing = (
            db.execute(
                select(AiMessage)
                .where(AiMessage.session_id == session_id)
                .where(AiMessage.message_index == message_index)
            )
            .scalar_one_or_none()
        )
    if not existing and text_hash:
        existing = (
            db.execute(
                select(AiMessage)
                .where(AiMessage.session_id == session_id)
                .where(AiMessage.turn_index == turn_index)
                .where(AiMessage.role == role)
                .where(AiMessage.text_hash == text_hash)
                .order_by(AiMessage.id.asc())
                .limit(1)
            )
            .scalar_one_or_none()
        )
    if not existing and source_key:
        index_taken = (
            db.execute(
                select(AiMessage.id)
                .where(AiMessage.session_id == session_id)
                .where(AiMessage.message_index == message_index)
            )
            .scalar_one_or_none()
        )
        if index_taken is not None:
            max_message_index = db.execute(select(func.max(AiMessage.message_index)).where(AiMessage.session_id == session_id)).scalar()
            message_index = int(max_message_index if max_message_index is not None else -1) + 1
    if existing:
        row = existing
        row.turn_id = turn.id if turn else row.turn_id
        row.turn_index = turn_index or row.turn_index or 0
        row.role = role
        row.content = content
        row.content_storage = content_storage
        row.text_len = int(message.get("text_len") or len(content))
        row.text_hash = text_hash
        row.blob_ref = blob_ref
        row.blob_encoding = blob_encoding
        row.blob_original_bytes = blob_original_bytes
        row.blob_compressed_bytes = blob_compressed_bytes
        row.blob_sha256 = blob_sha256
        row.occurred_at = occurred
        row.raw_event_id = event.event_id
        row.raw_path = str(message.get("raw_path") or "")[:512] or None
        row.source_key = source_key
    else:
        row = AiMessage(
            session_id=session_id,
            task_id=event.task_id,
            turn_id=turn.id if turn else None,
            message_index=message_index,
            turn_index=turn_index,
            role=role,
            content=content,
            content_storage=content_storage,
            text_len=int(message.get("text_len") or len(content)),
            text_hash=text_hash,
            blob_ref=blob_ref,
            blob_encoding=blob_encoding,
            blob_original_bytes=blob_original_bytes,
            blob_compressed_bytes=blob_compressed_bytes,
            blob_sha256=blob_sha256,
            raw_event_id=event.event_id,
            raw_path=str(message.get("raw_path") or "")[:512] or None,
            source_key=source_key,
            occurred_at=occurred,
        )
        db.add(row)
        db.flush()
    return row


def _turn_for_time(turns: list[AiTurn], occurred_at: datetime) -> AiTurn | None:
    candidate: AiTurn | None = None
    for turn in turns:
        if turn.created_at <= occurred_at and (candidate is None or turn.created_at >= candidate.created_at):
            candidate = turn
    return candidate


def _turn_for_change(turns: list[AiTurn], change: dict[str, Any], occurred_at: datetime) -> AiTurn | None:
    request_id = str(change.get("request_id") or "")[:256] or None
    response_id = str(change.get("response_id") or "")[:256] or None
    if request_id:
        for turn in turns:
            if turn.request_id != request_id:
                continue
            if response_id and turn.response_id and turn.response_id != response_id:
                continue
            return turn
    if isinstance(change.get("turn_index"), int):
        for turn in turns:
            if turn.turn_index == int(change["turn_index"]):
                return turn
    return _turn_for_time(turns, occurred_at)


def _upsert_ai_process_steps(db: Session, event: EventIn, session_id: str, normalized: dict[str, Any], turns: list[AiTurn]) -> None:
    raw_steps = normalized.get("process_steps")
    if not isinstance(raw_steps, list):
        return
    for step in raw_steps:
        if not isinstance(step, dict):
            continue
        occurred = _parse_time(step.get("occurred_at"), event.occurred_at)
        step_index = int(step.get("step_index") or 0)
        step_type = str(step.get("step_type") or "step")[:64]
        content = str(step.get("content") or "")
        content_hash = str(step.get("content_hash") or hashlib.sha256(content.encode("utf-8")).hexdigest())[:128]
        request_id = str(step.get("request_id") or "")[:256] or None
        response_id = str(step.get("response_id") or "")[:256] or None
        turn = _turn_for_change(turns, {**step, "request_id": request_id, "response_id": response_id}, occurred)
        step_id = str(step.get("step_id") or "")[:128] or None
        if request_id and step_id:
            existing_rows = (
                db.execute(
                    select(AiProcessStep)
                    .where(AiProcessStep.session_id == session_id)
                    .where(AiProcessStep.request_id == request_id)
                    .where(AiProcessStep.step_id == step_id)
                    .order_by(AiProcessStep.id)
                )
                .scalars()
                .all()
            )
        else:
            existing_rows = (
                db.execute(
                    select(AiProcessStep)
                    .where(AiProcessStep.session_id == session_id)
                    .where(AiProcessStep.step_type == step_type)
                    .where(AiProcessStep.content_hash == content_hash)
                    .order_by(AiProcessStep.id)
                )
                .scalars()
                .all()
            )
        existing = existing_rows[0] if existing_rows else None
        for duplicate in existing_rows[1:]:
            db.delete(duplicate)
        if existing:
            row = existing
            row.turn_id = turn.id if turn else row.turn_id
            row.turn_index = turn.turn_index if turn else row.turn_index
            row.request_id = request_id or row.request_id
            row.response_id = response_id or row.response_id
            row.step_id = step_id or row.step_id
            row.content = content
            row.title = str(step.get("title"))[:256] if step.get("title") else row.title
            row.tool_name = str(step.get("tool_name"))[:128] if step.get("tool_name") else row.tool_name
            row.tool_call_id = str(step.get("tool_call_id"))[:256] if step.get("tool_call_id") else row.tool_call_id
            row.actor_path = str(step.get("actor_path"))[:512] if step.get("actor_path") else row.actor_path
            row.actor_type = str(step.get("actor_type"))[:64] if step.get("actor_type") else row.actor_type
            row.parent_tool_call_id = str(step.get("parent_tool_call_id"))[:256] if step.get("parent_tool_call_id") else row.parent_tool_call_id
            row.raw_event_id = event.event_id
            row.raw_path = str(step.get("raw_path") or "")[:512] or row.raw_path
            row.status = str(step.get("status"))[:64] if step.get("status") else row.status
        else:
            db.add(
                AiProcessStep(
                    session_id=session_id,
                    task_id=event.task_id,
                    turn_id=turn.id if turn else None,
                    turn_index=turn.turn_index if turn else None,
                    request_id=request_id,
                    response_id=response_id,
                    step_id=step_id,
                    step_index=step_index,
                    step_type=step_type,
                    title=str(step.get("title"))[:256] if step.get("title") else None,
                    content=content,
                    content_hash=content_hash,
                    tool_call_id=str(step.get("tool_call_id"))[:256] if step.get("tool_call_id") else None,
                    tool_name=str(step.get("tool_name"))[:128] if step.get("tool_name") else None,
                    actor_path=str(step.get("actor_path"))[:512] if step.get("actor_path") else None,
                    actor_type=str(step.get("actor_type"))[:64] if step.get("actor_type") else None,
                    parent_tool_call_id=str(step.get("parent_tool_call_id"))[:256] if step.get("parent_tool_call_id") else None,
                    raw_event_id=event.event_id,
                    raw_path=str(step.get("raw_path") or "")[:512] or None,
                    status=str(step.get("status"))[:64] if step.get("status") else None,
                    occurred_at=occurred,
                )
            )


def _normalize_code_path(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = _decode_git_quoted_path(text)
    text = text.replace("\\", "/")
    if text.startswith("a/") or text.startswith("b/"):
        text = text[2:]
    text = text.lstrip("./")
    marker = "openspec/specs/"
    marker_index = text.find(marker)
    if marker_index >= 0:
        return text[marker_index:]
    return text


def _decode_git_quoted_path(text: str) -> str:
    raw_text = text.strip()
    is_quoted = len(raw_text) >= 2 and raw_text[0] == '"' and raw_text[-1] == '"'
    has_octal_escape = any(
        raw_text[index] == "\\"
        and index + 3 < len(raw_text)
        and all(ch in "01234567" for ch in raw_text[index + 1 : index + 4])
        for index in range(len(raw_text))
    )
    if not is_quoted and not has_octal_escape:
        return raw_text

    inner = raw_text[1:-1] if is_quoted else raw_text
    output = bytearray()
    index = 0
    escapes = {
        "a": b"\a",
        "b": b"\b",
        "f": b"\f",
        "n": b"\n",
        "r": b"\r",
        "t": b"\t",
        "v": b"\v",
        "\\": b"\\",
        '"': b'"',
    }
    while index < len(inner):
        char = inner[index]
        if char != "\\":
            output.extend(char.encode("utf-8"))
            index += 1
            continue
        if index + 3 < len(inner) and all(ch in "01234567" for ch in inner[index + 1 : index + 4]):
            output.append(int(inner[index + 1 : index + 4], 8))
            index += 4
            continue
        if index + 1 < len(inner):
            escaped = inner[index + 1]
            output.extend(escapes.get(escaped, escaped.encode("utf-8")))
            index += 2
            continue
        output.extend(b"\\")
        index += 1
    try:
        return output.decode("utf-8")
    except UnicodeDecodeError:
        return output.decode("latin-1", errors="replace")


def _normalize_diff_line_type(value: Any) -> str:
    text = str(value or "").lower()
    if text in {"added", "add", "insert", "+"}:
        return "added"
    if text in {"removed", "deleted", "delete", "-"}:
        return "removed"
    return text


def _normalize_line_for_match(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text)
    text = text.replace('"', "'")
    text = re.sub(r";+\s*$", "", text).strip()
    return text


def _line_is_blank(value: Any) -> bool:
    return isinstance(value, str) and _normalize_line_for_match(value) == ""


def _line_is_trackable(value: Any) -> bool:
    return not _line_is_blank(value)


def _line_text_hash(file_path: str, line: dict[str, Any]) -> str:
    explicit = line.get("text_hash") or line.get("line_hash") or line.get("content_hash")
    if explicit:
        return str(explicit)
    text = line.get("text")
    if isinstance(text, str):
        return hashlib.sha256(f"{file_path}\0{text}".encode("utf-8")).hexdigest()
    return ""


def _iter_code_diff_lines(change: dict[str, Any] | AiCodeChange) -> list[dict[str, Any]]:
    payload = _code_change_payload(change) if isinstance(change, AiCodeChange) else change
    file_path = _normalize_code_path(getattr(change, "file_path", None) if isinstance(change, AiCodeChange) else payload.get("file_path"))
    if not file_path:
        file_path = _normalize_code_path(payload.get("file_path") or payload.get("path"))
    output: list[dict[str, Any]] = []
    hunks = payload.get("hunks") if isinstance(payload.get("hunks"), list) else []
    for hunk_index, hunk in enumerate(hunks):
        if not isinstance(hunk, dict):
            continue
        lines = hunk.get("lines")
        if not isinstance(lines, list):
            continue
        for line_index, line in enumerate(lines):
            if not isinstance(line, dict):
                continue
            line_type = _normalize_diff_line_type(line.get("line_type") or line.get("type"))
            if line_type not in {"added", "removed"}:
                continue
            text_hash = _line_text_hash(file_path, line)
            if not file_path or not text_hash:
                continue
            output.append(
                {
                    "file_path": file_path,
                    "line_type": line_type,
                    "text_hash": text_hash,
                    "text": line.get("text"),
                    "old_line": line.get("old_line"),
                    "new_line": line.get("new_line"),
                    "hunk_index": hunk_index,
                    "line_index": line_index,
                }
            )
    editor_changes = payload.get("changes") if isinstance(payload.get("changes"), list) else []
    for change_index, editor_change in enumerate(editor_changes):
        if not isinstance(editor_change, dict):
            continue
        editor_file_path = _normalize_code_path(editor_change.get("file_path") or file_path)
        if not editor_file_path:
            continue
        for list_key, line_type in (("added_lines", "added"), ("removed_lines", "removed"), ("deleted_lines", "removed")):
            raw_lines = editor_change.get(list_key)
            if not isinstance(raw_lines, list):
                continue
            for line_index, line in enumerate(raw_lines):
                if not isinstance(line, dict):
                    continue
                text_hash = _line_text_hash(editor_file_path, line)
                if not text_hash:
                    continue
                output.append(
                    {
                        "file_path": editor_file_path,
                        "line_type": line_type,
                        "text_hash": text_hash,
                        "text": line.get("text"),
                        "old_line": line.get("old_line"),
                        "new_line": line.get("new_line"),
                        "hunk_index": change_index,
                        "line_index": line_index,
                    }
                )
    return output


def _event_workspace_hash(event: EventIn) -> str:
    payload = event.payload if isinstance(event.payload, dict) else {}
    return str(event.workspace_path_hash or payload.get("workspace_path_hash") or "").strip()


def _raw_workspace_hash(raw: RawIngestEvent) -> str:
    raw_json = raw.raw_json if isinstance(raw.raw_json, dict) else {}
    event_json = raw_json.get("event") if isinstance(raw_json.get("event"), dict) else {}
    payload = event_json.get("payload") if isinstance(event_json.get("payload"), dict) else {}
    return str(event_json.get("workspace_path_hash") or payload.get("workspace_path_hash") or "").strip()


def _line_scope_from_event(event: EventIn, payload: dict[str, Any] | None = None) -> dict[str, str]:
    payload = payload if isinstance(payload, dict) else event.payload if isinstance(event.payload, dict) else {}
    username = _clean_identity(event.username) or ""
    user_id = _clean_identity(event.user_id) or ""
    machine_id = _clean_identity(event.machine_id) or ""
    host_hash = _clean_identity(event.host_hash) or ""
    client_id = str(payload.get("client_id") or "").strip()
    has_commit_placeholder_identity = (
        event.event_type == "commit_snapshot"
        and username.lower() in {"user", "unknown"}
        and user_id.lower() in {"user", "unknown"}
    )
    if event.event_type == "commit_snapshot":
        if username.lower() in {"user", "unknown"}:
            username = ""
        if user_id.lower() in {"user", "unknown"}:
            user_id = ""
        if has_commit_placeholder_identity or machine_id.lower() in {"unknown"}:
            machine_id = ""
        if has_commit_placeholder_identity or host_hash.lower() in {"unknown"}:
            host_hash = ""
    return {
        "workspace_path_hash": str(event.workspace_path_hash or payload.get("workspace_path_hash") or "").strip(),
        "client_id": client_id,
        "username": username,
        "user_id": user_id,
        "machine_id": machine_id,
        "host_hash": host_hash,
    }


def _line_scope_from_raw(raw: RawIngestEvent) -> dict[str, str]:
    return {
        "workspace_path_hash": _raw_workspace_hash(raw),
        "client_id": str(raw.client_id or "").strip(),
        "username": _clean_identity(raw.username) or "",
        "user_id": _clean_identity(raw.user_id) or "",
        "machine_id": _clean_identity(raw.machine_id) or "",
        "host_hash": _clean_identity(raw.host_hash) or "",
    }


def _scope_user(scope: dict[str, str]) -> str:
    return scope.get("user_id") or scope.get("username") or ""


def _scope_same_host_or_machine(target: dict[str, str], candidate: dict[str, str]) -> bool:
    target_host = target.get("host_hash")
    candidate_host = candidate.get("host_hash")
    if target_host or candidate_host:
        return bool(target_host and candidate_host and target_host == candidate_host)
    target_machine = target.get("machine_id")
    candidate_machine = candidate.get("machine_id")
    if target_machine or candidate_machine:
        return bool(target_machine and candidate_machine and target_machine == candidate_machine)
    return False


def _scope_has_host_or_machine(scope: dict[str, str]) -> bool:
    return bool(scope.get("host_hash") or scope.get("machine_id"))


def _scope_host_or_machine_compatible(target: dict[str, str], candidate: dict[str, str]) -> bool:
    target_host = target.get("host_hash")
    candidate_host = candidate.get("host_hash")
    if target_host and candidate_host:
        return target_host == candidate_host
    target_machine = target.get("machine_id")
    candidate_machine = candidate.get("machine_id")
    if target_machine and candidate_machine:
        return target_machine == candidate_machine
    return True


def _scope_same_client(target: dict[str, str], candidate: dict[str, str]) -> bool:
    return bool(target.get("client_id") and target["client_id"] == candidate.get("client_id"))


def _scope_matches(target: dict[str, str], candidate: dict[str, str]) -> bool:
    target_user = _scope_user(target)
    candidate_user = _scope_user(candidate)
    if target_user and candidate_user and target_user != candidate_user:
        return False

    target_workspace = target.get("workspace_path_hash")
    candidate_workspace = candidate.get("workspace_path_hash")
    if target_workspace or candidate_workspace:
        if not target_workspace or not candidate_workspace or target_workspace != candidate_workspace:
            return False
        if not target_user or not candidate_user:
            return _scope_same_client(target, candidate) and _scope_host_or_machine_compatible(target, candidate)
        return _scope_same_host_or_machine(target, candidate) or _scope_same_client(target, candidate)

    if not target_user or not candidate_user:
        return False
    return _scope_same_client(target, candidate) and _scope_host_or_machine_compatible(target, candidate)


def _matching_ai_evidence_rows(db: Session, event: EventIn, occurred: datetime) -> list[AiCodeChange]:
    payload = event.payload if isinstance(event.payload, dict) else {}
    query = (
        select(AiCodeChange, RawIngestEvent)
        .join(RawIngestEvent, RawIngestEvent.event_id == AiCodeChange.event_id)
        .where(AiCodeChange.event_id != event.event_id)
        .where(AiCodeChange.occurred_at <= occurred)
        .where(RawIngestEvent.event_type != "commit_snapshot")
        .order_by(AiCodeChange.occurred_at.asc(), AiCodeChange.id.asc())
    )
    rows = db.execute(query).all()
    target_scope = _line_scope_from_event(event, payload)
    evidence: list[AiCodeChange] = []
    for change, raw in rows:
        if not _scope_matches(target_scope, _line_scope_from_raw(raw)):
            continue
        if not _is_mutable_code_change(change):
            continue
        payload = _code_change_payload(change)
        snapshot_kind = str(change.snapshot_kind or payload.get("snapshot_kind") or "").lower()
        if snapshot_kind not in AI_TURN_CODE_SNAPSHOT_KINDS:
            continue
        evidence.append(change)
    return evidence


def _iter_code_diff_lines_from_raw_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    raw_code_changes = payload.get("code_changes")
    if isinstance(raw_code_changes, list):
        for file_change in raw_code_changes:
            if isinstance(file_change, dict):
                output.extend(_iter_code_diff_lines(file_change))
    raw_files = payload.get("files")
    if isinstance(raw_files, list):
        for file_change in raw_files:
            if isinstance(file_change, dict):
                output.extend(_iter_code_diff_lines(file_change))
    raw_changes = payload.get("changes")
    if isinstance(raw_changes, list):
        for file_change in raw_changes:
            if isinstance(file_change, dict):
                output.extend(_iter_code_diff_lines(file_change))
    if not output:
        output.extend(_iter_code_diff_lines(payload))
    return output


def _iter_ai_evidence_diff_lines(db: Session, evidence: AiCodeChange) -> list[dict[str, Any]]:
    lines = _iter_code_diff_lines(evidence)
    if lines:
        return lines
    raw = db.get(RawIngestEvent, evidence.event_id)
    if raw is None:
        return []
    try:
        _, payload = _event_payload_from_raw(db, raw)
    except Exception:
        return []
    return _iter_code_diff_lines_from_raw_payload(payload)


def _line_number(line: dict[str, Any], line_type: str) -> int | None:
    raw = line.get("new_line") if line_type == "added" else line.get("old_line")
    try:
        number = int(raw)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _line_text_preview(line: dict[str, Any]) -> str | None:
    text = line.get("text")
    if not isinstance(text, str):
        return None
    return text[:1000]


def _line_attr_scope_filter(query, scope: dict[str, str]):
    strong_scope = bool(
        scope.get("workspace_path_hash")
        and _scope_user(scope)
        and (scope.get("host_hash") or scope.get("machine_id"))
    )
    if scope.get("workspace_path_hash"):
        query = query.where(AiLineAttribution.workspace_path_hash == scope["workspace_path_hash"])
    if scope.get("machine_id"):
        query = query.where(AiLineAttribution.machine_id == scope["machine_id"])
    if scope.get("host_hash"):
        query = query.where(AiLineAttribution.host_hash == scope["host_hash"])
    if scope.get("user_id"):
        query = query.where(AiLineAttribution.user_id == scope["user_id"])
    elif scope.get("username"):
        query = query.where(AiLineAttribution.username == scope["username"])
    if scope.get("client_id") and not strong_scope:
        query = query.where(AiLineAttribution.client_id == scope["client_id"])
    return query


def _find_line_attr(db: Session, scope: dict[str, str], file_path: str, line_no: int) -> AiLineAttribution | None:
    query = (
        select(AiLineAttribution)
        .where(AiLineAttribution.file_path == file_path[:1024])
        .where(AiLineAttribution.line_no == line_no)
        .order_by(AiLineAttribution.updated_at.desc(), AiLineAttribution.id.desc())
    )
    return db.execute(_line_attr_scope_filter(query, scope)).scalars().first()


def _line_attr_rows_for_file(db: Session, scope: dict[str, str], file_path: str) -> list[AiLineAttribution]:
    query = (
        select(AiLineAttribution)
        .where(AiLineAttribution.file_path == file_path[:1024])
        .order_by(AiLineAttribution.line_no.asc(), AiLineAttribution.id.asc())
    )
    return db.execute(_line_attr_scope_filter(query, scope)).scalars().all()


LINE_IDENTITY_FIELDS = ("client_id", "username", "user_id", "machine_id", "host_hash")
LINE_TURN_FIELDS = ("session_id", "request_id", "response_id")


def _line_scope_missing_identity(scope: dict[str, str]) -> bool:
    return any(not scope.get(field) for field in LINE_IDENTITY_FIELDS)


def _fill_line_scope_from_row(scope: dict[str, str], row: AiLineAttribution) -> None:
    for field in (*LINE_IDENTITY_FIELDS, *LINE_TURN_FIELDS):
        if not scope.get(field):
            scope[field] = str(getattr(row, field, "") or "")


def _fill_line_scope_from_raw(scope: dict[str, str], raw: RawIngestEvent | None) -> None:
    if raw is None:
        return
    raw_scope = _line_scope_from_raw(raw)
    for field in ("workspace_path_hash", "client_id", "username", "user_id", "machine_id", "host_hash"):
        if not scope.get(field):
            scope[field] = raw_scope.get(field, "")
    if not scope.get("session_id"):
        scope["session_id"] = str(raw.session_id or "")


def _fill_line_scope_from_code_change(scope: dict[str, str], change: AiCodeChange | None) -> None:
    if change is None:
        return
    for field in LINE_TURN_FIELDS:
        if not scope.get(field):
            scope[field] = str(getattr(change, field, "") or "")


def _line_scope_for_write(
    db: Session,
    scope: dict[str, str],
    event: EventIn,
    file_path: str,
    origin_event_id: str | None,
) -> dict[str, str]:
    writable = dict(scope)
    if not _line_scope_missing_identity(writable):
        return writable

    query = (
        select(AiLineAttribution)
        .where(AiLineAttribution.workspace_path_hash == writable.get("workspace_path_hash", ""))
        .where(AiLineAttribution.file_path == file_path[:1024])
        .order_by(AiLineAttribution.updated_at.desc(), AiLineAttribution.id.desc())
    )
    for row in db.execute(query).scalars().all():
        _fill_line_scope_from_row(writable, row)
        if not _line_scope_missing_identity(writable):
            return writable

    if origin_event_id:
        _fill_line_scope_from_raw(writable, db.get(RawIngestEvent, origin_event_id))
    if _line_scope_missing_identity(writable):
        _fill_line_scope_from_raw(writable, db.get(RawIngestEvent, event.event_id))
    return writable


def _line_turn_scope_for_write(
    db: Session,
    row: AiLineAttribution | None,
    event: EventIn,
    origin_event_id: str | None,
    request_id: str | None,
    response_id: str | None,
) -> dict[str, str]:
    writable: dict[str, str] = {
        "session_id": _event_session_id(event),
        "request_id": request_id or "",
        "response_id": response_id or "",
    }
    if row is not None:
        _fill_line_scope_from_row(writable, row)
    if origin_event_id and origin_event_id != event.event_id:
        with db.no_autoflush:
            origin_change = db.execute(select(AiCodeChange).where(AiCodeChange.event_id == origin_event_id)).scalars().first()
            origin_raw = db.get(RawIngestEvent, origin_event_id)
        _fill_line_scope_from_code_change(writable, origin_change)
        _fill_line_scope_from_raw(writable, origin_raw)
    if not writable.get("session_id"):
        with db.no_autoflush:
            current_raw = db.get(RawIngestEvent, event.event_id)
        _fill_line_scope_from_raw(writable, current_raw)
    return writable


def _resolve_line_attr_file_path(db: Session, scope: dict[str, str], file_path: str) -> str:
    normalized = _normalize_code_path(file_path)
    if not normalized:
        return ""
    if _line_attr_rows_for_file(db, scope, normalized):
        return normalized
    rows_query = select(AiLineAttribution.file_path).distinct()
    rows = db.execute(_line_attr_scope_filter(rows_query, scope)).scalars().all()
    candidates = [str(row or "") for row in rows if row]
    suffix_matches = [
        candidate
        for candidate in candidates
        if normalized.endswith(f"/{candidate}") or candidate.endswith(f"/{normalized}")
    ]
    if suffix_matches:
        return sorted(suffix_matches, key=lambda item: (len(item), item))[0]
    return normalized


def _line_attr_matches(row: AiLineAttribution | None, text_hash: str | None, text: Any) -> bool:
    if row is None:
        return False
    if _line_is_blank(text) or _line_is_blank(row.text_preview):
        return False
    if text_hash and row.text_hash and row.text_hash in {str(text_hash), str(text_hash)[:32]}:
        return True
    if isinstance(text, str) and row.text_preview is not None and row.text_preview == text[:1000]:
        return True
    normalized_text = _normalize_line_for_match(text)
    normalized_preview = _normalize_line_for_match(row.text_preview)
    if normalized_text and normalized_preview and normalized_text == normalized_preview:
        return True
    return False


def _line_content_keys(text_hash: str | None, text: Any) -> list[tuple[str, str]]:
    keys: list[tuple[str, str]] = []
    if _line_is_blank(text):
        return keys
    if text_hash:
        keys.append(("hash", str(text_hash)))
        if len(str(text_hash)) > 32:
            keys.append(("hash", str(text_hash)[:32]))
    if isinstance(text, str):
        keys.append(("text", text[:1000]))
        normalized = _normalize_line_for_match(text)
        if normalized:
            keys.append(("normalized_text", normalized[:1000]))
    return keys


def _line_attr_content_pool(db: Session, scope: dict[str, str], file_path: str) -> dict[tuple[str, str], list[AiLineAttribution]]:
    pool: dict[tuple[str, str], list[AiLineAttribution]] = {}
    for row in _line_attr_rows_for_file(db, scope, file_path):
        for key in _line_content_keys(row.text_hash, row.text_preview):
            pool.setdefault(key, []).append(row)
    return pool


def _consume_line_attr_by_content(
    pool: dict[tuple[str, str], list[AiLineAttribution]],
    consumed_ids: set[int],
    text_hash: str | None,
    text: Any,
    line_no: int | None,
) -> AiLineAttribution | None:
    for key in _line_content_keys(text_hash, text):
        for row in pool.get(key, []):
            if row.id in consumed_ids:
                continue
            if line_no is not None and row.line_no == line_no:
                continue
            consumed_ids.add(row.id)
            return row
    return None


def _locate_line_by_context(db: Session, scope: dict[str, str], file_path: str, hunk: dict[str, Any]) -> int | None:
    rows = _line_attr_rows_for_file(db, scope, file_path)
    if not rows:
        return None
    context_before = [line[:1000] for line in hunk.get("context_before", []) if isinstance(line, str)]
    context_after = [line[:1000] for line in hunk.get("context_after", []) if isinstance(line, str)]

    if context_before:
        before_len = len(context_before)
        for start in range(len(rows) - before_len, -1, -1):
            window = rows[start : start + before_len]
            if [row.text_preview for row in window] == context_before:
                return int(window[-1].line_no) + 1

    if context_after:
        after_len = len(context_after)
        for start in range(0, len(rows) - after_len + 1):
            window = rows[start : start + after_len]
            if [row.text_preview for row in window] == context_after:
                return int(window[0].line_no)
    return None


def _shift_line_attrs(db: Session, scope: dict[str, str], file_path: str, start_line: int, delta: int) -> None:
    if delta == 0:
        return
    query = (
        select(AiLineAttribution)
        .where(AiLineAttribution.file_path == file_path[:1024])
        .where(AiLineAttribution.line_no >= start_line)
        .order_by(AiLineAttribution.line_no.desc() if delta > 0 else AiLineAttribution.line_no.asc(), AiLineAttribution.id.desc())
    )
    rows = db.execute(_line_attr_scope_filter(query, scope)).scalars().all()
    for row in rows:
        row.line_no = max(1, int(row.line_no) + delta)
    if rows:
        db.flush()


def _upsert_line_attr(
    db: Session,
    scope: dict[str, str],
    event: EventIn,
    file_path: str,
    line_no: int,
    text_hash: str,
    text_preview: str | None,
    *,
    origin_author: str,
    last_editor: str,
    classification: str,
    origin_event_id: str | None,
    snapshot_kind: str | None,
    request_id: str | None,
    response_id: str | None,
    occurred: datetime,
) -> AiLineAttribution:
    row = _find_line_attr(db, scope, file_path, line_no)
    if not row:
        write_scope = _line_scope_for_write(db, scope, event, file_path, origin_event_id)
        row = AiLineAttribution(
            workspace_path_hash=write_scope.get("workspace_path_hash", ""),
            client_id=write_scope.get("client_id", ""),
            username=write_scope.get("username", ""),
            user_id=write_scope.get("user_id", ""),
            machine_id=write_scope.get("machine_id", ""),
            host_hash=write_scope.get("host_hash", ""),
            file_path=file_path[:1024],
            line_no=line_no,
            occurred_at=occurred,
        )
        db.add(row)
    turn_scope = _line_turn_scope_for_write(db, row, event, origin_event_id, request_id, response_id)
    row.session_id = turn_scope.get("session_id") or None
    row.request_id = turn_scope.get("request_id") or None
    row.response_id = turn_scope.get("response_id") or None
    row.text_hash = text_hash[:128]
    row.text_preview = text_preview
    row.origin_author = origin_author[:32]
    row.last_editor = last_editor[:32]
    row.classification = classification[:64]
    row.origin_event_id = origin_event_id[:64] if origin_event_id else None
    row.last_event_id = event.event_id
    row.source_snapshot_kind = snapshot_kind[:64] if snapshot_kind else None
    row.occurred_at = occurred
    return row


def _delete_line_attr(db: Session, scope: dict[str, str], file_path: str, line_no: int) -> AiLineAttribution | None:
    row = _find_line_attr(db, scope, file_path, line_no)
    if row:
        db.delete(row)
    return row


def _has_prior_tool_patch_for_same_turn_file(db: Session, change: dict[str, Any], file_path: str, occurred: datetime) -> bool:
    request_id = str(change.get("request_id") or "")[:256]
    response_id = str(change.get("response_id") or "")[:256]
    if not request_id and not response_id:
        return False
    query = (
        select(AiCodeChange)
        .where(AiCodeChange.snapshot_kind.in_(AI_TURN_TOOL_PATCH_SNAPSHOT_KINDS))
        .where(AiCodeChange.occurred_at <= occurred)
    )
    if request_id:
        query = query.where(AiCodeChange.request_id == request_id)
    if response_id:
        query = query.where(AiCodeChange.response_id == response_id)
    normalized = _normalize_code_path(file_path)
    for row in db.execute(query).scalars().all():
        row_payload = _code_change_payload(row)
        if not _change_payload_has_absolute_line_numbers(row_payload, str(row.snapshot_kind or row.change_type or "")):
            continue
        candidate = _normalize_code_path(row.file_path)
        if candidate == normalized or candidate.endswith(f"/{normalized}") or normalized.endswith(f"/{candidate}"):
            return True
    return False


ABSOLUTE_LINE_NUMBER_SNAPSHOT_KINDS = {
    "copilot_turn_editor_delta",
    "copilot_turn_workspace_diff",
    "claude_turn_editor_delta",
    "claude_turn_workspace_diff",
    "claude_turn_bash_delta",
    "codex_turn_editor_delta",
    "codex_turn_workspace_diff",
    "workspace_diff_current",
    "workspace_diff",
    "vscode_text_change",
}


def _line_number_basis_from_change(change: dict[str, Any]) -> str:
    for value in (
        change.get("line_number_basis"),
        change.get("lineNumberBasis"),
        (change.get("line_stats") or {}).get("line_number_basis") if isinstance(change.get("line_stats"), dict) else None,
    ):
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    if change.get("line_numbers_are_absolute") is True or change.get("lineNumbersAreAbsolute") is True:
        return "absolute"
    return ""


def _change_payload_has_absolute_line_numbers(change: dict[str, Any], event_type: str = "") -> bool:
    basis = _line_number_basis_from_change(change)
    if basis == "absolute":
        return True
    if basis in {"relative", "unknown", "snippet"}:
        return False
    snapshot_kind = str(change.get("snapshot_kind") or change.get("change_type") or event_type or "").lower()
    event_type_lower = str(change.get("event_type") or event_type or "").lower()
    if event_type_lower == "commit_snapshot" or snapshot_kind in {"commit_snapshot", "commit"}:
        return True
    return snapshot_kind in ABSOLUTE_LINE_NUMBER_SNAPSHOT_KINDS


def _change_has_absolute_line_numbers(event: EventIn, change: dict[str, Any]) -> bool:
    return _change_payload_has_absolute_line_numbers(change, event.event_type)


def _update_line_ledger_from_ai_change(db: Session, event: EventIn, occurred: datetime, change: dict[str, Any]) -> None:
    if event.event_type == "commit_snapshot":
        return
    snapshot_kind = str(change.get("snapshot_kind") or change.get("change_type") or event.event_type or "")
    snapshot_kind_lower = snapshot_kind.lower()
    if snapshot_kind_lower not in AI_TURN_CODE_SNAPSHOT_KINDS:
        return
    if not _change_has_absolute_line_numbers(event, change):
        return
    scope = _line_scope_from_event(event, event.payload if isinstance(event.payload, dict) else {})
    request_id = str(change.get("request_id") or "")[:256] or None
    response_id = str(change.get("response_id") or "")[:256] or None
    file_path = _normalize_code_path(change.get("file_path") or change.get("path"))
    if snapshot_kind_lower in AI_TURN_EDITOR_DELTA_SNAPSHOT_KINDS:
        resolved_file_path = _resolve_line_attr_file_path(db, scope, file_path)
        if _has_prior_tool_patch_for_same_turn_file(db, change, resolved_file_path, occurred):
            return
    hunks = change.get("hunks") if isinstance(change.get("hunks"), list) else []
    if not hunks:
        lines = _iter_code_diff_lines(change)
        for line in lines:
            file_path = _resolve_line_attr_file_path(db, scope, _normalize_code_path(line.get("file_path")))
            line_type = _normalize_diff_line_type(line.get("line_type"))
            line_no = _line_number(line, line_type)
            if not file_path or not line_no:
                continue
            text_hash = str(line.get("text_hash") or "")[:128]
            if not _line_is_trackable(line.get("text")):
                continue
            if line_type == "removed":
                existing = _find_line_attr(db, scope, file_path, line_no)
                if _line_attr_matches(existing, text_hash, line.get("text")):
                    _delete_line_attr(db, scope, file_path, line_no)
                continue
            existing = _find_line_attr(db, scope, file_path, line_no)
            origin_author = existing.origin_author if existing else "ai"
            origin_event_id = existing.origin_event_id if existing else event.event_id
            _upsert_line_attr(
                db,
                scope,
                event,
                file_path,
                line_no,
                text_hash,
                _line_text_preview(line),
                origin_author=origin_author or "ai",
                last_editor="ai",
                classification="ai_current",
                origin_event_id=origin_event_id or event.event_id,
                snapshot_kind=snapshot_kind,
                request_id=request_id,
                response_id=response_id,
                occurred=occurred,
            )
        return

    for hunk in hunks:
        if not isinstance(hunk, dict):
            continue
        hunk_file_path = _resolve_line_attr_file_path(db, scope, _normalize_code_path(hunk.get("file_path") or file_path))
        if not hunk_file_path:
            continue
        lines = hunk.get("lines") if isinstance(hunk.get("lines"), list) else []
        context_line = _locate_line_by_context(db, scope, hunk_file_path, hunk)
        removed_origins: list[AiLineAttribution] = []
        consumed_removed_ids: set[int] = set()
        content_pool = _line_attr_content_pool(db, scope, hunk_file_path)
        for line in lines:
            if not isinstance(line, dict):
                continue
            line_type = _normalize_diff_line_type(line.get("line_type") or line.get("type"))
            if line_type != "removed":
                continue
            line_no = _line_number(line, line_type)
            text_hash = _line_text_hash(hunk_file_path, line)
            if not _line_is_trackable(line.get("text")):
                continue
            candidate = _find_line_attr(db, scope, hunk_file_path, line_no) if line_no else None
            if not _line_attr_matches(candidate, text_hash, line.get("text")):
                candidate = _consume_line_attr_by_content(content_pool, consumed_removed_ids, text_hash, line.get("text"), line_no)
            elif candidate and candidate.id:
                consumed_removed_ids.add(candidate.id)
            if not candidate:
                continue
            removed_origins.append(candidate)
            db.delete(candidate)
        if removed_origins:
            db.flush()
        pure_added_count = sum(
            1
            for line in lines
            if isinstance(line, dict) and _normalize_diff_line_type(line.get("line_type") or line.get("type")) == "added"
        )
        if pure_added_count and not removed_origins and context_line:
            _shift_line_attrs(db, scope, hunk_file_path, context_line, pure_added_count)
        added_seen = 0
        for line in lines:
            if not isinstance(line, dict):
                continue
            line_type = _normalize_diff_line_type(line.get("line_type") or line.get("type"))
            if line_type != "added":
                continue
            line_no = _line_number(line, line_type)
            text_hash = _line_text_hash(hunk_file_path, line)
            if not _line_is_trackable(line.get("text")):
                continue
            previous = removed_origins.pop(0) if removed_origins else None
            if previous:
                line_no = previous.line_no
            elif context_line:
                line_no = context_line + added_seen
            added_seen += 1
            if not line_no:
                continue
            if previous is None:
                previous = _find_line_attr(db, scope, hunk_file_path, line_no)
            origin_author = previous.origin_author if previous else "ai"
            origin_event_id = previous.origin_event_id if previous else event.event_id
            _upsert_line_attr(
                db,
                scope,
                event,
                hunk_file_path,
                line_no,
                text_hash,
                _line_text_preview(line),
                origin_author=origin_author or "ai",
                last_editor="ai",
                classification="ai_current",
                origin_event_id=origin_event_id or event.event_id,
                snapshot_kind=snapshot_kind,
                request_id=request_id,
                response_id=response_id,
                occurred=occurred,
            )


def _ratio_dict(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 6) if denominator else 0.0


def _derive_hunk_modified_counts(hunks: list[dict[str, int]]) -> dict[str, int]:
    total_modified = 0
    ai_modified = 0
    human_modified = 0
    for hunk in hunks:
        total_modified += min(hunk["added"], hunk["removed"])
        ai_modified += min(hunk["ai_added"], hunk["ai_removed"])
        human_modified += min(hunk["human_added"], hunk["human_removed"])
    return {
        "lines_modified": total_modified,
        "ai_lines_modified": ai_modified,
        "human_lines_modified": human_modified,
    }


def _align_added_lines_to_ledger(
    lines: list[dict[str, Any]],
    ledger_rows: list[AiLineAttribution],
) -> tuple[dict[int, AiLineAttribution], bool]:
    added: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
        if not isinstance(line, dict):
            continue
        if _normalize_diff_line_type(line.get("line_type") or line.get("type")) != "added":
            continue
        text = line.get("text")
        normalized = _normalize_line_for_match(text)
        if normalized:
            added.append((index, normalized[:1000]))
    if not added or not ledger_rows:
        return {}, False

    old_items = [
        (row, normalized[:1000])
        for row in ledger_rows
        for normalized in [_normalize_line_for_match(row.text_preview)]
        if normalized
    ]
    if not old_items:
        return {}, False

    old_texts = [text for _, text in old_items]
    new_texts = [text for _, text in added]
    old_len = len(old_texts)
    new_len = len(new_texts)
    if old_len * new_len > 250_000:
        return {}, False

    dp = [[0] * (old_len + 1) for _ in range(new_len + 1)]
    for new_index in range(new_len - 1, -1, -1):
        for old_index in range(old_len - 1, -1, -1):
            if new_texts[new_index] == old_texts[old_index]:
                dp[new_index][old_index] = dp[new_index + 1][old_index + 1] + 1
            else:
                dp[new_index][old_index] = max(dp[new_index + 1][old_index], dp[new_index][old_index + 1])

    mapping: dict[int, AiLineAttribution] = {}
    exact_pairs: list[tuple[int, int]] = []
    new_index = 0
    old_index = 0
    while new_index < new_len and old_index < old_len:
        if new_texts[new_index] == old_texts[old_index]:
            exact_pairs.append((new_index, old_index))
            new_index += 1
            old_index += 1
        elif dp[new_index + 1][old_index] >= dp[new_index][old_index + 1]:
            new_index += 1
        else:
            old_index += 1

    for new_index, old_index in exact_pairs:
        mapping[added[new_index][0]] = old_items[old_index][0]

    boundaries = [(-1, -1), *exact_pairs, (new_len, old_len)]
    for (prev_new, prev_old), (next_new, next_old) in zip(boundaries, boundaries[1:]):
        unmatched_new_indexes = list(range(prev_new + 1, next_new))
        unmatched_old_indexes = list(range(prev_old + 1, next_old))
        for new_gap_index, old_gap_index in zip(unmatched_new_indexes, unmatched_old_indexes):
            mapping.setdefault(added[new_gap_index][0], old_items[old_gap_index][0])

    has_insertions = bool(mapping) and new_len > len(mapping)
    return mapping, has_insertions


def _summarize_large_code_change(change: dict[str, Any]) -> dict[str, Any]:
    total_lines = int(change.get("lines_added") or 0) + int(change.get("lines_deleted") or 0)
    if total_lines <= PRODUCT_FULL_LINE_ATTRIBUTION_LIMIT and _json_bytes(change) <= 64 * 1024:
        return change
    line_stats = change.get("line_stats") if isinstance(change.get("line_stats"), dict) else {}
    existing_summary = change.get("line_attribution_summary") if isinstance(change.get("line_attribution_summary"), dict) else {}
    attributed_added_total = int(existing_summary.get("ai_added_lines") or change.get("ai_lines_added") or 0) + int(
        existing_summary.get("human_added_lines") or change.get("human_lines_added") or 0
    )
    attributed_deleted_total = int(existing_summary.get("ai_deleted_lines") or change.get("ai_lines_deleted") or 0) + int(
        existing_summary.get("human_deleted_lines") or change.get("human_lines_deleted") or 0
    )
    effective_added_total = (
        int(existing_summary.get("total_added_lines"))
        if existing_summary.get("total_added_lines") is not None
        else (attributed_added_total if attributed_added_total else int(change.get("lines_added") or 0))
    )
    effective_deleted_total = (
        int(existing_summary.get("total_deleted_lines"))
        if existing_summary.get("total_deleted_lines") is not None
        else (attributed_deleted_total if attributed_deleted_total else int(change.get("lines_deleted") or 0))
    )
    change["line_detail_policy"] = str(change.get("line_detail_policy") or "summary_only")
    change["line_detail_truncated"] = True
    change["line_detail_limit"] = PRODUCT_FULL_LINE_ATTRIBUTION_LIMIT
    change["line_attribution_summary"] = {
        "file_path": _normalize_code_path(change.get("file_path")),
        "total_added_lines": effective_added_total,
        "total_deleted_lines": effective_deleted_total,
        "raw_total_added_lines": int(existing_summary.get("raw_total_added_lines") or change.get("lines_added") or 0),
        "raw_total_deleted_lines": int(existing_summary.get("raw_total_deleted_lines") or change.get("lines_deleted") or 0),
        "ignored_blank_lines": int(existing_summary.get("ignored_blank_lines") or 0),
        "ai_added_lines": int(existing_summary.get("ai_added_lines") or change.get("ai_lines_added") or 0),
        "human_added_lines": int(existing_summary.get("human_added_lines") or change.get("human_lines_added") or 0),
        "ai_deleted_lines": int(existing_summary.get("ai_deleted_lines") or change.get("ai_lines_deleted") or 0),
        "human_deleted_lines": int(existing_summary.get("human_deleted_lines") or change.get("human_lines_deleted") or 0),
        "captured_added_line_count": int(line_stats.get("captured_added_line_count") or change.get("captured_added_line_count") or 0),
        "captured_deleted_line_count": int(line_stats.get("captured_deleted_line_count") or change.get("captured_deleted_line_count") or 0),
        "full_line_attribution": False,
        "full_line_attribution_limit": PRODUCT_FULL_LINE_ATTRIBUTION_LIMIT,
        "sync_line_matching_skipped": bool(existing_summary.get("sync_line_matching_skipped")),
    }
    if existing_summary.get("skip_reason"):
        change["line_attribution_summary"]["skip_reason"] = str(existing_summary.get("skip_reason"))
    for heavy_key in ("hunks", "changes", "patch", "diff"):
        change.pop(heavy_key, None)
    change["product_detail_policy"] = "line_attribution_summary_only"
    return change


def _apply_commit_line_ledger_updates(
    db: Session,
    event: EventIn,
    occurred: datetime,
    scope: dict[str, str],
    updates: list[dict[str, Any]],
) -> None:
    upsert_targets = {
        (str(update["file_path"]), int(update["line_no"]))
        for update in updates
        if update.get("action") == "upsert" and update.get("file_path") and update.get("line_no")
    }
    for update in updates:
        if update["action"] == "delete":
            target = (str(update["file_path"]), int(update["line_no"]))
            if target in upsert_targets:
                continue
            _delete_line_attr(db, scope, update["file_path"], update["line_no"])
            continue
        move_from_line_no = update.get("move_from_line_no")
        if move_from_line_no and (str(update["file_path"]), int(move_from_line_no)) not in upsert_targets:
            _delete_line_attr(db, scope, update["file_path"], int(move_from_line_no))
        _upsert_line_attr(
            db,
            scope,
            event,
            update["file_path"],
            update["line_no"],
            update["text_hash"],
            update.get("text_preview"),
            origin_author=update["origin_author"],
            last_editor=update["last_editor"],
            classification=update["classification"],
            origin_event_id=update.get("origin_event_id") or event.event_id,
            snapshot_kind="commit_snapshot",
            request_id=None,
            response_id=None,
            occurred=occurred,
        )


def _captured_mutation_line_count(change: dict[str, Any]) -> int:
    total = 0
    hunks = change.get("hunks") if isinstance(change.get("hunks"), list) else []
    for hunk in hunks:
        if not isinstance(hunk, dict):
            continue
        lines = hunk.get("lines") if isinstance(hunk.get("lines"), list) else []
        for line in lines:
            if not isinstance(line, dict):
                continue
            if _normalize_diff_line_type(line.get("line_type") or line.get("type")) in {"added", "removed"}:
                total += 1
    return total


def _payload_captured_mutation_line_count(payload: dict[str, Any]) -> int:
    cached = payload.get("_tinyai_captured_mutation_line_count")
    if isinstance(cached, int):
        return cached
    raw_files = payload.get("files")
    raw_changes = payload.get("changes")
    files = raw_files if isinstance(raw_files, list) else raw_changes if isinstance(raw_changes, list) else []
    total = 0
    for raw in files:
        if isinstance(raw, dict):
            total += _captured_mutation_line_count(raw)
            if total > PRODUCT_FULL_LINE_ATTRIBUTION_LIMIT:
                break
    payload["_tinyai_captured_mutation_line_count"] = total
    return total


def _apply_summary_only_commit_attribution(change: dict[str, Any], commit_file_path: str) -> dict[str, Any]:
    raw_added_total = int(change.get("lines_added") or 0)
    raw_deleted_total = int(change.get("lines_deleted") or 0)
    line_stats = change.get("line_stats") if isinstance(change.get("line_stats"), dict) else {}
    line_attribution_summary = {
        "file_path": commit_file_path,
        "total_added_lines": raw_added_total,
        "total_deleted_lines": raw_deleted_total,
        "raw_total_added_lines": raw_added_total,
        "raw_total_deleted_lines": raw_deleted_total,
        "ignored_blank_lines": 0,
        "ai_added_lines": 0,
        "human_added_lines": raw_added_total,
        "ai_deleted_lines": 0,
        "human_deleted_lines": raw_deleted_total,
        "ai_current_lines_added": 0,
        "human_current_lines_added": raw_added_total,
        "ai_assisted_human_edited_lines_added": 0,
        "ai_current_lines_deleted": 0,
        "human_current_lines_deleted": raw_deleted_total,
        "ai_origin_lines_deleted_by_human": 0,
        "ai_assisted_human_edited_lines_modified": 0,
        "human_current_lines_modified": 0,
        "ai_moved_lines": 0,
        "lines_modified": 0,
        "ai_lines_modified": 0,
        "human_lines_modified": 0,
        "captured_added_line_count": int(line_stats.get("captured_added_line_count") or 0),
        "captured_deleted_line_count": int(line_stats.get("captured_deleted_line_count") or 0),
        "full_line_attribution": False,
        "full_line_attribution_limit": PRODUCT_FULL_LINE_ATTRIBUTION_LIMIT,
        "sync_line_matching_skipped": True,
        "skip_reason": "captured_commit_diff_exceeds_sync_line_attribution_limit",
    }
    change.update(
        {
            "ai_lines_added": 0,
            "human_lines_added": raw_added_total,
            "ai_lines_deleted": 0,
            "human_lines_deleted": raw_deleted_total,
            "ai_current_lines_added": 0,
            "human_current_lines_added": raw_added_total,
            "ai_assisted_human_edited_lines_added": 0,
            "ai_current_lines_deleted": 0,
            "human_current_lines_deleted": raw_deleted_total,
            "ai_origin_lines_deleted_by_human": 0,
            "ai_assisted_human_edited_lines_modified": 0,
            "human_current_lines_modified": 0,
            "ai_moved_lines": 0,
            "lines_modified": 0,
            "ai_lines_modified": 0,
            "human_lines_modified": 0,
            "ai_added_ratio": _ratio_dict(0, raw_added_total),
            "ai_deleted_ratio": _ratio_dict(0, raw_deleted_total),
            "ai_modified_ratio": _ratio_dict(0, 0),
            "ai_overall_change_ratio": _ratio_dict(0, raw_added_total + raw_deleted_total),
            "ai_overall_change_ratio_raw_ops": _ratio_dict(0, raw_added_total + raw_deleted_total),
            "matched_ai_change_event_ids": [],
            "line_attribution": dict(line_attribution_summary),
            "line_attribution_summary": line_attribution_summary,
            "line_attribution_truncated": True,
            "ai_attribution_method": "commit_diff_summary_only_large_file",
            "product_detail_policy": "line_attribution_summary_only",
        }
    )
    for heavy_key in ("hunks", "changes", "patch", "diff"):
        change.pop(heavy_key, None)
    return change


def _apply_commit_ai_attribution(db: Session, event: EventIn, occurred: datetime, change: dict[str, Any]) -> dict[str, Any]:
    if event.event_type != "commit_snapshot":
        return change

    commit_file_path = _normalize_code_path(change.get("file_path"))
    declared_line_count = int(change.get("lines_added") or 0) + int(change.get("lines_deleted") or 0)
    keep_full_line_attribution = declared_line_count <= PRODUCT_FULL_LINE_ATTRIBUTION_LIMIT
    payload = event.payload if isinstance(event.payload, dict) else {}
    if (
        _captured_mutation_line_count(change) > PRODUCT_FULL_LINE_ATTRIBUTION_LIMIT
        or _payload_captured_mutation_line_count(payload) > PRODUCT_FULL_LINE_ATTRIBUTION_LIMIT
    ):
        return _apply_summary_only_commit_attribution(change, commit_file_path)
    scope = _line_scope_from_event(event, payload)
    ai_pool: dict[tuple[str, str, str, str], list[dict[str, Any]]] = {}
    for evidence in _matching_ai_evidence_rows(db, event, occurred):
        for line in _iter_ai_evidence_diff_lines(db, evidence):
            evidence_record = {
                "event_id": evidence.event_id,
                "request_id": evidence.request_id,
                "response_id": evidence.response_id,
                "snapshot_kind": evidence.snapshot_kind,
            }
            for key_type, key_value in _line_content_keys(line.get("text_hash"), line.get("text")):
                key = (line["file_path"], line["line_type"], key_type, key_value)
                ai_pool.setdefault(key, []).append(evidence_record)

    ai_added = ai_deleted = human_added = human_deleted = 0
    ai_current_added = ai_current_deleted = 0
    human_current_added = human_current_deleted = 0
    ai_assisted_human_edited_added = 0
    ai_origin_deleted_by_human = 0
    matched_events: set[str] = set()
    hunk_summaries: list[dict[str, Any]] = []
    attributed_hunks: list[dict[str, Any]] = []
    ledger_updates: list[dict[str, Any]] = []
    ledger_content_pool = _line_attr_content_pool(db, scope, commit_file_path)
    ledger_rows_for_file = _line_attr_rows_for_file(db, scope, commit_file_path)
    consumed_ledger_ids: set[int] = set()
    moved_added_counter: Counter[tuple[str, str]] = Counter()

    hunks = change.get("hunks") if isinstance(change.get("hunks"), list) else []
    for hunk in hunks:
        if not isinstance(hunk, dict):
            continue
        for line in hunk.get("lines") if isinstance(hunk.get("lines"), list) else []:
            if not isinstance(line, dict):
                continue
            if _normalize_diff_line_type(line.get("line_type") or line.get("type")) != "added":
                continue
            text_hash = _line_text_hash(commit_file_path, line)
            keys = _line_content_keys(text_hash, line.get("text"))
            if keys:
                moved_added_counter[keys[-1]] += 1

    for hunk_index, hunk in enumerate(hunks):
        if not isinstance(hunk, dict):
            continue
        lines = hunk.get("lines") if isinstance(hunk.get("lines"), list) else []
        has_removed_lines = any(
            isinstance(candidate, dict)
            and _normalize_diff_line_type(candidate.get("line_type") or candidate.get("type")) == "removed"
            for candidate in lines
        )
        aligned_added_rows: dict[int, AiLineAttribution] = {}
        has_aligned_insertions = False
        if not has_removed_lines:
            aligned_added_rows, has_aligned_insertions = _align_added_lines_to_ledger(lines, ledger_rows_for_file)
        hunk_counts = {
            "added": 0,
            "removed": 0,
            "ai_added": 0,
            "ai_removed": 0,
            "human_added": 0,
            "human_removed": 0,
            "ai_assisted_human_edited_added": 0,
            "ai_origin_deleted_by_human": 0,
            "ai_moved": 0,
            "ignored_blank": 0,
        }
        attributed_lines: list[dict[str, Any]] = []
        for line_index, line in enumerate(lines):
            if not isinstance(line, dict):
                continue
            line_type = _normalize_diff_line_type(line.get("line_type") or line.get("type"))
            if line_type not in {"added", "removed"}:
                if keep_full_line_attribution:
                    attributed_lines.append(line)
                continue
            if _line_is_blank(line.get("text")):
                hunk_counts["ignored_blank"] += 1
                if keep_full_line_attribution:
                    attributed_line = {
                        "line_type": line_type,
                        "old_line": line.get("old_line"),
                        "new_line": line.get("new_line"),
                        "text_hash": _line_text_hash(commit_file_path, line),
                        "attribution": "ignored",
                        "origin_author": "none",
                        "last_editor": "none",
                        "classification": "ignored_blank_line",
                        "matched_ai_event_id": None,
                        "hunk_index": hunk_index,
                        "line_index": line_index,
                    }
                    if line.get("text") is not None:
                        attributed_line["text"] = line.get("text")
                    attributed_lines.append(attributed_line)
                continue
            text_hash = _line_text_hash(commit_file_path, line)
            matched = None
            for key_type, key_value in _line_content_keys(text_hash, line.get("text")):
                matched = ai_pool.get((commit_file_path, line_type, key_type, key_value))
                if matched:
                    break
            evidence = matched.pop(0) if matched else None
            line_no = _line_number(line, line_type)
            ledger = aligned_added_rows.get(line_index) if line_type == "added" else None
            if ledger and ledger.id:
                consumed_ledger_ids.add(ledger.id)
            elif not (line_type == "added" and has_aligned_insertions):
                ledger = _find_line_attr(db, scope, commit_file_path, line_no) if line_no else None
                if ledger and ledger.id:
                    consumed_ledger_ids.add(ledger.id)
            if not ledger and line_type == "added":
                ledger = _consume_line_attr_by_content(
                    ledger_content_pool,
                    consumed_ledger_ids,
                    text_hash,
                    line.get("text"),
                    line_no,
                )
            attribution = "ai" if evidence else "human"
            classification = "ai_current" if evidence else "human_current"
            origin_author = "ai" if evidence else "human"
            last_editor = "ai" if evidence else "human"
            origin_event_id = evidence.get("event_id") if evidence else None
            matched_event_id = evidence.get("event_id") if evidence else None
            if not evidence and ledger:
                origin_author = ledger.origin_author or "unknown"
                origin_event_id = ledger.origin_event_id
                same_current_text = bool(
                    _line_attr_matches(ledger, text_hash, line.get("text"))
                )
                if line_type == "added" and ledger.origin_author == "ai" and not same_current_text:
                    classification = "ai_assisted_human_edited"
                    last_editor = "human"
                    attribution = "human"
                    matched_event_id = ledger.last_event_id
                elif line_type == "added" and ledger.last_editor == "ai" and same_current_text:
                    classification = "ai_current"
                    last_editor = "ai"
                    attribution = "ai"
                    evidence = {"event_id": ledger.last_event_id, "source": "line_attribution_ledger"}
                    matched_event_id = ledger.last_event_id
                elif line_type == "removed" and ledger.origin_author == "ai":
                    move_key = (_line_content_keys(text_hash, line.get("text")) or [("", "")])[-1]
                    if moved_added_counter.get(move_key, 0) > 0:
                        moved_added_counter[move_key] -= 1
                        classification = "ai_current_moved"
                        last_editor = ledger.last_editor or "ai"
                        attribution = "ai"
                        hunk_counts["ai_moved"] += 1
                    else:
                        classification = "human_removed_ai_origin"
                        last_editor = "human"
                        attribution = "human"
                    matched_event_id = ledger.last_event_id
            attributed_line = {
                "line_type": line_type,
                "old_line": line.get("old_line"),
                "new_line": line.get("new_line"),
                "text_hash": text_hash,
                "attribution": attribution,
                "origin_author": origin_author,
                "last_editor": last_editor,
                "classification": classification,
                "matched_ai_event_id": matched_event_id,
                "hunk_index": hunk_index,
                "line_index": line_index,
            }
            if line.get("text") is not None:
                attributed_line["text"] = line.get("text")
            if keep_full_line_attribution:
                attributed_lines.append(attributed_line)
            if line_type == "added":
                hunk_counts["added"] += 1
                if attribution == "ai":
                    ai_added += 1
                    ai_current_added += 1
                    hunk_counts["ai_added"] += 1
                else:
                    human_added += 1
                    hunk_counts["human_added"] += 1
                    if classification == "ai_assisted_human_edited":
                        ai_assisted_human_edited_added += 1
                        hunk_counts["ai_assisted_human_edited_added"] += 1
                    else:
                        human_current_added += 1
                if line_no and _line_is_trackable(line.get("text")):
                    ledger_updates.append(
                        {
                            "action": "upsert",
                            "file_path": commit_file_path,
                            "line_no": line_no,
                            "move_from_line_no": ledger.line_no if ledger and ledger.line_no != line_no else None,
                            "text_hash": text_hash,
                            "text_preview": _line_text_preview(line),
                            "origin_author": origin_author if origin_author in {"ai", "human"} else ("ai" if attribution == "ai" else "human"),
                            "last_editor": last_editor,
                            "classification": classification,
                            "origin_event_id": origin_event_id or (event.event_id if attribution == "human" else matched_event_id),
                        }
                    )
            else:
                hunk_counts["removed"] += 1
                if attribution == "ai":
                    ai_deleted += 1
                    ai_current_deleted += 1
                    hunk_counts["ai_removed"] += 1
                else:
                    human_deleted += 1
                    hunk_counts["human_removed"] += 1
                    if classification == "human_removed_ai_origin":
                        ai_origin_deleted_by_human += 1
                        hunk_counts["ai_origin_deleted_by_human"] += 1
                    else:
                        human_current_deleted += 1
                if line_no:
                    ledger_updates.append({"action": "delete", "file_path": commit_file_path, "line_no": line_no})
            if evidence and evidence.get("event_id"):
                matched_events.add(str(evidence["event_id"]))
        hunk_summaries.append(hunk_counts)
        attributed_hunk = {
            "old_start": hunk.get("old_start"),
            "old_lines": hunk.get("old_lines"),
            "new_start": hunk.get("new_start"),
            "new_lines": hunk.get("new_lines"),
            "counts": hunk_counts,
        }
        if keep_full_line_attribution:
            attributed_hunk["lines"] = attributed_lines
        attributed_hunks.append(attributed_hunk)

    raw_added_total = int(change.get("lines_added") or 0)
    raw_deleted_total = int(change.get("lines_deleted") or 0)
    added_total = ai_added + human_added
    deleted_total = ai_deleted + human_deleted
    modified_counts = _derive_hunk_modified_counts(hunk_summaries)
    ai_assisted_human_edited_modified = 0
    human_current_modified = 0
    for hunk in hunk_summaries:
        ai_assisted_human_edited_modified += min(hunk["ai_assisted_human_edited_added"], hunk["human_removed"])
        human_current_modified += min(hunk["human_added"] - hunk["ai_assisted_human_edited_added"], hunk["human_removed"])
    ai_moved_lines = sum(int(hunk.get("ai_moved", 0)) for hunk in hunk_summaries)
    total_raw_ops = added_total + deleted_total
    ai_raw_ops = ai_added + ai_deleted
    line_attribution_summary = {
        "file_path": commit_file_path,
        "total_added_lines": added_total,
        "total_deleted_lines": deleted_total,
        "raw_total_added_lines": raw_added_total,
        "raw_total_deleted_lines": raw_deleted_total,
        "ignored_blank_lines": sum(int(hunk.get("ignored_blank", 0)) for hunk in hunk_summaries),
        "ai_added_lines": ai_added,
        "human_added_lines": human_added,
        "ai_deleted_lines": ai_deleted,
        "human_deleted_lines": human_deleted,
        "ai_current_lines_added": ai_current_added,
        "human_current_lines_added": human_current_added,
        "ai_assisted_human_edited_lines_added": ai_assisted_human_edited_added,
        "ai_current_lines_deleted": ai_current_deleted,
        "human_current_lines_deleted": human_current_deleted,
        "ai_origin_lines_deleted_by_human": ai_origin_deleted_by_human,
        "ai_assisted_human_edited_lines_modified": ai_assisted_human_edited_modified,
        "human_current_lines_modified": human_current_modified,
        "ai_moved_lines": ai_moved_lines,
        **modified_counts,
        "hunk_count": len(hunk_summaries),
        "full_line_attribution": keep_full_line_attribution,
        "full_line_attribution_limit": PRODUCT_FULL_LINE_ATTRIBUTION_LIMIT,
    }
    line_attribution = dict(line_attribution_summary)
    if keep_full_line_attribution:
        line_attribution["hunks"] = attributed_hunks
    change.update(
        {
            "ai_lines_added": ai_added,
            "human_lines_added": human_added,
            "ai_lines_deleted": ai_deleted,
            "human_lines_deleted": human_deleted,
            "ai_current_lines_added": ai_current_added,
            "human_current_lines_added": human_current_added,
            "ai_assisted_human_edited_lines_added": ai_assisted_human_edited_added,
            "ai_current_lines_deleted": ai_current_deleted,
            "human_current_lines_deleted": human_current_deleted,
            "ai_origin_lines_deleted_by_human": ai_origin_deleted_by_human,
            "ai_assisted_human_edited_lines_modified": ai_assisted_human_edited_modified,
            "human_current_lines_modified": human_current_modified,
            "ai_moved_lines": ai_moved_lines,
            **modified_counts,
            "ai_added_ratio": _ratio_dict(ai_added, added_total),
            "ai_deleted_ratio": _ratio_dict(ai_deleted, deleted_total),
            "ai_modified_ratio": _ratio_dict(modified_counts["ai_lines_modified"], modified_counts["lines_modified"]),
            "ai_overall_change_ratio": _ratio_dict(ai_raw_ops, total_raw_ops),
            "ai_overall_change_ratio_raw_ops": _ratio_dict(ai_raw_ops, total_raw_ops),
            "matched_ai_change_event_ids": sorted(matched_events),
            "line_attribution": line_attribution,
            "line_attribution_summary": line_attribution_summary,
            "line_attribution_truncated": not keep_full_line_attribution,
            "ai_attribution_method": "commit_diff_line_ledger_and_text_hash_evidence",
        }
    )
    change["_line_ledger_updates"] = ledger_updates
    if not keep_full_line_attribution:
        for heavy_key in ("hunks", "changes", "patch", "diff"):
            change.pop(heavy_key, None)
        change["product_detail_policy"] = "line_attribution_summary_only"
    return change


def _enqueue_line_attribution_job(db: Session, code_change: AiCodeChange) -> None:
    if code_change.id is None:
        db.flush()
    if db.execute(select(LineAttributionJob).where(LineAttributionJob.code_change_id == code_change.id)).scalar_one_or_none():
        return
    settings = get_settings()
    db.add(
        LineAttributionJob(
            code_change_id=code_change.id,
            event_id=code_change.event_id,
            session_id=code_change.session_id,
            task_id=code_change.task_id,
            snapshot_kind=code_change.snapshot_kind,
            file_path=(code_change.file_path or "")[:1024] if code_change.file_path else None,
            status="pending",
            attempts=0,
            max_attempts=max(1, settings.ingest_job_max_attempts),
            next_run_at=_local_now(),
        )
    )


def _upsert_ai_code_changes(db: Session, event: EventIn, session_id: str, normalized: dict[str, Any], turns: list[AiTurn]) -> None:
    raw_changes = normalized.get("code_changes")
    if not isinstance(raw_changes, list) or not raw_changes:
        return
    db.execute(delete(AiCodeChange).where(AiCodeChange.event_id == event.event_id))
    for change in raw_changes:
        if not isinstance(change, dict):
            continue
        occurred = _parse_time(change.get("occurred_at"), event.occurred_at)
        change = _apply_commit_ai_attribution(db, event, occurred, change)
        change = _summarize_large_code_change(change)
        turn = _turn_for_change(turns, change, occurred)
        request_id = str(change.get("request_id") or (turn.request_id if turn else "") or "")[:256] or None
        response_id = str(change.get("response_id") or (turn.response_id if turn else "") or "")[:256] or None
        snapshot_kind = str(change.get("snapshot_kind") or change.get("change_type") or event.event_type or "")[:64] or None
        diff_json = {key: value for key, value in change.items() if key not in {"raw_json", "raw_path", "_line_ledger_updates"}}
        row = AiCodeChange(
            session_id=session_id,
            task_id=event.task_id,
            turn_id=turn.id if turn else None,
            turn_index=turn.turn_index if turn else None,
            request_id=request_id,
            response_id=response_id,
            event_id=event.event_id,
            file_path=_normalize_code_path(change.get("file_path")) or None,
            change_type=str(change.get("change_type") or "code_change")[:64],
            snapshot_kind=snapshot_kind,
            diff_hash=str(change.get("diff_hash") or "")[:128] or None,
            lines_added=int(change.get("lines_added") or 0),
            lines_deleted=int(change.get("lines_deleted") or 0),
            is_effective=True,
            diff_json=diff_json,
            occurred_at=occurred,
        )
        db.add(row)
        db.flush()
        _enqueue_line_attribution_job(db, row)
    _refresh_effective_code_changes(db, session_id, event.task_id)


def _is_mutable_code_change(change: AiCodeChange) -> bool:
    payload = _code_change_payload(change)
    snapshot_kind = str(change.snapshot_kind or payload.get("snapshot_kind") or change.change_type or "").lower()
    event_type = str(payload.get("event_type") or "").lower()
    if snapshot_kind in {"commit_snapshot", "push_snapshot", "ai_line_snapshot", "adoption_snapshot"}:
        return False
    if event_type in {"commit_snapshot", "push_snapshot", "ai_line_snapshot", "adoption_snapshot"}:
        return False
    return snapshot_kind in MUTABLE_CODE_SNAPSHOT_KINDS or event_type == "code_change"


def _code_change_payload(change: AiCodeChange) -> dict[str, Any]:
    return change.diff_json if isinstance(change.diff_json, dict) else {}


def _code_effective_file_path(change: AiCodeChange) -> str:
    file_path = str(change.file_path or _code_change_payload(change).get("file_path") or "__workspace__").replace("\\", "/")
    marker = "openspec/specs/"
    marker_index = file_path.find(marker)
    if marker_index >= 0:
        return file_path[marker_index:]
    return file_path


def _code_effective_key(change: AiCodeChange) -> tuple[str, str]:
    unit_parts = [str(change.session_id or "unknown_session")]
    if change.task_id:
        unit_parts.append(str(change.task_id))
    unit = ":".join(unit_parts)
    file_path = _code_effective_file_path(change)
    return (unit, file_path)


def _code_snapshot_priority(change: AiCodeChange) -> int:
    snapshot_kind = str(change.snapshot_kind or _code_change_payload(change).get("snapshot_kind") or change.change_type or "").lower()
    priorities = {
        "copilot_turn_workspace_diff": 30,
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


def _refresh_effective_code_changes(db: Session, session_id: str, task_id: str | None) -> None:
    scope = or_(
        AiCodeChange.session_id == session_id,
        AiCodeChange.task_id == task_id if task_id else False,
    )
    rows = db.execute(select(AiCodeChange).where(scope).order_by(AiCodeChange.occurred_at.asc(), AiCodeChange.id.asc())).scalars().all()
    groups: dict[tuple[str, str], list[AiCodeChange]] = {}
    for row in rows:
        row.is_effective = True
        row.superseded_by_event_id = None
        snapshot_kind = str(row.snapshot_kind or _code_change_payload(row).get("snapshot_kind") or row.change_type or "").lower()
        if snapshot_kind in PROPOSED_ONLY_CODE_SNAPSHOT_KINDS:
            row.is_effective = False
            continue
        if not _is_mutable_code_change(row):
            continue
        groups.setdefault(_code_effective_key(row), []).append(row)

    for group_rows in groups.values():
        if not group_rows:
            continue
        latest = sorted(group_rows, key=lambda item: (_code_snapshot_priority(item), item.occurred_at, item.id))[-1]
        for row in group_rows:
            if row.id == latest.id:
                row.is_effective = True
                row.superseded_by_event_id = None
            else:
                row.is_effective = False
                row.superseded_by_event_id = latest.event_id


def _upsert_ai_spec_accesses(db: Session, event: EventIn, session_id: str, normalized: dict[str, Any], turns: list[AiTurn]) -> None:
    raw_accesses = normalized.get("spec_accesses")
    if not isinstance(raw_accesses, list) or not raw_accesses:
        return
    db.execute(delete(AiSpecAccess).where(AiSpecAccess.event_id == event.event_id))
    for access in raw_accesses:
        if not isinstance(access, dict):
            continue
        occurred = _parse_time(access.get("occurred_at"), event.occurred_at)
        turn = _turn_for_time(turns, occurred)
        db.add(
            AiSpecAccess(
                session_id=session_id,
                task_id=event.task_id,
                turn_id=turn.id if turn else None,
                turn_index=turn.turn_index if turn else None,
                event_id=event.event_id,
                spec_scope=str(access.get("spec_scope") or "unknown")[:32],
                doc_path=str(access.get("doc_path")) if access.get("doc_path") else None,
                access_type=str(access.get("access_type"))[:16] if access.get("access_type") else None,
                access_source=str(access.get("access_source"))[:64] if access.get("access_source") else None,
                matched_doc_count=int(access.get("matched_doc_count") or 0),
                matched_docs=access.get("matched_docs") if isinstance(access.get("matched_docs"), list) else None,
                via_catalog=bool(access.get("via_catalog")),
                matched_by=access.get("matched_by") if isinstance(access.get("matched_by"), list) else None,
                confidence=str(access.get("confidence") or event.source_confidence)[:24],
                occurred_at=occurred,
            )
        )


def _upsert_ai_spec_documents(db: Session, event: EventIn, payload: dict[str, Any], normalized: dict[str, Any]) -> None:
    raw_documents = normalized.get("spec_documents")
    if not isinstance(raw_documents, list) or not raw_documents:
        return

    workspace_hash = event.workspace_path_hash or str(payload.get("workspace_path_hash") or "")
    client_id = str(payload.get("client_id") or "")[:128] or None
    now = _parse_time(None, event.occurred_at)
    for document in raw_documents:
        if not isinstance(document, dict):
            continue
        doc_path = str(document.get("doc_path") or "").strip()
        if not doc_path:
            continue
        row = db.execute(
            select(AiSpecDocument).where(
                AiSpecDocument.workspace_path_hash == (workspace_hash or None),
                AiSpecDocument.doc_path == doc_path,
            )
        ).scalar_one_or_none()
        if row is None:
            row = AiSpecDocument(
                workspace_path_hash=workspace_hash or None,
                doc_path=doc_path,
                first_seen_at=now,
            )
            db.add(row)
        row.client_id = client_id
        row.username = event.username
        row.user_id = event.user_id
        row.machine_id = event.machine_id
        row.host_hash = event.host_hash
        row.spec_scope = str(document.get("spec_scope") or "project")[:32]
        row.file_name = str(document.get("file_name") or doc_path.rsplit("/", 1)[-1])[:256]
        row.size_bytes = int(document.get("size_bytes") or 0)
        row.line_count = int(document.get("line_count") or 0)
        row.content_hash = str(document.get("content_hash") or "")[:64] or None
        try:
            row.mtime_ms = float(document.get("mtime_ms")) if document.get("mtime_ms") is not None else None
        except (TypeError, ValueError):
            row.mtime_ms = None
        row.exists = bool(document.get("exists", True))
        row.metadata_json = document.get("metadata_json") if isinstance(document.get("metadata_json"), dict) else document
        row.source_event_id = event.event_id
        row.last_seen_at = now


def _upsert_ai_request_usage(
    db: Session,
    event: EventIn,
    session_id: str,
    normalized: dict[str, Any],
    turns_by_index: dict[int, AiTurn],
) -> None:
    raw_usage = normalized.get("request_usage")
    if not isinstance(raw_usage, list):
        return
    for usage in raw_usage:
        if not isinstance(usage, dict):
            continue
        request_id = str(usage.get("request_id") or "").strip()[:256]
        if not request_id:
            continue
        request_index = int(usage.get("request_index") or 0)
        turn_index = int(usage.get("turn_index") or request_index + 1)
        turn = None
        for candidate in turns_by_index.values():
            if candidate.request_id == request_id:
                turn = candidate
                break
        if turn is None:
            turn = turns_by_index.get(turn_index)
        existing = (
            db.execute(
                select(AiRequestUsage)
                .where(AiRequestUsage.session_id == session_id)
                .where(AiRequestUsage.request_id == request_id)
            )
            .scalar_one_or_none()
        )
        row = existing or AiRequestUsage(
            session_id=session_id,
            task_id=event.task_id,
            request_id=request_id,
            request_index=request_index,
        )
        row.task_id = row.task_id or event.task_id
        row.request_index = request_index
        row.turn_index = turn.turn_index if turn else turn_index
        row.turn_id = turn.id if turn else row.turn_id
        for field in ("model", "prompt_tokens", "output_tokens", "completion_tokens", "elapsed_ms", "copilot_credits", "credits_source"):
            value = usage.get(field)
            if value is not None:
                setattr(row, field, value)
        if usage.get("occurred_at"):
            row.occurred_at = _parse_time(usage.get("occurred_at"), event.occurred_at)
        row.raw_event_id = event.event_id
        row.raw_path = str(usage.get("raw_path") or "")[:512] or None
        if not existing:
            db.add(row)


def _upsert_ai_product_tables(db: Session, event: EventIn, payload: dict[str, Any], normalized: dict[str, Any]) -> None:
    session = _upsert_ai_session(db, event, payload, normalized)
    session_id = session.session_id
    if event.event_type == "turn_snapshot":
        db.execute(delete(AiMessage).where(AiMessage.raw_event_id == event.event_id))
        db.execute(delete(AiProcessStep).where(AiProcessStep.raw_event_id == event.event_id))
    raw_messages = normalized.get("messages")
    messages = [item for item in raw_messages if isinstance(item, dict)] if isinstance(raw_messages, list) else []
    turns_by_index: dict[int, AiTurn] = {
        turn.turn_index: turn
        for turn in db.execute(select(AiTurn).where(AiTurn.session_id == session_id)).scalars().all()
    }
    normalized_turns = normalized.get("turns")
    turn_status_by_request: dict[str, str] = {}
    turn_status_by_index: dict[int, str] = {}
    if isinstance(normalized_turns, list):
        for turn_data in normalized_turns:
            if not isinstance(turn_data, dict):
                continue
            turn_index = int(turn_data.get("turn_index") or 0)
            if turn_index <= 0:
                continue
            request_id = str(turn_data.get("request_id") or "")[:256] or None
            response_id = str(turn_data.get("response_id") or "")[:256] or None
            turn_status = _normalized_turn_status(turn_data.get("status"))
            if request_id:
                turn_status_by_request[request_id] = turn_status
            turn_status_by_index[turn_index] = turn_status
            created_at = _parse_time(turn_data.get("started_at"), event.occurred_at)
            turn = _upsert_turn(
                db,
                session_id,
                event.task_id,
                turn_index,
                created_at,
                request_id,
                response_id,
                tool=event.tool,
                status=turn_status,
            )
            if _is_open_turn_status(turn_status):
                if turn.completed_at is None:
                    turn.status = turn_status
            elif turn_data.get("completed_at"):
                turn.completed_at = _parse_time(turn_data.get("completed_at"), event.occurred_at)
                turn.status = turn_status or "completed"
            turns_by_index[turn.turn_index] = turn

    current_turn: AiTurn | None = None
    current_turn_index = 0
    for message in messages:
        role = str(message.get("role") or "message")
        occurred = _parse_time(message.get("occurred_at"), event.occurred_at)
        explicit_turn_index = message.get("turn_index") if isinstance(message.get("turn_index"), int) else None
        message_request_id = str(message.get("request_id") or "")[:256] or None
        message_response_id = str(message.get("response_id") or "")[:256] or None
        if explicit_turn_index:
            current_turn_index = explicit_turn_index
            current_turn = None
            if message_request_id:
                for candidate in turns_by_index.values():
                    if candidate.request_id != message_request_id:
                        continue
                    if message_response_id and candidate.response_id and candidate.response_id != message_response_id:
                        continue
                    current_turn = candidate
                    break
            if current_turn is None and not message_request_id:
                current_turn = turns_by_index.get(current_turn_index)
            if current_turn is None:
                current_turn = _upsert_turn(
                    db,
                    session_id,
                    event.task_id,
                    current_turn_index,
                    occurred,
                    message_request_id,
                    message_response_id,
                    tool=event.tool,
                    status=turn_status_by_request.get(message_request_id or "") or turn_status_by_index.get(current_turn_index),
                )
                turns_by_index[current_turn.turn_index] = current_turn
        elif role == "user":
            current_turn_index += 1
            current_turn = _upsert_turn(
                db,
                session_id,
                event.task_id,
                current_turn_index,
                occurred,
                tool=event.tool,
                status=turn_status_by_index.get(current_turn_index),
            )
            turns_by_index[current_turn.turn_index] = current_turn
        elif current_turn is None and current_turn_index > 0:
            current_turn = turns_by_index.get(current_turn_index)

        if current_turn:
            message["turn_index"] = current_turn.turn_index
        row = _upsert_ai_message(db, event, session_id, message, current_turn)
        if current_turn and role == "user":
            current_turn.user_message_id = row.id
            if current_turn.completed_at is None:
                current_turn.status = "in_progress"
        elif current_turn and role == "assistant":
            current_turn.assistant_message_id = row.id
            turn_status = turn_status_by_request.get(current_turn.request_id or "") or turn_status_by_index.get(current_turn.turn_index)
            if current_turn.completed_at is None and not _is_open_turn_status(turn_status):
                current_turn.completed_at = occurred
            if not _is_open_turn_status(turn_status):
                current_turn.status = "completed"

    turns = list(turns_by_index.values())
    _upsert_ai_request_usage(db, event, session_id, normalized, turns_by_index)
    _upsert_ai_process_steps(db, event, session_id, normalized, turns)
    _upsert_ai_code_changes(db, event, session_id, normalized, turns)
    _upsert_ai_spec_accesses(db, event, session_id, normalized, turns)
    _upsert_ai_spec_documents(db, event, payload, normalized)


def _normalize_and_upsert_event(db: Session, event: EventIn, payload: dict[str, Any]) -> None:
    if event.event_type == "turn_snapshot":
        normalized = normalize_event(event, payload)
        _insert_normalized_event(db, event, _compact_normalized_for_storage(normalized))
        db.flush()
    else:
        try:
            normalized = normalize_event(event, payload)
            _insert_normalized_event(db, event, _compact_normalized_for_storage(normalized))
            db.flush()
        except Exception as error:
            normalized = {
                "schema_version": "conversation.normalized.v1",
                "tool": event.tool,
                "event_type": event.event_type,
                "session": {"session_id": _product_session_id(event, payload), "task_id": event.task_id},
                "messages": [],
                "process_steps": [],
                "code_changes": [],
                "spec_accesses": [],
                "warnings": ["normalizer failed"],
            }
            _insert_normalized_event(db, event, normalized, parse_status="failed", error=str(error))
            db.flush()
    _upsert_ai_product_tables(db, event, payload, normalized)


def _conversation_signature(payload: dict[str, Any] | None) -> str | None:
    if not isinstance(payload, dict):
        return None
    existing = payload.get("message_signature")
    usage_signature = payload.get("usage_signature")
    if isinstance(existing, str) and existing:
        if isinstance(usage_signature, str) and usage_signature:
            return hashlib.sha256(f"{existing}:{usage_signature}".encode("utf-8")).hexdigest()
        return existing
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return None

    compact_messages: list[list[str]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "message")
        text_hash = message.get("text_hash")
        if not isinstance(text_hash, str) or not text_hash:
            text = message.get("text")
            text_hash = hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()
        compact_messages.append([role, text_hash])
    if not compact_messages:
        return None
    body = json.dumps(compact_messages, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _process_signature(payload: dict[str, Any] | None) -> str | None:
    if not isinstance(payload, dict):
        return None
    existing = payload.get("process_signature")
    if isinstance(existing, str) and existing:
        return existing
    steps = payload.get("process_steps")
    if not isinstance(steps, list):
        return None

    compact_steps: list[list[str]] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        kind = str(step.get("kind") or "step")
        text_hash = step.get("text_hash")
        if not isinstance(text_hash, str) or not text_hash:
            text = step.get("text")
            text_hash = hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()
        compact_steps.append([kind, text_hash, str(step.get("tool_name") or ""), str(step.get("status") or "")])
    if not compact_steps:
        return None
    body = json.dumps(compact_steps, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _semantic_duplicate_exists(db: Session, event: EventIn, payload: dict[str, Any]) -> bool:
    if event.event_type == "conversation_snapshot":
        signature = _conversation_signature(payload)
    elif event.event_type == "agent_process_snapshot":
        signature = _process_signature(payload)
    else:
        return False
    if not signature:
        return False

    session_id = _event_session_id(event)
    scope = RawIngestEvent.session_id == session_id if session_id else RawIngestEvent.task_id == event.task_id
    existing_events = (
        db.execute(
            select(RawIngestEvent)
            .where(scope)
            .where(RawIngestEvent.event_type == event.event_type)
            .where(RawIngestEvent.event_id != event.event_id)
            .order_by(RawIngestEvent.occurred_at.desc())
            .limit(100)
        )
        .scalars()
        .all()
    )
    signature_fn = _conversation_signature if event.event_type == "conversation_snapshot" else _process_signature
    for existing in existing_events:
        raw_json = existing.raw_json if isinstance(existing.raw_json, dict) else {}
        raw_event = raw_json.get("event") if isinstance(raw_json.get("event"), dict) else {}
        existing_payload = raw_event.get("payload") if isinstance(raw_event.get("payload"), dict) else {}
        if signature_fn(existing_payload) == signature:
            return True
    return False


def _sanitize_visible_reasoning(event: EventIn, payload: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    sanitized = dict(payload)
    if event.event_type == "agent_activity":
        kind = str(sanitized.get("activity_kind") or "").lower()
        if kind in {"visible_reasoning", "reasoning", "thinking"}:
            sanitized["reasoning_visibility"] = "visible_or_persisted"
            sanitized["capture_scope"] = "not_internal_chain_of_thought"
        return True, sanitized

    if event.event_type != "agent_process_snapshot":
        return True, sanitized

    raw_steps = sanitized.get("process_steps")
    if isinstance(raw_steps, list):
        tagged_steps: list[dict[str, Any]] = []
        for step in raw_steps:
            if not isinstance(step, dict):
                continue
            tagged = dict(step)
            kind = str(step.get("kind") or step.get("activity_kind") or step.get("step_type") or "").lower()
            if kind in {"visible_reasoning", "reasoning", "thinking"}:
                tagged["reasoning_visibility"] = "visible_or_persisted"
                tagged["capture_scope"] = "not_internal_chain_of_thought"
            tagged_steps.append(tagged)
        sanitized["process_steps"] = tagged_steps
        sanitized["process_step_count"] = len(tagged_steps)
    return True, sanitized


def ingest_batch(db: Session, batch: BatchIn) -> dict:
    _cleanup_ingest_history_if_due(db)
    if not _is_install_smoke_batch(batch):
        _upsert_plugin(db, batch, throttle_heartbeat=_batch_is_plugin_heartbeat_only(batch))
    accepted = 0
    duplicates = 0
    failed = 0
    event_results: list[dict[str, str | None]] = []
    task_ids: set[str] = set()

    for event in batch.events:
        task_ids.add(event.task_id)
        if event.event_type == "push_snapshot":
            duplicates += 1
            event_results.append({"event_id": event.event_id, "event_type": event.event_type, "status": "duplicate", "reason": "push_snapshot_disabled"})
            continue
        payload, raw_blobs = _extract_raw_event_blobs(dict(event.payload or {}))
        payload.setdefault("client_id", batch.client_id)
        payload.setdefault("plugin_name", batch.plugin_name)
        payload.setdefault("plugin_version", batch.plugin_version)
        if event.event_type == "plugin_heartbeat":
            heartbeat_inserted, heartbeat_reason = _insert_plugin_heartbeat(db, batch, event, payload)
            if heartbeat_inserted:
                accepted += 1
                event_results.append({"event_id": event.event_id, "event_type": event.event_type, "status": "accepted", "reason": None})
            else:
                duplicates += 1
                event_results.append({"event_id": event.event_id, "event_type": event.event_type, "status": "duplicate", "reason": heartbeat_reason or "heartbeat_duplicate"})
            continue

        if db.get(RawIngestEvent, event.event_id):
            duplicates += 1
            event_results.append({"event_id": event.event_id, "event_type": event.event_type, "status": "duplicate", "reason": "event_id_exists"})
            continue
        should_ingest, payload = _sanitize_visible_reasoning(event, payload)
        if not should_ingest:
            duplicates += 1
            event_results.append({"event_id": event.event_id, "event_type": event.event_type, "status": "duplicate", "reason": "not_ingested"})
            continue
        if event.event_type == "conversation_snapshot":
            signature = _conversation_signature(payload)
            if signature:
                payload.setdefault("message_signature", signature)
            if _semantic_duplicate_exists(db, event, payload):
                duplicates += 1
                event_results.append({"event_id": event.event_id, "event_type": event.event_type, "status": "duplicate", "reason": "semantic_duplicate"})
                continue
        elif event.event_type == "agent_process_snapshot":
            signature = _process_signature(payload)
            if signature:
                payload.setdefault("process_signature", signature)
            if _semantic_duplicate_exists(db, event, payload):
                duplicates += 1
                event_results.append({"event_id": event.event_id, "event_type": event.event_type, "status": "duplicate", "reason": "semantic_duplicate"})
                continue
        if not _insert_raw_ingest_event(db, batch, event, payload):
            duplicates += 1
            event_results.append({"event_id": event.event_id, "event_type": event.event_type, "status": "duplicate", "reason": "event_id_exists"})
            continue
        db.flush()
        _insert_raw_event_blobs(db, event.event_id, raw_blobs)
        payload_for_normalization = _rehydrate_blob_refs(payload, _decode_inline_blobs(raw_blobs)) if raw_blobs else payload
        event_for_normalization = event.model_copy(update={"payload": payload_for_normalization})
        if get_settings().ingest_async_normalization:
            _enqueue_ingest_job(db, event)
        else:
            _normalize_and_upsert_event(db, event_for_normalization, payload_for_normalization)
        accepted += 1
        event_results.append({"event_id": event.event_id, "event_type": event.event_type, "status": "accepted", "reason": None})

    db.commit()
    return {"accepted": accepted, "duplicates": duplicates, "failed": failed, "task_count": len(task_ids), "events": event_results}


def _safe_job_error(error: Exception) -> str:
    return f"{error.__class__.__name__}: normalization failed"


def _claim_pending_ingest_jobs(db: Session, limit: int, worker_id: str) -> list[IngestJob]:
    settings = get_settings()
    now = _local_now()
    stale_before = now - timedelta(seconds=max(30, settings.ingest_job_lock_timeout_seconds))
    query = (
        select(IngestJob)
        .where(
            or_(
                (IngestJob.status == "pending") & (IngestJob.next_run_at <= now),
                (IngestJob.status == "processing") & (IngestJob.locked_at < stale_before),
            )
        )
        .order_by(IngestJob.next_run_at.asc(), IngestJob.id.asc())
        .limit(limit)
    )
    try:
        query = query.with_for_update(skip_locked=True)
    except TypeError:
        query = query.with_for_update()
    jobs = db.execute(query).scalars().all()
    for job in jobs:
        job.status = "processing"
        job.locked_at = now
        job.locked_by = worker_id[:128]
        job.attempts += 1
        job.last_error = None
    db.commit()
    return jobs


def _claim_pending_line_attribution_jobs(db: Session, limit: int, worker_id: str) -> list[LineAttributionJob]:
    settings = get_settings()
    now = _local_now()
    stale_before = now - timedelta(seconds=max(30, settings.ingest_job_lock_timeout_seconds))
    query = (
        select(LineAttributionJob)
        .where(
            or_(
                (LineAttributionJob.status == "pending") & (LineAttributionJob.next_run_at <= now),
                (LineAttributionJob.status == "processing") & (LineAttributionJob.locked_at < stale_before),
            )
        )
        .order_by(LineAttributionJob.next_run_at.asc(), LineAttributionJob.id.asc())
        .limit(limit)
    )
    try:
        query = query.with_for_update(skip_locked=True)
    except TypeError:
        query = query.with_for_update()
    jobs = db.execute(query).scalars().all()
    for job in jobs:
        job.status = "processing"
        job.locked_at = now
        job.locked_by = worker_id[:128]
        job.attempts += 1
        job.last_error = None
    db.commit()
    return jobs


def _candidate_line_changes_for_job(db: Session, code_change: AiCodeChange) -> tuple[EventIn, list[dict[str, Any]]]:
    if not code_change.event_id:
        return EventIn(
            event_id=f"line-attribution-{code_change.id}",
            task_id=code_change.task_id or f"line-attribution-{code_change.id}",
            session_id=code_change.session_id,
            tool="copilot",
            event_type=str(code_change.change_type or code_change.snapshot_kind or "code_change"),
            occurred_at=code_change.occurred_at,
            payload=code_change.diff_json or {},
        ), [code_change.diff_json or {}]
    raw = db.get(RawIngestEvent, code_change.event_id)
    if raw is None:
        return EventIn(
            event_id=code_change.event_id,
            task_id=code_change.task_id or code_change.event_id,
            session_id=code_change.session_id,
            tool="copilot",
            event_type=str(code_change.change_type or code_change.snapshot_kind or "code_change"),
            occurred_at=code_change.occurred_at,
            payload=code_change.diff_json or {},
        ), [code_change.diff_json or {}]
    event, payload = _event_payload_from_raw(db, raw)
    normalized = normalize_event(event, payload)
    raw_changes = normalized.get("code_changes")
    if not isinstance(raw_changes, list):
        return event, [code_change.diff_json or {}]
    target_path = _normalize_code_path(code_change.file_path)
    target_kind = str(code_change.snapshot_kind or "").lower()
    candidates = [
        change
        for change in raw_changes
        if isinstance(change, dict)
        and _normalize_code_path(change.get("file_path")) == target_path
        and str(change.get("snapshot_kind") or change.get("change_type") or event.event_type or "").lower() == target_kind
    ]
    return event, candidates or [code_change.diff_json or {}]


def _persist_attributed_commit_change(db: Session, code_change: AiCodeChange) -> None:
    event, changes = _candidate_line_changes_for_job(db, code_change)
    if event.event_type != "commit_snapshot":
        return
    for change in changes:
        if not isinstance(change, dict):
            continue
        occurred = _parse_time(change.get("occurred_at"), code_change.occurred_at)
        attributed = _apply_commit_ai_attribution(db, event, occurred, dict(change))
        updates = attributed.get("_line_ledger_updates")
        if isinstance(updates, list):
            _apply_commit_line_ledger_updates(db, event, occurred, _line_scope_from_event(event, event.payload if isinstance(event.payload, dict) else {}), updates)
        summarized = _summarize_large_code_change(attributed)
        code_change.file_path = _normalize_code_path(summarized.get("file_path")) or code_change.file_path
        code_change.lines_added = int(summarized.get("lines_added") or code_change.lines_added or 0)
        code_change.lines_deleted = int(summarized.get("lines_deleted") or code_change.lines_deleted or 0)
        code_change.diff_hash = str(summarized.get("diff_hash") or "")[:128] or code_change.diff_hash
        code_change.diff_json = {key: value for key, value in summarized.items() if key not in {"raw_json", "raw_path", "_line_ledger_updates"}}


def _reattribute_recent_commit_snapshots_for_ai_change(db: Session, event: EventIn, occurred: datetime, change: dict[str, Any]) -> None:
    snapshot_kind = str(change.get("snapshot_kind") or change.get("change_type") or event.event_type or "").lower()
    if snapshot_kind not in AI_TURN_CODE_SNAPSHOT_KINDS:
        return
    file_path = _normalize_code_path(change.get("file_path") or change.get("path"))
    scope = _line_scope_from_event(event, event.payload if isinstance(event.payload, dict) else {})
    query = (
        select(AiCodeChange, RawIngestEvent)
        .join(RawIngestEvent, RawIngestEvent.event_id == AiCodeChange.event_id)
        .where(AiCodeChange.change_type == "commit_snapshot")
        .where(AiCodeChange.occurred_at >= occurred)
        .where(AiCodeChange.occurred_at <= occurred + timedelta(hours=24))
        .order_by(AiCodeChange.occurred_at.asc(), AiCodeChange.id.asc())
        .limit(200)
    )
    for commit_change, raw in db.execute(query).all():
        if file_path:
            commit_file_path = _normalize_code_path(commit_change.file_path or _code_change_payload(commit_change).get("file_path"))
            if commit_file_path and commit_file_path != file_path:
                continue
        if not _scope_matches(scope, _line_scope_from_raw(raw)):
            continue
        _persist_attributed_commit_change(db, commit_change)


def _process_line_attribution_job(db: Session, job: LineAttributionJob) -> None:
    code_change = db.get(AiCodeChange, job.code_change_id)
    if code_change is None:
        return
    if code_change.is_effective is False:
        return
    event, changes = _candidate_line_changes_for_job(db, code_change)
    if event.event_type == "commit_snapshot":
        _persist_attributed_commit_change(db, code_change)
        return
    for change in changes:
        if not isinstance(change, dict):
            continue
        occurred = _parse_time(change.get("occurred_at"), code_change.occurred_at)
        _update_line_ledger_from_ai_change(db, event, occurred, change)
        _reattribute_recent_commit_snapshots_for_ai_change(db, event, occurred, change)


def process_pending_line_attribution_jobs(db: Session, limit: int | None = None, worker_id: str = "collector-worker") -> dict[str, int]:
    settings = get_settings()
    max_jobs = max(1, limit or settings.ingest_worker_batch_size)
    stats = {"claimed": 0, "succeeded": 0, "failed": 0, "retrying": 0, "missing_code_change": 0}
    jobs = _claim_pending_line_attribution_jobs(db, max_jobs, worker_id)
    stats["claimed"] = len(jobs)

    for claimed in jobs:
        job_id = claimed.id
        try:
            job = db.get(LineAttributionJob, job_id)
            if job is None:
                continue
            if db.get(AiCodeChange, job.code_change_id) is None:
                job.status = "failed"
                job.last_error = "code_change_missing"
                stats["missing_code_change"] += 1
                stats["failed"] += 1
                db.commit()
                continue
            _process_line_attribution_job(db, job)
            job.status = "succeeded"
            job.locked_at = None
            job.locked_by = None
            job.last_error = None
            db.commit()
            stats["succeeded"] += 1
        except Exception as error:
            db.rollback()
            job = db.get(LineAttributionJob, job_id)
            if job is None:
                continue
            job.last_error = _safe_job_error(error)
            job.locked_at = None
            job.locked_by = None
            if job.attempts >= job.max_attempts:
                job.status = "failed"
                stats["failed"] += 1
            else:
                job.status = "pending"
                job.next_run_at = _local_now() + timedelta(seconds=max(1, settings.ingest_job_retry_seconds))
                stats["retrying"] += 1
            db.commit()
    return stats


def process_pending_ingest_jobs(
    db: Session,
    limit: int | None = None,
    worker_id: str = "collector-worker",
    *,
    process_line_jobs: bool = True,
) -> dict[str, int]:
    settings = get_settings()
    max_jobs = max(1, limit or settings.ingest_worker_batch_size)
    stats = {"claimed": 0, "succeeded": 0, "failed": 0, "retrying": 0, "missing_raw": 0}
    if process_line_jobs:
        line_stats = process_pending_line_attribution_jobs(db, limit=max_jobs, worker_id=f"{worker_id}:line-before")
        stats.update({f"line_{key}": value for key, value in line_stats.items()})
    jobs = _claim_pending_ingest_jobs(db, max_jobs, worker_id)
    stats["claimed"] = len(jobs)

    for claimed in jobs:
        job_id = claimed.id
        try:
            job = db.get(IngestJob, job_id)
            if job is None:
                continue
            raw_event = db.get(RawIngestEvent, job.raw_event_id)
            if raw_event is None:
                job.status = "failed"
                job.last_error = "raw_event_missing"
                stats["missing_raw"] += 1
                stats["failed"] += 1
                db.commit()
                continue
            event, payload = _event_payload_from_raw(db, raw_event)
            _normalize_and_upsert_event(db, event, payload)
            job.status = "succeeded"
            job.locked_at = None
            job.locked_by = None
            job.last_error = None
            db.commit()
            stats["succeeded"] += 1
            if process_line_jobs:
                line_stats = process_pending_line_attribution_jobs(db, limit=max_jobs, worker_id=f"{worker_id}:line-after")
                for key, value in line_stats.items():
                    stats[f"line_{key}"] = stats.get(f"line_{key}", 0) + value
        except Exception as error:
            db.rollback()
            job = db.get(IngestJob, job_id)
            if job is None:
                continue
            job.last_error = _safe_job_error(error)
            job.locked_at = None
            job.locked_by = None
            if job.attempts >= job.max_attempts:
                job.status = "failed"
                stats["failed"] += 1
            else:
                job.status = "pending"
                job.next_run_at = _local_now() + timedelta(seconds=max(1, settings.ingest_job_retry_seconds))
                stats["retrying"] += 1
            db.commit()
    return stats


def list_usernames(db: Session) -> list[str]:
    rows = [
        *db.execute(select(AiSession)).scalars().all(),
        *db.execute(select(PluginClient)).scalars().all(),
    ]
    users = sorted({label for row in rows if (label := _identity_display(row)) and label != "unknown"})
    return users


def overview_counts(db: Session) -> dict[str, int]:
    rows = db.execute(select(RawIngestEvent.event_type)).scalars().all()
    return dict(Counter(rows))
