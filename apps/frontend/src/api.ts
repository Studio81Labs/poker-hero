import type {
  ApplicationBackupRestoreResult,
  BenchmarkDatasetImportReceipt,
  BenchmarkDatasetImportResult,
  BenchmarkOverview,
  BenchmarkReport,
  CanonicalState,
  JobHistory,
  JobQueue,
  JobRecord,
  McpAccessConfig,
  McpIssuedPrincipal,
  McpPrincipal,
  McpScope,
  PipelineCapabilities,
  PipelineSelection,
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
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    status: number,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "ApiResponseError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const FIELD_LABELS: Record<string, string> = {
  action_context: "Action context",
  board_cards: "Board cards",
  current_bet: "Current bet",
  effective_stack: "Effective stack",
  facing_action: "Facing action",
  hero_cards: "Hero cards",
  hero_position: "Hero position",
  hero_stack: "Hero stack",
  opponent_commitment_total: "Total opponent commitments",
  opponent_position: "Opponent position",
  opponent_stack: "Opponent stack",
  opponent_wager: "Opponent wager total",
  opponents_at_current_bet: "Opponents at the current wager",
  players_in_hand: "Players in hand",
  postflop_action_history: "Current-street action history",
  pot_size: "Pot",
  preflop_action_history: "Preflop action history",
  preflop_open_size: "Opening size",
  preflop_opener_position: "Opening position",
  street: "Street",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldLabel(value: string): string {
  const normalized = value.trim();
  if (FIELD_LABELS[normalized]) {
    return FIELD_LABELS[normalized];
  }
  const words = normalized.replace(/[_-]/g, " ").trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Field";
}

function joinReadable(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function validationIssueMessage(value: Record<string, unknown>): string | null {
  if (typeof value.msg !== "string" || !value.msg.trim()) {
    return null;
  }
  const location = Array.isArray(value.loc)
    ? value.loc.filter((part): part is string => (
      typeof part === "string" && !["body", "path", "query"].includes(part)
    ))
    : [];
  const label = location.length > 0 ? fieldLabel(location[location.length - 1] ?? "") : "";
  const message = value.msg.trim();
  if (label && message.toLowerCase() === "field required") {
    return `${label} is required`;
  }
  return label ? `${label}: ${message}` : message;
}

function structuredMessage(value: unknown, depth = 0): string | null {
  if (depth > 5 || value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const message = value.trim();
    if (!message) return null;
    const structuredStart = [message.indexOf("{"), message.indexOf("[")]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    if (structuredStart !== undefined) {
      const structuredValue = message.slice(structuredStart);
      try {
        const decoded = structuredMessage(JSON.parse(structuredValue), depth + 1);
        if (decoded) {
          const prefix = message.slice(0, structuredStart).replace(/[:\s]+$/, "");
          return prefix ? `${prefix}: ${decoded}` : decoded;
        }
      } catch {
        return message;
      }
    }
    return message;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const validationMessages = value.flatMap((item) => {
      const message = isRecord(item) ? validationIssueMessage(item) : null;
      return message ? [message] : [];
    });
    if (validationMessages.length === value.length && validationMessages.length > 0) {
      return validationMessages.join(". ");
    }
    const messages = value.flatMap((item) => {
      const message = structuredMessage(item, depth + 1);
      return message ? [message] : [];
    });
    return messages.length > 0 ? joinReadable(messages) : null;
  }
  if (!isRecord(value)) {
    return null;
  }

  if (Array.isArray(value.missing_fields)) {
    const fields = [...new Set(value.missing_fields.flatMap((field) => (
      typeof field === "string" && field.trim() ? [fieldLabel(field)] : []
    )))];
    if (fields.length > 0) {
      const readableFields = fields.map((field, index) => (
        index === 0 ? field : `${field[0].toLowerCase()}${field.slice(1)}`
      ));
      return `Complete the required table details before requesting a recommendation: ${joinReadable(readableFields)}. Edit the listed fields, then approve the state again.`;
    }
  }
  for (const key of ["detail", "message", "error", "title"]) {
    if (key in value) {
      const message = structuredMessage(value[key], depth + 1);
      if (message) return message;
    }
  }
  const validationMessage = validationIssueMessage(value);
  if (validationMessage) return validationMessage;

  const entries = Object.entries(value).flatMap(([key, item]) => {
    const message = structuredMessage(item, depth + 1);
    return message ? [`${fieldLabel(key)}: ${message}`] : [];
  });
  return entries.length > 0 ? entries.join(". ") : null;
}

export function humanReadableMessage(value: unknown, fallback: string): string {
  return structuredMessage(value) ?? fallback;
}

const MAX_PLAIN_TEXT_ERROR_LENGTH = 512;

function readablePlainTextError(response: Response, body: string): string | null {
  const message = body.trim();
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (
    !message
    || message.length > MAX_PLAIN_TEXT_ERROR_LENGTH
    || contentType.includes("text/html")
    || message.startsWith("<")
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message)
    || /<(?:!doctype|html|head|body|title|h[1-6]|div|p)\b/i.test(message)
  ) {
    return null;
  }
  if (contentType && !contentType.startsWith("text/plain")) {
    return null;
  }
  return message;
}

function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }
  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) {
    return null;
  }
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const fallback = response.statusText.trim() || `Request failed (HTTP ${response.status})`;
    let detail = fallback;
    try {
      const body = await response.text();
      let payload: unknown = null;
      if (body.trim()) {
        try {
          payload = JSON.parse(body);
        } catch {
          payload = readablePlainTextError(response, body);
        }
      }
      detail = humanReadableMessage(payload, fallback);
    } catch {
      detail = fallback;
    }
    throw new ApiResponseError(
      detail,
      response.status,
      retryAfterSeconds(response),
    );
  }
  return response.json() as Promise<T>;
}

