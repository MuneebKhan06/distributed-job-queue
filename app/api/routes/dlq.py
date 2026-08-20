"""Dead letter queue inspection and replay."""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dlq import replay_job
from app.db.connection import get_session
from app.db.repository import JobRepository
from app.schemas.jobs import DLQEntry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dlq", tags=["dlq"])


def get_repository(session: AsyncSession = Depends(get_session)) -> JobRepository:
    return JobRepository(session)


@router.get("", response_model=list[DLQEntry])
async def list_dlq(
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    repository: JobRepository = Depends(get_repository),
) -> list[DLQEntry]:
    """Most recent failures first, which is the order an operator wants when
    something has just gone wrong."""
    entries = await repository.list_dlq(limit=limit, offset=offset)
    return [DLQEntry.model_validate(entry) for entry in entries]


@router.get("/{job_id}", response_model=DLQEntry)
async def get_dlq_entry(
    job_id: UUID,
    repository: JobRepository = Depends(get_repository),
) -> DLQEntry:
    entry = await repository.get_dlq_entry(job_id)
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Job {job_id} is not in the DLQ",
        )
    return DLQEntry.model_validate(entry)


@router.post("/{job_id}/replay", status_code=status.HTTP_202_ACCEPTED)
async def replay(job_id: UUID) -> dict[str, str]:
    """Put a dead job back on its priority stream.

    Deliberately not idempotent in the way submission is. Replaying twice
    enqueues twice, because an operator asking again is asking for another run,
    not repeating themselves by accident. The executor's completion check still
    stops the second copy from doing the work twice if the first one succeeds.
    """
    replayed = await replay_job(job_id)
    if not replayed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Job {job_id} is not in the DLQ",
        )
    return {"job_id": str(job_id), "status": "queued"}
