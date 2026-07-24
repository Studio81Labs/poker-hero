import math
import re
from collections import defaultdict
from datetime import datetime
from typing import Any, Literal

from app.models import (
    JobRecord,
    RecommendationAction,
    RecommendationResult,
    Street,
    TrainingActionDifference,
    TrainingCertainty,
    TrainingCertaintySummary,
    TrainingDecision,
    TrainingOutcome,
    TrainingProgress,
    TrainingRecentHand,
    TrainingReviewCertainty,
    TrainingReviewOrder,
    TrainingStreetSummary,
    TrainingTrend,
)


SIZING_MATCH_TOLERANCE = 0.01
MIN_SUPPORTED_FREQUENCY = 0.05
MAX_TREND_WINDOW = 10
STREET_ORDER: tuple[Street, ...] = ("preflop", "flop", "turn", "river")
CERTAINTY_ORDER: tuple[TrainingCertainty, ...] = ("low", "medium", "high")
PolicySupport = Literal["line", "action"]
TrainingActionDifferenceFilter = tuple[RecommendationAction, RecommendationAction]


def training_lesson_jobs(
    jobs: list[JobRecord],
    lesson_street: Street | None = None,
    lesson_query: str | None = None,
) -> list[JobRecord]:
    normalized_query = lesson_query.strip().casefold() if lesson_query else None
    return sorted(
        (
            job
            for job in jobs
            if job.training_decision is not None
            and job.recommendation is not None
            and job.training_reviewed_at is not None
            and job.training_review_note is not None
            and (
                lesson_street is None
                or (
                    job.approved_state is not None
                    and job.approved_state.street == lesson_street
                )
            )
            and (
                not normalized_query
                or normalized_query in job.training_review_note.casefold()
            )
        ),
        key=lambda job: job.training_reviewed_at,
        reverse=True,
    )


