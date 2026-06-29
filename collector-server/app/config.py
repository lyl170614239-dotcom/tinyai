from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "mysql+pymysql://tinyobs:tinyobs@localhost:13306/tinyobs"
    api_token: str = ""
    cors_origins: str = "*"
    github_api_url: str = "https://api.github.com"
    github_token: str = ""
    github_webhook_secret: str = ""
    raw_retention_days: int = 30
    normalized_retention_days: int = 90
    ingest_cleanup_interval_seconds: int = 3600
    ingest_async_normalization: bool = True
    ingest_worker_enabled: bool = True
    ingest_worker_batch_size: int = 50
    ingest_worker_interval_seconds: float = 1.0
    ingest_job_max_attempts: int = 5
    ingest_job_retry_seconds: int = 30
    ingest_job_lock_timeout_seconds: int = 300

    model_config = SettingsConfigDict(env_prefix="OBS_", env_file=".env", extra="ignore")

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
