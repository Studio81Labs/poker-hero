#[cfg(test)]
use postflop_solver::BetSize;
use postflop_solver::{
    card_from_str, flop_from_str, hole_to_string, solve, Action, ActionTree, BetSizeOptions,
    BoardState, CardConfig, PostFlopGame, Range, TreeConfig, NOT_DEALT,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};
use std::process::ExitCode;

const CHIP_SCALE: f64 = 100.0;
const ENGINE_REVISION: &str = "9d1509f";
const DEFAULT_OOP_RANGE: &str = "66+,A8s+,A5s-A4s,AJo+,K9s+,KQo,QTs+,JTs,96s+,85s+,75s+,65s,54s";
const DEFAULT_IP_RANGE: &str =
    "QQ-22,AQs-A2s,ATo+,K5s+,KJo+,Q8s+,J8s+,T7s+,96s+,86s+,75s+,64s+,53s+";

#[derive(Deserialize)]
struct RecommendationRequest {
    state: CanonicalState,
}

#[derive(Deserialize)]
struct CanonicalState {
    hero_cards: Vec<InputCard>,
    board_cards: Vec<InputCard>,
    pot_size: Option<f64>,
    current_bet: Option<f64>,
    hero_stack: Option<f64>,
    opponent_stack: Option<f64>,
    effective_stack: Option<f64>,
    players_in_hand: Option<u8>,
    hero_position: Option<String>,
    opponent_position: Option<String>,
    street: Option<String>,
    facing_action: Option<String>,
    #[serde(default)]
    postflop_action_history: Vec<PostflopActionInput>,
    #[serde(default)]
    completed_postflop_streets: Vec<CompletedPostflopStreetInput>,
}

#[derive(Deserialize)]
struct PostflopActionInput {
    actor: String,
    action: String,
    amount: Option<f64>,
}

#[derive(Deserialize)]
struct CompletedPostflopStreetInput {
    street: String,
    actions: Vec<CompletedPostflopActionInput>,
}

#[derive(Deserialize)]
struct CompletedPostflopActionInput {
    actor: String,
    action: String,
    amount: Option<f64>,
}

#[derive(Deserialize)]
struct InputCard {
    rank: String,
    suit: String,
}

#[derive(Serialize)]
struct RecommendationResult {
    action: String,
    sizing: Option<f64>,
    confidence: f64,
    explanation: String,
    raw: Value,
}

#[derive(Serialize)]
struct CandidateResult {
    action: String,
    sizing: Option<f64>,
    frequency: f64,
    ev: f64,
    solver_action: String,
}

#[derive(Debug)]
struct TreeAmounts {
    starting_pot: i32,
    current_bet: i32,
    effective_stack: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModeledActionKind {
    Check,
    Bet,
    Raise,
    Call,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ModeledAction {
    actor: usize,
    kind: ModeledActionKind,
    amount: i32,
}

#[derive(Debug, Default)]
struct PreparedHistory {
    actions: Vec<ModeledAction>,
    contributions: [i32; 2],
    observed_bet: Option<i32>,
    observed_raise_adders: Vec<i32>,
}

#[derive(Debug)]
struct PreparedStreetHistory {
    street: String,
    history: PreparedHistory,
}

#[derive(Debug)]
struct ConditioningPlan {
    completed: Vec<PreparedStreetHistory>,
    starting_pot: i32,
    effective_stack: i32,
}

struct ConditionedRanges {
    ranges: [Range; 2],
    evidence: Value,
    applied: bool,
}

#[derive(Clone, Copy)]
struct SolverOptions {
    max_memory_mb: f64,
    max_iterations: u32,
    target_ratio: f64,
    rake_rate: f64,
    rake_cap: f64,
}

struct StreetBetSizes {
    flop: [BetSizeOptions; 2],
    turn: [BetSizeOptions; 2],
    river: [BetSizeOptions; 2],
}

fn main() -> ExitCode {
    match read_request().and_then(solve_request) {
        Ok(result) => match serde_json::to_string(&result) {
            Ok(payload) => {
                println!("{payload}");
                ExitCode::SUCCESS
            }
            Err(error) => fail(format!("Could not serialize solver response: {error}")),
        },
        Err(error) => fail(error),
    }
}

fn read_request() -> Result<RecommendationRequest, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("Could not read solver request: {error}"))?;
    serde_json::from_str(&input).map_err(|error| format!("Invalid solver request JSON: {error}"))
}

