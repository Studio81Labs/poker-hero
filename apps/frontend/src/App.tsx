import { AlertTriangle, Check, ChevronDown, Download, Eye, Pencil, Play, RefreshCcw, Search, Upload, X } from "lucide-react";
import type { ChangeEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";

import "./App.css";
import { ActionHistoryField, ActionHistoryRow } from "./ActionHistoryField";
import { AppToolbar } from "./AppToolbar";
import { AutomationDialog } from "./AutomationDialog";
import { cardToCode, CODE_BY_SUIT, SUIT_BY_CODE } from "./cardPresentation";
import { DetectedStateForm } from "./DetectedStateForm";
import { DetectedStateField } from "./DetectedStateField";
import { DialogFooter } from "./DialogFooter";
import { DialogFrame } from "./DialogFrame";
import { DialogHeader } from "./DialogHeader";
import { ButtonControl, DownloadLinkControl, FileInputControl, FormField, SelectControl, TextAreaControl, TextInput } from "./FormControls";
import { InputSourcePanel, selectedFilesLabel, shareModeLabel, type InputMode, type ShareMode } from "./InputSourcePanel";
import { HistoryPanel } from "./HistoryPanel";
import type { HistoryItem } from "./historyPresentation";
import { InfoDialog } from "./InfoDialog";
import { JobStatusBadge } from "./JobStatusBadge";
import {
  benchmarkPercent,
  formatCandidateValue,
  formatEvLossBb,
} from "./metricPresentation";
import {
  type CompletedPostflopActionForm,
  type PostflopActionForm,
  type PreflopActionForm,
  requiresOpponentPosition,
  type StateForm,
} from "./pokerStateForm";
import { PipelineDialog } from "./PipelineDialog";
import {
  QueueProcessingDialog,
  type QueueProgress,
} from "./QueueProcessingDialog";
import { ScreenshotDetailsDialog } from "./ScreenshotDetailsDialog";
import { parseScreenshotTags, screenshotTags } from "./screenshotMetadata";
import { screenshotLabel } from "./screenshotPresentation";
import { ScreenshotQueuePanel } from "./ScreenshotQueuePanel";
import { SegmentedControl } from "./SegmentedControl";
import { StateMessage } from "./StateMessage";
import { SummaryMetric } from "./SummaryMetric";
import { TablePreview } from "./TablePreview";
import { ToggleControl } from "./ToggleControl";
import { TrainingActionDifferences } from "./TrainingActionDifferences";
import { TrainingActiveFilters } from "./TrainingActiveFilters";
import { TrainingCertaintyCalibration } from "./TrainingCertaintyCalibration";
import { TrainingDecisionList } from "./TrainingDecisionList";
import { TrainingPositionSummary } from "./TrainingPositionSummary";
import { TrainingProgressOverview } from "./TrainingProgressOverview";
import { TrainingSolverCoverage } from "./TrainingSolverCoverage";
import { TrainingStreetSummary } from "./TrainingStreetSummary";
import { UserGuideDialog } from "./UserGuideDialog";
import {
  ApiResponseError,
  applicationBackupUrl,
  approveState,
  archiveJobs,
  benchmarkDatasetUrl,
  completeTrainingReview,
  deleteJob,
  getBenchmarkDatasetImport,
  getBenchmarkOverview,
  getBenchmarkReport,
  getHistory,
  getJob,
  getPipelineCapabilities,
  getProcessingJobs,
  getSystemInfo,
  getTrainingProgress,
  humanReadableMessage,
  imageUrl,
  importBenchmarkDataset,
  recordTrainingDecision,
  reopenTrainingReview,
  requestRecommendation,
  restoreApplicationBackup,
  runParserBenchmark,
  setBenchmarkInclusion,
  trainingLessonsExportUrl,
  updateJobMetadata,
  uploadScreenshot,
} from "./api";
import type {
  BenchmarkCaseResult,
  BenchmarkDatasetImportResult,
  BenchmarkFieldComparison,
  BenchmarkFieldMetric,
  BenchmarkOverview,
  BenchmarkParserPipelineSummary,
  BenchmarkReport,
  BenchmarkReportSummary,
  CanonicalState,
  Card,
  CompletedPostflopAction,
  CompletedPostflopActionType,
  CompletedPostflopStreet,
  CompletedPostflopStreetHistory,
  DetectedState,
  JobHistory,
  JobQueue,
  JobRecord,
  PipelineCapabilities,
  PipelineOption,
  PipelineSelection,
  PreflopAction,
  PreflopPosition,
  PostflopAction,
  PostflopActor,
  Rank,
  RecommendationAction,
  RecommendationResult,
  Street,
  SystemInfo,
  TrainingCertainty,
  TrainingCertaintyFilter,
  TrainingPositionFilter,
  TrainingProgress,
  TrainingReviewCertainty,
  TrainingReviewCertaintyFilter,
  TrainingReviewDifference,
  TrainingReviewOrder,
  TrainingReviewStreet,
  TrainingSolverFilter,
  TrainingStreetFilter,
} from "./types";

const RANK_VALUES: readonly Rank[] = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const RANKS = new Set<string>(RANK_VALUES);
const SUITS = new Set<string>(Object.keys(CODE_BY_SUIT));
const STREETS = new Set<string>(["preflop", "flop", "turn", "river"]);
const FACING_ACTIONS = new Set<string>(["bet", "raise"]);
const TRAINING_ACTIONS: readonly RecommendationAction[] = ["fold", "check", "call", "bet", "raise"];
const TRAINING_CERTAINTIES: readonly TrainingCertainty[] = ["low", "medium", "high"];
const TRAINING_ACTION_OPTIONS = TRAINING_ACTIONS.map((value) => ({ value, label: value }));
const TRAINING_CERTAINTY_OPTIONS = TRAINING_CERTAINTIES.map((value) => ({ value, label: value }));
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
  completed_postflop_streets: [],
  action_context: null,
  user_approved: false,
};

