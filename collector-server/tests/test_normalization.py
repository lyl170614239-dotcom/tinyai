from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace
import importlib.util
import sys
import unittest


events_stub = ModuleType("app.schemas.events")
events_stub.EventIn = object
sys.modules.setdefault("app", ModuleType("app"))
sys.modules.setdefault("app.services", ModuleType("app.services"))
sys.modules["app.schemas.events"] = events_stub

module_path = Path(__file__).parents[1] / "app" / "services" / "normalization_service.py"
spec = importlib.util.spec_from_file_location("app.services.normalization_service", module_path)
assert spec and spec.loader
normalization_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = normalization_module
spec.loader.exec_module(normalization_module)
normalize_event = normalization_module.normalize_event

class NormalizationTests(unittest.TestCase):
    def event(self, tool: str = "copilot", event_type: str = "conversation_snapshot"):
        return SimpleNamespace(
            event_id="event-12345678",
            task_id="task-12345678",
            session_id="session-1",
            tool=tool,
            event_type=event_type,
            occurred_at=datetime(2026, 6, 24, tzinfo=timezone.utc),
            source_confidence="derived",
            user_id="test-user",
            model=None,
            payload={},
        )

    def test_source_keys_replace_incremental_copy_but_preserve_equal_text_in_other_turn(self):
        payload = {
            "messages": [
                {"role": "user", "text": "继续", "source_key": "request:0:user"},
                {"role": "assistant", "text": "处理中", "source_key": "request:0:assistant"},
                {"role": "assistant", "text": "处理完成", "source_key": "request:0:assistant"},
                {"role": "user", "text": "继续", "source_key": "request:1:user"},
                {"role": "user", "text": "", "text_len": 0},
            ]
        }
        normalized = normalize_event(self.event(), payload)
        self.assertEqual(normalized["adapter"], "copilot_transcript_v1")
        self.assertEqual(
            [(message["role"], message["content"]) for message in normalized["messages"]],
            [("user", "继续"), ("assistant", "处理完成"), ("user", "继续")],
        )

    def test_tool_specific_adapter_name(self):
        normalized = normalize_event(self.event("claude"), {"messages": []})
        self.assertEqual(normalized["adapter"], "claude_jsonl_v1")

    def test_copilot_request_usage_is_normalized_without_default_zeroes(self):
        payload = {
            "title": "系统目录列表",
            "resolved_model": "claude-sonnet-4-6",
            "request_usage": [
                {
                    "request_id": "request-1",
                    "request_index": 0,
                    "model": "claude-sonnet-4-6",
                    "prompt_tokens": 25040,
                    "output_tokens": 371,
                    "elapsed_ms": 19462,
                    "copilot_credits": 6.6,
                    "credits_source": "details",
                    "occurred_at": "2026-06-22T13:00:00Z",
                },
                {
                    "request_id": "request-2",
                    "request_index": 1,
                    "model": "gpt-5",
                },
            ],
            "usage_totals": {
                "prompt_tokens": 25040,
                "output_tokens": 371,
                "completion_tokens": 0,
                "elapsed_ms": 19462,
                "copilot_credits": 6.6,
            },
        }
        normalized = normalize_event(self.event(), payload)
        self.assertEqual(normalized["session"]["title"], "系统目录列表")
        self.assertEqual(normalized["session"]["model"], "claude-sonnet-4-6")
        self.assertEqual(normalized["request_usage"][0]["turn_index"], 1)
        self.assertEqual(normalized["request_usage"][1]["turn_index"], 2)
        self.assertIsNone(normalized["request_usage"][1]["prompt_tokens"])
        self.assertEqual(normalized["usage_totals"]["copilot_credits"], 6.6)

    def test_process_snapshot_preserves_stable_step_id_and_generates_legacy_fallback(self):
        payload = {
            "process_steps": [
                {
                    "step_id": "stable-readme-step",
                    "kind": "tool_call",
                    "text": "Read README.md",
                    "text_hash": "readme-hash",
                    "tool_name": "read_file",
                    "status": "complete",
                },
                {
                    "kind": "visible_reasoning",
                    "text": "Reviewed architecture",
                    "text_hash": "reasoning-hash",
                    "status": "complete",
                },
            ]
        }
        normalized = normalize_event(self.event(event_type="agent_process_snapshot"), payload)
        self.assertEqual(normalized["process_steps"][0]["step_id"], "stable-readme-step")
        self.assertTrue(normalized["process_steps"][1]["step_id"])
        self.assertEqual(normalized["process_steps"][1]["step_type"], "reasoning")

    def test_legacy_agent_activity_keeps_original_step_index(self):
        payload = {
            "activity_kind": "tool_call",
            "step_index": 7,
            "text": "Read main.py",
            "text_hash": "main-hash",
            "tool_name": "read_file",
        }
        normalized = normalize_event(self.event(event_type="agent_activity"), payload)
        self.assertEqual(normalized["process_steps"][0]["step_index"], 7)
        self.assertTrue(normalized["process_steps"][0]["step_id"])

    def test_copilot_snapshot_exposes_lifecycle_status_and_last_activity(self):
        payload = {
            "session_status": "completed",
            "last_activity_at": "2026-06-24T18:06:20+08:00",
            "messages": [{"role": "user", "text": "你好"}],
        }
        normalized = normalize_event(self.event(), payload)
        self.assertEqual(normalized["session"]["status"], "completed")
        self.assertEqual(normalized["session"]["last_activity_at"], "2026-06-24T18:06:20+08:00")

    def test_turn_snapshot_binds_messages_process_and_usage_to_request_response(self):
        payload = {
            "session_id": "copilot-session",
            "request_id": "request-1",
            "response_id": "response-1",
            "title": "架构分析",
            "model": "claude-haiku-4.5",
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
            "process_steps": [
                {
                    "step_id": "step-tool-1",
                    "step_type": "tool_call",
                    "text": "read_file complete",
                    "tool_call_id": "tool-1",
                    "tool_name": "read_file",
                    "actor_path": "top",
                    "actor_type": "top_level",
                    "status": "complete",
                }
            ],
            "request_usage": [{"request_id": "request-1", "response_id": "response-1", "request_index": 0, "prompt_tokens": 12}],
        }
        normalized = normalize_event(self.event(event_type="turn_snapshot"), payload)
        self.assertEqual(normalized["adapter"], "copilot_turn_snapshot_v1")
        self.assertEqual(normalized["session"]["status"], "completed")
        self.assertEqual(normalized["turns"][0]["request_id"], "request-1")
        self.assertEqual(normalized["messages"][0]["request_id"], "request-1")
        self.assertEqual(normalized["process_steps"][0]["step_id"], "step-tool-1")
        self.assertEqual(normalized["process_steps"][0]["tool_call_id"], "tool-1")
        self.assertEqual(normalized["request_usage"][0]["response_id"], "response-1")

    def test_codex_session_snapshot_keeps_user_and_assistant_in_conversation_turns(self):
        payload = {
            "session_id": "codex-session",
            "title": "codex 会话",
            "model": "gpt-5.5",
            "messages": [
                {"role": "user", "text": "你好", "message_id": "u1"},
                {"role": "assistant", "text": "你好，我在。", "message_id": "a1"},
                {"role": "user", "text": "你能做什么", "message_id": "u2"},
                {"role": "assistant", "text": "我可以帮你看代码。", "message_id": "a2"},
            ],
            "request_usage": [
                {"request_id": "codex-request-1", "response_id": "codex-response-1", "request_index": 0, "turn_index": 1},
                {"request_id": "codex-request-2", "response_id": "codex-response-2", "request_index": 1, "turn_index": 2},
            ],
        }
        normalized = normalize_event(self.event(tool="codex", event_type="turn_snapshot"), payload)

        self.assertEqual([turn["turn_index"] for turn in normalized["turns"]], [1, 2])
        self.assertEqual([message["turn_index"] for message in normalized["messages"]], [1, 1, 2, 2])
        self.assertEqual(
            [(message["role"], message["content"]) for message in normalized["messages"]],
            [("user", "你好"), ("assistant", "你好，我在。"), ("user", "你能做什么"), ("assistant", "我可以帮你看代码。")],
        )
        self.assertEqual(normalized["messages"][0]["request_id"], "codex-request-1")
        self.assertEqual(normalized["messages"][2]["request_id"], "codex-request-2")

    def test_claude_turn_snapshot_uses_claude_adapter_and_status(self):
        payload = {
            "session_id": "claude-session",
            "request_id": "request-1",
            "response_id": "response-1",
            "turn": {
                "turn_index": 1,
                "request_id": "request-1",
                "response_id": "response-1",
                "status": "failed",
            },
            "messages": [
                {"role": "user", "text": "今天天气怎么样", "text_hash": "u"},
                {"role": "assistant", "text": "Error during execution", "text_hash": "a"},
            ],
            "tool_calls": [
                {
                    "tool_call_id": "call-1",
                    "tool_name": "read_file",
                    "arguments_raw": {"file_path": "openspec/specs/a.md"},
                    "status": "complete",
                }
            ],
            "code_changes": [
                {
                    "snapshot_kind": "claude_turn_tool_patch",
                    "file_path": "src/a.py",
                    "lines_added": 1,
                    "lines_deleted": 0,
                    "hunks": [
                        {
                            "old_start": 1,
                            "old_lines": 0,
                            "new_start": 1,
                            "new_lines": 1,
                            "lines": [{"line_type": "added", "new_line": 1, "text": "x = 1", "text_hash": "h"}],
                        }
                    ],
                }
            ],
            "request_usage": [
                {"request_id": "request-1", "response_id": "response-1", "prompt_tokens": 10, "output_tokens": 2, "credits_source": "claude"}
            ],
        }

        normalized = normalize_event(self.event(tool="claude", event_type="turn_snapshot"), payload)

        self.assertEqual(normalized["adapter"], "claude_turn_snapshot_v1")
        self.assertEqual(normalized["turns"][0]["status"], "failed")
        self.assertEqual(normalized["code_changes"][0]["snapshot_kind"], "claude_turn_tool_patch")
        self.assertEqual(normalized["spec_accesses"][0]["doc_path"], "openspec/specs/a.md")
        self.assertEqual(normalized["request_usage"][0]["credits_source"], "claude")

    def test_claude_turn_snapshot_ignores_rejected_edit_code_change(self):
        payload = {
            "session_id": "claude-session",
            "request_id": "request-rejected-edit",
            "response_id": "response-rejected-edit",
            "turn": {
                "turn_index": 1,
                "request_id": "request-rejected-edit",
                "response_id": "response-rejected-edit",
                "status": "failed",
                "interrupted": True,
            },
            "messages": [
                {"role": "user", "text": "修改刘芸隆md，添加离别的故事", "text_hash": "u"},
                {"role": "assistant", "text": "我来修改文件。", "text_hash": "a"},
            ],
            "tool_calls": [
                {
                    "tool_call_id": "call-edit-rejected",
                    "tool_name": "replace_string_in_file",
                    "arguments_raw": {
                        "file_path": "/Users/user/code/ai-observability/刘芸隆.md",
                        "old_string": "旧内容",
                        "new_string": "新内容",
                    },
                    "status": "failed",
                    "result_raw": "User rejected tool use",
                }
            ],
            "process_steps": [
                {
                    "step_type": "tool_result",
                    "tool_call_id": "call-edit-rejected",
                    "tool_name": "replace_string_in_file",
                    "status": "failed",
                    "text": "The tool use was rejected.",
                }
            ],
            "code_changes": [
                {
                    "snapshot_kind": "claude_turn_tool_patch",
                    "file_path": "/Users/user/code/ai-observability/刘芸隆.md",
                    "tool_call_id": "call-edit-rejected",
                    "tool_name": "replace_string_in_file",
                    "lines_added": 1,
                    "lines_deleted": 1,
                    "hunks": [
                        {
                            "old_start": 1,
                            "old_lines": 1,
                            "new_start": 1,
                            "new_lines": 1,
                            "lines": [
                                {"line_type": "removed", "old_line": 1, "text": "旧内容", "text_hash": "old"},
                                {"line_type": "added", "new_line": 1, "text": "新内容", "text_hash": "new"},
                            ],
                        }
                    ],
                }
            ],
        }

        normalized = normalize_event(self.event(tool="claude", event_type="turn_snapshot"), payload)

        self.assertEqual(normalized["adapter"], "claude_turn_snapshot_v1")
        self.assertEqual(normalized["turns"][0]["status"], "failed")
        self.assertEqual(normalized["code_changes"], [])

    def test_claude_turn_snapshot_keeps_completed_edit_with_failure_words_in_content(self):
        payload = {
            "session_id": "claude-session",
            "request_id": "request-complete-edit",
            "response_id": "response-complete-edit",
            "turn": {
                "turn_index": 1,
                "request_id": "request-complete-edit",
                "response_id": "response-complete-edit",
                "status": "completed",
            },
            "messages": [
                {"role": "user", "text": "酒店状态流转", "text_hash": "u"},
                {"role": "assistant", "text": "已更新文档。", "text_hash": "a"},
            ],
            "tool_calls": [
                {
                    "tool_call_id": "call-edit-complete",
                    "tool_name": "replace_string_in_file",
                    "arguments_raw": {
                        "file_path": "/Users/user/code/project/openspec/specs/domain-knowledge.md",
                        "old_string": "旧内容",
                        "new_string": "PaymentFail / ErrorCode 只是业务枚举，不代表工具失败",
                    },
                    "status": "complete",
                    "result_raw": {
                        "filePath": "/Users/user/code/project/openspec/specs/domain-knowledge.md",
                        "newString": "PaymentFail / ErrorCode 只是业务枚举，不代表工具失败",
                    },
                }
            ],
            "process_steps": [
                {
                    "step_type": "tool_result",
                    "tool_call_id": "call-edit-complete",
                    "tool_name": "replace_string_in_file",
                    "status": "complete",
                    "text": "The file has been updated successfully.",
                }
            ],
            "code_changes": [
                {
                    "snapshot_kind": "claude_turn_tool_patch",
                    "file_path": "/Users/user/code/project/openspec/specs/domain-knowledge.md",
                    "tool_call_id": "call-edit-complete",
                    "tool_name": "replace_string_in_file",
                    "lines_added": 1,
                    "lines_deleted": 1,
                    "hunks": [
                        {
                            "old_start": 1,
                            "old_lines": 1,
                            "new_start": 1,
                            "new_lines": 1,
                            "lines": [
                                {"line_type": "removed", "old_line": 1, "text": "旧内容", "text_hash": "old"},
                                {
                                    "line_type": "added",
                                    "new_line": 1,
                                    "text": "PaymentFail / ErrorCode 只是业务枚举，不代表工具失败",
                                    "text_hash": "new",
                                },
                            ],
                        }
                    ],
                }
            ],
        }

        normalized = normalize_event(self.event(tool="claude", event_type="turn_snapshot"), payload)

        self.assertEqual(len(normalized["code_changes"]), 1)
        self.assertEqual(normalized["code_changes"][0]["snapshot_kind"], "claude_turn_tool_patch")

    def test_claude_turn_snapshot_cleans_agent_prompt_and_ide_context(self):
        agent_prompt = (
            "I need to understand the system architecture of the ai-observability project at "
            "/Users/user/code/ai-observability.\n\nPlease do a thorough exploration:"
        )
        payload = {
            "session_id": "claude-session",
            "request_id": "request-architecture",
            "response_id": "response-architecture",
            "title": "<ide_opened_file>The user opened clear_tinyobs_data.py.</ide_opened_file>\n给我看看系统架构",
            "turn": {
                "turn_index": 1,
                "request_id": "request-architecture",
                "response_id": "response-architecture",
                "status": "completed",
            },
            "messages": [
                {"role": "user", "text": agent_prompt, "source_key": "request-agent"},
                {
                    "role": "user",
                    "text": "<ide_opened_file>The user opened clear_tinyobs_data.py.</ide_opened_file>\n给我看看系统架构",
                    "source_key": "request-architecture",
                },
                {"role": "assistant", "text": "## TinyAI Observability — 系统架构", "source_key": "response-architecture"},
            ],
            "tool_calls": [
                {
                    "tool_name": "agent",
                    "tool_call_id": "call-agent",
                    "arguments_raw": {"prompt": agent_prompt},
                }
            ],
        }

        normalized = normalize_event(self.event(tool="claude", event_type="turn_snapshot"), payload)

        self.assertEqual(normalized["session"]["title"], "给我看看系统架构")
        self.assertEqual(
            [(message["role"], message["content"]) for message in normalized["messages"]],
            [("user", "给我看看系统架构"), ("assistant", "## TinyAI Observability — 系统架构")],
        )
        self.assertNotIn("ide_opened_file", normalized["messages"][0]["content"])
        self.assertFalse(any("I need to understand the system architecture" in message["content"] for message in normalized["messages"]))

    def test_claude_subagent_snapshot_is_not_a_top_level_turn(self):
        payload = {
            "session_id": "claude-session",
            "request_id": "subagent-request",
            "response_id": "subagent-response",
            "title": "Read /repo/plugin-runtime/src/mcp-server.ts and return a structured summary",
            "turn": {
                "turn_index": 1,
                "request_id": "subagent-request",
                "response_id": "subagent-response",
                "status": "failed",
            },
            "source_files": {
                "claude_project_jsonl": {
                    "path": "~/.claude/projects/project/session/subagents/agent-123.jsonl"
                }
            },
            "messages": [
                {"role": "user", "text": "Read /repo/plugin-runtime/src/mcp-server.ts and return a structured summary"},
                {"role": "assistant", "text": "API Error: 400"},
            ],
            "process_steps": [{"step_type": "error", "text": "API Error: 400"}],
            "request_usage": [{"request_id": "subagent-request", "response_id": "subagent-response", "request_index": 0}],
        }

        normalized = normalize_event(self.event(tool="claude", event_type="turn_snapshot"), payload)

        self.assertEqual(normalized["turns"], [])
        self.assertEqual(normalized["messages"], [])
        self.assertEqual(normalized["process_steps"], [])
        self.assertEqual(normalized["request_usage"], [])
        self.assertIn("claude subagent snapshot skipped", normalized["warnings"][0])

    def test_copilot_turn_snapshot_does_not_derive_code_changes_from_apply_patch_tool_call(self):
        patch = """*** Begin Patch
*** Update File: /Users/user/code/ai-observability/collector-server/tests/hello.py
@@
 def run_all():
     return {"hello": hello()}
+
+def molecular_weight(formula: str) -> float:
+    return 18.015
*** End Patch"""
        payload = {
            "cwd": "/Users/user/code/ai-observability",
            "session_id": "copilot-session",
            "request_id": "request-molecule",
            "response_id": "response-molecule",
            "turn": {
                "turn_index": 9,
                "request_id": "request-molecule",
                "response_id": "response-molecule",
                "started_at": "2026-06-24T10:00:01Z",
                "completed_at": "2026-06-24T10:00:10Z",
            },
            "messages": [
                {"role": "user", "text": "继续写代码，写一个分子计算的", "source_key": "request-molecule:user"},
                {"role": "assistant", "text": "已添加分子量计算", "source_key": "request-molecule:response-molecule:assistant"},
            ],
            "tool_calls": [
                {
                    "tool_name": "apply_patch",
                    "status": "complete",
                    "tool_call_id": "call-patch",
                    "request_id": "request-molecule",
                    "response_id": "response-molecule",
                    "completed_at": "2026-06-24T10:00:08Z",
                    "arguments_raw": {"input": patch},
                }
            ],
        }

        normalized = normalize_event(self.event(tool="copilot", event_type="turn_snapshot"), payload)

        self.assertEqual(normalized["code_changes"], [])

    def test_claude_turn_snapshot_still_derives_code_changes_from_apply_patch_tool_call(self):
        patch = """*** Begin Patch
*** Update File: /Users/user/code/ai-observability/collector-server/tests/hello.py
@@
 def run_all():
     return {"hello": hello()}
+
+def molecular_weight(formula: str) -> float:
+    return 18.015
*** End Patch"""
        payload = {
            "cwd": "/Users/user/code/ai-observability",
            "session_id": "claude-session",
            "request_id": "request-molecule",
            "response_id": "response-molecule",
            "turn": {
                "turn_index": 9,
                "request_id": "request-molecule",
                "response_id": "response-molecule",
                "started_at": "2026-06-24T10:00:01Z",
                "completed_at": "2026-06-24T10:00:10Z",
            },
            "messages": [
                {"role": "user", "text": "继续写代码，写一个分子计算的", "source_key": "request-molecule:user"},
                {"role": "assistant", "text": "已添加分子量计算", "source_key": "request-molecule:response-molecule:assistant"},
            ],
            "tool_calls": [
                {
                    "tool_name": "apply_patch",
                    "status": "complete",
                    "tool_call_id": "call-patch",
                    "request_id": "request-molecule",
                    "response_id": "response-molecule",
                    "completed_at": "2026-06-24T10:00:08Z",
                    "arguments_raw": {"input": patch},
                }
            ],
        }

        normalized = normalize_event(self.event(tool="claude", event_type="turn_snapshot"), payload)
        changes = normalized["code_changes"]

        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["file_path"], "collector-server/tests/hello.py")
        self.assertEqual(changes[0]["request_id"], "request-molecule")
        self.assertEqual(changes[0]["turn_index"], 9)
        self.assertEqual(changes[0]["snapshot_kind"], "claude_turn_tool_patch")
        self.assertGreaterEqual(changes[0]["lines_added"], 2)
        self.assertTrue(changes[0]["has_line_level_diff"])
        self.assertIn("molecular_weight", "\n".join(line["text"] for line in changes[0]["hunks"][0]["lines"]))

    def test_code_change_preserves_absolute_line_number_basis(self):
        payload = {
            "snapshot_kind": "copilot_turn_workspace_diff",
            "file_path": "src/example.py",
            "line_number_basis": "absolute",
            "lines_added": 1,
            "lines_deleted": 0,
            "hunks": [
                {
                    "old_start": 0,
                    "old_lines": 0,
                    "new_start": 42,
                    "new_lines": 1,
                    "lines": [{"line_type": "added", "new_line": 42, "text": "answer = 42", "text_hash": "h"}],
                }
            ],
        }

        normalized = normalize_event(self.event(event_type="code_change"), payload)

        self.assertEqual(normalized["code_changes"][0]["line_number_basis"], "absolute")
        self.assertTrue(normalized["code_changes"][0]["line_numbers_are_absolute"])
        self.assertEqual(normalized["code_changes"][0]["line_stats"]["line_number_basis"], "absolute")

    def test_tool_replacement_derives_relative_line_number_basis(self):
        payload = {
            "session_id": "claude-session",
            "request_id": "request-replace",
            "response_id": "response-replace",
            "turn": {"turn_index": 1, "request_id": "request-replace", "response_id": "response-replace"},
            "messages": [{"role": "user", "text": "改代码"}, {"role": "assistant", "text": "已改"}],
            "tool_calls": [
                {
                    "tool_call_id": "call-replace",
                    "tool_name": "replace_string_in_file",
                    "status": "complete",
                    "arguments_raw": {
                        "filePath": "src/example.py",
                        "oldString": "old = True",
                        "newString": "new = True",
                    },
                }
            ],
        }

        normalized = normalize_event(self.event(tool="claude", event_type="turn_snapshot"), payload)

        self.assertEqual(normalized["code_changes"][0]["line_number_basis"], "relative")
        self.assertFalse(normalized["code_changes"][0]["line_numbers_are_absolute"])
        self.assertEqual(normalized["code_changes"][0]["line_stats"]["line_number_basis"], "relative")

    def test_turn_snapshot_derives_spec_accesses_from_read_and_edit_tools(self):
        patch = """*** Begin Patch
*** Update File: /Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/architecture.md
@@
-旧架构
+新架构
*** End Patch"""
        payload = {
            "session_id": "copilot-session",
            "request_id": "request-spec",
            "response_id": "response-spec",
            "turn": {
                "turn_index": 2,
                "request_id": "request-spec",
                "response_id": "response-spec",
                "started_at": "2026-06-24T10:00:01Z",
                "completed_at": "2026-06-24T10:00:10Z",
            },
            "messages": [
                {"role": "user", "text": "按规范改代码", "source_key": "request-spec:user"},
                {"role": "assistant", "text": "已处理", "source_key": "request-spec:assistant"},
            ],
            "tool_calls": [
                {
                    "tool_call_id": "call-read",
                    "tool_name": "read_file",
                    "status": "requested",
                    "arguments_raw": {
                        "filePath": "/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/architecture.md",
                    },
                },
                {
                    "tool_call_id": "call-read",
                    "tool_name": "read_file",
                    "status": "complete",
                    "arguments_raw": {
                        "filePath": "openspec/specs/architecture.md",
                    },
                },
                {
                    "tool_call_id": "call-patch",
                    "tool_name": "apply_patch",
                    "status": "complete",
                    "arguments_raw": {"input": patch},
                },
            ],
        }

        normalized = normalize_event(self.event(tool="copilot", event_type="turn_snapshot"), payload)
        spec_accesses = normalized["spec_accesses"]

        self.assertEqual(
            [(access["doc_path"], access["matched_by"][2]) for access in spec_accesses],
            [
                ("openspec/specs/architecture.md", "access:read"),
            ],
        )
        self.assertEqual(spec_accesses[0]["spec_scope"], "project")
        self.assertEqual(spec_accesses[0]["confidence"], "derived")
        self.assertEqual(spec_accesses[0]["access_type"], "read")
        self.assertEqual(spec_accesses[0]["matched_doc_count"], 1)
        self.assertEqual(spec_accesses[0]["matched_docs"], ["openspec/specs/architecture.md"])
        self.assertIn("tool:read_file", spec_accesses[0]["matched_by"])

    def test_turn_snapshot_decodes_git_quoted_chinese_spec_path(self):
        payload = {
            "session_id": "claude-session",
            "request_id": "request-spec-chinese",
            "response_id": "response-spec-chinese",
            "turn": {
                "turn_index": 5,
                "request_id": "request-spec-chinese",
                "response_id": "response-spec-chinese",
            },
            "messages": [
                {"role": "user", "text": "修改刘芸隆.md", "source_key": "request-spec-chinese:user"},
                {"role": "assistant", "text": "已修改", "source_key": "request-spec-chinese:assistant"},
            ],
            "code_changes": [
                {
                    "snapshot_kind": "claude_turn_workspace_diff",
                    "file_path": '"b/openspec/specs/\\345\\210\\230\\350\\212\\270\\351\\232\\206.md"',
                    "lines_added": 1,
                    "lines_deleted": 0,
                    "hunks": [
                        {
                            "old_start": 1,
                            "old_lines": 0,
                            "new_start": 1,
                            "new_lines": 1,
                            "lines": [{"line_type": "added", "new_line": 1, "text": "开心", "text_hash": "h"}],
                        }
                    ],
                }
            ],
        }

        normalized = normalize_event(self.event(tool="claude", event_type="turn_snapshot"), payload)

        self.assertEqual(normalized["code_changes"][0]["file_path"], "openspec/specs/刘芸隆.md")
        self.assertEqual(len(normalized["spec_accesses"]), 1)
        self.assertEqual(normalized["spec_accesses"][0]["doc_path"], "openspec/specs/刘芸隆.md")

    def test_file_level_zero_line_counts_do_not_fallback_to_payload_totals(self):
        payload = {
            "snapshot_kind": "claude_turn_bash_delta",
            "lines_added": 74,
            "lines_deleted": 87,
            "files": [
                {
                    "snapshot_kind": "claude_turn_bash_delta",
                    "file_path": "plugin-runtime/src/index.ts",
                    "lines_added": 1,
                    "lines_deleted": 0,
                    "hunks": [
                        {
                            "old_start": 1,
                            "old_lines": 1,
                            "new_start": 1,
                            "new_lines": 2,
                            "lines": [
                                {"line_type": "context", "old_line": 1, "new_line": 1, "text": "export * from \"./client.js\";"},
                                {"line_type": "added", "new_line": 2, "text": "export * from \"./claude-bash-delta.js\";"},
                            ],
                        }
                    ],
                }
            ],
        }

        normalized = normalize_event(self.event(tool="claude", event_type="code_change"), payload)

        self.assertEqual(normalized["code_changes"][0]["lines_added"], 1)
        self.assertEqual(normalized["code_changes"][0]["lines_deleted"], 0)

    def test_commit_snapshot_does_not_derive_spec_access(self):
        payload = {
            "snapshot_kind": "commit_snapshot",
            "files": [
                {
                    "file_path": "openspec/specs/architecture.md",
                    "lines_added": 1,
                    "lines_deleted": 0,
                }
            ],
        }

        normalized = normalize_event(self.event(event_type="commit_snapshot"), payload)

        self.assertEqual(normalized["spec_accesses"], [])

    def test_turn_snapshot_normalizes_spec_document_catalog(self):
        payload = {
            "session_id": "copilot-session",
            "request_id": "request-docs",
            "response_id": "response-docs",
            "turn": {"turn_index": 1, "request_id": "request-docs", "response_id": "response-docs"},
            "messages": [
                {"role": "user", "text": "读取 specs", "source_key": "request-docs:user"},
                {"role": "assistant", "text": "已读取", "source_key": "request-docs:assistant"},
            ],
            "spec_documents": [
                {
                    "doc_path": "/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs/architecture.md",
                    "file_name": "architecture.md",
                    "size_bytes": 120,
                    "line_count": 8,
                    "content_hash": "a" * 64,
                    "mtime_ms": 123.4,
                },
                {
                    "doc_path": "openspec/specs/architecture.md",
                    "file_name": "architecture.md",
                    "size_bytes": 120,
                    "line_count": 8,
                    "content_hash": "a" * 64,
                    "mtime_ms": 123.4,
                },
            ],
        }

        normalized = normalize_event(self.event(event_type="turn_snapshot"), payload)

        self.assertEqual(len(normalized["spec_documents"]), 1)
        self.assertEqual(normalized["spec_documents"][0]["doc_path"], "openspec/specs/architecture.md")
        self.assertEqual(normalized["spec_documents"][0]["line_count"], 8)
        self.assertEqual(normalized["spec_documents"][0]["content_hash"], "a" * 64)

    def test_turn_snapshot_derives_spec_access_from_explicit_terminal_file_read_only(self):
        payload = {
            "session_id": "copilot-session",
            "request_id": "request-terminal-spec",
            "response_id": "response-terminal-spec",
            "turn": {
                "turn_index": 3,
                "request_id": "request-terminal-spec",
                "response_id": "response-terminal-spec",
                "started_at": "2026-06-24T10:00:01Z",
                "completed_at": "2026-06-24T10:00:10Z",
            },
            "messages": [
                {"role": "user", "text": "读规范", "source_key": "request-terminal-spec:user"},
                {"role": "assistant", "text": "已读取", "source_key": "request-terminal-spec:assistant"},
            ],
            "tool_calls": [
                {
                    "tool_call_id": "call-terminal-read",
                    "tool_name": "run_in_terminal",
                    "status": "complete",
                    "arguments_raw": {
                        "command": "cat openspec/specs/architecture.md && find openspec/specs -maxdepth 1 -type f",
                    },
                },
            ],
        }

        normalized = normalize_event(self.event(event_type="turn_snapshot"), payload)

        self.assertEqual(len(normalized["spec_accesses"]), 1)
        self.assertEqual(normalized["spec_accesses"][0]["doc_path"], "openspec/specs/architecture.md")
        self.assertEqual(normalized["spec_accesses"][0]["matched_doc_count"], 1)
        self.assertIn("terminal_command", normalized["spec_accesses"][0]["matched_by"])
        self.assertIn("access:read", normalized["spec_accesses"][0]["matched_by"])

    def test_turn_snapshot_does_not_create_wildcard_spec_access_for_terminal_directory_only(self):
        payload = {
            "session_id": "copilot-session",
            "request_id": "request-terminal-dir",
            "response_id": "response-terminal-dir",
            "turn": {"turn_index": 4, "request_id": "request-terminal-dir", "response_id": "response-terminal-dir"},
            "messages": [
                {"role": "user", "text": "列目录", "source_key": "request-terminal-dir:user"},
                {"role": "assistant", "text": "已列出", "source_key": "request-terminal-dir:assistant"},
            ],
            "tool_calls": [
                {
                    "tool_call_id": "call-terminal-dir",
                    "tool_name": "run_in_terminal",
                    "status": "complete",
                    "arguments_raw": {
                        "command": "cd /repo && python - <<'PY'\nimport pathlib\nroot=pathlib.Path('openspec/specs')\nfor path in root.iterdir(): print(path.name)\nPY",
                    },
                },
            ],
        }

        normalized = normalize_event(self.event(event_type="turn_snapshot"), payload)

        self.assertEqual(normalized["spec_accesses"], [])

    def test_idea_copilot_turn_snapshot_normalizes_like_copilot_turn(self):
        payload = {
            "schema_version": "copilot.turn_snapshot.v1",
            "source": "idea-copilot-log",
            "session_id": "idea-session",
            "request_id": "idea-request",
            "response_id": "idea-response",
            "turn_index": 2,
            "attempt": 1,
            "started_at": "2026-07-02T01:00:00Z",
            "completed_at": "2026-07-02T01:00:05Z",
            "turn": {
                "turn_index": 2,
                "request_id": "idea-request",
                "response_id": "idea-response",
                "status": "completed",
            },
            "messages": [
                {"role": "user", "text": "explain IDEA plugin", "source_key": "idea-request:user"},
                {"role": "assistant", "text": "it scans local Copilot artifacts", "source_key": "idea-request:idea-response:assistant"},
            ],
            "request_usage": [],
            "usage_totals": {},
        }

        normalized = normalize_event(self.event(tool="copilot", event_type="turn_snapshot"), payload)

        self.assertEqual(normalized["adapter"], "copilot_turn_snapshot_v1")
        self.assertEqual(normalized["session"]["session_id"], "session-1")
        self.assertEqual(normalized["session"]["external_session_id"], "idea-session")
        self.assertEqual(normalized["turns"][0]["request_id"], "idea-request")
        self.assertEqual(normalized["turns"][0]["response_id"], "idea-response")
        self.assertEqual(
            [(message["role"], message["content"]) for message in normalized["messages"]],
            [("user", "explain IDEA plugin"), ("assistant", "it scans local Copilot artifacts")],
        )


if __name__ == "__main__":
    unittest.main()
