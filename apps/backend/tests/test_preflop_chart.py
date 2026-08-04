from collections.abc import Callable

import pytest

from app.models import (
    CanonicalState,
    Card,
    FacingAction,
    PreflopAction,
    PreflopPosition,
    RecommendationRequest,
)
from app.solvers.preflop_chart import (
    COLD_THREE_BET_DEFENSE_POLICIES,
    COLD_THREE_BET_POLICY_NAME,
    DEFENSE_POLICIES,
    OPEN_SIZE_POLICIES,
    POSITION_POLICIES,
    SINGLE_CALLER_POLICY,
    STACK_DEPTH_POLICIES,
    THREE_BET_DEFENSE_POLICIES,
    THREE_BET_SIZE_POLICIES,
    adjusted_caller_defense_policy,
    adjusted_defense_policy,
    adjusted_three_bet_defense_policy,
    canonical_hand_class,
    hand_top_fraction,
    normalize_position,
    policy_for_stack_depth,
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
    hero_stack: float | None = None,
    effective_stack: float = 100,
    players_in_hand: int = 6,
    facing_action: FacingAction | None = None,
    action_context: str | None = None,
    preflop_opener_position: str | None = None,
    preflop_open_size: float | None = None,
    preflop_action_history: list[PreflopAction] | None = None,
) -> RecommendationRequest:
    return RecommendationRequest(
        provider="local_solver",
        state=CanonicalState(
            hero_cards=[Card.from_code(code) for code in cards],
            pot_size=pot_size,
            current_bet=current_bet,
            hero_stack=hero_stack,
            effective_stack=effective_stack,
            players_in_hand=players_in_hand,
            hero_position=position,
            preflop_opener_position=preflop_opener_position,
            preflop_open_size=preflop_open_size,
            preflop_action_history=preflop_action_history or [],
            street="preflop",
            facing_action=facing_action,
            action_context=action_context,
            user_approved=True,
        ),
    )


def structured_three_bet_request(
    cards: tuple[str, str],
    *,
    hero_position: PreflopPosition = "cutoff",
    three_bettor_position: PreflopPosition = "button",
    opening_size: float = 2.5,
    three_bet_size: float = 8.0,
    hero_stack: float | None = 97.5,
    effective_stack: float = 92.0,
    preflop_opener_position: str | None = None,
    preflop_open_size: float | None = None,
) -> RecommendationRequest:
    posted_blinds = {
        "utg": 0.0,
        "hijack": 0.0,
        "cutoff": 0.0,
        "button": 0.0,
        "small_blind": 0.5,
        "big_blind": 1.0,
    }
    pot_size = (
        1.5
        - posted_blinds[hero_position]
        - posted_blinds[three_bettor_position]
        + opening_size
        + three_bet_size
    )
    return request_for(
        cards,
        position=hero_position,
        current_bet=three_bet_size - opening_size,
        pot_size=pot_size,
        hero_stack=hero_stack,
        effective_stack=effective_stack,
        facing_action="raise",
        action_context="Ambiguous OCR text is ignored when history is approved",
        preflop_opener_position=preflop_opener_position,
        preflop_open_size=preflop_open_size,
        preflop_action_history=[
            PreflopAction(actor=hero_position, action="raise", amount=opening_size),
            PreflopAction(
                actor=three_bettor_position,
                action="raise",
                amount=three_bet_size,
            ),
        ],
    )


