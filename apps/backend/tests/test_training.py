from datetime import datetime, timezone

import pytest

from app.models import (
    CanonicalState,
    Card,
    JobRecord,
    RecommendationAction,
    RecommendationResult,
    Street,
    TrainingCertainty,
    TrainingDecision,
)
from app.training import build_training_lessons_markdown, summarize_training


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
    training_review_note: str | None = None,
    decision_certainty: TrainingCertainty | None = None,
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
            certainty=decision_certainty,
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
        training_review_note=training_review_note,
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
    assert progress.trend is not None
    assert progress.trend.window_hands == 1
    assert progress.trend.action_accuracy_delta == -1
    assert progress.trend.exact_accuracy_delta == 0
    assert progress.trend.average_ev_loss_delta_bb is None
    assert len(progress.action_differences) == 1
    assert progress.action_differences[0].decision_action == "fold"
    assert progress.action_differences[0].recommended_action == "call"
    assert progress.action_differences[0].hands == 1
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
    assert progress.review_street_counts == {"flop": 1, "turn": 1}
    assert progress.review_queue_hands == 2
    assert [hand.job_id for hand in progress.review_queue] == ["3" * 32, "2" * 32]


def test_summarize_training_calibrates_self_rated_certainty() -> None:
    candidates = {
        "candidates": [
            {"action": "fold", "sizing": None, "ev": 0.0},
            {"action": "call", "sizing": None, "ev": 1.0},
        ]
    }
    jobs = [
        reviewed_job(
            "1" * 32,
            "flop",
            "call",
            "call",
            datetime(2026, 7, 1, tzinfo=timezone.utc),
            recommendation_raw=candidates,
            decision_certainty="low",
        ),
        reviewed_job(
            "2" * 32,
            "turn",
            "fold",
            "call",
            datetime(2026, 7, 2, tzinfo=timezone.utc),
            recommendation_raw=candidates,
            decision_certainty="high",
        ),
        reviewed_job(
            "3" * 32,
            "river",
            "call",
            "call",
            datetime(2026, 7, 3, tzinfo=timezone.utc),
            recommendation_raw=candidates,
            decision_certainty="high",
        ),
        reviewed_job(
            "4" * 32,
            "preflop",
            "call",
            "call",
            datetime(2026, 7, 4, tzinfo=timezone.utc),
        ),
    ]

    progress = summarize_training(jobs)

    assert [summary.certainty for summary in progress.certainty_summaries] == [
        "low",
        "high",
    ]
    low, high = progress.certainty_summaries
    assert low.hands == 1
    assert low.needs_review_hands == 0
    assert low.action_accuracy == 1
    assert low.exact_accuracy == 1
    assert low.average_ev_loss_bb == 0
    assert high.hands == 2
    assert high.needs_review_hands == 1
    assert high.action_accuracy == 0.5
    assert high.exact_accuracy == 0.5
    assert high.ev_compared_hands == 2
    assert high.average_ev_loss_bb == 0.5
    assert progress.unrated_hands == 1
    assert progress.unrated_needs_review_hands == 0
    assert progress.recent_hands[0].decision_certainty is None
    assert progress.recent_hands[1].decision_certainty == "high"


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


