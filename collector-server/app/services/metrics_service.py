from __future__ import annotations

from collections import Counter, defaultdict
from statistics import median
from typing import Any, Iterable

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..models import (
    AiCodeChange,
    AiMessage,
    AiProcessStep,
    AiRequestUsage,
    AiSession,
    AiSpecAccess,
    AiSpecDocument,
    AiTurn,
    PullRequestAttribution,
    RawIngestEvent,
)
from .ingest_service import _identity_filter


def _ratio(numerator: float, denominator: float) -> float | None:
    if denominator <= 0:
        return None
    return round(numerator / denominator, 4)


def _number(numerator: float, denominator: float, digits: int = 2) -> float | None:
    if denominator <= 0:
        return None
    return round(numerator / denominator, digits)


def _metric(
    metric_id: int,
    name: str,
    value: float | int | None,
    *,
    numerator: float | int | None = None,
    denominator: float | int | None = None,
    confidence: str = "derived",
    method: str,
    unit: str = "ratio",
) -> dict[str, Any]:
    return {
        "id": metric_id,
        "name": name,
        "value": value,
        "unit": unit,
        "numerator": numerator,
        "denominator": denominator,
        "confidence": confidence,
        "method": method,
    }


def _payload(event: RawIngestEvent) -> dict[str, Any]:
    raw_json = event.raw_json if isinstance(event.raw_json, dict) else {}
    raw_event = raw_json.get("event") if isinstance(raw_json.get("event"), dict) else {}
    payload = raw_event.get("payload")
    return payload if isinstance(payload, dict) else {}


def _event_model(event: RawIngestEvent) -> str | None:
    raw_json = event.raw_json if isinstance(event.raw_json, dict) else {}
    raw_event = raw_json.get("event") if isinstance(raw_json.get("event"), dict) else {}
    batch = raw_json.get("batch") if isinstance(raw_json.get("batch"), dict) else {}
    value = raw_event.get("model") or batch.get("model")
    return str(value) if value else None


def _unit_id(session_id: str | None, task_id: str | None) -> str:
    return session_id or task_id or "unknown"


def _spec_unit(access: AiSpecAccess) -> str:
    return _unit_id(access.session_id, access.task_id)


def _code_unit(change: AiCodeChange) -> str:
    return _unit_id(change.session_id, change.task_id)


def _json_int(payload: dict[str, Any] | None, key: str, default: int | None = None) -> int | None:
    if not isinstance(payload, dict):
        return default
    value = payload.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return default


def _code_change_json(change: AiCodeChange) -> dict[str, Any]:
    if isinstance(change.diff_json, dict):
        return change.diff_json
    return {}


def _project_spec_doc_path(path: Any) -> str | None:
    text = str(path or "").replace("\\", "/").strip()
    marker = "openspec/specs/"
    index = text.find(marker)
    if index < 0:
        return None
    return text[index:].strip("/")


def _project_spec_docs_from_access(access: AiSpecAccess) -> list[str]:
    raw_docs = access.matched_docs if isinstance(access.matched_docs, list) and access.matched_docs else ([access.doc_path] if access.doc_path else [])
    docs: list[str] = []
    seen: set[str] = set()
    for raw_doc in raw_docs:
        doc_path = _project_spec_doc_path(raw_doc) or str(raw_doc or "").replace("\\", "/").strip().strip("/")
        if not doc_path or doc_path == "openspec/specs" or doc_path in seen:
            continue
        seen.add(doc_path)
        docs.append(doc_path)
    return docs


def _spec_change_locations(change: AiCodeChange) -> list[dict[str, Any]]:
    diff = _code_change_json(change)
    hunks = diff.get("hunks") if isinstance(diff.get("hunks"), list) else []
    locations: list[dict[str, Any]] = []
    for index, hunk in enumerate(hunks):
        if not isinstance(hunk, dict):
            continue
        lines = hunk.get("lines") if isinstance(hunk.get("lines"), list) else []
        added = sum(1 for line in lines if isinstance(line, dict) and str(line.get("line_type")) == "added")
        removed = sum(1 for line in lines if isinstance(line, dict) and str(line.get("line_type")) == "removed")
        locations.append(
            {
                "event_id": change.event_id,
                "session_id": change.session_id,
                "turn_index": change.turn_index,
                "snapshot_kind": change.snapshot_kind or change.change_type,
                "old_start": hunk.get("old_start"),
                "old_lines": hunk.get("old_lines"),
                "new_start": hunk.get("new_start"),
                "new_lines": hunk.get("new_lines"),
                "added": added,
                "removed": removed,
                "summary": f"第 {hunk.get('new_start') or '?'} 行附近，新增 {added} 行，删除 {removed} 行",
                "occurred_at": change.occurred_at.isoformat() if change.occurred_at else None,
                "hunk_index": index,
            }
        )
    if not locations and (change.lines_added or change.lines_deleted):
        locations.append(
            {
                "event_id": change.event_id,
                "session_id": change.session_id,
                "turn_index": change.turn_index,
                "snapshot_kind": change.snapshot_kind or change.change_type,
                "added": change.lines_added,
                "removed": change.lines_deleted,
                "summary": f"修改位置未解析，新增 {change.lines_added} 行，删除 {change.lines_deleted} 行",
                "occurred_at": change.occurred_at.isoformat() if change.occurred_at else None,
            }
        )
    return locations


AI_TURN_CODE_SNAPSHOT_KINDS = {
    "copilot_turn_tool_patch",
    "copilot_turn_editor_delta",
    "copilot_turn_workspace_diff",
    "claude_turn_tool_patch",
    "claude_turn_editor_delta",
    "claude_turn_workspace_diff",
    "claude_turn_bash_delta",
    "codex_turn_tool_patch",
    "codex_turn_editor_delta",
    "codex_turn_workspace_diff",
}


def _is_copilot_turn_code_change(change: AiCodeChange) -> bool:
    kind = str(change.snapshot_kind or change.change_type or "").lower()
    return kind in AI_TURN_CODE_SNAPSHOT_KINDS


def _effective_code_changes(changes: list[AiCodeChange]) -> list[AiCodeChange]:
    return [change for change in changes if getattr(change, "is_effective", True)]


def _ai_generated_added_lines(changes: list[AiCodeChange]) -> int:
    return sum(max(change.lines_added or 0, 0) for change in changes if _is_copilot_turn_code_change(change))


def _commit_ai_current_added_lines(changes: list[AiCodeChange]) -> int:
    total = 0
    for change in changes:
        payload = _code_change_json(change)
        if change.change_type != "commit_snapshot" and payload.get("snapshot_kind") != "commit_snapshot" and payload.get("event_type") != "commit_snapshot":
            continue
        if isinstance(payload.get("ai_current_lines_added"), int):
            total += max(int(payload.get("ai_current_lines_added") or 0), 0)
            continue
        total += max(_json_int(payload, "ai_lines_added", 0) or 0, 0)
    return total


