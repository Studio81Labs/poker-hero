import type { RecommendationEvidenceDetail } from "./recommendationEvidenceTypes";
import {
  formatEvidenceBb,
  formatEvidenceNumber,
  formatEvidenceRatio,
} from "./recommendationFormatting";
import {
  metadataLabel,
  metadataNumber,
  metadataRatio,
  metadataStringList,
} from "./recommendationMetadata";

export function appendPreflopEvidence(
  raw: Record<string, unknown>,
  details: RecommendationEvidenceDetail[],
): void {
  const stackPolicy = metadataLabel(raw.stack_depth_policy);
  const effectiveStack = metadataNumber(raw.effective_stack);
  if (stackPolicy && effectiveStack !== null && effectiveStack >= 0) {
    details.push({
      label: "Stack depth",
      value: `${stackPolicy} · ${formatEvidenceBb(effectiveStack)}`,
    });
  }
  const committedOpponents = metadataNumber(raw.opponents_at_current_bet);
  const opponentWager = metadataNumber(raw.opponent_wager);
  const opponentCommitmentTotal = metadataNumber(raw.opponent_commitment_total);
  const heroWager = metadataNumber(raw.hero_wager);
  const hasCommittedOpponentCount =
    committedOpponents !== null &&
    Number.isInteger(committedOpponents) &&
    committedOpponents > 0;
  const hasOpponentWager = opponentWager !== null && opponentWager > 0;
  const hasDistinctCommitmentTotal =
    opponentCommitmentTotal !== null &&
    opponentCommitmentTotal > 0 &&
    (!hasCommittedOpponentCount ||
      !hasOpponentWager ||
      Math.abs(opponentCommitmentTotal - committedOpponents * opponentWager) >
        0.001);
  const hasHeroWager = heroWager !== null && heroWager > 0;
  if (
    hasCommittedOpponentCount ||
    hasOpponentWager ||
    hasDistinctCommitmentTotal ||
    hasHeroWager
  ) {
    const context = [];
    if (hasCommittedOpponentCount) {
      context.push(
        `${committedOpponents} ${committedOpponents === 1 ? "opponent" : "opponents"}`,
      );
    }
    if (hasOpponentWager) {
      context.push(
        hasCommittedOpponentCount && committedOpponents === 1
          ? `${formatEvidenceBb(opponentWager)} committed`
          : `${formatEvidenceBb(opponentWager)} each`,
      );
    }
    if (hasDistinctCommitmentTotal) {
      context.push(`${formatEvidenceBb(opponentCommitmentTotal)} total`);
    }
    if (hasHeroWager) {
      context.push(`hero ${formatEvidenceBb(heroWager)}`);
    }
    details.push({
      label:
        hasCommittedOpponentCount || hasOpponentWager
          ? "At current wager"
          : "Existing commitments",
      value: context.join(" · "),
    });
  }

  const isolationRaiserPosition = metadataLabel(raw.isolation_raiser_position);
  const limpReraiserPosition = metadataLabel(raw.limp_reraiser_position);
  const limperPositions = metadataStringList(raw.limper_positions, 5)
    .map((position) => metadataLabel(position))
    .filter((position): position is string => position !== null);
  if (limperPositions.length > 0) {
    details.push({ label: "Limpers", value: limperPositions.join(" · ") });
  }
  const limperPosition = metadataLabel(raw.limper_position);
  if (limperPosition) {
    details.push({
      label: isolationRaiserPosition
        ? "Hero limper"
        : limpReraiserPosition
          ? "Original limper"
          : "Limper",
      value: limperPosition,
    });
  }

  const limpSize = metadataNumber(raw.limp_size);
  if (limpSize !== null && limpSize > 0) {
    details.push({ label: "Limp size", value: formatEvidenceBb(limpSize) });
  }

  const limpResponsePolicy = metadataLabel(raw.limp_response_policy);
  if (limpResponsePolicy) {
    details.push({ label: "Limp policy", value: limpResponsePolicy });
  }

  if (isolationRaiserPosition) {
    details.push({ label: "Isolation raiser", value: isolationRaiserPosition });
  }

  const isolationRaiseSize = metadataNumber(raw.isolation_raise_size);
  const isolationRaiseRatio = metadataNumber(raw.isolation_raise_to_limp_ratio);
  const isolationSizePolicy = metadataLabel(raw.isolation_raise_size_policy);
  if (isolationRaiseSize !== null && isolationRaiseSize > 0) {
    let isolationValue = formatEvidenceBb(isolationRaiseSize);
    if (isolationRaiseRatio !== null && isolationRaiseRatio > 0) {
      isolationValue += ` · ${formatEvidenceNumber(isolationRaiseRatio)}x limp`;
    }
    if (isolationSizePolicy) {
      isolationValue += ` · ${isolationSizePolicy}`;
    }
    details.push({ label: "Isolation size", value: isolationValue });
  }

  const isolationResponsePolicy = metadataLabel(raw.isolation_response_policy);
  if (isolationResponsePolicy) {
    details.push({ label: "Isolation policy", value: isolationResponsePolicy });
  }

  const heroIsolationRaiseSize = metadataNumber(raw.hero_isolation_raise_size);
  if (heroIsolationRaiseSize !== null && heroIsolationRaiseSize > 0) {
    details.push({
      label: "Hero isolation",
      value: formatEvidenceBb(heroIsolationRaiseSize),
    });
  }

  if (limpReraiserPosition) {
    details.push({ label: "Limp reraiser", value: limpReraiserPosition });
  }

  const limpReraiseSize = metadataNumber(raw.limp_reraise_size);
  const limpReraiseRatio = metadataNumber(raw.limp_reraise_to_isolation_ratio);
  const limpReraiseSizePolicy = metadataLabel(raw.limp_reraise_size_policy);
  if (limpReraiseSize !== null && limpReraiseSize > 0) {
    let limpReraiseValue = formatEvidenceBb(limpReraiseSize);
    if (limpReraiseRatio !== null && limpReraiseRatio > 0) {
      limpReraiseValue += ` · ${formatEvidenceNumber(limpReraiseRatio, 2)}x isolation`;
    }
    if (limpReraiseSizePolicy) {
      limpReraiseValue += ` · ${limpReraiseSizePolicy}`;
    }
    details.push({ label: "Limp-reraise size", value: limpReraiseValue });
  }

  const limpReraiseResponsePolicy = metadataLabel(
    raw.limp_reraise_response_policy,
  );
  if (limpReraiseResponsePolicy) {
    details.push({
      label: "Limp-reraise policy",
      value: limpReraiseResponsePolicy,
    });
  }

  const limpRaiseFraction = metadataRatio(raw.limp_raise_fraction);
  const baseLimpRaiseFraction = metadataRatio(raw.base_limp_raise_fraction);
  if (limpRaiseFraction !== null) {
    let rangeValue = formatEvidenceRatio(limpRaiseFraction);
    if (
      baseLimpRaiseFraction !== null &&
      Math.abs(baseLimpRaiseFraction - limpRaiseFraction) >= 0.0005
    ) {
      rangeValue += ` (base ${formatEvidenceRatio(baseLimpRaiseFraction)})`;
    }
    details.push({ label: "Isolation range", value: rangeValue });
  }

  const targetLimpRaiseSize = metadataNumber(raw.target_limp_raise_size);
  if (targetLimpRaiseSize !== null && targetLimpRaiseSize > 0) {
    details.push({
      label: "Isolation target",
      value: formatEvidenceBb(targetLimpRaiseSize),
    });
  }

  const multiLimpResponsePolicy = metadataLabel(raw.multi_limp_response_policy);
  if (multiLimpResponsePolicy) {
    details.push({
      label: "Multi-limp policy",
      value: multiLimpResponsePolicy,
    });
  }

  const multiLimpRaiseFraction = metadataRatio(raw.multi_limp_raise_fraction);
  const baseMultiLimpRaiseFraction = metadataRatio(
    raw.base_multi_limp_raise_fraction,
  );
  if (multiLimpRaiseFraction !== null) {
    let rangeValue = formatEvidenceRatio(multiLimpRaiseFraction);
    if (
      baseMultiLimpRaiseFraction !== null &&
      Math.abs(baseMultiLimpRaiseFraction - multiLimpRaiseFraction) >= 0.0005
    ) {
      rangeValue += ` (base ${formatEvidenceRatio(baseMultiLimpRaiseFraction)})`;
    }
    details.push({ label: "Multi-limp isolation range", value: rangeValue });
  }

  const targetMultiLimpRaiseSize = metadataNumber(
    raw.target_multi_limp_raise_size,
  );
  if (targetMultiLimpRaiseSize !== null && targetMultiLimpRaiseSize > 0) {
    details.push({
      label: "Isolation target",
      value: formatEvidenceBb(targetMultiLimpRaiseSize),
    });
  }

  const openerPosition = metadataLabel(raw.opener_position);
  const openerOpenFraction = metadataRatio(raw.opener_open_fraction);
  const baseOpenerOpenFraction = metadataRatio(raw.base_opener_open_fraction);
  if (openerPosition) {
    let openerValue = openerPosition;
    if (openerOpenFraction !== null) {
      openerValue += ` · ${formatEvidenceRatio(openerOpenFraction)} modeled`;
      if (
        baseOpenerOpenFraction !== null &&
        Math.abs(baseOpenerOpenFraction - openerOpenFraction) >= 0.0005
      ) {
        openerValue += ` (base ${formatEvidenceRatio(baseOpenerOpenFraction)})`;
      }
    }
    details.push({ label: "Opener", value: openerValue });
  }

  const callerPositions = metadataStringList(raw.caller_positions, 4)
    .map((position) => metadataLabel(position))
    .filter((position): position is string => position !== null);
  if (callerPositions.length > 0) {
    details.push({
      label: callerPositions.length === 1 ? "Caller" : "Callers",
      value: callerPositions.join(" · "),
    });
  }

  const callerAdjustmentPolicy = metadataLabel(raw.caller_adjustment_policy);
  const squeezeOpenMultiple = metadataNumber(raw.squeeze_open_multiple);
  if (callerAdjustmentPolicy) {
    details.push({
      label: "Caller adjustment",
      value: `${callerAdjustmentPolicy}${
        squeezeOpenMultiple !== null && squeezeOpenMultiple > 0
          ? ` · ${formatEvidenceNumber(squeezeOpenMultiple)}x squeeze`
          : ""
      }`,
    });
  }

  const openingRaiseSize = metadataNumber(raw.opening_raise_size);
  const openSizePolicy = metadataLabel(raw.open_size_policy);
  if (openingRaiseSize !== null && openingRaiseSize >= 0) {
    details.push({
      label: "Opening size",
      value: `${formatEvidenceBb(openingRaiseSize)}${openSizePolicy ? ` · ${openSizePolicy}` : ""}`,
    });
  }

  const heroPriorCommitment = metadataNumber(raw.hero_prior_commitment);
  if (heroPriorCommitment !== null && heroPriorCommitment >= 0) {
    details.push({
      label: "Hero prior call",
      value: formatEvidenceBb(heroPriorCommitment),
    });
  }

  const squeezeResponsePolicy = metadataLabel(raw.squeeze_response_policy);
  const threeBettorPosition = metadataLabel(raw.three_bettor_position);
  if (threeBettorPosition) {
    details.push({
      label: squeezeResponsePolicy ? "Squeezer" : "3-bettor",
      value: threeBettorPosition,
    });
  }

  if (squeezeResponsePolicy) {
    details.push({ label: "Squeeze policy", value: squeezeResponsePolicy });
  }

  const coldThreeBetPolicy = metadataLabel(raw.cold_three_bet_policy);
  if (coldThreeBetPolicy) {
    details.push({ label: "Cold 3-bet policy", value: coldThreeBetPolicy });
  }

  const threeBetSize = metadataNumber(raw.three_bet_size);
  const threeBetRatio = metadataNumber(raw.three_bet_to_open_ratio);
  const threeBetSizePolicy = metadataLabel(raw.three_bet_size_policy);
  if (threeBetSize !== null && threeBetSize > 0) {
    const ratio =
      threeBetRatio !== null && threeBetRatio > 0
        ? ` · ${formatEvidenceNumber(threeBetRatio, 2)}x`
        : "";
    details.push({
      label: "3-bet size",
      value: `${formatEvidenceBb(threeBetSize)}${ratio}${threeBetSizePolicy ? ` · ${threeBetSizePolicy}` : ""}`,
    });
  }

  const fourBettorPosition = metadataLabel(raw.four_bettor_position);
  if (fourBettorPosition) {
    details.push({ label: "4-bettor", value: fourBettorPosition });
  }

  const coldFourBetPolicy = metadataLabel(raw.cold_four_bet_policy);
  if (coldFourBetPolicy) {
    details.push({ label: "Cold 4-bet policy", value: coldFourBetPolicy });
  }

  const fourBetSize = metadataNumber(raw.four_bet_size);
  const fourBetRatio = metadataNumber(raw.four_bet_to_three_bet_ratio);
  const fourBetSizePolicy = metadataLabel(raw.four_bet_size_policy);
  if (fourBetSize !== null && fourBetSize > 0) {
    const ratio =
      fourBetRatio !== null && fourBetRatio > 0
        ? ` · ${formatEvidenceNumber(fourBetRatio, 2)}x`
        : "";
    details.push({
      label: "4-bet size",
      value: `${formatEvidenceBb(fourBetSize)}${ratio}${fourBetSizePolicy ? ` · ${fourBetSizePolicy}` : ""}`,
    });
  }

  const continueFraction = metadataRatio(raw.continue_fraction);
  const reraiseFraction = metadataRatio(raw.reraise_fraction);
  const fourBetFraction = metadataRatio(raw.four_bet_fraction);
  const fiveBetFraction = metadataRatio(raw.five_bet_fraction);
  if (
    continueFraction !== null ||
    reraiseFraction !== null ||
    fourBetFraction !== null ||
    fiveBetFraction !== null
  ) {
    const responseParts: string[] = [];
    if (continueFraction !== null) {
      responseParts.push(`Continue ${formatEvidenceRatio(continueFraction)}`);
    }
    if (reraiseFraction !== null) {
      responseParts.push(`Reraise ${formatEvidenceRatio(reraiseFraction)}`);
    }
    if (fourBetFraction !== null) {
      responseParts.push(`Four-bet ${formatEvidenceRatio(fourBetFraction)}`);
    }
    if (fiveBetFraction !== null) {
      responseParts.push(`Five-bet ${formatEvidenceRatio(fiveBetFraction)}`);
    }
    details.push({ label: "Response range", value: responseParts.join(" · ") });
  }

  const openFraction = metadataRatio(raw.open_fraction);
  const baseOpenFraction = metadataRatio(raw.base_open_fraction);
  if (openFraction !== null) {
    let openValue = formatEvidenceRatio(openFraction);
    if (
      baseOpenFraction !== null &&
      Math.abs(baseOpenFraction - openFraction) >= 0.0005
    ) {
      openValue += ` (base ${formatEvidenceRatio(baseOpenFraction)})`;
    }
    details.push({ label: "Opening range", value: openValue });
  }

  const targetOpenSize = metadataNumber(raw.target_open_size);
  if (targetOpenSize !== null && targetOpenSize >= 0) {
    details.push({
      label: "Open target",
      value: formatEvidenceBb(targetOpenSize),
    });
  }

  const maximumRaiseTotal = metadataNumber(
    raw.maximum_five_bet_total ??
      raw.maximum_four_bet_total ??
      raw.maximum_reraise_total ??
      raw.maximum_multi_limp_raise_total ??
      raw.maximum_limp_raise_total,
  );
  if (maximumRaiseTotal !== null && maximumRaiseTotal >= 0) {
    details.push({
      label: "All-in cap",
      value: formatEvidenceBb(maximumRaiseTotal),
    });
  }
}