fn solve_request(request: RecommendationRequest) -> Result<RecommendationResult, String> {
    let state = request.state;
    validate_state(&state)?;

    let street = state.street.as_deref().unwrap();
    let board_state = board_state(street)?;
    let hero_player = hero_player(
        state.hero_position.as_deref(),
        state.opponent_position.as_deref(),
    )?;
    let pot_size = positive_value(state.pot_size, "pot_size")?;
    let current_bet = non_negative_value(state.current_bet, "current_bet")?;
    let effective_stack = effective_stack_value(state.effective_stack, current_bet)?;
    let prepared_history = prepare_action_history(&state, hero_player, current_bet)?;
    let completed_histories = prepare_completed_histories(&state)?;
    let conditioning = conditioning_plan(
        &state,
        hero_player,
        pot_size,
        current_bet,
        effective_stack,
        &prepared_history,
        completed_histories,
    )?;
    let current_amounts = tree_amounts(
        pot_size,
        current_bet,
        effective_stack,
        state.hero_stack,
        state.opponent_stack,
        hero_player,
        &prepared_history,
    )?;
    let starting_pot = current_amounts.starting_pot;
    let tree_stack = current_amounts.effective_stack;
    let scaled_bet = current_amounts.current_bet;

    let hero_hand = hero_hand_code(&state.hero_cards)?;
    let mut oop_range = env_string("POKER_POSTFLOP_SOLVER_OOP_RANGE", DEFAULT_OOP_RANGE);
    let mut ip_range = env_string("POKER_POSTFLOP_SOLVER_IP_RANGE", DEFAULT_IP_RANGE);
    let range_source_value = env_string("POKER_POSTFLOP_SOLVER_RANGE_SOURCE", "configured");
    let range_source = validated_range_source(&range_source_value)?;
    let range_context =
        range_context_from_json(&env_string("POKER_POSTFLOP_SOLVER_RANGE_CONTEXT", "{}"))?;
    if hero_player == 0 {
        oop_range = include_hand(&oop_range, &hero_hand);
    } else {
        ip_range = include_hand(&ip_range, &hero_hand);
    }

    let solver_options = SolverOptions {
        max_memory_mb: positive_env_number("POKER_POSTFLOP_SOLVER_MAX_MEMORY_MB", 768.0)?,
        max_iterations: env_integer("POKER_POSTFLOP_SOLVER_MAX_ITERATIONS", 400)?,
        target_ratio: positive_env_number("POKER_POSTFLOP_SOLVER_TARGET_EXPLOITABILITY", 0.01)?,
        rake_rate: env_number("POKER_POSTFLOP_SOLVER_RAKE_RATE", 0.0)?,
        rake_cap: env_number("POKER_POSTFLOP_SOLVER_RAKE_CAP", 0.0)? * CHIP_SCALE,
    };
    let conditioned = conditioning
        .as_ref()
        .map(|plan| {
            condition_ranges(
                &state,
                hero_player,
                &oop_range,
                &ip_range,
                plan,
                solver_options,
            )
        })
        .transpose()?;
    let game_ranges = if let Some(result) = &conditioned {
        result.ranges
    } else {
        [oop_range.parse::<Range>()?, ip_range.parse::<Range>()?]
    };

    let bet_sizes = configured_bet_sizes(&board_state, scaled_bet, &prepared_history)?;
    let card_config = card_config_from_ranges(&state, game_ranges, &board_state)?;
    let tree_config = TreeConfig {
        initial_state: board_state,
        starting_pot,
        effective_stack: tree_stack,
        rake_rate: solver_options.rake_rate,
        rake_cap: solver_options.rake_cap,
        flop_bet_sizes: bet_sizes.flop,
        turn_bet_sizes: bet_sizes.turn,
        river_bet_sizes: bet_sizes.river,
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: 1.2,
        // Preserve the exact observed bet instead of rewriting near-all-in sizes.
        force_allin_threshold: 0.0,
        merging_threshold: 0.0,
    };

    let action_tree = ActionTree::new(tree_config)
        .map_err(|error| format!("Could not build postflop action tree: {error}"))?;
    let mut game = PostFlopGame::with_config(card_config, action_tree)
        .map_err(|error| format!("Could not initialize postflop game: {error}"))?;

    let (_, compressed_memory) = game.memory_usage();
    if compressed_memory as f64 > solver_options.max_memory_mb * 1024.0 * 1024.0 {
        return Err(format!(
            "estimated compressed game tree is {:.0} MB, above the configured {:.0} MB limit",
            compressed_memory as f64 / (1024.0 * 1024.0),
            solver_options.max_memory_mb
        ));
    }

    game.allocate_memory(true);
    let modeled_history =
        move_to_hero_decision(&mut game, hero_player, scaled_bet, &prepared_history)?;
    if game.current_player() != hero_player {
        return Err("modeled action history did not reach the hero decision".to_string());
    }
    let action_history = game.history().to_vec();
    game.back_to_root();

    let target_exploitability = starting_pot as f32 * solver_options.target_ratio as f32;
    let exploitability = solve(
        &mut game,
        solver_options.max_iterations,
        target_exploitability,
        false,
    );
    game.apply_history(&action_history);
    if game.current_player() != hero_player {
        return Err("solved action history did not return to the hero decision".to_string());
    }

    game.cache_normalized_weights();
    let actions = game.available_actions();
    let strategy = game.strategy();
    let expected_values = game.expected_values_detail(hero_player);
    let hero_cards = hero_card_ids(&state.hero_cards)?;
    let private_cards = game.private_cards(hero_player);
    let hero_index = private_cards
        .iter()
        .position(|cards| *cards == hero_cards)
        .ok_or_else(|| "hero cards are not present in the configured range".to_string())?;
    let num_hands = private_cards.len();

    let candidates = actions
        .iter()
        .enumerate()
        .map(|(action_index, action)| {
            let frequency = strategy[action_index * num_hands + hero_index] as f64;
            let ev = expected_values[action_index * num_hands + hero_index] as f64 / CHIP_SCALE;
            let (name, sizing) = normalized_action(*action, scaled_bet > 0);
            CandidateResult {
                action: name.to_string(),
                sizing,
                frequency: round(frequency, 4),
                ev: round(ev, 3),
                solver_action: format!("{action:?}"),
            }
        })
        .collect::<Vec<_>>();

    let best = candidates
        .iter()
        .max_by(|left, right| {
            left.frequency
                .total_cmp(&right.frequency)
                .then(left.ev.total_cmp(&right.ev))
        })
        .ok_or_else(|| "postflop solver returned no candidate actions".to_string())?;

    let exploitability_bb = exploitability as f64 / CHIP_SCALE;
    let exploitability_ratio = exploitability as f64 / starting_pot as f64;
    let solve_quality = (1.0 - exploitability_ratio).clamp(0.0, 1.0);
    let confidence = round(
        (0.5 + 0.45 * solve_quality * best.frequency).clamp(0.5, 0.95),
        2,
    );
    let position = if hero_player == 1 { "IP" } else { "OOP" };
    let size_text = best
        .sizing
        .map(|size| format!(" to {} BB", display_amount(size)))
        .unwrap_or_default();
    let range_description = if conditioned.as_ref().is_some_and(|result| result.applied) {
        "ranges conditioned through the reviewed prior-street actions"
    } else if range_source == "configured" {
        "configured ranges"
    } else {
        "preflop-history-derived ranges"
    };
    let explanation = format!(
        "Postflop solver analyzed a heads-up {street} tree using {range_description} and recommends {}{size_text} at {:.0}% frequency. The position was modeled as {position}; tree exploitability was {:.3} BB. Treat the result as training guidance because the ranges and modeled tree are assumptions.",
        best.action,
        best.frequency * 100.0,
        exploitability_bb,
    );

    Ok(RecommendationResult {
        action: best.action.clone(),
        sizing: best.sizing,
        confidence,
        explanation,
        raw: json!({
            "provider": "local_solver",
            "engine": "postflop_solver",
            "engine_revision": ENGINE_REVISION,
            "algorithm": "discounted_cfr",
            "street": street,
            "hero_position": position.to_lowercase(),
            "facing_action": state.facing_action,
            "modeled_history": modeled_history,
            "ranges": {"oop": oop_range, "ip": ip_range},
            "range_source": range_source,
            "range_context": range_context,
            "range_conditioning": conditioned.as_ref().map(|result| &result.evidence),
            "tree": {
                "starting_pot": starting_pot as f64 / CHIP_SCALE,
                "effective_stack": tree_stack as f64 / CHIP_SCALE,
                "visible_effective_stack": effective_stack,
                "hero_stack": state.hero_stack,
                "opponent_stack": state.opponent_stack,
                "compressed_memory_mb": round(compressed_memory as f64 / (1024.0 * 1024.0), 1),
                "max_iterations": solver_options.max_iterations,
                "target_exploitability_ratio": solver_options.target_ratio,
            },
            "exploitability": {
                "bb": round(exploitability_bb, 4),
                "pot_ratio": round(exploitability_ratio, 5),
            },
            "candidates": candidates,
            "process_boundary": "stdin_stdout_json",
        }),
    })
}

fn validate_state(state: &CanonicalState) -> Result<(), String> {
    let street = state
        .street
        .as_deref()
        .ok_or_else(|| "street is required".to_string())?;
    let expected_board = match street {
        "flop" => 3,
        "turn" => 4,
        "river" => 5,
        "preflop" => return Err("postflop-solver does not support preflop".to_string()),
        _ => return Err(format!("unknown street: {street}")),
    };
    if state.hero_cards.len() != 2 {
        return Err("exactly two hero cards are required".to_string());
    }
    if state.board_cards.len() != expected_board {
        return Err(format!("{street} requires {expected_board} board cards"));
    }
    if state.players_in_hand != Some(2) {
        return Err("postflop-solver supports heads-up spots only".to_string());
    }
    if state.current_bet.unwrap_or(0.0) > 0.0 {
        match state.facing_action.as_deref() {
            Some("bet") => {}
            Some("raise") if !state.postflop_action_history.is_empty() => {}
            Some("raise") => {
                return Err("a raised postflop spot requires structured action history".to_string())
            }
            _ => return Err("facing action must identify the outstanding wager".to_string()),
        }
    } else if state.facing_action.is_some() {
        return Err("facing action requires a positive amount to call".to_string());
    }
    Ok(())
}

#[cfg(test)]
fn card_config(
    state: &CanonicalState,
    oop_range: &str,
    ip_range: &str,
    initial_state: &BoardState,
) -> Result<CardConfig, String> {
    card_config_from_ranges(
        state,
        [oop_range.parse::<Range>()?, ip_range.parse::<Range>()?],
        initial_state,
    )
}

fn card_config_from_ranges(
    state: &CanonicalState,
    ranges: [Range; 2],
    initial_state: &BoardState,
) -> Result<CardConfig, String> {
    let board = state
        .board_cards
        .iter()
        .map(card_code)
        .collect::<Result<Vec<_>, _>>()?;
    let flop = flop_from_str(&board[..3].join(""))?;
    let turn = if !matches!(initial_state, BoardState::Flop) && board.len() >= 4 {
        card_from_str(&board[3])?
    } else {
        NOT_DEALT
    };
    let river = if matches!(initial_state, BoardState::River) && board.len() == 5 {
        card_from_str(&board[4])?
    } else {
        NOT_DEALT
    };
    Ok(CardConfig {
        range: ranges,
        flop,
        turn,
        river,
    })
}

