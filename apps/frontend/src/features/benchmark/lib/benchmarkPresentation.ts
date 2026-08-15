import { benchmarkPercent } from "../../../shared/lib/metricPresentation";
import {
  getBenchmarkReport,
  humanReadableMessage,
} from "../../../shared/api/client";
import {
  type BenchmarkCaseResult,
  type BenchmarkFieldComparison,
  type BenchmarkFieldMetric,
  type BenchmarkOverview,
  type BenchmarkParserPipelineSummary,
  type BenchmarkReport,
  type BenchmarkReportSummary,
  type PipelineCapabilities,
} from "../../../shared/types";
import { providerLabel } from "../../pipeline/lib/pipelineSelection";
import {
  PREFLOP_POSITIONS,
  normalizePreflopPosition,
} from "../../hand-review/lib/preflopPosition";
import { parserRoutingEvidence } from "../../recommendation/lib/recommendationPresentation";
import { benchmarkFieldLabel } from "../../training/lib/trainingPresentation";

export type BenchmarkCaseTrend =
  | "regressed"
  | "recovered"
  | "mixed"
  | "unchanged";

export type BenchmarkCaseFilter =
  | "all"
  | Exclude<BenchmarkCaseTrend, "unchanged">;

export type BenchmarkCaseChangeTrend = Extract<
  BenchmarkCaseTrend,
  "regressed" | "recovered"
>;

export type BenchmarkCaseChange = {
  key: string;
  label: string;
  trend: BenchmarkCaseChangeTrend;
  previousValue: unknown;
  currentValue: unknown;
};

export interface BenchmarkParserRouteMetric {
  provider: string;
  cases: number;
  failedCases: number;
  fallbackCases: number;
  correctFields: number;
  evaluatedFields: number;
  accuracy: number;
}

export interface BenchmarkParserRouteSummary {
  attributedCases: number;
  routes: BenchmarkParserRouteMetric[];
}

export interface BenchmarkComparisonProgress {
  parserId: string;
  completed: number;
  total: number;
}

