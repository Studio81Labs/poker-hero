import { AlertTriangle, Archive, Camera, Check, ChevronDown, Download, Eye, FlaskConical, Info, Play, RefreshCcw, Settings, Square, Target, Upload, X } from "lucide-react";
import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";

import "./App.css";
import {
  approveState,
  benchmarkDatasetUrl,
  completeTrainingReview,
  getBenchmarkOverview,
  getBenchmarkReport,
  getJob,
  getSystemInfo,
  getTrainingProgress,
  imageUrl,
  importBenchmarkDataset,
  recordTrainingDecision,
  reopenTrainingReview,
  requestRecommendation,
  runParserBenchmark,
  setBenchmarkInclusion,
  uploadScreenshot,
} from "./api";
import type {
  BenchmarkFieldComparison,
  BenchmarkFieldMetric,
  BenchmarkOverview,
  BenchmarkReport,
  BenchmarkReportSummary,
  CanonicalState,
  Card,
  DetectedState,
  FacingAction,
  JobRecord,
  Rank,
  RecommendationAction,
  RecommendationResult,
  Street,
  Suit,
  SystemInfo,
  TrainingOutcome,
  TrainingProgress,
  TrainingReviewOrder,
  TrainingReviewStreet,
} from "./types";

const SUIT_BY_CODE: Record<string, Suit> = {
  c: "clubs",
  d: "diamonds",
  h: "hearts",
  s: "spades",
};

const CODE_BY_SUIT: Record<Suit, string> = {
  clubs: "c",
  diamonds: "d",
  hearts: "h",
  spades: "s",
};

const RANK_VALUES: readonly Rank[] = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const RANKS = new Set<string>(RANK_VALUES);
const TRAINING_ACTIONS: readonly RecommendationAction[] = ["fold", "check", "call", "bet", "raise"];
const MIN_SUPPORTED_FREQUENCY = 0.05;

const EMPTY_STATE: CanonicalState = {
  hero_cards: [],
  board_cards: [],
  pot_size: null,
  current_bet: null,
  hero_stack: null,
  effective_stack: null,
  players_in_hand: null,
  hero_position: null,
  preflop_opener_position: null,
  preflop_open_size: null,
  street: null,
  facing_action: null,
  action_context: null,
  user_approved: false,
};

type StreetOption = "" | Street;
type FacingActionOption = "" | FacingAction;
type TrainingActionOption = "" | RecommendationAction;
type ShareMode = "browser" | "window" | "monitor";
type InputMode = "live" | "upload";
type TrainingProgressView = "recent" | "review";
type TrainingFocus = { street: Street; reason: string };

const TRAINING_STREET_ORDER: readonly Street[] = ["preflop", "flop", "turn", "river"];

type ExtendedDisplayMediaOptions = DisplayMediaStreamOptions & {
  monitorTypeSurfaces?: "include" | "exclude";
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
};

type DisplayMediaTrackSettings = MediaTrackSettings & {
  displaySurface?: unknown;
};

interface StateForm {
  hero_cards: string;
  board_cards: string;
  pot_size: string;
  current_bet: string;
  hero_stack: string;
  effective_stack: string;
  players_in_hand: string;
  hero_position: string;
  preflop_opener_position: string;
  preflop_open_size: string;
  street: StreetOption;
  facing_action: FacingActionOption;
  action_context: string;
}

interface HistoryItem {
  id: string;
  job: JobRecord;
  savedAt: string;
}

interface QueueProgress {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  currentIndex: number;
  currentFile: string;
  aborting: boolean;
}

interface RecommendationEvidenceMetric {
  label: string;
  value: number;
  unit: "percent" | "bb";
}

interface RecommendationEvidenceDetail {
  label: string;
  value: string;
}

interface RecommendationEvidenceCandidate {
  action: string;
  sizing: number | null;
  ev: number | null;
  frequency: number | null;
}

interface RecommendationEvidence {
  engine: string | null;
  fallbackFrom: string | null;
  fallbackReason: string | null;
  routed: boolean;
  metrics: RecommendationEvidenceMetric[];
  details: RecommendationEvidenceDetail[];
  ranges: RecommendationEvidenceDetail[];
  candidates: RecommendationEvidenceCandidate[];
}

const HISTORY_STORAGE_KEY = "poker-training-history-v1";
const ERROR_TOAST_ID = "poker-training-error";
const VALIDATION_TOAST_ID = "poker-training-validation";

const PROVIDER_LABELS: Record<string, string> = {
  custom_local: "Custom local solver",
  external_solver: "External solver",
  llm_advice: "LLM adviser",
  llm_vision: "External vision model",
  local_ev: "Local EV solver",
  local_ev_solver_v1: "Local EV solver",
  local_solver: "Local solver",
  mock: "Demo engine",
  ocr_cv: "OCR + computer vision",
  preflop_chart_v1: "Preflop chart",
  postflop_solver: "Postflop solver",
  rule_based: "Rule-based trainer",
  rule_based_training_v2: "Rule-based trainer",
};

const SHARE_MODES: readonly { value: ShareMode; label: string }[] = [
  { value: "browser", label: "Tab" },
  { value: "window", label: "Window" },
  { value: "monitor", label: "Screen" },
];

const PREFLOP_POSITIONS = [
  { value: "utg", label: "UTG" },
  { value: "hijack", label: "Hijack" },
  { value: "cutoff", label: "Cutoff" },
  { value: "button", label: "Button" },
  { value: "small_blind", label: "Small blind" },
  { value: "big_blind", label: "Big blind" },
] as const;

const CONFIDENCE_KEYS = [
  "hero_cards",
  "board_cards",
  "street",
  "pot_size",
  "current_bet",
  "hero_stack",
  "effective_stack",
  "players_in_hand",
  "hero_position",
  "facing_action",
  "action_context",
] as const;

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.replace(/_/g, " ");
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function metadataNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadataRatio(value: unknown): number | null {
  const number = metadataNumber(value);
  return number !== null && number >= 0 && number <= 1 ? number : null;
}

