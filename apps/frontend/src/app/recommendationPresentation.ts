import { type RecommendationResult } from "../types";
import { providerLabel } from "./pipelineSelection";

export interface RecommendationEvidenceMetric {
  label: string;
  value: number;
  unit: "percent" | "bb";
}

export interface RecommendationEvidenceDetail {
  label: string;
  value: string;
}

export interface RecommendationEvidenceCandidate {
  action: string;
  sizing: number | null;
  ev: number | null;
  frequency: number | null;
  foldEquity: number | null;
  perOpponentFoldEquity: number | null;
}

export interface RecommendationEvidence {
  engine: string | null;
  fallbackFrom: string | null;
  fallbackReason: string | null;
  routed: boolean;
  metrics: RecommendationEvidenceMetric[];
  details: RecommendationEvidenceDetail[];
  ranges: RecommendationEvidenceDetail[];
  candidates: RecommendationEvidenceCandidate[];
}

export interface ParserRoutingEvidence {
  provider: string;
  selectedProvider: string;
  layoutProfile: string;
  fallbackFrom: string | null;
  fallbackReason: string | null;
}

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

export function metadataRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function metadataNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function metadataRatio(value: unknown): number | null {
  const number = metadataNumber(value);
  return number !== null && number >= 0 && number <= 1 ? number : null;
}

export function metadataString(value: unknown, maxLength = 320): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`;
}

export function parserRoutingEvidence(
  value: unknown,
): ParserRoutingEvidence | null {
  const routing = metadataRecord(value);
  const provider = metadataString(routing?.provider, 64);
  const selectedProvider = metadataString(routing?.selected_provider, 64);
  const layoutProfile = metadataString(routing?.layout_profile, 64);
  if (!routing || !provider || !selectedProvider || !layoutProfile) {
    return null;
  }
  const fallbackFrom = metadataString(routing.fallback_from, 64);
  const fallbackReason = metadataString(routing.fallback_reason, 320);
  return {
    provider,
    selectedProvider,
    layoutProfile,
    fallbackFrom: fallbackFrom && fallbackReason ? fallbackFrom : null,
    fallbackReason: fallbackFrom && fallbackReason ? fallbackReason : null,
  };
}

export function parserRoutingFromRaw(
  value: unknown,
): ParserRoutingEvidence | null {
  return parserRoutingEvidence(metadataRecord(value)?.parser_routing);
}

export function metadataExactString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

export function metadataLabel(value: unknown): string | null {
  const normalized = metadataString(value, 40)
    ?.replace(/_/g, " ")
    .toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["ip", "oop", "utg"].includes(normalized)) {
    return normalized.toUpperCase();
  }
  return `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
}

export function metadataStringList(
  value: unknown,
  maxItems = 3,
  maxLength = 80,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, maxItems).flatMap((item) => {
    const normalized = metadataString(item, maxLength);
    return normalized ? [normalized] : [];
  });
}

export function formatEvidenceRatio(value: number): string {
  const percent = Number((value * 100).toFixed(1));
  return `${percent}%`;
}

export function formatEvidenceBb(value: number): string {
  return `${Number(value.toFixed(2))} BB`;
}

export function formatEvidenceNumber(value: number, precision = 1): string {
  return Number(value.toFixed(precision)).toString();
}

