"""Handler registry.

Handlers are registered by the prefix of the job type, so adding a job type
that an existing handler already covers ("transform.parquet") needs no change
here at all.
"""

from worker.handlers.base import (
    BaseJobHandler,
    JobError,
    PermanentJobError,
    TransientJobError,
)
from worker.handlers.compute import ComputeHandler
from worker.handlers.transform import TransformHandler
from worker.handlers.validate import ValidateHandler

_HANDLERS: dict[str, BaseJobHandler] = {
    handler.job_type_prefix: handler
    for handler in (TransformHandler(), ValidateHandler(), ComputeHandler())
}


def get_handler(job_type: str) -> BaseJobHandler:
    """Resolve a job type to its handler.

    An unroutable job type is permanent rather than transient. The API rejects
    these at submission, so one arriving here means the stream holds a message
    the API would no longer accept, and no amount of retrying changes that.
    """
    prefix = job_type.split(".", 1)[0]
    handler = _HANDLERS.get(prefix)
    if handler is None:
        raise PermanentJobError(f"no handler registered for job type {job_type}")
    return handler


def registered_prefixes() -> tuple[str, ...]:
    return tuple(sorted(_HANDLERS))


__all__ = [
    "BaseJobHandler",
    "ComputeHandler",
    "JobError",
    "PermanentJobError",
    "TransformHandler",
    "TransientJobError",
    "ValidateHandler",
    "get_handler",
    "registered_prefixes",
]
