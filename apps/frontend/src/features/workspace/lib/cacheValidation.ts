import type { JobRecord } from "../../../shared/types/jobs";
import type {
  CanonicalState,
  Card,
  CompletedPostflopAction,
  CompletedPostflopActionType,
  CompletedPostflopStreetHistory,
  DetectedState,
  PostflopAction,
  PostflopActor,
  PreflopAction,
} from "../../../shared/types/poker";
import type { RecommendationResult } from "../../../shared/types/recommendations";
import {
  FACING_ACTIONS,
  PREFLOP_POSITIONS,
  RANKS,
  STREETS,
  SUITS,
} from "../../hand-review/lib/pokerState";
import {
  SIZING_MATCH_TOLERANCE,
  TRAINING_ACTIONS,
  TRAINING_CERTAINTIES,
} from "../../training/lib/trainingPresentation";

export const PERSISTED_JOB_ID_PATTERN = /^[0-9a-f]{32}$/;
export const PROCESSING_CACHE_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function isCachedCard(value: unknown): value is Card {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const card = value as Partial<Card>;
  return (
    typeof card.rank === "string" &&
    RANKS.has(card.rank) &&
    typeof card.suit === "string" &&
    SUITS.has(card.suit)
  );
}

export function isNullableCachedNumber(
  value: unknown,
  minimum: number,
  minimumInclusive = true,
): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      (minimumInclusive ? value >= minimum : value > minimum))
  );
}

export function isNullableCachedString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isCachedPostflopAction(
  value: unknown,
): value is PostflopAction {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const action = value as Partial<PostflopAction>;
  return (
    (action.actor === "oop" || action.actor === "ip") &&
    (action.action === "check" ||
      action.action === "bet" ||
      action.action === "raise") &&
    (action.action === "check"
      ? action.amount === null
      : typeof action.amount === "number" &&
        Number.isFinite(action.amount) &&
        action.amount > 0)
  );
}

export function isCachedCompletedPostflopAction(
  value: unknown,
): value is CompletedPostflopAction {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const action = value as Partial<CompletedPostflopAction>;
  return (
    (action.actor === "oop" || action.actor === "ip") &&
    (action.action === "check" ||
      action.action === "bet" ||
      action.action === "raise" ||
      action.action === "call") &&
    (action.action === "check"
      ? action.amount === null
      : typeof action.amount === "number" &&
        Number.isFinite(action.amount) &&
        action.amount > 0)
  );
}

export function isCachedCompletedPostflopStreet(
  value: unknown,
): value is CompletedPostflopStreetHistory {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const history = value as Partial<CompletedPostflopStreetHistory>;
  if (
    !(
      (history.street === "flop" || history.street === "turn") &&
      Array.isArray(history.actions) &&
      history.actions.length >= 2 &&
      history.actions.length <= 8 &&
      history.actions.every(isCachedCompletedPostflopAction)
    )
  ) {
    return false;
  }

  const contributions: Record<PostflopActor, number> = { oop: 0, ip: 0 };
  let nextActor: PostflopActor = "oop";
  let previousAction: CompletedPostflopActionType | null = null;
  let terminal = false;
  for (let index = 0; index < history.actions.length; index += 1) {
    const action = history.actions[index];
    if (terminal || action.actor !== nextActor) {
      return false;
    }
    const opponent: PostflopActor = action.actor === "oop" ? "ip" : "oop";
    const actorTotal = contributions[action.actor];
    const opponentTotal = contributions[opponent];
    const amount = action.amount ?? 0;
    if (action.action === "check") {
      if (Math.abs(actorTotal - opponentTotal) > SIZING_MATCH_TOLERANCE) {
        return false;
      }
      terminal = previousAction === "check";
    } else if (action.action === "bet") {
      if (
        Math.abs(actorTotal - opponentTotal) > SIZING_MATCH_TOLERANCE ||
        actorTotal > SIZING_MATCH_TOLERANCE
      ) {
        return false;
      }
      contributions[action.actor] = amount;
    } else if (action.action === "raise") {
      if (
        actorTotal >= opponentTotal - SIZING_MATCH_TOLERANCE ||
        amount <= opponentTotal + SIZING_MATCH_TOLERANCE
      ) {
        return false;
      }
      contributions[action.actor] = amount;
    } else {
      if (
        actorTotal >= opponentTotal - SIZING_MATCH_TOLERANCE ||
        Math.abs(amount - opponentTotal) > SIZING_MATCH_TOLERANCE
      ) {
        return false;
      }
      contributions[action.actor] = opponentTotal;
      terminal = true;
    }
    if (terminal && index !== history.actions.length - 1) {
      return false;
    }
    previousAction = action.action;
    nextActor = opponent;
  }
  return terminal;
}

