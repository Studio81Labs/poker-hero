from datetime import datetime, timezone
from typing import Any, Literal, Self
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


Rank = Literal["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"]
Suit = Literal["clubs", "diamonds", "hearts", "spades"]
Street = Literal["preflop", "flop", "turn", "river"]
FacingAction = Literal["bet", "raise"]
RecommendationAction = Literal["fold", "check", "call", "bet", "raise"]
TrainingCertainty = Literal["low", "medium", "high"]
TrainingOutcome = Literal["match", "mixed", "same_action", "mixed_action", "different"]
TrainingReviewOrder = Literal["recent", "ev_loss"]
TrainingReviewCertainty = Literal["low", "medium", "high", "unrated"]

RANKS = {"2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"}
SUIT_BY_CODE = {
    "c": "clubs",
    "d": "diamonds",
    "h": "hearts",
    "s": "spades",
}
CODE_BY_SUIT = {value: key for key, value in SUIT_BY_CODE.items()}


def _validate_card_count(field_name: str, cards: list["Card"], maximum: int) -> list["Card"]:
    if len(cards) > maximum:
        raise ValueError(f"{field_name} cannot contain more than {maximum} cards")
    return cards


def _validate_unique_cards(hero_cards: list["Card"], board_cards: list["Card"]) -> None:
    seen: set[str] = set()
    for card in [*hero_cards, *board_cards]:
        if card.code in seen:
            raise ValueError(f"Duplicate card in state: {card.code}")
        seen.add(card.code)


class Card(BaseModel):
    rank: Rank
    suit: Suit

    @field_validator("rank", mode="before")
    @classmethod
    def validate_rank(cls, value: str) -> str:
        if not isinstance(value, str):
            return value
        normalized = value.upper()
        if normalized == "10":
            normalized = "T"
        if normalized not in RANKS:
            raise ValueError(f"Unknown card rank: {value}")
        return normalized

    @field_validator("suit", mode="before")
    @classmethod
    def validate_suit(cls, value: str) -> str:
        if not isinstance(value, str):
            return value
        normalized = value.lower()
        if normalized in SUIT_BY_CODE:
            normalized = SUIT_BY_CODE[normalized]
        if normalized not in CODE_BY_SUIT:
            raise ValueError(f"Unknown card suit: {value}")
        return normalized

    @property
    def code(self) -> str:
        return f"{self.rank}{CODE_BY_SUIT[self.suit]}"

    @classmethod
    def from_code(cls, value: str) -> "Card":
        stripped = value.strip()
        if len(stripped) not in {2, 3}:
            raise ValueError(f"Card code must be rank plus suit: {value}")
        rank = stripped[:-1]
        suit = stripped[-1]
        return cls(rank=rank, suit=suit)


class DetectedState(BaseModel):
    hero_cards: list[Card] = Field(default_factory=list)
    board_cards: list[Card] = Field(default_factory=list)
    pot_size: float | None = Field(default=None, ge=0)
    current_bet: float | None = Field(default=None, ge=0)
    hero_stack: float | None = Field(default=None, ge=0)
    effective_stack: float | None = Field(default=None, ge=0)
    players_in_hand: int | None = Field(default=None, ge=1)
    hero_position: str | None = Field(default=None)
    preflop_opener_position: str | None = Field(default=None)
    preflop_open_size: float | None = Field(default=None, gt=0)
    street: Street | None = Field(default=None)
    facing_action: FacingAction | None = Field(default=None)
    action_context: str | None = Field(default=None)

    @field_validator("hero_cards")
    @classmethod
    def validate_hero_card_count(cls, value: list[Card]) -> list[Card]:
        return _validate_card_count("hero_cards", value, 2)

    @field_validator("board_cards")
    @classmethod
    def validate_board_card_count(cls, value: list[Card]) -> list[Card]:
        return _validate_card_count("board_cards", value, 5)

    @model_validator(mode="after")
    def validate_unique_cards(self) -> Self:
        _validate_unique_cards(self.hero_cards, self.board_cards)
        return self


class ParserResult(BaseModel):
    state: DetectedState
    confidences: dict[str, float] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    raw: dict[str, Any] = Field(default_factory=dict)

    @field_validator("confidences")
    @classmethod
    def validate_confidences(cls, value: dict[str, float]) -> dict[str, float]:
        for field_name, confidence in value.items():
            if confidence < 0 or confidence > 1:
                raise ValueError(f"Confidence for {field_name} must be between 0 and 1")
        return value


