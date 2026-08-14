import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  getBenchmarkOverview,
  getJob,
  getPipelineCapabilities,
  runParserBenchmark,
} from "../../../shared/api/client";
import {
  type BenchmarkComparisonProgress,
  benchmarkCorpusIsUnverified,
  benchmarkReportSummary,
  benchmarkReportsAreComparable,
  cacheBenchmarkReport,
  loadCachedBenchmarkReport,
  previousComparableBenchmarkReport,
} from "../lib/benchmarkPresentation";
import {
  providerLabel,
  reconcilePipelineSelection,
} from "../../pipeline/lib/pipelineSelection";
import { messageFromError } from "../../workspace/lib/workflow";
import type {
  BenchmarkOverview,
  BenchmarkReport,
  JobRecord,
  PipelineCapabilities,
  PipelineSelection,
} from "../../../shared/types";

interface UseBenchmarkControllerOptions {
  busy: boolean;
  importRecoveryPending: boolean;
  mutationRecoveryPending: () => boolean;
  onError: (message: string | null) => void;
  onOpenJob: (job: JobRecord) => void;
  pipelineCapabilities: PipelineCapabilities | null;
  pipelineLoading: boolean;
  pipelineSelection: PipelineSelection | null;
  setPipelineCapabilities: (capabilities: PipelineCapabilities) => void;
  setPipelineLoading: (loading: boolean) => void;
  setPipelineSelection: (selection: PipelineSelection) => void;
}

interface RefreshBenchmarkOptions {
  failureMessage: string;
  selection?: PipelineSelection | null;
}

