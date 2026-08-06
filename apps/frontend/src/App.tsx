import { AlertTriangle, Archive, ArrowRight, Camera, Check, ChevronDown, Download, Eye, FlaskConical, Info, Pencil, Play, Plus, RefreshCcw, Search, Settings, Square, Target, Upload, X } from "lucide-react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";

import "./App.css";
import {
  ApiResponseError,
  applicationBackupUrl,
  approveState,
  archiveJobs,
  benchmarkDatasetUrl,
  completeTrainingReview,
  getBenchmarkDatasetImport,
  getBenchmarkOverview,
  getBenchmarkReport,
  getHistory,
  getJob,
  getProcessingJobs,
  getSystemInfo,
  getTrainingProgress,
  imageUrl,
  importBenchmarkDataset,
  recordTrainingDecision,
  reopenTrainingReview,
  requestRecommendation,
  restoreApplicationBackup,
  runParserBenchmark,
  setBenchmarkInclusion,
  trainingLessonsExportUrl,
  uploadScreenshot,
} from "./api";
import type {
  BenchmarkDatasetImportResult,
  BenchmarkFieldComparison,
  BenchmarkFieldMetric,
  BenchmarkOverview,
  BenchmarkReport,
  BenchmarkReportSummary,
  CanonicalState,
  Card,
  DetectedState,
  FacingAction,
  JobHistory,
  JobQueue,
  JobRecord,
  PreflopAction,
  PreflopActionType,
  PreflopPosition,
  PostflopAction,
  PostflopActionType,
  PostflopActor,
  Rank,
  RecommendationAction,
  RecommendationResult,
  Street,
  Suit,
  SystemInfo,
  TrainingCertainty,
  TrainingCertaintyFilter,
  TrainingOutcome,
  TrainingPositionFilter,
  TrainingProgress,
  TrainingReviewCertainty,
  TrainingReviewCertaintyFilter,
  TrainingReviewDifference,
  TrainingReviewOrder,
  TrainingReviewStreet,
  TrainingSolverFilter,
  TrainingStreetFilter,
  TrainingTrend,
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
const SUITS = new Set<string>(Object.keys(CODE_BY_SUIT));
const STREETS = new Set<string>(["preflop", "flop", "turn", "river"]);
const FACING_ACTIONS = new Set<string>(["bet", "raise"]);
const TRAINING_ACTIONS: readonly RecommendationAction[] = ["fold", "check", "call", "bet", "raise"];
const TRAINING_CERTAINTIES: readonly TrainingCertainty[] = ["low", "medium", "high"];
const MIN_SUPPORTED_FREQUENCY = 0.05;
const SIZING_MATCH_TOLERANCE = 0.01;
const MAX_TRAINING_REVIEW_NOTE_LENGTH = 1000;
const PERSISTED_JOB_ID_PATTERN = /^[0-9a-f]{32}$/;
const LOCAL_UPLOAD_RECONCILIATION_WINDOW_MS = 2 * 60 * 1000;
const HISTORY_SESSION_SYNC_KEY = "poker-training-history-synced";
const PROCESSING_QUEUE_SESSION_SYNC_KEY = "poker-training-processing-synced";
const HISTORY_MUTATION_LEASE_KEY = "poker-training-history-mutation-v1";
const PROCESSING_MUTATION_LEASE_KEY = "poker-training-processing-mutation-v1";
const PERSISTED_MUTATION_LEASE_MS = 30 * 1000;

const EMPTY_STATE: CanonicalState = {
  hero_cards: [],
  board_cards: [],
  pot_size: null,
  current_bet: null,
  hero_stack: null,
  opponent_stack: null,
  effective_stack: null,
  players_in_hand: null,
  opponents_at_current_bet: null,
  opponent_wager: null,
  opponent_commitment_total: null,
  hero_position: null,
  opponent_position: null,
  preflop_opener_position: null,
  preflop_open_size: null,
  preflop_action_history: [],
  street: null,
  facing_action: null,
  postflop_action_history: [],
  action_context: null,
  user_approved: false,
};

type StreetOption = "" | Street;
type FacingActionOption = "" | FacingAction;
type TrainingActionOption = "" | RecommendationAction;
type TrainingCertaintyOption = "" | TrainingCertainty;
type ShareMode = "browser" | "window" | "monitor";
type InputMode = "live" | "upload";
type PersistedJobMutationScope = "processing" | "history";
type MutationLeaseBase = {
  ownerId: string;
  expiresAt: number;
};
type JobMutationExpectation =
  | {
    kind: "approval";
    approvedStateKey: string;
  }
  | {
    kind: "training-decision";
    action: RecommendationAction;
    sizing: number | null;
    certainty: TrainingCertainty | null;
  }
  | {
    kind: "training-review";
    reviewed: boolean;
    note: string | null;
  }
  | {
    kind: "benchmark-inclusion";
    included: boolean;
  };
type JobMutationLease = MutationLeaseBase & {
  kind: "job";
  jobId: string;
  baselineUpdatedAt: string;
  expectsRemoval: boolean;
  expectedRecommendationRequestId: string | null;
  expectedMutation: JobMutationExpectation | null;
};
type ProjectionMutationTarget = "failed" | "parsed" | "approved" | "recommended";
type ProjectionMutationLease = MutationLeaseBase & {
  kind: "projection";
  baselineJobIds: string[];
  expectedRemovalJobIds: string[];
  benchmarkImportRequestId: string | null;
  benchmarkImportReceiptObserved: boolean;
  expectedUploads: Array<{
    requestId: string;
    target: ProjectionMutationTarget;
    recommendationRequestId: string | null;
  }>;
};
type ArchiveMutationLease = MutationLeaseBase & {
  kind: "archive";
  jobIds: string[];
  baselineUpdatedAt: Record<string, string>;
  confirmationJobIds: string[];
};
type PersistedMutationLease =
  | JobMutationLease
  | ProjectionMutationLease
  | ArchiveMutationLease;
type ProcessingQueueRestore = JobQueue & {
  revalidatedLeaseJob?: JobRecord;
  revalidatedArchiveJobs?: JobRecord[];
};
type TrainingProgressView = "recent" | "review" | "lessons";
type TrainingFocus = { street: Street; reason: string };
type TrainingCertaintyFocus = {
  certainty: TrainingReviewCertainty;
  label: string;
  reason: string;
};
type TrainingPositionFocus = {
  filter: TrainingPositionFilter;
  label: string;
  reason: string;
};
type TrainingActionDifferenceFocus = {
  difference: TrainingReviewDifference;
  label: string;
  reason: string;
};

const TRAINING_STREET_ORDER: readonly Street[] = ["preflop", "flop", "turn", "river"];
const TRAINING_CERTAINTY_FOCUS_ORDER: readonly TrainingCertainty[] = ["high", "medium", "low"];
const TRAINING_POSITION_FOCUS_ORDER: readonly string[] = [
  "UTG",
  "HJ",
  "CO",
  "BTN",
  "SB",
  "BB",
  "IP",
  "OOP",
];

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
  opponent_stack: string;
  effective_stack: string;
  players_in_hand: string;
  opponents_at_current_bet: string;
  opponent_wager: string;
  opponent_commitment_total: string;
  hero_position: string;
  opponent_position: string;
  preflop_opener_position: string;
  preflop_open_size: string;
  preflop_action_history: PreflopActionForm[];
  street: StreetOption;
  facing_action: FacingActionOption;
  postflop_action_history: PostflopActionForm[];
  action_context: string;
}

interface PostflopActionForm {
  actor: PostflopActor;
  action: PostflopActionType;
  amount: string;
}

interface PreflopActionForm {
  actor: PreflopPosition;
  action: PreflopActionType;
  amount: string;
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
  foldEquity: number | null;
  perOpponentFoldEquity: number | null;
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

interface AutomationSettings {
  enabled: boolean;
  autoApprove: boolean;
  autoRecommend: boolean;
  allowWarnings: boolean;
}

const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  enabled: true,
  autoApprove: true,
  autoRecommend: true,
  allowWarnings: false,
};
const AUTOMATION_SETTINGS_STORAGE_KEY = "poker-training-automation-v1";
const PROCESSING_QUEUE_STORAGE_KEY = "poker-training-processing-v1";
const PROCESSING_QUEUE_TOTAL_STORAGE_KEY = "poker-training-processing-total-v1";
const PROCESSING_QUEUE_CACHE_LIMIT = 100;
const PROCESSING_QUEUE_SNAPSHOT_RETRY_LIMIT = 3;
const PROCESSING_QUEUE_REVALIDATION_INTERVAL_MS = 250;
const PROCESSING_CACHE_FUTURE_SKEW_MS = 5 * 60 * 1000;
const HISTORY_STORAGE_KEY = "poker-training-history-v1";
const HISTORY_TOTAL_STORAGE_KEY = "poker-training-history-total-v1";
const HISTORY_CACHE_LIMIT = 24;
const HISTORY_SEARCH_PAGE_LIMIT = 100;
const HISTORY_SNAPSHOT_RETRY_LIMIT = 3;
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

const PREFLOP_POSITION_ALIASES: Readonly<Record<string, PreflopPosition>> = {
  utg: "utg",
  "under the gun": "utg",
  ep: "utg",
  "early position": "utg",
  hj: "hijack",
  hijack: "hijack",
  mp: "hijack",
  "middle position": "hijack",
  co: "cutoff",
  cutoff: "cutoff",
  btn: "button",
  button: "button",
  dealer: "button",
  sb: "small_blind",
  "small blind": "small_blind",
  bb: "big_blind",
  "big blind": "big_blind",
};

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
  const committedOpponents = metadataNumber(raw.opponents_at_current_bet);
  const opponentWager = metadataNumber(raw.opponent_wager);
  const opponentCommitmentTotal = metadataNumber(raw.opponent_commitment_total);
  const heroWager = metadataNumber(raw.hero_wager);
  const hasCommittedOpponentCount = committedOpponents !== null
    && Number.isInteger(committedOpponents)
    && committedOpponents > 0;
  const hasOpponentWager = opponentWager !== null && opponentWager > 0;
  const hasDistinctCommitmentTotal = opponentCommitmentTotal !== null
    && opponentCommitmentTotal > 0
    && (
      !hasCommittedOpponentCount
      || !hasOpponentWager
      || Math.abs(
        opponentCommitmentTotal - committedOpponents * opponentWager
      ) > 0.001
    );
  const hasHeroWager = heroWager !== null && heroWager > 0;
  if (
    hasCommittedOpponentCount
    || hasOpponentWager
    || hasDistinctCommitmentTotal
    || hasHeroWager
  ) {
    const context = [];
    if (hasCommittedOpponentCount) {
      context.push(`${committedOpponents} ${committedOpponents === 1 ? "opponent" : "opponents"}`);
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
      label: hasCommittedOpponentCount || hasOpponentWager
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

  const limpReraiseResponsePolicy = metadataLabel(raw.limp_reraise_response_policy);
  if (limpReraiseResponsePolicy) {
    details.push({ label: "Limp-reraise policy", value: limpReraiseResponsePolicy });
  }

  const limpRaiseFraction = metadataRatio(raw.limp_raise_fraction);
  const baseLimpRaiseFraction = metadataRatio(raw.base_limp_raise_fraction);
  if (limpRaiseFraction !== null) {
    let rangeValue = formatEvidenceRatio(limpRaiseFraction);
    if (
      baseLimpRaiseFraction !== null
      && Math.abs(baseLimpRaiseFraction - limpRaiseFraction) >= 0.0005
    ) {
      rangeValue += ` (base ${formatEvidenceRatio(baseLimpRaiseFraction)})`;
    }
    details.push({ label: "Isolation range", value: rangeValue });
  }

  const targetLimpRaiseSize = metadataNumber(raw.target_limp_raise_size);
  if (targetLimpRaiseSize !== null && targetLimpRaiseSize > 0) {
    details.push({ label: "Isolation target", value: formatEvidenceBb(targetLimpRaiseSize) });
  }

  const multiLimpResponsePolicy = metadataLabel(raw.multi_limp_response_policy);
  if (multiLimpResponsePolicy) {
    details.push({ label: "Multi-limp policy", value: multiLimpResponsePolicy });
  }

  const multiLimpRaiseFraction = metadataRatio(raw.multi_limp_raise_fraction);
  const baseMultiLimpRaiseFraction = metadataRatio(raw.base_multi_limp_raise_fraction);
  if (multiLimpRaiseFraction !== null) {
    let rangeValue = formatEvidenceRatio(multiLimpRaiseFraction);
    if (
      baseMultiLimpRaiseFraction !== null
      && Math.abs(baseMultiLimpRaiseFraction - multiLimpRaiseFraction) >= 0.0005
    ) {
      rangeValue += ` (base ${formatEvidenceRatio(baseMultiLimpRaiseFraction)})`;
    }
    details.push({ label: "Multi-limp isolation range", value: rangeValue });
  }

  const targetMultiLimpRaiseSize = metadataNumber(raw.target_multi_limp_raise_size);
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
        baseOpenerOpenFraction !== null
        && Math.abs(baseOpenerOpenFraction - openerOpenFraction) >= 0.0005
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
    const ratio = threeBetRatio !== null && threeBetRatio > 0
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
    const ratio = fourBetRatio !== null && fourBetRatio > 0
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
    continueFraction !== null
    || reraiseFraction !== null
    || fourBetFraction !== null
    || fiveBetFraction !== null
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
    if (baseOpenFraction !== null && Math.abs(baseOpenFraction - openFraction) >= 0.0005) {
      openValue += ` (base ${formatEvidenceRatio(baseOpenFraction)})`;
    }
    details.push({ label: "Opening range", value: openValue });
  }

  const targetOpenSize = metadataNumber(raw.target_open_size);
  if (targetOpenSize !== null && targetOpenSize >= 0) {
    details.push({ label: "Open target", value: formatEvidenceBb(targetOpenSize) });
  }

  const maximumRaiseTotal = metadataNumber(
    raw.maximum_five_bet_total
      ?? raw.maximum_four_bet_total
      ?? raw.maximum_reraise_total
      ?? raw.maximum_multi_limp_raise_total
      ?? raw.maximum_limp_raise_total,
  );
  if (maximumRaiseTotal !== null && maximumRaiseTotal >= 0) {
    details.push({ label: "All-in cap", value: formatEvidenceBb(maximumRaiseTotal) });
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
      const foldEquity = metadataRatio(record?.fold_equity);
      const perOpponentFoldEquity = metadataRatio(record?.per_opponent_fold_equity);
      const rawSizing = metadataNumber(record?.sizing);
      if (!record || !action || (ev === null && frequency === null)) {
        return [];
      }
      return [{
        action,
        sizing: rawSizing !== null && rawSizing >= 0 ? rawSizing : null,
        ev,
        frequency,
        foldEquity,
        perOpponentFoldEquity,
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

function trainingCertaintyLabel(certainty: TrainingCertainty): string {
  return `${certainty.slice(0, 1).toUpperCase()}${certainty.slice(1)}`;
}

function trainingStreetLabel(street: Street): string {
  return `${street.slice(0, 1).toUpperCase()}${street.slice(1)}`;
}

function formatEvLossBb(value: number): string {
  return `${formatCandidateValue(value)} BB`;
}

function formatAccuracyDelta(value: number): string {
  const points = Math.round(value * 100);
  return `${points > 0 ? "+" : ""}${points} pts`;
}

function formatEvLossDeltaBb(value: number): string {
  return `${value > 0 ? "+" : ""}${formatCandidateValue(value)} BB`;
}

function trainingTrendTone(
  delta: number,
  lowerIsBetter = false,
): "improving" | "declining" | "neutral" {
  const improvement = lowerIsBetter ? -delta : delta;
  if (improvement > 0) {
    return "improving";
  }
  if (improvement < 0) {
    return "declining";
  }
  return "neutral";
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
  const validActions = new Set<RecommendationAction>();
  const sizingBounds = new Map<RecommendationAction, { maximum: number; minimum: number }>();
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
    validActions.add(candidateAction);
    if (candidateSizing.value !== null) {
      const bounds = sizingBounds.get(candidateAction);
      sizingBounds.set(candidateAction, {
        maximum: bounds === undefined
          ? candidateSizing.value
          : Math.max(bounds.maximum, candidateSizing.value),
        minimum: bounds === undefined
          ? candidateSizing.value
          : Math.min(bounds.minimum, candidateSizing.value),
      });
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
  const hasDistinctLines = validActions.size > 1 || Array.from(
    sizingBounds.values(),
  ).some((bounds) => !trainingSizingMatches(bounds.minimum, bounds.maximum));
  if (
    bestEv === null
    || decisionEv === null
    || !recommendationLineFound
    || !hasDistinctLines
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
    return sizing !== null && sizing > 0
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

function decimalNumberParts(value: number): { coefficient: bigint; scale: number } {
  const [mantissa, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number.parseInt(exponentText, 10);
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

function decimalCoefficientAtScale(
  value: { coefficient: bigint; scale: number },
  scale: number,
): bigint {
  return value.coefficient * (10n ** BigInt(scale - value.scale));
}

function trainingSizingMatches(left: number | null, right: number | null): boolean {
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
  const difference = leftCoefficient >= rightCoefficient
    ? leftCoefficient - rightCoefficient
    : rightCoefficient - leftCoefficient;
  return difference < toleranceCoefficient;
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
  if (!Number.isFinite(sizing) || sizing <= 0) {
    return { sizing: null, error: "Enter a valid positive decision size" };
  }
  return { sizing, error: null };
}

function benchmarkFieldLabel(field: string): string {
  return field.replace(/_/g, " ");
}

function benchmarkPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

type SolverPerformanceSummary = {
  action_accuracy?: number;
  exact_accuracy?: number;
  ev_compared_hands?: number;
  average_ev_loss_bb?: number | null;
  trend?: TrainingTrend | null;
};

function trainingTrendWindowLabel(trend: TrainingTrend): string {
  const hands = trend.window_hands === 1 ? "hand" : "hands";
  return `Last ${trend.window_hands} ${hands} vs previous ${trend.window_hands}`;
}

function accessiblePointDelta(value: number): string {
  const points = Math.round(value * 100);
  const unit = Math.abs(points) === 1 ? "percentage point" : "percentage points";
  return `${points > 0 ? "+" : ""}${points} ${unit}`;
}

function solverPerformanceAccessibleLabel(
  summary: SolverPerformanceSummary,
): string | null {
  if (
    typeof summary.action_accuracy !== "number"
    || typeof summary.exact_accuracy !== "number"
  ) {
    return null;
  }
  const evLoss = (summary.ev_compared_hands ?? 0) > 0
    && typeof summary.average_ev_loss_bb === "number"
    ? `average EV loss ${formatEvLossBb(summary.average_ev_loss_bb)}`
    : "EV loss ungraded";
  const labels = [
    `Action accuracy ${benchmarkPercent(summary.action_accuracy)}`,
    `exact-line accuracy ${benchmarkPercent(summary.exact_accuracy)}`,
    evLoss,
  ];
  if (summary.trend) {
    const changes = [
      `action accuracy change ${accessiblePointDelta(summary.trend.action_accuracy_delta)}`,
      `exact-line accuracy change ${accessiblePointDelta(summary.trend.exact_accuracy_delta)}`,
    ];
    if (summary.trend.average_ev_loss_delta_bb !== null) {
      changes.push(
        `average EV loss change ${formatEvLossDeltaBb(summary.trend.average_ev_loss_delta_bb)}`,
      );
    }
    labels.push(`${trainingTrendWindowLabel(summary.trend)}: ${changes.join(", ")}`);
  }
  return labels.join("; ");
}

function SolverPerformance({
  summary,
}: {
  summary: SolverPerformanceSummary;
}) {
  if (
    typeof summary.action_accuracy !== "number"
    || typeof summary.exact_accuracy !== "number"
  ) {
    return null;
  }
  const trendTitle = summary.trend
    ? trainingTrendWindowLabel(summary.trend)
    : undefined;
  const evLoss = (summary.ev_compared_hands ?? 0) > 0
    && typeof summary.average_ev_loss_bb === "number"
    ? `${formatEvLossBb(summary.average_ev_loss_bb)} EV loss`
    : "EV ungraded";
  return (
    <small className="training-solver-performance" aria-hidden="true">
      <span>
        Action {benchmarkPercent(summary.action_accuracy)}
        {summary.trend ? (
          <em
            className={trainingTrendTone(summary.trend.action_accuracy_delta)}
            title={trendTitle}
          >
            {formatAccuracyDelta(summary.trend.action_accuracy_delta)}
          </em>
        ) : null}
      </span>
      <span>
        Exact {benchmarkPercent(summary.exact_accuracy)}
        {summary.trend ? (
          <em
            className={trainingTrendTone(summary.trend.exact_accuracy_delta)}
            title={trendTitle}
          >
            {formatAccuracyDelta(summary.trend.exact_accuracy_delta)}
          </em>
        ) : null}
      </span>
      <span>
        {evLoss}
        {summary.trend?.average_ev_loss_delta_bb !== null
          && summary.trend?.average_ev_loss_delta_bb !== undefined ? (
            <em
              className={trainingTrendTone(
                summary.trend.average_ev_loss_delta_bb,
                true,
              )}
              title={trendTitle}
            >
              {formatEvLossDeltaBb(summary.trend.average_ev_loss_delta_bb)}
            </em>
          ) : null}
      </span>
    </small>
  );
}

function performanceTrendAccessibleLabel(trend: TrainingTrend): string {
  const changes = [
    `action accuracy change ${accessiblePointDelta(trend.action_accuracy_delta)}`,
    `exact-line accuracy change ${accessiblePointDelta(trend.exact_accuracy_delta)}`,
  ];
  if (trend.average_ev_loss_delta_bb !== null) {
    changes.push(
      `average EV loss change ${formatEvLossDeltaBb(trend.average_ev_loss_delta_bb)}`,
    );
  }
  return `${trainingTrendWindowLabel(trend)}: ${changes.join(", ")}`;
}

function PerformanceTrend({
  trend,
  hiddenFromAssistiveTechnology = false,
}: {
  trend: TrainingTrend;
  hiddenFromAssistiveTechnology?: boolean;
}) {
  const title = trainingTrendWindowLabel(trend);
  return (
    <small
      className="training-summary-trend"
      aria-hidden={hiddenFromAssistiveTechnology || undefined}
      aria-label={
        hiddenFromAssistiveTechnology
          ? undefined
          : performanceTrendAccessibleLabel(trend)
      }
    >
      <span>{title}</span>
      <strong>
        Action
        <em className={trainingTrendTone(trend.action_accuracy_delta)}>
          {formatAccuracyDelta(trend.action_accuracy_delta)}
        </em>
      </strong>
      <strong>
        Exact
        <em className={trainingTrendTone(trend.exact_accuracy_delta)}>
          {formatAccuracyDelta(trend.exact_accuracy_delta)}
        </em>
      </strong>
      {trend.average_ev_loss_delta_bb !== null ? (
        <strong>
          EV loss
          <em className={trainingTrendTone(trend.average_ev_loss_delta_bb, true)}>
            {formatEvLossDeltaBb(trend.average_ev_loss_delta_bb)}
          </em>
        </strong>
      ) : null}
    </small>
  );
}

function solverStreetCountsLabel(counts: Partial<Record<Street, number>>): string {
  return TRAINING_STREET_ORDER
    .filter((street) => (counts[street] ?? 0) > 0)
    .map((street) => `${street.charAt(0).toUpperCase()} ${counts[street]}`)
    .join(" · ");
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

function sameTrainingPositionFilter(
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

function trainingReviewQueueStatus(
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
    const lessonCount = progress?.lesson_count ?? progress?.lesson_hands?.length ?? 0;
    const lessonMatchingHands = progress?.lesson_matching_hands
      ?? progress?.lesson_hands?.length
      ?? 0;
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
    const matchingHands = progress?.recent_matching_hands
      ?? progress?.recent_hands.length
      ?? 0;
    const visibleHands = progress?.recent_hands.length ?? 0;
    const kindLabel = solverFilter.kind === "route"
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
    const matchingHands = progress?.recent_matching_hands
      ?? progress?.recent_hands.length
      ?? 0;
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
    const matchingHands = progress?.recent_matching_hands
      ?? progress?.recent_hands.length
      ?? 0;
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
    const matchingHands = progress?.recent_matching_hands
      ?? progress?.recent_hands.length
      ?? 0;
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

  const matchingHands = progress.review_queue_hands ?? progress.review_queue.length;
  const actionScope = difference
    ? `for ${trainingDecisionLabel(difference.decision_action, null)} to ${trainingDecisionLabel(difference.recommended_action, null)}`
    : null;
  const streetScope = street === "all" ? "across all streets" : `on ${street}`;
  const certaintyScope = certainty === "all"
    ? null
    : certainty === "unrated"
      ? "without a certainty rating"
      : `with ${certainty} certainty`;
  const positionScope = reviewPosition?.kind === "position"
    ? `at ${reviewPosition.label}`
    : reviewPosition?.kind === "unpositioned"
      ? "without a recorded position"
      : null;
  const scope = [
    actionScope,
    streetScope,
    certaintyScope,
    positionScope,
  ].filter(Boolean).join(" ");
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

function suggestedCertaintyFocus(
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

    const pendingDifference = (right.needs_review_hands ?? 0) - (left.needs_review_hands ?? 0);
    if (pendingDifference !== 0) {
      return pendingDifference;
    }
    return TRAINING_CERTAINTY_FOCUS_ORDER.indexOf(left.certainty)
      - TRAINING_CERTAINTY_FOCUS_ORDER.indexOf(right.certainty);
  });
  const focus = ranked[0];
  if (!focus) {
    return null;
  }
  return {
    certainty: focus.certainty,
    label: trainingCertaintyLabel(focus.certainty),
    reason: usesEvLoss && focus.average_ev_loss_bb !== null
      ? `Highest average EV loss: ${formatEvLossBb(focus.average_ev_loss_bb)}`
      : `Lowest action match: ${benchmarkPercent(focus.action_accuracy)}`,
  };
}

function suggestedPositionFocus(
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

    const pendingDifference = (right.needs_review_hands ?? 0) - (left.needs_review_hands ?? 0);
    if (pendingDifference !== 0) {
      return pendingDifference;
    }
    const leftOrder = TRAINING_POSITION_FOCUS_ORDER.indexOf(left.position);
    const rightOrder = TRAINING_POSITION_FOCUS_ORDER.indexOf(right.position);
    return (leftOrder < 0 ? TRAINING_POSITION_FOCUS_ORDER.length : leftOrder)
      - (rightOrder < 0 ? TRAINING_POSITION_FOCUS_ORDER.length : rightOrder)
      || left.position.localeCompare(right.position);
  });
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
    reason: usesEvLoss && focus.average_ev_loss_bb !== null
      ? `Highest average EV loss: ${formatEvLossBb(focus.average_ev_loss_bb)}`
      : `Lowest action match: ${benchmarkPercent(focus.action_accuracy)}`,
  };
}

function suggestedActionDifferenceFocus(
  progress: TrainingProgress,
): TrainingActionDifferenceFocus | null {
  const candidates = (progress.action_differences ?? []).filter(
    (difference) => difference.needs_review_hands > 0,
  );
  if (candidates.length === 0) {
    return null;
  }

  const evCandidates = candidates.filter(
    (difference) => difference.ev_compared_hands > 0
      && difference.average_ev_loss_bb !== null,
  );
  const usesEvLoss = evCandidates.length > 0;
  const ranked = [...(usesEvLoss ? evCandidates : candidates)].sort((left, right) => {
    if (usesEvLoss) {
      const evDifference = (right.average_ev_loss_bb ?? 0) - (left.average_ev_loss_bb ?? 0);
      if (evDifference !== 0) {
        return evDifference;
      }
    }

    const pendingDifference = right.needs_review_hands - left.needs_review_hands;
    if (pendingDifference !== 0) {
      return pendingDifference;
    }
    const handDifference = right.hands - left.hands;
    if (handDifference !== 0) {
      return handDifference;
    }
    const decisionDifference = TRAINING_ACTIONS.indexOf(left.decision_action)
      - TRAINING_ACTIONS.indexOf(right.decision_action);
    return decisionDifference !== 0
      ? decisionDifference
      : TRAINING_ACTIONS.indexOf(left.recommended_action)
        - TRAINING_ACTIONS.indexOf(right.recommended_action);
  });
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
    reason: usesEvLoss && focus.average_ev_loss_bb !== null
      ? `Highest average EV loss: ${formatEvLossBb(focus.average_ev_loss_bb)}`
      : `Largest backlog: ${focus.needs_review_hands} ${focus.needs_review_hands === 1 ? "hand needs" : "hands need"} review`,
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

function normalizePreflopPosition(value: string | null | undefined): PreflopPosition | null {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase().replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return PREFLOP_POSITION_ALIASES[normalized] ?? null;
}

function requiresOpponentPosition(state: {
  street: StreetOption | null;
  players_in_hand: number | string | null;
  hero_position: string | null | undefined;
}): boolean {
  if (
    state.street === null
    || state.street === ""
    || state.street === "preflop"
    || Number(state.players_in_hand) !== 2
  ) {
    return false;
  }
  const normalizedHeroPosition = (state.hero_position ?? "")
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ![
    "ip",
    "in position",
    "oop",
    "out of position",
    "button",
    "btn",
    "dealer",
  ].includes(normalizedHeroPosition);
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
    return value.length > 0
      ? value.map((item) => benchmarkActionValue(item) ?? String(item)).join("; ")
      : "None";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function benchmarkActionValue(value: unknown): string | null {
  return benchmarkPreflopActionValue(value) ?? benchmarkPostflopActionValue(value);
}

function benchmarkPreflopActionValue(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (
    !PREFLOP_POSITIONS.some((position) => position.value === item.actor)
    || (item.action !== "call" && item.action !== "raise")
    || typeof item.amount !== "number"
    || !Number.isFinite(item.amount)
  ) {
    return null;
  }
  const actor = PREFLOP_POSITIONS.find((position) => position.value === item.actor)?.label;
  const action = item.action === "raise" ? "raise to" : "call";
  return `${actor} ${action} ${item.amount} BB`;
}

function benchmarkPostflopActionValue(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (
    (item.actor !== "oop" && item.actor !== "ip")
    || (item.action !== "check" && item.action !== "bet" && item.action !== "raise")
  ) {
    return null;
  }
  const actor = item.actor.toUpperCase();
  if (item.action === "check") {
    return `${actor} check`;
  }
  if (typeof item.amount !== "number" || !Number.isFinite(item.amount)) {
    return null;
  }
  const action = item.action === "raise" ? "raise to" : "bet";
  return `${actor} ${action} ${item.amount} BB`;
}

function benchmarkMismatchLabel(comparisons: BenchmarkFieldComparison[]): string {
  const mismatchCount = comparisons.filter((comparison) => !comparison.matched).length;
  if (mismatchCount === 0) {
    return "All labeled fields matched";
  }
  return `${mismatchCount} ${mismatchCount === 1 ? "mismatch" : "mismatches"}`;
}

function readAutomationSettings(): AutomationSettings {
  if (typeof window === "undefined") {
    return DEFAULT_AUTOMATION_SETTINGS;
  }
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(AUTOMATION_SETTINGS_STORAGE_KEY) ?? "null",
    ) as Partial<AutomationSettings> | null;
    if (
      parsed === null
      || typeof parsed !== "object"
      || typeof parsed.enabled !== "boolean"
      || typeof parsed.autoApprove !== "boolean"
      || typeof parsed.autoRecommend !== "boolean"
      || typeof parsed.allowWarnings !== "boolean"
    ) {
      return DEFAULT_AUTOMATION_SETTINGS;
    }
    return {
      enabled: parsed.enabled,
      autoApprove: parsed.autoApprove,
      autoRecommend: parsed.autoApprove && parsed.autoRecommend,
      allowWarnings: parsed.allowWarnings,
    };
  } catch {
    return DEFAULT_AUTOMATION_SETTINGS;
  }
}

function writeAutomationSettings(settings: AutomationSettings): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      AUTOMATION_SETTINGS_STORAGE_KEY,
      JSON.stringify(settings),
    );
  } catch {
    // Browser storage is optional; the current session keeps the chosen settings.
  }
}

function isCachedCard(value: unknown): value is Card {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const card = value as Partial<Card>;
  return typeof card.rank === "string"
    && RANKS.has(card.rank)
    && typeof card.suit === "string"
    && SUITS.has(card.suit);
}

function isNullableCachedNumber(
  value: unknown,
  minimum: number,
  minimumInclusive = true,
): value is number | null {
  return value === null
    || (
      typeof value === "number"
      && Number.isFinite(value)
      && (minimumInclusive ? value >= minimum : value > minimum)
    );
}

function isNullableCachedString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isCachedPostflopAction(value: unknown): value is PostflopAction {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const action = value as Partial<PostflopAction>;
  return (action.actor === "oop" || action.actor === "ip")
    && (action.action === "check" || action.action === "bet" || action.action === "raise")
    && (
      action.action === "check"
        ? action.amount === null
        : typeof action.amount === "number" && Number.isFinite(action.amount) && action.amount > 0
    );
}

function isCachedPreflopAction(value: unknown): value is PreflopAction {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const action = value as Partial<PreflopAction>;
  return PREFLOP_POSITIONS.some((position) => position.value === action.actor)
    && (action.action === "call" || action.action === "raise")
    && typeof action.amount === "number"
    && Number.isFinite(action.amount)
    && action.amount > 0;
}

function isCachedDetectedState(value: unknown): value is DetectedState {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const state = value as Partial<DetectedState>;
  if (
    !Array.isArray(state.hero_cards)
    || !state.hero_cards.every(isCachedCard)
    || state.hero_cards.length > 2
    || !Array.isArray(state.board_cards)
    || !state.board_cards.every(isCachedCard)
    || state.board_cards.length > 5
  ) {
    return false;
  }
  const cardCodes = [...state.hero_cards, ...state.board_cards]
    .map((card) => `${card.rank}:${card.suit}`);
  return new Set(cardCodes).size === cardCodes.length
    && isNullableCachedNumber(state.pot_size, 0)
    && isNullableCachedNumber(state.current_bet, 0)
    && isNullableCachedNumber(state.hero_stack, 0)
    && (
      state.opponent_stack === undefined
      || isNullableCachedNumber(state.opponent_stack, 0)
    )
    && isNullableCachedNumber(state.effective_stack, 0)
    && (
      state.players_in_hand === null
      || (
        typeof state.players_in_hand === "number"
        && Number.isInteger(state.players_in_hand)
        && state.players_in_hand >= 1
      )
    )
    && (
      state.opponents_at_current_bet === undefined
      || state.opponents_at_current_bet === null
      || (
        typeof state.opponents_at_current_bet === "number"
        && Number.isInteger(state.opponents_at_current_bet)
        && state.opponents_at_current_bet >= 1
        && typeof state.current_bet === "number"
        && state.current_bet > 0
        && typeof state.players_in_hand === "number"
        && state.opponents_at_current_bet < state.players_in_hand
      )
    )
    && (
      state.opponent_wager === undefined
      || state.opponent_wager === null
      || (
        typeof state.opponent_wager === "number"
        && Number.isFinite(state.opponent_wager)
        && state.opponent_wager > 0
        && typeof state.current_bet === "number"
        && state.current_bet > 0
        && state.opponent_wager >= state.current_bet
      )
    )
    && (
      state.opponent_commitment_total === undefined
      || state.opponent_commitment_total === null
      || (
        typeof state.opponent_commitment_total === "number"
        && Number.isFinite(state.opponent_commitment_total)
        && state.opponent_commitment_total > 0
        && (
          typeof state.pot_size !== "number"
          || state.opponent_commitment_total <= state.pot_size + 0.000001
        )
        && (
          typeof state.opponent_wager !== "number"
          || state.opponent_commitment_total + 0.000001 >= state.opponent_wager
            * (
              typeof state.opponents_at_current_bet === "number"
                ? state.opponents_at_current_bet
                : 1
            )
        )
      )
    )
    && isNullableCachedString(state.hero_position)
    && (
      state.opponent_position === undefined
      || isNullableCachedString(state.opponent_position)
    )
    && isNullableCachedString(state.preflop_opener_position)
    && isNullableCachedNumber(state.preflop_open_size, 0, false)
    && (
      state.preflop_action_history === undefined
      || (
        Array.isArray(state.preflop_action_history)
        && state.preflop_action_history.length <= 8
        && state.preflop_action_history.every(isCachedPreflopAction)
      )
    )
    && (
      state.street === null
      || (typeof state.street === "string" && STREETS.has(state.street))
    )
    && (
      state.facing_action === null
      || (
        typeof state.facing_action === "string"
        && FACING_ACTIONS.has(state.facing_action)
      )
    )
    && (
      state.postflop_action_history === undefined
      || (
        Array.isArray(state.postflop_action_history)
        && state.postflop_action_history.length <= 8
        && state.postflop_action_history.every(isCachedPostflopAction)
      )
    )
    && isNullableCachedString(state.action_context);
}

function isCachedCanonicalState(value: unknown): value is CanonicalState {
  return isCachedDetectedState(value)
    && typeof (value as Partial<CanonicalState>).user_approved === "boolean";
}

function isCachedActionSizing(action: unknown, sizing: unknown): boolean {
  if (action === "bet" || action === "raise") {
    return sizing === null
      || (
        typeof sizing === "number"
        && Number.isFinite(sizing)
        && sizing > 0
      );
  }
  return sizing === null;
}

function isCachedRecommendation(value: unknown): value is RecommendationResult {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const recommendation = value as Record<string, unknown>;
  return typeof recommendation.action === "string"
    && TRAINING_ACTIONS.some((action) => action === recommendation.action)
    && isCachedActionSizing(recommendation.action, recommendation.sizing)
    && typeof recommendation.confidence === "number"
    && Number.isFinite(recommendation.confidence)
    && recommendation.confidence >= 0
    && recommendation.confidence <= 1
    && typeof recommendation.explanation === "string"
    && recommendation.raw !== null
    && typeof recommendation.raw === "object"
    && !Array.isArray(recommendation.raw);
}

function isCachedTrainingDecision(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const decision = value as Record<string, unknown>;
  return typeof decision.action === "string"
    && TRAINING_ACTIONS.some((action) => action === decision.action)
    && isCachedActionSizing(decision.action, decision.sizing)
    && (
      decision.certainty === undefined
      || decision.certainty === null
      || (
        typeof decision.certainty === "string"
        && TRAINING_CERTAINTIES.some(
          (certainty) => certainty === decision.certainty,
        )
      )
    )
    && typeof decision.recorded_at === "string";
}

function isCachedParserResult(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value !== "object") {
    return false;
  }
  const parserResult = value as Record<string, unknown>;
  return isCachedDetectedState(parserResult.state)
    && parserResult.confidences !== null
    && typeof parserResult.confidences === "object"
    && !Array.isArray(parserResult.confidences)
    && Object.values(parserResult.confidences).every((confidence) =>
      typeof confidence === "number"
      && Number.isFinite(confidence)
      && confidence >= 0
      && confidence <= 1,
    )
    && Array.isArray(parserResult.warnings)
    && parserResult.warnings.every((warning) => typeof warning === "string")
    && parserResult.raw !== null
    && typeof parserResult.raw === "object"
    && !Array.isArray(parserResult.raw);
}

function isCachedJobRecord(value: unknown): value is JobRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<JobRecord>;
  return typeof candidate.id === "string"
    && PERSISTED_JOB_ID_PATTERN.test(candidate.id)
    && (
      candidate.status === "created"
      || candidate.status === "parsed"
      || candidate.status === "approved"
      || candidate.status === "recommended"
      || candidate.status === "error"
    )
    && typeof candidate.original_filename === "string"
    && typeof candidate.image_filename === "string"
    && typeof candidate.parser_provider === "string"
    && typeof candidate.recommendation_provider === "string"
    && isCachedParserResult(candidate.parser_result)
    && (
      candidate.approved_state === null
      || isCachedCanonicalState(candidate.approved_state)
    )
    && (
      candidate.recommendation === null
      || isCachedRecommendation(candidate.recommendation)
    )
    && typeof candidate.recommendation_pending === "boolean"
    && (
      candidate.recommendation_request_id === undefined
      || candidate.recommendation_request_id === null
      || typeof candidate.recommendation_request_id === "string"
    )
    && (
      candidate.training_decision === null
      || isCachedTrainingDecision(candidate.training_decision)
    )
    && (
      candidate.training_reviewed_at === null
      || typeof candidate.training_reviewed_at === "string"
    )
    && (
      candidate.training_review_note === null
      || typeof candidate.training_review_note === "string"
    )
    && (
      candidate.error === null
      || typeof candidate.error === "string"
    )
    && typeof candidate.benchmark_included === "boolean"
    && isSafeProcessingCacheTimestamp(candidate.created_at)
    && isSafeProcessingCacheTimestamp(candidate.updated_at)
    && candidate.archived_at === null;
}

function isSafeProcessingCacheTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && timestamp <= Date.now() + PROCESSING_CACHE_FUTURE_SKEW_MS;
}

function isPristineBenchmarkImport(job: JobRecord): boolean {
  return job.benchmark_included
    && job.status === "approved"
    && !job.recommendation_pending
    && job.parser_result === null
    && job.approved_state !== null
    && job.training_decision === null
    && job.recommendation === null
    && job.recommendation_request_id === null
    && job.training_reviewed_at === null
    && job.training_review_note === null
    && job.error === null;
}

function readProcessingQueue(): JobRecord[] | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(PROCESSING_QUEUE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed
      .filter(isCachedJobRecord)
      .filter((job) => !isPristineBenchmarkImport(job));
  } catch {
    return null;
  }
}

