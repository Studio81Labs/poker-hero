import { type HistoryItem } from "../historyPresentation";
import { screenshotTags } from "../screenshotMetadata";
import { getHistory, getProcessingJobs } from "../api";
import {
  type CanonicalState,
  type Card,
  type CompletedPostflopAction,
  type CompletedPostflopActionType,
  type CompletedPostflopStreetHistory,
  type DetectedState,
  type JobHistory,
  type JobQueue,
  type JobRecord,
  type PreflopAction,
  type PostflopAction,
  type PostflopActor,
  type RecommendationAction,
  type RecommendationResult,
  type TrainingCertainty,
} from "../types";
import {
  FACING_ACTIONS,
  PREFLOP_POSITIONS,
  RANKS,
  STREETS,
  SUITS,
  approvalKey,
} from "./pokerState";
import {
  SIZING_MATCH_TOLERANCE,
  TRAINING_ACTIONS,
  TRAINING_CERTAINTIES,
} from "./trainingPresentation";

export const PERSISTED_JOB_ID_PATTERN = /^[0-9a-f]{32}$/;

export const LOCAL_UPLOAD_RECONCILIATION_WINDOW_MS = 2 * 60 * 1000;

export const HISTORY_SESSION_SYNC_KEY = "poker-training-history-synced";

export const PROCESSING_QUEUE_SESSION_SYNC_KEY =
  "poker-training-processing-synced";

export const HISTORY_MUTATION_LEASE_KEY = "poker-training-history-mutation-v1";

export const PROCESSING_MUTATION_LEASE_KEY =
  "poker-training-processing-mutation-v1";

export const PERSISTED_MUTATION_LEASE_MS = 30 * 1000;

export type PersistedJobMutationScope = "processing" | "history";

export type MutationLeaseBase = {
  ownerId: string;
  expiresAt: number;
};

export type JobMutationExpectation =
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

export type JobMutationLease = MutationLeaseBase & {
  kind: "job";
  jobId: string;
  baselineUpdatedAt: string;
  expectsRemoval: boolean;
  expectedRecommendationRequestId: string | null;
  expectedMutation: JobMutationExpectation | null;
};

export type ProjectionMutationTarget =
  | "failed"
  | "parsed"
  | "approved"
  | "recommended";

