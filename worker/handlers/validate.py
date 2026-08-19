"""Data validation jobs.

Reports on every record rather than stopping at the first bad one. A validation
run that aborts early tells you one thing is wrong; a run that completes tells
you how much of the dataset is usable, which is the question actually being
asked.
"""

from typing import Any

from worker.handlers.base import BaseJobHandler, PermanentJobError

_TYPES: dict[str, type | tuple[type, ...]] = {
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "object": dict,
    "array": list,
}


def _check_record(record: dict[str, Any], rules: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    for field in rules.get("required", []):
        if record.get(field) is None:
            errors.append(f"{field} is required")

    for field, expected in rules.get("types", {}).items():
        value = record.get(field)
        if value is None:
            continue
        python_type = _TYPES.get(expected)
        if python_type is None:
            raise PermanentJobError(f"unknown type in rules: {expected}")
        # bool is a subclass of int in Python, so an integer rule would accept
        # True without this. That is exactly the kind of silent pass a
        # validation job exists to catch.
        if expected == "integer" and isinstance(value, bool):
            errors.append(f"{field} should be integer, got boolean")
        elif not isinstance(value, python_type):
            errors.append(f"{field} should be {expected}, got {type(value).__name__}")

    return errors


class ValidateHandler(BaseJobHandler):
    job_type_prefix = "validate"

    async def run(self, job_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.require(payload, "records", "rules")
        records = payload["records"]
        if not isinstance(records, list):
            raise PermanentJobError("records must be a list")

        failures: list[dict[str, Any]] = []
        for index, record in enumerate(records):
            errors = _check_record(record, payload["rules"])
            if errors:
                failures.append({"index": index, "errors": errors})

        return {
            "records_checked": len(records),
            "valid": len(records) - len(failures),
            "invalid": len(failures),
            # Capped so one badly broken dataset cannot write a result row the
            # size of the input it was validating.
            "failures": failures[:100],
            "failures_truncated": len(failures) > 100,
        }
