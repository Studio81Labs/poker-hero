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
    effective_stack: Option<f64>,
    players_in_hand: Option<u8>,
    hero_position: Option<String>,
    street: Option<String>,
    facing_action: Option<String>,
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
    let hero_player = hero_player(state.hero_position.as_deref())?;
    let pot_size = positive_value(state.pot_size, "pot_size")?;
    let current_bet = non_negative_value(state.current_bet, "current_bet")?;
    let effective_stack = positive_value(state.effective_stack, "effective_stack")?;

    let TreeAmounts {
        starting_pot,
        current_bet: scaled_bet,
        effective_stack: tree_stack,
    } = tree_amounts(pot_size, current_bet, effective_stack, state.hero_stack)?;

    let hero_hand = hero_hand_code(&state.hero_cards)?;
    let mut oop_range = env_string("POKER_POSTFLOP_SOLVER_OOP_RANGE", DEFAULT_OOP_RANGE);
    let mut ip_range = env_string("POKER_POSTFLOP_SOLVER_IP_RANGE", DEFAULT_IP_RANGE);
    if hero_player == 0 {
        oop_range = include_hand(&oop_range, &hero_hand);
    } else {
        ip_range = include_hand(&ip_range, &hero_hand);
    }

    let bet_sizes = configured_bet_sizes(&board_state, scaled_bet)?;
    let card_config = card_config(&state, &oop_range, &ip_range)?;
    let tree_config = TreeConfig {
        initial_state: board_state,
        starting_pot,
        effective_stack: tree_stack,
        rake_rate: env_number("POKER_POSTFLOP_SOLVER_RAKE_RATE", 0.0)?,
        rake_cap: env_number("POKER_POSTFLOP_SOLVER_RAKE_CAP", 0.0)? * CHIP_SCALE,
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
    let max_memory_mb = positive_env_number("POKER_POSTFLOP_SOLVER_MAX_MEMORY_MB", 768.0)?;
    if compressed_memory as f64 > max_memory_mb * 1024.0 * 1024.0 {
        return Err(format!(
            "estimated compressed game tree is {:.0} MB, above the configured {:.0} MB limit",
            compressed_memory as f64 / (1024.0 * 1024.0),
            max_memory_mb
        ));
    }

    game.allocate_memory(true);
    let max_iterations = env_integer("POKER_POSTFLOP_SOLVER_MAX_ITERATIONS", 400)?;
    let target_ratio = positive_env_number("POKER_POSTFLOP_SOLVER_TARGET_EXPLOITABILITY", 0.01)?;
    let target_exploitability = starting_pot as f32 * target_ratio as f32;
    let exploitability = solve(&mut game, max_iterations, target_exploitability, false);

    let modeled_history = move_to_hero_decision(&mut game, hero_player, scaled_bet)?;
    if game.current_player() != hero_player {
        return Err("modeled action history did not reach the hero decision".to_string());
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
    let explanation = format!(
        "Postflop solver analyzed a heads-up {street} tree using configured ranges and recommends {}{size_text} at {:.0}% frequency. The position was modeled as {position}; tree exploitability was {:.3} BB. Treat the result as training guidance because ranges and the simplified action history are assumptions.",
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
            "tree": {
                "starting_pot": starting_pot as f64 / CHIP_SCALE,
                "effective_stack": tree_stack as f64 / CHIP_SCALE,
                "visible_effective_stack": effective_stack,
                "hero_stack": state.hero_stack,
                "compressed_memory_mb": round(compressed_memory as f64 / (1024.0 * 1024.0), 1),
                "max_iterations": max_iterations,
                "target_exploitability_ratio": target_ratio,
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
    if state.current_bet.unwrap_or(0.0) > 0.0 && state.facing_action.as_deref() != Some("bet") {
        return Err(
            "facing action must identify a single bet; raises require full action history"
                .to_string(),
        );
    }
    Ok(())
}

fn card_config(
    state: &CanonicalState,
    oop_range: &str,
    ip_range: &str,
) -> Result<CardConfig, String> {
    let board = state
        .board_cards
        .iter()
        .map(card_code)
        .collect::<Result<Vec<_>, _>>()?;
    let flop = flop_from_str(&board[..3].join(""))?;
    let turn = if board.len() >= 4 {
        card_from_str(&board[3])?
    } else {
        NOT_DEALT
    };
    let river = if board.len() == 5 {
        card_from_str(&board[4])?
    } else {
        NOT_DEALT
    };
    let oop = oop_range.parse::<Range>()?;
    let ip = ip_range.parse::<Range>()?;
    Ok(CardConfig {
        range: [oop, ip],
        flop,
        turn,
        river,
    })
}

fn configured_bet_sizes(
    current_street: &BoardState,
    current_bet: i32,
) -> Result<StreetBetSizes, String> {
    let configured_bets = env_string("POKER_POSTFLOP_SOLVER_BET_SIZES", "70%");
    let raise_sizes = env_string("POKER_POSTFLOP_SOLVER_RAISE_SIZES", "2.5x");
    let base = BetSizeOptions::try_from((configured_bets.as_str(), raise_sizes.as_str()))?;
    let current = if current_bet > 0 {
        let bet_sizes = format!("{current_bet}c,{configured_bets}");
        BetSizeOptions::try_from((bet_sizes.as_str(), raise_sizes.as_str()))?
    } else {
        base.clone()
    };
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

fn paired_sizes(options: &BetSizeOptions) -> [BetSizeOptions; 2] {
    [options.clone(), options.clone()]
}

#[cfg(test)]
fn has_fixed_bet(options: &[BetSizeOptions; 2], amount: i32) -> bool {
    options
        .iter()
        .any(|player| player.bet.contains(&BetSize::Additive(amount, 0)))
}

fn move_to_hero_decision(
    game: &mut PostFlopGame,
    hero_player: usize,
    current_bet: i32,
) -> Result<Vec<String>, String> {
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

fn play_bet(game: &mut PostFlopGame, amount: i32) -> Result<(), String> {
    play_action(
        game,
        |action| {
            matches!(
                action,
                Action::Bet(value) | Action::AllIn(value) if value == amount
            )
        },
        &format!("bet of {:.2} BB", amount as f64 / CHIP_SCALE),
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

fn hero_player(position: Option<&str>) -> Result<usize, String> {
    let normalized = position
        .map(|value| value.to_lowercase().replace(['_', '-'], " "))
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "));
    match normalized.as_deref() {
        Some("ip" | "in position" | "button" | "btn") => Ok(1),
        Some("oop" | "out of position") => Ok(0),
        _ => Err("hero position must identify IP or OOP".to_string()),
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

fn scale_amount(value: f64, field: &str) -> Result<i32, String> {
    let scaled = (value * CHIP_SCALE).round();
    if scaled <= 0.0 && field != "current_bet" {
        return Err(format!("{field} is too small"));
    }
    if scaled < 0.0 || scaled > i32::MAX as f64 {
        return Err(format!("{field} is outside the supported range"));
    }
    Ok(scaled as i32)
}

fn tree_amounts(
    pot_size: f64,
    current_bet: f64,
    effective_stack: f64,
    hero_stack: Option<f64>,
) -> Result<TreeAmounts, String> {
    let scaled_pot = scale_amount(pot_size, "pot_size")?;
    let scaled_bet = scale_amount(current_bet, "current_bet")?;
    let starting_pot = if scaled_bet > 0 {
        scaled_pot - scaled_bet
    } else {
        scaled_pot
    };
    if starting_pot <= 0 {
        return Err("pot_size must be greater than current_bet".to_string());
    }

    let starting_effective_stack = if scaled_bet > 0 {
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
            effective_stack: Some(10.0),
            players_in_hand: Some(2),
            hero_position: Some("IP".to_string()),
            street: Some("flop".to_string()),
            facing_action: facing_action.map(str::to_string),
        }
    }

    #[test]
    fn position_parser_accepts_explicit_and_unambiguous_labels() {
        assert_eq!(hero_player(Some("IP")), Ok(1));
        assert_eq!(hero_player(Some("button")), Ok(1));
        assert_eq!(hero_player(Some("out-of-position")), Ok(0));
        assert!(hero_player(Some("SB")).is_err());
        assert!(hero_player(Some("BB")).is_err());
        assert!(hero_player(Some("cutoff")).is_err());
    }

    #[test]
    fn facing_bet_requires_an_explicit_first_bet_classification() {
        assert!(validate_state(&facing_bet_state(Some("bet"))).is_ok());
        for facing_action in [None, Some("raise")] {
            let error = validate_state(&facing_bet_state(facing_action)).unwrap_err();
            assert!(error.contains("raises require full action history"));
        }
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
    fn visible_effective_stack_is_not_increased_by_the_call_amount() {
        let amounts = tree_amounts(15.0, 5.0, 10.0, Some(10.0)).unwrap();

        assert_eq!(amounts.starting_pot, 1000);
        assert_eq!(amounts.current_bet, 500);
        assert_eq!(amounts.effective_stack, 1000);
    }

    #[test]
    fn bettor_wager_is_restored_when_the_bettor_is_effective() {
        let amounts = tree_amounts(30.0, 10.0, 5.0, Some(30.0)).unwrap();

        assert_eq!(amounts.starting_pot, 2000);
        assert_eq!(amounts.current_bet, 1000);
        assert_eq!(amounts.effective_stack, 1500);
    }

    #[test]
    fn facing_bet_requires_the_hero_stack() {
        let error = tree_amounts(15.0, 5.0, 10.0, None).unwrap_err();

        assert_eq!(error, "hero_stack is required");
    }

    #[test]
    fn observed_bet_size_is_available_on_the_current_street_only() {
        let flop = configured_bet_sizes(&BoardState::Flop, 137).unwrap();
        let turn = configured_bet_sizes(&BoardState::Turn, 137).unwrap();
        let river = configured_bet_sizes(&BoardState::River, 137).unwrap();

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
}
