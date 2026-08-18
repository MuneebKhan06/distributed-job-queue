"""FastAPI application entry point."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routes import health
from app.config import get_settings
from app.db.connection import dispose_engine
from app.redis.client import close_redis, ensure_consumer_groups

settings = get_settings()

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(levelname)-5.5s [%(name)s] %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Consumer groups are created here, before any worker can call XREADGROUP.

    XREADGROUP against a group that does not exist is an error, and workers come
    up alongside the API rather than after it, so creating the groups lazily on
    first submission would be a race the workers usually lose.
    """
    await ensure_consumer_groups()
    logger.info("Consumer groups ready")
    yield
    # Neither of these is optional: an engine that is never disposed leaks its
    # pooled connections, and so does the Redis pool.
    await close_redis()
    await dispose_engine()
    logger.info("Shutdown complete")


app = FastAPI(
    title="Distributed Job Queue",
    description="Job submission and inspection API for a Redis Streams backed queue.",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(health.router)
