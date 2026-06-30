import base64
from datetime import datetime, timezone
import gzip
import hashlib
import json
import unittest

from sqlalchemy import create_engine, select
from sqlalchemy.dialects.mysql import LONGTEXT
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.database import Base
from app.api.ingest import _preferred_code_changes, get_raw_event_blob, get_session_detail
from app.config import get_settings
from app.models import (
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
from app.schemas.events import BatchIn, EventIn
from app.services.ingest_service import ingest_batch, process_pending_ingest_jobs, process_pending_line_attribution_jobs
from app.services.metrics_service import knowledge_metrics


@compiles(LONGTEXT, "sqlite")
def _compile_longtext_sqlite(_type, _compiler, **_kw):
    return "TEXT"


class IngestServiceTests(unittest.TestCase):
    def setUp(self):
        self.settings = get_settings()
        self.old_async_normalization = self.settings.ingest_async_normalization
        self.settings.ingest_async_normalization = True
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(bind=self.engine)
        self.db = Session(bind=self.engine)

    def tearDown(self):
        self.settings.ingest_async_normalization = self.old_async_normalization
        self.db.close()
        self.engine.dispose()

    def test_article_reference_metrics_use_existing_spec_code_and_usage_data(self):
        now = datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc)
        self.db.add_all(
            [
                AiSession(
                    session_id="session-metrics",
                    task_id="task-metrics",
                    tool="copilot",
                    status="completed",
                    username="lyl",
                    user_id="user-1",
                    started_at=now,
                    last_activity_at=now,
                ),
                AiTurn(
                    session_id="session-metrics",
                    task_id="task-metrics",
                    turn_index=1,
                    request_id="request-metrics",
                    response_id="response-metrics",
                    status="completed",
                    created_at=now,
                    completed_at=now,
                ),
                AiSpecAccess(
                    session_id="session-metrics",
                    task_id="task-metrics",
                    turn_index=1,
                    event_id="spec-read-a",
                    spec_scope="project",
                    doc_path="openspec/specs/a.md",
                    access_type="read",
                    matched_doc_count=1,
                    matched_docs=["openspec/specs/a.md"],
                    confidence="derived",
                    occurred_at=now,
                ),
                AiSpecAccess(
                    session_id="session-metrics",
                    task_id="task-metrics",
                    turn_index=1,
                    event_id="spec-read-b",
                    spec_scope="project",
                    doc_path="openspec/specs/b.md",
                    access_type="read",
                    matched_doc_count=1,
                    matched_docs=["openspec/specs/b.md"],
                    confidence="derived",
                    occurred_at=now,
                ),
                AiSpecAccess(
                    session_id="session-metrics",
                    task_id="task-metrics",
                    turn_index=1,
                    event_id="spec-edit-a",
                    spec_scope="project",
                    doc_path="openspec/specs/a.md",
                    access_type="edit",
                    matched_doc_count=1,
                    matched_docs=["openspec/specs/a.md"],
                    confidence="derived",
                    occurred_at=now,
                ),
                AiCodeChange(
                    session_id="session-metrics",
                    task_id="task-metrics",
                    turn_index=1,
                    request_id="request-metrics",
                    response_id="response-metrics",
                    event_id="ai-generated-a",
                    file_path="openspec/specs/a.md",
                    change_type="code_change",
                    snapshot_kind="copilot_turn_tool_patch",
                    lines_added=10,
                    lines_deleted=0,
                    is_effective=True,
                    diff_json={"snapshot_kind": "copilot_turn_tool_patch", "file_path": "openspec/specs/a.md"},
                    occurred_at=now,
                ),
                AiCodeChange(
                    session_id="session-metrics",
                    task_id="commit-123",
                    turn_index=None,
                    request_id=None,
                    response_id=None,
                    event_id="commit-a",
                    file_path="openspec/specs/a.md",
                    change_type="commit_snapshot",
                    snapshot_kind="commit_snapshot",
                    lines_added=6,
                    lines_deleted=0,
                    is_effective=True,
                    diff_json={
                        "snapshot_kind": "commit_snapshot",
                        "file_path": "openspec/specs/a.md",
                        "ai_current_lines_added": 4,
                        "ai_lines_added": 4,
                        "human_lines_added": 2,
                        "line_attribution": {
                            "hunks": [
                                {
                                    "lines": [
                                        {
                                            "line_type": "added",
                                            "classification": "ai_current",
                                            "matched_ai_event_id": "ai-generated-a",
                                        }
                                        for _ in range(4)
                                    ]
                                    + [
                                        {
                                            "line_type": "added",
                                            "classification": "human_current",
                                            "matched_ai_event_id": None,
                                        }
                                        for _ in range(2)
                                    ]
                                }
                            ]
                        },
                    },
                    occurred_at=now,
                ),
                AiRequestUsage(
                    session_id="session-metrics",
                    task_id="task-metrics",
                    turn_index=1,
                    request_id="request-metrics",
                    request_index=1,
                    model="oswe-vscode-prime",
                    prompt_tokens=100,
                    output_tokens=20,
                    completion_tokens=30,
                    copilot_credits=2.0,
                    occurred_at=now,
                ),
            ]
        )
        self.db.commit()

        result = knowledge_metrics(self.db)
        metrics_by_id = {
            metric["id"]: metric
            for category in result["categories"]
            for metric in category["metrics"]
        }

        self.assertEqual(metrics_by_id[33]["value"], 0.5)
        self.assertEqual(metrics_by_id[34]["value"], 1)
        self.assertEqual(metrics_by_id[35]["value"], 1.0)
        self.assertEqual(metrics_by_id[36]["value"], 0.4)
        self.assertEqual(metrics_by_id[37]["value"], 37.5)
        self.assertEqual(metrics_by_id[38]["value"], 0.5)
        self.assertEqual(metrics_by_id[39]["unit"], "table")
        self.assertEqual(metrics_by_id[40]["value"], 0)
        self.assertEqual(metrics_by_id[41]["value"], 2)
        project_details = next(category["details"] for category in result["categories"] if category["key"] == "project_knowledge_usage")
        by_doc = {doc["doc_path"]: doc for doc in project_details["project_doc_usage"]}
        self.assertEqual(by_doc["openspec/specs/a.md"]["conversion_rate"], 1.0)
        self.assertEqual(by_doc["openspec/specs/a.md"]["related_ai_generated_added_lines"], 10)
        self.assertEqual(by_doc["openspec/specs/a.md"]["related_ai_accepted_added_lines"], 4)
        self.assertEqual(by_doc["openspec/specs/a.md"]["related_adoption_rate"], 0.4)
        self.assertEqual(by_doc["openspec/specs/a.md"]["related_credit_policy"], "full_related_credit")
        self.assertIn("不代表文档直接贡献代码", by_doc["openspec/specs/a.md"]["related_adoption_note"])
        self.assertEqual(by_doc["openspec/specs/b.md"]["related_ai_generated_added_lines"], 10)
        self.assertEqual(by_doc["openspec/specs/b.md"]["related_ai_accepted_added_lines"], 4)
        self.assertEqual(by_doc["openspec/specs/b.md"]["related_adoption_rate"], 0.4)
        self.assertEqual(by_doc["openspec/specs/b.md"]["efficiency_bucket"], "高频低转化")

    def test_project_doc_related_adoption_flags_high_frequency_low_adoption_docs(self):
        now = datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc)
        self.db.add(
            AiSession(
                session_id="session-related-quadrant",
                task_id="task-related-quadrant",
                tool="copilot",
                status="completed",
                username="lyl",
                user_id="user-1",
                started_at=now,
                last_activity_at=now,
            )
        )
        for turn_index in (1, 2, 3):
            self.db.add(
                AiTurn(
                    session_id="session-related-quadrant",
                    task_id="task-related-quadrant",
                    turn_index=turn_index,
                    request_id=f"request-related-{turn_index}",
                    response_id=f"response-related-{turn_index}",
                    status="completed",
                    created_at=now,
                    completed_at=now,
                )
            )
        for turn_index in (1, 2):
            self.db.add_all(
                [
                    AiSpecAccess(
                        session_id="session-related-quadrant",
                        task_id="task-related-quadrant",
                        turn_index=turn_index,
                        event_id=f"spec-read-hot-low-{turn_index}",
                        spec_scope="project",
                        doc_path="openspec/specs/hot-low.md",
                        access_type="read",
                        matched_doc_count=1,
                        matched_docs=["openspec/specs/hot-low.md"],
                        confidence="derived",
                        occurred_at=now,
                    ),
                    AiCodeChange(
                        session_id="session-related-quadrant",
                        task_id="task-related-quadrant",
                        turn_index=turn_index,
                        request_id=f"request-related-{turn_index}",
                        response_id=f"response-related-{turn_index}",
                        event_id=f"ai-hot-low-{turn_index}",
                        file_path="src/example.py",
                        change_type="code_change",
                        snapshot_kind="copilot_turn_tool_patch",
                        lines_added=10,
                        lines_deleted=0,
                        is_effective=True,
                        diff_json={"snapshot_kind": "copilot_turn_tool_patch", "file_path": "src/example.py"},
                        occurred_at=now,
                    ),
                ]
            )
        self.db.add_all(
            [
                AiSpecAccess(
                    session_id="session-related-quadrant",
                    task_id="task-related-quadrant",
                    turn_index=3,
                    event_id="spec-read-good",
                    spec_scope="project",
                    doc_path="openspec/specs/good.md",
                    access_type="read",
                    matched_doc_count=1,
                    matched_docs=["openspec/specs/good.md"],
                    confidence="derived",
                    occurred_at=now,
                ),
                AiCodeChange(
                    session_id="session-related-quadrant",
                    task_id="task-related-quadrant",
                    turn_index=3,
                    request_id="request-related-3",
                    response_id="response-related-3",
                    event_id="ai-good",
                    file_path="src/good.py",
                    change_type="code_change",
                    snapshot_kind="copilot_turn_tool_patch",
                    lines_added=10,
                    lines_deleted=0,
                    is_effective=True,
                    diff_json={"snapshot_kind": "copilot_turn_tool_patch", "file_path": "src/good.py"},
                    occurred_at=now,
                ),
                AiCodeChange(
                    session_id="session-related-quadrant",
                    task_id="commit-good",
                    event_id="commit-good",
                    file_path="src/good.py",
                    change_type="commit_snapshot",
                    snapshot_kind="commit_snapshot",
                    lines_added=10,
                    lines_deleted=0,
                    is_effective=True,
                    diff_json={
                        "snapshot_kind": "commit_snapshot",
                        "file_path": "src/good.py",
                        "line_attribution": {
                            "hunks": [
                                {
                                    "lines": [
                                        {
                                            "line_type": "added",
                                            "classification": "ai_current",
                                            "matched_ai_event_id": "ai-good",
                                        }
                                        for _ in range(10)
                                    ]
                                }
                            ]
                        },
                    },
                    occurred_at=now,
                ),
            ]
        )
        self.db.commit()

        result = knowledge_metrics(self.db)
        metrics_by_id = {
            metric["id"]: metric
            for category in result["categories"]
            for metric in category["metrics"]
        }
        project_details = next(category["details"] for category in result["categories"] if category["key"] == "project_knowledge_usage")
        by_doc = {doc["doc_path"]: doc for doc in project_details["project_doc_usage"]}

        self.assertEqual(metrics_by_id[40]["value"], 1)
        self.assertEqual(by_doc["openspec/specs/hot-low.md"]["read_count"], 2)
        self.assertEqual(by_doc["openspec/specs/hot-low.md"]["related_ai_generated_added_lines"], 20)
        self.assertEqual(by_doc["openspec/specs/hot-low.md"]["related_ai_accepted_added_lines"], 0)
        self.assertEqual(by_doc["openspec/specs/hot-low.md"]["related_adoption_rate"], 0.0)
        self.assertEqual(by_doc["openspec/specs/hot-low.md"]["related_efficiency_bucket"], "高频低关联采纳")

    def test_project_doc_related_adoption_does_not_allocate_summary_only_commit_lines(self):
        now = datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc)
        self.db.add_all(
            [
                AiSession(
                    session_id="session-summary-only",
                    task_id="task-summary-only",
                    tool="copilot",
                    status="completed",
                    username="lyl",
                    user_id="user-1",
                    started_at=now,
                    last_activity_at=now,
                ),
                AiTurn(
                    session_id="session-summary-only",
                    task_id="task-summary-only",
                    turn_index=1,
                    request_id="request-summary-only",
                    response_id="response-summary-only",
                    status="completed",
                    created_at=now,
                    completed_at=now,
                ),
                AiSpecAccess(
                    session_id="session-summary-only",
                    task_id="task-summary-only",
                    turn_index=1,
                    event_id="spec-read-summary-only",
                    spec_scope="project",
                    doc_path="openspec/specs/summary.md",
                    access_type="read",
                    matched_doc_count=1,
                    matched_docs=["openspec/specs/summary.md"],
                    confidence="derived",
                    occurred_at=now,
                ),
                AiCodeChange(
                    session_id="session-summary-only",
                    task_id="task-summary-only",
                    turn_index=1,
                    request_id="request-summary-only",
                    response_id="response-summary-only",
                    event_id="ai-summary-only",
                    file_path="src/summary.py",
                    change_type="code_change",
                    snapshot_kind="copilot_turn_tool_patch",
                    lines_added=7,
                    lines_deleted=0,
                    is_effective=True,
                    diff_json={"snapshot_kind": "copilot_turn_tool_patch", "file_path": "src/summary.py"},
                    occurred_at=now,
                ),
                AiCodeChange(
                    session_id="session-summary-only",
                    task_id="commit-summary-only",
                    event_id="commit-summary-only",
                    file_path="src/summary.py",
                    change_type="commit_snapshot",
                    snapshot_kind="commit_snapshot",
                    lines_added=7,
                    lines_deleted=0,
                    is_effective=True,
                    diff_json={
                        "snapshot_kind": "commit_snapshot",
                        "file_path": "src/summary.py",
                        "matched_ai_change_event_ids": ["ai-summary-only"],
                        "line_attribution_summary": {"ai_current_lines_added": 7},
                        "line_attribution": {"full_line_attribution": False},
                    },
                    occurred_at=now,
                ),
            ]
        )
        self.db.commit()

        result = knowledge_metrics(self.db)
        project_details = next(category["details"] for category in result["categories"] if category["key"] == "project_knowledge_usage")
        by_doc = {doc["doc_path"]: doc for doc in project_details["project_doc_usage"]}
        doc = by_doc["openspec/specs/summary.md"]

        self.assertEqual(doc["related_ai_generated_added_lines"], 7)
        self.assertEqual(doc["related_ai_accepted_added_lines"], 0)
        self.assertEqual(doc["related_unallocated_accepted_lines"], 7)
        self.assertEqual(doc["related_adoption_rate"], 0.0)
        self.assertEqual(project_details["related_unallocated_accepted_lines"], 7)

    def test_plugin_heartbeat_is_operational_not_business_raw(self):
        event = EventIn(
            event_id="heartbeat-123456",
            task_id="heartbeat-task",
            tool="copilot",
            event_type="plugin_heartbeat",
            occurred_at=datetime(2026, 6, 24, tzinfo=timezone.utc),
            payload={"activation": "vscode"},
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.24",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            events=[event],
        )

        result = ingest_batch(self.db, batch)

        self.assertEqual(result["accepted"], 1)
        self.assertEqual(result["events"][0]["status"], "accepted")
        self.assertEqual(self.db.execute(select(PluginClient)).scalars().one().client_id, "client-1")
        self.assertEqual(self.db.execute(select(PluginHeartbeat)).scalars().one().event_id, "heartbeat-123456")
        self.assertEqual(self.db.execute(select(RawIngestEvent)).scalars().all(), [])

    def test_turn_snapshot_is_queued_then_worker_normalizes_product_tables(self):
        event = EventIn(
            event_id="turn-1234567890",
            task_id="task-12345678",
            session_id="copilot-session",
            tool="copilot",
            event_type="turn_snapshot",
            occurred_at=datetime(2026, 6, 24, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "copilot-session",
                "request_id": "request-1",
                "response_id": "response-1",
                "title": "架构分析",
                "turn": {
                    "turn_index": 1,
                    "request_id": "request-1",
                    "response_id": "response-1",
                    "status": "completed",
                    "started_at": "2026-06-24T10:00:01Z",
                    "completed_at": "2026-06-24T10:00:10Z",
                },
                "messages": [
                    {"role": "user", "text": "给我分析系统架构", "source_key": "request-1:user"},
                    {"role": "assistant", "text": "最终回答", "source_key": "request-1:response-1:assistant"},
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.25",
            username="lyl",
            user_id="user-1",
            events=[event],
        )

        result = ingest_batch(self.db, batch)

        self.assertEqual(result["accepted"], 1)
        self.assertEqual(self.db.execute(select(RawIngestEvent)).scalars().one().event_id, "turn-1234567890")
        self.assertEqual(self.db.execute(select(IngestJob)).scalars().one().status, "pending")
        self.assertEqual(self.db.execute(select(NormalizedIngestEvent)).scalars().all(), [])
        self.assertEqual(self.db.execute(select(AiSession)).scalars().all(), [])

        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")

        self.assertEqual(stats["succeeded"], 1)
        self.assertEqual(self.db.execute(select(IngestJob)).scalars().one().status, "succeeded")
        self.assertEqual(self.db.execute(select(NormalizedIngestEvent)).scalars().one().raw_event_id, "turn-1234567890")
        self.assertEqual(self.db.get(AiSession, "copilot-session").title, "架构分析")
        self.assertEqual(
            [(message.role, message.content) for message in self.db.execute(select(AiMessage).order_by(AiMessage.message_index)).scalars().all()],
            [("user", "给我分析系统架构"), ("assistant", "最终回答")],
        )

    def test_turn_snapshot_full_pipeline_persists_tables_and_api_display(self):
        large_tool_result = "secret-api-key=sk-test-keep-raw\n" + ("tool-result-line\n" * 200)
        compressed = gzip.compress(large_tool_result.encode("utf-8"))
        patch = (
            "*** Begin Patch\n"
            "*** Update File: collector-server/tests/hello.py\n"
            "@@\n"
            "-old = True\n"
            "+new = True\n"
            "+print('done')\n"
            "*** End Patch\n"
        )
        event = EventIn(
            event_id="turn-full-pipeline",
            task_id="task-full-pipeline",
            session_id="copilot-session",
            tool="copilot",
            event_type="turn_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 5, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "copilot-session",
                "request_id": "request-full",
                "response_id": "response-full",
                "title": "完整链路测试",
                "resolved_model": "oswe-vscode-prime",
                "turn": {
                    "turn_index": 1,
                    "request_id": "request-full",
                    "response_id": "response-full",
                    "status": "completed",
                    "started_at": "2026-06-24T10:00:01Z",
                    "completed_at": "2026-06-24T10:00:10Z",
                },
                "messages": [
                    {
                        "role": "user",
                        "text": "给我写代码",
                        "source_key": "request-full:user",
                        "occurred_at": "2026-06-24T10:00:01Z",
                    },
                    {
                        "role": "assistant",
                        "text": "代码已完成",
                        "source_key": "request-full:assistant",
                        "occurred_at": "2026-06-24T10:00:10Z",
                    },
                ],
                "process_steps": [
                    {
                        "step_id": "step-apply-patch",
                        "step_type": "tool_call",
                        "title": "apply_patch",
                        "text": "Applied patch",
                        "tool_name": "apply_patch",
                        "tool_call_id": "tool-1",
                        "status": "completed",
                        "occurred_at": "2026-06-24T10:00:06Z",
                    }
                ],
                "tool_calls": [
                    {
                        "tool_call_id": "tool-1",
                        "tool_name": "apply_patch",
                        "status": "completed",
                        "completed_at": "2026-06-24T10:00:06Z",
                        "arguments_raw": json.dumps({"input": patch}),
                        "result_raw": {"blob_ref": "tool_calls.0.result_raw"},
                    }
                ],
                "request_usage": [
                    {
                        "request_id": "request-full",
                        "response_id": "response-full",
                        "request_index": 0,
                        "model": "oswe-vscode-prime",
                        "prompt_tokens": 123,
                        "output_tokens": 45,
                        "completion_tokens": 45,
                        "elapsed_ms": 9000,
                        "copilot_credits": 1.5,
                        "credits_source": "copilot",
                    }
                ],
                "usage_totals": {
                    "prompt_tokens": 123,
                    "output_tokens": 45,
                    "completion_tokens": 45,
                    "elapsed_ms": 9000,
                    "copilot_credits": 1.5,
                },
                "raw_event_blobs": [
                    {
                        "blob_key": "tool_calls.0.result_raw",
                        "encoding": "gzip+base64",
                        "value_type": "text",
                        "sha256": hashlib.sha256(large_tool_result.encode("utf-8")).hexdigest(),
                        "original_bytes": len(large_tool_result.encode("utf-8")),
                        "compressed_bytes": len(compressed),
                        "chunks": [base64.b64encode(compressed).decode("ascii")],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.28",
            username="lyl",
            user_id="user-1",
            events=[event],
        )

        result = ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        raw = self.db.get(RawIngestEvent, "turn-full-pipeline")
        normalized = self.db.execute(select(NormalizedIngestEvent)).scalars().one()
        detail = get_session_detail("copilot-session", db=self.db)
        blob = get_raw_event_blob("turn-full-pipeline", "tool_calls.0.result_raw", db=self.db)

        self.assertEqual(result["accepted"], 1)
        self.assertEqual(stats["succeeded"], 1)
        self.assertIsNotNone(raw)
        self.assertNotIn("raw_event_blobs", raw.raw_json["event"]["payload"])
        self.assertEqual(self.db.execute(select(RawEventBlob)).scalars().one().blob_key, "tool_calls.0.result_raw")
        self.assertEqual(normalized.raw_event_id, "turn-full-pipeline")
        self.assertEqual(self.db.get(AiSession, "copilot-session").title, "完整链路测试")
        self.assertEqual(self.db.execute(select(AiTurn)).scalars().one().request_id, "request-full")
        self.assertEqual(len(self.db.execute(select(AiMessage)).scalars().all()), 2)
        self.assertEqual(self.db.execute(select(AiProcessStep)).scalars().one().tool_call_id, "tool-1")
        self.assertEqual(self.db.execute(select(AiRequestUsage)).scalars().one().prompt_tokens, 123)
        self.assertEqual(detail["turns"][0]["user_messages"][0]["content"], "给我写代码")
        self.assertEqual(detail["turns"][0]["assistant_messages"][0]["content"], "代码已完成")
        self.assertEqual(detail["turns"][0]["process_steps"][0]["tool_call_id"], "tool-1")
        self.assertEqual(detail["turns"][0]["request_usage"]["model"], "oswe-vscode-prime")
        self.assertEqual(detail["turns"][0]["code_changes"][0]["snapshot_kind"], "copilot_turn_tool_patch")
        self.assertEqual(detail["turns"][0]["code_changes"][0]["lines_added"], 2)
        self.assertEqual(detail["turns"][0]["code_changes"][0]["lines_deleted"], 1)
        self.assertEqual(blob["content"], large_tool_result)

    def test_claude_conversation_and_turn_snapshots_do_not_duplicate_messages(self):
        conversation_event = EventIn(
            event_id="claude-conv-no-dupe",
            task_id="claude-session-no-dupe",
            session_id="claude-session-no-dupe",
            tool="claude",
            event_type="conversation_snapshot",
            occurred_at=datetime(2026, 6, 29, 7, 25, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "claude-session-no-dupe",
                "title": "你好",
                "session_status": "completed",
                "resolved_model": "claude-opus-4-6",
                "messages": [
                    {
                        "role": "user",
                        "text": "你好",
                        "message_id": "claude-message-user-1",
                        "turn_index": 1,
                        "occurred_at": "2026-06-29T07:25:01Z",
                    },
                    {
                        "role": "assistant",
                        "text": "你好！有什么我可以帮您的吗？",
                        "message_id": "claude-message-assistant-1",
                        "turn_index": 1,
                        "occurred_at": "2026-06-29T07:25:06Z",
                    },
                ],
            },
        )
        turn_event = EventIn(
            event_id="claude-turn-no-dupe",
            task_id="claude-session-no-dupe",
            session_id="claude-session-no-dupe",
            tool="claude",
            event_type="turn_snapshot",
            occurred_at=datetime(2026, 6, 29, 7, 25, 8, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "claude-session-no-dupe",
                "request_id": "claude-request-1",
                "response_id": "claude-response-1",
                "title": "你好",
                "resolved_model": "claude-opus-4-6",
                "turn": {
                    "turn_index": 1,
                    "request_id": "claude-request-1",
                    "response_id": "claude-response-1",
                    "status": "completed",
                    "started_at": "2026-06-29T07:25:01Z",
                    "completed_at": "2026-06-29T07:25:06Z",
                },
                "messages": [
                    {
                        "role": "user",
                        "text": "你好",
                        "source_key": "msg_20260629072501_user",
                        "occurred_at": "2026-06-29T07:25:01Z",
                    },
                    {
                        "role": "assistant",
                        "text": "你好！有什么我可以帮您的吗？",
                        "source_key": "msg_20260629072506_assistant",
                        "occurred_at": "2026-06-29T07:25:06Z",
                    },
                ],
            },
        )
        batch = BatchIn(
            client_id="client-claude",
            plugin_name="tinyai-observability-claude",
            plugin_version="0.1.36",
            username="lyl",
            user_id="user-1",
            events=[conversation_event, turn_event],
        )

        result = ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        messages = self.db.execute(select(AiMessage).order_by(AiMessage.message_index)).scalars().all()
        detail = get_session_detail("claude-session-no-dupe", db=self.db)

        self.assertEqual(result["accepted"], 2)
        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(len(self.db.execute(select(AiTurn)).scalars().all()), 1)
        self.assertEqual([(message.role, message.content) for message in messages], [("user", "你好"), ("assistant", "你好！有什么我可以帮您的吗？")])
        self.assertEqual(len(detail["turns"][0]["user_messages"]), 1)
        self.assertEqual(len(detail["turns"][0]["assistant_messages"]), 1)

    def test_session_detail_does_not_mix_same_index_different_request_evidence(self):
        occurred = datetime(2026, 6, 30, 3, 42, tzinfo=timezone.utc)
        self.db.add(
            AiSession(
                session_id="claude-mixed-session",
                task_id="claude-mixed-session",
                tool="claude",
                status="completed",
                title="给我看看系统架构",
                started_at=occurred,
                last_activity_at=occurred,
            )
        )
        self.db.flush()
        agent_turn = AiTurn(
            session_id="claude-mixed-session",
            task_id="claude-mixed-session",
            turn_index=1,
            request_id="request-agent",
            response_id="response-agent",
            status="in_progress",
            created_at=occurred,
            completed_at=occurred,
        )
        user_turn = AiTurn(
            session_id="claude-mixed-session",
            task_id="claude-mixed-session",
            turn_index=1,
            request_id="request-user",
            response_id="response-user",
            status="completed",
            created_at=occurred,
            completed_at=occurred,
        )
        self.db.add_all([agent_turn, user_turn])
        self.db.flush()
        self.db.add_all(
            [
                AiMessage(
                    session_id="claude-mixed-session",
                    task_id="claude-mixed-session",
                    turn_id=agent_turn.id,
                    turn_index=1,
                    message_index=0,
                    role="user",
                    content="Explore the repository",
                    occurred_at=occurred,
                ),
                AiMessage(
                    session_id="claude-mixed-session",
                    task_id="claude-mixed-session",
                    turn_id=user_turn.id,
                    turn_index=1,
                    message_index=1,
                    role="user",
                    content="给我看看系统架构",
                    occurred_at=occurred,
                ),
                AiProcessStep(
                    session_id="claude-mixed-session",
                    task_id="claude-mixed-session",
                    turn_id=agent_turn.id,
                    turn_index=1,
                    request_id="request-agent",
                    response_id="response-agent",
                    step_index=1,
                    step_type="tool_call",
                    tool_name="run_in_terminal",
                    content="ls -la plugins/",
                    occurred_at=occurred,
                ),
                AiCodeChange(
                    session_id="claude-mixed-session",
                    task_id="claude-mixed-session",
                    turn_id=agent_turn.id,
                    turn_index=1,
                    request_id="request-agent",
                    response_id="response-agent",
                    event_id="agent-bash-delta",
                    file_path="plugins",
                    change_type="claude_turn_bash_delta",
                    snapshot_kind="claude_turn_bash_delta",
                    lines_added=0,
                    lines_deleted=6,
                    is_effective=True,
                    occurred_at=occurred,
                ),
                AiCodeChange(
                    session_id="claude-mixed-session",
                    task_id="claude-mixed-session",
                    turn_index=None,
                    event_id="empty-code-change",
                    file_path=None,
                    change_type="code_change",
                    snapshot_kind="code_change",
                    lines_added=0,
                    lines_deleted=0,
                    is_effective=True,
                    diff_json={"files_changed": 0, "line_stats": {"has_line_level_diff": False}},
                    occurred_at=occurred,
                ),
            ]
        )
        self.db.commit()

        detail = get_session_detail("claude-mixed-session", db=self.db)

        self.assertEqual(len(detail["turns"]), 1)
        self.assertEqual(detail["turns"][0]["request_id"], "request-user")
        self.assertEqual([message["content"] for message in detail["turns"][0]["user_messages"]], ["给我看看系统架构"])
        self.assertEqual(detail["turns"][0]["process_steps"], [])
        self.assertEqual(detail["turns"][0]["code_changes"], [])
        self.assertEqual(detail["unassigned_process_steps"], [])
        self.assertEqual(detail["unassigned_code_changes"], [])

    def test_claude_segment_relative_turn_indexes_merge_by_request_id(self):
        def turn_event(
            event_id: str,
            turn_index: int,
            request_id: str,
            response_id: str,
            status: str,
            user_text: str,
            assistant_text: str | None,
            occurred_at: datetime,
        ) -> EventIn:
            messages = [
                {
                    "role": "user",
                    "text": user_text,
                    "source_key": f"{request_id}:user",
                    "turn_index": turn_index,
                    "occurred_at": occurred_at.isoformat().replace("+00:00", "Z"),
                }
            ]
            if assistant_text is not None:
                messages.append(
                    {
                        "role": "assistant",
                        "text": assistant_text,
                        "source_key": f"{request_id}:{response_id}:assistant",
                        "turn_index": turn_index,
                        "occurred_at": occurred_at.isoformat().replace("+00:00", "Z"),
                    }
                )
            return EventIn(
                event_id=event_id,
                task_id="claude-session-segment",
                session_id="claude-session-segment",
                tool="claude",
                event_type="turn_snapshot",
                occurred_at=occurred_at,
                source_confidence="derived",
                username="zhangsan",
                user_id="zhangsan@example.com",
                payload={
                    "session_id": "claude-session-segment",
                    "request_id": request_id,
                    "response_id": response_id,
                    "title": "Claude 分段日志",
                    "resolved_model": "deepseek-v4-pro",
                    "turn": {
                        "turn_index": turn_index,
                        "request_id": request_id,
                        "response_id": response_id,
                        "status": status,
                        "started_at": occurred_at.isoformat().replace("+00:00", "Z"),
                        "completed_at": occurred_at.isoformat().replace("+00:00", "Z") if status == "completed" else None,
                    },
                    "messages": messages,
                },
            )

        batch = BatchIn(
            client_id="client-claude-segment",
            plugin_name="tinyai-observability-claude",
            plugin_version="0.1.38",
            username="zhangsan",
            user_id="zhangsan@example.com",
            events=[
                # VS Code full-file scanner sees these as real turn 3/4 while
                # the assistant answer is still being written.
                turn_event(
                    "claude-partial-turn3",
                    3,
                    "request-style",
                    "response-style-progress",
                    "incomplete",
                    "修改一下刘芸隆md 修改里面的风格",
                    None,
                    datetime(2026, 6, 29, 15, 13, 9, tzinfo=timezone.utc),
                ),
                turn_event(
                    "claude-partial-turn4",
                    4,
                    "request-wuxia",
                    "response-wuxia-progress",
                    "incomplete",
                    "武侠风",
                    None,
                    datetime(2026, 6, 29, 15, 14, 19, tzinfo=timezone.utc),
                ),
                # Claude hook reads only a later segment, so the same request IDs
                # arrive as segment-relative turn 1/2 with final assistant text.
                turn_event(
                    "claude-complete-segment1",
                    1,
                    "request-style",
                    "response-style-final",
                    "completed",
                    "修改一下刘芸隆md 修改里面的风格",
                    "想改成什么风格？",
                    datetime(2026, 6, 29, 15, 18, 20, tzinfo=timezone.utc),
                ),
                turn_event(
                    "claude-complete-segment2",
                    2,
                    "request-wuxia",
                    "response-wuxia-final",
                    "completed",
                    "武侠风",
                    "改好了！刘芸隆.md 已变身武侠风。",
                    datetime(2026, 6, 29, 15, 18, 33, tzinfo=timezone.utc),
                ),
            ],
        )

        result = ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        turns = self.db.execute(select(AiTurn).order_by(AiTurn.turn_index.asc())).scalars().all()
        detail = get_session_detail("claude-session-segment", db=self.db)

        self.assertEqual(result["accepted"], 4)
        self.assertEqual(stats["succeeded"], 4)
        self.assertEqual([(turn.turn_index, turn.request_id, turn.status) for turn in turns], [(3, "request-style", "completed"), (4, "request-wuxia", "completed")])
        self.assertEqual([turn["turn_index"] for turn in detail["turns"]], [3, 4])
        self.assertEqual(detail["turns"][0]["user_messages"][0]["content"], "修改一下刘芸隆md 修改里面的风格")
        self.assertIn("想改成什么风格", detail["turns"][0]["assistant_messages"][0]["content"])
        self.assertEqual(detail["turns"][1]["user_messages"][0]["content"], "武侠风")
        self.assertIn("已变身武侠风", detail["turns"][1]["assistant_messages"][0]["content"])

    def test_claude_completed_turn_is_not_downgraded_by_late_incomplete_replay(self):
        def turn_event(
            event_id: str,
            turn_index: int,
            request_id: str,
            response_id: str,
            status: str,
            user_text: str,
            assistant_text: str | None,
            occurred_at: datetime,
        ) -> EventIn:
            messages = [
                {
                    "role": "user",
                    "text": user_text,
                    "source_key": f"{request_id}:user",
                    "turn_index": turn_index,
                    "occurred_at": occurred_at.isoformat().replace("+00:00", "Z"),
                }
            ]
            if assistant_text:
                messages.append(
                    {
                        "role": "assistant",
                        "text": assistant_text,
                        "source_key": f"{request_id}:{response_id}:assistant",
                        "turn_index": turn_index,
                        "occurred_at": occurred_at.isoformat().replace("+00:00", "Z"),
                    }
                )
            return EventIn(
                event_id=event_id,
                task_id="claude-session-late-replay",
                session_id="claude-session-late-replay",
                tool="claude",
                event_type="turn_snapshot",
                occurred_at=occurred_at,
                source_confidence="derived",
                username="zhangsan",
                user_id="zhangsan@example.com",
                payload={
                    "session_id": "claude-session-late-replay",
                    "request_id": request_id,
                    "response_id": response_id,
                    "title": user_text,
                    "resolved_model": "claude-opus-4-6",
                    "turn": {
                        "turn_index": turn_index,
                        "request_id": request_id,
                        "response_id": response_id,
                        "status": status,
                        "started_at": occurred_at.isoformat().replace("+00:00", "Z"),
                        "completed_at": occurred_at.isoformat().replace("+00:00", "Z") if status == "completed" else None,
                    },
                    "messages": messages,
                },
            )

        batch = BatchIn(
            client_id="client-claude-replay",
            plugin_name="tinyai-observability-claude",
            plugin_version="0.1.38",
            username="zhangsan",
            user_id="zhangsan@example.com",
            events=[
                turn_event(
                    "claude-completed-first",
                    3,
                    "request-happy",
                    "response-happy-final",
                    "completed",
                    "开心的分割",
                    "已经改成开心风格。",
                    datetime(2026, 6, 29, 15, 20, tzinfo=timezone.utc),
                ),
                turn_event(
                    "claude-late-incomplete-replay",
                    1,
                    "request-happy",
                    "request-happy:no_response",
                    "incomplete",
                    "开心的分割",
                    None,
                    datetime(2026, 6, 29, 15, 21, tzinfo=timezone.utc),
                ),
            ],
        )

        result = ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        turns = self.db.execute(select(AiTurn).order_by(AiTurn.turn_index.asc())).scalars().all()
        detail = get_session_detail("claude-session-late-replay", db=self.db)

        self.assertEqual(result["accepted"], 2)
        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0].turn_index, 3)
        self.assertEqual(turns[0].request_id, "request-happy")
        self.assertEqual(turns[0].response_id, "response-happy-final")
        self.assertEqual(turns[0].status, "completed")
        self.assertEqual(len(detail["turns"]), 1)
        self.assertEqual(detail["turns"][0]["user_messages"][0]["content"], "开心的分割")
        self.assertEqual(detail["turns"][0]["assistant_messages"][0]["content"], "已经改成开心风格。")

    def test_session_detail_hides_legacy_duplicate_messages(self):
        now = datetime(2026, 6, 29, 7, 25, tzinfo=timezone.utc)
        text_hash = hashlib.sha256("你好！有什么我可以帮您的吗？".encode("utf-8")).hexdigest()
        self.db.add(
            AiSession(
                session_id="legacy-dupe-session",
                task_id="legacy-dupe-session",
                tool="claude",
                status="completed",
                title="你好",
                username="lyl",
                user_id="user-1",
                started_at=now,
                last_activity_at=now,
            )
        )
        self.db.flush()
        turn = AiTurn(
            session_id="legacy-dupe-session",
            task_id="legacy-dupe-session",
            turn_index=1,
            status="completed",
            created_at=now,
            completed_at=now,
        )
        self.db.add(turn)
        self.db.flush()
        self.db.add_all(
            [
                AiMessage(
                    session_id="legacy-dupe-session",
                    task_id="legacy-dupe-session",
                    turn_id=turn.id,
                    message_index=0,
                    turn_index=1,
                    role="user",
                    content="你好",
                    text_len=2,
                    text_hash=hashlib.sha256("你好".encode("utf-8")).hexdigest(),
                    source_key="legacy-user",
                    occurred_at=now,
                ),
                AiMessage(
                    session_id="legacy-dupe-session",
                    task_id="legacy-dupe-session",
                    turn_id=turn.id,
                    message_index=1,
                    turn_index=1,
                    role="assistant",
                    content="你好！有什么我可以帮您的吗？",
                    text_len=15,
                    text_hash=text_hash,
                    source_key="legacy-assistant-conversation",
                    occurred_at=now,
                ),
                AiMessage(
                    session_id="legacy-dupe-session",
                    task_id="legacy-dupe-session",
                    turn_id=turn.id,
                    message_index=2,
                    turn_index=1,
                    role="assistant",
                    content="你好！有什么我可以帮您的吗？",
                    text_len=15,
                    text_hash=text_hash,
                    source_key="legacy-assistant-turn",
                    occurred_at=now,
                ),
            ]
        )
        self.db.commit()

        detail = get_session_detail("legacy-dupe-session", db=self.db)

        self.assertEqual(len(detail["turns"][0]["user_messages"]), 1)
        self.assertEqual(len(detail["turns"][0]["assistant_messages"]), 1)
        self.assertEqual(detail["turns"][0]["assistant_messages"][0]["content"], "你好！有什么我可以帮您的吗？")

    def test_turn_snapshot_derives_specs_accesses_into_product_table(self):
        patch = (
            "*** Begin Patch\n"
            "*** Update File: /Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/architecture.md\n"
            "@@\n"
            "-旧架构\n"
            "+新架构\n"
            "*** End Patch\n"
        )
        event = EventIn(
            event_id="turn-spec-access",
            task_id="task-spec-access",
            session_id="copilot-spec-session",
            tool="copilot",
            event_type="turn_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 5, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "copilot-spec-session",
                "request_id": "request-spec",
                "response_id": "response-spec",
                "turn": {
                    "turn_index": 1,
                    "request_id": "request-spec",
                    "response_id": "response-spec",
                    "status": "completed",
                    "started_at": "2026-06-24T10:00:01Z",
                    "completed_at": "2026-06-24T10:00:10Z",
                },
                "messages": [
                    {"role": "user", "text": "先读规范再修改", "source_key": "request-spec:user"},
                    {"role": "assistant", "text": "已处理", "source_key": "request-spec:assistant"},
                ],
                "tool_calls": [
                    {
                        "tool_call_id": "tool-read",
                        "tool_name": "read_file",
                        "status": "complete",
                        "arguments_raw": json.dumps(
                            {
                                "filePath": "/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/architecture.md",
                            }
                        ),
                    },
                    {
                        "tool_call_id": "tool-patch",
                        "tool_name": "apply_patch",
                        "status": "complete",
                        "arguments_raw": json.dumps({"input": patch}, ensure_ascii=False),
                    },
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.32",
            username="lyl",
            user_id="user-1",
            events=[event],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        accesses = self.db.execute(select(AiSpecAccess).order_by(AiSpecAccess.id.asc())).scalars().all()

        self.assertEqual(stats["succeeded"], 1)
        self.assertEqual(
            [(access.doc_path, access.matched_by[2]) for access in accesses],
            [
                ("openspec/specs/architecture.md", "access:read"),
                ("openspec/specs/architecture.md", "access:edit"),
            ],
        )
        self.assertTrue(all(access.spec_scope == "project" for access in accesses))
        self.assertTrue(all(access.confidence == "derived" for access in accesses))
        self.assertEqual([access.access_type for access in accesses], ["read", "edit"])
        self.assertEqual([access.matched_doc_count for access in accesses], [1, 1])
        self.assertEqual(accesses[0].matched_docs, ["openspec/specs/architecture.md"])

    def test_turn_snapshot_persists_batch_spec_access_action_with_document_count(self):
        event = EventIn(
            event_id="turn-spec-batch-access",
            task_id="task-spec-batch-access",
            session_id="copilot-spec-batch-session",
            tool="copilot",
            event_type="turn_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 5, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "copilot-spec-batch-session",
                "request_id": "request-spec-batch",
                "response_id": "response-spec-batch",
                "turn": {
                    "turn_index": 1,
                    "request_id": "request-spec-batch",
                    "response_id": "response-spec-batch",
                    "status": "completed",
                    "started_at": "2026-06-24T10:00:01Z",
                    "completed_at": "2026-06-24T10:00:10Z",
                },
                "messages": [
                    {"role": "user", "text": "读取 specs", "source_key": "request-spec-batch:user"},
                    {"role": "assistant", "text": "已读取", "source_key": "request-spec-batch:assistant"},
                ],
                "spec_accesses": [
                    {
                        "spec_scope": "project",
                        "doc_path": "openspec/specs",
                        "access_type": "read",
                        "access_source": "terminal_command",
                        "matched_doc_count": 2,
                        "matched_docs": ["openspec/specs/a.md", "openspec/specs/b.md"],
                        "matched_by": ["derived", "terminal_command", "access:read", "tool:run_in_terminal"],
                        "confidence": "derived",
                        "occurred_at": "2026-06-24T10:00:06Z",
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.32",
            username="lyl",
            user_id="user-1",
            events=[event],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        access = self.db.execute(select(AiSpecAccess)).scalars().one()

        self.assertEqual(stats["succeeded"], 1)
        self.assertEqual(access.doc_path, "openspec/specs")
        self.assertEqual(access.access_type, "read")
        self.assertEqual(access.access_source, "terminal_command")
        self.assertEqual(access.matched_doc_count, 2)
        self.assertEqual(access.matched_docs, ["openspec/specs/a.md", "openspec/specs/b.md"])

    def test_turn_snapshot_persists_project_spec_document_catalog(self):
        event = EventIn(
            event_id="turn-spec-documents",
            task_id="task-spec-documents",
            session_id="copilot-spec-documents-session",
            workspace_path_hash="workspace-1",
            tool="copilot",
            event_type="turn_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 5, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            host_hash="host-1",
            payload={
                "session_id": "copilot-spec-documents-session",
                "request_id": "request-spec-documents",
                "response_id": "response-spec-documents",
                "turn": {
                    "turn_index": 1,
                    "request_id": "request-spec-documents",
                    "response_id": "response-spec-documents",
                    "status": "completed",
                    "started_at": "2026-06-24T10:00:01Z",
                    "completed_at": "2026-06-24T10:00:10Z",
                },
                "messages": [
                    {"role": "user", "text": "读取 specs", "source_key": "request-spec-documents:user"},
                    {"role": "assistant", "text": "已读取", "source_key": "request-spec-documents:assistant"},
                ],
                "spec_documents": [
                    {
                        "doc_path": "openspec/specs/architecture.md",
                        "file_name": "architecture.md",
                        "size_bytes": 120,
                        "line_count": 8,
                        "content_hash": "a" * 64,
                        "mtime_ms": 123.4,
                    },
                    {
                        "doc_path": "openspec/specs/conventions.md",
                        "file_name": "conventions.md",
                        "size_bytes": 80,
                        "line_count": 4,
                        "content_hash": "b" * 64,
                        "mtime_ms": 124.4,
                    },
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.32",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            events=[event],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        documents = self.db.execute(select(AiSpecDocument).order_by(AiSpecDocument.doc_path)).scalars().all()

        self.assertEqual(stats["succeeded"], 1)
        self.assertEqual([document.doc_path for document in documents], ["openspec/specs/architecture.md", "openspec/specs/conventions.md"])
        self.assertEqual(documents[0].workspace_path_hash, "workspace-1")
        self.assertEqual(documents[0].client_id, "client-1")
        self.assertEqual(documents[0].line_count, 8)
        self.assertEqual(documents[0].content_hash, "a" * 64)

    def test_raw_turn_snapshot_dedupes_spec_access_from_tool_and_code_change_sources(self):
        event = EventIn(
            event_id="raw-spec-edit-dedupe",
            task_id="task-raw-spec-edit-dedupe",
            session_id="session-raw-spec-edit-dedupe",
            tool="copilot",
            event_type="turn_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 5, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "session-raw-spec-edit-dedupe",
                "request_id": "request-spec-edit-dedupe",
                "response_id": "response-spec-edit-dedupe",
                "turn": {
                    "turn_index": 1,
                    "request_id": "request-spec-edit-dedupe",
                    "response_id": "response-spec-edit-dedupe",
                    "status": "completed",
                    "started_at": "2026-06-24T10:00:01Z",
                    "completed_at": "2026-06-24T10:00:10Z",
                },
                "messages": [
                    {"role": "user", "text": "修改规范文档", "source_key": "request-spec-edit-dedupe:user"},
                    {"role": "assistant", "text": "已修改", "source_key": "request-spec-edit-dedupe:assistant"},
                ],
                "tool_calls": [
                    {
                        "tool_call_id": "tool-replace-spec",
                        "tool_name": "replace_string_in_file",
                        "status": "complete",
                        "arguments_raw": json.dumps(
                            {
                                "filePath": "/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/guide.md",
                                "oldString": "旧规范",
                                "newString": "新规范",
                            },
                            ensure_ascii=False,
                        ),
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.33",
            username="lyl",
            user_id="user-1",
            events=[event],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        raw = self.db.get(RawIngestEvent, "raw-spec-edit-dedupe")
        accesses = self.db.execute(select(AiSpecAccess).order_by(AiSpecAccess.id)).scalars().all()
        changes = self.db.execute(select(AiCodeChange).order_by(AiCodeChange.id)).scalars().all()

        self.assertEqual(stats["succeeded"], 1)
        self.assertIsNotNone(raw)
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0].file_path, "openspec/specs/guide.md")
        self.assertEqual(
            [(access.doc_path, access.access_type) for access in accesses],
            [("openspec/specs/guide.md", "edit")],
        )
        self.assertIn("tool_call", accesses[0].matched_by)
        self.assertIn("code_change", accesses[0].matched_by)

    def test_raw_events_replay_project_doc_related_adoption_from_raw_to_metrics(self):
        turn_event = EventIn(
            event_id="raw-related-turn",
            task_id="task-raw-related",
            session_id="session-raw-related",
            tool="copilot",
            event_type="turn_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 5, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "session-raw-related",
                "request_id": "request-raw-related",
                "response_id": "response-raw-related",
                "turn": {
                    "turn_index": 1,
                    "request_id": "request-raw-related",
                    "response_id": "response-raw-related",
                    "status": "completed",
                    "started_at": "2026-06-24T10:00:01Z",
                    "completed_at": "2026-06-24T10:00:10Z",
                },
                "messages": [
                    {"role": "user", "text": "读取规范并生成代码", "source_key": "request-raw-related:user"},
                    {"role": "assistant", "text": "已生成代码", "source_key": "request-raw-related:assistant"},
                ],
                "tool_calls": [
                    {
                        "tool_call_id": "tool-read-arch",
                        "tool_name": "read_file",
                        "status": "complete",
                        "arguments_raw": json.dumps({"filePath": "openspec/specs/architecture.md"}),
                    },
                    {
                        "tool_call_id": "tool-read-conventions",
                        "tool_name": "read_file",
                        "status": "complete",
                        "arguments_raw": json.dumps({"filePath": "openspec/specs/conventions.md"}),
                    },
                ],
                "code_changes": [
                    {
                        "file_path": "src/service.py",
                        "snapshot_kind": "copilot_turn_workspace_diff",
                        "request_id": "request-raw-related",
                        "response_id": "response-raw-related",
                        "turn_index": 1,
                        "lines_added": 3,
                        "lines_deleted": 0,
                        "hunks": [
                            {
                                "old_start": 0,
                                "old_lines": 0,
                                "new_start": 1,
                                "new_lines": 3,
                                "lines": [
                                    {"line_type": "added", "new_line": 1, "text": "def spec_backed_feature():"},
                                    {"line_type": "added", "new_line": 2, "text": "    return 'architecture'"},
                                    {"line_type": "added", "new_line": 3, "text": "FEATURE_ENABLED = True"},
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        commit_event = EventIn(
            event_id="raw-related-commit",
            task_id="commit-raw-related",
            session_id="session-raw-related",
            tool="copilot",
            event_type="commit_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 10, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "snapshot_kind": "commit_snapshot",
                "commit_sha": "rawrelatedcommit",
                "files_changed": 1,
                "lines_added": 4,
                "lines_deleted": 0,
                "file_paths": ["src/service.py"],
                "files": [
                    {
                        "file_path": "src/service.py",
                        "lines_added": 4,
                        "lines_deleted": 0,
                        "hunks": [
                            {
                                "old_start": 0,
                                "old_lines": 0,
                                "new_start": 1,
                                "new_lines": 4,
                                "lines": [
                                    {"line_type": "added", "new_line": 1, "text": "def spec_backed_feature():"},
                                    {"line_type": "added", "new_line": 2, "text": "    return 'architecture'"},
                                    {"line_type": "added", "new_line": 3, "text": "FEATURE_ENABLED = True"},
                                    {"line_type": "added", "new_line": 4, "text": "HUMAN_NOTE = 'manual'"},
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.33",
            username="lyl",
            user_id="user-1",
            events=[turn_event, commit_event],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        raw_events = self.db.execute(select(RawIngestEvent).order_by(RawIngestEvent.occurred_at)).scalars().all()
        commit_change = self.db.execute(select(AiCodeChange).where(AiCodeChange.event_id == "raw-related-commit")).scalars().one()
        result = knowledge_metrics(self.db)
        project_details = next(category["details"] for category in result["categories"] if category["key"] == "project_knowledge_usage")
        by_doc = {doc["doc_path"]: doc for doc in project_details["project_doc_usage"]}

        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual([row.event_id for row in raw_events], ["raw-related-turn", "raw-related-commit"])
        self.assertEqual(commit_change.diff_json["ai_current_lines_added"], 3)
        self.assertEqual(commit_change.diff_json["human_current_lines_added"], 1)
        self.assertEqual(commit_change.diff_json["matched_ai_change_event_ids"], ["raw-related-turn"])
        for doc_path in ("openspec/specs/architecture.md", "openspec/specs/conventions.md"):
            self.assertEqual(by_doc[doc_path]["related_ai_generated_added_lines"], 3)
            self.assertEqual(by_doc[doc_path]["related_ai_accepted_added_lines"], 3)
            self.assertEqual(by_doc[doc_path]["related_adoption_rate"], 1.0)

    def test_raw_code_changes_dedupes_absolute_and_relative_project_spec_paths(self):
        editor_delta = EventIn(
            event_id="raw-spec-editor-delta",
            task_id="task-raw-spec-paths",
            session_id="session-raw-spec-paths",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 5, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "session-raw-spec-paths",
                "request_id": "request-raw-spec-paths",
                "response_id": "response-raw-spec-paths",
                "turn_index": 1,
                "snapshot_kind": "copilot_turn_editor_delta",
                "files": [
                    {
                        "file_path": "/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/path.md",
                        "lines_added": 1,
                        "lines_deleted": 0,
                    }
                ],
            },
        )
        workspace_diff = EventIn(
            event_id="raw-spec-workspace-diff",
            task_id="task-raw-spec-paths",
            session_id="session-raw-spec-paths",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 6, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "session-raw-spec-paths",
                "request_id": "request-raw-spec-paths",
                "response_id": "response-raw-spec-paths",
                "turn_index": 1,
                "snapshot_kind": "copilot_turn_workspace_diff",
                "files": [
                    {
                        "file_path": "openspec/specs/path.md",
                        "lines_added": 1,
                        "lines_deleted": 0,
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.33",
            username="lyl",
            user_id="user-1",
            events=[editor_delta, workspace_diff],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        changes = self.db.execute(select(AiCodeChange).order_by(AiCodeChange.id)).scalars().all()

        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(len(changes), 2)
        self.assertFalse(changes[0].is_effective)
        self.assertEqual(changes[0].superseded_by_event_id, "raw-spec-workspace-diff")
        self.assertTrue(changes[1].is_effective)

    def test_code_change_files_blob_is_rehydrated_but_not_stored_as_large_json(self):
        file_path = "src/big.py"
        large_line = "print('" + ("x" * 90_000) + "')"
        files = [
            {
                "file_path": file_path,
                "lines_added": 1,
                "lines_deleted": 0,
                "hunks": [
                    {
                        "old_start": 0,
                        "old_lines": 0,
                        "new_start": 1,
                        "new_lines": 1,
                        "lines": [
                            {
                                "line_type": "added",
                                "new_line": 1,
                                "text": large_line,
                                "text_hash": hashlib.sha256(f"{file_path}\0{large_line}".encode("utf-8")).hexdigest(),
                            }
                        ],
                    }
                ],
            }
        ]
        raw = json.dumps(files, ensure_ascii=False).encode("utf-8")
        compressed = gzip.compress(raw)
        event = EventIn(
            event_id="code-change-files-blob",
            task_id="task-code-change-files-blob",
            session_id="copilot-session",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 6, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "copilot-session",
                "request_id": "request-blob",
                "response_id": "response-blob",
                "snapshot_kind": "copilot_turn_workspace_diff",
                "files_changed": 1,
                "lines_added": 1,
                "lines_deleted": 0,
                "files": {
                    "blob_ref": "files",
                    "encoding": "gzip+base64",
                    "value_type": "json",
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "original_bytes": len(raw),
                    "compressed_bytes": len(compressed),
                    "chunk_count": 1,
                },
                "raw_event_blobs": [
                    {
                        "blob_key": "files",
                        "encoding": "gzip+base64",
                        "value_type": "json",
                        "sha256": hashlib.sha256(raw).hexdigest(),
                        "original_bytes": len(raw),
                        "compressed_bytes": len(compressed),
                        "chunks": [base64.b64encode(compressed).decode("ascii")],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.31",
            username="lyl",
            user_id="user-1",
            events=[event],
        )

        result = ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        raw_row = self.db.get(RawIngestEvent, "code-change-files-blob")
        normalized = self.db.execute(select(NormalizedIngestEvent).where(NormalizedIngestEvent.raw_event_id == "code-change-files-blob")).scalars().one()
        change = self.db.execute(select(AiCodeChange).where(AiCodeChange.event_id == "code-change-files-blob")).scalars().one()

        self.assertEqual(result["accepted"], 1)
        self.assertEqual(stats["succeeded"], 1)
        self.assertEqual(raw_row.raw_json["event"]["payload"]["files"]["blob_ref"], "files")
        self.assertEqual(self.db.execute(select(RawEventBlob).where(RawEventBlob.raw_event_id == "code-change-files-blob")).scalars().one().blob_key, "files")
        self.assertLess(len(json.dumps(normalized.normalized_json, ensure_ascii=False)), 20_000)
        self.assertLess(len(json.dumps(change.diff_json, ensure_ascii=False)), 20_000)
        self.assertEqual(change.lines_added, 1)
        self.assertTrue(change.diff_json["line_detail_truncated"])

        commit = EventIn(
            event_id="commit-matches-files-blob",
            task_id="commit-matches-files-blob",
            tool="copilot",
            event_type="commit_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 7, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "snapshot_kind": "commit",
                "commit_sha": "commitblob",
                "files_changed": 1,
                "lines_added": 2,
                "lines_deleted": 0,
                "file_paths": [file_path],
                "files": [
                    {
                        "file_path": file_path,
                        "lines_added": 2,
                        "lines_deleted": 0,
                        "hunks": [
                            {
                                "old_start": 0,
                                "old_lines": 0,
                                "new_start": 1,
                                "new_lines": 2,
                                "lines": [
                                    {
                                        "line_type": "added",
                                        "new_line": 1,
                                        "text": large_line,
                                        "text_hash": hashlib.sha256(f"{file_path}\0{large_line}".encode("utf-8")).hexdigest(),
                                    },
                                    {
                                        "line_type": "added",
                                        "new_line": 2,
                                        "text": "HUMAN_LINE",
                                        "text_hash": hashlib.sha256(f"{file_path}\0HUMAN_LINE".encode("utf-8")).hexdigest(),
                                    },
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        commit_result = ingest_batch(
            self.db,
            BatchIn(
                client_id="client-1",
                plugin_name="tinyai-observability-vscode",
                plugin_version="0.1.31",
                username="lyl",
                user_id="user-1",
                events=[commit],
            ),
        )
        commit_stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        commit_change = self.db.execute(select(AiCodeChange).where(AiCodeChange.event_id == "commit-matches-files-blob")).scalars().one()

        self.assertEqual(commit_result["accepted"], 1)
        self.assertEqual(commit_stats["succeeded"], 1)
        self.assertEqual(commit_change.diff_json["ai_lines_added"], 1)
        self.assertEqual(commit_change.diff_json["human_lines_added"], 1)
        self.assertEqual(commit_change.diff_json["matched_ai_change_event_ids"], ["code-change-files-blob"])

    def test_code_change_effective_keeps_only_latest_workspace_result_per_file(self):
        def code_event(event_id: str, request_id: str, response_id: str, occurred_at: datetime, lines_added: int) -> EventIn:
            return EventIn(
                event_id=event_id,
                task_id="task-code-1234",
                session_id="copilot-session",
                tool="copilot",
                event_type="code_change",
                occurred_at=occurred_at,
                source_confidence="derived",
                username="lyl",
                user_id="user-1",
                payload={
                    "session_id": "copilot-session",
                    "request_id": request_id,
                    "response_id": response_id,
                    "turn_index": 1,
                    "snapshot_kind": "copilot_turn_editor_delta",
                    "diff_hash": f"diff-{event_id}",
                    "files": [
                        {
                            "file_path": "src/app.ts",
                            "lines_added": lines_added,
                            "lines_deleted": 0,
                        }
                    ],
                },
            )

        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.26",
            username="lyl",
            user_id="user-1",
            events=[
                code_event("code-aaa11111", "request-1", "response-1", datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc), 3),
                code_event("code-bbb22222", "request-2", "response-2", datetime(2026, 6, 24, 10, 5, tzinfo=timezone.utc), 5),
            ],
        )

        result = ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        changes = self.db.execute(select(AiCodeChange).order_by(AiCodeChange.occurred_at.asc())).scalars().all()

        self.assertEqual(result["accepted"], 2)
        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(len(changes), 2)
        self.assertFalse(changes[0].is_effective)
        self.assertEqual(changes[0].superseded_by_event_id, "code-bbb22222")
        self.assertTrue(changes[1].is_effective)
        self.assertEqual(changes[1].request_id, "request-2")
        self.assertEqual(changes[1].lines_added, 5)

    def test_turn_snapshot_replay_refreshes_existing_request_time(self):
        def turn_event(event_id: str, started_at: str, completed_at: str) -> EventIn:
            return EventIn(
                event_id=event_id,
                task_id="task-turn-replay",
                session_id="copilot-session",
                tool="copilot",
                event_type="turn_snapshot",
                occurred_at=datetime(2026, 6, 24, 10, 10, tzinfo=timezone.utc),
                source_confidence="derived",
                username="lyl",
                user_id="user-1",
                payload={
                    "session_id": "copilot-session",
                    "request_id": "request-replay",
                    "response_id": "response-replay",
                    "turn": {
                        "turn_index": 1,
                        "request_id": "request-replay",
                        "response_id": "response-replay",
                        "status": "completed",
                        "started_at": started_at,
                        "completed_at": completed_at,
                    },
                    "messages": [
                        {"role": "user", "text": "继续写代码", "source_key": "request-replay:user"},
                        {"role": "assistant", "text": "已完成", "source_key": "request-replay:assistant"},
                    ],
                },
            )

        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.28",
            username="lyl",
            user_id="user-1",
            events=[
                turn_event("turn-old-time", "2026-06-24T10:00:01Z", "2026-06-24T10:00:10Z"),
                turn_event("turn-corrected-time", "2026-06-24T10:05:01Z", "2026-06-24T10:05:10Z"),
            ],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        turn = self.db.execute(select(AiTurn)).scalars().one()

        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(turn.created_at, datetime(2026, 6, 24, 18, 5, 1))
        self.assertEqual(turn.completed_at, datetime(2026, 6, 24, 18, 5, 10))

    def test_turn_snapshot_tool_patch_supersedes_editor_delta_for_same_file(self):
        code_change = EventIn(
            event_id="editor-delta-old",
            task_id="task-tool-patch",
            session_id="copilot-session",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "copilot-session",
                "request_id": "request-old",
                "response_id": "response-old",
                "turn_index": 1,
                "snapshot_kind": "copilot_turn_editor_delta",
                "files": [{"file_path": "collector-server/tests/hello.py", "lines_added": 3, "lines_deleted": 1}],
            },
        )
        tool_patch = EventIn(
            event_id="turn-tool-patch-new",
            task_id="task-tool-patch",
            session_id="copilot-session",
            tool="copilot",
            event_type="turn_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 5, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "copilot-session",
                "request_id": "request-new",
                "response_id": "response-new",
                "turn_index": 2,
                "turn": {
                    "turn_index": 2,
                    "request_id": "request-new",
                    "response_id": "response-new",
                    "status": "completed",
                    "started_at": "2026-06-24T10:05:00Z",
                    "completed_at": "2026-06-24T10:05:10Z",
                },
                "messages": [
                    {"role": "user", "text": "继续写代码", "source_key": "request-new:user"},
                    {"role": "assistant", "text": "已完成", "source_key": "request-new:assistant"},
                ],
                "tool_calls": [
                    {
                        "tool_call_id": "tool-apply-patch",
                        "tool_name": "apply_patch",
                        "status": "completed",
                        "completed_at": "2026-06-24T10:05:03Z",
                        "arguments_raw": "{\"input\":\"*** Begin Patch\\n*** Update File: collector-server/tests/hello.py\\n@@\\n-old = True\\n+new = True\\n+print('done')\\n*** End Patch\\n\"}",
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.28",
            username="lyl",
            user_id="user-1",
            events=[code_change, tool_patch],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        changes = self.db.execute(select(AiCodeChange).order_by(AiCodeChange.occurred_at.asc())).scalars().all()

        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(len(changes), 2)
        self.assertEqual(changes[0].snapshot_kind, "copilot_turn_editor_delta")
        self.assertFalse(changes[0].is_effective)
        self.assertEqual(changes[0].superseded_by_event_id, "turn-tool-patch-new")
        self.assertEqual(changes[1].snapshot_kind, "copilot_turn_tool_patch")
        self.assertTrue(changes[1].is_effective)

    def test_preferred_code_changes_hides_duplicate_editor_delta_when_workspace_diff_exists(self):
        editor_delta = AiCodeChange(
            id=1,
            session_id="copilot-session",
            task_id="task-1",
            turn_index=1,
            request_id="request-1",
            response_id="response-1",
            file_path="openspec/specs/bubble_sort.py",
            snapshot_kind="copilot_turn_editor_delta",
            change_type="code_change",
            lines_added=31,
            lines_deleted=0,
            is_effective=True,
        )
        workspace_diff = AiCodeChange(
            id=2,
            session_id="copilot-session",
            task_id="task-1",
            turn_index=1,
            request_id="request-1",
            response_id="response-1",
            file_path="openspec/specs/bubble_sort.py",
            snapshot_kind="copilot_turn_workspace_diff",
            change_type="code_change",
            lines_added=31,
            lines_deleted=0,
            is_effective=True,
        )

        preferred = _preferred_code_changes([editor_delta, workspace_diff])

        self.assertEqual(preferred, [workspace_diff])

    def test_preferred_code_changes_normalizes_spec_absolute_and_relative_paths(self):
        tool_patch = AiCodeChange(
            id=1,
            session_id="copilot-session",
            task_id="task-1",
            turn_index=1,
            request_id="request-1",
            response_id="response-1",
            file_path="Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/刘芸隆.md",
            snapshot_kind="copilot_turn_tool_patch",
            change_type="code_change",
            lines_added=11,
            lines_deleted=5,
            is_effective=True,
        )
        editor_delta = AiCodeChange(
            id=2,
            session_id="copilot-session",
            task_id="task-1",
            turn_index=1,
            request_id="request-1",
            response_id="response-1",
            file_path="openspec/specs/刘芸隆.md",
            snapshot_kind="copilot_turn_editor_delta",
            change_type="code_change",
            lines_added=11,
            lines_deleted=5,
            is_effective=True,
        )
        other_doc = AiCodeChange(
            id=3,
            session_id="copilot-session",
            task_id="task-1",
            turn_index=1,
            request_id="request-1",
            response_id="response-1",
            file_path="openspec/specs/李白.md",
            snapshot_kind="copilot_turn_editor_delta",
            change_type="code_change",
            lines_added=11,
            lines_deleted=5,
            is_effective=True,
        )

        preferred = _preferred_code_changes([tool_patch, editor_delta, other_doc])

        self.assertEqual(preferred, [tool_patch, other_doc])

    def test_workspace_diff_supersedes_editor_delta_for_same_turn_file_even_if_editor_arrives_later(self):
        file_path = "openspec/specs/bubble_sort.py"

        def code_event(event_id: str, snapshot_kind: str, occurred_at: datetime) -> EventIn:
            return EventIn(
                event_id=event_id,
                task_id="task-bubble-sort",
                session_id="copilot-session",
                tool="copilot",
                event_type="code_change",
                occurred_at=occurred_at,
                source_confidence="derived",
                username="lyl",
                user_id="user-1",
                payload={
                    "session_id": "copilot-session",
                    "request_id": "request-bubble",
                    "response_id": "response-bubble",
                    "turn_index": 1,
                    "snapshot_kind": snapshot_kind,
                    "files": [
                        {
                            "file_path": file_path,
                            "lines_added": 31,
                            "lines_deleted": 0,
                        }
                    ],
                },
            )

        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.35",
            username="lyl",
            user_id="user-1",
            events=[
                code_event("workspace-diff-first", "copilot_turn_workspace_diff", datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc)),
                code_event("editor-delta-later", "copilot_turn_editor_delta", datetime(2026, 6, 24, 10, 1, tzinfo=timezone.utc)),
            ],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        changes = self.db.execute(select(AiCodeChange).order_by(AiCodeChange.occurred_at.asc())).scalars().all()

        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(changes[0].snapshot_kind, "copilot_turn_workspace_diff")
        self.assertTrue(changes[0].is_effective)
        self.assertEqual(changes[1].snapshot_kind, "copilot_turn_editor_delta")
        self.assertFalse(changes[1].is_effective)
        self.assertEqual(changes[1].superseded_by_event_id, "workspace-diff-first")

    def test_effective_code_changes_normalizes_specs_absolute_and_relative_paths(self):
        def code_event(event_id: str, snapshot_kind: str, file_path: str, occurred_at: datetime) -> EventIn:
            return EventIn(
                event_id=event_id,
                task_id="task-spec-path-normalize",
                session_id="copilot-session",
                tool="copilot",
                event_type="code_change",
                occurred_at=occurred_at,
                source_confidence="derived",
                username="lyl",
                user_id="user-1",
                payload={
                    "session_id": "copilot-session",
                    "request_id": "request-spec-normalize",
                    "response_id": "response-spec-normalize",
                    "turn_index": 1,
                    "snapshot_kind": snapshot_kind,
                    "files": [
                        {
                            "file_path": file_path,
                            "lines_added": 11,
                            "lines_deleted": 5,
                        }
                    ],
                },
            )

        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.35",
            username="lyl",
            user_id="user-1",
            events=[
                code_event(
                    "tool-patch-absolute-spec-path",
                    "copilot_turn_tool_patch",
                    "Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/刘芸隆.md",
                    datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
                ),
                code_event(
                    "editor-delta-relative-spec-path",
                    "copilot_turn_editor_delta",
                    "openspec/specs/刘芸隆.md",
                    datetime(2026, 6, 24, 10, 1, tzinfo=timezone.utc),
                ),
                code_event(
                    "editor-delta-other-spec-doc",
                    "copilot_turn_editor_delta",
                    "openspec/specs/李白.md",
                    datetime(2026, 6, 24, 10, 2, tzinfo=timezone.utc),
                ),
            ],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        changes = self.db.execute(select(AiCodeChange).order_by(AiCodeChange.event_id.asc())).scalars().all()

        by_event_id = {change.event_id: change for change in changes}
        self.assertEqual(stats["succeeded"], 3)
        self.assertTrue(by_event_id["tool-patch-absolute-spec-path"].is_effective)
        self.assertFalse(by_event_id["editor-delta-relative-spec-path"].is_effective)
        self.assertEqual(by_event_id["editor-delta-relative-spec-path"].superseded_by_event_id, "tool-patch-absolute-spec-path")
        self.assertTrue(by_event_id["editor-delta-other-spec-doc"].is_effective)

    def test_commit_snapshot_matches_db_ai_diff_evidence_by_line_hash(self):
        file_path = "collector-server/tests/hello.py"

        def line_hash(text: str) -> str:
            return hashlib.sha256(f"{file_path}\0{text}".encode("utf-8")).hexdigest()

        turn_patch = EventIn(
            event_id="turn-ai-diff-match",
            task_id="task-ai-diff-match",
            session_id="copilot-session",
            tool="copilot",
            event_type="turn_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "copilot-session",
                "request_id": "request-ai",
                "response_id": "response-ai",
                "turn_index": 1,
                "turn": {
                    "turn_index": 1,
                    "request_id": "request-ai",
                    "response_id": "response-ai",
                    "status": "completed",
                    "started_at": "2026-06-24T10:00:00Z",
                    "completed_at": "2026-06-24T10:00:05Z",
                },
                "messages": [
                    {"role": "user", "text": "修改 hello.py", "source_key": "request-ai:user"},
                    {"role": "assistant", "text": "已修改", "source_key": "request-ai:assistant"},
                ],
                "tool_calls": [
                    {
                        "tool_call_id": "tool-apply-patch",
                        "tool_name": "apply_patch",
                        "status": "completed",
                        "completed_at": "2026-06-24T10:00:03Z",
                        "arguments_raw": (
                            "{\"input\":\"*** Begin Patch\\n"
                            f"*** Update File: {file_path}\\n"
                            "@@\\n"
                            "-old = True\\n"
                            "+new = True\\n"
                            "*** End Patch\\n\"}"
                        ),
                    }
                ],
            },
        )
        commit_snapshot = EventIn(
            event_id="commit-ai-diff-match",
            task_id="commit-abcdef123456",
            tool="copilot",
            event_type="commit_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 3, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            payload={
                "commit_sha": "abcdef123456",
                "branch": "main",
                "snapshot_kind": "commit",
                "files_changed": 1,
                "lines_added": 2,
                "lines_deleted": 1,
                "file_paths": [file_path],
                "files": [
                    {
                        "file_path": file_path,
                        "lines_added": 2,
                        "lines_deleted": 1,
                        "hunks": [
                            {
                                "old_start": 1,
                                "old_lines": 1,
                                "new_start": 1,
                                "new_lines": 2,
                                "lines": [
                                    {"line_type": "removed", "old_line": 1, "text": "old = True", "text_hash": line_hash("old = True")},
                                    {"line_type": "added", "new_line": 1, "text": "new = True", "text_hash": line_hash("new = True")},
                                    {"line_type": "added", "new_line": 2, "text": "manual = True", "text_hash": line_hash("manual = True")},
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.29",
            username="lyl",
            user_id="user-1",
            events=[turn_patch, commit_snapshot],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        commit_change = self.db.execute(
            select(AiCodeChange).where(AiCodeChange.event_id == "commit-ai-diff-match")
        ).scalars().one()
        diff_json = commit_change.diff_json

        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(diff_json["ai_lines_added"], 1)
        self.assertEqual(diff_json["human_lines_added"], 1)
        self.assertEqual(diff_json["ai_lines_deleted"], 1)
        self.assertEqual(diff_json["human_lines_deleted"], 0)
        self.assertEqual(diff_json["lines_modified"], 1)
        self.assertEqual(diff_json["ai_lines_modified"], 1)
        self.assertEqual(diff_json["human_lines_modified"], 0)
        self.assertEqual(diff_json["matched_ai_change_event_ids"], ["turn-ai-diff-match"])
        self.assertEqual(diff_json["ai_attribution_method"], "commit_diff_line_ledger_and_text_hash_evidence")
        self.assertEqual(diff_json["line_attribution"]["hunks"][0]["lines"][2]["attribution"], "human")

    def test_commit_snapshot_marks_ai_origin_line_human_edited_by_ledger(self):
        file_path = "collector-server/tests/hello.py"

        def line_hash(text: str) -> str:
            return hashlib.sha256(f"{file_path}\0{text}".encode("utf-8")).hexdigest()

        ai_change = EventIn(
            event_id="turn-ai-origin-line",
            task_id="task-ai-origin-line",
            session_id="copilot-session",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            workspace_path_hash="workspace-1",
            payload={
                "session_id": "copilot-session",
                "request_id": "request-ai",
                "response_id": "response-ai",
                "snapshot_kind": "copilot_turn_editor_delta",
                "file_path": file_path,
                "lines_added": 1,
                "lines_deleted": 0,
                "hunks": [
                    {
                        "old_start": 0,
                        "old_lines": 0,
                        "new_start": 1,
                        "new_lines": 1,
                        "lines": [
                            {"line_type": "added", "new_line": 1, "text": "a = 1", "text_hash": line_hash("a = 1")},
                        ],
                    }
                ],
            },
        )
        commit_snapshot = EventIn(
            event_id="commit-human-edited-ai-origin",
            task_id="commit-human-edited",
            tool="copilot",
            event_type="commit_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 3, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            workspace_path_hash="workspace-1",
            payload={
                "commit_sha": "humanedited",
                "branch": "main",
                "snapshot_kind": "commit",
                "files_changed": 1,
                "lines_added": 1,
                "lines_deleted": 0,
                "file_paths": [file_path],
                "files": [
                    {
                        "file_path": file_path,
                        "lines_added": 1,
                        "lines_deleted": 0,
                        "hunks": [
                            {
                                "old_start": 0,
                                "old_lines": 0,
                                "new_start": 1,
                                "new_lines": 1,
                                "lines": [
                                    {"line_type": "added", "new_line": 1, "text": "a = 2", "text_hash": line_hash("a = 2")},
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.32",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            events=[ai_change, commit_snapshot],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        commit_change = self.db.execute(
            select(AiCodeChange).where(AiCodeChange.event_id == "commit-human-edited-ai-origin")
        ).scalars().one()
        diff_json = commit_change.diff_json
        line = diff_json["line_attribution"]["hunks"][0]["lines"][0]
        ledger = self.db.execute(select(AiLineAttribution).where(AiLineAttribution.file_path == file_path)).scalars().one()

        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(diff_json["ai_lines_added"], 0)
        self.assertEqual(diff_json["human_lines_added"], 1)
        self.assertEqual(diff_json["ai_assisted_human_edited_lines_added"], 1)
        self.assertEqual(diff_json["human_current_lines_added"], 0)
        self.assertEqual(line["origin_author"], "ai")
        self.assertEqual(line["last_editor"], "human")
        self.assertEqual(line["classification"], "ai_assisted_human_edited")
        self.assertEqual(ledger.origin_author, "ai")
        self.assertEqual(ledger.last_editor, "human")
        self.assertEqual(ledger.classification, "ai_assisted_human_edited")
        self.assertEqual(ledger.session_id, "copilot-session")
        self.assertEqual(ledger.request_id, "request-ai")
        self.assertEqual(ledger.response_id, "response-ai")

    def test_commit_snapshot_persists_ai_assisted_human_edit_when_same_line_deleted_and_added(self):
        file_path = "openspec/specs/刘芸隆.md"
        workspace_hash = "workspace-assisted-rewrite"

        def line_hash(text: str) -> str:
            return hashlib.sha256(f"{file_path}\0{text}".encode("utf-8")).hexdigest()

        seed_rows = [
            (37, "*离别，教会我们珍惜；远方，让我们各自成长。*", "ai", "ai", "ai_current", "seed-ai-event"),
            (38, "不要离别了 需要继续加油！！！！", "human", "human", "human_current", "seed-human-event"),
        ]
        for line_no, text, origin, editor, classification, event_id in seed_rows:
            self.db.add(
                AiLineAttribution(
                    workspace_path_hash=workspace_hash,
                    client_id="client-1",
                    username="lyl",
                    user_id="user-1",
                    machine_id="machine-1",
                    host_hash="",
                    file_path=file_path,
                    line_no=line_no,
                    text_hash=line_hash(text),
                    text_preview=text,
                    origin_author=origin,
                    last_editor=editor,
                    classification=classification,
                    origin_event_id=event_id,
                    last_event_id=event_id,
                    source_snapshot_kind="commit_snapshot",
                    occurred_at=datetime(2026, 6, 24, 10, 0),
                )
            )
        self.db.commit()

        rewritten = "*离别，教会我们珍惜；远方，让我们各自成长,但是也 reminder我们不要被离别所 replaced*"
        commit_snapshot = EventIn(
            event_id="commit-assisted-rewrite-same-line",
            task_id="commit-assisted-rewrite-same-line",
            tool="copilot",
            event_type="commit_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 3, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            workspace_path_hash=workspace_hash,
            payload={
                "commit_sha": "assistedrewrite",
                "branch": "main",
                "snapshot_kind": "commit",
                "files_changed": 1,
                "lines_added": 3,
                "lines_deleted": 2,
                "file_paths": [file_path],
                "files": [
                    {
                        "file_path": file_path,
                        "lines_added": 3,
                        "lines_deleted": 2,
                        "hunks": [
                            {
                                "old_start": 37,
                                "old_lines": 2,
                                "new_start": 37,
                                "new_lines": 3,
                                "lines": [
                                    {
                                        "line_type": "removed",
                                        "old_line": 37,
                                        "text": "*离别，教会我们珍惜；远方，让我们各自成长。*",
                                        "text_hash": line_hash("*离别，教会我们珍惜；远方，让我们各自成长。*"),
                                    },
                                    {
                                        "line_type": "removed",
                                        "old_line": 38,
                                        "text": "不要离别了 需要继续加油！！！！",
                                        "text_hash": line_hash("不要离别了 需要继续加油！！！！"),
                                    },
                                    {"line_type": "added", "new_line": 37, "text": rewritten, "text_hash": line_hash(rewritten)},
                                    {
                                        "line_type": "added",
                                        "new_line": 38,
                                        "text": "哈哈哈哈哈哈",
                                        "text_hash": line_hash("哈哈哈哈哈哈"),
                                    },
                                    {
                                        "line_type": "added",
                                        "new_line": 39,
                                        "text": "啊啊啊啊啊",
                                        "text_hash": line_hash("啊啊啊啊啊"),
                                    },
                                ],
                            }
                        ],
                    }
                ],
            },
        )

        ingest_batch(
            self.db,
            BatchIn(
                client_id="client-1",
                plugin_name="tinyai-observability-vscode",
                plugin_version="0.1.33",
                username="lyl",
                user_id="user-1",
                machine_id="machine-1",
                events=[commit_snapshot],
            ),
        )
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        commit_change = self.db.execute(
            select(AiCodeChange).where(AiCodeChange.event_id == "commit-assisted-rewrite-same-line")
        ).scalars().one()
        diff_json = commit_change.diff_json
        ledger_rows = self.db.execute(
            select(AiLineAttribution).where(AiLineAttribution.file_path == file_path).order_by(AiLineAttribution.line_no)
        ).scalars().all()

        self.assertEqual(stats["succeeded"], 1)
        self.assertEqual(diff_json["line_attribution"]["hunks"][0]["lines"][2]["classification"], "ai_assisted_human_edited")
        self.assertEqual([(row.line_no, row.text_preview, row.origin_author, row.last_editor, row.classification) for row in ledger_rows], [
            (37, rewritten, "ai", "human", "ai_assisted_human_edited"),
            (38, "哈哈哈哈哈哈", "human", "human", "human_current"),
            (39, "啊啊啊啊啊", "human", "human", "human_current"),
        ])
        self.assertEqual(ledger_rows[0].origin_event_id, "seed-ai-event")
        self.assertEqual(ledger_rows[0].last_event_id, "commit-assisted-rewrite-same-line")
        self.assertEqual(ledger_rows[0].source_snapshot_kind, "commit_snapshot")

    def test_commit_snapshot_keeps_ai_lines_current_when_human_inserts_line_into_new_ai_file(self):
        file_path = "openspec/specs/李白.md"
        ai_lines = [
            "# 李白",
            "",
            "## 基本信息",
            "",
            "李白（701-762），字太白，号青莲居士，唐代伟大的浪漫主义诗人。",
            "",
            "## 生平",
            "",
            "- 出生于武周圣历元年",
            "- 少年时代在四川长大",
            "- 二十五岁时开始游历，足迹遍及南北",
            "- 天宝初年，被唐玄宗召入长安，供奉翰林院",
            "- 因仙气飘然，才华横溢，被誉为\"诗仙\"",
            "",
            "## 主要成就",
            "",
            "### 诗歌创作",
            "- 现存诗歌1000多首",
            "- 开创了浪漫主义诗风",
            "- 代表作：《静夜思》《望庐山瀑布》《蜀道难》《将进酒》等",
            "",
            "### 创作特点",
            "- 想象丰富，气势磅礴",
            "- 语言自然流畅",
            "- 充满豪侠精神",
            "- 具有强烈的个性特征",
            "",
            "## 影响",
            "",
            "李白诗歌对后世文学产生了深远的影响，被誉为中国诗歌史上最伟大的诗人之一。",
        ]
        human_line = "李白是个牛逼的人！！！！"
        commit_lines = [ai_lines[0], human_line, *ai_lines[1:]]
        workspace_hash = "workspace-li-bai"

        def line_hash(text: str) -> str:
            return hashlib.sha256(f"{file_path}\0{text}".encode("utf-8")).hexdigest()

        ai_change = EventIn(
            event_id="turn-ai-li-bai-file",
            task_id="task-ai-li-bai-file",
            session_id="copilot-session-li-bai",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            workspace_path_hash=workspace_hash,
            payload={
                "session_id": "copilot-session-li-bai",
                "request_id": "request-ai",
                "response_id": "response-ai",
                "snapshot_kind": "copilot_turn_editor_delta",
                "file_path": file_path,
                "lines_added": len(ai_lines),
                "lines_deleted": 0,
                "changes": [
                    {
                        "file_path": file_path,
                        "added_lines": [
                            {"new_line": index, "text": text, "text_hash": line_hash(text)[:32]}
                            for index, text in enumerate(ai_lines, start=1)
                        ],
                    }
                ],
            },
        )
        commit_snapshot = EventIn(
            event_id="commit-li-bai-human-insert",
            task_id="commit-li-bai-human-insert",
            tool="copilot",
            event_type="commit_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 3, tzinfo=timezone.utc),
            source_confidence="direct",
            username="user",
            user_id="user",
            machine_id="unknown",
            workspace_path_hash=workspace_hash,
            payload={
                "commit_sha": "libaiinsert",
                "branch": "main",
                "snapshot_kind": "commit",
                "files_changed": 1,
                "lines_added": len(commit_lines),
                "lines_deleted": 0,
                "file_paths": [file_path],
                "files": [
                    {
                        "file_path": file_path,
                        "lines_added": len(commit_lines),
                        "lines_deleted": 0,
                        "hunks": [
                            {
                                "old_start": 0,
                                "old_lines": 0,
                                "new_start": 1,
                                "new_lines": len(commit_lines),
                                "lines": [
                                    {"line_type": "added", "new_line": index, "text": text, "text_hash": line_hash(text)}
                                    for index, text in enumerate(commit_lines, start=1)
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.33",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            events=[ai_change, commit_snapshot],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        commit_change = self.db.execute(select(AiCodeChange).where(AiCodeChange.event_id == "commit-li-bai-human-insert")).scalars().one()
        diff_json = commit_change.diff_json
        lines = diff_json["line_attribution"]["hunks"][0]["lines"]
        ledger_rows = self.db.execute(
            select(AiLineAttribution).where(AiLineAttribution.file_path == file_path).order_by(AiLineAttribution.line_no)
        ).scalars().all()

        nonblank_ai_lines = [line for line in ai_lines if line.strip()]
        nonblank_commit_lines = [line for line in commit_lines if line.strip()]
        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(diff_json["ai_current_lines_added"], len(nonblank_ai_lines))
        self.assertEqual(diff_json["human_current_lines_added"], 1)
        self.assertEqual(diff_json["ai_assisted_human_edited_lines_added"], 0)
        self.assertEqual(diff_json["line_attribution_summary"]["ignored_blank_lines"], len(commit_lines) - len(nonblank_commit_lines))
        self.assertEqual(lines[0]["classification"], "ai_current")
        self.assertEqual(lines[1]["text"], human_line)
        self.assertEqual(lines[1]["classification"], "human_current")
        self.assertEqual(lines[2]["classification"], "ignored_blank_line")
        self.assertEqual(lines[3]["classification"], "ai_current")
        self.assertEqual(len(ledger_rows), len(nonblank_commit_lines))
        self.assertEqual(ledger_rows[1].text_preview, human_line)
        self.assertEqual(ledger_rows[1].classification, "human_current")
        self.assertEqual(ledger_rows[1].username, "lyl")
        self.assertEqual(ledger_rows[1].user_id, "user-1")
        self.assertEqual(ledger_rows[1].machine_id, "machine-1")
        self.assertIsNone(ledger_rows[1].session_id)
        self.assertIsNone(ledger_rows[1].request_id)
        self.assertIsNone(ledger_rows[1].response_id)
        self.assertEqual(ledger_rows[0].session_id, "copilot-session-li-bai")
        self.assertEqual(ledger_rows[0].request_id, "request-ai")
        self.assertEqual(ledger_rows[0].response_id, "response-ai")
        self.assertTrue(all(row.classification == "ai_current" for index, row in enumerate(ledger_rows) if index != 1))

    def test_commit_snapshot_matches_ai_line_after_safe_format_normalization(self):
        file_path = "collector-server/tests/format_demo.py"
        workspace_hash = "workspace-format-normalization"
        ai_text = 'const   title = "hello";'
        committed_text = "const title = 'hello'"

        def line_hash(text: str) -> str:
            return hashlib.sha256(f"{file_path}\0{text}".encode("utf-8")).hexdigest()

        ai_change = EventIn(
            event_id="turn-ai-format-line",
            task_id="task-ai-format-line",
            session_id="copilot-session-format",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            workspace_path_hash=workspace_hash,
            payload={
                "session_id": "copilot-session-format",
                "request_id": "request-ai",
                "response_id": "response-ai",
                "snapshot_kind": "copilot_turn_editor_delta",
                "file_path": file_path,
                "lines_added": 1,
                "lines_deleted": 0,
                "hunks": [
                    {
                        "old_start": 0,
                        "old_lines": 0,
                        "new_start": 1,
                        "new_lines": 1,
                        "lines": [
                            {"line_type": "added", "new_line": 1, "text": ai_text, "text_hash": line_hash(ai_text)},
                        ],
                    }
                ],
            },
        )
        commit_snapshot = EventIn(
            event_id="commit-format-normalized-ai-line",
            task_id="commit-format-normalized-ai-line",
            tool="copilot",
            event_type="commit_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 3, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            workspace_path_hash=workspace_hash,
            payload={
                "commit_sha": "formatnormalized",
                "branch": "main",
                "snapshot_kind": "commit",
                "files_changed": 1,
                "lines_added": 1,
                "lines_deleted": 0,
                "file_paths": [file_path],
                "files": [
                    {
                        "file_path": file_path,
                        "lines_added": 1,
                        "lines_deleted": 0,
                        "hunks": [
                            {
                                "old_start": 0,
                                "old_lines": 0,
                                "new_start": 1,
                                "new_lines": 1,
                                "lines": [
                                    {
                                        "line_type": "added",
                                        "new_line": 1,
                                        "text": committed_text,
                                        "text_hash": line_hash(committed_text),
                                    },
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.34",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            events=[ai_change, commit_snapshot],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        commit_change = self.db.execute(
            select(AiCodeChange).where(AiCodeChange.event_id == "commit-format-normalized-ai-line")
        ).scalars().one()
        diff_json = commit_change.diff_json
        line = diff_json["line_attribution"]["hunks"][0]["lines"][0]

        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(diff_json["ai_current_lines_added"], 1)
        self.assertEqual(diff_json["human_current_lines_added"], 0)
        self.assertEqual(diff_json["ai_assisted_human_edited_lines_added"], 0)
        self.assertEqual(line["classification"], "ai_current")
        self.assertEqual(line["attribution"], "ai")

    def test_ai_line_attributions_skip_blank_lines(self):
        file_path = "collector-server/tests/blank_demo.py"
        workspace_hash = "workspace-blank-lines"

        def line_hash(text: str) -> str:
            return hashlib.sha256(f"{file_path}\0{text}".encode("utf-8")).hexdigest()

        ai_change = EventIn(
            event_id="turn-ai-blank-lines",
            task_id="task-ai-blank-lines",
            session_id="copilot-session-blank",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            workspace_path_hash=workspace_hash,
            payload={
                "session_id": "copilot-session-blank",
                "request_id": "request-ai",
                "response_id": "response-ai",
                "snapshot_kind": "copilot_turn_editor_delta",
                "file_path": file_path,
                "lines_added": 3,
                "lines_deleted": 0,
                "hunks": [
                    {
                        "old_start": 0,
                        "old_lines": 0,
                        "new_start": 1,
                        "new_lines": 3,
                        "lines": [
                            {"line_type": "added", "new_line": 1, "text": "alpha = 1", "text_hash": line_hash("alpha = 1")},
                            {"line_type": "added", "new_line": 2, "text": "   ", "text_hash": line_hash("   ")},
                            {"line_type": "added", "new_line": 3, "text": "beta = 2", "text_hash": line_hash("beta = 2")},
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.34",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            events=[ai_change],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        ledger_rows = self.db.execute(
            select(AiLineAttribution).where(AiLineAttribution.file_path == file_path).order_by(AiLineAttribution.line_no)
        ).scalars().all()

        self.assertEqual(stats["succeeded"], 1)
        self.assertEqual([(row.line_no, row.text_preview) for row in ledger_rows], [(1, "alpha = 1"), (3, "beta = 2")])

    def test_line_attribution_ledger_is_processed_by_separate_async_job(self):
        file_path = "collector-server/tests/async_ledger.py"

        def line_hash(text: str) -> str:
            return hashlib.sha256(f"{file_path}\0{text}".encode("utf-8")).hexdigest()

        ai_change = EventIn(
            event_id="async-ledger-code-change",
            task_id="task-async-ledger",
            session_id="copilot-session-async-ledger",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "copilot-session-async-ledger",
                "request_id": "request-ai",
                "response_id": "response-ai",
                "snapshot_kind": "copilot_turn_workspace_diff",
                "file_path": file_path,
                "lines_added": 1,
                "lines_deleted": 0,
                "hunks": [
                    {
                        "old_start": 0,
                        "old_lines": 0,
                        "new_start": 1,
                        "new_lines": 1,
                        "lines": [
                            {"line_type": "added", "new_line": 1, "text": "answer = 42", "text_hash": line_hash("answer = 42")},
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.35",
            username="lyl",
            user_id="user-1",
            events=[ai_change],
        )

        ingest_batch(self.db, batch)
        ingest_stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker", process_line_jobs=False)

        self.assertEqual(ingest_stats["succeeded"], 1)
        self.assertEqual(self.db.execute(select(AiCodeChange)).scalars().one().file_path, file_path)
        self.assertEqual(self.db.execute(select(LineAttributionJob)).scalars().one().status, "pending")
        self.assertEqual(self.db.execute(select(AiLineAttribution)).scalars().all(), [])

        line_stats = process_pending_line_attribution_jobs(self.db, limit=10, worker_id="line-worker")
        ledger_rows = self.db.execute(select(AiLineAttribution).where(AiLineAttribution.file_path == file_path)).scalars().all()

        self.assertEqual(line_stats["succeeded"], 1)
        self.assertEqual(len(ledger_rows), 1)
        self.assertEqual(ledger_rows[0].text_preview, "answer = 42")
        self.assertEqual(ledger_rows[0].classification, "ai_current")

    def test_new_file_commit_marks_positionally_rewritten_ai_line_as_ai_assisted(self):
        file_path = "openspec/specs/杜甫.md"
        workspace_hash = "workspace-dufu-rewrite"
        ai_lines = [
            "# 杜甫",
            "",
            "## 基本信息",
            "",
            "杜甫是唐代伟大的现实主义诗人。",
        ]
        rewritten_line = "## 基本信息啊的说法沙发上饭撒的"
        commit_lines = [ai_lines[0], "", rewritten_line, "", ai_lines[4]]

        def line_hash(text: str) -> str:
            return hashlib.sha256(f"{file_path}\0{text}".encode("utf-8")).hexdigest()

        ai_change = EventIn(
            event_id="turn-ai-dufu-file",
            task_id="task-ai-dufu-file",
            session_id="copilot-session-dufu",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 25, 10, 0, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="yunlong2.liu@ly.com",
            machine_id="machine-1",
            workspace_path_hash=workspace_hash,
            payload={
                "session_id": "copilot-session-dufu",
                "request_id": "request-ai",
                "response_id": "response-ai",
                "snapshot_kind": "copilot_turn_editor_delta",
                "file_path": file_path,
                "lines_added": len(ai_lines),
                "lines_deleted": 0,
                "hunks": [
                    {
                        "old_start": 0,
                        "old_lines": 0,
                        "new_start": 1,
                        "new_lines": len(ai_lines),
                        "lines": [
                            {"line_type": "added", "new_line": index, "text": text, "text_hash": line_hash(text)}
                            for index, text in enumerate(ai_lines, start=1)
                        ],
                    }
                ],
            },
        )
        commit_snapshot = EventIn(
            event_id="commit-dufu-human-rewrite",
            task_id="commit-dufu-human-rewrite",
            tool="copilot",
            event_type="commit_snapshot",
            occurred_at=datetime(2026, 6, 25, 10, 3, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="yunlong2.liu@ly.com",
            machine_id="machine-1",
            workspace_path_hash=workspace_hash,
            payload={
                "commit_sha": "dufurewrite",
                "branch": "main",
                "snapshot_kind": "commit",
                "files_changed": 1,
                "lines_added": len(commit_lines),
                "lines_deleted": 0,
                "file_paths": [file_path],
                "files": [
                    {
                        "file_path": file_path,
                        "lines_added": len(commit_lines),
                        "lines_deleted": 0,
                        "hunks": [
                            {
                                "old_start": 0,
                                "old_lines": 0,
                                "new_start": 1,
                                "new_lines": len(commit_lines),
                                "lines": [
                                    {"line_type": "added", "new_line": index, "text": text, "text_hash": line_hash(text)}
                                    for index, text in enumerate(commit_lines, start=1)
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.35",
            username="lyl",
            user_id="yunlong2.liu@ly.com",
            machine_id="machine-1",
            events=[ai_change, commit_snapshot],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        commit_change = self.db.execute(
            select(AiCodeChange).where(AiCodeChange.event_id == "commit-dufu-human-rewrite")
        ).scalars().one()
        diff_json = commit_change.diff_json
        rewritten = [
            line
            for hunk in diff_json["line_attribution"]["hunks"]
            for line in hunk["lines"]
            if line.get("text") == rewritten_line
        ][0]
        ledger = self.db.execute(
            select(AiLineAttribution).where(AiLineAttribution.file_path == file_path).where(AiLineAttribution.text_preview == rewritten_line)
        ).scalars().one()

        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(rewritten["origin_author"], "ai")
        self.assertEqual(rewritten["last_editor"], "human")
        self.assertEqual(rewritten["classification"], "ai_assisted_human_edited")
        self.assertEqual(diff_json["ai_assisted_human_edited_lines_added"], 1)
        self.assertEqual(ledger.origin_author, "ai")
        self.assertEqual(ledger.last_editor, "human")
        self.assertEqual(ledger.classification, "ai_assisted_human_edited")
        self.assertEqual(ledger.session_id, "copilot-session-dufu")
        self.assertEqual(ledger.request_id, "request-ai")
        self.assertEqual(ledger.response_id, "response-ai")

    def test_commit_snapshot_matches_ai_ledger_for_git_quoted_chinese_path_and_placeholder_user(self):
        file_path = "openspec/specs/刘芸隆.md"
        ai_lines = [
            "# 离别的故事",
            "",
            "## 序章",
            "",
            "窗外的雨淅淅沥沥地下着，打在玻璃上发出细碎的声响。",
            "",
            "## 那些年的相聚",
            "",
            "还记得初来时的青涩，是你们一个个走进我的生活。",
            "",
            "那些看似永恒的日子里，我们以为友谊可以一直延续。",
            "",
            "## 渐行渐远",
            "",
            "可生活就是这样，有相聚就有离散。",
            "",
            "距离似乎没有改变什么，我们依然会发消息、通视频电话。",
            "",
            "## 最后的晚餐",
            "",
            "临行前的那个晚上，我们终于在老地方聚集。",
            "",
            "我们有太多话要说，却又不知从何说起。",
            "",
            "那一刻，我才真正明白什么叫离别。",
            "",
            "## 新的篇章",
            "",
            "踏上列车的瞬间，我回头看了一次。",
            "",
            "离别不是结束，而是生命中最深刻的转折。",
            "",
            "那些关于你们的故事，已经深深地刻在我的生命里。",
            "",
            "---",
            "",
            "*离别，教会我们珍惜；远方，让我们各自成长。*",
        ]
        human_line = "不要离别了 需要继续加油！！！！"

        def line_hash(text: str) -> str:
            return hashlib.sha256(f"{file_path}\0{text}".encode("utf-8")).hexdigest()

        def ai_line_hash(text: str) -> str:
            return hashlib.sha256(text.encode("utf-8")).hexdigest()

        def git_quote(path: str) -> str:
            body = []
            for byte in f"b/{path}".encode("utf-8"):
                if 32 <= byte < 127 and byte not in {34, 92}:
                    body.append(chr(byte))
                else:
                    body.append(f"\\{byte:03o}")
            return f"\"{''.join(body)}\""

        ai_change = EventIn(
            event_id="turn-chinese-ai-lines",
            task_id="task-chinese-ai-lines",
            session_id="copilot-session-chinese",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="yunlong2.liu@ly.com",
            machine_id="machine-1",
            workspace_path_hash="workspace-chinese",
            payload={
                "session_id": "copilot-session-chinese",
                "request_id": "request-ai",
                "response_id": "response-ai",
                "snapshot_kind": "copilot_turn_editor_delta",
                "file_path": file_path,
                "lines_added": len(ai_lines),
                "lines_deleted": 0,
                "hunks": [
                    {
                        "old_start": 0,
                        "old_lines": 0,
                        "new_start": 1,
                        "new_lines": len(ai_lines),
                        "lines": [
                            {"line_type": "added", "new_line": index, "text": text, "text_hash": ai_line_hash(text)}
                            for index, text in enumerate(ai_lines, start=1)
                        ],
                    }
                ],
            },
        )
        commit_snapshot = EventIn(
            event_id="commit-chinese-placeholder-user",
            task_id="commit-chinese-placeholder",
            tool="copilot",
            event_type="commit_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 3, tzinfo=timezone.utc),
            source_confidence="direct",
            username="user",
            user_id="user",
            host_hash="different-hook-host",
            workspace_path_hash="workspace-chinese",
            payload={
                "commit_sha": "chinesepath",
                "branch": "main",
                "snapshot_kind": "commit",
                "files_changed": 1,
                "lines_added": len(ai_lines) + 1,
                "lines_deleted": 0,
                "file_paths": [git_quote(file_path)],
                "files": [
                    {
                        "file_path": git_quote(file_path),
                        "lines_added": len(ai_lines) + 1,
                        "lines_deleted": 0,
                        "hunks": [
                            {
                                "old_start": 0,
                                "old_lines": 0,
                                "new_start": 1,
                                "new_lines": len(ai_lines) + 1,
                                "lines": [
                                    *[
                                        {"line_type": "added", "new_line": index, "text": text, "text_hash": line_hash(text)}
                                        for index, text in enumerate(ai_lines, start=1)
                                    ],
                                    {
                                        "line_type": "added",
                                        "new_line": len(ai_lines) + 1,
                                        "text": human_line,
                                        "text_hash": line_hash(human_line),
                                    },
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.32",
            username="lyl",
            user_id="yunlong2.liu@ly.com",
            machine_id="machine-1",
            events=[ai_change, commit_snapshot],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        commit_change = self.db.execute(
            select(AiCodeChange).where(AiCodeChange.event_id == "commit-chinese-placeholder-user")
        ).scalars().one()
        diff_json = commit_change.diff_json
        lines = diff_json["line_attribution"]["hunks"][0]["lines"]

        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(commit_change.file_path, file_path)
        nonblank_ai_lines = [line for line in ai_lines if line.strip()]
        self.assertEqual(diff_json["ai_current_lines_added"], len(nonblank_ai_lines))
        self.assertEqual(diff_json["human_current_lines_added"], 1)
        self.assertEqual(diff_json["ai_lines_added"], len(nonblank_ai_lines))
        self.assertEqual(diff_json["human_lines_added"], 1)
        self.assertEqual(diff_json["line_attribution_summary"]["ignored_blank_lines"], len(ai_lines) - len(nonblank_ai_lines))
        self.assertEqual(lines[0]["classification"], "ai_current")
        self.assertEqual(lines[-1]["text"], human_line)
        self.assertEqual(lines[-1]["classification"], "human_current")

    def test_commit_snapshot_preserves_ai_attribution_when_line_moves(self):
        file_path = "collector-server/tests/move.py"

        def line_hash(text: str) -> str:
            return hashlib.sha256(f"{file_path}\0{text}".encode("utf-8")).hexdigest()

        ai_change = EventIn(
            event_id="turn-ai-move-source",
            task_id="task-ai-move-source",
            session_id="copilot-session-move",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            workspace_path_hash="workspace-move",
            payload={
                "session_id": "copilot-session-move",
                "request_id": "request-ai",
                "response_id": "response-ai",
                "snapshot_kind": "copilot_turn_editor_delta",
                "file_path": file_path,
                "lines_added": 2,
                "lines_deleted": 0,
                "hunks": [
                    {
                        "old_start": 0,
                        "old_lines": 0,
                        "new_start": 1,
                        "new_lines": 2,
                        "lines": [
                            {"line_type": "added", "new_line": 1, "text": "move_me = True", "text_hash": line_hash("move_me = True")},
                            {"line_type": "added", "new_line": 2, "text": "stay = True", "text_hash": line_hash("stay = True")},
                        ],
                    }
                ],
            },
        )
        commit_snapshot = EventIn(
            event_id="commit-ai-line-moved",
            task_id="commit-ai-line-moved",
            tool="copilot",
            event_type="commit_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 3, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            workspace_path_hash="workspace-move",
            payload={
                "commit_sha": "moveline",
                "branch": "main",
                "snapshot_kind": "commit",
                "files_changed": 1,
                "lines_added": 1,
                "lines_deleted": 1,
                "file_paths": [file_path],
                "files": [
                    {
                        "file_path": file_path,
                        "lines_added": 1,
                        "lines_deleted": 1,
                        "hunks": [
                            {
                                "old_start": 1,
                                "old_lines": 2,
                                "new_start": 1,
                                "new_lines": 2,
                                "lines": [
                                    {"line_type": "removed", "old_line": 1, "text": "move_me = True", "text_hash": line_hash("move_me = True")},
                                    {"line_type": "added", "new_line": 3, "text": "move_me = True", "text_hash": line_hash("move_me = True")},
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.32",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            events=[ai_change, commit_snapshot],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        commit_change = self.db.execute(
            select(AiCodeChange).where(AiCodeChange.event_id == "commit-ai-line-moved")
        ).scalars().one()
        diff_json = commit_change.diff_json
        lines = diff_json["line_attribution"]["hunks"][0]["lines"]
        ledger_rows = self.db.execute(
            select(AiLineAttribution).where(AiLineAttribution.file_path == file_path).order_by(AiLineAttribution.line_no)
        ).scalars().all()

        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(diff_json["ai_moved_lines"], 1)
        self.assertEqual(diff_json["ai_current_lines_added"], 1)
        self.assertEqual(diff_json["human_current_lines_added"], 0)
        self.assertEqual(lines[0]["classification"], "ai_current_moved")
        self.assertEqual(lines[1]["classification"], "ai_current")
        self.assertEqual([(row.line_no, row.text_preview, row.classification) for row in ledger_rows], [
            (2, "stay = True", "ai_current"),
            (3, "move_me = True", "ai_current"),
        ])

    def test_turn_tool_replacement_context_keeps_consecutive_ai_edits(self):
        file_path = "openspec/specs/刘芸隆.md"
        absolute_path = f"/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/{file_path}"
        workspace_hash = "workspace-consecutive-edits"
        context_lines = [
            (33, "那些关于你们的故事，已经深深地刻在我的生命里。", "ai", "ai", "ai_current"),
            (34, "", "ai", "ai", "ai_current"),
            (35, "---", "ai", "ai", "ai_current"),
            (36, "", "ai", "ai", "ai_current"),
            (37, "*离别，教会我们珍惜；远方，让我们各自成长。*", "ai", "ai", "ai_current"),
            (38, "不要离别了 需要继续加油！！！！", "human", "human", "human_current"),
        ]
        for line_no, text, origin, editor, classification in context_lines:
            self.db.add(
                AiLineAttribution(
                    workspace_path_hash=workspace_hash,
                    client_id="client-1",
                    username="lyl",
                    user_id="user-1",
                    machine_id="machine-1",
                    host_hash="",
                    file_path=file_path,
                    line_no=line_no,
                    text_hash=hashlib.sha256(f"{file_path}\0{text}".encode("utf-8")).hexdigest()[:128],
                    text_preview=text,
                    origin_author=origin,
                    last_editor=editor,
                    classification=classification,
                    origin_event_id="seed-event",
                    last_event_id="seed-event",
                    source_snapshot_kind="commit_snapshot",
                    occurred_at=datetime(2026, 6, 24, 10, 0),
                )
            )
        self.db.commit()

        def turn_with_replace(event_id: str, request_id: str, response_id: str, old_text: str, new_text: str, occurred_at: datetime) -> EventIn:
            return EventIn(
                event_id=event_id,
                task_id="task-consecutive-edits",
                session_id="copilot-session-consecutive",
                tool="copilot",
                event_type="turn_snapshot",
                occurred_at=occurred_at,
                source_confidence="direct",
                username="lyl",
                user_id="user-1",
                machine_id="machine-1",
                workspace_path_hash=workspace_hash,
                payload={
                    "session_id": "copilot-session-consecutive",
                    "request_id": request_id,
                    "response_id": response_id,
                    "turn": {
                        "turn_index": 1,
                        "request_id": request_id,
                        "response_id": response_id,
                        "status": "completed",
                        "started_at": "2026-06-24T10:00:01Z",
                        "completed_at": "2026-06-24T10:00:05Z",
                    },
                    "messages": [
                        {"role": "user", "text": "改文件", "source_key": f"{request_id}:user"},
                        {"role": "assistant", "text": "已改", "source_key": f"{request_id}:{response_id}:assistant"},
                    ],
                    "tool_calls": [
                        {
                            "tool_call_id": f"tool-{event_id}",
                            "tool_name": "replace_string_in_file",
                            "status": "requested",
                            "request_id": request_id,
                            "response_id": response_id,
                            "started_at": occurred_at.isoformat(),
                            "arguments_raw": json.dumps(
                                {
                                    "filePath": absolute_path,
                                    "oldString": old_text,
                                    "newString": new_text,
                                },
                                ensure_ascii=False,
                            ),
                        }
                    ],
                },
            )

        tail_before_replace = (
            "那些关于你们的故事，已经深深地刻在我的生命里。\n\n---\n\n"
            "*离别，教会我们珍惜；远方，让我们各自成长。*\n"
            "不要离别了 需要继续加油！！！！\n"
        )
        tail_after_replace = (
            "那些关于你们的故事，已经深深地刻在我的生命里。\n\n---\n\n"
            "*离别，教会我们珍惜；远方，让我们各自成长。*\n"
            "啊啊啊啊啊\n"
        )
        tail_after_insert = (
            "那些关于你们的故事，已经深深地刻在我的生命里。\n\n---\n\n"
            "*离别，教会我们珍惜；远方，让我们各自成长。*\n"
            "哈哈哈哈哈哈\n"
            "啊啊啊啊啊\n"
        )
        editor_replace = EventIn(
            event_id="editor-local-replace-line-six",
            task_id="task-consecutive-edits",
            session_id="copilot-session-consecutive",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 1, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            workspace_path_hash=workspace_hash,
            payload={
                "session_id": "copilot-session-consecutive",
                "request_id": "request-replace",
                "response_id": "response-replace",
                "snapshot_kind": "copilot_turn_editor_delta",
                "file_path": file_path,
                "lines_added": 1,
                "lines_deleted": 1,
                "hunks": [
                    {
                        "old_start": 6,
                        "new_start": 6,
                        "lines": [
                            {"line_type": "removed", "old_line": 6, "text": "不要离别了 需要继续加油！！！！"},
                            {"line_type": "added", "new_line": 6, "text": "啊啊啊啊啊"},
                        ],
                    }
                ],
            },
        )
        editor_insert = EventIn(
            event_id="editor-local-insert-line-six",
            task_id="task-consecutive-edits",
            session_id="copilot-session-consecutive",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 3, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            workspace_path_hash=workspace_hash,
            payload={
                "session_id": "copilot-session-consecutive",
                "request_id": "request-insert",
                "response_id": "response-insert",
                "snapshot_kind": "copilot_turn_editor_delta",
                "file_path": file_path,
                "lines_added": 1,
                "lines_deleted": 0,
                "hunks": [
                    {
                        "old_start": 6,
                        "new_start": 6,
                        "lines": [
                            {"line_type": "added", "new_line": 6, "text": "哈哈哈哈哈哈"},
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.33",
            username="lyl",
            user_id="user-1",
            machine_id="machine-1",
            events=[
                turn_with_replace(
                    "turn-tool-replace-context",
                    "request-replace",
                    "response-replace",
                    tail_before_replace,
                    tail_after_replace,
                    datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
                ),
                editor_replace,
                turn_with_replace(
                    "turn-tool-insert-context",
                    "request-insert",
                    "response-insert",
                    tail_after_replace,
                    tail_after_insert,
                    datetime(2026, 6, 24, 10, 2, tzinfo=timezone.utc),
                ),
                editor_insert,
            ],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        ledger_rows = self.db.execute(
            select(AiLineAttribution)
            .where(AiLineAttribution.file_path == file_path)
            .where(AiLineAttribution.line_no >= 37)
            .order_by(AiLineAttribution.line_no)
        ).scalars().all()
        code_changes = self.db.execute(select(AiCodeChange).order_by(AiCodeChange.occurred_at, AiCodeChange.id)).scalars().all()

        self.assertEqual(stats["succeeded"], 4)
        self.assertEqual([(row.line_no, row.text_preview, row.classification) for row in ledger_rows], [
            (37, "*离别，教会我们珍惜；远方，让我们各自成长。*", "ai_current"),
            (38, "哈哈哈哈哈哈", "ai_current"),
            (39, "啊啊啊啊啊", "ai_current"),
        ])
        self.assertEqual([row.snapshot_kind for row in code_changes], [
            "copilot_turn_tool_patch",
            "copilot_turn_editor_delta",
            "copilot_turn_tool_patch",
            "copilot_turn_editor_delta",
        ])

    def test_large_commit_snapshot_keeps_only_line_attribution_summary(self):
        file_path = "collector-server/tests/large.py"

        def line_hash(text: str) -> str:
            return hashlib.sha256(f"{file_path}\0{text}".encode("utf-8")).hexdigest()

        ai_change = EventIn(
            event_id="large-ai-editor-delta",
            task_id="task-large-ai",
            session_id="copilot-session-large",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            workspace_path_hash="workspace-large",
            payload={
                "session_id": "copilot-session-large",
                "snapshot_kind": "copilot_turn_editor_delta",
                "files": [
                    {
                        "file_path": file_path,
                        "lines_added": 1,
                        "lines_deleted": 0,
                        "changes": [
                            {
                                "file_path": file_path,
                                "added_line_count": 1,
                                "removed_line_count": 0,
                                "added_lines": [
                                    {"line_type": "added", "new_line": 1, "text": "AI_LINE", "text_hash": line_hash("AI_LINE")[:32]},
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        large_commit = EventIn(
            event_id="large-commit-snapshot",
            task_id="commit-large",
            tool="copilot",
            event_type="commit_snapshot",
            occurred_at=datetime(2026, 6, 24, 10, 5, tzinfo=timezone.utc),
            source_confidence="direct",
            username="lyl",
            user_id="user-1",
            workspace_path_hash="workspace-large",
            payload={
                "commit_sha": "largecommit",
                "branch": "main",
                "snapshot_kind": "commit",
                "files_changed": 1,
                "lines_added": 5001,
                "lines_deleted": 0,
                "file_paths": [file_path],
                "diff_raw": {
                    "blob_ref": "diff_raw",
                    "encoding": "gzip+base64",
                    "sha256": "sha-large",
                    "original_bytes": 6_000_000,
                    "compressed_bytes": 500_000,
                    "chunk_count": 2,
                },
                "files": [
                    {
                        "file_path": file_path,
                        "lines_added": 5001,
                        "lines_deleted": 0,
                        "hunks": [
                            {
                                "old_start": 0,
                                "old_lines": 0,
                                "new_start": 1,
                                "new_lines": 5001,
                                "lines": [
                                    {"line_type": "added", "new_line": 1, "text": "AI_LINE", "text_hash": line_hash("AI_LINE")},
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.29",
            username="lyl",
            user_id="user-1",
            events=[ai_change, large_commit],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        commit_change = self.db.execute(
            select(AiCodeChange).where(AiCodeChange.event_id == "large-commit-snapshot")
        ).scalars().one()
        diff_json = commit_change.diff_json

        self.assertEqual(stats["succeeded"], 2)
        self.assertEqual(diff_json["ai_lines_added"], 1)
        self.assertEqual(diff_json["human_lines_added"], 0)
        self.assertEqual(diff_json["line_attribution_summary"]["raw_total_added_lines"], 5001)
        self.assertEqual(diff_json["line_attribution_summary"]["total_added_lines"], 1)
        self.assertTrue(diff_json["line_attribution_truncated"])
        self.assertFalse(diff_json["line_attribution"]["full_line_attribution"])
        self.assertNotIn("hunks", diff_json["line_attribution"])
        self.assertNotIn("hunks", diff_json)
        self.assertEqual(diff_json["product_detail_policy"], "line_attribution_summary_only")
        self.assertEqual(diff_json["line_attribution_summary"]["full_line_attribution_limit"], 5000)
        self.assertEqual(diff_json["diff_blob_ref"]["blob_ref"], "diff_raw")

    def test_large_editor_delta_keeps_only_summary(self):
        file_path = "collector-server/tests/large-editor.py"
        event = EventIn(
            event_id="large-editor-delta-summary",
            task_id="task-large-editor",
            session_id="copilot-session-large-editor",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "copilot-session-large-editor",
                "snapshot_kind": "copilot_turn_editor_delta",
                "files": [
                    {
                        "file_path": file_path,
                        "lines_added": 5001,
                        "lines_deleted": 0,
                        "changes": [
                            {
                                "file_path": file_path,
                                "added_line_count": 5001,
                                "removed_line_count": 0,
                                "added_lines": [
                                    {"line_type": "added", "new_line": 1, "text": "AI_LINE", "text_hash": hashlib.sha256(f"{file_path}\0AI_LINE".encode("utf-8")).hexdigest()},
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.30",
            username="lyl",
            user_id="user-1",
            events=[event],
        )

        ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        change = self.db.execute(select(AiCodeChange).where(AiCodeChange.event_id == "large-editor-delta-summary")).scalars().one()
        diff_json = change.diff_json

        self.assertEqual(stats["succeeded"], 1)
        self.assertEqual(change.lines_added, 5001)
        self.assertTrue(diff_json["line_detail_truncated"])
        self.assertNotIn("changes", diff_json)
        self.assertEqual(diff_json["product_detail_policy"], "line_attribution_summary_only")
        self.assertEqual(diff_json["line_attribution_summary"]["total_added_lines"], 5001)

    def test_session_detail_prefers_tool_patch_over_legacy_editor_delta(self):
        editor_delta = AiCodeChange(
            session_id="copilot-session",
            task_id="task-code",
            turn_index=5,
            request_id="request-1",
            response_id="response-1",
            event_id="legacy-editor-delta",
            file_path="collector-server/tests/hello.py",
            change_type="copilot_turn_editor_delta",
            snapshot_kind="copilot_turn_editor_delta",
            lines_added=8,
            lines_deleted=3,
            occurred_at=datetime(2026, 6, 24, 10, 1),
        )
        tool_patch = AiCodeChange(
            session_id="copilot-session",
            task_id="task-code",
            turn_index=5,
            request_id="request-1",
            response_id="response-1",
            event_id="turn-tool-patch",
            file_path="collector-server/tests/hello.py",
            change_type="copilot_turn_tool_patch",
            snapshot_kind="copilot_turn_tool_patch",
            lines_added=8,
            lines_deleted=3,
            occurred_at=datetime(2026, 6, 24, 10, 0),
        )

        preferred = _preferred_code_changes([tool_patch, editor_delta])

        self.assertEqual(preferred, [tool_patch])

    def test_code_change_preserves_line_level_diff_and_stats(self):
        event = EventIn(
            event_id="code-line-level-1234",
            task_id="task-code-lines",
            session_id="copilot-session",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "copilot-session",
                "request_id": "request-1",
                "response_id": "response-1",
                "turn_index": 1,
                "snapshot_kind": "copilot_turn_editor_delta",
                "diff_hash": "diff-line-level",
                "files": [
                    {
                        "file_path": "tests/hello_agent.py",
                        "lines_added": 2,
                        "lines_deleted": 1,
                        "hunks": [
                            {
                                "old_start": 1,
                                "old_lines": 1,
                                "new_start": 1,
                                "new_lines": 2,
                                "lines": [
                                    {"line_type": "removed", "old_line": 1, "text": "old = True"},
                                    {"line_type": "added", "new_line": 1, "text": "def main():"},
                                    {"line_type": "added", "new_line": 2, "text": "    print('hello agent')"},
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.26",
            username="lyl",
            user_id="user-1",
            events=[event],
        )

        result = ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")
        change = self.db.execute(select(AiCodeChange)).scalars().one()

        self.assertEqual(result["accepted"], 1)
        self.assertEqual(stats["succeeded"], 1)
        self.assertEqual(change.lines_added, 2)
        self.assertEqual(change.lines_deleted, 1)
        self.assertEqual(change.diff_json["hunks"][0]["lines"][1]["text"], "def main():")
        self.assertEqual(change.diff_json["hunk_count"], 1)
        self.assertTrue(change.diff_json["has_line_level_diff"])
        self.assertTrue(change.diff_json["has_line_text"])
        self.assertTrue(change.diff_json["line_level_complete"])
        self.assertEqual(change.diff_json["line_stats"]["summary_added_line_count"], 2)
        self.assertEqual(change.diff_json["line_stats"]["summary_deleted_line_count"], 1)
        self.assertEqual(change.diff_json["line_stats"]["captured_added_line_count"], 2)
        self.assertEqual(change.diff_json["line_stats"]["captured_deleted_line_count"], 1)
        self.assertEqual(change.diff_json["line_stats"]["captured_line_count"], 3)

    def test_turn_scoped_workspace_diff_snapshot_creates_code_attribution(self):
        event = EventIn(
            event_id="workspace-diff-1234",
            task_id="task-workspace-diff",
            session_id="copilot-session",
            tool="copilot",
            event_type="code_change",
            occurred_at=datetime(2026, 6, 24, 10, 0, tzinfo=timezone.utc),
            source_confidence="derived",
            username="lyl",
            user_id="user-1",
            payload={
                "session_id": "copilot-session",
                "request_id": "request-1",
                "response_id": "response-1",
                "turn_index": 1,
                "snapshot_kind": "copilot_turn_workspace_diff",
                "files_changed": 50,
                "lines_added": 7567,
                "lines_deleted": 656,
                "files": [
                    {
                        "file_path": "unrelated/history.ts",
                        "lines_added": 100,
                        "lines_deleted": 20,
                    }
                ],
            },
        )
        batch = BatchIn(
            client_id="client-1",
            plugin_name="tinyai-observability-vscode",
            plugin_version="0.1.26",
            username="lyl",
            user_id="user-1",
            events=[event],
        )

        result = ingest_batch(self.db, batch)
        stats = process_pending_ingest_jobs(self.db, limit=10, worker_id="test-worker")

        self.assertEqual(result["accepted"], 1)
        self.assertEqual(stats["succeeded"], 1)
        change = self.db.execute(select(AiCodeChange)).scalars().one()
        self.assertEqual(change.snapshot_kind, "copilot_turn_workspace_diff")
        self.assertEqual(change.lines_added, 100)
        self.assertEqual(change.lines_deleted, 20)
        self.assertEqual(change.diff_json["files_changed"], 50)


if __name__ == "__main__":
    unittest.main()
