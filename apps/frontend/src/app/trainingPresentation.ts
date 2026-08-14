import {
  benchmarkPercent,
  formatCandidateValue,
  formatEvLossBb,
} from "../metricPresentation";
import {
  type RecommendationAction,
  type RecommendationResult,
  type Street,
  type TrainingCertainty,
  type TrainingCertaintyFilter,
  type TrainingPositionFilter,
  type TrainingProgress,
  type TrainingReviewCertainty,
  type TrainingReviewCertaintyFilter,
  type TrainingReviewDifference,
  type TrainingReviewOrder,
  type TrainingReviewStreet,
  type TrainingSolverFilter,
  type TrainingStreetFilter,
} from "../types";
import {
  metadataNumber,
  metadataRatio,
  metadataRecord,
} from "./recommendationPresentation";

export const TRAINING_ACTIONS: readonly RecommendationAction[] = [
  "fold",
  "check",
  "call",
  "bet",
  "raise",
];

export const TRAINING_CERTAINTIES: readonly TrainingCertainty[] = [
  "low",
  "medium",
  "high",
];

export const TRAINING_ACTION_OPTIONS = TRAINING_ACTIONS.map((value) => ({
  value,
  label: value,
}));

export const TRAINING_CERTAINTY_OPTIONS = TRAINING_CERTAINTIES.map((value) => ({
  value,
  label: value,
}));

export const MIN_SUPPORTED_FREQUENCY = 0.05;

export const SIZING_MATCH_TOLERANCE = 0.01;

export const MAX_TRAINING_REVIEW_NOTE_LENGTH = 1000;

export type TrainingActionOption = "" | RecommendationAction;

export type TrainingCertaintyOption = "" | TrainingCertainty;

export type TrainingProgressView = "recent" | "review" | "lessons";

export type TrainingFocus = { street: Street; reason: string };

export type TrainingCertaintyFocus = {
  certainty: TrainingReviewCertainty;
  label: string;
  reason: string;
};

export type TrainingPositionFocus = {
  filter: TrainingPositionFilter;
  label: string;
  reason: string;
};

export type TrainingActionDifferenceFocus = {
  difference: TrainingReviewDifference;
  label: string;
  reason: string;
};

export const TRAINING_STREET_ORDER: readonly Street[] = [
  "preflop",
  "flop",
  "turn",
  "river",
];

export const TRAINING_CERTAINTY_FOCUS_ORDER: readonly TrainingCertainty[] = [
  "high",
  "medium",
  "low",
];

export const TRAINING_POSITION_FOCUS_ORDER: readonly string[] = [
  "UTG",
  "HJ",
  "CO",
  "BTN",
  "SB",
  "BB",
  "IP",
  "OOP",
];

export function trainingDecisionLabel(
  action: RecommendationAction,
  sizing: number | null,
): string {
  const actionLabel = `${action.slice(0, 1).toUpperCase()}${action.slice(1)}`;
  return sizing === null
    ? actionLabel
    : `${actionLabel} ${formatCandidateValue(sizing)} BB`;
}

export function trainingCertaintyLabel(certainty: TrainingCertainty): string {
  return `${certainty.slice(0, 1).toUpperCase()}${certainty.slice(1)}`;
}

export function trainingDecisionComparison(
  action: RecommendationAction,
  sizing: number | null,
  recommendation: RecommendationResult,
): {
  label: string;
  tone: "match" | "partial" | "different";
  evLossBb: number | null;
} {
  const evLossBb = recommendationEvLossBb(action, sizing, recommendation);
  if (
    trainingLineMatches(
      action,
      sizing,
      recommendation.action,
      recommendation.sizing,
    )
  ) {
    return { label: "Matched solver", tone: "match", evLossBb };
  }
  const policySupport = recommendationPolicySupport(
    action,
    sizing,
    recommendation,
  );
  if (policySupport === "line") {
    return { label: "Solver-supported mix", tone: "match", evLossBb };
  }
  if (action === recommendation.action) {
    return { label: "Same action, different size", tone: "partial", evLossBb };
  }
  if (policySupport === "action") {
    return {
      label: "Solver-supported action, different size",
      tone: "partial",
      evLossBb,
    };
  }
  return { label: "Different action", tone: "different", evLossBb };
}

