from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import PullRequestAttribution
from ..schemas.github import PullRequestAttributionOut
from ..services.github_service import (
    GitHubWebhookError,
    process_pull_request_webhook,
    recent_pr_attributions,
    verify_signature,
)

router = APIRouter(prefix="/api/v1/github", tags=["github"])


@router.post("/webhook")
async def github_webhook(
    request: Request,
    db: Session = Depends(get_db),
    x_github_event: Optional[str] = Header(default=None),
    x_github_delivery: Optional[str] = Header(default=None),
    x_hub_signature_256: Optional[str] = Header(default=None),
) -> dict:
    raw_body = await request.body()
    try:
        verify_signature(raw_body, x_hub_signature_256)
    except GitHubWebhookError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error

    if x_github_event == "ping":
        return {"ok": True, "event": "ping"}
    if x_github_event != "pull_request":
        return {"ok": True, "ignored": True, "event": x_github_event}
    if not x_github_delivery:
        raise HTTPException(status_code=400, detail="missing X-GitHub-Delivery")

    payload = await request.json()
    try:
        return process_pull_request_webhook(db, payload, x_github_delivery)
    except GitHubWebhookError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.get("/pr-attributions/recent", response_model=list[PullRequestAttributionOut])
def list_recent_pr_attributions(limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)) -> list[PullRequestAttribution]:
    return recent_pr_attributions(db, limit=limit)
