"""Data transformation jobs.

Operates on records carried in the payload rather than reading a file from
disk. The queue mechanics are the subject of this project, and a handler that
depended on a shared filesystem would make every worker's environment part of
the contract.
"""

from datetime import datetime
from typing import Any

from worker.handlers.base import BaseJobHandler, PermanentJobError

# Recognised date formats, tried in order. The ISO format is last because the
# ambiguous day/month forms have to be resolved by explicit ordering, not by
# whichever happens to parse first.
_DATE_FORMATS = ("%d/%m/%Y", "%m-%d-%Y", "%d.%m.%Y", "%Y-%m-%d")


def _deduplicate(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop repeated records, keeping the first occurrence.

    Ordering is preserved deliberately: a downstream job that assumes input
    order should not have it quietly shuffled by a dedupe step.
    """
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for record in records:
        key = repr(sorted(record.items()))
        if key not in seen:
            seen.add(key)
            out.append(record)
    return out


def _normalise_dates(records: list[dict[str, Any]], fields: list[str]) -> list[dict[str, Any]]:
    """Rewrite the named fields to ISO 8601, leaving unparseable values alone.

    A value that matches no known format is passed through rather than dropped
    or defaulted. Silently substituting a date is how bad data becomes
    plausible-looking bad data.
    """
    out = []
    for record in records:
        updated = dict(record)
        for field in fields:
            raw = updated.get(field)
            if not isinstance(raw, str):
                continue
            for fmt in _DATE_FORMATS:
                try:
                    updated[field] = datetime.strptime(raw, fmt).date().isoformat()
                    break
                except ValueError:
                    continue
        out.append(updated)
    return out


def _fill_nulls(records: list[dict[str, Any]], defaults: dict[str, Any]) -> list[dict[str, Any]]:
    """Replace None with a per-field default. A missing key is filled too."""
    out = []
    for record in records:
        updated = dict(record)
        for field, default in defaults.items():
            if updated.get(field) is None:
                updated[field] = default
        out.append(updated)
    return out


class TransformHandler(BaseJobHandler):
    job_type_prefix = "transform"

    async def run(self, job_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.require(payload, "records", "operations")
        records = payload["records"]
        if not isinstance(records, list):
            raise PermanentJobError("records must be a list")

        applied: list[str] = []
        for operation in payload["operations"]:
            if operation == "deduplicate":
                records = _deduplicate(records)
            elif operation == "normalize_dates":
                records = _normalise_dates(records, payload.get("date_fields", []))
            elif operation == "fill_nulls":
                records = _fill_nulls(records, payload.get("defaults", {}))
            else:
                # Unknown operation is permanent: the payload asked for
                # something this version cannot do, and it will not learn to.
                raise PermanentJobError(f"unsupported operation: {operation}")
            applied.append(operation)

        return {
            "records_in": len(payload["records"]),
            "records_out": len(records),
            "operations_applied": applied,
            "records": records,
        }
