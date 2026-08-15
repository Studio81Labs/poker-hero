import type { RecommendationEvidenceDetail } from "./recommendationEvidenceTypes";
import {
  formatEvidenceBb,
  formatEvidenceNumber,
  formatEvidenceRatio,
} from "./recommendationFormatting";
import {
  metadataExactString,
  metadataLabel,
  metadataNumber,
  metadataRatio,
  metadataRecord,
  metadataString,
  metadataStringList,
} from "./recommendationMetadata";
import { rangeConditioningEvidence } from "./rangeConditioningPresentation";

export const POSTFLOP_RANGE_SOURCE_LABELS: Record<string, string> = {
  preflop_chart_limped_pot: "Preflop chart · limped pot",
  preflop_chart_isolation_raised_pot: "Preflop chart · isolation-raised pot",
  preflop_chart_limp_reraised_pot: "Preflop chart · limp-reraised pot",
  preflop_chart_single_raised_pot: "Preflop chart · single-raised pot",
  preflop_chart_three_bet_pot: "Preflop chart · 3-bet pot",
  preflop_chart_cold_three_bet_pot: "Preflop chart · cold-call 3-bet pot",
  preflop_chart_squeeze_pot: "Preflop chart · squeeze pot",
  preflop_chart_four_bet_pot: "Preflop chart · 4-bet pot",
  preflop_chart_cold_four_bet_pot: "Preflop chart · cold 4-bet pot",
};