def structured_called_open_request(
    cards: tuple[str, str],
    *,
    opener_position: PreflopPosition = "utg",
    caller_position: PreflopPosition = "hijack",
    hero_position: PreflopPosition = "button",
    opening_size: float = 2.5,
    caller_amount: float | None = None,
    effective_stack: float = 100.0,
    players_in_hand: int = 3,
) -> RecommendationRequest:
    posted_blinds = {
        "utg": 0.0,
        "hijack": 0.0,
        "cutoff": 0.0,
        "button": 0.0,
        "small_blind": 0.5,
        "big_blind": 1.0,
    }
    resolved_caller_amount = caller_amount or opening_size
    pot_size = (
        1.5
        - posted_blinds[opener_position]
        - posted_blinds[caller_position]
        + opening_size
        + resolved_caller_amount
    )
    return request_for(
        cards,
        position=hero_position,
        current_bet=opening_size - posted_blinds[hero_position],
        pot_size=pot_size,
        effective_stack=effective_stack,
        players_in_hand=players_in_hand,
        facing_action="raise",
        action_context="Structured history is authoritative",
        preflop_opener_position=opener_position,
        preflop_open_size=opening_size,
        preflop_action_history=[
            PreflopAction(
                actor=opener_position,
                action="raise",
                amount=opening_size,
            ),
            PreflopAction(
                actor=caller_position,
                action="call",
                amount=resolved_caller_amount,
            ),
        ],
    )


