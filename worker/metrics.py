"""Worker side metrics endpoint.

The worker is not an HTTP service, so it needs its own listener for Prometheus
to scrape. The alternative, having workers push into the API's registry, would
mean the API reporting numbers it did not measure and could not attribute to a
particular worker.

Counter definitions are imported from app.core.metrics rather than redeclared,
so a job counted here sums cleanly with one counted in the API.
"""

import logging

from prometheus_client import Gauge, start_http_server

logger = logging.getLogger(__name__)

JOBS_IN_FLIGHT = Gauge(
    "worker_jobs_in_flight",
    "Jobs currently executing in this worker",
    ["worker_id"],
)

WORKER_UP = Gauge(
    "worker_up",
    "1 while the worker loop is running",
    ["worker_id"],
)


def start_metrics_server(port: int, worker_id: str) -> None:
    """Expose /metrics on `port` for this worker process.

    Each worker binds its own port, so running several on one host means giving
    them different ports. In compose they are separate containers and the port
    can be identical, which is the normal case.
    """
    try:
        start_http_server(port)
    except OSError:
        # A worker that cannot bind its metrics port should still process jobs.
        # Losing observability is bad; refusing to work because of it is worse.
        logger.error("Could not bind metrics port %d, continuing without it", port, exc_info=True)
        return
    WORKER_UP.labels(worker_id=worker_id).set(1)
    logger.info("Worker metrics available on port %d", port)


def mark_stopped(worker_id: str) -> None:
    WORKER_UP.labels(worker_id=worker_id).set(0)
