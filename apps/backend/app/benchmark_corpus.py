from collections import Counter

from app.models import JobRecord


def benchmark_layout_profile(
    job: JobRecord,
    default_layout_profile: str,
) -> str:
    return job.parser_layout_profile or default_layout_profile


def benchmark_jobs_for_layout(
    jobs: list[JobRecord],
    layout_profile: str,
    default_layout_profile: str,
) -> list[JobRecord]:
    return [
        job
        for job in jobs
        if job.benchmark_included
        and benchmark_layout_profile(job, default_layout_profile) == layout_profile
    ]


def benchmark_layout_counts(
    jobs: list[JobRecord],
    default_layout_profile: str,
) -> dict[str, int]:
    return dict(
        sorted(
            Counter(
                benchmark_layout_profile(job, default_layout_profile)
                for job in jobs
                if job.benchmark_included
            ).items()
        )
    )