class CanonicalState(BaseModel):
    hero_cards: list[Card] = Field(default_factory=list)
    board_cards: list[Card] = Field(default_factory=list)
    pot_size: float | None = Field(default=None, ge=0)
    current_bet: float | None = Field(default=None, ge=0)
    hero_stack: float | None = Field(default=None, ge=0)
    effective_stack: float | None = Field(default=None, ge=0)
    players_in_hand: int | None = Field(default=None, ge=1)
    hero_position: str | None = Field(default=None)
    preflop_opener_position: str | None = Field(default=None)
    preflop_open_size: float | None = Field(default=None, gt=0)
    street: Street | None = Field(default=None)
    facing_action: FacingAction | None = Field(default=None)
    action_context: str | None = Field(default=None)
    user_approved: bool = Field(default=False)

    @field_validator("hero_cards")
    @classmethod
    def validate_hero_card_count(cls, value: list[Card]) -> list[Card]:
        return _validate_card_count("hero_cards", value, 2)

    @field_validator("board_cards")
    @classmethod
    def validate_board_card_count(cls, value: list[Card]) -> list[Card]:
        return _validate_card_count("board_cards", value, 5)

    @model_validator(mode="after")
    def validate_unique_cards(self) -> Self:
        _validate_unique_cards(self.hero_cards, self.board_cards)
        return self

    @classmethod
    def from_parser_result(cls, parser_result: ParserResult) -> "CanonicalState":
        state = parser_result.state.model_copy(deep=True)
        return cls(
            hero_cards=state.hero_cards,
            board_cards=state.board_cards,
            pot_size=state.pot_size,
            current_bet=state.current_bet,
            hero_stack=state.hero_stack,
            effective_stack=state.effective_stack,
            players_in_hand=state.players_in_hand,
            hero_position=state.hero_position,
            preflop_opener_position=state.preflop_opener_position,
            preflop_open_size=state.preflop_open_size,
            street=state.street,
            facing_action=state.facing_action,
            action_context=state.action_context,
        )


class RecommendationRequest(BaseModel):
    state: CanonicalState
    provider: str


class RecommendationResult(BaseModel):
    action: RecommendationAction
    sizing: float | None = Field(default=None, ge=0)
    confidence: float = Field(ge=0, le=1)
    explanation: str
    raw: dict[str, Any] = Field(default_factory=dict)


class TrainingDecisionRequest(BaseModel):
    action: RecommendationAction
    sizing: float | None = Field(default=None, ge=0)
    certainty: TrainingCertainty | None = None

    @model_validator(mode="after")
    def validate_sizing(self) -> Self:
        if self.action not in {"bet", "raise"} and self.sizing is not None:
            raise ValueError("Sizing is only valid for bet or raise decisions")
        return self


class TrainingDecision(TrainingDecisionRequest):
    recorded_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class TrainingReviewRequest(BaseModel):
    note: str | None = Field(default=None, max_length=1000)

    @field_validator("note", mode="before")
    @classmethod
    def normalize_note(cls, value: str | None) -> str | None:
        if not isinstance(value, str):
            return value
        stripped = value.strip()
        return stripped or None


class TrainingStreetSummary(BaseModel):
    street: Street
    reviewed_hands: int = Field(ge=0)
    action_matches: int = Field(ge=0)
    exact_matches: int = Field(ge=0)
    action_accuracy: float = Field(ge=0, le=1)
    exact_accuracy: float = Field(ge=0, le=1)
    ev_compared_hands: int = Field(default=0, ge=0)
    average_ev_loss_bb: float | None = Field(default=None, ge=0)


class TrainingCertaintySummary(BaseModel):
    certainty: TrainingCertainty
    hands: int = Field(ge=1)
    action_matches: int = Field(ge=0)
    exact_matches: int = Field(ge=0)
    needs_review_hands: int = Field(default=0, ge=0)
    action_accuracy: float = Field(ge=0, le=1)
    exact_accuracy: float = Field(ge=0, le=1)
    ev_compared_hands: int = Field(default=0, ge=0)
    average_ev_loss_bb: float | None = Field(default=None, ge=0)


class TrainingRecentHand(BaseModel):
    job_id: str
    original_filename: str
    street: Street | None
    hero_cards: list[Card] = Field(default_factory=list)
    decision_action: RecommendationAction
    decision_sizing: float | None = Field(default=None, ge=0)
    decision_certainty: TrainingCertainty | None = None
    recommended_action: RecommendationAction
    recommended_sizing: float | None = Field(default=None, ge=0)
    outcome: TrainingOutcome
    recorded_at: datetime
    reviewed_at: datetime | None = None
    review_note: str | None = None
    ev_loss_bb: float | None = Field(default=None, ge=0)