export function imageUrl(jobId: string): string {
  return `${API_BASE_URL}/api/jobs/${jobId}/image`;
}

export function applicationBackupUrl(): string {
  return `${API_BASE_URL}/api/backups/export`;
}

export async function restoreApplicationBackup(
  file: File,
): Promise<ApplicationBackupRestoreResult> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE_URL}/api/backups/restore`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  return readJson<ApplicationBackupRestoreResult>(response);
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const response = await fetch(`${API_BASE_URL}/api/health`, {
    credentials: "include",
  });
  return readJson<SystemInfo>(response);
}

export async function getPipelineCapabilities(): Promise<PipelineCapabilities> {
  const response = await fetch(`${API_BASE_URL}/api/pipeline`, {
    credentials: "include",
  });
  return readJson<PipelineCapabilities>(response);
}

export async function getMcpAccessConfig(): Promise<McpAccessConfig> {
  const response = await fetch(`${API_BASE_URL}/api/mcp/config`, {
    credentials: "include",
  });
  return readJson<McpAccessConfig>(response);
}

function mcpAdminHeaders(adminToken: string): HeadersInit {
  return { Authorization: `Bearer ${adminToken}` };
}

export async function listMcpPrincipals(
  adminToken: string,
): Promise<McpPrincipal[]> {
  const response = await fetch("/api/mcp/principals", {
    headers: mcpAdminHeaders(adminToken),
    credentials: "include",
  });
  const payload = await readJson<{ principals: McpPrincipal[] }>(response);
  return payload.principals;
}

export async function createMcpPrincipal(
  adminToken: string,
  input: {
    name: string;
    scopes: McpScope[];
    expires_at: string | null;
  },
): Promise<McpIssuedPrincipal> {
  const response = await fetch("/api/mcp/principals", {
    method: "POST",
    headers: {
      ...mcpAdminHeaders(adminToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    credentials: "include",
  });
  return readJson<McpIssuedPrincipal>(response);
}

export async function rotateMcpPrincipal(
  adminToken: string,
  principalId: string,
): Promise<McpIssuedPrincipal> {
  const response = await fetch(
    `/api/mcp/principals/${encodeURIComponent(principalId)}/rotate`,
    {
      method: "POST",
      headers: mcpAdminHeaders(adminToken),
      credentials: "include",
    },
  );
  return readJson<McpIssuedPrincipal>(response);
}

export async function revokeMcpPrincipal(
  adminToken: string,
  principalId: string,
): Promise<McpPrincipal> {
  const response = await fetch(
    `/api/mcp/principals/${encodeURIComponent(principalId)}`,
    {
      method: "DELETE",
      headers: mcpAdminHeaders(adminToken),
      credentials: "include",
    },
  );
  return readJson<McpPrincipal>(response);
}

export async function getJob(jobId: string): Promise<JobRecord> {
  const response = await fetch(`${API_BASE_URL}/api/jobs/${jobId}`, {
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function updateJobMetadata(
  jobId: string,
  metadata: { title: string | null; notes: string | null; tags: string[] },
): Promise<JobRecord> {
  const response = await fetch(
    `${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/metadata`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
      credentials: "include",
    },
  );
  return readJson<JobRecord>(response);
}

export async function deleteJob(jobId: string): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}`,
    {
      method: "DELETE",
      credentials: "include",
    },
  );
  if (!response.ok && response.status !== 404) {
    await readJson<never>(response);
  }
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

export async function uploadScreenshot(
  file: File,
  uploadRequestId: string,
  signal?: AbortSignal,
  pipeline?: PipelineSelection,
): Promise<JobRecord> {
  const form = new FormData();
  form.append("file", file);
  form.append("upload_request_id", uploadRequestId);
  if (pipeline) {
    form.append("parser_provider", pipeline.parser_provider);
    form.append("parser_layout_profile", pipeline.parser_layout_profile);
    form.append("recommendation_provider", pipeline.recommendation_provider);
    if (pipeline.recommendation_engine) {
      form.append("recommendation_engine", pipeline.recommendation_engine);
    }
  }
  const response = await fetch(`${API_BASE_URL}/api/jobs`, {
    method: "POST",
    body: form,
    signal,
    credentials: "include",
  });
  const job = await readJson<JobRecord>(response);
  return job.upload_request_id
    ? job
    : { ...job, upload_request_id: uploadRequestId };
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

export async function requestRecommendation(
  jobId: string,
  requestId: string,
  signal?: AbortSignal,
): Promise<JobRecord> {
  const response = await fetch(`${API_BASE_URL}/api/jobs/${jobId}/recommend`, {
    method: "POST",
    headers: { "X-Recommendation-Request-ID": requestId },
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

export async function importBenchmarkDataset(
  file: File,
  requestId: string,
): Promise<BenchmarkDatasetImportResult> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE_URL}/api/benchmarks/import`, {
    method: "POST",
    headers: { "X-Benchmark-Import-Request-ID": requestId },
    body: form,
    credentials: "include",
  });
  return readJson<BenchmarkDatasetImportResult>(response);
}

export async function getBenchmarkDatasetImport(
  requestId: string,
): Promise<BenchmarkDatasetImportReceipt> {
  const response = await fetch(
    `${API_BASE_URL}/api/benchmarks/imports/${encodeURIComponent(requestId)}`,
    { credentials: "include" },
  );
  return readJson<BenchmarkDatasetImportReceipt>(response);
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
