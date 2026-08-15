import { screenshotTags } from "../../screenshots/lib/screenshotMetadata";
import type { JobRecord } from "../../../shared/types/jobs";
import type { RecommendationAction } from "../../../shared/types/recommendations";
import type { TrainingCertainty } from "../../../shared/types/training";
import { approvalKey } from "../../hand-review/lib/pokerState";
import {
  TRAINING_ACTIONS,
  TRAINING_CERTAINTIES,
} from "../../training/lib/trainingPresentation";
import { isCachedActionSizing } from "./cacheValidation";

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
