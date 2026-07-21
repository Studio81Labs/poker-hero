import type {
  BenchmarkOverview,
  BenchmarkReport,
  CanonicalState,
  JobRecord,
  RecommendationAction,
  SystemInfo,
} from "./types";

const API_BASE_URL =
  typeof import.meta.env.VITE_API_BASE_URL === "string" && import.meta.env.VITE_API_BASE_URL.length > 0
    ? import.meta.env.VITE_API_BASE_URL
    : import.meta.env.DEV
      ? "http://localhost:8000"
      : "";

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = await response.json();
      detail = typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail);
    } catch {
      detail = response.statusText;
    }
    throw new Error(detail);
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
): Promise<JobRecord> {
  const response = await fetch(`${API_BASE_URL}/api/jobs/${jobId}/decision`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, sizing }),
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function getBenchmarkOverview(): Promise<BenchmarkOverview> {
  const response = await fetch(`${API_BASE_URL}/api/benchmarks`, {
    credentials: "include",
  });
  return readJson<BenchmarkOverview>(response);
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