export function appendPostflopEvidence(
  raw: Record<string, unknown>,
  engine: string | null,
  details: RecommendationEvidenceDetail[],
  ranges: RecommendationEvidenceDetail[],
): void {
  if (engine !== "postflop_solver") {
    return;
  }

  const heroPosition = metadataLabel(raw.hero_position);
  if (heroPosition && ["IP", "OOP"].includes(heroPosition)) {
    details.push({ label: "Position", value: heroPosition });
  }

  const modeledHistory = metadataStringList(raw.modeled_history);
  if (modeledHistory.length > 0) {
    details.push({
      label: "Modeled action",
      value: modeledHistory.join(" → "),
    });
  }

  const tree = metadataRecord(raw.tree);
  const startingPot = metadataNumber(tree?.starting_pot);
  const treeStack = metadataNumber(tree?.effective_stack);
  const treeParts: string[] = [];
  if (startingPot !== null && startingPot > 0) {
    treeParts.push(`${formatEvidenceBb(startingPot)} pot`);
  }
  if (treeStack !== null && treeStack >= 0) {
    treeParts.push(`${formatEvidenceBb(treeStack)} stack`);
  }
  if (treeParts.length > 0) {
    details.push({ label: "Tree", value: treeParts.join(" · ") });
  }

  const maxIterations = metadataNumber(tree?.max_iterations);
  const compressedMemoryMb = metadataNumber(tree?.compressed_memory_mb);
  const solveBudget: string[] = [];
  if (
    maxIterations !== null &&
    Number.isInteger(maxIterations) &&
    maxIterations > 0
  ) {
    solveBudget.push(`${maxIterations} iterations`);
  }
  if (compressedMemoryMb !== null && compressedMemoryMb >= 0) {
    solveBudget.push(`${formatEvidenceNumber(compressedMemoryMb)} MB estimate`);
  }
  if (solveBudget.length > 0) {
    details.push({ label: "Solve budget", value: solveBudget.join(" · ") });
  }

  const targetExploitability = metadataRatio(tree?.target_exploitability_ratio);
  if (targetExploitability !== null && targetExploitability > 0) {
    details.push({
      label: "Solve target",
      value: `${formatEvidenceRatio(targetExploitability)} pot exploitability`,
    });
  }

  const rawRangeSource = metadataString(raw.range_source, 80);
  const rangeSource = metadataLabel(rawRangeSource);
  if (rangeSource) {
    details.push({
      label: "Range source",
      value: POSTFLOP_RANGE_SOURCE_LABELS[rawRangeSource ?? ""] ?? rangeSource,
    });
  }
  details.push(...rangeConditioningEvidence(raw.range_conditioning));

  const contextualRangeSource =
    rawRangeSource === "preflop_chart_limped_pot" ||
    rawRangeSource === "preflop_chart_isolation_raised_pot" ||
    rawRangeSource === "preflop_chart_limp_reraised_pot" ||
    rawRangeSource === "preflop_chart_single_raised_pot" ||
    rawRangeSource === "preflop_chart_three_bet_pot" ||
    rawRangeSource === "preflop_chart_cold_three_bet_pot" ||
    rawRangeSource === "preflop_chart_squeeze_pot" ||
    rawRangeSource === "preflop_chart_four_bet_pot" ||
    rawRangeSource === "preflop_chart_cold_four_bet_pot";
  const rangeContext = contextualRangeSource
    ? metadataRecord(raw.range_context)
    : null;
  const rangeStackPolicy = metadataLabel(rangeContext?.stack_depth_policy);
  const rangeStartingStack = metadataNumber(
    rangeContext?.starting_effective_stack_bb,
  );
  const rangeStackSource = metadataString(rangeContext?.stack_depth_source, 40);
  if (
    rangeStackPolicy &&
    rangeStartingStack !== null &&
    rangeStartingStack > 0 &&
    (rangeStackSource === "reconstructed" ||
      rangeStackSource === "standard_assumption")
  ) {
    details.push({
      label: "Range depth",
      value: `${rangeStackPolicy} · ${formatEvidenceBb(rangeStartingStack)} ${
        rangeStackSource === "reconstructed" ? "starting" : "assumed"
      }`,
    });
  }
  const rangeDecisionStreet = metadataString(rangeContext?.decision_street, 20);
  const rangeCompletedStreetCount = metadataNumber(
    rangeContext?.completed_street_count,
  );
  if (
    (rangeDecisionStreet === "turn" || rangeDecisionStreet === "river") &&
    rangeCompletedStreetCount !== null &&
    Number.isInteger(rangeCompletedStreetCount) &&
    rangeCompletedStreetCount > 0
  ) {
    details.push({
      label: "Range verification",
      value: `${metadataLabel(rangeDecisionStreet)} · ${rangeCompletedStreetCount} completed ${
        rangeCompletedStreetCount === 1 ? "street" : "streets"
      }`,
    });
  }
  if (rawRangeSource === "preflop_chart_limped_pot") {
    const rangeLimperPosition = metadataLabel(rangeContext?.limper_position);
    const rangeBigBlindPosition = metadataLabel(
      rangeContext?.big_blind_position,
    );
    const rangeLimpSize = metadataNumber(rangeContext?.limp_size_bb);
    if (rangeLimperPosition && rangeBigBlindPosition) {
      details.push({
        label: "Range actors",
        value:
          rangeLimperPosition +
          " limps" +
          (rangeLimpSize !== null && rangeLimpSize > 0
            ? " " + formatEvidenceBb(rangeLimpSize)
            : "") +
          " · " +
          rangeBigBlindPosition +
          " checks",
      });
    }
    const rangeLimperFraction = metadataRatio(rangeContext?.limper_fraction);
    const rangeBigBlindRaise = metadataRatio(
      rangeContext?.big_blind_raise_fraction,
    );
    const rangeLimperModel = metadataString(
      rangeContext?.limper_range_model,
      80,
    );
    if (rangeLimperModel === "stack_adjusted_first_in_proxy") {
      details.push({
        label: "Range model",
        value: "Limper uses stack-adjusted first-in proxy",
      });
    }
    if (
      rangeLimperFraction !== null &&
      rangeBigBlindRaise !== null &&
      rangeBigBlindRaise < 1
    ) {
      details.push({
        label: "Range bands",
        value:
          "Entry " +
          formatEvidenceRatio(rangeLimperFraction) +
          " · BB check " +
          formatEvidenceRatio(rangeBigBlindRaise) +
          "-100%",
      });
    }
  } else if (rawRangeSource === "preflop_chart_isolation_raised_pot") {
    const rangeLimperPosition = metadataLabel(rangeContext?.limper_position);
    const rangeIsolationRaiserPosition = metadataLabel(
      rangeContext?.isolation_raiser_position,
    );
    const rangeLimpSize = metadataNumber(rangeContext?.limp_size_bb);
    const rangeIsolationRaiseSize = metadataNumber(
      rangeContext?.isolation_raise_size_bb,
    );
    if (rangeLimperPosition && rangeIsolationRaiserPosition) {
      details.push({
        label: "Range actors",
        value: `${rangeLimperPosition} limps${
          rangeLimpSize !== null && rangeLimpSize > 0
            ? ` ${formatEvidenceBb(rangeLimpSize)}`
            : ""
        } · ${rangeIsolationRaiserPosition} raises${
          rangeIsolationRaiseSize !== null && rangeIsolationRaiseSize > 0
            ? ` ${formatEvidenceBb(rangeIsolationRaiseSize)}`
            : ""
        } · ${rangeLimperPosition} calls`,
      });
    }
    const rangeIsolationFraction = metadataRatio(
      rangeContext?.isolation_raiser_fraction,
    );
    const rangeLimperContinue = metadataRatio(
      rangeContext?.limper_continue_fraction,
    );
    const rangeLimperReraise = metadataRatio(
      rangeContext?.limper_reraise_fraction,
    );
    if (
      rangeIsolationFraction !== null &&
      rangeLimperContinue !== null &&
      rangeLimperReraise !== null &&
      rangeLimperReraise < rangeLimperContinue
    ) {
      details.push({
        label: "Range bands",
        value: `BB isolate ${formatEvidenceRatio(rangeIsolationFraction)} · limper call ${formatEvidenceRatio(
          rangeLimperReraise,
        )}-${formatEvidenceRatio(rangeLimperContinue)}`,
      });
    }
  } else if (rawRangeSource === "preflop_chart_limp_reraised_pot") {
    const rangeLimperPosition = metadataLabel(rangeContext?.limper_position);
    const rangeIsolationRaiserPosition = metadataLabel(
      rangeContext?.isolation_raiser_position,
    );
    const rangeLimpSize = metadataNumber(rangeContext?.limp_size_bb);
    const rangeIsolationRaiseSize = metadataNumber(
      rangeContext?.isolation_raise_size_bb,
    );
    const rangeLimpReraiseSize = metadataNumber(
      rangeContext?.limp_reraise_size_bb,
    );
    if (rangeLimperPosition && rangeIsolationRaiserPosition) {
      details.push({
        label: "Range actors",
        value: `${rangeLimperPosition} limps${
          rangeLimpSize !== null && rangeLimpSize > 0
            ? ` ${formatEvidenceBb(rangeLimpSize)}`
            : ""
        } · ${rangeIsolationRaiserPosition} isolates${
          rangeIsolationRaiseSize !== null && rangeIsolationRaiseSize > 0
            ? ` ${formatEvidenceBb(rangeIsolationRaiseSize)}`
            : ""
        } · ${rangeLimperPosition} reraises${
          rangeLimpReraiseSize !== null && rangeLimpReraiseSize > 0
            ? ` ${formatEvidenceBb(rangeLimpReraiseSize)}`
            : ""
        } · ${rangeIsolationRaiserPosition} calls`,
      });
    }
    const rangeLimperReraise = metadataRatio(
      rangeContext?.limper_reraise_fraction,
    );
    const rangeIsolationRaiserContinue = metadataRatio(
      rangeContext?.isolation_raiser_continue_fraction,
    );
    const rangeIsolationRaiserFourBet = metadataRatio(
      rangeContext?.isolation_raiser_four_bet_fraction,
    );
    if (
      rangeLimperReraise !== null &&
      rangeIsolationRaiserContinue !== null &&
      rangeIsolationRaiserFourBet !== null &&
      rangeIsolationRaiserFourBet < rangeIsolationRaiserContinue
    ) {
      details.push({
        label: "Range bands",
        value: `Limper reraise ${formatEvidenceRatio(rangeLimperReraise)} · isolator call ${formatEvidenceRatio(
          rangeIsolationRaiserFourBet,
        )}-${formatEvidenceRatio(rangeIsolationRaiserContinue)}`,
      });
    }
  } else if (rawRangeSource === "preflop_chart_single_raised_pot") {
    const rangeOpenerPosition = metadataLabel(rangeContext?.opener_position);
    const rangeCallerPosition = metadataLabel(rangeContext?.caller_position);
    const rangeOpeningSize = metadataNumber(rangeContext?.opening_size_bb);
    if (rangeOpenerPosition && rangeCallerPosition) {
      details.push({
        label: "Range actors",
        value: `${rangeOpenerPosition} opens${
          rangeOpeningSize !== null && rangeOpeningSize > 0
            ? ` ${formatEvidenceBb(rangeOpeningSize)}`
            : ""
        } · ${rangeCallerPosition} calls`,
      });
    }
    const rangeOpenerFraction = metadataRatio(rangeContext?.opener_fraction);
    const rangeCallerContinue = metadataRatio(
      rangeContext?.caller_continue_fraction,
    );
    const rangeCallerReraise = metadataRatio(
      rangeContext?.caller_reraise_fraction,
    );
    if (
      rangeOpenerFraction !== null &&
      rangeCallerContinue !== null &&
      rangeCallerReraise !== null &&
      rangeCallerReraise < rangeCallerContinue
    ) {
      details.push({
        label: "Range bands",
        value: `Open ${formatEvidenceRatio(rangeOpenerFraction)} · flat ${formatEvidenceRatio(
          rangeCallerReraise,
        )}-${formatEvidenceRatio(rangeCallerContinue)}`,
      });
    }
  } else if (rawRangeSource === "preflop_chart_three_bet_pot") {
    const rangeOpenerPosition = metadataLabel(rangeContext?.opener_position);
    const rangeThreeBettorPosition = metadataLabel(
      rangeContext?.three_bettor_position,
    );
    const rangeOpeningSize = metadataNumber(rangeContext?.opening_size_bb);
    const rangeThreeBetSize = metadataNumber(rangeContext?.three_bet_size_bb);
    if (rangeOpenerPosition && rangeThreeBettorPosition) {
      details.push({
        label: "Range actors",
        value: `${rangeOpenerPosition} opens${
          rangeOpeningSize !== null && rangeOpeningSize > 0
            ? ` ${formatEvidenceBb(rangeOpeningSize)}`
            : ""
        } · ${rangeThreeBettorPosition} 3-bets${
          rangeThreeBetSize !== null && rangeThreeBetSize > 0
            ? ` ${formatEvidenceBb(rangeThreeBetSize)}`
            : ""
        } · ${rangeOpenerPosition} calls`,
      });
    }
    const rangeThreeBettorFraction = metadataRatio(
      rangeContext?.three_bettor_fraction,
    );
    const rangeOpenerContinue = metadataRatio(
      rangeContext?.opener_continue_fraction,
    );
    const rangeOpenerFourBet = metadataRatio(
      rangeContext?.opener_four_bet_fraction,
    );
    if (
      rangeThreeBettorFraction !== null &&
      rangeOpenerContinue !== null &&
      rangeOpenerFourBet !== null &&
      rangeOpenerFourBet < rangeOpenerContinue
    ) {
      details.push({
        label: "Range bands",
        value: `3-bet ${formatEvidenceRatio(rangeThreeBettorFraction)} · flat ${formatEvidenceRatio(
          rangeOpenerFourBet,
        )}-${formatEvidenceRatio(rangeOpenerContinue)}`,
      });
    }
  } else if (rawRangeSource === "preflop_chart_cold_three_bet_pot") {
    const rangeFoldedOpenerPosition = metadataLabel(
      rangeContext?.folded_opener_position,
    );
    const rangeThreeBettorPosition = metadataLabel(
      rangeContext?.three_bettor_position,
    );
    const rangeColdCallerPosition = metadataLabel(
      rangeContext?.cold_caller_position,
    );
    const rangeOpeningSize = metadataNumber(rangeContext?.opening_size_bb);
    const rangeThreeBetSize = metadataNumber(rangeContext?.three_bet_size_bb);
    const rangeFoldedOpenerCommitment = metadataNumber(
      rangeContext?.folded_opener_commitment_bb,
    );
    if (
      rangeFoldedOpenerPosition &&
      rangeThreeBettorPosition &&
      rangeColdCallerPosition
    ) {
      details.push({
        label: "Range actors",
        value: `${rangeFoldedOpenerPosition} opens${
          rangeOpeningSize !== null && rangeOpeningSize > 0
            ? ` ${formatEvidenceBb(rangeOpeningSize)}`
            : ""
        } · ${rangeThreeBettorPosition} 3-bets${
          rangeThreeBetSize !== null && rangeThreeBetSize > 0
            ? ` ${formatEvidenceBb(rangeThreeBetSize)}`
            : ""
        } · ${rangeColdCallerPosition} cold-calls · ${rangeFoldedOpenerPosition} folds${
          rangeFoldedOpenerCommitment !== null &&
          rangeFoldedOpenerCommitment > 0
            ? ` ${formatEvidenceBb(rangeFoldedOpenerCommitment)} dead`
            : ""
        }`,
      });
    }
    const rangeThreeBettorFraction = metadataRatio(
      rangeContext?.three_bettor_fraction,
    );
    const rangeColdCallerContinue = metadataRatio(
      rangeContext?.cold_caller_continue_fraction,
    );
    const rangeColdCallerFourBet = metadataRatio(
      rangeContext?.cold_caller_four_bet_fraction,
    );
    if (
      rangeThreeBettorFraction !== null &&
      rangeColdCallerContinue !== null &&
      rangeColdCallerFourBet !== null &&
      rangeColdCallerFourBet < rangeColdCallerContinue
    ) {
      details.push({
        label: "Range bands",
        value: `3-bet ${formatEvidenceRatio(rangeThreeBettorFraction)} · cold-call ${formatEvidenceRatio(
          rangeColdCallerFourBet,
        )}-${formatEvidenceRatio(rangeColdCallerContinue)}`,
      });
    }
  } else if (rawRangeSource === "preflop_chart_squeeze_pot") {
    const rangeFoldedOpenerPosition = metadataLabel(
      rangeContext?.folded_opener_position,
    );
    const rangeCallerPosition = metadataLabel(rangeContext?.caller_position);
    const rangeSqueezerPosition = metadataLabel(
      rangeContext?.squeezer_position,
    );
    const rangeOpeningSize = metadataNumber(rangeContext?.opening_size_bb);
    const rangeSqueezeSize = metadataNumber(rangeContext?.squeeze_size_bb);
    const rangeFoldedOpenerCommitment = metadataNumber(
      rangeContext?.folded_opener_commitment_bb,
    );
    if (
      rangeFoldedOpenerPosition &&
      rangeCallerPosition &&
      rangeSqueezerPosition
    ) {
      details.push({
        label: "Range actors",
        value: `${rangeFoldedOpenerPosition} opens${
          rangeOpeningSize !== null && rangeOpeningSize > 0
            ? ` ${formatEvidenceBb(rangeOpeningSize)}`
            : ""
        } · ${rangeCallerPosition} calls · ${rangeSqueezerPosition} squeezes${
          rangeSqueezeSize !== null && rangeSqueezeSize > 0
            ? ` ${formatEvidenceBb(rangeSqueezeSize)}`
            : ""
        } · ${rangeCallerPosition} calls · ${rangeFoldedOpenerPosition} folds${
          rangeFoldedOpenerCommitment !== null &&
          rangeFoldedOpenerCommitment > 0
            ? ` ${formatEvidenceBb(rangeFoldedOpenerCommitment)} dead`
            : ""
        }`,
      });
    }
    const rangeSqueezerFraction = metadataRatio(
      rangeContext?.squeezer_fraction,
    );
    const rangeCallerContinue = metadataRatio(
      rangeContext?.caller_continue_fraction,
    );
    const rangeCallerFourBet = metadataRatio(
      rangeContext?.caller_four_bet_fraction,
    );
    if (
      rangeSqueezerFraction !== null &&
      rangeCallerContinue !== null &&
      rangeCallerFourBet !== null &&
      rangeCallerFourBet < rangeCallerContinue
    ) {
      details.push({
        label: "Range bands",
        value: `Squeeze ${formatEvidenceRatio(rangeSqueezerFraction)} · call ${formatEvidenceRatio(
          rangeCallerFourBet,
        )}-${formatEvidenceRatio(rangeCallerContinue)}`,
      });
    }
  } else if (rawRangeSource === "preflop_chart_cold_four_bet_pot") {
    const rangeFoldedOpenerPosition = metadataLabel(
      rangeContext?.folded_opener_position,
    );
    const rangeThreeBettorPosition = metadataLabel(
      rangeContext?.three_bettor_position,
    );
    const rangeColdFourBettorPosition = metadataLabel(
      rangeContext?.cold_four_bettor_position,
    );
    const rangeOpeningSize = metadataNumber(rangeContext?.opening_size_bb);
    const rangeThreeBetSize = metadataNumber(rangeContext?.three_bet_size_bb);
    const rangeFourBetSize = metadataNumber(rangeContext?.four_bet_size_bb);
    const rangeFoldedOpenerCommitment = metadataNumber(
      rangeContext?.folded_opener_commitment_bb,
    );
    if (
      rangeFoldedOpenerPosition &&
      rangeThreeBettorPosition &&
      rangeColdFourBettorPosition
    ) {
      details.push({
        label: "Range actors",
        value: `${rangeFoldedOpenerPosition} opens${
          rangeOpeningSize !== null && rangeOpeningSize > 0
            ? ` ${formatEvidenceBb(rangeOpeningSize)}`
            : ""
        } · ${rangeThreeBettorPosition} 3-bets${
          rangeThreeBetSize !== null && rangeThreeBetSize > 0
            ? ` ${formatEvidenceBb(rangeThreeBetSize)}`
            : ""
        } · ${rangeColdFourBettorPosition} cold 4-bets${
          rangeFourBetSize !== null && rangeFourBetSize > 0
            ? ` ${formatEvidenceBb(rangeFourBetSize)}`
            : ""
        } · ${rangeFoldedOpenerPosition} folds${
          rangeFoldedOpenerCommitment !== null &&
          rangeFoldedOpenerCommitment > 0
            ? ` ${formatEvidenceBb(rangeFoldedOpenerCommitment)} dead`
            : ""
        } · ${rangeThreeBettorPosition} calls`,
      });
    }
    const rangeColdFourBet = metadataRatio(
      rangeContext?.cold_four_bettor_four_bet_fraction,
    );
    const rangeThreeBettorContinue = metadataRatio(
      rangeContext?.three_bettor_continue_fraction,
    );
    const rangeThreeBettorFiveBet = metadataRatio(
      rangeContext?.three_bettor_five_bet_fraction,
    );
    if (
      rangeColdFourBet !== null &&
      rangeThreeBettorContinue !== null &&
      rangeThreeBettorFiveBet !== null &&
      rangeThreeBettorFiveBet < rangeThreeBettorContinue
    ) {
      details.push({
        label: "Range bands",
        value: `Cold 4-bet ${formatEvidenceRatio(rangeColdFourBet)} · flat ${formatEvidenceRatio(
          rangeThreeBettorFiveBet,
        )}-${formatEvidenceRatio(rangeThreeBettorContinue)}`,
      });
    }
  } else if (rawRangeSource === "preflop_chart_four_bet_pot") {
    const rangeOpenerPosition = metadataLabel(rangeContext?.opener_position);
    const rangeThreeBettorPosition = metadataLabel(
      rangeContext?.three_bettor_position,
    );
    const rangeOpeningSize = metadataNumber(rangeContext?.opening_size_bb);
    const rangeThreeBetSize = metadataNumber(rangeContext?.three_bet_size_bb);
    const rangeFourBetSize = metadataNumber(rangeContext?.four_bet_size_bb);
    if (rangeOpenerPosition && rangeThreeBettorPosition) {
      details.push({
        label: "Range actors",
        value: `${rangeOpenerPosition} opens${
          rangeOpeningSize !== null && rangeOpeningSize > 0
            ? ` ${formatEvidenceBb(rangeOpeningSize)}`
            : ""
        } · ${rangeThreeBettorPosition} 3-bets${
          rangeThreeBetSize !== null && rangeThreeBetSize > 0
            ? ` ${formatEvidenceBb(rangeThreeBetSize)}`
            : ""
        } · ${rangeOpenerPosition} 4-bets${
          rangeFourBetSize !== null && rangeFourBetSize > 0
            ? ` ${formatEvidenceBb(rangeFourBetSize)}`
            : ""
        } · ${rangeThreeBettorPosition} calls`,
      });
    }
    const rangeOpenerFourBet = metadataRatio(
      rangeContext?.opener_four_bet_fraction,
    );
    const rangeThreeBettorContinue = metadataRatio(
      rangeContext?.three_bettor_continue_fraction,
    );
    const rangeThreeBettorFiveBet = metadataRatio(
      rangeContext?.three_bettor_five_bet_fraction,
    );
    if (
      rangeOpenerFourBet !== null &&
      rangeThreeBettorContinue !== null &&
      rangeThreeBettorFiveBet !== null &&
      rangeThreeBettorFiveBet < rangeThreeBettorContinue
    ) {
      details.push({
        label: "Range bands",
        value: `4-bet ${formatEvidenceRatio(rangeOpenerFourBet)} · flat ${formatEvidenceRatio(
          rangeThreeBettorFiveBet,
        )}-${formatEvidenceRatio(rangeThreeBettorContinue)}`,
      });
    }
  }

  const rawRanges = metadataRecord(raw.ranges);
  const oopRange = metadataExactString(rawRanges?.oop);
  const ipRange = metadataExactString(rawRanges?.ip);
  if (oopRange) {
    ranges.push({ label: "OOP", value: oopRange });
  }
  if (ipRange) {
    ranges.push({ label: "IP", value: ipRange });
  }
}
