import json
from collections import Counter
from hashlib import sha256

from app.models import BENCHMARK_FIELDS, JobRecord


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


def benchmark_corpus_fingerprint(jobs: list[JobRecord]) -> str:
    cases = [
        {
            "approved_state": job.approved_state.model_dump(
                mode="json",
                include=set(BENCHMARK_FIELDS),
            ),
            "job_id": job.id,
        }
        for job in sorted(jobs, key=lambda candidate: candidate.id)
        if job.benchmark_included and job.approved_state is not None
    ]
    payload = json.dumps(
        cases,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256(payload).hexdigest()
