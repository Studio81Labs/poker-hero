from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator


Rank = Literal["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"]
Suit = Literal["clubs", "diamonds", "hearts", "spades"]
Street = Literal["preflop", "flop", "turn", "river"]
RecommendationAction = Literal["fold", "check", "call", "bet", "raise"]

RANKS = {"2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"}
SUIT_BY_CODE = {
    "c": "clubs",
    "d": "diamonds",
    "h": "hearts",
    "s": "spades",
}
CODE_BY_SUIT = {value: key for key, value in SUIT_BY_CODE.items()}


class Card(BaseModel):
    rank: str
    suit: str

    @field_validator("rank")
    @classmethod
    def validate_rank(cls, value: str) -> str:
        normalized = value.upper()
        if normalized == "10":
            normalized = "T"
        if normalized not in RANKS:
            raise ValueError(f"Unknown card rank: {value}")
        return normalized

    @field_validator("suit")
    @classmethod
    def validate_suit(cls, value: str) -> str:
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
    effective_stack: float | None = Field(default=None, ge=0)
    players_in_hand: int | None = Field(default=None, ge=1)
    hero_position: str | None = Field(default=None)
    street: Street | None = Field(default=None)
    action_context: str | None = Field(default=None)


class ParserResult(BaseModel):
    state: DetectedState
    confidences: dict[str, float] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    raw: dict = Field(default_factory=dict)

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
    effective_stack: float | None = Field(default=None, ge=0)
    players_in_hand: int | None = Field(default=None, ge=1)
    hero_position: str | None = Field(default=None)
    street: Street | None = Field(default=None)
    action_context: str | None = Field(default=None)
    user_approved: bool = Field(default=False)

    @classmethod
    def from_parser_result(cls, parser_result: ParserResult) -> "CanonicalState":
        state = parser_result.state
        return cls(
            hero_cards=state.hero_cards,
            board_cards=state.board_cards,
            pot_size=state.pot_size,
            current_bet=state.current_bet,
            effective_stack=state.effective_stack,
            players_in_hand=state.players_in_hand,
            hero_position=state.hero_position,
            street=state.street,
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
    raw: dict = Field(default_factory=dict)


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
    recommendation: RecommendationResult | None = None
    error: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    def touch(self) -> None:
        self.updated_at = datetime.now(timezone.utc)