fn condition_ranges(
    state: &CanonicalState,
    hero_player: usize,
    oop_range: &str,
    ip_range: &str,
    plan: &ConditioningPlan,
    options: SolverOptions,
) -> Result<ConditionedRanges, String> {
    let initial_ranges = [oop_range.parse::<Range>()?, ip_range.parse::<Range>()?];
    let bet_sizes = conditioning_bet_sizes(plan)?;
    let card_config = card_config_from_ranges(state, initial_ranges, &BoardState::Flop)?;
    let tree_config = TreeConfig {
        initial_state: BoardState::Flop,
        starting_pot: plan.starting_pot,
        effective_stack: plan.effective_stack,
        rake_rate: options.rake_rate,
        rake_cap: options.rake_cap,
        flop_bet_sizes: bet_sizes.flop,
        turn_bet_sizes: bet_sizes.turn,
        river_bet_sizes: bet_sizes.river,
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: 0.0,
        force_allin_threshold: 0.0,
        merging_threshold: 0.0,
    };
    let action_tree = ActionTree::new(tree_config)
        .map_err(|error| format!("Could not build conditioning action tree: {error}"))?;
    let mut game = PostFlopGame::with_config(card_config, action_tree)
        .map_err(|error| format!("Could not initialize conditioning game: {error}"))?;
    let (_, compressed_memory) = game.memory_usage();
    let compressed_memory_mb = compressed_memory as f64 / (1024.0 * 1024.0);
    if compressed_memory_mb > options.max_memory_mb {
        return Ok(ConditionedRanges {
            ranges: initial_ranges,
            evidence: json!({
                "status": "skipped",
                "reason": "conditioning tree exceeds the configured memory limit",
                "estimated_compressed_memory_mb": round(compressed_memory_mb, 1),
                "max_memory_mb": options.max_memory_mb,
            }),
            applied: false,
        });
    }

    game.allocate_memory(true);
    let modeled_history = move_through_completed(&mut game, state, plan)?;
    let action_history = game.history().to_vec();
    game.back_to_root();
    let target_exploitability = plan.starting_pot as f32 * options.target_ratio as f32;
    let exploitability = solve(
        &mut game,
        options.max_iterations,
        target_exploitability,
        false,
    );
    game.apply_history(&action_history);

    let hero_cards = hero_card_ids(&state.hero_cards)?;
    let mut posterior_ranges = [Range::default(); 2];
    let mut active_hands = [0; 2];
    let mut hero_reach = 0.0;
    for player in 0..2 {
        let hands = game.private_cards(player);
        let mut weights = game.weights(player).to_vec();
        if player == hero_player {
            let hero_index = hands
                .iter()
                .position(|cards| *cards == hero_cards)
                .ok_or_else(|| {
                    "hero cards are not present in the conditioning range".to_string()
                })?;
            hero_reach = weights[hero_index] as f64;
            if weights[hero_index] <= 0.0 {
                weights[hero_index] = f32::EPSILON;
            }
        }
        active_hands[player] = weights.iter().filter(|weight| **weight > 0.0).count();
        if active_hands[player] == 0 {
            return Ok(ConditionedRanges {
                ranges: initial_ranges,
                evidence: json!({
                    "status": "skipped",
                    "reason": "reviewed line has zero reach for one player",
                }),
                applied: false,
            });
        }
        posterior_ranges[player] = Range::from_hands_weights(hands, &weights)?;
    }

    let exploitability_bb = exploitability as f64 / CHIP_SCALE;
    let exploitability_ratio = exploitability as f64 / plan.starting_pot as f64;
    Ok(ConditionedRanges {
        ranges: posterior_ranges,
        evidence: json!({
            "status": "applied",
            "mode": "flop_root_posterior",
            "decision_street": state.street,
            "completed_streets": plan.completed.iter().map(|item| item.street.as_str()).collect::<Vec<_>>(),
            "modeled_history": modeled_history,
            "downstream_tree": "single_bet_no_raises",
            "active_hands": {"oop": active_hands[0], "ip": active_hands[1]},
            "hero_line_reach": round(hero_reach, 6),
            "compressed_memory_mb": round(compressed_memory_mb, 1),
            "exploitability": {
                "bb": round(exploitability_bb, 4),
                "pot_ratio": round(exploitability_ratio, 5),
            },
        }),
        applied: true,
    })
}

fn conditioning_bet_sizes(plan: &ConditioningPlan) -> Result<StreetBetSizes, String> {
    let configured_bets =
        conditioning_bet_size(&env_string("POKER_POSTFLOP_SOLVER_BET_SIZES", "70%"))?;
    let mut flop_history = None;
    let mut turn_history = None;
    for item in &plan.completed {
        match item.street.as_str() {
            "flop" => flop_history = Some(&item.history),
            "turn" => turn_history = Some(&item.history),
            _ => {}
        }
    }
    let flop = paired_sizes(&configured_sizes_for_street(
        flop_history,
        None,
        &configured_bets,
        "",
    )?);
    let turn = paired_sizes(&configured_sizes_for_street(
        turn_history,
        None,
        &configured_bets,
        "",
    )?);
    let river = paired_sizes(&configured_sizes_for_street(
        None,
        None,
        &configured_bets,
        "",
    )?);
    Ok(StreetBetSizes { flop, turn, river })
}

fn conditioning_bet_size(configured: &str) -> Result<String, String> {
    configured
        .split(',')
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "POKER_POSTFLOP_SOLVER_BET_SIZES must contain a bet size".to_string())
}

fn configured_bet_sizes(
    current_street: &BoardState,
    current_bet: i32,
    history: &PreparedHistory,
) -> Result<StreetBetSizes, String> {
    let configured_bets = env_string("POKER_POSTFLOP_SOLVER_BET_SIZES", "70%");
    let configured_raises = env_string("POKER_POSTFLOP_SOLVER_RAISE_SIZES", "2.5x");
    let base = configured_sizes_for_street(None, None, &configured_bets, &configured_raises)?;
    let current_fallback = (current_bet > 0).then_some(current_bet);
    let current = configured_sizes_for_street(
        Some(history),
        current_fallback,
        &configured_bets,
        &configured_raises,
    )?;
    let (flop, turn, river) = match current_street {
        BoardState::Flop => (
            paired_sizes(&current),
            paired_sizes(&base),
            paired_sizes(&base),
        ),
        BoardState::Turn => (
            paired_sizes(&base),
            paired_sizes(&current),
            paired_sizes(&base),
        ),
        BoardState::River => (
            paired_sizes(&base),
            paired_sizes(&base),
            paired_sizes(&current),
        ),
    };
    Ok(StreetBetSizes { flop, turn, river })
}

fn configured_sizes_for_street(
    history: Option<&PreparedHistory>,
    fallback_bet: Option<i32>,
    configured_bets: &str,
    configured_raises: &str,
) -> Result<BetSizeOptions, String> {
    let observed_bet = history.and_then(|item| item.observed_bet).or(fallback_bet);
    let bet_sizes = observed_bet
        .map(|amount| format!("{amount}c,{configured_bets}"))
        .unwrap_or_else(|| configured_bets.to_string());
    let observed_raises = history
        .map(|item| item.observed_raise_adders.as_slice())
        .unwrap_or_default();
    let raise_sizes = if observed_raises.is_empty() {
        configured_raises.to_string()
    } else {
        let observed = observed_raises
            .iter()
            .map(|amount| format!("{amount}c"))
            .collect::<Vec<_>>()
            .join(",");
        if configured_raises.is_empty() {
            observed
        } else {
            format!("{observed},{configured_raises}")
        }
    };
    BetSizeOptions::try_from((bet_sizes.as_str(), raise_sizes.as_str()))
}

fn paired_sizes(options: &BetSizeOptions) -> [BetSizeOptions; 2] {
    [options.clone(), options.clone()]
}

#[cfg(test)]
fn has_fixed_bet(options: &[BetSizeOptions; 2], amount: i32) -> bool {
    options
        .iter()
        .any(|player| player.bet.contains(&BetSize::Additive(amount, 0)))
}

#[cfg(test)]
fn has_fixed_raise(options: &[BetSizeOptions; 2], amount: i32) -> bool {
    options
        .iter()
        .any(|player| player.raise.contains(&BetSize::Additive(amount, 0)))
}

fn move_to_hero_decision(
    game: &mut PostFlopGame,
    hero_player: usize,
    current_bet: i32,
    prepared: &PreparedHistory,
) -> Result<Vec<String>, String> {
    if !prepared.actions.is_empty() {
        let mut history = Vec::with_capacity(prepared.actions.len());
        replay_actions(game, prepared, &mut history)?;
        return Ok(history);
    }

    let mut history = Vec::new();
    if hero_player == 1 {
        if current_bet > 0 {
            play_bet(game, current_bet)?;
            history.push(format!("OOP bet {:.2} BB", current_bet as f64 / CHIP_SCALE));
        } else {
            play_action(game, |action| matches!(action, Action::Check), "OOP check")?;
            history.push("OOP check".to_string());
        }
    } else if current_bet > 0 {
        play_action(game, |action| matches!(action, Action::Check), "OOP check")?;
        play_bet(game, current_bet)?;
        history.push("OOP check".to_string());
        history.push(format!("IP bet {:.2} BB", current_bet as f64 / CHIP_SCALE));
    }
    Ok(history)
}