export type ProjectionMutationLease = MutationLeaseBase & {
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

export type ArchiveMutationLease = MutationLeaseBase & {
  kind: "archive";
  jobIds: string[];
  baselineUpdatedAt: Record<string, string>;
  confirmationJobIds: string[];
};

export type PersistedMutationLease =
  | JobMutationLease
  | ProjectionMutationLease
  | ArchiveMutationLease;

export type ProcessingQueueRestore = JobQueue & {
  revalidatedLeaseJob?: JobRecord;
  revalidatedArchiveJobs?: JobRecord[];
};

export const PROCESSING_QUEUE_STORAGE_KEY = "poker-training-processing-v1";

export const PROCESSING_QUEUE_TOTAL_STORAGE_KEY =
  "poker-training-processing-total-v1";

export const PROCESSING_QUEUE_CACHE_LIMIT = 100;

export const PROCESSING_QUEUE_SNAPSHOT_RETRY_LIMIT = 3;

export const PROCESSING_QUEUE_REVALIDATION_INTERVAL_MS = 250;

export const PROCESSING_CACHE_FUTURE_SKEW_MS = 5 * 60 * 1000;

export const HISTORY_STORAGE_KEY = "poker-training-history-v1";

export const HISTORY_TOTAL_STORAGE_KEY = "poker-training-history-total-v1";

export const HISTORY_CACHE_LIMIT = 24;

export const HISTORY_SEARCH_PAGE_LIMIT = 100;

export const HISTORY_SNAPSHOT_RETRY_LIMIT = 3;

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

export function readProcessingQueue(): JobRecord[] | null {
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

export function processingJobsForCache(jobs: JobRecord[]): JobRecord[] {
  return jobs.filter(
    (job) =>
      PERSISTED_JOB_ID_PATTERN.test(job.id) &&
      job.archived_at === null &&
      !isPristineBenchmarkImport(job),
  );
}

export function readStoredProcessingQueueTotal(): number | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(PROCESSING_QUEUE_TOTAL_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function writeProcessingQueue(
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
  const total =
    storedTotal === null
      ? processingJobs.length
      : Math.max(storedTotal, processingJobs.length);
  try {
    const serializedJobs = JSON.stringify(
      processingJobs.slice(0, PROCESSING_QUEUE_CACHE_LIMIT),
    );
    if (
      window.localStorage.getItem(PROCESSING_QUEUE_STORAGE_KEY) !==
      serializedJobs
    ) {
      window.localStorage.setItem(PROCESSING_QUEUE_STORAGE_KEY, serializedJobs);
    }
    const serializedTotal = String(total);
    if (
      window.localStorage.getItem(PROCESSING_QUEUE_TOTAL_STORAGE_KEY) !==
      serializedTotal
    ) {
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

export function readCachedProcessingQueueTotal(
  cachedJobs: JobRecord[] | null,
): number | null {
  if (cachedJobs === null || typeof window === "undefined") {
    return null;
  }
  const storedTotal = readStoredProcessingQueueTotal();
  if (
    storedTotal === null ||
    cachedJobs.length !== storedTotal ||
    cachedJobs.length > PROCESSING_QUEUE_CACHE_LIMIT
  ) {
    return null;
  }
  return storedTotal;
}

export function mutationLeaseStorageKey(
  scope: PersistedJobMutationScope,
): string {
  return scope === "processing"
    ? PROCESSING_MUTATION_LEASE_KEY
    : HISTORY_MUTATION_LEASE_KEY;
}

export function mutationLeaseOwnerId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function projectionMutationTargetReached(
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
    return (
      job.recommendation !== null ||
      (recommendationRequestId !== null &&
        job.recommendation_request_id === recommendationRequestId &&
        !job.recommendation_pending)
    );
  }
  if (target === "approved") {
    return job.approved_state !== null;
  }
  return (
    job.parser_result !== null ||
    job.approved_state !== null ||
    job.recommendation !== null
  );
}

export function projectionMutationLeaseTargetReached(
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

export function jobMutationExpectationReached(
  job: JobRecord,
  expectation: JobMutationExpectation,
): boolean {
  if (expectation.kind === "approval") {
    return (
      job.approved_state !== null &&
      job.approved_state.user_approved &&
      approvalKey(job.approved_state) === expectation.approvedStateKey &&
      job.training_decision === null &&
      job.recommendation === null &&
      job.training_reviewed_at === null &&
      job.training_review_note === null &&
      job.status === "approved" &&
      job.error === null
    );
  }
  if (expectation.kind === "training-decision") {
    return (
      job.training_decision !== null &&
      job.training_decision.action === expectation.action &&
      job.training_decision.sizing === expectation.sizing &&
      (job.training_decision.certainty ?? null) === expectation.certainty &&
      job.recommendation === null &&
      job.training_reviewed_at === null &&
      job.training_review_note === null &&
      job.status === "approved" &&
      job.error === null
    );
  }
  if (expectation.kind === "training-review") {
    return expectation.reviewed
      ? job.training_reviewed_at !== null &&
          job.training_review_note === expectation.note
      : job.training_reviewed_at === null;
  }
  if (expectation.kind === "metadata") {
    return (
      (job.title ?? null) === expectation.title &&
      (job.notes ?? null) === expectation.notes &&
      screenshotTags(job).length === expectation.tags.length &&
      screenshotTags(job).every((tag, index) => tag === expectation.tags[index])
    );
  }
  return job.benchmark_included === expectation.included;
}

export function projectionMutationTarget(
  runAutomation: boolean,
  autoApprove: boolean,
  autoRecommend: boolean,
): ProjectionMutationTarget {
  if (!runAutomation || !autoApprove) {
    return "parsed";
  }
  return autoRecommend ? "recommended" : "approved";
}

export function createMutationRequestId(): string {
  return globalThis.crypto.randomUUID();
}

export function mutationLeaseJobIds(
  lease: PersistedMutationLease | null,
): string[] {
  if (lease === null || lease.kind === "projection") {
    return [];
  }
  return lease.kind === "job" ? [lease.jobId] : lease.jobIds;
}

export function mutationLeaseTargetsJob(
  lease: PersistedMutationLease | null,
  jobId: string,
): boolean {
  return mutationLeaseJobIds(lease).includes(jobId);
}

export function matchingArchiveLeaseTargets(
  first: PersistedMutationLease | null,
  second: PersistedMutationLease | null,
): boolean {
  if (first?.kind !== "archive" || second?.kind !== "archive") {
    return false;
  }
  const secondIds = new Set(second.jobIds);
  return (
    first.jobIds.length === secondIds.size &&
    first.jobIds.every((jobId) => secondIds.has(jobId))
  );
}

export function benchmarkImportLeaseRequestId(
  first: PersistedMutationLease | null,
  second: PersistedMutationLease | null,
): string | null {
  const requestIds = [first, second].flatMap((lease) =>
    lease?.kind === "projection" && lease.benchmarkImportRequestId !== null
      ? [lease.benchmarkImportRequestId]
      : [],
  );
  return requestIds.length > 0 &&
    requestIds.every((requestId) => requestId === requestIds[0])
    ? requestIds[0]
    : null;
}

export function isBenchmarkImportLease(
  lease: PersistedMutationLease | null,
  requestId: string,
): lease is ProjectionMutationLease {
  return (
    lease?.kind === "projection" && lease.benchmarkImportRequestId === requestId
  );
}

export function isJobMutationExpectation(
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
    return (
      typeof expectation.action === "string" &&
      TRAINING_ACTIONS.some((action) => action === expectation.action) &&
      isCachedActionSizing(expectation.action, expectation.sizing) &&
      (expectation.certainty === null ||
        (typeof expectation.certainty === "string" &&
          TRAINING_CERTAINTIES.some(
            (certainty) => certainty === expectation.certainty,
          )))
    );
  }
  if (expectation.kind === "training-review") {
    return (
      typeof expectation.reviewed === "boolean" &&
      (expectation.note === null || typeof expectation.note === "string")
    );
  }
  if (expectation.kind === "metadata") {
    return (
      (expectation.title === null || typeof expectation.title === "string") &&
      (expectation.notes === null || typeof expectation.notes === "string") &&
      Array.isArray(expectation.tags) &&
      expectation.tags.every((tag) => typeof tag === "string")
    );
  }
  return (
    expectation.kind === "benchmark-inclusion" &&
    typeof expectation.included === "boolean"
  );
}

export function readPersistedMutationLease(
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
      parsed.kind === undefined &&
      typeof parsed.jobId === "string" &&
      typeof parsed.baselineUpdatedAt === "string"
    ) {
      parsed.kind = "job";
    }
    if (parsed.kind === "job" && parsed.expectsRemoval === undefined) {
      parsed.expectsRemoval = false;
    }
    if (
      parsed.kind === "job" &&
      parsed.expectedRecommendationRequestId === undefined
    ) {
      parsed.expectedRecommendationRequestId = null;
    }
    if (parsed.kind === "job" && parsed.expectedMutation === undefined) {
      parsed.expectedMutation = null;
    }
    if (parsed.kind === "archive" && parsed.confirmationJobIds === undefined) {
      parsed.confirmationJobIds = scope === "processing" ? parsed.jobIds : [];
    }
    if (parsed.kind === "projection" && Array.isArray(parsed.expectedUploads)) {
      for (const expectedUpload of parsed.expectedUploads) {
        if (
          typeof expectedUpload === "object" &&
          expectedUpload !== null &&
          (expectedUpload as Record<string, unknown>)
            .recommendationRequestId === undefined
        ) {
          (expectedUpload as Record<string, unknown>).recommendationRequestId =
            null;
        }
      }
    }
    if (
      parsed.kind === "projection" &&
      parsed.benchmarkImportRequestId === undefined
    ) {
      parsed.benchmarkImportRequestId = null;
    }
    if (
      parsed.kind === "projection" &&
      parsed.benchmarkImportReceiptObserved === undefined
    ) {
      parsed.benchmarkImportReceiptObserved = false;
    }
    if (
      typeof parsed.ownerId !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt) ||
      !["job", "projection", "archive"].includes(String(parsed.kind))
    ) {
      window.sessionStorage.removeItem(mutationLeaseStorageKey(scope));
      return null;
    }
    if (
      parsed.kind === "job" &&
      (typeof parsed.jobId !== "string" ||
        typeof parsed.baselineUpdatedAt !== "string" ||
        typeof parsed.expectsRemoval !== "boolean" ||
        (parsed.expectedRecommendationRequestId !== null &&
          typeof parsed.expectedRecommendationRequestId !== "string") ||
        (parsed.expectedMutation !== null &&
          !isJobMutationExpectation(parsed.expectedMutation)))
    ) {
      window.sessionStorage.removeItem(mutationLeaseStorageKey(scope));
      return null;
    }
    if (
      parsed.kind === "projection" &&
      (!Array.isArray(parsed.baselineJobIds) ||
        !parsed.baselineJobIds.every((value) => typeof value === "string") ||
        !Array.isArray(parsed.expectedRemovalJobIds) ||
        !parsed.expectedRemovalJobIds.every(
          (value) =>
            typeof value === "string" &&
            (parsed.baselineJobIds as unknown[]).includes(value),
        ) ||
        !Array.isArray(parsed.expectedUploads) ||
        (parsed.benchmarkImportRequestId !== null &&
          typeof parsed.benchmarkImportRequestId !== "string") ||
        typeof parsed.benchmarkImportReceiptObserved !== "boolean" ||
        !parsed.expectedUploads.every(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            typeof (value as Record<string, unknown>).requestId === "string" &&
            ((value as Record<string, unknown>).recommendationRequestId ===
              null ||
              typeof (value as Record<string, unknown>)
                .recommendationRequestId === "string") &&
            ["failed", "parsed", "approved", "recommended"].includes(
              String((value as Record<string, unknown>).target),
            ),
        ))
    ) {
      window.sessionStorage.removeItem(mutationLeaseStorageKey(scope));
      return null;
    }
    if (
      parsed.kind === "archive" &&
      (!Array.isArray(parsed.jobIds) ||
        !parsed.jobIds.every((value) => typeof value === "string") ||
        typeof parsed.baselineUpdatedAt !== "object" ||
        parsed.baselineUpdatedAt === null ||
        Array.isArray(parsed.baselineUpdatedAt) ||
        !Object.values(parsed.baselineUpdatedAt).every(
          (value) => typeof value === "string",
        ) ||
        !parsed.jobIds.every(
          (jobId) =>
            typeof (parsed.baselineUpdatedAt as Record<string, unknown>)[
              jobId
            ] === "string",
        ) ||
        !Array.isArray(parsed.confirmationJobIds) ||
        !parsed.confirmationJobIds.every(
          (jobId) =>
            typeof jobId === "string" &&
            (parsed.jobIds as unknown[]).includes(jobId),
        ))
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

export function writePersistedMutationLease(
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

export function replacePersistedMutationLease(
  scope: PersistedJobMutationScope,
  expectedLease: PersistedMutationLease,
  nextLease: PersistedMutationLease,
): boolean {
  const storedLease = readPersistedMutationLease(scope);
  if (
    storedLease === null ||
    storedLease.ownerId !== expectedLease.ownerId ||
    storedLease.kind !== expectedLease.kind ||
    storedLease.expiresAt !== expectedLease.expiresAt
  ) {
    return false;
  }
  return writePersistedMutationLease(scope, nextLease);
}

export function claimPersistedMutationLease(
  scope: PersistedJobMutationScope,
  ownerId: string,
): PersistedMutationLease | null {
  const lease = readPersistedMutationLease(scope);
  if (lease === null) {
    return null;
  }
  const claimedLease = { ...lease, ownerId };
  return writePersistedMutationLease(scope, claimedLease) ? claimedLease : null;
}

export function startPersistedMutationLease(
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

export function startProjectionMutationLease(
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

export function startArchiveMutationLease(
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
    confirmationJobIds:
      scope === "processing"
        ? jobs
            .filter((job) => !processingJobIds.has(job.id))
            .map((job) => job.id)
        : [],
    expiresAt: Date.now() + PERSISTED_MUTATION_LEASE_MS,
  };
  return writePersistedMutationLease(scope, lease) ? lease : null;
}

export function clearPersistedMutationLease(
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

export function markProcessingQueueSessionSynced(): void {
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

export function markProcessingQueueSessionUnsynced(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.removeItem(PROCESSING_QUEUE_SESSION_SYNC_KEY);
  } catch {
    // Blocked session storage already forces the app to reconcile on reload.
  }
}

export function processingQueueSessionSynced(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return (
      window.sessionStorage.getItem(PROCESSING_QUEUE_SESSION_SYNC_KEY) ===
      "true"
    );
  } catch {
    return false;
  }
}

export async function getProcessingQueueExtent(): Promise<JobQueue> {
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
        snapshotVersion !== null &&
        page.snapshot_version !== undefined &&
        page.snapshot_version !== snapshotVersion
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

export function readHistory(): HistoryItem[] | null {
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

export function writeHistory(items: HistoryItem[]): boolean {
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

export function readCachedHistoryTotal(
  cachedHistory: HistoryItem[] | null,
): number | null {
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
      !Number.isSafeInteger(parsed) ||
      parsed < 0 ||
      cachedHistory.length !== Math.min(parsed, HISTORY_CACHE_LIMIT)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function readHistoryTotal(): number {
  const cachedHistory = readHistory();
  return readCachedHistoryTotal(cachedHistory) ?? cachedHistory?.length ?? 0;
}

export function writeHistoryTotal(total: number): boolean {
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

export function markHistorySessionSynced(): void {
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

export function markHistorySessionUnsynced(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.removeItem(HISTORY_SESSION_SYNC_KEY);
  } catch {
    // A blocked session store already forces the app to fetch history on reload.
  }
}

export function historySessionSynced(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.sessionStorage.getItem(HISTORY_SESSION_SYNC_KEY) === "true";
  } catch {
    return false;
  }
}

export function historyItemsFromPage(page: JobHistory): HistoryItem[] {
  return page.jobs.map((job) => ({
    id: job.id,
    job,
    savedAt: job.archived_at ?? job.updated_at,
  }));
}

export async function getHistorySearchExtent(
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
        snapshotVersion !== null &&
        page.snapshot_version !== undefined &&
        page.snapshot_version !== snapshotVersion
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

export function mergeHistoryItems(
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

export function newerHistoryItem(
  current: HistoryItem,
  incoming: HistoryItem,
): HistoryItem {
  return newerHistoryJob(current.job, incoming.job) === current.job
    ? current
    : incoming;
}

export function newerJob(current: JobRecord, incoming: JobRecord): JobRecord {
  const currentUpdatedAt = Date.parse(current.updated_at);
  const incomingUpdatedAt = Date.parse(incoming.updated_at);
  return Number.isFinite(currentUpdatedAt) &&
    (!Number.isFinite(incomingUpdatedAt) ||
      currentUpdatedAt >= incomingUpdatedAt)
    ? current
    : incoming;
}

export function preserveUploadRequestId(
  incoming: JobRecord,
  current: JobRecord | undefined,
): JobRecord {
  return incoming.upload_request_id || !current?.upload_request_id
    ? incoming
    : { ...incoming, upload_request_id: current.upload_request_id };
}

export function newerHistoryJob(
  current: JobRecord,
  incoming: JobRecord,
): JobRecord {
  if (current.recommendation_pending && !incoming.recommendation_pending) {
    return incoming;
  }
  return newerJob(current, incoming);
}

export function localUploadMatchDistance(
  localJob: JobRecord,
  incomingJob: JobRecord,
): number | null {
  const matchingPersistedFailure =
    incomingJob.status === "error" &&
    localJob.error !== null &&
    incomingJob.error !== null &&
    (localJob.error === incomingJob.error ||
      localJob.error.endsWith(`: ${incomingJob.error}`));
  const matchingPersistedSuccess =
    incomingJob.status === "parsed" || incomingJob.status === "approved";
  if (
    !localJob.id.startsWith("local-error-") ||
    localJob.parser_provider !== "client" ||
    localJob.status !== "error" ||
    !PERSISTED_JOB_ID_PATTERN.test(incomingJob.id) ||
    (!matchingPersistedFailure && !matchingPersistedSuccess)
  ) {
    return null;
  }
  if (localJob.upload_request_id) {
    return incomingJob.upload_request_id === localJob.upload_request_id
      ? 0
      : null;
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

export function isLocalUploadError(job: JobRecord): boolean {
  return (
    job.id.startsWith("local-error-") &&
    job.parser_provider === "client" &&
    job.status === "error"
  );
}

export function restoredLocalUploadIds(
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

export function reconcileProcessingJobs(
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
      if (job.archived_at !== null || isPristineBenchmarkImport(job)) {
        return !incomingIds.has(job.id) && !removalCandidateIds.has(job.id);
      }
      return (
        isLocalUploadError(job) &&
        !cachedIds.has(job.id) &&
        !incomingIds.has(job.id) &&
        !removalCandidateIds.has(job.id) &&
        !restoredUploadIds.has(job.id)
      );
    }),
  ];
}

export function reconcileHistoryItems(
  current: HistoryItem[],
  incoming: HistoryItem[],
): HistoryItem[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  return incoming.map((item) => {
    const currentItem = currentById.get(item.id);
    return currentItem ? newerHistoryItem(currentItem, item) : item;
  });
}