type TrainingActionOption = "" | RecommendationAction;
type TrainingCertaintyOption = "" | TrainingCertainty;
type PersistedJobMutationScope = "processing" | "history";
type ActiveRecommendationRequest = {
  mutationScope: PersistedJobMutationScope;
  controller: AbortController;
  ownsMutationLease: boolean;
};
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
  }
  | {
    kind: "metadata";
    title: string | null;
    notes: string | null;
    tags: string[];
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
type BenchmarkCaseTrend = "regressed" | "recovered" | "mixed" | "unchanged";
type BenchmarkCaseFilter = "all" | Exclude<BenchmarkCaseTrend, "unchanged">;
type BenchmarkCaseChangeTrend = Extract<BenchmarkCaseTrend, "regressed" | "recovered">;
type BenchmarkCaseChange = {
  key: string;
  label: string;
  trend: BenchmarkCaseChangeTrend;
  previousValue: unknown;
  currentValue: unknown;
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

interface ParserRoutingEvidence {
  provider: string;
  selectedProvider: string;
  layoutProfile: string;
  fallbackFrom: string | null;
  fallbackReason: string | null;
}

interface BenchmarkParserRouteMetric {
  provider: string;
  cases: number;
  failedCases: number;
  fallbackCases: number;
  correctFields: number;
  evaluatedFields: number;
  accuracy: number;
}

interface BenchmarkParserRouteSummary {
  attributedCases: number;
  routes: BenchmarkParserRouteMetric[];
}

interface BenchmarkComparisonProgress {
  parserId: string;
  completed: number;
  total: number;
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
  auto: "Automatic recognition",
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
const POSTFLOP_RANGE_SOURCE_LABELS: Record<string, string> = {
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

function availablePipelineOption(
  options: PipelineOption[],
  optionId: string | null | undefined,
): PipelineOption | undefined {
  return options.find((option) => option.available && option.id === optionId);
}

function compatiblePipelineLayouts(
  capabilities: PipelineCapabilities,
  parserProvider: string,
): PipelineOption[] {
  const compatibleIds = capabilities.parser_layout_compatibility?.[parserProvider];
  if (!compatibleIds) {
    return capabilities.parser_layout_profiles;
  }
  const compatible = new Set(compatibleIds);
  return capabilities.parser_layout_profiles.filter((option) => compatible.has(option.id));
}

function reconcilePipelineSelection(
  capabilities: PipelineCapabilities,
  candidate: PipelineSelection,
): PipelineSelection {
  const parserProvider = availablePipelineOption(
    capabilities.parser_providers,
    candidate.parser_provider,
  )?.id ?? capabilities.parser_providers.find((option) => option.available)?.id
    ?? capabilities.defaults.parser_provider;
  const layouts = compatiblePipelineLayouts(capabilities, parserProvider);
  const parserLayoutProfile = availablePipelineOption(
    layouts,
    candidate.parser_layout_profile,
  )?.id ?? availablePipelineOption(layouts, capabilities.defaults.parser_layout_profile)?.id
    ?? layouts.find((option) => option.available)?.id
    ?? capabilities.defaults.parser_layout_profile;
  const recommendationProvider = availablePipelineOption(
    capabilities.recommendation_providers,
    candidate.recommendation_provider,
  )?.id ?? capabilities.recommendation_providers.find((option) => option.available)?.id
    ?? capabilities.defaults.recommendation_provider;
  const recommendationEngine = recommendationProvider === "local_solver"
    ? availablePipelineOption(
      capabilities.recommendation_engines,
      candidate.recommendation_engine,
    )?.id ?? availablePipelineOption(
      capabilities.recommendation_engines,
      capabilities.defaults.recommendation_engine,
    )?.id ?? capabilities.recommendation_engines.find((option) => option.available)?.id
      ?? null
    : null;
  return {
    parser_provider: parserProvider,
    parser_layout_profile: parserLayoutProfile,
    recommendation_provider: recommendationProvider,
    recommendation_engine: recommendationEngine,
  };
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

function parserRoutingEvidence(value: unknown): ParserRoutingEvidence | null {
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

function parserRoutingFromRaw(value: unknown): ParserRoutingEvidence | null {
  return parserRoutingEvidence(metadataRecord(value)?.parser_routing);
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

function rangeConditioningEvidence(value: unknown): RecommendationEvidenceDetail[] {
  const conditioning = metadataRecord(value);
  const status = metadataString(conditioning?.status, 20);
  if (!conditioning || (status !== "applied" && status !== "skipped")) {
    return [];
  }

  const details: RecommendationEvidenceDetail[] = [];
  const statusParts = [status === "applied" ? "Applied" : "Skipped"];
  if (status === "applied") {
    const completedStreets = metadataStringList(conditioning.completed_streets, 2)
      .map((street) => metadataLabel(street))
      .filter((street): street is string => street !== null);
    const decisionStreet = metadataLabel(conditioning.decision_street);
    const streets = decisionStreet ? [...completedStreets, decisionStreet] : completedStreets;
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
    const estimatedMemory = metadataNumber(conditioning.estimated_compressed_memory_mb);
    const memoryLimit = metadataNumber(conditioning.max_memory_mb);
    const limitParts: string[] = [];
    if (estimatedMemory !== null && estimatedMemory >= 0) {
      limitParts.push(`${formatEvidenceNumber(estimatedMemory)} MB estimate`);
    }
    if (memoryLimit !== null && memoryLimit > 0) {
      limitParts.push(`${formatEvidenceNumber(memoryLimit)} MB limit`);
    }
    if (limitParts.length > 0) {
      details.push({ label: "Conditioning limit", value: limitParts.join(" · ") });
    }
    return details;
  }

  const modeledHistory = metadataStringList(conditioning.modeled_history, 12);
  if (modeledHistory.length > 0) {
    details.push({ label: "Conditioning line", value: modeledHistory.join(" → ") });
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
  const conditioningExploitability = metadataRecord(conditioning.exploitability);
  const exploitabilityBb = metadataNumber(conditioningExploitability?.bb);
  const solveParts: string[] = [];
  if (downstreamTree) {
    solveParts.push(downstreamTree);
  }
  if (compressedMemory !== null && compressedMemory >= 0) {
    solveParts.push(`${formatEvidenceNumber(compressedMemory)} MB estimate`);
  }
  if (exploitabilityBb !== null && exploitabilityBb >= 0) {
    solveParts.push(`${formatEvidenceNumber(exploitabilityBb, 3)} BB exploitability`);
  }
  if (solveParts.length > 0) {
    details.push({ label: "Conditioning solve", value: solveParts.join(" · ") });
  }

  return details;
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

    const rawRangeSource = metadataString(raw.range_source, 80);
    const rangeSource = metadataLabel(rawRangeSource);
    if (rangeSource) {
      details.push({
        label: "Range source",
        value: POSTFLOP_RANGE_SOURCE_LABELS[rawRangeSource ?? ""] ?? rangeSource,
      });
    }
    details.push(...rangeConditioningEvidence(raw.range_conditioning));

    const contextualRangeSource = (
      rawRangeSource === "preflop_chart_limped_pot"
      || rawRangeSource === "preflop_chart_isolation_raised_pot"
      || rawRangeSource === "preflop_chart_limp_reraised_pot"
      || rawRangeSource === "preflop_chart_single_raised_pot"
      || rawRangeSource === "preflop_chart_three_bet_pot"
      || rawRangeSource === "preflop_chart_cold_three_bet_pot"
      || rawRangeSource === "preflop_chart_squeeze_pot"
      || rawRangeSource === "preflop_chart_four_bet_pot"
      || rawRangeSource === "preflop_chart_cold_four_bet_pot"
    );
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
      rangeStackPolicy
      && rangeStartingStack !== null
      && rangeStartingStack > 0
      && (
        rangeStackSource === "reconstructed"
        || rangeStackSource === "standard_assumption"
      )
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
      (rangeDecisionStreet === "turn" || rangeDecisionStreet === "river")
      && rangeCompletedStreetCount !== null
      && Number.isInteger(rangeCompletedStreetCount)
      && rangeCompletedStreetCount > 0
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
      const rangeBigBlindPosition = metadataLabel(rangeContext?.big_blind_position);
      const rangeLimpSize = metadataNumber(rangeContext?.limp_size_bb);
      if (rangeLimperPosition && rangeBigBlindPosition) {
        details.push({
          label: "Range actors",
          value: rangeLimperPosition
            + " limps"
            + (
              rangeLimpSize !== null && rangeLimpSize > 0
                ? " " + formatEvidenceBb(rangeLimpSize)
                : ""
            )
            + " · "
            + rangeBigBlindPosition
            + " checks",
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
        rangeLimperFraction !== null
        && rangeBigBlindRaise !== null
        && rangeBigBlindRaise < 1
      ) {
        details.push({
          label: "Range bands",
          value: "Entry "
            + formatEvidenceRatio(rangeLimperFraction)
            + " · BB check "
            + formatEvidenceRatio(rangeBigBlindRaise)
            + "-100%",
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
        rangeIsolationFraction !== null
        && rangeLimperContinue !== null
        && rangeLimperReraise !== null
        && rangeLimperReraise < rangeLimperContinue
      ) {
        details.push({
          label: "Range bands",
          value: `BB isolate ${formatEvidenceRatio(rangeIsolationFraction)} · limper call ${
            formatEvidenceRatio(rangeLimperReraise)
          }-${formatEvidenceRatio(rangeLimperContinue)}`,
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
        rangeLimperReraise !== null
        && rangeIsolationRaiserContinue !== null
        && rangeIsolationRaiserFourBet !== null
        && rangeIsolationRaiserFourBet < rangeIsolationRaiserContinue
      ) {
        details.push({
          label: "Range bands",
          value: `Limper reraise ${formatEvidenceRatio(rangeLimperReraise)} · isolator call ${
            formatEvidenceRatio(rangeIsolationRaiserFourBet)
          }-${formatEvidenceRatio(rangeIsolationRaiserContinue)}`,
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
      const rangeCallerContinue = metadataRatio(rangeContext?.caller_continue_fraction);
      const rangeCallerReraise = metadataRatio(rangeContext?.caller_reraise_fraction);
      if (
        rangeOpenerFraction !== null
        && rangeCallerContinue !== null
        && rangeCallerReraise !== null
        && rangeCallerReraise < rangeCallerContinue
      ) {
        details.push({
          label: "Range bands",
          value: `Open ${formatEvidenceRatio(rangeOpenerFraction)} · flat ${
            formatEvidenceRatio(rangeCallerReraise)
          }-${formatEvidenceRatio(rangeCallerContinue)}`,
        });
      }
    } else if (rawRangeSource === "preflop_chart_three_bet_pot") {
      const rangeOpenerPosition = metadataLabel(rangeContext?.opener_position);
      const rangeThreeBettorPosition = metadataLabel(rangeContext?.three_bettor_position);
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
      const rangeThreeBettorFraction = metadataRatio(rangeContext?.three_bettor_fraction);
      const rangeOpenerContinue = metadataRatio(rangeContext?.opener_continue_fraction);
      const rangeOpenerFourBet = metadataRatio(rangeContext?.opener_four_bet_fraction);
      if (
        rangeThreeBettorFraction !== null
        && rangeOpenerContinue !== null
        && rangeOpenerFourBet !== null
        && rangeOpenerFourBet < rangeOpenerContinue
      ) {
        details.push({
          label: "Range bands",
          value: `3-bet ${formatEvidenceRatio(rangeThreeBettorFraction)} · flat ${
            formatEvidenceRatio(rangeOpenerFourBet)
          }-${formatEvidenceRatio(rangeOpenerContinue)}`,
        });
      }
    } else if (rawRangeSource === "preflop_chart_cold_three_bet_pot") {
      const rangeFoldedOpenerPosition = metadataLabel(
        rangeContext?.folded_opener_position,
      );
      const rangeThreeBettorPosition = metadataLabel(rangeContext?.three_bettor_position);
      const rangeColdCallerPosition = metadataLabel(rangeContext?.cold_caller_position);
      const rangeOpeningSize = metadataNumber(rangeContext?.opening_size_bb);
      const rangeThreeBetSize = metadataNumber(rangeContext?.three_bet_size_bb);
      const rangeFoldedOpenerCommitment = metadataNumber(
        rangeContext?.folded_opener_commitment_bb,
      );
      if (
        rangeFoldedOpenerPosition
        && rangeThreeBettorPosition
        && rangeColdCallerPosition
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
            rangeFoldedOpenerCommitment !== null && rangeFoldedOpenerCommitment > 0
              ? ` ${formatEvidenceBb(rangeFoldedOpenerCommitment)} dead`
              : ""
          }`,
        });
      }
      const rangeThreeBettorFraction = metadataRatio(rangeContext?.three_bettor_fraction);
      const rangeColdCallerContinue = metadataRatio(
        rangeContext?.cold_caller_continue_fraction,
      );
      const rangeColdCallerFourBet = metadataRatio(
        rangeContext?.cold_caller_four_bet_fraction,
      );
      if (
        rangeThreeBettorFraction !== null
        && rangeColdCallerContinue !== null
        && rangeColdCallerFourBet !== null
        && rangeColdCallerFourBet < rangeColdCallerContinue
      ) {
        details.push({
          label: "Range bands",
          value: `3-bet ${formatEvidenceRatio(rangeThreeBettorFraction)} · cold-call ${
            formatEvidenceRatio(rangeColdCallerFourBet)
          }-${formatEvidenceRatio(rangeColdCallerContinue)}`,
        });
      }
    } else if (rawRangeSource === "preflop_chart_squeeze_pot") {
      const rangeFoldedOpenerPosition = metadataLabel(
        rangeContext?.folded_opener_position,
      );
      const rangeCallerPosition = metadataLabel(rangeContext?.caller_position);
      const rangeSqueezerPosition = metadataLabel(rangeContext?.squeezer_position);
      const rangeOpeningSize = metadataNumber(rangeContext?.opening_size_bb);
      const rangeSqueezeSize = metadataNumber(rangeContext?.squeeze_size_bb);
      const rangeFoldedOpenerCommitment = metadataNumber(
        rangeContext?.folded_opener_commitment_bb,
      );
      if (
        rangeFoldedOpenerPosition
        && rangeCallerPosition
        && rangeSqueezerPosition
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
            rangeFoldedOpenerCommitment !== null && rangeFoldedOpenerCommitment > 0
              ? ` ${formatEvidenceBb(rangeFoldedOpenerCommitment)} dead`
              : ""
          }`,
        });
      }
      const rangeSqueezerFraction = metadataRatio(rangeContext?.squeezer_fraction);
      const rangeCallerContinue = metadataRatio(rangeContext?.caller_continue_fraction);
      const rangeCallerFourBet = metadataRatio(rangeContext?.caller_four_bet_fraction);
      if (
        rangeSqueezerFraction !== null
        && rangeCallerContinue !== null
        && rangeCallerFourBet !== null
        && rangeCallerFourBet < rangeCallerContinue
      ) {
        details.push({
          label: "Range bands",
          value: `Squeeze ${formatEvidenceRatio(rangeSqueezerFraction)} · call ${
            formatEvidenceRatio(rangeCallerFourBet)
          }-${formatEvidenceRatio(rangeCallerContinue)}`,
        });
      }
    } else if (rawRangeSource === "preflop_chart_cold_four_bet_pot") {
      const rangeFoldedOpenerPosition = metadataLabel(
        rangeContext?.folded_opener_position,
      );
      const rangeThreeBettorPosition = metadataLabel(rangeContext?.three_bettor_position);
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
        rangeFoldedOpenerPosition
        && rangeThreeBettorPosition
        && rangeColdFourBettorPosition
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
            rangeFoldedOpenerCommitment !== null && rangeFoldedOpenerCommitment > 0
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
        rangeColdFourBet !== null
        && rangeThreeBettorContinue !== null
        && rangeThreeBettorFiveBet !== null
        && rangeThreeBettorFiveBet < rangeThreeBettorContinue
      ) {
        details.push({
          label: "Range bands",
          value: `Cold 4-bet ${formatEvidenceRatio(rangeColdFourBet)} · flat ${
            formatEvidenceRatio(rangeThreeBettorFiveBet)
          }-${formatEvidenceRatio(rangeThreeBettorContinue)}`,
        });
      }
    } else if (rawRangeSource === "preflop_chart_four_bet_pot") {
      const rangeOpenerPosition = metadataLabel(rangeContext?.opener_position);
      const rangeThreeBettorPosition = metadataLabel(rangeContext?.three_bettor_position);
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
      const rangeOpenerFourBet = metadataRatio(rangeContext?.opener_four_bet_fraction);
      const rangeThreeBettorContinue = metadataRatio(
        rangeContext?.three_bettor_continue_fraction,
      );
      const rangeThreeBettorFiveBet = metadataRatio(
        rangeContext?.three_bettor_five_bet_fraction,
      );
      if (
        rangeOpenerFourBet !== null
        && rangeThreeBettorContinue !== null
        && rangeThreeBettorFiveBet !== null
        && rangeThreeBettorFiveBet < rangeThreeBettorContinue
      ) {
        details.push({
          label: "Range bands",
          value: `4-bet ${formatEvidenceRatio(rangeOpenerFourBet)} · flat ${
            formatEvidenceRatio(rangeThreeBettorFiveBet)
          }-${formatEvidenceRatio(rangeThreeBettorContinue)}`,
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
    corpus_fingerprint: report.corpus_fingerprint,
    created_at: report.created_at,
    total_cases: report.total_cases,
    failed_cases: report.failed_cases,
    accuracy: report.accuracy,
    field_metrics: report.field_metrics,
  };
}

function benchmarkCorpusIsUnverified(
  reportFingerprint: string | null | undefined,
  currentFingerprint: string | null | undefined,
): boolean {
  return !reportFingerprint
    || !currentFingerprint
    || reportFingerprint !== currentFingerprint;
}

function benchmarkCorpusFingerprintAfterLayoutMutation(
  currentFingerprint: string | null | undefined,
  mutatedLayoutProfile: string | null | undefined,
  selectedLayoutProfile: string | null | undefined,
): string | null | undefined {
  return mutatedLayoutProfile
    && selectedLayoutProfile
    && mutatedLayoutProfile !== selectedLayoutProfile
    ? currentFingerprint
    : undefined;
}

function benchmarkReportOption(
  summary: BenchmarkReportSummary,
  latestId: string | undefined,
  capabilities: PipelineCapabilities | null,
  parserPipelines: BenchmarkOverview["parser_pipelines"],
  currentCorpusFingerprint: string | null | undefined,
): string {
  const createdAt = new Date(summary.created_at);
  const dateLabel = Number.isNaN(createdAt.getTime())
    ? "Previous run"
    : createdAt.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
  const parserLabel = capabilities?.parser_providers.find(
    (option) => option.id === summary.parser_provider,
  )?.label ?? parserPipelines?.find(
    (pipeline) => pipeline.parser.id === summary.parser_provider,
  )?.parser.label ?? providerLabel(summary.parser_provider);
  const rawLayoutLabel = capabilities?.parser_layout_profiles.find(
    (option) => option.id === summary.layout_profile,
  )?.label ?? providerLabel(summary.layout_profile);
  const layoutLabel = rawLayoutLabel.charAt(0).toUpperCase() + rawLayoutLabel.slice(1);
  const staleLabel = benchmarkCorpusIsUnverified(
    summary.corpus_fingerprint,
    currentCorpusFingerprint,
  )
    ? " · rerun needed"
    : "";
  return `${summary.id === latestId ? "Latest" : dateLabel} · ${parserLabel} · ${layoutLabel} · ${benchmarkPercent(summary.accuracy)}${staleLabel}`;
}

function previousComparableBenchmarkReport(
  report: BenchmarkReport | null,
  recentReports: BenchmarkReportSummary[],
  parserPipelines: BenchmarkOverview["parser_pipelines"],
): BenchmarkReportSummary | null {
  if (!report) {
    return null;
  }
  const currentIndex = recentReports.findIndex((summary) => summary.id === report.id);
  const recentMatch = currentIndex < 0
    ? null
    : recentReports
      .slice(currentIndex + 1)
      .find(
        (summary) =>
          summary.parser_provider === report.parser_provider &&
          summary.layout_profile === report.layout_profile &&
          !benchmarkCorpusIsUnverified(
            summary.corpus_fingerprint,
            report.corpus_fingerprint,
          ),
      ) ?? null;
  if (recentMatch) {
    return recentMatch;
  }
  const pipeline = parserPipelines?.find(
    (candidate) =>
      candidate.parser.id === report.parser_provider &&
      candidate.layout_profile === report.layout_profile &&
      candidate.latest_report?.id === report.id,
  );
  const previous = pipeline?.previous_report;
  return previous &&
    previous.parser_provider === report.parser_provider &&
    previous.layout_profile === report.layout_profile &&
    !benchmarkCorpusIsUnverified(
      previous.corpus_fingerprint,
      report.corpus_fingerprint,
    )
    ? previous
    : null;
}

function benchmarkPointChange(current: number, previous: number): number {
  return Math.round((current - previous) * 100);
}

function benchmarkPipelinePointChange(
  pipeline: BenchmarkParserPipelineSummary,
  currentCorpusFingerprint: string | null | undefined,
): number | null {
  const latest = pipeline.latest_report;
  const previous = pipeline.previous_report;
  if (
    !latest
    || !previous
    || benchmarkCorpusIsUnverified(
      latest.corpus_fingerprint,
      currentCorpusFingerprint,
    )
    || benchmarkCorpusIsUnverified(
      previous.corpus_fingerprint,
      latest.corpus_fingerprint,
    )
  ) {
    return null;
  }
  return benchmarkPointChange(latest.accuracy, previous.accuracy);
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

function previousBenchmarkFieldMetric(
  metric: BenchmarkFieldMetric,
  previousReport: BenchmarkReportSummary | null,
): BenchmarkFieldMetric | null {
  return previousReport?.field_metrics?.find((candidate) => candidate.field === metric.field) ?? null;
}

function benchmarkReportsAreComparable(
  report: BenchmarkReport,
  previousReport: BenchmarkReport,
): boolean {
  return previousReport.id !== report.id
    && previousReport.parser_provider === report.parser_provider
    && previousReport.layout_profile === report.layout_profile
    && !benchmarkCorpusIsUnverified(
      previousReport.corpus_fingerprint,
      report.corpus_fingerprint,
    );
}

function benchmarkCaseTrend(
  benchmarkCase: BenchmarkCaseResult,
  previousCase: BenchmarkCaseResult,
): BenchmarkCaseTrend {
  if (benchmarkCase.status !== previousCase.status) {
    return benchmarkCase.status === "error" ? "regressed" : "recovered";
  }
  if (benchmarkCase.accuracy < previousCase.accuracy) {
    return "regressed";
  }
  if (benchmarkCase.accuracy > previousCase.accuracy) {
    return "recovered";
  }
  const previousComparisons = new Map(
    previousCase.comparisons.map((comparison) => [comparison.field, comparison]),
  );
  let regressed = false;
  let recovered = false;
  for (const comparison of benchmarkCase.comparisons) {
    const previousComparison = previousComparisons.get(comparison.field);
    if (!previousComparison || comparison.matched === previousComparison.matched) {
      continue;
    }
    if (comparison.matched) {
      recovered = true;
    } else {
      regressed = true;
    }
  }
  if (regressed && recovered) {
    return "mixed";
  }
  if (regressed) {
    return "regressed";
  }
  if (recovered) {
    return "recovered";
  }
  return "unchanged";
}

function benchmarkCaseStatusValue(benchmarkCase: BenchmarkCaseResult): string {
  if (benchmarkCase.status === "error") {
    return humanReadableMessage(benchmarkCase.error, "Parser failed");
  }
  return `Completed at ${benchmarkPercent(benchmarkCase.accuracy)}`;
}

function benchmarkCaseChanges(
  benchmarkCase: BenchmarkCaseResult,
  previousCase: BenchmarkCaseResult,
): BenchmarkCaseChange[] {
  if (benchmarkCase.status !== previousCase.status) {
    return [{
      key: "parser-status",
      label: "Parser status",
      trend: benchmarkCase.status === "error" ? "regressed" : "recovered",
      previousValue: benchmarkCaseStatusValue(previousCase),
      currentValue: benchmarkCaseStatusValue(benchmarkCase),
    }];
  }
  const previousComparisons = new Map(
    previousCase.comparisons.map((comparison) => [comparison.field, comparison]),
  );
  const currentFields = new Set<string>();
  const changes: BenchmarkCaseChange[] = [];
  for (const comparison of benchmarkCase.comparisons) {
    currentFields.add(comparison.field);
    const previousComparison = previousComparisons.get(comparison.field);
    if (previousComparison?.matched === comparison.matched) {
      continue;
    }
    changes.push({
      key: comparison.field,
      label: benchmarkFieldLabel(comparison.field),
      trend: comparison.matched ? "recovered" : "regressed",
      previousValue: previousComparison
        ? previousComparison.detected
        : "Not evaluated",
      currentValue: comparison.detected,
    });
  }
  for (const previousComparison of previousCase.comparisons) {
    if (currentFields.has(previousComparison.field)) {
      continue;
    }
    changes.push({
      key: previousComparison.field,
      label: benchmarkFieldLabel(previousComparison.field),
      trend: "regressed",
      previousValue: previousComparison.detected,
      currentValue: "Not evaluated",
    });
  }
  return changes;
}

function benchmarkCaseTrendMap(
  report: BenchmarkReport | null,
  previousReport: BenchmarkReport | null,
): Map<string, BenchmarkCaseTrend> {
  const trends = new Map<string, BenchmarkCaseTrend>();
  if (
    !report
    || !previousReport
    || !benchmarkReportsAreComparable(report, previousReport)
  ) {
    return trends;
  }
  const previousCases = new Map(
    previousReport.cases.map((benchmarkCase) => [benchmarkCase.job_id, benchmarkCase]),
  );
  for (const benchmarkCase of report.cases) {
    const previousCase = previousCases.get(benchmarkCase.job_id);
    if (previousCase) {
      trends.set(
        benchmarkCase.job_id,
        benchmarkCaseTrend(benchmarkCase, previousCase),
      );
    }
  }
  return trends;
}

const BENCHMARK_REPORT_CACHE_LIMIT = 20;

function cacheBenchmarkReport(
  cache: Map<string, BenchmarkReport>,
  report: BenchmarkReport,
): BenchmarkReport {
  cache.delete(report.id);
  cache.set(report.id, report);
  while (cache.size > BENCHMARK_REPORT_CACHE_LIMIT) {
    const oldestId = cache.keys().next().value;
    if (oldestId === undefined) {
      break;
    }
    cache.delete(oldestId);
  }
  return report;
}

function loadCachedBenchmarkReport(
  reportId: string,
  cache: Map<string, BenchmarkReport>,
  pendingRequests: Map<string, Promise<BenchmarkReport>>,
): Promise<BenchmarkReport> {
  const cached = cache.get(reportId);
  if (cached) {
    return Promise.resolve(cacheBenchmarkReport(cache, cached));
  }
  const pending = pendingRequests.get(reportId);
  if (pending) {
    return pending;
  }
  const request = getBenchmarkReport(reportId)
    .then((report) => cacheBenchmarkReport(cache, report))
    .finally(() => {
      if (pendingRequests.get(reportId) === request) {
        pendingRequests.delete(reportId);
      }
    });
  pendingRequests.set(reportId, request);
  return request;
}

function benchmarkParserRouteSummary(
  report: BenchmarkReport | null,
): BenchmarkParserRouteSummary {
  if (!report || report.parser_provider !== "auto") {
    return { attributedCases: 0, routes: [] };
  }

  const routes = new Map<string, Omit<BenchmarkParserRouteMetric, "accuracy">>();
  let attributedCases = 0;
  for (const benchmarkCase of report.cases) {
    const routing = parserRoutingEvidence(benchmarkCase.parser_routing);
    if (
      !routing
      || routing.provider !== report.parser_provider
      || routing.layoutProfile !== report.layout_profile
    ) {
      continue;
    }
    attributedCases += 1;
    const current = routes.get(routing.selectedProvider) ?? {
      provider: routing.selectedProvider,
      cases: 0,
      failedCases: 0,
      fallbackCases: 0,
      correctFields: 0,
      evaluatedFields: 0,
    };
    current.cases += 1;
    current.failedCases += benchmarkCase.status === "error" ? 1 : 0;
    current.fallbackCases += routing.fallbackFrom ? 1 : 0;
    current.correctFields += benchmarkCase.correct_fields;
    current.evaluatedFields += benchmarkCase.evaluated_fields;
    routes.set(routing.selectedProvider, current);
  }

  return {
    attributedCases,
    routes: [...routes.values()]
      .map((route) => ({
        ...route,
        accuracy: route.evaluatedFields > 0
          ? route.correctFields / route.evaluatedFields
          : 0,
      }))
      .sort((left, right) => providerLabel(left.provider).localeCompare(
        providerLabel(right.provider),
      )),
  };
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

function isCachedCompletedPostflopAction(
  value: unknown,
): value is CompletedPostflopAction {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const action = value as Partial<CompletedPostflopAction>;
  return (action.actor === "oop" || action.actor === "ip")
    && (
      action.action === "check"
      || action.action === "bet"
      || action.action === "raise"
      || action.action === "call"
    )
    && (
      action.action === "check"
        ? action.amount === null
        : typeof action.amount === "number"
          && Number.isFinite(action.amount)
          && action.amount > 0
    );
}

function isCachedCompletedPostflopStreet(
  value: unknown,
): value is CompletedPostflopStreetHistory {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const history = value as Partial<CompletedPostflopStreetHistory>;
  if (!(
    (history.street === "flop" || history.street === "turn")
    && Array.isArray(history.actions)
    && history.actions.length >= 2
    && history.actions.length <= 8
    && history.actions.every(isCachedCompletedPostflopAction)
  )) {
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
        Math.abs(actorTotal - opponentTotal) > SIZING_MATCH_TOLERANCE
        || actorTotal > SIZING_MATCH_TOLERANCE
      ) {
        return false;
      }
      contributions[action.actor] = amount;
    } else if (action.action === "raise") {
      if (
        actorTotal >= opponentTotal - SIZING_MATCH_TOLERANCE
        || amount <= opponentTotal + SIZING_MATCH_TOLERANCE
      ) {
        return false;
      }
      contributions[action.actor] = amount;
    } else {
      if (
        actorTotal >= opponentTotal - SIZING_MATCH_TOLERANCE
        || Math.abs(amount - opponentTotal) > SIZING_MATCH_TOLERANCE
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

function isCachedCompletedPostflopHistory(
  value: unknown,
  currentStreet: unknown,
): value is CompletedPostflopStreetHistory[] | undefined {
  if (value === undefined) {
    return true;
  }
  if (
    !Array.isArray(value)
    || value.length > 2
    || !value.every(isCachedCompletedPostflopStreet)
  ) {
    return false;
  }
  const expected = currentStreet === "turn"
    ? ["flop"]
    : currentStreet === "river"
      ? ["flop", "turn"]
      : [];
  return value.every((history, index) => history.street === expected[index]);
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
    && isCachedCompletedPostflopHistory(
      state.completed_postflop_streets,
      state.street,
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
      candidate.parser_auto_approval_eligible === undefined
      || candidate.parser_auto_approval_eligible === null
      || typeof candidate.parser_auto_approval_eligible === "boolean"
    )
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
  if (expectation.kind === "metadata") {
    return (job.title ?? null) === expectation.title
      && (job.notes ?? null) === expectation.notes
      && screenshotTags(job).length === expectation.tags.length
      && screenshotTags(job).every(
        (tag, index) => tag === expectation.tags[index],
      );
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
  if (expectation.kind === "metadata") {
    return (expectation.title === null || typeof expectation.title === "string")
      && (expectation.notes === null || typeof expectation.notes === "string")
      && Array.isArray(expectation.tags)
      && expectation.tags.every((tag) => typeof tag === "string");
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

function summarizeConfidences(
  confidences: Record<string, number>,
  warnings: string[],
  state: CanonicalState | null,
) {
  const confidenceKeys: string[] = [...CONFIDENCE_KEYS];
  if ((state?.current_bet ?? 0) > 0) {
    confidenceKeys.push("opponent_wager");
  }
  if (state && requiresOpponentPosition(state)) {
    confidenceKeys.push("opponent_position");
  }
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
    completed_postflop_streets: state.completed_postflop_streets ?? [],
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
  const showOpponentStack = showPostflopHistory
    || state.street === "turn"
    || state.street === "river";
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
  const completedPostflopActions: CompletedPostflopActionForm[] = (
    state.completed_postflop_streets ?? []
  ).flatMap((history) => history.actions.map((action) => ({
    street: history.street,
    actor: action.actor,
    action: action.action,
    amount: action.amount === null ? "" : String(action.amount),
  })));
  return {
    hero_cards: formatCards(state.hero_cards),
    board_cards: formatCards(state.board_cards),
    pot_size: state.pot_size === null ? "" : String(state.pot_size),
    current_bet: state.current_bet === null ? "" : String(state.current_bet),
    hero_stack: state.hero_stack == null ? "" : String(state.hero_stack),
    opponent_stack: showOpponentStack && state.opponent_stack != null
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
    completed_postflop_actions: completedPostflopActions,
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
  const showOpponentStack = showPostflopHistory
    || form.street === "turn"
    || form.street === "river";
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
  const completedPostflopActions: Array<
    CompletedPostflopAction & { street: CompletedPostflopStreet }
  > = form.street === "turn" || form.street === "river"
    ? form.completed_postflop_actions.map((item, index) => {
        const amount = item.action === "check"
          ? null
          : parseOptionalNumber(
              item.amount,
              `Completed action ${index + 1} amount`,
            );
        if (item.action !== "check" && (amount === null || amount <= 0)) {
          throw new Error(
            `Completed action ${index + 1} amount must be greater than 0`,
          );
        }
        return {
          street: item.street,
          actor: item.actor,
          action: item.action,
          amount,
        };
      })
    : [];
  const completedPostflopStreets: CompletedPostflopStreetHistory[] = (
    ["flop", "turn"] as const
  ).flatMap((street) => {
    const actions = completedPostflopActions
      .filter((action) => action.street === street)
      .map(({ actor, action, amount }) => ({ actor, action, amount }));
    return actions.length > 0 ? [{ street, actions }] : [];
  });
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
    opponent_stack: showOpponentStack
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
    completed_postflop_streets: completedPostflopStreets,
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
    completed_postflop_streets: state.completed_postflop_streets ?? [],
    action_context: state.action_context,
  });
}

function benchmarkApprovalKey(state: CanonicalState): string {
  return JSON.stringify({
    hero_cards: state.hero_cards.map(cardToCode),
    board_cards: state.board_cards.map(cardToCode),
    street: state.street,
    pot_size: state.pot_size,
    current_bet: state.current_bet,
    hero_stack: state.hero_stack ?? null,
    opponent_stack: state.opponent_stack ?? null,
    effective_stack: state.effective_stack,
    players_in_hand: state.players_in_hand,
    hero_position: state.hero_position,
    opponent_position: state.opponent_position ?? null,
    preflop_opener_position: state.preflop_opener_position ?? null,
    preflop_open_size: state.preflop_open_size ?? null,
    preflop_action_history: state.preflop_action_history ?? [],
    facing_action: state.facing_action ?? null,
    postflop_action_history: state.postflop_action_history ?? [],
    completed_postflop_streets: state.completed_postflop_streets ?? [],
    action_context: state.action_context,
  });
}

function messageFromError(error: unknown, fallback: string): string {
  return humanReadableMessage(error instanceof Error ? error.message : error, fallback);
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

function captureName(): string {
  return `screen-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
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
  if (job.parser_auto_approval_eligible !== true) {
    throw new Error(
      job.parser_auto_approval_eligible === false
        ? "Automation stopped: parser confidence is below the configured auto-approval requirements"
        : "Automation stopped: parser confidence eligibility needs manual review",
    );
  }

  const state = formToCanonical(stateToForm(toCanonicalState(job.parser_result.state)));
  if (state.hero_cards.length === 0 || !state.street) {
    throw new Error("Automation stopped: parser state needs manual review");
  }
  return state;
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
  const [helpDialogOpen, setHelpDialogOpen] = useState(false);
  const [pipelineDialogOpen, setPipelineDialogOpen] = useState(false);
  const [pipelineCapabilities, setPipelineCapabilities] = useState<PipelineCapabilities | null>(null);
  const [pipelineSelection, setPipelineSelection] = useState<PipelineSelection | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [managedJobId, setManagedJobId] = useState<string | null>(null);
  const [screenshotTitle, setScreenshotTitle] = useState("");
  const [screenshotNotes, setScreenshotNotes] = useState("");
  const [screenshotTagInput, setScreenshotTagInput] = useState("");
  const [screenshotMetadataSaving, setScreenshotMetadataSaving] = useState(false);
  const [screenshotDeleting, setScreenshotDeleting] = useState(false);
  const [screenshotDeleteArmed, setScreenshotDeleteArmed] = useState(false);
  const [infoDialogOpen, setInfoDialogOpen] = useState(false);
  const [mcpTokenPending, setMcpTokenPending] = useState(false);
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
  const [benchmarkComparisonProgress, setBenchmarkComparisonProgress] = useState<BenchmarkComparisonProgress | null>(null);
  const [benchmarkUpdating, setBenchmarkUpdating] = useState(false);
  const [benchmarkImporting, setBenchmarkImporting] = useState(false);
  const [selectedBenchmarkReport, setSelectedBenchmarkReport] = useState<BenchmarkReport | null>(null);
  const [benchmarkComparisonReport, setBenchmarkComparisonReport] = useState<BenchmarkReport | null>(null);
  const [benchmarkComparisonReportLoading, setBenchmarkComparisonReportLoading] = useState(false);
  const [benchmarkCaseFilter, setBenchmarkCaseFilter] = useState<BenchmarkCaseFilter>("all");
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
  const queueAbortControllerRef = useRef<AbortController | null>(null);
  const queueAbortRequestedRef = useRef(false);
  const benchmarkOverviewRequestRef = useRef(0);
  const benchmarkComparisonReportRequestRef = useRef(0);
  const benchmarkReportCacheRef = useRef(new Map<string, BenchmarkReport>());
  const benchmarkReportRequestsRef = useRef(
    new Map<string, Promise<BenchmarkReport>>(),
  );
  const activeRecommendationRequestsRef = useRef(
    new Map<string, ActiveRecommendationRequest>(),
  );
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
          .then(async (receipt) => {
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
              setError(humanReadableMessage(
                receipt.error,
                "Could not recover parser dataset import",
              ));
              markProcessingQueueSessionUnsynced();
              scheduleProcessingQueueRestore();
              markHistorySessionUnsynced();
              void requestHistoryRestore(null, true);
              return;
            }
            setError(null);
            const readyCases = await applyBenchmarkDatasetImportResult(
              receipt.result,
            );
            if (
              !appMountedRef.current
              || benchmarkImportLeaseRequestId(
                processingMutationLeaseRef.current,
                historyMutationLeaseRef.current,
              ) !== benchmarkImportRequestId
            ) {
              return;
            }
            clearBenchmarkImportLeases(benchmarkImportRequestId);
            setBenchmarkImporting(false);
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
  const parserWarnings = (job?.parser_result?.warnings ?? []).map((warning) => (
    humanReadableMessage(warning, "The parser reported a warning")
  ));
  const warnings = job?.error
    ? [...parserWarnings, humanReadableMessage(job.error, "The screenshot needs attention")]
    : parserWarnings;
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
  const completedPostflopActionCounts = useMemo(
    () => form.completed_postflop_actions.reduce<Record<CompletedPostflopStreet, number>>(
      (counts, action) => ({
        ...counts,
        [action.street]: counts[action.street] + 1,
      }),
      { flop: 0, turn: 0 },
    ),
    [form.completed_postflop_actions],
  );
  const completedPostflopActionsAtLimit = form.street === "turn"
    ? completedPostflopActionCounts.flop >= 8
    : completedPostflopActionCounts.flop >= 8
      && completedPostflopActionCounts.turn >= 8;
  const screenshotUrl = useMemo(() => (job && job.image_filename !== "" ? imageUrl(job.id) : null), [job]);
  const screenSharing = screenStream !== null;
  const confidenceSummary = useMemo(
    () => summarizeConfidences(confidences, warnings, validation.state),
    [confidences, validation.state, warnings],
  );
  const filmstripCount = jobs.length > 0 ? jobs.length : files.length;
  const frameLabel = job ? screenshotLabel(job) : (screenSharing ? `${screenSourceLabel ?? shareModeLabel(shareMode)} live preview` : "No table selected");
  const frameStreet = form.street === "" ? "No street" : form.street;
  const queueCount = jobs.length > 0 ? jobs.length : files.length;
  const liveStatusLabel = screenSharing ? `${screenSourceLabel ?? shareModeLabel(shareMode)} sharing` : inputMode === "upload" ? "Upload queue" : "Live capture";
  const automationEnabled = automationSettings.enabled;
  const automationApprove = automationSettings.autoApprove;
  const automationRecommend = automationSettings.autoRecommend;
  const automationAllowWarnings = automationSettings.allowWarnings;
  const clearableJobs = useMemo(() => jobs.filter(isHistoryReady), [jobs]);
  const historySearchActive = historySearchResults !== null;
  const visibleHistory = historySearchResults ?? history;
  const visibleHistoryTotal = historySearchActive ? historySearchTotal : historyTotal;
  const managedJob = managedJobId === null
    ? null
    : jobs.find((candidate) => candidate.id === managedJobId)
      ?? history.find((item) => item.id === managedJobId)?.job
      ?? historySearchResults?.find((item) => item.id === managedJobId)?.job
      ?? null;
  const managedJobPersisted = Boolean(
    managedJob && PERSISTED_JOB_ID_PATTERN.test(managedJob.id),
  );
  const managedLocalUploadRecoveryPending = Boolean(
    managedJob
    && !managedJobPersisted
    && localUploadDeletionRequiresRecovery(managedJob),
  );
  const activeParserRouting = parserRoutingFromRaw(job?.parser_result?.raw);
  const activeParserProvider = activeParserRouting?.selectedProvider
    ?? systemInfo?.parser_provider
    ?? job?.parser_provider
    ?? null;
  const activeRecommendationProvider =
    systemInfo?.recommendation_engine ?? systemInfo?.recommendation_provider ?? job?.recommendation_provider ?? null;
  const activeInfoProviders = activeParserProvider && activeRecommendationProvider
    ? {
        recognition: providerLabel(activeParserProvider),
        recognitionFallbackFrom: activeParserRouting?.fallbackFrom
          ? providerLabel(activeParserRouting.fallbackFrom)
          : null,
        recognitionRoute: activeParserRouting
          ? providerLabel(activeParserRouting.provider)
          : null,
        recommendation: providerLabel(activeRecommendationProvider),
      }
    : null;
  const recentBenchmarkReports = useMemo(() => {
    if (benchmarkOverview?.recent_reports?.length) {
      return benchmarkOverview.recent_reports;
    }
    return benchmarkOverview?.latest_report
      ? [benchmarkReportSummary(benchmarkOverview.latest_report)]
      : [];
  }, [benchmarkOverview]);
  const benchmarkReport = selectedBenchmarkReport ?? benchmarkOverview?.latest_report ?? null;
  const benchmarkReportStale = Boolean(
    benchmarkReport
    && benchmarkCorpusIsUnverified(
      benchmarkReport.corpus_fingerprint,
      benchmarkOverview?.corpus_fingerprint,
    ),
  );
  const benchmarkReportParserLabel = benchmarkReport
    ? pipelineCapabilities?.parser_providers.find(
        (option) => option.id === benchmarkReport.parser_provider,
      )?.label ?? benchmarkOverview?.parser_pipelines?.find(
        (pipeline) => pipeline.parser.id === benchmarkReport.parser_provider,
      )?.parser.label ?? providerLabel(benchmarkReport.parser_provider)
    : null;
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
  const benchmarkTargetLayoutProfile = pipelineSelection?.parser_layout_profile
    ?? benchmarkOverview?.default_layout_profile
    ?? null;
  const benchmarkHasLayoutCounts = Boolean(
    benchmarkOverview?.included_cases_by_layout
    && (
      benchmarkOverview.included_cases === 0
      || Object.keys(benchmarkOverview.included_cases_by_layout).length > 0
    ),
  );
  const benchmarkIncludedCases = benchmarkTargetLayoutProfile
    && benchmarkHasLayoutCounts
    && benchmarkOverview?.included_cases_by_layout
    ? benchmarkOverview.included_cases_by_layout[benchmarkTargetLayoutProfile] ?? 0
    : benchmarkOverview?.included_cases ?? 0;
  const benchmarkTargetLayoutLabel = pipelineCapabilities?.parser_layout_profiles
    .find((option) => option.id === benchmarkTargetLayoutProfile)?.label
    ?? benchmarkTargetLayoutProfile;
  const benchmarkDatasetExportDisabled =
    benchmarkOperationsLocked ||
    benchmarkIncludedCases === 0;
  const previousBenchmarkReport = useMemo(
    () => previousComparableBenchmarkReport(
      benchmarkReport,
      recentBenchmarkReports,
      benchmarkOverview?.parser_pipelines,
    ),
    [benchmarkOverview?.parser_pipelines, benchmarkReport, recentBenchmarkReports],
  );
  useEffect(() => {
    const requestId = ++benchmarkComparisonReportRequestRef.current;
    setBenchmarkCaseFilter("all");
    setBenchmarkComparisonReport(null);
    if (!benchmarkDialogOpen || !benchmarkReport || !previousBenchmarkReport) {
      setBenchmarkComparisonReportLoading(false);
      return;
    }
    cacheBenchmarkReport(benchmarkReportCacheRef.current, benchmarkReport);
    setBenchmarkComparisonReportLoading(true);
    void loadCachedBenchmarkReport(
      previousBenchmarkReport.id,
      benchmarkReportCacheRef.current,
      benchmarkReportRequestsRef.current,
    )
      .then((previousReport) => {
        if (
          requestId !== benchmarkComparisonReportRequestRef.current
          || previousReport.id !== previousBenchmarkReport.id
        ) {
          return;
        }
        if (!benchmarkReportsAreComparable(benchmarkReport, previousReport)) {
          throw new Error("The previous benchmark report no longer matches this run");
        }
        setBenchmarkComparisonReport(previousReport);
      })
      .catch((benchmarkError) => {
        if (requestId === benchmarkComparisonReportRequestRef.current) {
          toast.warning(messageFromError(
            benchmarkError,
            "Could not compare benchmark cases",
          ));
        }
      })
      .finally(() => {
        if (requestId === benchmarkComparisonReportRequestRef.current) {
          setBenchmarkComparisonReportLoading(false);
        }
      });
  }, [benchmarkDialogOpen, benchmarkReport, previousBenchmarkReport]);
  const benchmarkAccuracyDelta = useMemo(
    () =>
      benchmarkReport && previousBenchmarkReport
        ? benchmarkPointChange(benchmarkReport.accuracy, previousBenchmarkReport.accuracy)
        : null,
    [benchmarkReport, previousBenchmarkReport],
  );
  const benchmarkCaseTrends = useMemo(
    () => benchmarkCaseTrendMap(
      benchmarkReport,
      benchmarkComparisonReport?.id === previousBenchmarkReport?.id
        ? benchmarkComparisonReport
        : null,
    ),
    [benchmarkComparisonReport, benchmarkReport, previousBenchmarkReport?.id],
  );
  const benchmarkComparisonCases = useMemo(() => {
    if (
      !benchmarkReport
      || !benchmarkComparisonReport
      || !benchmarkReportsAreComparable(benchmarkReport, benchmarkComparisonReport)
      || benchmarkComparisonReport.id !== previousBenchmarkReport?.id
    ) {
      return new Map<string, BenchmarkCaseResult>();
    }
    return new Map(
      benchmarkComparisonReport.cases.map((benchmarkCase) => [
        benchmarkCase.job_id,
        benchmarkCase,
      ]),
    );
  }, [benchmarkComparisonReport, benchmarkReport, previousBenchmarkReport?.id]);
  const benchmarkCaseTrendCounts = useMemo(() => {
    const counts = { regressed: 0, recovered: 0, mixed: 0 };
    for (const trend of benchmarkCaseTrends.values()) {
      if (trend !== "unchanged") {
        counts[trend] += 1;
      }
    }
    return counts;
  }, [benchmarkCaseTrends]);
  const visibleBenchmarkCases = useMemo(
    () => benchmarkCaseFilter === "all"
      ? benchmarkReport?.cases ?? []
      : benchmarkReport?.cases.filter(
        (benchmarkCase) => benchmarkCaseTrends.get(benchmarkCase.job_id)
          === benchmarkCaseFilter,
      ) ?? [],
    [benchmarkCaseFilter, benchmarkCaseTrends, benchmarkReport],
  );
  const benchmarkParserRoutes = useMemo(
    () => benchmarkParserRouteSummary(benchmarkReport),
    [benchmarkReport],
  );
  const benchmarkParserPipelines = benchmarkOverview?.parser_pipelines ?? [];
  const benchmarkRunnablePipelines = benchmarkParserPipelines.filter(
    (pipeline) => pipeline.parser.available,
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

  function mutationComposesWithActiveRecommendation(
    scope: PersistedJobMutationScope,
  ): boolean {
    const lease = scope === "processing"
      ? processingMutationLeaseRef.current
      : historyMutationLeaseRef.current;
    if (lease?.ownerId !== mutationOwnerId) {
      return false;
    }
    const activeRequests = [
      ...activeRecommendationRequestsRef.current.entries(),
    ].filter(([, request]) => request.mutationScope === scope);
    if (lease.kind === "job") {
      return activeRequests.some(([jobId]) => jobId === lease.jobId);
    }
    return lease.kind === "projection"
      && lease.benchmarkImportRequestId === null
      && activeRequests.length > 0;
  }

  function localUploadDeletionRequiresRecovery(
    localJob: JobRecord,
  ): boolean {
    if (!isLocalUploadError(localJob) || !localJob.upload_request_id) {
      return false;
    }
    const lease = processingMutationLeaseRef.current;
    const expectedUpload = lease?.kind === "projection"
      ? lease.expectedUploads.find(
          (candidate) => candidate.requestId === localJob.upload_request_id,
        )
      : undefined;
    if (expectedUpload?.target === "failed") {
      return false;
    }
    return expectedUpload !== undefined
      || !processingQueueSessionSynced();
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
    if (restoreAfterMutation) {
      historyRestoreRetryRequestedRef.current = true;
    }
    if (
      historyMutationCountRef.current === 0
      && historyRestoreRetryRequestedRef.current
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
    if (restoreAfterMutation) {
      processingRestoreRetryRequestedRef.current = true;
    }
    if (
      processingMutationCountRef.current === 0
      && processingRestoreRetryRequestedRef.current
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

  async function onSearchHistory() {
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
    const previousJob = jobsRef.current.find(
      (candidate) => candidate.id === approved.id,
    );
    const benchmarkStateChanged = !previousJob?.benchmark_included
      || !previousJob.approved_state
      || benchmarkApprovalKey(previousJob.approved_state)
        !== benchmarkApprovalKey(approvedState);
    replaceJob(approved);
    formBaselineRef.current = approvedForm;
    formDirtyRef.current = false;
    setForm(approvedForm);
    setApprovedStateKey(approvalKey(approvedState));
    if (approved.benchmark_included) {
      setBenchmarkOverview((current) => current
        ? {
            ...current,
            corpus_fingerprint: benchmarkStateChanged
              ? benchmarkCorpusFingerprintAfterLayoutMutation(
                  current.corpus_fingerprint,
                  approved.parser_layout_profile ?? current.default_layout_profile,
                  benchmarkTargetLayoutProfile,
                )
              : current.corpus_fingerprint,
          }
        : current);
    }
  }

  function preserveNewerScreenshotMetadata(incoming: JobRecord): JobRecord {
    const current = jobsRef.current.find(
      (candidate) => candidate.id === incoming.id,
    );
    const currentUpdatedAt = current ? Date.parse(current.updated_at) : Number.NaN;
    const incomingUpdatedAt = Date.parse(incoming.updated_at);
    return current
      && Number.isFinite(currentUpdatedAt)
      && (!Number.isFinite(incomingUpdatedAt) || currentUpdatedAt > incomingUpdatedAt)
      ? {
          ...incoming,
          title: current.title ?? null,
          notes: current.notes ?? null,
          tags: screenshotTags(current),
          updated_at: current.updated_at,
        }
      : incoming;
  }

  function applyRecommendedJob(recommended: JobRecord) {
    const reconciled = preserveNewerScreenshotMetadata(recommended);
    replaceJob(reconciled);
    if (reconciled.approved_state) {
      setApprovedStateKey(approvalKey(reconciled.approved_state));
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

    const recommendationController = new AbortController();
    const abortRecommendation = () => recommendationController.abort();
    if (signal?.aborted) {
      abortRecommendation();
    } else {
      signal?.addEventListener("abort", abortRecommendation, { once: true });
    }
    activeRecommendationRequestsRef.current.set(approved.id, {
      mutationScope: persistedJobMutationScope(approved),
      controller: recommendationController,
      ownsMutationLease: false,
    });
    markPersistedJobSessionUnsynced(approved);
    try {
      const recommended = preserveUploadRequestId(
        await requestRecommendation(
          approved.id,
          recommendationRequestId ?? createMutationRequestId(),
          recommendationController.signal,
        ),
        approved,
      );
      if (jobsRef.current.some((candidate) => candidate.id === approved.id)) {
        applyRecommendedJob(recommended);
      }
      return recommended;
    } finally {
      signal?.removeEventListener("abort", abortRecommendation);
      if (
        activeRecommendationRequestsRef.current.get(approved.id)?.controller
          === recommendationController
      ) {
        activeRecommendationRequestsRef.current.delete(approved.id);
      }
    }
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
          pipelineSelection ?? undefined,
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
        let includeCompletedJob = true;
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
            );
            if (isAbortError(automationError) && controller.signal.aborted) {
              if (confirmedJob) {
                completedJobs.push(confirmedJob);
              }
              completedCount += 1;
              skippedCount = selectedFiles.length - completedCount;
              discardUnstartedUploads(index + 1);
              break;
            }
            if (!confirmedJob) {
              updateExpectedUpload(expectedUploadIndex, "failed");
              includeCompletedJob = false;
            } else if (!mutationFailureMayHavePersistedSideEffect(automationError)) {
              updateExpectedUpload(
                expectedUploadIndex,
                confirmedJob.recommendation !== null
                  ? "recommended"
                  : confirmedJob.approved_state !== null
                    ? "approved"
                    : "parsed",
              );
            }
            if (confirmedJob) {
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
        }
        if (includeCompletedJob) {
          completedJobs.push(completed);
        }
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
    const created = await uploadScreenshot(
      file,
      uploadRequestId,
      undefined,
      pipelineSelection ?? undefined,
    );
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
      const confirmedJob = capturedJobId === null
        ? null
        : jobsRef.current.find((candidate) => candidate.id === capturedJobId) ?? null;
      const deletedDuringAutomation = capturedJobId !== null
        && confirmedJob === null;
      if (deletedDuringAutomation) {
        updateExpectedUpload(expectedUploadIndex, "failed");
        settlePersistedMutationLease("processing", jobsRef.current, false);
      } else if (
        !isAbortError(captureError)
        && !mutationFailureMayHavePersistedSideEffect(captureError)
      ) {
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
      if (!deletedDuringAutomation) {
        setError(messageFromError(captureError, "Screen capture failed"));
      }
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
    const recommendationController = new AbortController();
    activeRecommendationRequestsRef.current.set(job.id, {
      mutationScope,
      controller: recommendationController,
      ownsMutationLease: true,
    });
    let recommendationStarted = false;
    let restoreAfterMutation = changesProcessingMembership;
    setBusy(true);
    setError(null);
    try {
      if (decisionExpectation?.kind === "training-decision") {
        const decided = await recordTrainingDecision(
          job.id,
          decisionExpectation.action,
          decisionExpectation.sizing,
          decisionExpectation.certainty,
        );
        if (
          recommendationController.signal.aborted
          || !jobsRef.current.some((candidate) => candidate.id === job.id)
        ) {
          return;
        }
        replaceJob(preserveNewerScreenshotMetadata(decided));
      }
      if (!armPersistedRecommendationLease(
        mutationScope,
        job.id,
        recommendationRequestId,
      )) {
        return;
      }
      recommendationStarted = true;
      const recommended = await requestRecommendation(
        job.id,
        recommendationRequestId,
        recommendationController.signal,
      );
      if (jobsRef.current.some((candidate) => candidate.id === job.id)) {
        applyRecommendedJob(recommended);
      }
    } catch (recommendError) {
      const jobStillPresent = jobsRef.current.some(
        (candidate) => candidate.id === job.id,
      );
      if (jobStillPresent) {
        if (
          recommendationStarted
            ? recommendationAttemptMayHavePersistedSideEffect(recommendError)
            : mutationFailureMayHavePersistedSideEffect(recommendError)
        ) {
          markPersistedJobMutationUncertain(mutationScope, job.id);
        }
        restoreAfterMutation = restoreAfterMutation || recommendationStarted;
        setError(messageFromError(recommendError, "Recommendation failed"));
      }
    } finally {
      if (
        activeRecommendationRequestsRef.current.get(job.id)?.controller
          === recommendationController
      ) {
        activeRecommendationRequestsRef.current.delete(job.id);
      }
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
      if (field === "current_bet") {
        next.opponent_wager = "";
        next.action_context = "";
        if (value !== "") {
          next.facing_action = "";
        }
      }
      if (field === "facing_action") {
        next.opponent_wager = "";
        next.action_context = "";
      }
      if (field === "street" && (value === "" || value === "preflop")) {
        next.opponent_wager = "";
        next.facing_action = "";
        next.action_context = "";
      }
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
      const usesCompletedPostflopHistory = next.street === "turn"
        || next.street === "river";
      if (!usesPostflopHistory) {
        next.postflop_action_history = [];
      }
      if (!usesCompletedPostflopHistory) {
        next.completed_postflop_actions = [];
      } else if (next.street === "turn") {
        next.completed_postflop_actions = next.completed_postflop_actions.filter(
          (action) => action.street === "flop",
        );
      }
      if (!usesPostflopHistory && !usesCompletedPostflopHistory) {
        next.opponent_stack = "";
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

  function addCompletedPostflopAction() {
    const previous = form.completed_postflop_actions[
      form.completed_postflop_actions.length - 1
    ];
    let street: CompletedPostflopStreet = form.street === "river"
      ? previous?.street ?? "flop"
      : "flop";
    if (completedPostflopActionCounts[street] >= 8 && form.street === "river") {
      street = street === "flop" ? "turn" : "flop";
    }
    const streetActionCount = completedPostflopActionCounts[street];
    if (streetActionCount >= 8) {
      return;
    }
    updateForm("completed_postflop_actions", [
      ...form.completed_postflop_actions,
      {
        street,
        actor: streetActionCount % 2 === 0 ? "oop" : "ip",
        action: "check",
        amount: "",
      },
    ]);
  }

  function updateCompletedPostflopAction(
    index: number,
    field: keyof CompletedPostflopActionForm,
    value: string,
  ) {
    const next = form.completed_postflop_actions.map((action, actionIndex) => {
      if (actionIndex !== index) {
        return action;
      }
      const updated = {
        ...action,
        [field]: value,
      } as CompletedPostflopActionForm;
      if (field === "action" && value === "check") {
        updated.amount = "";
      }
      return updated;
    });
    updateForm("completed_postflop_actions", next);
  }

  function removeCompletedPostflopAction(index: number) {
    updateForm(
      "completed_postflop_actions",
      form.completed_postflop_actions.filter(
        (_, actionIndex) => actionIndex !== index,
      ),
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

  function loadPipelineCapabilities() {
    if (pipelineCapabilities || pipelineLoading) {
      return;
    }

    setPipelineLoading(true);
    void getPipelineCapabilities()
      .then((capabilities) => {
        setPipelineCapabilities(capabilities);
        setPipelineSelection((current) => reconcilePipelineSelection(
          capabilities,
          current ?? capabilities.defaults,
        ));
      })
      .catch((pipelineError) => {
        setError(messageFromError(pipelineError, "Could not read analysis plugins"));
      })
      .finally(() => setPipelineLoading(false));
  }

  function openPipelineDialog() {
    setPipelineDialogOpen(true);
    loadPipelineCapabilities();
  }

  function updatePipelineSelection(
    field: "parser_layout_profile" | "recommendation_engine",
    value: string,
  ) {
    setPipelineSelection((current) => current ? {
      ...current,
      [field]: value,
    } : current);
  }

  function updateParserProvider(value: string) {
    setPipelineSelection((current) => (
      current && pipelineCapabilities
        ? reconcilePipelineSelection(pipelineCapabilities, {
          ...current,
          parser_provider: value,
        })
        : current
    ));
  }

  function updateRecommendationProvider(value: string) {
    setPipelineSelection((current) => {
      if (!current) {
        return current;
      }
      if (value !== "local_solver") {
        return {
          ...current,
          recommendation_provider: value,
          recommendation_engine: null,
        };
      }
      const selectedEngineAvailable = pipelineCapabilities?.recommendation_engines.some(
        (option) => option.available && option.id === current.recommendation_engine,
      );
      const recommendationEngine = selectedEngineAvailable
        ? current.recommendation_engine
        : pipelineCapabilities?.recommendation_engines.find((option) => option.available)?.id ?? null;
      return {
        ...current,
        recommendation_provider: value,
        recommendation_engine: recommendationEngine,
      };
    });
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

  function closeInfoDialog() {
    if (backupRestoring || mcpTokenPending) {
      return;
    }
    setInfoDialogOpen(false);
  }

  async function onApplicationBackupRestore(backupFile: File) {
    if (busy || backupRestoring) {
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

  function loadBenchmarkOverview(
    selection: PipelineSelection | null,
    preservePipelineComparison = false,
  ) {
    const requestId = ++benchmarkOverviewRequestRef.current;
    benchmarkComparisonReportRequestRef.current += 1;
    setExpandedBenchmarkCaseId(null);
    setBenchmarkCaseFilter("all");
    setBenchmarkComparisonReport(null);
    setBenchmarkComparisonReportLoading(false);
    setSelectedBenchmarkReport(null);
    setBenchmarkOverview((current) => current
      ? {
          ...current,
          latest_report: null,
          recent_reports: [],
          parser_pipelines: preservePipelineComparison
            ? current.parser_pipelines
            : [],
        }
      : null);
    setBenchmarkLoading(true);
    void getBenchmarkOverview(selection ?? undefined)
      .then((overview) => {
        if (requestId !== benchmarkOverviewRequestRef.current) {
          return;
        }
        if (overview.latest_report) {
          cacheBenchmarkReport(
            benchmarkReportCacheRef.current,
            overview.latest_report,
          );
        }
        setBenchmarkOverview(overview);
        setSelectedBenchmarkReport(overview.latest_report);
      })
      .catch((benchmarkError) => {
        if (requestId === benchmarkOverviewRequestRef.current) {
          setError(messageFromError(benchmarkError, "Could not load parser benchmark"));
        }
      })
      .finally(() => {
        if (requestId === benchmarkOverviewRequestRef.current) {
          setBenchmarkLoading(false);
        }
      });
  }

  function openBenchmarkDialog() {
    setBenchmarkDialogOpen(true);
    loadBenchmarkOverview(pipelineSelection);
  }

  function closeBenchmarkDialog() {
    benchmarkOverviewRequestRef.current += 1;
    benchmarkComparisonReportRequestRef.current += 1;
    setBenchmarkLoading(false);
    setBenchmarkComparisonReportLoading(false);
    setBenchmarkDialogOpen(false);
  }

  async function applyBenchmarkDatasetImportResult(
    result: BenchmarkDatasetImportResult,
  ): Promise<number> {
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
    const importedLayoutCounts = result.included_cases_by_layout;
    const hasImportedLayoutCounts = Boolean(
      importedLayoutCounts
      && (
        result.included_cases === 0
        || Object.keys(importedLayoutCounts).length > 0
      ),
    );
    const shouldRefreshOverview = !hasImportedLayoutCounts
      || Boolean(benchmarkOverview?.corpus_fingerprint);
    setBenchmarkOverview((current) => {
      return {
        included_cases: result.included_cases,
        included_cases_by_layout: hasImportedLayoutCounts
          ? importedLayoutCounts ?? undefined
          : undefined,
        corpus_fingerprint: undefined,
        default_layout_profile: current?.default_layout_profile,
        latest_report: current?.latest_report ?? null,
        recent_reports: current?.recent_reports ?? [],
        parser_pipelines: current?.parser_pipelines ?? [],
      };
    });
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
    if (shouldRefreshOverview) {
      const requestId = ++benchmarkOverviewRequestRef.current;
      try {
        const overview = await getBenchmarkOverview(pipelineSelection ?? undefined);
        if (
          appMountedRef.current
          && requestId === benchmarkOverviewRequestRef.current
        ) {
          if (overview.latest_report) {
            cacheBenchmarkReport(
              benchmarkReportCacheRef.current,
              overview.latest_report,
            );
          }
          setBenchmarkOverview(overview);
        }
      } catch (benchmarkError) {
        if (
          appMountedRef.current
          && requestId === benchmarkOverviewRequestRef.current
        ) {
          setError(messageFromError(
            benchmarkError,
            "Dataset imported, but benchmark counts could not be refreshed",
          ));
        }
      } finally {
        if (
          appMountedRef.current
          && requestId === benchmarkOverviewRequestRef.current
        ) {
          setBenchmarkLoading(false);
        }
      }
    }
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
      const readyCases = await applyBenchmarkDatasetImportResult(result);
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
      setBenchmarkOverview((current) => {
        const change = included ? 1 : -1;
        const layoutProfile = updated.parser_layout_profile
          ?? current?.default_layout_profile
          ?? null;
        const includedByLayout = layoutProfile
          && current?.included_cases_by_layout !== undefined
          ? {
              ...(current?.included_cases_by_layout ?? {}),
              [layoutProfile]: Math.max(
                0,
                (current?.included_cases_by_layout?.[layoutProfile] ?? 0) + change,
              ),
            }
          : current?.included_cases_by_layout;
        const corpusFingerprint = benchmarkCorpusFingerprintAfterLayoutMutation(
          current?.corpus_fingerprint,
          layoutProfile,
          benchmarkTargetLayoutProfile,
        );
        return current
          ? {
              ...current,
              included_cases: Math.max(0, current.included_cases + change),
              included_cases_by_layout: includedByLayout,
              corpus_fingerprint: corpusFingerprint,
            }
          : {
              included_cases: included ? 1 : 0,
              included_cases_by_layout: includedByLayout,
              corpus_fingerprint: undefined,
              default_layout_profile: layoutProfile ?? undefined,
              latest_report: null,
              recent_reports: [],
            };
      });
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

  function applyBenchmarkReport(
    latestReport: BenchmarkReport,
    selectReport: boolean,
  ) {
    const latestSummary = benchmarkReportSummary(latestReport);
    cacheBenchmarkReport(benchmarkReportCacheRef.current, latestReport);
    if (selectReport) {
      setSelectedBenchmarkReport(latestReport);
    }
    setBenchmarkOverview((current) => ({
      included_cases: current?.included_cases ?? latestReport.total_cases,
      included_cases_by_layout: current?.included_cases_by_layout,
      corpus_fingerprint: undefined,
      default_layout_profile: current?.default_layout_profile
        ?? latestReport.layout_profile,
      latest_report: selectReport
        ? latestReport
        : current?.latest_report ?? null,
      recent_reports: selectReport
        ? [
            latestSummary,
            ...(current?.recent_reports ?? []).filter(
              (summary) => summary.id !== latestReport.id,
            ),
          ].slice(0, 10)
        : current?.recent_reports ?? [],
      parser_pipelines: current?.parser_pipelines?.map((pipeline) => (
        pipeline.parser.id === latestReport.parser_provider
        && pipeline.layout_profile === latestReport.layout_profile
          ? { ...pipeline, latest_report: latestSummary }
          : pipeline
      )),
    }));
  }

  async function revalidateBenchmarkCorpusAfterRun(
    selection: PipelineSelection | null,
  ): Promise<void> {
    const requestId = ++benchmarkOverviewRequestRef.current;
    try {
      const overview = await getBenchmarkOverview(selection ?? undefined);
      if (
        appMountedRef.current
        && requestId === benchmarkOverviewRequestRef.current
      ) {
        if (overview.latest_report) {
          cacheBenchmarkReport(
            benchmarkReportCacheRef.current,
            overview.latest_report,
          );
        }
        setBenchmarkOverview(overview);
      }
    } catch (benchmarkError) {
      if (
        appMountedRef.current
        && requestId === benchmarkOverviewRequestRef.current
      ) {
        setError(messageFromError(
          benchmarkError,
          "Benchmark completed, but the current corpus could not be verified",
        ));
      }
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
      const latestReport = await runParserBenchmark(
        pipelineSelection ?? undefined,
      );
      applyBenchmarkReport(latestReport, true);
      if (latestReport.corpus_fingerprint) {
        await revalidateBenchmarkCorpusAfterRun(pipelineSelection);
      }
    } catch (benchmarkError) {
      setError(messageFromError(benchmarkError, "Parser benchmark failed"));
    } finally {
      setBenchmarkRunning(false);
    }
  }

  async function onRunBenchmarkComparison() {
    if (
      benchmarkOperationsLocked
      || benchmarkRunnablePipelines.length < 2
      || mutationRecoveryPending(["processing", "history"])
    ) {
      return;
    }
    const selectedParser = pipelineSelection?.parser_provider
      ?? benchmarkReport?.parser_provider
      ?? benchmarkRunnablePipelines[0]?.parser.id;
    const failures: string[] = [];
    let successfulRuns = 0;
    let corpusRevalidationRequired = false;
    setBenchmarkRunning(true);
    setError(null);
    try {
      for (const [index, pipeline] of benchmarkRunnablePipelines.entries()) {
        setBenchmarkComparisonProgress({
          parserId: pipeline.parser.id,
          completed: index,
          total: benchmarkRunnablePipelines.length,
        });
        try {
          const report = await runParserBenchmark({
            parser_provider: pipeline.parser.id,
            parser_layout_profile: pipeline.layout_profile,
          });
          applyBenchmarkReport(report, pipeline.parser.id === selectedParser);
          successfulRuns += 1;
          corpusRevalidationRequired ||= Boolean(report.corpus_fingerprint);
        } catch (benchmarkError) {
          failures.push(
            `${pipeline.parser.label}: ${messageFromError(
              benchmarkError,
              "Benchmark failed",
            )}`,
          );
        }
      }
      if (successfulRuns > 0 && corpusRevalidationRequired) {
        await revalidateBenchmarkCorpusAfterRun(pipelineSelection);
      }
      if (successfulRuns === benchmarkRunnablePipelines.length) {
        toast.success(`Benchmark comparison ready: ${successfulRuns} parsers`);
      } else if (successfulRuns > 0) {
        toast.warning(
          `Benchmark comparison completed for ${successfulRuns} of ${benchmarkRunnablePipelines.length} parsers. ${failures.join(" ")}`,
        );
      } else {
        setError(`No parser benchmark completed. ${failures.join(" ")}`);
      }
    } finally {
      setBenchmarkComparisonProgress(null);
      setBenchmarkRunning(false);
    }
  }

  async function selectBenchmarkParserPipeline(parserProvider: string) {
    if (
      benchmarkOperationsLocked
      || pipelineLoading
      || parserProvider === pipelineSelection?.parser_provider
    ) {
      return;
    }
    let capabilities = pipelineCapabilities;
    if (!capabilities) {
      setPipelineLoading(true);
      setError(null);
      try {
        capabilities = await getPipelineCapabilities();
        setPipelineCapabilities(capabilities);
      } catch (pipelineError) {
        setError(messageFromError(
          pipelineError,
          "Could not read analysis plugins",
        ));
        return;
      } finally {
        setPipelineLoading(false);
      }
    }
    const currentSelection = reconcilePipelineSelection(
      capabilities,
      pipelineSelection ?? capabilities.defaults,
    );
    const nextSelection = reconcilePipelineSelection(capabilities, {
      ...currentSelection,
      parser_provider: parserProvider,
    });
    if (
      nextSelection.parser_provider !== parserProvider
      || nextSelection.parser_layout_profile !== currentSelection.parser_layout_profile
    ) {
      setError("That parser is not available for the selected table layout");
      return;
    }
    setPipelineSelection(nextSelection);
    loadBenchmarkOverview(nextSelection, true);
  }

  async function selectBenchmarkReport(reportId: string) {
    if (reportId === benchmarkReport?.id) {
      return;
    }
    setBenchmarkReportLoading(true);
    setExpandedBenchmarkCaseId(null);
    setError(null);
    try {
      setSelectedBenchmarkReport(await loadCachedBenchmarkReport(
        reportId,
        benchmarkReportCacheRef.current,
        benchmarkReportRequestsRef.current,
      ));
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
      closeBenchmarkDialog();
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

  function openScreenshotDetails(candidate: JobRecord) {
    setManagedJobId(candidate.id);
    setScreenshotTitle(typeof candidate.title === "string" ? candidate.title : "");
    setScreenshotNotes(typeof candidate.notes === "string" ? candidate.notes : "");
    setScreenshotTagInput(screenshotTags(candidate).join(", "));
    setScreenshotDeleteArmed(false);
    setError(null);
  }

  function closeScreenshotDetails() {
    if (screenshotMetadataSaving || screenshotDeleting) {
      return;
    }
    setManagedJobId(null);
    setScreenshotDeleteArmed(false);
  }

  async function saveScreenshotMetadata() {
    if (
      !managedJob
      || !managedJobPersisted
      || screenshotMetadataSaving
      || screenshotDeleting
    ) {
      return;
    }
    const mutationScope = persistedJobMutationScope(managedJob);
    const savingAlongsideRecommendation = mutationComposesWithActiveRecommendation(
      mutationScope,
    );
    if (
      !savingAlongsideRecommendation
      && mutationRecoveryPending([mutationScope])
    ) {
      return;
    }

    let tags: string[];
    try {
      tags = parseScreenshotTags(screenshotTagInput);
    } catch (metadataError) {
      setError(messageFromError(metadataError, "Check the screenshot tags"));
      return;
    }
    const title = screenshotTitle.trim() || null;
    const notes = screenshotNotes.trim() || null;
    const expectation: JobMutationExpectation = {
      kind: "metadata",
      title,
      notes,
      tags,
    };
    if (savingAlongsideRecommendation) {
      if (mutationScope === "processing") {
        beginProcessingMembershipMutation();
      } else {
        beginHistoryMutation();
      }
    } else {
      beginPersistedJobMutation(managedJob, expectation);
    }
    let restoreAfterMutation = false;
    let deletedRemotely = false;
    setScreenshotMetadataSaving(true);
    setError(null);
    try {
      const updated = await updateJobMetadata(managedJob.id, {
        title,
        notes,
        tags,
      });
      const movedToHistory = mutationScope === "processing"
        && updated.archived_at !== null;
      if (movedToHistory) {
        removeJobFromProcessingProjection(updated.id);
        setManagedJobId(null);
        markHistorySessionUnsynced();
      } else {
        updateJobs((current) => current.map((candidate) =>
          candidate.id === updated.id ? updated : candidate
        ));
      }
      updateHistoryJob(updated);
      if (!savingAlongsideRecommendation) {
        settlePersistedMutationLease(
          mutationScope,
          [updated],
          mutationScope === "processing",
        );
      }
      if (movedToHistory) {
        void requestHistoryRestore(null, true);
      }
      setScreenshotTitle(updated.title ?? "");
      setScreenshotNotes(updated.notes ?? "");
      setScreenshotTagInput(screenshotTags(updated).join(", "));
      toast.success("Screenshot details saved");
    } catch (metadataError) {
      deletedRemotely = metadataError instanceof ApiResponseError
        && metadataError.status === 404;
      if (deletedRemotely) {
        restoreAfterMutation = true;
        reconcileAuthoritativeScreenshotRemoval(managedJob, mutationScope);
        toast.warning("Screenshot was already deleted elsewhere");
      } else if (mutationFailureMayHavePersistedSideEffect(metadataError)) {
        markPersistedJobMutationUncertain(mutationScope, managedJob.id);
        restoreAfterMutation = true;
      }
      if (!deletedRemotely) {
        setError(messageFromError(metadataError, "Could not save screenshot details"));
      }
    } finally {
      if (savingAlongsideRecommendation) {
        if (mutationScope === "processing") {
          endProcessingMembershipMutation(restoreAfterMutation);
        } else {
          endHistoryMutation(restoreAfterMutation);
        }
      } else {
        endPersistedJobMutation(
          mutationScope,
          deletedRemotely,
        );
      }
      setScreenshotMetadataSaving(false);
    }
  }

  function removeJobFromProcessingProjection(jobId: string) {
    const currentJobs = jobsRef.current;
    const deletedIndex = currentJobs.findIndex(
      (candidate) => candidate.id === jobId,
    );
    const nextJobs = currentJobs.filter((candidate) => candidate.id !== jobId);
    updateJobs(() => nextJobs);
    clearJobAttention(jobId);
    if (activeJobIdRef.current === jobId) {
      const fallbackIndex = Math.min(Math.max(deletedIndex, 0), nextJobs.length - 1);
      alignWorkspaceToJob(nextJobs[fallbackIndex] ?? null);
    }
    if (writeProcessingQueue(nextJobs)) {
      markProcessingQueueSessionSynced();
    }
  }

  function removeScreenshotFromClient(deletedJob: JobRecord) {
    removeJobFromProcessingProjection(deletedJob.id);

    const removedFromSearch = historySearchResults?.some(
      (item) => item.id === deletedJob.id,
    ) ?? false;
    setHistory((current) => {
      const next = current.filter((item) => item.id !== deletedJob.id);
      writeHistory(next);
      return next;
    });
    setHistorySearchResults((current) =>
      current?.filter((item) => item.id !== deletedJob.id) ?? null
    );
    if (deletedJob.archived_at) {
      setHistoryTotal((current) => {
        const next = Math.max(0, current - 1);
        writeHistoryTotal(next);
        return next;
      });
    }
    if (removedFromSearch) {
      setHistorySearchTotal((current) => Math.max(0, current - 1));
    }
  }

  function reconcileAuthoritativeScreenshotRemoval(
    deletedJob: JobRecord,
    mutationScope: PersistedJobMutationScope,
  ) {
    const activeRecommendation = activeRecommendationRequestsRef.current.get(
      deletedJob.id,
    );
    if (
      activeRecommendation?.ownsMutationLease
      && activeRecommendation.mutationScope === mutationScope
    ) {
      clearOwnedMutationLease(mutationScope);
    }
    if (mutationScope === "processing") {
      processingRemovalCandidateIdsRef.current.delete(deletedJob.id);
    }
    removeScreenshotFromClient(deletedJob);
    if (benchmarkOverview !== null || deletedJob.benchmark_included) {
      const requestId = ++benchmarkOverviewRequestRef.current;
      void getBenchmarkOverview(pipelineSelection ?? undefined)
        .then((overview) => {
          if (requestId === benchmarkOverviewRequestRef.current) {
            setBenchmarkOverview(overview);
          }
        })
        .catch((benchmarkError) => {
          if (requestId === benchmarkOverviewRequestRef.current) {
            setError(messageFromError(
              benchmarkError,
              "Screenshot removed, but the benchmark count could not refresh",
            ));
          }
        })
        .finally(() => {
          if (requestId === benchmarkOverviewRequestRef.current) {
            setBenchmarkLoading(false);
          }
        });
    }
    setManagedJobId(null);
    setScreenshotDeleteArmed(false);
    if (mutationScope === "processing") {
      markHistorySessionUnsynced();
      void requestHistoryRestore(null, true);
    } else {
      markProcessingQueueSessionUnsynced();
      scheduleProcessingQueueRestore();
    }
    if (activeRecommendation?.mutationScope === mutationScope) {
      activeRecommendation.controller.abort();
    }
  }

  async function permanentlyDeleteScreenshot() {
    if (!managedJob || screenshotMetadataSaving || screenshotDeleting) {
      return;
    }
    if (!managedJobPersisted) {
      if (localUploadDeletionRequiresRecovery(managedJob)) {
        markProcessingQueueSessionUnsynced();
        if (processingMutationLeaseRef.current !== null) {
          scheduleMutationLeaseRevalidation();
        } else {
          scheduleProcessingQueueRestore();
        }
        setError(
          "Checking whether this upload reached storage. Delete it after recovery finishes.",
        );
        return;
      }
      removeScreenshotFromClient(managedJob);
      setManagedJobId(null);
      setScreenshotDeleteArmed(false);
      toast.success("Failed upload removed from the queue");
      return;
    }

    const mutationScope = persistedJobMutationScope(managedJob);
    const deletingAlongsideRecommendation = mutationComposesWithActiveRecommendation(
      mutationScope,
    );
    if (
      !deletingAlongsideRecommendation
      && mutationRecoveryPending([mutationScope])
    ) {
      return;
    }
    if (mutationScope === "processing") {
      beginProcessingMembershipMutation([managedJob.id]);
    } else {
      beginHistoryMutation();
    }
    setScreenshotDeleting(true);
    setError(null);
    let restoreAfterMutation = false;
    try {
      await deleteJob(managedJob.id);
      restoreAfterMutation = true;
      reconcileAuthoritativeScreenshotRemoval(managedJob, mutationScope);
      toast.success("Screenshot permanently deleted");
    } catch (deleteError) {
      restoreAfterMutation = true;
      setError(messageFromError(deleteError, "Could not delete screenshot"));
    } finally {
      if (mutationScope === "processing") {
        endProcessingMembershipMutation(restoreAfterMutation);
      } else {
        endHistoryMutation(restoreAfterMutation);
      }
      setScreenshotDeleting(false);
    }
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
      <AppToolbar
        automationEnabled={automationEnabled}
        busy={busy}
        historyTotal={historyTotal}
        liveStatusLabel={liveStatusLabel}
        onConfigureAutomation={() => setAutomationDialogOpen(true)}
        onConfigurePipeline={openPipelineDialog}
        onOpenBenchmark={openBenchmarkDialog}
        onOpenHelp={() => setHelpDialogOpen(true)}
        onOpenInfo={openInfoDialog}
        onOpenTraining={openTrainingDialog}
        onToggleAutomation={() => updateAutomationSettings((current) => ({
          ...current,
          enabled: !current.enabled,
        }))}
        queueCount={queueCount}
        screenSharing={screenSharing}
      />

      <section className="app-workspace">
        <aside className="control-rail" aria-label="Capture, queue and history">
          <InputSourcePanel
            busy={busy}
            files={files}
            inputMode={inputMode}
            livePreviewVisible={livePreviewVisible}
            onCapture={onCaptureScreen}
            onFilesChange={setFiles}
            onInputModeChange={setInputMode}
            onShareModeChange={setShareMode}
            onStartOrViewShare={() => (
              screenSharing ? setLivePreviewVisible(true) : onStartScreenShare()
            )}
            onStopShare={onStopScreenShare}
            onUpload={onUpload}
            screenSharing={screenSharing}
            screenSourceLabel={screenSourceLabel}
            shareMode={shareMode}
          />

          <ScreenshotQueuePanel
            activeJobId={job?.id ?? null}
            attentionByJobId={jobAttention}
            busy={busy}
            clearDisabled={historyLoading || busy || clearableJobs.length === 0}
            count={filmstripCount}
            jobs={jobs}
            onClearReviewed={clearReviewedToHistory}
            onManageJob={openScreenshotDetails}
            onOpenJob={activateJob}
            pendingFilesLabel={files.length > 0 ? selectedFilesLabel(files) : null}
          />

          <HistoryPanel
            busy={busy}
            items={visibleHistory}
            loading={historyLoading}
            onClearSearch={clearHistorySearch}
            onLoadOlder={() => void loadOlderHistory()}
            onManageJob={openScreenshotDetails}
            onOpenItem={openHistory}
            onOpenSearch={() => setHistorySearchOpen(true)}
            onRefresh={() => void refreshVisibleHistory()}
            onSearch={() => void onSearchHistory()}
            onSearchInputChange={setHistorySearchInput}
            searchActive={historySearchActive}
            searchInput={historySearchInput}
            searchOpen={historySearchOpen}
            searchTotal={historySearchTotal}
            total={visibleHistoryTotal}
          />
        </aside>

        <TablePreview
          averageConfidence={confidenceSummary.averageConfidence}
          detectedFieldCount={confidenceSummary.detectedCount}
          fieldCount={confidenceSummary.fieldTotal}
          frameLabel={frameLabel}
          frameStreet={frameStreet}
          livePreviewVisible={livePreviewVisible}
          ref={videoRef}
          reviewCount={confidenceSummary.reviewCount}
          screenSharing={screenSharing}
          screenshotUrl={screenshotUrl}
        />

        <section className="review-column" aria-label="Hand review">
          <div className="panel-header">
            <h2>Detected state</h2>
            {job ? <JobStatusBadge status={job.status} /> : null}
          </div>

          <div className="review-scroll">
            <DetectedStateForm
              confidences={confidences}
              disabled={stateControlsDisabled}
              form={form}
              onChange={updateForm}
              warnings={warnings}
            >
              {form.street === "turn" || form.street === "river" ? (
                <ActionHistoryField
                  addDisabled={stateControlsDisabled || completedPostflopActionsAtLimit}
                  addLabel="Add action"
                  emptyMessage="No completed streets recorded"
                  heading="Completed streets (total BB)"
                  itemCount={form.completed_postflop_actions.length}
                  onAdd={addCompletedPostflopAction}
                >
                      {form.completed_postflop_actions.map((action, index) => (
                        <ActionHistoryRow className="completed-action-history-row" index={index} key={index}>
                          <SelectControl
                            aria-label={`Completed action ${index + 1} street`}
                            density="compact"
                            disabled={stateControlsDisabled}
                            value={action.street}
                            onChange={(event) => updateCompletedPostflopAction(index, "street", event.target.value)}
                          >
                            <option
                              value="flop"
                              disabled={
                                action.street !== "flop"
                                && completedPostflopActionCounts.flop >= 8
                              }
                            >
                              Flop
                            </option>
                            {form.street === "river" ? (
                              <option
                                value="turn"
                                disabled={
                                  action.street !== "turn"
                                  && completedPostflopActionCounts.turn >= 8
                                }
                              >
                                Turn
                              </option>
                            ) : null}
                          </SelectControl>
                          <SelectControl
                            aria-label={`Completed action ${index + 1} actor`}
                            density="compact"
                            disabled={stateControlsDisabled}
                            value={action.actor}
                            onChange={(event) => updateCompletedPostflopAction(index, "actor", event.target.value)}
                          >
                            <option value="oop">OOP</option>
                            <option value="ip">IP</option>
                          </SelectControl>
                          <SelectControl
                            aria-label={`Completed action ${index + 1} type`}
                            density="compact"
                            disabled={stateControlsDisabled}
                            value={action.action}
                            onChange={(event) => updateCompletedPostflopAction(index, "action", event.target.value)}
                          >
                            <option value="check">Check</option>
                            <option value="bet">Bet</option>
                            <option value="raise">Raise to</option>
                            <option value="call">Call to</option>
                          </SelectControl>
                          <TextInput
                            density="compact"
                            aria-label={`Completed action ${index + 1} amount`}
                            disabled={stateControlsDisabled || action.action === "check"}
                            inputMode="decimal"
                            value={action.amount}
                            onChange={(event) => updateCompletedPostflopAction(index, "amount", event.target.value)}
                            placeholder={action.action === "check" ? "-" : "BB"}
                          />
                          <ButtonControl
                            iconOnly
                            disabled={stateControlsDisabled}
                            onClick={() => removeCompletedPostflopAction(index)}
                            title={`Remove completed action ${index + 1}`}
                            aria-label={`Remove completed action ${index + 1}`}
                          >
                            <X size={13} aria-hidden="true" />
                          </ButtonControl>
                        </ActionHistoryRow>
                      ))}
                </ActionHistoryField>
              ) : null}
              {form.street !== "" && form.street !== "preflop" && form.facing_action === "raise" ? (
                <ActionHistoryField
                  addDisabled={stateControlsDisabled || form.postflop_action_history.length >= 8}
                  addLabel="Add action"
                  emptyMessage="No current-street actions recorded"
                  heading="Current street history (total BB)"
                  itemCount={form.postflop_action_history.length}
                  onAdd={addPostflopAction}
                >
                      {form.postflop_action_history.map((action, index) => (
                        <ActionHistoryRow index={index} key={index}>
                          <SelectControl
                            aria-label={`Action ${index + 1} actor`}
                            density="compact"
                            disabled={stateControlsDisabled}
                            value={action.actor}
                            onChange={(event) => updatePostflopAction(index, "actor", event.target.value)}
                          >
                            <option value="oop">OOP</option>
                            <option value="ip">IP</option>
                          </SelectControl>
                          <SelectControl
                            aria-label={`Action ${index + 1} type`}
                            density="compact"
                            disabled={stateControlsDisabled}
                            value={action.action}
                            onChange={(event) => updatePostflopAction(index, "action", event.target.value)}
                          >
                            <option value="check">Check</option>
                            <option value="bet">Bet</option>
                            <option value="raise">Raise to</option>
                          </SelectControl>
                          <TextInput
                            density="compact"
                            aria-label={`Action ${index + 1} amount`}
                            disabled={stateControlsDisabled || action.action === "check"}
                            inputMode="decimal"
                            value={action.amount}
                            onChange={(event) => updatePostflopAction(index, "amount", event.target.value)}
                            placeholder={action.action === "check" ? "-" : "BB"}
                          />
                          <ButtonControl
                            iconOnly
                            disabled={stateControlsDisabled}
                            onClick={() => removePostflopAction(index)}
                            title={`Remove action ${index + 1}`}
                            aria-label={`Remove action ${index + 1}`}
                          >
                            <X size={13} aria-hidden="true" />
                          </ButtonControl>
                        </ActionHistoryRow>
                      ))}
                </ActionHistoryField>
              ) : null}
              {form.street === "preflop" && form.facing_action === "raise" ? (
                <>
                  {form.preflop_action_history.length === 0 ? (
                    <>
                      <DetectedStateField label="Opener position" confidenceText="manual">
                        <SelectControl
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
                        </SelectControl>
                      </DetectedStateField>
                      <DetectedStateField label="Opening size" confidenceText="manual">
                        <TextInput
                          disabled={stateControlsDisabled}
                          inputMode="decimal"
                          value={form.preflop_open_size}
                          onChange={(event) => updateForm("preflop_open_size", event.target.value)}
                          placeholder="BB"
                        />
                      </DetectedStateField>
                    </>
                  ) : null}
                  <ActionHistoryField
                    addDisabled={stateControlsDisabled || form.preflop_action_history.length >= 8}
                    addLabel="Add preflop action"
                    emptyMessage="No actions recorded"
                    heading="Preflop history (total BB)"
                    itemCount={form.preflop_action_history.length}
                    onAdd={addPreflopAction}
                  >
                        {form.preflop_action_history.map((action, index) => (
                          <ActionHistoryRow index={index} key={index}>
                            <SelectControl
                              aria-label={`Preflop action ${index + 1} actor`}
                              density="compact"
                              disabled={stateControlsDisabled}
                              value={action.actor}
                              onChange={(event) => updatePreflopAction(index, "actor", event.target.value)}
                            >
                              {PREFLOP_POSITIONS.map((position) => (
                                <option key={position.value} value={position.value}>
                                  {position.label}
                                </option>
                              ))}
                            </SelectControl>
                            <SelectControl
                              aria-label={`Preflop action ${index + 1} type`}
                              density="compact"
                              disabled={stateControlsDisabled}
                              value={action.action}
                              onChange={(event) => updatePreflopAction(index, "action", event.target.value)}
                            >
                              <option value="raise">Raise to</option>
                              <option value="call">Call</option>
                            </SelectControl>
                            <TextInput
                              density="compact"
                              aria-label={`Preflop action ${index + 1} amount`}
                              disabled={stateControlsDisabled}
                              inputMode="decimal"
                              value={action.amount}
                              onChange={(event) => updatePreflopAction(index, "amount", event.target.value)}
                              placeholder="BB"
                            />
                            <ButtonControl
                              iconOnly
                              disabled={stateControlsDisabled}
                              onClick={() => removePreflopAction(index)}
                              title={`Remove preflop action ${index + 1}`}
                              aria-label={`Remove preflop action ${index + 1}`}
                            >
                              <X size={13} aria-hidden="true" />
                            </ButtonControl>
                          </ActionHistoryRow>
                        ))}
                  </ActionHistoryField>
                </>
              ) : null}
            </DetectedStateForm>

            {currentStateApproved && !activeRecommendation ? (
              <section className="training-decision" aria-label="Your training decision">
                <div className="training-decision-head">
                  <span>Your decision</span>
                  <small>{activeTrainingDecision ? "Answer locked" : "Optional before reveal"}</small>
                </div>
                <SegmentedControl
                  ariaLabel="Choose your action"
                  className="training-action-options"
                  options={TRAINING_ACTION_OPTIONS}
                  value={trainingAction}
                  onChange={(action) => {
                    setTrainingAction(action);
                    if (action !== "bet" && action !== "raise") {
                      setTrainingSizing("");
                    }
                  }}
                  disabled={busy}
                />
                <div className="training-certainty">
                  <span>How sure?</span>
                  <SegmentedControl
                    ariaLabel="How sure are you?"
                    options={TRAINING_CERTAINTY_OPTIONS}
                    value={trainingCertainty}
                    onChange={(certainty) => setTrainingCertainty(
                      trainingCertainty === certainty ? "" : certainty,
                    )}
                    disabled={busy}
                  />
                </div>
                <div className="training-decision-footer">
                  {trainingAction === "bet" || trainingAction === "raise" ? (
                    <FormField label="Size">
                      <TextInput
                        density="compact"
                        aria-label="Decision sizing in BB"
                        inputMode="decimal"
                        value={trainingSizing}
                        onChange={(event) => setTrainingSizing(event.target.value)}
                        placeholder="BB"
                        disabled={busy}
                      />
                    </FormField>
                  ) : null}
                  <span className="training-decision-hint">
                    {activeTrainingDecision
                      ? "Saved before reveal"
                      : trainingAction
                        ? "Ready to lock"
                        : "No answer selected"}
                  </span>
                  <ButtonControl
                    variant="secondary"
                    onClick={onSaveTrainingDecision}
                    disabled={!trainingAction || busy}
                  >
                    <Check size={13} aria-hidden="true" />
                    {activeTrainingDecision ? "Update answer" : "Lock answer"}
                  </ButtonControl>
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
                            <ButtonControl
                              variant="ghost"
                              onClick={onReopenTrainingReview}
                              disabled={busy || trainingReviewNoteEditing}
                            >
                              <RefreshCcw size={11} aria-hidden="true" />
                              Reopen review
                            </ButtonControl>
                          </div>
                        ) : (
                          <ButtonControl variant="ghost" onClick={onCompleteTrainingReview} disabled={busy}>
                            <Check size={12} aria-hidden="true" />
                            {trainingReviewQueueJobId === job?.id
                              ? "Mark reviewed & next"
                              : "Mark reviewed"}
                          </ButtonControl>
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
                          <TextAreaControl
                            appearance="inverse"
                            aria-label="Edit training review note"
                            value={trainingReviewNote}
                            onChange={(event) => setTrainingReviewNote(event.target.value)}
                            maxLength={MAX_TRAINING_REVIEW_NOTE_LENGTH}
                            rows={2}
                            placeholder="What will you remember next time?"
                            disabled={busy}
                          />
                          <span className="training-review-note-actions">
                            <ButtonControl
                              variant="secondary"
                              onClick={cancelTrainingReviewNoteEdit}
                              disabled={busy}
                            >
                              <X size={11} aria-hidden="true" />
                              Cancel
                            </ButtonControl>
                            <ButtonControl
                              variant="secondary"
                              onClick={() => void onUpdateTrainingReviewNote()}
                              disabled={
                                busy
                                || (trainingReviewNote.trim() || null) === job.training_review_note
                              }
                            >
                              <Check size={11} aria-hidden="true" />
                              Save note
                            </ButtonControl>
                          </span>
                        </label>
                      ) : job.training_review_note ? (
                        <div className="training-review-note-saved" aria-label="Saved training review note">
                          <div>
                            <strong>Review note</strong>
                            <ButtonControl
                              variant="secondary"
                              onClick={startTrainingReviewNoteEdit}
                              disabled={busy}
                              aria-label="Edit training review note"
                              title="Edit lesson note"
                            >
                              <Pencil size={11} aria-hidden="true" />
                            </ButtonControl>
                          </div>
                          <span>{job.training_review_note}</span>
                        </div>
                      ) : (
                        <ButtonControl
                          variant="secondary"
                          className="training-review-note-add"
                          onClick={startTrainingReviewNoteEdit}
                          disabled={busy}
                        >
                          <Pencil size={11} aria-hidden="true" />
                          Add lesson note
                        </ButtonControl>
                      )
                    ) : (
                      <label className="training-review-note">
                        <span>
                          Review note
                          <small>{trainingReviewNote.length}/{MAX_TRAINING_REVIEW_NOTE_LENGTH}</small>
                        </span>
                        <TextAreaControl
                          appearance="inverse"
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
            <ButtonControl onClick={onApprove} disabled={!canApprove || busy} aria-label="Approve state">
              <Check size={15} aria-hidden="true" />
              Approve
            </ButtonControl>
            <ButtonControl variant="secondary" onClick={onRecommend} disabled={!canRecommend || busy} aria-label="Request recommendation">
              <Play size={14} aria-hidden="true" />
              Recommend
            </ButtonControl>
            <ButtonControl variant="ghost" iconOnly onClick={resetToParser} disabled={!job?.parser_result || busy} title="Reset to parser" aria-label="Reset to parser">
              <RefreshCcw size={14} aria-hidden="true" />
            </ButtonControl>
          </div>
        </section>
      </section>

      {queueProgress ? (
        <QueueProcessingDialog
          onAbort={onAbortQueue}
          progress={queueProgress}
        />
      ) : null}

      {managedJob ? (
        <ScreenshotDetailsDialog
          deleteArmed={screenshotDeleteArmed}
          deleting={screenshotDeleting}
          job={managedJob}
          metadataSaving={screenshotMetadataSaving}
          notes={screenshotNotes}
          onClose={closeScreenshotDetails}
          onDelete={() => void permanentlyDeleteScreenshot()}
          onDeleteArmedChange={setScreenshotDeleteArmed}
          onNotesChange={setScreenshotNotes}
          onSave={() => void saveScreenshotMetadata()}
          onTagsChange={setScreenshotTagInput}
          onTitleChange={setScreenshotTitle}
          persisted={managedJobPersisted}
          recoveryPending={managedLocalUploadRecoveryPending}
          tags={screenshotTagInput}
          title={screenshotTitle}
        />
      ) : null}

      {automationDialogOpen ? (
        <AutomationDialog
          allowWarnings={automationAllowWarnings}
          autoApprove={automationApprove}
          autoRecommend={automationRecommend}
          enabled={automationEnabled}
          onAllowWarningsChange={(value) => updateAutomationSettings((current) => ({
            ...current,
            allowWarnings: value,
          }))}
          onAutoApproveChange={updateAutomationApprove}
          onAutoRecommendChange={(value) => updateAutomationSettings((current) => ({
            ...current,
            autoRecommend: value,
          }))}
          onClose={() => setAutomationDialogOpen(false)}
        />
      ) : null}

      {pipelineDialogOpen ? (
        <PipelineDialog
          capabilities={pipelineCapabilities}
          compatibleLayouts={pipelineCapabilities && pipelineSelection
            ? compatiblePipelineLayouts(
              pipelineCapabilities,
              pipelineSelection.parser_provider,
            )
            : []}
          loading={pipelineLoading}
          onClose={() => setPipelineDialogOpen(false)}
          onParserChange={updateParserProvider}
          onParserLayoutChange={(value) => updatePipelineSelection(
            "parser_layout_profile",
            value,
          )}
          onRecommendationChange={updateRecommendationProvider}
          onRecommendationEngineChange={(value) => updatePipelineSelection(
            "recommendation_engine",
            value,
          )}
          selection={pipelineSelection}
        />
      ) : null}

      {helpDialogOpen ? (
        <UserGuideDialog onClose={() => setHelpDialogOpen(false)} />
      ) : null}

      {infoDialogOpen ? (
        <InfoDialog
          backupDownloadUrl={applicationBackupUrl()}
          backupRestoring={backupRestoring}
          busy={busy}
          mcpTokenPending={mcpTokenPending}
          onClose={closeInfoDialog}
          onMcpTokenPendingChange={setMcpTokenPending}
          onRestoreBackup={(file) => void onApplicationBackupRestore(file)}
          providers={activeInfoProviders}
          systemInfoLoading={systemInfoLoading}
        />
      ) : null}

      {trainingDialogOpen ? (
        <DialogFrame
          className="training-progress-dialog"
          titleId="training-progress-title"
        >
            <DialogHeader
              titleId="training-progress-title"
              title="Training progress"
              subtitle="Your locked answers compared with completed recommendations"
              closeLabel="Close training progress"
              closeDisabled={trainingReviewJobId !== null}
              onClose={() => setTrainingDialogOpen(false)}
            />

            <div className="training-progress-body">
              {trainingProgressLoading ? (
                <StateMessage centered className="training-progress-empty">Reading reviewed decisions...</StateMessage>
              ) : trainingProgress && trainingProgress.reviewed_hands > 0 ? (
                <>
                  <TrainingProgressOverview progress={trainingProgress} />

                  <TrainingSolverCoverage
                    controlsDisabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                    coverage={trainingProgress.solver_coverage}
                    engineLabel={providerLabel}
                    onFilterChange={updateTrainingSolverFilter}
                  />

                  <TrainingCertaintyCalibration
                    certaintyLabel={trainingCertaintyLabel}
                    controlsDisabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                    focus={certaintyFocus}
                    onFilterChange={updateTrainingCertaintyFilter}
                    onReview={focusTrainingReviewCertainty}
                    progress={trainingProgress}
                    showFocus={trainingProgressView === "recent"}
                  />

                  <TrainingActionDifferences
                    actionLabel={(action) => trainingDecisionLabel(action, null)}
                    controlsDisabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                    differences={trainingProgress.action_differences}
                    focus={actionDifferenceFocus}
                    onReview={focusTrainingActionDifference}
                    showFocus={trainingProgressView === "recent"}
                  />

                  <TrainingStreetSummary
                    controlsDisabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                    focus={trainingFocus}
                    onFilterChange={updateTrainingStreetFilter}
                    onReview={focusTrainingReviewStreet}
                    reviewCounts={trainingProgress.review_street_counts}
                    showFocus={trainingProgressView === "recent"}
                    summaries={trainingProgress.street_summaries}
                  />

                  <TrainingPositionSummary
                    controlsDisabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                    focus={positionFocus}
                    onFilterChange={updateTrainingPositionFilter}
                    onReview={focusTrainingReviewPosition}
                    progress={trainingProgress}
                    showFocus={trainingProgressView === "recent"}
                  />

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
                            <FormField className="training-review-order" label="Order" labelClassName="training-review-order-label">
                              <SelectControl
                                aria-label="Review order"
                                density="compact"
                                value={trainingReviewOrder}
                                onChange={(event) => void updateTrainingReviewQueue(
                                  event.target.value as TrainingReviewOrder,
                                  trainingReviewStreet,
                                )}
                                disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                              >
                                <option value="recent">Newest</option>
                                <option value="ev_loss">EV loss</option>
                              </SelectControl>
                            </FormField>
                            <FormField className="training-review-order" label="Street" labelClassName="training-review-order-label">
                              <SelectControl
                                aria-label="Review street"
                                density="compact"
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
                              </SelectControl>
                            </FormField>
                            <FormField className="training-review-order" label="Certainty" labelClassName="training-review-order-label">
                              <SelectControl
                                aria-label="Review certainty"
                                density="compact"
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
                              </SelectControl>
                            </FormField>
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
                              <TextInput
                                appearance="borderless"
                                density="compact"
                                type="search"
                                aria-label="Search saved lesson notes"
                                placeholder="Search notes"
                                maxLength={120}
                                value={trainingLessonSearch}
                                onChange={(event) => setTrainingLessonSearch(event.target.value)}
                                disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                              />
                              <ButtonControl
                                type="submit"
                                variant="ghost"
                                className="training-lesson-search-submit"
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
                              </ButtonControl>
                            </form>
                            <FormField className="training-review-order" label="Order" labelClassName="training-review-order-label">
                              <SelectControl
                                aria-label="Lesson order"
                                density="compact"
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
                              </SelectControl>
                            </FormField>
                            <FormField className="training-review-order" label="Street" labelClassName="training-review-order-label">
                              <SelectControl
                                aria-label="Lesson street"
                                density="compact"
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
                              </SelectControl>
                            </FormField>
                          </>
                        ) : null}
                        <SegmentedControl
                          ariaLabel="Training decision view"
                          className="training-view-switch"
                          options={[
                            { value: "recent", label: "Recent" },
                            {
                              value: "review",
                              label: `Needs review ${trainingProgress.needs_review_hands}`,
                            },
                            {
                              value: "lessons",
                              label: `Lessons ${trainingProgress.lesson_count ?? trainingProgress.lesson_hands?.length ?? 0}`,
                            },
                          ]}
                          value={trainingProgressView}
                          onChange={(view) => {
                            if (view === "recent") {
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
                              return;
                            }
                            if (view === "review") {
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
                              return;
                            }
                            setTrainingProgressView("lessons");
                          }}
                        />
                      </div>
                    </div>
                    <TrainingActiveFilters
                      actionLabel={(action) => trainingDecisionLabel(action, null)}
                      certaintyFilter={trainingCertaintyFilter}
                      controlsDisabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                      onClearCertainty={() => updateTrainingCertaintyFilter(null)}
                      onClearPosition={() => updateTrainingPositionFilter(null)}
                      onClearReviewDifference={() => updateTrainingReviewQueue(
                        trainingReviewOrder,
                        trainingReviewStreet,
                        null,
                      )}
                      onClearReviewPosition={() => updateTrainingReviewQueue(
                        trainingReviewOrder,
                        trainingReviewStreet,
                        trainingReviewDifference,
                        trainingReviewCertainty,
                        null,
                      )}
                      onClearSolver={() => updateTrainingSolverFilter(null)}
                      onClearStreet={() => updateTrainingStreetFilter(null)}
                      positionFilter={trainingPositionFilter}
                      reviewDifference={trainingReviewDifference}
                      reviewPosition={trainingReviewPosition}
                      solverFilter={trainingSolverFilter}
                      streetFilter={trainingStreetFilter}
                      view={trainingProgressView}
                    />
                    <TrainingDecisionList
                      certaintyLabel={trainingCertaintyLabel}
                      decisionLabel={trainingDecisionLabel}
                      hands={visibleTrainingHands}
                      lessonFiltersActive={trainingLessonStreet !== "all" || Boolean(trainingLessonQuery)}
                      onOpen={reviewTrainingHand}
                      onReopen={reopenTrainingReviewFromProgress}
                      openDisabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                      positionFilter={trainingPositionFilter}
                      reopenDisabled={trainingReviewJobId !== null || busy}
                      solverFilter={trainingSolverFilter}
                      streetFilter={trainingStreetFilter}
                      view={trainingProgressView}
                    />
                  </section>
                </>
              ) : (
                <StateMessage centered className="training-progress-empty">
                  Lock an answer before revealing a recommendation to start tracking progress.
                </StateMessage>
              )}
            </div>

            <DialogFooter className="training-progress-footer">
              <span>{reviewQueueStatus}</span>
              {trainingProgressView === "lessons" ? (
                <DownloadLinkControl
                  className="training-lessons-export"
                  href={trainingLessonsExportUrl(
                    trainingLessonStreet,
                    trainingLessonQuery,
                    trainingLessonOrder,
                  )}
                  download="poker-hero-lessons.md"
                  disabled={trainingLessonsExportDisabled}
                >
                  <Download size={14} aria-hidden="true" />
                  Export lessons
                </DownloadLinkControl>
              ) : null}
              {nextReviewHand ? (
                <ButtonControl
                  onClick={() => void reviewTrainingHand(nextReviewHand.job_id, true)}
                  disabled={trainingProgressLoading || trainingReviewJobId !== null || busy}
                >
                  <Eye size={14} aria-hidden="true" />
                  {trainingReviewOrder === "ev_loss" && typeof nextReviewHand.ev_loss_bb === "number"
                    ? "Review highest loss"
                    : "Review next"}
                </ButtonControl>
              ) : null}
              <ButtonControl
                variant="secondary"
                onClick={() => setTrainingDialogOpen(false)}
                disabled={trainingReviewJobId !== null}
              >
                Done
              </ButtonControl>
            </DialogFooter>
        </DialogFrame>
      ) : null}

      {benchmarkDialogOpen ? (
        <DialogFrame
          className="benchmark-dialog"
          titleId="benchmark-dialog-title"
        >
            <DialogHeader
              titleId="benchmark-dialog-title"
              title="Parser benchmark"
              subtitle={benchmarkReport
                ? `${benchmarkReportParserLabel} · ${benchmarkReport.layout_profile}`
                : "Ground-truth recognition checks"}
              closeLabel="Close parser benchmark"
              closeDisabled={benchmarkRunning || benchmarkUpdating || benchmarkImporting || benchmarkReportLoading || benchmarkReviewJobId !== null}
              onClose={closeBenchmarkDialog}
            />

            <div className="benchmark-dialog-body">
              <ToggleControl
                className="benchmark-ground-truth"
                checked={job?.benchmark_included ?? false}
                title="Use current hand as ground truth"
                description={job?.approved_state
                  ? job.original_filename
                  : job?.benchmark_included
                    ? "Previous approved state remains included"
                    : "Approve the current hand first"}
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
              />

              {!benchmarkLoading && benchmarkParserPipelines.length > 1 ? (
                <section
                  className="benchmark-pipeline-comparison"
                  aria-labelledby="benchmark-pipeline-comparison-title"
                >
                  <div className="benchmark-pipeline-comparison-heading">
                    <h3 id="benchmark-pipeline-comparison-title">Parser comparison</h3>
                    <div>
                      <span>Latest saved run</span>
                      {benchmarkRunnablePipelines.length > 1 ? (
                        <ButtonControl
                          variant="secondary"
                          className="benchmark-comparison-run"
                          onClick={onRunBenchmarkComparison}
                          disabled={
                            benchmarkOperationsLocked
                            || benchmarkIncludedCases === 0
                          }
                        >
                          <Play size={12} aria-hidden="true" />
                          {benchmarkComparisonProgress
                            ? `${benchmarkComparisonProgress.completed + 1}/${benchmarkComparisonProgress.total}`
                            : "Run comparison"}
                        </ButtonControl>
                      ) : null}
                    </div>
                  </div>
                  <div className="benchmark-pipeline-list">
                    {benchmarkParserPipelines.map((pipeline) => {
                      const selected = pipeline.parser.id
                        === (
                          pipelineSelection?.parser_provider
                          ?? benchmarkReport?.parser_provider
                          ?? benchmarkParserPipelines[0]?.parser.id
                        );
                      const report = pipeline.latest_report;
                      const running = benchmarkComparisonProgress?.parserId
                        === pipeline.parser.id;
                      const stale = Boolean(
                        report
                        && benchmarkCorpusIsUnverified(
                          report.corpus_fingerprint,
                          benchmarkOverview?.corpus_fingerprint,
                        ),
                      );
                      const accuracyDelta = benchmarkPipelinePointChange(
                        pipeline,
                        benchmarkOverview?.corpus_fingerprint,
                      );
                      const trendLabel = accuracyDelta === null
                        ? null
                        : `${accuracyDelta > 0 ? "+" : ""}${accuracyDelta} pts`;
                      let status = "No benchmark run";
                      if (running) {
                        status = "Running benchmark...";
                      } else if (!pipeline.parser.available) {
                        status = pipeline.parser.unavailable_reason
                          ?? "Parser is unavailable";
                      } else if (stale) {
                        status = "Current corpus not verified · rerun";
                      } else if (report) {
                        status = `${report.total_cases} ${report.total_cases === 1 ? "case" : "cases"}${report.failed_cases > 0 ? ` · ${report.failed_cases} failed` : ""}`;
                      }
                      return (
                        <ButtonControl
                          key={pipeline.parser.id}
                          variant="ghost"
                          className={[
                            selected ? "active" : "",
                            running ? "running" : "",
                            stale ? "stale" : "",
                          ].filter(Boolean).join(" ") || undefined}
                          onClick={() => selectBenchmarkParserPipeline(
                            pipeline.parser.id,
                          )}
                          disabled={
                            selected
                            || pipelineLoading
                            || !pipeline.parser.available
                            || benchmarkOperationsLocked
                          }
                          aria-current={selected ? "true" : undefined}
                          aria-label={`Use ${pipeline.parser.label} benchmark pipeline`}
                          title={pipeline.parser.unavailable_reason
                            ?? (stale
                              ? "This benchmark is not verified against the current ground truth"
                              : undefined)}
                        >
                          <span>
                            <strong>{pipeline.parser.label}</strong>
                            <small>
                              {status}
                              {trendLabel ? (
                                <span
                                  className={`benchmark-pipeline-trend${accuracyDelta !== null && accuracyDelta > 0 ? " positive" : accuracyDelta !== null && accuracyDelta < 0 ? " negative" : ""}`}
                                >
                                  {` · ${trendLabel}`}
                                </span>
                              ) : null}
                            </small>
                          </span>
                          <strong className={report?.failed_cases || stale ? "needs-review" : undefined}>
                            {report ? benchmarkPercent(report.accuracy) : "--"}
                          </strong>
                        </ButtonControl>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {benchmarkLoading ? (
                <StateMessage centered className="benchmark-empty">Reading benchmark results...</StateMessage>
              ) : benchmarkReport ? (
                <>
                  <div className="benchmark-report-toolbar">
                    <FormField label="Report" labelClassName="benchmark-report-label">
                      <SelectControl
                        aria-label="Benchmark report"
                        value={benchmarkReport.id}
                        onChange={(event) => void selectBenchmarkReport(event.target.value)}
                        disabled={benchmarkReportLoading || benchmarkRunning || benchmarkUpdating || benchmarkImporting || benchmarkReviewJobId !== null || busy}
                      >
                        {recentBenchmarkReports.map((summary) => (
                          <option key={summary.id} value={summary.id}>
                            {benchmarkReportOption(
                              summary,
                              benchmarkOverview?.latest_report?.id,
                              pipelineCapabilities,
                              benchmarkOverview?.parser_pipelines,
                              benchmarkOverview?.corpus_fingerprint,
                            )}
                          </option>
                        ))}
                      </SelectControl>
                    </FormField>
                    {benchmarkAccuracyDelta !== null ? (
                      <strong className={benchmarkAccuracyDelta < 0 ? "negative" : ""}>
                        {benchmarkAccuracyDelta > 0 ? "+" : ""}{benchmarkAccuracyDelta} pts vs previous
                      </strong>
                    ) : (
                      <span>No comparable earlier run</span>
                    )}
                  </div>
                  {benchmarkReportStale ? (
                    <div className="benchmark-corpus-warning" role="status">
                      <AlertTriangle size={14} aria-hidden="true" />
                      <span>
                        <strong>This run is not verified against the current ground truth.</strong>
                        Run the benchmark again before comparing its accuracy.
                      </span>
                    </div>
                  ) : null}
                  <div className="benchmark-summary" aria-label="Benchmark summary">
                    <SummaryMetric label="cases" value={benchmarkReport.total_cases} />
                    <SummaryMetric label="fields correct" value={`${benchmarkReport.correct_fields}/${benchmarkReport.evaluated_fields}`} />
                    <SummaryMetric label="accuracy" value={benchmarkPercent(benchmarkReport.accuracy)} />
                    <SummaryMetric attention={benchmarkReport.failed_cases > 0} label="failed" value={benchmarkReport.failed_cases} />
                  </div>

                  <div className="benchmark-results-scroll">
                    {benchmarkReport.parser_provider === "auto" ? (
                      <section className="benchmark-result-section" aria-labelledby="benchmark-routes-title">
                        <h3 id="benchmark-routes-title">Parser routes</h3>
                        {benchmarkParserRoutes.routes.length > 0 ? (
                          <div className="benchmark-route-list">
                            {benchmarkParserRoutes.routes.map((route) => (
                              <div
                                key={route.provider}
                                aria-label={`${providerLabel(route.provider)} parser route`}
                              >
                                <span>
                                  <strong>{providerLabel(route.provider)}</strong>
                                  <small>
                                    {route.cases} {route.cases === 1 ? "case" : "cases"}
                                    {` · ${route.correctFields}/${route.evaluatedFields} fields`}
                                    {route.fallbackCases > 0
                                      ? ` · ${route.fallbackCases} ${route.fallbackCases === 1 ? "fallback" : "fallbacks"}`
                                      : ""}
                                    {route.failedCases > 0
                                      ? ` · ${route.failedCases} failed`
                                      : ""}
                                  </small>
                                </span>
                                <strong className={route.failedCases > 0 ? "needs-review" : ""}>
                                  {benchmarkPercent(route.accuracy)}
                                </strong>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <StateMessage as="p" className="benchmark-route-empty" size="compact">No parser routes were recorded for this report.</StateMessage>
                        )}
                        <p className="benchmark-route-coverage">
                          {benchmarkParserRoutes.attributedCases} of {benchmarkReport.total_cases} cases attributed
                        </p>
                      </section>
                    ) : null}
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
                      <div className="benchmark-case-heading">
                        <h3 id="benchmark-cases-title">Cases</h3>
                        {benchmarkComparisonReportLoading ? (
                          <span role="status">Comparing cases...</span>
                        ) : benchmarkCaseTrends.size > 0 ? (
                          <SegmentedControl
                            ariaLabel="Benchmark case filter"
                            className="benchmark-case-filter"
                            options={[
                              { value: "all", label: `All ${benchmarkReport.cases.length}` },
                              { value: "regressed", label: `Regressed ${benchmarkCaseTrendCounts.regressed}` },
                              { value: "recovered", label: `Recovered ${benchmarkCaseTrendCounts.recovered}` },
                              { value: "mixed", label: `Mixed ${benchmarkCaseTrendCounts.mixed}` },
                            ]}
                            value={benchmarkCaseFilter}
                            onChange={(filter) => {
                              setBenchmarkCaseFilter(filter);
                              setExpandedBenchmarkCaseId(null);
                            }}
                          />
                        ) : null}
                      </div>
                      <div className="benchmark-case-list">
                        {visibleBenchmarkCases.map((benchmarkCase) => {
                          const expanded = expandedBenchmarkCaseId === benchmarkCase.job_id;
                          const mismatches = benchmarkCase.comparisons.filter((comparison) => !comparison.matched);
                          const parserRoute = parserRoutingEvidence(benchmarkCase.parser_routing);
                          const caseTrend = benchmarkCaseTrends.get(benchmarkCase.job_id);
                          const previousCase = benchmarkComparisonCases.get(benchmarkCase.job_id);
                          const caseChanges = expanded && previousCase
                            ? benchmarkCaseChanges(benchmarkCase, previousCase)
                            : [];
                          const detailId = `benchmark-case-${benchmarkCase.job_id}`;
                          return (
                            <div
                              key={benchmarkCase.job_id}
                              className={`benchmark-case-row${caseTrend && caseTrend !== "unchanged" ? ` ${caseTrend}` : ""}`}
                            >
                              <ButtonControl
                                variant="ghost"
                                className="benchmark-case-summary"
                                onClick={() => setExpandedBenchmarkCaseId((current) => (current === benchmarkCase.job_id ? null : benchmarkCase.job_id))}
                                aria-expanded={expanded}
                                aria-controls={detailId}
                                aria-label={`Toggle ${benchmarkCase.original_filename} benchmark details${caseTrend && caseTrend !== "unchanged" ? `, ${caseTrend}` : ""}`}
                              >
                                <span>
                                  <strong>
                                    {benchmarkCase.original_filename}
                                    {caseTrend && caseTrend !== "unchanged" ? (
                                      <em className={`benchmark-case-trend ${caseTrend}`}>
                                        {caseTrend}
                                      </em>
                                    ) : null}
                                  </strong>
                                  <small>
                                    {parserRoute ? `${providerLabel(parserRoute.selectedProvider)} · ` : ""}
                                    {benchmarkCase.error
                                      ? humanReadableMessage(benchmarkCase.error, "Benchmark failed")
                                      : benchmarkMismatchLabel(benchmarkCase.comparisons)}
                                  </small>
                                </span>
                                <strong className={benchmarkCase.status === "error" || mismatches.length > 0 ? "needs-review" : ""}>
                                  {benchmarkCase.status === "error" ? "Error" : benchmarkPercent(benchmarkCase.accuracy)}
                                </strong>
                                <ChevronDown size={15} aria-hidden="true" />
                              </ButtonControl>
                              {expanded ? (
                                <div id={detailId} className="benchmark-case-details">
                                  {parserRoute ? (
                                    <div className="benchmark-case-routing" aria-label="Parser routing">
                                      <strong>{providerLabel(parserRoute.selectedProvider)}</strong>
                                      <span>
                                        via {providerLabel(parserRoute.provider)}
                                        {parserRoute.fallbackFrom
                                          ? ` · fallback from ${providerLabel(parserRoute.fallbackFrom)}`
                                          : ""}
                                      </span>
                                      {parserRoute.fallbackReason ? <small>{parserRoute.fallbackReason}</small> : null}
                                    </div>
                                  ) : null}
                                  {benchmarkCase.error ? (
                                    <p className="benchmark-case-error">
                                      {humanReadableMessage(benchmarkCase.error, "Benchmark failed")}
                                    </p>
                                  ) : null}
                                  {caseChanges.length > 0 ? (
                                    <div
                                      className="benchmark-case-changes"
                                      aria-label={`${benchmarkCase.original_filename} changes since previous run`}
                                    >
                                      <strong className="benchmark-case-changes-title">
                                        Changes since previous run
                                      </strong>
                                      {caseChanges.map((change) => (
                                        <div
                                          key={change.key}
                                          className={`benchmark-case-change ${change.trend}`}
                                          aria-label={`${change.label} ${change.trend}`}
                                        >
                                          <span className="benchmark-case-change-field">
                                            <strong>{change.label}</strong>
                                            <em>{change.trend}</em>
                                          </span>
                                          <span>
                                            <small>Previous</small>
                                            <code>{benchmarkComparisonValue(change.previousValue)}</code>
                                          </span>
                                          <span>
                                            <small>Current</small>
                                            <code>{benchmarkComparisonValue(change.currentValue)}</code>
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : null}
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
                                    <ButtonControl
                                      variant="secondary"
                                      onClick={() => void reviewBenchmarkCase(benchmarkCase.job_id)}
                                      disabled={benchmarkRunning || benchmarkUpdating || benchmarkImporting || benchmarkReportLoading || benchmarkReviewJobId !== null || busy}
                                    >
                                      <Eye size={14} aria-hidden="true" />
                                      {benchmarkReviewJobId === benchmarkCase.job_id ? "Opening..." : "Review hand"}
                                    </ButtonControl>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                        {visibleBenchmarkCases.length === 0 ? (
                          <StateMessage as="p" centered className="benchmark-case-empty" size="compact">
                            {benchmarkCaseFilter === "all"
                              ? "No benchmark cases in this report."
                              : `No ${benchmarkCaseFilter} cases in this comparison.`}
                          </StateMessage>
                        ) : null}
                      </div>
                    </section>
                  </div>
                </>
              ) : (
                <StateMessage centered className="benchmark-empty">No benchmark has been run yet.</StateMessage>
              )}
            </div>

            <DialogFooter className="benchmark-dialog-footer">
              <span>
                <strong>{benchmarkIncludedCases}</strong> ground-truth {benchmarkIncludedCases === 1 ? "hand" : "hands"}
                {benchmarkTargetLayoutLabel ? ` · ${benchmarkTargetLayoutLabel}` : ""}
              </span>
              <ButtonControl
                variant="secondary"
                className="benchmark-dataset-action"
                onClick={() => benchmarkDatasetInputRef.current?.click()}
                disabled={benchmarkOperationsLocked}
                aria-label="Import dataset"
                title="Import dataset"
              >
                <Upload size={14} aria-hidden="true" />
                <span>{benchmarkImporting ? "Importing..." : "Import dataset"}</span>
              </ButtonControl>
              <FileInputControl
                ref={benchmarkDatasetInputRef}
                accept=".zip,application/zip"
                aria-label="Parser dataset ZIP"
                disabled={benchmarkOperationsLocked}
                onChange={(event) => void onBenchmarkDatasetImport(event)}
              />
              <DownloadLinkControl
                className="secondary-button benchmark-dataset-action benchmark-export-button"
                href={benchmarkDatasetUrl(pipelineSelection ?? undefined)}
                download
                aria-label="Export dataset"
                title="Export dataset"
                disabled={benchmarkDatasetExportDisabled}
              >
                <Download size={14} aria-hidden="true" />
                <span>Export dataset</span>
              </DownloadLinkControl>
              <ButtonControl
                onClick={onRunBenchmark}
                disabled={
                  benchmarkOperationsLocked ||
                  benchmarkIncludedCases === 0
                }
              >
                <Play size={14} aria-hidden="true" />
                {benchmarkRunning ? "Running..." : "Run benchmark"}
              </ButtonControl>
              <ButtonControl
                variant="secondary"
                onClick={closeBenchmarkDialog}
                disabled={benchmarkRunning || benchmarkUpdating || benchmarkImporting || benchmarkReportLoading || benchmarkReviewJobId !== null}
              >
                Done
              </ButtonControl>
            </DialogFooter>
        </DialogFrame>
      ) : null}
    </main>
  );
}
