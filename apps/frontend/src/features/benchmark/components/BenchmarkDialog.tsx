import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type Ref,
} from "react";
import {
  AlertTriangle,
  ChevronDown,
  Download,
  Eye,
  Play,
  Upload,
} from "lucide-react";

import {
  benchmarkDatasetUrl,
  humanReadableMessage,
} from "../../../shared/api/client";
import {
  type BenchmarkCaseFilter,
  type BenchmarkComparisonProgress,
  benchmarkCaseChanges,
  benchmarkCaseTrendMap,
  benchmarkComparisonValue,
  benchmarkCorpusIsUnverified,
  benchmarkMismatchLabel,
  benchmarkParserRouteSummary,
  benchmarkPipelinePointChange,
  benchmarkPointChange,
  benchmarkReportOption,
  benchmarkReportsAreComparable,
  previousBenchmarkFieldMetric,
} from "../lib/benchmarkPresentation";
import { providerLabel } from "../../pipeline/lib/pipelineSelection";
import { parserRoutingEvidence } from "../../recommendation/lib/recommendationPresentation";
import { DialogFooter } from "../../../shared/components/DialogFooter";
import { DialogFrame } from "../../../shared/components/DialogFrame";
import { DialogHeader } from "../../../shared/components/DialogHeader";
import {
  ButtonControl,
  DownloadLinkControl,
  FileInputControl,
  FormField,
  SelectControl,
} from "../../../shared/components/FormControls";
import { benchmarkPercent } from "../../../shared/lib/metricPresentation";
import { SegmentedControl } from "../../../shared/components/SegmentedControl";
import { StateMessage } from "../../../shared/components/StateMessage";
import { SummaryMetric } from "../../../shared/components/SummaryMetric";
import { ToggleControl } from "../../../shared/components/ToggleControl";
import type {
  BenchmarkOverview,
  BenchmarkParserPipelineSummary,
  BenchmarkReport,
  BenchmarkReportSummary,
  JobRecord,
  PipelineCapabilities,
  PipelineSelection,
} from "../../../shared/types";

export interface BenchmarkDialogProps {
  busy: boolean;
  comparisonProgress: BenchmarkComparisonProgress | null;
  comparisonReport: BenchmarkReport | null;
  comparisonReportLoading: boolean;
  currentJob: JobRecord | null;
  datasetExportDisabled: boolean;
  datasetInputRef: Ref<HTMLInputElement>;
  importInProgress: boolean;
  includedCases: number;
  loading: boolean;
  onClose: () => void;
  onChooseDatasetImport: () => void;
  onDatasetImport: (
    event: ChangeEvent<HTMLInputElement>,
  ) => void | Promise<void>;
  onReviewCase: (jobId: string) => void | Promise<void>;
  onRun: () => void | Promise<void>;
  onRunComparison: () => void | Promise<void>;
  onSelectPipeline: (parserProvider: string) => void | Promise<void>;
  onSelectReport: (reportId: string) => void | Promise<void>;
  onToggleInclusion: () => void | Promise<void>;
  operationsLocked: boolean;
  overview: BenchmarkOverview | null;
  parserPipelines: BenchmarkParserPipelineSummary[];
  pipelineCapabilities: PipelineCapabilities | null;
  pipelineLoading: boolean;
  pipelineSelection: PipelineSelection | null;
  previousReport: BenchmarkReportSummary | null;
  recentReports: BenchmarkReportSummary[];
  report: BenchmarkReport | null;
  reportLoading: boolean;
  reportParserLabel: string | null;
  reportStale: boolean;
  reviewJobId: string | null;
  running: boolean;
  targetLayoutLabel: string | null;
  updating: boolean;
}