def test_summarize_training_lists_completed_lesson_notes_by_review_time() -> None:
    jobs = [
        reviewed_job(
            "1" * 32,
            "flop",
            "fold",
            "call",
            datetime(2026, 7, 1, tzinfo=timezone.utc),
            training_reviewed_at=datetime(2026, 7, 10, tzinfo=timezone.utc),
            training_review_note="Respect the call price.",
        ),
        reviewed_job(
            "2" * 32,
            "turn",
            "fold",
            "raise",
            datetime(2026, 7, 2, tzinfo=timezone.utc),
            training_reviewed_at=datetime(2026, 7, 12, tzinfo=timezone.utc),
            training_review_note="Check blockers before folding.",
        ),
        reviewed_job(
            "3" * 32,
            "river",
            "call",
            "raise",
            datetime(2026, 7, 3, tzinfo=timezone.utc),
            training_review_note="This reopened note is still being revised.",
        ),
        reviewed_job(
            "4" * 32,
            "preflop",
            "call",
            "call",
            datetime(2026, 7, 4, tzinfo=timezone.utc),
            training_reviewed_at=datetime(2026, 7, 13, tzinfo=timezone.utc),
        ),
    ]

    progress = summarize_training(jobs, recent_limit=1, lesson_limit=1)

    assert progress.lesson_count == 2
    assert progress.lesson_matching_hands == 2
    assert len(progress.lesson_hands) == 1
    assert progress.lesson_hands[0].job_id == "2" * 32
    assert progress.lesson_hands[0].review_note == "Check blockers before folding."

    filtered = summarize_training(
        jobs,
        lesson_street="turn",
        lesson_query="BLOCKERS",
    )

    assert filtered.lesson_count == 2
    assert filtered.lesson_matching_hands == 1
    assert [hand.job_id for hand in filtered.lesson_hands] == ["2" * 32]

    unmatched = summarize_training(
        jobs,
        lesson_street="flop",
        lesson_query="blockers",
    )

    assert unmatched.lesson_count == 2
    assert unmatched.lesson_matching_hands == 0
    assert unmatched.lesson_hands == []

    document, exported_count = build_training_lessons_markdown(
        jobs,
        lesson_street="turn",
        lesson_query="BLOCKERS",
    )

    assert exported_count == 1
    assert document.startswith("# Poker Hero Lessons\n")
    assert "1 saved lesson note." in document
    assert "## Ah Kd - Turn" in document
    assert "- Board: Not recorded" in document
    assert "- You: Fold" in document
    assert "- Solver: Raise" in document
    assert "> Check blockers before folding." in document
    assert "Respect the call price." not in document


def test_training_lesson_export_uses_safe_code_span_delimiters() -> None:
    job = reviewed_job(
        "1" * 32,
        "flop",
        "check",
        "check",
        datetime(2026, 7, 1, tzinfo=timezone.utc),
        training_reviewed_at=datetime(2026, 7, 2, tzinfo=timezone.utc),
        training_review_note="Keep the metadata literal.",
    )
    job.original_filename = "`table`<strong>unsafe</strong>.png"
    assert job.approved_state is not None
    job.approved_state.hero_position = "cut``off"

    document, exported_count = build_training_lessons_markdown([job])

    assert exported_count == 1
    assert "- Source: `` `table`<strong>unsafe</strong>.png ``" in document
    assert "- Position: ```cut``off```" in document
    assert "\\`" not in document


def test_training_lessons_can_prioritize_ev_loss_before_display_limit() -> None:
    highest_loss = reviewed_job(
        "1" * 32,
        "flop",
        "fold",
        "call",
        datetime(2026, 7, 1, tzinfo=timezone.utc),
        recommendation_raw={
            "candidates": [
                {"action": "fold", "sizing": None, "ev": -2.0},
                {"action": "call", "sizing": None, "ev": 0.0},
            ]
        },
        training_reviewed_at=datetime(2026, 7, 10, tzinfo=timezone.utc),
        training_review_note="Study the highest-loss fold.",
    )
    lower_loss = reviewed_job(
        "2" * 32,
        "turn",
        "fold",
        "call",
        datetime(2026, 7, 2, tzinfo=timezone.utc),
        recommendation_raw={
            "candidates": [
                {"action": "fold", "sizing": None, "ev": -0.5},
                {"action": "call", "sizing": None, "ev": 0.0},
            ]
        },
        training_reviewed_at=datetime(2026, 7, 12, tzinfo=timezone.utc),
        training_review_note="Study the lower-loss fold.",
    )
    ungraded = reviewed_job(
        "3" * 32,
        "river",
        "fold",
        "call",
        datetime(2026, 7, 3, tzinfo=timezone.utc),
        training_reviewed_at=datetime(2026, 7, 14, tzinfo=timezone.utc),
        training_review_note="Keep ungraded lessons available.",
    )
    highest_loss.original_filename = "highest-loss.png"
    lower_loss.original_filename = "lower-loss.png"
    ungraded.original_filename = "ungraded.png"
    jobs = [highest_loss, lower_loss, ungraded]

    recent = summarize_training(jobs, lesson_limit=2)
    prioritized = summarize_training(
        jobs,
        lesson_limit=2,
        lesson_order="ev_loss",
    )
    document, exported_count = build_training_lessons_markdown(
        jobs,
        lesson_order="ev_loss",
    )

    assert [hand.job_id for hand in recent.lesson_hands] == [
        ungraded.id,
        lower_loss.id,
    ]
    assert [hand.job_id for hand in prioritized.lesson_hands] == [
        highest_loss.id,
        lower_loss.id,
    ]
    assert exported_count == 3
    assert document.index("highest-loss.png") < document.index("lower-loss.png")
    assert document.index("lower-loss.png") < document.index("ungraded.png")


