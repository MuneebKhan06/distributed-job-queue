"""Liveness and dependency check."""

import logging

from fastapi import APIRouter
from sqlalchemy import text

from app.db.connection import session_scope
from app.redis.client import get_redis, ping
from app.redis.streams import CONSUMER_GROUP, STREAM_NORMAL

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"])


async def _database_ok() -> bool:
    try:
        async with session_scope() as session:
            await session.execute(text("SELECT 1"))
        return True
    except Exception:
        logger.warning("Database health check failed", exc_info=True)
        return False


async def _active_workers() -> int:
    """Consumers currently registered in the group.

    Read from the normal stream because every worker subscribes to all three,
    so any one of them gives the same count.
    """
    try:
        groups = await get_redis().xinfo_groups(STREAM_NORMAL)
    except Exception:
        logger.warning("Could not read consumer group info", exc_info=True)
        return 0
    for group in groups:
        if group.get("name") == CONSUMER_GROUP:
            return int(group.get("consumers", 0))
    return 0


@router.get("/health")
async def health() -> dict[str, object]:
    """Always 200, with the detail in the body.

    A dependency being down is information the caller asked for, not a failure
    of this endpoint. Returning 503 here would make an orchestrator restart the
    API because PostgreSQL is unwell, which fixes nothing.
    """
    redis_ok = await ping()
    database_ok = await _database_ok()
    return {
        "status": "healthy" if (redis_ok and database_ok) else "degraded",
        "redis": "connected" if redis_ok else "unavailable",
        "database": "connected" if database_ok else "unavailable",
        "workers_active": await _active_workers() if redis_ok else 0,
    }
