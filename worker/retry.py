"""Retry timing.

Only the delay maths lives here. Whether a job is retried at all is the
executor's call, and where the retry is parked until it comes due is the delay
queue's, so this stays a pure function that can be reasoned about on its own.
"""

import random

# Cap on the exponent before the delay is clamped anyway. 2 ** 1000 is a real
# number in Python and computing it to then throw it away for max_delay is a
# waste that only shows up once max_attempts is misconfigured.
_MAX_EXPONENT = 32


def compute_delay(
    attempt: int,
    base_delay: float,
    max_delay: float,
    rng: random.Random | None = None,
) -> float:
    """Seconds to wait before attempt number `attempt` is retried.

        delay = min(base * 2 ** attempt, max_delay) * (0.5 + random() * 0.5)

    Exponential growth stops a failing downstream from being hammered. The
    jitter is what stops a hundred jobs that failed together from all retrying
    in the same instant and recreating the spike that broke it.

    This is equal jitter, spreading each retry over the top half of its window,
    rather than full jitter over the whole window. Full jitter can return
    something very close to zero on the first retry, which is indistinguishable
    from not backing off at all.
    """
    if attempt < 0:
        raise ValueError("attempt must not be negative")
    if base_delay <= 0:
        raise ValueError("base_delay must be positive")
    if max_delay < base_delay:
        raise ValueError("max_delay must be at least base_delay")

    rng = rng or random
    exponent = min(attempt, _MAX_EXPONENT)
    window = min(base_delay * (2**exponent), max_delay)
    return window * (0.5 + rng.random() * 0.5)


def should_retry(attempt: int, max_attempts: int) -> bool:
    """Whether another attempt is allowed.

    `attempt` is the number of attempts already made, so this is a comparison
    against the budget rather than a check for the last one.
    """
    return attempt < max_attempts