def structured_cold_three_bet_request(
    cards: tuple[str, str],
    *,
    opener_position: PreflopPosition = "utg",
    three_bettor_position: PreflopPosition = "button",
    hero_position: PreflopPosition = "big_blind",
    opening_size: float = 2.5,
    three_bet_size: float = 8.0,
    hero_stack: float | None = 99.0,
    effective_stack: float = 92.0,
    players_in_hand: int = 3,
) -> RecommendationRequest:
    posted_blinds = {
        "utg": 0.0,
        "hijack": 0.0,
        "cutoff": 0.0,
        "button": 0.0,
        "small_blind": 0.5,
        "big_blind": 1.0,
    }
    pot_size = (
        1.5
        - posted_blinds[opener_position]
        - posted_blinds[three_bettor_position]
        + opening_size
        + three_bet_size
    )
    return request_for(
        cards,
        position=hero_position,
        current_bet=three_bet_size - posted_blinds[hero_position],
        pot_size=pot_size,
        hero_stack=hero_stack,
        effective_stack=effective_stack,
        players_in_hand=players_in_hand,
        facing_action="raise",
        action_context="Structured history is authoritative",
        preflop_opener_position=opener_position,
        preflop_open_size=opening_size,
        preflop_action_history=[
            PreflopAction(
                actor=opener_position,
                action="raise",
                amount=opening_size,
            ),
            PreflopAction(
                actor=three_bettor_position,
                action="raise",
                amount=three_bet_size,
            ),
        ],
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


def test_three_bet_defense_policies_cover_every_legal_position_matchup() -> None:
    expected_matchups = {
        (hero, three_bettor)
        for hero in POSITION_POLICIES
        for three_bettor in POSITION_POLICIES
        if POSITION_ACTION_ORDER[hero] < POSITION_ACTION_ORDER[three_bettor]
    }

    assert set(THREE_BET_DEFENSE_POLICIES) == expected_matchups
    assert all(
        0 < policy.four_bet_fraction <= policy.continue_fraction <= 1
        for policy in THREE_BET_DEFENSE_POLICIES.values()
    )


def test_cold_three_bet_policies_cover_every_legal_three_seat_order() -> None:
    expected_matchups = {
        (opener, three_bettor, hero)
        for opener in POSITION_POLICIES
        for three_bettor in POSITION_POLICIES
        for hero in POSITION_POLICIES
        if POSITION_ACTION_ORDER[opener]
        < POSITION_ACTION_ORDER[three_bettor]
        < POSITION_ACTION_ORDER[hero]
    }

    assert set(COLD_THREE_BET_DEFENSE_POLICIES) == expected_matchups
    assert all(
        0 < policy.four_bet_fraction <= policy.continue_fraction <= 1
        for policy in COLD_THREE_BET_DEFENSE_POLICIES.values()
    )


def test_cold_three_bet_policies_remain_valid_after_all_adjustments() -> None:
    for policy in COLD_THREE_BET_DEFENSE_POLICIES.values():
        for size_policy in THREE_BET_SIZE_POLICIES:
            for stack_policy in STACK_DEPTH_POLICIES:
                adjusted = adjusted_three_bet_defense_policy(
                    policy,
                    size_policy,
                    stack_policy,
                )
                assert (
                    0
                    < adjusted.four_bet_fraction
                    <= adjusted.continue_fraction
                    <= 1
                )


def test_cold_three_bet_policies_are_tighter_than_opener_defense() -> None:
    for (opener, three_bettor, _), cold_policy in (
        COLD_THREE_BET_DEFENSE_POLICIES.items()
    ):
        opener_policy = THREE_BET_DEFENSE_POLICIES[(opener, three_bettor)]
        assert cold_policy.continue_fraction < opener_policy.continue_fraction
        assert cold_policy.four_bet_fraction <= opener_policy.four_bet_fraction


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


def test_single_caller_policy_tightens_existing_defense_boundaries() -> None:
    base = adjusted_defense_policy(
        DEFENSE_POLICIES[("utg", "button")],
        OPEN_SIZE_POLICIES[1],
        STACK_DEPTH_POLICIES[2],
    )

    adjusted = adjusted_caller_defense_policy(base, SINGLE_CALLER_POLICY)

    assert adjusted.continue_fraction < base.continue_fraction
    assert adjusted.reraise_fraction < base.reraise_fraction
    assert 0 < adjusted.reraise_fraction <= adjusted.continue_fraction


def test_three_bet_size_policies_tighten_as_the_raise_grows() -> None:
    assert [policy.maximum_ratio for policy in THREE_BET_SIZE_POLICIES] == sorted(
        policy.maximum_ratio for policy in THREE_BET_SIZE_POLICIES
    )
    assert all(
        current.continue_multiplier >= following.continue_multiplier
        and current.four_bet_multiplier >= following.four_bet_multiplier
        for current, following in zip(
            THREE_BET_SIZE_POLICIES,
            THREE_BET_SIZE_POLICIES[1:],
        )
    )


def test_stack_depth_policies_are_ordered_and_keep_reraises_inside_continues() -> None:
    finite_maximums = [
        policy.maximum_stack
        for policy in STACK_DEPTH_POLICIES
        if policy.maximum_stack is not None
    ]

    assert finite_maximums == sorted(finite_maximums)
    assert STACK_DEPTH_POLICIES[-1].maximum_stack is None
    assert all(
        current.open_multiplier <= following.open_multiplier
        and current.continue_multiplier <= following.continue_multiplier
        and current.reraise_multiplier >= following.reraise_multiplier
        and current.opening_size <= following.opening_size
        for current, following in zip(STACK_DEPTH_POLICIES, STACK_DEPTH_POLICIES[1:])
    )
    for base_policy in DEFENSE_POLICIES.values():
        for size_policy in OPEN_SIZE_POLICIES:
            for stack_policy in STACK_DEPTH_POLICIES:
                adjusted = adjusted_defense_policy(
                    base_policy,
                    size_policy,
                    stack_policy,
                )
                assert adjusted.reraise_fraction <= adjusted.continue_fraction
    for base_policy in THREE_BET_DEFENSE_POLICIES.values():
        for size_policy in THREE_BET_SIZE_POLICIES:
            for stack_policy in STACK_DEPTH_POLICIES:
                adjusted = adjusted_three_bet_defense_policy(
                    base_policy,
                    size_policy,
                    stack_policy,
                )
                assert adjusted.four_bet_fraction <= adjusted.continue_fraction


@pytest.mark.parametrize(
    ("effective_stack", "expected_policy"),
    [
        (20.0, "short"),
        (20.01, "medium"),
        (50.0, "medium"),
        (50.01, "standard"),
        (150.0, "standard"),
        (150.01, "deep"),
    ],
)
def test_stack_depth_policy_boundaries(
    effective_stack: float,
    expected_policy: str,
) -> None:
    policy = policy_for_stack_depth(effective_stack)

    assert policy is not None
    assert policy.name == expected_policy


def test_opens_premium_hand_from_early_position() -> None:
    result = solve_preflop_chart(request_for(("Ah", "Ad"), position="UTG"))

    assert result is not None
    assert result.action == "raise"
    assert result.sizing == 2.5
    assert result.raw["engine"] == "preflop_chart_v1"
    assert result.raw["scenario"] == "first_in"
    assert result.raw["chart_tier"] == "open"


@pytest.mark.parametrize(
    ("effective_stack", "expected_action", "expected_policy", "expected_fraction"),
    [
        (20, "fold", "short", 0.405),
        (100, "raise", "standard", 0.45),
    ],
)
def test_first_in_range_accounts_for_stack_depth(
    effective_stack: float,
    expected_action: str,
    expected_policy: str,
    expected_fraction: float,
) -> None:
    result = solve_preflop_chart(
        request_for(
            ("9h", "8d"),
            position="button",
            effective_stack=effective_stack,
        )
    )

    assert result is not None
    assert result.action == expected_action
    assert result.raw["policy_source"] == "hero_position_stack"
    assert result.raw["stack_depth_policy"] == expected_policy
    assert result.raw["base_open_fraction"] == 0.45
    assert result.raw["open_fraction"] == expected_fraction


def test_short_stack_uses_smaller_first_in_open_size() -> None:
    result = solve_preflop_chart(
        request_for(
            ("Ah", "Ad"),
            position="button",
            effective_stack=20,
        )
    )

    assert result is not None
    assert result.action == "raise"
    assert result.sizing == 2.2
    assert result.raw["target_open_size"] == 2.2


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
    assert result.raw["policy_source"] == "hero_opener_size_stack_matchup"
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
    assert result.raw["base_opener_open_fraction"] == (
        0.17 if opener_position == "utg" else 0.45
    )
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


@pytest.mark.parametrize(
    ("effective_stack", "expected_action", "expected_policy", "expected_fraction"),
    [
        (20, "fold", "short", 0.36),
        (100, "call", "standard", 0.40),
    ],
)
def test_big_blind_continue_range_accounts_for_stack_depth(
    effective_stack: float,
    expected_action: str,
    expected_policy: str,
    expected_fraction: float,
) -> None:
    result = solve_preflop_chart(
        request_for(
            ("7h", "6h"),
            position="big blind",
            current_bet=1.5,
            pot_size=4,
            effective_stack=effective_stack,
            facing_action="raise",
            preflop_opener_position="button",
            preflop_open_size=2.5,
        )
    )

    assert result is not None
    assert result.action == expected_action
    assert result.raw["stack_depth_policy"] == expected_policy
    assert result.raw["continue_fraction"] == expected_fraction
    assert result.raw["base_opener_open_fraction"] == 0.45
    assert result.raw["opener_open_fraction"] == (0.405 if effective_stack == 20 else 0.45)


@pytest.mark.parametrize(
    ("effective_stack", "expected_action", "expected_policy", "expected_fraction"),
    [
        (20, "raise", "short", 0.156),
        (100, "call", "standard", 0.12),
    ],
)
def test_big_blind_reraise_range_accounts_for_stack_depth(
    effective_stack: float,
    expected_action: str,
    expected_policy: str,
    expected_fraction: float,
) -> None:
    result = solve_preflop_chart(
        request_for(
            ("Ah", "Jd"),
            position="big blind",
            current_bet=1.5,
            pot_size=4,
            effective_stack=effective_stack,
            facing_action="raise",
            preflop_opener_position="button",
            preflop_open_size=2.5,
        )
    )

    assert result is not None
    assert result.action == expected_action
    assert result.raw["stack_depth_policy"] == expected_policy
    assert result.raw["reraise_fraction"] == expected_fraction


@pytest.mark.parametrize(
    ("effective_stack", "expected_action", "expected_sizing"),
    [
        (1.4, "call", None),
        (1.6, "raise", 2.6),
        (2.6, "raise", 3.6),
    ],
)
def test_short_stack_reraise_requires_a_total_above_the_open(
    effective_stack: float,
    expected_action: str,
    expected_sizing: float | None,
) -> None:
    result = solve_preflop_chart(
        request_for(
            ("Ah", "Jd"),
            position="big blind",
            current_bet=1.5,
            pot_size=4,
            effective_stack=effective_stack,
            facing_action="raise",
            preflop_opener_position="button",
            preflop_open_size=2.5,
        )
    )

    assert result is not None
    assert result.action == expected_action
    assert result.sizing == expected_sizing


def test_reraise_uses_opponent_total_when_hero_covers() -> None:
    result = solve_preflop_chart(
        request_for(
            ("Ah", "Jd"),
            position="big blind",
            current_bet=1.5,
            pot_size=4,
            hero_stack=10,
            effective_stack=1,
            facing_action="raise",
            preflop_opener_position="button",
            preflop_open_size=2.5,
        )
    )

    assert result is not None
    assert result.action == "raise"
    assert result.sizing == 3.5
    assert result.raw["maximum_reraise_total"] == 3.5


def test_reraises_premium_hand_and_caps_size_to_effective_total() -> None:
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
    assert result.sizing == 7
    assert result.raw["maximum_reraise_total"] == 7
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


def test_structured_single_open_takes_precedence_over_ambiguous_text() -> None:
    result = solve_preflop_chart(
        request_for(
            ("Ah", "Jd"),
            position="button",
            current_bet=2.5,
            pot_size=4,
            facing_action="raise",
            action_context="OCR could not identify the action",
            preflop_action_history=[
                PreflopAction(actor="cutoff", action="raise", amount=2.5)
            ],
        )
    )

    assert result is not None
    assert result.action == "call"
    assert result.raw["scenario"] == "facing_open_raise"
    assert result.raw["opener_position"] == "cutoff"


@pytest.mark.parametrize(
    ("cards", "expected_action", "expected_tier"),
    [
        (("Ah", "Ad"), "raise", "four_bet"),
        (("8h", "8s"), "call", "continue"),
        (("7h", "2d"), "fold", "fold"),
    ],
)
def test_structured_three_bet_history_routes_position_aware_response(
    cards: tuple[str, str],
    expected_action: str,
    expected_tier: str,
) -> None:
    result = solve_preflop_chart(structured_three_bet_request(cards))

    assert result is not None
    assert result.action == expected_action
    assert result.raw["scenario"] == "facing_three_bet"
    assert result.raw["chart_tier"] == expected_tier
    assert result.raw["opener_position"] == "cutoff"
    assert result.raw["three_bettor_position"] == "button"
    assert result.raw["opening_raise_size"] == 2.5
    assert result.raw["three_bet_size"] == 8
    assert result.raw["three_bet_to_open_ratio"] == 3.2


@pytest.mark.parametrize(
    ("cards", "expected_action", "expected_tier"),
    [
        (("Ah", "Ad"), "raise", "four_bet"),
        (("Th", "Ts"), "call", "continue"),
        (("7h", "2d"), "fold", "fold"),
    ],
)
def test_cold_three_bet_history_routes_conservative_response(
    cards: tuple[str, str],
    expected_action: str,
    expected_tier: str,
) -> None:
    result = solve_preflop_chart(structured_cold_three_bet_request(cards))

    assert result is not None
    assert result.action == expected_action
    assert result.raw["scenario"] == "facing_cold_three_bet"
    assert result.raw["chart_tier"] == expected_tier
    assert result.raw["opener_position"] == "utg"
    assert result.raw["three_bettor_position"] == "button"
    assert result.raw["opening_raise_size"] == 2.5
    assert result.raw["three_bet_size"] == 8
    assert result.raw["three_bet_to_open_ratio"] == 3.2
    assert result.raw["cold_three_bet_policy"] == COLD_THREE_BET_POLICY_NAME
    assert result.raw["policy_source"] == (
        "hero_opener_three_bettor_size_stack_matchup"
    )


def test_cold_four_bet_cap_uses_only_hero_posted_blind() -> None:
    result = solve_preflop_chart(
        structured_cold_three_bet_request(
            ("Ah", "Ad"),
            hero_stack=10,
            effective_stack=10,
        )
    )

    assert result is not None
    assert result.action == "raise"
    assert result.sizing == 11
    assert result.raw["maximum_four_bet_total"] == 11


@pytest.mark.parametrize(
    "mutation",
    [
        lambda state: setattr(state, "players_in_hand", 4),
        lambda state: setattr(state, "current_bet", 5.5),
        lambda state: setattr(state, "pot_size", 11),
        lambda state: setattr(state, "hero_stack", None),
        lambda state: setattr(state, "hero_stack", 6),
        lambda state: setattr(state, "effective_stack", 100),
        lambda state: setattr(state, "preflop_opener_position", "hijack"),
        lambda state: setattr(state, "preflop_open_size", 3),
        lambda state: setattr(
            state,
            "preflop_action_history",
            [
                PreflopAction(actor="button", action="raise", amount=2.5),
                PreflopAction(actor="utg", action="raise", amount=8),
            ],
        ),
    ],
)
def test_declines_inconsistent_cold_three_bet_state(
    mutation: Callable[[CanonicalState], None],
) -> None:
    request = structured_cold_three_bet_request(("Ah", "Ad"))
    mutation(request.state)

    assert solve_preflop_chart(request) is None


@pytest.mark.parametrize(
    ("cards", "expected_action", "expected_tier"),
    [
        (("Ah", "Ad"), "raise", "squeeze"),
        (("Ah", "Jh"), "call", "overcall"),
        (("Kh", "Qd"), "fold", "fold"),
    ],
)
def test_single_caller_history_routes_conservative_response(
    cards: tuple[str, str],
    expected_action: str,
    expected_tier: str,
) -> None:
    result = solve_preflop_chart(structured_called_open_request(cards))

    assert result is not None
    assert result.action == expected_action
    assert result.raw["scenario"] == "facing_open_with_caller"
    assert result.raw["chart_tier"] == expected_tier
    assert result.raw["opener_position"] == "utg"
    assert result.raw["caller_positions"] == ["hijack"]
    assert result.raw["caller_count"] == 1
    assert result.raw["caller_adjustment_policy"] == "single_caller_conservative"
    assert result.raw["policy_source"] == "hero_opener_caller_size_stack_matchup"


def test_single_caller_squeeze_uses_larger_raise_target() -> None:
    called = solve_preflop_chart(structured_called_open_request(("Ah", "Ad")))
    unopened_call = solve_preflop_chart(
        request_for(
            ("Ah", "Ad"),
            position="button",
            current_bet=2.5,
            pot_size=4,
            facing_action="raise",
            preflop_opener_position="utg",
            preflop_open_size=2.5,
        )
    )

    assert called is not None
    assert unopened_call is not None
    assert called.action == "raise"
    assert unopened_call.action == "raise"
    assert called.sizing == 10
    assert unopened_call.sizing == 7.5
    assert called.raw["squeeze_open_multiple"] == 4


def test_single_caller_tightens_boundary_hand_to_fold() -> None:
    called = solve_preflop_chart(structured_called_open_request(("Kh", "Qd")))
    heads_up = solve_preflop_chart(
        request_for(
            ("Kh", "Qd"),
            position="button",
            current_bet=2.5,
            pot_size=4,
            facing_action="raise",
            preflop_opener_position="utg",
            preflop_open_size=2.5,
        )
    )

    assert called is not None
    assert heads_up is not None
    assert called.action == "fold"
    assert heads_up.action == "call"
    assert called.raw["continue_fraction"] < heads_up.raw["continue_fraction"]


@pytest.mark.parametrize(
    "mutation",
    [
        lambda state: setattr(state, "players_in_hand", 4),
        lambda state: setattr(state, "current_bet", 2),
        lambda state: setattr(state, "pot_size", 6),
        lambda state: setattr(
            state,
            "preflop_action_history",
            [
                PreflopAction(actor="utg", action="raise", amount=2.5),
                PreflopAction(actor="hijack", action="call", amount=2),
            ],
        ),
        lambda state: setattr(
            state,
            "preflop_action_history",
            [
                PreflopAction(actor="hijack", action="raise", amount=2.5),
                PreflopAction(actor="utg", action="call", amount=2.5),
            ],
        ),
    ],
)
def test_declines_inconsistent_single_caller_state(
    mutation: Callable[[CanonicalState], None],
) -> None:
    request = structured_called_open_request(("Ah", "Ad"))
    mutation(request.state)

    assert solve_preflop_chart(request) is None


def test_three_bet_size_tightens_continue_boundary() -> None:
    small = solve_preflop_chart(
        structured_three_bet_request(
            ("Ah", "Qd"),
            three_bet_size=6.5,
            effective_stack=93.5,
        )
    )
    very_large = solve_preflop_chart(
        structured_three_bet_request(
            ("Ah", "Qd"),
            three_bet_size=12,
            effective_stack=88,
        )
    )

    assert small is not None
    assert very_large is not None
    assert small.action == "call"
    assert very_large.action == "fold"
    assert small.raw["three_bet_size_policy"] == "small"
    assert very_large.raw["three_bet_size_policy"] == "very_large"
    assert small.raw["continue_fraction"] > very_large.raw["continue_fraction"]


def test_short_stack_moves_boundary_hand_into_four_bet_range() -> None:
    short = solve_preflop_chart(
        structured_three_bet_request(
            ("8h", "8s"),
            hero_stack=17.5,
            effective_stack=12,
        )
    )
    standard = solve_preflop_chart(structured_three_bet_request(("8h", "8s")))

    assert short is not None
    assert standard is not None
    assert short.action == "raise"
    assert standard.action == "call"
    assert short.raw["stack_depth_policy"] == "short"
    assert short.raw["four_bet_fraction"] > standard.raw["four_bet_fraction"]


def test_four_bet_size_is_capped_by_hero_total_stack() -> None:
    result = solve_preflop_chart(
        structured_three_bet_request(
            ("Ah", "Ad"),
            hero_stack=9.5,
            effective_stack=9.5,
        )
    )

    assert result is not None
    assert result.action == "raise"
    assert result.sizing == 12
    assert result.raw["maximum_four_bet_total"] == 12


@pytest.mark.parametrize(
    "mutation",
    [
        lambda state: setattr(state, "current_bet", 5),
        lambda state: setattr(state, "pot_size", 11),
        lambda state: setattr(state, "hero_stack", None),
        lambda state: setattr(state, "hero_stack", 5),
        lambda state: setattr(state, "effective_stack", 98),
        lambda state: setattr(state, "preflop_opener_position", "hijack"),
        lambda state: setattr(state, "preflop_open_size", 3),
    ],
)
def test_declines_inconsistent_structured_three_bet_state(
    mutation: Callable[[CanonicalState], None],
) -> None:
    request = structured_three_bet_request(("Ah", "Ad"))
    mutation(request.state)

    assert solve_preflop_chart(request) is None


@pytest.mark.parametrize(
    "history",
    [
        [PreflopAction(actor="cutoff", action="call", amount=2.5)],
        [PreflopAction(actor="button", action="raise", amount=2.5)],
        [
            PreflopAction(actor="hijack", action="raise", amount=2.5),
            PreflopAction(actor="button", action="raise", amount=8),
        ],
        [
            PreflopAction(actor="cutoff", action="raise", amount=2.5),
            PreflopAction(actor="hijack", action="raise", amount=8),
        ],
        [
            PreflopAction(actor="cutoff", action="raise", amount=2.5),
            PreflopAction(actor="button", action="raise", amount=3.5),
        ],
        [
            PreflopAction(actor="cutoff", action="raise", amount=2.5),
            PreflopAction(actor="button", action="raise", amount=8),
            PreflopAction(actor="small_blind", action="raise", amount=20),
        ],
    ],
)
def test_declines_unsupported_structured_preflop_histories(
    history: list[PreflopAction],
) -> None:
    request = structured_three_bet_request(("Ah", "Ad"))
    request.state.preflop_action_history = history

    assert solve_preflop_chart(request) is None


def test_declines_three_bet_larger_than_supported_size_band() -> None:
    result = solve_preflop_chart(
        structured_three_bet_request(
            ("Ah", "Ad"),
            three_bet_size=13,
            effective_stack=87,
        )
    )

    assert result is None


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