function processingJobsForCache(jobs: JobRecord[]): JobRecord[] {
  return jobs.filter((job) =>
    PERSISTED_JOB_ID_PATTERN.test(job.id)
    && job.archived_at === null
    && !isPristineBenchmarkImport(job),
  );
}

function readStoredProcessingQueueTotal(): number | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(
      PROCESSING_QUEUE_TOTAL_STORAGE_KEY,
    );
    if (raw === null) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeProcessingQueue(
  jobs: JobRecord[],
  preserveKnownTotal = false,
  authoritativeJobIds: ReadonlySet<string> = new Set(),
): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const cachedJobsById = new Map(
    (readProcessingQueue() ?? []).map((job) => [job.id, job]),
  );
  const processingJobs = processingJobsForCache(jobs).map((job) => {
    if (authoritativeJobIds.has(job.id)) {
      return job;
    }
    const cachedJob = cachedJobsById.get(job.id);
    return cachedJob ? newerJob(job, cachedJob) : job;
  });
  const storedTotal = preserveKnownTotal
    ? readStoredProcessingQueueTotal()
    : null;
  const total = storedTotal === null
    ? processingJobs.length
    : Math.max(storedTotal, processingJobs.length);
  try {
    const serializedJobs = JSON.stringify(
      processingJobs.slice(0, PROCESSING_QUEUE_CACHE_LIMIT),
    );
    if (window.localStorage.getItem(PROCESSING_QUEUE_STORAGE_KEY) !== serializedJobs) {
      window.localStorage.setItem(PROCESSING_QUEUE_STORAGE_KEY, serializedJobs);
    }
    const serializedTotal = String(total);
    if (window.localStorage.getItem(PROCESSING_QUEUE_TOTAL_STORAGE_KEY) !== serializedTotal) {
      window.localStorage.setItem(
        PROCESSING_QUEUE_TOTAL_STORAGE_KEY,
        serializedTotal,
      );
    }
    return true;
  } catch {
    markProcessingQueueSessionUnsynced();
    return false;
  }
}

function readCachedProcessingQueueTotal(
  cachedJobs: JobRecord[] | null,
): number | null {
  if (cachedJobs === null || typeof window === "undefined") {
    return null;
  }
  const storedTotal = readStoredProcessingQueueTotal();
  if (
    storedTotal === null
    || cachedJobs.length !== storedTotal
    || cachedJobs.length > PROCESSING_QUEUE_CACHE_LIMIT
  ) {
    return null;
  }
  return storedTotal;
}

function mutationLeaseStorageKey(
  scope: PersistedJobMutationScope,
): string {
  return scope === "processing"
    ? PROCESSING_MUTATION_LEASE_KEY
    : HISTORY_MUTATION_LEASE_KEY;
}

function mutationLeaseOwnerId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function projectionMutationTargetReached(
  job: JobRecord,
  target: ProjectionMutationTarget,
  recommendationRequestId: string | null,
): boolean {
  if (target === "failed") {
    return false;
  }
  if (job.status === "error") {
    return true;
  }
  if (target === "recommended") {
    return job.recommendation !== null
      || (
        recommendationRequestId !== null
        && job.recommendation_request_id === recommendationRequestId
        && !job.recommendation_pending
      );
  }
  if (target === "approved") {
    return job.approved_state !== null;
  }
  return job.parser_result !== null
    || job.approved_state !== null
    || job.recommendation !== null;
}

function projectionMutationLeaseTargetReached(
  lease: ProjectionMutationLease,
  job: JobRecord,
): boolean | null {
  const expectedUpload = lease.expectedUploads.find(
    (candidate) => job.upload_request_id === candidate.requestId,
  );
  return expectedUpload
    ? projectionMutationTargetReached(
        job,
        expectedUpload.target,
        expectedUpload.recommendationRequestId,
      )
    : null;
}

function jobMutationExpectationReached(
  job: JobRecord,
  expectation: JobMutationExpectation,
): boolean {
  if (expectation.kind === "approval") {
    return job.approved_state !== null
      && job.approved_state.user_approved
      && approvalKey(job.approved_state) === expectation.approvedStateKey
      && job.training_decision === null
      && job.recommendation === null
      && job.training_reviewed_at === null
      && job.training_review_note === null
      && job.status === "approved"
      && job.error === null;
  }
  if (expectation.kind === "training-decision") {
    return job.training_decision !== null
      && job.training_decision.action === expectation.action
      && job.training_decision.sizing === expectation.sizing
      && (job.training_decision.certainty ?? null) === expectation.certainty
      && job.recommendation === null
      && job.training_reviewed_at === null
      && job.training_review_note === null
      && job.status === "approved"
      && job.error === null;
  }
  if (expectation.kind === "training-review") {
    return expectation.reviewed
      ? (
        job.training_reviewed_at !== null
        && job.training_review_note === expectation.note
      )
      : job.training_reviewed_at === null;
  }
  return job.benchmark_included === expectation.included;
}

function projectionMutationTarget(
  runAutomation: boolean,
  autoApprove: boolean,
  autoRecommend: boolean,
): ProjectionMutationTarget {
  if (!runAutomation || !autoApprove) {
    return "parsed";
  }
  return autoRecommend ? "recommended" : "approved";
}

function createMutationRequestId(): string {
  return globalThis.crypto.randomUUID();
}

function mutationLeaseJobIds(
  lease: PersistedMutationLease | null,
): string[] {
  if (lease === null || lease.kind === "projection") {
    return [];
  }
  return lease.kind === "job" ? [lease.jobId] : lease.jobIds;
}

function mutationLeaseTargetsJob(
  lease: PersistedMutationLease | null,
  jobId: string,
): boolean {
  return mutationLeaseJobIds(lease).includes(jobId);
}

function matchingArchiveLeaseTargets(
  first: PersistedMutationLease | null,
  second: PersistedMutationLease | null,
): boolean {
  if (first?.kind !== "archive" || second?.kind !== "archive") {
    return false;
  }
  const secondIds = new Set(second.jobIds);
  return first.jobIds.length === secondIds.size
    && first.jobIds.every((jobId) => secondIds.has(jobId));
}

function benchmarkImportLeaseRequestId(
  first: PersistedMutationLease | null,
  second: PersistedMutationLease | null,
): string | null {
  const requestIds = [first, second].flatMap((lease) =>
    lease?.kind === "projection" && lease.benchmarkImportRequestId !== null
      ? [lease.benchmarkImportRequestId]
      : []
  );
  return requestIds.length > 0 && requestIds.every(
    (requestId) => requestId === requestIds[0],
  )
    ? requestIds[0]
    : null;
}

function isBenchmarkImportLease(
  lease: PersistedMutationLease | null,
  requestId: string,
): lease is ProjectionMutationLease {
  return lease?.kind === "projection"
    && lease.benchmarkImportRequestId === requestId;
}

function isJobMutationExpectation(
  value: unknown,
): value is JobMutationExpectation {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const expectation = value as Record<string, unknown>;
  if (expectation.kind === "approval") {
    return typeof expectation.approvedStateKey === "string";
  }
  if (expectation.kind === "training-decision") {
    return typeof expectation.action === "string"
      && TRAINING_ACTIONS.some((action) => action === expectation.action)
      && isCachedActionSizing(expectation.action, expectation.sizing)
      && (
        expectation.certainty === null
        || (
          typeof expectation.certainty === "string"
          && TRAINING_CERTAINTIES.some(
            (certainty) => certainty === expectation.certainty,
          )
        )
      );
  }
  if (expectation.kind === "training-review") {
    return typeof expectation.reviewed === "boolean"
      && (
        expectation.note === null
        || typeof expectation.note === "string"
      );
  }
  return expectation.kind === "benchmark-inclusion"
    && typeof expectation.included === "boolean";
}

function readPersistedMutationLease(
  scope: PersistedJobMutationScope,
): PersistedMutationLease | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(mutationLeaseStorageKey(scope));
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.kind === undefined
      && typeof parsed.jobId === "string"
      && typeof parsed.baselineUpdatedAt === "string"
    ) {
      parsed.kind = "job";
    }
    if (parsed.kind === "job" && parsed.expectsRemoval === undefined) {
      parsed.expectsRemoval = false;
    }
    if (
      parsed.kind === "job"
      && parsed.expectedRecommendationRequestId === undefined
    ) {
      parsed.expectedRecommendationRequestId = null;
    }
    if (parsed.kind === "job" && parsed.expectedMutation === undefined) {
      parsed.expectedMutation = null;
    }
    if (parsed.kind === "archive" && parsed.confirmationJobIds === undefined) {
      parsed.confirmationJobIds = scope === "processing" ? parsed.jobIds : [];
    }
    if (
      parsed.kind === "projection"
      && Array.isArray(parsed.expectedUploads)
    ) {
      for (const expectedUpload of parsed.expectedUploads) {
        if (
          typeof expectedUpload === "object"
          && expectedUpload !== null
          && (expectedUpload as Record<string, unknown>)
            .recommendationRequestId === undefined
        ) {
          (expectedUpload as Record<string, unknown>)
            .recommendationRequestId = null;
        }
      }
    }
    if (
      parsed.kind === "projection"
      && parsed.benchmarkImportRequestId === undefined
    ) {
      parsed.benchmarkImportRequestId = null;
    }
    if (
      parsed.kind === "projection"
      && parsed.benchmarkImportReceiptObserved === undefined
    ) {
      parsed.benchmarkImportReceiptObserved = false;
    }
    if (
      typeof parsed.ownerId !== "string"
      || typeof parsed.expiresAt !== "number"
      || !Number.isFinite(parsed.expiresAt)
      || !["job", "projection", "archive"].includes(String(parsed.kind))
    ) {
      window.sessionStorage.removeItem(mutationLeaseStorageKey(scope));
      return null;
    }
    if (
      parsed.kind === "job"
      && (
        typeof parsed.jobId !== "string"
        || typeof parsed.baselineUpdatedAt !== "string"
        || typeof parsed.expectsRemoval !== "boolean"
        || (
          parsed.expectedRecommendationRequestId !== null
          && typeof parsed.expectedRecommendationRequestId !== "string"
        )
        || (
          parsed.expectedMutation !== null
          && !isJobMutationExpectation(parsed.expectedMutation)
        )
      )
    ) {
      window.sessionStorage.removeItem(mutationLeaseStorageKey(scope));
      return null;
    }
    if (
      parsed.kind === "projection"
      && (
        !Array.isArray(parsed.baselineJobIds)
        || !parsed.baselineJobIds.every((value) => typeof value === "string")
        || !Array.isArray(parsed.expectedRemovalJobIds)
        || !parsed.expectedRemovalJobIds.every(
          (value) =>
            typeof value === "string"
            && (parsed.baselineJobIds as unknown[]).includes(value),
        )
        || !Array.isArray(parsed.expectedUploads)
        || (
          parsed.benchmarkImportRequestId !== null
          && typeof parsed.benchmarkImportRequestId !== "string"
        )
        || typeof parsed.benchmarkImportReceiptObserved !== "boolean"
        || !parsed.expectedUploads.every((value) =>
          typeof value === "object"
          && value !== null
          && typeof (value as Record<string, unknown>).requestId === "string"
          && (
            (value as Record<string, unknown>).recommendationRequestId === null
            || typeof (value as Record<string, unknown>)
              .recommendationRequestId === "string"
          )
          && ["failed", "parsed", "approved", "recommended"].includes(String(
            (value as Record<string, unknown>).target,
          ))
        )
      )
    ) {
      window.sessionStorage.removeItem(mutationLeaseStorageKey(scope));
      return null;
    }
    if (
      parsed.kind === "archive"
      && (
        !Array.isArray(parsed.jobIds)
        || !parsed.jobIds.every((value) => typeof value === "string")
        || typeof parsed.baselineUpdatedAt !== "object"
        || parsed.baselineUpdatedAt === null
        || Array.isArray(parsed.baselineUpdatedAt)
        || !Object.values(parsed.baselineUpdatedAt).every(
          (value) => typeof value === "string",
        )
        || !parsed.jobIds.every(
          (jobId) =>
            typeof (parsed.baselineUpdatedAt as Record<string, unknown>)[jobId]
              === "string",
        )
        || !Array.isArray(parsed.confirmationJobIds)
        || !parsed.confirmationJobIds.every(
          (jobId) =>
            typeof jobId === "string"
            && (parsed.jobIds as unknown[]).includes(jobId),
        )
      )
    ) {
      window.sessionStorage.removeItem(mutationLeaseStorageKey(scope));
      return null;
    }
    return parsed as PersistedMutationLease;
  } catch {
    try {
      window.sessionStorage.removeItem(mutationLeaseStorageKey(scope));
    } catch {
      // An unavailable session store is equivalent to having no durable lease.
    }
    return null;
  }
}

function writePersistedMutationLease(
  scope: PersistedJobMutationScope,
  lease: PersistedMutationLease,
): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    window.sessionStorage.setItem(
      mutationLeaseStorageKey(scope),
      JSON.stringify(lease),
    );
    return true;
  } catch {
    return false;
  }
}

function replacePersistedMutationLease(
  scope: PersistedJobMutationScope,
  expectedLease: PersistedMutationLease,
  nextLease: PersistedMutationLease,
): boolean {
  const storedLease = readPersistedMutationLease(scope);
  if (
    storedLease === null
    || storedLease.ownerId !== expectedLease.ownerId
    || storedLease.kind !== expectedLease.kind
    || storedLease.expiresAt !== expectedLease.expiresAt
  ) {
    return false;
  }
  return writePersistedMutationLease(scope, nextLease);
}

function claimPersistedMutationLease(
  scope: PersistedJobMutationScope,
  ownerId: string,
): PersistedMutationLease | null {
  const lease = readPersistedMutationLease(scope);
  if (lease === null) {
    return null;
  }
  const claimedLease = { ...lease, ownerId };
  return writePersistedMutationLease(scope, claimedLease)
    ? claimedLease
    : null;
}

function startPersistedMutationLease(
  scope: PersistedJobMutationScope,
  ownerId: string,
  job: JobRecord,
  expectedMutation: JobMutationExpectation | null,
  expectsRemoval = false,
): PersistedMutationLease | null {
  const lease: PersistedMutationLease = {
    kind: "job",
    ownerId,
    jobId: job.id,
    baselineUpdatedAt: job.updated_at,
    expectsRemoval,
    expectedRecommendationRequestId: null,
    expectedMutation,
    expiresAt: Date.now() + PERSISTED_MUTATION_LEASE_MS,
  };
  return writePersistedMutationLease(scope, lease) ? lease : null;
}

function startProjectionMutationLease(
  scope: PersistedJobMutationScope,
  ownerId: string,
  baselineJobs: readonly JobRecord[],
  expectedUploads: ProjectionMutationLease["expectedUploads"] = [],
  expectedRemovalJobIds: readonly string[] = [],
  benchmarkImportRequestId: string | null = null,
): PersistedMutationLease | null {
  const lease: ProjectionMutationLease = {
    kind: "projection",
    ownerId,
    baselineJobIds: baselineJobs.map((job) => job.id),
    expectedRemovalJobIds: [...expectedRemovalJobIds],
    benchmarkImportRequestId,
    benchmarkImportReceiptObserved: false,
    expectedUploads: [...expectedUploads],
    expiresAt: Date.now() + PERSISTED_MUTATION_LEASE_MS,
  };
  return writePersistedMutationLease(scope, lease) ? lease : null;
}

function startArchiveMutationLease(
  scope: PersistedJobMutationScope,
  ownerId: string,
  jobs: readonly JobRecord[],
  processingJobIds: ReadonlySet<string> = new Set(),
): PersistedMutationLease | null {
  const lease: ArchiveMutationLease = {
    kind: "archive",
    ownerId,
    jobIds: jobs.map((job) => job.id),
    baselineUpdatedAt: Object.fromEntries(
      jobs.map((job) => [job.id, job.updated_at]),
    ),
    confirmationJobIds: scope === "processing"
      ? jobs
          .filter((job) => !processingJobIds.has(job.id))
          .map((job) => job.id)
      : [],
    expiresAt: Date.now() + PERSISTED_MUTATION_LEASE_MS,
  };
  return writePersistedMutationLease(scope, lease) ? lease : null;
}

function clearPersistedMutationLease(
  scope: PersistedJobMutationScope,
  ownerId: string,
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (readPersistedMutationLease(scope)?.ownerId === ownerId) {
      window.sessionStorage.removeItem(mutationLeaseStorageKey(scope));
    }
  } catch {
    // An unavailable session store already forces authoritative reloads.
  }
}

function markProcessingQueueSessionSynced(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (readPersistedMutationLease("processing") !== null) {
      window.sessionStorage.removeItem(PROCESSING_QUEUE_SESSION_SYNC_KEY);
      return;
    }
    window.sessionStorage.setItem(PROCESSING_QUEUE_SESSION_SYNC_KEY, "true");
  } catch {
    // Persisted jobs remain available when browser session storage is unavailable.
  }
}

function markProcessingQueueSessionUnsynced(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.removeItem(PROCESSING_QUEUE_SESSION_SYNC_KEY);
  } catch {
    // Blocked session storage already forces the app to reconcile on reload.
  }
}

function processingQueueSessionSynced(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.sessionStorage.getItem(
      PROCESSING_QUEUE_SESSION_SYNC_KEY,
    ) === "true";
  } catch {
    return false;
  }
}

async function getProcessingQueueExtent(): Promise<JobQueue> {
  for (
    let attempt = 0;
    attempt < PROCESSING_QUEUE_SNAPSHOT_RETRY_LIMIT;
    attempt += 1
  ) {
    const jobs: JobRecord[] = [];
    let snapshotVersion: string | null = null;
    let snapshotChanged = false;
    let total = 0;

    do {
      const page = await getProcessingJobs(jobs.length);
      if (
        snapshotVersion !== null
        && page.snapshot_version !== undefined
        && page.snapshot_version !== snapshotVersion
      ) {
        snapshotChanged = true;
        break;
      }
      snapshotVersion ??= page.snapshot_version ?? null;
      total = page.total;
      jobs.push(...page.jobs);
      if (page.jobs.length === 0) {
        break;
      }
    } while (jobs.length < total);

    if (!snapshotChanged && jobs.length >= total) {
      return {
        total,
        jobs: jobs.slice(0, total),
        snapshot_version: snapshotVersion ?? undefined,
      };
    }
  }

  throw new Error("Processing queue changed repeatedly while loading");
}

function readHistory(): HistoryItem[] | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryItem[]) : null;
  } catch {
    return null;
  }
}

function writeHistory(items: HistoryItem[]): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    window.localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify(items.slice(0, HISTORY_CACHE_LIMIT)),
    );
    return true;
  } catch {
    // Persisted history remains authoritative when the bounded browser cache is unavailable.
    markHistorySessionUnsynced();
    return false;
  }
}

