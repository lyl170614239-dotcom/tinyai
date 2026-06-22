from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AgentEvent, CodeChangeSnapshot, PullRequestAttribution, SpecAccessEvent, TaskSession


def _ratio(numerator: float, denominator: float) -> float | None:
    if denominator <= 0:
        return None
    return round(numerator / denominator, 4)


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


def _payload(event: AgentEvent) -> dict[str, Any]:
    return event.payload if isinstance(event.payload, dict) else {}


def _latest_conversation_by_task(events: Iterable[AgentEvent]) -> dict[str, dict[str, Any]]:
    snapshots: dict[str, tuple[Any, dict[str, Any]]] = {}
    for event in events:
        if event.event_type != "conversation_snapshot":
            continue
        current = snapshots.get(event.task_id)
        if current is None or event.occurred_at >= current[0]:
            snapshots[event.task_id] = (event.occurred_at, _payload(event))
    return {task_id: payload for task_id, (_, payload) in snapshots.items()}


def _task_sets_by_spec(spec_events: list[SpecAccessEvent]) -> tuple[set[str], set[str], set[str], dict[str, set[str]]]:
    personal_tasks: set[str] = set()
    official_tasks: set[str] = set()
    catalog_tasks: set[str] = set()
    doc_tasks: dict[str, set[str]] = defaultdict(set)

    for event in spec_events:
        if event.spec_scope == "personal":
            personal_tasks.add(event.task_id)
            if event.doc_path:
                doc_tasks[event.doc_path].add(event.task_id)
        elif event.spec_scope == "official":
            official_tasks.add(event.task_id)
        elif event.spec_scope == "catalog" or event.via_catalog:
            catalog_tasks.add(event.task_id)

    return personal_tasks, official_tasks, catalog_tasks, doc_tasks


def _adoption_rate(snapshots: list[CodeChangeSnapshot], task_filter: set[str] | None = None) -> tuple[float | None, int, int]:
    retained = 0
    generated = 0
    for snapshot in snapshots:
        if task_filter is not None and snapshot.task_id not in task_filter:
            continue
        if snapshot.retained_lines is None:
            continue
        retained += max(snapshot.retained_lines, 0)
        generated += max(snapshot.lines_added, 0)
    return _ratio(retained, generated), retained, generated


def _int_payload(payload: dict[str, Any], key: str, default: int = 0) -> int:
    value = payload.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return default


def _ai_code_totals(events: list[AgentEvent], event_type: str) -> dict[str, int]:
    ai_added = 0
    total_added = 0
    files_changed = 0
    event_count = 0
    for event in events:
        if event.event_type != event_type:
            continue
        payload = _payload(event)
        event_count += 1
        total = _int_payload(payload, "lines_added")
        total_added += total
        ai_added += _int_payload(payload, "ai_lines_added", total)
        files_changed += _int_payload(payload, "files_changed")
    return {
        "ai_added": ai_added,
        "total_added": total_added,
        "files_changed": files_changed,
        "event_count": event_count,
    }


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


