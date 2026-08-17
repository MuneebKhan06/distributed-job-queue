"""Create the dlq_jobs table

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "dlq_jobs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        # Deliberately not unique. A replayed job that fails again lands here a
        # second time, and losing that second record would hide a job that is
        # failing repeatedly rather than once.
        sa.Column("job_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("job_type", sa.String(length=50), nullable=True),
        sa.Column("original_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("error_reason", sa.Text(), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column(
            "failed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    # Lookup by job_id is the replay path; failed_at DESC is the operator
    # browsing the most recent failures, which is the common read.
    op.create_index("idx_dlq_jobs_job_id", "dlq_jobs", ["job_id"])
    op.create_index("idx_dlq_jobs_failed_at", "dlq_jobs", [sa.text("failed_at DESC")])


def downgrade() -> None:
    op.drop_index("idx_dlq_jobs_failed_at", table_name="dlq_jobs")
    op.drop_index("idx_dlq_jobs_job_id", table_name="dlq_jobs")
    op.drop_table("dlq_jobs")
