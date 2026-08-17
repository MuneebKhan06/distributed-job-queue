"""Every query against the jobs and dlq_jobs tables lives here.

Keeping SQL in one place means the API routes and the worker share the same
statements rather than each growing their own slightly different version of
"mark this job finished".
"""

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import DLQJob, Job


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class JobRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create_job(
        self,
        job_id: UUID,
        job_type: str,
        priority: str,
        payload: dict[str, Any],
        max_attempts: int,
    ) -> bool:
        """Insert a job, returning False if that job_id already exists.

        ON CONFLICT DO NOTHING rather than a SELECT followed by an INSERT: the
        read-then-write version has a window where two concurrent submissions
        of the same job_id both see nothing and both insert.
        """
        statement = (
            pg_insert(Job)
            .values(
                job_id=job_id,
                job_type=job_type,
                priority=priority,
                payload=payload,
                max_attempts=max_attempts,
                status="queued",
            )
            .on_conflict_do_nothing(index_elements=["job_id"])
            .returning(Job.id)
        )
        result = await self.session.execute(statement)
        return result.scalar_one_or_none() is not None

    async def get_job(self, job_id: UUID) -> Job | None:
        result = await self.session.execute(select(Job).where(Job.job_id == job_id))
        return result.scalar_one_or_none()

    async def list_jobs(
        self,
        status: str | None = None,
        job_type: str | None = None,
        priority: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Job]:
        statement = select(Job)
        if status is not None:
            statement = statement.where(Job.status == status)
        if job_type is not None:
            statement = statement.where(Job.job_type == job_type)
        if priority is not None:
            statement = statement.where(Job.priority == priority)
        statement = statement.order_by(Job.submitted_at.desc()).limit(limit).offset(offset)
        result = await self.session.execute(statement)
        return list(result.scalars().all())

    async def count_by_status(self) -> dict[str, int]:
        """Queue depth per status, for the health and metrics endpoints."""
        result = await self.session.execute(select(Job.status, func.count()).group_by(Job.status))
        return {status: count for status, count in result.all()}

    async def mark_running(self, job_id: UUID, worker_id: str, attempt: int) -> None:
        await self.session.execute(
            update(Job)
            .where(Job.job_id == job_id)
            .values(
                status="running",
                worker_id=worker_id,
                attempt=attempt,
                started_at=_utcnow(),
            )
        )

    async def mark_completed(self, job_id: UUID, result: dict[str, Any] | None) -> None:
        await self.session.execute(
            update(Job)
            .where(Job.job_id == job_id)
            .values(
                status="completed",
                result=result,
                error_message=None,
                completed_at=_utcnow(),
            )
        )

    async def mark_failed(self, job_id: UUID, error_message: str) -> None:
        """A failure that still has retries left. completed_at stays null
        because the job is not finished, only this attempt is."""
        await self.session.execute(
            update(Job)
            .where(Job.job_id == job_id)
            .values(
                status="failed",
                error_message=error_message,
            )
        )

    async def mark_dead(self, job_id: UUID, error_message: str) -> None:
        """Retries exhausted. This is terminal, so completed_at is set."""
        await self.session.execute(
            update(Job)
            .where(Job.job_id == job_id)
            .values(
                status="dead",
                error_message=error_message,
                completed_at=_utcnow(),
            )
        )

    async def is_completed(self, job_id: UUID) -> bool:
        """The idempotency check a worker runs before executing a reclaimed
        message, so a job ACKed late is not executed twice."""
        result = await self.session.execute(select(Job.status).where(Job.job_id == job_id))
        return result.scalar_one_or_none() == "completed"

    async def add_to_dlq(
        self,
        job_id: UUID,
        job_type: str | None,
        original_payload: dict[str, Any] | None,
        error_reason: str,
        attempt_count: int,
    ) -> DLQJob:
        entry = DLQJob(
            job_id=job_id,
            job_type=job_type,
            original_payload=original_payload,
            error_reason=error_reason,
            attempt_count=attempt_count,
        )
        self.session.add(entry)
        await self.session.flush()
        return entry

    async def list_dlq(self, limit: int = 50, offset: int = 0) -> list[DLQJob]:
        result = await self.session.execute(
            select(DLQJob).order_by(DLQJob.failed_at.desc()).limit(limit).offset(offset)
        )
        return list(result.scalars().all())

    async def get_dlq_entry(self, job_id: UUID) -> DLQJob | None:
        """Most recent DLQ record for a job. A job can fail, be replayed, and
        fail again, so ordering matters here."""
        result = await self.session.execute(
            select(DLQJob).where(DLQJob.job_id == job_id).order_by(DLQJob.failed_at.desc()).limit(1)
        )
        return result.scalar_one_or_none()

    async def reset_for_replay(self, job_id: UUID) -> None:
        """Put a dead job back into the queued state so it can be re-executed.

        The attempt counter is reset because a replay is an operator decision to
        try again from scratch, not a continuation of the original retry budget.
        """
        await self.session.execute(
            update(Job)
            .where(Job.job_id == job_id)
            .values(
                status="queued",
                attempt=0,
                error_message=None,
                started_at=None,
                completed_at=None,
                worker_id=None,
            )
        )