function readCachedHistoryTotal(cachedHistory: HistoryItem[] | null): number | null {
  if (cachedHistory === null || typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(HISTORY_TOTAL_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = Number(raw);
    if (
      !Number.isSafeInteger(parsed)
      || parsed < 0
      || cachedHistory.length !== Math.min(parsed, HISTORY_CACHE_LIMIT)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function readHistoryTotal(): number {
  const cachedHistory = readHistory();
  return readCachedHistoryTotal(cachedHistory) ?? cachedHistory?.length ?? 0;
}

function writeHistoryTotal(total: number): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    window.localStorage.setItem(HISTORY_TOTAL_STORAGE_KEY, String(total));
    return true;
  } catch {
    // The server count remains authoritative when browser storage is unavailable.
    markHistorySessionUnsynced();
    return false;
  }
}

function markHistorySessionSynced(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (readPersistedMutationLease("history") !== null) {
      window.sessionStorage.removeItem(HISTORY_SESSION_SYNC_KEY);
      return;
    }
    window.sessionStorage.setItem(HISTORY_SESSION_SYNC_KEY, "true");
  } catch {
    // The persisted endpoint remains usable when browser storage is unavailable.
  }
}

function markHistorySessionUnsynced(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.removeItem(HISTORY_SESSION_SYNC_KEY);
  } catch {
    // A blocked session store already forces the app to fetch history on reload.
  }
}

function historySessionSynced(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.sessionStorage.getItem(HISTORY_SESSION_SYNC_KEY) === "true";
  } catch {
    return false;
  }
}

function historyItemsFromPage(page: JobHistory): HistoryItem[] {
  return page.jobs.map((job) => ({
    id: job.id,
    job,
    savedAt: job.archived_at ?? job.updated_at,
  }));
}

async function getHistorySearchExtent(
  query: string,
  loadedCount: number,
): Promise<JobHistory> {
  for (let attempt = 0; attempt < HISTORY_SNAPSHOT_RETRY_LIMIT; attempt += 1) {
    const jobs: JobRecord[] = [];
    let snapshotVersion: string | null = null;
    let snapshotChanged = false;
    let total = 0;

    do {
      const page = await getHistory(
        jobs.length,
        query,
        Math.min(HISTORY_SEARCH_PAGE_LIMIT, loadedCount - jobs.length),
      );
      if (
        snapshotVersion !== null
        && page.snapshot_version !== undefined
        && page.snapshot_version !== snapshotVersion
      ) {
        snapshotChanged = true;
        break;
      }
      snapshotVersion ??= page.snapshot_version ?? null;
      total = page.total;
      jobs.push(...page.jobs);
      if (page.jobs.length === 0) {
        break;
      }
    } while (jobs.length < Math.min(loadedCount, total));

    if (!snapshotChanged) {
      return {
        total,
        jobs: jobs.slice(0, Math.min(loadedCount, total)),
        snapshot_version: snapshotVersion ?? undefined,
      };
    }
  }

  throw new Error("Saved history changed repeatedly while loading");
}

function mergeHistoryItems(
  current: HistoryItem[],
  incoming: HistoryItem[],
): HistoryItem[] {
  const currentIds = new Set(current.map((item) => item.id));
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  return [
    ...current.map((item) => {
      const incomingItem = incomingById.get(item.id);
      return incomingItem ? newerHistoryItem(item, incomingItem) : item;
    }),
    ...incoming.filter((item) => !currentIds.has(item.id)),
  ];
}

function newerHistoryItem(
  current: HistoryItem,
  incoming: HistoryItem,
): HistoryItem {
  return newerHistoryJob(current.job, incoming.job) === current.job
    ? current
    : incoming;
}

function newerJob(current: JobRecord, incoming: JobRecord): JobRecord {
  const currentUpdatedAt = Date.parse(current.updated_at);
  const incomingUpdatedAt = Date.parse(incoming.updated_at);
  return Number.isFinite(currentUpdatedAt)
    && (!Number.isFinite(incomingUpdatedAt) || currentUpdatedAt >= incomingUpdatedAt)
    ? current
    : incoming;
}

function preserveUploadRequestId(
  incoming: JobRecord,
  current: JobRecord | undefined,
): JobRecord {
  return incoming.upload_request_id || !current?.upload_request_id
    ? incoming
    : { ...incoming, upload_request_id: current.upload_request_id };
}

function newerHistoryJob(
  current: JobRecord,
  incoming: JobRecord,
): JobRecord {
  if (current.recommendation_pending && !incoming.recommendation_pending) {
    return incoming;
  }
  return newerJob(current, incoming);
}

function localUploadMatchDistance(
  localJob: JobRecord,
  incomingJob: JobRecord,
): number | null {
  const matchingPersistedFailure = incomingJob.status === "error"
    && localJob.error !== null
    && incomingJob.error !== null
    && (
      localJob.error === incomingJob.error
      || localJob.error.endsWith(`: ${incomingJob.error}`)
    );
  const matchingPersistedSuccess = incomingJob.status === "parsed"
    || incomingJob.status === "approved";
  if (
    !localJob.id.startsWith("local-error-")
    || localJob.parser_provider !== "client"
    || localJob.status !== "error"
    || !PERSISTED_JOB_ID_PATTERN.test(incomingJob.id)
    || (!matchingPersistedFailure && !matchingPersistedSuccess)
  ) {
    return null;
  }
  if (localJob.upload_request_id) {
    return incomingJob.upload_request_id === localJob.upload_request_id ? 0 : null;
  }
  if (localJob.original_filename !== incomingJob.original_filename) {
    return null;
  }

  const localUpdatedAt = Date.parse(localJob.updated_at);
  const incomingUpdatedAt = Date.parse(incomingJob.updated_at);
  if (!Number.isFinite(localUpdatedAt) || !Number.isFinite(incomingUpdatedAt)) {
    return null;
  }
  const distance = Math.abs(localUpdatedAt - incomingUpdatedAt);
  return distance <= LOCAL_UPLOAD_RECONCILIATION_WINDOW_MS ? distance : null;
}

function isLocalUploadError(job: JobRecord): boolean {
  return job.id.startsWith("local-error-")
    && job.parser_provider === "client"
    && job.status === "error";
}

function restoredLocalUploadIds(
  current: JobRecord[],
  incoming: JobRecord[],
  currentById: Map<string, JobRecord>,
): Set<string> {
  const localErrors = current.filter(isLocalUploadError);
  const matchedIds = new Set<string>();

  for (const incomingJob of incoming) {
    if (currentById.has(incomingJob.id)) {
      continue;
    }
    let closestMatch: JobRecord | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const localJob of localErrors) {
      if (matchedIds.has(localJob.id)) {
        continue;
      }
      const distance = localUploadMatchDistance(localJob, incomingJob);
      if (distance !== null && distance < closestDistance) {
        closestMatch = localJob;
        closestDistance = distance;
      }
    }
    if (closestMatch !== null) {
      matchedIds.add(closestMatch.id);
    }
  }

  return matchedIds;
}

function reconcileProcessingJobs(
  current: JobRecord[],
  incoming: JobRecord[],
  cachedIds: Set<string>,
  removalCandidateIds: ReadonlySet<string>,
): JobRecord[] {
  const currentById = new Map(current.map((job) => [job.id, job]));
  const incomingIds = new Set(incoming.map((job) => job.id));
  const restoredUploadIds = restoredLocalUploadIds(
    current,
    incoming,
    currentById,
  );
  return [
    ...incoming,
    ...current.filter((job) => {
      if (
        job.archived_at !== null
        || isPristineBenchmarkImport(job)
      ) {
        return !incomingIds.has(job.id)
          && !removalCandidateIds.has(job.id);
      }
      return isLocalUploadError(job)
        && !cachedIds.has(job.id)
        && !incomingIds.has(job.id)
        && !removalCandidateIds.has(job.id)
        && !restoredUploadIds.has(job.id);
    }),
  ];
}