export function isCachedCompletedPostflopHistory(
  value: unknown,
  currentStreet: unknown,
): value is CompletedPostflopStreetHistory[] | undefined {
  if (value === undefined) {
    return true;
  }
  if (
    !Array.isArray(value) ||
    value.length > 2 ||
    !value.every(isCachedCompletedPostflopStreet)
  ) {
    return false;
  }
  const expected =
    currentStreet === "turn"
      ? ["flop"]
      : currentStreet === "river"
        ? ["flop", "turn"]
        : [];
  return value.every((history, index) => history.street === expected[index]);
}

export function isCachedPreflopAction(value: unknown): value is PreflopAction {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const action = value as Partial<PreflopAction>;
  return (
    PREFLOP_POSITIONS.some((position) => position.value === action.actor) &&
    (action.action === "call" || action.action === "raise") &&
    typeof action.amount === "number" &&
    Number.isFinite(action.amount) &&
    action.amount > 0
  );
}

export function isCachedDetectedState(value: unknown): value is DetectedState {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const state = value as Partial<DetectedState>;
  if (
    !Array.isArray(state.hero_cards) ||
    !state.hero_cards.every(isCachedCard) ||
    state.hero_cards.length > 2 ||
    !Array.isArray(state.board_cards) ||
    !state.board_cards.every(isCachedCard) ||
    state.board_cards.length > 5
  ) {
    return false;
  }
  const cardCodes = [...state.hero_cards, ...state.board_cards].map(
    (card) => `${card.rank}:${card.suit}`,
  );
  return (
    new Set(cardCodes).size === cardCodes.length &&
    isNullableCachedNumber(state.pot_size, 0) &&
    isNullableCachedNumber(state.current_bet, 0) &&
    isNullableCachedNumber(state.hero_stack, 0) &&
    (state.opponent_stack === undefined ||
      isNullableCachedNumber(state.opponent_stack, 0)) &&
    isNullableCachedNumber(state.effective_stack, 0) &&
    (state.players_in_hand === null ||
      (typeof state.players_in_hand === "number" &&
        Number.isInteger(state.players_in_hand) &&
        state.players_in_hand >= 1)) &&
    (state.opponents_at_current_bet === undefined ||
      state.opponents_at_current_bet === null ||
      (typeof state.opponents_at_current_bet === "number" &&
        Number.isInteger(state.opponents_at_current_bet) &&
        state.opponents_at_current_bet >= 1 &&
        typeof state.current_bet === "number" &&
        state.current_bet > 0 &&
        typeof state.players_in_hand === "number" &&
        state.opponents_at_current_bet < state.players_in_hand)) &&
    (state.opponent_wager === undefined ||
      state.opponent_wager === null ||
      (typeof state.opponent_wager === "number" &&
        Number.isFinite(state.opponent_wager) &&
        state.opponent_wager > 0 &&
        typeof state.current_bet === "number" &&
        state.current_bet > 0 &&
        state.opponent_wager >= state.current_bet)) &&
    (state.opponent_commitment_total === undefined ||
      state.opponent_commitment_total === null ||
      (typeof state.opponent_commitment_total === "number" &&
        Number.isFinite(state.opponent_commitment_total) &&
        state.opponent_commitment_total > 0 &&
        (typeof state.pot_size !== "number" ||
          state.opponent_commitment_total <= state.pot_size + 0.000001) &&
        (typeof state.opponent_wager !== "number" ||
          state.opponent_commitment_total + 0.000001 >=
            state.opponent_wager *
              (typeof state.opponents_at_current_bet === "number"
                ? state.opponents_at_current_bet
                : 1)))) &&
    isNullableCachedString(state.hero_position) &&
    (state.opponent_position === undefined ||
      isNullableCachedString(state.opponent_position)) &&
    isNullableCachedString(state.preflop_opener_position) &&
    isNullableCachedNumber(state.preflop_open_size, 0, false) &&
    (state.preflop_action_history === undefined ||
      (Array.isArray(state.preflop_action_history) &&
        state.preflop_action_history.length <= 8 &&
        state.preflop_action_history.every(isCachedPreflopAction))) &&
    (state.street === null ||
      (typeof state.street === "string" && STREETS.has(state.street))) &&
    (state.facing_action === null ||
      (typeof state.facing_action === "string" &&
        FACING_ACTIONS.has(state.facing_action))) &&
    (state.postflop_action_history === undefined ||
      (Array.isArray(state.postflop_action_history) &&
        state.postflop_action_history.length <= 8 &&
        state.postflop_action_history.every(isCachedPostflopAction))) &&
    isCachedCompletedPostflopHistory(
      state.completed_postflop_streets,
      state.street,
    ) &&
    isNullableCachedString(state.action_context)
  );
}

export function isCachedCanonicalState(
  value: unknown,
): value is CanonicalState {
  return (
    isCachedDetectedState(value) &&
    typeof (value as Partial<CanonicalState>).user_approved === "boolean"
  );
}