export function rangeConditioningEvidence(
  value: unknown,
): RecommendationEvidenceDetail[] {
  const conditioning = metadataRecord(value);
  const status = metadataString(conditioning?.status, 20);
  if (!conditioning || (status !== "applied" && status !== "skipped")) {
    return [];
  }

  const details: RecommendationEvidenceDetail[] = [];
  const statusParts = [status === "applied" ? "Applied" : "Skipped"];
  if (status === "applied") {
    const completedStreets = metadataStringList(
      conditioning.completed_streets,
      2,
    )
      .map((street) => metadataLabel(street))
      .filter((street): street is string => street !== null);
    const decisionStreet = metadataLabel(conditioning.decision_street);
    const streets = decisionStreet
      ? [...completedStreets, decisionStreet]
      : completedStreets;
    if (streets.length > 0) {
      statusParts.push(streets.join(" → "));
    }
  } else {
    const reason = metadataString(conditioning.reason, 160);
    if (reason) {
      statusParts.push(reason);
    }
  }
  details.push({ label: "Range conditioning", value: statusParts.join(" · ") });

  if (status === "skipped") {
    const estimatedMemory = metadataNumber(
      conditioning.estimated_compressed_memory_mb,
    );
    const memoryLimit = metadataNumber(conditioning.max_memory_mb);
    const limitParts: string[] = [];
    if (estimatedMemory !== null && estimatedMemory >= 0) {
      limitParts.push(`${formatEvidenceNumber(estimatedMemory)} MB estimate`);
    }
    if (memoryLimit !== null && memoryLimit > 0) {
      limitParts.push(`${formatEvidenceNumber(memoryLimit)} MB limit`);
    }
    if (limitParts.length > 0) {
      details.push({
        label: "Conditioning limit",
        value: limitParts.join(" · "),
      });
    }
    return details;
  }

  const modeledHistory = metadataStringList(conditioning.modeled_history, 12);
  if (modeledHistory.length > 0) {
    details.push({
      label: "Conditioning line",
      value: modeledHistory.join(" → "),
    });
  }

  const activeHands = metadataRecord(conditioning.active_hands);
  const oopHands = metadataNumber(activeHands?.oop);
  const ipHands = metadataNumber(activeHands?.ip);
  const heroLineReach = metadataRatio(conditioning.hero_line_reach);
  const reachParts: string[] = [];
  if (heroLineReach !== null) {
    reachParts.push(`Hero ${formatEvidenceRatio(heroLineReach)}`);
  }
  if (oopHands !== null && Number.isInteger(oopHands) && oopHands > 0) {
    reachParts.push(`OOP ${oopHands} combos`);
  }
  if (ipHands !== null && Number.isInteger(ipHands) && ipHands > 0) {
    reachParts.push(`IP ${ipHands} combos`);
  }
  if (reachParts.length > 0) {
    details.push({ label: "Posterior reach", value: reachParts.join(" · ") });
  }

  const downstreamTree = metadataLabel(conditioning.downstream_tree);
  const compressedMemory = metadataNumber(conditioning.compressed_memory_mb);
  const conditioningExploitability = metadataRecord(
    conditioning.exploitability,
  );
  const exploitabilityBb = metadataNumber(conditioningExploitability?.bb);
  const solveParts: string[] = [];
  if (downstreamTree) {
    solveParts.push(downstreamTree);
  }
  if (compressedMemory !== null && compressedMemory >= 0) {
    solveParts.push(`${formatEvidenceNumber(compressedMemory)} MB estimate`);
  }
  if (exploitabilityBb !== null && exploitabilityBb >= 0) {
    solveParts.push(
      `${formatEvidenceNumber(exploitabilityBb, 3)} BB exploitability`,
    );
  }
  if (solveParts.length > 0) {
    details.push({
      label: "Conditioning solve",
      value: solveParts.join(" · "),
    });
  }

  return details;
}

