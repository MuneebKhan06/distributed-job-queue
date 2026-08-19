"""The interface every job handler implements, and the failure taxonomy.

The distinction between the two error types is the important part of this
module. A handler that cannot tell them apart forces the retry machinery to
treat every failure the same way, which means either retrying malformed input
five times for nothing, or giving up on a database blip that would have cleared
on the next attempt.
"""

from abc import ABC, abstractmethod
from typing import Any


class JobError(Exception):
    """Base for anything a handler raises deliberately."""


class TransientJobError(JobError):
    """The attempt failed, but the same input could succeed later.

    A timeout, a connection reset, a rate limit, a downstream service that is
    briefly down. These are worth retrying with backoff.
    """


class PermanentJobError(JobError):
    """The input itself is wrong, so no number of retries will help.

    A missing required field, an unparseable value, an unsupported operation.
    These go straight to the DLQ: retrying them just delays the inevitable and
    occupies a worker that could be doing real work.
    """


class BaseJobHandler(ABC):
    """One handler per job type family.

    Handlers are stateless and are instantiated once at import. Anything a
    handler needs per job arrives in the payload, so the same instance can serve
    concurrent jobs without coordination.
    """

    #: Job types are dotted, and the part before the first dot selects the
    #: handler. "transform.csv" and "transform.json" both land on transform.
    job_type_prefix: str

    @abstractmethod
    async def run(self, job_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Execute the job and return its result.

        The full job_type is passed, not just the payload, because a handler
        routinely branches on the suffix: transform.csv and transform.json want
        different parsing but share everything after it.

        Raise TransientJobError or PermanentJobError to classify a failure.
        Any other exception is treated as transient, on the reasoning that an
        unclassified bug is more often a passing condition than a permanent
        property of the input.
        """

    def require(self, payload: dict[str, Any], *fields: str) -> None:
        """Assert required payload fields, as a permanent failure if missing.

        Every handler needs this and every handler would otherwise write it
        slightly differently, with some of them raising the wrong error type.
        """
        missing = [field for field in fields if field not in payload]
        if missing:
            raise PermanentJobError(f"payload is missing required fields: {', '.join(missing)}")