class TrainingTrend(BaseModel):
    window_hands: int = Field(ge=1)
    recent_action_accuracy: float = Field(ge=0, le=1)
    previous_action_accuracy: float = Field(ge=0, le=1)
    action_accuracy_delta: float = Field(ge=-1, le=1)
    recent_exact_accuracy: float = Field(ge=0, le=1)
    previous_exact_accuracy: float = Field(ge=0, le=1)
    exact_accuracy_delta: float = Field(ge=-1, le=1)
    recent_ev_compared_hands: int = Field(default=0, ge=0)
    previous_ev_compared_hands: int = Field(default=0, ge=0)
    recent_average_ev_loss_bb: float | None = Field(default=None, ge=0)
    previous_average_ev_loss_bb: float | None = Field(default=None, ge=0)
    average_ev_loss_delta_bb: float | None = None


class TrainingPositionSummary(BaseModel):
    position: str = Field(min_length=1)
    reviewed_hands: int = Field(ge=1)
    action_matches: int = Field(ge=0)
    exact_matches: int = Field(ge=0)
    action_accuracy: float = Field(ge=0, le=1)
    exact_accuracy: float = Field(ge=0, le=1)
    ev_compared_hands: int = Field(default=0, ge=0)
    average_ev_loss_bb: float | None = Field(default=None, ge=0)
    trend: TrainingTrend | None = None


class TrainingActionDifference(BaseModel):
    decision_action: RecommendationAction
    recommended_action: RecommendationAction
    hands: int = Field(ge=1)
    needs_review_hands: int = Field(default=0, ge=0)
    ev_compared_hands: int = Field(default=0, ge=0)
    average_ev_loss_bb: float | None = Field(default=None, ge=0)


class TrainingSolverRouteSummary(BaseModel):
    key: str = Field(pattern=r"^[0-9a-f]{64}$")
    engine: str
    hands: int = Field(ge=1)
    fallback_hands: int = Field(default=0, ge=0)
    action_matches: int = Field(default=0, ge=0)
    exact_matches: int = Field(default=0, ge=0)
    action_accuracy: float = Field(default=0, ge=0, le=1)
    exact_accuracy: float = Field(default=0, ge=0, le=1)
    ev_compared_hands: int = Field(default=0, ge=0)
    average_ev_loss_bb: float | None = Field(default=None, ge=0)
    trend: TrainingTrend | None = None
    street_counts: dict[Street, int] = Field(default_factory=dict)


class TrainingSolverFallbackSummary(BaseModel):
    key: str = Field(pattern=r"^[0-9a-f]{64}$")
    reason: str
    hands: int = Field(ge=1)
    action_matches: int = Field(default=0, ge=0)
    exact_matches: int = Field(default=0, ge=0)
    action_accuracy: float = Field(default=0, ge=0, le=1)
    exact_accuracy: float = Field(default=0, ge=0, le=1)
    ev_compared_hands: int = Field(default=0, ge=0)
    average_ev_loss_bb: float | None = Field(default=None, ge=0)
    trend: TrainingTrend | None = None
    street_counts: dict[Street, int] = Field(default_factory=dict)


class TrainingSolverCoverageTrend(BaseModel):
    window_hands: int = Field(ge=1)
    recent_attribution_rate: float = Field(ge=0, le=1)
    previous_attribution_rate: float = Field(ge=0, le=1)
    attribution_rate_delta: float = Field(ge=-1, le=1)
    recent_fallback_rate: float = Field(ge=0, le=1)
    previous_fallback_rate: float = Field(ge=0, le=1)
    fallback_rate_delta: float = Field(ge=-1, le=1)


class TrainingSolverCoverage(BaseModel):
    total_hands: int = Field(ge=0)
    tracked_hands: int = Field(default=0, ge=0)
    unattributed_hands: int = Field(default=0, ge=0)
    fallback_hands: int = Field(default=0, ge=0)
    fallback_rate: float = Field(default=0, ge=0, le=1)
    trend: TrainingSolverCoverageTrend | None = None
    routes: list[TrainingSolverRouteSummary] = Field(default_factory=list)
    fallback_reasons: list[TrainingSolverFallbackSummary] = Field(default_factory=list)


