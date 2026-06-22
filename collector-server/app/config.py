from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "mysql+pymysql://tinyobs:tinyobs@localhost:13306/tinyobs"
    api_token: str = "dev-token"
    cors_origins: str = "http://localhost:18081,http://127.0.0.1:18081"
    github_api_url: str = "https://api.github.com"
    github_token: str = ""
    github_webhook_secret: str = ""

    model_config = SettingsConfigDict(env_prefix="OBS_", env_file=".env", extra="ignore")

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