export function recommendationEvidenceFromRaw(
  raw: Record<string, unknown>,
  recommendation: RecommendationResult,
): RecommendationEvidence | null {
  const engine = metadataString(raw.engine, 80);
  const equity = metadataRecord(raw.equity);
  const rangeEquity = metadataRatio(equity?.equity ?? raw.equity);
  const realizedEquity = metadataRatio(raw.realized_equity);
  const requiredEquity = metadataRatio(raw.required_equity ?? raw.pot_odds);
  const exploitability = metadataRecord(raw.exploitability);
  const exploitabilityBb = metadataNumber(exploitability?.bb);
  const handTopFraction = metadataRatio(raw.hand_top_fraction);
  const policyFraction = metadataRatio(raw.policy_fraction);
  const metrics: RecommendationEvidenceMetric[] = [];
  const details: RecommendationEvidenceDetail[] = [];
  const ranges: RecommendationEvidenceDetail[] = [];

  if (rangeEquity !== null) {
    metrics.push({
      label: "Range equity",
      value: rangeEquity,
      unit: "percent",
    });
  }
  if (realizedEquity !== null) {
    metrics.push({ label: "Realized", value: realizedEquity, unit: "percent" });
  }
  if (requiredEquity !== null && requiredEquity > 0) {
    metrics.push({
      label: "Call price",
      value: requiredEquity,
      unit: "percent",
    });
  }
  if (exploitabilityBb !== null && exploitabilityBb >= 0) {
    metrics.push({
      label: "Exploitability",
      value: exploitabilityBb,
      unit: "bb",
    });
  }
  if (handTopFraction !== null) {
    metrics.push({
      label: "Hand rank",
      value: handTopFraction,
      unit: "percent",
    });
  }
  if (policyFraction !== null) {
    metrics.push({
      label: "Chart range",
      value: policyFraction,
      unit: "percent",
    });
  }

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

  if (engine === "postflop_solver") {
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
      solveBudget.push(
        `${formatEvidenceNumber(compressedMemoryMb)} MB estimate`,
      );
    }
    if (solveBudget.length > 0) {
      details.push({ label: "Solve budget", value: solveBudget.join(" · ") });
    }

    const targetExploitability = metadataRatio(
      tree?.target_exploitability_ratio,
    );
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
        value:
          POSTFLOP_RANGE_SOURCE_LABELS[rawRangeSource ?? ""] ?? rangeSource,
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
    const rangeStackSource = metadataString(
      rangeContext?.stack_depth_source,
      40,
    );
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
    const rangeDecisionStreet = metadataString(
      rangeContext?.decision_street,
      20,
    );
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

  const sortedCandidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .flatMap((candidate): RecommendationEvidenceCandidate[] => {
      const record = metadataRecord(candidate);
      const action = metadataString(record?.action, 24);
      const ev = metadataNumber(record?.ev);
      const frequency = metadataRatio(record?.frequency);
      const foldEquity = metadataRatio(record?.fold_equity);
      const perOpponentFoldEquity = metadataRatio(
        record?.per_opponent_fold_equity,
      );
      const rawSizing = metadataNumber(record?.sizing);
      if (!record || !action || (ev === null && frequency === null)) {
        return [];
      }
      return [
        {
          action,
          sizing: rawSizing !== null && rawSizing >= 0 ? rawSizing : null,
          ev,
          frequency,
          foldEquity,
          perOpponentFoldEquity,
        },
      ];
    })
    .sort((left, right) => {
      if (left.ev !== null && right.ev !== null && left.ev !== right.ev) {
        return right.ev - left.ev;
      }
      if (left.ev === null && right.ev !== null) {
        return 1;
      }
      if (left.ev !== null && right.ev === null) {
        return -1;
      }
      return (right.frequency ?? 0) - (left.frequency ?? 0);
    });
  const chosenCandidateIndex = sortedCandidates.findIndex((candidate) =>
    candidateMatchesRecommendation(candidate, recommendation),
  );
  const candidates =
    chosenCandidateIndex >= 4
      ? [
          ...sortedCandidates.slice(0, 3),
          sortedCandidates[chosenCandidateIndex],
        ]
      : sortedCandidates.slice(0, 4);

  const fallbackFrom = metadataString(raw.requested_engine, 80);
  const routingReason = metadataString(raw.routing_reason);
  const fallbackReason = routingReason ?? metadataString(raw.fallback_reason);
  if (
    metrics.length === 0 &&
    details.length === 0 &&
    ranges.length === 0 &&
    candidates.length === 0 &&
    !fallbackReason
  ) {
    return null;
  }
  return {
    engine: engine ? providerLabel(engine) : null,
    fallbackFrom: fallbackFrom ? providerLabel(fallbackFrom) : null,
    fallbackReason,
    routed: routingReason !== null,
    metrics,
    details,
    ranges,
    candidates,
  };
}

export function formatEvidenceMetric(
  metric: RecommendationEvidenceMetric,
): string {
  if (metric.unit === "percent") {
    return `${Math.round(metric.value * 100)}%`;
  }
  return `${Number(metric.value.toFixed(3))} BB`;
}

export function recommendationContextLabel(
  evidence: RecommendationEvidence,
): string {
  if (evidence.fallbackFrom) {
    return `${evidence.fallbackFrom} ${evidence.routed ? "route" : "fallback"}`;
  }
  return evidence.routed ? "Specialized route" : "Fallback used";
}

export function candidateMatchesRecommendation(
  candidate: RecommendationEvidenceCandidate,
  recommendation: RecommendationResult,
): boolean {
  if (candidate.action !== recommendation.action) {
    return false;
  }
  if (recommendation.sizing === null) {
    return candidate.sizing === null;
  }
  return (
    candidate.sizing !== null &&
    Math.abs(candidate.sizing - recommendation.sizing) < 0.001
  );
}
