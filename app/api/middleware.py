"""Request correlation IDs.

Metrics tell you how many submissions failed. A correlation ID lets you follow
one: from the POST that accepted it, through the stream, to the worker that
executed it.

That last hop is the part worth having here. A job queue is asynchronous, so
the caller's request has long since returned by the time anything interesting
happens, and without an ID carried on the message there is nothing linking the
worker's log line back to the client that submitted the job.
"""

import contextvars
import logging
import re
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

REQUEST_ID_HEADER = "X-Request-ID"

# Clients may supply their own ID so a trace can span several services. That
# makes it attacker controlled text heading straight for the logs, so it is
# filtered rather than trusted: newlines would let a caller forge log lines and
# an unbounded value would let them bloat every record. Anything outside this
# set is replaced with a generated ID rather than sanitised into something the
# caller never sent and would not recognise.
_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


class RequestIDFilter(logging.Filter):
    """Puts the current request's ID on every record, from anywhere.

    A logging filter reads the contextvar when the record is emitted, so call
    sites do not have to accept and forward an ID they have no other use for.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True


class RequestIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        supplied = request.headers.get(REQUEST_ID_HEADER)
        usable = bool(supplied and _SAFE_REQUEST_ID.match(supplied))
        request_id = supplied if usable else str(uuid.uuid4())

        token = request_id_var.set(request_id)
        try:
            response = await call_next(request)
        finally:
            # Reset rather than leave it set: without this the value leaks into
            # whatever the event loop handles next on this task.
            request_id_var.reset(token)

        # Echoed back so the caller can quote it when reporting a problem.
        response.headers[REQUEST_ID_HEADER] = request_id
        return response


def current_request_id() -> str:
    """The ID for the request being handled, or "-" outside a request.

    Workers call this too. There is no request there, so they get the default
    and put the ID from the message on the log record instead.
    """
    return request_id_var.get()