def test_summarize_training_compares_equal_recent_windows() -> None:
    candidates = {
        "candidates": [
            {"action": "fold", "sizing": None, "ev": 0.0},
            {"action": "call", "sizing": None, "ev": 1.0},
        ]
    }
    jobs = [
        reviewed_job(
            f"{index:032x}",
            "flop",
            "fold" if index < 2 else "call",
            "call",
            datetime(2026, 7, index + 1, tzinfo=timezone.utc),
            recommendation_raw=candidates,
        )
        for index in range(4)
    ]

    progress = summarize_training(jobs)

    assert progress.trend is not None
    assert progress.trend.window_hands == 2
    assert progress.trend.recent_action_accuracy == 1
    assert progress.trend.previous_action_accuracy == 0
    assert progress.trend.action_accuracy_delta == 1
    assert progress.trend.recent_exact_accuracy == 1
    assert progress.trend.previous_exact_accuracy == 0
    assert progress.trend.exact_accuracy_delta == 1
    assert progress.trend.recent_ev_compared_hands == 2
    assert progress.trend.previous_ev_compared_hands == 2
    assert progress.trend.recent_average_ev_loss_bb == 0
    assert progress.trend.previous_average_ev_loss_bb == 1
    assert progress.trend.average_ev_loss_delta_bb == -1


def test_summarize_training_groups_and_orders_action_differences() -> None:
    jobs = [
        reviewed_job(
            "1" * 32,
            "flop",
            "fold",
            "call",
            datetime(2026, 7, 1, tzinfo=timezone.utc),
            recommendation_raw={
                "candidates": [
                    {"action": "fold", "sizing": None, "ev": 0.0},
                    {"action": "call", "sizing": None, "ev": 1.2},
                ]
            },
        ),
        reviewed_job(
            "2" * 32,
            "turn",
            "fold",
            "call",
            datetime(2026, 7, 2, tzinfo=timezone.utc),
            training_reviewed_at=datetime(2026, 7, 6, tzinfo=timezone.utc),
        ),
        reviewed_job(
            "3" * 32,
            "river",
            "raise",
            "call",
            datetime(2026, 7, 3, tzinfo=timezone.utc),
            decision_sizing=4,
            recommendation_raw={
                "candidates": [
                    {"action": "raise", "sizing": 4, "ev": 0.0},
                    {"action": "call", "sizing": None, "ev": 2.0},
                ]
            },
        ),
        reviewed_job(
            "4" * 32,
            "river",
            "check",
            "bet",
            datetime(2026, 7, 4, tzinfo=timezone.utc),
            recommended_sizing=3,
        ),
        reviewed_job(
            "5" * 32,
            "river",
            "raise",
            "call",
            datetime(2026, 7, 5, tzinfo=timezone.utc),
            decision_sizing=4,
            recommendation_raw={
                "candidates": [
                    {
                        "action": "raise",
                        "sizing": 4,
                        "frequency": 0.2,
                    },
                    {
                        "action": "call",
                        "sizing": None,
                        "frequency": 0.8,
                    },
                ]
            },
        ),
    ]

    progress = summarize_training(jobs)
    raise_to_call = summarize_training(
        jobs,
        review_action_difference=("raise", "call"),
    )

    assert [
        (
            difference.decision_action,
            difference.recommended_action,
            difference.hands,
        )
        for difference in progress.action_differences
    ] == [
        ("fold", "call", 2),
        ("raise", "call", 1),
        ("check", "bet", 1),
    ]
    fold_to_call = progress.action_differences[0]
    assert fold_to_call.needs_review_hands == 1
    assert fold_to_call.ev_compared_hands == 1
    assert fold_to_call.average_ev_loss_bb == 1.2
    assert progress.action_differences[1].average_ev_loss_bb == 2
    assert progress.action_differences[2].average_ev_loss_bb is None
    assert raise_to_call.review_queue_hands == 1
    assert [hand.job_id for hand in raise_to_call.review_queue] == ["3" * 32]


