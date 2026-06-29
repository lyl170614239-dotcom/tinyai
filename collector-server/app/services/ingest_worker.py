from __future__ import annotations

import asyncio
import logging
import socket

from ..config import get_settings
from ..database import SessionLocal
from .ingest_service import process_pending_ingest_jobs


logger = logging.getLogger(__name__)


async def run_ingest_worker() -> None:
    settings = get_settings()
    worker_id = f"{socket.gethostname()}:{id(asyncio.current_task())}"
    while True:
        try:
            with SessionLocal() as db:
                stats = process_pending_ingest_jobs(db, limit=settings.ingest_worker_batch_size, worker_id=worker_id)
            if stats.get("claimed"):
                logger.info(
                    "processed ingest jobs claimed=%s succeeded=%s retrying=%s failed=%s line_claimed=%s line_succeeded=%s",
                    stats.get("claimed", 0),
                    stats.get("succeeded", 0),
                    stats.get("retrying", 0),
                    stats.get("failed", 0),
                    stats.get("line_claimed", 0),
                    stats.get("line_succeeded", 0),
                )
                await asyncio.sleep(0)
            else:
                await asyncio.sleep(max(0.1, settings.ingest_worker_interval_seconds))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("ingest worker loop failed")
            await asyncio.sleep(max(1.0, settings.ingest_worker_interval_seconds))
