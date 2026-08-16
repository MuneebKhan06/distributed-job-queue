"""Pydantic models for the job API.

These are the wire contract. The SQLAlchemy models in app/db/models.py are the
storage contract, and the two are deliberately kept separate: a column can be
added for internal bookkeeping without it leaking into the API response.
"""

from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator


class JobPriority(str, Enum):
    HIGH = "high"
    NORMAL = "normal"
    LOW = "low"


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    DEAD = "dead"


# Handlers register under a prefix, so "transform.csv" and "transform.json" both
# route to the transform handler. Validated here to reject a job type that no
# worker could ever pick up, rather than discovering it after the round trip
# through Redis.
KNOWN_JOB_TYPE_PREFIXES = ("transform", "validate", "compute")


class JobSubmission(BaseModel):
    """Body of POST /jobs."""

    job_id: UUID = Field(default_factory=uuid4)
    job_type: str = Field(min_length=1, max_length=50)
    priority: JobPriority = JobPriority.NORMAL
    payload: dict[str, Any]
    max_attempts: int = Field(default=5, ge=1, le=20)

    @field_validator("job_type")
    @classmethod
    def job_type_must_be_routable(cls, value: str) -> str:
        prefix = value.split(".", 1)[0]
        if prefix not in KNOWN_JOB_TYPE_PREFIXES:
            known = ", ".join(KNOWN_JOB_TYPE_PREFIXES)
            raise ValueError(f"job_type must start with one of: {known}")
        return value


class JobAccepted(BaseModel):
    """202 response for a submission that made it onto the stream."""

    job_id: UUID
    status: JobStatus = JobStatus.QUEUED
    stream_message_id: str


class JobDetail(BaseModel):
    """Full job state, as returned by GET /jobs/{job_id}."""

    job_id: UUID
    job_type: str
    priority: JobPriority
    status: JobStatus
    attempt: int
    max_attempts: int
    payload: dict[str, Any]
    result: dict[str, Any] | None = None
    error_message: str | None = None
    submitted_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    worker_id: str | None = None

    model_config = {"from_attributes": True}


class DLQEntry(BaseModel):
    """A job that exhausted its retries, as returned by GET /dlq."""

    job_id: UUID
    job_type: str | None = None
    original_payload: dict[str, Any] | None = None
    error_reason: str
    attempt_count: int
    failed_at: datetime

    model_config = {"from_attributes": True}