export function recommendationEvLossBb(
  action: RecommendationAction,
  sizing: number | null,
  recommendation: RecommendationResult,
): number | null {
  const candidates = Array.isArray(recommendation.raw.candidates)
    ? recommendation.raw.candidates
    : [];
  let bestEv: number | null = null;
  let decisionEv: number | null = null;
  let recommendationLineFound = false;
  const validActions = new Set<RecommendationAction>();
  const sizingBounds = new Map<
    RecommendationAction,
    { maximum: number; minimum: number }
  >();
  for (const candidate of candidates) {
    const record = metadataRecord(candidate);
    const candidateAction = recommendationAction(record?.action);
    if (
      !record ||
      !candidateAction ||
      !Object.prototype.hasOwnProperty.call(record, "sizing")
    ) {
      continue;
    }
    const candidateSizing = policyCandidateSizing(
      candidateAction,
      record.sizing,
    );
    const ev = metadataNumber(record.ev);
    if (!candidateSizing.valid || ev === null) {
      continue;
    }
    validActions.add(candidateAction);
    if (candidateSizing.value !== null) {
      const bounds = sizingBounds.get(candidateAction);
      sizingBounds.set(candidateAction, {
        maximum:
          bounds === undefined
            ? candidateSizing.value
            : Math.max(bounds.maximum, candidateSizing.value),
        minimum:
          bounds === undefined
            ? candidateSizing.value
            : Math.min(bounds.minimum, candidateSizing.value),
      });
    }
    bestEv = bestEv === null ? ev : Math.max(bestEv, ev);
    if (
      trainingLineMatches(
        recommendation.action,
        recommendation.sizing,
        candidateAction,
        candidateSizing.value,
      )
    ) {
      recommendationLineFound = true;
    }
    if (
      trainingLineMatches(
        action,
        sizing,
        candidateAction,
        candidateSizing.value,
      )
    ) {
      decisionEv = decisionEv === null ? ev : Math.max(decisionEv, ev);
    }
  }
  const hasDistinctLines =
    validActions.size > 1 ||
    Array.from(sizingBounds.values()).some(
      (bounds) => !trainingSizingMatches(bounds.minimum, bounds.maximum),
    );
  if (
    bestEv === null ||
    decisionEv === null ||
    !recommendationLineFound ||
    !hasDistinctLines
  ) {
    return null;
  }
  return Number(Math.max(0, bestEv - decisionEv).toFixed(6));
}

export function recommendationAction(
  value: unknown,
): RecommendationAction | null {
  if (
    value === "fold" ||
    value === "check" ||
    value === "call" ||
    value === "bet" ||
    value === "raise"
  ) {
    return value;
  }
  return null;
}

export function recommendationPolicySupport(
  action: RecommendationAction,
  sizing: number | null,
  recommendation: RecommendationResult,
): "line" | "action" | null {
  const candidates = Array.isArray(recommendation.raw.candidates)
    ? recommendation.raw.candidates
    : [];
  let actionSupported = false;
  for (const candidate of candidates) {
    const record = metadataRecord(candidate);
    if (!record || record.action !== action) {
      continue;
    }
    const frequency = metadataRatio(record.frequency);
    if (frequency === null || frequency < MIN_SUPPORTED_FREQUENCY) {
      continue;
    }
    const candidateSizing = policyCandidateSizing(action, record.sizing);
    if (!candidateSizing.valid) {
      continue;
    }
    actionSupported = true;
    if (trainingSizingMatches(sizing, candidateSizing.value)) {
      return "line";
    }
  }
  return actionSupported ? "action" : null;
}

export function policyCandidateSizing(
  action: RecommendationAction,
  value: unknown,
): { valid: boolean; value: number | null } {
  if (action === "bet" || action === "raise") {
    const sizing = metadataNumber(value);
    return sizing !== null && sizing > 0
      ? { valid: true, value: sizing }
      : { valid: false, value: null };
  }
  return value === null
    ? { valid: true, value: null }
    : { valid: false, value: null };
}

export function trainingLineMatches(
  leftAction: RecommendationAction,
  leftSizing: number | null,
  rightAction: RecommendationAction,
  rightSizing: number | null,
): boolean {
  return (
    leftAction === rightAction && trainingSizingMatches(leftSizing, rightSizing)
  );
}

export function decimalNumberParts(value: number): {
  coefficient: bigint;
  scale: number;
} {
  const [mantissa, exponentText] = value.toString().toLowerCase().split("e");
  const exponent =
    exponentText === undefined ? 0 : Number.parseInt(exponentText, 10);
  const negative = mantissa.startsWith("-");
  const unsignedMantissa = negative ? mantissa.slice(1) : mantissa;
  const [integerPart, fractionalPart = ""] = unsignedMantissa.split(".");
  const digits = `${integerPart}${fractionalPart}`;
  const coefficient = BigInt(digits) * (negative ? -1n : 1n);
  return {
    coefficient,
    scale: fractionalPart.length - exponent,
  };
}

