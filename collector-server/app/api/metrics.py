from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..services.metrics_service import knowledge_metrics

router = APIRouter(prefix="/api/v1/metrics", tags=["metrics"])


@router.get("/knowledge")
def get_knowledge_metrics(
    username: Optional[str] = Query(default=None, max_length=256),
    db: Session = Depends(get_db),
) -> dict:
    return knowledge_metrics(db, username=username)
