from __future__ import annotations

import re
from typing import Any

try:
    from pypinyin import Style, pinyin
except ImportError:  # pragma: no cover - production images install pypinyin.
    Style = None
    pinyin = None


GENERIC_IDENTITY_VALUES = {"unknown", "user", "null", "none"}


def clean_identity(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    if not cleaned or cleaned.lower() in GENERIC_IDENTITY_VALUES:
        return None
    return cleaned


def _pinyin_text(value: str) -> str:
    if not pinyin or not Style:
        return value
    parts: list[str] = []
    for item in pinyin(value, style=Style.NORMAL, heteronym=False, errors="default"):
        if item:
            parts.append(item[0])
    return "".join(parts)


def english_user_slug(value: Any) -> str | None:
    cleaned = clean_identity(value)
    if not cleaned or "@" in cleaned:
        return None
    romanized = _pinyin_text(cleaned)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", romanized).strip("-._").lower()
    return slug[:128] if slug else None


def normalize_plugin_user_id(
    *,
    username: Any = None,
    user_id: Any = None,
    user_display_name: Any = None,
) -> str:
    return (
        english_user_slug(username)
        or english_user_slug(user_id)
        or english_user_slug(user_display_name)
        or "unknown"
    )