fn move_through_completed(
    game: &mut PostFlopGame,
    state: &CanonicalState,
    plan: &ConditioningPlan,
) -> Result<Vec<String>, String> {
    let mut modeled = Vec::new();
    for item in &plan.completed {
        replay_actions(game, &item.history, &mut modeled)?;
        if !game.is_chance_node() {
            return Err(format!(
                "completed {} history did not reach the next board card",
                item.street
            ));
        }
        let board_index = match item.street.as_str() {
            "flop" => 3,
            "turn" => 4,
            _ => return Err(format!("unsupported completed street: {}", item.street)),
        };
        let card = state
            .board_cards
            .get(board_index)
            .ok_or_else(|| format!("{} board card is missing", item.street))?;
        let code = card_code(card)?;
        let card_id = card_from_str(&code)?;
        if game.possible_cards() & (1_u64 << card_id) == 0 {
            return Err(format!(
                "reviewed {code} card is incompatible with the conditioning ranges"
            ));
        }
        game.play(card_id as usize);
        modeled.push(format!("deal {code}"));
    }
    Ok(modeled)
}

fn replay_actions(
    game: &mut PostFlopGame,
    prepared: &PreparedHistory,
    modeled: &mut Vec<String>,
) -> Result<(), String> {
    for action in &prepared.actions {
        if game.current_player() != action.actor {
            return Err("structured action history does not match the action tree".to_string());
        }
        let actor = if action.actor == 0 { "OOP" } else { "IP" };
        match action.kind {
            ModeledActionKind::Check => {
                play_action(
                    game,
                    |candidate| matches!(candidate, Action::Check),
                    "check",
                )?;
                modeled.push(format!("{actor} check"));
            }
            ModeledActionKind::Bet => {
                play_wager(game, ModeledActionKind::Bet, action.amount)?;
                modeled.push(format!(
                    "{actor} bet {:.2} BB",
                    action.amount as f64 / CHIP_SCALE
                ));
            }
            ModeledActionKind::Raise => {
                play_wager(game, ModeledActionKind::Raise, action.amount)?;
                modeled.push(format!(
                    "{actor} raise to {:.2} BB",
                    action.amount as f64 / CHIP_SCALE
                ));
            }
            ModeledActionKind::Call => {
                play_action(game, |candidate| matches!(candidate, Action::Call), "call")?;
                modeled.push(format!(
                    "{actor} call to {:.2} BB",
                    action.amount as f64 / CHIP_SCALE
                ));
            }
        }
    }
    Ok(())
}

fn play_bet(game: &mut PostFlopGame, amount: i32) -> Result<(), String> {
    play_wager(game, ModeledActionKind::Bet, amount)
}

fn play_wager(game: &mut PostFlopGame, kind: ModeledActionKind, amount: i32) -> Result<(), String> {
    let label = match kind {
        ModeledActionKind::Bet => "bet",
        ModeledActionKind::Raise => "raise",
        ModeledActionKind::Check | ModeledActionKind::Call => {
            return Err("action is not a wager".to_string())
        }
    };
    play_action(
        game,
        |action| {
            let matching_kind = match kind {
                ModeledActionKind::Bet => matches!(action, Action::Bet(_) | Action::AllIn(_)),
                ModeledActionKind::Raise => {
                    matches!(action, Action::Raise(_) | Action::AllIn(_))
                }
                ModeledActionKind::Check | ModeledActionKind::Call => false,
            };
            let matching_amount = match action {
                Action::Bet(value) | Action::Raise(value) | Action::AllIn(value) => value == amount,
                _ => false,
            };
            matching_kind && matching_amount
        },
        &format!("{label} to {:.2} BB", amount as f64 / CHIP_SCALE),
    )
}

fn play_action<F>(game: &mut PostFlopGame, predicate: F, label: &str) -> Result<(), String>
where
    F: Fn(Action) -> bool,
{
    let actions = game.available_actions();
    let index = actions
        .iter()
        .position(|action| predicate(*action))
        .ok_or_else(|| format!("modeled {label} is not available in the action tree"))?;
    game.play(index);
    Ok(())
}

fn normalized_action(action: Action, facing_bet: bool) -> (&'static str, Option<f64>) {
    match action {
        Action::Fold => ("fold", None),
        Action::Check => ("check", None),
        Action::Call => ("call", None),
        Action::Bet(amount) => ("bet", Some(round(amount as f64 / CHIP_SCALE, 2))),
        Action::Raise(amount) => ("raise", Some(round(amount as f64 / CHIP_SCALE, 2))),
        Action::AllIn(amount) if facing_bet => {
            ("raise", Some(round(amount as f64 / CHIP_SCALE, 2)))
        }
        Action::AllIn(amount) => ("bet", Some(round(amount as f64 / CHIP_SCALE, 2))),
        _ => ("check", None),
    }
}

fn hero_card_ids(cards: &[InputCard]) -> Result<(u8, u8), String> {
    let first = card_from_str(&card_code(&cards[0])?)?;
    let second = card_from_str(&card_code(&cards[1])?)?;
    Ok((first.min(second), first.max(second)))
}

fn hero_hand_code(cards: &[InputCard]) -> Result<String, String> {
    hole_to_string(hero_card_ids(cards)?)
}

fn card_code(card: &InputCard) -> Result<String, String> {
    let suit = match card.suit.to_lowercase().as_str() {
        "clubs" | "c" => "c",
        "diamonds" | "d" => "d",
        "hearts" | "h" => "h",
        "spades" | "s" => "s",
        _ => return Err(format!("unknown suit: {}", card.suit)),
    };
    Ok(format!("{}{suit}", card.rank.to_uppercase()))
}

fn normalized_position(position: Option<&str>) -> Option<&'static str> {
    let normalized = position
        .map(|value| value.to_lowercase().replace(['_', '-'], " "))
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))?;
    match normalized.as_str() {
        "ip" | "in position" => Some("ip"),
        "oop" | "out of position" => Some("oop"),
        "utg" | "under the gun" | "ep" | "early" | "early position" => Some("utg"),
        "hijack" | "hj" | "mp" | "middle" | "middle position" => Some("hijack"),
        "cutoff" | "co" => Some("cutoff"),
        "button" | "btn" | "dealer" => Some("button"),
        "small blind" | "sb" => Some("small_blind"),
        "big blind" | "bb" => Some("big_blind"),
        _ => None,
    }
}

fn seat_order(position: &str) -> Option<u8> {
    match position {
        "small_blind" => Some(0),
        "big_blind" => Some(1),
        "utg" => Some(2),
        "hijack" => Some(3),
        "cutoff" => Some(4),
        "button" => Some(5),
        _ => None,
    }
}

fn hero_player(
    hero_position: Option<&str>,
    opponent_position: Option<&str>,
) -> Result<usize, String> {
    let hero = normalized_position(hero_position);
    let opponent = normalized_position(opponent_position);
    let mut inferred = Vec::new();
    match hero {
        Some("ip") => inferred.push(1),
        Some("oop") => inferred.push(0),
        Some("button") => inferred.push(1),
        _ => {}
    }
    match opponent {
        Some("ip" | "button") => inferred.push(0),
        Some("oop") => inferred.push(1),
        _ => {}
    }
    if let Some(first) = inferred.first() {
        return if inferred.iter().all(|value| value == first) {
            Ok(*first)
        } else {
            Err("hero and opponent positions are contradictory".to_string())
        };
    }
    if hero == opponent
        || matches!(
            (hero, opponent),
            (Some("small_blind"), Some("big_blind")) | (Some("big_blind"), Some("small_blind"))
        )
    {
        return Err("hero and opponent positions do not establish relative position".to_string());
    }
    match (hero.and_then(seat_order), opponent.and_then(seat_order)) {
        (Some(hero_order), Some(opponent_order)) if hero_order > opponent_order => Ok(1),
        (Some(_), Some(_)) => Ok(0),
        _ => Err(
            "hero position must identify IP or OOP, or hero and opponent seats must establish relative position"
                .to_string(),
        ),
    }
}

fn board_state(street: &str) -> Result<BoardState, String> {
    match street {
        "flop" => Ok(BoardState::Flop),
        "turn" => Ok(BoardState::Turn),
        "river" => Ok(BoardState::River),
        _ => Err(format!("unsupported postflop street: {street}")),
    }
}

fn include_hand(range: &str, hand: &str) -> String {
    format!("{hand},{range}")
}

fn positive_value(value: Option<f64>, field: &str) -> Result<f64, String> {
    let value = value.ok_or_else(|| format!("{field} is required"))?;
    if !value.is_finite() || value <= 0.0 {
        return Err(format!("{field} must be a positive finite number"));
    }
    Ok(value)
}

fn non_negative_value(value: Option<f64>, field: &str) -> Result<f64, String> {
    let value = value.ok_or_else(|| format!("{field} is required"))?;
    if !value.is_finite() || value < 0.0 {
        return Err(format!("{field} must be a non-negative finite number"));
    }
    Ok(value)
}