def test_summarize_training_prioritizes_pending_action_differences() -> None:
    reviewed_at = datetime(2026, 7, 10, tzinfo=timezone.utc)
    actions = [
        ("fold", "call", reviewed_at),
        ("fold", "call", reviewed_at),
        ("fold", "call", reviewed_at),
        ("check", "bet", reviewed_at),
        ("check", "bet", reviewed_at),
        ("call", "raise", reviewed_at),
        ("bet", "raise", None),
    ]
    jobs = [
        reviewed_job(
            f"{index:032x}",
            "flop",
            decision_action,
            recommended_action,
            datetime(2026, 7, index, tzinfo=timezone.utc),
            training_reviewed_at=training_reviewed_at,
        )
        for index, (
            decision_action,
            recommended_action,
            training_reviewed_at,
        ) in enumerate(actions, start=1)
    ]

    progress = summarize_training(jobs)

    assert [
        (
            difference.decision_action,
            difference.recommended_action,
            difference.hands,
            difference.needs_review_hands,
        )
        for difference in progress.action_differences
    ] == [
        ("bet", "raise", 1, 1),
        ("fold", "call", 3, 0),
        ("check", "bet", 2, 0),
        ("call", "raise", 1, 0),
    ]


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
    assert progress.review_queue_hands == 4
    assert len(progress.recent_hands) == 1
    assert [hand.job_id for hand in progress.review_queue] == [f"{3:032x}", f"{2:032x}"]


def test_summarize_training_prioritizes_review_queue_by_ev_loss() -> None:
    jobs = [
        reviewed_job(
            "1" * 32,
            "flop",
            "fold",
            "call",
            datetime(2026, 7, 5, tzinfo=timezone.utc),
            recommendation_raw={
                "candidates": [
                    {"action": "fold", "sizing": None, "ev": 0.0},
                    {"action": "call", "sizing": None, "ev": 1.2},
                ]
            },
        ),
        reviewed_job(
            "2" * 32,
            "turn",
            "fold",
            "call",
            datetime(2026, 7, 6, tzinfo=timezone.utc),
            recommendation_raw={
                "candidates": [
                    {"action": "fold", "sizing": None, "ev": 0.0},
                    {"action": "call", "sizing": None, "ev": 0.2},
                ]
            },
        ),
        reviewed_job(
            "3" * 32,
            "river",
            "fold",
            "call",
            datetime(2026, 7, 7, tzinfo=timezone.utc),
        ),
    ]

    progress = summarize_training(jobs, review_limit=2, review_order="ev_loss")
    complete_queue = summarize_training(jobs, review_limit=3, review_order="ev_loss")

    assert progress.needs_review_hands == 3
    assert [hand.job_id for hand in progress.recent_hands] == [
        "3" * 32,
        "2" * 32,
        "1" * 32,
    ]
    assert [hand.job_id for hand in progress.review_queue] == [
        "1" * 32,
        "2" * 32,
    ]
    assert [hand.ev_loss_bb for hand in progress.review_queue] == [1.2, 0.2]
    assert [hand.job_id for hand in complete_queue.review_queue] == [
        "1" * 32,
        "2" * 32,
        "3" * 32,
    ]
    assert complete_queue.review_queue[2].ev_loss_bb is None