class TrainingProgress(BaseModel):
    reviewed_hands: int = Field(ge=0)
    action_matches: int = Field(ge=0)
    exact_matches: int = Field(ge=0)
    different_actions: int = Field(ge=0)
    needs_review_hands: int = Field(ge=0)
    action_accuracy: float = Field(ge=0, le=1)
    exact_accuracy: float = Field(ge=0, le=1)
    ev_compared_hands: int = Field(default=0, ge=0)
    average_ev_loss_bb: float | None = Field(default=None, ge=0)
    trend: TrainingTrend | None = None
    action_differences: list[TrainingActionDifference] = Field(default_factory=list)
    solver_coverage: TrainingSolverCoverage
    certainty_summaries: list[TrainingCertaintySummary] = Field(default_factory=list)
    unrated_hands: int = Field(default=0, ge=0)
    unrated_needs_review_hands: int = Field(default=0, ge=0)
    street_summaries: list[TrainingStreetSummary] = Field(default_factory=list)
    position_summaries: list[TrainingPositionSummary] = Field(default_factory=list)
    unpositioned_hands: int = Field(default=0, ge=0)
    recent_matching_hands: int = Field(default=0, ge=0)
    recent_hands: list[TrainingRecentHand] = Field(default_factory=list)
    lesson_count: int = Field(default=0, ge=0)
    lesson_matching_hands: int = Field(default=0, ge=0)
    lesson_hands: list[TrainingRecentHand] = Field(default_factory=list)
    review_street_counts: dict[Street, int] = Field(default_factory=dict)
    review_queue_hands: int = Field(default=0, ge=0)
    review_queue: list[TrainingRecentHand] = Field(default_factory=list)


class JobRecord(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    id: str = Field(default_factory=lambda: uuid4().hex)
    status: Literal["created", "parsed", "approved", "recommended", "error"] = "created"
    original_filename: str
    image_filename: str
    parser_provider: str
    recommendation_provider: str
    parser_result: ParserResult | None = None
    approved_state: CanonicalState | None = None
    training_decision: TrainingDecision | None = None
    recommendation: RecommendationResult | None = None
    training_reviewed_at: datetime | None = None
    training_review_note: str | None = None
    benchmark_included: bool = False
    error: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    def touch(self) -> None:
        self.updated_at = datetime.now(timezone.utc)


class BenchmarkSelectionRequest(BaseModel):
    included: bool


class BenchmarkDatasetImportResult(BaseModel):
    imported_cases: int = Field(ge=0)
    reused_cases: int = Field(ge=0)
    included_cases: int = Field(ge=0)
    job_ids: list[str] = Field(default_factory=list)


class BenchmarkFieldComparison(BaseModel):
    field: str
    expected: Any
    detected: Any
    matched: bool
    confidence: float | None = Field(default=None, ge=0, le=1)


class BenchmarkCaseResult(BaseModel):
    job_id: str
    original_filename: str
    status: Literal["completed", "error"]
    correct_fields: int
    evaluated_fields: int
    accuracy: float = Field(ge=0, le=1)
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    comparisons: list[BenchmarkFieldComparison] = Field(default_factory=list)


class BenchmarkFieldMetric(BaseModel):
    field: str
    correct: int
    total: int
    accuracy: float = Field(ge=0, le=1)


class BenchmarkReport(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    parser_provider: str
    layout_profile: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    total_cases: int
    successful_cases: int
    failed_cases: int
    correct_fields: int
    evaluated_fields: int
    accuracy: float = Field(ge=0, le=1)
    field_metrics: list[BenchmarkFieldMetric] = Field(default_factory=list)
    cases: list[BenchmarkCaseResult] = Field(default_factory=list)


class BenchmarkReportSummary(BaseModel):
    id: str
    parser_provider: str
    layout_profile: str
    created_at: datetime
    total_cases: int
    failed_cases: int
    accuracy: float = Field(ge=0, le=1)
    field_metrics: list[BenchmarkFieldMetric] = Field(default_factory=list)

    @classmethod
    def from_report(cls, report: BenchmarkReport) -> "BenchmarkReportSummary":
        return cls(
            id=report.id,
            parser_provider=report.parser_provider,
            layout_profile=report.layout_profile,
            created_at=report.created_at,
            total_cases=report.total_cases,
            failed_cases=report.failed_cases,
            accuracy=report.accuracy,
            field_metrics=report.field_metrics,
        )


class BenchmarkOverview(BaseModel):
    included_cases: int
    latest_report: BenchmarkReport | None = None
    recent_reports: list[BenchmarkReportSummary] = Field(default_factory=list)
