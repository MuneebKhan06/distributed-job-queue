"""Shared Redis connection pool.

Created on first use rather than at import, for the same reason as the database
engine: importing a module should not open a socket. Both the API lifespan and
the worker shutdown path call close_redis().
"""

import logging

from redis.asyncio import Redis
from redis.exceptions import ResponseError

from app.config import get_settings
from app.redis.streams import ALL_STREAMS, CONSUMER_GROUP

logger = logging.getLogger(__name__)

_client: Redis | None = None


def get_redis() -> Redis:
    global _client
    if _client is None:
        settings = get_settings()
        _client = Redis.from_url(
            settings.redis_url,
            # Stream payloads are JSON text and message IDs are strings, so
            # decoding here keeps every caller from doing it by hand.
            decode_responses=True,
            health_check_interval=30,
        )
    return _client


async def ensure_consumer_groups(client: Redis | None = None) -> None:
    """Create the consumer group on every stream, if it is not there already.

    XGROUP CREATE with MKSTREAM makes the stream too, which matters because the
    group has to exist before the first worker calls XREADGROUP, and at that
    point no job has been submitted so the stream does not exist yet.
    """
    client = client or get_redis()
    for stream in ALL_STREAMS:
        try:
            await client.xgroup_create(name=stream, groupname=CONSUMER_GROUP, id="0", mkstream=True)
            logger.info("Created consumer group %s on %s", CONSUMER_GROUP, stream)
        except ResponseError as exc:
            # BUSYGROUP is the expected result on every start after the first.
            # Anything else is a real failure and should not be swallowed.
            if "BUSYGROUP" not in str(exc):
                raise


async def ping() -> bool:
    """Used by the health endpoint. Returns False rather than raising, because
    an unreachable Redis is a reportable state, not a broken request."""
    try:
        return bool(await get_redis().ping())
    except Exception:
        logger.warning("Redis ping failed", exc_info=True)
        return False


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