def test_summarize_training_filters_review_street_before_ordering_and_limit() -> None:
    jobs = [
        reviewed_job(
            "1" * 32,
            "flop",
            "fold",
            "call",
            datetime(2026, 7, 5, tzinfo=timezone.utc),
            recommendation_raw={
                "candidates": [
                    {"action": "fold", "sizing": None, "ev": 0.0},
                    {"action": "call", "sizing": None, "ev": 0.4},
                ]
            },
        ),
        reviewed_job(
            "2" * 32,
            "turn",
            "fold",
            "call",
            datetime(2026, 7, 7, tzinfo=timezone.utc),
            recommendation_raw={
                "candidates": [
                    {"action": "fold", "sizing": None, "ev": 0.0},
                    {"action": "call", "sizing": None, "ev": 2.0},
                ]
            },
        ),
        reviewed_job(
            "3" * 32,
            "flop",
            "fold",
            "call",
            datetime(2026, 7, 6, tzinfo=timezone.utc),
            recommendation_raw={
                "candidates": [
                    {"action": "fold", "sizing": None, "ev": 0.0},
                    {"action": "call", "sizing": None, "ev": 0.8},
                ]
            },
        ),
    ]

    progress = summarize_training(
        jobs,
        review_limit=1,
        review_order="ev_loss",
        review_street="flop",
    )

    assert progress.needs_review_hands == 3
    assert progress.review_street_counts == {"flop": 2, "turn": 1}
    assert progress.review_queue_hands == 2
    assert [hand.job_id for hand in progress.review_queue] == ["3" * 32]
    assert [hand.job_id for hand in progress.recent_hands] == [
        "2" * 32,
        "3" * 32,
        "1" * 32,
    ]


def test_summarize_training_filters_pending_reviews_by_certainty() -> None:
    jobs = [
        reviewed_job(
            "1" * 32,
            "flop",
            "fold",
            "call",
            datetime(2026, 7, 5, tzinfo=timezone.utc),
            decision_certainty="high",
        ),
        reviewed_job(
            "2" * 32,
            "turn",
            "fold",
            "call",
            datetime(2026, 7, 6, tzinfo=timezone.utc),
            decision_certainty="low",
        ),
        reviewed_job(
            "3" * 32,
            "river",
            "fold",
            "call",
            datetime(2026, 7, 7, tzinfo=timezone.utc),
        ),
    ]

    high = summarize_training(jobs, review_certainty="high")
    unrated = summarize_training(jobs, review_certainty="unrated")

    assert high.needs_review_hands == 3
    assert high.review_queue_hands == 1
    assert [hand.job_id for hand in high.review_queue] == ["1" * 32]
    assert high.review_queue[0].decision_certainty == "high"
    assert unrated.needs_review_hands == 3
    assert unrated.review_queue_hands == 1
    assert [hand.job_id for hand in unrated.review_queue] == ["3" * 32]
    assert unrated.review_queue[0].decision_certainty is None
    assert unrated.unrated_hands == 1
    assert unrated.unrated_needs_review_hands == 1


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
    assert progress.review_queue_hands == 1
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


