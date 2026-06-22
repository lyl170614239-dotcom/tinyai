from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import AgentEvent, PluginClient
from ..schemas.events import BatchIn, BatchOut, EventOut, PluginClientOut, TaskSummaryOut
from ..services.ingest_service import ingest_batch, overview_counts, recent_tasks

router = APIRouter(prefix="/api/v1", tags=["ingest"])


def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    expected = f"Bearer {get_settings().api_token}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="invalid collector token")


@router.post("/events/batch", response_model=BatchOut, dependencies=[Depends(require_token)])
def create_events(batch: BatchIn, db: Session = Depends(get_db)) -> dict:
    return ingest_batch(db, batch)


@router.get("/plugins", response_model=list[PluginClientOut])
def list_plugins(db: Session = Depends(get_db)) -> list[PluginClient]:
    return db.execute(select(PluginClient).order_by(PluginClient.last_seen_at.desc()).limit(100)).scalars().all()


@router.get("/tasks/recent", response_model=list[TaskSummaryOut])
def list_recent_tasks(limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)) -> list[dict]:
    return recent_tasks(db, limit=limit)


@router.get("/tasks/{task_id}/events", response_model=list[EventOut])
def list_task_events(task_id: str, db: Session = Depends(get_db)) -> list[AgentEvent]:
    return (
        db.execute(
            select(AgentEvent)
            .where(AgentEvent.task_id == task_id)
            .order_by(AgentEvent.occurred_at.asc(), AgentEvent.created_at.asc())
        )
        .scalars()
        .all()
    )


@router.get("/overview")
def get_overview(db: Session = Depends(get_db)) -> dict:
    return {"event_counts": overview_counts(db)}
