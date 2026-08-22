"""FastAPI application entry point."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.middleware import RequestIDFilter, RequestIDMiddleware
from app.api.routes import dlq, health, jobs, metrics
from app.config import get_settings
from app.db.connection import dispose_engine
from app.redis.client import close_redis, ensure_consumer_groups

settings = get_settings()

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(levelname)-5.5s [%(name)s] [%(request_id)s] %(message)s",
)
# Attached to the handler rather than a logger, so records from third party
# loggers carry the field too. Without it they would raise a formatting error
# on the missing %(request_id)s.
for _handler in logging.getLogger().handlers:
    _handler.addFilter(RequestIDFilter())

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

app.add_middleware(RequestIDMiddleware)

app.include_router(health.router)
app.include_router(jobs.router)
app.include_router(dlq.router)
app.include_router(metrics.router)
