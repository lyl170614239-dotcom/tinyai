from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
from typing import Any

from ..schemas.events import EventIn


NORMALIZED_SCHEMA_VERSION = "conversation.normalized.v1"
PARSER_VERSION = "2026-06-25.1"
BEIJING_TZ = timezone(timedelta(hours=8))
GLOBAL_WORKSPACE_DIFF_SNAPSHOT_KINDS = {"workspace_diff_current", "workspace_diff"}
PATCH_FILE_RE = re.compile(r"^\*\*\* (Update|Add|Delete) File: (.+)$")
PATCH_HUNK_RE = re.compile(r"^@@(?:\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?)?")
PROJECT_SPEC_RELATIVE_ROOT = "openspec/specs"
PROJECT_SPEC_ABSOLUTE_ROOT = "/Users/user/code/java_code/jmapi_hotel_new/jmapi_hotel/openspec/specs"
SPEC_READ_TOOLS = {"read_file"}
SPEC_EDIT_TOOLS = {"replace_string_in_file", "create_file", "edit_file", "apply_patch"}
SPEC_EDIT_SNAPSHOT_KINDS = {
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
SPEC_COMMAND_FILE_RE = re.compile(
    r"(?:file://)?(?:/[^\s\"'`<>\]\)]+/)?openspec/specs/[^\s\"'`<>\]\);|]+?\.[A-Za-z0-9]+",
    re.IGNORECASE,
)
CLAUDE_CONTEXT_BLOCK_RE = re.compile(
    r"<(ide_opened_file|selected_text|selection|system-reminder|system_reminder)[^>]*>.*?</\1>",
    re.IGNORECASE | re.DOTALL,
)


def _iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=BEIJING_TZ)
    else:
        value = value.astimezone(BEIJING_TZ)
    return value.isoformat()


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _content_from_message(message: dict[str, Any]) -> str:
    text = message.get("text")
    if isinstance(text, str):
        return text
    preview = message.get("text_preview")
    if isinstance(preview, str):
        return preview
    value = message.get("content") or message.get("message")
    if isinstance(value, str):
        return value
    return ""


def _text_blob_info(message: dict[str, Any]) -> dict[str, Any]:
    ref = _json_record(message.get("text_blob_ref"))
    if not ref:
        return {}
    return {
        "content_storage": "blob_preview",
        "blob_ref": str(ref.get("blob_ref") or "")[:512] or None,
        "blob_encoding": str(ref.get("encoding") or "")[:64] or None,
        "blob_original_bytes": _optional_number(ref.get("original_bytes")),
        "blob_compressed_bytes": _optional_number(ref.get("compressed_bytes")),
        "blob_sha256": str(ref.get("sha256") or "")[:128] or None,
    }


def _content_from_step(step: dict[str, Any]) -> str:
    for key in ("content", "text", "message", "label", "title", "tool_name"):
        value = step.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _normalize_role(role: Any) -> str:
    text = str(role or "message").lower()
    if text in {"user", "assistant", "system", "tool"}:
        return text
    if text in {"ai", "agent"}:
        return "assistant"
    return "message"


def _strip_claude_context_blocks(text: str) -> str:
    cleaned = CLAUDE_CONTEXT_BLOCK_RE.sub("", text)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _prompt_text_from_value(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("prompt", "text", "content"):
            nested = value.get(key)
            if isinstance(nested, str):
                return nested
        return ""
    return ""


def _claude_agent_prompt_candidates(payload: dict[str, Any]) -> list[str]:
    prompts: list[str] = []
    raw_tools = payload.get("tool_calls")
    if not isinstance(raw_tools, list):
        return prompts
    for tool in raw_tools:
        if not isinstance(tool, dict):
            continue
        tool_name = str(tool.get("tool_name") or tool.get("name") or "").lower()
        if tool_name != "agent":
            continue
        for key in ("arguments_raw", "arguments", "input", "args"):
            raw_value = tool.get(key)
            raw_args = _json_record(raw_value)
            prompt = _prompt_text_from_value(raw_args) or _prompt_text_from_value(raw_value)
            if prompt.strip():
                prompts.append(prompt)
    return prompts


def _looks_like_claude_agent_prompt(text: str, payload: dict[str, Any]) -> bool:
    normalized = " ".join(text.split()).lower()
    if not normalized:
        return False
    for prompt in _claude_agent_prompt_candidates(payload):
        candidate = " ".join(prompt.split()).lower()
        if candidate and (normalized == candidate or normalized in candidate or candidate in normalized):
            return True
    if normalized.startswith("i need to ") and "please do a thorough exploration" in normalized:
        return True
    if normalized.startswith("i need to understand ") and ("project" in normalized or "codebase" in normalized):
        return True
    return False


def _is_claude_subagent_snapshot(payload: dict[str, Any]) -> bool:
    source_files = payload.get("source_files")
    if not isinstance(source_files, dict):
        return False
    claude_jsonl = source_files.get("claude_project_jsonl")
    if not isinstance(claude_jsonl, dict):
        return False
    path = str(claude_jsonl.get("path") or "").replace("\\", "/").lower()
    return "/subagents/" in path or path.startswith("subagents/")


def _normalize_step_type(value: Any) -> str:
    text = str(value or "").lower()
    if text in {"visible_reasoning", "reasoning", "thinking"}:
        return "reasoning"
    if text in {"file_read", "read"} or "read" in text:
        return "file_read"
    if text in {"code_edit", "code_change", "patch"} or "edit" in text or "patch" in text:
        return "code_edit"
    if text in {"tool_call", "tool"} or "tool" in text:
        return "tool_call"
    if "error" in text:
        return "error"
    return text or "step"


def _safe_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _range_from_values(values: list[int]) -> dict[str, int | None]:
    if not values:
        return {"min": None, "max": None}
    return {"min": min(values), "max": max(values)}


def _code_line_stats(raw: dict[str, Any], payload: dict[str, Any], lines_added: int, lines_deleted: int) -> dict[str, Any]:
    hunks = raw.get("hunks") if isinstance(raw.get("hunks"), list) else []
    editor_changes = raw.get("changes") if isinstance(raw.get("changes"), list) else []
    hunk_count = 0
    captured_line_count = 0
    captured_added_line_count = 0
    captured_deleted_line_count = 0
    captured_context_line_count = 0
    redacted_line_count = 0
    old_line_numbers: list[int] = []
    new_line_numbers: list[int] = []

    for hunk in hunks:
        if not isinstance(hunk, dict):
            continue
        hunk_count += 1
        lines = hunk.get("lines")
        if not isinstance(lines, list):
            continue
        for line in lines:
            if not isinstance(line, dict):
                continue
            captured_line_count += 1
            line_type = str(line.get("line_type") or line.get("type") or "").lower()
            if line_type in {"added", "add", "insert", "+"}:
                captured_added_line_count += 1
            elif line_type in {"removed", "deleted", "delete", "-"}:
                captured_deleted_line_count += 1
            else:
                captured_context_line_count += 1
            if line.get("redacted"):
                redacted_line_count += 1
            old_line = _safe_int(line.get("old_line"))
            new_line = _safe_int(line.get("new_line"))
            if old_line is not None:
                old_line_numbers.append(old_line)
            if new_line is not None:
                new_line_numbers.append(new_line)

    editor_change_count = 0
    editor_added_line_count = 0
    editor_removed_line_count = 0
    for change in editor_changes:
        if not isinstance(change, dict):
            continue
        editor_change_count += 1
        added_lines = change.get("added_lines")
        if isinstance(added_lines, list):
            editor_added_line_count += len([line for line in added_lines if isinstance(line, dict)])
            for line in added_lines:
                if not isinstance(line, dict):
                    continue
                new_line = _safe_int(line.get("new_line"))
                if new_line is not None:
                    new_line_numbers.append(new_line)
                if line.get("redacted"):
                    redacted_line_count += 1
        editor_removed_line_count += _safe_int(change.get("removed_line_count")) or 0
        range_start = _safe_int(change.get("range_start_line"))
        range_end = _safe_int(change.get("range_end_line"))
        if range_start is not None:
            old_line_numbers.append(range_start)
        if range_end is not None:
            old_line_numbers.append(range_end)

    has_hunk_lines = captured_line_count > 0
    has_editor_lines = editor_added_line_count > 0 or editor_removed_line_count > 0
    captured_added = captured_added_line_count if has_hunk_lines else editor_added_line_count
    captured_deleted = captured_deleted_line_count if has_hunk_lines else editor_removed_line_count
    captured_context = captured_context_line_count if has_hunk_lines else 0
    captured_total = captured_line_count if has_hunk_lines else editor_added_line_count + editor_removed_line_count
    summary_added = lines_added
    summary_deleted = lines_deleted
    return {
        "summary_added_line_count": summary_added,
        "summary_deleted_line_count": summary_deleted,
        "summary_total_line_count": summary_added + summary_deleted,
        "hunk_count": hunk_count,
        "editor_change_count": editor_change_count,
        "captured_line_count": captured_total,
        "captured_added_line_count": captured_added,
        "captured_deleted_line_count": captured_deleted,
        "captured_context_line_count": captured_context,
        "redacted_line_count": redacted_line_count,
        "has_line_level_diff": hunk_count > 0 or editor_change_count > 0 or has_editor_lines,
        "has_line_text": has_hunk_lines or editor_added_line_count > 0,
        "line_level_complete": captured_added >= summary_added and captured_deleted >= summary_deleted,
        "diff_truncated": bool(raw.get("truncated") or payload.get("truncated")),
        "old_line_range": _range_from_values(old_line_numbers),
        "new_line_range": _range_from_values(new_line_numbers),
    }


def _display_path(file_path: str, payload: dict[str, Any]) -> str:
    cwd = payload.get("cwd")
    if isinstance(cwd, str) and file_path.startswith(f"{cwd}/"):
        return file_path[len(cwd) + 1 :]
    if file_path.startswith("file://"):
        return file_path[7:]
    return file_path


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
        "'": b"'",
    }
    while index < len(inner):
        char = inner[index]
        if char != "\\":
            output.extend(char.encode("utf-8"))
            index += 1
            continue
        octal = inner[index + 1 : index + 4]
        if len(octal) == 3 and all(ch in "01234567" for ch in octal):
            output.append(int(octal, 8))
            index += 4
            continue
        next_char = inner[index + 1 : index + 2]
        if next_char in escapes:
            output.extend(escapes[next_char])
            index += 2
            continue
        output.extend(b"\\")
        index += 1
    return output.decode("utf-8", errors="replace")