export function decimalCoefficientAtScale(
  value: { coefficient: bigint; scale: number },
  scale: number,
): bigint {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}

export function trainingSizingMatches(
  left: number | null,
  right: number | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return false;
  }
  const leftParts = decimalNumberParts(left);
  const rightParts = decimalNumberParts(right);
  const toleranceParts = decimalNumberParts(SIZING_MATCH_TOLERANCE);
  const commonScale = Math.max(
    leftParts.scale,
    rightParts.scale,
    toleranceParts.scale,
  );
  const leftCoefficient = decimalCoefficientAtScale(leftParts, commonScale);
  const rightCoefficient = decimalCoefficientAtScale(rightParts, commonScale);
  const toleranceCoefficient = decimalCoefficientAtScale(
    toleranceParts,
    commonScale,
  );
  const difference =
    leftCoefficient >= rightCoefficient
      ? leftCoefficient - rightCoefficient
      : rightCoefficient - leftCoefficient;
  return difference < toleranceCoefficient;
}

export function parseTrainingSizing(
  action: TrainingActionOption,
  rawSizing: string,
): { sizing: number | null; error: string | null } {
  if (action !== "bet" && action !== "raise") {
    return { sizing: null, error: null };
  }
  if (rawSizing.trim() === "") {
    return { sizing: null, error: null };
  }
  const sizing = Number(rawSizing);
  if (!Number.isFinite(sizing) || sizing <= 0) {
    return { sizing: null, error: "Enter a valid positive decision size" };
  }
  return { sizing, error: null };
}

export function benchmarkFieldLabel(field: string): string {
  return field.replace(/_/g, " ");
}

export function sameTrainingPositionFilter(
  left: TrainingPositionFilter | null,
  right: TrainingPositionFilter | null,
): boolean {
  if (left?.kind !== right?.kind) {
    return false;
  }
  if (!left || !right || left.kind === "unpositioned") {
    return true;
  }
  return right.kind === "position" && left.position === right.position;
}

