"""Aggregation and compute jobs."""

from typing import Any

from worker.handlers.base import BaseJobHandler, PermanentJobError

_SUPPORTED = ("sum", "avg", "min", "max", "count")


def _aggregate(values: list[Any], metric: str) -> float | int | None:
    numeric = [v for v in values if isinstance(v, int | float) and not isinstance(v, bool)]
    if metric == "count":
        # count is over the rows present, not the numeric ones: a null column
        # should not change how many records a group is reported to have.
        return len(values)
    if not numeric:
        return None
    if metric == "sum":
        return sum(numeric)
    if metric == "avg":
        return sum(numeric) / len(numeric)
    if metric == "min":
        return min(numeric)
    return max(numeric)


class ComputeHandler(BaseJobHandler):
    job_type_prefix = "compute"

    async def run(self, job_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.require(payload, "records", "metrics")
        records = payload["records"]
        if not isinstance(records, list):
            raise PermanentJobError("records must be a list")

        metrics: dict[str, str] = payload["metrics"]
        for field, metric in metrics.items():
            if metric not in _SUPPORTED:
                raise PermanentJobError(
                    f"unsupported metric {metric} for {field}, expected one of {_SUPPORTED}"
                )

        group_by = payload.get("group_by")
        if group_by is None:
            groups = {"_all": records}
        else:
            groups = {}
            for record in records:
                # Grouping key is stringified so a null or a mixed-type column
                # cannot blow up the whole job on an unorderable comparison.
                groups.setdefault(str(record.get(group_by)), []).append(record)

        results = {
            key: {
                field: _aggregate([r.get(field) for r in rows], metric)
                for field, metric in metrics.items()
            }
            for key, rows in groups.items()
        }

        return {
            "records_in": len(records),
            "group_by": group_by,
            "groups": len(results),
            "results": results,
        }
