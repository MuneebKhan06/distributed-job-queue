"""Create the jobs table

Revision ID: 0001
Revises:
Create Date: 2026-08-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "jobs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        # The idempotency key, supplied by the client. UNIQUE is what makes a
        # resubmitted job a conflict instead of a second copy on the queue.
        sa.Column("job_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("job_type", sa.String(length=50), nullable=False),
        sa.Column("priority", sa.String(length=10), server_default="normal", nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=20), server_default="queued", nullable=False),
        sa.Column("attempt", sa.Integer(), server_default="0", nullable=False),
        sa.Column("max_attempts", sa.Integer(), server_default="5", nullable=False),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        # Three timestamps, not one updated_at: queue wait and execution time
        # are both derivable from these, and a single mutable column would
        # overwrite the history that makes them derivable.
        sa.Column(
            "submitted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("worker_id", sa.String(length=100), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id"),
    )
    op.create_index("idx_jobs_status", "jobs", ["status"])
    op.create_index("idx_jobs_job_type", "jobs", ["job_type"])
    op.create_index("idx_jobs_submitted", "jobs", [sa.text("submitted_at DESC")])
    # Partial: only assigned jobs are ever looked up by worker, and in a healthy
    # queue most rows have no worker yet.
    op.create_index(
        "idx_jobs_worker",
        "jobs",
        ["worker_id"],
        postgresql_where=sa.text("worker_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("idx_jobs_worker", table_name="jobs")
    op.drop_index("idx_jobs_submitted", table_name="jobs")
    op.drop_index("idx_jobs_job_type", table_name="jobs")
    op.drop_index("idx_jobs_status", table_name="jobs")
    op.drop_table("jobs")
