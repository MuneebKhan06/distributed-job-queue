"""Job submission and query endpoints."""

from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.routes.jobs import get_repository
from app.main import app

JOB_ID = "550e8400-e29b-41d4-a716-446655440000"


def body(**overrides):
    base = {
        "job_id": JOB_ID,
        "job_type": "transform.csv",
        "priority": "normal",
        "payload": {"source": "sales.csv"},
    }
    base.update(overrides)
    return base


@pytest.fixture
def repository():
    repo = AsyncMock()
    repo.create_job.return_value = True
    return repo


@pytest.fixture
def client(repository):
    # No context manager, so the lifespan never runs and nothing reaches Redis.
    app.dependency_overrides[get_repository] = lambda: repository
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def enqueue():
    with patch("app.api.routes.jobs.enqueue_job", new=AsyncMock(return_value="1699-0")) as mock:
        yield mock


def test_accepted_submission_returns_the_stream_message_id(client, enqueue):
    response = client.post("/jobs", json=body())

    assert response.status_code == 202
    assert response.json() == {
        "job_id": JOB_ID,
        "status": "queued",
        "stream_message_id": "1699-0",
    }


def test_row_is_committed_before_the_message_is_enqueued(client, repository, enqueue):
    """The regression this guards against is subtle: the session dependency
    commits on teardown, which runs after the handler returns, so an implicit
    commit would put the message on the stream while the row was still
    uncommitted. A worker reading it would find no job to mark running.
    """
    order = []
    repository.session = MagicMock()
    repository.session.commit = AsyncMock(side_effect=lambda: order.append("commit"))
    enqueue.side_effect = lambda **_: order.append("enqueue") or "1699-0"

    client.post("/jobs", json=body())

    assert order == ["commit", "enqueue"]


def test_duplicate_submission_conflicts_and_is_not_enqueued(client, repository, enqueue):
    repository.create_job.return_value = False

    response = client.post("/jobs", json=body())

    assert response.status_code == 409
    enqueue.assert_not_awaited()


def test_unroutable_job_type_is_rejected(client, enqueue):
    response = client.post("/jobs", json=body(job_type="delete.everything"))

    assert response.status_code == 422
    enqueue.assert_not_awaited()


def test_missing_job_is_reported_as_not_found(client, repository):
    repository.get_job.return_value = None

    assert client.get(f"/jobs/{uuid4()}").status_code == 404


def test_listing_rejects_a_limit_above_the_cap(client, repository):
    """An unbounded LIMIT against a table that only grows is how a status page
    turns into a full table scan."""
    repository.list_jobs.return_value = []

    assert client.get("/jobs?limit=9999").status_code == 422
    assert client.get("/jobs?limit=500").status_code == 200


def test_listing_passes_filters_through(client, repository):
    repository.list_jobs.return_value = []

    client.get("/jobs?status=failed&job_type=compute.sum&priority=high&limit=10&offset=5")

    assert repository.list_jobs.await_args.kwargs == {
        "status": "failed",
        "job_type": "compute.sum",
        "priority": "high",
        "limit": 10,
        "offset": 5,
    }


def test_a_generated_correlation_id_is_returned(client, enqueue):
    response = client.post("/jobs", json=body())

    assert len(response.headers["X-Request-ID"]) == 36


def test_a_supplied_correlation_id_is_echoed_back(client, enqueue):
    response = client.post("/jobs", json=body(), headers={"X-Request-ID": "trace-abc-123"})

    assert response.headers["X-Request-ID"] == "trace-abc-123"


def test_a_dangerous_correlation_id_is_replaced_not_sanitised(client, enqueue):
    """A newline in a header would let a caller forge log lines. Replacing it
    with a generated ID is safer than editing it into something the caller
    never sent and would not recognise."""
    forged = "abc\nERROR  fake log line"

    response = client.post("/jobs", json=body(), headers={"X-Request-ID": forged})

    assert response.headers["X-Request-ID"] != forged
    assert "\n" not in response.headers["X-Request-ID"]


def test_an_overlong_correlation_id_is_replaced(client, enqueue):
    response = client.post("/jobs", json=body(), headers={"X-Request-ID": "x" * 200})

    assert len(response.headers["X-Request-ID"]) == 36


def test_the_correlation_id_travels_with_the_job(client):
    """The whole point: a worker log line has to be traceable back to the
    request that submitted the job, and the request is long gone by then."""
    from app.api.middleware import request_id_var
    from app.redis.producer import _encode

    seen = {}

    async def capture(**kwargs):
        # Read inside the request, where the contextvar is set.
        seen["request_id"] = request_id_var.get()
        return "1699-0"

    with patch("app.api.routes.jobs.enqueue_job", new=capture):
        client.post("/jobs", json=body(), headers={"X-Request-ID": "trace-abc-123"})

    assert seen["request_id"] == "trace-abc-123"
    assert _encode(uuid4(), "t.csv", "normal", {}, 0, 5, "trace-abc-123")["request_id"] == (
        "trace-abc-123"
    )
