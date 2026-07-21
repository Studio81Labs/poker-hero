from collections import defaultdict
from datetime import datetime
from typing import Literal

from app.models import (
    JobRecord,
    Street,
    TrainingProgress,
    TrainingRecentHand,
    TrainingStreetSummary,
)


SIZING_MATCH_TOLERANCE = 0.01
STREET_ORDER: tuple[Street, ...] = ("preflop", "flop", "turn", "river")
TrainingOutcome = Literal["match", "same_action", "different"]


def summarize_training(
    jobs: list[JobRecord],
    recent_limit: int = 8,
    review_limit: int = 24,
) -> TrainingProgress:
    reviewed = [
        job
        for job in jobs
        if job.training_decision is not None and job.recommendation is not None
    ]
    outcomes = {job.id: training_outcome(job) for job in reviewed}
    action_matches = sum(outcome != "different" for outcome in outcomes.values())
    exact_matches = sum(outcome == "match" for outcome in outcomes.values())
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
        street_exact_matches = sum(outcomes[job.id] == "match" for job in street_jobs)
        street_total = len(street_jobs)
        street_summaries.append(
            TrainingStreetSummary(
                street=street,
                reviewed_hands=street_total,
                action_matches=street_action_matches,
                exact_matches=street_exact_matches,
                action_accuracy=street_action_matches / street_total,
                exact_accuracy=street_exact_matches / street_total,
            )
        )

    newest_first = sorted(reviewed, key=_training_recorded_at, reverse=True)
    recent_hands = [
        _recent_hand(job, outcomes[job.id])
        for job in newest_first[: max(0, recent_limit)]
    ]
    review_queue = [
        _recent_hand(job, outcomes[job.id])
        for job in newest_first
        if outcomes[job.id] != "match" and job.training_reviewed_at is None
    ][: max(0, review_limit)]
    needs_review_hands = sum(
        outcomes[job.id] != "match" and job.training_reviewed_at is None
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
        street_summaries=street_summaries,
        recent_hands=recent_hands,
        review_queue=review_queue,
    )


def training_outcome(job: JobRecord) -> TrainingOutcome:
    decision = job.training_decision
    recommendation = job.recommendation
    if decision is None or recommendation is None:
        raise ValueError("Training comparison requires a decision and recommendation")
    if decision.action != recommendation.action:
        return "different"
    if decision.sizing is None or recommendation.sizing is None:
        return "match" if decision.sizing == recommendation.sizing else "same_action"
    return (
        "match"
        if abs(decision.sizing - recommendation.sizing) < SIZING_MATCH_TOLERANCE
        else "same_action"
    )


def _training_recorded_at(job: JobRecord) -> datetime:
    if job.training_decision is None:
        raise ValueError("Training hand requires a decision")
    return job.training_decision.recorded_at


def _recent_hand(job: JobRecord, outcome: TrainingOutcome) -> TrainingRecentHand:
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
        recommended_action=recommendation.action,
        recommended_sizing=recommendation.sizing,
        outcome=outcome,
        recorded_at=decision.recorded_at,
        reviewed_at=job.training_reviewed_at,
    )
