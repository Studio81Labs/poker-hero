import type {
  BenchmarkDatasetImportReceipt,
  BenchmarkDatasetImportResult,
  BenchmarkOverview,
  BenchmarkReport,
  JobRecord,
  PipelineSelection,
} from "../types";
import { apiUrl, readJson } from "./core";

type ParserPipeline = Pick<
  PipelineSelection,
  "parser_provider" | "parser_layout_profile"
>;

export async function getBenchmarkOverview(
  pipeline?: ParserPipeline,
): Promise<BenchmarkOverview> {
  const search = new URLSearchParams();
  if (pipeline) {
    search.set("parser_provider", pipeline.parser_provider);
    search.set("parser_layout_profile", pipeline.parser_layout_profile);
  }
  const query = search.size > 0 ? `?${search.toString()}` : "";
  const response = await fetch(apiUrl(`/api/benchmarks${query}`), {
    credentials: "include",
  });
  return readJson<BenchmarkOverview>(response);
}

export function benchmarkDatasetUrl(pipeline?: ParserPipeline): string {
  const url = apiUrl("/api/benchmarks/export");
  if (!pipeline) {
    return url;
  }
  const search = new URLSearchParams({
    parser_provider: pipeline.parser_provider,
    parser_layout_profile: pipeline.parser_layout_profile,
  });
  return `${url}?${search.toString()}`;
}

export async function importBenchmarkDataset(
  file: File,
  requestId: string,
): Promise<BenchmarkDatasetImportResult> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(apiUrl("/api/benchmarks/import"), {
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
    apiUrl(`/api/benchmarks/imports/${encodeURIComponent(requestId)}`),
    { credentials: "include" },
  );
  return readJson<BenchmarkDatasetImportReceipt>(response);
}

export async function getBenchmarkReport(
  reportId: string,
): Promise<BenchmarkReport> {
  const response = await fetch(apiUrl(`/api/benchmarks/${reportId}`), {
    credentials: "include",
  });
  return readJson<BenchmarkReport>(response);
}

export async function setBenchmarkInclusion(
  jobId: string,
  included: boolean,
): Promise<JobRecord> {
  const response = await fetch(apiUrl(`/api/jobs/${jobId}/benchmark`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ included }),
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function runParserBenchmark(
  pipeline?: ParserPipeline,
): Promise<BenchmarkReport> {
  const request: RequestInit = {
    method: "POST",
    credentials: "include",
  };
  if (pipeline) {
    request.headers = { "Content-Type": "application/json" };
    request.body = JSON.stringify({
      parser_provider: pipeline.parser_provider,
      parser_layout_profile: pipeline.parser_layout_profile,
    });
  }
  const response = await fetch(apiUrl("/api/benchmarks/run"), request);
  return readJson<BenchmarkReport>(response);
}