function metadataString(value: unknown, maxLength = 320): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function metadataExactString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function metadataLabel(value: unknown): string | null {
  const normalized = metadataString(value, 40)?.replace(/_/g, " ").toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["ip", "oop", "utg"].includes(normalized)) {
    return normalized.toUpperCase();
  }
  return `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
}

function metadataStringList(value: unknown, maxItems = 3, maxLength = 80): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, maxItems).flatMap((item) => {
    const normalized = metadataString(item, maxLength);
    return normalized ? [normalized] : [];
  });
}

function formatEvidenceRatio(value: number): string {
  const percent = Number((value * 100).toFixed(1));
  return `${percent}%`;
}

function formatEvidenceBb(value: number): string {
  return `${Number(value.toFixed(2))} BB`;
}

function formatEvidenceNumber(value: number, precision = 1): string {
  return Number(value.toFixed(precision)).toString();
}

function recommendationEvidenceFromRaw(
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
    metrics.push({ label: "Range equity", value: rangeEquity, unit: "percent" });
  }
  if (realizedEquity !== null) {
    metrics.push({ label: "Realized", value: realizedEquity, unit: "percent" });
  }
  if (requiredEquity !== null && requiredEquity > 0) {
    metrics.push({ label: "Call price", value: requiredEquity, unit: "percent" });
  }
  if (exploitabilityBb !== null && exploitabilityBb >= 0) {
    metrics.push({ label: "Exploitability", value: exploitabilityBb, unit: "bb" });
  }
  if (handTopFraction !== null) {
    metrics.push({ label: "Hand rank", value: handTopFraction, unit: "percent" });
  }
  if (policyFraction !== null) {
    metrics.push({ label: "Chart range", value: policyFraction, unit: "percent" });
  }

  const stackPolicy = metadataLabel(raw.stack_depth_policy);
  const effectiveStack = metadataNumber(raw.effective_stack);
  if (stackPolicy && effectiveStack !== null && effectiveStack >= 0) {
    details.push({ label: "Stack depth", value: `${stackPolicy} · ${formatEvidenceBb(effectiveStack)}` });
  }

  const openerPosition = metadataLabel(raw.opener_position);
  const openerOpenFraction = metadataRatio(raw.opener_open_fraction);
  const baseOpenerOpenFraction = metadataRatio(raw.base_opener_open_fraction);
  if (openerPosition) {
    let openerValue = openerPosition;
    if (openerOpenFraction !== null) {
      openerValue += ` · ${formatEvidenceRatio(openerOpenFraction)} modeled`;
      if (
        baseOpenerOpenFraction !== null
        && Math.abs(baseOpenerOpenFraction - openerOpenFraction) >= 0.0005
      ) {
        openerValue += ` (base ${formatEvidenceRatio(baseOpenerOpenFraction)})`;
      }
    }
    details.push({ label: "Opener", value: openerValue });
  }

  const openingRaiseSize = metadataNumber(raw.opening_raise_size);
  const openSizePolicy = metadataLabel(raw.open_size_policy);
  if (openingRaiseSize !== null && openingRaiseSize >= 0) {
    details.push({
      label: "Opening size",
      value: `${formatEvidenceBb(openingRaiseSize)}${openSizePolicy ? ` · ${openSizePolicy}` : ""}`,
    });
  }

  const continueFraction = metadataRatio(raw.continue_fraction);
  const reraiseFraction = metadataRatio(raw.reraise_fraction);
  if (continueFraction !== null || reraiseFraction !== null) {
    const responseParts: string[] = [];
    if (continueFraction !== null) {
      responseParts.push(`Continue ${formatEvidenceRatio(continueFraction)}`);
    }
    if (reraiseFraction !== null) {
      responseParts.push(`Reraise ${formatEvidenceRatio(reraiseFraction)}`);
    }
    details.push({ label: "Response range", value: responseParts.join(" · ") });
  }

  const openFraction = metadataRatio(raw.open_fraction);
  const baseOpenFraction = metadataRatio(raw.base_open_fraction);
  if (openFraction !== null) {
    let openValue = formatEvidenceRatio(openFraction);
    if (baseOpenFraction !== null && Math.abs(baseOpenFraction - openFraction) >= 0.0005) {
      openValue += ` (base ${formatEvidenceRatio(baseOpenFraction)})`;
    }
    details.push({ label: "Opening range", value: openValue });
  }

  const targetOpenSize = metadataNumber(raw.target_open_size);
  if (targetOpenSize !== null && targetOpenSize >= 0) {
    details.push({ label: "Open target", value: formatEvidenceBb(targetOpenSize) });
  }

  const maximumReraiseTotal = metadataNumber(raw.maximum_reraise_total);
  if (maximumReraiseTotal !== null && maximumReraiseTotal >= 0) {
    details.push({ label: "All-in cap", value: formatEvidenceBb(maximumReraiseTotal) });
  }

  if (engine === "postflop_solver") {
    const heroPosition = metadataLabel(raw.hero_position);
    if (heroPosition && ["IP", "OOP"].includes(heroPosition)) {
      details.push({ label: "Position", value: heroPosition });
    }

    const modeledHistory = metadataStringList(raw.modeled_history);
    if (modeledHistory.length > 0) {
      details.push({ label: "Modeled action", value: modeledHistory.join(" → ") });
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
    if (maxIterations !== null && Number.isInteger(maxIterations) && maxIterations > 0) {
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
      const rawSizing = metadataNumber(record?.sizing);
      if (!record || !action || (ev === null && frequency === null)) {
        return [];
      }
      return [{
        action,
        sizing: rawSizing !== null && rawSizing >= 0 ? rawSizing : null,
        ev,
        frequency,
      }];
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
  const chosenCandidateIndex = sortedCandidates.findIndex((candidate) => (
    candidateMatchesRecommendation(candidate, recommendation)
  ));
  const candidates = chosenCandidateIndex >= 4
    ? [...sortedCandidates.slice(0, 3), sortedCandidates[chosenCandidateIndex]]
    : sortedCandidates.slice(0, 4);

  const fallbackFrom = metadataString(raw.requested_engine, 80);
  const routingReason = metadataString(raw.routing_reason);
  const fallbackReason = routingReason ?? metadataString(raw.fallback_reason);
  if (
    metrics.length === 0
    && details.length === 0
    && ranges.length === 0
    && candidates.length === 0
    && !fallbackReason
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

function formatEvidenceMetric(metric: RecommendationEvidenceMetric): string {
  if (metric.unit === "percent") {
    return `${Math.round(metric.value * 100)}%`;
  }
  return `${Number(metric.value.toFixed(3))} BB`;
}

function recommendationContextLabel(evidence: RecommendationEvidence): string {
  if (evidence.fallbackFrom) {
    return `${evidence.fallbackFrom} ${evidence.routed ? "route" : "fallback"}`;
  }
  return evidence.routed ? "Specialized route" : "Fallback used";
}

function formatCandidateValue(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function candidateMatchesRecommendation(
  candidate: RecommendationEvidenceCandidate,
  recommendation: RecommendationResult,
): boolean {
  if (candidate.action !== recommendation.action) {
    return false;
  }
  if (recommendation.sizing === null) {
    return candidate.sizing === null;
  }
  return candidate.sizing !== null && Math.abs(candidate.sizing - recommendation.sizing) < 0.001;
}

function trainingDecisionLabel(action: RecommendationAction, sizing: number | null): string {
  const actionLabel = `${action.slice(0, 1).toUpperCase()}${action.slice(1)}`;
  return sizing === null ? actionLabel : `${actionLabel} ${formatCandidateValue(sizing)} BB`;
}

function formatEvLossBb(value: number): string {
  return `${formatCandidateValue(value)} BB`;
}

function trainingDecisionComparison(
  action: RecommendationAction,
  sizing: number | null,
  recommendation: RecommendationResult,
): { label: string; tone: "match" | "partial" | "different"; evLossBb: number | null } {
  const evLossBb = recommendationEvLossBb(action, sizing, recommendation);
  if (trainingLineMatches(action, sizing, recommendation.action, recommendation.sizing)) {
    return { label: "Matched solver", tone: "match", evLossBb };
  }
  const policySupport = recommendationPolicySupport(action, sizing, recommendation);
  if (policySupport === "line") {
    return { label: "Solver-supported mix", tone: "match", evLossBb };
  }
  if (action === recommendation.action) {
    return { label: "Same action, different size", tone: "partial", evLossBb };
  }
  if (policySupport === "action") {
    return { label: "Solver-supported action, different size", tone: "partial", evLossBb };
  }
  return { label: "Different action", tone: "different", evLossBb };
}

function recommendationEvLossBb(
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
  const validLines: { action: RecommendationAction; sizing: number | null }[] = [];
  for (const candidate of candidates) {
    const record = metadataRecord(candidate);
    const candidateAction = recommendationAction(record?.action);
    if (
      !record
      || !candidateAction
      || !Object.prototype.hasOwnProperty.call(record, "sizing")
    ) {
      continue;
    }
    const candidateSizing = policyCandidateSizing(candidateAction, record.sizing);
    const ev = metadataNumber(record.ev);
    if (!candidateSizing.valid || ev === null) {
      continue;
    }
    if (!validLines.some((line) => trainingLineMatches(
      line.action,
      line.sizing,
      candidateAction,
      candidateSizing.value,
    ))) {
      validLines.push({ action: candidateAction, sizing: candidateSizing.value });
    }
    bestEv = bestEv === null ? ev : Math.max(bestEv, ev);
    if (trainingLineMatches(
      recommendation.action,
      recommendation.sizing,
      candidateAction,
      candidateSizing.value,
    )) {
      recommendationLineFound = true;
    }
    if (trainingLineMatches(action, sizing, candidateAction, candidateSizing.value)) {
      decisionEv = decisionEv === null ? ev : Math.max(decisionEv, ev);
    }
  }
  if (
    bestEv === null
    || decisionEv === null
    || !recommendationLineFound
    || validLines.length < 2
  ) {
    return null;
  }
  return Number(Math.max(0, bestEv - decisionEv).toFixed(6));
}

function recommendationAction(value: unknown): RecommendationAction | null {
  if (value === "fold" || value === "check" || value === "call" || value === "bet" || value === "raise") {
    return value;
  }
  return null;
}

function recommendationPolicySupport(
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

function policyCandidateSizing(
  action: RecommendationAction,
  value: unknown,
): { valid: boolean; value: number | null } {
  if (action === "bet" || action === "raise") {
    const sizing = metadataNumber(value);
    return sizing !== null && sizing >= 0
      ? { valid: true, value: sizing }
      : { valid: false, value: null };
  }
  return value === null
    ? { valid: true, value: null }
    : { valid: false, value: null };
}

function trainingLineMatches(
  leftAction: RecommendationAction,
  leftSizing: number | null,
  rightAction: RecommendationAction,
  rightSizing: number | null,
): boolean {
  return leftAction === rightAction && trainingSizingMatches(leftSizing, rightSizing);
}

function trainingSizingMatches(left: number | null, right: number | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return Math.abs(left - right) < 0.01;
}

function parseTrainingSizing(
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
  if (!Number.isFinite(sizing) || sizing < 0) {
    return { sizing: null, error: "Enter a valid non-negative decision size" };
  }
  return { sizing, error: null };
}

function benchmarkFieldLabel(field: string): string {
  return field.replace(/_/g, " ");
}

function benchmarkPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function trainingOutcomeLabel(outcome: TrainingOutcome): string {
  if (outcome === "match") {
    return "Exact match";
  }
  if (outcome === "mixed") {
    return "Supported mix";
  }
  if (outcome === "same_action") {
    return "Same action";
  }
  if (outcome === "mixed_action") {
    return "Supported action";
  }
  return "Different action";
}

function trainingReviewQueueStatus(
  progress: TrainingProgress | null,
  view: TrainingProgressView,
  loading: boolean,
  order: TrainingReviewOrder,
  street: TrainingReviewStreet,
): string {
  if (view !== "review") {
    return "Automation-only hands are not scored.";
  }
  if (loading) {
    return "Updating review queue...";
  }
  if (!progress) {
    return "No pending review hands.";
  }

  const matchingHands = progress.review_queue_hands ?? progress.review_queue.length;
  const scope = street === "all" ? "across all streets" : `on ${street}`;
  if (matchingHands > progress.review_queue.length) {
    const orderLabel = order === "ev_loss" ? "highest-loss" : "newest";
    return `Showing ${progress.review_queue.length} ${orderLabel} of ${matchingHands} review hands ${scope}.`;
  }
  if (matchingHands > 0) {
    return `${matchingHands} pending review hand${matchingHands === 1 ? "" : "s"} ${scope}.`;
  }
  return `No pending review hands ${scope}.`;
}

function suggestedTrainingFocus(progress: TrainingProgress): TrainingFocus | null {
  const counts = progress.review_street_counts ?? {};
  const candidates = progress.street_summaries.filter(
    (summary) => (counts[summary.street] ?? 0) > 0,
  );
  if (candidates.length === 0) {
    return null;
  }

  const evCandidates = candidates.filter(
    (summary) => summary.ev_compared_hands > 0 && summary.average_ev_loss_bb !== null,
  );
  const usesEvLoss = evCandidates.length > 0;
  const ranked = [...(usesEvLoss ? evCandidates : candidates)].sort((left, right) => {
    if (usesEvLoss) {
      const evDifference = (right.average_ev_loss_bb ?? 0) - (left.average_ev_loss_bb ?? 0);
      if (evDifference !== 0) {
        return evDifference;
      }
    } else {
      const accuracyDifference = left.action_accuracy - right.action_accuracy;
      if (accuracyDifference !== 0) {
        return accuracyDifference;
      }
    }

    const pendingDifference = (counts[right.street] ?? 0) - (counts[left.street] ?? 0);
    if (pendingDifference !== 0) {
      return pendingDifference;
    }
    return TRAINING_STREET_ORDER.indexOf(left.street) - TRAINING_STREET_ORDER.indexOf(right.street);
  });
  const focus = ranked[0];
  if (!focus) {
    return null;
  }
  return {
    street: focus.street,
    reason: usesEvLoss && focus.average_ev_loss_bb !== null
      ? `Highest average EV loss: ${formatEvLossBb(focus.average_ev_loss_bb)}`
      : `Lowest action match: ${benchmarkPercent(focus.action_accuracy)}`,
  };
}

function benchmarkReportSummary(report: BenchmarkReport): BenchmarkReportSummary {
  return {
    id: report.id,
    parser_provider: report.parser_provider,
    layout_profile: report.layout_profile,
    created_at: report.created_at,
    total_cases: report.total_cases,
    failed_cases: report.failed_cases,
    accuracy: report.accuracy,
    field_metrics: report.field_metrics,
  };
}

function benchmarkReportOption(summary: BenchmarkReportSummary, latestId: string | undefined): string {
  const createdAt = new Date(summary.created_at);
  const dateLabel = Number.isNaN(createdAt.getTime())
    ? "Previous run"
    : createdAt.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
  return `${summary.id === latestId ? "Latest" : dateLabel} · ${benchmarkPercent(summary.accuracy)}`;
}

function previousComparableBenchmarkReport(
  report: BenchmarkReport | null,
  recentReports: BenchmarkReportSummary[],
): BenchmarkReportSummary | null {
  if (!report) {
    return null;
  }
  const currentIndex = recentReports.findIndex((summary) => summary.id === report.id);
  if (currentIndex < 0) {
    return null;
  }
  return recentReports
    .slice(currentIndex + 1)
    .find(
      (summary) =>
        summary.parser_provider === report.parser_provider &&
        summary.layout_profile === report.layout_profile,
    ) ?? null;
}

function benchmarkPointChange(current: number, previous: number): number {
  return Math.round((current - previous) * 100);
}

function previousBenchmarkFieldMetric(
  metric: BenchmarkFieldMetric,
  previousReport: BenchmarkReportSummary | null,
): BenchmarkFieldMetric | null {
  return previousReport?.field_metrics?.find((candidate) => candidate.field === metric.field) ?? null;
}

function benchmarkComparisonValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "Not detected";
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map(String).join(" ") : "None";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function benchmarkMismatchLabel(comparisons: BenchmarkFieldComparison[]): string {
  const mismatchCount = comparisons.filter((comparison) => !comparison.matched).length;
  if (mismatchCount === 0) {
    return "All labeled fields matched";
  }
  return `${mismatchCount} ${mismatchCount === 1 ? "mismatch" : "mismatches"}`;
}

function readHistory(): HistoryItem[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryItem[]) : [];
  } catch {
    return [];
  }
}

function writeHistory(items: HistoryItem[]): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items.slice(0, 24)));
}

function cardToCode(card: Card): string {
  return `${card.rank}${CODE_BY_SUIT[card.suit]}`;
}

function cardToDisplay(card: Card): string {
  const suit = card.suit === "spades" ? "♠" : card.suit === "hearts" ? "♥" : card.suit === "diamonds" ? "♦" : "♣";
  return `${card.rank}${suit}`;
}

function isRedSuit(card: Card): boolean {
  return card.suit === "hearts" || card.suit === "diamonds";
}

function isRank(value: string): value is Rank {
  return RANKS.has(value);
}

function parseCards(value: string, label: string): Card[] {
  const cards = value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((code) => {
      const rawRank = code.slice(0, -1).toUpperCase();
      const rank = rawRank === "10" ? "T" : rawRank;
      const suit = SUIT_BY_CODE[code.slice(-1).toLowerCase()];
      if (!isRank(rank) || !suit) {
        throw new Error(`${label} contains an invalid card code: ${code}`);
      }
      return { rank, suit };
    });

  return cards;
}

function formatCards(cards: Card[]): string {
  return cards.map(cardToCode).join(" ");
}

function parseOptionalNumber(value: string, label: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

function parseOptionalInteger(value: string, label: string): number | null {
  const parsed = parseOptionalNumber(value, label);
  if (parsed !== null && !Number.isInteger(parsed)) {
    throw new Error(`${label} must be a whole number`);
  }
  if (parsed !== null && parsed < 1) {
    throw new Error(`${label} must be at least 1`);
  }
  return parsed;
}

function validateCardState(heroCards: Card[], boardCards: Card[]): void {
  if (heroCards.length > 2) {
    throw new Error("Hero cards cannot contain more than 2 cards");
  }
  if (boardCards.length > 5) {
    throw new Error("Board cards cannot contain more than 5 cards");
  }

  const seen = new Set<string>();
  for (const card of [...heroCards, ...boardCards]) {
    const code = cardToCode(card);
    if (seen.has(code)) {
      throw new Error(`Duplicate card in state: ${code}`);
    }
    seen.add(code);
  }
}

function confidenceLabel(value: number | undefined): string {
  if (value === undefined) {
    return "not detected";
  }
  return `${Math.round(value * 100)}%`;
}

function confidencePercent(value: number | undefined): number {
  return value === undefined ? 0 : Math.round(value * 100);
}

function confidenceTone(value: number | undefined): string {
  if (value === undefined) {
    return "missing";
  }
  if (value < 0.7) {
    return "low";
  }
  if (value < 0.85) {
    return "medium";
  }
  return "high";
}

function summarizeConfidences(confidences: Record<string, number>, warnings: string[]) {
  const values = CONFIDENCE_KEYS.map((key) => confidences[key]).filter((value): value is number => value !== undefined);
  const detectedCount = values.length;
  const averageConfidence = detectedCount === 0 ? 0 : Math.round((values.reduce((sum, value) => sum + value, 0) / detectedCount) * 100);
  const reviewCount = values.filter((value) => value < 0.7).length + warnings.length;

  return {
    averageConfidence,
    detectedCount,
    fieldTotal: CONFIDENCE_KEYS.length,
    reviewCount,
  };
}

function toCanonicalState(state: DetectedState | CanonicalState): CanonicalState {
  return {
    hero_cards: state.hero_cards,
    board_cards: state.board_cards,
    pot_size: state.pot_size,
    current_bet: state.current_bet,
    hero_stack: state.hero_stack ?? null,
    effective_stack: state.effective_stack,
    players_in_hand: state.players_in_hand,
    hero_position: state.hero_position,
    preflop_opener_position: state.preflop_opener_position ?? null,
    preflop_open_size: state.preflop_open_size ?? null,
    street: state.street,
    facing_action: state.facing_action ?? null,
    action_context: state.action_context,
    user_approved: "user_approved" in state ? state.user_approved : false,
  };
}

function stateFromJob(job: JobRecord): CanonicalState {
  if (job.approved_state) {
    return toCanonicalState(job.approved_state);
  }
  if (job.parser_result) {
    return toCanonicalState(job.parser_result.state);
  }
  return EMPTY_STATE;
}

function stateToForm(state: DetectedState | CanonicalState): StateForm {
  const showPreflopOpen = state.street === "preflop" && state.facing_action === "raise";
  return {
    hero_cards: formatCards(state.hero_cards),
    board_cards: formatCards(state.board_cards),
    pot_size: state.pot_size === null ? "" : String(state.pot_size),
    current_bet: state.current_bet === null ? "" : String(state.current_bet),
    hero_stack: state.hero_stack == null ? "" : String(state.hero_stack),
    effective_stack: state.effective_stack === null ? "" : String(state.effective_stack),
    players_in_hand: state.players_in_hand === null ? "" : String(state.players_in_hand),
    hero_position: state.hero_position ?? "",
    preflop_opener_position: showPreflopOpen ? (state.preflop_opener_position ?? "") : "",
    preflop_open_size:
      showPreflopOpen && state.preflop_open_size !== null && state.preflop_open_size !== undefined
        ? String(state.preflop_open_size)
        : "",
    street: state.street ?? "",
    facing_action: state.facing_action ?? "",
    action_context: state.action_context ?? "",
  };
}

function formToCanonical(form: StateForm): CanonicalState {
  const heroCards = parseCards(form.hero_cards, "Hero cards");
  const boardCards = parseCards(form.board_cards, "Board cards");
  validateCardState(heroCards, boardCards);
  const showPreflopOpen = form.street === "preflop" && form.facing_action === "raise";
  const preflopOpenSize = showPreflopOpen
    ? parseOptionalNumber(form.preflop_open_size, "Opening size")
    : null;
  if (preflopOpenSize !== null && preflopOpenSize <= 0) {
    throw new Error("Opening size must be greater than 0");
  }

  return {
    hero_cards: heroCards,
    board_cards: boardCards,
    pot_size: parseOptionalNumber(form.pot_size, "Pot"),
    current_bet: parseOptionalNumber(form.current_bet, "Current bet"),
    hero_stack: parseOptionalNumber(form.hero_stack, "Hero stack"),
    effective_stack: parseOptionalNumber(form.effective_stack, "Effective stack"),
    players_in_hand: parseOptionalInteger(form.players_in_hand, "Players in hand"),
    hero_position: form.hero_position.trim() === "" ? null : form.hero_position.trim(),
    preflop_opener_position:
      showPreflopOpen && form.preflop_opener_position !== ""
        ? form.preflop_opener_position
        : null,
    preflop_open_size: preflopOpenSize,
    street: form.street === "" ? null : form.street,
    facing_action: form.facing_action === "" ? null : form.facing_action,
    action_context: form.action_context.trim() === "" ? null : form.action_context.trim(),
    user_approved: false,
  };
}

function approvalKey(state: CanonicalState): string {
  return JSON.stringify({
    hero_cards: state.hero_cards.map(cardToCode),
    board_cards: state.board_cards.map(cardToCode),
    pot_size: state.pot_size,
    current_bet: state.current_bet,
    hero_stack: state.hero_stack ?? null,
    effective_stack: state.effective_stack,
    players_in_hand: state.players_in_hand,
    hero_position: state.hero_position,
    preflop_opener_position: state.preflop_opener_position ?? null,
    preflop_open_size: state.preflop_open_size ?? null,
    street: state.street,
    facing_action: state.facing_action ?? null,
    action_context: state.action_context,
  });
}

function clearApprovedResult(job: JobRecord): JobRecord {
  if (!job.approved_state && !job.recommendation) {
    return job;
  }
  if (!job.parser_result) {
    return job;
  }

  return {
    ...job,
    status: job.parser_result ? "parsed" : "created",
    approved_state: null,
    training_decision: null,
    recommendation: null,
  };
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function selectedFilesLabel(files: File[]): string {
  if (files.length === 0) {
    return "Choose screenshots";
  }
  if (files.length === 1) {
    return files[0].name;
  }
  return `${files.length} screenshots selected`;
}

function relativeTimeLabel(isoDate: string): string {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(isoDate).getTime()) / 1000));
  if (elapsedSeconds < 60) {
    return "just now";
  }
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} min ago`;
  }
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours} hr ago`;
  }
  const elapsedDays = Math.round(elapsedHours / 24);
  return `${elapsedDays} day${elapsedDays === 1 ? "" : "s"} ago`;
}

function captureName(): string {
  return `screen-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
}