def _commit_line_related_ai_events(change: AiCodeChange) -> tuple[Counter[str], set[str], int]:
    payload = _code_change_json(change)
    if change.change_type != "commit_snapshot" and payload.get("snapshot_kind") != "commit_snapshot" and payload.get("event_type") != "commit_snapshot":
        return Counter(), set(), 0
    attribution = payload.get("line_attribution") if isinstance(payload.get("line_attribution"), dict) else {}
    hunks = attribution.get("hunks") if isinstance(attribution.get("hunks"), list) else []
    if hunks:
        accepted_by_event: Counter[str] = Counter()
        for hunk in hunks:
            if not isinstance(hunk, dict):
                continue
            lines = hunk.get("lines") if isinstance(hunk.get("lines"), list) else []
            for line in lines:
                if not isinstance(line, dict):
                    continue
                line_type = str(line.get("line_type") or line.get("type") or "").lower()
                classification = str(line.get("classification") or "").lower()
                matched_event_id = str(line.get("matched_ai_event_id") or "")
                if line_type == "added" and classification == "ai_current" and matched_event_id:
                    accepted_by_event[matched_event_id] += 1
        return accepted_by_event, set(), 0

    summary = payload.get("line_attribution_summary") if isinstance(payload.get("line_attribution_summary"), dict) else {}
    matched_events = payload.get("matched_ai_change_event_ids")
    event_ids = {str(event_id) for event_id in matched_events} if isinstance(matched_events, list) else set()
    unallocated = max(
        _json_int(summary, "ai_current_lines_added", _json_int(payload, "ai_current_lines_added", 0)) or 0,
        0,
    )
    return Counter(), event_ids, unallocated


def _ai_code_adoption_rate(changes: list[AiCodeChange], unit_filter: set[str] | None = None) -> tuple[float | None, int, int]:
    retained = 0
    generated = 0
    for change in changes:
        if unit_filter is not None and _code_unit(change) not in unit_filter and (change.task_id or "") not in unit_filter:
            continue
        payload = _code_change_json(change)
        retained_lines = _json_int(payload, "retained_lines")
        if retained_lines is None:
            continue
        retained += max(retained_lines, 0)
        generated += max(change.lines_added, 0)
    return _ratio(retained, generated), retained, generated


def _ai_code_totals_from_changes(changes: list[AiCodeChange], change_type: str) -> dict[str, int]:
    ai_added = 0
    total_added = 0
    ai_deleted = 0
    total_deleted = 0
    ai_modified = 0
    human_added = 0
    human_deleted = 0
    human_modified = 0
    total_modified = 0
    files_changed = 0
    event_ids: set[str] = set()
    for change in changes:
        payload = _code_change_json(change)
        if change.change_type != change_type and payload.get("snapshot_kind") != change_type and payload.get("event_type") != change_type:
            continue
        event_ids.add(change.event_id or f"{change.id}")
        total_added += max(change.lines_added, 0)
        total_deleted += max(change.lines_deleted, 0)
        ai_added_value = _json_int(payload, "ai_lines_added", 0)
        ai_deleted_value = _json_int(payload, "ai_lines_deleted", 0)
        ai_added += max(ai_added_value or 0, 0)
        ai_deleted += max(ai_deleted_value or 0, 0)
        human_added += max(_json_int(payload, "human_lines_added", max(change.lines_added - (_json_int(payload, "ai_lines_added", 0) or 0), 0)) or 0, 0)
        human_deleted += max(_json_int(payload, "human_lines_deleted", max(change.lines_deleted - (_json_int(payload, "ai_lines_deleted", 0) or 0), 0)) or 0, 0)
        ai_modified += max(_json_int(payload, "ai_lines_modified", 0) or 0, 0)
        human_modified += max(_json_int(payload, "human_lines_modified", 0) or 0, 0)
        total_modified += max(_json_int(payload, "lines_modified", 0) or 0, 0)
        files_changed += max(_json_int(payload, "files_changed", 0) or 0, 0)
    return {
        "ai_added": ai_added,
        "total_added": total_added,
        "ai_deleted": ai_deleted,
        "total_deleted": total_deleted,
        "ai_modified": ai_modified,
        "human_added": human_added,
        "human_deleted": human_deleted,
        "human_modified": human_modified,
        "total_modified": total_modified,
        "files_changed": files_changed,
        "event_count": len(event_ids),
    }


def _int_payload(payload: dict[str, Any], key: str, default: int = 0) -> int:
    value = payload.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return default


def _pr_ai_code_totals(attributions: list[PullRequestAttribution]) -> dict[str, int]:
    return {
        "ai_added": sum(max(item.ai_lines_added, 0) for item in attributions),
        "total_added": sum(max(item.total_lines_added, 0) for item in attributions),
        "ai_deleted": sum(max(item.ai_lines_deleted, 0) for item in attributions),
        "total_deleted": sum(max(item.total_lines_deleted, 0) for item in attributions),
        "ai_files_changed": sum(max(item.ai_files_changed, 0) for item in attributions),
        "total_files_changed": sum(max(item.total_files_changed, 0) for item in attributions),
        "ai_commit_count": sum(max(item.ai_commit_count, 0) for item in attributions),
        "commit_count": sum(max(item.commit_count, 0) for item in attributions),
        "event_count": len(attributions),
    }


def _success_result(result: str | None) -> bool:
    if not result:
        return False
    normalized = result.lower()
    return normalized in {"success", "succeeded", "done", "completed", "accepted", "pass", "passed", "fixed", "ok"}


def is_user_chat_session(session: AiSession) -> bool:
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


def user_chat_session_ids(sessions: Iterable[AiSession], messages: Iterable[AiMessage]) -> set[str]:
    sessions_with_user_messages = {
        message.session_id
        for message in messages
        if message.role == "user"
    }
    return {
        session.session_id
        for session in sessions
        if is_user_chat_session(session) and session.session_id in sessions_with_user_messages
    }


