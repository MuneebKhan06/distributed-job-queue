"""Validation rules on the wire contract."""

from uuid import UUID

import pytest
from pydantic import ValidationError

from app.schemas.jobs import JobPriority, JobStatus, JobSubmission


def _submission(**overrides):
    body = {"job_type": "transform.csv", "payload": {"source": "sales.csv"}}
    body.update(overrides)
    return JobSubmission(**body)


def test_job_id_is_generated_when_omitted():
    assert isinstance(_submission().job_id, UUID)


def test_supplied_job_id_is_preserved():
    job_id = UUID("550e8400-e29b-41d4-a716-446655440000")
    assert _submission(job_id=job_id).job_id == job_id


def test_priority_defaults_to_normal():
    assert _submission().priority is JobPriority.NORMAL


@pytest.mark.parametrize("job_type", ["transform.csv", "validate.schema", "compute.rollup"])
def test_known_prefixes_are_accepted(job_type):
    assert _submission(job_type=job_type).job_type == job_type


@pytest.mark.parametrize("job_type", ["delete.everything", "transformcsv", "", "unknown"])
def test_unroutable_job_types_are_rejected(job_type):
    """A job type no handler can serve is rejected at the edge.

    Accepting it would put a message on the stream that every worker refuses,
    so the failure would surface as a DLQ entry instead of a 422.
    """
    with pytest.raises(ValidationError):
        _submission(job_type=job_type)


def test_max_attempts_is_bounded():
    with pytest.raises(ValidationError):
        _submission(max_attempts=0)
    with pytest.raises(ValidationError):
        _submission(max_attempts=100)


def test_payload_is_required():
    with pytest.raises(ValidationError):
        JobSubmission(job_type="transform.csv")


def test_status_and_priority_serialise_as_plain_strings():
    """The enums have to round trip through JSON as their values, because the
    same strings are written to Redis stream fields and to the status column."""
    assert JobPriority.HIGH.value == "high"
    assert JobStatus.DEAD.value == "dead"
    assert _submission(priority="low").priority is JobPriority.LOW
