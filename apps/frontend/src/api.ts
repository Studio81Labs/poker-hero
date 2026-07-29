import type {
  BenchmarkDatasetImportResult,
  BenchmarkOverview,
  BenchmarkReport,
  CanonicalState,
  JobHistory,
  JobQueue,
  JobRecord,
  RecommendationAction,
  SystemInfo,
  TrainingCertainty,
  TrainingCertaintyFilter,
  TrainingProgress,
  TrainingPositionFilter,
  TrainingReviewCertaintyFilter,
  TrainingReviewDifference,
  TrainingReviewOrder,
  TrainingReviewStreet,
  TrainingSolverFilter,
  TrainingStreetFilter,
} from "./types";

const API_BASE_URL =
  typeof import.meta.env.VITE_API_BASE_URL === "string" && import.meta.env.VITE_API_BASE_URL.length > 0
    ? import.meta.env.VITE_API_BASE_URL
    : import.meta.env.DEV
      ? "http://localhost:8000"
      : "";

const HISTORY_ARCHIVE_BATCH_SIZE = 100;

export class ApiResponseError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiResponseError";
    this.status = status;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = await response.json();
      detail = typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail);
    } catch {
      detail = response.statusText;
    }
    throw new ApiResponseError(detail, response.status);
  }
  return response.json() as Promise<T>;
}

export function imageUrl(jobId: string): string {
  return `${API_BASE_URL}/api/jobs/${jobId}/image`;
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const response = await fetch(`${API_BASE_URL}/api/health`, {
    credentials: "include",
  });
  return readJson<SystemInfo>(response);
}

export async function getJob(jobId: string): Promise<JobRecord> {
  const response = await fetch(`${API_BASE_URL}/api/jobs/${jobId}`, {
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function getProcessingJobs(offset = 0): Promise<JobQueue> {
  const query = offset > 0 ? `?offset=${offset}` : "";
  const response = await fetch(`${API_BASE_URL}/api/jobs${query}`, {
    credentials: "include",
  });
  return readJson<JobQueue>(response);
}

export async function getHistory(
  offset = 0,
  query = "",
  limit?: number,
): Promise<JobHistory> {
  const params = new URLSearchParams();
  if (offset > 0) {
    params.set("offset", String(offset));
  }
  if (query.trim()) {
    params.set("query", query.trim());
  }
  if (limit !== undefined) {
    params.set("limit", String(limit));
  }
  const queryString = params.size > 0 ? `?${params.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/api/history${queryString}`, {
    credentials: "include",
  });
  return readJson<JobHistory>(response);
}

export async function archiveJobs(jobIds: string[]): Promise<JobHistory> {
  if (jobIds.length === 0) {
    throw new Error("At least one job is required to archive history");
  }

  let history: JobHistory | null = null;
  for (let offset = 0; offset < jobIds.length; offset += HISTORY_ARCHIVE_BATCH_SIZE) {
    const response = await fetch(`${API_BASE_URL}/api/history`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_ids: jobIds.slice(offset, offset + HISTORY_ARCHIVE_BATCH_SIZE),
      }),
      credentials: "include",
    });
    history = await readJson<JobHistory>(response);
  }
  if (history === null) {
    throw new Error("History archive did not process any jobs");
  }
  return history;
}

