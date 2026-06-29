from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import AiCodeChange, PullRequestAttribution

BEIJING_TZ = timezone(timedelta(hours=8))


class GitHubWebhookError(Exception):
    pass


def verify_signature(raw_body: bytes, signature: str | None) -> None:
    secret = get_settings().github_webhook_secret
    if not secret:
        return
    if not signature or not signature.startswith("sha256="):
        raise GitHubWebhookError("missing github webhook signature")
    expected = "sha256=" + hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise GitHubWebhookError("invalid github webhook signature")


def _json_get(record: dict[str, Any], key: str, default: Any = None) -> Any:
    value = record.get(key)
    return default if value is None else value


def _int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return default


def _change_payload(change: AiCodeChange) -> dict[str, Any]:
    if isinstance(change.diff_json, dict):
        return change.diff_json
    return {}


def _local_now() -> datetime:
    return datetime.now(BEIJING_TZ).replace(tzinfo=None)


def _commit_snapshot_index(db: Session) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    changes = db.execute(select(AiCodeChange).where(AiCodeChange.change_type == "commit_snapshot")).scalars().all()
    for change in changes:
        payload = _change_payload(change)
        sha = str(payload.get("commit_sha") or "")
        if not sha:
            continue
        if payload.get("ai_assisted") is False:
            continue
        current = index.get(sha) or {"ai_lines_added": 0, "ai_lines_deleted": 0, "files_changed": 0, "line_attribution": None}
        index[sha] = {
            "ai_lines_added": max(current["ai_lines_added"], _int(payload.get("ai_lines_added"), change.lines_added)),
            "ai_lines_deleted": max(current["ai_lines_deleted"], _int(payload.get("ai_lines_deleted"), change.lines_deleted)),
            "files_changed": max(current["files_changed"], _int(payload.get("files_changed"))),
            "human_lines_added": _int(payload.get("human_lines_added")),
            "line_attribution": payload.get("line_attribution") if isinstance(payload.get("line_attribution"), dict) else current.get("line_attribution"),
        }
    return index


def _safe_commits_url(commits_url: str, repository_full_name: str, pr_number: int) -> str:
    settings = get_settings()
    parsed = urlparse(commits_url)
    api_base = settings.github_api_url.rstrip("/")
    if parsed.scheme and parsed.netloc:
        if not commits_url.startswith(api_base):
            raise GitHubWebhookError("commits_url does not match configured GitHub API URL")
        return commits_url
    return f"{api_base}/repos/{repository_full_name}/pulls/{pr_number}/commits"


def _fetch_pr_commit_shas(commits_url: str, repository_full_name: str, pr_number: int) -> list[str]:
    settings = get_settings()
    url = _safe_commits_url(commits_url, repository_full_name, pr_number)
    shas: list[str] = []
    headers = {
        "accept": "application/vnd.github+json",
        "user-agent": "tinyai-observability",
        "x-github-api-version": "2022-11-28",
    }
    if settings.github_token:
        headers["authorization"] = f"Bearer {settings.github_token}"

    for page in range(1, 4):
        separator = "&" if "?" in url else "?"
        page_url = f"{url}{separator}per_page=100&page={page}"
        request = Request(page_url, headers=headers)
        try:
            with urlopen(request, timeout=10) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError) as error:
            raise GitHubWebhookError(f"failed to fetch pull request commits: {error}") from error
        if not isinstance(data, list):
            raise GitHubWebhookError("unexpected GitHub commits response")
        shas.extend(str(item.get("sha")) for item in data if isinstance(item, dict) and item.get("sha"))
        if len(data) < 100:
            break
    return shas


def _commit_shas_from_payload(payload: dict[str, Any]) -> list[str]:
    commits = payload.get("commits")
    if not isinstance(commits, list):
        return []
    shas = []
    for item in commits:
        if isinstance(item, str):
            shas.append(item)
        elif isinstance(item, dict) and item.get("sha"):
            shas.append(str(item["sha"]))
    return shas


def _sender_login(payload: dict[str, Any]) -> str | None:
    sender = payload.get("sender")
    if not isinstance(sender, dict):
        return None
    login = sender.get("login")
    return str(login) if login else None