def knowledge_metrics(db: Session) -> dict[str, Any]:
    tasks = db.execute(select(TaskSession)).scalars().all()
    events = db.execute(select(AgentEvent)).scalars().all()
    spec_events = db.execute(select(SpecAccessEvent)).scalars().all()
    code_snapshots = db.execute(select(CodeChangeSnapshot)).scalars().all()
    pr_attributions = db.execute(select(PullRequestAttribution)).scalars().all()

    task_ids = {task.task_id for task in tasks}
    task_count = len(task_ids)
    ended_tasks = {task.task_id for task in tasks if task.ended_at}
    successful_tasks = {task.task_id for task in tasks if _success_result(task.result)}

    personal_tasks, official_tasks, catalog_tasks, doc_tasks = _task_sets_by_spec(spec_events)
    fallback_tasks = {event.task_id for event in events if event.event_type == "fallback_search"}
    correction_tasks = {event.task_id for event in events if event.event_type == "user_correction"}
    regenerate_tasks = {event.task_id for event in events if event.event_type == "regenerate"}
    interruption_tasks = {event.task_id for event in events if event.event_type == "interruption"}
    specs_bug_tasks = {
        event.task_id
        for event in events
        if event.event_type == "user_correction"
        and str(_payload(event).get("reason") or _payload(event).get("category") or "").lower()
        in {"specs_misunderstanding", "spec_misread", "wrong_spec", "knowledge_error"}
    }

    conversations = _latest_conversation_by_task(events)
    conversation_followup_tasks = {
        task_id for task_id, payload in conversations.items() if int(payload.get("user_followup_count") or 0) > 0
    }
    conversation_regenerate_tasks = {
        task_id for task_id, payload in conversations.items() if int(payload.get("task_repeat_attempts") or 0) > 0
    }
    conversation_interruption_tasks = {
        task_id for task_id, payload in conversations.items() if int(payload.get("turn_aborted_count") or 0) > 0
    }
    repeat_attempt_sum = sum(int(payload.get("task_repeat_attempts") or 0) for payload in conversations.values())

    catalog_hit_events = [event for event in events if event.event_type == "catalog_hit"]
    catalog_miss_tasks = {
        event.task_id
        for event in catalog_hit_events
        if isinstance(_payload(event).get("result_count"), int) and int(_payload(event).get("result_count") or 0) == 0
    }
    matched_by_counter: Counter[str] = Counter()
    matched_event_count = 0
    module_or_tags_event_count = 0
    for event in catalog_hit_events:
        payload = _payload(event)
        matched_by = payload.get("matched_by")
        if isinstance(matched_by, list):
            matched_event_count += 1
            normalized_matches = {str(item) for item in matched_by}
            matched_by_counter.update(normalized_matches)
            if "module" in normalized_matches or "tags" in normalized_matches:
                module_or_tags_event_count += 1
        matched_by_counts = payload.get("matched_by_counts")
        if isinstance(matched_by_counts, dict):
            matched_event_count += 1
            has_module_or_tags = False
            for key, value in matched_by_counts.items():
                if isinstance(value, int) and value > 0:
                    matched_by_counter[str(key)] += 1
                    if str(key) in {"module", "tags"}:
                        has_module_or_tags = True
            if has_module_or_tags:
                module_or_tags_event_count += 1

    personal_adoption, personal_retained, personal_generated = _adoption_rate(code_snapshots, personal_tasks)
    overall_adoption, overall_retained, overall_generated = _adoption_rate(code_snapshots)
    commit_ai = _ai_code_totals(events, "commit_snapshot")
    push_ai = _ai_code_totals(events, "push_snapshot")
    pr_ai = _pr_ai_code_totals(pr_attributions)

    doc_usage = []
    for doc_path, doc_task_ids in sorted(doc_tasks.items(), key=lambda item: (-len(item[1]), item[0]))[:100]:
        doc_adoption, doc_retained, doc_generated = _adoption_rate(code_snapshots, doc_task_ids)
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

    first_pass_tasks = {
        task.task_id
        for task in tasks
        if _success_result(task.result)
        and task.task_id not in correction_tasks
        and task.task_id not in regenerate_tasks
        and task.task_id not in interruption_tasks
        and task.task_id not in conversation_followup_tasks
        and task.task_id not in conversation_regenerate_tasks
        and task.task_id not in conversation_interruption_tasks
    }

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
                    method="tasks_with_personal_spec_read / all_tasks",
                ),
                _metric(
                    3,
                    "个人知识库中各个文档的使用率",
                    None,
                    confidence="direct",
                    method="per_doc_task_count / all_tasks",
                    unit="table",
                ),
            ],
            "details": {"personal_doc_usage": doc_usage},
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
                    method="tasks_with_catalog_hit_before_or_during_spec_access / tasks_with_any_spec_access",
                ),
                _metric(
                    17,
                    "开发时误读 official 比例",
                    _ratio(len(official_tasks - personal_tasks), len(personal_tasks | official_tasks)),
                    numerator=len(official_tasks - personal_tasks),
                    denominator=len(personal_tasks | official_tasks),
                    confidence="direct",
                    method="tasks_with_official_spec_without_personal_spec / tasks_with_any_spec_access",
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
                    method="retained_lines / generated_lines from adoption_snapshot events",
                ),
                _metric(
                    19,
                    "使用个人 specs 后的代码采纳率",
                    personal_adoption,
                    numerator=personal_retained,
                    denominator=personal_generated,
                    confidence="direct",
                    method="retained_lines / generated_lines for tasks_with_personal_spec",
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
                    method="sum(ai_lines_added) from commit_snapshot events",
                    unit="count",
                ),
                _metric(
                    22,
                    "提交级 AI 代码占比",
                    _ratio(commit_ai["ai_added"], commit_ai["total_added"]),
                    numerator=commit_ai["ai_added"],
                    denominator=commit_ai["total_added"],
                    confidence="derived",
                    method="commit_snapshot ai_lines_added / commit_snapshot lines_added",
                ),
                _metric(
                    23,
                    "推送/PR 级 AI 代码占比",
                    _ratio(push_ai["ai_added"], push_ai["total_added"]),
                    numerator=push_ai["ai_added"],
                    denominator=push_ai["total_added"],
                    confidence="derived",
                    method="push_snapshot ai_lines_added / push_snapshot lines_added",
                ),
                _metric(
                    24,
                    "推送/PR 级 AI 新增代码行数",
                    push_ai["ai_added"],
                    numerator=push_ai["ai_added"],
                    denominator=push_ai["event_count"],
                    confidence="derived",
                    method="sum(ai_lines_added) from push_snapshot events",
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
                    method="matched commit_snapshot commits / PR commits",
                ),
            ],
            "details": {
                "commit_snapshot": commit_ai,
                "push_snapshot": push_ai,
                "github_pr_attribution": pr_ai,
                "attribution_note": "Current plugin attribution treats code in commits/push ranges recorded by TinyAI hooks or MCP tools as AI-attributed. GitHub PR attribution intersects PR commits with plugin commit_snapshot events. Mixed human/AI commits still need a later hunk-level matcher for higher precision.",
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
            "event_count": len(events),
            "spec_access_event_count": len(spec_events),
            "code_snapshot_count": len(code_snapshots),
            "conversation_snapshot_count": len(conversations),
            "commit_snapshot_count": commit_ai["event_count"],
            "push_snapshot_count": push_ai["event_count"],
            "ai_committed_lines": commit_ai["ai_added"],
            "ai_pushed_lines": push_ai["ai_added"],
            "pr_attribution_count": pr_ai["event_count"],
            "pr_ai_lines": pr_ai["ai_added"],
            "pr_total_lines": pr_ai["total_added"],
        },
        "categories": categories,
    }