function reconcileHistoryItems(
  current: HistoryItem[],
  incoming: HistoryItem[],
): HistoryItem[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  return incoming.map((item) => {
    const currentItem = currentById.get(item.id);
    return currentItem ? newerHistoryItem(currentItem, item) : item;
  });
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

function summarizeConfidences(
  confidences: Record<string, number>,
  warnings: string[],
  state: CanonicalState | null,
) {
  const confidenceKeys: readonly string[] = state && requiresOpponentPosition(state)
    ? [...CONFIDENCE_KEYS, "opponent_position"]
    : CONFIDENCE_KEYS;
  const values = confidenceKeys.map((key) => confidences[key]).filter((value): value is number => value !== undefined);
  const detectedCount = values.length;
  const averageConfidence = detectedCount === 0 ? 0 : Math.round((values.reduce((sum, value) => sum + value, 0) / detectedCount) * 100);
  const reviewCount = values.filter((value) => value < 0.7).length + warnings.length;

  return {
    averageConfidence,
    detectedCount,
    fieldTotal: confidenceKeys.length,
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
    opponent_stack: state.opponent_stack ?? null,
    effective_stack: state.effective_stack,
    players_in_hand: state.players_in_hand,
    opponents_at_current_bet: state.opponents_at_current_bet ?? null,
    opponent_wager: state.opponent_wager ?? null,
    opponent_commitment_total: state.opponent_commitment_total ?? null,
    hero_position: state.hero_position,
    opponent_position: state.opponent_position ?? null,
    preflop_opener_position: state.preflop_opener_position ?? null,
    preflop_open_size: state.preflop_open_size ?? null,
    preflop_action_history: state.preflop_action_history ?? [],
    street: state.street,
    facing_action: state.facing_action ?? null,
    postflop_action_history: state.postflop_action_history ?? [],
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
  const showPostflopHistory = state.street !== null
    && state.street !== "preflop"
    && state.facing_action === "raise";
  const showOpponentPosition = requiresOpponentPosition(state);
  const preflopActionHistory: PreflopActionForm[] = (state.preflop_action_history ?? []).map(
    (action) => ({
      actor: action.actor,
      action: action.action,
      amount: String(action.amount),
    }),
  );
  const structuredOpener = preflopActionHistory[0]?.action === "raise"
    ? preflopActionHistory[0]
    : null;
  return {
    hero_cards: formatCards(state.hero_cards),
    board_cards: formatCards(state.board_cards),
    pot_size: state.pot_size === null ? "" : String(state.pot_size),
    current_bet: state.current_bet === null ? "" : String(state.current_bet),
    hero_stack: state.hero_stack == null ? "" : String(state.hero_stack),
    opponent_stack: showPostflopHistory && state.opponent_stack != null
      ? String(state.opponent_stack)
      : "",
    effective_stack: state.effective_stack === null ? "" : String(state.effective_stack),
    players_in_hand: state.players_in_hand === null ? "" : String(state.players_in_hand),
    opponents_at_current_bet: state.opponents_at_current_bet == null
      ? ""
      : String(state.opponents_at_current_bet),
    opponent_wager: state.opponent_wager == null ? "" : String(state.opponent_wager),
    opponent_commitment_total: state.opponent_commitment_total == null
      ? ""
      : String(state.opponent_commitment_total),
    hero_position: state.hero_position ?? "",
    opponent_position: showOpponentPosition
      ? state.opponent_position ?? ""
      : "",
    preflop_opener_position:
      structuredOpener?.actor
      ?? normalizePreflopPosition(state.preflop_opener_position)
      ?? "",
    preflop_open_size:
      structuredOpener !== null
        ? structuredOpener.amount
        : state.preflop_open_size !== null && state.preflop_open_size !== undefined
          ? String(state.preflop_open_size)
        : "",
    preflop_action_history: preflopActionHistory,
    street: state.street ?? "",
    facing_action: state.facing_action ?? "",
    postflop_action_history: showPostflopHistory
      ? (state.postflop_action_history ?? []).map((action) => ({
          actor: action.actor,
          action: action.action,
          amount: action.amount === null ? "" : String(action.amount),
        }))
      : [],
    action_context: state.action_context ?? "",
  };
}

function formToCanonical(form: StateForm): CanonicalState {
  const heroCards = parseCards(form.hero_cards, "Hero cards");
  const boardCards = parseCards(form.board_cards, "Board cards");
  validateCardState(heroCards, boardCards);
  const showPostflopHistory = form.street !== ""
    && form.street !== "preflop"
    && form.facing_action === "raise";
  const legacyPreflopOpenSize = form.preflop_action_history.length === 0
    ? parseOptionalNumber(form.preflop_open_size, "Opening size")
    : null;
  if (legacyPreflopOpenSize !== null && legacyPreflopOpenSize <= 0) {
    throw new Error("Opening size must be greater than 0");
  }
  const preflopActionHistory: PreflopAction[] = form.preflop_action_history.map((item, index) => {
    const amount = parseOptionalNumber(item.amount, `Preflop action ${index + 1} amount`);
    if (amount === null || amount <= 0) {
      throw new Error(`Preflop action ${index + 1} amount must be greater than 0`);
    }
    return { actor: item.actor, action: item.action, amount };
  });
  const structuredOpener = preflopActionHistory[0]?.action === "raise"
    ? preflopActionHistory[0]
    : null;
  const preserveLegacyOpener = preflopActionHistory.length === 0;
  const postflopActionHistory: PostflopAction[] = showPostflopHistory
    ? form.postflop_action_history.map((item, index) => {
        const amount = item.action === "check"
          ? null
          : parseOptionalNumber(item.amount, `Action ${index + 1} amount`);
        if (item.action !== "check" && (amount === null || amount <= 0)) {
          throw new Error(`Action ${index + 1} amount must be greater than 0`);
        }
        return { actor: item.actor, action: item.action, amount };
      })
    : [];
  const potSize = parseOptionalNumber(form.pot_size, "Pot");
  const playersInHand = parseOptionalInteger(form.players_in_hand, "Players in hand");
  const currentBet = parseOptionalNumber(form.current_bet, "Current bet");
  const usesOpponentPosition = requiresOpponentPosition({
    street: form.street,
    players_in_hand: playersInHand,
    hero_position: form.hero_position,
  });
  const needsCommittedOpponentCount = (currentBet ?? 0) > 0
    && (playersInHand ?? 0) > 2;
  const opponentsAtCurrentBet = needsCommittedOpponentCount
    ? parseOptionalInteger(
      form.opponents_at_current_bet,
      "Opponents at current bet",
    )
    : null;
  const opponentWager = (currentBet ?? 0) > 0
    ? parseOptionalNumber(form.opponent_wager, "Opponent wager total")
    : null;
  const usesOpponentCommitmentTotal = (
    (currentBet ?? 0) <= 0 && form.street === "preflop"
  ) || (
    (currentBet ?? 0) > 0 && (playersInHand ?? 0) > 2
  );
  const opponentCommitmentTotal = usesOpponentCommitmentTotal
    ? parseOptionalNumber(
      form.opponent_commitment_total,
      "Opponent commitments total",
    )
    : null;
  if (
    opponentsAtCurrentBet !== null
    && playersInHand !== null
    && opponentsAtCurrentBet >= playersInHand
  ) {
    throw new Error("Opponents at current bet must be lower than players in hand");
  }
  if (opponentWager !== null && opponentWager <= 0) {
    throw new Error("Opponent wager total must be greater than 0");
  }
  if (
    opponentWager !== null
    && currentBet !== null
    && opponentWager < currentBet
  ) {
    throw new Error("Opponent wager total must be at least the current bet");
  }
  if (opponentCommitmentTotal !== null && opponentCommitmentTotal <= 0) {
    throw new Error("Opponent commitments total must be greater than 0");
  }
  if (
    opponentCommitmentTotal !== null
    && potSize !== null
    && opponentCommitmentTotal > potSize + 0.000001
  ) {
    throw new Error("Opponent commitments total cannot exceed the pot");
  }
  const recordedWagers = form.street === "preflop"
    ? preflopActionHistory.map((action) => action.amount)
    : form.street !== ""
      ? postflopActionHistory.flatMap((action) => (
        action.amount === null ? [] : [action.amount]
      ))
      : [];
  const knownOpponentWager = opponentWager ?? Math.max(
    currentBet ?? 0,
    ...recordedWagers,
  );
  const minimumOpponentCommitments = knownOpponentWager > 0
    ? knownOpponentWager * (opponentsAtCurrentBet ?? 1)
    : null;
  if (
    opponentCommitmentTotal !== null
    && minimumOpponentCommitments !== null
    && opponentCommitmentTotal + 0.000001 < minimumOpponentCommitments
  ) {
    throw new Error("Opponent commitments total must cover opponents at the current wager");
  }
  const knownLatestWager = opponentWager ?? Math.max(0, ...recordedWagers);
  const maximumOpponentCommitments = knownLatestWager > 0
    && playersInHand !== null
    ? knownLatestWager * (playersInHand - 1)
    : null;
  if (
    opponentCommitmentTotal !== null
    && maximumOpponentCommitments !== null
    && opponentCommitmentTotal > maximumOpponentCommitments + 0.000001
  ) {
    throw new Error(
      "Opponent commitments total cannot exceed the latest wager across active opponents",
    );
  }

  return {
    hero_cards: heroCards,
    board_cards: boardCards,
    pot_size: potSize,
    current_bet: currentBet,
    hero_stack: parseOptionalNumber(form.hero_stack, "Hero stack"),
    opponent_stack: showPostflopHistory
      ? parseOptionalNumber(form.opponent_stack, "Opponent stack")
      : null,
    effective_stack: parseOptionalNumber(form.effective_stack, "Effective stack"),
    players_in_hand: playersInHand,
    opponents_at_current_bet: needsCommittedOpponentCount
      ? opponentsAtCurrentBet
      : null,
    opponent_wager: opponentWager,
    opponent_commitment_total: opponentCommitmentTotal,
    hero_position: form.hero_position.trim() === "" ? null : form.hero_position.trim(),
    opponent_position: usesOpponentPosition && form.opponent_position.trim() !== ""
      ? form.opponent_position.trim()
      : null,
    preflop_opener_position:
      structuredOpener?.actor
      ?? (
        preserveLegacyOpener && form.preflop_opener_position !== ""
          ? form.preflop_opener_position
          : null
      ),
    preflop_open_size: structuredOpener?.amount
      ?? (preserveLegacyOpener ? legacyPreflopOpenSize : null),
    preflop_action_history: preflopActionHistory,
    street: form.street === "" ? null : form.street,
    facing_action: form.facing_action === "" ? null : form.facing_action,
    postflop_action_history: postflopActionHistory,
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
    opponent_stack: state.opponent_stack ?? null,
    effective_stack: state.effective_stack,
    players_in_hand: state.players_in_hand,
    opponents_at_current_bet: state.opponents_at_current_bet ?? null,
    opponent_wager: state.opponent_wager ?? null,
    opponent_commitment_total: state.opponent_commitment_total ?? null,
    hero_position: state.hero_position,
    opponent_position: state.opponent_position ?? null,
    preflop_opener_position: state.preflop_opener_position ?? null,
    preflop_open_size: state.preflop_open_size ?? null,
    preflop_action_history: state.preflop_action_history ?? [],
    street: state.street,
    facing_action: state.facing_action ?? null,
    postflop_action_history: state.postflop_action_history ?? [],
    action_context: state.action_context,
  });
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function mutationFailureMayHavePersistedSideEffect(error: unknown): boolean {
  return error instanceof TypeError
    || (
      error instanceof ApiResponseError
      && (error.status === 408 || error.status >= 500)
    );
}

function recommendationAttemptMayHavePersistedSideEffect(
  error: unknown,
): boolean {
  return mutationFailureMayHavePersistedSideEffect(error)
    || (error instanceof ApiResponseError && error.status === 422);
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
  return job.archived_at === null
    && job.status !== "error"
    && !job.recommendation_pending
    && (
      job.status === "approved"
      || job.status === "recommended"
      || job.approved_state !== null
      || job.recommendation !== null
    );
}

function isProcessingJobInProgress(job: JobRecord): boolean {
  return job.archived_at === null
    && (job.status === "created" || job.recommendation_pending);
}

function createLocalErrorJob(
  file: File,
  message: string,
  index: number,
  uploadRequestId: string,
): JobRecord {
  const timestamp = new Date().toISOString();
  return {
    id: `local-error-${Date.now()}-${index}`,
    status: "error",
    upload_request_id: uploadRequestId,
    original_filename: file.name,
    image_filename: "",
    parser_provider: "client",
    recommendation_provider: "none",
    parser_result: null,
    approved_state: null,
    training_decision: null,
    recommendation: null,
    recommendation_pending: false,
    training_reviewed_at: null,
    training_review_note: null,
    benchmark_included: false,
    archived_at: null,
    error: message,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function queueDetail(job: JobRecord, attention: string | undefined): string {
  if (attention) {
    return attention;
  }
  if (job.status === "error") {
    return job.error ?? "Needs attention";
  }
  if (job.status === "created") {
    return "Parsing screenshot";
  }
  if (job.recommendation_pending) {
    return "Recommendation running";
  }
  if (job.parser_result && job.parser_result.warnings.length > 0) {
    return "Review warnings";
  }
  return job.parser_result?.state.street ?? "No street";
}

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>(
    () => readProcessingQueue() ?? [],
  );
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [form, setForm] = useState<StateForm>(() => stateToForm(EMPTY_STATE));
  const [approvedStateKey, setApprovedStateKey] = useState<string | null>(null);
  const [trainingAction, setTrainingAction] = useState<TrainingActionOption>("");
  const [trainingSizing, setTrainingSizing] = useState("");
  const [trainingCertainty, setTrainingCertainty] = useState<TrainingCertaintyOption>("");
  const [trainingReviewNote, setTrainingReviewNote] = useState("");
  const [trainingReviewNoteEditing, setTrainingReviewNoteEditing] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>("live");
  const [shareMode, setShareMode] = useState<ShareMode>("window");
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenSourceLabel, setScreenSourceLabel] = useState<string | null>(null);
  const [livePreviewVisible, setLivePreviewVisible] = useState(false);
  const [automationSettings, setAutomationSettings] = useState(
    readAutomationSettings,
  );
  const [automationDialogOpen, setAutomationDialogOpen] = useState(false);
  const [infoDialogOpen, setInfoDialogOpen] = useState(false);
  const [backupRestoring, setBackupRestoring] = useState(false);
  const [trainingDialogOpen, setTrainingDialogOpen] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState<TrainingProgress | null>(null);
  const [trainingProgressView, setTrainingProgressView] = useState<TrainingProgressView>("recent");
  const [trainingReviewOrder, setTrainingReviewOrder] = useState<TrainingReviewOrder>("recent");
  const [trainingReviewStreet, setTrainingReviewStreet] = useState<TrainingReviewStreet>("all");
  const [trainingReviewCertainty, setTrainingReviewCertainty] = useState<TrainingReviewCertaintyFilter>("all");
  const [trainingReviewDifference, setTrainingReviewDifference] = useState<TrainingReviewDifference | null>(null);
  const [trainingReviewPosition, setTrainingReviewPosition] = useState<TrainingPositionFilter | null>(null);
  const [trainingSolverFilter, setTrainingSolverFilter] = useState<TrainingSolverFilter | null>(null);
  const [trainingPositionFilter, setTrainingPositionFilter] = useState<TrainingPositionFilter | null>(null);
  const [trainingStreetFilter, setTrainingStreetFilter] = useState<TrainingStreetFilter | null>(null);
  const [trainingCertaintyFilter, setTrainingCertaintyFilter] = useState<TrainingCertaintyFilter | null>(null);
  const [trainingLessonOrder, setTrainingLessonOrder] = useState<TrainingReviewOrder>("recent");
  const [trainingLessonStreet, setTrainingLessonStreet] = useState<TrainingReviewStreet>("all");
  const [trainingLessonSearch, setTrainingLessonSearch] = useState("");
  const [trainingLessonQuery, setTrainingLessonQuery] = useState("");
  const [trainingProgressLoading, setTrainingProgressLoading] = useState(false);
  const [trainingReviewJobId, setTrainingReviewJobId] = useState<string | null>(null);
  const [trainingReviewQueueJobId, setTrainingReviewQueueJobId] = useState<string | null>(null);
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
  const [history, setHistory] = useState<HistoryItem[]>(() => readHistory() ?? []);
  const [historyTotal, setHistoryTotal] = useState(readHistoryTotal);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const [historySearchInput, setHistorySearchInput] = useState("");
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [historySearchResults, setHistorySearchResults] = useState<HistoryItem[] | null>(null);
  const [historySearchTotal, setHistorySearchTotal] = useState(0);
  const [historySearchSnapshotVersion, setHistorySearchSnapshotVersion] = useState<string | null>(null);
  const [queueProgress, setQueueProgress] = useState<QueueProgress | null>(null);
  const [jobAttention, setJobAttention] = useState<Record<string, string>>({});
  const [processingRestoreRequest, setProcessingRestoreRequest] = useState(0);
  const [mutationLeaseRestoreRequest, setMutationLeaseRestoreRequest] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setErrorMessage] = useState<string | null>(null);
  const [errorSequence, setErrorSequence] = useState(0);
  const [mutationOwnerId] = useState(mutationLeaseOwnerId);
  const [initialProcessingMutationLease] = useState(() =>
    claimPersistedMutationLease("processing", mutationOwnerId),
  );
  const [initialHistoryMutationLease] = useState(() =>
    claimPersistedMutationLease("history", mutationOwnerId),
  );
  const appMountedRef = useRef(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const benchmarkDatasetInputRef = useRef<HTMLInputElement | null>(null);
  const applicationBackupInputRef = useRef<HTMLInputElement | null>(null);
  const queueAbortControllerRef = useRef<AbortController | null>(null);
  const queueAbortRequestedRef = useRef(false);
  const historySearchRequestRef = useRef(0);
  const jobsRef = useRef(jobs);
  const activeJobIdRef = useRef(activeJobId);
  const formBaselineRef = useRef(form);
  const formDirtyRef = useRef(false);
  const processingCacheInitializedRef = useRef(false);
  const processingMembershipGenerationRef = useRef(0);
  const processingMutationCountRef = useRef(0);
  const processingRemovalCandidateIdsRef = useRef(new Set(
    initialProcessingMutationLease?.kind === "archive"
      ? initialProcessingMutationLease.jobIds
      : [],
  ));
  const processingUpdateCandidateIdsRef = useRef(new Set<string>());
  const processingRestoreRetryRequestedRef = useRef(false);
  const processingMutationLeaseRef = useRef(initialProcessingMutationLease);
  const historyMutationGenerationRef = useRef(0);
  const historyMutationCountRef = useRef(0);
  const historyJobRestoreActiveIdsRef = useRef(new Set<string>());
  const historyJobRestoreIdsRef = useRef(new Set<string>());
  const historyJobRestorePromiseRef = useRef<Promise<void> | null>(null);
  const historyJobRestoreRetryTimerRef = useRef<number | null>(null);
  const historyUpdateCandidateIdsRef = useRef(new Set(
    mutationLeaseJobIds(initialHistoryMutationLease),
  ));
  const historyMutationLeaseRef = useRef(initialHistoryMutationLease);
  const historyFullRestoreRequestedRef = useRef(false);
  const historyRestoreRetryRequestedRef = useRef(false);
  const historyRestorePromiseRef = useRef<Promise<boolean> | null>(null);
  const legacyHistoryArchivePromiseRef = useRef<Promise<boolean> | null>(null);
  const benchmarkImportRecoveryPromiseRef = useRef<Promise<void> | null>(null);
  const processingRestorePromiseRef = useRef<Promise<ProcessingQueueRestore> | null>(
    null,
  );

  useEffect(() => {
    appMountedRef.current = true;
    return () => {
      appMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    writeAutomationSettings(automationSettings);
  }, [automationSettings]);

  useEffect(() => {
    jobsRef.current = jobs;
    if (!processingCacheInitializedRef.current) {
      processingCacheInitializedRef.current = true;
      return;
    }
    writeProcessingQueue(jobs, !processingQueueSessionSynced());
  }, [jobs]);

  useEffect(() => {
    let restoreTimer: number | null = null;
    const onStorage = (event: StorageEvent) => {
      if (
        (
          event.key !== PROCESSING_QUEUE_STORAGE_KEY
          && event.key !== PROCESSING_QUEUE_TOTAL_STORAGE_KEY
        )
        || (
          event.storageArea !== null
          && event.storageArea !== window.localStorage
        )
      ) {
        return;
      }
      markProcessingQueueSessionUnsynced();
      if (restoreTimer !== null) {
        window.clearTimeout(restoreTimer);
      }
      restoreTimer = window.setTimeout(() => {
        restoreTimer = null;
        if (processingMutationCountRef.current === 0) {
          scheduleProcessingQueueRestore();
        } else {
          processingRestoreRetryRequestedRef.current = true;
        }
      }, 25);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      if (restoreTimer !== null) {
        window.clearTimeout(restoreTimer);
      }
    };
  }, []);

  useEffect(() => {
    if (!jobs.some(isProcessingJobInProgress)) {
      return;
    }
    markProcessingQueueSessionUnsynced();
    const revalidationTimer = window.setTimeout(() => {
      if (processingMutationCountRef.current === 0) {
        scheduleProcessingQueueRestore();
      } else {
        processingRestoreRetryRequestedRef.current = true;
      }
    }, PROCESSING_QUEUE_REVALIDATION_INTERVAL_MS);
    return () => window.clearTimeout(revalidationTimer);
  }, [jobs]);

  useEffect(() => {
    if (
      processingMutationLeaseRef.current === null
      && historyMutationLeaseRef.current === null
    ) {
      return;
    }
    let retryTimer: number | null = null;
    let retryDelay = PROCESSING_QUEUE_REVALIDATION_INTERVAL_MS;
    let benchmarkImportRetryNotBefore = 0;
    const revalidateLeases = () => {
      retryTimer = null;
      let leasePending = false;
      const linkedArchiveLeases = matchingArchiveLeaseTargets(
        processingMutationLeaseRef.current,
        historyMutationLeaseRef.current,
      );
      const benchmarkImportRequestId = benchmarkImportLeaseRequestId(
        processingMutationLeaseRef.current,
        historyMutationLeaseRef.current,
      );
      if (
        benchmarkImportRequestId !== null
        && benchmarkImportRecoveryPromiseRef.current === null
        && Date.now() >= benchmarkImportRetryNotBefore
      ) {
        const recovery = getBenchmarkDatasetImport(benchmarkImportRequestId)
          .then((receipt) => {
            benchmarkImportRetryNotBefore = 0;
            if (
              !appMountedRef.current
              || benchmarkImportLeaseRequestId(
                processingMutationLeaseRef.current,
                historyMutationLeaseRef.current,
              ) !== benchmarkImportRequestId
            ) {
              return;
            }
            if (receipt.status === "pending") {
              markBenchmarkImportReceiptObserved(benchmarkImportRequestId);
              return;
            }
            if (receipt.status === "failed" || receipt.result === null) {
              clearBenchmarkImportLeases(
                benchmarkImportRequestId,
                true,
              );
              setBenchmarkImporting(false);
              setError(receipt.error ?? "Could not recover parser dataset import");
              markProcessingQueueSessionUnsynced();
              scheduleProcessingQueueRestore();
              markHistorySessionUnsynced();
              void requestHistoryRestore(null, true);
              return;
            }
            const readyCases = applyBenchmarkDatasetImportResult(receipt.result);
            clearBenchmarkImportLeases(benchmarkImportRequestId);
            setBenchmarkImporting(false);
            setError(null);
            toast.success(
              `Dataset recovered: ${readyCases} ${readyCases === 1 ? "hand" : "hands"}`,
            );
            markProcessingQueueSessionUnsynced();
            scheduleProcessingQueueRestore();
            markHistorySessionUnsynced();
            void requestHistoryRestore(null, true);
          })
          .catch((recoveryError) => {
            if (
              recoveryError instanceof ApiResponseError
              && recoveryError.status === 429
              && recoveryError.retryAfterSeconds !== null
            ) {
              benchmarkImportRetryNotBefore = Math.max(
                benchmarkImportRetryNotBefore,
                Date.now() + recoveryError.retryAfterSeconds * 1_000,
              );
              return;
            }
            if (
              recoveryError instanceof ApiResponseError
              && recoveryError.status === 404
            ) {
              const importLeases = [
                processingMutationLeaseRef.current,
                historyMutationLeaseRef.current,
              ].flatMap((lease) =>
                isBenchmarkImportLease(lease, benchmarkImportRequestId)
                  ? [lease]
                  : []
              );
              if (
                importLeases.length > 0
                && importLeases.every(
                  (lease) =>
                    !lease.benchmarkImportReceiptObserved
                    && Date.now() >= lease.expiresAt,
                )
              ) {
                clearBenchmarkImportLeases(
                  benchmarkImportRequestId,
                  true,
                );
                markProcessingQueueSessionUnsynced();
                scheduleProcessingQueueRestore();
                markHistorySessionUnsynced();
                void requestHistoryRestore(null, true);
              }
              return;
            }
            // Network failures remain recoverable for the lifetime of the lease.
          })
          .finally(() => {
            if (benchmarkImportRecoveryPromiseRef.current === recovery) {
              benchmarkImportRecoveryPromiseRef.current = null;
            }
          });
        benchmarkImportRecoveryPromiseRef.current = recovery;
      }
      const processingLease = processingMutationLeaseRef.current;
      if (processingLease !== null) {
        const retainedImportLease = benchmarkImportRequestId !== null
          && isBenchmarkImportLease(
            processingLease,
            benchmarkImportRequestId,
          )
          && processingLease.benchmarkImportReceiptObserved;
        if (
          Date.now() >= processingLease.expiresAt
          && !retainedImportLease
        ) {
          clearPersistedMutationLease("processing", mutationOwnerId);
          processingMutationLeaseRef.current = null;
          markProcessingQueueSessionUnsynced();
          if (processingMutationCountRef.current === 0) {
            scheduleProcessingQueueRestore();
          } else {
            processingRestoreRetryRequestedRef.current = true;
          }
        } else {
          leasePending = true;
          markProcessingQueueSessionUnsynced();
          if (!isBenchmarkImportLease(
            processingLease,
            benchmarkImportRequestId ?? "",
          )) {
            if (processingMutationCountRef.current === 0) {
              scheduleProcessingQueueRestore();
            } else {
              processingRestoreRetryRequestedRef.current = true;
            }
          }
        }
      }

      const historyLease = historyMutationLeaseRef.current;
      if (historyLease !== null) {
        const historyLeaseJobIds = mutationLeaseJobIds(historyLease);
        const retainedImportLease = benchmarkImportRequestId !== null
          && isBenchmarkImportLease(
            historyLease,
            benchmarkImportRequestId,
          )
          && historyLease.benchmarkImportReceiptObserved;
        if (
          Date.now() >= historyLease.expiresAt
          && !retainedImportLease
        ) {
          clearPersistedMutationLease("history", mutationOwnerId);
          historyMutationLeaseRef.current = null;
          for (const jobId of historyLeaseJobIds) {
            historyUpdateCandidateIdsRef.current.delete(jobId);
          }
          markHistorySessionUnsynced();
          if (linkedArchiveLeases) {
            void requestHistoryRestore(null, true);
          } else if (historyLeaseJobIds.length > 0) {
            requestHistoryJobRestore(historyLeaseJobIds);
          } else {
            void requestHistoryRestore(null, true);
          }
        } else {
          leasePending = true;
          markHistorySessionUnsynced();
          if (
            !linkedArchiveLeases
            && !isBenchmarkImportLease(
              historyLease,
              benchmarkImportRequestId ?? "",
            )
          ) {
            if (historyLeaseJobIds.length > 0) {
              requestHistoryJobRestore(historyLeaseJobIds);
            } else {
              void requestHistoryRestore(null, true);
            }
          }
        }
      }

      if (leasePending) {
        retryDelay = Math.min(retryDelay * 2, 2_000);
        retryTimer = window.setTimeout(
          revalidateLeases,
          Math.max(
            retryDelay,
            benchmarkImportRetryNotBefore - Date.now(),
          ),
        );
      }
    };
    retryTimer = window.setTimeout(revalidateLeases, retryDelay);
    return () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [mutationLeaseRestoreRequest]);

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
  const canRecommend = currentStateApproved
    && !job?.recommendation
    && !job?.recommendation_pending;
  const stateControlsDisabled = busy;
  const screenshotUrl = useMemo(() => (job && job.image_filename !== "" ? imageUrl(job.id) : null), [job]);
  const screenSharing = screenStream !== null;
  const confidenceSummary = useMemo(
    () => summarizeConfidences(confidences, warnings, validation.state),
    [confidences, validation.state, warnings],
  );
  const filmstripCount = jobs.length > 0 ? jobs.length : files.length;
  const frameLabel = job?.original_filename ?? (screenSharing ? `${screenSourceLabel ?? shareModeLabel(shareMode)} live preview` : "No table selected");
  const frameStreet = form.street === "" ? "No street" : form.street;
  const queueCount = jobs.length > 0 ? jobs.length : files.length;
  const liveStatusLabel = screenSharing ? `${screenSourceLabel ?? shareModeLabel(shareMode)} sharing` : inputMode === "upload" ? "Upload queue" : "Live capture";
  const queueProgressPercent = queueProgress ? Math.round((queueProgress.completed / queueProgress.total) * 100) : 0;
  const automationEnabled = automationSettings.enabled;
  const automationApprove = automationSettings.autoApprove;
  const automationRecommend = automationSettings.autoRecommend;
  const automationAllowWarnings = automationSettings.allowWarnings;
  const clearableJobs = useMemo(() => jobs.filter(isHistoryReady), [jobs]);
  const historySearchActive = historySearchResults !== null;
  const visibleHistory = historySearchResults ?? history;
  const visibleHistoryTotal = historySearchActive ? historySearchTotal : historyTotal;
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
  const benchmarkImportRecoveryPending =
    benchmarkImportLeaseRequestId(
      processingMutationLeaseRef.current,
      historyMutationLeaseRef.current,
    ) !== null;
  const benchmarkOperationsLocked =
    benchmarkLoading ||
    benchmarkReportLoading ||
    benchmarkRunning ||
    benchmarkUpdating ||
    benchmarkImporting ||
    benchmarkImportRecoveryPending ||
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
    : trainingProgressView === "lessons"
      ? trainingProgress?.lesson_hands ?? []
      : trainingProgress?.recent_hands ?? [];
  const matchingTrainingLessons = trainingProgress?.lesson_matching_hands
    ?? trainingProgress?.lesson_hands?.length
    ?? 0;
  const trainingLessonsExportDisabled = matchingTrainingLessons === 0
    || trainingProgressLoading
    || trainingReviewJobId !== null
    || busy;
  const nextReviewHand = trainingProgressView === "lessons"
    || (
      trainingProgressView === "recent"
      && (
        trainingSolverFilter
        || trainingPositionFilter
        || trainingStreetFilter
        || trainingCertaintyFilter
      )
    )
    ? null
    : trainingProgress?.review_queue[0] ?? null;
  const reviewQueueStatus = trainingReviewQueueStatus(
    trainingProgress,
    trainingProgressView,
    trainingProgressLoading,
    trainingReviewOrder,
    trainingReviewStreet,
    trainingReviewDifference,
    trainingReviewCertainty,
    trainingReviewPosition,
    trainingLessonStreet,
    trainingLessonQuery,
    trainingLessonOrder,
    trainingSolverFilter,
    trainingPositionFilter,
    trainingStreetFilter,
    trainingCertaintyFilter,
  );
  const trainingFocus = trainingProgress ? suggestedTrainingFocus(trainingProgress) : null;
  const certaintyFocus = trainingProgress ? suggestedCertaintyFocus(trainingProgress) : null;
  const positionFocus = trainingProgress ? suggestedPositionFocus(trainingProgress) : null;
  const actionDifferenceFocus = trainingProgress
    ? suggestedActionDifferenceFocus(trainingProgress)
    : null;

  function setError(nextError: string | null) {
    setErrorMessage(nextError);
    setErrorSequence((current) => current + 1);
  }

  function scheduleProcessingQueueRestore() {
    processingRestoreRetryRequestedRef.current = false;
    processingRestorePromiseRef.current = null;
    setProcessingRestoreRequest((current) => current + 1);
  }

  function scheduleMutationLeaseRevalidation() {
    setMutationLeaseRestoreRequest((current) => current + 1);
  }

  function installMutationLease(
    scope: PersistedJobMutationScope,
    lease: PersistedMutationLease | null,
  ) {
    if (scope === "processing") {
      processingMutationLeaseRef.current = lease;
      markProcessingQueueSessionUnsynced();
      return;
    }
    historyMutationLeaseRef.current = lease;
    for (const jobId of mutationLeaseJobIds(lease)) {
      historyUpdateCandidateIdsRef.current.add(jobId);
    }
    markHistorySessionUnsynced();
  }

  function clearOwnedMutationLease(scope: PersistedJobMutationScope) {
    if (!appMountedRef.current) {
      return;
    }
    clearPersistedMutationLease(scope, mutationOwnerId);
    if (scope === "processing") {
      if (processingMutationLeaseRef.current?.ownerId === mutationOwnerId) {
        processingMutationLeaseRef.current = null;
      }
      return;
    }
    const historyLease = historyMutationLeaseRef.current;
    if (historyLease?.ownerId === mutationOwnerId) {
      for (const jobId of mutationLeaseJobIds(historyLease)) {
        historyUpdateCandidateIdsRef.current.delete(jobId);
      }
      historyMutationLeaseRef.current = null;
    }
  }

  function markBenchmarkImportReceiptObserved(requestId: string) {
    for (const scope of ["processing", "history"] as const) {
      const leaseRef = scope === "processing"
        ? processingMutationLeaseRef
        : historyMutationLeaseRef;
      const lease = leaseRef.current;
      if (!isBenchmarkImportLease(lease, requestId)) {
        continue;
      }
      const updatedLease: ProjectionMutationLease = {
        ...lease,
        benchmarkImportReceiptObserved: true,
        expiresAt: Date.now() + PERSISTED_MUTATION_LEASE_MS,
      };
      if (replacePersistedMutationLease(scope, lease, updatedLease)) {
        leaseRef.current = updatedLease;
      }
    }
  }

  function clearBenchmarkImportLeases(
    requestId: string,
    releaseRemovalCandidates = false,
  ) {
    const processingLease = processingMutationLeaseRef.current;
    if (isBenchmarkImportLease(processingLease, requestId)) {
      if (releaseRemovalCandidates) {
        for (const jobId of processingLease.expectedRemovalJobIds) {
          processingRemovalCandidateIdsRef.current.delete(jobId);
        }
      }
      clearOwnedMutationLease("processing");
    }
    if (isBenchmarkImportLease(
      historyMutationLeaseRef.current,
      requestId,
    )) {
      clearOwnedMutationLease("history");
    }
  }

  function mutationRecoveryPending(
    scopes: readonly PersistedJobMutationScope[],
  ): boolean {
    const pending = scopes.some((scope) =>
      scope === "processing"
        ? processingMutationLeaseRef.current !== null
        : historyMutationLeaseRef.current !== null
    );
    if (!pending) {
      return false;
    }
    scheduleMutationLeaseRevalidation();
    setError("Finishing recovery from a previous action. Try again in a moment.");
    return true;
  }

  function trackExpectedUpload(
    requestId: string,
    target: ProjectionMutationTarget,
    recommendationRequestId: string | null,
  ): number | null {
    const lease = processingMutationLeaseRef.current;
    if (lease?.kind !== "projection") {
      return null;
    }
    const updatedLease: ProjectionMutationLease = {
      ...lease,
      expectedUploads: [
        ...lease.expectedUploads,
        { requestId, target, recommendationRequestId },
      ],
      expiresAt: Date.now() + PERSISTED_MUTATION_LEASE_MS,
    };
    if (replacePersistedMutationLease("processing", lease, updatedLease)) {
      processingMutationLeaseRef.current = updatedLease;
      return updatedLease.expectedUploads.length - 1;
    }
    return null;
  }

  function updateExpectedUpload(
    expectedUploadIndex: number | null,
    target: ProjectionMutationTarget,
  ) {
    const lease = processingMutationLeaseRef.current;
    if (
      lease?.kind !== "projection"
      || expectedUploadIndex === null
      || lease.expectedUploads[expectedUploadIndex] === undefined
    ) {
      return;
    }
    const expectedUploads = [...lease.expectedUploads];
    expectedUploads[expectedUploadIndex] = {
      ...expectedUploads[expectedUploadIndex],
      target,
      recommendationRequestId: target === "recommended"
        ? expectedUploads[expectedUploadIndex].recommendationRequestId
        : null,
    };
    const updatedLease: ProjectionMutationLease = {
      ...lease,
      expectedUploads,
      expiresAt: Date.now() + PERSISTED_MUTATION_LEASE_MS,
    };
    if (replacePersistedMutationLease("processing", lease, updatedLease)) {
      processingMutationLeaseRef.current = updatedLease;
    }
  }

  function settlePersistedMutationLease(
    scope: PersistedJobMutationScope,
    incomingJobs: readonly JobRecord[],
    completeProcessingProjection: boolean,
  ): boolean {
    const leaseRef = scope === "processing"
      ? processingMutationLeaseRef
      : historyMutationLeaseRef;
    const lease = leaseRef.current;
    if (lease === null) {
      return false;
    }
    const storedLease = readPersistedMutationLease(scope);
    if (
      storedLease === null
      || storedLease.ownerId !== mutationOwnerId
      || storedLease.kind !== lease.kind
      || storedLease.expiresAt !== lease.expiresAt
    ) {
      leaseRef.current = null;
      return false;
    }

    let settled = false;
    if (lease.kind === "job") {
      const incomingJob = incomingJobs.find(
        (candidate) => candidate.id === lease.jobId,
      );
      if (
        incomingJob !== undefined
        && lease.expectedRecommendationRequestId !== null
      ) {
        settled = (
          incomingJob.recommendation_request_id
            === lease.expectedRecommendationRequestId
          && !incomingJob.recommendation_pending
        );
      } else if (
        incomingJob !== undefined
        && lease.expectedMutation !== null
      ) {
        settled = jobMutationExpectationReached(
          incomingJob,
          lease.expectedMutation,
        );
      } else {
        settled = false;
      }
    } else if (lease.kind === "projection") {
      if (lease.benchmarkImportRequestId !== null) {
        settled = false;
      } else if (lease.expectedUploads.length > 0) {
        const baselineIds = new Set(lease.baselineJobIds);
        const availableJobs = incomingJobs.filter(
          (job) => !baselineIds.has(job.id) && !isLocalUploadError(job),
        );
        settled = lease.expectedUploads.every((expectedUpload) => {
          if (expectedUpload.target === "failed") {
            return true;
          }
          const matchingIndex = availableJobs.findIndex((job) =>
            job.upload_request_id === expectedUpload.requestId
            && projectionMutationTargetReached(
              job,
              expectedUpload.target,
              expectedUpload.recommendationRequestId,
            )
          );
          if (matchingIndex === -1) {
            return false;
          }
          availableJobs.splice(matchingIndex, 1);
          return true;
        });
      } else if (lease.expectedRemovalJobIds.length > 0) {
        const incomingIds = new Set(incomingJobs.map((job) => job.id));
        settled = completeProcessingProjection
          && lease.expectedRemovalJobIds.every((jobId) => !incomingIds.has(jobId));
      }
    } else if (scope === "processing") {
      const incomingById = new Map(incomingJobs.map((job) => [job.id, job]));
      const confirmationIds = new Set(lease.confirmationJobIds);
      settled = completeProcessingProjection
        && lease.jobIds.every((jobId) => {
          const incomingJob = incomingById.get(jobId);
          if (!confirmationIds.has(jobId)) {
            return incomingJob === undefined;
          }
          return incomingJob !== undefined
            && incomingJob.archived_at !== null
            && incomingJob.updated_at !== lease.baselineUpdatedAt[jobId];
        });
    } else {
      const incomingById = new Map(incomingJobs.map((job) => [job.id, job]));
      settled = lease.jobIds.every((jobId) => {
        const incomingJob = incomingById.get(jobId);
        return incomingJob !== undefined
          && incomingJob.archived_at !== null
          && incomingJob.updated_at !== lease.baselineUpdatedAt[jobId];
      });
    }
    if (!settled) {
      return false;
    }

    clearPersistedMutationLease(scope, mutationOwnerId);
    leaseRef.current = null;
    const targetJobIds = mutationLeaseJobIds(lease);
    for (const jobId of targetJobIds) {
      processingUpdateCandidateIdsRef.current.delete(jobId);
    }
    if (scope === "history") {
      historyMutationGenerationRef.current += 1;
      for (const jobId of targetJobIds) {
        historyUpdateCandidateIdsRef.current.delete(jobId);
      }
    }
    if (
      scope === "processing"
      && lease.kind === "archive"
      && matchingArchiveLeaseTargets(
        lease,
        historyMutationLeaseRef.current,
      )
    ) {
      clearPersistedMutationLease("history", mutationOwnerId);
      historyMutationLeaseRef.current = null;
      historyMutationGenerationRef.current += 1;
      for (const jobId of lease.jobIds) {
        historyUpdateCandidateIdsRef.current.delete(jobId);
      }
      markHistorySessionUnsynced();
      void requestHistoryRestore(null, true);
    }
    return true;
  }

  function requestHistoryRestore(
    jobIds: string[] | null = null,
    queueAfterActive = false,
  ): Promise<boolean> {
    const activeRestore = historyRestorePromiseRef.current;
    if (activeRestore) {
      if (queueAfterActive) {
        if (jobIds === null) {
          historyFullRestoreRequestedRef.current = true;
        }
        historyRestoreRetryRequestedRef.current = true;
      }
      return activeRestore;
    }

    if (jobIds === null) {
      historyFullRestoreRequestedRef.current = false;
    }
    historyRestoreRetryRequestedRef.current = false;
    const restore = syncHistory(jobIds, false);
    historyRestorePromiseRef.current = restore;
    void restore.finally(() => {
      if (historyRestorePromiseRef.current !== restore) {
        return;
      }
      historyRestorePromiseRef.current = null;
      if (
        historyRestoreRetryRequestedRef.current
        && historyMutationCountRef.current === 0
      ) {
        historyRestoreRetryRequestedRef.current = false;
        requestDeferredHistoryRestore();
      }
    });
    return restore;
  }

  function requestDeferredHistoryRestore() {
    const targetJobIds = new Set([
      ...historyJobRestoreIdsRef.current,
      ...historyUpdateCandidateIdsRef.current,
    ]);
    if (targetJobIds.size > 0) {
      if (historyJobRestoreRetryTimerRef.current !== null) {
        if (historyFullRestoreRequestedRef.current) {
          historyFullRestoreRequestedRef.current = false;
          void requestHistoryRestore(null, true);
        }
        return;
      }
      if (historyFullRestoreRequestedRef.current) {
        historyRestoreRetryRequestedRef.current = true;
      }
      requestHistoryJobRestore([...targetJobIds]);
      return;
    }
    historyFullRestoreRequestedRef.current = false;
    void requestHistoryRestore(null, true);
  }

  function scheduleHistoryJobRestoreRetry() {
    if (historyJobRestoreRetryTimerRef.current !== null) {
      return;
    }
    historyJobRestoreRetryTimerRef.current = window.setTimeout(() => {
      historyJobRestoreRetryTimerRef.current = null;
      if (
        historyMutationCountRef.current > 0
        || historyRestorePromiseRef.current
        || historyJobRestorePromiseRef.current
      ) {
        historyRestoreRetryRequestedRef.current = true;
        return;
      }
      requestDeferredHistoryRestore();
    }, PROCESSING_QUEUE_REVALIDATION_INTERVAL_MS);
  }

  function hasPendingHistoryJobRestore(
    resolvedJobIds: ReadonlySet<string>,
  ): boolean {
    return [
      ...historyUpdateCandidateIdsRef.current,
      ...historyJobRestoreIdsRef.current,
      ...historyJobRestoreActiveIdsRef.current,
    ].some((jobId) => !resolvedJobIds.has(jobId));
  }

  function requestHistoryJobRestore(jobIds: readonly string[]) {
    let queuedNewTarget = false;
    for (const jobId of jobIds) {
      if (
        !historyJobRestoreActiveIdsRef.current.has(jobId)
        && !historyJobRestoreIdsRef.current.has(jobId)
      ) {
        historyJobRestoreIdsRef.current.add(jobId);
        queuedNewTarget = true;
      }
    }
    if (historyMutationCountRef.current > 0) {
      historyRestoreRetryRequestedRef.current = true;
      return;
    }
    if (historyJobRestorePromiseRef.current) {
      if (queuedNewTarget) {
        historyRestoreRetryRequestedRef.current = true;
      }
      return;
    }

    const requestedJobIds = [...historyJobRestoreIdsRef.current];
    if (requestedJobIds.length === 0) {
      return;
    }
    historyJobRestoreIdsRef.current.clear();
    historyJobRestoreActiveIdsRef.current = new Set(requestedJobIds);
    const restoreGeneration = historyMutationGenerationRef.current;
    const restore = Promise.all(requestedJobIds.map((jobId) => getJob(jobId)))
      .then((incomingJobs) => {
        if (
          historyMutationGenerationRef.current !== restoreGeneration
          || historyMutationCountRef.current > 0
        ) {
          for (const jobId of requestedJobIds) {
            historyJobRestoreIdsRef.current.add(jobId);
          }
          markHistorySessionUnsynced();
          historyRestoreRetryRequestedRef.current = true;
          return;
        }
        applyHistoryJobUpdates(incomingJobs);
      })
      .catch(() => {
        for (const jobId of requestedJobIds) {
          historyJobRestoreIdsRef.current.add(jobId);
        }
        markHistorySessionUnsynced();
        historyRestoreRetryRequestedRef.current =
          historyFullRestoreRequestedRef.current;
        scheduleHistoryJobRestoreRetry();
      });
    historyJobRestorePromiseRef.current = restore;
    void restore.finally(() => {
      if (historyJobRestorePromiseRef.current !== restore) {
        return;
      }
      historyJobRestorePromiseRef.current = null;
      historyJobRestoreActiveIdsRef.current.clear();
      if (
        historyRestoreRetryRequestedRef.current
        && historyMutationCountRef.current === 0
      ) {
        historyRestoreRetryRequestedRef.current = false;
        requestDeferredHistoryRestore();
      }
    });
  }

  function beginHistoryMutation() {
    historyMutationCountRef.current += 1;
    historyMutationGenerationRef.current += 1;
    markHistorySessionUnsynced();
  }

  function endHistoryMutation(restoreAfterMutation = false) {
    historyMutationCountRef.current = Math.max(
      historyMutationCountRef.current - 1,
      0,
    );
    if (
      historyMutationCountRef.current === 0
      && (
        restoreAfterMutation
        || historyRestoreRetryRequestedRef.current
      )
    ) {
      historyRestoreRetryRequestedRef.current = false;
      requestDeferredHistoryRestore();
    }
  }

  function beginProcessingMembershipMutation(
    removalCandidateIds: readonly string[] = [],
    updateCandidateIds: readonly string[] = [],
  ) {
    for (const removalCandidateId of removalCandidateIds) {
      processingRemovalCandidateIdsRef.current.add(removalCandidateId);
    }
    for (const updateCandidateId of updateCandidateIds) {
      processingUpdateCandidateIdsRef.current.add(updateCandidateId);
    }
    processingMutationCountRef.current += 1;
    processingMembershipGenerationRef.current += 1;
    markProcessingQueueSessionUnsynced();
  }

  function endProcessingMembershipMutation(restoreAfterMutation = true) {
    processingMutationCountRef.current = Math.max(
      processingMutationCountRef.current - 1,
      0,
    );
    if (
      processingMutationCountRef.current === 0
      && (
        restoreAfterMutation
        || processingRestoreRetryRequestedRef.current
      )
    ) {
      scheduleProcessingQueueRestore();
    }
  }

  function beginPersistedJobMutation(
    persistedJob: JobRecord,
    expectedMutation: JobMutationExpectation | null,
    removalCandidateIds: readonly string[] = [],
  ): PersistedJobMutationScope {
    const scope = persistedJobMutationScope(persistedJob);
    const lease = startPersistedMutationLease(
      scope,
      mutationOwnerId,
      persistedJob,
      expectedMutation,
      removalCandidateIds.includes(persistedJob.id),
    );
    if (scope === "history") {
      historyMutationLeaseRef.current = lease;
      beginHistoryMutation();
      return "history";
    }
    processingMutationLeaseRef.current = lease;
    beginProcessingMembershipMutation(removalCandidateIds);
    return "processing";
  }

  function armPersistedRecommendationLease(
    mutationScope: PersistedJobMutationScope,
    jobId: string,
    recommendationRequestId: string,
  ): boolean {
    const leaseRef = mutationScope === "processing"
      ? processingMutationLeaseRef
      : historyMutationLeaseRef;
    const lease = leaseRef.current;
    if (lease === null) {
      return true;
    }
    if (
      lease.kind !== "job"
      || lease.jobId !== jobId
      || lease.ownerId !== mutationOwnerId
    ) {
      return false;
    }
    const armedLease: JobMutationLease = {
      ...lease,
      expectedRecommendationRequestId: recommendationRequestId,
      expectedMutation: null,
      expiresAt: Date.now() + PERSISTED_MUTATION_LEASE_MS,
    };
    if (!replacePersistedMutationLease(mutationScope, lease, armedLease)) {
      return false;
    }
    leaseRef.current = armedLease;
    return true;
  }

  function persistedJobMutationScope(
    persistedJob: JobRecord,
  ): PersistedJobMutationScope {
    return persistedJob.archived_at ? "history" : "processing";
  }

  function markPersistedJobMutationUncertain(
    mutationScope: PersistedJobMutationScope,
    persistedJobId: string,
  ) {
    if (mutationScope === "processing") {
      processingUpdateCandidateIdsRef.current.add(persistedJobId);
      return;
    }
    historyUpdateCandidateIdsRef.current.add(persistedJobId);
  }

  function endPersistedJobMutation(
    mutationScope: PersistedJobMutationScope,
    restoreAfterMutation: boolean,
  ) {
    if (!appMountedRef.current) {
      return;
    }
    const leaseRef = mutationScope === "processing"
      ? processingMutationLeaseRef
      : historyMutationLeaseRef;
    const lease = leaseRef.current;
    const updateCandidates = mutationScope === "processing"
      ? processingUpdateCandidateIdsRef.current
      : historyUpdateCandidateIdsRef.current;
    const retainUncertainLease = mutationLeaseJobIds(lease).some(
      (jobId) => updateCandidates.has(jobId),
    );
    if (retainUncertainLease) {
      scheduleMutationLeaseRevalidation();
    } else {
      clearPersistedMutationLease(mutationScope, mutationOwnerId);
      if (lease?.ownerId === mutationOwnerId) {
        leaseRef.current = null;
      }
    }
    if (mutationScope === "processing") {
      endProcessingMembershipMutation(restoreAfterMutation);
      return;
    }
    endHistoryMutation(restoreAfterMutation);
  }

  function markPersistedJobSessionUnsynced(persistedJob: JobRecord) {
    if (persistedJob.archived_at) {
      markHistorySessionUnsynced();
      return;
    }
    markProcessingQueueSessionUnsynced();
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
    const cachedHistory = readHistory();
    if (
      historySessionSynced()
      && readCachedHistoryTotal(cachedHistory) !== null
    ) {
      return;
    }

    const legacyJobs = (cachedHistory ?? [])
      .filter((item) =>
        item.job.archived_at == null
        && PERSISTED_JOB_ID_PATTERN.test(item.id),
      );
    const legacyJobIds = legacyJobs.map((item) => item.id);
    if (legacyJobIds.length > 0) {
      installMutationLease(
        "processing",
        startArchiveMutationLease(
          "processing",
          mutationOwnerId,
          legacyJobs.map((item) => item.job),
        ),
      );
      installMutationLease(
        "history",
        startArchiveMutationLease(
          "history",
          mutationOwnerId,
          legacyJobs.map((item) => item.job),
        ),
      );
      const migration = requestHistoryRestore(legacyJobIds);
      legacyHistoryArchivePromiseRef.current = migration;
      void migration;
      return;
    }
    void requestHistoryRestore();
  }, []);

  useEffect(() => () => {
    if (historyJobRestoreRetryTimerRef.current !== null) {
      window.clearTimeout(historyJobRestoreRetryTimerRef.current);
      historyJobRestoreRetryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const pendingArchivedJobIds = new Set([
      ...history.flatMap((item) =>
        item.job.recommendation_pending ? [item.id] : [],
      ),
      ...(historySearchResults ?? []).flatMap((item) =>
        item.job.recommendation_pending ? [item.id] : [],
      ),
      ...jobs.flatMap((candidate) =>
        candidate.archived_at && candidate.recommendation_pending
          ? [candidate.id]
          : [],
      ),
    ]);
    if (pendingArchivedJobIds.size === 0) {
      return;
    }
    markHistorySessionUnsynced();
    const revalidationTimer = window.setInterval(() => {
      requestHistoryJobRestore([...pendingArchivedJobIds]);
    }, PROCESSING_QUEUE_REVALIDATION_INTERVAL_MS);
    return () => window.clearInterval(revalidationTimer);
  }, [history, historySearchResults, jobs]);

  useEffect(() => {
    const cachedJobs = readProcessingQueue();
    const legacyHistoryArchive = legacyHistoryArchivePromiseRef.current;
    if (
      legacyHistoryArchive === null
      && processingQueueSessionSynced()
      && readCachedProcessingQueueTotal(cachedJobs) !== null
      && !cachedJobs?.some(isProcessingJobInProgress)
    ) {
      return;
    }
    markProcessingQueueSessionUnsynced();

    const cachedIds = new Set((cachedJobs ?? []).map((cachedJob) => cachedJob.id));
    const restoreGeneration = processingMembershipGenerationRef.current;
    processingRestorePromiseRef.current ??= (async () => {
      if (legacyHistoryArchive !== null && !(await legacyHistoryArchive)) {
        throw new Error("Could not migrate legacy history before restoring processing");
      }
      const queue = await getProcessingQueueExtent();
      const lease = processingMutationLeaseRef.current;
      if (
        lease?.kind === "job"
        && !queue.jobs.some((candidate) => candidate.id === lease.jobId)
      ) {
        const leasedJob = await getJob(lease.jobId);
        return {
          ...queue,
          revalidatedLeaseJob: leasedJob,
        };
      }
      if (lease?.kind === "archive" && lease.confirmationJobIds.length > 0) {
        const queueIds = new Set(queue.jobs.map((candidate) => candidate.id));
        const confirmationJobs = await Promise.all(
          lease.confirmationJobIds
            .filter((jobId) => !queueIds.has(jobId))
            .map((jobId) => getJob(jobId)),
        );
        return {
          ...queue,
          revalidatedArchiveJobs: confirmationJobs,
        };
      }
      return queue;
    })();
    let active = true;
    let restoreRetryTimer: number | null = null;
    void processingRestorePromiseRef.current
      .then((queue) => {
        if (!active) {
          return;
        }
        if (processingMembershipGenerationRef.current !== restoreGeneration) {
          markProcessingQueueSessionUnsynced();
          processingRestoreRetryRequestedRef.current = true;
          if (processingMutationCountRef.current === 0) {
            scheduleProcessingQueueRestore();
          }
          return;
        }
        const currentJobs = jobsRef.current;
        const currentJobsById = new Map(currentJobs.map((candidate) => [
          candidate.id,
          candidate,
        ]));
        const projectionJobs = queue.jobs.map((candidate) =>
          preserveUploadRequestId(candidate, currentJobsById.get(candidate.id))
        );
        const revalidatedLeaseJob = queue.revalidatedLeaseJob
          ? preserveUploadRequestId(
              queue.revalidatedLeaseJob,
              currentJobsById.get(queue.revalidatedLeaseJob.id),
            )
          : null;
        const settlementJobs = revalidatedLeaseJob
          ? [revalidatedLeaseJob, ...projectionJobs]
          : [
              ...(queue.revalidatedArchiveJobs ?? []),
              ...projectionJobs,
            ];
        const incomingJobs = (
          revalidatedLeaseJob?.archived_at === null
          && processingMutationLeaseRef.current?.kind === "job"
          && !processingMutationLeaseRef.current.expectsRemoval
        )
          ? settlementJobs
          : projectionJobs;
        const processingLease = processingMutationLeaseRef.current;
        const authoritativeMutationJobIds = new Set(
          mutationLeaseJobIds(processingLease),
        );
        const mutationLeaseSettled = settlePersistedMutationLease(
          "processing",
          settlementJobs,
          true,
        );
        const currentActiveId = activeJobIdRef.current;
        const currentActiveJob = currentActiveId === null
          ? null
          : currentJobs.find((candidate) => candidate.id === currentActiveId) ?? null;
        let nextJobs = reconcileProcessingJobs(
          currentJobs,
          incomingJobs,
          cachedIds,
          processingRemovalCandidateIdsRef.current,
        );
        const nextJobsById = new Map(nextJobs.map((candidate) => [
          candidate.id,
          candidate,
        ]));
        const recoveredAutomationIds = new Set(incomingJobs.flatMap((incomingJob) => {
          const currentJob = currentJobsById.get(incomingJob.id);
          const reconciledJob = nextJobsById.get(incomingJob.id);
          const reachedPersistedProjectionTarget = processingLease?.kind === "projection"
            ? projectionMutationLeaseTargetReached(processingLease, incomingJob)
            : null;
          const reachedCurrentAutomationTarget = incomingJob.approved_state !== null
            && (!automationRecommend || incomingJob.recommendation !== null);
          const reachedAutomationTarget = incomingJob.error === null
            && (
              reachedPersistedProjectionTarget
              ?? reachedCurrentAutomationTarget
            );
          return currentJob
            && reconciledJob !== currentJob
            && reachedAutomationTarget
            ? [incomingJob.id]
            : [];
        }));
        clearJobAttentionEntries(recoveredAutomationIds);
        const preservedMissingDirtyJob = formDirtyRef.current
          && currentActiveJob !== null
          && !processingRemovalCandidateIdsRef.current.has(currentActiveJob.id)
          && !nextJobs.some((candidate) => candidate.id === currentActiveJob.id);
        if (preservedMissingDirtyJob) {
          nextJobs = [currentActiveJob, ...nextJobs];
        }
        const reconciledActiveJob = currentActiveId === null
          ? null
          : nextJobs.find((candidate) => candidate.id === currentActiveId) ?? null;
        const activeJobUpdatedAuthoritatively = currentActiveJob !== null
          && reconciledActiveJob !== null
          && (
            processingUpdateCandidateIdsRef.current.has(currentActiveJob.id)
            || (
              mutationLeaseSettled
              && authoritativeMutationJobIds.has(currentActiveJob.id)
            )
          )
          && reconciledActiveJob.updated_at !== currentActiveJob.updated_at;
        const preserveDirtyForm = formDirtyRef.current
          && reconciledActiveJob !== null
          && !activeJobUpdatedAuthoritatively;
        for (const removalCandidateId of processingRemovalCandidateIdsRef.current) {
          if (
            !mutationLeaseTargetsJob(
              processingMutationLeaseRef.current,
              removalCandidateId,
            )
          ) {
            processingRemovalCandidateIdsRef.current.delete(removalCandidateId);
          }
        }
        for (const updateCandidateId of processingUpdateCandidateIdsRef.current) {
          if (
            !mutationLeaseTargetsJob(
              processingMutationLeaseRef.current,
              updateCandidateId,
            )
          ) {
            processingUpdateCandidateIdsRef.current.delete(updateCandidateId);
          }
        }
        jobsRef.current = nextJobs;
        setJobs(nextJobs);
        if (!preserveDirtyForm) {
          alignWorkspaceToJob(reconciledActiveJob ?? nextJobs[0] ?? null);
        }
        const processingInProgress = nextJobs.some(isProcessingJobInProgress);
        const authoritativeJobIds = new Set(
          incomingJobs.map((candidate) => candidate.id),
        );
        if (
          writeProcessingQueue(nextJobs, false, authoritativeJobIds)
          && !preservedMissingDirtyJob
          && !processingInProgress
          && processingMutationLeaseRef.current === null
        ) {
          markProcessingQueueSessionSynced();
        } else {
          markProcessingQueueSessionUnsynced();
        }
      })
      .catch((processingError) => {
        if (active) {
          setError(messageFromError(
            processingError,
            "Could not restore processing queue",
          ));
          markProcessingQueueSessionUnsynced();
          restoreRetryTimer = window.setTimeout(() => {
            restoreRetryTimer = null;
            if (processingMutationCountRef.current === 0) {
              scheduleProcessingQueueRestore();
            } else {
              processingRestoreRetryRequestedRef.current = true;
            }
          }, PROCESSING_QUEUE_REVALIDATION_INTERVAL_MS);
        }
      });

    return () => {
      active = false;
      if (restoreRetryTimer !== null) {
        window.clearTimeout(restoreRetryTimer);
      }
    };
  }, [processingRestoreRequest]);

  useEffect(() => {
    if (activeJobId !== null || jobs.length === 0) {
      return;
    }
    alignWorkspaceToJob(jobs[0]);
  }, [activeJobId, jobs]);

  useEffect(() => {
    if (!currentStateApproved) {
      setTrainingAction("");
      setTrainingSizing("");
      setTrainingCertainty("");
      return;
    }
    setTrainingAction(job?.training_decision?.action ?? "");
    setTrainingSizing(
      job?.training_decision?.sizing === null || job?.training_decision?.sizing === undefined
        ? ""
        : String(job.training_decision.sizing),
    );
    setTrainingCertainty(job?.training_decision?.certainty ?? "");
  }, [
    currentStateApproved,
    job?.id,
    job?.training_decision?.action,
    job?.training_decision?.certainty,
    job?.training_decision?.sizing,
  ]);

  useEffect(() => {
    setTrainingReviewNote(job?.training_review_note ?? "");
    setTrainingReviewNoteEditing(false);
  }, [job?.id, job?.training_review_note, job?.training_reviewed_at]);

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

  function alignWorkspaceToJob(nextJob: JobRecord | null) {
    const nextState = nextJob ? stateFromJob(nextJob) : EMPTY_STATE;
    const nextForm = stateToForm(nextState);
    activeJobIdRef.current = nextJob?.id ?? null;
    formBaselineRef.current = nextForm;
    formDirtyRef.current = false;
    setActiveJobId(nextJob?.id ?? null);
    setForm(nextForm);
    setApprovedStateKey(
      nextJob?.approved_state ? approvalKey(nextJob.approved_state) : null,
    );
  }

  function activateJob(nextJob: JobRecord) {
    alignWorkspaceToJob(nextJob);
    setLivePreviewVisible(false);
    setError(null);
  }

  function updateJobs(
    updater: (current: JobRecord[]) => JobRecord[],
  ) {
    const nextJobs = updater(jobsRef.current);
    jobsRef.current = nextJobs;
    setJobs(nextJobs);
  }

  function clearJobAttentionEntries(jobIds: ReadonlySet<string>) {
    if (jobIds.size === 0) {
      return;
    }
    setJobAttention((current) => {
      if (![...jobIds].some((jobId) => jobId in current)) {
        return current;
      }
      const next = { ...current };
      for (const jobId of jobIds) {
        delete next[jobId];
      }
      return next;
    });
  }

  function clearJobAttention(jobId: string) {
    clearJobAttentionEntries(new Set([jobId]));
  }

  function replaceJob(updatedJob: JobRecord) {
    const currentJob = jobsRef.current.find(
      (candidate) => candidate.id === updatedJob.id,
    );
    const normalizedJob = preserveUploadRequestId(updatedJob, currentJob);
    updateJobs((current) =>
      current.map((candidate) =>
        candidate.id === normalizedJob.id ? normalizedJob : candidate
      ),
    );
    clearJobAttention(updatedJob.id);
    updateHistoryJob(normalizedJob);
    activeJobIdRef.current = updatedJob.id;
    setActiveJobId(updatedJob.id);
  }

  function upsertAndActivateJob(nextJob: JobRecord) {
    updateJobs((current) => {
      const existing = current.some((candidate) => candidate.id === nextJob.id);
      return existing
        ? current.map((candidate) => (candidate.id === nextJob.id ? nextJob : candidate))
        : [nextJob, ...current];
    });
    updateHistoryJob(nextJob, false);
    activateJob(nextJob);
  }

  function updateHistoryJob(updatedJob: JobRecord, revalidateSearch = true) {
    setHistory((current) => {
      if (!current.some((item) => item.id === updatedJob.id)) {
        return current;
      }
      const next = current.map((item) => (item.id === updatedJob.id ? { ...item, job: updatedJob } : item));
      writeHistory(next);
      return next;
    });
    setHistorySearchResults((current) =>
      current?.map((item) => (item.id === updatedJob.id ? { ...item, job: updatedJob } : item))
      ?? null,
    );
    if (
      revalidateSearch
      && updatedJob.archived_at
      && historySearchActive
      && historySearchQuery
    ) {
      void revalidateHistorySearch(historySearchQuery);
    }
  }

  function applyHistoryJobUpdates(incomingJobs: JobRecord[]) {
    const settlingArchiveLease = historyMutationLeaseRef.current?.kind === "archive";
    const authoritativeMutationJobIds = new Set(
      mutationLeaseJobIds(historyMutationLeaseRef.current),
    );
    const mutationLeaseSettled = settlePersistedMutationLease(
      "history",
      incomingJobs,
      false,
    );
    const incomingJobsById = new Map(
      incomingJobs.map((incomingJob) => [incomingJob.id, incomingJob]),
    );
    const reconciledHistoryJob = (
      currentJob: JobRecord,
      incomingJob: JobRecord,
    ) => mutationLeaseSettled && authoritativeMutationJobIds.has(incomingJob.id)
      ? incomingJob
      : newerHistoryJob(currentJob, incomingJob);
    const resolvedJobIds = new Set(incomingJobsById.keys());
    const currentActiveId = activeJobIdRef.current;
    const currentActiveJob = currentActiveId === null
      ? null
      : jobsRef.current.find((candidate) => candidate.id === currentActiveId) ?? null;
    const nextJobs = jobsRef.current.map((candidate) => {
      const incomingJob = incomingJobsById.get(candidate.id);
      return incomingJob
        ? reconciledHistoryJob(candidate, incomingJob)
        : candidate;
    });
    const reconciledActiveJob = currentActiveId === null
      ? null
      : nextJobs.find((candidate) => candidate.id === currentActiveId) ?? null;
    const activeJobUpdated = currentActiveJob !== null
      && reconciledActiveJob !== null
      && reconciledActiveJob !== currentActiveJob;
    if (nextJobs.some((candidate, index) => candidate !== jobsRef.current[index])) {
      updateJobs(() => nextJobs);
    }
    if (
      activeJobUpdated
      && (
        !formDirtyRef.current
        || (
          currentActiveId !== null
          && (
            historyUpdateCandidateIdsRef.current.has(currentActiveId)
            || (
              mutationLeaseSettled
              && authoritativeMutationJobIds.has(currentActiveId)
            )
          )
        )
      )
    ) {
      alignWorkspaceToJob(reconciledActiveJob);
    }

    setHistory((current) => {
      const next = current.map((item) => {
        const incomingJob = incomingJobsById.get(item.id);
        return incomingJob
          ? { ...item, job: reconciledHistoryJob(item.job, incomingJob) }
          : item;
      });
      const historyCached = writeHistory(next);
      const cachedHistory = historyCached ? readHistory() : null;
      const pendingSearchResult = (historySearchResults ?? []).some((item) => {
        const incomingJob = incomingJobsById.get(item.id);
        return (
          incomingJob
            ? reconciledHistoryJob(item.job, incomingJob)
            : item.job
        ).recommendation_pending;
      });
      const pendingWorkspaceJob = nextJobs.some(
        (candidate) => candidate.archived_at && candidate.recommendation_pending,
      );
      if (
        historyCached
        && readCachedHistoryTotal(cachedHistory) !== null
        && !historyFullRestoreRequestedRef.current
        && !hasPendingHistoryJobRestore(resolvedJobIds)
        && !next.some((item) => item.job.recommendation_pending)
        && !pendingSearchResult
        && !pendingWorkspaceJob
        && historyMutationLeaseRef.current === null
      ) {
        markHistorySessionSynced();
      } else {
        markHistorySessionUnsynced();
      }
      return next;
    });
    setHistorySearchResults((current) =>
      current?.map((item) => {
        const incomingJob = incomingJobsById.get(item.id);
        return incomingJob
          ? { ...item, job: reconciledHistoryJob(item.job, incomingJob) }
          : item;
      }) ?? null,
    );
    for (const incomingJob of incomingJobs) {
      if (
        !mutationLeaseTargetsJob(
          historyMutationLeaseRef.current,
          incomingJob.id,
        )
      ) {
        historyUpdateCandidateIdsRef.current.delete(incomingJob.id);
      }
      historyJobRestoreIdsRef.current.delete(incomingJob.id);
    }
    if (mutationLeaseSettled && settlingArchiveLease) {
      void requestHistoryRestore(null, true);
    }
  }

  function applyHistoryPage(page: JobHistory, append = false) {
    const pageItems = historyItemsFromPage(page);
    const authoritativeMutationJobIds = new Set(
      mutationLeaseJobIds(historyMutationLeaseRef.current),
    );
    const mutationLeaseSettled = settlePersistedMutationLease(
      "history",
      pageItems.map((item) => item.job),
      false,
    );
    const resolvedJobIds = new Set(pageItems.map((item) => item.id));
    const incomingJobsById = new Map(
      pageItems.map((item) => [item.id, item.job]),
    );
    const currentActiveId = activeJobIdRef.current;
    const currentActiveJob = currentActiveId === null
      ? null
      : jobsRef.current.find((candidate) => candidate.id === currentActiveId) ?? null;
    const nextJobs = jobsRef.current.map((candidate) => {
      const incomingJob = incomingJobsById.get(candidate.id);
      return incomingJob
        ? (
            mutationLeaseSettled
              && authoritativeMutationJobIds.has(incomingJob.id)
              ? incomingJob
              : newerHistoryJob(candidate, incomingJob)
          )
        : candidate;
    });
    const reconciledActiveJob = currentActiveId === null
      ? null
      : nextJobs.find((candidate) => candidate.id === currentActiveId) ?? null;
    const activeJobUpdated = currentActiveJob !== null
      && reconciledActiveJob !== null
      && reconciledActiveJob !== currentActiveJob;
    if (nextJobs.some((candidate, index) => candidate !== jobsRef.current[index])) {
      updateJobs(() => nextJobs);
    }
    if (
      activeJobUpdated
      && (
        !formDirtyRef.current
        || (
          currentActiveId !== null
          && (
            historyUpdateCandidateIdsRef.current.has(currentActiveId)
            || (
              mutationLeaseSettled
              && authoritativeMutationJobIds.has(currentActiveId)
            )
          )
        )
      )
    ) {
      alignWorkspaceToJob(reconciledActiveJob);
    }
    for (const item of pageItems) {
      if (!mutationLeaseTargetsJob(historyMutationLeaseRef.current, item.id)) {
        historyUpdateCandidateIdsRef.current.delete(item.id);
      }
      historyJobRestoreIdsRef.current.delete(item.id);
    }
    setHistoryTotal(page.total);
    setHistory((current) => {
      let items = append
        ? mergeHistoryItems(current, pageItems)
        : reconcileHistoryItems(current, pageItems);
      if (mutationLeaseSettled && authoritativeMutationJobIds.size > 0) {
        const authoritativeItems = new Map(
          pageItems
            .filter((item) => authoritativeMutationJobIds.has(item.id))
            .map((item) => [item.id, item]),
        );
        items = items.map((item) =>
          authoritativeItems.get(item.id) ?? item,
        );
      }
      const historyCached = writeHistory(items);
      const totalCached = writeHistoryTotal(page.total);
      if (
        historyCached
        && totalCached
        && !hasPendingHistoryJobRestore(resolvedJobIds)
        && !items.some((item) => item.job.recommendation_pending)
        && historyMutationLeaseRef.current === null
      ) {
        markHistorySessionSynced();
      } else {
        markHistorySessionUnsynced();
      }
      return items;
    });
  }

  function applyHistorySearchPage(page: JobHistory, append = false) {
    const pageItems = historyItemsFromPage(page);
    setHistorySearchTotal(page.total);
    setHistorySearchSnapshotVersion(page.snapshot_version ?? null);
    setHistorySearchResults((current) => {
      if (!append || current === null) {
        return reconcileHistoryItems(current ?? [], pageItems);
      }
      return mergeHistoryItems(current, pageItems);
    });
  }

  function clearHistorySearch() {
    historySearchRequestRef.current += 1;
    setHistorySearchOpen(false);
    setHistorySearchInput("");
    setHistorySearchQuery("");
    setHistorySearchResults(null);
    setHistorySearchTotal(0);
    setHistorySearchSnapshotVersion(null);
  }

  async function onSearchHistory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = historySearchInput.trim();
    if (!query) {
      clearHistorySearch();
      return;
    }

    const requestId = ++historySearchRequestRef.current;
    setHistoryLoading(true);
    setError(null);
    try {
      const page = await getHistory(0, query);
      if (requestId !== historySearchRequestRef.current) {
        return;
      }
      setHistorySearchQuery(query);
      applyHistorySearchPage(page);
    } catch (historyError) {
      if (requestId === historySearchRequestRef.current) {
        setError(messageFromError(historyError, "Could not search saved history"));
      }
    } finally {
      setHistoryLoading(false);
    }
  }

  async function revalidateHistorySearch(query: string) {
    const requestId = ++historySearchRequestRef.current;
    const loadedCount = Math.max(
      historySearchResults?.length ?? 0,
      HISTORY_CACHE_LIMIT,
    );
    try {
      const page = await getHistorySearchExtent(query, loadedCount);
      if (requestId === historySearchRequestRef.current) {
        applyHistorySearchPage(page);
      }
    } catch (historyError) {
      if (requestId === historySearchRequestRef.current) {
        setError(messageFromError(historyError, "Could not refresh history search"));
      }
    }
  }

  async function refreshVisibleHistory() {
    if (!historySearchActive) {
      await syncHistory();
      return;
    }

    setHistoryLoading(true);
    setError(null);
    try {
      await revalidateHistorySearch(historySearchQuery);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadOlderHistory() {
    if (historyLoading || visibleHistory.length >= visibleHistoryTotal) {
      return;
    }

    setHistoryLoading(true);
    setError(null);
    try {
      if (historySearchActive) {
        const requestId = ++historySearchRequestRef.current;
        const page = await getHistory(visibleHistory.length, historySearchQuery);
        if (requestId !== historySearchRequestRef.current) {
          return;
        }
        if (
          historySearchSnapshotVersion !== null
          && page.snapshot_version === historySearchSnapshotVersion
        ) {
          applyHistorySearchPage(page, true);
          return;
        }
        if (page.total === 0) {
          applyHistorySearchPage(page);
          return;
        }
        const rebuiltPage = await getHistorySearchExtent(
          historySearchQuery,
          Math.min(
            visibleHistory.length + HISTORY_CACHE_LIMIT,
            page.total,
          ),
        );
        if (requestId !== historySearchRequestRef.current) {
          return;
        }
        applyHistorySearchPage(rebuiltPage);
        return;
      }
      const page = await getHistory(history.length);
      if (page.total !== historyTotal) {
        applyHistoryPage(await getHistory());
        return;
      }
      applyHistoryPage(page, true);
    } catch (historyError) {
      setError(messageFromError(historyError, "Could not load older history"));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function syncHistory(
    jobIds: string[] | null = null,
    reportErrors = true,
  ): Promise<boolean> {
    const restoreGeneration = historyMutationGenerationRef.current;
    setHistoryLoading(true);
    try {
      const page = jobIds ? await archiveJobs(jobIds) : await getHistory();
      if (
        historyMutationGenerationRef.current !== restoreGeneration
        || historyMutationCountRef.current > 0
      ) {
        markHistorySessionUnsynced();
        if (jobIds === null) {
          historyFullRestoreRequestedRef.current = true;
        }
        historyRestoreRetryRequestedRef.current = true;
        if (
          historyMutationCountRef.current === 0
          && historyRestorePromiseRef.current === null
        ) {
          historyRestoreRetryRequestedRef.current = false;
          requestDeferredHistoryRestore();
        }
        return false;
      }
      applyHistoryPage(page);
      if (jobIds !== null) {
        clearOwnedMutationLease("processing");
        clearOwnedMutationLease("history");
      }
      return true;
    } catch (historyError) {
      if (jobIds !== null) {
        if (mutationFailureMayHavePersistedSideEffect(historyError)) {
          scheduleMutationLeaseRevalidation();
        } else {
          clearOwnedMutationLease("processing");
          clearOwnedMutationLease("history");
        }
      }
      if (reportErrors) {
        setError(messageFromError(historyError, "Could not load saved history"));
      }
      return false;
    } finally {
      setHistoryLoading(false);
    }
  }

  function appendJob(created: JobRecord) {
    updateJobs((current) => [...current, created]);
    activateJob(created);
  }

  function applyApprovedJob(approved: JobRecord, fallbackState: CanonicalState) {
    const approvedState = approved.approved_state ?? { ...fallbackState, user_approved: true };
    const approvedForm = stateToForm(approvedState);
    replaceJob(approved);
    formBaselineRef.current = approvedForm;
    formDirtyRef.current = false;
    setForm(approvedForm);
    setApprovedStateKey(approvalKey(approvedState));
  }

  function applyRecommendedJob(recommended: JobRecord) {
    replaceJob(recommended);
    if (recommended.approved_state) {
      setApprovedStateKey(approvalKey(recommended.approved_state));
    }
  }

  async function runConfiguredAutomation(
    created: JobRecord,
    recommendationRequestId: string | null,
    signal?: AbortSignal,
  ): Promise<JobRecord> {
    if (!automationApprove) {
      return created;
    }
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const approvalState = autoApprovalState(created, automationAllowWarnings);
    markPersistedJobSessionUnsynced(created);
    const approved = preserveUploadRequestId(
      await approveState(created.id, approvalState, signal),
      created,
    );
    applyApprovedJob(approved, approvalState);

    if (!automationRecommend) {
      return approved;
    }

    markPersistedJobSessionUnsynced(approved);
    const recommended = preserveUploadRequestId(
      await requestRecommendation(
        approved.id,
        recommendationRequestId ?? createMutationRequestId(),
        signal,
      ),
      approved,
    );
    applyRecommendedJob(recommended);
    return recommended;
  }

  async function uploadSelectedFiles(
    runAutomation: boolean,
    expectedUploads: ProjectionMutationLease["expectedUploads"],
  ): Promise<JobRecord[]> {
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
    const discardUnstartedUploads = (startIndex: number) => {
      for (let index = startIndex; index < selectedFiles.length; index += 1) {
        updateExpectedUpload(index, "failed");
      }
    };

    for (const [index, selectedFile] of selectedFiles.entries()) {
      if (controller.signal.aborted) {
        skippedCount = selectedFiles.length - completedCount;
        discardUnstartedUploads(index);
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

      const expectedUploadIndex = index;
      const expectedUpload = expectedUploads[index];
      try {
        const created = await uploadScreenshot(
          selectedFile,
          expectedUpload.requestId,
          controller.signal,
        );
        updateExpectedUpload(
          expectedUploadIndex,
          projectionMutationTarget(
            runAutomation,
            automationApprove,
            automationRecommend,
          ),
        );
        appendJob(created);
        let completed = created;
        if (runAutomation) {
          try {
            completed = await runConfiguredAutomation(
              created,
              expectedUpload.recommendationRequestId,
              controller.signal,
            );
          } catch (automationError) {
            const confirmedJob = jobsRef.current.find(
              (candidate) => candidate.id === created.id,
            ) ?? created;
            if (isAbortError(automationError)) {
              completedJobs.push(confirmedJob);
              completedCount += 1;
              skippedCount = selectedFiles.length - completedCount;
              discardUnstartedUploads(index + 1);
              break;
            }
            if (!mutationFailureMayHavePersistedSideEffect(automationError)) {
              updateExpectedUpload(
                expectedUploadIndex,
                confirmedJob.recommendation !== null
                  ? "recommended"
                  : confirmedJob.approved_state !== null
                    ? "approved"
                    : "parsed",
              );
            }
            const message = messageFromError(automationError, "Automation stopped for this screenshot");
            setJobAttention((current) => ({
              ...current,
              [created.id]: message,
            }));
            completed = confirmedJob;
            attentionMessages.push(`${selectedFile.name}: ${message}`);
            failedCount += 1;
          }
        }
        completedJobs.push(completed);
        completedCount += 1;
      } catch (uploadError) {
        if (isAbortError(uploadError)) {
          skippedCount = selectedFiles.length - completedCount;
          discardUnstartedUploads(index + 1);
          break;
        }
        if (
          uploadError instanceof ApiResponseError
          && !mutationFailureMayHavePersistedSideEffect(uploadError)
        ) {
          updateExpectedUpload(expectedUploadIndex, "failed");
        }
        const message = messageFromError(uploadError, "Upload failed");
        const errorJob = createLocalErrorJob(
          selectedFile,
          message,
          index,
          expectedUpload.requestId,
        );
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
    if (
      files.length === 0
      || mutationRecoveryPending(["processing"])
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    beginProcessingMembershipMutation();
    const uploadTarget = projectionMutationTarget(
      automationEnabled,
      automationApprove,
      automationRecommend,
    );
    const expectedUploads = files.map(() => ({
      requestId: createMutationRequestId(),
      target: uploadTarget,
      recommendationRequestId: uploadTarget === "recommended"
        ? createMutationRequestId()
        : null,
    }));
    installMutationLease(
      "processing",
      startProjectionMutationLease(
        "processing",
        mutationOwnerId,
        processingJobsForCache(jobsRef.current),
        expectedUploads,
      ),
    );
    try {
      const completedJobs = await uploadSelectedFiles(
        automationEnabled,
        expectedUploads,
      );
      settlePersistedMutationLease("processing", completedJobs, false);
      if (processingMutationLeaseRef.current !== null) {
        scheduleMutationLeaseRevalidation();
      }
    } catch (uploadError) {
      scheduleMutationLeaseRevalidation();
      setError(messageFromError(uploadError, "Upload failed"));
    } finally {
      endProcessingMembershipMutation();
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

  async function captureAndParseScreen(
    file: File,
    uploadRequestId: string,
  ): Promise<JobRecord> {
    const created = await uploadScreenshot(file, uploadRequestId);
    appendJob(created);
    return created;
  }

  async function onCaptureScreen() {
    if (mutationRecoveryPending(["processing"])) {
      return;
    }
    setBusy(true);
    setError(null);
    beginProcessingMembershipMutation();
    let expectedUploadIndex: number | null = null;
    let capturedJobId: string | null = null;
    try {
      const captureFile = await captureSharedScreenFile();
      installMutationLease(
        "processing",
        startProjectionMutationLease(
          "processing",
          mutationOwnerId,
          processingJobsForCache(jobsRef.current),
        ),
      );
      const uploadTarget = projectionMutationTarget(
        automationEnabled,
        automationApprove,
        automationRecommend,
      );
      const uploadRequestId = createMutationRequestId();
      const recommendationRequestId = uploadTarget === "recommended"
        ? createMutationRequestId()
        : null;
      expectedUploadIndex = trackExpectedUpload(
        uploadRequestId,
        uploadTarget,
        recommendationRequestId,
      );
      const created = await captureAndParseScreen(captureFile, uploadRequestId);
      capturedJobId = created.id;
      updateExpectedUpload(
        expectedUploadIndex,
        uploadTarget,
      );
      let completed = created;
      if (automationEnabled) {
        completed = await runConfiguredAutomation(
          created,
          recommendationRequestId,
        );
      }
      settlePersistedMutationLease("processing", [completed], false);
      if (processingMutationLeaseRef.current !== null) {
        scheduleMutationLeaseRevalidation();
      }
    } catch (captureError) {
      if (
        !isAbortError(captureError)
        && !mutationFailureMayHavePersistedSideEffect(captureError)
      ) {
        const confirmedJob = capturedJobId === null
          ? null
          : jobsRef.current.find((candidate) => candidate.id === capturedJobId) ?? null;
        updateExpectedUpload(
          expectedUploadIndex,
          confirmedJob === null
            ? "failed"
            : confirmedJob.recommendation !== null
              ? "recommended"
              : confirmedJob.approved_state !== null
                ? "approved"
                : "parsed",
        );
      }
      if (processingMutationLeaseRef.current !== null) {
        scheduleMutationLeaseRevalidation();
      }
      setError(messageFromError(captureError, "Screen capture failed"));
    } finally {
      endProcessingMembershipMutation();
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

    const changesProcessingMembership = job.benchmark_included
      && job.parser_result === null
      && !isPristineBenchmarkImport(job);
    if (mutationRecoveryPending([persistedJobMutationScope(job)])) {
      return;
    }
    const mutationScope = beginPersistedJobMutation(
      job,
      {
        kind: "approval",
        approvedStateKey: approvalKey(validation.state),
      },
      changesProcessingMembership ? [job.id] : [],
    );
    let restoreAfterMutation = changesProcessingMembership;
    setBusy(true);
    setError(null);
    try {
      const approved = await approveState(job.id, validation.state);
      applyApprovedJob(approved, validation.state);
    } catch (approveError) {
      if (mutationFailureMayHavePersistedSideEffect(approveError)) {
        markPersistedJobMutationUncertain(mutationScope, job.id);
      }
      restoreAfterMutation = true;
      setError(messageFromError(approveError, "Approval failed"));
    } finally {
      endPersistedJobMutation(mutationScope, restoreAfterMutation);
      setBusy(false);
    }
  }

  async function onRecommend() {
    if (!job || !canRecommend) {
      return;
    }
    if (mutationRecoveryPending([persistedJobMutationScope(job)])) {
      return;
    }
    const changesProcessingMembership = isPristineBenchmarkImport(job);
    const recommendationRequestId = createMutationRequestId();
    let decisionExpectation: JobMutationExpectation | null = null;
    if (trainingAction) {
      const parsedSizing = parseTrainingSizing(trainingAction, trainingSizing);
      if (parsedSizing.error) {
        setError(parsedSizing.error);
        return;
      }
      const decisionChanged = !job.training_decision
        || job.training_decision.action !== trainingAction
        || job.training_decision.sizing !== parsedSizing.sizing
        || (job.training_decision.certainty ?? null) !== (trainingCertainty || null);
      if (decisionChanged) {
        decisionExpectation = {
          kind: "training-decision",
          action: trainingAction,
          sizing: parsedSizing.sizing,
          certainty: trainingCertainty || null,
        };
      }
    }
    const mutationScope = beginPersistedJobMutation(
      job,
      decisionExpectation,
    );
    let recommendationStarted = false;
    let restoreAfterMutation = changesProcessingMembership;
    setBusy(true);
    setError(null);
    try {
      if (decisionExpectation?.kind === "training-decision") {
        replaceJob(await recordTrainingDecision(
          job.id,
          decisionExpectation.action,
          decisionExpectation.sizing,
          decisionExpectation.certainty,
        ));
      }
      if (!armPersistedRecommendationLease(
        mutationScope,
        job.id,
        recommendationRequestId,
      )) {
        return;
      }
      recommendationStarted = true;
      applyRecommendedJob(await requestRecommendation(
        job.id,
        recommendationRequestId,
      ));
    } catch (recommendError) {
      if (
        recommendationStarted
          ? recommendationAttemptMayHavePersistedSideEffect(recommendError)
          : mutationFailureMayHavePersistedSideEffect(recommendError)
      ) {
        markPersistedJobMutationUncertain(mutationScope, job.id);
      }
      restoreAfterMutation = restoreAfterMutation || recommendationStarted;
      setError(messageFromError(recommendError, "Recommendation failed"));
    } finally {
      endPersistedJobMutation(mutationScope, restoreAfterMutation);
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
    if (mutationRecoveryPending([persistedJobMutationScope(job)])) {
      return;
    }

    const changesProcessingMembership = isPristineBenchmarkImport(job);
    const mutationScope = beginPersistedJobMutation(job, {
      kind: "training-decision",
      action: trainingAction,
      sizing: parsedSizing.sizing,
      certainty: trainingCertainty || null,
    });
    let restoreAfterMutation = changesProcessingMembership;
    setBusy(true);
    setError(null);
    try {
      replaceJob(await recordTrainingDecision(
        job.id,
        trainingAction,
        parsedSizing.sizing,
        trainingCertainty || null,
      ));
      toast.success("Training answer locked");
    } catch (decisionError) {
      if (mutationFailureMayHavePersistedSideEffect(decisionError)) {
        markPersistedJobMutationUncertain(mutationScope, job.id);
      }
      restoreAfterMutation = true;
      setError(messageFromError(decisionError, "Could not save your training answer"));
    } finally {
      endPersistedJobMutation(mutationScope, restoreAfterMutation);
      setBusy(false);
    }
  }

  async function onCompleteTrainingReview() {
    if (!job || !activeTrainingDecision || !activeRecommendation || decisionComparison?.tone === "match") {
      return;
    }
    if (mutationRecoveryPending([persistedJobMutationScope(job)])) {
      return;
    }

    const continueReviewQueue = trainingReviewQueueJobId === job.id;
    const reviewNote = trainingReviewNote.trim() || null;
    const mutationScope = beginPersistedJobMutation(job, {
      kind: "training-review",
      reviewed: true,
      note: reviewNote,
    });
    let restoreAfterMutation = false;
    setBusy(true);
    setError(null);
    try {
      const reviewedJob = await completeTrainingReview(
        job.id,
        reviewNote,
      );
      replaceJob(reviewedJob);
      if (!continueReviewQueue) {
        toast.success("Training review completed");
        return;
      }

      try {
        const progress = await getTrainingProgress(
          trainingReviewOrder,
          trainingReviewStreet,
          trainingReviewDifference,
          trainingReviewCertainty,
          trainingLessonStreet,
          trainingLessonQuery,
          trainingLessonOrder,
          null,
          null,
          null,
          null,
          trainingReviewPosition,
        );
        setTrainingProgress(progress);
        const nextHand = progress.review_queue[0] ?? null;
        if (!nextHand) {
          setTrainingReviewQueueJobId(null);
          setTrainingProgressView("review");
          setTrainingDialogOpen(true);
          toast.success("Review queue completed");
          return;
        }

        const nextJob = await getJob(nextHand.job_id);
        upsertAndActivateJob(nextJob);
        setTrainingReviewQueueJobId(nextJob.id);
        toast.success("Training review completed. Next hand ready");
      } catch (continueError) {
        setTrainingReviewQueueJobId(null);
        setError(messageFromError(
          continueError,
          "Review completed, but the next training hand could not be loaded",
        ));
      }
    } catch (reviewError) {
      if (mutationFailureMayHavePersistedSideEffect(reviewError)) {
        markPersistedJobMutationUncertain(mutationScope, job.id);
      }
      restoreAfterMutation = true;
      setError(messageFromError(reviewError, "Could not complete training review"));
    } finally {
      endPersistedJobMutation(mutationScope, restoreAfterMutation);
      setBusy(false);
    }
  }

  async function onReopenTrainingReview() {
    if (!job || !activeTrainingDecision || !activeRecommendation || decisionComparison?.tone === "match" || !job.training_reviewed_at) {
      return;
    }
    if (mutationRecoveryPending([persistedJobMutationScope(job)])) {
      return;
    }

    const mutationScope = beginPersistedJobMutation(job, {
      kind: "training-review",
      reviewed: false,
      note: null,
    });
    let restoreAfterMutation = false;
    setBusy(true);
    setError(null);
    try {
      const reopenedJob = await reopenTrainingReview(job.id);
      replaceJob(reopenedJob);
      toast.success("Training review reopened");
    } catch (reviewError) {
      if (mutationFailureMayHavePersistedSideEffect(reviewError)) {
        markPersistedJobMutationUncertain(mutationScope, job.id);
      }
      restoreAfterMutation = true;
      setError(messageFromError(reviewError, "Could not reopen training review"));
    } finally {
      endPersistedJobMutation(mutationScope, restoreAfterMutation);
      setBusy(false);
    }
  }

  function startTrainingReviewNoteEdit() {
    setTrainingReviewNote(job?.training_review_note ?? "");
    setTrainingReviewNoteEditing(true);
  }

  function cancelTrainingReviewNoteEdit() {
    setTrainingReviewNote(job?.training_review_note ?? "");
    setTrainingReviewNoteEditing(false);
  }

  async function onUpdateTrainingReviewNote() {
    if (
      !job
      || !activeTrainingDecision
      || !activeRecommendation
      || decisionComparison?.tone === "match"
      || !job.training_reviewed_at
    ) {
      return;
    }
    if (mutationRecoveryPending([persistedJobMutationScope(job)])) {
      return;
    }

    const note = trainingReviewNote.trim() || null;
    const mutationScope = beginPersistedJobMutation(job, {
      kind: "training-review",
      reviewed: true,
      note,
    });
    let restoreAfterMutation = false;
    setBusy(true);
    setError(null);
    try {
      const updatedJob = await completeTrainingReview(job.id, note);
      replaceJob(updatedJob);
      setTrainingReviewNoteEditing(false);
      toast.success(note ? "Lesson note updated" : "Lesson note removed");
    } catch (reviewError) {
      if (mutationFailureMayHavePersistedSideEffect(reviewError)) {
        markPersistedJobMutationUncertain(mutationScope, job.id);
      }
      restoreAfterMutation = true;
      setError(messageFromError(reviewError, "Could not update lesson note"));
    } finally {
      endPersistedJobMutation(mutationScope, restoreAfterMutation);
      setBusy(false);
    }
  }

  async function reopenTrainingReviewFromProgress(jobId: string) {
    let persistedJob = jobsRef.current.find(
      (candidate) => candidate.id === jobId,
    )
      ?? history.find((item) => item.id === jobId)?.job
      ?? historySearchResults?.find((item) => item.id === jobId)?.job
      ?? null;
    let mutationScope: PersistedJobMutationScope | null = null;
    let reviewPersisted = false;
    let restoreAfterMutation = false;
    setTrainingReviewJobId(jobId);
    setError(null);
    try {
      persistedJob ??= await getJob(jobId);
      if (mutationRecoveryPending([persistedJobMutationScope(persistedJob)])) {
        return;
      }
      mutationScope = beginPersistedJobMutation(persistedJob, {
        kind: "training-review",
        reviewed: false,
        note: null,
      });
      const reopenedJob = await reopenTrainingReview(jobId);
      reviewPersisted = true;
      updateJobs((current) =>
        current.map((candidate) => (candidate.id === reopenedJob.id ? reopenedJob : candidate)),
      );
      updateHistoryJob(reopenedJob);
      setTrainingProgress(await getTrainingProgress(
        trainingReviewOrder,
        trainingReviewStreet,
        trainingReviewDifference,
        trainingReviewCertainty,
        trainingLessonStreet,
        trainingLessonQuery,
        trainingLessonOrder,
        trainingSolverFilter,
        trainingPositionFilter,
        trainingStreetFilter,
        trainingCertaintyFilter,
        trainingReviewPosition,
      ));
      toast.success("Training review reopened");
    } catch (reviewError) {
      if (mutationScope !== null) {
        if (
          !reviewPersisted
          && mutationFailureMayHavePersistedSideEffect(reviewError)
        ) {
          markPersistedJobMutationUncertain(mutationScope, jobId);
        }
        restoreAfterMutation = !reviewPersisted;
      }
      setError(messageFromError(reviewError, "Could not reopen training review"));
    } finally {
      if (mutationScope !== null) {
        endPersistedJobMutation(mutationScope, restoreAfterMutation);
      }
      setTrainingReviewJobId(null);
    }
  }

  function updateForm<K extends keyof StateForm>(field: K, value: StateForm[K]) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (
        (
          (field === "street" && value !== "preflop")
          || (field === "facing_action" && value !== "raise")
        )
        && next.preflop_action_history.length === 0
      ) {
        next.preflop_opener_position = "";
        next.preflop_open_size = "";
      }
      const usesPostflopHistory = next.facing_action === "raise"
        && next.street !== ""
        && next.street !== "preflop";
      if (!usesPostflopHistory) {
        next.opponent_stack = "";
        next.postflop_action_history = [];
      }
      const usesOpponentPosition = requiresOpponentPosition(next);
      if (!usesOpponentPosition) {
        next.opponent_position = "";
      }
      const usesCommittedOpponentCount = Number(next.current_bet) > 0
        && Number(next.players_in_hand) > 2;
      if (!usesCommittedOpponentCount) {
        next.opponents_at_current_bet = "";
        if (Number(next.current_bet) > 0) {
          next.opponent_commitment_total = "";
        }
      }
      if (Number(next.current_bet) <= 0) {
        next.opponent_wager = "";
        if (next.street !== "preflop") {
          next.opponent_commitment_total = "";
        }
      }
      formDirtyRef.current = JSON.stringify(next)
        !== JSON.stringify(formBaselineRef.current);
      return next;
    });
    setApprovedStateKey(null);
  }

  function addPreflopAction() {
    const previous = form.preflop_action_history[
      form.preflop_action_history.length - 1
    ];
    const previousIndex = previous
      ? PREFLOP_POSITIONS.findIndex((position) => position.value === previous.actor)
      : -1;
    const legacyOpener = normalizePreflopPosition(form.preflop_opener_position);
    const heroPosition = normalizePreflopPosition(form.hero_position);
    const actor = form.preflop_action_history.length === 0
      ? (legacyOpener ?? heroPosition ?? "cutoff")
      : (PREFLOP_POSITIONS[previousIndex + 1]?.value ?? "big_blind");
    updateForm("preflop_action_history", [
      ...form.preflop_action_history,
      {
        actor,
        action: "raise",
        amount: form.preflop_action_history.length === 0
          ? form.preflop_open_size
          : "",
      },
    ]);
  }

  function updatePreflopAction(
    index: number,
    field: keyof PreflopActionForm,
    value: string,
  ) {
    const next = form.preflop_action_history.map((action, actionIndex) => (
      actionIndex === index
        ? { ...action, [field]: value } as PreflopActionForm
        : action
    ));
    updateForm("preflop_action_history", next);
  }

  function removePreflopAction(index: number) {
    updateForm(
      "preflop_action_history",
      form.preflop_action_history.filter((_, actionIndex) => actionIndex !== index),
    );
  }

  function addPostflopAction() {
    updateForm("postflop_action_history", [
      ...form.postflop_action_history,
      {
        actor: form.postflop_action_history.length % 2 === 0 ? "oop" : "ip",
        action: "check",
        amount: "",
      },
    ]);
  }

  function updatePostflopAction(
    index: number,
    field: keyof PostflopActionForm,
    value: string,
  ) {
    const next = form.postflop_action_history.map((action, actionIndex) => {
      if (actionIndex !== index) {
        return action;
      }
      const updated = { ...action, [field]: value } as PostflopActionForm;
      if (field === "action" && value === "check") {
        updated.amount = "";
      }
      return updated;
    });
    updateForm("postflop_action_history", next);
  }

  function removePostflopAction(index: number) {
    updateForm(
      "postflop_action_history",
      form.postflop_action_history.filter((_, actionIndex) => actionIndex !== index),
    );
  }

  function resetToParser() {
    if (job?.parser_result) {
      const parserForm = stateToForm(job.parser_result.state);
      formBaselineRef.current = parserForm;
      formDirtyRef.current = false;
      setForm(parserForm);
      setError(null);
      setApprovedStateKey(null);
    }
  }

  function updateAutomationApprove(value: boolean) {
    updateAutomationSettings((current) => ({
      ...current,
      autoApprove: value,
      autoRecommend: value && current.autoRecommend,
    }));
  }

  function updateAutomationSettings(
    updater: (current: AutomationSettings) => AutomationSettings,
  ) {
    setAutomationSettings(updater);
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

  async function onApplicationBackupRestore(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const backupFile = event.target.files?.[0];
    event.target.value = "";
    if (!backupFile || busy || backupRestoring) {
      return;
    }

    setBackupRestoring(true);
    setBusy(true);
    setError(null);
    try {
      const result = await restoreApplicationBackup(backupFile);
      setBenchmarkOverview(null);
      setSelectedBenchmarkReport(null);
      setTrainingProgress(null);
      clearHistorySearch();
      markProcessingQueueSessionUnsynced();
      scheduleProcessingQueueRestore();
      markHistorySessionUnsynced();
      void requestHistoryRestore(null, true);

      const restoredItems = result.imported_jobs
        + result.imported_benchmark_reports;
      const reusedItems = result.reused_jobs
        + result.reused_benchmark_reports;
      const restoredParts = [
        result.imported_jobs > 0
          ? `${result.imported_jobs} new ${result.imported_jobs === 1 ? "hand" : "hands"}`
          : null,
        result.imported_benchmark_reports > 0
          ? `${result.imported_benchmark_reports} benchmark ${result.imported_benchmark_reports === 1 ? "report" : "reports"}`
          : null,
      ].filter((part): part is string => part !== null);
      toast.success(
        restoredItems > 0
          ? `Backup restored: ${restoredParts.join(", ")}`
          : `Backup already present: ${reusedItems} ${reusedItems === 1 ? "record" : "records"} verified`,
      );
    } catch (backupError) {
      setError(messageFromError(backupError, "Could not restore application backup"));
    } finally {
      setBackupRestoring(false);
      setBusy(false);
    }
  }

  function openTrainingDialog() {
    setTrainingReviewQueueJobId(null);
    setTrainingDialogOpen(true);
    setTrainingProgress(null);
    setTrainingProgressView("recent");
    setTrainingReviewOrder("recent");
    setTrainingReviewStreet("all");
    setTrainingReviewCertainty("all");
    setTrainingReviewDifference(null);
    setTrainingReviewPosition(null);
    setTrainingSolverFilter(null);
    setTrainingPositionFilter(null);
    setTrainingStreetFilter(null);
    setTrainingCertaintyFilter(null);
    setTrainingLessonOrder("recent");
    setTrainingLessonStreet("all");
    setTrainingLessonSearch("");
    setTrainingLessonQuery("");
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
    reviewDifference: TrainingReviewDifference | null = trainingReviewDifference,
    reviewCertainty: TrainingReviewCertaintyFilter = trainingReviewCertainty,
    reviewPosition: TrainingPositionFilter | null = trainingReviewPosition,
  ) {
    if (
      (
        reviewOrder === trainingReviewOrder
        && reviewStreet === trainingReviewStreet
        && reviewCertainty === trainingReviewCertainty
        && sameTrainingPositionFilter(reviewPosition, trainingReviewPosition)
        && reviewDifference?.decision_action === trainingReviewDifference?.decision_action
        && reviewDifference?.recommended_action === trainingReviewDifference?.recommended_action
        && trainingSolverFilter === null
        && trainingPositionFilter === null
        && trainingStreetFilter === null
        && trainingCertaintyFilter === null
      )
      || trainingProgressLoading
    ) {
      return;
    }
    const previousOrder = trainingReviewOrder;
    const previousStreet = trainingReviewStreet;
    const previousCertainty = trainingReviewCertainty;
    const previousDifference = trainingReviewDifference;
    const previousReviewPosition = trainingReviewPosition;
    const previousSolverFilter = trainingSolverFilter;
    const previousPositionFilter = trainingPositionFilter;
    const previousStreetFilter = trainingStreetFilter;
    const previousCertaintyFilter = trainingCertaintyFilter;
    setTrainingReviewOrder(reviewOrder);
    setTrainingReviewStreet(reviewStreet);
    setTrainingReviewCertainty(reviewCertainty);
    setTrainingReviewDifference(reviewDifference);
    setTrainingReviewPosition(reviewPosition);
    setTrainingSolverFilter(null);
    setTrainingPositionFilter(null);
    setTrainingStreetFilter(null);
    setTrainingCertaintyFilter(null);
    setTrainingProgressLoading(true);
    setError(null);
    try {
      setTrainingProgress(await getTrainingProgress(
        reviewOrder,
        reviewStreet,
        reviewDifference,
        reviewCertainty,
        trainingLessonStreet,
        trainingLessonQuery,
        trainingLessonOrder,
        null,
        null,
        null,
        null,
        reviewPosition,
      ));
    } catch (trainingError) {
      setTrainingReviewOrder(previousOrder);
      setTrainingReviewStreet(previousStreet);
      setTrainingReviewCertainty(previousCertainty);
      setTrainingReviewDifference(previousDifference);
      setTrainingReviewPosition(previousReviewPosition);
      setTrainingSolverFilter(previousSolverFilter);
      setTrainingPositionFilter(previousPositionFilter);
      setTrainingStreetFilter(previousStreetFilter);
      setTrainingCertaintyFilter(previousCertaintyFilter);
      setError(messageFromError(trainingError, "Could not filter training reviews"));
    } finally {
      setTrainingProgressLoading(false);
    }
  }

  async function updateTrainingLessonFilters(
    lessonStreet: TrainingReviewStreet,
    lessonSearch: string = trainingLessonSearch,
    lessonOrder: TrainingReviewOrder = trainingLessonOrder,
  ) {
    const lessonQuery = lessonSearch.trim();
    if (
      (
        lessonOrder === trainingLessonOrder
        && lessonStreet === trainingLessonStreet
        && lessonQuery === trainingLessonQuery
      )
      || trainingProgressLoading
    ) {
      return;
    }
    const previousOrder = trainingLessonOrder;
    const previousStreet = trainingLessonStreet;
    setTrainingLessonOrder(lessonOrder);
    setTrainingLessonStreet(lessonStreet);
    setTrainingProgressLoading(true);
    setError(null);
    try {
      setTrainingProgress(await getTrainingProgress(
        trainingReviewOrder,
        trainingReviewStreet,
        trainingReviewDifference,
        trainingReviewCertainty,
        lessonStreet,
        lessonQuery,
        lessonOrder,
        trainingSolverFilter,
        trainingPositionFilter,
        trainingStreetFilter,
        trainingCertaintyFilter,
        trainingReviewPosition,
      ));
      setTrainingLessonQuery(lessonQuery);
    } catch (trainingError) {
      setTrainingLessonOrder(previousOrder);
      setTrainingLessonStreet(previousStreet);
      setError(messageFromError(trainingError, "Could not filter saved lessons"));
    } finally {
      setTrainingProgressLoading(false);
    }
  }

  async function focusTrainingReviewStreet(street: Street) {
    setTrainingProgressView("review");
    await updateTrainingReviewQueue(
      trainingReviewOrder,
      street,
      null,
      "all",
      null,
    );
  }

  async function focusTrainingReviewCertainty(certainty: TrainingReviewCertainty) {
    setTrainingProgressView("review");
    await updateTrainingReviewQueue(
      trainingReviewOrder,
      "all",
      null,
      certainty,
      null,
    );
  }

  async function focusTrainingActionDifference(
    difference: TrainingReviewDifference,
  ) {
    setTrainingProgressView("review");
    await updateTrainingReviewQueue(
      trainingReviewOrder,
      "all",
      difference,
      "all",
      null,
    );
  }

  async function focusTrainingReviewPosition(
    position: TrainingPositionFilter,
  ) {
    setTrainingProgressView("review");
    await updateTrainingReviewQueue(
      trainingReviewOrder,
      "all",
      null,
      "all",
      position,
    );
  }

  async function updateTrainingSolverFilter(
    filter: TrainingSolverFilter | null,
  ) {
    setTrainingProgressView("recent");
    if (
      (
        filter?.kind === trainingSolverFilter?.kind
        && (
          filter?.kind === "unattributed"
          || (
            trainingSolverFilter?.kind !== "unattributed"
            && filter?.key === trainingSolverFilter?.key
          )
        )
      )
      || trainingProgressLoading
    ) {
      return;
    }
    const previousSolverFilter = trainingSolverFilter;
    const previousPositionFilter = trainingPositionFilter;
    const previousStreetFilter = trainingStreetFilter;
    const previousCertaintyFilter = trainingCertaintyFilter;
    setTrainingSolverFilter(filter);
    setTrainingPositionFilter(null);
    setTrainingStreetFilter(null);
    setTrainingCertaintyFilter(null);
    setTrainingProgressLoading(true);
    setError(null);
    try {
      setTrainingProgress(await getTrainingProgress(
        trainingReviewOrder,
        trainingReviewStreet,
        trainingReviewDifference,
        trainingReviewCertainty,
        trainingLessonStreet,
        trainingLessonQuery,
        trainingLessonOrder,
        filter,
        null,
        null,
        null,
        trainingReviewPosition,
      ));
    } catch (trainingError) {
      setTrainingSolverFilter(previousSolverFilter);
      setTrainingPositionFilter(previousPositionFilter);
      setTrainingStreetFilter(previousStreetFilter);
      setTrainingCertaintyFilter(previousCertaintyFilter);
      setError(messageFromError(trainingError, "Could not load solver hands"));
    } finally {
      setTrainingProgressLoading(false);
    }
  }

  async function updateTrainingPositionFilter(
    filter: TrainingPositionFilter | null,
  ) {
    setTrainingProgressView("recent");
    if (
      (
        filter?.kind === trainingPositionFilter?.kind
        && (
          filter?.kind === "unpositioned"
          || (
            trainingPositionFilter?.kind === "position"
            && filter?.position === trainingPositionFilter.position
          )
        )
      )
      || trainingProgressLoading
    ) {
      return;
    }
    const previousSolverFilter = trainingSolverFilter;
    const previousPositionFilter = trainingPositionFilter;
    const previousStreetFilter = trainingStreetFilter;
    const previousCertaintyFilter = trainingCertaintyFilter;
    setTrainingSolverFilter(null);
    setTrainingPositionFilter(filter);
    setTrainingStreetFilter(null);
    setTrainingCertaintyFilter(null);
    setTrainingProgressLoading(true);
    setError(null);
    try {
      setTrainingProgress(await getTrainingProgress(
        trainingReviewOrder,
        trainingReviewStreet,
        trainingReviewDifference,
        trainingReviewCertainty,
        trainingLessonStreet,
        trainingLessonQuery,
        trainingLessonOrder,
        null,
        filter,
        null,
        null,
        trainingReviewPosition,
      ));
    } catch (trainingError) {
      setTrainingSolverFilter(previousSolverFilter);
      setTrainingPositionFilter(previousPositionFilter);
      setTrainingStreetFilter(previousStreetFilter);
      setTrainingCertaintyFilter(previousCertaintyFilter);
      setError(messageFromError(trainingError, "Could not load position hands"));
    } finally {
      setTrainingProgressLoading(false);
    }
  }

  async function updateTrainingStreetFilter(
    filter: TrainingStreetFilter | null,
  ) {
    setTrainingProgressView("recent");
    if (
      filter?.street === trainingStreetFilter?.street
      || trainingProgressLoading
    ) {
      return;
    }
    const previousSolverFilter = trainingSolverFilter;
    const previousPositionFilter = trainingPositionFilter;
    const previousStreetFilter = trainingStreetFilter;
    const previousCertaintyFilter = trainingCertaintyFilter;
    setTrainingSolverFilter(null);
    setTrainingPositionFilter(null);
    setTrainingStreetFilter(filter);
    setTrainingCertaintyFilter(null);
    setTrainingProgressLoading(true);
    setError(null);
    try {
      setTrainingProgress(await getTrainingProgress(
        trainingReviewOrder,
        trainingReviewStreet,
        trainingReviewDifference,
        trainingReviewCertainty,
        trainingLessonStreet,
        trainingLessonQuery,
        trainingLessonOrder,
        null,
        null,
        filter,
        null,
        trainingReviewPosition,
      ));
    } catch (trainingError) {
      setTrainingSolverFilter(previousSolverFilter);
      setTrainingPositionFilter(previousPositionFilter);
      setTrainingStreetFilter(previousStreetFilter);
      setTrainingCertaintyFilter(previousCertaintyFilter);
      setError(messageFromError(trainingError, "Could not load street hands"));
    } finally {
      setTrainingProgressLoading(false);
    }
  }

  async function updateTrainingCertaintyFilter(
    filter: TrainingCertaintyFilter | null,
  ) {
    setTrainingProgressView("recent");
    if (
      filter?.certainty === trainingCertaintyFilter?.certainty
      || trainingProgressLoading
    ) {
      return;
    }
    const previousSolverFilter = trainingSolverFilter;
    const previousPositionFilter = trainingPositionFilter;
    const previousStreetFilter = trainingStreetFilter;
    const previousCertaintyFilter = trainingCertaintyFilter;
    setTrainingSolverFilter(null);
    setTrainingPositionFilter(null);
    setTrainingStreetFilter(null);
    setTrainingCertaintyFilter(filter);
    setTrainingProgressLoading(true);
    setError(null);
    try {
      setTrainingProgress(await getTrainingProgress(
        trainingReviewOrder,
        trainingReviewStreet,
        trainingReviewDifference,
        trainingReviewCertainty,
        trainingLessonStreet,
        trainingLessonQuery,
        trainingLessonOrder,
        null,
        null,
        null,
        filter,
        trainingReviewPosition,
      ));
    } catch (trainingError) {
      setTrainingSolverFilter(previousSolverFilter);
      setTrainingPositionFilter(previousPositionFilter);
      setTrainingStreetFilter(previousStreetFilter);
      setTrainingCertaintyFilter(previousCertaintyFilter);
      setError(messageFromError(trainingError, "Could not load certainty hands"));
    } finally {
      setTrainingProgressLoading(false);
    }
  }

  async function reviewTrainingHand(jobId: string, continueReviewQueue = false) {
    setTrainingReviewJobId(jobId);
    setError(null);
    try {
      const reviewJob = await getJob(jobId);
      upsertAndActivateJob(reviewJob);
      setTrainingReviewQueueJobId(
        continueReviewQueue
        && trainingProgress?.review_queue.some((hand) => hand.job_id === reviewJob.id)
          ? reviewJob.id
          : null,
      );
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

  function applyBenchmarkDatasetImportResult(
    result: BenchmarkDatasetImportResult,
  ): number {
    const importedIds = new Set(result.job_ids);
    const dirtyActiveJobId = formDirtyRef.current
      ? activeJobIdRef.current
      : null;
    for (
      const removalCandidateId
      of processingRemovalCandidateIdsRef.current
    ) {
      if (!importedIds.has(removalCandidateId)) {
        processingRemovalCandidateIdsRef.current.delete(removalCandidateId);
      }
    }
    setBenchmarkOverview((current) => ({
      included_cases: result.included_cases,
      latest_report: current?.latest_report ?? null,
      recent_reports: current?.recent_reports ?? [],
    }));
    const nextJobs = jobsRef.current.flatMap((candidate) => {
      if (!importedIds.has(candidate.id)) {
        return [candidate];
      }
      const includedCandidate: JobRecord = {
        ...candidate,
        benchmark_included: true,
      };
      if (!isPristineBenchmarkImport(includedCandidate)) {
        return [includedCandidate];
      }
      if (candidate.id === dirtyActiveJobId) {
        processingRemovalCandidateIdsRef.current.delete(candidate.id);
        return [includedCandidate];
      }
      return [];
    });
    const activeJobRemoved = activeJobIdRef.current !== null
      && !nextJobs.some((candidate) => candidate.id === activeJobIdRef.current);
    updateJobs(() => nextJobs);
    if (activeJobRemoved) {
      alignWorkspaceToJob(nextJobs[0] ?? null);
    }
    setHistory((current) => {
      const next = current.map((item) =>
        importedIds.has(item.id)
          ? { ...item, job: { ...item.job, benchmark_included: true } }
          : item,
      );
      writeHistory(next);
      return next;
    });
    setHistorySearchResults((current) =>
      current?.map((item) =>
        importedIds.has(item.id)
          ? { ...item, job: { ...item.job, benchmark_included: true } }
          : item,
      ) ?? null,
    );
    return result.imported_cases + result.reused_cases;
  }

  async function onBenchmarkDatasetImport(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const datasetFile = input.files?.[0];
    if (!datasetFile || benchmarkOperationsLocked) {
      input.value = "";
      return;
    }
    if (mutationRecoveryPending(["processing", "history"])) {
      input.value = "";
      return;
    }

    const removalCandidateIds = jobsRef.current
      .filter((candidate) => isPristineBenchmarkImport({
        ...candidate,
        benchmark_included: true,
      }))
      .map((candidate) => candidate.id);
    const benchmarkImportRequestId = createMutationRequestId();
    installMutationLease(
      "processing",
      startProjectionMutationLease(
        "processing",
        mutationOwnerId,
        processingJobsForCache(jobsRef.current),
        [],
        removalCandidateIds,
        benchmarkImportRequestId,
      ),
    );
    installMutationLease(
      "history",
      startProjectionMutationLease(
        "history",
        mutationOwnerId,
        history.map((item) => item.job),
        [],
        [],
        benchmarkImportRequestId,
      ),
    );
    beginProcessingMembershipMutation(removalCandidateIds);
    setBenchmarkImporting(true);
    setError(null);
    let restoreAfterImport = false;
    try {
      const result = await importBenchmarkDataset(
        datasetFile,
        benchmarkImportRequestId,
      );
      const readyCases = applyBenchmarkDatasetImportResult(result);
      restoreAfterImport = true;
      clearOwnedMutationLease("processing");
      clearOwnedMutationLease("history");
      toast.success(`Dataset ready: ${readyCases} ${readyCases === 1 ? "hand" : "hands"}`);
    } catch (benchmarkError) {
      const deterministicRejection = benchmarkError instanceof ApiResponseError
        && benchmarkError.status >= 400
        && benchmarkError.status < 500
        && benchmarkError.status !== 408;
      if (deterministicRejection) {
        clearOwnedMutationLease("processing");
        clearOwnedMutationLease("history");
        for (const removalCandidateId of removalCandidateIds) {
          processingRemovalCandidateIdsRef.current.delete(removalCandidateId);
        }
        restoreAfterImport = true;
      } else {
        scheduleMutationLeaseRevalidation();
      }
      setError(messageFromError(benchmarkError, "Could not import parser dataset"));
    } finally {
      input.value = "";
      endProcessingMembershipMutation(restoreAfterImport);
      setBenchmarkImporting(false);
    }
  }

  async function toggleBenchmarkInclusion() {
    if (!job || (!job.approved_state && !job.benchmark_included)) {
      return;
    }
    if (mutationRecoveryPending([persistedJobMutationScope(job)])) {
      return;
    }
    const included = !job.benchmark_included;
    const isCurrentlyPristine = isPristineBenchmarkImport(job);
    const willBePristine = isPristineBenchmarkImport({
      ...job,
      benchmark_included: included,
    });
    const changesProcessingMembership = isCurrentlyPristine !== willBePristine;
    const mutationScope = beginPersistedJobMutation(
      job,
      {
        kind: "benchmark-inclusion",
        included,
      },
      changesProcessingMembership && willBePristine ? [job.id] : [],
    );
    let restoreAfterMutation = changesProcessingMembership;
    setBenchmarkUpdating(true);
    setError(null);
    try {
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
      if (mutationFailureMayHavePersistedSideEffect(benchmarkError)) {
        markPersistedJobMutationUncertain(mutationScope, job.id);
      }
      restoreAfterMutation = true;
      setError(messageFromError(benchmarkError, "Could not update benchmark ground truth"));
    } finally {
      endPersistedJobMutation(mutationScope, restoreAfterMutation);
      setBenchmarkUpdating(false);
    }
  }

  async function onRunBenchmark() {
    if (
      benchmarkOperationsLocked
      || mutationRecoveryPending(["processing", "history"])
    ) {
      return;
    }
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
      upsertAndActivateJob(reviewJob);
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
    updateJobs((current) => {
      const existing = current.some((candidate) => candidate.id === item.job.id);
      if (existing) {
        return current.map((candidate) => (candidate.id === item.job.id ? item.job : candidate));
      }
      return [item.job, ...current];
    });
    activateJob(item.job);
  }

  async function clearReviewedToHistory() {
    const readyJobs = jobs.filter(isHistoryReady);
    if (
      readyJobs.length === 0
      || mutationRecoveryPending(["processing", "history"])
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    installMutationLease(
      "processing",
      startArchiveMutationLease(
        "processing",
        mutationOwnerId,
        readyJobs,
        new Set(
          processingJobsForCache(jobsRef.current).map(
            (candidate) => candidate.id,
          ),
        ),
      ),
    );
    installMutationLease(
      "history",
      startArchiveMutationLease(
        "history",
        mutationOwnerId,
        readyJobs,
      ),
    );
    beginProcessingMembershipMutation();
    beginHistoryMutation();
    let historyMutationActive = true;
    try {
      applyHistoryPage(await archiveJobs(readyJobs.map((candidate) => candidate.id)));
      clearOwnedMutationLease("processing");
      clearOwnedMutationLease("history");
      if (historySearchActive && historySearchQuery) {
        void revalidateHistorySearch(historySearchQuery);
      }
      const remainingJobs = jobs.filter((candidate) => !isHistoryReady(candidate));
      updateJobs(() => remainingJobs);
      if (remainingJobs.length > 0) {
        activateJob(remainingJobs.find((candidate) => candidate.id === activeJobId) ?? remainingJobs[0]);
      } else {
        alignWorkspaceToJob(null);
        setError(null);
      }
    } catch (historyError) {
      const archiveErrorMessage = messageFromError(
        historyError,
        "Could not save reviewed hands to history",
      );
      endHistoryMutation();
      historyMutationActive = false;
      const historyReconciled = await syncHistory(null, false);
      if (historyReconciled && historySearchActive && historySearchQuery) {
        await revalidateHistorySearch(historySearchQuery);
      } else if (!historyReconciled) {
        markHistorySessionUnsynced();
      }
      if (mutationFailureMayHavePersistedSideEffect(historyError)) {
        scheduleMutationLeaseRevalidation();
      } else {
        clearOwnedMutationLease("processing");
        clearOwnedMutationLease("history");
      }
      setError(archiveErrorMessage);
    } finally {
      if (historyMutationActive) {
        endHistoryMutation();
      }
      endProcessingMembershipMutation();
      setBusy(false);
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
            <strong>{historyTotal}</strong>
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
              onClick={() => updateAutomationSettings((current) => ({
                ...current,
                enabled: !current.enabled,
              }))}
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
                  disabled={historyLoading || busy || clearableJobs.length === 0}
                  title="Clear reviewed to history"
                  aria-label="Clear reviewed"
                >
                  <Archive size={13} aria-hidden="true" />
                </button>
              </span>
            </div>
            {jobs.length > 0 ? (
              <div className="batch-list">
                {jobs.map((candidate, index) => {
                  const attention = jobAttention[candidate.id];
                  const className = [
                    "batch-item",
                    candidate.id === job?.id ? "active" : "",
                    attention ? "attention" : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      className={className}
                      onClick={() => activateJob(candidate)}
                      disabled={busy}
                      aria-label={`Open screenshot ${index + 1}: ${candidate.original_filename}`}
                    >
                      <span className="batch-number">{index + 1}</span>
                      <span className="batch-text">
                        <span>{candidate.original_filename}</span>
                        <small>{queueDetail(candidate, attention)}</small>
                      </span>
                      <StatusPill status={candidate.status} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="pending-files">{files.length > 0 ? selectedFilesLabel(files) : "No screenshots uploaded or captured yet"}</div>
            )}
          </section>

          <section className="history-panel" aria-label="Session history">
            <div className="rail-section-heading history-heading">
              <span>
                {historySearchActive
                  ? `History · ${historySearchTotal} ${historySearchTotal === 1 ? "match" : "matches"}`
                  : "History · reopen"}
              </span>
              <span className="history-heading-actions">
                <span className="autosaved-pill">Auto-saved</span>
                <button
                  type="button"
                  className={historySearchOpen ? "history-search-toggle active" : "history-search-toggle"}
                  onClick={() => {
                    if (historySearchOpen) {
                      clearHistorySearch();
                    } else {
                      setHistorySearchOpen(true);
                    }
                  }}
                  disabled={historyLoading || busy}
                  title={historySearchOpen ? "Close history search" : "Search saved history"}
                  aria-label={historySearchOpen ? "Close history search" : "Search saved history"}
                >
                  {historySearchOpen ? <X size={12} aria-hidden="true" /> : <Search size={12} aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  className="history-refresh"
                  onClick={() => void refreshVisibleHistory()}
                  disabled={historyLoading || busy}
                  title={historySearchActive ? "Refresh history search" : "Refresh saved history"}
                  aria-label={historySearchActive ? "Refresh history search" : "Refresh saved history"}
                >
                  <RefreshCcw size={12} aria-hidden="true" />
                </button>
              </span>
            </div>
            {historySearchOpen ? (
              <form className="history-search-form" onSubmit={(event) => void onSearchHistory(event)}>
                <label className="sr-only" htmlFor="history-search-query">History search query</label>
                <input
                  id="history-search-query"
                  type="search"
                  value={historySearchInput}
                  onChange={(event) => setHistorySearchInput(event.target.value)}
                  placeholder="Cards, street, action..."
                  maxLength={100}
                  disabled={historyLoading || busy}
                  autoComplete="off"
                  autoFocus
                />
                <button
                  type="submit"
                  disabled={historyLoading || busy || historySearchInput.trim().length === 0}
                  title="Run history search"
                  aria-label="Run history search"
                >
                  <Search size={12} aria-hidden="true" />
                </button>
              </form>
            ) : null}
            {visibleHistory.length > 0 ? (
              <div className="history-list">
                {visibleHistory.map((item, index) => {
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
                {visibleHistory.length < visibleHistoryTotal ? (
                  <button
                    type="button"
                    className="history-load-older"
                    onClick={() => void loadOlderHistory()}
                    disabled={historyLoading || busy}
                    aria-label="Load older history"
                  >
                    <ChevronDown size={12} aria-hidden="true" />
                    <span>
                      {historyLoading
                        ? "Loading..."
                        : `Load ${visibleHistoryTotal - visibleHistory.length} older`}
                    </span>
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="history-empty">
                {historyLoading
                  ? "Loading saved history..."
                  : historySearchActive
                    ? "No saved hands match this search."
                    : "Cleared reviewed hands will appear here."}
              </div>
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
                <select disabled={stateControlsDisabled} value={form.street} onChange={(event) => updateForm("street", event.target.value as StreetOption)}>
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
              {Number(form.current_bet) > 0 && Number(form.players_in_hand) > 2 ? (
                <Field label="Opponents at wager" confidence="manual">
                  <input
                    disabled={stateControlsDisabled}
                    inputMode="numeric"
                    min="1"
                    max={Math.max(1, Number(form.players_in_hand) - 1)}
                    value={form.opponents_at_current_bet}
                    onChange={(event) => updateForm("opponents_at_current_bet", event.target.value)}
                    placeholder="Already committed"
                  />
                </Field>
              ) : null}
              {Number(form.current_bet) > 0 && (
                form.street === "preflop"
                || form.facing_action === "raise"
                || form.opponent_wager !== ""
              ) ? (
                <Field label="Opponent wager total" confidence="manual">
                  <input
                    disabled={stateControlsDisabled}
                    inputMode="decimal"
                    min={form.current_bet || "0"}
                    value={form.opponent_wager}
                    onChange={(event) => updateForm("opponent_wager", event.target.value)}
                    placeholder="Total BB committed"
                  />
                </Field>
              ) : null}
              {(form.street === "preflop" && Number(form.current_bet) <= 0)
                || (
                  Number(form.current_bet) > 0
                  && Number(form.players_in_hand) > 2
                  && (
                    form.street === "preflop"
                    || form.facing_action === "raise"
                    || form.opponent_commitment_total !== ""
                  )
                ) ? (
                  <Field label="Opponent commitments total" confidence="manual">
                    <input
                      disabled={stateControlsDisabled}
                      inputMode="decimal"
                      min="0"
                      value={form.opponent_commitment_total}
                      onChange={(event) => updateForm(
                        "opponent_commitment_total",
                        event.target.value,
                      )}
                      placeholder="All opponents, BB"
                    />
                  </Field>
                ) : null}
              <Field label="Hero position" confidence={confidenceLabel(confidences.hero_position)} confidenceValue={confidences.hero_position}>
                <input disabled={stateControlsDisabled} value={form.hero_position} onChange={(event) => updateForm("hero_position", event.target.value)} />
              </Field>
              {requiresOpponentPosition(form) ? (
                  <Field label="Opponent position" confidence={confidenceLabel(confidences.opponent_position)} confidenceValue={confidences.opponent_position}>
                    <input disabled={stateControlsDisabled} value={form.opponent_position} onChange={(event) => updateForm("opponent_position", event.target.value)} />
                  </Field>
                ) : null}
              <Field label="Facing action" confidence={confidenceLabel(confidences.facing_action)} confidenceValue={confidences.facing_action}>
                <select disabled={stateControlsDisabled} value={form.facing_action} onChange={(event) => updateForm("facing_action", event.target.value as FacingActionOption)}>
                  <option value="">Select action</option>
                  <option value="bet">Bet</option>
                  <option value="raise">Raise or check-raise</option>
                </select>
              </Field>
              {form.street !== "" && form.street !== "preflop" && form.facing_action === "raise" ? (
                <>
                  <Field label="Opponent stack" confidence="manual">
                    <input
                      disabled={stateControlsDisabled}
                      inputMode="decimal"
                      value={form.opponent_stack}
                      onChange={(event) => updateForm("opponent_stack", event.target.value)}
                      placeholder="BB behind"
                    />
                  </Field>
                  <div className="action-history-field">
                    <div className="action-history-header">
                      <div>
                        <strong>Postflop history (total BB)</strong>
                      </div>
                      <button
                        type="button"
                        className="action-history-add"
                        disabled={stateControlsDisabled || form.postflop_action_history.length >= 8}
                        onClick={addPostflopAction}
                      >
                        <Plus size={13} aria-hidden="true" />
                        Add action
                      </button>
                    </div>
                    {form.postflop_action_history.length > 0 ? (
                      <div className="action-history-list">
                        {form.postflop_action_history.map((action, index) => (
                          <div className="action-history-row" key={index}>
                            <span>{index + 1}</span>
                            <select
                              aria-label={`Action ${index + 1} actor`}
                              disabled={stateControlsDisabled}
                              value={action.actor}
                              onChange={(event) => updatePostflopAction(index, "actor", event.target.value)}
                            >
                              <option value="oop">OOP</option>
                              <option value="ip">IP</option>
                            </select>
                            <select
                              aria-label={`Action ${index + 1} type`}
                              disabled={stateControlsDisabled}
                              value={action.action}
                              onChange={(event) => updatePostflopAction(index, "action", event.target.value)}
                            >
                              <option value="check">Check</option>
                              <option value="bet">Bet</option>
                              <option value="raise">Raise to</option>
                            </select>
                            <input
                              aria-label={`Action ${index + 1} amount`}
                              disabled={stateControlsDisabled || action.action === "check"}
                              inputMode="decimal"
                              value={action.amount}
                              onChange={(event) => updatePostflopAction(index, "amount", event.target.value)}
                              placeholder={action.action === "check" ? "-" : "BB"}
                            />
                            <button
                              type="button"
                              disabled={stateControlsDisabled}
                              onClick={() => removePostflopAction(index)}
                              title={`Remove action ${index + 1}`}
                              aria-label={`Remove action ${index + 1}`}
                            >
                              <X size={13} aria-hidden="true" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p>No actions recorded</p>
                    )}
                  </div>
                </>
              ) : null}
              {form.street === "preflop" && form.facing_action === "raise" ? (
                <>
                  {form.preflop_action_history.length === 0 ? (
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
                  <div className="action-history-field">
                    <div className="action-history-header">
                      <div>
                        <strong>Preflop history (total BB)</strong>
                      </div>
                      <button
                        type="button"
                        className="action-history-add"
                        disabled={stateControlsDisabled || form.preflop_action_history.length >= 8}
                        onClick={addPreflopAction}
                      >
                        <Plus size={13} aria-hidden="true" />
                        Add preflop action
                      </button>
                    </div>
                    {form.preflop_action_history.length > 0 ? (
                      <div className="action-history-list">
                        {form.preflop_action_history.map((action, index) => (
                          <div className="action-history-row" key={index}>
                            <span>{index + 1}</span>
                            <select
                              aria-label={`Preflop action ${index + 1} actor`}
                              disabled={stateControlsDisabled}
                              value={action.actor}
                              onChange={(event) => updatePreflopAction(index, "actor", event.target.value)}
                            >
                              {PREFLOP_POSITIONS.map((position) => (
                                <option key={position.value} value={position.value}>
                                  {position.label}
                                </option>
                              ))}
                            </select>
                            <select
                              aria-label={`Preflop action ${index + 1} type`}
                              disabled={stateControlsDisabled}
                              value={action.action}
                              onChange={(event) => updatePreflopAction(index, "action", event.target.value)}
                            >
                              <option value="raise">Raise to</option>
                              <option value="call">Call</option>
                            </select>
                            <input
                              aria-label={`Preflop action ${index + 1} amount`}
                              disabled={stateControlsDisabled}
                              inputMode="decimal"
                              value={action.amount}
                              onChange={(event) => updatePreflopAction(index, "amount", event.target.value)}
                              placeholder="BB"
                            />
                            <button
                              type="button"
                              disabled={stateControlsDisabled}
                              onClick={() => removePreflopAction(index)}
                              title={`Remove preflop action ${index + 1}`}
                              aria-label={`Remove preflop action ${index + 1}`}
                            >
                              <X size={13} aria-hidden="true" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p>No actions recorded</p>
                    )}
                  </div>
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
                <div className="training-certainty">
                  <span>How sure?</span>
                  <div role="group" aria-label="How sure are you?">
                    {TRAINING_CERTAINTIES.map((certainty) => (
                      <button
                        key={certainty}
                        type="button"
                        className={trainingCertainty === certainty ? "active" : undefined}
                        aria-pressed={trainingCertainty === certainty}
                        onClick={() => setTrainingCertainty(
                          trainingCertainty === certainty ? "" : certainty,
                        )}
                        disabled={busy}
                      >
                        {certainty}
                      </button>
                    ))}
                  </div>
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
                  ) : null}
                  <span className="training-decision-hint">
                    {activeTrainingDecision
                      ? "Saved before reveal"
                      : trainingAction
                        ? "Ready to lock"
                        : "No answer selected"}
                  </span>
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
                      {activeTrainingDecision.certainty ? (
                        <small className="training-comparison-certainty">
                          {trainingCertaintyLabel(activeTrainingDecision.certainty)} certainty
                        </small>
                      ) : null}
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
                            <button
                              type="button"
                              onClick={onReopenTrainingReview}
                              disabled={busy || trainingReviewNoteEditing}
                            >
                              <RefreshCcw size={11} aria-hidden="true" />
                              Reopen review
                            </button>
                          </div>
                        ) : (
                          <button type="button" onClick={onCompleteTrainingReview} disabled={busy}>
                            <Check size={12} aria-hidden="true" />
                            {trainingReviewQueueJobId === job?.id
                              ? "Mark reviewed & next"
                              : "Mark reviewed"}
                          </button>
                        )
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {activeTrainingDecision
                  && decisionComparison
                  && decisionComparison.tone !== "match" ? (
                    job?.training_reviewed_at ? (
                      trainingReviewNoteEditing ? (
                        <label className="training-review-note">
                          <span>
                            Lesson note
                            <small>{trainingReviewNote.length}/{MAX_TRAINING_REVIEW_NOTE_LENGTH}</small>
                          </span>
                          <textarea
                            aria-label="Edit training review note"
                            value={trainingReviewNote}
                            onChange={(event) => setTrainingReviewNote(event.target.value)}
                            maxLength={MAX_TRAINING_REVIEW_NOTE_LENGTH}
                            rows={2}
                            placeholder="What will you remember next time?"
                            disabled={busy}
                          />
                          <span className="training-review-note-actions">
                            <button
                              type="button"
                              onClick={cancelTrainingReviewNoteEdit}
                              disabled={busy}
                            >
                              <X size={11} aria-hidden="true" />
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => void onUpdateTrainingReviewNote()}
                              disabled={
                                busy
                                || (trainingReviewNote.trim() || null) === job.training_review_note
                              }
                            >
                              <Check size={11} aria-hidden="true" />
                              Save note
                            </button>
                          </span>
                        </label>
                      ) : job.training_review_note ? (
                        <div className="training-review-note-saved" aria-label="Saved training review note">
                          <div>
                            <strong>Review note</strong>
                            <button
                              type="button"
                              onClick={startTrainingReviewNoteEdit}
                              disabled={busy}
                              aria-label="Edit training review note"
                              title="Edit lesson note"
                            >
                              <Pencil size={11} aria-hidden="true" />
                            </button>
                          </div>
                          <span>{job.training_review_note}</span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="training-review-note-add"
                          onClick={startTrainingReviewNoteEdit}
                          disabled={busy}
                        >
                          <Pencil size={11} aria-hidden="true" />
                          Add lesson note
                        </button>
                      )
                    ) : (
                      <label className="training-review-note">
                        <span>
                          Review note
                          <small>{trainingReviewNote.length}/{MAX_TRAINING_REVIEW_NOTE_LENGTH}</small>
                        </span>
                        <textarea
                          aria-label="Training review note"
                          value={trainingReviewNote}
                          onChange={(event) => setTrainingReviewNote(event.target.value)}
                          maxLength={MAX_TRAINING_REVIEW_NOTE_LENGTH}
                          rows={2}
                          placeholder="What will you remember next time?"
                          disabled={busy}
                        />
                      </label>
                    )
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
                                {candidate.foldEquity !== null ? (
                                  <small>
                                    Field folds {Math.round(candidate.foldEquity * 100)}%
                                    {candidate.perOpponentFoldEquity !== null && candidate.perOpponentFoldEquity !== candidate.foldEquity
                                      ? ` · each ${Math.round(candidate.perOpponentFoldEquity * 100)}%`
                                      : ""}
                                  </small>
                                ) : null}
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
                onToggle={() => updateAutomationSettings((current) => ({
                  ...current,
                  autoRecommend: !current.autoRecommend,
                }))}
              />
              <AutomationToggle
                title="Allow parser warnings"
                description="Continue automation even when fields are flagged"
                checked={automationAllowWarnings}
                disabled={!automationApprove}
                onToggle={() => updateAutomationSettings((current) => ({
                  ...current,
                  allowWarnings: !current.allowWarnings,
                }))}
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
              <button
                type="button"
                className="dialog-icon-button"
                onClick={() => setInfoDialogOpen(false)}
                disabled={backupRestoring}
                aria-label="Close app information"
              >
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
              <section className="info-dialog-section data-recovery-section">
                <h3>Data and recovery</h3>
                <p>Back up screenshots, reviewed hands, lesson notes, training decisions, recommendations, and benchmark reports in one portable ZIP.</p>
                <div className="data-recovery-actions">
                  <a
                    className={`secondary-button${busy ? " disabled" : ""}`}
                    href={applicationBackupUrl()}
                    download
                    aria-label="Download application backup"
                    aria-disabled={busy}
                    tabIndex={busy ? -1 : undefined}
                    onClick={(event) => {
                      if (busy) {
                        event.preventDefault();
                      }
                    }}
                  >
                    <Download size={14} aria-hidden="true" />
                    Download backup
                  </a>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => applicationBackupInputRef.current?.click()}
                    disabled={busy || backupRestoring}
                    aria-label="Restore application backup"
                  >
                    <Upload size={14} aria-hidden="true" />
                    {backupRestoring ? "Restoring..." : "Restore backup"}
                  </button>
                  <input
                    ref={applicationBackupInputRef}
                    className="sr-only"
                    type="file"
                    accept=".zip,application/zip"
                    aria-label="Application backup ZIP"
                    disabled={busy || backupRestoring}
                    onChange={(event) => void onApplicationBackupRestore(event)}
                  />
                </div>
              </section>
            </div>

            <div className="automation-dialog-footer info-dialog-footer">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setInfoDialogOpen(false)}
                disabled={backupRestoring}
              >
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

                  {trainingProgress.trend ? (
                    <section className="training-progress-section training-trend-section" aria-labelledby="training-trend-title">
                      <div className="training-section-heading training-trend-heading">
                        <h3 id="training-trend-title">Recent trend</h3>
                        <span>
                          Last {trainingProgress.trend.window_hands} vs previous {trainingProgress.trend.window_hands}
                        </span>
                      </div>
                      <div
                        className={`training-trend-grid${trainingProgress.trend.average_ev_loss_delta_bb !== null ? " has-ev" : ""}`}
                      >
                        <div>
                          <span>Action match</span>
                          <strong>{benchmarkPercent(trainingProgress.trend.recent_action_accuracy)}</strong>
                          <em className={trainingTrendTone(trainingProgress.trend.action_accuracy_delta)}>
                            {formatAccuracyDelta(trainingProgress.trend.action_accuracy_delta)}
                          </em>
                        </div>
                        <div>
                          <span>Exact line</span>
                          <strong>{benchmarkPercent(trainingProgress.trend.recent_exact_accuracy)}</strong>
                          <em className={trainingTrendTone(trainingProgress.trend.exact_accuracy_delta)}>
                            {formatAccuracyDelta(trainingProgress.trend.exact_accuracy_delta)}
                          </em>
                        </div>
                        {trainingProgress.trend.average_ev_loss_delta_bb !== null
                          && trainingProgress.trend.recent_average_ev_loss_bb !== null ? (
                            <div>
                              <span>Avg EV loss</span>
                              <strong>{formatEvLossBb(trainingProgress.trend.recent_average_ev_loss_bb)}</strong>
                              <em className={trainingTrendTone(
                                trainingProgress.trend.average_ev_loss_delta_bb,
                                true,
                              )}>
                                {formatEvLossDeltaBb(trainingProgress.trend.average_ev_loss_delta_bb)}
                              </em>
                            </div>
                          ) : null}
                      </div>
                    </section>
                  ) : null}

                  {trainingProgress.solver_coverage
                    && trainingProgress.solver_coverage.total_hands > 0 ? (
                    <section
                      className="training-progress-section training-solver-section"
                      aria-labelledby="training-solver-title"
                    >
                      <div className="training-section-heading">
                        <h3 id="training-solver-title">Solver coverage</h3>
                        <span className="training-section-context">
                          {trainingProgress.solver_coverage.tracked_hands} attributed
                          {" · "}
                          {trainingProgress.solver_coverage.unattributed_hands > 0 ? (
                            <button
                              type="button"
                              className="training-solver-unattributed"
                              onClick={() => void updateTrainingSolverFilter({
                                kind: "unattributed",
                                label: "Unattributed recommendations",
                              })}
                              disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                              aria-label={`Show ${trainingProgress.solver_coverage.unattributed_hands} unattributed ${trainingProgress.solver_coverage.unattributed_hands === 1 ? "hand" : "hands"}`}
                              title="Show training hands"
                            >
                              {trainingProgress.solver_coverage.unattributed_hands} unattributed
                              <Eye size={11} aria-hidden="true" />
                            </button>
                          ) : (
                            <>0 unattributed</>
                          )}
                          {" · "}
                          {trainingProgress.solver_coverage.fallback_hands} fallback
                          {" ("}
                          {benchmarkPercent(trainingProgress.solver_coverage.fallback_rate)}
                          )
                        </span>
                      </div>
                      {trainingProgress.solver_coverage.trend ? (
                        <div className="training-solver-trend" aria-label="Solver coverage trend">
                          <span>
                            Last {trainingProgress.solver_coverage.trend.window_hands}
                            {" vs previous "}
                            {trainingProgress.solver_coverage.trend.window_hands}
                          </span>
                          <div>
                            <small>Attribution</small>
                            <strong>
                              {benchmarkPercent(
                                trainingProgress.solver_coverage.trend.recent_attribution_rate,
                              )}
                            </strong>
                            <em className={trainingTrendTone(
                              trainingProgress.solver_coverage.trend.attribution_rate_delta,
                            )}>
                              {formatAccuracyDelta(
                                trainingProgress.solver_coverage.trend.attribution_rate_delta,
                              )}
                            </em>
                          </div>
                          <div>
                            <small>Fallback</small>
                            <strong>
                              {benchmarkPercent(
                                trainingProgress.solver_coverage.trend.recent_fallback_rate,
                              )}
                            </strong>
                            <em className={trainingTrendTone(
                              trainingProgress.solver_coverage.trend.fallback_rate_delta,
                              true,
                            )}>
                              {formatAccuracyDelta(
                                trainingProgress.solver_coverage.trend.fallback_rate_delta,
                              )}
                            </em>
                          </div>
                        </div>
                      ) : null}
                      {trainingProgress.solver_coverage.routes.length > 0 ? (
                        <table className="training-street-table training-solver-table">
                          <thead>
                            <tr>
                              <th>Engine</th>
                              <th>Hands</th>
                              <th>Share</th>
                              <th>Streets</th>
                              <th>Fallback</th>
                            </tr>
                          </thead>
                          <tbody>
                            {trainingProgress.solver_coverage.routes.map((route) => (
                              <tr key={route.key}>
                                <th scope="row">
                                  <button
                                    type="button"
                                    className="training-solver-route"
                                    onClick={() => void updateTrainingSolverFilter({
                                      kind: "route",
                                      key: route.key,
                                      label: providerLabel(route.engine),
                                    })}
                                    disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                                    aria-label={[
                                      `Show ${route.hands} ${route.hands === 1 ? "hand" : "hands"} handled by ${providerLabel(route.engine)}`,
                                      solverPerformanceAccessibleLabel(route),
                                    ].filter(Boolean).join(". ")}
                                    title="Show training hands"
                                  >
                                    <span className="training-solver-route-name">
                                      {providerLabel(route.engine)}
                                    </span>
                                    <Eye size={12} aria-hidden="true" />
                                    <SolverPerformance summary={route} />
                                  </button>
                                </th>
                                <td>{route.hands}</td>
                                <td>
                                  {benchmarkPercent(
                                    route.hands
                                      / Math.max(trainingProgress.solver_coverage!.tracked_hands, 1),
                                  )}
                                </td>
                                <td className="training-solver-streets">
                                  {solverStreetCountsLabel(route.street_counts) || "—"}
                                </td>
                                <td>{route.fallback_hands || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : null}
                      {trainingProgress.solver_coverage.fallback_reasons.length > 0 ? (
                        <div className="training-solver-fallbacks">
                          <h4>Fallback reasons</h4>
                          {trainingProgress.solver_coverage.fallback_reasons.map((fallback) => (
                            <button
                              key={fallback.key}
                              type="button"
                              className="training-solver-fallback"
                              onClick={() => void updateTrainingSolverFilter({
                                kind: "fallback",
                                key: fallback.key,
                                label: fallback.reason,
                              })}
                              disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                              aria-label={[
                                `Show ${fallback.hands} ${fallback.hands === 1 ? "hand" : "hands"} using fallback: ${fallback.reason}`,
                                solverPerformanceAccessibleLabel(fallback),
                              ].filter(Boolean).join(". ")}
                              title="Show training hands"
                            >
                              <span>{fallback.reason}</span>
                              <em>{solverStreetCountsLabel(fallback.street_counts) || "—"}</em>
                              <SolverPerformance summary={fallback} />
                              <strong>{fallback.hands}</strong>
                              <Eye size={13} aria-hidden="true" />
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  {(trainingProgress.certainty_summaries?.length ?? 0) > 0
                    || (trainingProgress.unrated_hands ?? 0) > 0 ? (
                    <section
                      className="training-progress-section training-certainty-section"
                      aria-labelledby="training-certainty-title"
                    >
                      <div className="training-section-heading">
                        <h3 id="training-certainty-title">Confidence calibration</h3>
                        {trainingProgressView === "recent" && certaintyFocus ? (
                          <button
                            type="button"
                            className="training-focus-action"
                            onClick={() => void focusTrainingReviewCertainty(certaintyFocus.certainty)}
                            disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                            title={certaintyFocus.reason}
                            aria-label={`Focus ${certaintyFocus.certainty === "unrated" ? "unrated" : `${certaintyFocus.certainty} certainty`} reviews: ${certaintyFocus.reason}`}
                          >
                            <Target size={13} aria-hidden="true" />
                            Focus {certaintyFocus.label}
                          </button>
                        ) : (
                          <span className="training-section-context">Self-rated before reveal</span>
                        )}
                      </div>
                      <table className="training-street-table training-certainty-table">
                        <thead>
                          <tr>
                            <th>Certainty</th>
                            <th>Hands</th>
                            <th>Action</th>
                            <th>Exact</th>
                            <th>Avg EV loss</th>
                            <th>Review</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trainingProgress.certainty_summaries?.map((summary) => (
                            <Fragment key={summary.certainty}>
                              <tr className={summary.trend ? "has-trend" : undefined}>
                                <th scope="row">
                                  <button
                                    type="button"
                                    className="training-summary-drilldown"
                                    onClick={() => void updateTrainingCertaintyFilter({
                                      certainty: summary.certainty,
                                      label: trainingCertaintyLabel(summary.certainty),
                                    })}
                                    disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                                    aria-label={[
                                      `Show ${summary.hands} ${summary.hands === 1 ? "hand" : "hands"} rated ${summary.certainty} certainty`,
                                      summary.trend
                                        ? performanceTrendAccessibleLabel(summary.trend)
                                        : null,
                                    ].filter(Boolean).join(". ")}
                                    title="Show training hands"
                                  >
                                    <span>{trainingCertaintyLabel(summary.certainty)}</span>
                                    <Eye size={12} aria-hidden="true" />
                                  </button>
                                </th>
                                <td>{summary.hands}</td>
                                <td>{benchmarkPercent(summary.action_accuracy)}</td>
                                <td>{benchmarkPercent(summary.exact_accuracy)}</td>
                                <td>
                                  {summary.ev_compared_hands > 0 && summary.average_ev_loss_bb !== null
                                    ? formatEvLossBb(summary.average_ev_loss_bb)
                                    : "—"}
                                </td>
                                <td>
                                  {(summary.needs_review_hands ?? 0) > 0 ? (
                                    <button
                                      type="button"
                                      className="training-certainty-review"
                                      onClick={() => void focusTrainingReviewCertainty(summary.certainty)}
                                      disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                                      aria-label={`Review ${summary.certainty} certainty differences (${summary.needs_review_hands})`}
                                      title={`Review ${summary.certainty}-certainty differences`}
                                    >
                                      <Target size={12} aria-hidden="true" />
                                      {summary.needs_review_hands}
                                    </button>
                                  ) : "—"}
                                </td>
                              </tr>
                              {summary.trend ? (
                                <tr className="training-summary-trend-row">
                                  <td colSpan={6}>
                                    <PerformanceTrend trend={summary.trend} />
                                  </td>
                                </tr>
                              ) : null}
                            </Fragment>
                          ))}
                          {(trainingProgress.unrated_hands ?? 0) > 0 ? (
                            <tr className="training-unrated-row">
                              <th scope="row">
                                <button
                                  type="button"
                                  className="training-summary-drilldown"
                                  onClick={() => void updateTrainingCertaintyFilter({
                                    certainty: "unrated",
                                    label: "Unrated",
                                  })}
                                  disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                                  aria-label={`Show ${trainingProgress.unrated_hands} unrated ${trainingProgress.unrated_hands === 1 ? "hand" : "hands"}`}
                                  title="Show training hands"
                                >
                                  <span>Unrated</span>
                                  <Eye size={12} aria-hidden="true" />
                                </button>
                              </th>
                              <td>{trainingProgress.unrated_hands}</td>
                              <td>—</td>
                              <td>—</td>
                              <td>—</td>
                              <td>
                                {(trainingProgress.unrated_needs_review_hands ?? 0) > 0 ? (
                                  <button
                                    type="button"
                                    className="training-certainty-review"
                                    onClick={() => void focusTrainingReviewCertainty("unrated")}
                                    disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                                    aria-label={`Review unrated differences (${trainingProgress.unrated_needs_review_hands})`}
                                    title="Review unrated differences"
                                  >
                                    <Target size={12} aria-hidden="true" />
                                    {trainingProgress.unrated_needs_review_hands}
                                  </button>
                                ) : "—"}
                              </td>
                            </tr>
                          ) : null}
                        </tbody>
                      </table>
                    </section>
                  ) : null}

                  {(trainingProgress.action_differences?.length ?? 0) > 0 ? (
                    <section
                      className="training-progress-section training-differences-section"
                      aria-labelledby="training-differences-title"
                    >
                      <div className="training-section-heading training-differences-heading">
                        <h3 id="training-differences-title">Common differences</h3>
                        <span className="training-differences-heading-actions">
                          <span className="training-differences-context">
                            Unsupported action choices
                          </span>
                          {trainingProgressView === "recent" && actionDifferenceFocus ? (
                            <button
                              type="button"
                              className="training-focus-action"
                              onClick={() => void focusTrainingActionDifference(
                                actionDifferenceFocus.difference,
                              )}
                              disabled={
                                trainingProgressLoading
                                || trainingReviewJobId !== null
                                || busy
                              }
                              title={actionDifferenceFocus.reason}
                              aria-label={`Focus ${actionDifferenceFocus.label} differences: ${actionDifferenceFocus.reason}`}
                            >
                              <Target size={13} aria-hidden="true" />
                              Focus {actionDifferenceFocus.label}
                            </button>
                          ) : null}
                        </span>
                      </div>
                      <div className="training-differences-list">
                        {trainingProgress.action_differences?.slice(0, 3).map((difference) => (
                          <div
                            key={`${difference.decision_action}-${difference.recommended_action}`}
                            className="training-difference"
                          >
                            <div className="training-difference-actions">
                              <strong>{trainingDecisionLabel(difference.decision_action, null)}</strong>
                              <ArrowRight size={13} aria-hidden="true" />
                              <strong>{trainingDecisionLabel(difference.recommended_action, null)}</strong>
                            </div>
                            <span>
                              {difference.hands} {difference.hands === 1 ? "hand" : "hands"}
                            </span>
                            <em>
                              {difference.ev_compared_hands > 0 && difference.average_ev_loss_bb !== null
                                ? `${formatEvLossBb(difference.average_ev_loss_bb)} avg loss`
                                : "EV ungraded"}
                            </em>
                            {difference.needs_review_hands > 0 ? (
                              <button
                                type="button"
                                className="training-difference-review"
                                onClick={() => void focusTrainingActionDifference(difference)}
                                disabled={
                                  trainingProgressLoading
                                  || trainingReviewJobId !== null
                                  || busy
                                }
                                aria-label={`Review ${trainingDecisionLabel(difference.decision_action, null)} to ${trainingDecisionLabel(difference.recommended_action, null)} differences (${difference.needs_review_hands})`}
                                title={`${difference.needs_review_hands} pending review${difference.needs_review_hands === 1 ? "" : "s"}`}
                              >
                                <Target size={12} aria-hidden="true" />
                                {difference.needs_review_hands}
                              </button>
                            ) : (
                              <span
                                className="training-difference-review-empty"
                                aria-label={`No pending ${trainingDecisionLabel(difference.decision_action, null)} to ${trainingDecisionLabel(difference.recommended_action, null)} reviews`}
                              >
                                —
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}

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
                          <th>Review</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trainingProgress.street_summaries.map((summary) => {
                          const pendingReviews = trainingProgress.review_street_counts?.[
                            summary.street
                          ] ?? 0;
                          return (
                            <Fragment key={summary.street}>
                              <tr className={summary.trend ? "has-trend" : undefined}>
                                <th scope="row">
                                  <button
                                    type="button"
                                    className="training-summary-drilldown"
                                    onClick={() => void updateTrainingStreetFilter({
                                      street: summary.street,
                                      label: trainingStreetLabel(summary.street),
                                    })}
                                    disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                                    aria-label={`Show ${summary.reviewed_hands} ${summary.reviewed_hands === 1 ? "hand" : "hands"} played on ${summary.street}`}
                                    title="Show training hands"
                                  >
                                    <span>{summary.street}</span>
                                    <Eye size={12} aria-hidden="true" />
                                  </button>
                                </th>
                                <td>{summary.reviewed_hands}</td>
                                <td>{benchmarkPercent(summary.action_accuracy)}</td>
                                <td>{benchmarkPercent(summary.exact_accuracy)}</td>
                                <td>
                                  {summary.ev_compared_hands > 0 && summary.average_ev_loss_bb !== null
                                    ? formatEvLossBb(summary.average_ev_loss_bb)
                                    : "—"}
                                </td>
                                <td>
                                  {pendingReviews > 0 ? (
                                    <button
                                      type="button"
                                      className="training-certainty-review"
                                      onClick={() => void focusTrainingReviewStreet(summary.street)}
                                      disabled={
                                        trainingProgressLoading
                                        || trainingReviewJobId !== null
                                        || busy
                                      }
                                      aria-label={`Review ${summary.street} street differences (${pendingReviews})`}
                                      title={`Review ${summary.street} differences`}
                                    >
                                      <Target size={12} aria-hidden="true" />
                                      {pendingReviews}
                                    </button>
                                  ) : "—"}
                                </td>
                              </tr>
                              {summary.trend ? (
                                <tr className="training-summary-trend-row">
                                  <td colSpan={6}>
                                    <PerformanceTrend trend={summary.trend} />
                                  </td>
                                </tr>
                              ) : null}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </section>

                  {(trainingProgress.position_summaries?.length ?? 0) > 0
                    || (trainingProgress.unpositioned_hands ?? 0) > 0 ? (
                    <section
                      className="training-progress-section"
                      aria-labelledby="training-positions-title"
                    >
                      <div className="training-section-heading">
                        <h3 id="training-positions-title">By position</h3>
                        {(trainingProgressView === "recent" && positionFocus)
                          || (trainingProgress.unpositioned_hands ?? 0) > 0 ? (
                          <span className="training-position-heading-actions">
                            {trainingProgressView === "recent" && positionFocus ? (
                              <button
                                type="button"
                                className="training-focus-action"
                                onClick={() => void focusTrainingReviewPosition(positionFocus.filter)}
                                disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                                title={positionFocus.reason}
                                aria-label={`Focus ${positionFocus.filter.kind === "unpositioned" ? "unpositioned" : `${positionFocus.label} position`} reviews: ${positionFocus.reason}`}
                              >
                                <Target size={13} aria-hidden="true" />
                                Focus {positionFocus.label}
                              </button>
                            ) : null}
                            {(trainingProgress.unpositioned_hands ?? 0) > 0 ? (
                              <span className="training-section-context training-position-context">
                                <button
                                  type="button"
                                  className="training-position-unrecorded"
                                  onClick={() => void updateTrainingPositionFilter({
                                    kind: "unpositioned",
                                    label: "Unpositioned",
                                  })}
                                  disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                                  aria-label={`Show ${trainingProgress.unpositioned_hands} unpositioned ${trainingProgress.unpositioned_hands === 1 ? "hand" : "hands"}`}
                                  title="Show training hands"
                                >
                                  {trainingProgress.unpositioned_hands} unrecorded
                                  <Eye size={11} aria-hidden="true" />
                                </button>
                                {(trainingProgress.unpositioned_needs_review_hands ?? 0) > 0 ? (
                                  <button
                                    type="button"
                                    className="training-certainty-review"
                                    onClick={() => void focusTrainingReviewPosition({
                                      kind: "unpositioned",
                                      label: "Unpositioned",
                                    })}
                                    disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                                    aria-label={`Review unpositioned differences (${trainingProgress.unpositioned_needs_review_hands})`}
                                    title="Open pending reviews"
                                  >
                                    <Target size={11} aria-hidden="true" />
                                    {trainingProgress.unpositioned_needs_review_hands}
                                  </button>
                                ) : null}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </div>
                      {(trainingProgress.position_summaries?.length ?? 0) > 0 ? (
                        <table className="training-street-table training-position-table">
                          <thead>
                            <tr>
                              <th>Position</th>
                              <th>Hands</th>
                              <th>Action</th>
                              <th>Exact</th>
                              <th>Avg EV loss</th>
                              <th>Review</th>
                            </tr>
                          </thead>
                          <tbody>
                            {trainingProgress.position_summaries?.map((summary) => (
                              <Fragment key={summary.position}>
                                <tr className={summary.trend ? "has-trend" : undefined}>
                                  <th scope="row">
                                    <button
                                      type="button"
                                      className="training-summary-drilldown"
                                      onClick={() => void updateTrainingPositionFilter({
                                        kind: "position",
                                        position: summary.position,
                                        label: summary.position,
                                      })}
                                      disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                                      aria-label={[
                                        `Show ${summary.reviewed_hands} ${summary.reviewed_hands === 1 ? "hand" : "hands"} recorded at ${summary.position}`,
                                        summary.trend
                                          ? performanceTrendAccessibleLabel(summary.trend)
                                          : null,
                                      ].filter(Boolean).join(". ")}
                                      title="Show training hands"
                                    >
                                      <span>{summary.position}</span>
                                      <Eye size={12} aria-hidden="true" />
                                    </button>
                                  </th>
                                  <td>{summary.reviewed_hands}</td>
                                  <td>{benchmarkPercent(summary.action_accuracy)}</td>
                                  <td>{benchmarkPercent(summary.exact_accuracy)}</td>
                                  <td>
                                    {summary.ev_compared_hands > 0
                                      && summary.average_ev_loss_bb !== null
                                      ? formatEvLossBb(summary.average_ev_loss_bb)
                                      : "—"}
                                  </td>
                                  <td>
                                    {(summary.needs_review_hands ?? 0) > 0 ? (
                                      <button
                                        type="button"
                                        className="training-certainty-review"
                                        onClick={() => void focusTrainingReviewPosition({
                                          kind: "position",
                                          position: summary.position,
                                          label: summary.position,
                                        })}
                                        disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                                        aria-label={`Review ${summary.position} position differences (${summary.needs_review_hands})`}
                                        title="Open pending reviews"
                                      >
                                        <Target size={11} aria-hidden="true" />
                                        {summary.needs_review_hands}
                                      </button>
                                    ) : "—"}
                                  </td>
                                </tr>
                                {summary.trend ? (
                                  <tr className="training-summary-trend-row">
                                    <td colSpan={6}>
                                      <PerformanceTrend
                                        trend={summary.trend}
                                        hiddenFromAssistiveTechnology
                                      />
                                    </td>
                                  </tr>
                                ) : null}
                              </Fragment>
                            ))}
                          </tbody>
                        </table>
                      ) : null}
                    </section>
                  ) : null}

                  <section className="training-progress-section recent-training-section" aria-labelledby="training-hands-title">
                    <div className="training-review-heading">
                      <h3 id="training-hands-title">
                        {trainingProgressView === "review"
                          ? "Needs review"
                          : trainingProgressView === "lessons"
                            ? "Saved lessons"
                            : "Recent decisions"}
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
                            <label className="training-review-order">
                              <span>Certainty</span>
                              <select
                                aria-label="Review certainty"
                                value={trainingReviewCertainty}
                                onChange={(event) => void updateTrainingReviewQueue(
                                  trainingReviewOrder,
                                  trainingReviewStreet,
                                  trainingReviewDifference,
                                  event.target.value as TrainingReviewCertaintyFilter,
                                )}
                                disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                              >
                                <option value="all">All</option>
                                <option value="high">High</option>
                                <option value="medium">Medium</option>
                                <option value="low">Low</option>
                                <option value="unrated">Unrated</option>
                              </select>
                            </label>
                          </>
                        ) : null}
                        {trainingProgressView === "lessons" ? (
                          <>
                            <form
                              className="training-lesson-search"
                              role="search"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void updateTrainingLessonFilters(
                                  trainingLessonStreet,
                                  trainingLessonSearch,
                                );
                              }}
                            >
                              <input
                                type="search"
                                aria-label="Search saved lesson notes"
                                placeholder="Search notes"
                                maxLength={120}
                                value={trainingLessonSearch}
                                onChange={(event) => setTrainingLessonSearch(event.target.value)}
                                disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                              />
                              <button
                                type="submit"
                                aria-label="Apply lesson search"
                                title="Search lesson notes"
                                disabled={
                                  trainingProgressLoading
                                  || trainingReviewJobId !== null
                                  || busy
                                  || trainingLessonSearch.trim() === trainingLessonQuery
                                }
                              >
                                <Search size={13} aria-hidden="true" />
                              </button>
                            </form>
                            <label className="training-review-order">
                              <span>Order</span>
                              <select
                                aria-label="Lesson order"
                                value={trainingLessonOrder}
                                onChange={(event) => void updateTrainingLessonFilters(
                                  trainingLessonStreet,
                                  trainingLessonSearch,
                                  event.target.value as TrainingReviewOrder,
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
                                aria-label="Lesson street"
                                value={trainingLessonStreet}
                                onChange={(event) => void updateTrainingLessonFilters(
                                  event.target.value as TrainingReviewStreet,
                                  trainingLessonSearch,
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
                            onClick={() => {
                              if (trainingSolverFilter) {
                                void updateTrainingSolverFilter(null);
                              } else if (trainingPositionFilter) {
                                void updateTrainingPositionFilter(null);
                              } else if (trainingStreetFilter) {
                                void updateTrainingStreetFilter(null);
                              } else if (trainingCertaintyFilter) {
                                void updateTrainingCertaintyFilter(null);
                              } else {
                                setTrainingProgressView("recent");
                              }
                            }}
                            aria-pressed={trainingProgressView === "recent"}
                          >
                            Recent
                          </button>
                          <button
                            type="button"
                            className={trainingProgressView === "review" ? "active" : ""}
                            onClick={() => {
                              setTrainingProgressView("review");
                              if (
                                trainingSolverFilter
                                || trainingPositionFilter
                                || trainingStreetFilter
                                || trainingCertaintyFilter
                              ) {
                                void updateTrainingReviewQueue(
                                  trainingReviewOrder,
                                  trainingReviewStreet,
                                );
                              }
                            }}
                            aria-pressed={trainingProgressView === "review"}
                          >
                            Needs review {trainingProgress.needs_review_hands}
                          </button>
                          <button
                            type="button"
                            className={trainingProgressView === "lessons" ? "active" : ""}
                            onClick={() => setTrainingProgressView("lessons")}
                            aria-pressed={trainingProgressView === "lessons"}
                          >
                            Lessons {trainingProgress.lesson_count ?? trainingProgress.lesson_hands?.length ?? 0}
                          </button>
                        </div>
                      </div>
                    </div>
                    {trainingProgressView === "review" && trainingReviewDifference ? (
                      <div className="training-active-difference" aria-label="Active action-difference filter">
                        <span>
                          {trainingDecisionLabel(trainingReviewDifference.decision_action, null)}
                          <ArrowRight size={12} aria-hidden="true" />
                          {trainingDecisionLabel(trainingReviewDifference.recommended_action, null)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void updateTrainingReviewQueue(
                            trainingReviewOrder,
                            trainingReviewStreet,
                            null,
                          )}
                          disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                          aria-label="Clear action-difference filter"
                          title="Clear action-difference filter"
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </div>
                    ) : null}
                    {trainingProgressView === "review" && trainingReviewPosition ? (
                      <div
                        className="training-active-difference training-active-position"
                        aria-label="Active review position filter"
                      >
                        <span>
                          <Target size={12} aria-hidden="true" />
                          {trainingReviewPosition.label}
                        </span>
                        <button
                          type="button"
                          onClick={() => void updateTrainingReviewQueue(
                            trainingReviewOrder,
                            trainingReviewStreet,
                            trainingReviewDifference,
                            trainingReviewCertainty,
                            null,
                          )}
                          disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                          aria-label="Clear review position filter"
                          title="Clear review position filter"
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </div>
                    ) : null}
                    {trainingProgressView === "recent" && trainingSolverFilter ? (
                      <div className="training-active-difference training-active-solver" aria-label="Active solver filter">
                        <span>
                          {trainingSolverFilter.kind === "fallback" ? (
                            <AlertTriangle size={12} aria-hidden="true" />
                          ) : trainingSolverFilter.kind === "unattributed" ? (
                            <Info size={12} aria-hidden="true" />
                          ) : (
                            <Target size={12} aria-hidden="true" />
                          )}
                          {trainingSolverFilter.label}
                        </span>
                        <button
                          type="button"
                          onClick={() => void updateTrainingSolverFilter(null)}
                          disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                          aria-label="Clear solver filter"
                          title="Clear solver filter"
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </div>
                    ) : null}
                    {trainingProgressView === "recent" && trainingPositionFilter ? (
                      <div className="training-active-difference training-active-position" aria-label="Active position filter">
                        <span>
                          <Target size={12} aria-hidden="true" />
                          {trainingPositionFilter.label}
                        </span>
                        <button
                          type="button"
                          onClick={() => void updateTrainingPositionFilter(null)}
                          disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                          aria-label="Clear position filter"
                          title="Clear position filter"
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </div>
                    ) : null}
                    {trainingProgressView === "recent" && trainingStreetFilter ? (
                      <div className="training-active-difference training-active-street" aria-label="Active street filter">
                        <span>
                          <Target size={12} aria-hidden="true" />
                          {trainingStreetFilter.label}
                        </span>
                        <button
                          type="button"
                          onClick={() => void updateTrainingStreetFilter(null)}
                          disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                          aria-label="Clear street filter"
                          title="Clear street filter"
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </div>
                    ) : null}
                    {trainingProgressView === "recent" && trainingCertaintyFilter ? (
                      <div className="training-active-difference training-active-certainty" aria-label="Active certainty filter">
                        <span>
                          <Target size={12} aria-hidden="true" />
                          {trainingCertaintyFilter.label}
                        </span>
                        <button
                          type="button"
                          onClick={() => void updateTrainingCertaintyFilter(null)}
                          disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                          aria-label="Clear certainty filter"
                          title="Clear certainty filter"
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </div>
                    ) : null}
                    {visibleTrainingHands.length > 0 ? (
                      <div className="recent-training-list">
                        {visibleTrainingHands.map((hand) => (
                          <div className="recent-training-row" key={hand.job_id}>
                            <button
                              className="recent-training-open"
                              type="button"
                              onClick={() => void reviewTrainingHand(
                                hand.job_id,
                                trainingProgressView === "review",
                              )}
                              disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                              aria-label={`Open ${hand.original_filename} training review`}
                            >
                              <span className="recent-training-hand">
                                <strong>{hand.hero_cards.length > 0 ? hand.hero_cards.map(cardToDisplay).join(" ") : "Unknown cards"}</strong>
                                <small>
                                  {hand.street ?? "Unknown street"} · {hand.original_filename}
                                  {hand.decision_certainty
                                    ? ` · ${trainingCertaintyLabel(hand.decision_certainty)} certainty`
                                    : ""}
                                </small>
                              </span>
                              <span className="recent-training-lines">
                                <small>You: {trainingDecisionLabel(hand.decision_action, hand.decision_sizing)}</small>
                                <small>Solver: {trainingDecisionLabel(hand.recommended_action, hand.recommended_sizing)}</small>
                                {typeof hand.ev_loss_bb === "number" ? (
                                  <small className="recent-training-ev">
                                    EV loss: {formatEvLossBb(hand.ev_loss_bb)}
                                  </small>
                                ) : null}
                                {hand.review_note ? (
                                  <small className="recent-training-note">
                                    Note: {hand.review_note}
                                  </small>
                                ) : null}
                              </span>
                              <em className={hand.reviewed_at ? "reviewed" : hand.outcome}>
                                {hand.reviewed_at ? "Reviewed" : trainingOutcomeLabel(hand.outcome)}
                              </em>
                              <Eye size={15} aria-hidden="true" />
                            </button>
                            {trainingProgressView !== "lessons"
                              && hand.reviewed_at
                              && hand.outcome !== "match"
                              && hand.outcome !== "mixed" ? (
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
                      <div className="training-review-empty">
                        {trainingProgressView === "lessons"
                          ? trainingLessonStreet !== "all" || trainingLessonQuery
                            ? "No saved lesson notes match these filters."
                            : "No saved lesson notes yet."
                          : trainingProgressView === "review"
                            ? "No action or sizing differences need review."
                            : trainingSolverFilter
                              ? trainingSolverFilter.kind === "route"
                                ? "No training hands were handled by this engine."
                                : trainingSolverFilter.kind === "fallback"
                                  ? "No training hands use this fallback."
                                  : "No training hands are missing engine attribution."
                              : trainingPositionFilter
                                ? trainingPositionFilter.kind === "position"
                                  ? `No training hands were recorded at ${trainingPositionFilter.label}.`
                                  : "No training hands have a recorded position."
                                : trainingStreetFilter
                                  ? `No training hands were played on ${trainingStreetFilter.label}.`
                                  : "No recent training decisions."}
                      </div>
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
              {trainingProgressView === "lessons" ? (
                <a
                  className={`training-lessons-export${trainingLessonsExportDisabled ? " disabled" : ""}`}
                  href={trainingLessonsExportUrl(
                    trainingLessonStreet,
                    trainingLessonQuery,
                    trainingLessonOrder,
                  )}
                  download="poker-hero-lessons.md"
                  aria-disabled={trainingLessonsExportDisabled}
                  tabIndex={trainingLessonsExportDisabled ? -1 : undefined}
                  onClick={(event) => {
                    if (trainingLessonsExportDisabled) {
                      event.preventDefault();
                    }
                  }}
                >
                  <Download size={14} aria-hidden="true" />
                  Export lessons
                </a>
              ) : null}
              {nextReviewHand ? (
                <button
                  type="button"
                  onClick={() => void reviewTrainingHand(nextReviewHand.job_id, true)}
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
                  benchmarkOperationsLocked ||
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