fn effective_stack_value(value: Option<f64>, current_bet: f64) -> Result<f64, String> {
    if current_bet > 0.0 {
        non_negative_value(value, "effective_stack")
    } else {
        positive_value(value, "effective_stack")
    }
}

fn scale_amount(value: f64, field: &str) -> Result<i32, String> {
    if !value.is_finite() {
        return Err(format!("{field} must be a finite number"));
    }
    let scaled = (value * CHIP_SCALE).round();
    if scaled <= 0.0 && field != "current_bet" {
        return Err(format!("{field} is too small"));
    }
    if scaled < 0.0 || scaled > i32::MAX as f64 {
        return Err(format!("{field} is outside the supported range"));
    }
    Ok(scaled as i32)
}

fn prepare_action_history(
    state: &CanonicalState,
    hero_player: usize,
    current_bet: f64,
) -> Result<PreparedHistory, String> {
    if state.postflop_action_history.is_empty() {
        return Ok(PreparedHistory::default());
    }

    let mut prepared = PreparedHistory::default();
    let mut next_actor = 0;
    let mut last_aggression: Option<&str> = None;
    for (index, input) in state.postflop_action_history.iter().enumerate() {
        let action_number = index + 1;
        let actor = match input.actor.to_lowercase().as_str() {
            "oop" => 0,
            "ip" => 1,
            _ => {
                return Err(format!(
                    "postflop action {action_number} has an unknown actor"
                ))
            }
        };
        if actor != next_actor {
            let expected = if next_actor == 0 { "OOP" } else { "IP" };
            return Err(format!(
                "postflop action {action_number} must be by {expected}"
            ));
        }
        let opponent = 1 - actor;
        let kind = match input.action.to_lowercase().as_str() {
            "check" => {
                if action_number != 1 {
                    return Err(
                        "only the opening OOP action can be a check in current-street history"
                            .to_string(),
                    );
                }
                if input.amount.is_some() {
                    return Err(format!(
                        "postflop action {action_number} check cannot have an amount"
                    ));
                }
                if prepared.contributions[actor] != prepared.contributions[opponent] {
                    return Err(format!(
                        "postflop action {action_number} cannot check while facing a wager"
                    ));
                }
                ModeledActionKind::Check
            }
            "bet" => {
                if prepared.contributions[actor] != prepared.contributions[opponent] {
                    return Err(format!(
                        "postflop action {action_number} must be a raise, not a bet"
                    ));
                }
                let amount = scale_amount(
                    input.amount.ok_or_else(|| {
                        format!("postflop action {action_number} bet requires an amount")
                    })?,
                    "postflop bet",
                )?;
                prepared.contributions[actor] = amount;
                prepared.observed_bet = Some(amount);
                last_aggression = Some("bet");
                ModeledActionKind::Bet
            }
            "raise" => {
                if prepared.contributions[actor] >= prepared.contributions[opponent] {
                    return Err(format!(
                        "postflop action {action_number} cannot raise without facing a wager"
                    ));
                }
                let amount = scale_amount(
                    input.amount.ok_or_else(|| {
                        format!("postflop action {action_number} raise requires an amount")
                    })?,
                    "postflop raise",
                )?;
                if amount <= prepared.contributions[opponent] {
                    return Err(format!(
                        "postflop action {action_number} raise-to amount must exceed the previous wager"
                    ));
                }
                prepared
                    .observed_raise_adders
                    .push(amount - prepared.contributions[opponent]);
                prepared.contributions[actor] = amount;
                last_aggression = Some("raise");
                ModeledActionKind::Raise
            }
            _ => {
                return Err(format!(
                    "postflop action {action_number} has an unknown action"
                ))
            }
        };
        let amount = prepared.contributions[actor];
        prepared.actions.push(ModeledAction {
            actor,
            kind,
            amount,
        });
        next_actor = opponent;
    }

    if next_actor != hero_player {
        return Err(
            "structured postflop action history does not end at the hero decision".to_string(),
        );
    }
    let opponent = 1 - hero_player;
    let expected_call = prepared.contributions[opponent] - prepared.contributions[hero_player];
    if expected_call < 0 {
        return Err(
            "structured postflop action history ends with the opponent facing a wager".to_string(),
        );
    }
    let scaled_current_bet = scale_amount(current_bet, "current_bet")?;
    if expected_call != scaled_current_bet {
        return Err(
            "current bet does not match the amount to call implied by structured postflop action history"
                .to_string(),
        );
    }
    let expected_facing = if expected_call > 0 {
        last_aggression
    } else {
        None
    };
    if state.facing_action.as_deref() != expected_facing {
        return Err("facing action does not match structured postflop action history".to_string());
    }
    Ok(prepared)
}

fn prepare_completed_histories(
    state: &CanonicalState,
) -> Result<Vec<PreparedStreetHistory>, String> {
    state
        .completed_postflop_streets
        .iter()
        .map(prepare_completed_history)
        .collect()
}

fn prepare_completed_history(
    input: &CompletedPostflopStreetInput,
) -> Result<PreparedStreetHistory, String> {
    if !matches!(input.street.as_str(), "flop" | "turn") {
        return Err(format!("unsupported completed street: {}", input.street));
    }
    if input.actions.len() < 2 || input.actions.len() > 8 {
        return Err(format!(
            "completed {} history must contain between 2 and 8 actions",
            input.street
        ));
    }

    let mut prepared = PreparedHistory::default();
    let mut next_actor = 0;
    let mut previous_was_check = false;
    let mut terminal = false;
    for (index, action) in input.actions.iter().enumerate() {
        let action_number = index + 1;
        if terminal {
            return Err(format!(
                "completed {} history continues after its terminal action",
                input.street
            ));
        }
        let actor = match action.actor.to_lowercase().as_str() {
            "oop" => 0,
            "ip" => 1,
            _ => {
                return Err(format!(
                    "completed {} action {action_number} has an unknown actor",
                    input.street
                ))
            }
        };
        if actor != next_actor {
            let expected = if next_actor == 0 { "OOP" } else { "IP" };
            return Err(format!(
                "completed {} action {action_number} must be by {expected}",
                input.street
            ));
        }
        let opponent = 1 - actor;
        let actor_total = prepared.contributions[actor];
        let opponent_total = prepared.contributions[opponent];
        let (kind, amount) = match action.action.to_lowercase().as_str() {
            "check" => {
                if action.amount.is_some() {
                    return Err(format!(
                        "completed {} action {action_number} check cannot have an amount",
                        input.street
                    ));
                }
                if actor_total != opponent_total {
                    return Err(format!(
                        "completed {} action {action_number} cannot check while facing a wager",
                        input.street
                    ));
                }
                terminal = previous_was_check;
                previous_was_check = true;
                (ModeledActionKind::Check, actor_total)
            }
            "bet" => {
                if actor_total != opponent_total || actor_total != 0 {
                    return Err(format!(
                        "completed {} action {action_number} bet requires an unopened street",
                        input.street
                    ));
                }
                let amount = scale_amount(
                    action.amount.ok_or_else(|| {
                        format!(
                            "completed {} action {action_number} bet requires an amount",
                            input.street
                        )
                    })?,
                    "completed postflop bet",
                )?;
                prepared.contributions[actor] = amount;
                prepared.observed_bet = Some(amount);
                previous_was_check = false;
                (ModeledActionKind::Bet, amount)
            }
            "raise" => {
                if actor_total >= opponent_total {
                    return Err(format!(
                        "completed {} action {action_number} cannot raise without facing a wager",
                        input.street
                    ));
                }
                let amount = scale_amount(
                    action.amount.ok_or_else(|| {
                        format!(
                            "completed {} action {action_number} raise requires an amount",
                            input.street
                        )
                    })?,
                    "completed postflop raise",
                )?;
                if amount <= opponent_total {
                    return Err(format!(
                        "completed {} action {action_number} raise-to amount must exceed the previous wager",
                        input.street
                    ));
                }
                prepared.observed_raise_adders.push(amount - opponent_total);
                prepared.contributions[actor] = amount;
                previous_was_check = false;
                (ModeledActionKind::Raise, amount)
            }
            "call" => {
                if actor_total >= opponent_total {
                    return Err(format!(
                        "completed {} action {action_number} cannot call without facing a wager",
                        input.street
                    ));
                }
                let amount = scale_amount(
                    action.amount.ok_or_else(|| {
                        format!(
                            "completed {} action {action_number} call requires an amount",
                            input.street
                        )
                    })?,
                    "completed postflop call",
                )?;
                if amount != opponent_total {
                    return Err(format!(
                        "completed {} action {action_number} call must match the faced total",
                        input.street
                    ));
                }
                prepared.contributions[actor] = amount;
                terminal = true;
                previous_was_check = false;
                (ModeledActionKind::Call, amount)
            }
            _ => {
                return Err(format!(
                    "completed {} action {action_number} has an unknown action",
                    input.street
                ))
            }
        };
        prepared.actions.push(ModeledAction {
            actor,
            kind,
            amount,
        });
        next_actor = opponent;
    }
    if !terminal {
        return Err(format!(
            "completed {} history must end with check-check or a call",
            input.street
        ));
    }
    Ok(PreparedStreetHistory {
        street: input.street.clone(),
        history: prepared,
    })
}