function shareModeLabel(mode: ShareMode): string {
  return SHARE_MODES.find((option) => option.value === mode)?.label ?? "Window";
}

function displaySurfaceLabel(displaySurface: unknown): string | null {
  if (displaySurface === "browser") {
    return "Tab";
  }
  if (displaySurface === "window") {
    return "Window";
  }
  if (displaySurface === "monitor") {
    return "Screen";
  }
  return null;
}

function displayMediaOptions(mode: ShareMode): ExtendedDisplayMediaOptions {
  const options: ExtendedDisplayMediaOptions = {
    audio: false,
    monitorTypeSurfaces: mode === "monitor" ? "include" : "exclude",
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: mode === "browser" ? "include" : "exclude",
    video: {
      frameRate: 8,
      displaySurface: mode,
    } as MediaTrackConstraints,
  };

  return options;
}

function displaySurfaceMatchesMode(displaySurface: unknown, mode: ShareMode): boolean {
  if (displaySurface !== "browser" && displaySurface !== "window" && displaySurface !== "monitor") {
    return true;
  }
  return displaySurface === mode;
}

function stopMediaStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

function wrongShareModeMessage(displaySurface: unknown, mode: ShareMode): string {
  const selectedLabel = displaySurfaceLabel(displaySurface) ?? "Different source";
  const expectedLabel = shareModeLabel(mode).toLowerCase();
  return `${selectedLabel} was selected. Choose a ${expectedLabel} in the browser share picker, or switch the source type before sharing.`;
}

function getDisplaySurface(stream: MediaStream): unknown {
  return (stream.getVideoTracks()[0]?.getSettings() as DisplayMediaTrackSettings | undefined)?.displaySurface;
}

function autoApprovalState(job: JobRecord, allowWarnings: boolean): CanonicalState {
  if (!job.parser_result) {
    throw new Error("Automation stopped: parser did not return a state");
  }
  if (!allowWarnings && job.parser_result.warnings.length > 0) {
    throw new Error("Automation stopped: parser warnings need manual review");
  }

  const state = formToCanonical(stateToForm(toCanonicalState(job.parser_result.state)));
  if (state.hero_cards.length === 0 || !state.street) {
    throw new Error("Automation stopped: parser state needs manual review");
  }
  return state;
}

function historyCards(job: JobRecord): Card[] {
  const state = job.approved_state ?? job.parser_result?.state ?? EMPTY_STATE;
  return state.hero_cards.slice(0, 2);
}

function historyAction(job: JobRecord): string {
  if (job.recommendation) {
    return job.recommendation.action;
  }
  return job.approved_state ? "approved" : job.status;
}

function isHistoryReady(job: JobRecord): boolean {
  return job.status === "approved" || job.status === "recommended" || job.approved_state !== null || job.recommendation !== null;
}