def summarize_training(
    jobs: list[JobRecord],
    recent_limit: int = 8,
    lesson_limit: int = 24,
    review_limit: int = 24,
    review_order: TrainingReviewOrder = "recent",
    review_street: Street | None = None,
    review_certainty: TrainingReviewCertainty | None = None,
    review_action_difference: TrainingActionDifferenceFilter | None = None,
    lesson_street: Street | None = None,
    lesson_query: str | None = None,
) -> TrainingProgress:
    reviewed = [
        job
        for job in jobs
        if job.training_decision is not None and job.recommendation is not None
    ]
    outcomes = {job.id: training_outcome(job) for job in reviewed}
    ev_losses = {job.id: training_ev_loss_bb(job) for job in reviewed}
    comparable_ev_losses = [
        loss for loss in ev_losses.values() if loss is not None
    ]
    action_matches = sum(outcome != "different" for outcome in outcomes.values())
    exact_matches = sum(outcome in {"match", "mixed"} for outcome in outcomes.values())
    reviewed_hands = len(reviewed)

    by_street: dict[Street, list[JobRecord]] = defaultdict(list)
    for job in reviewed:
        if job.approved_state is not None and job.approved_state.street is not None:
            by_street[job.approved_state.street].append(job)

    street_summaries = []
    for street in STREET_ORDER:
        street_jobs = by_street.get(street, [])
        if not street_jobs:
            continue
        street_action_matches = sum(outcomes[job.id] != "different" for job in street_jobs)
        street_exact_matches = sum(
            outcomes[job.id] in {"match", "mixed"} for job in street_jobs
        )
        street_total = len(street_jobs)
        street_ev_losses = [
            loss
            for job in street_jobs
            if (loss := ev_losses[job.id]) is not None
        ]
        street_summaries.append(
            TrainingStreetSummary(
                street=street,
                reviewed_hands=street_total,
                action_matches=street_action_matches,
                exact_matches=street_exact_matches,
                action_accuracy=street_action_matches / street_total,
                exact_accuracy=street_exact_matches / street_total,
                ev_compared_hands=len(street_ev_losses),
                average_ev_loss_bb=_average_ev_loss(street_ev_losses),
            )
        )

    certainty_summaries = []
    for certainty in CERTAINTY_ORDER:
        certainty_jobs = [
            job
            for job in reviewed
            if job.training_decision is not None
            and job.training_decision.certainty == certainty
        ]
        if not certainty_jobs:
            continue
        certainty_action_matches = sum(
            outcomes[job.id] != "different" for job in certainty_jobs
        )
        certainty_exact_matches = sum(
            outcomes[job.id] in {"match", "mixed"} for job in certainty_jobs
        )
        certainty_needs_review = sum(
            outcomes[job.id] not in {"match", "mixed"}
            and job.training_reviewed_at is None
            for job in certainty_jobs
        )
        certainty_ev_losses = [
            loss
            for job in certainty_jobs
            if (loss := ev_losses[job.id]) is not None
        ]
        certainty_total = len(certainty_jobs)
        certainty_summaries.append(
            TrainingCertaintySummary(
                certainty=certainty,
                hands=certainty_total,
                action_matches=certainty_action_matches,
                exact_matches=certainty_exact_matches,
                needs_review_hands=certainty_needs_review,
                action_accuracy=certainty_action_matches / certainty_total,
                exact_accuracy=certainty_exact_matches / certainty_total,
                ev_compared_hands=len(certainty_ev_losses),
                average_ev_loss_bb=_average_ev_loss(certainty_ev_losses),
            )
        )

    unrated_jobs = [
        job
        for job in reviewed
        if job.training_decision is not None
        and job.training_decision.certainty is None
    ]
    unrated_needs_review_hands = sum(
        outcomes[job.id] not in {"match", "mixed"}
        and job.training_reviewed_at is None
        for job in unrated_jobs
    )

    newest_first = sorted(reviewed, key=_training_recorded_at, reverse=True)
    trend = _training_trend(newest_first, outcomes, ev_losses)
    action_differences = _action_differences(reviewed, outcomes, ev_losses)
    recent_hands = [
        _recent_hand(job, outcomes[job.id], ev_losses[job.id])
        for job in newest_first[: max(0, recent_limit)]
    ]
    lesson_jobs = training_lesson_jobs(reviewed)
    filtered_lesson_jobs = training_lesson_jobs(
        reviewed,
        lesson_street=lesson_street,
        lesson_query=lesson_query,
    )
    lesson_hands = [
        _recent_hand(job, outcomes[job.id], ev_losses[job.id])
        for job in filtered_lesson_jobs[: max(0, lesson_limit)]
    ]
    pending_review_jobs = [
        job
        for job in newest_first
        if outcomes[job.id] not in {"match", "mixed"}
        and job.training_reviewed_at is None
    ]
    review_street_counts: dict[Street, int] = defaultdict(int)
    for job in pending_review_jobs:
        if job.approved_state is not None and job.approved_state.street is not None:
            review_street_counts[job.approved_state.street] += 1
    filtered_review_jobs = [
        job
        for job in pending_review_jobs
        if (
            review_street is None
            or (
                job.approved_state is not None
                and job.approved_state.street == review_street
            )
        )
        and (
            review_certainty is None
            or (
                job.training_decision is not None
                and (
                    (
                        review_certainty == "unrated"
                        and job.training_decision.certainty is None
                    )
                    or job.training_decision.certainty == review_certainty
                )
            )
        )
        and (
            review_action_difference is None
            or (
                outcomes[job.id] == "different"
                and job.training_decision is not None
                and job.recommendation is not None
                and (
                    job.training_decision.action,
                    job.recommendation.action,
                )
                == review_action_difference
            )
        )
    ]
    if review_order == "ev_loss":
        filtered_review_jobs.sort(
            key=lambda job: _review_ev_priority(job, ev_losses[job.id]),
            reverse=True,
        )
    review_queue = [
        _recent_hand(job, outcomes[job.id], ev_losses[job.id])
        for job in filtered_review_jobs[: max(0, review_limit)]
    ]
    needs_review_hands = sum(
        outcomes[job.id] not in {"match", "mixed"}
        and job.training_reviewed_at is None
        for job in reviewed
    )
    return TrainingProgress(
        reviewed_hands=reviewed_hands,
        action_matches=action_matches,
        exact_matches=exact_matches,
        different_actions=reviewed_hands - action_matches,
        needs_review_hands=needs_review_hands,
        action_accuracy=action_matches / reviewed_hands if reviewed_hands else 0,
        exact_accuracy=exact_matches / reviewed_hands if reviewed_hands else 0,
        ev_compared_hands=len(comparable_ev_losses),
        average_ev_loss_bb=_average_ev_loss(comparable_ev_losses),
        trend=trend,
        action_differences=action_differences,
        certainty_summaries=certainty_summaries,
        unrated_hands=len(unrated_jobs),
        unrated_needs_review_hands=unrated_needs_review_hands,
        street_summaries=street_summaries,
        recent_hands=recent_hands,
        lesson_count=len(lesson_jobs),
        lesson_matching_hands=len(filtered_lesson_jobs),
        lesson_hands=lesson_hands,
        review_street_counts=dict(review_street_counts),
        review_queue_hands=len(filtered_review_jobs),
        review_queue=review_queue,
    )


