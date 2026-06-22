from __future__ import annotations

import re
from typing import Any, Optional


SECRET_RE = re.compile(
    r"(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|"
    r"(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?[^'\"\s]+)",
    re.IGNORECASE,
)
BLOCKED_KEYS = {"prompt", "message", "content", "answer", "code", "env", "dotenv"}


def redact_value(value: Any, *, allow_full_conversation_text: bool = False) -> Any:
    if isinstance(value, str):
        redacted = SECRET_RE.sub("[REDACTED]", value)
        if allow_full_conversation_text:
            return redacted
        return redacted[:2048]
    if isinstance(value, list):
        items = value if allow_full_conversation_text else value[:50]
        return [redact_value(item, allow_full_conversation_text=allow_full_conversation_text) for item in items]
    if isinstance(value, dict):
        clean: dict[str, Any] = {}
        items = list(value.items())
        selected_items = items if allow_full_conversation_text else items[:80]
        for key, item in selected_items:
            key_text = str(key)
            if key_text.lower() in BLOCKED_KEYS:
                clean[key_text] = "[REDACTED]"
            else:
                clean[key_text] = redact_value(item, allow_full_conversation_text=allow_full_conversation_text)
        return clean
    return value


def redact_payload(payload: Optional[dict], *, allow_full_conversation_text: bool = False) -> dict:
    if not payload:
        return {}
    return redact_value(payload, allow_full_conversation_text=allow_full_conversation_text)