function createLocalErrorJob(file: File, message: string, index: number): JobRecord {
  const timestamp = new Date().toISOString();
  return {
    id: `local-error-${Date.now()}-${index}`,
    status: "error",
    original_filename: file.name,
    image_filename: "",
    parser_provider: "client",
    recommendation_provider: "none",
    parser_result: null,
    approved_state: null,
    training_decision: null,
    recommendation: null,
    training_reviewed_at: null,
    benchmark_included: false,
    error: message,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function markJobNeedsAttention(job: JobRecord, message: string): JobRecord {
  return {
    ...job,
    status: "error",
    error: message,
    updated_at: new Date().toISOString(),
  };
}

function queueDetail(job: JobRecord): string {
  if (job.status === "error") {
    return job.error ?? "Needs attention";
  }
  if (job.parser_result && job.parser_result.warnings.length > 0) {
    return "Review warnings";
  }
  return job.parser_result?.state.street ?? "No street";
}

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [form, setForm] = useState<StateForm>(() => stateToForm(EMPTY_STATE));
  const [approvedStateKey, setApprovedStateKey] = useState<string | null>(null);
  const [trainingAction, setTrainingAction] = useState<TrainingActionOption>("");
  const [trainingSizing, setTrainingSizing] = useState("");
  const [inputMode, setInputMode] = useState<InputMode>("live");
  const [shareMode, setShareMode] = useState<ShareMode>("window");
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenSourceLabel, setScreenSourceLabel] = useState<string | null>(null);
  const [livePreviewVisible, setLivePreviewVisible] = useState(false);
  const [automationEnabled, setAutomationEnabled] = useState(true);
  const [automationDialogOpen, setAutomationDialogOpen] = useState(false);
  const [infoDialogOpen, setInfoDialogOpen] = useState(false);
  const [trainingDialogOpen, setTrainingDialogOpen] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState<TrainingProgress | null>(null);
  const [trainingProgressView, setTrainingProgressView] = useState<TrainingProgressView>("recent");
  const [trainingReviewOrder, setTrainingReviewOrder] = useState<TrainingReviewOrder>("recent");
  const [trainingReviewStreet, setTrainingReviewStreet] = useState<TrainingReviewStreet>("all");
  const [trainingProgressLoading, setTrainingProgressLoading] = useState(false);
  const [trainingReviewJobId, setTrainingReviewJobId] = useState<string | null>(null);
  const [benchmarkDialogOpen, setBenchmarkDialogOpen] = useState(false);
  const [benchmarkOverview, setBenchmarkOverview] = useState<BenchmarkOverview | null>(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkReportLoading, setBenchmarkReportLoading] = useState(false);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkUpdating, setBenchmarkUpdating] = useState(false);
  const [benchmarkImporting, setBenchmarkImporting] = useState(false);
  const [selectedBenchmarkReport, setSelectedBenchmarkReport] = useState<BenchmarkReport | null>(null);
  const [expandedBenchmarkCaseId, setExpandedBenchmarkCaseId] = useState<string | null>(null);
  const [benchmarkReviewJobId, setBenchmarkReviewJobId] = useState<string | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);
  const [automationApprove, setAutomationApprove] = useState(true);
  const [automationRecommend, setAutomationRecommend] = useState(true);
  const [automationAllowWarnings, setAutomationAllowWarnings] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(() => readHistory());
  const [queueProgress, setQueueProgress] = useState<QueueProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setErrorMessage] = useState<string | null>(null);
  const [errorSequence, setErrorSequence] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const benchmarkDatasetInputRef = useRef<HTMLInputElement | null>(null);
  const queueAbortControllerRef = useRef<AbortController | null>(null);
  const queueAbortRequestedRef = useRef(false);

  const job = useMemo(() => jobs.find((candidate) => candidate.id === activeJobId) ?? jobs[0] ?? null, [activeJobId, jobs]);
  const validation = useMemo(() => {
    try {
      return { state: formToCanonical(form), error: null };
    } catch (validationError) {
      return { state: null, error: messageFromError(validationError, "Correct the detected state") };
    }
  }, [form]);
  const confidences: Record<string, number> = job?.parser_result?.confidences ?? {};
  const parserWarnings = job?.parser_result?.warnings ?? [];
  const warnings = job?.error ? [...parserWarnings, job.error] : parserWarnings;
  const currentStateKey = validation.state ? approvalKey(validation.state) : null;
  const currentStateApproved = Boolean(job?.approved_state && currentStateKey && approvedStateKey === currentStateKey);
  const activeRecommendation = currentStateApproved ? job?.recommendation ?? null : null;
  const activeTrainingDecision = currentStateApproved ? job?.training_decision ?? null : null;
  const decisionEvidence = useMemo(
    () => (activeRecommendation
      ? recommendationEvidenceFromRaw(activeRecommendation.raw, activeRecommendation)
      : null),
    [activeRecommendation],
  );
  const canApprove = Boolean(
    (job?.parser_result || job?.approved_state)
      && validation.state
      && validation.state.hero_cards.length > 0
      && validation.state.street
      && !currentStateApproved,
  );
  const canRecommend = currentStateApproved && !job?.recommendation;
  const stateControlsDisabled = busy;
  const screenshotUrl = useMemo(() => (job && job.image_filename !== "" ? imageUrl(job.id) : null), [job]);
  const screenSharing = screenStream !== null;
  const confidenceSummary = useMemo(() => summarizeConfidences(confidences, warnings), [confidences, warnings]);
  const filmstripCount = jobs.length > 0 ? jobs.length : files.length;
  const frameLabel = job?.original_filename ?? (screenSharing ? `${screenSourceLabel ?? shareModeLabel(shareMode)} live preview` : "No table selected");
  const frameStreet = form.street === "" ? "No street" : form.street;
  const queueCount = jobs.length > 0 ? jobs.length : files.length;
  const liveStatusLabel = screenSharing ? `${screenSourceLabel ?? shareModeLabel(shareMode)} sharing` : inputMode === "upload" ? "Upload queue" : "Live capture";
  const queueProgressPercent = queueProgress ? Math.round((queueProgress.completed / queueProgress.total) * 100) : 0;
  const clearableJobs = useMemo(() => jobs.filter(isHistoryReady), [jobs]);
  const activeParserProvider = systemInfo?.parser_provider ?? job?.parser_provider ?? null;
  const activeRecommendationProvider =
    systemInfo?.recommendation_engine ?? systemInfo?.recommendation_provider ?? job?.recommendation_provider ?? null;
  const recentBenchmarkReports = useMemo(() => {
    if (benchmarkOverview?.recent_reports?.length) {
      return benchmarkOverview.recent_reports;
    }
    return benchmarkOverview?.latest_report
      ? [benchmarkReportSummary(benchmarkOverview.latest_report)]
      : [];
  }, [benchmarkOverview]);
  const benchmarkReport = selectedBenchmarkReport ?? benchmarkOverview?.latest_report ?? null;
  const benchmarkOperationsLocked =
    benchmarkLoading ||
    benchmarkReportLoading ||
    benchmarkRunning ||
    benchmarkUpdating ||
    benchmarkImporting ||
    benchmarkReviewJobId !== null ||
    busy;
  const benchmarkDatasetExportDisabled =
    benchmarkOperationsLocked ||
    (benchmarkOverview?.included_cases ?? 0) === 0;
  const previousBenchmarkReport = useMemo(
    () => previousComparableBenchmarkReport(benchmarkReport, recentBenchmarkReports),
    [benchmarkReport, recentBenchmarkReports],
  );
  const benchmarkAccuracyDelta = useMemo(
    () =>
      benchmarkReport && previousBenchmarkReport
        ? benchmarkPointChange(benchmarkReport.accuracy, previousBenchmarkReport.accuracy)
        : null,
    [benchmarkReport, previousBenchmarkReport],
  );
  const decisionComparison = useMemo(
    () => (activeRecommendation && activeTrainingDecision
      ? trainingDecisionComparison(
        activeTrainingDecision.action,
        activeTrainingDecision.sizing,
        activeRecommendation,
      )
      : null),
    [activeRecommendation, activeTrainingDecision],
  );
  const visibleTrainingHands = trainingProgressView === "review"
    ? trainingProgress?.review_queue ?? []
    : trainingProgress?.recent_hands ?? [];
  const nextReviewHand = trainingProgress?.review_queue[0] ?? null;
  const reviewQueueStatus = trainingReviewQueueStatus(
    trainingProgress,
    trainingProgressView,
    trainingProgressLoading,
    trainingReviewOrder,
    trainingReviewStreet,
  );
  const trainingFocus = trainingProgress ? suggestedTrainingFocus(trainingProgress) : null;

  function setError(nextError: string | null) {
    setErrorMessage(nextError);
    setErrorSequence((current) => current + 1);
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.srcObject = screenStream;
    if (screenStream) {
      try {
        const playPromise = video.play();
        void playPromise?.catch?.(() => undefined);
      } catch {
        // Browsers can delay playback until the element is visible; capture still works once frames arrive.
      }
    }
  }, [screenStream]);

  useEffect(() => {
    if (!screenStream) {
      return;
    }

    const tracks = screenStream.getTracks();
    const onEnded = () => {
      setScreenStream((current) => (current === screenStream ? null : current));
      setScreenSourceLabel(null);
      setLivePreviewVisible(false);
    };
    tracks.forEach((track) => track.addEventListener("ended", onEnded));

    return () => {
      tracks.forEach((track) => {
        track.removeEventListener("ended", onEnded);
        track.stop();
      });
    };
  }, [screenStream]);

  useEffect(() => {
    if (error) {
      toast.error(error, { id: ERROR_TOAST_ID });
      return;
    }
    toast.dismiss(ERROR_TOAST_ID);
  }, [error, errorSequence]);

  useEffect(() => {
    if (!currentStateApproved) {
      setTrainingAction("");
      setTrainingSizing("");
      return;
    }
    setTrainingAction(job?.training_decision?.action ?? "");
    setTrainingSizing(
      job?.training_decision?.sizing === null || job?.training_decision?.sizing === undefined
        ? ""
        : String(job.training_decision.sizing),
    );
  }, [currentStateApproved, job?.id, job?.training_decision?.action, job?.training_decision?.sizing]);

  useEffect(() => {
    if (job && validation.error) {
      toast.warning(validation.error, { id: VALIDATION_TOAST_ID });
      return;
    }
    toast.dismiss(VALIDATION_TOAST_ID);
  }, [job, validation.error]);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFiles(Array.from(event.target.files ?? []));
  }

  function activateJob(nextJob: JobRecord) {
    setActiveJobId(nextJob.id);
    const nextState = stateFromJob(nextJob);
    setForm(stateToForm(nextState));
    setApprovedStateKey(nextJob.approved_state ? approvalKey(nextJob.approved_state) : null);
    setLivePreviewVisible(false);
    setError(null);
  }

  function replaceJob(updatedJob: JobRecord) {
    setJobs((current) => current.map((candidate) => (candidate.id === updatedJob.id ? updatedJob : candidate)));
    setActiveJobId(updatedJob.id);
  }

  function updateHistoryJob(updatedJob: JobRecord) {
    setHistory((current) => {
      if (!current.some((item) => item.id === updatedJob.id)) {
        return current;
      }
      const next = current.map((item) => (item.id === updatedJob.id ? { ...item, job: updatedJob } : item));
      writeHistory(next);
      return next;
    });
  }

  function appendJob(created: JobRecord) {
    setJobs((current) => [...current, created]);
    activateJob(created);
  }

  function saveHistoryJobs(nextJobs: JobRecord[]) {
    if (nextJobs.length === 0) {
      return;
    }

    const savedAt = new Date().toISOString();
    const items: HistoryItem[] = nextJobs.map((nextJob) => ({
      id: nextJob.id,
      job: nextJob,
      savedAt,
    }));
    const incomingIds = new Set(items.map((item) => item.id));

    setHistory((current) => {
      const next = [...items, ...current.filter((candidate) => !incomingIds.has(candidate.id))].slice(0, 24);
      writeHistory(next);
      return next;
    });
  }

  function applyApprovedJob(approved: JobRecord, fallbackState: CanonicalState) {
    const approvedState = approved.approved_state ?? { ...fallbackState, user_approved: true };
    replaceJob(approved);
    setForm(stateToForm(approvedState));
    setApprovedStateKey(approvalKey(approvedState));
  }

  function applyRecommendedJob(recommended: JobRecord) {
    replaceJob(recommended);
    if (recommended.approved_state) {
      setApprovedStateKey(approvalKey(recommended.approved_state));
    }
  }

  async function runConfiguredAutomation(created: JobRecord, signal?: AbortSignal): Promise<JobRecord> {
    if (!automationApprove) {
      return created;
    }
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const approvalState = autoApprovalState(created, automationAllowWarnings);
    const approved = await approveState(created.id, approvalState, signal);
    applyApprovedJob(approved, approvalState);

    if (!automationRecommend) {
      return approved;
    }

    const recommended = await requestRecommendation(approved.id, signal);
    applyRecommendedJob(recommended);
    return recommended;
  }

  async function uploadSelectedFiles(runAutomation: boolean): Promise<JobRecord[]> {
    const selectedFiles = [...files];
    const controller = new AbortController();
    queueAbortControllerRef.current = controller;
    queueAbortRequestedRef.current = false;
    setQueueProgress({
      total: selectedFiles.length,
      completed: 0,
      failed: 0,
      skipped: 0,
      currentIndex: 0,
      currentFile: "",
      aborting: false,
    });

    const completedJobs: JobRecord[] = [];
    const attentionMessages: string[] = [];
    let completedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const [index, selectedFile] of selectedFiles.entries()) {
      if (controller.signal.aborted) {
        skippedCount = selectedFiles.length - completedCount;
        break;
      }
      setQueueProgress({
        total: selectedFiles.length,
        completed: completedCount,
        failed: failedCount,
        skipped: 0,
        currentIndex: index + 1,
        currentFile: selectedFile.name,
        aborting: false,
      });

      try {
        const created = await uploadScreenshot(selectedFile, controller.signal);
        appendJob(created);
        let completed = created;
        if (runAutomation) {
          try {
            completed = await runConfiguredAutomation(created, controller.signal);
          } catch (automationError) {
            if (isAbortError(automationError)) {
              completedJobs.push(created);
              completedCount += 1;
              skippedCount = selectedFiles.length - completedCount;
              break;
            }
            const message = messageFromError(automationError, "Automation stopped for this screenshot");
            const attentionJob = markJobNeedsAttention(created, message);
            replaceJob(attentionJob);
            completed = attentionJob;
            attentionMessages.push(`${selectedFile.name}: ${message}`);
            failedCount += 1;
          }
        }
        completedJobs.push(completed);
        completedCount += 1;
      } catch (uploadError) {
        if (isAbortError(uploadError)) {
          skippedCount = selectedFiles.length - completedCount;
          break;
        }
        const message = messageFromError(uploadError, "Upload failed");
        const errorJob = createLocalErrorJob(selectedFile, message, index);
        appendJob(errorJob);
        completedJobs.push(errorJob);
        attentionMessages.push(`${selectedFile.name}: ${message}`);
        completedCount += 1;
        failedCount += 1;
      }
      setQueueProgress({
        total: selectedFiles.length,
        completed: completedCount,
        failed: failedCount,
        skipped: skippedCount,
        currentIndex: Math.min(index + 1, selectedFiles.length),
        currentFile: selectedFile.name,
        aborting: controller.signal.aborted,
      });
    }
    if (completedJobs.length > 1) {
      activateJob(completedJobs[0]);
    }
    if (controller.signal.aborted || queueAbortRequestedRef.current) {
      setError(`Import aborted. ${skippedCount} unprocessed screenshot${skippedCount === 1 ? "" : "s"} discarded.`);
    } else if (attentionMessages.length > 0) {
      setError(`${attentionMessages.length} screenshot${attentionMessages.length === 1 ? "" : "s"} need attention. Check the highlighted queue items.`);
    }
    setFiles([]);
    setQueueProgress(null);
    queueAbortControllerRef.current = null;
    queueAbortRequestedRef.current = false;
    return completedJobs;
  }

  async function onUpload() {
    if (files.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await uploadSelectedFiles(automationEnabled);
    } catch (uploadError) {
      setError(messageFromError(uploadError, "Upload failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onStartScreenShare(mode: ShareMode = shareMode) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError("Screen sharing is not supported in this browser");
      return;
    }

    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(mode));
      const displaySurface = getDisplaySurface(stream);
      if (!displaySurfaceMatchesMode(displaySurface, mode)) {
        stopMediaStream(stream);
        setScreenSourceLabel(null);
        setScreenStream(null);
        setLivePreviewVisible(false);
        setError(wrongShareModeMessage(displaySurface, mode));
        return;
      }
      setScreenSourceLabel(displaySurfaceLabel(displaySurface) ?? shareModeLabel(mode));
      setScreenStream(stream);
      setLivePreviewVisible(true);
    } catch (shareError) {
      setError(messageFromError(shareError, "Screen sharing was cancelled"));
    }
  }

  function onStopScreenShare() {
    setScreenSourceLabel(null);
    setScreenStream(null);
    setLivePreviewVisible(false);
  }

  async function captureSharedScreenFile(): Promise<File> {
    const video = videoRef.current;
    if (!video || !screenStream) {
      throw new Error("Start screen sharing before capturing");
    }
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      throw new Error("Screen share is still loading; try capture again in a moment");
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not prepare screen capture");
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((capturedBlob) => {
        if (capturedBlob) {
          resolve(capturedBlob);
        } else {
          reject(new Error("Could not encode screen capture"));
        }
      }, "image/png");
    });
    return new File([blob], captureName(), { type: "image/png" });
  }

  async function captureAndParseScreen(): Promise<JobRecord> {
    const created = await uploadScreenshot(await captureSharedScreenFile());
    appendJob(created);
    return created;
  }

  async function onCaptureScreen() {
    setBusy(true);
    setError(null);
    try {
      const created = await captureAndParseScreen();
      if (automationEnabled) {
        await runConfiguredAutomation(created);
      }
    } catch (captureError) {
      setError(messageFromError(captureError, "Screen capture failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onApprove() {
    if (!job) {
      return;
    }
    if (!validation.state) {
      setError(validation.error ?? "Correct the detected state before approval");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const approved = await approveState(job.id, validation.state);
      applyApprovedJob(approved, validation.state);
    } catch (approveError) {
      setError(messageFromError(approveError, "Approval failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onRecommend() {
    if (!job || !canRecommend) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (trainingAction) {
        const parsedSizing = parseTrainingSizing(trainingAction, trainingSizing);
        if (parsedSizing.error) {
          setError(parsedSizing.error);
          return;
        }
        const decisionChanged = !job.training_decision
          || job.training_decision.action !== trainingAction
          || job.training_decision.sizing !== parsedSizing.sizing;
        if (decisionChanged) {
          replaceJob(await recordTrainingDecision(job.id, trainingAction, parsedSizing.sizing));
        }
      }
      applyRecommendedJob(await requestRecommendation(job.id));
    } catch (recommendError) {
      setError(messageFromError(recommendError, "Recommendation failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onSaveTrainingDecision() {
    if (!job || !currentStateApproved || activeRecommendation || !trainingAction) {
      return;
    }
    const parsedSizing = parseTrainingSizing(trainingAction, trainingSizing);
    if (parsedSizing.error) {
      setError(parsedSizing.error);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      replaceJob(await recordTrainingDecision(job.id, trainingAction, parsedSizing.sizing));
      toast.success("Training answer locked");
    } catch (decisionError) {
      setError(messageFromError(decisionError, "Could not save your training answer"));
    } finally {
      setBusy(false);
    }
  }

  async function onCompleteTrainingReview() {
    if (!job || !activeTrainingDecision || !activeRecommendation || decisionComparison?.tone === "match") {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const reviewedJob = await completeTrainingReview(job.id);
      replaceJob(reviewedJob);
      updateHistoryJob(reviewedJob);
      toast.success("Training review completed");
    } catch (reviewError) {
      setError(messageFromError(reviewError, "Could not complete training review"));
    } finally {
      setBusy(false);
    }
  }

  async function onReopenTrainingReview() {
    if (!job || !activeTrainingDecision || !activeRecommendation || decisionComparison?.tone === "match" || !job.training_reviewed_at) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const reopenedJob = await reopenTrainingReview(job.id);
      replaceJob(reopenedJob);
      updateHistoryJob(reopenedJob);
      toast.success("Training review reopened");
    } catch (reviewError) {
      setError(messageFromError(reviewError, "Could not reopen training review"));
    } finally {
      setBusy(false);
    }
  }

  async function reopenTrainingReviewFromProgress(jobId: string) {
    setTrainingReviewJobId(jobId);
    setError(null);
    try {
      const reopenedJob = await reopenTrainingReview(jobId);
      setJobs((current) => current.map((candidate) => (candidate.id === reopenedJob.id ? reopenedJob : candidate)));
      updateHistoryJob(reopenedJob);
      setTrainingProgress(await getTrainingProgress(trainingReviewOrder, trainingReviewStreet));
      toast.success("Training review reopened");
    } catch (reviewError) {
      setError(messageFromError(reviewError, "Could not reopen training review"));
    } finally {
      setTrainingReviewJobId(null);
    }
  }

  function updateForm(field: keyof StateForm, value: string) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (
        (field === "street" && value !== "preflop") ||
        (field === "facing_action" && value !== "raise")
      ) {
        next.preflop_opener_position = "";
        next.preflop_open_size = "";
      }
      return next;
    });
    setApprovedStateKey(null);
    setJobs((current) => current.map((candidate) => (candidate.id === job?.id ? clearApprovedResult(candidate) : candidate)));
  }

  function resetToParser() {
    if (job?.parser_result) {
      setForm(stateToForm(job.parser_result.state));
      setError(null);
      setApprovedStateKey(null);
      setJobs((current) => current.map((candidate) => (candidate.id === job.id ? clearApprovedResult(candidate) : candidate)));
    }
  }

  function updateAutomationApprove(value: boolean) {
    setAutomationApprove(value);
    if (!value) {
      setAutomationRecommend(false);
    }
  }

  function openInfoDialog() {
    setInfoDialogOpen(true);
    if (systemInfo || systemInfoLoading) {
      return;
    }

    setSystemInfoLoading(true);
    void getSystemInfo()
      .then(setSystemInfo)
      .catch(() => undefined)
      .finally(() => setSystemInfoLoading(false));
  }

  function openTrainingDialog() {
    setTrainingDialogOpen(true);
    setTrainingProgress(null);
    setTrainingProgressView("recent");
    setTrainingReviewOrder("recent");
    setTrainingReviewStreet("all");
    setTrainingProgressLoading(true);
    setError(null);
    void getTrainingProgress()
      .then(setTrainingProgress)
      .catch((trainingError) => setError(messageFromError(trainingError, "Could not load training progress")))
      .finally(() => setTrainingProgressLoading(false));
  }

  async function updateTrainingReviewQueue(
    reviewOrder: TrainingReviewOrder,
    reviewStreet: TrainingReviewStreet,
  ) {
    if (
      (reviewOrder === trainingReviewOrder && reviewStreet === trainingReviewStreet)
      || trainingProgressLoading
    ) {
      return;
    }
    const previousOrder = trainingReviewOrder;
    const previousStreet = trainingReviewStreet;
    setTrainingReviewOrder(reviewOrder);
    setTrainingReviewStreet(reviewStreet);
    setTrainingProgressLoading(true);
    setError(null);
    try {
      setTrainingProgress(await getTrainingProgress(reviewOrder, reviewStreet));
    } catch (trainingError) {
      setTrainingReviewOrder(previousOrder);
      setTrainingReviewStreet(previousStreet);
      setError(messageFromError(trainingError, "Could not filter training reviews"));
    } finally {
      setTrainingProgressLoading(false);
    }
  }

  async function focusTrainingReviewStreet(street: Street) {
    setTrainingProgressView("review");
    await updateTrainingReviewQueue(trainingReviewOrder, street);
  }

  async function reviewTrainingHand(jobId: string) {
    setTrainingReviewJobId(jobId);
    setError(null);
    try {
      const reviewJob = await getJob(jobId);
      setJobs((current) => {
        const existing = current.some((candidate) => candidate.id === reviewJob.id);
        return existing
          ? current.map((candidate) => (candidate.id === reviewJob.id ? reviewJob : candidate))
          : [reviewJob, ...current];
      });
      activateJob(reviewJob);
      setTrainingDialogOpen(false);
    } catch (trainingError) {
      setError(messageFromError(trainingError, "Could not open training hand"));
    } finally {
      setTrainingReviewJobId(null);
    }
  }

  function openBenchmarkDialog() {
    setExpandedBenchmarkCaseId(null);
    setSelectedBenchmarkReport(null);
    setBenchmarkDialogOpen(true);
    setBenchmarkLoading(true);
    void getBenchmarkOverview()
      .then((overview) => {
        setBenchmarkOverview(overview);
        setSelectedBenchmarkReport(overview.latest_report);
      })
      .catch((benchmarkError) => setError(messageFromError(benchmarkError, "Could not load parser benchmark")))
      .finally(() => setBenchmarkLoading(false));
  }

  async function onBenchmarkDatasetImport(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const datasetFile = input.files?.[0];
    if (!datasetFile || benchmarkOperationsLocked) {
      input.value = "";
      return;
    }

    setBenchmarkImporting(true);
    setError(null);
    try {
      const result = await importBenchmarkDataset(datasetFile);
      const importedIds = new Set(result.job_ids);
      setBenchmarkOverview((current) => ({
        included_cases: result.included_cases,
        latest_report: current?.latest_report ?? null,
        recent_reports: current?.recent_reports ?? [],
      }));
      setJobs((current) =>
        current.map((candidate) =>
          importedIds.has(candidate.id)
            ? { ...candidate, benchmark_included: true }
            : candidate,
        ),
      );
      setHistory((current) => {
        const next = current.map((item) =>
          importedIds.has(item.id)
            ? { ...item, job: { ...item.job, benchmark_included: true } }
            : item,
        );
        writeHistory(next);
        return next;
      });
      const readyCases = result.imported_cases + result.reused_cases;
      toast.success(`Dataset ready: ${readyCases} ${readyCases === 1 ? "hand" : "hands"}`);
    } catch (benchmarkError) {
      setError(messageFromError(benchmarkError, "Could not import parser dataset"));
    } finally {
      input.value = "";
      setBenchmarkImporting(false);
    }
  }

  async function toggleBenchmarkInclusion() {
    if (!job || (!job.approved_state && !job.benchmark_included)) {
      return;
    }
    setBenchmarkUpdating(true);
    setError(null);
    try {
      const included = !job.benchmark_included;
      const updated = await setBenchmarkInclusion(job.id, included);
      replaceJob(updated);
      setBenchmarkOverview((current) =>
        current
          ? {
              ...current,
              included_cases: Math.max(0, current.included_cases + (included ? 1 : -1)),
            }
          : {
              included_cases: included ? 1 : 0,
              latest_report: null,
              recent_reports: [],
            },
      );
    } catch (benchmarkError) {
      setError(messageFromError(benchmarkError, "Could not update benchmark ground truth"));
    } finally {
      setBenchmarkUpdating(false);
    }
  }

  async function onRunBenchmark() {
    setBenchmarkRunning(true);
    setError(null);
    try {
      const latestReport = await runParserBenchmark();
      const latestSummary = benchmarkReportSummary(latestReport);
      setSelectedBenchmarkReport(latestReport);
      setBenchmarkOverview((current) => ({
        included_cases: current?.included_cases ?? latestReport.total_cases,
        latest_report: latestReport,
        recent_reports: [
          latestSummary,
          ...(current?.recent_reports ?? []).filter((summary) => summary.id !== latestReport.id),
        ].slice(0, 10),
      }));
    } catch (benchmarkError) {
      setError(messageFromError(benchmarkError, "Parser benchmark failed"));
    } finally {
      setBenchmarkRunning(false);
    }
  }

  async function selectBenchmarkReport(reportId: string) {
    if (reportId === benchmarkReport?.id) {
      return;
    }
    setBenchmarkReportLoading(true);
    setExpandedBenchmarkCaseId(null);
    setError(null);
    try {
      setSelectedBenchmarkReport(await getBenchmarkReport(reportId));
    } catch (benchmarkError) {
      setError(messageFromError(benchmarkError, "Could not load benchmark report"));
    } finally {
      setBenchmarkReportLoading(false);
    }
  }

  async function reviewBenchmarkCase(jobId: string) {
    setBenchmarkReviewJobId(jobId);
    setError(null);
    try {
      const reviewJob = await getJob(jobId);
      setJobs((current) => {
        const existing = current.some((candidate) => candidate.id === reviewJob.id);
        return existing
          ? current.map((candidate) => (candidate.id === reviewJob.id ? reviewJob : candidate))
          : [reviewJob, ...current];
      });
      activateJob(reviewJob);
      setBenchmarkDialogOpen(false);
      setExpandedBenchmarkCaseId(null);
    } catch (benchmarkError) {
      setError(messageFromError(benchmarkError, "Could not open benchmark hand"));
    } finally {
      setBenchmarkReviewJobId(null);
    }
  }

  function onAbortQueue() {
    queueAbortRequestedRef.current = true;
    queueAbortControllerRef.current?.abort();
    setQueueProgress((current) =>
      current
        ? {
            ...current,
            aborting: true,
            skipped: Math.max(current.total - current.completed, 0),
          }
        : current,
    );
  }

  function openHistory(item: HistoryItem) {
    setJobs((current) => {
      const existing = current.some((candidate) => candidate.id === item.job.id);
      if (existing) {
        return current.map((candidate) => (candidate.id === item.job.id ? item.job : candidate));
      }
      return [item.job, ...current];
    });
    activateJob(item.job);
  }

  function clearReviewedToHistory() {
    const readyJobs = jobs.filter(isHistoryReady);
    if (readyJobs.length === 0) {
      return;
    }

    const remainingJobs = jobs.filter((candidate) => !isHistoryReady(candidate));
    saveHistoryJobs(readyJobs);
    setJobs(remainingJobs);
    if (remainingJobs.length > 0) {
      activateJob(remainingJobs.find((candidate) => candidate.id === activeJobId) ?? remainingJobs[0]);
    } else {
      setActiveJobId(null);
      setForm(stateToForm(EMPTY_STATE));
      setApprovedStateKey(null);
      setError(null);
    }
  }

  return (
    <main className="app-shell">
      <Toaster
        closeButton
        containerAriaLabel="App notifications"
        expand={false}
        offset={{ right: 18, top: 88 }}
        position="top-right"
        richColors
        toastOptions={{
          classNames: {
            closeButton: "app-toast-close",
            error: "app-toast-error",
            title: "app-toast-title",
            toast: "app-toast",
            warning: "app-toast-warning",
          },
          duration: 6000,
        }}
      />
      <section className="toolbar" aria-label="Analyzer controls">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            A
          </div>
          <div>
            <h1>Poker Training Analyzer</h1>
            <p>Post-hand review for Texas Hold&apos;em screenshots</p>
          </div>
        </div>
        <div className="toolbar-stats" aria-label="Session status">
          <div className="toolbar-stat">
            <strong>{queueCount}</strong>
            <span>in queue</span>
          </div>
          <i aria-hidden="true" />
          <div className="toolbar-stat">
            <strong>{history.length}</strong>
            <span>reviewed</span>
          </div>
          <div className={screenSharing ? "source-status active" : "source-status"}>
            <span aria-hidden="true" />
            <strong>{liveStatusLabel}</strong>
          </div>
          <i aria-hidden="true" />
          <div className="automation-header-control">
            <button
              type="button"
              className={automationEnabled ? "automation-master active" : "automation-master"}
              onClick={() => setAutomationEnabled((current) => !current)}
              aria-pressed={automationEnabled}
              aria-label={`Automation ${automationEnabled ? "On" : "Off"}`}
            >
              <span className="switch-mini" aria-hidden="true">
                <span />
              </span>
              <span className="automation-master-text">
                <strong>Automation</strong>
                <span>{automationEnabled ? "On" : "Off"}</span>
              </span>
            </button>
            <button type="button" className="automation-config-button" onClick={() => setAutomationDialogOpen(true)} aria-label="Configure automation">
              <Settings size={17} aria-hidden="true" />
            </button>
          </div>
          <button type="button" className="header-icon-button" onClick={openInfoDialog} title="About this app" aria-label="About this app">
            <Info size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="header-icon-button"
            onClick={openTrainingDialog}
            disabled={busy}
            title="Training progress"
            aria-label="Training progress"
          >
            <Target size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="header-icon-button"
            onClick={openBenchmarkDialog}
            disabled={busy}
            title="Parser benchmark"
            aria-label="Parser benchmark"
          >
            <FlaskConical size={18} aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="app-workspace">
        <aside className="control-rail" aria-label="Capture, queue and history">
          <section className="input-panel">
            <div className="input-panel-heading">
              <h2>Input</h2>
              <div className="input-mode-switch" role="group" aria-label="Input mode">
                <button type="button" className={inputMode === "live" ? "active" : ""} onClick={() => setInputMode("live")} disabled={busy} aria-pressed={inputMode === "live"}>
                  Live
                </button>
                <button type="button" className={inputMode === "upload" ? "active" : ""} onClick={() => setInputMode("upload")} disabled={busy} aria-pressed={inputMode === "upload"}>
                  Upload
                </button>
              </div>
            </div>

            <div className="input-source-body">
              {inputMode === "live" ? (
                <>
                  <span className="input-label">Capture source</span>
                  <div className="share-mode" role="group" aria-label="Share source type">
                    {SHARE_MODES.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={shareMode === option.value ? "active" : ""}
                        onClick={() => setShareMode(option.value)}
                        disabled={screenSharing || busy}
                        aria-pressed={shareMode === option.value}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <div className="screen-capture-actions">
                    <button
                      type="button"
                      className="secondary-button share-source-button"
                      onClick={() => (screenSharing ? setLivePreviewVisible(true) : onStartScreenShare())}
                      disabled={busy || (screenSharing && livePreviewVisible)}
                    >
                      <span className={screenSharing ? "source-indicator active" : "source-indicator"} aria-hidden="true" />
                      {screenSharing ? `View live ${shareModeLabel(shareMode).toLowerCase()}` : `Share ${shareModeLabel(shareMode).toLowerCase()}`}
                    </button>
                    <button type="button" className="secondary-button icon-action" onClick={onCaptureScreen} disabled={!screenSharing || busy} title="Capture and parse" aria-label="Capture and parse">
                      <Camera size={15} aria-hidden="true" />
                    </button>
                    <button type="button" className="secondary-button icon-action" onClick={onStopScreenShare} disabled={!screenSharing || busy} title="Stop sharing" aria-label="Stop sharing">
                      <Square size={13} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="source-hint">{screenSharing ? `${screenSourceLabel ?? "Source"} sharing active` : "Pick a source and share to read frames."}</div>
                </>
              ) : (
                <>
                  <span className="input-label">Screenshot files</span>
                  <div className="upload-source-row">
                    <label className="file-picker">
                      <Upload size={15} aria-hidden="true" />
                      <span>{selectedFilesLabel(files)}</span>
                      <input className="file-input" type="file" accept="image/*" multiple aria-label="Choose screenshots" onChange={onFileChange} />
                    </label>
                    <button type="button" className="secondary-button icon-action" onClick={onUpload} disabled={files.length === 0 || busy} title="Upload and parse" aria-label="Upload and parse">
                      <Upload size={15} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="source-hint">{files.length > 0 ? `${files.length} selected for upload` : "Choose screenshots to add them to the queue."}</div>
                </>
              )}
            </div>
          </section>

          <section className="queue-panel" aria-label="Screenshots queue">
            <div className="rail-section-heading">
              <span>Queued frames</span>
              <span className="sr-only">{filmstripCount} screenshots</span>
              <span className="queue-heading-actions">
                <strong>{filmstripCount}</strong>
                <button
                  type="button"
                  className="clear-reviewed-button"
                  onClick={clearReviewedToHistory}
                  disabled={busy || clearableJobs.length === 0}
                  title="Clear reviewed to history"
                  aria-label="Clear reviewed"
                >
                  <Archive size={13} aria-hidden="true" />
                </button>
              </span>
            </div>
            {jobs.length > 0 ? (
              <div className="batch-list">
                {jobs.map((candidate, index) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={candidate.id === job?.id ? "batch-item active" : "batch-item"}
                    onClick={() => activateJob(candidate)}
                    disabled={busy}
                    aria-label={`Open screenshot ${index + 1}: ${candidate.original_filename}`}
                  >
                    <span className="batch-number">{index + 1}</span>
                    <span className="batch-text">
                      <span>{candidate.original_filename}</span>
                      <small>{queueDetail(candidate)}</small>
                    </span>
                    <StatusPill status={candidate.status} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="pending-files">{files.length > 0 ? selectedFilesLabel(files) : "No screenshots uploaded or captured yet"}</div>
            )}
          </section>

          <section className="history-panel" aria-label="Session history">
            <div className="rail-section-heading history-heading">
              <span>History · reopen</span>
              <span className="autosaved-pill">Auto-saved</span>
            </div>
            {history.length > 0 ? (
              <div className="history-list">
                {history.map((item, index) => {
                  const cards = historyCards(item.job);
                  return (
                    <button key={`${item.id}-${item.savedAt}`} type="button" className="history-item" onClick={() => openHistory(item)} aria-label={`Reopen history item ${index + 1}`}>
                      <span className="history-cards">
                        {cards.length > 0 ? (
                          cards.map((card) => (
                            <span key={cardToCode(card)} className={isRedSuit(card) ? "red-card" : ""}>
                              {cardToDisplay(card)}
                            </span>
                          ))
                        ) : (
                          <small>No cards</small>
                        )}
                      </span>
                      <span className="history-meta">
                        <small>{relativeTimeLabel(item.savedAt)}</small>
                        <strong>{historyAction(item.job)}</strong>
                      </span>
                      <span className="history-result">{item.job.recommendation ? `${Math.round(item.job.recommendation.confidence * 100)}%` : item.job.status.slice(0, 1).toUpperCase()}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="history-empty">Cleared reviewed hands will appear here.</div>
            )}
          </section>
        </aside>

        <section className="table-column" aria-label="Poker table preview">
          <div className="table-frame-bar">
            <span className={screenSharing ? "live-dot active" : "live-dot"} aria-hidden="true" />
            <span>{frameLabel}</span>
            <strong>{frameStreet}</strong>
          </div>
          <div className="table-frame-body">
            <video className={screenSharing && livePreviewVisible ? "shared-preview active" : "shared-preview"} ref={videoRef} muted playsInline aria-label="Shared screen preview" />
            {screenshotUrl ? <img className={screenSharing && livePreviewVisible ? "screenshot-preview hidden" : "screenshot-preview"} src={screenshotUrl} alt="Uploaded poker table screenshot" /> : null}
            {(!screenSharing || !livePreviewVisible) && !screenshotUrl ? <div className="empty-screenshot">No screenshot uploaded</div> : null}
          </div>
          <div className="confidence-summary" aria-label="Parser confidence summary">
            <div>
              <strong>
                {confidenceSummary.detectedCount}
                <span>/{confidenceSummary.fieldTotal}</span>
              </strong>
              <small>fields read</small>
            </div>
            <div>
              <strong>{confidenceSummary.averageConfidence}%</strong>
              <small>avg confidence</small>
            </div>
            <div>
              <strong className={confidenceSummary.reviewCount > 0 ? "needs-review" : ""}>{confidenceSummary.reviewCount}</strong>
              <small>need review</small>
            </div>
          </div>
        </section>

        <section className="review-column" aria-label="Hand review">
          <div className="panel-header">
            <h2>Detected state</h2>
            {job ? <StatusPill status={job.status} /> : null}
          </div>

          <div className="review-scroll">
            {warnings.length > 0 ? (
              <div className="parser-warnings">
                <AlertTriangle size={16} aria-hidden="true" />
                <ul>
                  {warnings.map((warning, index) => (
                    <li key={`${warning}-${index}`}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="field-grid">
              <Field label="Hero cards" confidence={confidenceLabel(confidences.hero_cards)} confidenceValue={confidences.hero_cards}>
                <input disabled={stateControlsDisabled} value={form.hero_cards} onChange={(event) => updateForm("hero_cards", event.target.value)} />
              </Field>
              <Field label="Board cards" confidence={confidenceLabel(confidences.board_cards)} confidenceValue={confidences.board_cards}>
                <input disabled={stateControlsDisabled} value={form.board_cards} onChange={(event) => updateForm("board_cards", event.target.value)} />
              </Field>
              <Field label="Street" confidence={confidenceLabel(confidences.street)} confidenceValue={confidences.street}>
                <select disabled={stateControlsDisabled} value={form.street} onChange={(event) => updateForm("street", event.target.value)}>
                  <option value="">Select street</option>
                  <option value="preflop">Preflop</option>
                  <option value="flop">Flop</option>
                  <option value="turn">Turn</option>
                  <option value="river">River</option>
                </select>
              </Field>
              <Field label="Pot" confidence={confidenceLabel(confidences.pot_size)} confidenceValue={confidences.pot_size}>
                <input disabled={stateControlsDisabled} inputMode="decimal" value={form.pot_size} onChange={(event) => updateForm("pot_size", event.target.value)} />
              </Field>
              <Field label="Current bet" confidence={confidenceLabel(confidences.current_bet)} confidenceValue={confidences.current_bet}>
                <input
                  disabled={stateControlsDisabled}
                  inputMode="decimal"
                  value={form.current_bet}
                  onChange={(event) => updateForm("current_bet", event.target.value)}
                />
              </Field>
              <Field label="Effective stack" confidence={confidenceLabel(confidences.effective_stack)} confidenceValue={confidences.effective_stack}>
                <input
                  disabled={stateControlsDisabled}
                  inputMode="decimal"
                  value={form.effective_stack}
                  onChange={(event) => updateForm("effective_stack", event.target.value)}
                />
              </Field>
              <Field label="Hero stack" confidence={confidenceLabel(confidences.hero_stack)} confidenceValue={confidences.hero_stack}>
                <input
                  disabled={stateControlsDisabled}
                  inputMode="decimal"
                  value={form.hero_stack}
                  onChange={(event) => updateForm("hero_stack", event.target.value)}
                />
              </Field>
              <Field label="Players in hand" confidence={confidenceLabel(confidences.players_in_hand)} confidenceValue={confidences.players_in_hand}>
                <input
                  disabled={stateControlsDisabled}
                  inputMode="numeric"
                  value={form.players_in_hand}
                  onChange={(event) => updateForm("players_in_hand", event.target.value)}
                />
              </Field>
              <Field label="Hero position" confidence={confidenceLabel(confidences.hero_position)} confidenceValue={confidences.hero_position}>
                <input disabled={stateControlsDisabled} value={form.hero_position} onChange={(event) => updateForm("hero_position", event.target.value)} />
              </Field>
              <Field label="Facing action" confidence={confidenceLabel(confidences.facing_action)} confidenceValue={confidences.facing_action}>
                <select disabled={stateControlsDisabled} value={form.facing_action} onChange={(event) => updateForm("facing_action", event.target.value)}>
                  <option value="">Select action</option>
                  <option value="bet">Bet</option>
                  <option value="raise">Raise or check-raise</option>
                </select>
              </Field>
              {form.street === "preflop" && form.facing_action === "raise" ? (
                <>
                  <Field label="Opener position" confidence="manual">
                    <select
                      disabled={stateControlsDisabled}
                      value={form.preflop_opener_position}
                      onChange={(event) => updateForm("preflop_opener_position", event.target.value)}
                    >
                      <option value="">Select position</option>
                      {PREFLOP_POSITIONS.map((position) => (
                        <option key={position.value} value={position.value}>
                          {position.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Opening size" confidence="manual">
                    <input
                      disabled={stateControlsDisabled}
                      inputMode="decimal"
                      value={form.preflop_open_size}
                      onChange={(event) => updateForm("preflop_open_size", event.target.value)}
                      placeholder="BB"
                    />
                  </Field>
                </>
              ) : null}
              <Field label="Action context" confidence={confidenceLabel(confidences.action_context)} confidenceValue={confidences.action_context}>
                <textarea disabled={stateControlsDisabled} value={form.action_context} onChange={(event) => updateForm("action_context", event.target.value)} />
              </Field>
            </div>

            {currentStateApproved && !activeRecommendation ? (
              <section className="training-decision" aria-label="Your training decision">
                <div className="training-decision-head">
                  <span>Your decision</span>
                  <small>{activeTrainingDecision ? "Answer locked" : "Optional before reveal"}</small>
                </div>
                <div className="training-action-options" role="group" aria-label="Choose your action">
                  {TRAINING_ACTIONS.map((action) => (
                    <button
                      key={action}
                      type="button"
                      className={trainingAction === action ? "active" : undefined}
                      aria-pressed={trainingAction === action}
                      onClick={() => {
                        setTrainingAction(action);
                        if (action !== "bet" && action !== "raise") {
                          setTrainingSizing("");
                        }
                      }}
                      disabled={busy}
                    >
                      {action}
                    </button>
                  ))}
                </div>
                <div className="training-decision-footer">
                  {trainingAction === "bet" || trainingAction === "raise" ? (
                    <label>
                      <span>Size</span>
                      <input
                        aria-label="Decision sizing in BB"
                        inputMode="decimal"
                        value={trainingSizing}
                        onChange={(event) => setTrainingSizing(event.target.value)}
                        placeholder="BB"
                        disabled={busy}
                      />
                    </label>
                  ) : (
                    <span className="training-decision-hint">No answer locked</span>
                  )}
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={onSaveTrainingDecision}
                    disabled={!trainingAction || busy}
                  >
                    <Check size={13} aria-hidden="true" />
                    {activeTrainingDecision ? "Update answer" : "Lock answer"}
                  </button>
                </div>
              </section>
            ) : null}

            {activeRecommendation ? (
              <section className="recommendation" aria-label="Recommendation">
                <div className="recommendation-head">
                  <span>Recommended play</span>
                  <strong>{Math.round(activeRecommendation.confidence * 100)}% confidence</strong>
                </div>
                <div className="recommendation-main">
                  <span className="recommendation-action">{activeRecommendation.action}</span>
                  {activeRecommendation.sizing !== null ? <span className="recommendation-sizing">{activeRecommendation.sizing}</span> : null}
                </div>
                {activeTrainingDecision && decisionComparison ? (
                  <div className="training-comparison" aria-label="Training decision comparison">
                    <span>
                      <small>Your answer</small>
                      <strong>{trainingDecisionLabel(activeTrainingDecision.action, activeTrainingDecision.sizing)}</strong>
                    </span>
                    <div className="training-comparison-result">
                      <em className={decisionComparison.tone}>{decisionComparison.label}</em>
                      {decisionComparison.evLossBb !== null ? (
                        <small className="training-comparison-ev">
                          {formatEvLossBb(decisionComparison.evLossBb)} EV loss
                        </small>
                      ) : null}
                      {decisionComparison.tone !== "match" ? (
                        job?.training_reviewed_at ? (
                          <div className="training-review-complete">
                            <span>
                              <Check size={12} aria-hidden="true" />
                              Reviewed
                            </span>
                            <button type="button" onClick={onReopenTrainingReview} disabled={busy}>
                              <RefreshCcw size={11} aria-hidden="true" />
                              Reopen review
                            </button>
                          </div>
                        ) : (
                          <button type="button" onClick={onCompleteTrainingReview} disabled={busy}>
                            <Check size={12} aria-hidden="true" />
                            Mark reviewed
                          </button>
                        )
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <p>{activeRecommendation.explanation}</p>
                {decisionEvidence ? (
                  <div className="recommendation-evidence" aria-label="Decision evidence">
                    <div className="recommendation-evidence-head">
                      <span>Decision evidence</span>
                      {decisionEvidence.engine ? <strong>{decisionEvidence.engine}</strong> : null}
                    </div>
                    {decisionEvidence.fallbackReason ? (
                      <div className="recommendation-fallback">
                        <strong>
                          {recommendationContextLabel(decisionEvidence)}
                        </strong>
                        <span>{decisionEvidence.fallbackReason}</span>
                      </div>
                    ) : null}
                    {decisionEvidence.metrics.length > 0 ? (
                      <div className="recommendation-metrics">
                        {decisionEvidence.metrics.map((metric) => (
                          <div key={metric.label}>
                            <strong>{formatEvidenceMetric(metric)}</strong>
                            <span>{metric.label}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {decisionEvidence.details.length > 0 ? (
                      <dl className="recommendation-context" aria-label="Decision context">
                        {decisionEvidence.details.map((detail) => (
                          <div key={detail.label}>
                            <dt>{detail.label}</dt>
                            <dd>{detail.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {decisionEvidence.ranges.length > 0 ? (
                      <details className="recommendation-ranges" aria-label="Modeled ranges">
                        <summary>Modeled ranges</summary>
                        <dl>
                          {decisionEvidence.ranges.map((range) => (
                            <div key={range.label}>
                              <dt>{range.label}</dt>
                              <dd>{range.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    ) : null}
                    {decisionEvidence.candidates.length > 0 ? (
                      <div className="recommendation-candidates" role="list" aria-label="Compared actions">
                        <div className="recommendation-candidates-head">
                          <span>Compared actions</span>
                          <span>EV / frequency</span>
                        </div>
                        {decisionEvidence.candidates.map((candidate, index) => {
                          const selected = candidateMatchesRecommendation(candidate, activeRecommendation);
                          return (
                            <div
                              key={`${candidate.action}-${candidate.sizing ?? "none"}-${index}`}
                              className={selected ? "selected" : undefined}
                              role="listitem"
                              aria-current={selected ? "true" : undefined}
                            >
                              <span className="recommendation-candidate-action">
                                <strong>{candidate.action}</strong>
                                {candidate.sizing !== null ? <small>{formatCandidateValue(candidate.sizing)} BB</small> : null}
                                {selected ? <em>Chosen</em> : null}
                              </span>
                              <span className="recommendation-candidate-values">
                                {candidate.ev !== null ? <strong>EV {formatCandidateValue(candidate.ev)} BB</strong> : null}
                                {candidate.frequency !== null ? <small>{Math.round(candidate.frequency * 100)}% frequency</small> : null}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>

          <div className="review-actions">
            <button type="button" onClick={onApprove} disabled={!canApprove || busy} aria-label="Approve state">
              <Check size={15} aria-hidden="true" />
              Approve
            </button>
            <button type="button" className="secondary-button" onClick={onRecommend} disabled={!canRecommend || busy} aria-label="Request recommendation">
              <Play size={14} aria-hidden="true" />
              Recommend
            </button>
            <button type="button" className="ghost-button icon-action" onClick={resetToParser} disabled={!job?.parser_result || busy} title="Reset to parser" aria-label="Reset to parser">
              <RefreshCcw size={14} aria-hidden="true" />
            </button>
          </div>
        </section>
      </section>

      {queueProgress ? (
        <section className="processing-backdrop">
          <div className="processing-dialog" role="dialog" aria-modal="true" aria-labelledby="processing-dialog-title">
            <div className="processing-header">
              <div>
                <h2 id="processing-dialog-title">{queueProgress.aborting ? "Stopping import" : "Processing queue"}</h2>
                <p>
                  {queueProgress.currentIndex > 0 ? `Screenshot ${queueProgress.currentIndex} of ${queueProgress.total}` : `Preparing ${queueProgress.total} screenshots`}
                </p>
              </div>
              <strong>{queueProgressPercent}%</strong>
            </div>

            <div className="processing-progress" aria-hidden="true">
              <span style={{ width: `${queueProgressPercent}%` }} />
            </div>

            <div className="processing-current">
              <span>{queueProgress.aborting ? "Discarding unprocessed screenshots" : "Current screenshot"}</span>
              <strong>{queueProgress.currentFile || "Preparing queue"}</strong>
            </div>

            <div className="processing-stats">
              <div>
                <strong>{queueProgress.completed}</strong>
                <span>processed</span>
              </div>
              <div>
                <strong>{queueProgress.failed}</strong>
                <span>attention</span>
              </div>
              <div>
                <strong>{queueProgress.skipped}</strong>
                <span>discarded</span>
              </div>
            </div>

            <button type="button" className="secondary-button" onClick={onAbortQueue} disabled={queueProgress.aborting}>
              <Square size={13} aria-hidden="true" />
              Abort and discard unprocessed
            </button>
          </div>
        </section>
      ) : null}

      {automationDialogOpen ? (
        <section className="modal-backdrop">
          <div className="automation-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-dialog-title">
            <div className="automation-dialog-header">
              <div>
                <h2 id="automation-dialog-title">Configure automation</h2>
                <p>Applies to every frame you capture or upload</p>
              </div>
              <button type="button" className="dialog-icon-button" onClick={() => setAutomationDialogOpen(false)} aria-label="Close automation settings">
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="automation-dialog-body">
              <AutomationToggle
                title="Auto-approve parsed state"
                description="Skip manual review when confidence is high"
                checked={automationApprove}
                onToggle={() => updateAutomationApprove(!automationApprove)}
              />
              <AutomationToggle
                title="Auto-request recommendation"
                description="Generate a play the moment a frame is approved"
                checked={automationRecommend}
                disabled={!automationApprove}
                onToggle={() => setAutomationRecommend((current) => !current)}
              />
              <AutomationToggle
                title="Allow parser warnings"
                description="Continue automation even when fields are flagged"
                checked={automationAllowWarnings}
                disabled={!automationApprove}
                onToggle={() => setAutomationAllowWarnings((current) => !current)}
              />
            </div>

            <div className="automation-dialog-footer">
              <span>
                Master automation is <strong>{automationEnabled ? "On" : "Off"}</strong>
              </span>
              <button type="button" className="secondary-button" onClick={() => setAutomationDialogOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {infoDialogOpen ? (
        <section className="modal-backdrop">
          <div className="automation-dialog info-dialog" role="dialog" aria-modal="true" aria-labelledby="info-dialog-title">
            <div className="automation-dialog-header">
              <div>
                <h2 id="info-dialog-title">About Poker Training Analyzer</h2>
                <p>Post-hand Texas Hold&apos;em review and training</p>
              </div>
              <button type="button" className="dialog-icon-button" onClick={() => setInfoDialogOpen(false)} aria-label="Close app information">
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="info-dialog-body">
              <section className="info-dialog-section active-engines">
                <h3>Currently active</h3>
                {activeParserProvider && activeRecommendationProvider ? (
                  <div className="info-provider-grid">
                    <div>
                      <small>Recognition</small>
                      <strong>{providerLabel(activeParserProvider)}</strong>
                    </div>
                    <div>
                      <small>Recommendation</small>
                      <strong>{providerLabel(activeRecommendationProvider)}</strong>
                    </div>
                  </div>
                ) : (
                  <p>{systemInfoLoading ? "Reading backend configuration..." : "Active engine details are unavailable."}</p>
                )}
              </section>
              <section className="info-dialog-section">
                <h3>Recognition</h3>
                <p>OCR and computer vision read the cards, board, pot, bets, stacks, and table state from each screenshot. Confidence scores identify fields that need review.</p>
              </section>
              <section className="info-dialog-section">
                <h3>Recommendations</h3>
                <p>The configured engine analyzes approved hand state and compares available actions. Preflop uses a position-aware training chart, the postflop engine solves supported heads-up game trees, and ambiguous spots use the range/EV fallback.</p>
              </section>
              <section className="info-dialog-section">
                <h3>Training scope</h3>
                <p>Designed for post-hand study. It does not place bets or interact directly with a poker client.</p>
              </section>
            </div>

            <div className="automation-dialog-footer info-dialog-footer">
              <button type="button" className="secondary-button" onClick={() => setInfoDialogOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {trainingDialogOpen ? (
        <section className="modal-backdrop">
          <div className="automation-dialog training-progress-dialog" role="dialog" aria-modal="true" aria-labelledby="training-progress-title">
            <div className="automation-dialog-header">
              <div>
                <h2 id="training-progress-title">Training progress</h2>
                <p>Your locked answers compared with completed recommendations</p>
              </div>
              <button
                type="button"
                className="dialog-icon-button"
                onClick={() => setTrainingDialogOpen(false)}
                disabled={trainingReviewJobId !== null}
                aria-label="Close training progress"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="training-progress-body">
              {trainingProgressLoading ? (
                <div className="training-progress-empty">Reading reviewed decisions...</div>
              ) : trainingProgress && trainingProgress.reviewed_hands > 0 ? (
                <>
                  <div
                    className={`training-progress-summary${trainingProgress.ev_compared_hands > 0 ? " has-ev" : ""}`}
                    aria-label="Training progress summary"
                  >
                    <div>
                      <strong>{trainingProgress.reviewed_hands}</strong>
                      <span>reviewed</span>
                    </div>
                    <div>
                      <strong>{benchmarkPercent(trainingProgress.action_accuracy)}</strong>
                      <span>action match</span>
                    </div>
                    <div>
                      <strong>{benchmarkPercent(trainingProgress.exact_accuracy)}</strong>
                      <span>exact line</span>
                    </div>
                    {trainingProgress.ev_compared_hands > 0 && trainingProgress.average_ev_loss_bb !== null ? (
                      <div>
                        <strong>{formatEvLossBb(trainingProgress.average_ev_loss_bb)}</strong>
                        <span>avg EV loss</span>
                      </div>
                    ) : null}
                    <div>
                      <strong className={trainingProgress.needs_review_hands > 0 ? "needs-review" : ""}>
                        {trainingProgress.needs_review_hands}
                      </strong>
                      <span>needs review</span>
                    </div>
                  </div>

                  <section className="training-progress-section" aria-labelledby="training-streets-title">
                    <div className="training-section-heading">
                      <h3 id="training-streets-title">By street</h3>
                      {trainingProgressView === "recent" && trainingFocus ? (
                        <button
                          type="button"
                          className="training-focus-action"
                          onClick={() => void focusTrainingReviewStreet(trainingFocus.street)}
                          disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                          title={trainingFocus.reason}
                          aria-label={`Focus ${trainingFocus.street} reviews: ${trainingFocus.reason}`}
                        >
                          <Target size={13} aria-hidden="true" />
                          Focus {trainingFocus.street}
                        </button>
                      ) : null}
                    </div>
                    <table className="training-street-table">
                      <thead>
                        <tr>
                          <th>Street</th>
                          <th>Hands</th>
                          <th>Action</th>
                          <th>Exact</th>
                          <th>Avg EV loss</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trainingProgress.street_summaries.map((summary) => (
                          <tr key={summary.street}>
                            <th>{summary.street}</th>
                            <td>{summary.reviewed_hands}</td>
                            <td>{benchmarkPercent(summary.action_accuracy)}</td>
                            <td>{benchmarkPercent(summary.exact_accuracy)}</td>
                            <td>
                              {summary.ev_compared_hands > 0 && summary.average_ev_loss_bb !== null
                                ? formatEvLossBb(summary.average_ev_loss_bb)
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>

                  <section className="training-progress-section recent-training-section" aria-labelledby="training-hands-title">
                    <div className="training-review-heading">
                      <h3 id="training-hands-title">
                        {trainingProgressView === "review" ? "Needs review" : "Recent decisions"}
                      </h3>
                      <div className="training-review-controls">
                        {trainingProgressView === "review" ? (
                          <>
                            <label className="training-review-order">
                              <span>Order</span>
                              <select
                                aria-label="Review order"
                                value={trainingReviewOrder}
                                onChange={(event) => void updateTrainingReviewQueue(
                                  event.target.value as TrainingReviewOrder,
                                  trainingReviewStreet,
                                )}
                                disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                              >
                                <option value="recent">Newest</option>
                                <option value="ev_loss">EV loss</option>
                              </select>
                            </label>
                            <label className="training-review-order">
                              <span>Street</span>
                              <select
                                aria-label="Review street"
                                value={trainingReviewStreet}
                                onChange={(event) => void updateTrainingReviewQueue(
                                  trainingReviewOrder,
                                  event.target.value as TrainingReviewStreet,
                                )}
                                disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                              >
                                <option value="all">All</option>
                                <option value="preflop">Preflop</option>
                                <option value="flop">Flop</option>
                                <option value="turn">Turn</option>
                                <option value="river">River</option>
                              </select>
                            </label>
                          </>
                        ) : null}
                        <div className="training-view-switch" role="group" aria-label="Training decision view">
                          <button
                            type="button"
                            className={trainingProgressView === "recent" ? "active" : ""}
                            onClick={() => setTrainingProgressView("recent")}
                            aria-pressed={trainingProgressView === "recent"}
                          >
                            Recent
                          </button>
                          <button
                            type="button"
                            className={trainingProgressView === "review" ? "active" : ""}
                            onClick={() => setTrainingProgressView("review")}
                            aria-pressed={trainingProgressView === "review"}
                          >
                            Needs review {trainingProgress.needs_review_hands}
                          </button>
                        </div>
                      </div>
                    </div>
                    {visibleTrainingHands.length > 0 ? (
                      <div className="recent-training-list">
                        {visibleTrainingHands.map((hand) => (
                          <div className="recent-training-row" key={hand.job_id}>
                            <button
                              className="recent-training-open"
                              type="button"
                              onClick={() => void reviewTrainingHand(hand.job_id)}
                              disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                              aria-label={`Open ${hand.original_filename} training review`}
                            >
                              <span className="recent-training-hand">
                                <strong>{hand.hero_cards.length > 0 ? hand.hero_cards.map(cardToDisplay).join(" ") : "Unknown cards"}</strong>
                                <small>{hand.street ?? "Unknown street"} · {hand.original_filename}</small>
                              </span>
                              <span className="recent-training-lines">
                                <small>You: {trainingDecisionLabel(hand.decision_action, hand.decision_sizing)}</small>
                                <small>Solver: {trainingDecisionLabel(hand.recommended_action, hand.recommended_sizing)}</small>
                                {typeof hand.ev_loss_bb === "number" ? (
                                  <small className="recent-training-ev">
                                    EV loss: {formatEvLossBb(hand.ev_loss_bb)}
                                  </small>
                                ) : null}
                              </span>
                              <em className={hand.reviewed_at ? "reviewed" : hand.outcome}>
                                {hand.reviewed_at ? "Reviewed" : trainingOutcomeLabel(hand.outcome)}
                              </em>
                              <Eye size={15} aria-hidden="true" />
                            </button>
                            {hand.reviewed_at && hand.outcome !== "match" && hand.outcome !== "mixed" ? (
                              <button
                                className="recent-training-reopen"
                                type="button"
                                onClick={() => void reopenTrainingReviewFromProgress(hand.job_id)}
                                disabled={trainingReviewJobId !== null || busy}
                                aria-label={`Reopen ${hand.original_filename} training review`}
                                title="Reopen review"
                              >
                                <RefreshCcw size={14} aria-hidden="true" />
                              </button>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="training-review-empty">No action or sizing differences need review.</div>
                    )}
                  </section>
                </>
              ) : (
                <div className="training-progress-empty">
                  Lock an answer before revealing a recommendation to start tracking progress.
                </div>
              )}
            </div>

            <div className="automation-dialog-footer training-progress-footer">
              <span>{reviewQueueStatus}</span>
              {nextReviewHand ? (
                <button
                  type="button"
                  onClick={() => void reviewTrainingHand(nextReviewHand.job_id)}
                  disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                >
                  <Eye size={14} aria-hidden="true" />
                  {trainingReviewOrder === "ev_loss" && typeof nextReviewHand.ev_loss_bb === "number"
                    ? "Review highest loss"
                    : "Review next"}
                </button>
              ) : null}
              <button
                type="button"
                className="secondary-button"
                onClick={() => setTrainingDialogOpen(false)}
                disabled={trainingReviewJobId !== null}
              >
                Done
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {benchmarkDialogOpen ? (
        <section className="modal-backdrop">
          <div className="automation-dialog benchmark-dialog" role="dialog" aria-modal="true" aria-labelledby="benchmark-dialog-title">
            <div className="automation-dialog-header">
              <div>
                <h2 id="benchmark-dialog-title">Parser benchmark</h2>
                <p>
                  {benchmarkReport
                    ? `${providerLabel(benchmarkReport.parser_provider)} · ${benchmarkReport.layout_profile}`
                    : "Ground-truth recognition checks"}
                </p>
              </div>
              <button
                type="button"
                className="dialog-icon-button"
                onClick={() => setBenchmarkDialogOpen(false)}
                disabled={benchmarkRunning || benchmarkUpdating || benchmarkImporting || benchmarkReportLoading || benchmarkReviewJobId !== null}
                aria-label="Close parser benchmark"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="benchmark-dialog-body">
              <button
                type="button"
                className="automation-toggle-row benchmark-ground-truth"
                role="switch"
                aria-checked={job?.benchmark_included ?? false}
                onClick={toggleBenchmarkInclusion}
                disabled={
                  (!job?.approved_state && !job?.benchmark_included) ||
                  busy ||
                  benchmarkLoading ||
                  benchmarkReportLoading ||
                  benchmarkRunning ||
                  benchmarkUpdating ||
                  benchmarkImporting ||
                  benchmarkReviewJobId !== null
                }
              >
                <span>
                  <strong>Use current hand as ground truth</strong>
                  <small>
                    {job?.approved_state
                      ? job.original_filename
                      : job?.benchmark_included
                        ? "Previous approved state remains included"
                        : "Approve the current hand first"}
                  </small>
                </span>
                <span className={job?.benchmark_included ? "switch-control active" : "switch-control"} aria-hidden="true">
                  <span />
                </span>
              </button>

              {benchmarkLoading ? (
                <div className="benchmark-empty">Reading benchmark results...</div>
              ) : benchmarkReport ? (
                <>
                  <div className="benchmark-report-toolbar">
                    <label>
                      <span>Report</span>
                      <select
                        aria-label="Benchmark report"
                        value={benchmarkReport.id}
                        onChange={(event) => void selectBenchmarkReport(event.target.value)}
                        disabled={benchmarkReportLoading || benchmarkRunning || benchmarkUpdating || benchmarkImporting || benchmarkReviewJobId !== null || busy}
                      >
                        {recentBenchmarkReports.map((summary) => (
                          <option key={summary.id} value={summary.id}>
                            {benchmarkReportOption(summary, benchmarkOverview?.latest_report?.id)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {benchmarkAccuracyDelta !== null ? (
                      <strong className={benchmarkAccuracyDelta < 0 ? "negative" : ""}>
                        {benchmarkAccuracyDelta > 0 ? "+" : ""}{benchmarkAccuracyDelta} pts vs previous
                      </strong>
                    ) : (
                      <span>No comparable earlier run</span>
                    )}
                  </div>
                  <div className="benchmark-summary" aria-label="Benchmark summary">
                    <div>
                      <strong>{benchmarkReport.total_cases}</strong>
                      <span>cases</span>
                    </div>
                    <div>
                      <strong>{benchmarkReport.correct_fields}/{benchmarkReport.evaluated_fields}</strong>
                      <span>fields correct</span>
                    </div>
                    <div>
                      <strong>{benchmarkPercent(benchmarkReport.accuracy)}</strong>
                      <span>accuracy</span>
                    </div>
                    <div>
                      <strong className={benchmarkReport.failed_cases > 0 ? "needs-review" : ""}>{benchmarkReport.failed_cases}</strong>
                      <span>failed</span>
                    </div>
                  </div>

                  <div className="benchmark-results-scroll">
                    <section className="benchmark-result-section" aria-labelledby="benchmark-fields-title">
                      <h3 id="benchmark-fields-title">Field accuracy</h3>
                      <div className="benchmark-field-list">
                        {benchmarkReport.field_metrics.map((metric) => {
                          const previousMetric = previousBenchmarkFieldMetric(metric, previousBenchmarkReport);
                          const fieldDelta = previousMetric
                            ? benchmarkPointChange(metric.accuracy, previousMetric.accuracy)
                            : null;
                          const trendLabel = previousBenchmarkReport?.field_metrics?.length
                            ? fieldDelta === null
                              ? "New"
                              : `${fieldDelta > 0 ? "+" : ""}${fieldDelta} pts`
                            : null;
                          return (
                            <div key={metric.field} className={trendLabel ? "has-trend" : undefined}>
                              <span>{benchmarkFieldLabel(metric.field)}</span>
                              <small>{metric.correct}/{metric.total}</small>
                              <strong>{benchmarkPercent(metric.accuracy)}</strong>
                              {trendLabel ? (
                                <small
                                  className={`benchmark-field-trend${fieldDelta !== null && fieldDelta < 0 ? " negative" : ""}`}
                                  aria-label={`${benchmarkFieldLabel(metric.field)} change ${trendLabel}`}
                                >
                                  {trendLabel}
                                </small>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </section>
                    <section className="benchmark-result-section" aria-labelledby="benchmark-cases-title">
                      <h3 id="benchmark-cases-title">Cases</h3>
                      <div className="benchmark-case-list">
                        {benchmarkReport.cases.map((benchmarkCase) => {
                          const expanded = expandedBenchmarkCaseId === benchmarkCase.job_id;
                          const mismatches = benchmarkCase.comparisons.filter((comparison) => !comparison.matched);
                          const detailId = `benchmark-case-${benchmarkCase.job_id}`;
                          return (
                            <div key={benchmarkCase.job_id} className="benchmark-case-row">
                              <button
                                type="button"
                                className="benchmark-case-summary"
                                onClick={() => setExpandedBenchmarkCaseId((current) => (current === benchmarkCase.job_id ? null : benchmarkCase.job_id))}
                                aria-expanded={expanded}
                                aria-controls={detailId}
                                aria-label={`Toggle ${benchmarkCase.original_filename} benchmark details`}
                              >
                                <span>
                                  <strong>{benchmarkCase.original_filename}</strong>
                                  <small>{benchmarkCase.error ?? benchmarkMismatchLabel(benchmarkCase.comparisons)}</small>
                                </span>
                                <strong className={benchmarkCase.status === "error" || mismatches.length > 0 ? "needs-review" : ""}>
                                  {benchmarkCase.status === "error" ? "Error" : benchmarkPercent(benchmarkCase.accuracy)}
                                </strong>
                                <ChevronDown size={15} aria-hidden="true" />
                              </button>
                              {expanded ? (
                                <div id={detailId} className="benchmark-case-details">
                                  {benchmarkCase.error ? <p className="benchmark-case-error">{benchmarkCase.error}</p> : null}
                                  {mismatches.length > 0 ? (
                                    <div className="benchmark-mismatch-list">
                                      {mismatches.map((comparison) => (
                                        <div key={comparison.field}>
                                          <strong>{benchmarkFieldLabel(comparison.field)}</strong>
                                          <span>
                                            <small>Expected</small>
                                            <code>{benchmarkComparisonValue(comparison.expected)}</code>
                                          </span>
                                          <span>
                                            <small>Detected</small>
                                            <code>{benchmarkComparisonValue(comparison.detected)}</code>
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : benchmarkCase.error ? null : (
                                    <p className="benchmark-case-matched">Every labeled field matched the approved state.</p>
                                  )}
                                  <div className="benchmark-case-actions">
                                    <button
                                      type="button"
                                      className="secondary-button"
                                      onClick={() => void reviewBenchmarkCase(benchmarkCase.job_id)}
                                      disabled={benchmarkRunning || benchmarkUpdating || benchmarkImporting || benchmarkReportLoading || benchmarkReviewJobId !== null || busy}
                                    >
                                      <Eye size={14} aria-hidden="true" />
                                      {benchmarkReviewJobId === benchmarkCase.job_id ? "Opening..." : "Review hand"}
                                    </button>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  </div>
                </>
              ) : (
                <div className="benchmark-empty">No benchmark has been run yet.</div>
              )}
            </div>

            <div className="automation-dialog-footer benchmark-dialog-footer">
              <span>
                <strong>{benchmarkOverview?.included_cases ?? 0}</strong> ground-truth {benchmarkOverview?.included_cases === 1 ? "hand" : "hands"}
              </span>
              <button
                type="button"
                className="secondary-button benchmark-dataset-action"
                onClick={() => benchmarkDatasetInputRef.current?.click()}
                disabled={benchmarkOperationsLocked}
                aria-label="Import dataset"
                title="Import dataset"
              >
                <Upload size={14} aria-hidden="true" />
                <span>{benchmarkImporting ? "Importing..." : "Import dataset"}</span>
              </button>
              <input
                ref={benchmarkDatasetInputRef}
                className="sr-only"
                type="file"
                accept=".zip,application/zip"
                aria-label="Parser dataset ZIP"
                disabled={benchmarkOperationsLocked}
                onChange={(event) => void onBenchmarkDatasetImport(event)}
              />
              <a
                className={`secondary-button benchmark-dataset-action benchmark-export-button${benchmarkDatasetExportDisabled ? " disabled" : ""}`}
                href={benchmarkDatasetUrl()}
                download
                aria-label="Export dataset"
                title="Export dataset"
                aria-disabled={benchmarkDatasetExportDisabled}
                tabIndex={benchmarkDatasetExportDisabled ? -1 : undefined}
                onClick={(event) => {
                  if (benchmarkDatasetExportDisabled) {
                    event.preventDefault();
                  }
                }}
              >
                <Download size={14} aria-hidden="true" />
                <span>Export dataset</span>
              </a>
              <button
                type="button"
                onClick={onRunBenchmark}
                disabled={
                  benchmarkLoading ||
                  benchmarkReportLoading ||
                  benchmarkRunning ||
                  benchmarkUpdating ||
                  benchmarkImporting ||
                  benchmarkReviewJobId !== null ||
                  busy ||
                  (benchmarkOverview?.included_cases ?? 0) === 0
                }
              >
                <Play size={14} aria-hidden="true" />
                {benchmarkRunning ? "Running..." : "Run benchmark"}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setBenchmarkDialogOpen(false)}
                disabled={benchmarkRunning || benchmarkUpdating || benchmarkImporting || benchmarkReportLoading || benchmarkReviewJobId !== null}
              >
                Done
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function AutomationToggle({
  title,
  description,
  checked,
  disabled = false,
  onToggle,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className="automation-toggle-row" role="switch" aria-checked={checked} onClick={onToggle} disabled={disabled}>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className={checked ? "switch-control active" : "switch-control"} aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

function Field({ label, confidence, confidenceValue, children }: { label: string; confidence: string; confidenceValue?: number; children: ReactNode }) {
  const percent = confidencePercent(confidenceValue);
  const tone = confidenceTone(confidenceValue);
  return (
    <label className={`field field-${tone}`}>
      <span className="field-header">
        <span>{label}</span>
        <small>{confidence}</small>
      </span>
      {children}
      <span className="confidence-track" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
    </label>
  );
}

function StatusPill({ status }: { status: JobRecord["status"] }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}
