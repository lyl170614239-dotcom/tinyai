from __future__ import annotations

import asyncio
from contextlib import suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.health import router as health_router
from .api.github import router as github_router
from .api.ingest import router as ingest_router
from .api.metrics import router as metrics_router
from .config import get_settings
from .database import init_db
from .services.ingest_worker import run_ingest_worker


def create_app() -> FastAPI:
    settings = get_settings()
    allow_origins = settings.cors_origin_list
    app = FastAPI(title="TinyAI Observability Collector", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allow_origins,
        allow_credentials="*" not in allow_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health_router)
    app.include_router(ingest_router)
    app.include_router(metrics_router)
    app.include_router(github_router)

    @app.on_event("startup")
    async def _startup() -> None:
        init_db()
        if settings.ingest_async_normalization and settings.ingest_worker_enabled:
            app.state.ingest_worker_task = asyncio.create_task(run_ingest_worker())

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        task = getattr(app.state, "ingest_worker_task", None)
        if task is None:
            return
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    return app


app = create_app()
