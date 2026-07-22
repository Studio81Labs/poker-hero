import pytest

from app.models import CanonicalState, Card, FacingAction, RecommendationRequest
from app.solvers.preflop_chart import (
    canonical_hand_class,
    hand_top_fraction,
    normalize_position,
    solve_preflop_chart,
)


def request_for(
    cards: tuple[str, str],
    *,
    position: str | None,
    current_bet: float = 0,
    pot_size: float = 1.5,
    effective_stack: float = 100,
    players_in_hand: int = 6,
    facing_action: FacingAction | None = None,
    action_context: str | None = None,
) -> RecommendationRequest:
    return RecommendationRequest(
        provider="local_solver",
        state=CanonicalState(
            hero_cards=[Card.from_code(code) for code in cards],
            pot_size=pot_size,
            current_bet=current_bet,
            effective_stack=effective_stack,
            players_in_hand=players_in_hand,
            hero_position=position,
            street="preflop",
            facing_action=facing_action,
            action_context=action_context,
            user_approved=True,
        ),
    )


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("UTG", "utg"),
        ("middle-position", "hijack"),
        ("CO", "cutoff"),
        ("dealer", "button"),
        ("small_blind", "small_blind"),
        ("BB", "big_blind"),
        ("IP", None),
    ],
)
def test_normalizes_supported_preflop_positions(value: str, expected: str | None) -> None:
    assert normalize_position(value) == expected


def test_canonical_hand_class_is_order_independent() -> None:
    cards = [Card.from_code("7d"), Card.from_code("Ah")]

    assert canonical_hand_class(cards) == "A7o"
    assert canonical_hand_class(list(reversed(cards))) == "A7o"


def test_chart_ranking_accounts_for_suited_wheel_ace_playability() -> None:
    suited_ace = [Card.from_code("Ah"), Card.from_code("2h")]
    weak_offsuit = [Card.from_code("Kh"), Card.from_code("7d")]

    assert hand_top_fraction(suited_ace) < hand_top_fraction(weak_offsuit)


def test_opens_premium_hand_from_early_position() -> None:
    result = solve_preflop_chart(request_for(("Ah", "Ad"), position="UTG"))

    assert result is not None
    assert result.action == "raise"
    assert result.sizing == 2.5
    assert result.raw["engine"] == "preflop_chart_v1"
    assert result.raw["scenario"] == "first_in"
    assert result.raw["chart_tier"] == "open"


def test_folds_weak_unopened_button_hand() -> None:
    result = solve_preflop_chart(request_for(("7h", "2d"), position="button"))

    assert result is not None
    assert result.action == "fold"
    assert result.sizing is None


@pytest.mark.parametrize(
    "action_context",
    [
        "Cutoff raises; hero has 2.5 BB to call",
        "Cutoff opens to 2.5 BB",
        "Cutoff opened to 2.5 BB",
        "Cutoff open raises to 2.5 BB",
    ],
)
def test_defends_medium_button_hand_against_assumed_open_raise(
    action_context: str,
) -> None:
    result = solve_preflop_chart(
        request_for(
            ("Ah", "Jd"),
            position="button",
            current_bet=2.5,
            pot_size=4,
            facing_action="raise",
            action_context=action_context,
        )
    )

    assert result is not None
    assert result.action == "call"
    assert result.raw["scenario"] == "facing_open_raise"
    assert any("opener-position average" in value for value in result.raw["assumptions"])


def test_reraises_premium_hand_and_caps_size_to_effective_stack() -> None:
    result = solve_preflop_chart(
        request_for(
            ("Kh", "Ks"),
            position="big blind",
            current_bet=2,
            pot_size=4.5,
            effective_stack=6,
            facing_action="raise",
            action_context="Button raises to 3 BB",
        )
    )

    assert result is not None
    assert result.action == "raise"
    assert result.sizing == 6
    assert result.raw["chart_tier"] == "reraise"


@pytest.mark.parametrize(
    "action_context",
    [
        "Button opens to 2.5 BB",
        "Button raises; hero has 1.5 BB to call",
    ],
)
def test_sizes_blind_reraise_from_total_open(action_context: str) -> None:
    result = solve_preflop_chart(
        request_for(
            ("Kh", "Ks"),
            position="big blind",
            current_bet=1.5,
            pot_size=4,
            facing_action="raise",
            action_context=action_context,
        )
    )

    assert result is not None
    assert result.action == "raise"
    assert result.sizing == 7.5


def test_checks_big_blind_when_no_amount_is_required() -> None:
    result = solve_preflop_chart(request_for(("7h", "2d"), position="BB"))

    assert result is not None
    assert result.action == "check"
    assert [candidate["action"] for candidate in result.raw["candidates"]] == ["check", "raise"]


