from pathlib import Path

import pytest

from app.providers.base import ProviderError, ProviderInputError
from app.storage import FileJobStore
from api_test_support import (
    APPROVED_STATE,
    approve_job,
    load_only_job,
    make_client,
    upload_job,
)


def test_upload_persists_client_request_identity(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    request_id = "08b8ce83-8423-4fe6-8aa1-966d6710ad74"

    response = upload_job(client, upload_request_id=request_id)

    assert response.status_code == 201
    assert response.json()["upload_request_id"] == request_id
    assert load_only_job(tmp_path).upload_request_id == request_id


def test_processing_queue_pages_unarchived_jobs_in_stable_order(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    job_ids = [
        upload_job(client, filename=f"queue-{index}.png").json()["id"]
        for index in range(4)
    ]
    approve_job(client, job_ids[1])
    client.put("/api/history", json={"job_ids": [job_ids[1]]})
    benchmark_only_id = upload_job(
        client,
        filename="benchmark-only.png",
    ).json()["id"]
    store = FileJobStore(tmp_path)
    benchmark_only = store.get(benchmark_only_id)
    benchmark_only.parser_result = None
    benchmark_only.approved_state = APPROVED_STATE
    benchmark_only.benchmark_included = True
    benchmark_only.status = "approved"
    store.save(benchmark_only)

    first_page = client.get("/api/jobs?limit=2")
    second_page = client.get("/api/jobs?limit=2&offset=2")
    changed_job = store.get(job_ids[2])
    changed_job.error = "Needs another look"
    store.save(changed_job)
    changed_page = client.get("/api/jobs?limit=2")

    assert first_page.status_code == 200
    assert second_page.status_code == 200
    assert first_page.json()["total"] == 3
    assert [job["id"] for job in first_page.json()["jobs"]] == [
        job_ids[0],
        job_ids[2],
    ]
    assert [job["id"] for job in second_page.json()["jobs"]] == [job_ids[3]]
    assert first_page.json()["snapshot_version"] == second_page.json()["snapshot_version"]
    assert changed_page.json()["snapshot_version"] != first_page.json()["snapshot_version"]
    assert client.get("/api/jobs?offset=-1").status_code == 422


def test_processing_queue_keeps_mutated_benchmark_imports(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FailingProvider:
        name = "failing"
        required_fields = ["hero_cards", "street"]

        def required_fields_for(self, state: object):
            return self.required_fields

        def recommend(self, request: object):
            raise ProviderError("provider exploded")

    client = make_client(tmp_path)
    pristine_id = upload_job(client, filename="pristine-import.png").json()["id"]
    decision_id = upload_job(client, filename="decision-import.png").json()["id"]
    failed_id = upload_job(client, filename="failed-import.png").json()["id"]
    store = FileJobStore(tmp_path)
    for job_id in (pristine_id, decision_id, failed_id):
        approve_job(client, job_id)
        imported_job = store.get(job_id)
        imported_job.parser_result = None
        imported_job.benchmark_included = True
        store.save(imported_job)

    decision = client.put(
        f"/api/jobs/{decision_id}/decision",
        json={"action": "call", "sizing": None, "certainty": "medium"},
    )
    monkeypatch.setattr("app.bootstrap.build_provider", lambda settings: FailingProvider())
    failed_recommendation = client.post(f"/api/jobs/{failed_id}/recommend")
    queue = client.get("/api/jobs")

    assert decision.status_code == 200
    assert failed_recommendation.status_code == 502
    assert queue.status_code == 200
    assert queue.json()["total"] == 2
    assert [job["id"] for job in queue.json()["jobs"]] == [decision_id, failed_id]
    assert queue.json()["jobs"][0]["training_decision"]["action"] == "call"
    assert queue.json()["jobs"][1]["status"] == "error"
    assert queue.json()["jobs"][1]["error"] == "provider exploded"


def test_processing_queue_keeps_correctable_benchmark_attempts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class CorrectableProvider:
        name = "correctable"
        required_fields = ["hero_cards", "street"]

        def required_fields_for(self, state: object):
            return self.required_fields

        def recommend(self, request: object):
            raise ProviderInputError("Add the missing table context")

    client = make_client(tmp_path)
    job_id = upload_job(client, filename="correctable-import.png").json()["id"]
    approve_job(client, job_id)
    store = FileJobStore(tmp_path)
    imported_job = store.get(job_id)
    imported_job.parser_result = None
    imported_job.benchmark_included = True
    store.save(imported_job)
    monkeypatch.setattr("app.bootstrap.build_provider", lambda settings: CorrectableProvider())

    recommendation = client.post(
        f"/api/jobs/{job_id}/recommend",
        headers={"X-Recommendation-Request-ID": "correctable-attempt"},
    )
    queue = client.get("/api/jobs")

    assert recommendation.status_code == 422
    assert queue.status_code == 200
    assert queue.json()["total"] == 1
    assert queue.json()["jobs"][0]["id"] == job_id
    assert queue.json()["jobs"][0]["recommendation_request_id"] == (
        "correctable-attempt"
    )


def test_job_metadata_is_normalized_persisted_and_searchable(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client, filename="anonymous-table.png").json()["id"]

    updated = client.put(
        f"/api/jobs/{job_id}/metadata",
        json={
            "title": "  Tricky turn decision  ",
            "notes": "  Villain had been playing aggressively.  ",
            "tags": [" Turn ", "Study", "turn", ""],
        },
    )

    assert updated.status_code == 200
    assert updated.json()["title"] == "Tricky turn decision"
    assert updated.json()["notes"] == "Villain had been playing aggressively."
    assert updated.json()["tags"] == ["Turn", "Study"]
    persisted = FileJobStore(tmp_path).get(job_id)
    assert persisted.title == "Tricky turn decision"
    assert persisted.notes == "Villain had been playing aggressively."
    assert persisted.tags == ["Turn", "Study"]

    approve_job(client, job_id)
    client.put("/api/history", json={"job_ids": [job_id]})
    for query in ("tricky decision", "aggressively", "study"):
        result = client.get("/api/history", params={"query": query})
        assert result.status_code == 200
        assert [job["id"] for job in result.json()["jobs"]] == [job_id]

    cleared = client.put(
        f"/api/jobs/{job_id}/metadata",
        json={"title": " ", "notes": "", "tags": []},
    )
    assert cleared.status_code == 200
    assert cleared.json()["title"] is None
    assert cleared.json()["notes"] is None
    assert cleared.json()["tags"] == []


def test_job_metadata_rejects_oversized_excess_or_ambiguous_tags(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]

    oversized = client.put(
        f"/api/jobs/{job_id}/metadata",
        json={"title": None, "notes": None, "tags": ["x" * 33]},
    )
    excessive = client.put(
        f"/api/jobs/{job_id}/metadata",
        json={
            "title": None,
            "notes": None,
            "tags": [f"tag-{index}" for index in range(11)],
        },
    )
    comma_separated = client.put(
        f"/api/jobs/{job_id}/metadata",
        json={"title": None, "notes": None, "tags": ["turn,river"]},
    )

    assert oversized.status_code == 422
    assert excessive.status_code == 422
    assert comma_separated.status_code == 422
    assert FileJobStore(tmp_path).get(job_id).tags == []


def test_delete_removes_unarchivable_job_and_image(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client, filename="incomplete-table.png").json()["id"]
    job_dir = tmp_path / "jobs" / job_id

    deleted = client.delete(f"/api/jobs/{job_id}")

    assert deleted.status_code == 204
    assert deleted.content == b""
    assert not job_dir.exists()
    assert client.get(f"/api/jobs/{job_id}").status_code == 404
    assert client.get(f"/api/jobs/{job_id}/image").status_code == 404
    assert client.get("/api/jobs").json()["total"] == 0
    assert client.delete(f"/api/jobs/{job_id}").status_code == 404


def test_delete_removes_archived_job_from_history(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    client.put("/api/history", json={"job_ids": [job_id]})

    deleted = client.delete(f"/api/jobs/{job_id}")

    assert deleted.status_code == 204
    assert client.get("/api/history").json()["total"] == 0
