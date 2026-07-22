import pytest

from app.models import CanonicalState, Card, FacingAction, RecommendationRequest
from app.solvers.preflop_chart import (
    DEFENSE_POLICIES,
    OPEN_SIZE_POLICIES,
    POSITION_POLICIES,
    canonical_hand_class,
    hand_top_fraction,
    normalize_position,
    solve_preflop_chart,
)
from app.solvers.preflop_context import (
    MAX_SINGLE_OPEN_SIZE_BB,
    MIN_SINGLE_OPEN_SIZE_BB,
    POSITION_ACTION_ORDER,
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
    preflop_opener_position: str | None = None,
    preflop_open_size: float | None = None,
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
            preflop_opener_position=preflop_opener_position,
            preflop_open_size=preflop_open_size,
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


def test_defense_policies_cover_every_legal_position_matchup() -> None:
    expected_matchups = {
        (opener, hero)
        for opener in POSITION_POLICIES
        for hero in POSITION_POLICIES
        if POSITION_ACTION_ORDER[opener] < POSITION_ACTION_ORDER[hero]
    }

    assert set(DEFENSE_POLICIES) == expected_matchups
    assert all(
        0 < policy.reraise_fraction <= policy.continue_fraction <= 1
        for policy in DEFENSE_POLICIES.values()
    )


def test_open_size_policies_tighten_as_the_raise_grows() -> None:
    assert MIN_SINGLE_OPEN_SIZE_BB <= OPEN_SIZE_POLICIES[0].maximum_size
    assert OPEN_SIZE_POLICIES[-1].maximum_size == MAX_SINGLE_OPEN_SIZE_BB
    assert [policy.maximum_size for policy in OPEN_SIZE_POLICIES] == sorted(
        policy.maximum_size for policy in OPEN_SIZE_POLICIES
    )
    assert all(
        current.continue_multiplier >= following.continue_multiplier
        and current.reraise_multiplier >= following.reraise_multiplier
        for current, following in zip(OPEN_SIZE_POLICIES, OPEN_SIZE_POLICIES[1:])
    )


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
    assert result.raw["policy_source"] == "hero_opener_size_matchup"
    assert any("matchup-specific" in value for value in result.raw["assumptions"])


@pytest.mark.parametrize(
    ("opener_position", "expected_action", "expected_continue_fraction"),
    [
        ("utg", "fold", 0.20),
        ("button", "call", 0.40),
    ],
)
def test_big_blind_continue_range_accounts_for_opener_position(
    opener_position: str,
    expected_action: str,
    expected_continue_fraction: float,
) -> None:
    result = solve_preflop_chart(
        request_for(
            ("Ah", "9d"),
            position="big blind",
            current_bet=1.5,
            pot_size=4,
            facing_action="raise",
            action_context="Hero faces 1.5 BB to call",
            preflop_opener_position=opener_position,
            preflop_open_size=2.5,
        )
    )

    assert result is not None
    assert result.action == expected_action
    assert result.raw["continue_fraction"] == expected_continue_fraction
    assert result.raw["opener_position"] == opener_position


@pytest.mark.parametrize(
    ("opener_position", "expected_action", "expected_reraise_fraction"),
    [
        ("utg", "call", 0.06),
        ("button", "raise", 0.12),
    ],
)
def test_big_blind_reraise_range_accounts_for_opener_position(
    opener_position: str,
    expected_action: str,
    expected_reraise_fraction: float,
) -> None:
    result = solve_preflop_chart(
        request_for(
            ("Ah", "Qd"),
            position="big blind",
            current_bet=1.5,
            pot_size=4,
            facing_action="raise",
            action_context="Hero faces 1.5 BB to call",
            preflop_opener_position=opener_position,
            preflop_open_size=2.5,
        )
    )

    assert result is not None
    assert result.action == expected_action
    assert result.raw["reraise_fraction"] == expected_reraise_fraction
    assert result.raw["opener_open_fraction"] == (
        0.17 if opener_position == "utg" else 0.45
    )


@pytest.mark.parametrize(
    (
        "opening_size",
        "amount_to_call",
        "pot_size",
        "expected_action",
        "expected_policy",
        "expected_continue_fraction",
    ),
    [
        (2.0, 1.0, 3.5, "call", "small", 0.44),
        (4.0, 3.0, 5.5, "fold", "very_large", 0.312),
    ],
)
def test_big_blind_continue_range_accounts_for_opening_size(
    opening_size: float,
    amount_to_call: float,
    pot_size: float,
    expected_action: str,
    expected_policy: str,
    expected_continue_fraction: float,
) -> None:
    result = solve_preflop_chart(
        request_for(
            ("7h", "6h"),
            position="big blind",
            current_bet=amount_to_call,
            pot_size=pot_size,
            facing_action="raise",
            action_context="Hero faces a button open",
            preflop_opener_position="button",
            preflop_open_size=opening_size,
        )
    )

    assert result is not None
    assert result.action == expected_action
    assert result.raw["open_size_policy"] == expected_policy
    assert result.raw["base_continue_fraction"] == 0.40
    assert result.raw["continue_fraction"] == expected_continue_fraction


@pytest.mark.parametrize(
    ("opening_size", "amount_to_call", "pot_size", "expected_action", "expected_fraction"),
    [
        (2.0, 1.0, 3.5, "raise", 0.126),
        (4.0, 3.0, 5.5, "call", 0.108),
    ],
)
def test_big_blind_reraise_range_accounts_for_opening_size(
    opening_size: float,
    amount_to_call: float,
    pot_size: float,
    expected_action: str,
    expected_fraction: float,
) -> None:
    result = solve_preflop_chart(
        request_for(
            ("Ah", "Jd"),
            position="big blind",
            current_bet=amount_to_call,
            pot_size=pot_size,
            facing_action="raise",
            action_context="Hero faces a button open",
            preflop_opener_position="button",
            preflop_open_size=opening_size,
        )
    )

    assert result is not None
    assert result.action == expected_action
    assert result.raw["base_reraise_fraction"] == 0.12
    assert result.raw["reraise_fraction"] == expected_fraction


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


def test_supports_big_blind_defense_against_small_blind_open() -> None:
    result = solve_preflop_chart(
        request_for(
            ("Kh", "Ks"),
            position="big blind",
            current_bet=2,
            pot_size=4,
            facing_action="raise",
            action_context="Small blind opens to 3 BB",
        )
    )

    assert result is not None
    assert result.action == "raise"
    assert result.sizing == 9


def test_prefers_structured_preflop_opener_context() -> None:
    result = solve_preflop_chart(
        request_for(
            ("Kh", "Ks"),
            position="big blind",
            current_bet=1.5,
            pot_size=4,
            facing_action="raise",
            action_context="Hero faces 1.5 BB to call into a 4 BB pot",
            preflop_opener_position="button",
            preflop_open_size=2.5,
        )
    )

    assert result is not None
    assert result.action == "raise"
    assert result.sizing == 7.5
    assert result.raw["opener_position"] == "button"
    assert result.raw["opening_raise_size"] == 2.5


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
        request_for(
            ("Ah", "Ad"),
            position="button",
            preflop_opener_position="cutoff",
        ),
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
            position="big blind",
            current_bet=1.5,
            pot_size=4,
            facing_action="raise",
            preflop_opener_position="button",
            preflop_open_size=3,
        ),
        request_for(
            ("Ah", "Ad"),
            position="big blind",
            current_bet=1.5,
            pot_size=4,
            facing_action="raise",
            action_context="Button opens to 3 BB",
        ),
        request_for(
            ("Ah", "Ad"),
            position="big blind",
            current_bet=0.5,
            pot_size=3,
            facing_action="raise",
            preflop_opener_position="button",
            preflop_open_size=1.5,
        ),
        request_for(
            ("Ah", "Ad"),
            position="big blind",
            current_bet=3.5,
            pot_size=6,
            facing_action="raise",
            preflop_opener_position="button",
            preflop_open_size=4.5,
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