@pytest.mark.parametrize(
    "recommendation_request",
    [
        request_for(("Ah", "Kd"), position=None),
        request_for(
            ("Ah", "Kd"),
            position="button",
            current_bet=0,
            pot_size=1.5,
            facing_action="raise",
            action_context="UTG raises",
        ),
        request_for(
            ("Ah", "Kd"),
            position="button",
            current_bet=0,
            pot_size=1.5,
            action_context="UTG opens to 2.5 BB",
        ),
        request_for(("Ah", "Kd"), position="button", players_in_hand=7),
        request_for(("Ah", "Ad"), position="button", effective_stack=0),
        request_for(("Ah", "Kd"), position="button", pot_size=2.5),
        request_for(("Ah", "Kd"), position="button", pot_size=4.5),
        request_for(("Ah", "Ad"), position="BB", pot_size=4.5),
        request_for(("Ah", "Ad"), position="BB", current_bet=2.5, pot_size=4.5),
        request_for(
            ("Ah", "Ad"),
            position="BB",
            current_bet=2.5,
            pot_size=4.5,
            facing_action="raise",
        ),
        request_for(
            ("Ah", "Ad"),
            position="BB",
            current_bet=2.5,
            pot_size=2.5,
            facing_action="raise",
            action_context="CO opens to 2.5 BB",
        ),
        request_for(
            ("Ah", "Ad"),
            position="button",
            current_bet=2.5,
            pot_size=6.5,
            facing_action="raise",
            action_context="UTG raises to 2.5 BB",
        ),
        request_for(
            ("Ah", "Ad"),
            position="BB",
            current_bet=2.5,
            pot_size=4.5,
            facing_action="raise",
            action_context="Opponent raises to 3 BB",
        ),
        request_for(
            ("Ah", "Ad"),
            position="UTG",
            current_bet=2.5,
            pot_size=4.5,
            facing_action="raise",
            action_context="Hijack raises to 3 BB",
        ),
        request_for(
            ("Ah", "Ad"),
            position="cutoff",
            current_bet=2.5,
            pot_size=4.5,
            facing_action="raise",
            action_context="Button raises to 3 BB",
        ),
        request_for(("Ah", "Kd"), position="button", action_context="UTG limp, hero to act"),
        request_for(
            ("Ah", "Kd"),
            position="button",
            current_bet=2.5,
            pot_size=6.5,
            facing_action="raise",
            action_context="UTG raises, CO calls, hero on button",
        ),
        request_for(
            ("Ah", "Kd"),
            position="button",
            current_bet=2.5,
            pot_size=6.5,
            facing_action="raise",
            action_context="UTG raises, CO call, hero on button",
        ),
        request_for(
            ("Ah", "Kd"),
            position="button",
            current_bet=2.5,
            pot_size=6.5,
            facing_action="raise",
            action_context="UTG raises, CO flatted, hero on button",
        ),
        request_for(
            ("Ah", "Kd"),
            position="BB",
            current_bet=3,
            pot_size=6.5,
            facing_action="raise",
            action_context="UTG raises, button raises to 4 BB",
        ),
        request_for(
            ("Ah", "Kd"),
            position="BB",
            current_bet=3,
            pot_size=6.5,
            facing_action="raise",
            action_context="UTG opens, button opens to 4 BB",
        ),
        request_for(
            ("Ah", "Kd"),
            position="BB",
            current_bet=2,
            pot_size=4.5,
            facing_action="raise",
            action_context="UTG raises all-in to 3 BB",
        ),
        request_for(
            ("Ah", "Kd"),
            position="BB",
            current_bet=3,
            pot_size=6.5,
            facing_action="raise",
            action_context="UTG raises, button squeezed to 4 BB",
        ),
        request_for(
            ("Ah", "Kd"),
            position="button",
            current_bet=8,
            pot_size=12,
            facing_action="raise",
            action_context="Hero faces a 3-bet",
        ),
        request_for(
            ("Ah", "Kd"),
            position="button",
            current_bet=8,
            pot_size=12,
            facing_action="raise",
            action_context="UTG raises to 9 BB",
        ),
        request_for(
            ("Ah", "Kd"),
            position="button",
            current_bet=24,
            pot_size=36,
            facing_action="raise",
            action_context="Hero faces a five-bet",
        ),
        request_for(
            ("Ah", "Kd"),
            position="button",
            current_bet=8,
            pot_size=12,
            facing_action="raise",
            action_context="Small blind re-raises, hero to act",
        ),
        request_for(
            ("Ah", "Kd"),
            position="BB",
            current_bet=3,
            pot_size=6,
            facing_action="raise",
            action_context="UTG raises, button reraised to 4 BB",
        ),
        request_for(
            ("Ah", "Kd"),
            position="BB",
            current_bet=3,
            pot_size=6,
            facing_action="raise",
            action_context="UTG raises, button re-raised to 4 BB",
        ),
    ],
)
def test_declines_ambiguous_preflop_states(
    recommendation_request: RecommendationRequest,
) -> None:
    assert solve_preflop_chart(recommendation_request) is None