export function isCachedActionSizing(
  action: unknown,
  sizing: unknown,
): boolean {
  if (action === "bet" || action === "raise") {
    return (
      sizing === null ||
      (typeof sizing === "number" && Number.isFinite(sizing) && sizing > 0)
    );
  }
  return sizing === null;
}

export function isCachedRecommendation(
  value: unknown,
): value is RecommendationResult {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const recommendation = value as Record<string, unknown>;
  return (
    typeof recommendation.action === "string" &&
    TRAINING_ACTIONS.some((action) => action === recommendation.action) &&
    isCachedActionSizing(recommendation.action, recommendation.sizing) &&
    typeof recommendation.confidence === "number" &&
    Number.isFinite(recommendation.confidence) &&
    recommendation.confidence >= 0 &&
    recommendation.confidence <= 1 &&
    typeof recommendation.explanation === "string" &&
    recommendation.raw !== null &&
    typeof recommendation.raw === "object" &&
    !Array.isArray(recommendation.raw)
  );
}

export function isCachedTrainingDecision(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const decision = value as Record<string, unknown>;
  return (
    typeof decision.action === "string" &&
    TRAINING_ACTIONS.some((action) => action === decision.action) &&
    isCachedActionSizing(decision.action, decision.sizing) &&
    (decision.certainty === undefined ||
      decision.certainty === null ||
      (typeof decision.certainty === "string" &&
        TRAINING_CERTAINTIES.some(
          (certainty) => certainty === decision.certainty,
        ))) &&
    typeof decision.recorded_at === "string"
  );
}

export function isCachedParserResult(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value !== "object") {
    return false;
  }
  const parserResult = value as Record<string, unknown>;
  return (
    isCachedDetectedState(parserResult.state) &&
    parserResult.confidences !== null &&
    typeof parserResult.confidences === "object" &&
    !Array.isArray(parserResult.confidences) &&
    Object.values(parserResult.confidences).every(
      (confidence) =>
        typeof confidence === "number" &&
        Number.isFinite(confidence) &&
        confidence >= 0 &&
        confidence <= 1,
    ) &&
    Array.isArray(parserResult.warnings) &&
    parserResult.warnings.every((warning) => typeof warning === "string") &&
    parserResult.raw !== null &&
    typeof parserResult.raw === "object" &&
    !Array.isArray(parserResult.raw)
  );
}

export function isCachedJobRecord(value: unknown): value is JobRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<JobRecord>;
  return (
    typeof candidate.id === "string" &&
    PERSISTED_JOB_ID_PATTERN.test(candidate.id) &&
    (candidate.status === "created" ||
      candidate.status === "parsed" ||
      candidate.status === "approved" ||
      candidate.status === "recommended" ||
      candidate.status === "error") &&
    typeof candidate.original_filename === "string" &&
    typeof candidate.image_filename === "string" &&
    typeof candidate.parser_provider === "string" &&
    typeof candidate.recommendation_provider === "string" &&
    isCachedParserResult(candidate.parser_result) &&
    (candidate.parser_auto_approval_eligible === undefined ||
      candidate.parser_auto_approval_eligible === null ||
      typeof candidate.parser_auto_approval_eligible === "boolean") &&
    (candidate.approved_state === null ||
      isCachedCanonicalState(candidate.approved_state)) &&
    (candidate.recommendation === null ||
      isCachedRecommendation(candidate.recommendation)) &&
    typeof candidate.recommendation_pending === "boolean" &&
    (candidate.recommendation_request_id === undefined ||
      candidate.recommendation_request_id === null ||
      typeof candidate.recommendation_request_id === "string") &&
    (candidate.training_decision === null ||
      isCachedTrainingDecision(candidate.training_decision)) &&
    (candidate.training_reviewed_at === null ||
      typeof candidate.training_reviewed_at === "string") &&
    (candidate.training_review_note === null ||
      typeof candidate.training_review_note === "string") &&
    (candidate.error === null || typeof candidate.error === "string") &&
    typeof candidate.benchmark_included === "boolean" &&
    isSafeProcessingCacheTimestamp(candidate.created_at) &&
    isSafeProcessingCacheTimestamp(candidate.updated_at) &&
    candidate.archived_at === null
  );
}

export function isSafeProcessingCacheTimestamp(
  value: unknown,
): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    timestamp <= Date.now() + PROCESSING_CACHE_FUTURE_SKEW_MS
  );
}

export function isPristineBenchmarkImport(job: JobRecord): boolean {
  return (
    job.benchmark_included &&
    job.status === "approved" &&
    !job.recommendation_pending &&
    job.parser_result === null &&
    job.approved_state !== null &&
    job.training_decision === null &&
    job.recommendation === null &&
    job.recommendation_request_id === null &&
    job.training_reviewed_at === null &&
    job.training_review_note === null &&
    job.error === null
  );
}