export function BenchmarkDialog({
  busy,
  comparisonProgress,
  comparisonReport,
  comparisonReportLoading,
  currentJob,
  datasetExportDisabled,
  datasetInputRef,
  importInProgress,
  includedCases,
  loading,
  onClose,
  onChooseDatasetImport,
  onDatasetImport,
  onReviewCase,
  onRun,
  onRunComparison,
  onSelectPipeline,
  onSelectReport,
  onToggleInclusion,
  operationsLocked,
  overview,
  parserPipelines,
  pipelineCapabilities,
  pipelineLoading,
  pipelineSelection,
  previousReport,
  recentReports,
  report,
  reportLoading,
  reportParserLabel,
  reportStale,
  reviewJobId,
  running,
  targetLayoutLabel,
  updating,
}: BenchmarkDialogProps) {
  const [caseFilter, setCaseFilter] = useState<BenchmarkCaseFilter>("all");
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null);
  useEffect(() => {
    setCaseFilter("all");
    setExpandedCaseId(null);
  }, [report?.id]);
  const runnablePipelines = parserPipelines.filter(
    (pipeline) => pipeline.parser.available,
  );
  const accuracyDelta =
    report && previousReport
      ? benchmarkPointChange(report.accuracy, previousReport.accuracy)
      : null;
  const caseTrends = useMemo(
    () =>
      benchmarkCaseTrendMap(
        report,
        comparisonReport?.id === previousReport?.id ? comparisonReport : null,
      ),
    [comparisonReport, previousReport?.id, report],
  );
  const comparisonCases = useMemo(() => {
    if (
      !report ||
      !comparisonReport ||
      !benchmarkReportsAreComparable(report, comparisonReport) ||
      comparisonReport.id !== previousReport?.id
    ) {
      return new Map();
    }
    return new Map(
      comparisonReport.cases.map((benchmarkCase) => [
        benchmarkCase.job_id,
        benchmarkCase,
      ]),
    );
  }, [comparisonReport, previousReport?.id, report]);
  const caseTrendCounts = useMemo(() => {
    const counts = { regressed: 0, recovered: 0, mixed: 0 };
    for (const trend of caseTrends.values()) {
      if (trend !== "unchanged") counts[trend] += 1;
    }
    return counts;
  }, [caseTrends]);
  const visibleCases =
    caseFilter === "all"
      ? (report?.cases ?? [])
      : (report?.cases.filter(
          (benchmarkCase) =>
            caseTrends.get(benchmarkCase.job_id) === caseFilter,
        ) ?? []);
  const parserRoutes = benchmarkParserRouteSummary(report);
  const closeDisabled =
    running ||
    updating ||
    importInProgress ||
    reportLoading ||
    reviewJobId !== null;

  return (
    <DialogFrame className="benchmark-dialog" titleId="benchmark-dialog-title">
      <DialogHeader
        titleId="benchmark-dialog-title"
        title="Parser benchmark"
        subtitle={
          report
            ? `${reportParserLabel} · ${report.layout_profile}`
            : "Ground-truth recognition checks"
        }
        closeLabel="Close parser benchmark"
        closeDisabled={closeDisabled}
        onClose={onClose}
      />

      <div className="benchmark-dialog-body">
        <ToggleControl
          className="benchmark-ground-truth"
          checked={currentJob?.benchmark_included ?? false}
          title="Use current hand as ground truth"
          description={
            currentJob?.approved_state
              ? currentJob.original_filename
              : currentJob?.benchmark_included
                ? "Previous approved state remains included"
                : "Approve the current hand first"
          }
          onClick={() => void onToggleInclusion()}
          disabled={
            (!currentJob?.approved_state && !currentJob?.benchmark_included) ||
            operationsLocked
          }
        />

        {!loading && parserPipelines.length > 1 ? (
          <section
            className="benchmark-pipeline-comparison"
            aria-labelledby="benchmark-pipeline-comparison-title"
          >
            <div className="benchmark-pipeline-comparison-heading">
              <h3 id="benchmark-pipeline-comparison-title">
                Parser comparison
              </h3>
              <div>
                <span>Latest saved run</span>
                {runnablePipelines.length > 1 ? (
                  <ButtonControl
                    variant="secondary"
                    className="benchmark-comparison-run"
                    onClick={() => void onRunComparison()}
                    disabled={operationsLocked || includedCases === 0}
                  >
                    <Play size={12} aria-hidden="true" />
                    {comparisonProgress
                      ? `${comparisonProgress.completed + 1}/${comparisonProgress.total}`
                      : "Run comparison"}
                  </ButtonControl>
                ) : null}
              </div>
            </div>
            <div className="benchmark-pipeline-list">
              {parserPipelines.map((pipeline) => {
                const selected =
                  pipeline.parser.id ===
                  (pipelineSelection?.parser_provider ??
                    report?.parser_provider ??
                    parserPipelines[0]?.parser.id);
                const pipelineReport = pipeline.latest_report;
                const pipelineRunning =
                  comparisonProgress?.parserId === pipeline.parser.id;
                const stale = Boolean(
                  pipelineReport &&
                  benchmarkCorpusIsUnverified(
                    pipelineReport.corpus_fingerprint,
                    overview?.corpus_fingerprint,
                  ),
                );
                const pipelineDelta = benchmarkPipelinePointChange(
                  pipeline,
                  overview?.corpus_fingerprint,
                );
                const trendLabel =
                  pipelineDelta === null
                    ? null
                    : `${pipelineDelta > 0 ? "+" : ""}${pipelineDelta} pts`;
                let status = "No benchmark run";
                if (pipelineRunning) {
                  status = "Running benchmark...";
                } else if (!pipeline.parser.available) {
                  status =
                    pipeline.parser.unavailable_reason ??
                    "Parser is unavailable";
                } else if (stale) {
                  status = "Current corpus not verified · rerun";
                } else if (pipelineReport) {
                  status = `${pipelineReport.total_cases} ${pipelineReport.total_cases === 1 ? "case" : "cases"}${pipelineReport.failed_cases > 0 ? ` · ${pipelineReport.failed_cases} failed` : ""}`;
                }
                return (
                  <ButtonControl
                    key={pipeline.parser.id}
                    variant="ghost"
                    className={
                      [
                        selected ? "active" : "",
                        pipelineRunning ? "running" : "",
                        stale ? "stale" : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    onClick={() => void onSelectPipeline(pipeline.parser.id)}
                    disabled={
                      selected ||
                      pipelineLoading ||
                      !pipeline.parser.available ||
                      operationsLocked
                    }
                    aria-current={selected ? "true" : undefined}
                    aria-label={`Use ${pipeline.parser.label} benchmark pipeline`}
                    title={
                      pipeline.parser.unavailable_reason ??
                      (stale
                        ? "This benchmark is not verified against the current ground truth"
                        : undefined)
                    }
                  >
                    <span>
                      <strong>{pipeline.parser.label}</strong>
                      <small>
                        {status}
                        {trendLabel ? (
                          <span
                            className={`benchmark-pipeline-trend${pipelineDelta !== null && pipelineDelta > 0 ? " positive" : pipelineDelta !== null && pipelineDelta < 0 ? " negative" : ""}`}
                          >
                            {` · ${trendLabel}`}
                          </span>
                        ) : null}
                      </small>
                    </span>
                    <strong
                      className={
                        pipelineReport?.failed_cases || stale
                          ? "needs-review"
                          : undefined
                      }
                    >
                      {pipelineReport
                        ? benchmarkPercent(pipelineReport.accuracy)
                        : "--"}
                    </strong>
                  </ButtonControl>
                );
              })}
            </div>
          </section>
        ) : null}

        {loading ? (
          <StateMessage centered className="benchmark-empty">
            Reading benchmark results...
          </StateMessage>
        ) : report ? (
          <>
            <div className="benchmark-report-toolbar">
              <FormField label="Report" labelClassName="benchmark-report-label">
                <SelectControl
                  aria-label="Benchmark report"
                  value={report.id}
                  onChange={(event) => void onSelectReport(event.target.value)}
                  disabled={operationsLocked}
                >
                  {recentReports.map((summary) => (
                    <option key={summary.id} value={summary.id}>
                      {benchmarkReportOption(
                        summary,
                        overview?.latest_report?.id,
                        pipelineCapabilities,
                        overview?.parser_pipelines,
                        overview?.corpus_fingerprint,
                      )}
                    </option>
                  ))}
                </SelectControl>
              </FormField>
              {accuracyDelta !== null ? (
                <strong className={accuracyDelta < 0 ? "negative" : ""}>
                  {accuracyDelta > 0 ? "+" : ""}
                  {accuracyDelta} pts vs previous
                </strong>
              ) : (
                <span>No comparable earlier run</span>
              )}
            </div>
            {reportStale ? (
              <div className="benchmark-corpus-warning" role="status">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>
                  <strong>
                    This run is not verified against the current ground truth.
                  </strong>
                  Run the benchmark again before comparing its accuracy.
                </span>
              </div>
            ) : null}
            <div className="benchmark-summary" aria-label="Benchmark summary">
              <SummaryMetric label="cases" value={report.total_cases} />
              <SummaryMetric
                label="fields correct"
                value={`${report.correct_fields}/${report.evaluated_fields}`}
              />
              <SummaryMetric
                label="accuracy"
                value={benchmarkPercent(report.accuracy)}
              />
              <SummaryMetric
                attention={report.failed_cases > 0}
                label="failed"
                value={report.failed_cases}
              />
            </div>

            <div className="benchmark-results-scroll">
              {report.parser_provider === "auto" ? (
                <section
                  className="benchmark-result-section"
                  aria-labelledby="benchmark-routes-title"
                >
                  <h3 id="benchmark-routes-title">Parser routes</h3>
                  {parserRoutes.routes.length > 0 ? (
                    <div className="benchmark-route-list">
                      {parserRoutes.routes.map((route) => (
                        <div
                          key={route.provider}
                          aria-label={`${providerLabel(route.provider)} parser route`}
                        >
                          <span>
                            <strong>{providerLabel(route.provider)}</strong>
                            <small>
                              {route.cases}{" "}
                              {route.cases === 1 ? "case" : "cases"}
                              {` · ${route.correctFields}/${route.evaluatedFields} fields`}
                              {route.fallbackCases > 0
                                ? ` · ${route.fallbackCases} ${route.fallbackCases === 1 ? "fallback" : "fallbacks"}`
                                : ""}
                              {route.failedCases > 0
                                ? ` · ${route.failedCases} failed`
                                : ""}
                            </small>
                          </span>
                          <strong
                            className={
                              route.failedCases > 0 ? "needs-review" : ""
                            }
                          >
                            {benchmarkPercent(route.accuracy)}
                          </strong>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <StateMessage
                      as="p"
                      className="benchmark-route-empty"
                      size="compact"
                    >
                      No parser routes were recorded for this report.
                    </StateMessage>
                  )}
                  <p className="benchmark-route-coverage">
                    {parserRoutes.attributedCases} of {report.total_cases} cases
                    attributed
                  </p>
                </section>
              ) : null}

              <section
                className="benchmark-result-section"
                aria-labelledby="benchmark-fields-title"
              >
                <h3 id="benchmark-fields-title">Field accuracy</h3>
                <div className="benchmark-field-list">
                  {report.field_metrics.map((metric) => {
                    const previousMetric = previousBenchmarkFieldMetric(
                      metric,
                      previousReport,
                    );
                    const fieldDelta = previousMetric
                      ? benchmarkPointChange(
                          metric.accuracy,
                          previousMetric.accuracy,
                        )
                      : null;
                    const trendLabel = previousReport?.field_metrics?.length
                      ? fieldDelta === null
                        ? "New"
                        : `${fieldDelta > 0 ? "+" : ""}${fieldDelta} pts`
                      : null;
                    return (
                      <div
                        key={metric.field}
                        className={trendLabel ? "has-trend" : undefined}
                      >
                        <span>{metric.field.replace(/_/g, " ")}</span>
                        <small>
                          {metric.correct}/{metric.total}
                        </small>
                        <strong>{benchmarkPercent(metric.accuracy)}</strong>
                        {trendLabel ? (
                          <small
                            className={`benchmark-field-trend${fieldDelta !== null && fieldDelta < 0 ? " negative" : ""}`}
                            aria-label={`${metric.field.replace(/_/g, " ")} change ${trendLabel}`}
                          >
                            {trendLabel}
                          </small>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>

              <section
                className="benchmark-result-section"
                aria-labelledby="benchmark-cases-title"
              >
                <div className="benchmark-case-heading">
                  <h3 id="benchmark-cases-title">Cases</h3>
                  {comparisonReportLoading ? (
                    <span role="status">Comparing cases...</span>
                  ) : caseTrends.size > 0 ? (
                    <SegmentedControl
                      ariaLabel="Benchmark case filter"
                      className="benchmark-case-filter"
                      options={[
                        { value: "all", label: `All ${report.cases.length}` },
                        {
                          value: "regressed",
                          label: `Regressed ${caseTrendCounts.regressed}`,
                        },
                        {
                          value: "recovered",
                          label: `Recovered ${caseTrendCounts.recovered}`,
                        },
                        {
                          value: "mixed",
                          label: `Mixed ${caseTrendCounts.mixed}`,
                        },
                      ]}
                      value={caseFilter}
                      onChange={(filter) => {
                        setCaseFilter(filter);
                        setExpandedCaseId(null);
                      }}
                    />
                  ) : null}
                </div>
                <div className="benchmark-case-list">
                  {visibleCases.map((benchmarkCase) => {
                    const expanded = expandedCaseId === benchmarkCase.job_id;
                    const mismatches = benchmarkCase.comparisons.filter(
                      (comparison) => !comparison.matched,
                    );
                    const parserRoute = parserRoutingEvidence(
                      benchmarkCase.parser_routing,
                    );
                    const caseTrend = caseTrends.get(benchmarkCase.job_id);
                    const previousCase = comparisonCases.get(
                      benchmarkCase.job_id,
                    );
                    const caseChanges =
                      expanded && previousCase
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
                          onClick={() =>
                            setExpandedCaseId((current) =>
                              current === benchmarkCase.job_id
                                ? null
                                : benchmarkCase.job_id,
                            )
                          }
                          aria-expanded={expanded}
                          aria-controls={detailId}
                          aria-label={`Toggle ${benchmarkCase.original_filename} benchmark details${caseTrend && caseTrend !== "unchanged" ? `, ${caseTrend}` : ""}`}
                        >
                          <span>
                            <strong>
                              {benchmarkCase.original_filename}
                              {caseTrend && caseTrend !== "unchanged" ? (
                                <em
                                  className={`benchmark-case-trend ${caseTrend}`}
                                >
                                  {caseTrend}
                                </em>
                              ) : null}
                            </strong>
                            <small>
                              {parserRoute
                                ? `${providerLabel(parserRoute.selectedProvider)} · `
                                : ""}
                              {benchmarkCase.error
                                ? humanReadableMessage(
                                    benchmarkCase.error,
                                    "Benchmark failed",
                                  )
                                : benchmarkMismatchLabel(
                                    benchmarkCase.comparisons,
                                  )}
                            </small>
                          </span>
                          <strong
                            className={
                              benchmarkCase.status === "error" ||
                              mismatches.length > 0
                                ? "needs-review"
                                : ""
                            }
                          >
                            {benchmarkCase.status === "error"
                              ? "Error"
                              : benchmarkPercent(benchmarkCase.accuracy)}
                          </strong>
                          <ChevronDown size={15} aria-hidden="true" />
                        </ButtonControl>
                        {expanded ? (
                          <div id={detailId} className="benchmark-case-details">
                            {parserRoute ? (
                              <div
                                className="benchmark-case-routing"
                                aria-label="Parser routing"
                              >
                                <strong>
                                  {providerLabel(parserRoute.selectedProvider)}
                                </strong>
                                <span>
                                  via {providerLabel(parserRoute.provider)}
                                  {parserRoute.fallbackFrom
                                    ? ` · fallback from ${providerLabel(parserRoute.fallbackFrom)}`
                                    : ""}
                                </span>
                                {parserRoute.fallbackReason ? (
                                  <small>{parserRoute.fallbackReason}</small>
                                ) : null}
                              </div>
                            ) : null}
                            {benchmarkCase.error ? (
                              <p className="benchmark-case-error">
                                {humanReadableMessage(
                                  benchmarkCase.error,
                                  "Benchmark failed",
                                )}
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
                                      <code>
                                        {benchmarkComparisonValue(
                                          change.previousValue,
                                        )}
                                      </code>
                                    </span>
                                    <span>
                                      <small>Current</small>
                                      <code>
                                        {benchmarkComparisonValue(
                                          change.currentValue,
                                        )}
                                      </code>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {mismatches.length > 0 ? (
                              <div className="benchmark-mismatch-list">
                                {mismatches.map((comparison) => (
                                  <div key={comparison.field}>
                                    <strong>
                                      {comparison.field.replace(/_/g, " ")}
                                    </strong>
                                    <span>
                                      <small>Expected</small>
                                      <code>
                                        {benchmarkComparisonValue(
                                          comparison.expected,
                                        )}
                                      </code>
                                    </span>
                                    <span>
                                      <small>Detected</small>
                                      <code>
                                        {benchmarkComparisonValue(
                                          comparison.detected,
                                        )}
                                      </code>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : benchmarkCase.error ? null : (
                              <p className="benchmark-case-matched">
                                Every labeled field matched the approved state.
                              </p>
                            )}
                            <div className="benchmark-case-actions">
                              <ButtonControl
                                variant="secondary"
                                onClick={() =>
                                  void onReviewCase(benchmarkCase.job_id)
                                }
                                disabled={operationsLocked}
                              >
                                <Eye size={14} aria-hidden="true" />
                                {reviewJobId === benchmarkCase.job_id
                                  ? "Opening..."
                                  : "Review hand"}
                              </ButtonControl>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {visibleCases.length === 0 ? (
                    <StateMessage
                      as="p"
                      centered
                      className="benchmark-case-empty"
                      size="compact"
                    >
                      {caseFilter === "all"
                        ? "No benchmark cases in this report."
                        : `No ${caseFilter} cases in this comparison.`}
                    </StateMessage>
                  ) : null}
                </div>
              </section>
            </div>
          </>
        ) : (
          <StateMessage centered className="benchmark-empty">
            No benchmark has been run yet.
          </StateMessage>
        )}
      </div>

      <DialogFooter className="benchmark-dialog-footer">
        <span>
          <strong>{includedCases}</strong> ground-truth{" "}
          {includedCases === 1 ? "hand" : "hands"}
          {targetLayoutLabel ? ` · ${targetLayoutLabel}` : ""}
        </span>
        <ButtonControl
          variant="secondary"
          className="benchmark-dataset-action"
          onClick={onChooseDatasetImport}
          disabled={operationsLocked}
          aria-label="Import dataset"
          title="Import dataset"
        >
          <Upload size={14} aria-hidden="true" />
          <span>{importInProgress ? "Importing..." : "Import dataset"}</span>
        </ButtonControl>
        <FileInputControl
          ref={datasetInputRef}
          accept=".zip,application/zip"
          aria-label="Parser dataset ZIP"
          disabled={operationsLocked}
          onChange={(event) => void onDatasetImport(event)}
        />
        <DownloadLinkControl
          className="secondary-button benchmark-dataset-action benchmark-export-button"
          href={benchmarkDatasetUrl(pipelineSelection ?? undefined)}
          download
          aria-label="Export dataset"
          title="Export dataset"
          disabled={datasetExportDisabled}
        >
          <Download size={14} aria-hidden="true" />
          <span>Export dataset</span>
        </DownloadLinkControl>
        <ButtonControl
          onClick={() => void onRun()}
          disabled={operationsLocked || includedCases === 0}
        >
          <Play size={14} aria-hidden="true" />
          {running ? "Running..." : "Run benchmark"}
        </ButtonControl>
        <ButtonControl
          variant="secondary"
          onClick={onClose}
          disabled={closeDisabled}
        >
          Done
        </ButtonControl>
      </DialogFooter>
    </DialogFrame>
  );
}