def _strip_path_noise(value: str) -> str:
    text = value.strip().replace("file://", "").strip(" \t\r\n'`")
    text = _decode_git_quoted_path(text)
    return text.replace("\\", "/").strip(" \t\r\n\"'`")


def _normalize_code_change_path(value: Any, payload: dict[str, Any]) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    path = _strip_path_noise(_display_path(value, payload))
    cwd = payload.get("cwd")
    if isinstance(cwd, str) and cwd.strip():
        normalized_cwd = _strip_path_noise(cwd).rstrip("/")
        if path.startswith(f"{normalized_cwd}/"):
            path = path[len(normalized_cwd) + 1 :]
    path = path.lstrip("./")
    if path.startswith("a/") or path.startswith("b/"):
        path = path[2:]
    spec_marker = f"{PROJECT_SPEC_RELATIVE_ROOT}/"
    marker_index = path.find(spec_marker)
    if marker_index >= 0:
        path = path[marker_index:]
    return path or None


def _spec_doc_path(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    path = _strip_path_noise(value)
    root = PROJECT_SPEC_RELATIVE_ROOT
    if path == root or path == PROJECT_SPEC_ABSOLUTE_ROOT:
        return ""
    for prefix in (f"{PROJECT_SPEC_ABSOLUTE_ROOT}/", f"{root}/", f"/{root}/"):
        if path.startswith(prefix):
            suffix = path[len(prefix) :].strip("/")
            return f"{root}/{suffix}" if suffix else ""
    marker = f"/{root}/"
    if marker in path:
        suffix = path.split(marker, 1)[1].strip("/")
        return f"{root}/{suffix}" if suffix else ""
    return ""


def _json_record(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _tool_call_arguments(tool: dict[str, Any]) -> dict[str, Any]:
    return _json_record(tool.get("arguments_raw") or tool.get("arguments") or tool.get("input") or tool.get("args"))


def _tool_file_path(args: dict[str, Any], payload: dict[str, Any]) -> str:
    for key in ("filePath", "file_path", "path", "file", "uri"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return _display_path(value.strip(), payload)
    return ""


def _tool_line_suffix(args: dict[str, Any]) -> str:
    start = _safe_int(args.get("startLine") or args.get("start_line") or args.get("line") or args.get("fromLine"))
    end = _safe_int(args.get("endLine") or args.get("end_line") or args.get("toLine"))
    if start and end:
        return f" · {start}-{end} 行"
    if start:
        return f" · 第 {start} 行"
    return ""


def _human_tool_content(tool_name: str, status: str, args: dict[str, Any], payload: dict[str, Any]) -> str:
    file_path = _tool_file_path(args, payload)
    line_suffix = _tool_line_suffix(args)
    action_labels = {
        "read_file": "读取文件",
        "replace_string_in_file": "修改文件",
        "create_file": "创建文件",
        "edit_file": "编辑文件",
        "apply_patch": "应用补丁",
    }
    action = action_labels.get(tool_name, tool_name)
    status_suffix = f" · {status}" if status else ""
    if file_path:
        return f"{action}：{file_path}{line_suffix}{status_suffix}"
    return f"{action}{status_suffix}".strip()


def _split_lines(value: str) -> list[str]:
    lines = re.split(r"\r?\n", value)
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def _line_record(line_type: str, file_path: str, text: str, old_line: int | None = None, new_line: int | None = None) -> dict[str, Any]:
    record: dict[str, Any] = {
        "line_type": line_type,
        "text": text,
        "text_hash": _hash_text(f"{file_path}\0{text}"),
    }
    if old_line is not None:
        record["old_line"] = old_line
    if new_line is not None:
        record["new_line"] = new_line
    return record


def _line_number_basis(*records: dict[str, Any]) -> str | None:
    for record in records:
        for key in ("line_number_basis", "lineNumberBasis"):
            value = record.get(key)
            if isinstance(value, str):
                normalized = value.strip().lower()
                if normalized in {"absolute", "relative", "unknown"}:
                    return normalized
        if record.get("line_numbers_are_absolute") is True or record.get("lineNumbersAreAbsolute") is True:
            return "absolute"
    return None


def _code_change_from_replacement(raw: dict[str, Any], payload: dict[str, Any], source: str) -> dict[str, Any] | None:
    file_path = raw.get("filePath") or raw.get("file_path") or raw.get("path") or raw.get("file")
    old_string = raw.get("oldString") or raw.get("old_string")
    new_string = raw.get("newString") or raw.get("new_string")
    if not isinstance(file_path, str) or not isinstance(old_string, str) or not isinstance(new_string, str):
        return None
    display_path = _display_path(file_path, payload)
    old_lines = _split_lines(old_string)
    new_lines = _split_lines(new_string)
    prefix = 0
    while prefix < len(old_lines) and prefix < len(new_lines) and old_lines[prefix] == new_lines[prefix]:
        prefix += 1
    suffix = 0
    while (
        suffix + prefix < len(old_lines)
        and suffix + prefix < len(new_lines)
        and old_lines[len(old_lines) - 1 - suffix] == new_lines[len(new_lines) - 1 - suffix]
    ):
        suffix += 1
    removed = old_lines[prefix : len(old_lines) - suffix]
    added = new_lines[prefix : len(new_lines) - suffix]
    if not removed and not added:
        return None
    context_before = old_lines[:prefix]
    context_after = old_lines[len(old_lines) - suffix :] if suffix else []
    hunk_lines: list[dict[str, Any]] = []
    for index, line in enumerate(removed):
        hunk_lines.append(_line_record("removed", display_path, line, old_line=prefix + index + 1))
    for index, line in enumerate(added):
        hunk_lines.append(_line_record("added", display_path, line, new_line=prefix + index + 1))
    change = {
        "file_path": display_path,
        "lines_added": len(added),
        "lines_deleted": len(removed),
        "hunks": [
            {
                "old_start": prefix + 1,
                "old_lines": len(removed),
                "new_start": prefix + 1,
                "new_lines": len(added),
                "context_before": context_before[-20:],
                "context_after": context_after[:20],
                "context_before_line_count": len(context_before),
                "context_after_line_count": len(context_after),
                "lines": hunk_lines,
            }
        ],
        "source": source,
        "tool_name": raw.get("tool_name") or raw.get("name"),
        "line_number_basis": "relative",
    }
    change["diff_hash"] = _hash_text(json.dumps(change, ensure_ascii=False, sort_keys=True))
    return change


def _code_changes_from_apply_patch(patch_text: Any, payload: dict[str, Any], source: str, tool_name: str | None = None) -> list[dict[str, Any]]:
    if not isinstance(patch_text, str) or "*** Begin Patch" not in patch_text:
        return []
    changes: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    old_line = 1
    new_line = 1

    def finish() -> None:
        nonlocal current
        if current and any(hunk.get("lines") for hunk in current.get("hunks", [])):
            current["hunks"] = [hunk for hunk in current.get("hunks", []) if hunk.get("lines")]
            current["diff_hash"] = _hash_text(json.dumps(current, ensure_ascii=False, sort_keys=True))
            changes.append(current)
        current = None

    for raw_line in patch_text.splitlines():
        file_match = PATCH_FILE_RE.match(raw_line)
        if file_match:
            finish()
            operation, file_path = file_match.groups()
            display_path = _display_path(file_path.strip(), payload)
            current = {
                "file_path": display_path,
                "change_kind": operation.lower(),
                "lines_added": 0,
                "lines_deleted": 0,
                "source": source,
                "tool_name": tool_name or "apply_patch",
                "line_number_basis": "absolute" if operation.lower() == "add" else "relative",
                "hunks": [],
            }
            old_line = 1
            new_line = 1
            continue
        if current is None:
            continue
        if raw_line.startswith("@@"):
            hunk_match = PATCH_HUNK_RE.match(raw_line)
            if hunk_match and hunk_match.group(1):
                old_line = int(hunk_match.group(1))
                new_line = int(hunk_match.group(2) or 1)
                current["line_number_basis"] = "absolute"
            elif current.get("line_number_basis") != "absolute":
                current["line_number_basis"] = "relative"
            current["hunks"].append(
                {
                    "old_start": old_line,
                    "old_lines": 0,
                    "new_start": new_line,
                    "new_lines": 0,
                    "lines": [],
                }
            )
            continue
        if not current.get("hunks"):
            current["hunks"].append({"old_start": old_line, "old_lines": 0, "new_start": new_line, "new_lines": 0, "lines": []})
        hunk = current["hunks"][-1]
        if raw_line.startswith("+") and not raw_line.startswith("+++"):
            text = raw_line[1:]
            hunk["lines"].append(_line_record("added", current["file_path"], text, new_line=new_line))
            hunk["new_lines"] += 1
            current["lines_added"] += 1
            new_line += 1
        elif raw_line.startswith("-") and not raw_line.startswith("---"):
            text = raw_line[1:]
            hunk["lines"].append(_line_record("removed", current["file_path"], text, old_line=old_line))
            hunk["old_lines"] += 1
            current["lines_deleted"] += 1
            old_line += 1
        elif raw_line.startswith(" "):
            old_line += 1
            new_line += 1
    finish()
    return changes


def _tool_call_code_changes(payload: dict[str, Any], event_tool: str = "copilot") -> list[dict[str, Any]]:
    if str(event_tool or "").lower() == "copilot":
        return []
    raw_tools = payload.get("tool_calls")
    if not isinstance(raw_tools, list):
        return []
    changes: list[dict[str, Any]] = []
    for index, tool in enumerate(raw_tools):
        if not isinstance(tool, dict):
            continue
        status = str(tool.get("status") or "").lower()
        if status and status not in {"complete", "completed", "success", "succeeded", "requested"}:
            continue
        tool_name = str(tool.get("tool_name") or tool.get("name") or "").strip()
        if tool_name not in {"apply_patch", "replace_string_in_file", "create_file", "edit_file"}:
            continue
        args = _json_record(tool.get("arguments_raw") or tool.get("arguments") or tool.get("input") or tool.get("args"))
        source = "turn_snapshot_tool_call"
        if tool_name == "apply_patch":
            derived = _code_changes_from_apply_patch(args.get("input") or args.get("patch") or args.get("diff"), payload, source, tool_name)
        else:
            derived_change = _code_change_from_replacement(args, payload, source)
            derived = [derived_change] if derived_change else []
        for change in derived:
            change["tool_call_id"] = tool.get("tool_call_id") or tool.get("toolCallId")
            change["tool_name"] = tool_name
            change["status"] = status or None
            change["request_id"] = tool.get("request_id") or payload.get("request_id") or (payload.get("turn") or {}).get("request_id")
            change["response_id"] = tool.get("response_id") or payload.get("response_id") or (payload.get("turn") or {}).get("response_id")
            turn = payload.get("turn") if isinstance(payload.get("turn"), dict) else {}
            change["turn_index"] = turn.get("turn_index") or payload.get("turn_index")
            change["occurred_at"] = tool.get("completed_at") or tool.get("started_at")
            change["raw_path"] = f"$.tool_calls[{index}]"
            change["raw_json"] = tool
            tool_source = str(payload.get("tool") or payload.get("source_tool") or event_tool or "copilot").lower()
            if tool_source not in {"copilot", "claude", "codex"}:
                tool_source = "copilot"
            change["snapshot_kind"] = f"{tool_source}_turn_tool_patch"
            changes.append(change)
    return changes


def _session_id(event: EventIn, payload: dict[str, Any]) -> str:
    value = event.session_id or payload.get("session_id") or payload.get("sessionId") or event.task_id
    return str(value)[:128]


def _normalize_messages(event: EventIn, payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_messages = payload.get("messages")
    if not isinstance(raw_messages, list):
        return []
    is_claude_turn_snapshot = event.tool == "claude" and event.event_type == "turn_snapshot"
    messages: list[dict[str, Any]] = []
    positions_by_source: dict[str, int] = {}
    current_turn_index = 0
    for index, raw in enumerate(raw_messages):
        if not isinstance(raw, dict):
            continue
        content = _content_from_message(raw)
        blob_info = _text_blob_info(raw)
        text_len = int(raw.get("text_len") or 0) if blob_info else (len(content) if content else int(raw.get("text_len") or 0))
        if not content.strip() and text_len == 0:
            continue
        role = _normalize_role(raw.get("role"))
        if is_claude_turn_snapshot and role == "user":
            content = _strip_claude_context_blocks(content)
            if not content.strip():
                continue
            if _looks_like_claude_agent_prompt(content, payload):
                continue
            if not blob_info:
                text_len = len(content)
        explicit_turn_index = _safe_int(raw.get("turn_index") if raw.get("turn_index") is not None else raw.get("turn"))
        if explicit_turn_index and explicit_turn_index > 0:
            current_turn_index = explicit_turn_index
        elif role == "user":
            current_turn_index = 1 if current_turn_index <= 0 else current_turn_index + 1
        elif current_turn_index <= 0:
            current_turn_index = 1
        text_hash = str(raw.get("text_hash") or raw.get("content_hash") or _hash_text(content))
        content_hash = text_hash if blob_info else (_hash_text(content) if is_claude_turn_snapshot and role == "user" else text_hash)
        occurred_at = raw.get("occurred_at") if isinstance(raw.get("occurred_at"), str) else _iso(event.occurred_at)
        source_key = raw.get("source_key") or raw.get("message_id")
        normalized = {
            "message_index": len(messages),
            "source_index": index,
            "source_key": str(source_key)[:256] if source_key else None,
            "turn_index": current_turn_index,
            "request_id": str(raw.get("request_id") or raw.get("requestId") or "")[:256] or None,
            "response_id": str(raw.get("response_id") or raw.get("responseId") or "")[:256] or None,
            "role": role,
            "content": content,
            "content_hash": content_hash,
            "text_len": text_len,
            "occurred_at": occurred_at,
            "raw_path": f"$.messages[{index}]",
            "raw_json": raw,
            **blob_info,
        }
        if source_key:
            identity = f"{normalized['role']}:{source_key}"
            existing_position = positions_by_source.get(identity)
            if existing_position is not None:
                normalized["message_index"] = existing_position
                normalized["turn_index"] = messages[existing_position].get("turn_index") or normalized["turn_index"]
                messages[existing_position] = normalized
                continue
            positions_by_source[identity] = len(messages)
        messages.append(normalized)
    for message_index, message in enumerate(messages):
        message["message_index"] = message_index
    return messages


def _normalize_process_steps(event: EventIn, payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_steps = payload.get("process_steps")
    steps: list[dict[str, Any]] = []
    raw_tools = payload.get("tool_calls")
    tools_by_call_id: dict[str, dict[str, Any]] = {}
    if isinstance(raw_tools, list):
        for tool in raw_tools:
            if not isinstance(tool, dict):
                continue
            tool_call_id = str(tool.get("tool_call_id") or tool.get("toolCallId") or "").strip()
            if tool_call_id:
                tools_by_call_id[tool_call_id] = tool
    if isinstance(raw_steps, list):
        for index, raw in enumerate(raw_steps):
            if not isinstance(raw, dict):
                continue
            tool_call_id = str(raw.get("tool_call_id") or "")[:256] or None
            tool_name = str(raw.get("tool_name"))[:128] if raw.get("tool_name") else None
            tool = tools_by_call_id.get(tool_call_id or "")
            tool_args = _tool_call_arguments(tool) if tool else {}
            tool_status = str(raw.get("status") or (tool or {}).get("status") or "")[:64]
            content = _content_from_step(raw)
            if tool_name and tool_args:
                readable_tool_content = _human_tool_content(tool_name, tool_status, tool_args, payload)
                if readable_tool_content:
                    content = readable_tool_content
            step_type = _normalize_step_type(raw.get("kind") or raw.get("activity_kind") or raw.get("step_type"))
            content_hash = str(raw.get("text_hash") or _hash_text(content))
            step_id = str(
                raw.get("step_id")
                or _hash_text(f"{step_type}:{content_hash}:{tool_name or ''}:{tool_status or ''}")
            )
            steps.append(
                {
                    "step_index": index,
                    "step_id": step_id,
                    "request_id": str(raw.get("request_id") or payload.get("request_id") or "")[:256] or None,
                    "response_id": str(raw.get("response_id") or payload.get("response_id") or "")[:256] or None,
                    "step_type": step_type,
                    "title": str(raw.get("label") or raw.get("title") or raw.get("tool_name") or "")[:256] or None,
                    "content": content,
                    "content_hash": content_hash,
                    "tool_call_id": tool_call_id,
                    "tool_name": tool_name,
                    "actor_path": str(raw.get("actor_path") or "")[:512] or None,
                    "actor_type": str(raw.get("actor_type") or "")[:64] or None,
                    "parent_tool_call_id": str(raw.get("parent_tool_call_id") or "")[:256] or None,
                    "status": tool_status or None,
                    "occurred_at": raw.get("occurred_at") if isinstance(raw.get("occurred_at"), str) else _iso(event.occurred_at),
                    "raw_path": f"$.process_steps[{index}]",
                    "raw_json": raw,
                }
            )

    if event.event_type in {"agent_activity", "file_read"}:
        content = _content_from_step(payload)
        step_type = "file_read" if event.event_type == "file_read" else _normalize_step_type(payload.get("activity_kind"))
        content_hash = str(payload.get("text_hash") or _hash_text(content))
        steps.append(
            {
                "step_index": int(payload.get("step_index") or len(steps)),
                "step_id": str(
                    payload.get("step_id")
                    or _hash_text(
                        f"{step_type}:{content_hash}:{payload.get('tool_name') or ''}:{payload.get('status') or ''}"
                    )
                ),
                "step_type": step_type,
                "title": str(payload.get("label") or payload.get("tool_name") or event.event_type)[:256],
                "content": content,
                "content_hash": content_hash,
                "tool_name": str(payload.get("tool_name"))[:128] if payload.get("tool_name") else None,
                "status": str(payload.get("status"))[:64] if payload.get("status") else None,
                "occurred_at": _iso(event.occurred_at),
                "raw_path": "$.payload",
                "raw_json": payload,
            }
        )
    return steps


def _is_failed_or_empty_commit_snapshot(payload: dict[str, Any]) -> bool:
    if payload.get("ai_attribution_evidence") == "snapshot_failed":
        return True
    if payload.get("commit_sha") or payload.get("commitSha") or payload.get("sha"):
        return False
    files = payload.get("files")
    changes = payload.get("changes")
    if isinstance(files, list) and files:
        return False
    if isinstance(changes, list) and changes:
        return False
    if payload.get("file_path") or payload.get("path"):
        return False
    return True


def _normalize_code_changes(event: EventIn, payload: dict[str, Any]) -> list[dict[str, Any]]:
    snapshot_kind = str(payload.get("snapshot_kind") or "").lower()
    if snapshot_kind in GLOBAL_WORKSPACE_DIFF_SNAPSHOT_KINDS:
        return []
    if event.event_type == "commit_snapshot" and _is_failed_or_empty_commit_snapshot(payload):
        return []

    raw_embedded = payload.get("code_changes")
    if isinstance(raw_embedded, list):
        files = [item for item in raw_embedded if isinstance(item, dict)]
    elif event.event_type == "turn_snapshot":
        files = _tool_call_code_changes(payload, event.tool)
    elif event.event_type in {"code_change", "ai_line_snapshot", "adoption_snapshot", "commit_snapshot", "push_snapshot"}:
        raw_files = payload.get("files")
        raw_changes = payload.get("changes")
        files = raw_files if isinstance(raw_files, list) else []
        if not files and isinstance(raw_changes, list):
            files = [item for item in raw_changes if isinstance(item, dict)]
        if not files and payload.get("file_path"):
            files = [payload]
        if not files and any(payload.get(key) is not None for key in ("lines_added", "lines_deleted", "retained_lines", "ai_lines_added")):
            files = [payload]
    else:
        return []

    changes: list[dict[str, Any]] = []
    failed_tool_call_ids = _failed_tool_call_ids(payload)
    def first_int_present(*values: Any) -> int:
        for value in values:
            if value is None or isinstance(value, bool):
                continue
            try:
                return int(value)
            except (TypeError, ValueError):
                continue
        return 0

    for index, raw in enumerate(files):
        if not isinstance(raw, dict):
            continue
        tool_call_id = str(raw.get("tool_call_id") or "")
        if tool_call_id and tool_call_id in failed_tool_call_ids:
            continue
        lines_added = first_int_present(raw.get("lines_added"), raw.get("added_line_count"), payload.get("lines_added"), payload.get("ai_lines_added"))
        lines_deleted = first_int_present(raw.get("lines_deleted"), raw.get("removed_line_count"), payload.get("lines_deleted"), payload.get("ai_lines_deleted"))
        raw_path = "$.payload"
        if isinstance(raw_embedded, list):
            raw_path = f"$.code_changes[{index}]"
        elif raw.get("raw_path"):
            raw_path = str(raw.get("raw_path"))
        elif isinstance(payload.get("files"), list):
            raw_path = f"$.files[{index}]"
        elif isinstance(payload.get("changes"), list):
            raw_path = f"$.changes[{index}]"
        turn = payload.get("turn") if isinstance(payload.get("turn"), dict) else {}
        line_stats = _code_line_stats(raw, payload, lines_added, lines_deleted)
        line_number_basis = _line_number_basis(raw, payload)
        file_path = _normalize_code_change_path(raw.get("file_path") or raw.get("path"), payload)
        normalized_change = {
            "change_index": index,
            "file_path": file_path,
            "change_type": str(event.event_type if event.event_type in {"commit_snapshot", "push_snapshot"} else raw.get("snapshot_kind") or payload.get("snapshot_kind") or event.event_type or payload.get("trigger") or "code_change")[:64],
            "event_type": event.event_type,
            "snapshot_kind": str(raw.get("snapshot_kind") or payload.get("snapshot_kind") or "")[:64] or None,
            "commit_sha": str(raw.get("commit_sha") or payload.get("commit_sha") or "")[:128] or None,
            "branch": str(raw.get("branch") or payload.get("branch") or "")[:256] or None,
            "request_id": str(raw.get("request_id") or payload.get("request_id") or "")[:256] or None,
            "response_id": str(raw.get("response_id") or payload.get("response_id") or "")[:256] or None,
            "turn_index": raw.get("turn_index") if isinstance(raw.get("turn_index"), int) else payload.get("turn_index") or turn.get("turn_index"),
            "diff_hash": str(raw.get("diff_hash") or payload.get("diff_hash") or "")[:128] or None,
            "lines_added": lines_added,
            "lines_deleted": lines_deleted,
            "retained_lines": raw.get("retained_lines") if isinstance(raw.get("retained_lines"), int) else payload.get("retained_lines"),
            "adoption_rate": raw.get("adoption_rate") if isinstance(raw.get("adoption_rate"), (int, float)) else payload.get("adoption_rate"),
            "ai_lines_added": raw.get("ai_lines_added") if isinstance(raw.get("ai_lines_added"), int) else payload.get("ai_lines_added"),
            "ai_lines_deleted": raw.get("ai_lines_deleted") if isinstance(raw.get("ai_lines_deleted"), int) else payload.get("ai_lines_deleted"),
            "files_changed": raw.get("files_changed") if isinstance(raw.get("files_changed"), int) else payload.get("files_changed"),
            "line_stats": line_stats,
            "hunk_count": line_stats["hunk_count"],
            "captured_line_count": line_stats["captured_line_count"],
            "captured_added_line_count": line_stats["captured_added_line_count"],
            "captured_deleted_line_count": line_stats["captured_deleted_line_count"],
            "captured_context_line_count": line_stats["captured_context_line_count"],
            "has_line_level_diff": line_stats["has_line_level_diff"],
            "has_line_text": line_stats["has_line_text"],
            "line_level_complete": line_stats["line_level_complete"],
            "diff_truncated": line_stats["diff_truncated"],
            "occurred_at": raw.get("occurred_at") if isinstance(raw.get("occurred_at"), str) else _iso(event.occurred_at),
            "raw_path": raw_path,
            "raw_json": raw,
        }
        if line_number_basis:
            normalized_change["line_number_basis"] = line_number_basis
            normalized_change["line_numbers_are_absolute"] = line_number_basis == "absolute"
            if isinstance(normalized_change.get("line_stats"), dict):
                normalized_change["line_stats"]["line_number_basis"] = line_number_basis
        diff_raw_ref = payload.get("diff_raw")
        if isinstance(diff_raw_ref, dict) and diff_raw_ref.get("blob_ref"):
            normalized_change["diff_blob_ref"] = diff_raw_ref
        elif isinstance(raw.get("diff_raw"), dict) and raw.get("diff_raw", {}).get("blob_ref"):
            normalized_change["diff_blob_ref"] = raw.get("diff_raw")
        for raw_diff_key in (
            "hunks",
            "changes",
            "patch",
            "diff",
            "old_path",
            "new_path",
            "language",
            "status",
            "change_kind",
            "tool_call_id",
            "tool_name",
            "source",
            "line_number_basis",
            "line_numbers_are_absolute",
        ):
            if raw_diff_key in raw:
                normalized_change[raw_diff_key] = raw.get(raw_diff_key)
        changes.append(normalized_change)
    return changes


def _failed_tool_call_ids(payload: dict[str, Any]) -> set[str]:
    failed: set[str] = set()
    tool_calls = payload.get("tool_calls")
    if isinstance(tool_calls, list):
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            tool_call_id = str(call.get("tool_call_id") or call.get("id") or "")
            if not tool_call_id:
                continue
            status = str(call.get("status") or "").lower()
            result_text = _compact_json_text(call.get("result_raw")).lower()
            if _is_failed_tool_status(status) or _is_rejected_or_interrupted_tool_text(result_text):
                failed.add(tool_call_id)
            elif not _is_success_tool_status(status) and _is_failed_or_rejected_tool_text(result_text):
                failed.add(tool_call_id)

    process_steps = payload.get("process_steps")
    if isinstance(process_steps, list):
        for step in process_steps:
            if not isinstance(step, dict):
                continue
            if str(step.get("step_type") or "").lower() != "tool_result":
                continue
            tool_call_id = str(step.get("tool_call_id") or "")
            if not tool_call_id:
                continue
            status = str(step.get("status") or "").lower()
            text = str(step.get("text") or "").lower()
            if _is_failed_tool_status(status) or _is_rejected_or_interrupted_tool_text(text):
                failed.add(tool_call_id)
            elif not _is_success_tool_status(status) and _is_failed_or_rejected_tool_text(text):
                failed.add(tool_call_id)
    return failed


def _is_success_tool_status(status: str) -> bool:
    normalized = status.strip().lower().replace("_", " ").replace("-", " ")
    return normalized in {"complete", "completed", "success", "succeeded", "ok", "done"}


def _is_failed_tool_status(status: str) -> bool:
    normalized = status.strip().lower().replace("_", " ").replace("-", " ")
    return normalized in {
        "failed",
        "failure",
        "error",
        "errored",
        "rejected",
        "denied",
        "cancelled",
        "canceled",
        "interrupted",
        "timeout",
        "timed out",
    }


def _compact_json_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return str(value)


def _is_rejected_or_interrupted_tool_text(text: str) -> bool:
    lowered = text.lower()
    return any(
        marker in lowered
        for marker in (
            "user rejected tool use",
            "tool use was rejected",
            "tool interrupted",
            "request interrupted",
        )
    )


def _is_failed_or_rejected_tool_text(text: str) -> bool:
    lowered = text.lower()
    if _is_rejected_or_interrupted_tool_text(lowered):
        return True
    return any(
        marker in lowered
        for marker in (
            "failed",
            "error",
            "cancelled",
            "canceled",
            "denied",
        )
    )


def _normalize_spec_accesses(event: EventIn, payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_embedded = payload.get("spec_accesses")
    if isinstance(raw_embedded, list):
        sources = [item for item in raw_embedded if isinstance(item, dict)]
    elif event.event_type in {"spec_read", "catalog_hit", "fallback_search", "official_misread"}:
        sources = [payload]
    else:
        return []

    accesses: list[dict[str, Any]] = []
    for index, raw in enumerate(sources):
        accesses.append(
            {
                "spec_scope": str(raw.get("spec_scope") or "unknown")[:32],
                "doc_path": raw.get("doc_path"),
                "access_type": raw.get("access_type"),
                "access_source": raw.get("access_source") or raw.get("source"),
                "matched_doc_count": raw.get("matched_doc_count"),
                "matched_docs": raw.get("matched_docs"),
                "source_key": raw.get("source_key"),
                "via_catalog": bool(raw.get("via_catalog")),
                "matched_by": raw.get("matched_by") if isinstance(raw.get("matched_by"), list) else None,
                "confidence": raw.get("confidence") or event.source_confidence,
                "occurred_at": raw.get("occurred_at") if isinstance(raw.get("occurred_at"), str) else _iso(event.occurred_at),
                "raw_path": f"$.spec_accesses[{index}]" if isinstance(raw_embedded, list) else "$.payload",
                "raw_json": raw,
            }
        )
    return accesses


def _derived_spec_access(
    *,
    doc_path: str,
    access_type: str,
    source: str,
    occurred_at: Any,
    raw_path: str,
    tool_name: str | None = None,
    matched_docs: list[str] | None = None,
    source_key: str | None = None,
) -> dict[str, Any]:
    docs = matched_docs or ([doc_path] if doc_path and doc_path != PROJECT_SPEC_RELATIVE_ROOT else [])
    matched_by = ["derived", source, f"access:{access_type}"]
    if tool_name:
        matched_by.append(f"tool:{tool_name}")
    return {
        "spec_scope": "project",
        "doc_path": doc_path,
        "access_type": access_type,
        "access_source": source,
        "matched_doc_count": len(docs),
        "matched_docs": docs,
        "source_key": source_key or raw_path,
        "via_catalog": False,
        "matched_by": matched_by,
        "confidence": "derived",
        "occurred_at": occurred_at,
        "raw_path": raw_path,
        "raw_json": {
            "source": source,
            "access_type": access_type,
            "tool_name": tool_name,
            "doc_path": doc_path,
            "matched_doc_count": len(docs),
            "matched_docs": docs,
        },
    }


def _spec_access_type(access: dict[str, Any]) -> str:
    if access.get("access_type"):
        return str(access.get("access_type"))
    matched_by = access.get("matched_by")
    if isinstance(matched_by, list):
        for item in matched_by:
            text = str(item)
            if text.startswith("access:"):
                return text.split(":", 1)[1]
    return "unknown"


def _dedupe_spec_accesses(accesses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    positions: dict[tuple[str, str], int] = {}
    for access in accesses:
        doc_path = str(access.get("doc_path") or "")
        access_type = _spec_access_type(access)
        key = (doc_path, access_type)
        existing_index = positions.get(key) if doc_path and access_type else None
        if existing_index is not None:
            existing = deduped[existing_index]
            merged_docs: list[str] = []
            for item in (
                existing.get("matched_docs") if isinstance(existing.get("matched_docs"), list) else [],
                access.get("matched_docs") if isinstance(access.get("matched_docs"), list) else [],
            ):
                for doc in item:
                    text = str(doc or "").strip()
                    if text and text not in merged_docs:
                        merged_docs.append(text)
            merged_by: list[str] = []
            for item in (
                existing.get("matched_by") if isinstance(existing.get("matched_by"), list) else [],
                access.get("matched_by") if isinstance(access.get("matched_by"), list) else [],
            ):
                for source in item:
                    text = str(source or "").strip()
                    if text and text not in merged_by:
                        merged_by.append(text)
            if merged_docs:
                existing["matched_docs"] = merged_docs
                existing["matched_doc_count"] = len(merged_docs)
            if merged_by:
                existing["matched_by"] = merged_by
            continue
        if doc_path and access_type:
            positions[key] = len(deduped)
        deduped.append(access)
    return deduped


def _derive_spec_accesses_from_tools(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_tools = payload.get("tool_calls")
    if not isinstance(raw_tools, list):
        return []
    accesses: list[dict[str, Any]] = []
    for index, tool in enumerate(raw_tools):
        if not isinstance(tool, dict):
            continue
        tool_name = str(tool.get("tool_name") or tool.get("name") or "").strip()
        args = _tool_call_arguments(tool)
        occurred_at = tool.get("completed_at") or tool.get("started_at") or payload.get("completed_at") or payload.get("started_at")
        if tool_name in SPEC_READ_TOOLS | SPEC_EDIT_TOOLS:
            file_path = _tool_file_path(args, payload)
            doc_path = _spec_doc_path(file_path)
            if not doc_path:
                continue
            access_type = "read" if tool_name in SPEC_READ_TOOLS else "edit"
            tool_call_id = str(tool.get("tool_call_id") or tool.get("toolCallId") or "") or None
            accesses.append(
                _derived_spec_access(
                    doc_path=doc_path,
                    access_type=access_type,
                    source="tool_call",
                    occurred_at=occurred_at if isinstance(occurred_at, str) else None,
                    raw_path=f"$.tool_calls[{index}]",
                    tool_name=tool_name,
                    source_key=tool_call_id,
                )
            )
        elif tool_name == "run_in_terminal":
            command = args.get("command")
            if not isinstance(command, str) or PROJECT_SPEC_RELATIVE_ROOT not in command:
                continue
            is_edit = bool(
                re.search(
                    r"\b(write_text|writeFileSync|writeFile|appendFile|open\s*\([^)]*['\"]w|tee\s+)|>\s*(?:['\"])?[^\n]*openspec/specs/",
                    command,
                    re.IGNORECASE,
                )
            )
            docs = []
            for match in SPEC_COMMAND_FILE_RE.finditer(command):
                doc_path = _spec_doc_path(match.group(0))
                if doc_path and doc_path not in docs:
                    docs.append(doc_path)
            if docs:
                accesses.append(
                    _derived_spec_access(
                        doc_path=docs[0] if len(docs) == 1 else PROJECT_SPEC_RELATIVE_ROOT,
                        access_type="edit" if is_edit else "read",
                        source="terminal_command",
                        occurred_at=occurred_at if isinstance(occurred_at, str) else None,
                        raw_path=f"$.tool_calls[{index}].arguments_raw.command",
                        tool_name=tool_name,
                        matched_docs=docs,
                        source_key=str(tool.get("tool_call_id") or tool.get("toolCallId") or "") or None,
                    )
                )
    return accesses


def _derive_spec_accesses_from_code_changes(code_changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    accesses: list[dict[str, Any]] = []
    for index, change in enumerate(code_changes):
        if not isinstance(change, dict):
            continue
        snapshot_kind = str(change.get("snapshot_kind") or change.get("change_type") or "").lower()
        if snapshot_kind not in SPEC_EDIT_SNAPSHOT_KINDS:
            continue
        doc_path = _spec_doc_path(change.get("file_path"))
        if not doc_path:
            continue
        accesses.append(
            _derived_spec_access(
                doc_path=doc_path,
                access_type="edit",
                source="code_change",
                occurred_at=change.get("occurred_at"),
                raw_path=str(change.get("raw_path") or f"$.code_changes[{index}]"),
                tool_name=str(change.get("tool_name") or "") or None,
            )
        )
    return accesses


def _normalize_all_spec_accesses(event: EventIn, payload: dict[str, Any], code_changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    explicit = _normalize_spec_accesses(event, payload)
    derived = _derive_spec_accesses_from_tools(payload) + _derive_spec_accesses_from_code_changes(code_changes)
    return _dedupe_spec_accesses(explicit + derived)


def _normalize_spec_documents(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_documents = payload.get("spec_documents")
    if not isinstance(raw_documents, list):
        raw_catalog = payload.get("spec_catalog")
        raw_documents = raw_catalog.get("documents") if isinstance(raw_catalog, dict) else None
    if not isinstance(raw_documents, list):
        return []

    documents: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_documents):
        if not isinstance(raw, dict):
            continue
        doc_path = _spec_doc_path(raw.get("doc_path") or raw.get("path") or raw.get("file_path"))
        if not doc_path or doc_path in seen:
            continue
        seen.add(doc_path)
        documents.append(
            {
                "spec_scope": str(raw.get("spec_scope") or "project")[:32],
                "doc_path": doc_path,
                "file_name": str(raw.get("file_name") or doc_path.rsplit("/", 1)[-1])[:256],
                "size_bytes": _safe_int(raw.get("size_bytes") or raw.get("size")) or 0,
                "line_count": _safe_int(raw.get("line_count")) or 0,
                "content_hash": str(raw.get("content_hash") or raw.get("sha256") or "")[:64] or None,
                "mtime_ms": raw.get("mtime_ms"),
                "exists": bool(raw.get("exists", True)),
                "metadata_json": raw,
                "raw_path": f"$.spec_documents[{index}]",
            }
        )
    return documents


def _optional_number(value: Any) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    return None


def _normalize_request_usage(event: EventIn, payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_usage = payload.get("request_usage")
    if not isinstance(raw_usage, list):
        return []
    normalized: list[dict[str, Any]] = []
    for source_index, raw in enumerate(raw_usage):
        if not isinstance(raw, dict):
            continue
        request_index = raw.get("request_index")
        if not isinstance(request_index, int) or isinstance(request_index, bool):
            request_index = source_index
        request_id = raw.get("request_id")
        if not isinstance(request_id, str) or not request_id.strip():
            request_id = f"{_session_id(event, payload)}:request:{request_index}"
        turn_index = _safe_int(raw.get("turn_index") if raw.get("turn_index") is not None else raw.get("turn"))
        if not turn_index or turn_index <= 0:
            turn_index = request_index + 1
        normalized.append(
            {
                "request_id": request_id[:256],
                "response_id": str(raw.get("response_id") or payload.get("response_id") or "")[:256] or None,
                "request_index": request_index,
                "turn_index": turn_index,
                "model": str(raw.get("model"))[:128] if raw.get("model") else None,
                "prompt_tokens": _optional_number(raw.get("prompt_tokens")),
                "output_tokens": _optional_number(raw.get("output_tokens")),
                "completion_tokens": _optional_number(raw.get("completion_tokens")),
                "elapsed_ms": _optional_number(raw.get("elapsed_ms")),
                "copilot_credits": _optional_number(raw.get("copilot_credits")),
                "credits_source": str(raw.get("credits_source"))[:24] if raw.get("credits_source") else None,
                "occurred_at": raw.get("occurred_at") if isinstance(raw.get("occurred_at"), str) else None,
                "raw_path": f"$.request_usage[{source_index}]",
            }
        )
    return normalized


def _normalize_usage_totals(payload: dict[str, Any]) -> dict[str, int | float]:
    raw = payload.get("usage_totals")
    if not isinstance(raw, dict):
        return {}
    return {
        key: value
        for key in ("prompt_tokens", "output_tokens", "completion_tokens", "elapsed_ms", "copilot_credits")
        if (value := _optional_number(raw.get(key))) is not None
    }


def _normalize_turn_snapshot(event: EventIn, payload: dict[str, Any]) -> dict[str, Any]:
    session_id = _session_id(event, payload)
    turn = payload.get("turn") if isinstance(payload.get("turn"), dict) else {}
    request_id = str(payload.get("request_id") or turn.get("request_id") or "")[:256]
    response_id = str(payload.get("response_id") or turn.get("response_id") or "")[:256]
    turn_index = int(turn.get("turn_index") or payload.get("turn_index") or 1)
    completed_at = turn.get("completed_at") or payload.get("completed_at") or _iso(event.occurred_at)
    started_at = turn.get("started_at") or payload.get("started_at") or _iso(event.occurred_at)
    turn_status = str(turn.get("status") or payload.get("status") or "completed").lower()
    if turn_status not in {"active", "idle", "completed", "failed", "incomplete"}:
        turn_status = "completed"
    if event.tool == "claude" and _is_claude_subagent_snapshot(payload):
        return {
            "schema_version": NORMALIZED_SCHEMA_VERSION,
            "tool": event.tool,
            "adapter": f"{event.tool}_turn_snapshot_v1",
            "event_type": event.event_type,
            "source_confidence": event.source_confidence,
            "session": {
                "session_id": session_id,
                "external_session_id": payload.get("session_id") or event.session_id,
                "task_id": event.task_id,
                "user_id": event.user_id,
                "started_at": started_at,
                "last_activity_at": completed_at,
                "status": "completed" if turn_status == "completed" else turn_status,
                "title": None,
                "model": payload.get("resolved_model") or payload.get("model") or event.model,
            },
            "turns": [],
            "messages": [],
            "process_steps": [],
            "code_changes": [],
            "spec_accesses": [],
            "spec_documents": _normalize_spec_documents(payload),
            "request_usage": [],
            "usage_totals": {},
            "warnings": ["claude subagent snapshot skipped from top-level product timeline"],
        }
    messages = _normalize_messages(event, payload)
    usage = _normalize_request_usage(event, payload)
    usage_by_turn = {
        int(item["turn_index"]): item
        for item in usage
        if isinstance(item.get("turn_index"), int) and int(item["turn_index"]) > 0
    }
    message_turn_indexes = {
        int(message["turn_index"])
        for message in messages
        if isinstance(message.get("turn_index"), int) and int(message["turn_index"]) > 0
    }
    is_multi_turn_snapshot = len(message_turn_indexes) > 1

    def request_ids_for_turn(index: int) -> tuple[str | None, str | None]:
        usage_item = usage_by_turn.get(index)
        if usage_item:
            return str(usage_item.get("request_id") or "")[:256] or None, str(usage_item.get("response_id") or "")[:256] or None
        if not is_multi_turn_snapshot or index == turn_index:
            return request_id or None, response_id or None
        return None, None

    for message in messages:
        message_turn_index = _safe_int(message.get("turn_index")) or turn_index
        message["turn_index"] = message_turn_index
        default_request_id, default_response_id = request_ids_for_turn(message_turn_index)
        message["request_id"] = message.get("request_id") or default_request_id
        message["response_id"] = message.get("response_id") or default_response_id
    process_steps = _normalize_process_steps(event, payload)
    for step in process_steps:
        step_turn_index = _safe_int(step.get("turn_index")) or turn_index
        step["turn_index"] = step_turn_index
        default_request_id, default_response_id = request_ids_for_turn(step_turn_index)
        step["request_id"] = step.get("request_id") or default_request_id
        step["response_id"] = step.get("response_id") or default_response_id
    code_changes = _normalize_code_changes(event, payload)
    for item in usage:
        usage_turn_index = _safe_int(item.get("turn_index")) or turn_index
        item["turn_index"] = usage_turn_index
        if not is_multi_turn_snapshot or usage_turn_index == turn_index:
            item["request_id"] = item.get("request_id") or request_id or None
            item["response_id"] = item.get("response_id") or response_id or None
    turn_indexes = {turn_index}
    turn_indexes.update(message_turn_indexes)
    turn_indexes.update(int(item["turn_index"]) for item in usage if isinstance(item.get("turn_index"), int) and int(item["turn_index"]) > 0)
    turn_indexes.update(
        int(step["turn_index"])
        for step in process_steps
        if isinstance(step.get("turn_index"), int) and int(step["turn_index"]) > 0
    )
    warnings: list[str] = []
    if not messages:
        warnings.append("turn_snapshot contains no normalized top-level messages")
    if not request_id:
        warnings.append("turn_snapshot missing request_id")
    if not response_id:
        warnings.append("turn_snapshot missing response_id")
    session_title = payload.get("title")
    if event.tool == "claude":
        first_user_message = next((message.get("content") for message in messages if message.get("role") == "user" and message.get("content")), None)
        if isinstance(first_user_message, str) and first_user_message.strip():
            session_title = first_user_message.strip()
        elif isinstance(session_title, str):
            cleaned_title = _strip_claude_context_blocks(session_title)
            session_title = None if _looks_like_claude_agent_prompt(cleaned_title, payload) else cleaned_title or None
    return {
        "schema_version": NORMALIZED_SCHEMA_VERSION,
        "tool": event.tool,
        "adapter": f"{event.tool}_turn_snapshot_v1",
        "event_type": event.event_type,
        "source_confidence": event.source_confidence,
        "session": {
            "session_id": session_id,
            "external_session_id": payload.get("session_id") or event.session_id,
            "task_id": event.task_id,
            "user_id": event.user_id,
            "started_at": started_at,
            "last_activity_at": completed_at,
            "status": "completed" if turn_status == "completed" else turn_status,
            "title": session_title,
            "model": payload.get("resolved_model") or payload.get("model") or event.model,
        },
        "turns": [
            {
                "turn_index": index,
                "request_id": request_ids_for_turn(index)[0],
                "response_id": request_ids_for_turn(index)[1],
                "attempt": payload.get("attempt") or turn.get("attempt"),
                "status": turn_status,
                "started_at": started_at,
                "completed_at": completed_at,
            }
            for index in sorted(turn_indexes)
            if index > 0
        ],
        "messages": messages,
        "process_steps": process_steps,
        "code_changes": code_changes,
        "spec_accesses": _normalize_all_spec_accesses(event, payload, code_changes),
        "spec_documents": _normalize_spec_documents(payload),
        "request_usage": usage,
        "usage_totals": _normalize_usage_totals(payload),
        "warnings": warnings,
    }


def _normalize_for_tool(event: EventIn, payload: dict[str, Any], adapter_name: str) -> dict[str, Any]:
    session_id = _session_id(event, payload)
    warnings: list[str] = []
    messages = _normalize_messages(event, payload)
    process_steps = _normalize_process_steps(event, payload)
    code_changes = _normalize_code_changes(event, payload)
    if event.event_type == "conversation_snapshot" and not messages:
        warnings.append("conversation_snapshot contains no normalized messages")

    return {
        "schema_version": NORMALIZED_SCHEMA_VERSION,
        "tool": event.tool,
        "adapter": adapter_name,
        "event_type": event.event_type,
        "source_confidence": event.source_confidence,
        "session": {
            "session_id": session_id,
            "external_session_id": payload.get("session_id") or payload.get("sessionId") or event.session_id,
            "task_id": event.task_id,
            "user_id": event.user_id,
            "started_at": payload.get("started_at") or _iso(event.occurred_at),
            "last_activity_at": payload.get("last_activity_at") or _iso(event.occurred_at),
            "status": payload.get("session_status"),
            "title": payload.get("title"),
            "model": payload.get("resolved_model") or event.model,
        },
        "messages": messages,
        "process_steps": process_steps,
        "code_changes": code_changes,
        "spec_accesses": _normalize_all_spec_accesses(event, payload, code_changes),
        "spec_documents": _normalize_spec_documents(payload),
        "request_usage": _normalize_request_usage(event, payload),
        "usage_totals": _normalize_usage_totals(payload),
        "warnings": warnings,
    }


def normalize_copilot_event(event: EventIn, payload: dict[str, Any]) -> dict[str, Any]:
    if event.event_type == "turn_snapshot":
        return _normalize_turn_snapshot(event, payload)
    return _normalize_for_tool(event, payload, "copilot_transcript_v1")


def normalize_claude_event(event: EventIn, payload: dict[str, Any]) -> dict[str, Any]:
    if event.event_type == "turn_snapshot":
        return _normalize_turn_snapshot(event, payload)
    return _normalize_for_tool(event, payload, "claude_jsonl_v1")


def normalize_codex_event(event: EventIn, payload: dict[str, Any]) -> dict[str, Any]:
    if event.event_type == "turn_snapshot":
        return _normalize_turn_snapshot(event, payload)
    return _normalize_for_tool(event, payload, "codex_session_jsonl_v1")


def normalize_git_event(event: EventIn, payload: dict[str, Any]) -> dict[str, Any]:
    return _normalize_for_tool(event, payload, "git_boundary_v1")


def normalize_event(event: EventIn, payload: dict[str, Any]) -> dict[str, Any]:
    adapters = {
        "copilot": normalize_copilot_event,
        "claude": normalize_claude_event,
        "codex": normalize_codex_event,
        "git": normalize_git_event,
    }
    return adapters[event.tool](event, payload)
