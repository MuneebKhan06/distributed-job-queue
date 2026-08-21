"""Job submission and inspection endpoints."""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.metrics import JOBS_SUBMITTED
from app.db.connection import get_session
from app.db.repository import JobRepository
from app.redis.producer import enqueue_job
from app.schemas.jobs import JobAccepted, JobDetail, JobPriority, JobStatus, JobSubmission

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/jobs", tags=["jobs"])


def get_repository(session: AsyncSession = Depends(get_session)) -> JobRepository:
    return JobRepository(session)


@router.post("", status_code=status.HTTP_202_ACCEPTED, response_model=JobAccepted)
async def submit_job(
    submission: JobSubmission,
    repository: JobRepository = Depends(get_repository),
) -> JobAccepted:
    """Persist the job, then put it on the stream.

    The order matters. Writing to Redis first would let a worker pick up a job
    whose row does not exist yet, and the worker's first action is to update
    that row. The reverse failure, a row that never reaches the stream, leaves
    the job visibly stuck in 'queued' rather than causing a confusing crash in
    a worker, and it is recoverable by resubmitting the same job_id.
    """
    created = await repository.create_job(
        job_id=submission.job_id,
        job_type=submission.job_type,
        priority=submission.priority.value,
        payload=submission.payload,
        max_attempts=submission.max_attempts,
    )
    if not created:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Job {submission.job_id} has already been submitted",
        )

    message_id = await enqueue_job(
        job_id=submission.job_id,
        job_type=submission.job_type,
        priority=submission.priority,
        payload=submission.payload,
        max_attempts=submission.max_attempts,
    )
    JOBS_SUBMITTED.labels(
        job_type=submission.job_type, priority=submission.priority.value
    ).inc()
    return JobAccepted(job_id=submission.job_id, stream_message_id=message_id)


@router.get("/{job_id}", response_model=JobDetail)
async def get_job(
    job_id: UUID,
    repository: JobRepository = Depends(get_repository),
) -> JobDetail:
    job = await repository.get_job(job_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Job {job_id} not found",
        )
    return JobDetail.model_validate(job)


@router.get("", response_model=list[JobDetail])
async def list_jobs(
    job_status: JobStatus | None = Query(default=None, alias="status"),
    job_type: str | None = Query(default=None),
    priority: JobPriority | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    repository: JobRepository = Depends(get_repository),
) -> list[JobDetail]:
    """Filtered listing.

    limit is capped rather than open ended: this table grows without bound, and
    an unbounded LIMIT is how a status page becomes a full table scan.
    """
    jobs = await repository.list_jobs(
        status=job_status.value if job_status else None,
        job_type=job_type,
        priority=priority.value if priority else None,
        limit=limit,
        offset=offset,
    )
    return [JobDetail.model_validate(job) for job in jobs]