export async function uploadScreenshot(file: File, signal?: AbortSignal): Promise<JobRecord> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE_URL}/api/jobs`, {
    method: "POST",
    body: form,
    signal,
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function approveState(jobId: string, state: CanonicalState, signal?: AbortSignal): Promise<JobRecord> {
  const response = await fetch(`${API_BASE_URL}/api/jobs/${jobId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...state, user_approved: true }),
    signal,
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function requestRecommendation(jobId: string, signal?: AbortSignal): Promise<JobRecord> {
  const response = await fetch(`${API_BASE_URL}/api/jobs/${jobId}/recommend`, {
    method: "POST",
    signal,
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function recordTrainingDecision(
  jobId: string,
  action: RecommendationAction,
  sizing: number | null,
  certainty: TrainingCertainty | null,
): Promise<JobRecord> {
  const response = await fetch(`${API_BASE_URL}/api/jobs/${jobId}/decision`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, sizing, certainty }),
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function completeTrainingReview(
  jobId: string,
  note: string | null,
): Promise<JobRecord> {
  const response = await fetch(`${API_BASE_URL}/api/jobs/${jobId}/training-review`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function reopenTrainingReview(jobId: string): Promise<JobRecord> {
  const response = await fetch(`${API_BASE_URL}/api/jobs/${jobId}/training-review`, {
    method: "DELETE",
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function getTrainingProgress(
  reviewOrder: TrainingReviewOrder = "recent",
  reviewStreet: TrainingReviewStreet = "all",
  reviewDifference: TrainingReviewDifference | null = null,
  reviewCertainty: TrainingReviewCertaintyFilter = "all",
  lessonStreet: TrainingReviewStreet = "all",
  lessonQuery = "",
  lessonOrder: TrainingReviewOrder = "recent",
  solverFilter: TrainingSolverFilter | null = null,
  positionFilter: TrainingPositionFilter | null = null,
  streetFilter: TrainingStreetFilter | null = null,
  certaintyFilter: TrainingCertaintyFilter | null = null,
  reviewPositionFilter: TrainingPositionFilter | null = null,
): Promise<TrainingProgress> {
  const search = new URLSearchParams();
  if (reviewOrder !== "recent") {
    search.set("review_order", reviewOrder);
  }
  if (reviewStreet !== "all") {
    search.set("review_street", reviewStreet);
  }
  if (reviewCertainty !== "all") {
    search.set("review_certainty", reviewCertainty);
  }
  if (reviewDifference) {
    search.set("review_decision_action", reviewDifference.decision_action);
    search.set("review_recommended_action", reviewDifference.recommended_action);
  }
  if (reviewPositionFilter?.kind === "position") {
    search.set("review_position", reviewPositionFilter.position);
  } else if (reviewPositionFilter?.kind === "unpositioned") {
    search.set("review_unpositioned", "true");
  }
  if (lessonOrder !== "recent") {
    search.set("lesson_order", lessonOrder);
  }
  if (lessonStreet !== "all") {
    search.set("lesson_street", lessonStreet);
  }
  if (lessonQuery.trim()) {
    search.set("lesson_query", lessonQuery.trim());
  }
  if (solverFilter?.kind === "fallback") {
    search.set("solver_fallback_key", solverFilter.key);
  } else if (solverFilter?.kind === "route") {
    search.set("solver_route_key", solverFilter.key);
  } else if (solverFilter?.kind === "unattributed") {
    search.set("solver_unattributed", "true");
  }
  if (positionFilter?.kind === "position") {
    search.set("recent_position", positionFilter.position);
  } else if (positionFilter?.kind === "unpositioned") {
    search.set("recent_unpositioned", "true");
  }
  if (streetFilter) {
    search.set("recent_street", streetFilter.street);
  }
  if (certaintyFilter) {
    search.set("recent_certainty", certaintyFilter.certainty);
  }
  const query = search.size > 0 ? `?${search.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/api/training/progress${query}`, {
    credentials: "include",
  });
  return readJson<TrainingProgress>(response);
}

export function trainingLessonsExportUrl(
  lessonStreet: TrainingReviewStreet = "all",
  lessonQuery = "",
  lessonOrder: TrainingReviewOrder = "recent",
): string {
  const search = new URLSearchParams();
  if (lessonOrder !== "recent") {
    search.set("lesson_order", lessonOrder);
  }
  if (lessonStreet !== "all") {
    search.set("lesson_street", lessonStreet);
  }
  if (lessonQuery.trim()) {
    search.set("lesson_query", lessonQuery.trim());
  }
  const query = search.size > 0 ? `?${search.toString()}` : "";
  return `${API_BASE_URL}/api/training/lessons/export${query}`;
}

export async function getBenchmarkOverview(): Promise<BenchmarkOverview> {
  const response = await fetch(`${API_BASE_URL}/api/benchmarks`, {
    credentials: "include",
  });
  return readJson<BenchmarkOverview>(response);
}

export function benchmarkDatasetUrl(): string {
  return `${API_BASE_URL}/api/benchmarks/export`;
}

export async function importBenchmarkDataset(file: File): Promise<BenchmarkDatasetImportResult> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE_URL}/api/benchmarks/import`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  return readJson<BenchmarkDatasetImportResult>(response);
}

export async function getBenchmarkReport(reportId: string): Promise<BenchmarkReport> {
  const response = await fetch(`${API_BASE_URL}/api/benchmarks/${reportId}`, {
    credentials: "include",
  });
  return readJson<BenchmarkReport>(response);
}

export async function setBenchmarkInclusion(jobId: string, included: boolean): Promise<JobRecord> {
  const response = await fetch(`${API_BASE_URL}/api/jobs/${jobId}/benchmark`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ included }),
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function runParserBenchmark(): Promise<BenchmarkReport> {
  const response = await fetch(`${API_BASE_URL}/api/benchmarks/run`, {
    method: "POST",
    credentials: "include",
  });
  return readJson<BenchmarkReport>(response);
}