def _branch_sha(pull_request: dict[str, Any], side: str) -> str | None:
    branch = pull_request.get(side)
    if not isinstance(branch, dict):
        return None
    sha = branch.get("sha")
    return str(sha) if sha else None


def process_pull_request_webhook(db: Session, payload: dict[str, Any], delivery_id: str) -> dict[str, Any]:
    repository = _json_get(payload, "repository", {})
    pull_request = _json_get(payload, "pull_request", {})
    if not isinstance(repository, dict) or not isinstance(pull_request, dict):
        raise GitHubWebhookError("missing pull_request or repository payload")

    repository_full_name = str(repository.get("full_name") or "")
    pr_number = _int(payload.get("number") or pull_request.get("number"))
    if not repository_full_name or not pr_number:
        raise GitHubWebhookError("missing repository full_name or pull request number")

    commit_shas = _commit_shas_from_payload(payload)
    if not commit_shas:
        commits_url = str(pull_request.get("commits_url") or "")
        commit_shas = _fetch_pr_commit_shas(commits_url, repository_full_name, pr_number)

    snapshot_index = _commit_snapshot_index(db)
    matched: list[dict[str, Any]] = []
    unmatched: list[str] = []
    ai_lines_added = 0
    ai_lines_deleted = 0
    ai_files_changed = 0

    for sha in commit_shas:
        snapshot = snapshot_index.get(sha)
        if not snapshot:
            unmatched.append(sha)
            continue
        matched.append({"sha": sha, **snapshot})
        ai_lines_added += snapshot["ai_lines_added"]
        ai_lines_deleted += snapshot["ai_lines_deleted"]
        ai_files_changed += snapshot["files_changed"]

    total_lines_added = _int(pull_request.get("additions"), ai_lines_added)
    total_lines_deleted = _int(pull_request.get("deletions"), ai_lines_deleted)
    total_files_changed = _int(pull_request.get("changed_files"), ai_files_changed)
    attribution = PullRequestAttribution(
        delivery_id=delivery_id,
        repository_full_name=repository_full_name,
        repository_id=str(repository.get("id")) if repository.get("id") is not None else None,
        pr_number=pr_number,
        pr_node_id=str(pull_request.get("node_id")) if pull_request.get("node_id") else None,
        action=str(payload.get("action") or "unknown")[:64],
        sender_login=_sender_login(payload),
        head_sha=_branch_sha(pull_request, "head"),
        base_sha=_branch_sha(pull_request, "base"),
        commit_count=len(commit_shas),
        total_lines_added=total_lines_added,
        total_lines_deleted=total_lines_deleted,
        total_files_changed=total_files_changed,
        ai_commit_count=len(matched),
        ai_lines_added=ai_lines_added,
        ai_lines_deleted=ai_lines_deleted,
        ai_files_changed=ai_files_changed,
        ai_code_ratio=round(ai_lines_added / total_lines_added, 4) if total_lines_added > 0 else None,
        matched_commit_shas={"commits": matched},
        unmatched_commit_shas={"commits": unmatched[:250], "truncated": len(unmatched) > 250},
        attribution_method="pr_commit_snapshot_intersection",
        confidence="derived",
        occurred_at=_local_now(),
    )

    existing = db.execute(select(PullRequestAttribution).where(PullRequestAttribution.delivery_id == delivery_id)).scalar_one_or_none()
    if existing:
        return {"ok": True, "duplicate": True, "id": existing.id}

    db.add(attribution)
    db.commit()
    db.refresh(attribution)
    return {
        "ok": True,
        "duplicate": False,
        "id": attribution.id,
        "repository_full_name": repository_full_name,
        "pr_number": pr_number,
        "commit_count": len(commit_shas),
        "ai_commit_count": len(matched),
        "ai_lines_added": ai_lines_added,
        "total_lines_added": total_lines_added,
        "ai_code_ratio": attribution.ai_code_ratio,
    }


def recent_pr_attributions(db: Session, limit: int = 50) -> list[PullRequestAttribution]:
    return (
        db.execute(select(PullRequestAttribution).order_by(PullRequestAttribution.occurred_at.desc()).limit(limit))
        .scalars()
        .all()
    )
