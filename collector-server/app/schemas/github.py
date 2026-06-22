from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel
from pydantic import ConfigDict


class PullRequestAttributionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    delivery_id: str
    repository_full_name: str
    repository_id: Optional[str]
    pr_number: int
    pr_node_id: Optional[str]
    action: str
    sender_login: Optional[str]
    head_sha: Optional[str]
    base_sha: Optional[str]
    commit_count: int
    total_lines_added: int
    total_lines_deleted: int
    total_files_changed: int
    ai_commit_count: int
    ai_lines_added: int
    ai_lines_deleted: int
    ai_files_changed: int
    ai_code_ratio: Optional[float]
    matched_commit_shas: Optional[dict]
    unmatched_commit_shas: Optional[dict]
    attribution_method: str
    confidence: str
    occurred_at: datetime