export function trainingReviewQueueStatus(
  progress: TrainingProgress | null,
  view: TrainingProgressView,
  loading: boolean,
  order: TrainingReviewOrder,
  street: TrainingReviewStreet,
  difference: TrainingReviewDifference | null,
  certainty: TrainingReviewCertaintyFilter,
  reviewPosition: TrainingPositionFilter | null,
  lessonStreet: TrainingReviewStreet,
  lessonQuery: string,
  lessonOrder: TrainingReviewOrder,
  solverFilter: TrainingSolverFilter | null,
  positionFilter: TrainingPositionFilter | null,
  streetFilter: TrainingStreetFilter | null,
  certaintyFilter: TrainingCertaintyFilter | null,
): string {
  if (view === "lessons") {
    if (loading) {
      return "Reading saved lessons...";
    }
    const lessonCount =
      progress?.lesson_count ?? progress?.lesson_hands?.length ?? 0;
    const lessonMatchingHands =
      progress?.lesson_matching_hands ?? progress?.lesson_hands?.length ?? 0;
    const visibleLessons = progress?.lesson_hands?.length ?? 0;
    const filtersActive = lessonStreet !== "all" || lessonQuery.length > 0;
    const orderLabel = lessonOrder === "ev_loss" ? "highest-loss" : "newest";
    if (filtersActive) {
      if (lessonMatchingHands > visibleLessons) {
        return `Showing ${visibleLessons} ${orderLabel} of ${lessonMatchingHands} matching lessons.`;
      }
      if (lessonMatchingHands > 0) {
        return `${lessonMatchingHands} lesson note${lessonMatchingHands === 1 ? "" : "s"} ${lessonMatchingHands === 1 ? "matches" : "match"} these filters.`;
      }
      return "No saved lesson notes match these filters.";
    }
    if (lessonCount > visibleLessons) {
      return `Showing ${visibleLessons} ${orderLabel} of ${lessonCount} saved lesson notes.`;
    }
    if (lessonCount > 0) {
      return `${lessonCount} saved lesson note${lessonCount === 1 ? "" : "s"}.`;
    }
    return "No saved lesson notes yet.";
  }
  if (view === "recent" && solverFilter) {
    if (loading) {
      if (solverFilter.kind === "route") {
        return "Finding engine hands...";
      }
      return solverFilter.kind === "fallback"
        ? "Finding fallback hands..."
        : "Finding unattributed hands...";
    }
    const matchingHands =
      progress?.recent_matching_hands ?? progress?.recent_hands.length ?? 0;
    const visibleHands = progress?.recent_hands.length ?? 0;
    const kindLabel =
      solverFilter.kind === "route"
        ? "engine"
        : solverFilter.kind === "fallback"
          ? "fallback"
          : "unattributed";
    if (matchingHands > visibleHands) {
      return `Showing ${visibleHands} newest of ${matchingHands} ${kindLabel} hands.`;
    }
    if (solverFilter.kind === "route") {
      return `${matchingHands} training hand${matchingHands === 1 ? "" : "s"} handled by ${solverFilter.label}.`;
    }
    if (solverFilter.kind === "unattributed") {
      return `${matchingHands} training hand${matchingHands === 1 ? " has" : "s have"} no engine attribution.`;
    }
    return `${matchingHands} training hand${matchingHands === 1 ? "" : "s"} used this fallback.`;
  }
  if (view === "recent" && positionFilter) {
    if (loading) {
      return positionFilter.kind === "position"
        ? `Finding ${positionFilter.label} hands...`
        : "Finding unpositioned hands...";
    }
    const matchingHands =
      progress?.recent_matching_hands ?? progress?.recent_hands.length ?? 0;
    const visibleHands = progress?.recent_hands.length ?? 0;
    if (matchingHands > visibleHands) {
      return `Showing ${visibleHands} newest of ${matchingHands} ${positionFilter.label} hands.`;
    }
    if (positionFilter.kind === "position") {
      return `${matchingHands} training hand${matchingHands === 1 ? "" : "s"} recorded at ${positionFilter.label}.`;
    }
    return `${matchingHands} training hand${matchingHands === 1 ? " has" : "s have"} no recorded position.`;
  }
  if (view === "recent" && streetFilter) {
    if (loading) {
      return `Finding ${streetFilter.label} hands...`;
    }
    const matchingHands =
      progress?.recent_matching_hands ?? progress?.recent_hands.length ?? 0;
    const visibleHands = progress?.recent_hands.length ?? 0;
    if (matchingHands > visibleHands) {
      return `Showing ${visibleHands} newest of ${matchingHands} ${streetFilter.label} hands.`;
    }
    return `${matchingHands} training hand${matchingHands === 1 ? "" : "s"} played on ${streetFilter.label}.`;
  }
  if (view === "recent" && certaintyFilter) {
    if (loading) {
      return certaintyFilter.certainty === "unrated"
        ? "Finding unrated hands..."
        : `Finding ${certaintyFilter.label.toLowerCase()}-certainty hands...`;
    }
    const matchingHands =
      progress?.recent_matching_hands ?? progress?.recent_hands.length ?? 0;
    const visibleHands = progress?.recent_hands.length ?? 0;
    if (matchingHands > visibleHands) {
      return `Showing ${visibleHands} newest of ${matchingHands} ${certaintyFilter.label} hands.`;
    }
    if (certaintyFilter.certainty === "unrated") {
      return `${matchingHands} training hand${matchingHands === 1 ? " has" : "s have"} no certainty rating.`;
    }
    return `${matchingHands} training hand${matchingHands === 1 ? "" : "s"} rated ${certaintyFilter.label.toLowerCase()} certainty.`;
  }
  if (view !== "review") {
    return "Automation-only hands are not scored.";
  }
  if (loading) {
    return "Updating review queue...";
  }
  if (!progress) {
    return "No pending review hands.";
  }

  const matchingHands =
    progress.review_queue_hands ?? progress.review_queue.length;
  const actionScope = difference
    ? `for ${trainingDecisionLabel(difference.decision_action, null)} to ${trainingDecisionLabel(difference.recommended_action, null)}`
    : null;
  const streetScope = street === "all" ? "across all streets" : `on ${street}`;
  const certaintyScope =
    certainty === "all"
      ? null
      : certainty === "unrated"
        ? "without a certainty rating"
        : `with ${certainty} certainty`;
  const positionScope =
    reviewPosition?.kind === "position"
      ? `at ${reviewPosition.label}`
      : reviewPosition?.kind === "unpositioned"
        ? "without a recorded position"
        : null;
  const scope = [actionScope, streetScope, certaintyScope, positionScope]
    .filter(Boolean)
    .join(" ");
  if (matchingHands > progress.review_queue.length) {
    const orderLabel = order === "ev_loss" ? "highest-loss" : "newest";
    return `Showing ${progress.review_queue.length} ${orderLabel} of ${matchingHands} review hands ${scope}.`;
  }
  if (matchingHands > 0) {
    return `${matchingHands} pending review hand${matchingHands === 1 ? "" : "s"} ${scope}.`;
  }
  return `No pending review hands ${scope}.`;
}

