from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..services.metrics_service import knowledge_metrics

router = APIRouter(prefix="/api/v1/metrics", tags=["metrics"])


@router.get("/knowledge")
def get_knowledge_metrics(db: Session = Depends(get_db)) -> dict:
    return knowledge_metrics(db)