fn conditioning_plan(
    state: &CanonicalState,
    hero_player: usize,
    pot_size: f64,
    current_bet: f64,
    effective_stack: f64,
    current_history: &PreparedHistory,
    completed: Vec<PreparedStreetHistory>,
) -> Result<Option<ConditioningPlan>, String> {
    let expected: &[&str] = match state.street.as_deref() {
        Some("turn") => &["flop"],
        Some("river") => &["flop", "turn"],
        _ => &[],
    };
    if expected.is_empty()
        || completed
            .iter()
            .map(|item| item.street.as_str())
            .ne(expected.iter().copied())
    {
        return Ok(None);
    }
    let (Some(hero_stack), Some(opponent_stack)) = (state.hero_stack, state.opponent_stack) else {
        return Ok(None);
    };
    if !hero_stack.is_finite()
        || hero_stack <= 0.0
        || !opponent_stack.is_finite()
        || opponent_stack < 0.0
        || (hero_stack.min(opponent_stack) - effective_stack).abs() > 0.01
    {
        return Ok(None);
    }

    let scaled_bet = scale_amount(current_bet, "current_bet")?;
    let mut contributions = current_street_contributions(hero_player, scaled_bet, current_history);
    for item in &completed {
        for (player, amount) in item.history.contributions.iter().enumerate() {
            contributions[player] = contributions[player]
                .checked_add(*amount)
                .ok_or_else(|| "postflop contributions exceed the supported range".to_string())?;
        }
    }
    let total_contributions = contributions.iter().try_fold(0_i32, |total, amount| {
        total
            .checked_add(*amount)
            .ok_or_else(|| "postflop contributions exceed the supported range".to_string())
    })?;
    let starting_pot = scale_amount(pot_size, "pot_size")?
        .checked_sub(total_contributions)
        .ok_or_else(|| "pot_size is outside the supported range".to_string())?;
    if starting_pot <= 0 {
        return Ok(None);
    }
    let hero_start = hero_stack + contributions[hero_player] as f64 / CHIP_SCALE;
    let opponent_start = opponent_stack + contributions[1 - hero_player] as f64 / CHIP_SCALE;
    let effective_stack = scale_amount(hero_start.min(opponent_start), "effective_stack")?;
    if contributions.iter().any(|amount| *amount > effective_stack) {
        return Ok(None);
    }
    Ok(Some(ConditioningPlan {
        completed,
        starting_pot,
        effective_stack,
    }))
}

fn current_street_contributions(
    hero_player: usize,
    current_bet: i32,
    history: &PreparedHistory,
) -> [i32; 2] {
    if !history.actions.is_empty() {
        history.contributions
    } else if current_bet > 0 {
        let mut contributions = [0, 0];
        contributions[1 - hero_player] = current_bet;
        contributions
    } else {
        [0, 0]
    }
}

fn tree_amounts(
    pot_size: f64,
    current_bet: f64,
    effective_stack: f64,
    hero_stack: Option<f64>,
    opponent_stack: Option<f64>,
    hero_player: usize,
    history: &PreparedHistory,
) -> Result<TreeAmounts, String> {
    let scaled_pot = scale_amount(pot_size, "pot_size")?;
    let scaled_bet = scale_amount(current_bet, "current_bet")?;
    let starting_pot = if history.actions.is_empty() {
        if scaled_bet > 0 {
            scaled_pot - scaled_bet
        } else {
            scaled_pot
        }
    } else {
        scaled_pot - history.contributions.iter().sum::<i32>()
    };
    if starting_pot <= 0 {
        return Err("pot_size must exceed the wagers in the modeled action history".to_string());
    }

    let starting_effective_stack = if !history.actions.is_empty() {
        let hero_stack = positive_value(hero_stack, "hero_stack")?;
        let opponent_stack = non_negative_value(opponent_stack, "opponent_stack")?;
        let visible_effective_stack = hero_stack.min(opponent_stack);
        if (visible_effective_stack - effective_stack).abs() > 0.01 {
            return Err(
                "effective_stack does not match the visible hero and opponent stacks".to_string(),
            );
        }
        let hero_start = hero_stack + history.contributions[hero_player] as f64 / CHIP_SCALE;
        let opponent_start =
            opponent_stack + history.contributions[1 - hero_player] as f64 / CHIP_SCALE;
        hero_start.min(opponent_start)
    } else if scaled_bet > 0 {
        let hero_stack = positive_value(hero_stack, "hero_stack")?;
        hero_stack.min(effective_stack + current_bet)
    } else {
        effective_stack
    };
    let tree_stack = scale_amount(starting_effective_stack, "effective_stack")?;
    Ok(TreeAmounts {
        starting_pot,
        current_bet: scaled_bet,
        effective_stack: tree_stack,
    })
}