export function suggestedTrainingFocus(
  progress: TrainingProgress,
): TrainingFocus | null {
  const counts = progress.review_street_counts ?? {};
  const candidates = progress.street_summaries.filter(
    (summary) => (counts[summary.street] ?? 0) > 0,
  );
  if (candidates.length === 0) {
    return null;
  }

  const evCandidates = candidates.filter(
    (summary) =>
      summary.ev_compared_hands > 0 && summary.average_ev_loss_bb !== null,
  );
  const usesEvLoss = evCandidates.length > 0;
  const ranked = [...(usesEvLoss ? evCandidates : candidates)].sort(
    (left, right) => {
      if (usesEvLoss) {
        const evDifference =
          (right.average_ev_loss_bb ?? 0) - (left.average_ev_loss_bb ?? 0);
        if (evDifference !== 0) {
          return evDifference;
        }
      } else {
        const accuracyDifference = left.action_accuracy - right.action_accuracy;
        if (accuracyDifference !== 0) {
          return accuracyDifference;
        }
      }

      const pendingDifference =
        (counts[right.street] ?? 0) - (counts[left.street] ?? 0);
      if (pendingDifference !== 0) {
        return pendingDifference;
      }
      return (
        TRAINING_STREET_ORDER.indexOf(left.street) -
        TRAINING_STREET_ORDER.indexOf(right.street)
      );
    },
  );
  const focus = ranked[0];
  if (!focus) {
    return null;
  }
  return {
    street: focus.street,
    reason:
      usesEvLoss && focus.average_ev_loss_bb !== null
        ? `Highest average EV loss: ${formatEvLossBb(focus.average_ev_loss_bb)}`
        : `Lowest action match: ${benchmarkPercent(focus.action_accuracy)}`,
  };
}

export function suggestedCertaintyFocus(
  progress: TrainingProgress,
): TrainingCertaintyFocus | null {
  const candidates = (progress.certainty_summaries ?? []).filter(
    (summary) => (summary.needs_review_hands ?? 0) > 0,
  );
  if (candidates.length === 0) {
    const unratedPending = progress.unrated_needs_review_hands ?? 0;
    return unratedPending > 0
      ? {
          certainty: "unrated",
          label: "Unrated",
          reason: `${unratedPending} legacy ${unratedPending === 1 ? "hand needs" : "hands need"} review`,
        }
      : null;
  }

  const evCandidates = candidates.filter(
    (summary) =>
      summary.ev_compared_hands > 0 && summary.average_ev_loss_bb !== null,
  );
  const usesEvLoss = evCandidates.length > 0;
  const ranked = [...(usesEvLoss ? evCandidates : candidates)].sort(
    (left, right) => {
      if (usesEvLoss) {
        const evDifference =
          (right.average_ev_loss_bb ?? 0) - (left.average_ev_loss_bb ?? 0);
        if (evDifference !== 0) {
          return evDifference;
        }
      } else {
        const accuracyDifference = left.action_accuracy - right.action_accuracy;
        if (accuracyDifference !== 0) {
          return accuracyDifference;
        }
      }

      const pendingDifference =
        (right.needs_review_hands ?? 0) - (left.needs_review_hands ?? 0);
      if (pendingDifference !== 0) {
        return pendingDifference;
      }
      return (
        TRAINING_CERTAINTY_FOCUS_ORDER.indexOf(left.certainty) -
        TRAINING_CERTAINTY_FOCUS_ORDER.indexOf(right.certainty)
      );
    },
  );
  const focus = ranked[0];
  if (!focus) {
    return null;
  }
  return {
    certainty: focus.certainty,
    label: trainingCertaintyLabel(focus.certainty),
    reason:
      usesEvLoss && focus.average_ev_loss_bb !== null
        ? `Highest average EV loss: ${formatEvLossBb(focus.average_ev_loss_bb)}`
        : `Lowest action match: ${benchmarkPercent(focus.action_accuracy)}`,
  };
}

