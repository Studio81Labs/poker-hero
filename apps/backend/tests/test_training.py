from datetime import datetime, timezone

import pytest

from app.models import (
    CanonicalState,
    Card,
    JobRecord,
    RecommendationAction,
    RecommendationResult,
    Street,
    TrainingDecision,
)
from app.training import summarize_training


def reviewed_job(
    job_id: str,
    street: Street,
    decision_action: RecommendationAction,
    recommended_action: RecommendationAction,
    recorded_at: datetime,
    decision_sizing: float | None = None,
    recommended_sizing: float | None = None,
    recommendation_raw: dict[str, object] | None = None,
    training_reviewed_at: datetime | None = None,
) -> JobRecord:
    return JobRecord(
        id=job_id,
        status="recommended",
        original_filename=f"{street}.png",
        image_filename="original.png",
        parser_provider="mock",
        recommendation_provider="mock",
        approved_state=CanonicalState(
            hero_cards=[Card.from_code("Ah"), Card.from_code("Kd")],
            street=street,
            user_approved=True,
        ),
        training_decision=TrainingDecision(
            action=decision_action,
            sizing=decision_sizing,
            recorded_at=recorded_at,
        ),
        recommendation=RecommendationResult(
            action=recommended_action,
            sizing=recommended_sizing,
            confidence=0.8,
            explanation="Test recommendation",
            raw=recommendation_raw or {},
        ),
        training_reviewed_at=training_reviewed_at,
    )


def test_summarize_training_scores_actions_sizes_streets_and_recency() -> None:
    jobs = [
        reviewed_job(
            "1" * 32,
            "preflop",
            "call",
            "call",
            datetime(2026, 7, 1, tzinfo=timezone.utc),
        ),
        reviewed_job(
            "2" * 32,
            "flop",
            "bet",
            "bet",
            datetime(2026, 7, 2, tzinfo=timezone.utc),
            decision_sizing=5,
            recommended_sizing=6,
        ),
        reviewed_job(
            "3" * 32,
            "turn",
            "fold",
            "call",
            datetime(2026, 7, 3, tzinfo=timezone.utc),
        ),
        JobRecord(
            id="4" * 32,
            original_filename="incomplete.png",
            image_filename="original.png",
            parser_provider="mock",
            recommendation_provider="mock",
            training_decision=TrainingDecision(action="check"),
        ),
    ]

    progress = summarize_training(jobs)

    assert progress.reviewed_hands == 3
    assert progress.action_matches == 2
    assert progress.exact_matches == 1
    assert progress.different_actions == 1
    assert progress.needs_review_hands == 2
    assert progress.action_accuracy == pytest.approx(2 / 3)
    assert progress.exact_accuracy == pytest.approx(1 / 3)
    assert [summary.street for summary in progress.street_summaries] == [
        "preflop",
        "flop",
        "turn",
    ]
    assert [hand.job_id for hand in progress.recent_hands] == [
        "3" * 32,
        "2" * 32,
        "1" * 32,
    ]
    assert [hand.outcome for hand in progress.recent_hands] == [
        "different",
        "same_action",
        "match",
    ]
    assert [hand.job_id for hand in progress.review_queue] == ["3" * 32, "2" * 32]


def test_summarize_training_limits_recent_hands() -> None:
    jobs = [
        reviewed_job(
            f"{index:032x}",
            "river",
            "check",
            "check",
            datetime(2026, 7, index + 1, tzinfo=timezone.utc),
        )
        for index in range(4)
    ]

    progress = summarize_training(jobs, recent_limit=2)

    assert progress.reviewed_hands == 4
    assert len(progress.recent_hands) == 2
    assert progress.recent_hands[0].job_id == f"{3:032x}"


def test_summarize_training_limits_review_queue_independently() -> None:
    jobs = [
        reviewed_job(
            f"{index:032x}",
            "turn",
            "raise",
            "call",
            datetime(2026, 7, index + 1, tzinfo=timezone.utc),
            decision_sizing=4,
        )
        for index in range(4)
    ]

    progress = summarize_training(jobs, recent_limit=1, review_limit=2)

    assert progress.needs_review_hands == 4
    assert len(progress.recent_hands) == 1
    assert [hand.job_id for hand in progress.review_queue] == [f"{3:032x}", f"{2:032x}"]


