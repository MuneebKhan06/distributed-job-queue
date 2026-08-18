"""Application settings, resolved from the environment.

Every field has a default that works inside docker-compose, so a fresh clone
runs without a .env file. Anything you do put in .env wins.
"""

from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # API
    app_name: str = "distributed-job-queue"
    api_host: str = "0.0.0.0"
    api_port: int = Field(default=8000, ge=1, le=65535)
    log_level: str = "INFO"

    # PostgreSQL
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_user: str = "jobqueue"
    postgres_password: str = "jobqueue"
    postgres_db: str = "jobqueue"
    # Left unset so it can be derived from the fields above. Two independent
    # sources of truth for the same connection is how they drift apart.
    database_url_override: str | None = Field(default=None, validation_alias="DATABASE_URL")

    # Redis
    redis_host: str = "redis"
    redis_port: int = 6379
    redis_db: int = 0
    redis_url_override: str | None = Field(default=None, validation_alias="REDIS_URL")

    # Worker. Bounded here rather than trusted, because these are read once at
    # startup and then used in the hot loop: a zero batch size or a zero weight
    # only shows up as a worker that silently does nothing.
    worker_batch_size: int = Field(default=10, ge=1, le=1000)
    worker_block_ms: int = Field(default=5000, ge=100)
    high_priority_weight: int = Field(default=3, ge=1, le=100)

    # Retries
    retry_base_delay_seconds: float = Field(default=1.0, gt=0)
    retry_max_delay_seconds: float = Field(default=60.0, gt=0)
    max_attempts: int = Field(default=5, ge=1, le=20)

    # Metrics
    worker_metrics_port: int = Field(default=9100, ge=1, le=65535)

    @model_validator(mode="after")
    def check_retry_window(self) -> "Settings":
        if self.retry_max_delay_seconds < self.retry_base_delay_seconds:
            raise ValueError(
                "retry_max_delay_seconds must be at least retry_base_delay_seconds, "
                f"got max={self.retry_max_delay_seconds} base={self.retry_base_delay_seconds}"
            )
        return self

    @property
    def database_url(self) -> str:
        if self.database_url_override:
            return self.database_url_override
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def redis_url(self) -> str:
        if self.redis_url_override:
            return self.redis_url_override
        return f"redis://{self.redis_host}:{self.redis_port}/{self.redis_db}"


@lru_cache
def get_settings() -> Settings:
    """Resolved on first use rather than at import.

    Importing a module should not read the environment. Tests that need a
    different environment can clear the cache instead of reloading modules.
    """
    return Settings()