export function suggestedPositionFocus(
  progress: TrainingProgress,
): TrainingPositionFocus | null {
  const candidates = (progress.position_summaries ?? []).filter(
    (summary) => (summary.needs_review_hands ?? 0) > 0,
  );
  if (candidates.length === 0) {
    const unpositionedPending = progress.unpositioned_needs_review_hands ?? 0;
    return unpositionedPending > 0
      ? {
          filter: {
            kind: "unpositioned",
            label: "Unpositioned",
          },
          label: "Unpositioned",
          reason: `${unpositionedPending} unpositioned ${unpositionedPending === 1 ? "hand needs" : "hands need"} review`,
        }
      : null;
  }

  const evCandidates = candidates.filter(
    (summary) =>
      summary.ev_compared_hands > 0 && summary.average_ev_loss_bb !== null,
  );
  const usesEvLoss = evCandidates.length > 0;
  const ranked = [...(usesEvLoss ? evCandidates : candidates)].sort(
    (left, right) => {
      if (usesEvLoss) {
        const evDifference =
          (right.average_ev_loss_bb ?? 0) - (left.average_ev_loss_bb ?? 0);
        if (evDifference !== 0) {
          return evDifference;
        }
      } else {
        const accuracyDifference = left.action_accuracy - right.action_accuracy;
        if (accuracyDifference !== 0) {
          return accuracyDifference;
        }
      }

      const pendingDifference =
        (right.needs_review_hands ?? 0) - (left.needs_review_hands ?? 0);
      if (pendingDifference !== 0) {
        return pendingDifference;
      }
      const leftOrder = TRAINING_POSITION_FOCUS_ORDER.indexOf(left.position);
      const rightOrder = TRAINING_POSITION_FOCUS_ORDER.indexOf(right.position);
      return (
        (leftOrder < 0 ? TRAINING_POSITION_FOCUS_ORDER.length : leftOrder) -
          (rightOrder < 0
            ? TRAINING_POSITION_FOCUS_ORDER.length
            : rightOrder) || left.position.localeCompare(right.position)
      );
    },
  );
  const focus = ranked[0];
  if (!focus) {
    return null;
  }
  return {
    filter: {
      kind: "position",
      position: focus.position,
      label: focus.position,
    },
    label: focus.position,
    reason:
      usesEvLoss && focus.average_ev_loss_bb !== null
        ? `Highest average EV loss: ${formatEvLossBb(focus.average_ev_loss_bb)}`
        : `Lowest action match: ${benchmarkPercent(focus.action_accuracy)}`,
  };
}

export function suggestedActionDifferenceFocus(
  progress: TrainingProgress,
): TrainingActionDifferenceFocus | null {
  const candidates = (progress.action_differences ?? []).filter(
    (difference) => difference.needs_review_hands > 0,
  );
  if (candidates.length === 0) {
    return null;
  }

  const evCandidates = candidates.filter(
    (difference) =>
      difference.ev_compared_hands > 0 &&
      difference.average_ev_loss_bb !== null,
  );
  const usesEvLoss = evCandidates.length > 0;
  const ranked = [...(usesEvLoss ? evCandidates : candidates)].sort(
    (left, right) => {
      if (usesEvLoss) {
        const evDifference =
          (right.average_ev_loss_bb ?? 0) - (left.average_ev_loss_bb ?? 0);
        if (evDifference !== 0) {
          return evDifference;
        }
      }

      const pendingDifference =
        right.needs_review_hands - left.needs_review_hands;
      if (pendingDifference !== 0) {
        return pendingDifference;
      }
      const handDifference = right.hands - left.hands;
      if (handDifference !== 0) {
        return handDifference;
      }
      const decisionDifference =
        TRAINING_ACTIONS.indexOf(left.decision_action) -
        TRAINING_ACTIONS.indexOf(right.decision_action);
      return decisionDifference !== 0
        ? decisionDifference
        : TRAINING_ACTIONS.indexOf(left.recommended_action) -
            TRAINING_ACTIONS.indexOf(right.recommended_action);
    },
  );
  const focus = ranked[0];
  if (!focus) {
    return null;
  }
  return {
    difference: {
      decision_action: focus.decision_action,
      recommended_action: focus.recommended_action,
    },
    label: `${trainingDecisionLabel(focus.decision_action, null)} to ${trainingDecisionLabel(focus.recommended_action, null)}`,
    reason:
      usesEvLoss && focus.average_ev_loss_bb !== null
        ? `Highest average EV loss: ${formatEvLossBb(focus.average_ev_loss_bb)}`
        : `Largest backlog: ${focus.needs_review_hands} ${focus.needs_review_hands === 1 ? "hand needs" : "hands need"} review`,
  };
}