def test_summarize_training_excludes_completed_reviews_from_pending_queue() -> None:
    completed_at = datetime(2026, 7, 10, tzinfo=timezone.utc)
    jobs = [
        reviewed_job(
            "7" * 32,
            "turn",
            "raise",
            "call",
            datetime(2026, 7, 7, tzinfo=timezone.utc),
            decision_sizing=5,
            training_reviewed_at=completed_at,
        ),
        reviewed_job(
            "8" * 32,
            "river",
            "bet",
            "bet",
            datetime(2026, 7, 8, tzinfo=timezone.utc),
            decision_sizing=5,
            recommended_sizing=6,
        ),
    ]

    progress = summarize_training(jobs)

    assert progress.reviewed_hands == 2
    assert progress.needs_review_hands == 1
    assert [hand.job_id for hand in progress.review_queue] == ["8" * 32]
    assert progress.recent_hands[1].reviewed_at == completed_at


def test_summarize_training_applies_sizing_tolerance() -> None:
    jobs = [
        reviewed_job(
            "5" * 32,
            "flop",
            "bet",
            "bet",
            datetime(2026, 7, 5, tzinfo=timezone.utc),
            decision_sizing=5,
            recommended_sizing=5.005,
        ),
        reviewed_job(
            "6" * 32,
            "flop",
            "bet",
            "bet",
            datetime(2026, 7, 6, tzinfo=timezone.utc),
            decision_sizing=5,
            recommended_sizing=5.02,
        ),
    ]

    progress = summarize_training(jobs)

    assert progress.action_matches == 2
    assert progress.exact_matches == 1
    assert [hand.outcome for hand in progress.recent_hands] == ["same_action", "match"]
    assert [hand.job_id for hand in progress.review_queue] == ["6" * 32]


def test_summarize_training_scores_meaningful_solver_mixes() -> None:
    jobs = [
        reviewed_job(
            "9" * 32,
            "turn",
            "raise",
            "call",
            datetime(2026, 7, 9, tzinfo=timezone.utc),
            decision_sizing=8,
            recommendation_raw={
                "candidates": [
                    {"action": "call", "sizing": None, "frequency": 0.8},
                    {"action": "raise", "sizing": 8, "frequency": 0.2},
                ]
            },
        ),
        reviewed_job(
            "a" * 32,
            "river",
            "raise",
            "call",
            datetime(2026, 7, 10, tzinfo=timezone.utc),
            decision_sizing=9,
            recommendation_raw={
                "candidates": [
                    {"action": "call", "sizing": None, "frequency": 0.8},
                    {"action": "raise", "sizing": 8, "frequency": 0.2},
                ]
            },
        ),
    ]

    progress = summarize_training(jobs)

    assert progress.action_matches == 2
    assert progress.exact_matches == 1
    assert progress.different_actions == 0
    assert progress.needs_review_hands == 1
    assert [hand.outcome for hand in progress.recent_hands] == [
        "mixed_action",
        "mixed",
    ]
    assert [hand.job_id for hand in progress.review_queue] == ["a" * 32]


def test_summarize_training_ignores_noise_and_malformed_policy_candidates() -> None:
    jobs = [
        reviewed_job(
            "b" * 32,
            "flop",
            "raise",
            "call",
            datetime(2026, 7, 11, tzinfo=timezone.utc),
            decision_sizing=8,
            recommendation_raw={
                "candidates": [
                    {"action": "raise", "sizing": 8, "frequency": 0.049},
                    {"action": "raise", "sizing": 8, "frequency": "20%"},
                    {"action": "raise", "sizing": None, "frequency": 0.2},
                    {"action": "raise", "sizing": 8, "frequency": True},
                ]
            },
        )
    ]

    progress = summarize_training(jobs)

    assert progress.action_matches == 0
    assert progress.exact_matches == 0
    assert progress.different_actions == 1
    assert progress.needs_review_hands == 1
    assert progress.recent_hands[0].outcome == "different"


def test_summarize_training_handles_empty_history() -> None:
    progress = summarize_training([])

    assert progress.reviewed_hands == 0
    assert progress.needs_review_hands == 0
    assert progress.action_accuracy == 0
    assert progress.exact_accuracy == 0
    assert progress.street_summaries == []
    assert progress.recent_hands == []
    assert progress.review_queue == []