def build_training_lessons_markdown(
    jobs: list[JobRecord],
    lesson_street: Street | None = None,
    lesson_query: str | None = None,
) -> tuple[str, int]:
    lesson_jobs = training_lesson_jobs(
        jobs,
        lesson_street=lesson_street,
        lesson_query=lesson_query,
    )
    lesson_count = len(lesson_jobs)
    lines = [
        "# Poker Hero Lessons",
        "",
        f"{lesson_count} saved lesson note{'s' if lesson_count != 1 else ''}.",
        "",
    ]
    for job in lesson_jobs:
        state = job.approved_state
        decision = job.training_decision
        recommendation = job.recommendation
        reviewed_at = job.training_reviewed_at
        note = job.training_review_note
        if (
            decision is None
            or recommendation is None
            or reviewed_at is None
            or note is None
        ):
            continue

        hero_cards = (
            " ".join(card.code for card in state.hero_cards)
            if state is not None
            else ""
        ) or "Unknown cards"
        street = (
            state.street.title()
            if state is not None and state.street
            else "Unknown street"
        )
        board_cards = (
            " ".join(card.code for card in state.board_cards)
            if state is not None
            else ""
        ) or (
            "Preflop"
            if state is not None and state.street == "preflop"
            else "Not recorded"
        )
        lines.extend(
            [
                f"## {hero_cards} - {street}",
                "",
                f"- Reviewed: `{_markdown_timestamp(reviewed_at)}`",
                f"- Source: {_markdown_code_span(job.original_filename)}",
                f"- Board: {board_cards}",
                *(
                    [f"- Position: {_markdown_code_span(state.hero_position)}"]
                    if state is not None and state.hero_position
                    else []
                ),
                *(
                    [f"- Pot: {state.pot_size:g} BB"]
                    if state is not None and state.pot_size is not None
                    else []
                ),
                *(
                    [f"- To call: {state.current_bet:g} BB"]
                    if state is not None
                    and state.current_bet is not None
                    and state.current_bet > 0
                    else []
                ),
                *(
                    [f"- Effective stack: {state.effective_stack:g} BB"]
                    if state is not None and state.effective_stack is not None
                    else []
                ),
                f"- You: {_training_line(decision.action, decision.sizing)}",
                f"- Solver: {_training_line(recommendation.action, recommendation.sizing)}",
                (
                    f"- Certainty: {decision.certainty.title()}"
                    if decision.certainty
                    else "- Certainty: Unrated"
                ),
            ]
        )
        ev_loss = training_ev_loss_bb(job)
        if ev_loss is not None:
            lines.append(f"- EV loss: {ev_loss:g} BB")
        lines.extend(["", "### Lesson", "", *_markdown_quote(note), ""])

    return "\n".join(lines).rstrip() + "\n", lesson_count


def _training_line(action: RecommendationAction, sizing: float | None) -> str:
    label = action.title()
    return f"{label} {sizing:g} BB" if sizing is not None else label