def knowledge_metrics(db: Session, username: str | None = None) -> dict[str, Any]:
    if username:
        sessions = db.execute(select(AiSession).where(_identity_filter(AiSession, username))).scalars().all()
    else:
        sessions = db.execute(select(AiSession)).scalars().all()

    session_ids = {session.session_id for session in sessions}
    if username:
        event_query = select(RawIngestEvent).where(
            or_(
                RawIngestEvent.session_id.in_(session_ids) if session_ids else False,
                RawIngestEvent.task_id.in_({session.task_id for session in sessions if session.task_id}) if sessions else False,
            )
        )
    else:
        event_query = select(RawIngestEvent)

    events = db.execute(event_query).scalars().all()
    task_ids = {session.task_id for session in sessions if session.task_id}

    if username:
        spec_accesses = db.execute(
            select(AiSpecAccess).where(
                or_(
                    AiSpecAccess.session_id.in_(session_ids) if session_ids else False,
                    AiSpecAccess.task_id.in_(task_ids) if task_ids else False,
                )
            )
        ).scalars().all()
        code_changes = db.execute(
            select(AiCodeChange).where(
                or_(
                    AiCodeChange.session_id.in_(session_ids) if session_ids else False,
                    AiCodeChange.task_id.in_(task_ids) if task_ids else False,
                )
            )
        ).scalars().all()
        turns = db.execute(select(AiTurn).where(AiTurn.session_id.in_(session_ids) if session_ids else False)).scalars().all()
        messages = db.execute(select(AiMessage).where(AiMessage.session_id.in_(session_ids) if session_ids else False)).scalars().all()
        process_steps = db.execute(select(AiProcessStep).where(AiProcessStep.session_id.in_(session_ids) if session_ids else False)).scalars().all()
        request_usage = db.execute(
            select(AiRequestUsage).where(
                or_(
                    AiRequestUsage.session_id.in_(session_ids) if session_ids else False,
                    AiRequestUsage.task_id.in_(task_ids) if task_ids else False,
                )
            )
        ).scalars().all()
        spec_documents = db.execute(
            select(AiSpecDocument).where(
                or_(
                    AiSpecDocument.username == username,
                    AiSpecDocument.user_id == username,
                )
            )
        ).scalars().all()
    else:
        spec_accesses = db.execute(select(AiSpecAccess)).scalars().all()
        code_changes = db.execute(select(AiCodeChange)).scalars().all()
        turns = db.execute(select(AiTurn)).scalars().all()
        messages = db.execute(select(AiMessage)).scalars().all()
        process_steps = db.execute(select(AiProcessStep)).scalars().all()
        request_usage = db.execute(select(AiRequestUsage)).scalars().all()
        spec_documents = db.execute(select(AiSpecDocument)).scalars().all()

    pr_attributions = db.execute(select(PullRequestAttribution)).scalars().all()
    code_changes = _effective_code_changes(code_changes)
    chat_session_ids = user_chat_session_ids(sessions, messages)
    sessions = [session for session in sessions if session.session_id in chat_session_ids]
    session_units = set(chat_session_ids)
    chat_task_ids = {session.task_id for session in sessions if session.task_id}
    turns = [turn for turn in turns if turn.session_id in chat_session_ids]
    messages = [message for message in messages if message.session_id in chat_session_ids]
    process_steps = [step for step in process_steps if step.session_id in chat_session_ids]
    request_usage = [
        usage
        for usage in request_usage
        if usage.session_id in chat_session_ids or (usage.task_id and usage.task_id in chat_task_ids)
    ]

    task_count = len(session_units)
    ended_tasks = {
        _unit_id(event.session_id, event.task_id)
        for event in events
        if event.event_type == "task_end"
    } | {session.session_id for session in sessions if session.status == "completed"}
    successful_tasks = {
        _unit_id(event.session_id, event.task_id)
        for event in events
        if event.event_type == "task_end"
        and _success_result(str(_payload(event).get("result") or _payload(event).get("status") or ""))
    }

    model_counts: Counter[str] = Counter(usage.model for usage in request_usage if usage.model)
    if not model_counts:
        model_counts.update(model for e in events if (model := _event_model(e)))
    usage_session_ids = {usage.session_id for usage in request_usage}
    legacy_output_tokens = sum(
        _int_payload(_payload(event), "output_tokens")
        for event in events
        if event.event_type == "task_end" and _unit_id(event.session_id, event.task_id) not in usage_session_ids
    )
    prompt_tokens_total = sum(usage.prompt_tokens or 0 for usage in request_usage)
    output_tokens_total = sum(usage.output_tokens or 0 for usage in request_usage) + legacy_output_tokens
    completion_tokens_total = sum(usage.completion_tokens or 0 for usage in request_usage)
    elapsed_ms_total = sum(usage.elapsed_ms or 0 for usage in request_usage)
    copilot_credits_total = round(sum(usage.copilot_credits or 0 for usage in request_usage), 3)

    personal_tasks = {_spec_unit(access) for access in spec_accesses if access.spec_scope == "personal"}
    official_tasks = {_spec_unit(access) for access in spec_accesses if access.spec_scope == "official"}
    catalog_tasks = {_spec_unit(access) for access in spec_accesses if access.spec_scope == "catalog" or access.via_catalog}
    doc_tasks: dict[str, set[str]] = defaultdict(set)
    for access in spec_accesses:
        if access.spec_scope == "personal" and access.doc_path:
            doc_tasks[access.doc_path].add(_spec_unit(access))

    fallback_tasks = {_unit_id(event.session_id, event.task_id) for event in events if event.event_type == "fallback_search"}
    correction_tasks = {_unit_id(event.session_id, event.task_id) for event in events if event.event_type == "user_correction"}
    regenerate_tasks = {_unit_id(event.session_id, event.task_id) for event in events if event.event_type == "regenerate"}
    interruption_tasks = {_unit_id(event.session_id, event.task_id) for event in events if event.event_type == "interruption"}
    specs_bug_tasks = {
        _unit_id(event.session_id, event.task_id)
        for event in events
        if event.event_type == "user_correction"
        and str(_payload(event).get("reason") or _payload(event).get("category") or "").lower()
        in {"specs_misunderstanding", "spec_misread", "wrong_spec", "knowledge_error"}
    }

    turns_by_session: dict[str, list[AiTurn]] = defaultdict(list)
    for turn in turns:
        turns_by_session[turn.session_id].append(turn)
    conversations = {session_id: sorted(items, key=lambda item: item.turn_index) for session_id, items in turns_by_session.items()}
    conversation_followup_tasks = {session_id for session_id, items in conversations.items() if len(items) > 1}
    conversation_regenerate_tasks: set[str] = set()
    conversation_interruption_tasks = {
        _unit_id(event.session_id, event.task_id)
        for event in events
        if event.event_type == "conversation_snapshot" and int(_payload(event).get("turn_aborted_count") or 0) > 0
    }
    repeat_attempt_sum = sum(max(len(items) - 1, 0) for items in conversations.values())

    catalog_hit_events = [access for access in spec_accesses if access.via_catalog or access.spec_scope == "catalog"]
    project_spec_accesses = [access for access in spec_accesses if access.spec_scope == "project"]
    project_read_accesses = [access for access in project_spec_accesses if str(access.access_type or "").lower() == "read"]
    project_edit_accesses = [access for access in project_spec_accesses if str(access.access_type or "").lower() == "edit"]
    project_doc_read_counter: Counter[str] = Counter()
    project_doc_edit_counter: Counter[str] = Counter()
    project_doc_access_counter: Counter[str] = Counter()
    for access in project_spec_accesses:
        docs = _project_spec_docs_from_access(access)
        access_type = str(access.access_type or "").lower()
        for doc in docs:
            doc_path = str(doc)
            project_doc_access_counter[doc_path] += 1
            if access_type == "read":
                project_doc_read_counter[doc_path] += 1
            elif access_type == "edit":
                project_doc_edit_counter[doc_path] += 1
    project_doc_locations: dict[str, list[dict[str, Any]]] = defaultdict(list)
    project_doc_location_keys: dict[str, set[tuple[Any, ...]]] = defaultdict(set)
    for change in code_changes:
        if not _is_copilot_turn_code_change(change):
            continue
        doc_path = _project_spec_doc_path(change.file_path or _code_change_json(change).get("file_path"))
        if not doc_path:
            continue
        added_key = False
        for location in _spec_change_locations(change):
            key = (
                location.get("new_start"),
                location.get("old_start"),
                location.get("added"),
                location.get("removed"),
                location.get("summary"),
            )
            if key in project_doc_location_keys[doc_path]:
                continue
            project_doc_location_keys[doc_path].add(key)
            project_doc_locations[doc_path].append(location)
            added_key = True
        if added_key:
            project_doc_edit_counter[doc_path] += 1
    project_spec_turns = {
        (access.session_id, access.turn_index)
        for access in project_spec_accesses
        if access.session_id and access.turn_index is not None
    }
    document_by_path = {document.doc_path: document for document in spec_documents if getattr(document, "doc_path", None)}
    all_project_doc_paths = set(document_by_path) | set(project_doc_access_counter) | set(project_doc_locations)
    project_doc_conversion_by_path: dict[str, float | None] = {}
    for doc_path in all_project_doc_paths:
        read_count = project_doc_read_counter.get(doc_path, 0)
        edit_count = len(project_doc_locations.get(doc_path, [])) if project_doc_locations.get(doc_path) else project_doc_edit_counter.get(doc_path, 0)
        project_doc_conversion_by_path[doc_path] = _ratio(edit_count, read_count) if read_count > 0 else None
    project_doc_read_values = [project_doc_read_counter.get(path, 0) for path in all_project_doc_paths if project_doc_read_counter.get(path, 0) > 0]
    project_doc_conversion_values = [
        value for value in project_doc_conversion_by_path.values()
        if value is not None
    ]
    project_doc_read_median = float(median(project_doc_read_values)) if project_doc_read_values else 0.0
    project_doc_conversion_median = float(median(project_doc_conversion_values)) if project_doc_conversion_values else 0.0
    low_conversion_doc_paths: set[str] = set()
    high_frequency_low_conversion_doc_paths: set[str] = set()
    for doc_path, conversion_rate in project_doc_conversion_by_path.items():
        if conversion_rate is None:
            continue
        read_count = project_doc_read_counter.get(doc_path, 0)
        if conversion_rate < project_doc_conversion_median:
            low_conversion_doc_paths.add(doc_path)
        if read_count >= project_doc_read_median and conversion_rate < project_doc_conversion_median:
            high_frequency_low_conversion_doc_paths.add(doc_path)

    project_docs_by_turn: dict[tuple[str, int], set[str]] = defaultdict(set)
    for access in project_read_accesses:
        if not access.session_id or access.turn_index is None:
            continue
        docs = _project_spec_docs_from_access(access)
        if not docs:
            continue
        project_docs_by_turn[(access.session_id, int(access.turn_index))].update(docs)

    evidence_by_event_id: dict[str, AiCodeChange] = {}
    ai_evidence_by_turn: dict[tuple[str, int], list[AiCodeChange]] = defaultdict(list)
    for change in code_changes:
        if not _is_copilot_turn_code_change(change) or not change.event_id or not change.session_id or change.turn_index is None:
            continue
        evidence_by_event_id[str(change.event_id)] = change
        ai_evidence_by_turn[(change.session_id, int(change.turn_index))].append(change)

    project_doc_related_turns: dict[str, set[tuple[str, int]]] = defaultdict(set)
    project_doc_related_evidence_events: dict[str, set[str]] = defaultdict(set)
    project_doc_related_generated_added: Counter[str] = Counter()
    project_doc_related_accepted_added: Counter[str] = Counter()
    project_doc_related_commits: dict[str, set[str]] = defaultdict(set)
    project_doc_related_unallocated: Counter[str] = Counter()
    global_related_unallocated_accepted_lines = 0

    for turn_key, docs in project_docs_by_turn.items():
        evidence_rows = ai_evidence_by_turn.get(turn_key, [])
        if not evidence_rows:
            continue
        generated_added = sum(max(change.lines_added or 0, 0) for change in evidence_rows)
        event_ids = {str(change.event_id) for change in evidence_rows if change.event_id}
        for doc_path in docs:
            project_doc_related_turns[doc_path].add(turn_key)
            project_doc_related_evidence_events[doc_path].update(event_ids)
            project_doc_related_generated_added[doc_path] += generated_added

    for commit_change in code_changes:
        accepted_by_event, summary_event_ids, unallocated_count = _commit_line_related_ai_events(commit_change)
        commit_id = str(commit_change.event_id or commit_change.id)
        for event_id, accepted_count in accepted_by_event.items():
            evidence = evidence_by_event_id.get(event_id)
            if not evidence or not evidence.session_id or evidence.turn_index is None:
                continue
            for doc_path in project_docs_by_turn.get((evidence.session_id, int(evidence.turn_index)), set()):
                project_doc_related_accepted_added[doc_path] += int(accepted_count)
                project_doc_related_commits[doc_path].add(commit_id)
        if unallocated_count <= 0 or not summary_event_ids:
            continue
        global_related_unallocated_accepted_lines += unallocated_count
        if len(summary_event_ids) != 1:
            continue
        event_id = next(iter(summary_event_ids))
        evidence = evidence_by_event_id.get(event_id)
        if not evidence or not evidence.session_id or evidence.turn_index is None:
            continue
        for doc_path in project_docs_by_turn.get((evidence.session_id, int(evidence.turn_index)), set()):
            project_doc_related_unallocated[doc_path] += unallocated_count

    project_doc_related_adoption_by_path: dict[str, float | None] = {}
    for doc_path in all_project_doc_paths | set(project_doc_related_generated_added):
        generated = project_doc_related_generated_added.get(doc_path, 0)
        accepted = project_doc_related_accepted_added.get(doc_path, 0)
        project_doc_related_adoption_by_path[doc_path] = _ratio(accepted, generated) if generated > 0 else None
    related_adoption_values = [
        value for value in project_doc_related_adoption_by_path.values()
        if value is not None
    ]
    project_doc_related_adoption_median = float(median(related_adoption_values)) if related_adoption_values else 0.0
    high_frequency_low_related_doc_paths: set[str] = set()
    related_docs_with_adoption_data = {
        doc_path
        for doc_path, generated in project_doc_related_generated_added.items()
        if generated > 0 and project_doc_related_accepted_added.get(doc_path, 0) > 0
    }
    for doc_path, related_adoption in project_doc_related_adoption_by_path.items():
        if related_adoption is None:
            continue
        read_count = project_doc_read_counter.get(doc_path, 0)
        generated = project_doc_related_generated_added.get(doc_path, 0)
        accepted = project_doc_related_accepted_added.get(doc_path, 0)
        no_line_level_acceptance = generated > 0 and accepted == 0
        if read_count >= project_doc_read_median and (
            related_adoption < project_doc_related_adoption_median or no_line_level_acceptance
        ):
            high_frequency_low_related_doc_paths.add(doc_path)

    all_project_doc_paths |= set(project_doc_related_generated_added) | set(project_doc_related_accepted_added) | set(project_doc_related_unallocated)
    project_doc_usage = []
    for doc_path in sorted(
        all_project_doc_paths,
        key=lambda item: (-(project_doc_read_counter.get(item, 0) + project_doc_edit_counter.get(item, 0)), item),
    )[:300]:
        document = document_by_path.get(doc_path)
        edit_locations = project_doc_locations.get(doc_path, [])[:20]
        read_count = project_doc_read_counter.get(doc_path, 0)
        edit_count = len(edit_locations) if edit_locations else project_doc_edit_counter.get(doc_path, 0)
        conversion_rate = project_doc_conversion_by_path.get(doc_path)
        related_generated = project_doc_related_generated_added.get(doc_path, 0)
        related_accepted = project_doc_related_accepted_added.get(doc_path, 0)
        related_adoption = project_doc_related_adoption_by_path.get(doc_path)
        if conversion_rate is None:
            efficiency_bucket = "未读取"
        elif doc_path in high_frequency_low_conversion_doc_paths:
            efficiency_bucket = "高频低转化"
        elif read_count >= project_doc_read_median and conversion_rate >= project_doc_conversion_median:
            efficiency_bucket = "高频高转化"
        elif read_count < project_doc_read_median and conversion_rate < project_doc_conversion_median:
            efficiency_bucket = "低频低转化"
        else:
            efficiency_bucket = "低频高转化"
        if related_adoption is None:
            related_efficiency_bucket = "无AI代码关联"
        elif doc_path in high_frequency_low_related_doc_paths:
            related_efficiency_bucket = "高频低关联采纳"
        elif related_generated > 0 and related_accepted == 0:
            related_efficiency_bucket = "低频低关联采纳"
        elif read_count >= project_doc_read_median and related_adoption >= project_doc_related_adoption_median:
            related_efficiency_bucket = "高频高关联采纳"
        elif read_count < project_doc_read_median and related_adoption < project_doc_related_adoption_median:
            related_efficiency_bucket = "低频低关联采纳"
        else:
            related_efficiency_bucket = "低频高关联采纳"
        project_doc_usage.append(
            {
                "doc_path": doc_path,
                "file_name": document.file_name if document else doc_path.rsplit("/", 1)[-1],
                "read_count": read_count,
                "edit_count": edit_count,
                "edit_access_count": project_doc_edit_counter.get(doc_path, 0),
                "access_count": project_doc_access_counter.get(doc_path, 0),
                "conversion_rate": conversion_rate,
                "efficiency_bucket": efficiency_bucket,
                "related_turn_count": len(project_doc_related_turns.get(doc_path, set())),
                "related_ai_evidence_event_count": len(project_doc_related_evidence_events.get(doc_path, set())),
                "related_ai_generated_added_lines": related_generated,
                "related_ai_accepted_added_lines": related_accepted,
                "related_adoption_rate": related_adoption,
                "related_commit_count": len(project_doc_related_commits.get(doc_path, set())),
                "related_unallocated_accepted_lines": project_doc_related_unallocated.get(doc_path, 0),
                "related_efficiency_bucket": related_efficiency_bucket,
                "related_credit_policy": "full_related_credit",
                "related_adoption_note": "关联分析，不代表文档直接贡献代码；多文档同轮会重复关联，文档级行数不能跨文档累加。",
                "content_hash": document.content_hash if document else None,
                "last_seen_at": document.last_seen_at.isoformat() if document and document.last_seen_at else None,
                "edit_locations": edit_locations,
            }
        )
    catalog_miss_tasks = {
        _unit_id(event.session_id, event.task_id)
        for event in events
        if event.event_type == "catalog_hit" and isinstance(_payload(event).get("result_count"), int) and int(_payload(event).get("result_count") or 0) == 0
    }
    matched_by_counter: Counter[str] = Counter()
    matched_event_count = 0
    module_or_tags_event_count = 0
    for access in catalog_hit_events:
        matched_by = access.matched_by
        if isinstance(matched_by, list):
            matched_event_count += 1
            normalized_matches = {str(item) for item in matched_by}
            matched_by_counter.update(normalized_matches)
            if "module" in normalized_matches or "tags" in normalized_matches:
                module_or_tags_event_count += 1

    personal_adoption, personal_retained, personal_generated = _ai_code_adoption_rate(code_changes, personal_tasks)
    overall_adoption, overall_retained, overall_generated = _ai_code_adoption_rate(code_changes)
    commit_ai = _ai_code_totals_from_changes(code_changes, "commit_snapshot")
    push_ai = _ai_code_totals_from_changes(code_changes, "push_snapshot")
    pr_ai = _pr_ai_code_totals(pr_attributions)
    effective_ai_turn_changes = [change for change in code_changes if _is_copilot_turn_code_change(change)]
    ai_generated_added_lines = _ai_generated_added_lines(code_changes)
    ai_commit_current_added_lines = _commit_ai_current_added_lines(code_changes)
    code_turn_units = {
        (change.session_id, change.turn_index)
        for change in effective_ai_turn_changes
        if change.session_id and change.turn_index is not None
    }
    total_tokens = prompt_tokens_total + output_tokens_total + completion_tokens_total
    project_docs_with_reads = {path for path, count in project_doc_read_counter.items() if count > 0}
    project_docs_with_edits = {path for path, count in project_doc_edit_counter.items() if count > 0} | set(project_doc_locations)

    doc_usage = []
    for doc_path, doc_task_ids in sorted(doc_tasks.items(), key=lambda item: (-len(item[1]), item[0]))[:100]:
        doc_adoption, doc_retained, doc_generated = _ai_code_adoption_rate(code_changes, doc_task_ids)
        doc_usage.append(
            {
                "doc_path": doc_path,
                "task_count": len(doc_task_ids),
                "usage_rate": _ratio(len(doc_task_ids), task_count),
                "code_adoption_rate": doc_adoption,
                "retained_lines": doc_retained,
                "generated_lines": doc_generated,
            }
        )

    first_pass_tasks = successful_tasks - correction_tasks - regenerate_tasks - interruption_tasks
    first_pass_tasks -= conversation_followup_tasks | conversation_regenerate_tasks | conversation_interruption_tasks

    categories = [
        {
            "key": "knowledge_usage_coverage",
            "title": "知识库使用覆盖",
            "metrics": [
                _metric(
                    1,
                    "个人 specs 知识库调用率",
                    _ratio(len(personal_tasks), task_count),
                    numerator=len(personal_tasks),
                    denominator=task_count,
                    confidence="direct",
                    method="sessions_with_personal_ai_spec_access / all_ai_sessions",
                ),
                _metric(
                    3,
                    "个人知识库中各个文档的使用率",
                    None,
                    confidence="direct",
                    method="per_doc_session_count / all_ai_sessions",
                    unit="table",
                ),
            ],
            "details": {"personal_doc_usage": doc_usage},
        },
        {
            "key": "project_knowledge_usage",
            "title": "项目知识库命中",
            "metrics": [
                _metric(
                    21,
                    "项目知识库命中次数",
                    len(project_spec_accesses),
                    numerator=len(project_spec_accesses),
                    denominator=None,
                    confidence="derived",
                    method="count(ai_spec_accesses where spec_scope=project)",
                    unit="count",
                ),
                _metric(
                    22,
                    "项目知识库读取次数",
                    len(project_read_accesses),
                    numerator=len(project_read_accesses),
                    denominator=None,
                    confidence="derived",
                    method="count(project spec accesses with access_type=read)",
                    unit="count",
                ),
                _metric(
                    23,
                    "项目知识库命中文档次数",
                    sum(max(int(access.matched_doc_count or 0), 1 if access.doc_path and access.doc_path != "openspec/specs" else 0) for access in project_spec_accesses),
                    numerator=sum(max(int(access.matched_doc_count or 0), 1 if access.doc_path and access.doc_path != "openspec/specs" else 0) for access in project_spec_accesses),
                    denominator=None,
                    confidence="derived",
                    method="sum(matched_doc_count) from project spec accesses",
                    unit="count",
                ),
                _metric(
                    24,
                    "项目知识库轮次命中率",
                    _ratio(len(project_spec_turns), len(turns)),
                    numerator=len(project_spec_turns),
                    denominator=len(turns),
                    confidence="derived",
                    method="turns_with_project_spec_access / all_turns",
                ),
                _metric(
                    33,
                    "知识访问到修改转化率",
                    _ratio(len(project_docs_with_edits), len(project_docs_with_reads)),
                    numerator=len(project_docs_with_edits),
                    denominator=len(project_docs_with_reads),
                    confidence="derived",
                    method="project_spec_docs_with_edit / project_spec_docs_with_read",
                ),
                _metric(
                    34,
                    "高频低转化知识文档数",
                    len(high_frequency_low_conversion_doc_paths),
                    numerator=len(high_frequency_low_conversion_doc_paths),
                    denominator=len(project_docs_with_reads),
                    confidence="derived",
                    method="docs_with_read_count_above_median_and_conversion_rate_below_median",
                    unit="count",
                ),
                _metric(
                    39,
                    "文档关联 AI 提交采纳率",
                    None,
                    confidence="derived",
                    method="per_doc related_ai_accepted_added_lines / related_ai_generated_added_lines; full related credit, not direct contribution",
                    unit="table",
                ),
                _metric(
                    40,
                    "高频低关联采纳文档数",
                    len(high_frequency_low_related_doc_paths),
                    numerator=len(high_frequency_low_related_doc_paths),
                    denominator=len(project_docs_with_reads),
                    confidence="derived",
                    method="docs_with_read_count_above_median_and_related_adoption_rate_below_median",
                    unit="count",
                ),
                _metric(
                    41,
                    "有关联采纳数据的文档数",
                    len(related_docs_with_adoption_data),
                    numerator=len(related_docs_with_adoption_data),
                    denominator=len(project_docs_with_reads),
                    confidence="derived",
                    method="docs_with_read_ai_generation_and_line_level_commit_acceptance",
                    unit="count",
                ),
            ],
            "details": {
                "project_doc_usage": project_doc_usage,
                "related_adoption_policy": "同一轮 turn 内文档读取与 AI 代码生成做关联分析；不代表文档直接贡献代码；多文档同轮会重复关联，文档级行数不能跨文档累加。",
                "related_unallocated_accepted_lines": global_related_unallocated_accepted_lines,
            },
        },
        {
            "key": "read_rule_compliance",
            "title": "读取规则合规",
            "metrics": [
                _metric(
                    4,
                    "是否按个人库读取规则阅读",
                    _ratio(len((personal_tasks | official_tasks) & catalog_tasks), len(personal_tasks | official_tasks)),
                    numerator=len((personal_tasks | official_tasks) & catalog_tasks),
                    denominator=len(personal_tasks | official_tasks),
                    confidence="derived",
                    method="sessions_with_ai_spec_access_via_catalog / sessions_with_any_ai_spec_access",
                ),
                _metric(
                    17,
                    "开发时误读 official 比例",
                    _ratio(len(official_tasks - personal_tasks), len(personal_tasks | official_tasks)),
                    numerator=len(official_tasks - personal_tasks),
                    denominator=len(personal_tasks | official_tasks),
                    confidence="direct",
                    method="sessions_with_official_ai_spec_without_personal_spec / sessions_with_any_ai_spec_access",
                ),
            ],
        },
        {
            "key": "location_hit_efficiency",
            "title": "定位与命中效率",
            "metrics": [
                _metric(
                    12,
                    "catalog/spec 没覆盖率",
                    _ratio(len(catalog_miss_tasks | fallback_tasks), len(catalog_tasks | fallback_tasks)),
                    numerator=len(catalog_miss_tasks | fallback_tasks),
                    denominator=len(catalog_tasks | fallback_tasks),
                    confidence="derived",
                    method="tasks_with_catalog_zero_result_or_fallback_search / tasks_with_catalog_or_fallback",
                ),
                _metric(
                    13,
                    "fallback search rate",
                    _ratio(len(fallback_tasks), task_count),
                    numerator=len(fallback_tasks),
                    denominator=task_count,
                    confidence="direct",
                    method="tasks_with_fallback_search / all_tasks",
                ),
                _metric(
                    14,
                    "keywords 命中率",
                    _ratio(matched_by_counter.get("keywords", 0), matched_event_count),
                    numerator=matched_by_counter.get("keywords", 0),
                    denominator=matched_event_count,
                    confidence="derived",
                    method="catalog_hit_events_matching_keywords / catalog_hit_events_with_match_metadata",
                ),
                _metric(
                    15,
                    "related_code 命中率",
                    _ratio(matched_by_counter.get("related_code", 0), matched_event_count),
                    numerator=matched_by_counter.get("related_code", 0),
                    denominator=matched_event_count,
                    confidence="derived",
                    method="catalog_hit_events_matching_related_code / catalog_hit_events_with_match_metadata",
                ),
                _metric(
                    16,
                    "module/tags 命中率",
                    _ratio(module_or_tags_event_count, matched_event_count),
                    numerator=module_or_tags_event_count,
                    denominator=matched_event_count,
                    confidence="derived",
                    method="catalog_hit_events_matching_module_or_tags / catalog_hit_events_with_match_metadata",
                ),
            ],
        },
        {
            "key": "knowledge_and_code_adoption_quality",
            "title": "知识库和代码采纳质量",
            "metrics": [
                _metric(
                    2,
                    "使用个人知识库的采纳率",
                    _ratio(len(personal_tasks & successful_tasks), len(personal_tasks)),
                    numerator=len(personal_tasks & successful_tasks),
                    denominator=len(personal_tasks),
                    confidence="derived",
                    method="successful_tasks_with_personal_spec / tasks_with_personal_spec",
                ),
                _metric(
                    18,
                    "代码采纳率",
                    overall_adoption,
                    numerator=overall_retained,
                    denominator=overall_generated,
                    confidence="direct",
                    method="retained_lines / generated_lines from ai_code_changes",
                ),
                _metric(
                    19,
                    "使用个人 specs 后的代码采纳率",
                    personal_adoption,
                    numerator=personal_retained,
                    denominator=personal_generated,
                    confidence="direct",
                    method="retained_lines / generated_lines in sessions_with_personal_ai_spec_access",
                ),
                _metric(
                    20,
                    "文档级代码采纳率",
                    None,
                    confidence="direct",
                    method="per_doc retained_lines / generated_lines",
                    unit="table",
                ),
                _metric(
                    7,
                    "因 specs 理解错误引入 bug 的比例",
                    _ratio(len(specs_bug_tasks), len(personal_tasks | official_tasks)),
                    numerator=len(specs_bug_tasks),
                    denominator=len(personal_tasks | official_tasks),
                    confidence="inferred",
                    method="user_correction events tagged as specs_misunderstanding / tasks_with_any_spec_access",
                ),
            ],
            "details": {"doc_code_adoption": doc_usage},
        },
        {
            "key": "ai_code_attribution",
            "title": "AI 代码归因",
            "metrics": [
                _metric(
                    21,
                    "提交级 AI 新增代码行数",
                    commit_ai["ai_added"],
                    numerator=commit_ai["ai_added"],
                    denominator=commit_ai["event_count"],
                    confidence="derived",
                    method="sum(ai_lines_added) from ai_code_changes where change_type=commit_snapshot",
                    unit="count",
                ),
                _metric(
                    22,
                    "提交级 AI 代码占比",
                    _ratio(commit_ai["ai_added"], commit_ai["total_added"]),
                    numerator=commit_ai["ai_added"],
                    denominator=commit_ai["total_added"],
                    confidence="derived",
                    method="commit_snapshot ai_lines_added / lines_added",
                ),
                _metric(
                    28,
                    "提交级 AI 删除代码行数",
                    commit_ai["ai_deleted"],
                    numerator=commit_ai["ai_deleted"],
                    denominator=commit_ai["event_count"],
                    confidence="derived",
                    method="sum(ai_lines_deleted) from ai_code_changes where change_type=commit_snapshot",
                    unit="count",
                ),
                _metric(
                    29,
                    "提交级 AI 删除占比",
                    _ratio(commit_ai["ai_deleted"], commit_ai["total_deleted"]),
                    numerator=commit_ai["ai_deleted"],
                    denominator=commit_ai["total_deleted"],
                    confidence="derived",
                    method="commit_snapshot ai_lines_deleted / lines_deleted",
                ),
                _metric(
                    30,
                    "提交级 AI 修改代码行数",
                    commit_ai["ai_modified"],
                    numerator=commit_ai["ai_modified"],
                    denominator=commit_ai["event_count"],
                    confidence="derived",
                    method="sum(ai_lines_modified) inferred from commit_snapshot hunks",
                    unit="count",
                ),
                _metric(
                    31,
                    "提交级 AI 修改占比",
                    _ratio(commit_ai["ai_modified"], commit_ai["total_modified"]),
                    numerator=commit_ai["ai_modified"],
                    denominator=commit_ai["total_modified"],
                    confidence="derived",
                    method="commit_snapshot ai_lines_modified / inferred lines_modified",
                ),
                _metric(
                    32,
                    "提交级人工变更行数",
                    max(commit_ai["human_added"] + commit_ai["human_deleted"] - commit_ai["human_modified"], 0),
                    numerator=max(commit_ai["human_added"] + commit_ai["human_deleted"] - commit_ai["human_modified"], 0),
                    denominator=commit_ai["event_count"],
                    confidence="derived",
                    method="sum(human_lines_added + human_lines_deleted - human_lines_modified) from commit_snapshot attribution to avoid double-counting modified lines",
                    unit="count",
                ),
                _metric(
                    23,
                    "推送/PR 级 AI 代码占比",
                    _ratio(push_ai["ai_added"], push_ai["total_added"]),
                    numerator=push_ai["ai_added"],
                    denominator=push_ai["total_added"],
                    confidence="derived",
                    method="ai_code_changes push_snapshot ai_lines_added / lines_added",
                ),
                _metric(
                    24,
                    "推送/PR 级 AI 新增代码行数",
                    push_ai["ai_added"],
                    numerator=push_ai["ai_added"],
                    denominator=push_ai["event_count"],
                    confidence="derived",
                    method="sum(ai_lines_added) from ai_code_changes where change_type=push_snapshot",
                    unit="count",
                ),
                _metric(
                    25,
                    "GitHub PR 级 AI 新增代码行数",
                    pr_ai["ai_added"],
                    numerator=pr_ai["ai_added"],
                    denominator=pr_ai["event_count"],
                    confidence="derived",
                    method="sum(ai_lines_added) from pull_request_attributions",
                    unit="count",
                ),
                _metric(
                    26,
                    "GitHub PR 级 AI 代码占比",
                    _ratio(pr_ai["ai_added"], pr_ai["total_added"]),
                    numerator=pr_ai["ai_added"],
                    denominator=pr_ai["total_added"],
                    confidence="derived",
                    method="pull_request_attributions ai_lines_added / total_lines_added",
                ),
                _metric(
                    27,
                    "GitHub PR commit 命中率",
                    _ratio(pr_ai["ai_commit_count"], pr_ai["commit_count"]),
                    numerator=pr_ai["ai_commit_count"],
                    denominator=pr_ai["commit_count"],
                    confidence="derived",
                    method="matched ai_code_changes commit_snapshot commits / PR commits",
                ),
            ],
            "details": {
                "commit_snapshot": commit_ai,
                "push_snapshot": push_ai,
                "github_pr_attribution": pr_ai,
                "attribution_note": "Commit attribution is deterministic: commit_snapshot line hashes are matched against previously ingested AI turn diff evidence (copilot_turn_*/claude_turn_*/codex_turn_*), consuming duplicate line hashes by occurrence count. Modified lines are inferred from added+removed pairs inside each hunk.",
            },
        },
        {
            "key": "ai_coding_outcome_cost",
            "title": "AI Coding 结果与成本",
            "metrics": [
                _metric(
                    35,
                    "AI 参与代码轮次覆盖率",
                    _ratio(len(code_turn_units), len(turns)),
                    numerator=len(code_turn_units),
                    denominator=len(turns),
                    confidence="derived",
                    method="turns_with_effective_copilot_code_change / all_turns",
                ),
                _metric(
                    36,
                    "AI 代码提交采纳率",
                    _ratio(ai_commit_current_added_lines, ai_generated_added_lines),
                    numerator=ai_commit_current_added_lines,
                    denominator=ai_generated_added_lines,
                    confidence="derived",
                    method="commit_snapshot_ai_current_added_lines / effective_copilot_turn_generated_added_lines",
                ),
                _metric(
                    37,
                    "每 AI 提交行 Token",
                    _number(total_tokens, ai_commit_current_added_lines),
                    numerator=total_tokens,
                    denominator=ai_commit_current_added_lines,
                    confidence="derived",
                    method="total_prompt_output_completion_tokens / commit_snapshot_ai_current_added_lines",
                    unit="number",
                ),
                _metric(
                    38,
                    "每 AI 提交行点数",
                    _number(copilot_credits_total, ai_commit_current_added_lines, digits=4),
                    numerator=copilot_credits_total,
                    denominator=ai_commit_current_added_lines,
                    confidence="derived",
                    method="total_copilot_credits / commit_snapshot_ai_current_added_lines",
                    unit="number",
                ),
            ],
            "details": {
                "article_reference": "Adapted from the AI Coding metrics article: link funnel, code adoption, and Token cost. Demand coverage and merge-release adoption are intentionally excluded because the current plugin data has no demand/release system linkage.",
                "ai_generated_added_lines": ai_generated_added_lines,
                "ai_commit_current_added_lines": ai_commit_current_added_lines,
                "total_tokens": total_tokens,
                "copilot_credits_total": copilot_credits_total,
            },
        },
        {
            "key": "task_result_and_rework",
            "title": "任务结果与返工",
            "metrics": [
                _metric(
                    5,
                    "任务有效解决率",
                    _ratio(len(successful_tasks), len(ended_tasks)),
                    numerator=len(successful_tasks),
                    denominator=len(ended_tasks),
                    confidence="direct",
                    method="task_end_success / ended_tasks",
                ),
                _metric(
                    6,
                    "第一次实现就满足要求的比例",
                    _ratio(len(first_pass_tasks), len(ended_tasks)),
                    numerator=len(first_pass_tasks),
                    denominator=len(ended_tasks),
                    confidence="derived",
                    method="successful_tasks_without_followup_correction_regenerate_or_interruption / ended_tasks",
                ),
                _metric(
                    8,
                    "用户纠错追问率",
                    _ratio(len(correction_tasks | conversation_followup_tasks), task_count),
                    numerator=len(correction_tasks | conversation_followup_tasks),
                    denominator=task_count,
                    confidence="derived",
                    method="tasks_with_user_correction_or_conversation_followup / all_tasks",
                ),
                _metric(
                    9,
                    "重新生成率",
                    _ratio(len(regenerate_tasks | conversation_regenerate_tasks), task_count),
                    numerator=len(regenerate_tasks | conversation_regenerate_tasks),
                    denominator=task_count,
                    confidence="derived",
                    method="tasks_with_regenerate_event_or_repeat_attempts / all_tasks",
                ),
                _metric(
                    10,
                    "用户中断 AI 输出比例",
                    _ratio(len(interruption_tasks | conversation_interruption_tasks), task_count),
                    numerator=len(interruption_tasks | conversation_interruption_tasks),
                    denominator=task_count,
                    confidence="derived",
                    method="tasks_with_interruption_event_or_turn_aborted / all_tasks",
                ),
                _metric(
                    11,
                    "同一任务重复尝试次数",
                    round(repeat_attempt_sum / len(conversations), 4) if conversations else None,
                    numerator=repeat_attempt_sum,
                    denominator=len(conversations),
                    confidence="derived",
                    method="average task_repeat_attempts from conversation_snapshot",
                    unit="count",
                ),
            ],
        },
    ]

    return {
        "summary": {
            "task_count": task_count,
            "session_count": len(sessions),
            "turn_count": len(turns),
            "message_count": len(messages),
            "event_count": len(events),
            "spec_access_event_count": len(spec_accesses),
            "project_spec_access_count": len(project_spec_accesses),
            "project_spec_read_count": len(project_read_accesses),
            "project_spec_edit_count": len(project_edit_accesses),
            "project_spec_doc_hit_count": sum(max(int(access.matched_doc_count or 0), 1 if access.doc_path and access.doc_path != "openspec/specs" else 0) for access in project_spec_accesses),
            "project_spec_unique_doc_count": len(all_project_doc_paths),
            "project_spec_conversion_rate": _ratio(len(project_docs_with_edits), len(project_docs_with_reads)),
            "project_spec_low_conversion_doc_count": len(high_frequency_low_conversion_doc_paths),
            "project_spec_low_related_adoption_doc_count": len(high_frequency_low_related_doc_paths),
            "project_spec_related_adoption_doc_count": len(related_docs_with_adoption_data),
            "code_snapshot_count": len(code_changes),
            "conversation_snapshot_count": len(conversations),
            "agent_process_snapshot_count": len({step.session_id for step in process_steps}),
            "agent_activity_event_count": len(process_steps),
            "file_read_event_count": len([step for step in process_steps if step.step_type == "file_read"]),
            "commit_snapshot_count": commit_ai["event_count"],
            "push_snapshot_count": push_ai["event_count"],
            "ai_committed_lines": commit_ai["ai_added"],
            "ai_generated_added_lines": ai_generated_added_lines,
            "ai_commit_current_added_lines": ai_commit_current_added_lines,
            "ai_pushed_lines": push_ai["ai_added"],
            "pr_attribution_count": pr_ai["event_count"],
            "pr_ai_lines": pr_ai["ai_added"],
            "pr_total_lines": pr_ai["total_added"],
            "username_filter": username,
            "model_usage": dict(model_counts.most_common(20)),
            "request_usage_count": len(request_usage),
            "prompt_tokens_total": prompt_tokens_total,
            "output_tokens_total": output_tokens_total,
            "completion_tokens_total": completion_tokens_total,
            "elapsed_ms_total": elapsed_ms_total,
            "copilot_credits_total": copilot_credits_total,
        },
        "categories": categories,
    }