export function useBenchmarkController({
  busy,
  importRecoveryPending,
  mutationRecoveryPending,
  onError,
  onOpenJob,
  pipelineCapabilities,
  pipelineLoading,
  pipelineSelection,
  setPipelineCapabilities,
  setPipelineLoading,
  setPipelineSelection,
}: UseBenchmarkControllerOptions) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [overview, setOverview] = useState<BenchmarkOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [comparisonProgress, setComparisonProgress] =
    useState<BenchmarkComparisonProgress | null>(null);
  const [updating, setUpdating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selectedReport, setSelectedReport] = useState<BenchmarkReport | null>(
    null,
  );
  const [comparisonReport, setComparisonReport] =
    useState<BenchmarkReport | null>(null);
  const [comparisonReportLoading, setComparisonReportLoading] = useState(false);
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const overviewRequestRef = useRef(0);
  const comparisonReportRequestRef = useRef(0);
  const reportCacheRef = useRef(new Map<string, BenchmarkReport>());
  const reportRequestsRef = useRef(new Map<string, Promise<BenchmarkReport>>());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const recentReports = useMemo(() => {
    if (overview?.recent_reports?.length) {
      return overview.recent_reports;
    }
    return overview?.latest_report
      ? [benchmarkReportSummary(overview.latest_report)]
      : [];
  }, [overview]);
  const report = selectedReport ?? overview?.latest_report ?? null;
  const reportStale = Boolean(
    report &&
    benchmarkCorpusIsUnverified(
      report.corpus_fingerprint,
      overview?.corpus_fingerprint,
    ),
  );
  const reportParserLabel = report
    ? (pipelineCapabilities?.parser_providers.find(
        (option) => option.id === report.parser_provider,
      )?.label ??
      overview?.parser_pipelines?.find(
        (pipeline) => pipeline.parser.id === report.parser_provider,
      )?.parser.label ??
      providerLabel(report.parser_provider))
    : null;
  const operationsLocked =
    loading ||
    reportLoading ||
    running ||
    updating ||
    importing ||
    importRecoveryPending ||
    reviewJobId !== null ||
    busy;
  const targetLayoutProfile =
    pipelineSelection?.parser_layout_profile ??
    overview?.default_layout_profile ??
    null;
  const hasLayoutCounts = Boolean(
    overview?.included_cases_by_layout &&
    (overview.included_cases === 0 ||
      Object.keys(overview.included_cases_by_layout).length > 0),
  );
  const includedCases =
    targetLayoutProfile && hasLayoutCounts && overview?.included_cases_by_layout
      ? (overview.included_cases_by_layout[targetLayoutProfile] ?? 0)
      : (overview?.included_cases ?? 0);
  const targetLayoutLabel =
    pipelineCapabilities?.parser_layout_profiles.find(
      (option) => option.id === targetLayoutProfile,
    )?.label ?? targetLayoutProfile;
  const datasetExportDisabled = operationsLocked || includedCases === 0;
  const previousReport = useMemo(
    () =>
      previousComparableBenchmarkReport(
        report,
        recentReports,
        overview?.parser_pipelines,
      ),
    [overview?.parser_pipelines, recentReports, report],
  );
  const parserPipelines = overview?.parser_pipelines ?? [];
  const runnablePipelines = parserPipelines.filter(
    (pipeline) => pipeline.parser.available,
  );

  useEffect(() => {
    const requestId = ++comparisonReportRequestRef.current;
    setComparisonReport(null);
    if (!dialogOpen || !report || !previousReport) {
      setComparisonReportLoading(false);
      return;
    }
    cacheBenchmarkReport(reportCacheRef.current, report);
    setComparisonReportLoading(true);
    void loadCachedBenchmarkReport(
      previousReport.id,
      reportCacheRef.current,
      reportRequestsRef.current,
    )
      .then((loadedReport) => {
        if (
          requestId !== comparisonReportRequestRef.current ||
          loadedReport.id !== previousReport.id
        ) {
          return;
        }
        if (!benchmarkReportsAreComparable(report, loadedReport)) {
          throw new Error(
            "The previous benchmark report no longer matches this run",
          );
        }
        setComparisonReport(loadedReport);
      })
      .catch((error) => {
        if (requestId === comparisonReportRequestRef.current) {
          toast.warning(
            messageFromError(error, "Could not compare benchmark cases"),
          );
        }
      })
      .finally(() => {
        if (requestId === comparisonReportRequestRef.current) {
          setComparisonReportLoading(false);
        }
      });
  }, [dialogOpen, previousReport, report]);

  function cacheOverviewReport(nextOverview: BenchmarkOverview) {
    if (nextOverview.latest_report) {
      cacheBenchmarkReport(reportCacheRef.current, nextOverview.latest_report);
    }
  }

  function loadOverview(
    selection: PipelineSelection | null,
    preservePipelineComparison = false,
  ) {
    const requestId = ++overviewRequestRef.current;
    comparisonReportRequestRef.current += 1;
    setComparisonReport(null);
    setComparisonReportLoading(false);
    setSelectedReport(null);
    setOverview((current) =>
      current
        ? {
            ...current,
            latest_report: null,
            recent_reports: [],
            parser_pipelines: preservePipelineComparison
              ? current.parser_pipelines
              : [],
          }
        : null,
    );
    setLoading(true);
    void getBenchmarkOverview(selection ?? undefined)
      .then((nextOverview) => {
        if (requestId !== overviewRequestRef.current) {
          return;
        }
        cacheOverviewReport(nextOverview);
        setOverview(nextOverview);
        setSelectedReport(nextOverview.latest_report);
      })
      .catch((error) => {
        if (requestId === overviewRequestRef.current) {
          onError(messageFromError(error, "Could not load parser benchmark"));
        }
      })
      .finally(() => {
        if (requestId === overviewRequestRef.current) {
          setLoading(false);
        }
      });
  }

  async function refreshOverview({
    failureMessage,
    selection = pipelineSelection,
  }: RefreshBenchmarkOptions): Promise<BenchmarkOverview | null> {
    const requestId = ++overviewRequestRef.current;
    try {
      const nextOverview = await getBenchmarkOverview(selection ?? undefined);
      if (!mountedRef.current || requestId !== overviewRequestRef.current) {
        return null;
      }
      cacheOverviewReport(nextOverview);
      setOverview(nextOverview);
      return nextOverview;
    } catch (error) {
      if (mountedRef.current && requestId === overviewRequestRef.current) {
        onError(messageFromError(error, failureMessage));
      }
      return null;
    }
  }

  function openDialog() {
    setDialogOpen(true);
    loadOverview(pipelineSelection);
  }

  function closeDialog() {
    overviewRequestRef.current += 1;
    comparisonReportRequestRef.current += 1;
    setLoading(false);
    setComparisonReportLoading(false);
    setDialogOpen(false);
  }

  function reset() {
    overviewRequestRef.current += 1;
    comparisonReportRequestRef.current += 1;
    setOverview(null);
    setSelectedReport(null);
    setComparisonReport(null);
    setLoading(false);
    setReportLoading(false);
    setComparisonReportLoading(false);
  }

  function applyReport(latestReport: BenchmarkReport, selectReport: boolean) {
    const latestSummary = benchmarkReportSummary(latestReport);
    cacheBenchmarkReport(reportCacheRef.current, latestReport);
    if (selectReport) {
      setSelectedReport(latestReport);
    }
    setOverview((current) => ({
      included_cases: current?.included_cases ?? latestReport.total_cases,
      included_cases_by_layout: current?.included_cases_by_layout,
      corpus_fingerprint: undefined,
      default_layout_profile:
        current?.default_layout_profile ?? latestReport.layout_profile,
      latest_report: selectReport
        ? latestReport
        : (current?.latest_report ?? null),
      recent_reports: selectReport
        ? [
            latestSummary,
            ...(current?.recent_reports ?? []).filter(
              (summary) => summary.id !== latestReport.id,
            ),
          ].slice(0, 10)
        : (current?.recent_reports ?? []),
      parser_pipelines: current?.parser_pipelines?.map((pipeline) =>
        pipeline.parser.id === latestReport.parser_provider &&
        pipeline.layout_profile === latestReport.layout_profile
          ? { ...pipeline, latest_report: latestSummary }
          : pipeline,
      ),
    }));
  }

  async function revalidateAfterRun(selection: PipelineSelection | null) {
    await refreshOverview({
      failureMessage:
        "Benchmark completed, but the current corpus could not be verified",
      selection,
    });
  }

  async function run() {
    if (operationsLocked || mutationRecoveryPending()) {
      return;
    }
    setRunning(true);
    onError(null);
    try {
      const latestReport = await runParserBenchmark(
        pipelineSelection ?? undefined,
      );
      applyReport(latestReport, true);
      if (latestReport.corpus_fingerprint) {
        await revalidateAfterRun(pipelineSelection);
      }
    } catch (error) {
      onError(messageFromError(error, "Parser benchmark failed"));
    } finally {
      setRunning(false);
    }
  }

  async function runComparison() {
    if (
      operationsLocked ||
      runnablePipelines.length < 2 ||
      mutationRecoveryPending()
    ) {
      return;
    }
    const selectedParser =
      pipelineSelection?.parser_provider ??
      report?.parser_provider ??
      runnablePipelines[0]?.parser.id;
    const failures: string[] = [];
    let successfulRuns = 0;
    let corpusRevalidationRequired = false;
    setRunning(true);
    onError(null);
    try {
      for (const [index, pipeline] of runnablePipelines.entries()) {
        setComparisonProgress({
          parserId: pipeline.parser.id,
          completed: index,
          total: runnablePipelines.length,
        });
        try {
          const nextReport = await runParserBenchmark({
            parser_provider: pipeline.parser.id,
            parser_layout_profile: pipeline.layout_profile,
          });
          applyReport(nextReport, pipeline.parser.id === selectedParser);
          successfulRuns += 1;
          corpusRevalidationRequired ||= Boolean(nextReport.corpus_fingerprint);
        } catch (error) {
          failures.push(
            `${pipeline.parser.label}: ${messageFromError(error, "Benchmark failed")}`,
          );
        }
      }
      if (successfulRuns > 0 && corpusRevalidationRequired) {
        await revalidateAfterRun(pipelineSelection);
      }
      if (successfulRuns === runnablePipelines.length) {
        toast.success(`Benchmark comparison ready: ${successfulRuns} parsers`);
      } else if (successfulRuns > 0) {
        toast.warning(
          `Benchmark comparison completed for ${successfulRuns} of ${runnablePipelines.length} parsers. ${failures.join(" ")}`,
        );
      } else {
        onError(`No parser benchmark completed. ${failures.join(" ")}`);
      }
    } finally {
      setComparisonProgress(null);
      setRunning(false);
    }
  }

  async function selectParserPipeline(parserProvider: string) {
    if (
      operationsLocked ||
      pipelineLoading ||
      parserProvider === pipelineSelection?.parser_provider
    ) {
      return;
    }
    let capabilities = pipelineCapabilities;
    if (!capabilities) {
      setPipelineLoading(true);
      onError(null);
      try {
        capabilities = await getPipelineCapabilities();
        setPipelineCapabilities(capabilities);
      } catch (error) {
        onError(messageFromError(error, "Could not read analysis plugins"));
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
      nextSelection.parser_provider !== parserProvider ||
      nextSelection.parser_layout_profile !==
        currentSelection.parser_layout_profile
    ) {
      onError("That parser is not available for the selected table layout");
      return;
    }
    setPipelineSelection(nextSelection);
    loadOverview(nextSelection, true);
  }

  async function selectReport(reportId: string) {
    if (reportId === report?.id) {
      return;
    }
    setReportLoading(true);
    onError(null);
    try {
      setSelectedReport(
        await loadCachedBenchmarkReport(
          reportId,
          reportCacheRef.current,
          reportRequestsRef.current,
        ),
      );
    } catch (error) {
      onError(messageFromError(error, "Could not load benchmark report"));
    } finally {
      setReportLoading(false);
    }
  }

  async function reviewCase(jobId: string) {
    setReviewJobId(jobId);
    onError(null);
    try {
      onOpenJob(await getJob(jobId));
      closeDialog();
    } catch (error) {
      onError(messageFromError(error, "Could not open benchmark hand"));
    } finally {
      setReviewJobId(null);
    }
  }

  return {
    closeDialog,
    comparisonProgress,
    comparisonReport,
    comparisonReportLoading,
    datasetExportDisabled,
    dialogOpen,
    importing,
    includedCases,
    loadOverview,
    loading,
    openDialog,
    operationsLocked,
    overview,
    parserPipelines,
    previousReport,
    recentReports,
    refreshOverview,
    report,
    reportLoading,
    reportParserLabel,
    reportStale,
    reset,
    reviewCase,
    reviewJobId,
    run,
    runComparison,
    running,
    selectParserPipeline,
    selectReport,
    setImporting,
    setOverview,
    setUpdating,
    targetLayoutLabel,
    targetLayoutProfile,
    updating,
  };
}