fn env_string(name: &str, default: &str) -> String {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn validated_range_source(value: &str) -> Result<&str, String> {
    match value {
        "configured"
        | "preflop_chart_single_raised_pot"
        | "preflop_chart_three_bet_pot"
        | "preflop_chart_cold_three_bet_pot"
        | "preflop_chart_squeeze_pot"
        | "preflop_chart_four_bet_pot" => Ok(value),
        _ => Err("POKER_POSTFLOP_SOLVER_RANGE_SOURCE is unsupported".to_string()),
    }
}

fn range_context_from_json(value: &str) -> Result<Value, String> {
    let context: Value = serde_json::from_str(value)
        .map_err(|_| "POKER_POSTFLOP_SOLVER_RANGE_CONTEXT must be valid JSON".to_string())?;
    if !context.is_object() {
        return Err("POKER_POSTFLOP_SOLVER_RANGE_CONTEXT must be a JSON object".to_string());
    }
    Ok(context)
}

fn env_number(name: &str, default: f64) -> Result<f64, String> {
    match env::var(name) {
        Ok(value) if !value.trim().is_empty() => value
            .parse::<f64>()
            .map_err(|_| format!("{name} must be a number")),
        _ => Ok(default),
    }
}

fn env_integer(name: &str, default: u32) -> Result<u32, String> {
    let value = match env::var(name) {
        Ok(value) if !value.trim().is_empty() => value
            .parse::<u32>()
            .map_err(|_| format!("{name} must be a positive integer")),
        _ => Ok(default),
    }?;
    if value == 0 {
        return Err(format!("{name} must be a positive integer"));
    }
    Ok(value)
}

fn positive_env_number(name: &str, default: f64) -> Result<f64, String> {
    let value = env_number(name, default)?;
    if !value.is_finite() || value <= 0.0 {
        return Err(format!("{name} must be a positive number"));
    }
    Ok(value)
}

fn round(value: f64, decimals: i32) -> f64 {
    let scale = 10_f64.powi(decimals);
    (value * scale).round() / scale
}

fn display_amount(value: f64) -> String {
    let formatted = format!("{value:.2}");
    formatted
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn fail(message: String) -> ExitCode {
    eprintln!("{message}");
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facing_bet_state(facing_action: Option<&str>) -> CanonicalState {
        CanonicalState {
            hero_cards: vec![
                InputCard {
                    rank: "A".to_string(),
                    suit: "hearts".to_string(),
                },
                InputCard {
                    rank: "K".to_string(),
                    suit: "diamonds".to_string(),
                },
            ],
            board_cards: vec![
                InputCard {
                    rank: "2".to_string(),
                    suit: "clubs".to_string(),
                },
                InputCard {
                    rank: "3".to_string(),
                    suit: "diamonds".to_string(),
                },
                InputCard {
                    rank: "4".to_string(),
                    suit: "hearts".to_string(),
                },
            ],
            pot_size: Some(15.0),
            current_bet: Some(5.0),
            hero_stack: Some(10.0),
            opponent_stack: None,
            effective_stack: Some(10.0),
            players_in_hand: Some(2),
            hero_position: Some("IP".to_string()),
            opponent_position: None,
            street: Some("flop".to_string()),
            facing_action: facing_action.map(str::to_string),
            postflop_action_history: Vec::new(),
            completed_postflop_streets: Vec::new(),
        }
    }

    fn raised_state() -> CanonicalState {
        let mut state = facing_bet_state(Some("raise"));
        state.pot_size = Some(19.0);
        state.hero_stack = Some(8.0);
        state.opponent_stack = Some(3.0);
        state.effective_stack = Some(3.0);
        state.hero_position = Some("OOP".to_string());
        state.street = Some("river".to_string());
        state.board_cards.extend([
            InputCard {
                rank: "5".to_string(),
                suit: "spades".to_string(),
            },
            InputCard {
                rank: "6".to_string(),
                suit: "clubs".to_string(),
            },
        ]);
        state.postflop_action_history = vec![
            PostflopActionInput {
                actor: "oop".to_string(),
                action: "bet".to_string(),
                amount: Some(2.0),
            },
            PostflopActionInput {
                actor: "ip".to_string(),
                action: "raise".to_string(),
                amount: Some(7.0),
            },
        ];
        state
    }

    fn turn_state_with_completed_flop() -> CanonicalState {
        let mut state = facing_bet_state(None);
        state.board_cards.push(InputCard {
            rank: "5".to_string(),
            suit: "spades".to_string(),
        });
        state.pot_size = Some(9.5);
        state.current_bet = Some(0.0);
        state.hero_stack = Some(95.5);
        state.opponent_stack = Some(95.5);
        state.effective_stack = Some(95.5);
        state.hero_position = Some("OOP".to_string());
        state.opponent_position = Some("IP".to_string());
        state.street = Some("turn".to_string());
        state.completed_postflop_streets = vec![CompletedPostflopStreetInput {
            street: "flop".to_string(),
            actions: vec![
                CompletedPostflopActionInput {
                    actor: "oop".to_string(),
                    action: "bet".to_string(),
                    amount: Some(2.0),
                },
                CompletedPostflopActionInput {
                    actor: "ip".to_string(),
                    action: "call".to_string(),
                    amount: Some(2.0),
                },
            ],
        }];
        state
    }

    #[test]
    fn position_parser_accepts_explicit_and_unambiguous_labels() {
        assert_eq!(hero_player(Some("IP"), None), Ok(1));
        assert_eq!(hero_player(Some("button"), None), Ok(1));
        assert_eq!(hero_player(Some("dealer"), None), Ok(1));
        assert_eq!(hero_player(Some("out-of-position"), None), Ok(0));
        assert_eq!(hero_player(Some("BB"), Some("button")), Ok(0));
        assert_eq!(hero_player(Some("cutoff"), Some("HJ")), Ok(1));
        assert_eq!(hero_player(Some("HJ"), Some("cutoff")), Ok(0));
        assert_eq!(hero_player(Some("under-the-gun"), Some("CO")), Ok(0));
        assert_eq!(hero_player(Some("middle"), Some("early")), Ok(1));
        assert_eq!(hero_player(None, Some("IP")), Ok(0));
        assert!(hero_player(Some("IP"), Some("IP")).is_err());
        assert!(hero_player(Some("SB"), Some("BB")).is_err());
        assert!(hero_player(Some("BB"), None).is_err());
        assert!(hero_player(Some("cutoff"), None).is_err());
    }

    #[test]
    fn facing_bet_requires_an_explicit_wager_classification() {
        assert!(validate_state(&facing_bet_state(Some("bet"))).is_ok());
        let missing = validate_state(&facing_bet_state(None)).unwrap_err();
        assert!(missing.contains("identify the outstanding wager"));
        let incomplete = validate_state(&facing_bet_state(Some("raise"))).unwrap_err();
        assert!(incomplete.contains("requires structured action history"));
        assert!(validate_state(&raised_state()).is_ok());

        let mut stale = facing_bet_state(Some("bet"));
        stale.current_bet = Some(0.0);
        let stale_error = validate_state(&stale).unwrap_err();
        assert!(stale_error.contains("requires a positive amount to call"));
    }

    #[test]
    fn raised_history_reconstructs_contributions_and_call_amount() {
        let state = raised_state();
        let history = prepare_action_history(&state, 0, 5.0).unwrap();

        assert_eq!(history.contributions, [200, 700]);
        assert_eq!(history.observed_bet, Some(200));
        assert_eq!(history.observed_raise_adders, vec![500]);

        let amounts = tree_amounts(19.0, 5.0, 3.0, Some(8.0), Some(3.0), 0, &history).unwrap();
        assert_eq!(amounts.starting_pot, 1000);
        assert_eq!(amounts.current_bet, 500);
        assert_eq!(amounts.effective_stack, 1000);
    }

    #[test]
    fn raised_history_replays_to_the_hero_node() {
        let state = raised_state();
        let history = prepare_action_history(&state, 0, 5.0).unwrap();
        let sizes = BetSizeOptions::try_from(("200c", "500c")).unwrap();
        let tree = ActionTree::new(TreeConfig {
            initial_state: BoardState::River,
            starting_pot: 1000,
            effective_stack: 1000,
            rake_rate: 0.0,
            rake_cap: 0.0,
            flop_bet_sizes: paired_sizes(&sizes),
            turn_bet_sizes: paired_sizes(&sizes),
            river_bet_sizes: paired_sizes(&sizes),
            turn_donk_sizes: None,
            river_donk_sizes: None,
            add_allin_threshold: 1.2,
            force_allin_threshold: 0.0,
            merging_threshold: 0.0,
        })
        .unwrap();
        let cards = card_config(&state, "AhKd", "QsQc", &BoardState::River).unwrap();
        let mut game = PostFlopGame::with_config(cards, tree).unwrap();
        game.allocate_memory(false);

        let modeled = move_to_hero_decision(&mut game, 0, 500, &history).unwrap();
        let action_history = game.history().to_vec();
        game.back_to_root();
        solve(&mut game, 1, 0.0, false);
        game.apply_history(&action_history);
        game.cache_normalized_weights();
        let expected_values = game.expected_values_detail(0);

        assert_eq!(game.current_player(), 0);
        assert_eq!(game.history(), action_history);
        assert!(!expected_values.is_empty());
        assert_eq!(modeled, ["OOP bet 2.00 BB", "IP raise to 7.00 BB"]);
    }

    #[test]
    fn completed_history_reconstructs_flop_root_amounts() {
        let state = turn_state_with_completed_flop();
        let completed = prepare_completed_histories(&state).unwrap();

        assert_eq!(completed[0].history.contributions, [200, 200]);
        assert_eq!(completed[0].history.observed_bet, Some(200));
        let plan = conditioning_plan(
            &state,
            0,
            9.5,
            0.0,
            95.5,
            &PreparedHistory::default(),
            completed,
        )
        .unwrap()
        .unwrap();

        assert_eq!(plan.starting_pot, 550);
        assert_eq!(plan.effective_stack, 9750);
        assert_eq!(plan.completed[0].street, "flop");
    }

    #[test]
    fn conditioning_requires_visible_stacks_and_every_prior_street() {
        let mut missing_stack = turn_state_with_completed_flop();
        missing_stack.opponent_stack = None;
        assert!(conditioning_plan(
            &missing_stack,
            0,
            9.5,
            0.0,
            95.5,
            &PreparedHistory::default(),
            prepare_completed_histories(&missing_stack).unwrap(),
        )
        .unwrap()
        .is_none());

        let mut partial_river = turn_state_with_completed_flop();
        partial_river.board_cards.push(InputCard {
            rank: "6".to_string(),
            suit: "clubs".to_string(),
        });
        partial_river.street = Some("river".to_string());
        assert!(conditioning_plan(
            &partial_river,
            0,
            9.5,
            0.0,
            95.5,
            &PreparedHistory::default(),
            prepare_completed_histories(&partial_river).unwrap(),
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn completed_history_replays_actions_and_the_actual_turn() {
        let state = turn_state_with_completed_flop();
        let plan = conditioning_plan(
            &state,
            0,
            9.5,
            0.0,
            95.5,
            &PreparedHistory::default(),
            prepare_completed_histories(&state).unwrap(),
        )
        .unwrap()
        .unwrap();
        let sizes = conditioning_bet_sizes(&plan).unwrap();
        let tree = ActionTree::new(TreeConfig {
            initial_state: BoardState::Flop,
            starting_pot: plan.starting_pot,
            effective_stack: plan.effective_stack,
            rake_rate: 0.0,
            rake_cap: 0.0,
            flop_bet_sizes: sizes.flop,
            turn_bet_sizes: sizes.turn,
            river_bet_sizes: sizes.river,
            turn_donk_sizes: None,
            river_donk_sizes: None,
            add_allin_threshold: 1.2,
            force_allin_threshold: 0.0,
            merging_threshold: 0.0,
        })
        .unwrap();
        let cards = card_config(&state, "AhKd", "9c9s", &BoardState::Flop).unwrap();
        let mut game = PostFlopGame::with_config(cards, tree).unwrap();
        game.allocate_memory(true);

        let modeled = move_through_completed(&mut game, &state, &plan).unwrap();

        assert_eq!(
            modeled,
            ["OOP bet 2.00 BB", "IP call to 2.00 BB", "deal 5s"]
        );
        assert_eq!(game.current_board().len(), 4);
        assert_eq!(game.current_player(), 0);
    }

    #[test]
    fn posterior_conditioning_returns_reachable_ranges() {
        let state = turn_state_with_completed_flop();
        let plan = conditioning_plan(
            &state,
            0,
            9.5,
            0.0,
            95.5,
            &PreparedHistory::default(),
            prepare_completed_histories(&state).unwrap(),
        )
        .unwrap()
        .unwrap();

        let result = condition_ranges(
            &state,
            0,
            "AhKd,AsKs",
            "9c9s,8c8s",
            &plan,
            SolverOptions {
                max_memory_mb: 768.0,
                max_iterations: 1,
                target_ratio: 0.01,
                rake_rate: 0.0,
                rake_cap: 0.0,
            },
        )
        .unwrap();

        assert!(result.applied);
        assert_eq!(result.evidence["status"], "applied");
        assert!(
            result.ranges[0]
                .get_weight_by_cards(card_from_str("Ah").unwrap(), card_from_str("Kd").unwrap())
                > 0.0
        );
        assert!(!result.ranges[1].is_empty());
    }

    #[test]
    fn posterior_conditioning_skips_trees_above_the_memory_limit() {
        let state = turn_state_with_completed_flop();
        let plan = conditioning_plan(
            &state,
            0,
            9.5,
            0.0,
            95.5,
            &PreparedHistory::default(),
            prepare_completed_histories(&state).unwrap(),
        )
        .unwrap()
        .unwrap();

        let result = condition_ranges(
            &state,
            0,
            "AhKd,AsKs",
            "9c9s,8c8s",
            &plan,
            SolverOptions {
                max_memory_mb: 0.000_001,
                max_iterations: 1,
                target_ratio: 0.01,
                rake_rate: 0.0,
                rake_cap: 0.0,
            },
        )
        .unwrap();

        assert!(!result.applied);
        assert_eq!(result.evidence["status"], "skipped");
        assert_eq!(
            result.evidence["reason"],
            "conditioning tree exceeds the configured memory limit"
        );
    }

    #[test]
    fn action_mapping_preserves_solver_sizing() {
        assert_eq!(normalized_action(Action::Call, true), ("call", None));
        assert_eq!(
            normalized_action(Action::Raise(625), true),
            ("raise", Some(6.25))
        );
        assert_eq!(
            normalized_action(Action::AllIn(1200), false),
            ("bet", Some(12.0))
        );
    }

    #[test]
    fn exact_hero_hand_is_canonicalized_before_configured_range() {
        let cards = [
            InputCard {
                rank: "K".to_string(),
                suit: "d".to_string(),
            },
            InputCard {
                rank: "A".to_string(),
                suit: "h".to_string(),
            },
        ];

        let hand = hero_hand_code(&cards).unwrap();

        assert_eq!(hand, "AhKd");
        assert_eq!(include_hand("AKs,QQ+", &hand), "AhKd,AKs,QQ+");
    }

    #[test]
    fn range_evidence_accepts_supported_sources_and_object_context() {
        assert_eq!(validated_range_source("configured"), Ok("configured"));
        assert_eq!(
            validated_range_source("preflop_chart_single_raised_pot"),
            Ok("preflop_chart_single_raised_pot")
        );
        assert_eq!(
            validated_range_source("preflop_chart_three_bet_pot"),
            Ok("preflop_chart_three_bet_pot")
        );
        assert_eq!(
            validated_range_source("preflop_chart_cold_three_bet_pot"),
            Ok("preflop_chart_cold_three_bet_pot")
        );
        assert_eq!(
            validated_range_source("preflop_chart_squeeze_pot"),
            Ok("preflop_chart_squeeze_pot")
        );
        assert_eq!(
            validated_range_source("preflop_chart_four_bet_pot"),
            Ok("preflop_chart_four_bet_pot")
        );
        assert!(validated_range_source("automatic").is_err());
        assert_eq!(
            range_context_from_json(r#"{"scenario":"single_raised_pot"}"#).unwrap(),
            json!({"scenario": "single_raised_pot"})
        );
        assert!(range_context_from_json("[]").is_err());
        assert!(range_context_from_json("not-json").is_err());
    }

    #[test]
    fn visible_effective_stack_is_not_increased_by_the_call_amount() {
        let amounts = tree_amounts(
            15.0,
            5.0,
            10.0,
            Some(10.0),
            None,
            1,
            &PreparedHistory::default(),
        )
        .unwrap();

        assert_eq!(amounts.starting_pot, 1000);
        assert_eq!(amounts.current_bet, 500);
        assert_eq!(amounts.effective_stack, 1000);
    }

    #[test]
    fn bettor_wager_is_restored_when_the_bettor_is_effective() {
        let amounts = tree_amounts(
            30.0,
            10.0,
            5.0,
            Some(30.0),
            None,
            1,
            &PreparedHistory::default(),
        )
        .unwrap();

        assert_eq!(amounts.starting_pot, 2000);
        assert_eq!(amounts.current_bet, 1000);
        assert_eq!(amounts.effective_stack, 1500);
    }

    #[test]
    fn all_in_bettor_wager_restores_zero_visible_effective_stack() {
        let visible_stack = effective_stack_value(Some(0.0), 10.0).unwrap();
        let amounts = tree_amounts(
            30.0,
            10.0,
            visible_stack,
            Some(30.0),
            None,
            1,
            &PreparedHistory::default(),
        )
        .unwrap();

        assert_eq!(amounts.starting_pot, 2000);
        assert_eq!(amounts.current_bet, 1000);
        assert_eq!(amounts.effective_stack, 1000);
    }

    #[test]
    fn zero_effective_stack_without_a_bet_is_rejected() {
        let error = effective_stack_value(Some(0.0), 0.0).unwrap_err();

        assert_eq!(error, "effective_stack must be a positive finite number");
    }

    #[test]
    fn facing_bet_requires_the_hero_stack() {
        let error =
            tree_amounts(15.0, 5.0, 10.0, None, None, 1, &PreparedHistory::default()).unwrap_err();

        assert_eq!(error, "hero_stack is required");
    }

    #[test]
    fn observed_bet_size_is_available_on_the_current_street_only() {
        let history = PreparedHistory::default();
        let flop = configured_bet_sizes(&BoardState::Flop, 137, &history).unwrap();
        let turn = configured_bet_sizes(&BoardState::Turn, 137, &history).unwrap();
        let river = configured_bet_sizes(&BoardState::River, 137, &history).unwrap();

        assert!(has_fixed_bet(&flop.flop, 137));
        assert!(!has_fixed_bet(&flop.turn, 137));
        assert!(!has_fixed_bet(&flop.river, 137));
        assert!(!has_fixed_bet(&turn.flop, 137));
        assert!(has_fixed_bet(&turn.turn, 137));
        assert!(!has_fixed_bet(&turn.river, 137));
        assert!(!has_fixed_bet(&river.flop, 137));
        assert!(!has_fixed_bet(&river.turn, 137));
        assert!(has_fixed_bet(&river.river, 137));
    }

    #[test]
    fn conditioning_uses_only_the_first_configured_bet_size() {
        assert_eq!(conditioning_bet_size("50%, 70%, 100%").unwrap(), "50%");
        assert!(conditioning_bet_size(" , ").is_err());
    }

    #[test]
    fn observed_raise_increment_is_available_on_the_current_street() {
        let state = raised_state();
        let history = prepare_action_history(&state, 0, 5.0).unwrap();
        let sizes = configured_bet_sizes(&BoardState::Flop, 500, &history).unwrap();

        assert!(has_fixed_bet(&sizes.flop, 200));
        assert!(has_fixed_raise(&sizes.flop, 500));
        assert!(!has_fixed_raise(&sizes.turn, 500));
        assert!(!has_fixed_raise(&sizes.river, 500));
    }
}
