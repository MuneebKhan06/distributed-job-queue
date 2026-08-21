"""Prometheus scrape endpoint for the API process."""

from fastapi import APIRouter, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from app.core.metrics import refresh_queue_depths

router = APIRouter(tags=["metrics"])


@router.get("/metrics")
async def metrics() -> Response:
    """Queue depths are refreshed here, on the scrape, so the numbers reflect
    the moment Prometheus asked rather than whenever the API last happened to
    touch Redis."""
    await refresh_queue_depths()
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)
