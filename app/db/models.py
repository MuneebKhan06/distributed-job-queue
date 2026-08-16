"""SQLAlchemy models for job state.

PostgreSQL is the source of truth for what happened to a job. Redis holds the
queue; it does not hold history, and it is not consulted to answer "what is the
status of this job".
"""

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    # The idempotency key. Supplied by the client so a retried submission is
    # recognised as the same job rather than queued twice.
    job_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), nullable=False, unique=True)
    job_type: Mapped[str] = mapped_column(String(50), nullable=False)
    priority: Mapped[str] = mapped_column(String(10), nullable=False, server_default="normal")
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="queued")
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="5")
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Three timestamps rather than one updated_at: queue wait is
    # started_at - submitted_at, execution is completed_at - started_at, and a
    # single mutable column would destroy both as it is overwritten.
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Which worker ran it. Without this, "one worker is failing every job it
    # touches" is invisible in the data.
    worker_id: Mapped[str | None] = mapped_column(String(100), nullable=True)

    __table_args__ = (
        Index("idx_jobs_status", "status"),
        Index("idx_jobs_job_type", "job_type"),
        Index("idx_jobs_submitted", submitted_at.desc()),
        # Partial: only assigned jobs are ever looked up by worker, and most
        # rows in a healthy queue have no worker yet.
        Index("idx_jobs_worker", "worker_id", postgresql_where=worker_id.isnot(None)),
    )

    def __repr__(self) -> str:
        return f"<Job {self.job_id} {self.job_type} {self.status}>"


class DLQJob(Base):
    """A job that exhausted its retries.

    Kept in its own table instead of a 'dead' status on jobs, because the DLQ is
    read with a different access pattern: an operator browsing failures, not the
    hot status lookup the jobs table serves.
    """

    __tablename__ = "dlq_jobs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    # Not unique: the same job can land here again after a replay that fails.
    job_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), nullable=False)
    job_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    original_payload: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    error_reason: Mapped[str] = mapped_column(Text, nullable=False)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False)
    failed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("idx_dlq_jobs_job_id", "job_id"),
        Index("idx_dlq_jobs_failed_at", failed_at.desc()),
    )

    def __repr__(self) -> str:
        return f"<DLQJob {self.job_id} attempts={self.attempt_count}>"