def test_summarize_training_reports_available_candidate_ev_loss() -> None:
    jobs = [
        reviewed_job(
            "d" * 32,
            "flop",
            "call",
            "raise",
            datetime(2026, 7, 13, tzinfo=timezone.utc),
            recommended_sizing=8,
            recommendation_raw={
                "candidates": [
                    {"action": "fold", "sizing": None, "ev": 0.0},
                    {"action": "call", "sizing": None, "ev": 2.7},
                    {"action": "raise", "sizing": 8, "ev": 2.82},
                ]
            },
        ),
        reviewed_job(
            "e" * 32,
            "flop",
            "raise",
            "raise",
            datetime(2026, 7, 14, tzinfo=timezone.utc),
            decision_sizing=8,
            recommended_sizing=8,
            recommendation_raw={
                "candidates": [
                    {"action": "call", "sizing": None, "ev": 2.8},
                    {"action": "raise", "sizing": 8, "ev": 2.82},
                ]
            },
        ),
        reviewed_job(
            "f" * 32,
            "turn",
            "bet",
            "bet",
            datetime(2026, 7, 15, tzinfo=timezone.utc),
            decision_sizing=6,
            recommended_sizing=6,
            recommendation_raw={
                "candidates": [
                    {"action": "check", "sizing": None, "ev": 1.4},
                    {"action": "bet", "sizing": 5, "ev": 1.5},
                ]
            },
        ),
    ]

    progress = summarize_training(jobs)

    assert progress.ev_compared_hands == 2
    assert progress.average_ev_loss_bb == pytest.approx(0.06)
    assert progress.recent_hands[1].ev_loss_bb == 0
    assert progress.recent_hands[2].ev_loss_bb == pytest.approx(0.12)
    assert progress.recent_hands[0].ev_loss_bb is None
    assert progress.street_summaries[0].ev_compared_hands == 2
    assert progress.street_summaries[0].average_ev_loss_bb == pytest.approx(0.06)
    assert progress.street_summaries[1].ev_compared_hands == 0
    assert progress.street_summaries[1].average_ev_loss_bb is None


def test_summarize_training_rejects_malformed_candidate_ev_metadata() -> None:
    jobs = [
        reviewed_job(
            f"{index + 16:032x}",
            "river",
            "call",
            "raise",
            datetime(2026, 7, 16 + index, tzinfo=timezone.utc),
            recommended_sizing=8,
            recommendation_raw={"candidates": candidates},
        )
        for index, candidates in enumerate(
            [
                [{"action": "call", "sizing": None, "ev": "2.4"}],
                [{"action": "call", "ev": 2.4}],
                [{"action": "call", "sizing": 0, "ev": 2.4}],
                [{"action": "unknown", "sizing": None, "ev": 2.4}],
                [{"action": "call", "sizing": None, "ev": float("nan")}],
                [{"action": "call", "sizing": None, "ev": 2.4}],
                [
                    {"action": "fold", "sizing": None, "ev": 0.0},
                    {"action": "call", "sizing": None, "ev": 2.4},
                ],
            ]
        )
    ]

    progress = summarize_training(jobs)

    assert progress.ev_compared_hands == 0
    assert progress.average_ev_loss_bb is None
    assert all(hand.ev_loss_bb is None for hand in progress.recent_hands)


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
        ),
        reviewed_job(
            "c" * 32,
            "turn",
            "call",
            "raise",
            datetime(2026, 7, 12, tzinfo=timezone.utc),
            recommended_sizing=8,
            recommendation_raw={
                "candidates": [
                    {"action": "call", "frequency": 0.2},
                ]
            },
        ),
    ]

    progress = summarize_training(jobs)

    assert progress.action_matches == 0
    assert progress.exact_matches == 0
    assert progress.different_actions == 2
    assert progress.needs_review_hands == 2
    assert [hand.outcome for hand in progress.recent_hands] == [
        "different",
        "different",
    ]


def test_summarize_training_handles_empty_history() -> None:
    progress = summarize_training([])

    assert progress.reviewed_hands == 0
    assert progress.needs_review_hands == 0
    assert progress.action_accuracy == 0
    assert progress.exact_accuracy == 0
    assert progress.ev_compared_hands == 0
    assert progress.average_ev_loss_bb is None
    assert progress.street_summaries == []
    assert progress.recent_hands == []
    assert progress.review_queue == []