def _markdown_timestamp(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _markdown_code_span(value: str) -> str:
    normalized = value.replace("\r", " ").replace("\n", " ")
    longest_run = max(
        (len(match.group()) for match in re.finditer(r"`+", normalized)),
        default=0,
    )
    delimiter = "`" * (longest_run + 1)
    padding = " " if normalized.startswith("`") or normalized.endswith("`") else ""
    return f"{delimiter}{padding}{normalized}{padding}{delimiter}"


def _markdown_quote(value: str) -> list[str]:
    return [f"> {line}" if line else ">" for line in value.splitlines() or [""]]


def training_outcome(job: JobRecord) -> TrainingOutcome:
    decision = job.training_decision
    recommendation = job.recommendation
    if decision is None or recommendation is None:
        raise ValueError("Training comparison requires a decision and recommendation")
    if _line_matches(
        decision.action,
        decision.sizing,
        recommendation.action,
        recommendation.sizing,
    ):
        return "match"

    policy_support = _policy_support(decision, recommendation)
    if policy_support == "line":
        return "mixed"
    if decision.action == recommendation.action:
        return "same_action"
    if policy_support == "action":
        return "mixed_action"
    return "different"


def training_ev_loss_bb(job: JobRecord) -> float | None:
    decision = job.training_decision
    recommendation = job.recommendation
    if decision is None or recommendation is None:
        raise ValueError("Training comparison requires a decision and recommendation")
    candidates = recommendation.raw.get("candidates")
    if not isinstance(candidates, list):
        return None

    best_ev: float | None = None
    decision_ev: float | None = None
    recommendation_line_found = False
    valid_lines: set[tuple[str, float | None]] = set()
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        action = candidate.get("action")
        if action not in {"fold", "check", "call", "bet", "raise"}:
            continue
        if "sizing" not in candidate:
            continue
        sizing = _candidate_sizing(action, candidate.get("sizing"))
        if sizing is _INVALID_SIZING:
            continue
        ev = _finite_number(candidate.get("ev"))
        if ev is None:
            continue
        valid_lines.add((action, sizing))
        best_ev = ev if best_ev is None else max(best_ev, ev)
        if _line_matches(
            recommendation.action,
            recommendation.sizing,
            action,
            sizing,
        ):
            recommendation_line_found = True
        if _line_matches(decision.action, decision.sizing, action, sizing):
            decision_ev = ev if decision_ev is None else max(decision_ev, ev)

    if (
        best_ev is None
        or decision_ev is None
        or not recommendation_line_found
        or len(valid_lines) < 2
    ):
        return None
    return round(max(0.0, best_ev - decision_ev), 6)


def _policy_support(
    decision: TrainingDecision,
    recommendation: RecommendationResult,
) -> PolicySupport | None:
    candidates = recommendation.raw.get("candidates")
    if not isinstance(candidates, list):
        return None

    action_supported = False
    for candidate in candidates:
        if not isinstance(candidate, dict) or candidate.get("action") != decision.action:
            continue
        frequency = _finite_number(candidate.get("frequency"))
        if (
            frequency is None
            or frequency < MIN_SUPPORTED_FREQUENCY
            or frequency > 1
        ):
            continue
        if "sizing" not in candidate:
            continue
        sizing = _candidate_sizing(decision.action, candidate.get("sizing"))
        if sizing is _INVALID_SIZING:
            continue
        action_supported = True
        if _sizing_matches(decision.sizing, sizing):
            return "line"
    return "action" if action_supported else None


_INVALID_SIZING = object()


def _candidate_sizing(
    action: RecommendationAction,
    value: Any,
) -> float | None | object:
    if action in {"bet", "raise"}:
        sizing = _finite_number(value)
        return sizing if sizing is not None and sizing >= 0 else _INVALID_SIZING
    return None if value is None else _INVALID_SIZING


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _line_matches(
    left_action: RecommendationAction,
    left_sizing: float | None,
    right_action: RecommendationAction,
    right_sizing: float | None,
) -> bool:
    return left_action == right_action and _sizing_matches(left_sizing, right_sizing)


def _sizing_matches(left: float | None, right: float | None) -> bool:
    if left is None or right is None:
        return left == right
    return abs(left - right) < SIZING_MATCH_TOLERANCE


def _training_recorded_at(job: JobRecord) -> datetime:
    if job.training_decision is None:
        raise ValueError("Training hand requires a decision")
    return job.training_decision.recorded_at


def _review_ev_priority(
    job: JobRecord,
    ev_loss_bb: float | None,
) -> tuple[bool, float, datetime]:
    return (
        ev_loss_bb is not None,
        ev_loss_bb if ev_loss_bb is not None else 0,
        _training_recorded_at(job),
    )


def _training_trend(
    newest_first: list[JobRecord],
    outcomes: dict[str, TrainingOutcome],
    ev_losses: dict[str, float | None],
) -> TrainingTrend | None:
    window_hands = min(MAX_TREND_WINDOW, len(newest_first) // 2)
    if window_hands == 0:
        return None

    recent_jobs = newest_first[:window_hands]
    previous_jobs = newest_first[window_hands : window_hands * 2]
    recent_action_accuracy = _window_accuracy(
        recent_jobs,
        outcomes,
        exact=False,
    )
    previous_action_accuracy = _window_accuracy(
        previous_jobs,
        outcomes,
        exact=False,
    )
    recent_exact_accuracy = _window_accuracy(
        recent_jobs,
        outcomes,
        exact=True,
    )
    previous_exact_accuracy = _window_accuracy(
        previous_jobs,
        outcomes,
        exact=True,
    )
    recent_ev_losses = [
        loss
        for job in recent_jobs
        if (loss := ev_losses[job.id]) is not None
    ]
    previous_ev_losses = [
        loss
        for job in previous_jobs
        if (loss := ev_losses[job.id]) is not None
    ]
    recent_average_ev_loss = _average_ev_loss(recent_ev_losses)
    previous_average_ev_loss = _average_ev_loss(previous_ev_losses)
    ev_loss_delta = (
        round(recent_average_ev_loss - previous_average_ev_loss, 6)
        if recent_average_ev_loss is not None
        and previous_average_ev_loss is not None
        else None
    )
    return TrainingTrend(
        window_hands=window_hands,
        recent_action_accuracy=recent_action_accuracy,
        previous_action_accuracy=previous_action_accuracy,
        action_accuracy_delta=round(
            recent_action_accuracy - previous_action_accuracy,
            6,
        ),
        recent_exact_accuracy=recent_exact_accuracy,
        previous_exact_accuracy=previous_exact_accuracy,
        exact_accuracy_delta=round(
            recent_exact_accuracy - previous_exact_accuracy,
            6,
        ),
        recent_ev_compared_hands=len(recent_ev_losses),
        previous_ev_compared_hands=len(previous_ev_losses),
        recent_average_ev_loss_bb=recent_average_ev_loss,
        previous_average_ev_loss_bb=previous_average_ev_loss,
        average_ev_loss_delta_bb=ev_loss_delta,
    )


def _action_differences(
    reviewed: list[JobRecord],
    outcomes: dict[str, TrainingOutcome],
    ev_losses: dict[str, float | None],
) -> list[TrainingActionDifference]:
    grouped: dict[
        tuple[RecommendationAction, RecommendationAction],
        list[JobRecord],
    ] = defaultdict(list)
    for job in reviewed:
        if outcomes[job.id] != "different":
            continue
        decision = job.training_decision
        recommendation = job.recommendation
        if decision is None or recommendation is None:
            continue
        grouped[(decision.action, recommendation.action)].append(job)

    summaries = []
    for (decision_action, recommended_action), jobs in grouped.items():
        difference_ev_losses = [
            loss
            for job in jobs
            if (loss := ev_losses[job.id]) is not None
        ]
        summaries.append(
            TrainingActionDifference(
                decision_action=decision_action,
                recommended_action=recommended_action,
                hands=len(jobs),
                needs_review_hands=sum(
                    job.training_reviewed_at is None for job in jobs
                ),
                ev_compared_hands=len(difference_ev_losses),
                average_ev_loss_bb=_average_ev_loss(difference_ev_losses),
            )
        )
    return sorted(
        summaries,
        key=lambda summary: (
            summary.needs_review_hands == 0,
            -summary.hands,
            summary.average_ev_loss_bb is None,
            -(summary.average_ev_loss_bb or 0),
            summary.decision_action,
            summary.recommended_action,
        ),
    )


def _window_accuracy(
    jobs: list[JobRecord],
    outcomes: dict[str, TrainingOutcome],
    *,
    exact: bool,
) -> float:
    if exact:
        matches = sum(outcomes[job.id] in {"match", "mixed"} for job in jobs)
    else:
        matches = sum(outcomes[job.id] != "different" for job in jobs)
    return matches / len(jobs)


def _average_ev_loss(losses: list[float]) -> float | None:
    return round(sum(losses) / len(losses), 6) if losses else None


def _recent_hand(
    job: JobRecord,
    outcome: TrainingOutcome,
    ev_loss_bb: float | None,
) -> TrainingRecentHand:
    decision = job.training_decision
    recommendation = job.recommendation
    if decision is None or recommendation is None:
        raise ValueError("Recent training hand requires a decision and recommendation")
    return TrainingRecentHand(
        job_id=job.id,
        original_filename=job.original_filename,
        street=job.approved_state.street if job.approved_state else None,
        hero_cards=job.approved_state.hero_cards if job.approved_state else [],
        decision_action=decision.action,
        decision_sizing=decision.sizing,
        decision_certainty=decision.certainty,
        recommended_action=recommendation.action,
        recommended_sizing=recommendation.sizing,
        outcome=outcome,
        recorded_at=decision.recorded_at,
        reviewed_at=job.training_reviewed_at,
        review_note=job.training_review_note,
        ev_loss_bb=ev_loss_bb,
    )
