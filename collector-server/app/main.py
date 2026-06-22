from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.health import router as health_router
from .api.github import router as github_router
from .api.ingest import router as ingest_router
from .api.metrics import router as metrics_router
from .config import get_settings
from .database import init_db


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="TinyAI Observability Collector", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health_router)
    app.include_router(ingest_router)
    app.include_router(metrics_router)
    app.include_router(github_router)

    @app.on_event("startup")
    def _startup() -> None:
        init_db()

    return app


app = create_app()