export function benchmarkReportSummary(
  report: BenchmarkReport,
): BenchmarkReportSummary {
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

export function benchmarkCorpusIsUnverified(
  reportFingerprint: string | null | undefined,
  currentFingerprint: string | null | undefined,
): boolean {
  return (
    !reportFingerprint ||
    !currentFingerprint ||
    reportFingerprint !== currentFingerprint
  );
}

export function benchmarkCorpusFingerprintAfterLayoutMutation(
  currentFingerprint: string | null | undefined,
  mutatedLayoutProfile: string | null | undefined,
  selectedLayoutProfile: string | null | undefined,
): string | null | undefined {
  return mutatedLayoutProfile &&
    selectedLayoutProfile &&
    mutatedLayoutProfile !== selectedLayoutProfile
    ? currentFingerprint
    : undefined;
}

export function benchmarkReportOption(
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
  const parserLabel =
    capabilities?.parser_providers.find(
      (option) => option.id === summary.parser_provider,
    )?.label ??
    parserPipelines?.find(
      (pipeline) => pipeline.parser.id === summary.parser_provider,
    )?.parser.label ??
    providerLabel(summary.parser_provider);
  const rawLayoutLabel =
    capabilities?.parser_layout_profiles.find(
      (option) => option.id === summary.layout_profile,
    )?.label ?? providerLabel(summary.layout_profile);
  const layoutLabel =
    rawLayoutLabel.charAt(0).toUpperCase() + rawLayoutLabel.slice(1);
  const staleLabel = benchmarkCorpusIsUnverified(
    summary.corpus_fingerprint,
    currentCorpusFingerprint,
  )
    ? " · rerun needed"
    : "";
  return `${summary.id === latestId ? "Latest" : dateLabel} · ${parserLabel} · ${layoutLabel} · ${benchmarkPercent(summary.accuracy)}${staleLabel}`;
}

export function previousComparableBenchmarkReport(
  report: BenchmarkReport | null,
  recentReports: BenchmarkReportSummary[],
  parserPipelines: BenchmarkOverview["parser_pipelines"],
): BenchmarkReportSummary | null {
  if (!report) {
    return null;
  }
  const currentIndex = recentReports.findIndex(
    (summary) => summary.id === report.id,
  );
  const recentMatch =
    currentIndex < 0
      ? null
      : (recentReports
          .slice(currentIndex + 1)
          .find(
            (summary) =>
              summary.parser_provider === report.parser_provider &&
              summary.layout_profile === report.layout_profile &&
              !benchmarkCorpusIsUnverified(
                summary.corpus_fingerprint,
                report.corpus_fingerprint,
              ),
          ) ?? null);
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

export function benchmarkPointChange(
  current: number,
  previous: number,
): number {
  return Math.round((current - previous) * 100);
}

export function benchmarkPipelinePointChange(
  pipeline: BenchmarkParserPipelineSummary,
  currentCorpusFingerprint: string | null | undefined,
): number | null {
  const latest = pipeline.latest_report;
  const previous = pipeline.previous_report;
  if (
    !latest ||
    !previous ||
    benchmarkCorpusIsUnverified(
      latest.corpus_fingerprint,
      currentCorpusFingerprint,
    ) ||
    benchmarkCorpusIsUnverified(
      previous.corpus_fingerprint,
      latest.corpus_fingerprint,
    )
  ) {
    return null;
  }
  return benchmarkPointChange(latest.accuracy, previous.accuracy);
}

export { normalizePreflopPosition };

export function previousBenchmarkFieldMetric(
  metric: BenchmarkFieldMetric,
  previousReport: BenchmarkReportSummary | null,
): BenchmarkFieldMetric | null {
  return (
    previousReport?.field_metrics?.find(
      (candidate) => candidate.field === metric.field,
    ) ?? null
  );
}

export function benchmarkReportsAreComparable(
  report: BenchmarkReport,
  previousReport: BenchmarkReport,
): boolean {
  return (
    previousReport.id !== report.id &&
    previousReport.parser_provider === report.parser_provider &&
    previousReport.layout_profile === report.layout_profile &&
    !benchmarkCorpusIsUnverified(
      previousReport.corpus_fingerprint,
      report.corpus_fingerprint,
    )
  );
}

export function benchmarkCaseTrend(
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
    previousCase.comparisons.map((comparison) => [
      comparison.field,
      comparison,
    ]),
  );
  let regressed = false;
  let recovered = false;
  for (const comparison of benchmarkCase.comparisons) {
    const previousComparison = previousComparisons.get(comparison.field);
    if (
      !previousComparison ||
      comparison.matched === previousComparison.matched
    ) {
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

export function benchmarkCaseStatusValue(
  benchmarkCase: BenchmarkCaseResult,
): string {
  if (benchmarkCase.status === "error") {
    return humanReadableMessage(benchmarkCase.error, "Parser failed");
  }
  return `Completed at ${benchmarkPercent(benchmarkCase.accuracy)}`;
}

export function benchmarkCaseChanges(
  benchmarkCase: BenchmarkCaseResult,
  previousCase: BenchmarkCaseResult,
): BenchmarkCaseChange[] {
  if (benchmarkCase.status !== previousCase.status) {
    return [
      {
        key: "parser-status",
        label: "Parser status",
        trend: benchmarkCase.status === "error" ? "regressed" : "recovered",
        previousValue: benchmarkCaseStatusValue(previousCase),
        currentValue: benchmarkCaseStatusValue(benchmarkCase),
      },
    ];
  }
  const previousComparisons = new Map(
    previousCase.comparisons.map((comparison) => [
      comparison.field,
      comparison,
    ]),
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

export function benchmarkCaseTrendMap(
  report: BenchmarkReport | null,
  previousReport: BenchmarkReport | null,
): Map<string, BenchmarkCaseTrend> {
  const trends = new Map<string, BenchmarkCaseTrend>();
  if (
    !report ||
    !previousReport ||
    !benchmarkReportsAreComparable(report, previousReport)
  ) {
    return trends;
  }
  const previousCases = new Map(
    previousReport.cases.map((benchmarkCase) => [
      benchmarkCase.job_id,
      benchmarkCase,
    ]),
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

export const BENCHMARK_REPORT_CACHE_LIMIT = 20;

export function cacheBenchmarkReport(
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

export function loadCachedBenchmarkReport(
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

export function benchmarkParserRouteSummary(
  report: BenchmarkReport | null,
): BenchmarkParserRouteSummary {
  if (!report || report.parser_provider !== "auto") {
    return { attributedCases: 0, routes: [] };
  }

  const routes = new Map<
    string,
    Omit<BenchmarkParserRouteMetric, "accuracy">
  >();
  let attributedCases = 0;
  for (const benchmarkCase of report.cases) {
    const routing = parserRoutingEvidence(benchmarkCase.parser_routing);
    if (
      !routing ||
      routing.provider !== report.parser_provider ||
      routing.layoutProfile !== report.layout_profile
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
        accuracy:
          route.evaluatedFields > 0
            ? route.correctFields / route.evaluatedFields
            : 0,
      }))
      .sort((left, right) =>
        providerLabel(left.provider).localeCompare(
          providerLabel(right.provider),
        ),
      ),
  };
}

export function benchmarkComparisonValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "Not detected";
  }
  if (Array.isArray(value)) {
    return value.length > 0
      ? value
          .map((item) => benchmarkActionValue(item) ?? String(item))
          .join("; ")
      : "None";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

export function benchmarkActionValue(value: unknown): string | null {
  return (
    benchmarkPreflopActionValue(value) ?? benchmarkPostflopActionValue(value)
  );
}

export function benchmarkPreflopActionValue(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (
    !PREFLOP_POSITIONS.some((position) => position.value === item.actor) ||
    (item.action !== "call" && item.action !== "raise") ||
    typeof item.amount !== "number" ||
    !Number.isFinite(item.amount)
  ) {
    return null;
  }
  const actor = PREFLOP_POSITIONS.find(
    (position) => position.value === item.actor,
  )?.label;
  const action = item.action === "raise" ? "raise to" : "call";
  return `${actor} ${action} ${item.amount} BB`;
}

export function benchmarkPostflopActionValue(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (
    (item.actor !== "oop" && item.actor !== "ip") ||
    (item.action !== "check" &&
      item.action !== "bet" &&
      item.action !== "raise")
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

export function benchmarkMismatchLabel(
  comparisons: BenchmarkFieldComparison[],
): string {
  const mismatchCount = comparisons.filter(
    (comparison) => !comparison.matched,
  ).length;
  if (mismatchCount === 0) {
    return "All labeled fields matched";
  }
  return `${mismatchCount} ${mismatchCount === 1 ? "mismatch" : "mismatches"}`;
}
