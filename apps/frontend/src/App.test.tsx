import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import type { CanonicalState, DetectedState, JobRecord, RecommendationResult } from "./types";

const detectedState: DetectedState = {
  hero_cards: [
    { rank: "A", suit: "hearts" },
    { rank: "K", suit: "diamonds" },
  ],
  board_cards: [
    { rank: "Q", suit: "spades" },
    { rank: "J", suit: "clubs" },
    { rank: "2", suit: "hearts" },
  ],
  pot_size: 12.5,
  current_bet: 2.5,
  hero_stack: 97.5,
  effective_stack: 96,
  players_in_hand: 3,
  hero_position: "button",
  preflop_opener_position: null,
  preflop_open_size: null,
  street: "flop",
  facing_action: "bet",
  action_context: "Cutoff bet 2.5 into 12.5",
};

const recommendation: RecommendationResult = {
  action: "raise",
  sizing: 7.5,
  confidence: 0.82,
  explanation: "Apply pressure with top pair and strong blockers.",
  raw: { provider: "mock" },
};

const recommendationWithEvidence: RecommendationResult = {
  ...recommendation,
  explanation: "Solver compared candidate actions and selected the highest EV line.",
  raw: {
    provider: "local_solver",
    engine: "local_ev_solver_v1",
    requested_engine: "postflop_solver",
    fallback_reason: "the open-source engine supports heads-up postflop spots only",
    equity: { equity: 0.61 },
    realized_equity: 0.55,
    required_equity: 0.2,
    stack_depth_policy: 42,
    effective_stack: -1,
    opening_raise_size: "2.5",
    continue_fraction: 4,
    candidates: [
      { action: "fold", sizing: null, ev: 0 },
      { action: "call", sizing: null, ev: 3.1 },
      { action: "check", sizing: null, ev: 3 },
      { action: "bet", sizing: 2.5, ev: 2.9 },
      { action: "raise", sizing: 4, ev: 2.8 },
      { action: "raise", sizing: 7.5, ev: 2.4, frequency: 0.72 },
      { action: "invalid", sizing: -1, ev: "unknown" },
    ],
  },
};

function canonicalState(overrides: Partial<CanonicalState> = {}): CanonicalState {
  return {
    ...detectedState,
    user_approved: true,
    ...overrides,
  };
}

function jobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-123",
    status: "parsed",
    original_filename: "table.png",
    image_filename: "job-123.png",
    parser_provider: "mock",
    recommendation_provider: "mock",
    parser_result: {
      state: detectedState,
      confidences: {
        hero_cards: 0.99,
        board_cards: 0.98,
        pot_size: 0.92,
        current_bet: 0.9,
        hero_stack: 0.89,
        effective_stack: 0.88,
        players_in_hand: 0.86,
        hero_position: 0.84,
        street: 1,
        facing_action: 0.9,
      },
      warnings: [],
      raw: { provider: "mock" },
    },
    approved_state: null,
    training_decision: null,
    recommendation: null,
    recommendation_pending: false,
    training_reviewed_at: null,
    training_review_note: null,
    benchmark_included: false,
    archived_at: null,
    error: null,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    ...overrides,
  };
}

function approvedJob(state: CanonicalState = canonicalState()): JobRecord {
  return jobRecord({
    status: "approved",
    approved_state: state,
    recommendation: null,
  });
}

function recommendedJob(state: CanonicalState = canonicalState()): JobRecord {
  return jobRecord({
    status: "recommended",
    approved_state: state,
    recommendation,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function processingQueueResponse(
  jobs: JobRecord[],
  snapshotVersion = "test-processing-snapshot",
): Response {
  return jsonResponse({
    total: jobs.length,
    jobs,
    snapshot_version: snapshotVersion,
  });
}

function benchmarkOverviewForJob(jobId: string, originalFilename: string) {
  return {
    included_cases: 1,
    latest_report: {
      id: `benchmark-${jobId}`,
      parser_provider: "ocr_cv",
      layout_profile: "fortuna",
      created_at: "2026-07-20T12:00:00Z",
      total_cases: 1,
      successful_cases: 1,
      failed_cases: 0,
      correct_fields: 10,
      evaluated_fields: 10,
      accuracy: 1,
      field_metrics: [{ field: "pot_size", correct: 1, total: 1, accuracy: 1 }],
      cases: [{
        job_id: jobId,
        original_filename: originalFilename,
        status: "completed",
        correct_fields: 10,
        evaluated_fields: 10,
        accuracy: 1,
        warnings: [],
        error: null,
        comparisons: [],
      }],
    },
    recent_reports: [],
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function fetchMock() {
  return vi.mocked(fetch);
}

function stubCanvasCapture() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(callback: BlobCallback) {
    callback(new Blob(["capture"], { type: "image/png" }));
  });
}

function stubDisplayMedia(displaySurface = "window") {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  const stop = vi.fn();
  const getDisplayMedia = vi.fn().mockResolvedValue({
    getTracks: () => [{ addEventListener, removeEventListener, stop }],
    getVideoTracks: () => [{ getSettings: () => ({ displaySurface }) }],
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia },
  });

  return { addEventListener, getDisplayMedia, removeEventListener, stop };
}

function setSharedPreviewSize() {
  const preview = screen.getByLabelText("Shared screen preview");
  Object.defineProperty(preview, "videoWidth", { configurable: true, value: 973 });
  Object.defineProperty(preview, "videoHeight", { configurable: true, value: 691 });
}

async function switchToUploadMode(user = userEvent.setup()) {
  if (!screen.queryByLabelText("Choose screenshots")) {
    await user.click(screen.getByRole("button", { name: "Upload" }));
  }
  return user;
}

async function disableAutomation(user = userEvent.setup()) {
  const automationButton = screen.queryByRole("button", { name: "Automation On" });
  if (automationButton) {
    await user.click(automationButton);
  }
  return user;
}

async function uploadScreenshot(name = "table.png") {
  const user = userEvent.setup();
  await disableAutomation(user);
  await switchToUploadMode(user);
  const input = screen.getByLabelText("Choose screenshots");
  const file = new File(["not-real-image-bytes"], name, { type: "image/png" });

  await user.upload(input, file);
  await user.click(screen.getByRole("button", { name: "Upload and parse" }));

  return user;
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("poker-training-processing-v1", "[]");
  window.localStorage.setItem("poker-training-processing-total-v1", "0");
  window.localStorage.setItem("poker-training-history-v1", "[]");
  window.localStorage.setItem("poker-training-history-total-v1", "0");
  window.sessionStorage.clear();
  window.sessionStorage.setItem("poker-training-processing-synced", "true");
  window.sessionStorage.setItem("poker-training-history-synced", "true");
  vi.stubGlobal("fetch", vi.fn());
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: undefined,
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("restores the processing queue immediately from the browser cache", async () => {
    const cachedJob = jobRecord({
      id: "a".repeat(32),
      original_filename: "cached-table.png",
    });
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([cachedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");

    render(<App />);

    expect(await screen.findByRole("button", {
      name: "Open screenshot 1: cached-table.png",
    })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Ah Kd")).toBeInTheDocument();
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer processing cache record from another tab", async () => {
    const jobId = "1".repeat(32);
    const staleJob = jobRecord({
      id: jobId,
      original_filename: "shared-cache.png",
    });
    const newerJob = {
      ...staleJob,
      status: "approved" as const,
      approved_state: canonicalState({ pot_size: 20 }),
      updated_at: "2026-07-10T00:01:00Z",
    };
    const archivedJob = jobRecord({
      id: "2".repeat(32),
      original_filename: "history-trigger.png",
      archived_at: "2026-07-10T00:02:00Z",
    });
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([staleJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{
        id: archivedJob.id,
        job: archivedJob,
        savedAt: archivedJob.archived_at,
      }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    render(<App />);
    const user = userEvent.setup();

    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([newerJob]),
    );
    await user.click(screen.getByRole("button", {
      name: "Reopen history item 1",
    }));

    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([newerJob]));
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("preserves a dirty archived workspace during processing reconciliation", async () => {
    const processingJob = jobRecord({
      id: "3".repeat(32),
      original_filename: "processing-sibling.png",
    });
    const archivedJob = jobRecord({
      id: "4".repeat(32),
      original_filename: "archived-workspace.png",
      archived_at: "2026-07-10T00:02:00Z",
    });
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([processingJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{
        id: archivedJob.id,
        job: archivedJob,
        savedAt: archivedJob.archived_at,
      }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    fetchMock().mockResolvedValueOnce(processingQueueResponse(
      [processingJob],
      "processing-refresh-with-archived-workspace",
    ));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", {
      name: "Reopen history item 1",
    }));
    const heroCards = screen.getByLabelText(/Hero cards/);
    await user.clear(heroCards);
    await user.type(heroCards, "7d Ah");
    window.dispatchEvent(new StorageEvent("storage", {
      key: "poker-training-processing-v1",
      oldValue: "[]",
      newValue: JSON.stringify([processingJob]),
      storageArea: window.localStorage,
    }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    expect(await screen.findByDisplayValue("7d Ah")).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Open screenshot 2: archived-workspace.png",
    })).toHaveClass("active");
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([processingJob]);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
  });

  it("reconciles processing when another tab changes the shared cache", async () => {
    const jobId = "3".repeat(32);
    const staleJob = jobRecord({
      id: jobId,
      original_filename: "cross-tab-update.png",
    });
    const newerJob = {
      ...staleJob,
      status: "approved" as const,
      approved_state: canonicalState({ pot_size: 20 }),
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([staleJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock().mockResolvedValueOnce(processingQueueResponse(
      [newerJob],
      "cross-tab-update-snapshot",
    ));
    render(<App />);

    const serializedNewerJob = JSON.stringify([newerJob]);
    window.localStorage.setItem(
      "poker-training-processing-v1",
      serializedNewerJob,
    );
    window.dispatchEvent(new StorageEvent("storage", {
      key: "poker-training-processing-v1",
      oldValue: JSON.stringify([staleJob]),
      newValue: serializedNewerJob,
      storageArea: window.localStorage,
    }));

    expect(await screen.findByDisplayValue("20")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve state" })).toBeDisabled();
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
  });

  it("preserves dirty processing jobs removed by another tab", async () => {
    const removedJob = jobRecord({
      id: "0".repeat(32),
      original_filename: "archived-in-another-tab.png",
    });
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([removedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock().mockResolvedValueOnce(processingQueueResponse(
      [],
      "cross-tab-removal",
    ));
    render(<App />);
    const user = userEvent.setup();

    expect(await screen.findByRole("button", {
      name: "Open screenshot 1: archived-in-another-tab.png",
    })).toBeInTheDocument();
    const heroCards = screen.getByLabelText(/Hero cards/);
    await user.clear(heroCards);
    await user.type(heroCards, "7d Ah");
    window.localStorage.setItem("poker-training-processing-v1", "[]");
    window.localStorage.setItem("poker-training-processing-total-v1", "0");
    window.dispatchEvent(new StorageEvent("storage", {
      key: "poker-training-processing-v1",
      oldValue: JSON.stringify([removedJob]),
      newValue: "[]",
      storageArea: window.localStorage,
    }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", {
      name: "Open screenshot 1: archived-in-another-tab.png",
    })).toHaveClass("active");
    expect(heroCards).toHaveValue("7d Ah");
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([removedJob]);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBeNull();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("polls a parser job that was still running during reload", async () => {
    const jobId = "5".repeat(32);
    const createdJob = jobRecord({
      id: jobId,
      status: "created",
      original_filename: "parser-still-running.png",
      parser_result: null,
      updated_at: "2026-07-10T00:01:00Z",
    });
    const parsedJob = jobRecord({
      id: jobId,
      original_filename: "parser-still-running.png",
      updated_at: "2026-07-10T00:02:00Z",
    });
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([createdJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(processingQueueResponse(
        [createdJob],
        "parser-still-running",
      ))
      .mockResolvedValueOnce(processingQueueResponse(
        [parsedJob],
        "parser-completed",
      ));

    render(<App />);

    const queueItem = await screen.findByRole("button", {
      name: "Open screenshot 1: parser-still-running.png",
    });
    expect(within(queueItem).getByText("Parsing screenshot")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("Ah Kd")).toBeInTheDocument();
    expect(within(queueItem).queryByText("Parsing screenshot")).not.toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([parsedJob]);
  });

  it("polls a recommendation that was still running during reload", async () => {
    const jobId = "4".repeat(32);
    const pendingJob = {
      ...approvedJob(),
      id: jobId,
      original_filename: "pending-recommendation.png",
      recommendation_pending: true,
      updated_at: "2026-07-10T00:01:00Z",
    };
    const completedJob = {
      ...recommendedJob(),
      id: jobId,
      original_filename: "pending-recommendation.png",
      recommendation_pending: false,
      updated_at: "2026-07-10T00:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([pendingJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    const pendingCompletion = deferredResponse();
    fetchMock()
      .mockResolvedValueOnce(processingQueueResponse(
        [pendingJob],
        "recommendation-still-running",
      ))
      .mockReturnValueOnce(pendingCompletion.promise);
    render(<App />);

    const queueItem = await screen.findByRole("button", {
      name: "Open screenshot 1: pending-recommendation.png",
    });
    expect(within(queueItem).getByText("Recommendation running")).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeDisabled();
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(2));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBeNull();

    await act(async () => {
      pendingCompletion.resolve(processingQueueResponse(
        [completedJob],
        "recommendation-completed",
      ));
      await pendingCompletion.promise;
    });

    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(within(queueItem).queryByText(
      "Recommendation running",
    )).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([completedJob]);
  });

  it("lets terminal history state replace a future-dated pending cache", async () => {
    const jobId = "8".repeat(32);
    const archivedAt = "2026-07-10T00:00:30Z";
    const pendingJob = {
      ...approvedJob(),
      id: jobId,
      original_filename: "archived-pending-recommendation.png",
      recommendation_pending: true,
      archived_at: archivedAt,
      updated_at: "9999-01-01T00:00:00Z",
    };
    const completedJob = {
      ...recommendedJob(),
      id: jobId,
      original_filename: "archived-pending-recommendation.png",
      recommendation_pending: false,
      archived_at: archivedAt,
      updated_at: "2026-07-10T00:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{
        id: jobId,
        job: pendingJob,
        savedAt: archivedAt,
      }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    const pendingHistoryRestore = deferredResponse();
    fetchMock().mockReturnValueOnce(pendingHistoryRestore.promise);
    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", {
      name: "Reopen history item 1",
    }));
    expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeDisabled();
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${jobId}`,
      { credentials: "include" },
    ));
    expect(window.sessionStorage.getItem(
      "poker-training-history-synced",
    )).toBeNull();
    await act(async () => {
      pendingHistoryRestore.resolve(jsonResponse(completedJob));
      await pendingHistoryRestore.promise;
    });

    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(screen.getByText(recommendation.explanation)).toBeInTheDocument();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-history-v1"),
    ))[0].job).toEqual(completedJob);
    expect(window.sessionStorage.getItem(
      "poker-training-history-synced",
    )).toBe("true");
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${jobId}`,
    ]);
  });

  it(
    "prefers terminal processing state over a slightly newer pending cache",
    async () => {
      const jobId = "9".repeat(32);
      const serverUpdatedAt = Date.now();
      const poisonedPendingJob = {
        ...approvedJob(),
        id: jobId,
        original_filename: "future-pending.png",
        recommendation_pending: true,
        updated_at: new Date(serverUpdatedAt + 60_000).toISOString(),
      };
      const completedJob = {
        ...recommendedJob(),
        id: jobId,
        original_filename: "future-pending.png",
        recommendation_pending: false,
        updated_at: new Date(serverUpdatedAt).toISOString(),
      };
      window.localStorage.setItem(
        "poker-training-processing-v1",
        JSON.stringify([poisonedPendingJob]),
      );
      window.localStorage.setItem("poker-training-processing-total-v1", "1");
      fetchMock().mockResolvedValueOnce(processingQueueResponse(
        [completedJob],
        "future-pending-recovered",
      ));

      render(<App />);

      expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
      expect(screen.getByRole("button", {
        name: "Request recommendation",
      })).toBeDisabled();
      expect(fetchMock()).toHaveBeenCalledTimes(1);
      expect(window.sessionStorage.getItem(
        "poker-training-processing-synced",
      )).toBe("true");
      expect(JSON.parse(String(
        window.localStorage.getItem("poker-training-processing-v1"),
      ))).toEqual([completedJob]);
    },
  );

  it("lets authoritative processing state replace a future-dated ordinary cache", async () => {
    const jobId = "7".repeat(32);
    const futureCachedJob = jobRecord({
      id: jobId,
      original_filename: "future-ordinary.png",
      updated_at: "9999-01-01T00:00:00Z",
    });
    const approvedServerJob: JobRecord = {
      ...futureCachedJob,
      status: "approved",
      approved_state: canonicalState({ pot_size: 20 }),
      updated_at: "2026-07-10T00:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([futureCachedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.sessionStorage.removeItem("poker-training-processing-synced");
    fetchMock().mockResolvedValueOnce(processingQueueResponse(
      [approvedServerJob],
      "future-ordinary-recovered",
    ));

    render(<App />);

    expect(await screen.findByDisplayValue("20")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve state" })).toBeDisabled();
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([approvedServerJob]);
  });

  it("retries a failed authoritative restore for an ordinary cached job", async () => {
    const jobId = "6".repeat(32);
    const cachedJob = jobRecord({
      id: jobId,
      original_filename: "ordinary-restore-retry.png",
      updated_at: "2026-07-10T00:01:00Z",
    });
    const persistedJob: JobRecord = {
      ...cachedJob,
      status: "approved",
      approved_state: canonicalState({ pot_size: 20 }),
      updated_at: "2026-07-10T00:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([cachedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.sessionStorage.removeItem("poker-training-processing-synced");
    fetchMock()
      .mockRejectedValueOnce(new TypeError("Temporary queue restore failure"))
      .mockResolvedValueOnce(processingQueueResponse(
        [persistedJob],
        "ordinary-restore-recovered",
      ));

    render(<App />);

    expect(await screen.findByDisplayValue("20")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve state" })).toBeDisabled();
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedJob]);
  });

  it("retries polling after a pending recommendation restore fails", async () => {
    const jobId = "5".repeat(32);
    const pendingJob = {
      ...approvedJob(),
      id: jobId,
      original_filename: "pending-retry.png",
      recommendation_pending: true,
      updated_at: "2026-07-10T00:01:00Z",
    };
    const completedJob = {
      ...recommendedJob(),
      id: jobId,
      original_filename: "pending-retry.png",
      recommendation_pending: false,
      updated_at: "2026-07-10T00:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([pendingJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(processingQueueResponse(
        [pendingJob],
        "pending-before-transient-failure",
      ))
      .mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValueOnce(processingQueueResponse(
        [completedJob],
        "pending-retry-completed",
      ));

    render(<App />);

    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(3);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([completedJob]);
  });

  it("keeps mutated or pending benchmark imports in the cached processing queue", async () => {
    const decisionImport = {
      ...approvedJob(),
      id: "d".repeat(32),
      original_filename: "decision-import.png",
      parser_result: null,
      benchmark_included: true,
      training_decision: {
        action: "call" as const,
        sizing: null,
        certainty: "medium" as const,
        recorded_at: "2026-07-10T00:01:00Z",
      },
    };
    const failedImport = {
      ...approvedJob(),
      id: "e".repeat(32),
      status: "error" as const,
      original_filename: "failed-import.png",
      parser_result: null,
      benchmark_included: true,
      error: "provider exploded",
    };
    const pristineImport = {
      ...approvedJob(),
      id: "f".repeat(32),
      original_filename: "pristine-import.png",
      parser_result: null,
      benchmark_included: true,
    };
    const pendingImport = {
      ...approvedJob(),
      id: "a".repeat(32),
      original_filename: "pending-import.png",
      parser_result: null,
      benchmark_included: true,
      recommendation_pending: true,
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([
        decisionImport,
        failedImport,
        pristineImport,
        pendingImport,
      ]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "3");
    const pendingQueue = deferredResponse();
    fetchMock().mockReturnValueOnce(pendingQueue.promise);

    render(<App />);

    expect(await screen.findByRole("button", {
      name: "Open screenshot 1: decision-import.png",
    })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Open screenshot 2: failed-import.png",
    })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Open screenshot 3: pending-import.png",
    })).toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: /pristine-import\.png/,
    })).not.toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    );
  });

  it("reconciles malformed processing cache entries from the backend", async () => {
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([{ id: "c".repeat(32) }]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock().mockResolvedValueOnce(jsonResponse({
      total: 0,
      jobs: [],
      snapshot_version: "empty-processing-snapshot",
    }));

    render(<App />);

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    await waitFor(() => expect(window.localStorage.getItem(
      "poker-training-processing-total-v1",
    )).toBe("0"));
    expect(screen.queryByRole("button", {
      name: /Open screenshot/,
    })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(
      "poker-training-processing-v1",
    )).toBe("[]");
  });

  it(
    "rejects a cached processing job without an explicit archive state",
    async () => {
      const cachedJob = jobRecord({
        id: "7".repeat(32),
        original_filename: "missing-archive-state.png",
      });
      const { archived_at: _archivedAt, ...jobWithoutArchiveState } = cachedJob;
      window.localStorage.setItem(
        "poker-training-processing-v1",
        JSON.stringify([jobWithoutArchiveState]),
      );
      window.localStorage.setItem("poker-training-processing-total-v1", "1");
      fetchMock().mockResolvedValueOnce(processingQueueResponse(
        [],
        "missing-archive-state-reconciled",
      ));

      render(<App />);

      await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
        "http://localhost:8000/api/jobs",
        { credentials: "include" },
      ));
      expect(screen.queryByRole("button", {
        name: /missing-archive-state\.png/,
      })).not.toBeInTheDocument();
      expect(window.localStorage.getItem(
        "poker-training-processing-v1",
      )).toBe("[]");
      expect(window.localStorage.getItem(
        "poker-training-processing-total-v1",
      )).toBe("0");
      expect(window.sessionStorage.getItem(
        "poker-training-processing-synced",
      )).toBe("true");
    },
  );

  it.each([
    {
      label: "missing",
      malformedJob: (() => {
        const { benchmark_included: _benchmarkIncluded, ...jobWithoutFlag } = {
          ...approvedJob(),
          id: "9".repeat(32),
          original_filename: "missing-benchmark-flag.png",
          parser_result: null,
          benchmark_included: true,
        };
        return jobWithoutFlag;
      })(),
    },
    {
      label: "non-boolean",
      malformedJob: {
        ...approvedJob(),
        id: "8".repeat(32),
        original_filename: "invalid-benchmark-flag.png",
        parser_result: null,
        benchmark_included: "true",
      },
    },
  ])("rejects a $label cached benchmark flag and restores the backend projection", async ({
    malformedJob,
  }) => {
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([malformedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock().mockResolvedValueOnce(processingQueueResponse(
      [],
      "benchmark-filtered-snapshot",
    ));

    render(<App />);

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    expect(screen.queryByRole("button", {
      name: /benchmark-flag\.png/,
    })).not.toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem(
      "poker-training-processing-v1",
    )).toBe("[]"));
  });

  it("rejects malformed cached cards and restores the backend record", async () => {
    const persistedJob = jobRecord({
      id: "c".repeat(32),
      original_filename: "restored-valid-table.png",
    });
    const malformedJob = {
      ...persistedJob,
      parser_result: {
        ...persistedJob.parser_result,
        state: {
          ...persistedJob.parser_result?.state,
          hero_cards: [null],
        },
      },
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([malformedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock().mockResolvedValueOnce(jsonResponse({
      total: 1,
      jobs: [persistedJob],
      snapshot_version: "valid-processing-snapshot",
    }));

    render(<App />);

    expect(await screen.findByRole("button", {
      name: "Open screenshot 1: restored-valid-table.png",
    })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Ah Kd")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    );
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))[0].parser_result.state.hero_cards).toEqual(detectedState.hero_cards);
  });

  it("rejects malformed cached recommendations and restores the backend record", async () => {
    const persistedJob = {
      ...recommendedJob(),
      id: "d".repeat(32),
      original_filename: "restored-recommendation.png",
    };
    const malformedJob = {
      ...persistedJob,
      recommendation: {},
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([malformedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock().mockResolvedValueOnce(jsonResponse({
      total: 1,
      jobs: [persistedJob],
      snapshot_version: "valid-recommendation-snapshot",
    }));

    render(<App />);

    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(screen.getByText(recommendation.explanation)).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    );
  });

  it.each([
    {
      label: "training decision",
      invalidFields: {
        training_decision: {
          action: {},
          sizing: null,
          certainty: "medium",
          recorded_at: "2026-07-20T12:00:00Z",
        },
      },
    },
    {
      label: "training review note",
      invalidFields: {
        training_review_note: {},
      },
    },
  ])("rejects malformed cached $label and restores the backend record", async ({
    invalidFields,
  }) => {
    const persistedJob = {
      ...recommendedJob(),
      id: "a".repeat(32),
      original_filename: "restored-training-metadata.png",
      training_decision: {
        action: "call" as const,
        sizing: null,
        certainty: "medium" as const,
        recorded_at: "2026-07-20T12:00:00Z",
      },
      training_reviewed_at: "2026-07-20T12:05:00Z",
      training_review_note: "Review the solver comparison.",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([{ ...persistedJob, ...invalidFields }]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock().mockResolvedValueOnce(jsonResponse({
      total: 1,
      jobs: [persistedJob],
      snapshot_version: "valid-training-metadata-snapshot",
    }));

    render(<App />);

    const restoredItem = await screen.findByRole("button", {
      name: "Open screenshot 1: restored-training-metadata.png",
    });
    expect(within(restoredItem).getByText("recommended")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    );
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))[0]).toMatchObject({
      training_decision: persistedJob.training_decision,
      training_reviewed_at: persistedJob.training_reviewed_at,
      training_review_note: persistedJob.training_review_note,
    }));
  });

  it("rejects malformed cached errors and restores the backend record", async () => {
    const persistedJob = jobRecord({
      id: "f".repeat(32),
      original_filename: "restored-error-state.png",
    });
    const malformedJob = {
      ...persistedJob,
      status: "error",
      error: {},
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([malformedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock().mockResolvedValueOnce(jsonResponse({
      total: 1,
      jobs: [persistedJob],
      snapshot_version: "valid-error-snapshot",
    }));

    render(<App />);

    const restoredItem = await screen.findByRole("button", {
      name: "Open screenshot 1: restored-error-state.png",
    });
    expect(within(restoredItem).getByText("parsed")).toBeInTheDocument();
    expect(within(restoredItem).getByText("flop")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    );
  });

  it("keeps unsaved form edits out of the processing cache", async () => {
    const persistedJob = {
      ...recommendedJob(),
      id: "e".repeat(32),
      original_filename: "confirmed-recommendation.png",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([persistedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    const firstRender = render(<App />);
    const user = userEvent.setup();

    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    const potInput = screen.getByLabelText(/Pot/);
    await user.clear(potInput);
    await user.type(potInput, "18");

    expect(screen.queryByLabelText("Recommendation")).not.toBeInTheDocument();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))[0]).toMatchObject({
      status: "recommended",
      approved_state: persistedJob.approved_state,
      recommendation: persistedJob.recommendation,
    });

    firstRender.unmount();
    render(<App />);

    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(screen.getByLabelText(/Pot/)).toHaveValue("12.5");
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("restores persisted processing jobs when the browser cache is unavailable", async () => {
    const persistedJob = jobRecord({
      id: "b".repeat(32),
      original_filename: "persisted-table.png",
    });
    window.localStorage.removeItem("poker-training-processing-v1");
    window.localStorage.removeItem("poker-training-processing-total-v1");
    window.sessionStorage.removeItem("poker-training-processing-synced");
    fetchMock().mockResolvedValueOnce(jsonResponse({
      total: 1,
      jobs: [persistedJob],
      snapshot_version: "processing-snapshot",
    }));

    render(<App />);

    expect(await screen.findByRole("button", {
      name: "Open screenshot 1: persisted-table.png",
    })).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    );
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toHaveLength(1);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
  });

  it("realigns an untouched cached form with the reconciled active job", async () => {
    const cachedJob = jobRecord({
      id: "d".repeat(32),
      original_filename: "reconciled-table.png",
    });
    const reconciledState: DetectedState = {
      ...detectedState,
      hero_cards: [
        { rank: "Q", suit: "clubs" },
        { rank: "Q", suit: "hearts" },
      ],
    };
    const reconciledJob = jobRecord({
      ...cachedJob,
      parser_result: {
        ...cachedJob.parser_result!,
        state: reconciledState,
      },
      updated_at: "2026-07-10T00:01:00Z",
    });
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([cachedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.sessionStorage.removeItem("poker-training-processing-synced");
    const pendingQueue = deferredResponse();
    fetchMock().mockReturnValueOnce(pendingQueue.promise);

    render(<App />);

    expect(await screen.findByDisplayValue("Ah Kd")).toBeInTheDocument();
    pendingQueue.resolve(jsonResponse({
      total: 1,
      jobs: [reconciledJob],
      snapshot_version: "reconciled-snapshot",
    }));

    expect(await screen.findByDisplayValue("Qc Qh")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Ah Kd")).not.toBeInTheDocument();
  });

  it("keeps an approval that completes while queue restoration is pending", async () => {
    const cachedJob = jobRecord({
      id: "a".repeat(32),
      original_filename: "approval-race.png",
    });
    const approved = {
      ...cachedJob,
      status: "approved" as const,
      approved_state: canonicalState(),
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([cachedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.sessionStorage.removeItem("poker-training-processing-synced");
    const pendingQueue = deferredResponse();
    const pendingApproval = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingQueue.promise)
      .mockReturnValueOnce(pendingApproval.promise)
      .mockResolvedValueOnce(processingQueueResponse(
        [approved],
        "approved-after-stale-restore",
      ));
    render(<App />);

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    screen.getByRole("button", { name: "Approve state" }).click();
    await waitFor(() => expect(fetchMock()).toHaveBeenNthCalledWith(
      2,
      `http://localhost:8000/api/jobs/${cachedJob.id}/approve`,
      expect.objectContaining({ method: "POST" }),
    ));

    await act(async () => {
      pendingApproval.resolve(jsonResponse(approved));
      await pendingApproval.promise;
      await Promise.resolve();
      await Promise.resolve();
      pendingQueue.resolve(jsonResponse({
        total: 1,
        jobs: [cachedJob],
        snapshot_version: "stale-processing-snapshot",
      }));
      await pendingQueue.promise;
    });

    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))[0].status).toBe("approved"));
    expect(screen.getByRole("button", { name: "Approve state" })).toBeDisabled();
    expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeEnabled();
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true"));
    expect(fetchMock()).toHaveBeenCalledTimes(3);
  });

  it.each([
    "approval",
    "recommendation",
    "decision",
  ] as const)(
    "reloads backend state when an older restore finishes during an ordinary %s request",
    async (operation) => {
      const jobId = "b".repeat(32);
      const initialJob = operation === "approval"
        ? jobRecord({
            id: jobId,
            original_filename: `pending-${operation}.png`,
          })
        : {
            ...approvedJob(),
            id: jobId,
            original_filename: `pending-${operation}.png`,
          };
      const persistedJob: JobRecord = operation === "approval"
        ? {
            ...initialJob,
            status: "approved",
            approved_state: canonicalState(),
            updated_at: "2026-07-10T00:01:00Z",
          }
        : operation === "recommendation"
          ? {
              ...initialJob,
              status: "recommended",
              recommendation,
              updated_at: "2026-07-10T00:01:00Z",
            }
          : {
              ...initialJob,
              training_decision: {
                action: "call",
                sizing: null,
                certainty: "medium",
                recorded_at: "2026-07-10T00:01:00Z",
              },
              updated_at: "2026-07-10T00:01:00Z",
            };
      window.localStorage.setItem(
        "poker-training-processing-v1",
        JSON.stringify([initialJob]),
      );
      window.localStorage.setItem("poker-training-processing-total-v1", "1");
      window.sessionStorage.removeItem("poker-training-processing-synced");
      const pendingRestore = deferredResponse();
      const pendingMutation = deferredResponse();
      fetchMock()
        .mockReturnValueOnce(pendingRestore.promise)
        .mockReturnValueOnce(pendingMutation.promise)
        .mockResolvedValueOnce(processingQueueResponse(
          [persistedJob],
          `pending-${operation}-snapshot`,
        ));
      const firstRender = render(<App />);
      const user = userEvent.setup();

      await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
        "http://localhost:8000/api/jobs",
        { credentials: "include" },
      ));
      if (operation === "approval") {
        await user.click(screen.getByRole("button", { name: "Approve state" }));
      } else if (operation === "recommendation") {
        await user.click(screen.getByRole("button", {
          name: "Request recommendation",
        }));
      } else {
        const decisionPanel = await screen.findByLabelText("Your training decision");
        await user.click(within(decisionPanel).getByRole("button", { name: "call" }));
        await user.click(within(decisionPanel).getByRole("button", { name: "medium" }));
        await user.click(within(decisionPanel).getByRole("button", { name: "Lock answer" }));
      }

      const mutationPath = operation === "approval"
        ? "approve"
        : operation === "decision"
          ? "decision"
          : "recommend";
      const mutationMethod = operation === "decision" ? "PUT" : "POST";
      await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
        `http://localhost:8000/api/jobs/${jobId}/${mutationPath}`,
        expect.objectContaining({ method: mutationMethod }),
      ));
      await act(async () => {
        pendingRestore.resolve(processingQueueResponse(
          [initialJob],
          `stale-${operation}-snapshot`,
        ));
        await pendingRestore.promise;
      });
      expect(window.sessionStorage.getItem(
        "poker-training-processing-synced",
      )).toBeNull();
      expect(fetchMock()).toHaveBeenCalledTimes(2);

      firstRender.unmount();
      render(<App />);

      await waitFor(() => expect(JSON.parse(String(
        window.localStorage.getItem("poker-training-processing-v1"),
      ))).toEqual([persistedJob]));
      if (operation === "approval") {
        expect(screen.getByRole("button", { name: "Approve state" })).toBeDisabled();
      } else if (operation === "recommendation") {
        expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
      } else {
        expect(await within(screen.getByLabelText(
          "Your training decision",
        )).findByText("Answer locked")).toBeInTheDocument();
      }
      expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
        "http://localhost:8000/api/jobs",
        `http://localhost:8000/api/jobs/${jobId}/${mutationPath}`,
        "http://localhost:8000/api/jobs",
      ]);
    },
  );

  it.each([
    "approval",
    "review",
  ] as const)(
    "reloads archived %s state when an older history restore finishes during the request",
    async (operation) => {
      const jobId = "f".repeat(32);
      const archivedAt = "2026-07-20T12:00:00Z";
      const initialJob = operation === "approval"
        ? jobRecord({
            id: jobId,
            original_filename: `archived-pending-${operation}.png`,
            archived_at: archivedAt,
          })
        : {
            ...recommendedJob(),
            id: jobId,
            original_filename: `archived-pending-${operation}.png`,
            archived_at: archivedAt,
            training_decision: {
              action: "call" as const,
              sizing: null,
              certainty: "medium" as const,
              recorded_at: "2026-07-20T12:01:00Z",
            },
          };
      const persistedJob: JobRecord = operation === "approval"
        ? {
            ...initialJob,
            status: "approved",
            approved_state: canonicalState(),
            updated_at: "2026-07-20T12:02:00Z",
          }
        : {
            ...initialJob,
            training_reviewed_at: "2026-07-20T12:02:00Z",
            updated_at: "2026-07-20T12:02:00Z",
          };
      window.localStorage.setItem(
        "poker-training-history-v1",
        JSON.stringify([{
          id: jobId,
          job: initialJob,
          savedAt: archivedAt,
        }]),
      );
      window.localStorage.setItem("poker-training-history-total-v1", "1");
      window.sessionStorage.removeItem("poker-training-history-synced");
      const pendingHistoryRestore = deferredResponse();
      const pendingMutation = deferredResponse();
      fetchMock()
        .mockReturnValueOnce(pendingHistoryRestore.promise)
        .mockReturnValueOnce(pendingMutation.promise)
        .mockResolvedValueOnce(processingQueueResponse(
          [persistedJob],
          `archived-${operation}-completed`,
        ));
      const firstRender = render(<App />);
      const user = userEvent.setup();

      await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
        "http://localhost:8000/api/history",
        { credentials: "include" },
      ));
      await user.click(screen.getByRole("button", {
        name: "Reopen history item 1",
      }));
      if (operation === "approval") {
        await user.click(screen.getByRole("button", { name: "Approve state" }));
      } else {
        await user.click(within(
          await screen.findByLabelText("Training decision comparison"),
        ).getByRole("button", { name: "Mark reviewed" }));
      }

      const mutationPath = operation === "approval"
        ? "approve"
        : "training-review";
      const mutationMethod = operation === "approval" ? "POST" : "PUT";
      await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
        `http://localhost:8000/api/jobs/${jobId}/${mutationPath}`,
        expect.objectContaining({ method: mutationMethod }),
      ));
      await act(async () => {
        pendingHistoryRestore.resolve(processingQueueResponse(
          [initialJob],
          `stale-archived-${operation}`,
        ));
        await pendingHistoryRestore.promise;
      });
      expect(window.sessionStorage.getItem(
        "poker-training-history-synced",
      )).toBeNull();
      expect(fetchMock()).toHaveBeenCalledTimes(2);

      firstRender.unmount();
      render(<App />);

      await waitFor(() => expect(JSON.parse(String(
        window.localStorage.getItem("poker-training-history-v1"),
      ))[0].job).toEqual(persistedJob));
      await user.click(await screen.findByRole("button", {
        name: "Reopen history item 1",
      }));
      if (operation === "approval") {
        expect(screen.getByRole("button", { name: "Approve state" })).toBeDisabled();
      } else {
        expect(within(await screen.findByLabelText(
          "Training decision comparison",
        )).getByText("Reviewed")).toBeInTheDocument();
      }
      expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
        "http://localhost:8000/api/history",
        `http://localhost:8000/api/jobs/${jobId}/${mutationPath}`,
        "http://localhost:8000/api/history",
      ]);
    },
  );

  it("restores a committed ordinary approval after its response is lost", async () => {
    const parsedJob = jobRecord({
      id: "c".repeat(32),
      original_filename: "approval-response-lost.png",
    });
    const correctedState = canonicalState({ pot_size: 20 });
    const persistedApproval: JobRecord = {
      ...parsedJob,
      status: "approved",
      approved_state: correctedState,
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([parsedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockRejectedValueOnce(new TypeError("Connection lost after approval"))
      .mockResolvedValueOnce(processingQueueResponse(
        [persistedApproval],
        "persisted-approval-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    const potInput = await screen.findByDisplayValue("12.5");
    await user.clear(potInput);
    await user.type(potInput, "20");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    expect(await screen.findByText("Connection lost after approval")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Approve state",
    })).toBeDisabled());
    expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeEnabled();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedApproval]);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    expect(await screen.findByDisplayValue("20")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve state" })).toBeDisabled();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${parsedJob.id}/approve`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("restores a persisted provider error after an ordinary recommendation failure", async () => {
    const approved = {
      ...approvedJob(),
      id: "5".repeat(32),
      original_filename: "ordinary-provider-failure.png",
    };
    const failedJob: JobRecord = {
      ...approved,
      status: "error",
      error: "provider exploded",
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([approved]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ detail: "provider exploded" }, 502))
      .mockResolvedValueOnce(processingQueueResponse(
        [failedJob],
        "ordinary-provider-failure-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", {
      name: "Request recommendation",
    }));

    expect(await screen.findAllByText("provider exploded")).not.toHaveLength(0);
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([failedJob]));
    expect(within(screen.getByRole("button", {
      name: "Open screenshot 1: ordinary-provider-failure.png",
    })).getByText("error")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    expect(await screen.findAllByText("provider exploded")).not.toHaveLength(0);
    expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeEnabled();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${approved.id}/recommend`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("restores an ordinary recommendation after its successful response is lost", async () => {
    const approved = {
      ...approvedJob(),
      id: "6".repeat(32),
      original_filename: "ordinary-recommendation-lost.png",
    };
    const persistedRecommendation: JobRecord = {
      ...approved,
      status: "recommended",
      recommendation,
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([approved]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockRejectedValueOnce(new TypeError("Connection lost after recommendation"))
      .mockResolvedValueOnce(processingQueueResponse(
        [persistedRecommendation],
        "ordinary-recommendation-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", {
      name: "Request recommendation",
    }));

    expect(await screen.findByText("Connection lost after recommendation")).toBeInTheDocument();
    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedRecommendation]));
    expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeDisabled();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(screen.getByText(recommendation.explanation)).toBeInTheDocument();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${approved.id}/recommend`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("restores an ordinary training decision after its response is lost", async () => {
    const approved = {
      ...approvedJob(),
      id: "7".repeat(32),
      original_filename: "ordinary-decision-lost.png",
    };
    const persistedDecision: JobRecord = {
      ...approved,
      training_decision: {
        action: "call",
        sizing: null,
        certainty: "medium",
        recorded_at: "2026-07-10T00:01:00Z",
      },
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([approved]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockRejectedValueOnce(new TypeError("Connection lost after saving answer"))
      .mockResolvedValueOnce(processingQueueResponse(
        [persistedDecision],
        "ordinary-decision-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();
    const decisionPanel = await screen.findByLabelText("Your training decision");

    await user.click(within(decisionPanel).getByRole("button", { name: "call" }));
    await user.click(within(decisionPanel).getByRole("button", { name: "medium" }));
    await user.click(within(decisionPanel).getByRole("button", { name: "Lock answer" }));

    expect(await screen.findByText("Connection lost after saving answer")).toBeInTheDocument();
    expect(await within(screen.getByLabelText(
      "Your training decision",
    )).findByText("Answer locked")).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedDecision]));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    const restoredDecisionPanel = await screen.findByLabelText("Your training decision");
    expect(within(restoredDecisionPanel).getByText("Answer locked")).toBeInTheDocument();
    expect(within(restoredDecisionPanel).getByRole("button", {
      name: "medium",
    })).toHaveAttribute("aria-pressed", "true");
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${approved.id}/decision`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it.each([
    { operation: "approval" as const },
    { operation: "recommendation" as const },
    { operation: "decision" as const },
    { operation: "review" as const },
  ])("restores an archived $operation after its response is lost", async ({
    operation,
  }) => {
    const jobId = "9".repeat(32);
    const archivedAt = "2026-07-20T12:00:00Z";
    const trainingDecision = {
      action: "call" as const,
      sizing: null,
      certainty: "medium" as const,
      recorded_at: "2026-07-20T12:01:00Z",
    };
    const parsedArchivedJob = jobRecord({
      id: jobId,
      original_filename: `archived-${operation}-response-lost.png`,
      image_filename: `${jobId}.png`,
      archived_at: archivedAt,
    });
    const approvedArchivedJob: JobRecord = {
      ...approvedJob(),
      id: jobId,
      original_filename: parsedArchivedJob.original_filename,
      image_filename: `${jobId}.png`,
      archived_at: archivedAt,
    };
    const reviewedArchivedJob: JobRecord = {
      ...recommendedJob(),
      id: jobId,
      original_filename: parsedArchivedJob.original_filename,
      image_filename: `${jobId}.png`,
      training_decision: trainingDecision,
      archived_at: archivedAt,
    };
    let initialJob: JobRecord;
    let persistedJob: JobRecord;
    if (operation === "approval") {
      initialJob = parsedArchivedJob;
      persistedJob = {
        ...parsedArchivedJob,
        status: "approved",
        approved_state: canonicalState({ pot_size: 20 }),
        updated_at: "2026-07-20T12:10:00Z",
      };
    } else if (operation === "recommendation") {
      initialJob = approvedArchivedJob;
      persistedJob = {
        ...approvedArchivedJob,
        status: "recommended",
        recommendation,
        updated_at: "2026-07-20T12:10:00Z",
      };
    } else if (operation === "decision") {
      initialJob = approvedArchivedJob;
      persistedJob = {
        ...approvedArchivedJob,
        training_decision: trainingDecision,
        updated_at: "2026-07-20T12:10:00Z",
      };
    } else {
      initialJob = reviewedArchivedJob;
      persistedJob = {
        ...reviewedArchivedJob,
        training_reviewed_at: "2026-07-20T12:10:00Z",
        training_review_note: "Persisted archived lesson.",
        updated_at: "2026-07-20T12:10:00Z",
      };
    }
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{ id: jobId, job: initialJob, savedAt: archivedAt }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    fetchMock()
      .mockRejectedValueOnce(new TypeError(`Connection lost after archived ${operation}`))
      .mockResolvedValueOnce(jsonResponse(persistedJob));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", {
      name: "Reopen history item 1",
    }));
    if (operation === "approval") {
      const potInput = await screen.findByDisplayValue("12.5");
      await user.clear(potInput);
      await user.type(potInput, "20");
      await user.click(screen.getByRole("button", { name: "Approve state" }));
    } else if (operation === "recommendation") {
      await user.click(screen.getByRole("button", {
        name: "Request recommendation",
      }));
    } else if (operation === "decision") {
      const decisionPanel = await screen.findByLabelText("Your training decision");
      await user.click(within(decisionPanel).getByRole("button", { name: "call" }));
      await user.click(within(decisionPanel).getByRole("button", { name: "medium" }));
      await user.click(within(decisionPanel).getByRole("button", { name: "Lock answer" }));
    } else {
      const comparison = await screen.findByLabelText("Training decision comparison");
      await user.type(
        screen.getByLabelText("Training review note"),
        "Persisted archived lesson.",
      );
      await user.click(within(comparison).getByRole("button", {
        name: "Mark reviewed",
      }));
    }

    expect(await screen.findByText(
      `Connection lost after archived ${operation}`,
    )).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-history-v1"),
    ))[0].job).toEqual(persistedJob));
    expect(window.sessionStorage.getItem(
      "poker-training-history-synced",
    )).toBe("true");
    if (operation === "approval") {
      expect(await screen.findByDisplayValue("20")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Approve state" })).toBeDisabled();
    } else if (operation === "recommendation") {
      expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    } else if (operation === "decision") {
      expect(await within(screen.getByLabelText(
        "Your training decision",
      )).findByText("Answer locked")).toBeInTheDocument();
    } else {
      const comparison = await screen.findByLabelText("Training decision comparison");
      expect(within(comparison).getByText("Reviewed")).toBeInTheDocument();
      expect(screen.getByLabelText("Saved training review note")).toHaveTextContent(
        "Persisted archived lesson.",
      );
    }

    firstRender.unmount();
    render(<App />);
    await user.click(await screen.findByRole("button", {
      name: "Reopen history item 1",
    }));

    if (operation === "approval") {
      expect(await screen.findByDisplayValue("20")).toBeInTheDocument();
    } else if (operation === "recommendation") {
      expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    } else if (operation === "decision") {
      expect(await within(screen.getByLabelText(
        "Your training decision",
      )).findByText("Answer locked")).toBeInTheDocument();
    } else {
      expect(await screen.findByLabelText(
        "Saved training review note",
      )).toHaveTextContent("Persisted archived lesson.");
    }
    const mutationPath = operation === "approval"
      ? "approve"
      : operation === "decision"
        ? "decision"
        : operation === "review"
          ? "training-review"
          : "recommend";
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${jobId}/${mutationPath}`,
      `http://localhost:8000/api/jobs/${jobId}`,
    ]);
  });

  it("preserves ordinary approval edits when the failed write did not commit", async () => {
    const parsedJob = jobRecord({
      id: "d".repeat(32),
      original_filename: "approval-not-committed.png",
    });
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([parsedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockRejectedValueOnce(new TypeError("Approval request failed"))
      .mockResolvedValueOnce(processingQueueResponse(
        [parsedJob],
        "unchanged-approval-snapshot",
      ));
    render(<App />);
    const user = userEvent.setup();

    const potInput = await screen.findByDisplayValue("12.5");
    await user.clear(potInput);
    await user.type(potInput, "20");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    expect(await screen.findByText("Approval request failed")).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true"));
    expect(potInput).toHaveValue("20");
    expect(screen.getByRole("button", { name: "Approve state" })).toBeEnabled();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([parsedJob]);
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${parsedJob.id}/approve`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("preserves a dirty form while its active job is reconciled", async () => {
    const cachedJob = jobRecord({
      id: "e".repeat(32),
      original_filename: "edited-table.png",
    });
    const reconciledState: DetectedState = {
      ...detectedState,
      hero_cards: [
        { rank: "Q", suit: "clubs" },
        { rank: "Q", suit: "hearts" },
      ],
    };
    const reconciledJob = jobRecord({
      ...cachedJob,
      parser_result: {
        ...cachedJob.parser_result!,
        state: reconciledState,
      },
      updated_at: "2026-07-10T00:01:00Z",
    });
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([cachedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.sessionStorage.removeItem("poker-training-processing-synced");
    const pendingQueue = deferredResponse();
    fetchMock().mockReturnValueOnce(pendingQueue.promise);
    render(<App />);
    const user = userEvent.setup();
    const heroCards = await screen.findByLabelText(/Hero cards/);

    await user.clear(heroCards);
    await user.type(heroCards, "7d Ah");
    pendingQueue.resolve(jsonResponse({
      total: 1,
      jobs: [reconciledJob],
      snapshot_version: "reconciled-snapshot",
    }));

    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))[0].updated_at).toBe("2026-07-10T00:01:00Z"));
    expect(heroCards).toHaveValue("7d Ah");
    expect(screen.queryByDisplayValue("Qc Qh")).not.toBeInTheDocument();
  });

  it("keeps a dirty cached job selected when reconciliation removes it", async () => {
    const cachedJob = jobRecord({
      id: "f".repeat(32),
      original_filename: "dirty-cached-table.png",
    });
    const incomingJob = jobRecord({
      id: "1".repeat(32),
      original_filename: "different-table.png",
    });
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([cachedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.sessionStorage.removeItem("poker-training-processing-synced");
    const pendingQueue = deferredResponse();
    fetchMock().mockReturnValueOnce(pendingQueue.promise);
    render(<App />);
    const user = userEvent.setup();
    const heroCards = await screen.findByLabelText(/Hero cards/);

    await user.clear(heroCards);
    await user.type(heroCards, "7d Ah");
    pendingQueue.resolve(jsonResponse({
      total: 1,
      jobs: [incomingJob],
      snapshot_version: "replacement-snapshot",
    }));

    expect(await screen.findByRole("button", {
      name: "Open screenshot 2: different-table.png",
    })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Open screenshot 1: dirty-cached-table.png",
    })).toHaveClass("active");
    expect(heroCards).toHaveValue("7d Ah");
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBeNull();
  });

  it("ignores a stale restore after cached jobs move to history", async () => {
    const staleJob: JobRecord = {
      ...recommendedJob(),
      id: "2".repeat(32),
      original_filename: "stale-processing.png",
      archived_at: null,
    };
    const archivedJob: JobRecord = {
      ...staleJob,
      archived_at: "2026-07-10T00:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([staleJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.sessionStorage.removeItem("poker-training-processing-synced");
    const pendingRestore = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingRestore.promise)
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [archivedJob],
        snapshot_version: "archived-snapshot",
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 0,
        jobs: [],
        snapshot_version: "fresh-processing-snapshot",
      }));
    render(<App />);
    const user = userEvent.setup();

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    await user.click(screen.getByRole("button", { name: "Clear reviewed" }));
    expect(await screen.findByRole("button", {
      name: "Reopen history item 1",
    })).toBeInTheDocument();

    await act(async () => {
      pendingRestore.resolve(jsonResponse({
        total: 1,
        jobs: [staleJob],
        snapshot_version: "stale-processing-snapshot",
      }));
      await pendingRestore.promise;
    });

    await waitFor(() => expect(fetchMock()).toHaveBeenNthCalledWith(
      3,
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: stale-processing.png",
    })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(
      "poker-training-processing-v1",
    )).toBe("[]");
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
  });

  it("reconciles queues larger than the bounded browser cache", async () => {
    const persistedJobs = Array.from({ length: 101 }, (_, index) => jobRecord({
      id: index.toString(16).padStart(32, "0"),
      original_filename: `persisted-${index + 1}.png`,
    }));
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify(persistedJobs.slice(0, 100)),
    );
    window.localStorage.setItem(
      "poker-training-processing-total-v1",
      String(persistedJobs.length),
    );
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        total: persistedJobs.length,
        jobs: persistedJobs.slice(0, 100),
        snapshot_version: "processing-snapshot",
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: persistedJobs.length,
        jobs: persistedJobs.slice(100),
        snapshot_version: "processing-snapshot",
      }));

    render(<App />);

    expect(await screen.findByRole("button", {
      name: "Open screenshot 101: persisted-101.png",
    })).toBeInTheDocument();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/jobs",
      "http://localhost:8000/api/jobs?offset=100",
    ]);
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toHaveLength(100);
    expect(window.localStorage.getItem(
      "poker-training-processing-total-v1",
    )).toBe("101");
  });

  it("preserves the known complete count while queue reconciliation is pending", async () => {
    const persistedJobs = Array.from({ length: 101 }, (_, index) => jobRecord({
      id: index.toString(16).padStart(32, "0"),
      original_filename: `persisted-${index + 1}.png`,
    }));
    const approved = {
      ...persistedJobs[0],
      status: "approved" as const,
      approved_state: canonicalState(),
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify(persistedJobs.slice(0, 100)),
    );
    window.localStorage.setItem(
      "poker-training-processing-total-v1",
      String(persistedJobs.length),
    );
    const pendingQueue = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingQueue.promise)
      .mockResolvedValueOnce(jsonResponse(approved));
    render(<App />);
    const user = userEvent.setup();

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    const approveButton = screen.getByRole("button", { name: "Approve state" });
    await waitFor(() => expect(approveButton).toBeEnabled());
    await user.click(approveButton);

    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))[0].status).toBe("approved"));
    expect(window.localStorage.getItem(
      "poker-training-processing-total-v1",
    )).toBe("101");
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBeNull();
  });

  it.each([
    {
      label: "persisted parser failure",
      filename: "parse-failed.png",
      status: "error" as const,
      persistedError: "Image could not be parsed",
      localError: "Image could not be parsed",
      responseLost: false,
    },
    {
      label: "persisted successful upload",
      filename: "parsed-response-lost.png",
      status: "parsed" as const,
      persistedError: null,
      localError: "Connection lost after upload",
      responseLost: true,
    },
  ])("replaces a local placeholder with the $label during queue reconciliation", async ({
    filename,
    localError,
    persistedError,
    responseLost,
    status,
  }) => {
    window.sessionStorage.removeItem("poker-training-processing-synced");
    const pendingQueue = deferredResponse();
    const failedAt = new Date().toISOString();
    const persistedJob = jobRecord({
      id: "9".repeat(32),
      status,
      original_filename: filename,
      parser_result: status === "error" ? null : jobRecord().parser_result,
      error: persistedError,
      created_at: failedAt,
      updated_at: failedAt,
    });
    fetchMock().mockReturnValueOnce(pendingQueue.promise);
    if (responseLost) {
      fetchMock().mockRejectedValueOnce(new TypeError(localError));
    } else {
      fetchMock().mockResolvedValueOnce(jsonResponse({
        detail: localError,
      }, 502));
    }
    fetchMock().mockResolvedValueOnce(jsonResponse({
      total: 1,
      jobs: [persistedJob],
      snapshot_version: "restored-upload",
    }));
    render(<App />);
    const user = userEvent.setup();

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    await disableAutomation(user);
    await switchToUploadMode(user);
    await user.upload(
      screen.getByLabelText("Choose screenshots"),
      new File(["upload"], filename, { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getAllByRole("button", {
      name: new RegExp(`Open screenshot \\d+: ${filename.replace(".", "\\.")}`),
    })).toHaveLength(1));
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedJob]);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    await act(async () => {
      pendingQueue.resolve(jsonResponse({
        total: 0,
        jobs: [],
        snapshot_version: "stale-empty-snapshot",
      }));
    });
  });

  it("reconciles a lost upload response after an already-synced mount", async () => {
    const persistedAt = new Date().toISOString();
    const persistedJob = jobRecord({
      id: "8".repeat(32),
      original_filename: "lost-after-sync.png",
      created_at: persistedAt,
      updated_at: persistedAt,
    });
    fetchMock()
      .mockRejectedValueOnce(new TypeError("Connection lost after upload"))
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [persistedJob],
        snapshot_version: "post-mutation-snapshot",
      }));
    render(<App />);
    const user = userEvent.setup();

    expect(fetchMock()).not.toHaveBeenCalled();
    await disableAutomation(user);
    await switchToUploadMode(user);
    await user.upload(
      screen.getByLabelText("Choose screenshots"),
      new File(["upload"], "lost-after-sync.png", { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByRole("button", {
      name: /Open screenshot \d+: lost-after-sync\.png/,
    })).toHaveLength(1));
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedJob]);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
  });

  it("renders live capture first and exposes upload mode", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        status: "ok",
        parser_provider: "ocr_cv",
        recommendation_provider: "local_solver",
        recommendation_engine: "postflop_solver",
      }),
    );
    render(<App />);
    const user = userEvent.setup();

    expect(screen.getByRole("heading", { name: "Poker Training Analyzer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share window" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Automation On" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Screenshots queue")).toBeInTheDocument();
    expect(screen.getByText("No screenshots uploaded or captured yet")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "About this app" }));
    expect(screen.getByRole("dialog", { name: "About Poker Training Analyzer" })).toBeInTheDocument();
    expect(await screen.findByText("OCR + computer vision")).toBeInTheDocument();
    expect(screen.getByText("Postflop solver")).toBeInTheDocument();
    expect(screen.getByText(/OCR and computer vision read the cards/)).toBeInTheDocument();
    expect(screen.getByText(/Preflop uses a position-aware training chart/i)).toBeInTheDocument();
    expect(fetchMock().mock.calls[0][0]).toBe("http://localhost:8000/api/health");
    await user.click(screen.getByRole("button", { name: "Close app information" }));
    expect(screen.queryByRole("dialog", { name: "About Poker Training Analyzer" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Configure automation" }));
    expect(screen.getByRole("dialog", { name: "Configure automation" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Auto-approve parsed state/ })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Done" }));

    await switchToUploadMode(user);

    expect(screen.getByRole("button", { name: "Upload and parse" })).toBeDisabled();
    expect(screen.getByText("Choose screenshots to add them to the queue.")).toBeInTheDocument();
  });

  it("restores automation settings across reloads", async () => {
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Automation On" }));
    await user.click(screen.getByRole("button", { name: "Configure automation" }));
    await user.click(screen.getByRole("switch", {
      name: /Auto-request recommendation/,
    }));
    await user.click(screen.getByRole("switch", {
      name: /Allow parser warnings/,
    }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    firstRender.unmount();

    render(<App />);

    expect(screen.getByRole("button", { name: "Automation Off" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.click(screen.getByRole("button", { name: "Configure automation" }));
    expect(screen.getByRole("switch", {
      name: /Auto-approve parsed state/,
    })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", {
      name: /Auto-request recommendation/,
    })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", {
      name: /Allow parser warnings/,
    })).toHaveAttribute("aria-checked", "true");
  });

  it("uses safe automation defaults when saved settings are malformed", () => {
    window.localStorage.setItem(
      "poker-training-automation-v1",
      JSON.stringify({
        enabled: "yes",
        autoApprove: true,
        autoRecommend: true,
        allowWarnings: false,
      }),
    );

    render(<App />);

    expect(screen.getByRole("button", { name: "Automation On" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("uploads a screenshot, populates parser state, and enables approval", async () => {
    const created = jobRecord();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]));
    render(<App />);

    const user = await uploadScreenshot();

    expect(await screen.findByDisplayValue("Ah Kd")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Qs Jc 2h")).toBeInTheDocument();
    expect(screen.getByDisplayValue("12.5")).toBeInTheDocument();
    expect(screen.getByLabelText(/Facing action/)).toHaveValue("bet");
    expect(screen.getByRole("button", { name: "Approve state" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Request recommendation" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "About this app" }));
    expect(screen.getAllByText("Demo engine")).toHaveLength(2);
  });

  it("re-approves corrections to an approved-only imported job", async () => {
    const importedJob = {
      ...approvedJob(),
      id: "imported-job",
      original_filename: "imported.png",
      parser_result: null,
      benchmark_included: true,
    };
    const correctedState = canonicalState({ pot_size: 20 });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(importedJob, 201))
      .mockResolvedValueOnce(processingQueueResponse([importedJob]))
      .mockResolvedValueOnce(jsonResponse({ ...importedJob, approved_state: correctedState }));
    render(<App />);

    const user = await uploadScreenshot("imported.png");
    expect(await screen.findByDisplayValue("12.5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve state" })).toBeDisabled();

    const potInput = screen.getByDisplayValue("12.5");
    await user.clear(potInput);
    await user.type(potInput, "20");

    const approveButton = screen.getByRole("button", { name: "Approve state" });
    expect(approveButton).toBeEnabled();
    await user.click(approveButton);

    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/jobs/imported-job/approve");
    const payload = JSON.parse(String(fetchMock().mock.calls[2][1]?.body));
    expect(payload.pot_size).toBe(20);
    expect(payload.user_approved).toBe(true);
  });

  it("uploads multiple screenshots and switches between parsed jobs", async () => {
    const secondState: DetectedState = {
      ...detectedState,
      hero_cards: [
        { rank: "7", suit: "diamonds" },
        { rank: "A", suit: "hearts" },
      ],
      board_cards: [],
      pot_size: 3.5,
      current_bet: 1.5,
      hero_stack: 100.4,
      effective_stack: 100.4,
      players_in_hand: 2,
      street: "preflop",
      action_context: "Hero faces 1.5 BB to call into 3.5 BB pot",
    };
    const firstJob = jobRecord({ id: "job-1", original_filename: "first.png" });
    const secondJob = jobRecord({
      id: "job-2",
      original_filename: "second.png",
      parser_result: {
        state: secondState,
        confidences: { hero_cards: 0.91, street: 0.9 },
        warnings: [],
        raw: {},
      },
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(firstJob, 201))
      .mockResolvedValueOnce(jsonResponse(secondJob, 201))
      .mockResolvedValueOnce(processingQueueResponse([firstJob, secondJob]));
    render(<App />);
    const user = userEvent.setup();
    await disableAutomation(user);
    await switchToUploadMode(user);
    const input = screen.getByLabelText("Choose screenshots");

    await user.upload(input, [
      new File(["first"], "first.png", { type: "image/png" }),
      new File(["second"], "second.png", { type: "image/png" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));

    expect(await screen.findByLabelText("Screenshots queue")).toBeInTheDocument();
    expect(screen.getByText("2 screenshots")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Ah Kd")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(3);

    await user.click(screen.getByRole("button", { name: "Open screenshot 2: second.png" }));

    expect(screen.getByDisplayValue("7d Ah")).toBeInTheDocument();
    expect(screen.getByDisplayValue("3.5")).toBeInTheDocument();
    expect(screen.getByLabelText(/Street/)).toHaveValue("preflop");
  });

  it("continues a batch upload when one screenshot fails", async () => {
    const firstJob = jobRecord({ id: "job-1", original_filename: "first.png" });
    const thirdJob = jobRecord({ id: "job-3", original_filename: "third.png" });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(firstJob, 201))
      .mockResolvedValueOnce(jsonResponse({ detail: "Second image is unreadable" }, 400))
      .mockResolvedValueOnce(jsonResponse(thirdJob, 201))
      .mockResolvedValueOnce(processingQueueResponse([firstJob, thirdJob]));
    render(<App />);
    const user = userEvent.setup();
    await disableAutomation(user);
    await switchToUploadMode(user);

    await user.upload(screen.getByLabelText("Choose screenshots"), [
      new File(["first"], "first.png", { type: "image/png" }),
      new File(["second"], "second.png", { type: "image/png" }),
      new File(["third"], "third.png", { type: "image/png" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));

    expect(await screen.findByRole("button", {
      name: /Open screenshot \d+: third\.png/,
    })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: /Open screenshot \d+: first\.png/,
    })).toBeInTheDocument();
    const failedItem = screen.getByRole("button", {
      name: /Open screenshot \d+: second\.png/,
    });
    expect(within(failedItem).getByText("error")).toBeInTheDocument();
    expect(within(failedItem).getByText("Second image is unreadable")).toBeInTheDocument();
    expect(await screen.findByText("1 screenshot need attention. Check the highlighted queue items.")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(4);
  });

  it("shows processing progress and aborts unprocessed screenshots", async () => {
    fetchMock().mockImplementation((url, options) => {
      if (url === "http://localhost:8000/api/jobs" && options?.method !== "POST") {
        return Promise.resolve(processingQueueResponse([]));
      }
      const signal = options?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    render(<App />);
    const user = userEvent.setup();

    await switchToUploadMode(user);
    await user.upload(screen.getByLabelText("Choose screenshots"), [
      new File(["first"], "first.png", { type: "image/png" }),
      new File(["second"], "second.png", { type: "image/png" }),
      new File(["third"], "third.png", { type: "image/png" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));

    expect(await screen.findByRole("dialog", { name: "Processing queue" })).toBeInTheDocument();
    expect(screen.getByText("first.png")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Abort and discard unprocessed" }));

    expect(await screen.findByText("Import aborted. 3 unprocessed screenshots discarded.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Stopping import" })).not.toBeInTheDocument());
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(screen.getByText("No screenshots uploaded or captured yet")).toBeInTheDocument();
  });

  it("reports when screen sharing is not available", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Share window" }));

    expect(await screen.findByText("Screen sharing is not supported in this browser")).toBeInTheDocument();
  });

  it("captures a shared screen frame and uploads it for parsing", async () => {
    const { addEventListener, getDisplayMedia } = stubDisplayMedia("browser");
    stubCanvasCapture();
    const created = jobRecord({ original_filename: "screen-capture.png" });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]));
    render(<App />);
    const user = userEvent.setup();
    await disableAutomation(user);

    await user.click(screen.getByRole("button", { name: "Tab" }));
    await user.click(screen.getByRole("button", { name: "Share tab" }));
    expect(await screen.findByText("Tab sharing active")).toBeInTheDocument();
    expect(screen.getByLabelText("Shared screen preview")).toHaveClass("active");
    setSharedPreviewSize();

    await user.click(screen.getByRole("button", { name: "Capture and parse" }));

    expect(await screen.findByDisplayValue("Ah Kd")).toBeInTheDocument();
    expect(screen.getByAltText("Uploaded poker table screenshot")).not.toHaveClass("hidden");
    expect(screen.getByLabelText("Shared screen preview")).not.toHaveClass("active");
    expect(screen.getByRole("button", { name: "View live tab" })).toBeEnabled();
    expect(screen.getByLabelText("Screenshots queue")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open screenshot 1: screen-capture.png" })).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(getDisplayMedia).toHaveBeenCalledWith({
      audio: false,
      monitorTypeSurfaces: "exclude",
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      video: { frameRate: 8, displaySurface: "browser" },
    });
    expect(addEventListener).toHaveBeenCalledWith("ended", expect.any(Function));

    await user.click(screen.getByRole("button", { name: "View live tab" }));
    expect(screen.getByLabelText("Shared screen preview")).toHaveClass("active");
    expect(screen.getByAltText("Uploaded poker table screenshot")).toHaveClass("hidden");
  });

  it("runs capture, approval, and recommendation through automation", async () => {
    stubDisplayMedia("window");
    stubCanvasCapture();
    const created = jobRecord({ original_filename: "screen-capture.png" });
    const approved = { ...approvedJob(), original_filename: "screen-capture.png" };
    const recommended = { ...recommendedJob(), original_filename: "screen-capture.png" };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(jsonResponse(approved))
      .mockResolvedValueOnce(jsonResponse(recommended))
      .mockResolvedValueOnce(processingQueueResponse([recommended]))
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [{
          ...recommended,
          archived_at: "2026-07-10T00:01:00Z",
        }],
      }))
      .mockResolvedValueOnce(processingQueueResponse([]));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Share window" }));
    expect(await screen.findByText("Window sharing active")).toBeInTheDocument();
    setSharedPreviewSize();

    await user.click(screen.getByRole("button", { name: "Capture and parse" }));

    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve state" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request recommendation" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open screenshot 1: screen-capture.png" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reopen history item 1" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear reviewed" }));

    const historyItem = await screen.findByRole("button", { name: "Reopen history item 1" });
    expect(within(historyItem).getByText("raise")).toBeInTheDocument();
    expect(within(historyItem).getByText("A♥")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open screenshot 1: screen-capture.png" })).not.toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(6);
    expect(fetchMock().mock.calls[0][0]).toBe("http://localhost:8000/api/jobs");
    expect(fetchMock().mock.calls[1][0]).toBe("http://localhost:8000/api/jobs/job-123/approve");
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/jobs/job-123/recommend");
    expect(fetchMock().mock.calls[3][0]).toBe("http://localhost:8000/api/jobs");
    expect(fetchMock().mock.calls[4][0]).toBe("http://localhost:8000/api/history");
    expect(fetchMock().mock.calls[4][1]?.method).toBe("PUT");
    expect(fetchMock().mock.calls[5][0]).toBe("http://localhost:8000/api/jobs");
    expect(JSON.parse(String(fetchMock().mock.calls[4][1]?.body))).toEqual({
      job_ids: ["job-123"],
    });
    expect(JSON.parse(String(fetchMock().mock.calls[1][1]?.body)).user_approved).toBe(true);
  });

  it("runs upload, approval, and recommendation through automation", async () => {
    const created = jobRecord({ original_filename: "uploaded.png" });
    const approved = { ...approvedJob(), original_filename: "uploaded.png" };
    const recommended = { ...recommendedJob(), original_filename: "uploaded.png" };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(jsonResponse(approved))
      .mockResolvedValueOnce(jsonResponse(recommended))
      .mockResolvedValueOnce(processingQueueResponse([recommended]))
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [{
          ...recommended,
          archived_at: "2026-07-10T00:01:00Z",
        }],
      }))
      .mockResolvedValueOnce(processingQueueResponse([]));
    render(<App />);
    const user = userEvent.setup();

    await switchToUploadMode(user);
    await user.upload(screen.getByLabelText("Choose screenshots"), new File(["uploaded"], "uploaded.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));

    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open screenshot 1: uploaded.png" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reopen history item 1" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear reviewed" }));

    expect(await screen.findByRole("button", { name: "Reopen history item 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open screenshot 1: uploaded.png" })).not.toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(6);
    expect(fetchMock().mock.calls[0][0]).toBe("http://localhost:8000/api/jobs");
    expect(fetchMock().mock.calls[1][0]).toBe("http://localhost:8000/api/jobs/job-123/approve");
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/jobs/job-123/recommend");
    expect(fetchMock().mock.calls[3][0]).toBe("http://localhost:8000/api/jobs");
    expect(fetchMock().mock.calls[4][0]).toBe("http://localhost:8000/api/history");
    expect(fetchMock().mock.calls[5][0]).toBe("http://localhost:8000/api/jobs");
  });

  it("retains server approval when upload recommendation automation fails", async () => {
    const jobId = "f".repeat(32);
    const created = jobRecord({
      id: jobId,
      original_filename: "recommendation-failed.png",
    });
    const approved = {
      ...approvedJob(),
      id: jobId,
      original_filename: "recommendation-failed.png",
      updated_at: "2026-07-10T00:01:00Z",
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(jsonResponse(approved))
      .mockResolvedValueOnce(jsonResponse({ detail: "Solver unavailable" }, 502))
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [approved],
        snapshot_version: "approved-processing-snapshot",
      }));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await switchToUploadMode(user);
    await user.upload(
      screen.getByLabelText("Choose screenshots"),
      new File(["failed"], "recommendation-failed.png", { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));

    const attentionItem = await screen.findByRole("button", {
      name: "Open screenshot 1: recommendation-failed.png",
    });
    expect(within(attentionItem).getByText("approved")).toBeInTheDocument();
    expect(within(attentionItem).getByText("Solver unavailable")).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))[0]).toMatchObject({
      status: "approved",
      approved_state: approved.approved_state,
      error: null,
      updated_at: approved.updated_at,
    }));

    firstRender.unmount();
    render(<App />);

    const restoredItem = await screen.findByRole("button", {
      name: "Open screenshot 1: recommendation-failed.png",
    });
    expect(within(restoredItem).getByText("approved")).toBeInTheDocument();
    expect(within(restoredItem).queryByText("Solver unavailable")).not.toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeEnabled();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
  });

  it("clears upload attention after reconciliation restores a completed recommendation", async () => {
    const jobId = "3".repeat(32);
    const created = jobRecord({
      id: jobId,
      original_filename: "recommendation-response-lost.png",
    });
    const approved = {
      ...approvedJob(),
      id: jobId,
      original_filename: "recommendation-response-lost.png",
      updated_at: "2026-07-10T00:01:00Z",
    };
    const persistedRecommendation = {
      ...recommendedJob(),
      id: jobId,
      original_filename: "recommendation-response-lost.png",
      updated_at: "2026-07-10T00:02:00Z",
    };
    const pendingQueue = deferredResponse();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(jsonResponse(approved))
      .mockRejectedValueOnce(new TypeError("Connection lost after recommendation"))
      .mockReturnValueOnce(pendingQueue.promise);
    render(<App />);
    const user = userEvent.setup();

    await switchToUploadMode(user);
    await user.upload(
      screen.getByLabelText("Choose screenshots"),
      new File(["lost-response"], "recommendation-response-lost.png", {
        type: "image/png",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));

    const attentionItem = await screen.findByRole("button", {
      name: "Open screenshot 1: recommendation-response-lost.png",
    });
    expect(attentionItem).toHaveClass("attention");
    expect(within(attentionItem).getByText(
      "Connection lost after recommendation",
    )).toBeInTheDocument();

    await act(async () => {
      pendingQueue.resolve(processingQueueResponse(
        [persistedRecommendation],
        "persisted-automation-recommendation",
      ));
      await pendingQueue.promise;
    });

    await waitFor(() => expect(within(attentionItem).getByText(
      "recommended",
    )).toBeInTheDocument());
    expect(attentionItem).not.toHaveClass("attention");
    expect(within(attentionItem).queryByText(
      "Connection lost after recommendation",
    )).not.toBeInTheDocument();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedRecommendation]);
  });

  it("invalidates an older history restore while clearing reviewed jobs", async () => {
    const readyJob: JobRecord = {
      ...recommendedJob(),
      id: "7".repeat(32),
      original_filename: "archive-history-race.png",
      updated_at: "2026-07-10T00:01:00Z",
    };
    const archivedJob: JobRecord = {
      ...readyJob,
      archived_at: "2026-07-10T00:02:00Z",
      updated_at: "2026-07-10T00:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([readyJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    const pendingHistoryRestore = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingHistoryRestore.promise)
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [archivedJob],
        snapshot_version: "archive-response",
      }))
      .mockResolvedValueOnce(processingQueueResponse(
        [],
        "archive-processing-empty",
      ))
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [archivedJob],
        snapshot_version: "archive-history-reconciled",
      }));
    render(<App />);

    const refreshButton = screen.getByRole("button", {
      name: "Refresh saved history",
    });
    const clearButton = screen.getByRole("button", { name: "Clear reviewed" });
    act(() => {
      refreshButton.click();
      clearButton.click();
    });
    expect(await screen.findByRole("button", {
      name: "Reopen history item 1",
    })).toBeInTheDocument();

    await act(async () => {
      pendingHistoryRestore.resolve(jsonResponse({
        total: 0,
        jobs: [],
        snapshot_version: "stale-pre-archive-history",
      }));
      await pendingHistoryRestore.promise;
    });

    await waitFor(() => expect(fetchMock()).toHaveBeenNthCalledWith(
      4,
      "http://localhost:8000/api/history",
      { credentials: "include" },
    ));
    expect(screen.getByRole("button", {
      name: "Reopen history item 1",
    })).toBeInTheDocument();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-history-v1"),
    ))[0].job).toEqual(archivedJob);
    expect(window.sessionStorage.getItem(
      "poker-training-history-synced",
    )).toBe("true");
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/history",
      "http://localhost:8000/api/history",
      "http://localhost:8000/api/jobs",
      "http://localhost:8000/api/history",
    ]);
    expect(fetchMock().mock.calls[1][1]?.method).toBe("PUT");
  });

  it("keeps completed jobs in processing when history persistence fails", async () => {
    const created = jobRecord({ original_filename: "retry.png" });
    const approved = { ...approvedJob(), original_filename: "retry.png" };
    const recommended = { ...recommendedJob(), original_filename: "retry.png" };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(jsonResponse(approved))
      .mockResolvedValueOnce(jsonResponse(recommended))
      .mockResolvedValueOnce(processingQueueResponse([recommended]))
      .mockResolvedValueOnce(jsonResponse({ detail: "History storage is unavailable" }, 500))
      .mockResolvedValueOnce(jsonResponse({ detail: "History storage is unavailable" }, 500))
      .mockResolvedValueOnce(processingQueueResponse([recommended]));
    render(<App />);
    const user = userEvent.setup();

    await switchToUploadMode(user);
    await user.upload(
      screen.getByLabelText("Choose screenshots"),
      new File(["retry"], "retry.png", { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));
    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear reviewed" }));

    expect(await screen.findByText("History storage is unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Open screenshot 1: retry.png",
    })).toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: "Reopen history item 1",
    })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem("poker-training-history-synced")).toBeNull();
  });

  it("refreshes history when a later archive batch fails", async () => {
    window.sessionStorage.removeItem("poker-training-processing-synced");
    const readyJobs = Array.from({ length: 101 }, (_, index) => ({
      ...recommendedJob(),
      id: index.toString(16).padStart(32, "0"),
      original_filename: `partial-archive-${index + 1}.png`,
    }));
    const archivedJobs = readyJobs.slice(0, 100).map((job) => ({
      ...job,
      archived_at: "2026-07-10T00:02:00Z",
    }));
    const firstHistoryPage = {
      total: 100,
      jobs: archivedJobs.slice(0, 24),
      snapshot_version: "partial-history-snapshot",
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        total: 101,
        jobs: readyJobs.slice(0, 100),
        snapshot_version: "ready-processing-snapshot",
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 101,
        jobs: readyJobs.slice(100),
        snapshot_version: "ready-processing-snapshot",
      }))
      .mockResolvedValueOnce(jsonResponse(firstHistoryPage))
      .mockResolvedValueOnce(jsonResponse({ detail: "Final archive batch failed" }, 500))
      .mockResolvedValueOnce(jsonResponse(firstHistoryPage))
      .mockResolvedValueOnce(processingQueueResponse(
        readyJobs.slice(100),
        "remaining-processing-snapshot",
      ));
    render(<App />);
    const user = userEvent.setup();

    expect(await screen.findByRole("button", {
      name: "Open screenshot 101: partial-archive-101.png",
    })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear reviewed" }));

    expect(await screen.findByText("Final archive batch failed")).toBeInTheDocument();
    expect(await screen.findByRole("button", {
      name: "Reopen history item 1",
    })).toBeInTheDocument();
    expect(await screen.findByRole("button", {
      name: "Open screenshot 1: partial-archive-101.png",
    })).toBeInTheDocument();
    expect(window.localStorage.getItem("poker-training-history-total-v1")).toBe("100");
    expect(window.sessionStorage.getItem("poker-training-history-synced")).toBe("true");
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/jobs",
      "http://localhost:8000/api/jobs?offset=100",
      "http://localhost:8000/api/history",
      "http://localhost:8000/api/history",
      "http://localhost:8000/api/history",
      "http://localhost:8000/api/jobs",
    ]);
    expect(fetchMock().mock.calls[2][1]?.method).toBe("PUT");
    expect(fetchMock().mock.calls[3][1]?.method).toBe("PUT");
    expect(fetchMock().mock.calls[4][1]).toEqual({ credentials: "include" });
  });

  it("clears persisted jobs when the bounded browser history cache is unavailable", async () => {
    const created = jobRecord({ original_filename: "storage-disabled.png" });
    const approved = { ...approvedJob(), original_filename: "storage-disabled.png" };
    const recommended = { ...recommendedJob(), original_filename: "storage-disabled.png" };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(jsonResponse(approved))
      .mockResolvedValueOnce(jsonResponse(recommended))
      .mockResolvedValueOnce(processingQueueResponse([recommended]))
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [{
          ...recommended,
          archived_at: "2026-07-10T00:01:00Z",
        }],
      }))
      .mockResolvedValueOnce(processingQueueResponse([]));
    render(<App />);
    const user = userEvent.setup();

    await switchToUploadMode(user);
    await user.upload(
      screen.getByLabelText("Choose screenshots"),
      new File(["storage-disabled"], "storage-disabled.png", { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));
    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled", "QuotaExceededError");
    });

    await user.click(screen.getByRole("button", { name: "Clear reviewed" }));

    expect(await screen.findByRole("button", {
      name: "Reopen history item 1",
    })).toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: storage-disabled.png",
    })).not.toBeInTheDocument();
    expect(screen.queryByText("Storage is disabled")).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem("poker-training-history-synced")).toBeNull();
  });

  it("stops automation before approval when parser warnings are not allowed", async () => {
    stubDisplayMedia("window");
    stubCanvasCapture();
    const created = jobRecord({
      parser_result: {
        state: detectedState,
        confidences: { hero_cards: 0.71, street: 0.9 },
        warnings: ["Hero cards need manual review"],
        raw: {},
      },
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Share window" }));
    expect(await screen.findByText("Window sharing active")).toBeInTheDocument();
    setSharedPreviewSize();

    await user.click(screen.getByRole("button", { name: "Capture and parse" }));

    expect(await screen.findByText("Automation stopped: parser warnings need manual review")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Request recommendation" })).toBeDisabled();
  });

  it("rejects a selected source that does not match the active share mode", async () => {
    const stop = vi.fn();
    const getDisplayMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop }],
      getVideoTracks: () => [{ getSettings: () => ({ displaySurface: "window" }) }],
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    });
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Tab" }));
    await user.click(screen.getByRole("button", { name: "Share tab" }));

    expect(await screen.findByText(/Window was selected\. Choose a tab/)).toBeInTheDocument();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Capture and parse" })).toBeDisabled();
  });

  it("clears stale recommendation access after edits until the current form is re-approved", async () => {
    const editedState = canonicalState({ pot_size: 18 });
    const created = jobRecord();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()))
      .mockResolvedValueOnce(jsonResponse(recommendedJob()))
      .mockResolvedValueOnce(jsonResponse(approvedJob(editedState)))
      .mockResolvedValueOnce(jsonResponse(recommendedJob(editedState)));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(await screen.findByRole("button", { name: "Approve state" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Request recommendation" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Request recommendation" }));
    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve state" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request recommendation" })).toBeDisabled();

    const potInput = screen.getByLabelText(/Pot/);
    await user.clear(potInput);
    await user.type(potInput, "18");

    expect(screen.queryByLabelText("Recommendation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request recommendation" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Request recommendation" }));
    expect(fetchMock()).toHaveBeenCalledTimes(4);

    await user.click(screen.getByRole("button", { name: "Approve state" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Request recommendation" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Request recommendation" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(6));

    await user.click(screen.getByRole("button", { name: "Reset to parser" }));
    expect(screen.queryByLabelText("Recommendation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve state" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Request recommendation" })).toBeDisabled();
  });

  it("locks a training answer before reveal and compares it with the recommendation", async () => {
    const trainingDecision = {
      action: "raise" as const,
      sizing: 7.5,
      certainty: "high" as const,
      recorded_at: "2026-07-20T12:00:00Z",
    };
    const decisionJob = { ...approvedJob(), training_decision: trainingDecision };
    const revealedJob = {
      ...recommendedJob(),
      training_decision: trainingDecision,
    };
    const created = jobRecord();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()))
      .mockResolvedValueOnce(jsonResponse(decisionJob))
      .mockResolvedValueOnce(jsonResponse(revealedJob));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(await screen.findByRole("button", { name: "Approve state" }));
    const decisionPanel = await screen.findByLabelText("Your training decision");
    await user.click(within(decisionPanel).getByRole("button", { name: "raise" }));
    await user.type(within(decisionPanel).getByLabelText("Decision sizing in BB"), "7.5");
    await user.click(within(decisionPanel).getByRole("button", { name: "high" }));
    await user.click(within(decisionPanel).getByRole("button", { name: "Lock answer" }));

    expect(await within(decisionPanel).findByText("Answer locked")).toBeInTheDocument();
    expect(within(decisionPanel).getByText("Saved before reveal")).toBeInTheDocument();
    expect(fetchMock().mock.calls[3][0]).toBe("http://localhost:8000/api/jobs/job-123/decision");
    expect(fetchMock().mock.calls[3][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ action: "raise", sizing: 7.5, certainty: "high" }),
    });

    await user.click(screen.getByRole("button", { name: "Request recommendation" }));

    const comparison = await screen.findByLabelText("Training decision comparison");
    expect(within(comparison).getByText("Raise 7.5 BB")).toBeInTheDocument();
    expect(within(comparison).getByText("High certainty")).toBeInTheDocument();
    expect(within(comparison).getByText("Matched solver")).toBeInTheDocument();
    expect(within(comparison).queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(5);
  });

  it("accepts an exact alternate line from a meaningful solver mix", async () => {
    const trainingDecision = {
      action: "raise" as const,
      sizing: 8,
      recorded_at: "2026-07-20T12:00:00Z",
    };
    const mixedRecommendation: RecommendationResult = {
      action: "call",
      sizing: null,
      confidence: 0.87,
      explanation: "Call most often and mix in a raise.",
      raw: {
        provider: "local_solver",
        engine: "postflop_solver",
        candidates: [
          { action: "call", sizing: null, ev: 2.75, frequency: 0.84 },
          { action: "raise", sizing: 8, ev: 2.74, frequency: 0.16 },
        ],
      },
    };
    const created = jobRecord();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()))
      .mockResolvedValueOnce(jsonResponse({ ...approvedJob(), training_decision: trainingDecision }))
      .mockResolvedValueOnce(jsonResponse({
        ...recommendedJob(),
        training_decision: trainingDecision,
        recommendation: mixedRecommendation,
      }));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(await screen.findByRole("button", { name: "Approve state" }));
    const decisionPanel = await screen.findByLabelText("Your training decision");
    await user.click(within(decisionPanel).getByRole("button", { name: "raise" }));
    await user.type(within(decisionPanel).getByLabelText("Decision sizing in BB"), "8");
    await user.click(screen.getByRole("button", { name: "Request recommendation" }));

    const comparison = await screen.findByLabelText("Training decision comparison");
    expect(within(comparison).getByText("Solver-supported mix")).toBeInTheDocument();
    expect(within(comparison).getByText("0.01 BB EV loss")).toBeInTheDocument();
    expect(within(comparison).queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
  });

  it("marks a differing training decision reviewed", async () => {
    const trainingDecision = {
      action: "call" as const,
      sizing: null,
      recorded_at: "2026-07-20T12:00:00Z",
    };
    const decisionJob = { ...approvedJob(), training_decision: trainingDecision };
    const revealedJob = { ...recommendedJob(), training_decision: trainingDecision };
    const completedReviewJob = {
      ...revealedJob,
      training_reviewed_at: "2026-07-20T12:05:00Z",
      training_review_note: "Call needs less equity than the raise.",
    };
    const updatedReviewJob = {
      ...completedReviewJob,
      training_review_note: "Count the bluff combinations before raising.",
    };
    const clearedReviewJob = {
      ...completedReviewJob,
      training_review_note: null,
    };
    const reopenedReviewJob = {
      ...revealedJob,
      training_reviewed_at: null,
      training_review_note: null,
    };
    const created = jobRecord();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()))
      .mockResolvedValueOnce(jsonResponse(decisionJob))
      .mockResolvedValueOnce(jsonResponse(revealedJob))
      .mockResolvedValueOnce(jsonResponse(completedReviewJob))
      .mockResolvedValueOnce(jsonResponse(updatedReviewJob))
      .mockResolvedValueOnce(jsonResponse(clearedReviewJob))
      .mockResolvedValueOnce(jsonResponse(reopenedReviewJob));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(await screen.findByRole("button", { name: "Approve state" }));
    const decisionPanel = await screen.findByLabelText("Your training decision");
    await user.click(within(decisionPanel).getByRole("button", { name: "call" }));
    await user.click(screen.getByRole("button", { name: "Request recommendation" }));

    const comparison = await screen.findByLabelText("Training decision comparison");
    await user.type(
      screen.getByLabelText("Training review note"),
      "Call needs less equity than the raise.",
    );
    await user.click(within(comparison).getByRole("button", { name: "Mark reviewed" }));

    expect(await within(comparison).findByText("Reviewed")).toBeInTheDocument();
    expect(within(comparison).queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Saved training review note")).toHaveTextContent(
      "Call needs less equity than the raise.",
    );
    expect(await screen.findByText("Training review completed")).toBeInTheDocument();
    expect(fetchMock().mock.calls[5][0]).toBe("http://localhost:8000/api/jobs/job-123/training-review");
    expect(fetchMock().mock.calls[5][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ note: "Call needs less equity than the raise." }),
    });

    await user.click(screen.getByRole("button", { name: "Edit training review note" }));
    const editNote = screen.getByLabelText("Edit training review note");
    expect(within(comparison).getByRole("button", { name: "Reopen review" })).toBeDisabled();
    await user.clear(editNote);
    await user.type(editNote, "Count the bluff combinations before raising.");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Lesson note updated")).toBeInTheDocument();
    expect(screen.getByLabelText("Saved training review note")).toHaveTextContent(
      "Count the bluff combinations before raising.",
    );
    expect(within(comparison).getByText("Reviewed")).toBeInTheDocument();
    expect(fetchMock().mock.calls[6][0]).toBe("http://localhost:8000/api/jobs/job-123/training-review");
    expect(fetchMock().mock.calls[6][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ note: "Count the bluff combinations before raising." }),
    });

    await user.click(screen.getByRole("button", { name: "Edit training review note" }));
    await user.clear(screen.getByLabelText("Edit training review note"));
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Lesson note removed")).toBeInTheDocument();
    expect(screen.queryByLabelText("Saved training review note")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add lesson note" })).toBeInTheDocument();
    expect(within(comparison).getByText("Reviewed")).toBeInTheDocument();
    expect(fetchMock().mock.calls[7][0]).toBe("http://localhost:8000/api/jobs/job-123/training-review");
    expect(fetchMock().mock.calls[7][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ note: null }),
    });

    await user.click(within(comparison).getByRole("button", { name: "Reopen review" }));

    expect(await within(comparison).findByRole("button", { name: "Mark reviewed" })).toBeInTheDocument();
    expect(within(comparison).queryByText("Reviewed")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Training review note")).toHaveValue("");
    expect(await screen.findByText("Training review reopened")).toBeInTheDocument();
    expect(fetchMock().mock.calls[8][0]).toBe("http://localhost:8000/api/jobs/job-123/training-review");
    expect(fetchMock().mock.calls[8][1]).toMatchObject({ method: "DELETE" });
  });

  it.each([
    { operation: "complete" as const },
    { operation: "reopen" as const },
    { operation: "note" as const },
  ])("reconciles a lost training-review $operation response", async ({
    operation,
  }) => {
    const jobId = "2".repeat(32);
    const baseJob = {
      ...recommendedJob(),
      id: jobId,
      original_filename: `${operation}-review-response-lost.png`,
      image_filename: `${jobId}.png`,
      training_decision: {
        action: "call" as const,
        sizing: null,
        certainty: "medium" as const,
        recorded_at: "2026-07-20T12:00:00Z",
      },
      updated_at: "2026-07-20T12:00:00Z",
    };
    const initialJob = operation === "complete"
      ? baseJob
      : {
          ...baseJob,
          training_reviewed_at: "2026-07-20T12:05:00Z",
          training_review_note: "Original lesson note.",
        };
    const persistedJob = operation === "complete"
      ? {
          ...baseJob,
          training_reviewed_at: "2026-07-20T12:10:00Z",
          training_review_note: "Persisted lesson note.",
          updated_at: "2026-07-20T12:10:00Z",
        }
      : operation === "reopen"
        ? {
            ...baseJob,
            training_reviewed_at: null,
            training_review_note: null,
            updated_at: "2026-07-20T12:10:00Z",
          }
        : {
            ...baseJob,
            training_reviewed_at: "2026-07-20T12:05:00Z",
            training_review_note: "Persisted updated lesson.",
            updated_at: "2026-07-20T12:10:00Z",
          };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([initialJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockRejectedValueOnce(new TypeError(`Connection lost after ${operation}`))
      .mockResolvedValueOnce(processingQueueResponse(
        [persistedJob],
        `${operation}-review-persisted-snapshot`,
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();
    const comparison = await screen.findByLabelText("Training decision comparison");

    if (operation === "complete") {
      await user.type(
        screen.getByLabelText("Training review note"),
        "Persisted lesson note.",
      );
      await user.click(within(comparison).getByRole("button", {
        name: "Mark reviewed",
      }));
    } else if (operation === "reopen") {
      await user.click(within(comparison).getByRole("button", {
        name: "Reopen review",
      }));
    } else {
      await user.click(screen.getByRole("button", {
        name: "Edit training review note",
      }));
      const noteInput = screen.getByLabelText("Edit training review note");
      await user.clear(noteInput);
      await user.type(noteInput, "Persisted updated lesson.");
      await user.click(screen.getByRole("button", { name: "Save note" }));
    }

    expect(await screen.findByText(
      `Connection lost after ${operation}`,
    )).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedJob]));
    if (operation === "reopen") {
      expect(await within(comparison).findByRole("button", {
        name: "Mark reviewed",
      })).toBeInTheDocument();
      expect(screen.getByLabelText("Training review note")).toHaveValue("");
    } else {
      expect(await within(comparison).findByText("Reviewed")).toBeInTheDocument();
      expect(screen.getByLabelText("Saved training review note")).toHaveTextContent(
        persistedJob.training_review_note ?? "",
      );
    }
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    const restoredComparison = await screen.findByLabelText(
      "Training decision comparison",
    );
    if (operation === "reopen") {
      expect(within(restoredComparison).getByRole("button", {
        name: "Mark reviewed",
      })).toBeInTheDocument();
    } else {
      expect(within(restoredComparison).getByText("Reviewed")).toBeInTheDocument();
      expect(screen.getByLabelText("Saved training review note")).toHaveTextContent(
        persistedJob.training_review_note ?? "",
      );
    }
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${jobId}/training-review`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("records a selected answer automatically when recommendation is requested", async () => {
    const trainingDecision = {
      action: "call" as const,
      sizing: null,
      certainty: "medium" as const,
      recorded_at: "2026-07-20T12:00:00Z",
    };
    const created = jobRecord();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()))
      .mockResolvedValueOnce(jsonResponse({ ...approvedJob(), training_decision: trainingDecision }))
      .mockResolvedValueOnce(jsonResponse({ ...recommendedJob(), training_decision: trainingDecision }));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(await screen.findByRole("button", { name: "Approve state" }));
    const decisionPanel = await screen.findByLabelText("Your training decision");
    await user.click(within(decisionPanel).getByRole("button", { name: "call" }));
    await user.click(within(decisionPanel).getByRole("button", { name: "medium" }));
    await user.click(screen.getByRole("button", { name: "Request recommendation" }));

    const comparison = await screen.findByLabelText("Training decision comparison");
    expect(within(comparison).getByText("Call")).toBeInTheDocument();
    expect(within(comparison).getByText("Medium certainty")).toBeInTheDocument();
    expect(within(comparison).getByText("Different action")).toBeInTheDocument();
    expect(fetchMock().mock.calls[3][0]).toBe("http://localhost:8000/api/jobs/job-123/decision");
    expect(fetchMock().mock.calls[3][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ action: "call", sizing: null, certainty: "medium" }),
    });
    expect(fetchMock().mock.calls[4][0]).toBe("http://localhost:8000/api/jobs/job-123/recommend");
  });

  it("clears an unlocked training answer when the approved state is edited", async () => {
    const editedState = canonicalState({ pot_size: 18 });
    const created = jobRecord();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()))
      .mockResolvedValueOnce(jsonResponse(approvedJob(editedState)))
      .mockResolvedValueOnce(jsonResponse(recommendedJob(editedState)));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(await screen.findByRole("button", { name: "Approve state" }));
    const originalDecisionPanel = await screen.findByLabelText("Your training decision");
    await user.click(within(originalDecisionPanel).getByRole("button", { name: "call" }));
    expect(within(originalDecisionPanel).getByRole("button", { name: "call" })).toHaveAttribute("aria-pressed", "true");
    expect(within(originalDecisionPanel).getByText("Ready to lock")).toBeInTheDocument();

    const potInput = screen.getByLabelText(/Pot/);
    await user.clear(potInput);
    await user.type(potInput, "18");
    expect(screen.queryByLabelText("Your training decision")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve state" }));
    const updatedDecisionPanel = await screen.findByLabelText("Your training decision");
    expect(within(updatedDecisionPanel).getByRole("button", { name: "call" })).toHaveAttribute("aria-pressed", "false");
    expect(within(updatedDecisionPanel).getByRole("button", { name: "Lock answer" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Request recommendation" }));
    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(5);
    expect(fetchMock().mock.calls[4][0]).toBe("http://localhost:8000/api/jobs/job-123/recommend");
  });

  it("continues through the filtered training review queue", async () => {
    const trainingDecision = {
      action: "call" as const,
      sizing: null,
      recorded_at: "2026-07-20T12:00:00Z",
    };
    const reviewedJob = {
      ...recommendedJob(),
      id: "review-job",
      original_filename: "review.png",
      image_filename: "original.png",
      training_decision: trainingDecision,
    };
    const completedReviewedJob = {
      ...reviewedJob,
      training_reviewed_at: "2026-07-20T12:05:00Z",
      training_review_note: "Prefer calling this raise size.",
    };
    const sizeJob = {
      ...recommendedJob(),
      id: "size-job",
      original_filename: "size.png",
      image_filename: "original.png",
      training_decision: {
        action: "fold" as const,
        sizing: null,
        recorded_at: "2026-07-20T11:00:00Z",
      },
      recommendation: {
        ...recommendation,
        action: "call" as const,
        sizing: null,
      },
    };
    const completedSizeJob = {
      ...sizeJob,
      training_reviewed_at: "2026-07-20T12:06:00Z",
      training_review_note: "Do not overfold the river.",
    };
    const exactHand = {
      job_id: "exact-job",
      original_filename: "exact.png",
      street: "flop" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "raise" as const,
      decision_sizing: 7.5,
      recommended_action: "raise" as const,
      recommended_sizing: 7.5,
      outcome: "match" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      decision_certainty: "low" as const,
      ev_loss_bb: 0,
    };
    const mixedHand = {
      ...exactHand,
      job_id: "mixed-job",
      original_filename: "mixed.png",
      decision_action: "raise" as const,
      decision_sizing: 8,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "mixed" as const,
      recorded_at: "2026-07-20T12:30:00Z",
      decision_certainty: "high" as const,
      review_note: "Prefer the lower-variance supported line.",
      ev_loss_bb: 0.01,
    };
    const reviewQueue = [{
      job_id: "review-job",
      original_filename: "review.png",
      street: "turn" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "call" as const,
      decision_sizing: null,
      recommended_action: "raise" as const,
      recommended_sizing: 7.5,
      outcome: "different" as const,
      recorded_at: "2026-07-20T12:00:00Z",
      reviewed_at: null,
      ev_loss_bb: 0.12,
    }, {
      job_id: "size-job",
      original_filename: "size.png",
      street: "river" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "fold" as const,
      decision_sizing: null,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "different" as const,
      recorded_at: "2026-07-20T11:00:00Z",
      reviewed_at: null,
      ev_loss_bb: null,
    }];
    const streetTrend = {
      window_hands: 2,
      recent_action_accuracy: 0.75,
      previous_action_accuracy: 0.5,
      action_accuracy_delta: 0.25,
      recent_exact_accuracy: 0.25,
      previous_exact_accuracy: 0.75,
      exact_accuracy_delta: -0.5,
      recent_ev_compared_hands: 2,
      previous_ev_compared_hands: 2,
      recent_average_ev_loss_bb: 0.2,
      previous_average_ev_loss_bb: 0.6,
      average_ev_loss_delta_bb: -0.4,
    };
    const progress = {
      reviewed_hands: 4,
      action_matches: 3,
      exact_matches: 2,
      different_actions: 1,
      needs_review_hands: 2,
      action_accuracy: 3 / 4,
      exact_accuracy: 2 / 4,
      ev_compared_hands: 3,
      average_ev_loss_bb: 0.043333,
      certainty_summaries: [{
        certainty: "low" as const,
        hands: 1,
        action_matches: 1,
        exact_matches: 1,
        action_accuracy: 1,
        exact_accuracy: 1,
        ev_compared_hands: 1,
        average_ev_loss_bb: 0,
      }, {
        certainty: "high" as const,
        hands: 1,
        action_matches: 1,
        exact_matches: 1,
        action_accuracy: 1,
        exact_accuracy: 1,
        ev_compared_hands: 1,
        average_ev_loss_bb: 0.01,
      }],
      action_differences: [{
        decision_action: "fold" as const,
        recommended_action: "call" as const,
        hands: 2,
        needs_review_hands: 2,
        ev_compared_hands: 0,
        average_ev_loss_bb: null,
      }],
      street_summaries: [{
        street: "flop" as const,
        reviewed_hands: 4,
        action_matches: 3,
        exact_matches: 2,
        action_accuracy: 3 / 4,
        exact_accuracy: 2 / 4,
        ev_compared_hands: 2,
        average_ev_loss_bb: 0.005,
        trend: streetTrend,
      }],
      position_summaries: [{
        position: "BTN",
        reviewed_hands: 2,
        action_matches: 1,
        exact_matches: 1,
        action_accuracy: 0.5,
        exact_accuracy: 0.5,
        ev_compared_hands: 1,
        average_ev_loss_bb: 0.12,
      }, {
        position: "OOP",
        reviewed_hands: 1,
        action_matches: 1,
        exact_matches: 1,
        action_accuracy: 1,
        exact_accuracy: 1,
        ev_compared_hands: 0,
        average_ev_loss_bb: null,
      }],
      unpositioned_hands: 1,
      recent_hands: [exactHand, mixedHand],
      review_queue_hands: 2,
      review_queue: reviewQueue,
    };
    const nextProgress = {
      ...progress,
      needs_review_hands: 1,
      review_queue_hands: 1,
      review_queue: [reviewQueue[1]],
    };
    const completedProgress = {
      ...progress,
      needs_review_hands: 0,
      position_summaries: [],
      review_queue_hands: 0,
      review_queue: [],
      unpositioned_hands: 4,
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(reviewedJob))
      .mockResolvedValueOnce(jsonResponse(completedReviewedJob))
      .mockResolvedValueOnce(jsonResponse(nextProgress))
      .mockResolvedValueOnce(jsonResponse(sizeJob))
      .mockResolvedValueOnce(jsonResponse(completedSizeJob))
      .mockResolvedValueOnce(jsonResponse(completedProgress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));

    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    const summary = await within(dialog).findByLabelText("Training progress summary");
    expect(summary).toHaveTextContent("75%");
    expect(within(summary).getByText("50%")).toBeInTheDocument();
    expect(within(summary).getByText("0.043 BB")).toBeInTheDocument();
    expect(within(dialog).getByRole("row", { name: /low 1 100% 100% 0 BB/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("row", { name: /high 1 100% 100% 0.01 BB/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("row", { name: /flop 4 75% 50% 0.005 BB/i })).toBeInTheDocument();
    const renderedStreetTrend = within(dialog).getByLabelText(
      "Last 2 hands vs previous 2: action accuracy change +25 percentage points, exact-line accuracy change -50 percentage points, average EV loss change -0.4 BB",
    );
    expect(within(renderedStreetTrend).getByText("+25 pts")).toHaveClass("improving");
    expect(within(renderedStreetTrend).getByText("-50 pts")).toHaveClass("declining");
    expect(within(renderedStreetTrend).getByText("-0.4 BB")).toHaveClass("improving");
    expect(within(dialog).getByRole("heading", { name: "By position" })).toBeInTheDocument();
    expect(within(dialog).getByText("1 unrecorded")).toBeInTheDocument();
    expect(within(dialog).getByRole("row", { name: /BTN 2 50% 50% 0.12 BB/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("row", { name: /OOP 1 100% 100%/i })).toBeInTheDocument();
    expect(within(dialog).getByText("You: Raise 7.5 BB")).toBeInTheDocument();
    expect(within(dialog).getByText("Solver: Raise 7.5 BB")).toBeInTheDocument();
    expect(within(dialog).getByText("EV loss: 0.01 BB")).toBeInTheDocument();
    expect(within(dialog).getByText("Note: Prefer the lower-variance supported line.")).toBeInTheDocument();
    expect(within(dialog).getByText("Exact match")).toBeInTheDocument();
    expect(within(dialog).getByText("Supported mix")).toBeInTheDocument();
    expect(fetchMock().mock.calls[0][0]).toBe("http://localhost:8000/api/training/progress");

    const reviewFoldToCall = within(dialog).getByRole("button", {
      name: "Review Fold to Call differences (2)",
    });
    expect(reviewFoldToCall).toHaveTextContent("2");
    await user.click(reviewFoldToCall);

    expect(within(dialog).getByRole("button", { name: "Needs review 2" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).queryByRole("button", { name: "Open exact.png training review" })).not.toBeInTheDocument();
    expect(within(dialog).getAllByText("Different action")).toHaveLength(2);
    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?review_decision_action=fold&review_recommended_action=call",
    );

    await user.click(within(dialog).getByRole("button", { name: "Review next" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Training progress" })).not.toBeInTheDocument());
    expect(screen.getByAltText("Uploaded poker table screenshot")).toHaveAttribute(
      "src",
      "http://localhost:8000/api/jobs/review-job/image",
    );
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/jobs/review-job");

    await user.type(
      await screen.findByLabelText("Training review note"),
      "Prefer calling this raise size.",
    );
    await user.click(screen.getByRole("button", { name: "Mark reviewed & next" }));

    await waitFor(() => expect(screen.getByAltText("Uploaded poker table screenshot")).toHaveAttribute(
      "src",
      "http://localhost:8000/api/jobs/size-job/image",
    ));
    expect(fetchMock().mock.calls[3][0]).toBe("http://localhost:8000/api/jobs/review-job/training-review");
    expect(fetchMock().mock.calls[3][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ note: "Prefer calling this raise size." }),
    });
    expect(fetchMock().mock.calls[4][0]).toBe(
      "http://localhost:8000/api/training/progress?review_decision_action=fold&review_recommended_action=call",
    );
    expect(fetchMock().mock.calls[5][0]).toBe("http://localhost:8000/api/jobs/size-job");
    expect(await screen.findByText("Training review completed. Next hand ready")).toBeInTheDocument();
    expect(screen.getByLabelText("Training review note")).toHaveValue("");

    await user.type(screen.getByLabelText("Training review note"), "Do not overfold the river.");
    await user.click(screen.getByRole("button", { name: "Mark reviewed & next" }));

    const completedDialog = await screen.findByRole("dialog", { name: "Training progress" });
    expect(within(completedDialog).getByRole("button", { name: "Needs review 0" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(completedDialog).getByRole("heading", { name: "By position" })).toBeInTheDocument();
    expect(within(completedDialog).getByText("4 unrecorded")).toBeInTheDocument();
    expect(within(completedDialog).getByText("No action or sizing differences need review.")).toBeInTheDocument();
    expect(await screen.findByText("Review queue completed")).toBeInTheDocument();
    expect(fetchMock().mock.calls[6][0]).toBe("http://localhost:8000/api/jobs/size-job/training-review");
    expect(fetchMock().mock.calls[6][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ note: "Do not overfold the river." }),
    });
    expect(fetchMock().mock.calls[7][0]).toBe(
      "http://localhost:8000/api/training/progress?review_decision_action=fold&review_recommended_action=call",
    );
  });

  it("drills into recent training hands from a street summary", async () => {
    const flopHand = {
      job_id: "flop-job",
      original_filename: "flop.png",
      street: "flop" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "check" as const,
      decision_sizing: null,
      recommended_action: "check" as const,
      recommended_sizing: null,
      outcome: "match" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: 0,
    };
    const turnHand = {
      ...flopHand,
      job_id: "turn-job",
      original_filename: "turn.png",
      street: "turn" as const,
      recorded_at: "2026-07-20T12:00:00Z",
    };
    const progress = {
      reviewed_hands: 3,
      action_matches: 3,
      exact_matches: 3,
      different_actions: 0,
      needs_review_hands: 0,
      action_accuracy: 1,
      exact_accuracy: 1,
      ev_compared_hands: 2,
      average_ev_loss_bb: 0,
      street_summaries: [{
        street: "flop" as const,
        reviewed_hands: 2,
        action_matches: 2,
        exact_matches: 2,
        action_accuracy: 1,
        exact_accuracy: 1,
        ev_compared_hands: 1,
        average_ev_loss_bb: 0,
      }, {
        street: "turn" as const,
        reviewed_hands: 1,
        action_matches: 1,
        exact_matches: 1,
        action_accuracy: 1,
        exact_accuracy: 1,
        ev_compared_hands: 1,
        average_ev_loss_bb: 0,
      }],
      position_summaries: [],
      unpositioned_hands: 3,
      recent_matching_hands: 3,
      recent_hands: [flopHand, turnHand],
      review_queue_hands: 0,
      review_queue: [],
    };
    const flopProgress = {
      ...progress,
      recent_matching_hands: 2,
      recent_hands: [flopHand],
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(flopProgress))
      .mockResolvedValueOnce(jsonResponse(progress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));

    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    await user.click(within(dialog).getByRole("button", {
      name: "Show 2 hands played on flop",
    }));

    const streetFilter = await within(dialog).findByLabelText("Active street filter");
    expect(within(streetFilter).getByText("Flop")).toBeInTheDocument();
    expect(within(dialog).getByText("Showing 1 newest of 2 Flop hands.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open flop.png training review",
    })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", {
      name: "Open turn.png training review",
    })).not.toBeInTheDocument();
    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?recent_street=flop",
    );

    await user.click(within(streetFilter).getByRole("button", {
      name: "Clear street filter",
    }));
    await waitFor(() => expect(within(dialog).queryByLabelText("Active street filter")).not.toBeInTheDocument());
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/training/progress");
  });

  it("drills into normalized position and unpositioned training hands", async () => {
    const buttonHand = {
      job_id: "button-job",
      original_filename: "button.png",
      street: "flop" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "check" as const,
      decision_sizing: null,
      recommended_action: "check" as const,
      recommended_sizing: null,
      outcome: "match" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: 0,
    };
    const unpositionedHand = {
      ...buttonHand,
      job_id: "unpositioned-job",
      original_filename: "unpositioned.png",
      recorded_at: "2026-07-20T12:00:00Z",
    };
    const positionTrend = {
      window_hands: 1,
      recent_action_accuracy: 1,
      previous_action_accuracy: 0,
      action_accuracy_delta: 1,
      recent_exact_accuracy: 1,
      previous_exact_accuracy: 0,
      exact_accuracy_delta: 1,
      recent_ev_compared_hands: 1,
      previous_ev_compared_hands: 1,
      recent_average_ev_loss_bb: 0.2,
      previous_average_ev_loss_bb: 0.6,
      average_ev_loss_delta_bb: -0.4,
    };
    const progress = {
      reviewed_hands: 3,
      action_matches: 3,
      exact_matches: 3,
      different_actions: 0,
      needs_review_hands: 0,
      action_accuracy: 1,
      exact_accuracy: 1,
      ev_compared_hands: 2,
      average_ev_loss_bb: 0,
      street_summaries: [],
      position_summaries: [{
        position: "BTN",
        reviewed_hands: 2,
        action_matches: 2,
        exact_matches: 2,
        action_accuracy: 1,
        exact_accuracy: 1,
        ev_compared_hands: 1,
        average_ev_loss_bb: 0,
        trend: positionTrend,
      }],
      unpositioned_hands: 1,
      recent_matching_hands: 3,
      recent_hands: [buttonHand, unpositionedHand],
      review_queue_hands: 0,
      review_queue: [],
    };
    const buttonProgress = {
      ...progress,
      recent_matching_hands: 2,
      recent_hands: [buttonHand],
    };
    const unpositionedProgress = {
      ...progress,
      recent_matching_hands: 1,
      recent_hands: [unpositionedHand],
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(buttonProgress))
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(unpositionedProgress))
      .mockResolvedValueOnce(jsonResponse(progress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));

    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    expect(within(dialog).getByText("Last 1 hand vs previous 1")).toBeInTheDocument();
    expect(within(dialog).getAllByText("+100 pts")).toHaveLength(2);
    expect(within(dialog).getByText("-0.4 BB")).toHaveClass("improving");
    await user.click(within(dialog).getByRole("button", {
      name: "Show 2 hands recorded at BTN. Last 1 hand vs previous 1: action accuracy change +100 percentage points, exact-line accuracy change +100 percentage points, average EV loss change -0.4 BB",
    }));

    const buttonFilter = await within(dialog).findByLabelText("Active position filter");
    expect(within(buttonFilter).getByText("BTN")).toBeInTheDocument();
    expect(within(dialog).getByText("Showing 1 newest of 2 BTN hands.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open button.png training review",
    })).toBeInTheDocument();
    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?recent_position=BTN",
    );

    await user.click(within(buttonFilter).getByRole("button", {
      name: "Clear position filter",
    }));
    await waitFor(() => expect(within(dialog).queryByLabelText("Active position filter")).not.toBeInTheDocument());
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/training/progress");

    await user.click(within(dialog).getByRole("button", {
      name: "Show 1 unpositioned hand",
    }));

    const unpositionedFilter = await within(dialog).findByLabelText("Active position filter");
    expect(within(unpositionedFilter).getByText("Unpositioned")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open unpositioned.png training review",
    })).toBeInTheDocument();
    expect(fetchMock().mock.calls[3][0]).toBe(
      "http://localhost:8000/api/training/progress?recent_unpositioned=true",
    );

    await user.click(within(unpositionedFilter).getByRole("button", {
      name: "Clear position filter",
    }));
    await waitFor(() => expect(within(dialog).queryByLabelText("Active position filter")).not.toBeInTheDocument());
    expect(fetchMock().mock.calls[4][0]).toBe("http://localhost:8000/api/training/progress");
  });

  it("opens pending reviews from street summaries", async () => {
    const flopHand = {
      job_id: "flop-review",
      original_filename: "flop-review.png",
      street: "flop" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "fold" as const,
      decision_sizing: null,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "different" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: 0.8,
    };
    const progress = {
      reviewed_hands: 2,
      action_matches: 1,
      exact_matches: 1,
      different_actions: 1,
      needs_review_hands: 1,
      action_accuracy: 0.5,
      exact_accuracy: 0.5,
      ev_compared_hands: 1,
      average_ev_loss_bb: 0.8,
      street_summaries: [{
        street: "flop" as const,
        reviewed_hands: 1,
        action_matches: 0,
        exact_matches: 0,
        action_accuracy: 0,
        exact_accuracy: 0,
        ev_compared_hands: 1,
        average_ev_loss_bb: 0.8,
      }, {
        street: "turn" as const,
        reviewed_hands: 1,
        action_matches: 1,
        exact_matches: 1,
        action_accuracy: 1,
        exact_accuracy: 1,
        ev_compared_hands: 0,
        average_ev_loss_bb: null,
      }],
      position_summaries: [],
      recent_matching_hands: 2,
      recent_hands: [flopHand],
      review_street_counts: { flop: 1 },
      review_queue_hands: 1,
      review_queue: [flopHand],
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(progress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));

    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    const reviewFlop = within(dialog).getByRole("button", {
      name: "Review flop street differences (1)",
    });
    expect(reviewFlop).toHaveTextContent("1");
    const turnRow = within(dialog).getByRole("row", {
      name: "turn 1 100% 100% — —",
    });
    expect(within(turnRow).getAllByRole("button")).toHaveLength(1);

    await user.click(reviewFlop);

    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?review_street=flop",
    );
    expect(await within(dialog).findByText(
      "1 pending review hand on flop.",
    )).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open flop-review.png training review",
    })).toBeInTheDocument();
  });

  it("opens pending reviews from position summaries", async () => {
    const buttonHand = {
      job_id: "button-review",
      original_filename: "button-review.png",
      street: "flop" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "fold" as const,
      decision_sizing: null,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "different" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: 1,
    };
    const unpositionedHand = {
      ...buttonHand,
      job_id: "unpositioned-review",
      original_filename: "unpositioned-review.png",
      recorded_at: "2026-07-20T12:00:00Z",
    };
    const progress = {
      reviewed_hands: 3,
      action_matches: 1,
      exact_matches: 1,
      different_actions: 2,
      needs_review_hands: 2,
      action_accuracy: 1 / 3,
      exact_accuracy: 1 / 3,
      ev_compared_hands: 2,
      average_ev_loss_bb: 1,
      street_summaries: [],
      position_summaries: [{
        position: "BTN",
        reviewed_hands: 2,
        action_matches: 1,
        exact_matches: 1,
        needs_review_hands: 1,
        action_accuracy: 0.5,
        exact_accuracy: 0.5,
        ev_compared_hands: 1,
        average_ev_loss_bb: 1,
      }],
      unpositioned_hands: 1,
      unpositioned_needs_review_hands: 1,
      recent_matching_hands: 3,
      recent_hands: [buttonHand, unpositionedHand],
      review_queue_hands: 2,
      review_queue: [buttonHand, unpositionedHand],
    };
    const buttonProgress = {
      ...progress,
      review_queue_hands: 1,
      review_queue: [buttonHand],
    };
    const unpositionedProgress = {
      ...progress,
      review_queue_hands: 1,
      review_queue: [unpositionedHand],
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(buttonProgress))
      .mockResolvedValueOnce(jsonResponse(buttonProgress))
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(unpositionedProgress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));

    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    await user.click(within(dialog).getByRole("button", {
      name: "Review BTN position differences (1)",
    }));

    const buttonFilter = await within(dialog).findByLabelText(
      "Active review position filter",
    );
    expect(within(buttonFilter).getByText("BTN")).toBeInTheDocument();
    expect(within(dialog).getByText(
      "1 pending review hand across all streets at BTN.",
    )).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open button-review.png training review",
    })).toBeInTheDocument();
    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?review_position=BTN",
    );

    await user.selectOptions(
      within(dialog).getByLabelText("Review street"),
      "flop",
    );
    expect(await within(dialog).findByText(
      "1 pending review hand on flop at BTN.",
    )).toBeInTheDocument();
    expect(fetchMock().mock.calls[2][0]).toBe(
      "http://localhost:8000/api/training/progress?review_street=flop&review_position=BTN",
    );

    const filteredButtonPosition = within(dialog).getByLabelText(
      "Active review position filter",
    );
    await user.click(within(filteredButtonPosition).getByRole("button", {
      name: "Clear review position filter",
    }));
    await waitFor(() => expect(
      within(dialog).queryByLabelText("Active review position filter"),
    ).not.toBeInTheDocument());
    expect(fetchMock().mock.calls[3][0]).toBe(
      "http://localhost:8000/api/training/progress?review_street=flop",
    );

    await user.click(within(dialog).getByRole("button", {
      name: "Review unpositioned differences (1)",
    }));

    const unpositionedFilter = await within(dialog).findByLabelText(
      "Active review position filter",
    );
    expect(within(unpositionedFilter).getByText("Unpositioned")).toBeInTheDocument();
    expect(within(dialog).getByText(
      "1 pending review hand across all streets without a recorded position.",
    )).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open unpositioned-review.png training review",
    })).toBeInTheDocument();
    expect(fetchMock().mock.calls[4][0]).toBe(
      "http://localhost:8000/api/training/progress?review_unpositioned=true",
    );
  });

  it("suggests the highest-loss position review focus", async () => {
    const bigBlindHand = {
      job_id: "bb-focus-job",
      original_filename: "bb-focus.png",
      street: "turn" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "fold" as const,
      decision_sizing: null,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "different" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: 1.2,
    };
    const progress = {
      reviewed_hands: 4,
      action_matches: 0,
      exact_matches: 0,
      different_actions: 4,
      needs_review_hands: 4,
      action_accuracy: 0,
      exact_accuracy: 0,
      ev_compared_hands: 4,
      average_ev_loss_bb: 0.6,
      street_summaries: [],
      position_summaries: [{
        position: "BTN",
        reviewed_hands: 2,
        action_matches: 0,
        exact_matches: 0,
        needs_review_hands: 2,
        action_accuracy: 0,
        exact_accuracy: 0,
        ev_compared_hands: 2,
        average_ev_loss_bb: 0.4,
      }, {
        position: "BB",
        reviewed_hands: 1,
        action_matches: 0,
        exact_matches: 0,
        needs_review_hands: 1,
        action_accuracy: 0,
        exact_accuracy: 0,
        ev_compared_hands: 1,
        average_ev_loss_bb: 1.2,
      }],
      unpositioned_hands: 1,
      unpositioned_needs_review_hands: 1,
      recent_hands: [bigBlindHand],
      review_queue_hands: 4,
      review_queue: [bigBlindHand],
    };
    const focusedProgress = {
      ...progress,
      review_queue_hands: 1,
      review_queue: [bigBlindHand],
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(focusedProgress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));

    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    const focus = within(dialog).getByRole("button", {
      name: "Focus BB position reviews: Highest average EV loss: 1.2 BB",
    });
    expect(focus).toHaveTextContent("Focus BB");

    await user.click(focus);

    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?review_position=BB",
    );
    expect(await within(dialog).findByText(
      "1 pending review hand across all streets at BB.",
    )).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open bb-focus.png training review",
    })).toBeInTheDocument();
  });

  it("suggests unpositioned reviews when scored positions are clear", async () => {
    const unpositionedHand = {
      job_id: "unpositioned-focus-job",
      original_filename: "unpositioned-focus.png",
      street: "river" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "fold" as const,
      decision_sizing: null,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "different" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: null,
    };
    const progress = {
      reviewed_hands: 2,
      action_matches: 1,
      exact_matches: 1,
      different_actions: 1,
      needs_review_hands: 1,
      action_accuracy: 0.5,
      exact_accuracy: 0.5,
      ev_compared_hands: 0,
      average_ev_loss_bb: null,
      street_summaries: [],
      position_summaries: [{
        position: "BTN",
        reviewed_hands: 1,
        action_matches: 1,
        exact_matches: 1,
        needs_review_hands: 0,
        action_accuracy: 1,
        exact_accuracy: 1,
        ev_compared_hands: 0,
        average_ev_loss_bb: null,
      }],
      unpositioned_hands: 1,
      unpositioned_needs_review_hands: 1,
      recent_hands: [unpositionedHand],
      review_queue_hands: 1,
      review_queue: [unpositionedHand],
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(progress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));

    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    const focus = within(dialog).getByRole("button", {
      name: "Focus unpositioned reviews: 1 unpositioned hand needs review",
    });
    expect(focus).toHaveTextContent("Focus Unpositioned");

    await user.click(focus);

    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?review_unpositioned=true",
    );
    expect(await within(dialog).findByText(
      "1 pending review hand across all streets without a recorded position.",
    )).toBeInTheDocument();
  });

  it("suggests the highest-loss action-difference review focus", async () => {
    const patternHand = {
      job_id: "raise-call-focus-job",
      original_filename: "raise-call-focus.png",
      street: "turn" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "raise" as const,
      decision_sizing: 8,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "different" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: 1.1,
    };
    const progress = {
      reviewed_hands: 9,
      action_matches: 0,
      exact_matches: 0,
      different_actions: 9,
      needs_review_hands: 7,
      action_accuracy: 0,
      exact_accuracy: 0,
      ev_compared_hands: 3,
      average_ev_loss_bb: 0.6,
      action_differences: [{
        decision_action: "fold" as const,
        recommended_action: "call" as const,
        hands: 4,
        needs_review_hands: 2,
        ev_compared_hands: 2,
        average_ev_loss_bb: 0.4,
      }, {
        decision_action: "check" as const,
        recommended_action: "bet" as const,
        hands: 4,
        needs_review_hands: 4,
        ev_compared_hands: 0,
        average_ev_loss_bb: null,
      }, {
        decision_action: "raise" as const,
        recommended_action: "call" as const,
        hands: 1,
        needs_review_hands: 1,
        ev_compared_hands: 1,
        average_ev_loss_bb: 1.1,
      }],
      street_summaries: [],
      position_summaries: [],
      recent_hands: [patternHand],
      review_queue_hands: 7,
      review_queue: [patternHand],
    };
    const focusedProgress = {
      ...progress,
      review_queue_hands: 1,
      review_queue: [patternHand],
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(focusedProgress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));

    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    const focus = within(dialog).getByRole("button", {
      name: "Focus Raise to Call differences: Highest average EV loss: 1.1 BB",
    });
    expect(focus).toHaveTextContent("Focus Raise to Call");

    await user.click(focus);

    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?review_decision_action=raise&review_recommended_action=call",
    );
    expect(await within(dialog).findByText(
      "1 pending review hand for Raise to Call across all streets.",
    )).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open raise-call-focus.png training review",
    })).toBeInTheDocument();
  });

  it("suggests the largest action-difference backlog when EV is ungraded", async () => {
    const patternHand = {
      job_id: "check-bet-focus-job",
      original_filename: "check-bet-focus.png",
      street: "flop" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "check" as const,
      decision_sizing: null,
      recommended_action: "bet" as const,
      recommended_sizing: 2,
      outcome: "different" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: null,
    };
    const progress = {
      reviewed_hands: 9,
      action_matches: 0,
      exact_matches: 0,
      different_actions: 9,
      needs_review_hands: 6,
      action_accuracy: 0,
      exact_accuracy: 0,
      ev_compared_hands: 0,
      average_ev_loss_bb: null,
      action_differences: [{
        decision_action: "fold" as const,
        recommended_action: "call" as const,
        hands: 5,
        needs_review_hands: 2,
        ev_compared_hands: 0,
        average_ev_loss_bb: null,
      }, {
        decision_action: "check" as const,
        recommended_action: "bet" as const,
        hands: 4,
        needs_review_hands: 4,
        ev_compared_hands: 0,
        average_ev_loss_bb: null,
      }, {
        decision_action: "raise" as const,
        recommended_action: "call" as const,
        hands: 2,
        needs_review_hands: 0,
        ev_compared_hands: 0,
        average_ev_loss_bb: null,
      }],
      street_summaries: [],
      position_summaries: [],
      recent_hands: [patternHand],
      review_queue_hands: 6,
      review_queue: [patternHand],
    };
    const focusedProgress = {
      ...progress,
      review_queue_hands: 4,
      review_queue: [patternHand],
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(focusedProgress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));

    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    const focus = within(dialog).getByRole("button", {
      name: "Focus Check to Bet differences: Largest backlog: 4 hands need review",
    });
    expect(focus).toHaveTextContent("Focus Check to Bet");
    expect(within(dialog).getByRole("button", {
      name: "Review Check to Bet differences (4)",
    })).toHaveTextContent("4");
    expect(within(dialog).getByLabelText(
      "No pending Raise to Call reviews",
    )).toHaveTextContent("—");

    await user.click(focus);

    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?review_decision_action=check&review_recommended_action=bet",
    );
    expect(await within(dialog).findByText(
      "Showing 1 newest of 4 review hands for Check to Bet across all streets.",
    )).toBeInTheDocument();
  });

  it("drills into solver engine, fallback, and unattributed coverage", async () => {
    const routeKey = "b".repeat(64);
    const fallbackKey = "a".repeat(64);
    const solverPerformanceTrend = {
      window_hands: 1,
      recent_action_accuracy: 1,
      previous_action_accuracy: 0,
      action_accuracy_delta: 1,
      recent_exact_accuracy: 1,
      previous_exact_accuracy: 0,
      exact_accuracy_delta: 1,
      recent_ev_compared_hands: 1,
      previous_ev_compared_hands: 1,
      recent_average_ev_loss_bb: 0.2,
      previous_average_ev_loss_bb: 0.6,
      average_ev_loss_delta_bb: -0.4,
    };
    const routeHand = {
      job_id: "route-job",
      original_filename: "engine.png",
      street: "flop" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "check" as const,
      decision_sizing: null,
      recommended_action: "check" as const,
      recommended_sizing: null,
      outcome: "match" as const,
      recorded_at: "2026-07-21T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: null,
    };
    const fallbackHand = {
      job_id: "fallback-job",
      original_filename: "fallback.png",
      street: "turn" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "call" as const,
      decision_sizing: null,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "match" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: null,
    };
    const unattributedHand = {
      job_id: "unattributed-job",
      original_filename: "legacy.png",
      street: "river" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "fold" as const,
      decision_sizing: null,
      recommended_action: "fold" as const,
      recommended_sizing: null,
      outcome: "match" as const,
      recorded_at: "2026-07-19T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: null,
    };
    const progress = {
      reviewed_hands: 6,
      action_matches: 5,
      exact_matches: 5,
      different_actions: 1,
      needs_review_hands: 1,
      action_accuracy: 5 / 6,
      exact_accuracy: 5 / 6,
      ev_compared_hands: 0,
      average_ev_loss_bb: null,
      solver_coverage: {
        total_hands: 6,
        tracked_hands: 5,
        unattributed_hands: 1,
        fallback_hands: 2,
        fallback_rate: 1 / 3,
        trend: {
          window_hands: 2,
          recent_attribution_rate: 0.75,
          previous_attribution_rate: 1,
          attribution_rate_delta: -0.25,
          recent_fallback_rate: 0,
          previous_fallback_rate: 0.5,
          fallback_rate_delta: -0.5,
        },
        routes: [{
          key: routeKey,
          engine: "local_ev_solver_v1",
          hands: 2,
          fallback_hands: 2,
          action_matches: 1,
          exact_matches: 1,
          action_accuracy: 0.5,
          exact_accuracy: 0.5,
          ev_compared_hands: 1,
          average_ev_loss_bb: 0.4,
          trend: solverPerformanceTrend,
          street_counts: { flop: 1, turn: 1 },
        }, {
          key: "c".repeat(64),
          engine: "postflop_solver",
          hands: 2,
          fallback_hands: 0,
          action_matches: 2,
          exact_matches: 2,
          action_accuracy: 1,
          exact_accuracy: 1,
          ev_compared_hands: 0,
          average_ev_loss_bb: null,
          street_counts: { flop: 1, river: 1 },
        }, {
          key: "d".repeat(64),
          engine: "preflop_chart_v1",
          hands: 1,
          fallback_hands: 0,
          action_matches: 1,
          exact_matches: 1,
          action_accuracy: 1,
          exact_accuracy: 1,
          ev_compared_hands: 0,
          average_ev_loss_bb: null,
          street_counts: { preflop: 1 },
        }],
        fallback_reasons: [{
          key: fallbackKey,
          reason: "hero position must identify IP or OOP",
          hands: 2,
          action_matches: 1,
          exact_matches: 1,
          action_accuracy: 0.5,
          exact_accuracy: 0.5,
          ev_compared_hands: 1,
          average_ev_loss_bb: 0.4,
          trend: solverPerformanceTrend,
          street_counts: { flop: 1, turn: 1 },
        }],
      },
      street_summaries: [],
      recent_matching_hands: 6,
      recent_hands: [],
      review_queue_hands: 0,
      review_queue: [],
    };
    const filteredProgress = {
      ...progress,
      recent_matching_hands: 2,
      recent_hands: [fallbackHand],
    };
    const routeFilteredProgress = {
      ...progress,
      recent_matching_hands: 2,
      recent_hands: [routeHand],
    };
    const unattributedFilteredProgress = {
      ...progress,
      recent_matching_hands: 1,
      recent_hands: [unattributedHand],
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(routeFilteredProgress))
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(filteredProgress))
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(unattributedFilteredProgress))
      .mockResolvedValueOnce(jsonResponse(progress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));

    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    expect(within(dialog).getByRole("heading", { name: "Solver coverage" })).toBeInTheDocument();
    const solverTrend = within(dialog).getByLabelText("Solver coverage trend");
    expect(within(solverTrend).getByText("Last 2 vs previous 2")).toBeInTheDocument();
    expect(within(solverTrend).getByText("75%")).toBeInTheDocument();
    expect(within(solverTrend).getByText("0%")).toBeInTheDocument();
    expect(within(solverTrend).getByText("-25 pts")).toHaveClass("declining");
    expect(within(solverTrend).getByText("-50 pts")).toHaveClass("improving");
    const showUnattributedHands = within(dialog).getByRole("button", {
      name: "Show 1 unattributed hand",
    });
    expect(showUnattributedHands).toBeEnabled();
    const showEngineHands = within(dialog).getByRole("button", {
      name: "Show 2 hands handled by Local EV solver. Action accuracy 50%; exact-line accuracy 50%; average EV loss 0.4 BB; Last 1 hand vs previous 1: action accuracy change +100 percentage points, exact-line accuracy change +100 percentage points, average EV loss change -0.4 BB",
    });
    expect(showEngineHands).toBeEnabled();
    expect(within(showEngineHands).getByText("Action 50%")).toBeInTheDocument();
    expect(within(showEngineHands).getByText("Exact 50%")).toBeInTheDocument();
    expect(within(showEngineHands).getByText("0.4 BB EV loss")).toBeInTheDocument();
    expect(within(showEngineHands).getAllByText("+100 pts")).toHaveLength(2);
    expect(within(showEngineHands).getByText("-0.4 BB")).toHaveClass("improving");
    const showPostflopHands = within(dialog).getByRole("button", {
      name: "Show 2 hands handled by Postflop solver. Action accuracy 100%; exact-line accuracy 100%; EV loss ungraded",
    });
    expect(showPostflopHands).toBeEnabled();
    expect(within(showPostflopHands).getByText("EV ungraded")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Show 1 hand handled by Preflop chart. Action accuracy 100%; exact-line accuracy 100%; EV loss ungraded",
    })).toBeEnabled();
    const showFallbackHands = within(dialog).getByRole("button", {
      name: "Show 2 hands using fallback: hero position must identify IP or OOP. Action accuracy 50%; exact-line accuracy 50%; average EV loss 0.4 BB; Last 1 hand vs previous 1: action accuracy change +100 percentage points, exact-line accuracy change +100 percentage points, average EV loss change -0.4 BB",
    });
    expect(showFallbackHands).toBeEnabled();
    expect(within(showFallbackHands).getByText("Action 50%")).toBeInTheDocument();
    expect(within(showFallbackHands).getByText("Exact 50%")).toBeInTheDocument();
    expect(within(showFallbackHands).getByText("0.4 BB EV loss")).toBeInTheDocument();
    expect(within(showFallbackHands).getAllByText("+100 pts")).toHaveLength(2);
    expect(within(showFallbackHands).getByText("-0.4 BB")).toHaveClass("improving");

    await user.click(showEngineHands);

    expect(fetchMock().mock.calls[1][0]).toBe(
      `http://localhost:8000/api/training/progress?solver_route_key=${routeKey}`,
    );
    const activeRouteFilter = await within(dialog).findByLabelText("Active solver filter");
    expect(within(activeRouteFilter).getByText("Local EV solver")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open engine.png training review",
    })).toBeInTheDocument();
    expect(within(dialog).getByText(
      "Showing 1 newest of 2 engine hands.",
    )).toBeInTheDocument();

    await user.click(within(activeRouteFilter).getByRole("button", {
      name: "Clear solver filter",
    }));

    await waitFor(() => expect(
      within(dialog).queryByLabelText("Active solver filter"),
    ).not.toBeInTheDocument());
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/training/progress");

    const refreshedFallbackHands = within(dialog).getByRole("button", {
      name: "Show 2 hands using fallback: hero position must identify IP or OOP. Action accuracy 50%; exact-line accuracy 50%; average EV loss 0.4 BB; Last 1 hand vs previous 1: action accuracy change +100 percentage points, exact-line accuracy change +100 percentage points, average EV loss change -0.4 BB",
    });
    await waitFor(() => expect(refreshedFallbackHands).toBeEnabled());
    await user.click(refreshedFallbackHands);

    expect(fetchMock().mock.calls[3][0]).toBe(
      `http://localhost:8000/api/training/progress?solver_fallback_key=${fallbackKey}`,
    );
    const activeFilter = await within(dialog).findByLabelText("Active solver filter");
    expect(within(activeFilter).getByText("hero position must identify IP or OOP")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open fallback.png training review",
    })).toBeInTheDocument();
    expect(within(dialog).getByText(
      "Showing 1 newest of 2 fallback hands.",
    )).toBeInTheDocument();

    await user.click(within(activeFilter).getByRole("button", {
      name: "Clear solver filter",
    }));

    await waitFor(() => expect(
      within(dialog).queryByLabelText("Active solver filter"),
    ).not.toBeInTheDocument());
    expect(fetchMock().mock.calls[4][0]).toBe("http://localhost:8000/api/training/progress");

    const refreshedUnattributedHands = within(dialog).getByRole("button", {
      name: "Show 1 unattributed hand",
    });
    await waitFor(() => expect(refreshedUnattributedHands).toBeEnabled());
    await user.click(refreshedUnattributedHands);

    expect(fetchMock().mock.calls[5][0]).toBe(
      "http://localhost:8000/api/training/progress?solver_unattributed=true",
    );
    const activeUnattributedFilter = await within(dialog).findByLabelText("Active solver filter");
    expect(within(activeUnattributedFilter).getByText(
      "Unattributed recommendations",
    )).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open legacy.png training review",
    })).toBeInTheDocument();
    expect(within(dialog).getByText(
      "1 training hand has no engine attribution.",
    )).toBeInTheDocument();

    await user.click(within(activeUnattributedFilter).getByRole("button", {
      name: "Clear solver filter",
    }));

    await waitFor(() => expect(
      within(dialog).queryByLabelText("Active solver filter"),
    ).not.toBeInTheDocument());
    expect(fetchMock().mock.calls[6][0]).toBe("http://localhost:8000/api/training/progress");
  });

  it("shows entirely unattributed legacy recommendation coverage", async () => {
    const progress = {
      reviewed_hands: 3,
      action_matches: 2,
      exact_matches: 2,
      different_actions: 1,
      needs_review_hands: 1,
      action_accuracy: 2 / 3,
      exact_accuracy: 2 / 3,
      ev_compared_hands: 0,
      average_ev_loss_bb: null,
      solver_coverage: {
        total_hands: 3,
        tracked_hands: 0,
        unattributed_hands: 3,
        fallback_hands: 0,
        fallback_rate: 0,
        routes: [],
        fallback_reasons: [],
      },
      street_summaries: [],
      recent_hands: [],
      review_queue_hands: 0,
      review_queue: [],
    };
    fetchMock().mockResolvedValueOnce(jsonResponse(progress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));

    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    expect(within(dialog).getByRole("heading", { name: "Solver coverage" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Show 3 unattributed hands",
    })).toBeEnabled();
  });

  it("suggests a focus street and orders its reviews by EV loss", async () => {
    const lowHand = {
      job_id: "low-job",
      original_filename: "low.png",
      street: "flop" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "fold" as const,
      decision_sizing: null,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "different" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      ev_loss_bb: 0.2,
    };
    const highHand = {
      ...lowHand,
      job_id: "high-job",
      original_filename: "high.png",
      street: "turn" as const,
      recorded_at: "2026-07-20T12:00:00Z",
      ev_loss_bb: 1.4,
    };
    const recentProgress = {
      reviewed_hands: 2,
      action_matches: 0,
      exact_matches: 0,
      different_actions: 2,
      needs_review_hands: 2,
      action_accuracy: 0,
      exact_accuracy: 0,
      ev_compared_hands: 2,
      average_ev_loss_bb: 0.8,
      action_differences: [{
        decision_action: "fold" as const,
        recommended_action: "call" as const,
        hands: 2,
        needs_review_hands: 2,
        ev_compared_hands: 2,
        average_ev_loss_bb: 0.8,
      }],
      trend: {
        window_hands: 1,
        recent_action_accuracy: 0,
        previous_action_accuracy: 0,
        action_accuracy_delta: 0,
        recent_exact_accuracy: 0,
        previous_exact_accuracy: 0,
        exact_accuracy_delta: 0,
        recent_ev_compared_hands: 1,
        previous_ev_compared_hands: 1,
        recent_average_ev_loss_bb: 0.2,
        previous_average_ev_loss_bb: 1.4,
        average_ev_loss_delta_bb: -1.2,
      },
      street_summaries: [{
        street: "flop" as const,
        reviewed_hands: 1,
        action_matches: 0,
        exact_matches: 0,
        action_accuracy: 0,
        exact_accuracy: 0,
        ev_compared_hands: 1,
        average_ev_loss_bb: 0.2,
      }, {
        street: "turn" as const,
        reviewed_hands: 1,
        action_matches: 0,
        exact_matches: 0,
        action_accuracy: 0,
        exact_accuracy: 0,
        ev_compared_hands: 1,
        average_ev_loss_bb: 1.4,
      }],
      recent_hands: [lowHand, highHand],
      review_street_counts: { flop: 1, turn: 1 },
      review_queue_hands: 2,
      review_queue: [lowHand, highHand],
    };
    const focusedProgress = {
      ...recentProgress,
      review_queue_hands: 1,
      review_queue: [highHand],
    };
    const pendingStreet = deferredResponse();
    const pendingOrder = deferredResponse();
    const highJob = {
      ...recommendedJob(),
      id: "high-job",
      original_filename: "high.png",
      training_decision: {
        action: "fold" as const,
        sizing: null,
        recorded_at: highHand.recorded_at,
      },
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(recentProgress))
      .mockResolvedValueOnce(jsonResponse(recentProgress))
      .mockResolvedValueOnce(jsonResponse(recentProgress))
      .mockReturnValueOnce(pendingStreet.promise)
      .mockReturnValueOnce(pendingOrder.promise)
      .mockResolvedValueOnce(jsonResponse(highJob));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));
    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    const trend = within(dialog).getByRole("region", { name: "Recent trend" });
    expect(within(trend).getByText("Last 1 vs previous 1")).toBeInTheDocument();
    expect(within(trend).getByText("0.2 BB")).toBeInTheDocument();
    expect(within(trend).getByText("-1.2 BB")).toHaveClass("improving");
    const differences = within(dialog).getByRole("region", { name: "Common differences" });
    expect(within(differences).getByText("Fold")).toBeInTheDocument();
    expect(within(differences).getByText("Call")).toBeInTheDocument();
    expect(within(differences).getByText("2 hands")).toBeInTheDocument();
    expect(within(differences).getByText("0.8 BB avg loss")).toBeInTheDocument();
    const reviewFoldToCall = within(differences).getByRole("button", {
      name: "Review Fold to Call differences (2)",
    });
    expect(reviewFoldToCall).toHaveTextContent("2");
    await user.click(reviewFoldToCall);
    expect(await within(dialog).findByLabelText("Active action-difference filter")).toHaveTextContent(
      "FoldCall",
    );
    expect(within(dialog).getByText(
      "2 pending review hands for Fold to Call across all streets.",
    )).toBeInTheDocument();
    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?review_decision_action=fold&review_recommended_action=call",
    );

    await user.click(within(dialog).getByRole("button", {
      name: "Clear action-difference filter",
    }));
    await waitFor(() => expect(
      within(dialog).queryByLabelText("Active action-difference filter"),
    ).not.toBeInTheDocument());
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/training/progress");

    await user.click(within(dialog).getByRole("button", { name: "Recent" }));
    await user.click(within(dialog).getByRole("button", { name: /Focus turn reviews/ }));

    expect(within(dialog).getByText("Updating review queue...")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Open low.png training review" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Open high.png training review" })).not.toBeInTheDocument();
    expect(fetchMock().mock.calls[3][0]).toBe(
      "http://localhost:8000/api/training/progress?review_street=turn",
    );

    pendingStreet.resolve(jsonResponse(focusedProgress));
    await waitFor(() => expect(within(dialog).getByLabelText("Review street")).toHaveValue("turn"));
    expect(within(dialog).getByText("1 pending review hand on turn.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Open low.png training review" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Open high.png training review" })).toBeEnabled();

    await user.selectOptions(within(dialog).getByLabelText("Review order"), "ev_loss");
    const reviewHighestLoss = within(dialog).getByRole("button", { name: "Review highest loss" });
    expect(reviewHighestLoss).toBeDisabled();
    expect(within(dialog).getByText("Updating review queue...")).toBeInTheDocument();
    expect(fetchMock().mock.calls[4][0]).toBe(
      "http://localhost:8000/api/training/progress?review_order=ev_loss&review_street=turn",
    );

    pendingOrder.resolve(jsonResponse(focusedProgress));
    await waitFor(() => expect(reviewHighestLoss).toBeEnabled());
    expect(within(dialog).getByLabelText("Review order")).toHaveValue("ev_loss");
    await user.click(reviewHighestLoss);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Training progress" })).not.toBeInTheDocument());
    expect(screen.getByAltText("Uploaded poker table screenshot")).toHaveAttribute(
      "src",
      "http://localhost:8000/api/jobs/high-job/image",
    );
    expect(fetchMock().mock.calls[5][0]).toBe("http://localhost:8000/api/jobs/high-job");
  });

  it("opens pending reviews from a certainty calibration row", async () => {
    const highHand = {
      job_id: "high-certainty-job",
      original_filename: "high-certainty.png",
      street: "turn" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "fold" as const,
      decision_sizing: null,
      decision_certainty: "high" as const,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "different" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: 0.8,
    };
    const certaintyTrend = {
      window_hands: 1,
      recent_action_accuracy: 0,
      previous_action_accuracy: 1,
      action_accuracy_delta: -1,
      recent_exact_accuracy: 0,
      previous_exact_accuracy: 1,
      exact_accuracy_delta: -1,
      recent_ev_compared_hands: 1,
      previous_ev_compared_hands: 1,
      recent_average_ev_loss_bb: 0.8,
      previous_average_ev_loss_bb: 0,
      average_ev_loss_delta_bb: 0.8,
    };
    const progress = {
      reviewed_hands: 2,
      action_matches: 1,
      exact_matches: 1,
      different_actions: 1,
      needs_review_hands: 1,
      action_accuracy: 0.5,
      exact_accuracy: 0.5,
      ev_compared_hands: 2,
      average_ev_loss_bb: 0.4,
      certainty_summaries: [{
        certainty: "high" as const,
        hands: 2,
        action_matches: 1,
        exact_matches: 1,
        needs_review_hands: 1,
        action_accuracy: 0.5,
        exact_accuracy: 0.5,
        ev_compared_hands: 2,
        average_ev_loss_bb: 0.4,
        trend: certaintyTrend,
      }],
      street_summaries: [],
      recent_hands: [highHand],
      review_queue_hands: 1,
      review_queue: [highHand],
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(progress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));
    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    const renderedCertaintyTrend = within(dialog).getByLabelText(
      "Last 1 hand vs previous 1: action accuracy change -100 percentage points, exact-line accuracy change -100 percentage points, average EV loss change +0.8 BB",
    );
    expect(within(renderedCertaintyTrend).getAllByText("-100 pts")).toHaveLength(2);
    expect(within(renderedCertaintyTrend).getByText("+0.8 BB")).toHaveClass("declining");
    const shortcut = within(dialog).getByRole("button", {
      name: "Review high certainty differences (1)",
    });
    expect(shortcut).toBeEnabled();

    await user.click(shortcut);

    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?review_certainty=high",
    );
    expect(await within(dialog).findByLabelText("Review certainty")).toHaveValue("high");
    expect(within(dialog).getByRole("button", { name: "Needs review 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(dialog).getByText(
      "1 pending review hand across all streets with high certainty.",
    )).toBeInTheDocument();
  });

  it("suggests the highest-loss certainty review focus", async () => {
    const lowHand = {
      job_id: "low-certainty-job",
      original_filename: "low-certainty.png",
      street: "turn" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "fold" as const,
      decision_sizing: null,
      decision_certainty: "low" as const,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "different" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: 1.2,
    };
    const highHand = {
      ...lowHand,
      job_id: "high-certainty-job",
      original_filename: "high-certainty.png",
      decision_certainty: "high" as const,
      recorded_at: "2026-07-20T12:00:00Z",
      ev_loss_bb: 0.4,
    };
    const progress = {
      reviewed_hands: 3,
      action_matches: 0,
      exact_matches: 0,
      different_actions: 3,
      needs_review_hands: 3,
      action_accuracy: 0,
      exact_accuracy: 0,
      ev_compared_hands: 3,
      average_ev_loss_bb: 0.67,
      certainty_summaries: [{
        certainty: "low" as const,
        hands: 1,
        action_matches: 0,
        exact_matches: 0,
        needs_review_hands: 1,
        action_accuracy: 0,
        exact_accuracy: 0,
        ev_compared_hands: 1,
        average_ev_loss_bb: 1.2,
      }, {
        certainty: "high" as const,
        hands: 2,
        action_matches: 0,
        exact_matches: 0,
        needs_review_hands: 2,
        action_accuracy: 0,
        exact_accuracy: 0,
        ev_compared_hands: 2,
        average_ev_loss_bb: 0.4,
      }],
      unrated_hands: 0,
      unrated_needs_review_hands: 0,
      street_summaries: [],
      recent_hands: [lowHand, highHand],
      review_queue_hands: 3,
      review_queue: [lowHand, highHand],
    };
    const focusedProgress = {
      ...progress,
      review_queue_hands: 1,
      review_queue: [lowHand],
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(focusedProgress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));
    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    const focus = within(dialog).getByRole("button", {
      name: "Focus low certainty reviews: Highest average EV loss: 1.2 BB",
    });
    expect(focus).toHaveTextContent("Focus Low");

    await user.click(focus);

    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?review_certainty=low",
    );
    expect(await within(dialog).findByLabelText("Review certainty")).toHaveValue("low");
    expect(within(dialog).getByText(
      "1 pending review hand across all streets with low certainty.",
    )).toBeInTheDocument();
  });

  it("drills into rated and unrated certainty hands", async () => {
    const highHand = {
      job_id: "high-certainty-job",
      original_filename: "high-certainty.png",
      street: "turn" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "call" as const,
      decision_sizing: null,
      decision_certainty: "high" as const,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "match" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: 0,
    };
    const unratedHand = {
      ...highHand,
      job_id: "unrated-job",
      original_filename: "unrated.png",
      decision_certainty: null,
      recorded_at: "2026-07-20T12:00:00Z",
    };
    const progress = {
      reviewed_hands: 3,
      action_matches: 3,
      exact_matches: 3,
      different_actions: 0,
      needs_review_hands: 0,
      action_accuracy: 1,
      exact_accuracy: 1,
      ev_compared_hands: 3,
      average_ev_loss_bb: 0,
      certainty_summaries: [{
        certainty: "high" as const,
        hands: 2,
        action_matches: 2,
        exact_matches: 2,
        needs_review_hands: 0,
        action_accuracy: 1,
        exact_accuracy: 1,
        ev_compared_hands: 2,
        average_ev_loss_bb: 0,
      }],
      unrated_hands: 1,
      unrated_needs_review_hands: 0,
      street_summaries: [],
      recent_matching_hands: 3,
      recent_hands: [highHand, unratedHand],
      review_queue_hands: 0,
      review_queue: [],
    };
    const highProgress = {
      ...progress,
      recent_matching_hands: 2,
      recent_hands: [highHand],
    };
    const unratedProgress = {
      ...progress,
      recent_matching_hands: 1,
      recent_hands: [unratedHand],
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(highProgress))
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(unratedProgress))
      .mockResolvedValueOnce(jsonResponse(progress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));
    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    await user.click(within(dialog).getByRole("button", {
      name: "Show 2 hands rated high certainty",
    }));

    const highFilter = await within(dialog).findByLabelText("Active certainty filter");
    expect(within(highFilter).getByText("High")).toBeInTheDocument();
    expect(within(dialog).getByText("Showing 1 newest of 2 High hands.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open high-certainty.png training review",
    })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", {
      name: "Open unrated.png training review",
    })).not.toBeInTheDocument();
    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?recent_certainty=high",
    );

    await user.click(within(highFilter).getByRole("button", {
      name: "Clear certainty filter",
    }));
    await waitFor(() => expect(
      within(dialog).queryByLabelText("Active certainty filter"),
    ).not.toBeInTheDocument());
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/training/progress");

    await user.click(within(dialog).getByRole("button", {
      name: "Show 1 unrated hand",
    }));

    const unratedFilter = await within(dialog).findByLabelText("Active certainty filter");
    expect(within(unratedFilter).getByText("Unrated")).toBeInTheDocument();
    expect(within(dialog).getByText("1 training hand has no certainty rating.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open unrated.png training review",
    })).toBeInTheDocument();
    expect(fetchMock().mock.calls[3][0]).toBe(
      "http://localhost:8000/api/training/progress?recent_certainty=unrated",
    );

    await user.click(within(unratedFilter).getByRole("button", {
      name: "Clear certainty filter",
    }));
    await waitFor(() => expect(
      within(dialog).queryByLabelText("Active certainty filter"),
    ).not.toBeInTheDocument());
    expect(fetchMock().mock.calls[4][0]).toBe("http://localhost:8000/api/training/progress");
  });

  it("surfaces legacy unrated hands without treating them as calibrated", async () => {
    const unratedHand = {
      job_id: "unrated-job",
      original_filename: "unrated.png",
      street: "river" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "fold" as const,
      decision_sizing: null,
      decision_certainty: null,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "different" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: null,
    };
    const progress = {
      reviewed_hands: 1,
      action_matches: 0,
      exact_matches: 0,
      different_actions: 1,
      needs_review_hands: 1,
      action_accuracy: 0,
      exact_accuracy: 0,
      ev_compared_hands: 0,
      average_ev_loss_bb: null,
      certainty_summaries: [],
      unrated_hands: 1,
      unrated_needs_review_hands: 1,
      street_summaries: [],
      recent_hands: [unratedHand],
      review_queue_hands: 1,
      review_queue: [unratedHand],
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(progress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));
    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    expect(within(dialog).getByRole("button", {
      name: "Focus unrated reviews: 1 legacy hand needs review",
    })).toBeInTheDocument();
    expect(within(dialog).getByRole("row", {
      name: "Unrated 1 — — — 1",
    })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", {
      name: "Review unrated differences (1)",
    }));

    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?review_certainty=unrated",
    );
    expect(await within(dialog).findByLabelText("Review certainty")).toHaveValue("unrated");
    expect(within(dialog).getByText(
      "1 pending review hand across all streets without a certainty rating.",
    )).toBeInTheDocument();
  });

  it("filters and continues training reviews by decision certainty", async () => {
    const highHand = {
      job_id: "high-certainty-job",
      original_filename: "high-certainty.png",
      street: "flop" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "fold" as const,
      decision_sizing: null,
      decision_certainty: "high" as const,
      recommended_action: "raise" as const,
      recommended_sizing: 7.5,
      outcome: "different" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: 1.1,
    };
    const unratedHand = {
      ...highHand,
      job_id: "unrated-job",
      original_filename: "unrated.png",
      decision_certainty: null,
      recorded_at: "2026-07-20T12:00:00Z",
      ev_loss_bb: 0.2,
    };
    const progress = {
      reviewed_hands: 2,
      action_matches: 0,
      exact_matches: 0,
      different_actions: 2,
      needs_review_hands: 2,
      action_accuracy: 0,
      exact_accuracy: 0,
      ev_compared_hands: 2,
      average_ev_loss_bb: 0.65,
      street_summaries: [],
      recent_hands: [highHand, unratedHand],
      review_queue_hands: 2,
      review_queue: [highHand, unratedHand],
    };
    const highProgress = {
      ...progress,
      review_queue_hands: 1,
      review_queue: [highHand],
    };
    const completedProgress = {
      ...progress,
      needs_review_hands: 1,
      review_queue_hands: 0,
      review_queue: [],
    };
    const highJob = recommendedJob();
    highJob.id = highHand.job_id;
    highJob.original_filename = highHand.original_filename;
    highJob.training_decision = {
      action: "fold",
      sizing: null,
      certainty: "high",
      recorded_at: highHand.recorded_at,
    };
    const reviewedHighJob = {
      ...highJob,
      training_reviewed_at: "2026-07-20T14:00:00Z",
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(highProgress))
      .mockResolvedValueOnce(jsonResponse(highJob))
      .mockResolvedValueOnce(jsonResponse(reviewedHighJob))
      .mockResolvedValueOnce(jsonResponse(completedProgress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));
    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    await user.click(within(dialog).getByRole("button", { name: "Needs review 2" }));
    await user.selectOptions(within(dialog).getByLabelText("Review certainty"), "high");

    expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?review_certainty=high",
    );
    expect(await within(dialog).findByText(
      "1 pending review hand across all streets with high certainty.",
    )).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Open high-certainty.png training review",
    })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", {
      name: "Open unrated.png training review",
    })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Review next" }));
    await user.click(await screen.findByRole("button", { name: "Mark reviewed & next" }));

    const completedDialog = await screen.findByRole("dialog", { name: "Training progress" });
    expect(within(completedDialog).getByLabelText("Review certainty")).toHaveValue("high");
    expect(within(completedDialog).getByText(
      "No pending review hands across all streets with high certainty.",
    )).toBeInTheDocument();
    expect(fetchMock().mock.calls[4][0]).toBe(
      "http://localhost:8000/api/training/progress?review_certainty=high",
    );
  });

  it("falls back to action accuracy when suggesting an ungraded focus street", async () => {
    const hand = {
      job_id: "focus-job",
      original_filename: "focus.png",
      street: "flop" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "fold" as const,
      decision_sizing: null,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "different" as const,
      recorded_at: "2026-07-20T13:00:00Z",
      reviewed_at: null,
      ev_loss_bb: null,
    };
    fetchMock().mockResolvedValueOnce(jsonResponse({
      reviewed_hands: 3,
      action_matches: 1,
      exact_matches: 1,
      different_actions: 2,
      needs_review_hands: 2,
      action_accuracy: 1 / 3,
      exact_accuracy: 1 / 3,
      ev_compared_hands: 0,
      average_ev_loss_bb: null,
      trend: {
        window_hands: 1,
        recent_action_accuracy: 1,
        previous_action_accuracy: 0,
        action_accuracy_delta: 1,
        recent_exact_accuracy: 1,
        previous_exact_accuracy: 0,
        exact_accuracy_delta: 1,
        recent_ev_compared_hands: 0,
        previous_ev_compared_hands: 0,
        recent_average_ev_loss_bb: null,
        previous_average_ev_loss_bb: null,
        average_ev_loss_delta_bb: null,
      },
      street_summaries: [{
        street: "flop",
        reviewed_hands: 2,
        action_matches: 0,
        exact_matches: 0,
        action_accuracy: 0,
        exact_accuracy: 0,
        ev_compared_hands: 0,
        average_ev_loss_bb: null,
      }, {
        street: "turn",
        reviewed_hands: 1,
        action_matches: 1,
        exact_matches: 1,
        action_accuracy: 1,
        exact_accuracy: 1,
        ev_compared_hands: 0,
        average_ev_loss_bb: null,
      }],
      recent_hands: [hand],
      review_street_counts: { flop: 1, turn: 1 },
      review_queue_hands: 2,
      review_queue: [hand],
    }));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));
    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    const trend = within(dialog).getByRole("region", { name: "Recent trend" });

    expect(within(dialog).getByRole("button", {
      name: "Focus flop reviews: Lowest action match: 0%",
    })).toBeInTheDocument();
    expect(within(trend).getAllByText("+100 pts")[0]).toHaveClass("improving");
    expect(within(trend).queryByText("Avg EV loss")).not.toBeInTheDocument();
  });

  it("reopens a completed review from recent training decisions", async () => {
    const trainingDecision = {
      action: "call" as const,
      sizing: null,
      recorded_at: "2026-07-20T12:00:00Z",
    };
    const reviewedAt = "2026-07-20T12:05:00Z";
    const reviewedHand = {
      job_id: "review-job",
      original_filename: "review.png",
      street: "turn" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "call" as const,
      decision_sizing: null,
      recommended_action: "raise" as const,
      recommended_sizing: 7.5,
      outcome: "different" as const,
      recorded_at: trainingDecision.recorded_at,
      reviewed_at: reviewedAt,
    };
    const reopenedHand = { ...reviewedHand, reviewed_at: null };
    const reviewedProgress = {
      reviewed_hands: 1,
      action_matches: 0,
      exact_matches: 0,
      different_actions: 1,
      needs_review_hands: 0,
      action_accuracy: 0,
      exact_accuracy: 0,
      street_summaries: [],
      recent_hands: [reviewedHand],
      review_queue: [],
    };
    const reopenedProgress = {
      ...reviewedProgress,
      needs_review_hands: 1,
      recent_hands: [reopenedHand],
      review_queue: [reopenedHand],
    };
    const reopenedJob = {
      ...recommendedJob(),
      id: "review-job",
      original_filename: "review.png",
      training_decision: trainingDecision,
      training_reviewed_at: null,
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(reviewedProgress))
      .mockResolvedValueOnce(jsonResponse(reopenedJob))
      .mockResolvedValueOnce(jsonResponse(reopenedProgress));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));
    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    expect(within(dialog).getByText("Reviewed")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Reopen review.png training review" }));

    expect(await within(dialog).findByRole("button", { name: "Needs review 1" })).toBeInTheDocument();
    expect(within(dialog).getByText("Different action")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Reopen review.png training review" })).not.toBeInTheDocument();
    expect(await screen.findByText("Training review reopened")).toBeInTheDocument();
    expect(fetchMock().mock.calls[1][0]).toBe("http://localhost:8000/api/jobs/review-job/training-review");
    expect(fetchMock().mock.calls[1][1]).toMatchObject({ method: "DELETE" });
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/training/progress");
  });

  it("reconciles a lost progress-dialog reopen response", async () => {
    const jobId = "6".repeat(32);
    const reviewedAt = "2026-07-20T12:05:00Z";
    const trainingDecision = {
      action: "call" as const,
      sizing: null,
      certainty: "medium" as const,
      recorded_at: "2026-07-20T12:00:00Z",
    };
    const reviewedJob = {
      ...recommendedJob(),
      id: jobId,
      original_filename: "progress-reopen-lost.png",
      training_decision: trainingDecision,
      training_reviewed_at: reviewedAt,
      training_review_note: "Review this spot again.",
      updated_at: reviewedAt,
    };
    const reopenedJob = {
      ...reviewedJob,
      training_reviewed_at: null,
      training_review_note: null,
      updated_at: "2026-07-20T12:10:00Z",
    };
    const reviewedHand = {
      job_id: jobId,
      original_filename: reviewedJob.original_filename,
      street: "turn" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "call" as const,
      decision_sizing: null,
      recommended_action: "raise" as const,
      recommended_sizing: 7.5,
      outcome: "different" as const,
      recorded_at: trainingDecision.recorded_at,
      reviewed_at: reviewedAt,
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([reviewedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        reviewed_hands: 1,
        action_matches: 0,
        exact_matches: 0,
        different_actions: 1,
        needs_review_hands: 0,
        action_accuracy: 0,
        exact_accuracy: 0,
        street_summaries: [],
        recent_hands: [reviewedHand],
        review_queue: [],
      }))
      .mockRejectedValueOnce(new TypeError("Connection lost after progress reopen"))
      .mockResolvedValueOnce(processingQueueResponse(
        [reopenedJob],
        "progress-reopen-persisted-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));
    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    await user.click(within(dialog).getByRole("button", {
      name: "Reopen progress-reopen-lost.png training review",
    }));

    expect(await screen.findByText(
      "Connection lost after progress reopen",
    )).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([reopenedJob]));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    const comparison = await screen.findByLabelText(
      "Training decision comparison",
    );
    expect(within(comparison).getByRole("button", {
      name: "Mark reviewed",
    })).toBeInTheDocument();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/training/progress",
      `http://localhost:8000/api/jobs/${jobId}/training-review`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("keeps completed review notes available in a dedicated lessons view", async () => {
    const recentHand = {
      job_id: "recent-job",
      original_filename: "recent.png",
      street: "flop" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "call" as const,
      decision_sizing: null,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "match" as const,
      recorded_at: "2026-07-20T12:00:00Z",
      reviewed_at: null,
      review_note: null,
      ev_loss_bb: null,
    };
    const lessonHand = {
      job_id: "lesson-job",
      original_filename: "lesson.png",
      street: "turn" as const,
      hero_cards: canonicalState().hero_cards,
      decision_action: "fold" as const,
      decision_sizing: null,
      recommended_action: "call" as const,
      recommended_sizing: null,
      outcome: "different" as const,
      recorded_at: "2026-07-19T12:00:00Z",
      reviewed_at: "2026-07-20T14:00:00Z",
      review_note: "Count the bluff combinations before folding.",
      ev_loss_bb: 0.5,
    };
    const olderLessonHand = {
      ...lessonHand,
      job_id: "older-lesson-job",
      original_filename: "older-lesson.png",
      recorded_at: "2026-07-18T12:00:00Z",
      reviewed_at: "2026-07-19T14:00:00Z",
      review_note: "Use the pot odds before choosing a line.",
      ev_loss_bb: 2,
    };
    const progress = {
      reviewed_hands: 3,
      action_matches: 1,
      exact_matches: 1,
      different_actions: 2,
      needs_review_hands: 0,
      action_accuracy: 1 / 3,
      exact_accuracy: 1 / 3,
      ev_compared_hands: 0,
      average_ev_loss_bb: null,
      street_summaries: [],
      recent_hands: [recentHand],
      lesson_count: 2,
      lesson_matching_hands: 2,
      lesson_hands: [lessonHand, olderLessonHand],
      review_queue_hands: 0,
      review_queue: [],
    };
    const turnProgress = {
      ...progress,
      lesson_matching_hands: 1,
      lesson_hands: [lessonHand],
    };
    const evOrderedProgress = {
      ...progress,
      lesson_hands: [olderLessonHand, lessonHand],
    };
    const lessonJob = {
      ...recommendedJob(),
      id: "lesson-job",
      original_filename: "lesson.png",
      training_decision: {
        action: "fold" as const,
        sizing: null,
        certainty: "high" as const,
        recorded_at: lessonHand.recorded_at,
      },
      training_reviewed_at: lessonHand.reviewed_at,
      training_review_note: lessonHand.review_note,
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(progress))
      .mockResolvedValueOnce(jsonResponse(evOrderedProgress))
      .mockResolvedValueOnce(jsonResponse(turnProgress))
      .mockResolvedValueOnce(jsonResponse(turnProgress))
      .mockResolvedValueOnce(jsonResponse(lessonJob));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Training progress" }));
    const dialog = await screen.findByRole("dialog", { name: "Training progress" });
    await user.click(within(dialog).getByRole("button", { name: "Lessons 2" }));

    expect(within(dialog).getByRole("heading", { name: "Saved lessons" })).toBeInTheDocument();
    expect(within(dialog).getByText("2 saved lesson notes.")).toBeInTheDocument();
    expect(within(dialog).getByText(
      "Note: Count the bluff combinations before folding.",
    )).toBeInTheDocument();
    expect(within(dialog).getByText(
      "Note: Use the pot odds before choosing a line.",
    )).toBeInTheDocument();
    expect(within(dialog).queryByText("recent.png")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", {
      name: "Reopen lesson.png training review",
    })).not.toBeInTheDocument();

    await user.selectOptions(within(dialog).getByLabelText("Lesson order"), "ev_loss");

    await waitFor(() => expect(fetchMock().mock.calls[1][0]).toBe(
      "http://localhost:8000/api/training/progress?lesson_order=ev_loss",
    ));
    expect(within(dialog).getAllByRole("button", {
      name: /Open .* training review/,
    })[0]).toHaveAccessibleName("Open older-lesson.png training review");

    await user.selectOptions(within(dialog).getByLabelText("Lesson street"), "turn");

    await waitFor(() => expect(fetchMock().mock.calls[2][0]).toBe(
      "http://localhost:8000/api/training/progress?lesson_order=ev_loss&lesson_street=turn",
    ));
    expect(within(dialog).getByText("1 lesson note matches these filters.")).toBeInTheDocument();
    expect(within(dialog).queryByText(
      "Note: Use the pot odds before choosing a line.",
    )).not.toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Search saved lesson notes"), "bluff");
    await user.click(within(dialog).getByRole("button", { name: "Apply lesson search" }));

    await waitFor(() => expect(fetchMock().mock.calls[3][0]).toBe(
      "http://localhost:8000/api/training/progress?lesson_order=ev_loss&lesson_street=turn&lesson_query=bluff",
    ));
    expect(within(dialog).getByText(
      "Note: Count the bluff combinations before folding.",
    )).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Export lessons" })).toHaveAttribute(
      "href",
      "http://localhost:8000/api/training/lessons/export?lesson_order=ev_loss&lesson_street=turn&lesson_query=bluff",
    );
    expect(within(dialog).getByRole("link", { name: "Export lessons" })).toHaveAttribute(
      "download",
      "poker-hero-lessons.md",
    );

    await user.click(within(dialog).getByRole("button", {
      name: "Open lesson.png training review",
    }));

    expect(fetchMock().mock.calls[4][0]).toBe(
      "http://localhost:8000/api/jobs/lesson-job",
    );
    expect(await screen.findByLabelText("Saved training review note")).toHaveTextContent(
      "Count the bluff combinations before folding.",
    );
    expect(screen.getByRole("button", { name: "Reopen review" })).toBeInTheDocument();
  });

  it("loads saved history and reopens a reviewed hand", async () => {
    const savedState = canonicalState({
      hero_cards: [
        { rank: "7", suit: "diamonds" },
        { rank: "A", suit: "hearts" },
      ],
      board_cards: [],
      pot_size: 3.5,
      street: "preflop",
    });
    delete (savedState as Partial<CanonicalState>).hero_stack;
    delete (savedState as Partial<CanonicalState>).facing_action;
    const savedJob: JobRecord = {
      ...recommendedJob(savedState),
      id: "history-job",
      original_filename: "history.png",
      image_filename: "history.png",
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{ id: savedJob.id, job: savedJob, savedAt: new Date().toISOString() }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    render(<App />);
    const user = userEvent.setup();

    const historyItem = screen.getByRole("button", { name: "Reopen history item 1" });
    expect(within(historyItem).getByText("7♦")).toBeInTheDocument();

    await user.click(historyItem);

    expect(await screen.findByDisplayValue("7d Ah")).toBeInTheDocument();
    expect(screen.getByDisplayValue("3.5")).toBeInTheDocument();
    expect(screen.getByLabelText(/Hero stack/)).toHaveValue("");
    expect(screen.getByLabelText(/Facing action/)).toHaveValue("");
    expect(screen.getByLabelText("Recommendation")).toBeInTheDocument();
    expect(screen.queryByLabelText("Decision evidence")).not.toBeInTheDocument();
  });

  it("updates persisted history immediately after a reopened hand is re-approved", async () => {
    const archivedAt = "2026-07-10T00:02:00Z";
    const savedJob: JobRecord = {
      ...recommendedJob(),
      archived_at: archivedAt,
    };
    const reapprovedJob: JobRecord = {
      ...approvedJob(),
      archived_at: archivedAt,
      updated_at: "2026-07-10T00:03:00Z",
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{
        id: savedJob.id,
        job: savedJob,
        savedAt: archivedAt,
      }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    fetchMock().mockResolvedValueOnce(jsonResponse(reapprovedJob));
    render(<App />);
    const user = userEvent.setup();

    expect(within(screen.getByRole("button", {
      name: "Reopen history item 1",
    })).getByText("raise")).toBeInTheDocument();
    await user.click(screen.getByRole("button", {
      name: "Reopen history item 1",
    }));
    await user.click(screen.getByRole("button", { name: "Reset to parser" }));
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    const updatedHistoryItem = screen.getByRole("button", {
      name: "Reopen history item 1",
    });
    await waitFor(() => expect(within(updatedHistoryItem).getByText("approved")).toBeInTheDocument());
    expect(within(updatedHistoryItem).queryByText("raise")).not.toBeInTheDocument();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-history-v1"),
    ))[0].job).toMatchObject({
      status: "approved",
      recommendation: null,
      updated_at: "2026-07-10T00:03:00Z",
    });
  });

  it("keeps a newer reopened hand when an older history refresh finishes", async () => {
    const archivedAt = "2026-07-10T00:02:00Z";
    const staleJob: JobRecord = {
      ...recommendedJob(),
      archived_at: archivedAt,
      updated_at: "2026-07-10T00:01:00Z",
    };
    const reapprovedJob: JobRecord = {
      ...approvedJob(),
      archived_at: archivedAt,
      updated_at: "2026-07-10T00:03:00Z",
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{
        id: staleJob.id,
        job: staleJob,
        savedAt: archivedAt,
      }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    window.sessionStorage.removeItem("poker-training-history-synced");
    const pendingHistory = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingHistory.promise)
      .mockResolvedValueOnce(jsonResponse(reapprovedJob));
    render(<App />);
    const user = userEvent.setup();

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", {
      name: "Reopen history item 1",
    }));
    await user.click(screen.getByRole("button", { name: "Reset to parser" }));
    await user.click(screen.getByRole("button", { name: "Approve state" }));
    await waitFor(() => expect(within(screen.getByRole("button", {
      name: "Reopen history item 1",
    })).getByText("approved")).toBeInTheDocument());

    pendingHistory.resolve(jsonResponse({
      total: 1,
      jobs: [staleJob],
    }));

    await waitFor(() => expect(screen.getByRole("button", {
      name: "Refresh saved history",
    })).toBeEnabled());
    const historyItem = screen.getByRole("button", {
      name: "Reopen history item 1",
    });
    expect(within(historyItem).getByText("approved")).toBeInTheDocument();
    expect(within(historyItem).queryByText("raise")).not.toBeInTheDocument();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-history-v1"),
    ))[0].job).toMatchObject({
      status: "approved",
      recommendation: null,
      updated_at: "2026-07-10T00:03:00Z",
    });
  });

  it("restores persisted history when the browser has no local cache", async () => {
    window.localStorage.removeItem("poker-training-history-v1");
    window.sessionStorage.removeItem("poker-training-history-synced");
    const savedJob: JobRecord = {
      ...recommendedJob(canonicalState({
        hero_cards: [
          { rank: "Q", suit: "clubs" },
          { rank: "Q", suit: "hearts" },
        ],
      })),
      id: "server-history-job",
      original_filename: "server-history.png",
      archived_at: "2026-07-10T00:02:00Z",
    };
    fetchMock().mockResolvedValueOnce(jsonResponse({
      total: 3,
      jobs: [savedJob],
    }));

    render(<App />);

    const historyItem = await screen.findByRole("button", {
      name: "Reopen history item 1",
    });
    expect(within(historyItem).getByText("Q♣")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Session status")).getByText("3")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/history",
      { credentials: "include" },
    );
    expect(JSON.parse(
      String(window.localStorage.getItem("poker-training-history-v1")),
    )).toHaveLength(1);
  });

  it("preserves the complete persisted history count across same-tab reloads", async () => {
    window.localStorage.removeItem("poker-training-history-v1");
    window.sessionStorage.removeItem("poker-training-history-synced");
    const savedJobs = Array.from({ length: 24 }, (_, index): JobRecord => ({
      ...recommendedJob(),
      id: `server-history-${index}`,
      original_filename: `server-history-${index}.png`,
      archived_at: `2026-07-10T00:${String(index).padStart(2, "0")}:00Z`,
    }));
    fetchMock().mockResolvedValueOnce(jsonResponse({
      total: 31,
      jobs: savedJobs,
    }));

    const firstRender = render(<App />);
    expect(await within(screen.getByLabelText("Session status")).findByText("31")).toBeInTheDocument();
    expect(window.localStorage.getItem("poker-training-history-total-v1")).toBe("31");
    firstRender.unmount();

    render(<App />);

    expect(within(screen.getByLabelText("Session status")).getByText("31")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("loads older persisted history without expanding the local cache", async () => {
    window.localStorage.removeItem("poker-training-history-v1");
    window.sessionStorage.removeItem("poker-training-history-synced");
    const savedJobs = Array.from({ length: 31 }, (_, index): JobRecord => ({
      ...recommendedJob(),
      id: `paged-history-${index}`,
      original_filename: `paged-history-${index}.png`,
      archived_at: `2026-07-${String(31 - index).padStart(2, "0")}T00:00:00Z`,
    }));
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        total: 31,
        jobs: savedJobs.slice(0, 24),
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 31,
        jobs: savedJobs.slice(24),
      }));
    render(<App />);
    const user = userEvent.setup();

    const loadOlder = await screen.findByRole("button", {
      name: "Load older history",
    });
    expect(loadOlder).toHaveTextContent("Load 7 older");
    await user.click(loadOlder);

    expect(await screen.findByRole("button", {
      name: "Reopen history item 31",
    })).toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: "Load older history",
    })).not.toBeInTheDocument();
    expect(fetchMock()).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8000/api/history?offset=24",
      { credentials: "include" },
    );
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-history-v1"),
    ))).toHaveLength(24);
  });

  it("searches and pages archived hands without replacing the newest-page cache", async () => {
    const archivedAt = "2026-07-10T00:02:00Z";
    const cachedJob: JobRecord = {
      ...recommendedJob(),
      id: "cached-history-job",
      archived_at: archivedAt,
    };
    const firstMatch: JobRecord = {
      ...recommendedJob(canonicalState({
        hero_cards: [
          { rank: "Q", suit: "clubs" },
          { rank: "Q", suit: "hearts" },
        ],
        street: "turn",
      })),
      id: "matching-history-1",
      original_filename: "turn-bluff-1.png",
      archived_at: "2026-07-09T00:00:00Z",
    };
    const secondMatch: JobRecord = {
      ...recommendedJob(canonicalState({
        hero_cards: [
          { rank: "7", suit: "diamonds" },
          { rank: "9", suit: "clubs" },
        ],
        street: "turn",
      })),
      id: "matching-history-2",
      original_filename: "turn-bluff-2.png",
      archived_at: "2026-07-08T00:00:00Z",
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{
        id: cachedJob.id,
        job: cachedJob,
        savedAt: archivedAt,
      }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        total: 2,
        jobs: [firstMatch],
        snapshot_version: "stable-search",
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 2,
        jobs: [secondMatch],
        snapshot_version: "stable-search",
      }));
    render(<App />);
    const user = userEvent.setup();
    const historyPanel = screen.getByLabelText("Session history");

    await user.click(within(historyPanel).getByRole("button", {
      name: "Search saved history",
    }));
    await user.type(within(historyPanel).getByLabelText(
      "History search query",
    ), "turn bluff");
    await user.click(within(historyPanel).getByRole("button", {
      name: "Run history search",
    }));

    expect(await within(historyPanel).findByText("Q♣")).toBeInTheDocument();
    expect(within(historyPanel).getByText(/2 matches/)).toBeInTheDocument();
    expect(within(historyPanel).getByRole("button", {
      name: "Load older history",
    })).toHaveTextContent("Load 1 older");
    await user.click(within(historyPanel).getByRole("button", {
      name: "Load older history",
    }));

    expect(await within(historyPanel).findByText("7♦")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenNthCalledWith(
      1,
      "http://localhost:8000/api/history?query=turn+bluff",
      { credentials: "include" },
    );
    expect(fetchMock()).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8000/api/history?offset=1&query=turn+bluff",
      { credentials: "include" },
    );
    expect(within(screen.getByLabelText("Session status")).getByText("1")).toBeInTheDocument();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-history-v1"),
    ))[0].id).toBe(cachedJob.id);

    await user.click(within(historyPanel).getByRole("button", {
      name: "Close history search",
    }));

    expect(within(historyPanel).getByText("A♥")).toBeInTheDocument();
    expect(within(historyPanel).queryByText("Q♣")).not.toBeInTheDocument();
  });

  it("polls a pending archived recommendation returned only by history search", async () => {
    const cachedJob: JobRecord = {
      ...recommendedJob(),
      id: "cached-search-anchor",
      archived_at: "2026-07-10T00:00:00Z",
    };
    const pendingJob: JobRecord = {
      ...approvedJob(),
      id: "search-only-pending-job",
      original_filename: "search-only-pending.png",
      recommendation_pending: true,
      archived_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:01:00Z",
    };
    const completedJob: JobRecord = {
      ...pendingJob,
      status: "recommended",
      recommendation_pending: false,
      recommendation,
      updated_at: "2026-06-01T00:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{
        id: cachedJob.id,
        job: cachedJob,
        savedAt: cachedJob.archived_at,
      }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [pendingJob],
        snapshot_version: "pending-search-result",
      }))
      .mockResolvedValueOnce(jsonResponse(completedJob));
    render(<App />);
    const user = userEvent.setup();
    const historyPanel = screen.getByLabelText("Session history");

    await user.click(within(historyPanel).getByRole("button", {
      name: "Search saved history",
    }));
    await user.type(within(historyPanel).getByLabelText(
      "History search query",
    ), "pending");
    await user.click(within(historyPanel).getByRole("button", {
      name: "Run history search",
    }));
    await user.click(await screen.findByRole("button", {
      name: "Reopen history item 1",
    }));

    expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeDisabled();
    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(screen.getByText(recommendation.explanation)).toBeInTheDocument();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/history?query=pending",
      `http://localhost:8000/api/jobs/${pendingJob.id}`,
    ]);
  });

  it("restores a lost archived write response by ID outside the newest history page", async () => {
    const cachedJob: JobRecord = {
      ...recommendedJob(),
      id: "newest-history-anchor",
      archived_at: "2026-07-10T00:00:00Z",
    };
    const targetJob = jobRecord({
      id: "older-search-write-target",
      original_filename: "older-search-write-target.png",
      archived_at: "2026-06-01T00:00:00Z",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:01:00Z",
    });
    const persistedJob: JobRecord = {
      ...targetJob,
      status: "approved",
      approved_state: canonicalState({ pot_size: 20 }),
      updated_at: "2026-06-01T00:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{
        id: cachedJob.id,
        job: cachedJob,
        savedAt: cachedJob.archived_at,
      }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [targetJob],
        snapshot_version: "older-write-target",
      }))
      .mockRejectedValueOnce(new TypeError("Connection lost after archived approval"))
      .mockRejectedValueOnce(new TypeError("Temporary archived job restore failure"))
      .mockResolvedValueOnce(jsonResponse(persistedJob));
    render(<App />);
    const user = userEvent.setup();
    const historyPanel = screen.getByLabelText("Session history");

    await user.click(within(historyPanel).getByRole("button", {
      name: "Search saved history",
    }));
    await user.type(within(historyPanel).getByLabelText(
      "History search query",
    ), "older target");
    await user.click(within(historyPanel).getByRole("button", {
      name: "Run history search",
    }));
    await user.click(await screen.findByRole("button", {
      name: "Reopen history item 1",
    }));
    const potInput = await screen.findByDisplayValue("12.5");
    await user.clear(potInput);
    await user.type(potInput, "20");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    expect(await screen.findByText(
      "Connection lost after archived approval",
    )).toBeInTheDocument();
    expect(await screen.findByDisplayValue("20")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Approve state",
    })).toBeDisabled());
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/history?query=older+target",
      `http://localhost:8000/api/jobs/${targetJob.id}/approve`,
      `http://localhost:8000/api/jobs/${targetJob.id}`,
      `http://localhost:8000/api/jobs/${targetJob.id}`,
    ]);
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-history-v1"),
    ))[0].id).toBe(cachedJob.id);
  });

  it("completes a queued full history restore after targeted archived recovery", async () => {
    const targetJob = jobRecord({
      id: "queued-full-restore-target",
      original_filename: "queued-full-restore-target.png",
      archived_at: "2026-06-01T00:00:00Z",
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:01:00Z",
    });
    const persistedTarget: JobRecord = {
      ...targetJob,
      status: "approved",
      approved_state: canonicalState({ pot_size: 20 }),
      updated_at: "2026-06-01T00:02:00Z",
    };
    const staleSibling: JobRecord = {
      ...recommendedJob(),
      id: "stale-history-sibling",
      original_filename: "stale-history-sibling.png",
      archived_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    };
    const refreshedSibling: JobRecord = {
      ...staleSibling,
      original_filename: "refreshed-history-sibling.png",
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([
        {
          id: targetJob.id,
          job: targetJob,
          savedAt: targetJob.archived_at,
        },
        {
          id: staleSibling.id,
          job: staleSibling,
          savedAt: staleSibling.archived_at,
        },
      ]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "2");
    window.sessionStorage.removeItem("poker-training-history-synced");
    const pendingFullRestore = deferredResponse();
    const pendingTargetRestore = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingFullRestore.promise)
      .mockRejectedValueOnce(new TypeError("Connection lost after archived approval"))
      .mockReturnValueOnce(pendingTargetRestore.promise)
      .mockResolvedValueOnce(jsonResponse({
        total: 2,
        jobs: [refreshedSibling, persistedTarget],
        snapshot_version: "reconciled-full-history",
      }));
    render(<App />);
    const user = userEvent.setup();

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/history",
      { credentials: "include" },
    ));
    await user.click(screen.getByRole("button", {
      name: "Reopen history item 1",
    }));
    const potInput = await screen.findByDisplayValue("12.5");
    await user.clear(potInput);
    await user.type(potInput, "20");
    await user.click(screen.getByRole("button", { name: "Approve state" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenNthCalledWith(
      3,
      `http://localhost:8000/api/jobs/${targetJob.id}`,
      { credentials: "include" },
    ));

    await act(async () => {
      pendingFullRestore.resolve(jsonResponse({
        total: 1,
        jobs: [targetJob],
        snapshot_version: "invalidated-full-history",
      }));
      await pendingFullRestore.promise;
    });
    expect(window.sessionStorage.getItem(
      "poker-training-history-synced",
    )).toBeNull();

    await act(async () => {
      pendingTargetRestore.resolve(jsonResponse(persistedTarget));
      await pendingTargetRestore.promise;
    });

    await waitFor(() => expect(fetchMock()).toHaveBeenNthCalledWith(
      4,
      "http://localhost:8000/api/history",
      { credentials: "include" },
    ));
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-history-v1"),
    )).map((item: { job: JobRecord }) => item.job.original_filename)).toEqual([
      "refreshed-history-sibling.png",
      "queued-full-restore-target.png",
    ]));
    expect(window.sessionStorage.getItem(
      "poker-training-history-synced",
    )).toBe("true");
    expect(screen.getByRole("button", { name: "Approve state" })).toBeDisabled();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/history",
      `http://localhost:8000/api/jobs/${targetJob.id}/approve`,
      `http://localhost:8000/api/jobs/${targetJob.id}`,
      "http://localhost:8000/api/history",
    ]);
  });

  it("revalidates the active history search after an archived hand changes", async () => {
    const archivedAt = "2026-07-10T00:02:00Z";
    const savedJob: JobRecord = {
      ...recommendedJob(),
      archived_at: archivedAt,
    };
    const reapprovedJob: JobRecord = {
      ...approvedJob(),
      archived_at: archivedAt,
      updated_at: "2026-07-10T00:03:00Z",
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{
        id: savedJob.id,
        job: savedJob,
        savedAt: archivedAt,
      }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [savedJob],
        snapshot_version: "before-approval",
      }))
      .mockResolvedValueOnce(jsonResponse(reapprovedJob))
      .mockResolvedValueOnce(jsonResponse({
        total: 0,
        jobs: [],
        snapshot_version: "after-approval",
      }));
    render(<App />);
    const user = userEvent.setup();
    const historyPanel = screen.getByLabelText("Session history");

    await user.click(within(historyPanel).getByRole("button", {
      name: "Search saved history",
    }));
    await user.type(within(historyPanel).getByLabelText(
      "History search query",
    ), "raise");
    await user.click(within(historyPanel).getByRole("button", {
      name: "Run history search",
    }));
    await user.click(await within(historyPanel).findByRole("button", {
      name: "Reopen history item 1",
    }));
    await user.click(screen.getByRole("button", { name: "Reset to parser" }));
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    expect(await within(historyPanel).findByText(
      "No saved hands match this search.",
    )).toBeInTheDocument();
    expect(within(historyPanel).getByText(/0 matches/)).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenNthCalledWith(
      3,
      "http://localhost:8000/api/history?query=raise&limit=24",
      { credentials: "include" },
    );
    const reviewedStat = within(screen.getByLabelText("Session status"))
      .getByText("reviewed")
      .closest(".toolbar-stat");
    expect(reviewedStat).not.toBeNull();
    expect(within(reviewedStat as HTMLElement).getByText("1")).toBeInTheDocument();
  });

  it("preserves loaded search pages when an archived hand changes", async () => {
    const savedJobs = Array.from({ length: 25 }, (_, index): JobRecord => ({
      ...recommendedJob(),
      id: `searched-history-${index}`,
      original_filename: `searched-history-${index}.png`,
      archived_at: `2026-07-${String(25 - index).padStart(2, "0")}T00:00:00Z`,
    }));
    const lastJob = savedJobs[24];
    const reapprovedLastJob: JobRecord = {
      ...approvedJob(),
      id: lastJob.id,
      original_filename: lastJob.original_filename,
      archived_at: lastJob.archived_at,
      updated_at: "2026-07-26T00:00:00Z",
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        total: 25,
        jobs: savedJobs.slice(0, 24),
        snapshot_version: "before-approval",
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 25,
        jobs: savedJobs.slice(24),
        snapshot_version: "before-approval",
      }))
      .mockResolvedValueOnce(jsonResponse(reapprovedLastJob))
      .mockResolvedValueOnce(jsonResponse({
        total: 25,
        jobs: [...savedJobs.slice(0, 24), reapprovedLastJob],
        snapshot_version: "after-approval",
      }));
    render(<App />);
    const user = userEvent.setup();
    const historyPanel = screen.getByLabelText("Session history");

    await user.click(within(historyPanel).getByRole("button", {
      name: "Search saved history",
    }));
    await user.type(within(historyPanel).getByLabelText(
      "History search query",
    ), "flop");
    await user.click(within(historyPanel).getByRole("button", {
      name: "Run history search",
    }));
    await user.click(await within(historyPanel).findByRole("button", {
      name: "Load older history",
    }));
    await user.click(await within(historyPanel).findByRole("button", {
      name: "Reopen history item 25",
    }));
    await user.click(screen.getByRole("button", { name: "Reset to parser" }));
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    const lastHistoryItem = await within(historyPanel).findByRole("button", {
      name: "Reopen history item 25",
    });
    expect(within(lastHistoryItem).getByText("approved")).toBeInTheDocument();
    expect(within(historyPanel).getByText(/25 matches/)).toBeInTheDocument();
    expect(within(historyPanel).queryByRole("button", {
      name: "Load older history",
    })).not.toBeInTheDocument();
    expect(fetchMock()).toHaveBeenNthCalledWith(
      4,
      "http://localhost:8000/api/history?query=flop&limit=25",
      { credentials: "include" },
    );
  });

  it("preserves loaded search pages when the matching total changes", async () => {
    const savedJobs = Array.from({ length: 50 }, (_, index): JobRecord => ({
      ...recommendedJob(),
      id: `changing-search-history-${index}`,
      original_filename: `changing-search-history-${index}.png`,
      archived_at: `2026-07-25T00:${String(49 - index).padStart(2, "0")}:00Z`,
    }));
    const newJob: JobRecord = {
      ...recommendedJob(),
      id: "new-search-history-job",
      original_filename: "new-search-history-job.png",
      archived_at: "2026-07-26T00:00:00Z",
    };
    const updatedJobs = [newJob, ...savedJobs];
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        total: 50,
        jobs: savedJobs.slice(0, 24),
        snapshot_version: "before-membership-change",
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 50,
        jobs: savedJobs.slice(24, 48),
        snapshot_version: "before-membership-change",
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 51,
        jobs: updatedJobs.slice(48),
        snapshot_version: "after-membership-change",
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 51,
        jobs: updatedJobs,
        snapshot_version: "after-membership-change",
      }));
    render(<App />);
    const user = userEvent.setup();
    const historyPanel = screen.getByLabelText("Session history");

    await user.click(within(historyPanel).getByRole("button", {
      name: "Search saved history",
    }));
    await user.type(within(historyPanel).getByLabelText(
      "History search query",
    ), "flop");
    await user.click(within(historyPanel).getByRole("button", {
      name: "Run history search",
    }));
    await user.click(await within(historyPanel).findByRole("button", {
      name: "Load older history",
    }));

    expect(await within(historyPanel).findByRole("button", {
      name: "Reopen history item 48",
    })).toBeInTheDocument();
    await user.click(within(historyPanel).getByRole("button", {
      name: "Load older history",
    }));

    expect(await within(historyPanel).findByRole("button", {
      name: "Reopen history item 51",
    })).toBeInTheDocument();
    expect(within(historyPanel).getByText(/51 matches/)).toBeInTheDocument();
    expect(within(historyPanel).queryByRole("button", {
      name: "Load older history",
    })).not.toBeInTheDocument();
    expect(fetchMock()).toHaveBeenNthCalledWith(
      4,
      "http://localhost:8000/api/history?query=flop&limit=51",
      { credentials: "include" },
    );
  });

  it("rebuilds loaded search pages when membership shifts at the same total", async () => {
    const savedJobs = Array.from({ length: 50 }, (_, index): JobRecord => ({
      ...recommendedJob(),
      id: `stable-search-membership-${index}`,
      original_filename: `stable-search-membership-${index}.png`,
      archived_at: `2026-07-25T00:${String(49 - index).padStart(2, "0")}:00Z`,
    }));
    const newMatch: JobRecord = {
      ...recommendedJob(canonicalState({
        hero_cards: [
          { rank: "Q", suit: "clubs" },
          { rank: "Q", suit: "hearts" },
        ],
      })),
      id: "new-search-membership",
      original_filename: "new-search-membership.png",
      archived_at: "2026-07-26T00:00:00Z",
    };
    const updatedJobs = [newMatch, ...savedJobs.slice(0, 49)];
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        total: 50,
        jobs: savedJobs.slice(0, 24),
        snapshot_version: "before-membership-change",
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 50,
        jobs: updatedJobs.slice(24, 48),
        snapshot_version: "after-membership-change",
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 50,
        jobs: updatedJobs.slice(0, 48),
        snapshot_version: "after-membership-change",
      }));
    render(<App />);
    const user = userEvent.setup();
    const historyPanel = screen.getByLabelText("Session history");

    await user.click(within(historyPanel).getByRole("button", {
      name: "Search saved history",
    }));
    await user.type(within(historyPanel).getByLabelText(
      "History search query",
    ), "flop");
    await user.click(within(historyPanel).getByRole("button", {
      name: "Run history search",
    }));
    await user.click(await within(historyPanel).findByRole("button", {
      name: "Load older history",
    }));

    expect(await within(historyPanel).findByText("Q♣")).toBeInTheDocument();
    expect(within(historyPanel).getByRole("button", {
      name: "Reopen history item 48",
    })).toBeInTheDocument();
    expect(within(historyPanel).getByRole("button", {
      name: "Load older history",
    })).toHaveTextContent("Load 2 older");
    expect(fetchMock()).toHaveBeenCalledTimes(3);
    expect(fetchMock()).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8000/api/history?offset=24&query=flop",
      { credentials: "include" },
    );
    expect(fetchMock()).toHaveBeenNthCalledWith(
      3,
      "http://localhost:8000/api/history?query=flop&limit=48",
      { credentials: "include" },
    );
  });

  it("clears a paged search when its changed snapshot has no matches", async () => {
    const savedJobs = Array.from({ length: 25 }, (_, index): JobRecord => ({
      ...recommendedJob(),
      id: `removed-search-history-${index}`,
      original_filename: `removed-search-history-${index}.png`,
      archived_at: `2026-07-${String(25 - index).padStart(2, "0")}T00:00:00Z`,
    }));
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        total: 25,
        jobs: savedJobs.slice(0, 24),
        snapshot_version: "before-removal",
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 0,
        jobs: [],
        snapshot_version: "after-removal",
      }));
    render(<App />);
    const user = userEvent.setup();
    const historyPanel = screen.getByLabelText("Session history");

    await user.click(within(historyPanel).getByRole("button", {
      name: "Search saved history",
    }));
    await user.type(within(historyPanel).getByLabelText(
      "History search query",
    ), "flop");
    await user.click(within(historyPanel).getByRole("button", {
      name: "Run history search",
    }));
    await user.click(await within(historyPanel).findByRole("button", {
      name: "Load older history",
    }));

    expect(await within(historyPanel).findByText(
      "No saved hands match this search.",
    )).toBeInTheDocument();
    expect(within(historyPanel).getByText(/0 matches/)).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(fetchMock()).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8000/api/history?offset=24&query=flop",
      { credentials: "include" },
    );
  });

  it("restarts history pagination when the archived total changes between pages", async () => {
    window.localStorage.removeItem("poker-training-history-v1");
    window.sessionStorage.removeItem("poker-training-history-synced");
    const savedJobs = Array.from({ length: 31 }, (_, index): JobRecord => ({
      ...recommendedJob(),
      id: `stable-history-${index}`,
      original_filename: `stable-history-${index}.png`,
      archived_at: `2026-07-${String(31 - index).padStart(2, "0")}T00:00:00Z`,
    }));
    const newJob: JobRecord = {
      ...recommendedJob(),
      id: "new-history-job",
      original_filename: "new-history-job.png",
      archived_at: "2026-08-01T00:00:00Z",
    };
    const updatedJobs = [newJob, ...savedJobs];
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        total: 31,
        jobs: savedJobs.slice(0, 24),
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 32,
        jobs: updatedJobs.slice(24),
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 32,
        jobs: updatedJobs.slice(0, 24),
      }))
      .mockResolvedValueOnce(jsonResponse({
        total: 32,
        jobs: updatedJobs.slice(24),
      }));
    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", {
      name: "Load older history",
    }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(3));
    expect(fetchMock()).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8000/api/history?offset=24",
      { credentials: "include" },
    );
    expect(fetchMock()).toHaveBeenNthCalledWith(
      3,
      "http://localhost:8000/api/history",
      { credentials: "include" },
    );
    expect(screen.getByRole("button", {
      name: "Load older history",
    })).toHaveTextContent("Load 8 older");

    await user.click(screen.getByRole("button", {
      name: "Load older history",
    }));

    expect(await screen.findByRole("button", {
      name: "Reopen history item 32",
    })).toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: "Load older history",
    })).not.toBeInTheDocument();
    expect(fetchMock()).toHaveBeenNthCalledWith(
      4,
      "http://localhost:8000/api/history?offset=24",
      { credentials: "include" },
    );
  });

  it("reloads persisted history when local caching failed but session storage is available", async () => {
    window.localStorage.removeItem("poker-training-history-v1");
    window.sessionStorage.removeItem("poker-training-history-synced");
    const savedJob: JobRecord = {
      ...recommendedJob(),
      id: "quota-history-job",
      original_filename: "quota-history.png",
      archived_at: "2026-07-10T00:05:00Z",
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ total: 1, jobs: [savedJob] }))
      .mockResolvedValueOnce(jsonResponse({ total: 1, jobs: [savedJob] }));
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(
      this: Storage,
      key: string,
      value: string,
    ) {
      if (this === window.localStorage) {
        throw new DOMException("Local storage quota exceeded", "QuotaExceededError");
      }
      originalSetItem.call(this, key, value);
    });

    const firstRender = render(<App />);
    expect(await screen.findByRole("button", {
      name: "Reopen history item 1",
    })).toBeInTheDocument();
    expect(window.sessionStorage.getItem("poker-training-history-synced")).toBeNull();
    firstRender.unmount();

    render(<App />);

    expect(await screen.findByRole("button", {
      name: "Reopen history item 1",
    })).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing", null],
    ["unreadable", "{not-json"],
  ])("reloads persisted history when the local cache is %s", async (_label, cachedValue) => {
    if (cachedValue === null) {
      window.localStorage.removeItem("poker-training-history-v1");
    } else {
      window.localStorage.setItem("poker-training-history-v1", cachedValue);
    }
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    window.sessionStorage.setItem("poker-training-history-synced", "true");
    const savedJob: JobRecord = {
      ...recommendedJob(),
      id: "recovered-history-job",
      original_filename: "recovered-history.png",
      archived_at: "2026-07-10T00:06:00Z",
    };
    fetchMock().mockResolvedValueOnce(jsonResponse({
      total: 1,
      jobs: [savedJob],
    }));

    render(<App />);

    expect(await screen.findByRole("button", {
      name: "Reopen history item 1",
    })).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/history",
      { credentials: "include" },
    );
  });

  it("refreshes saved history from the backend", async () => {
    const savedJob: JobRecord = {
      ...recommendedJob(),
      id: "refreshed-history-job",
      original_filename: "refreshed.png",
      archived_at: "2026-07-10T00:03:00Z",
    };
    fetchMock().mockResolvedValueOnce(jsonResponse({
      total: 1,
      jobs: [savedJob],
    }));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Refresh saved history" }));

    expect(await screen.findByRole("button", {
      name: "Reopen history item 1",
    })).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/history",
      { credentials: "include" },
    );
  });

  it("migrates legacy local history into persisted history", async () => {
    const jobId = "a".repeat(32);
    const legacyJob: JobRecord = {
      ...recommendedJob(),
      id: jobId,
      original_filename: "legacy.png",
      archived_at: null,
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{
        id: jobId,
        job: legacyJob,
        savedAt: "2026-07-10T00:00:00Z",
      }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    window.sessionStorage.removeItem("poker-training-history-synced");
    window.localStorage.removeItem("poker-training-processing-v1");
    window.localStorage.removeItem("poker-training-processing-total-v1");
    window.sessionStorage.removeItem("poker-training-processing-synced");
    const pendingMigration = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingMigration.promise)
      .mockResolvedValueOnce(jsonResponse({
        total: 0,
        jobs: [],
        snapshot_version: "post-migration-processing",
      }));

    render(<App />);

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/history",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ job_ids: [jobId] }),
      }),
    ));
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    pendingMigration.resolve(jsonResponse({
      total: 1,
      jobs: [{
        ...legacyJob,
        archived_at: "2026-07-10T00:04:00Z",
      }],
    }));

    await waitFor(() => expect(fetchMock()).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    expect(screen.getByRole("button", {
      name: "Reopen history item 1",
    })).toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: legacy.png",
    })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem("poker-training-history-synced")).toBe("true");
    expect(window.sessionStorage.getItem("poker-training-processing-synced")).toBe("true");
  });

  it("shows normalized decision evidence for solver recommendations", async () => {
    const evidenceJob: JobRecord = {
      ...recommendedJob(),
      id: "evidence-job",
      original_filename: "evidence.png",
      image_filename: "evidence.png",
      recommendation: recommendationWithEvidence,
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{ id: evidenceJob.id, job: evidenceJob, savedAt: new Date().toISOString() }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Reopen history item 1" }));

    const evidence = await screen.findByLabelText("Decision evidence");
    expect(within(evidence).getByText("Local EV solver")).toBeInTheDocument();
    expect(within(evidence).getByText("Postflop solver fallback")).toBeInTheDocument();
    expect(within(evidence).getByText("61%")).toBeInTheDocument();
    expect(within(evidence).getByText("55%")).toBeInTheDocument();
    expect(within(evidence).getByText("20%")).toBeInTheDocument();
    expect(within(evidence).getByText("EV 2.4 BB")).toBeInTheDocument();
    expect(within(evidence).getByText("72% frequency")).toBeInTheDocument();
    const chosen = within(evidence).getByText("Chosen").closest('[role="listitem"]');
    expect(chosen).toHaveTextContent("raise");
    expect(chosen).toHaveTextContent("7.5 BB");
    expect(within(evidence).getAllByRole("listitem")).toHaveLength(4);
    expect(within(evidence).queryByText("invalid")).not.toBeInTheDocument();
    expect(within(evidence).queryByLabelText("Decision context")).not.toBeInTheDocument();
    expect(within(evidence).queryByLabelText("Modeled ranges")).not.toBeInTheDocument();
  });

  it("shows postflop tree assumptions and expandable ranges", async () => {
    const longOopRange = `${"AA,".repeat(90)}AKs`;
    const postflopJob: JobRecord = {
      ...recommendedJob(),
      id: "postflop-solver-job",
      original_filename: "postflop.png",
      image_filename: "postflop.png",
      recommendation: {
        action: "call",
        sizing: null,
        confidence: 0.81,
        explanation: "The postflop solver recommends calling at 64% frequency.",
        raw: {
          provider: "local_solver",
          engine: "postflop_solver",
          hero_position: "ip",
          modeled_history: ["OOP bet 2.50 BB"],
          tree: {
            starting_pot: 10,
            effective_stack: 95,
            compressed_memory_mb: 34.6,
            max_iterations: 400,
            target_exploitability_ratio: 0.01,
          },
          ranges: {
            oop: longOopRange,
            ip: "QQ-22,AQs-A2s,ATo+",
          },
          exploitability: { bb: 0.12 },
          candidates: [
            { action: "fold", sizing: null, frequency: 0.1, ev: 0 },
            { action: "call", sizing: null, frequency: 0.64, ev: 2.4 },
            { action: "raise", sizing: 8, frequency: 0.26, ev: 2.1 },
          ],
        },
      },
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{ id: postflopJob.id, job: postflopJob, savedAt: new Date().toISOString() }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Reopen history item 1" }));

    const evidence = await screen.findByLabelText("Decision evidence");
    expect(within(evidence).getByText("Postflop solver")).toBeInTheDocument();
    expect(within(evidence).getByText("0.12 BB")).toBeInTheDocument();
    const decisionContext = within(evidence).getByLabelText("Decision context");
    expect(within(decisionContext).getByText("IP")).toBeInTheDocument();
    expect(within(decisionContext).getByText("OOP bet 2.50 BB")).toBeInTheDocument();
    expect(within(decisionContext).getByText("10 BB pot · 95 BB stack")).toBeInTheDocument();
    expect(within(decisionContext).getByText("400 iterations · 34.6 MB estimate")).toBeInTheDocument();
    expect(within(decisionContext).getByText("1% pot exploitability")).toBeInTheDocument();

    const modeledRanges = within(evidence).getByLabelText("Modeled ranges");
    expect(modeledRanges).not.toHaveAttribute("open");
    await user.click(within(modeledRanges).getByText("Modeled ranges"));
    expect(modeledRanges).toHaveAttribute("open");
    expect(within(modeledRanges).getByText(longOopRange)).toBeVisible();
    expect(within(modeledRanges).getByText("QQ-22,AQs-A2s,ATo+")).toBeVisible();
  });

  it("omits malformed postflop context while preserving valid evidence", async () => {
    const malformedJob: JobRecord = {
      ...recommendedJob(),
      id: "malformed-postflop-job",
      original_filename: "malformed.png",
      image_filename: "malformed.png",
      recommendation: {
        action: "check",
        sizing: null,
        confidence: 0.7,
        explanation: "Check remains available.",
        raw: {
          provider: "local_solver",
          engine: "postflop_solver",
          hero_position: "button",
          modeled_history: "OOP check",
          tree: {
            starting_pot: -1,
            effective_stack: -2,
            compressed_memory_mb: -1,
            max_iterations: 2.5,
            target_exploitability_ratio: 4,
          },
          ranges: { oop: 42, ip: "" },
          candidates: [{ action: "check", sizing: null, frequency: 1 }],
        },
      },
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{ id: malformedJob.id, job: malformedJob, savedAt: new Date().toISOString() }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Reopen history item 1" }));

    const evidence = await screen.findByLabelText("Decision evidence");
    expect(within(evidence).getByText("Postflop solver")).toBeInTheDocument();
    expect(within(evidence).getByText("100% frequency")).toBeInTheDocument();
    expect(within(evidence).queryByLabelText("Decision context")).not.toBeInTheDocument();
    expect(within(evidence).queryByLabelText("Modeled ranges")).not.toBeInTheDocument();
  });

  it("labels position-aware chart evidence without exposing its internal id", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "preflop-chart-job",
      original_filename: "preflop.png",
      image_filename: "preflop.png",
      recommendation: {
        action: "raise",
        sizing: 2.5,
        confidence: 0.74,
        explanation: "The position-aware preflop chart recommends raise to 2.5 BB.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          requested_engine: "postflop_solver",
          routing_reason: "the hand is preflop",
          hand_top_fraction: 0.28,
          policy_fraction: 0.45,
          stack_depth_policy: "standard",
          effective_stack: 100,
          base_open_fraction: 0.45,
          open_fraction: 0.45,
          target_open_size: 2.5,
          candidates: [
            { action: "fold", sizing: null, frequency: 0 },
            { action: "call", sizing: null, frequency: 0 },
            { action: "raise", sizing: 2.5, frequency: 1 },
          ],
        },
      },
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{ id: chartJob.id, job: chartJob, savedAt: new Date().toISOString() }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Reopen history item 1" }));

    const evidence = await screen.findByLabelText("Decision evidence");
    expect(within(evidence).getByText("Preflop chart")).toBeInTheDocument();
    expect(within(evidence).getByText("Postflop solver route")).toBeInTheDocument();
    expect(within(evidence).queryByText("preflop_chart_v1")).not.toBeInTheDocument();
    expect(within(evidence).getByText("28%")).toBeInTheDocument();
    expect(within(evidence).getAllByText("45%")).toHaveLength(2);
    expect(within(evidence).getByText("100% frequency")).toBeInTheDocument();
    const chartContext = within(evidence).getByLabelText("Decision context");
    expect(within(chartContext).getByText("Standard · 100 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("Opening range")).toBeInTheDocument();
    expect(within(chartContext).getByText("Open target")).toBeInTheDocument();
    expect(within(chartContext).getByText("2.5 BB")).toBeInTheDocument();
  });

  it("shows stack-aware facing-open chart context", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "facing-open-chart-job",
      original_filename: "facing-open.png",
      image_filename: "facing-open.png",
      recommendation: {
        action: "raise",
        sizing: 3.6,
        confidence: 0.78,
        explanation: "The preflop chart recommends the stack-aware reraise line.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.1243,
          policy_fraction: 0.156,
          stack_depth_policy: "short",
          effective_stack: 20,
          opener_position: "button",
          base_opener_open_fraction: 0.45,
          opener_open_fraction: 0.405,
          opening_raise_size: 2.5,
          open_size_policy: "standard",
          continue_fraction: 0.36,
          reraise_fraction: 0.156,
          maximum_reraise_total: 3.6,
          candidates: [
            { action: "fold", sizing: null, frequency: 0.1 },
            { action: "call", sizing: null, frequency: 0.35 },
            { action: "raise", sizing: 3.6, frequency: 0.55 },
          ],
        },
      },
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{ id: chartJob.id, job: chartJob, savedAt: new Date().toISOString() }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Reopen history item 1" }));

    const evidence = await screen.findByLabelText("Decision evidence");
    const chartContext = within(evidence).getByLabelText("Decision context");
    expect(within(chartContext).getByText("Short · 20 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("Button · 40.5% modeled (base 45%)")).toBeInTheDocument();
    expect(within(chartContext).getByText("2.5 BB · Standard")).toBeInTheDocument();
    expect(within(chartContext).getByText("Continue 36% · Reraise 15.6%")).toBeInTheDocument();
    expect(within(chartContext).getByText("3.6 BB")).toBeInTheDocument();
  });

  it("displays backend upload errors as queue attention items", async () => {
    const validJob = jobRecord({ original_filename: "valid.png" });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(validJob, 201))
      .mockResolvedValueOnce(processingQueueResponse([validJob]))
      .mockResolvedValueOnce(jsonResponse({ detail: "Upload must contain supported image data" }, 400))
      .mockResolvedValueOnce(processingQueueResponse([validJob]));
    render(<App />);

    await uploadScreenshot("valid.png");
    expect(await screen.findByDisplayValue("Ah Kd")).toBeInTheDocument();
    expect(screen.getByAltText("Uploaded poker table screenshot")).toBeInTheDocument();

    await uploadScreenshot("broken.png");

    expect(await screen.findByText("1 screenshot need attention. Check the highlighted queue items.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open screenshot 1: valid.png" })).toBeInTheDocument();
    const failedItem = screen.getByRole("button", { name: "Open screenshot 2: broken.png" });
    expect(within(failedItem).getByText("error")).toBeInTheDocument();
    expect(within(failedItem).getByText("Upload must contain supported image data")).toBeInTheDocument();
  });

  it("sends corrected approval payload with user_approved forced true", async () => {
    const correctedState = canonicalState({ current_bet: 3.5 });
    const created = jobRecord();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob(correctedState)));
    render(<App />);

    const user = await uploadScreenshot();
    const currentBetInput = await screen.findByLabelText(/Current bet/);
    await user.clear(currentBetInput);
    await user.type(currentBetInput, "3.5");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(3));
    const approveOptions = fetchMock().mock.calls[2][1];
    const payload = JSON.parse(String(approveOptions?.body));

    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/jobs/job-123/approve");
    expect(payload.current_bet).toBe(3.5);
    expect(payload.facing_action).toBe("bet");
    expect(payload.user_approved).toBe(true);
  });

  it("submits structured opener context for preflop raise states", async () => {
    const preflopState: DetectedState = {
      ...detectedState,
      board_cards: [],
      pot_size: 4,
      current_bet: 1.5,
      hero_position: "big blind",
      street: "preflop",
      facing_action: "raise",
      action_context: "Hero faces 1.5 BB to call into a 4 BB pot",
    };
    const parsedJob = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: preflopState,
      },
    });
    const approvedState = canonicalState({
      ...preflopState,
      preflop_opener_position: "button",
      preflop_open_size: 2.5,
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(parsedJob, 201))
      .mockResolvedValueOnce(processingQueueResponse([parsedJob]))
      .mockResolvedValueOnce(jsonResponse(approvedJob(approvedState)));
    render(<App />);

    const user = await uploadScreenshot();
    await user.selectOptions(await screen.findByLabelText(/Opener position/), "button");
    await user.type(screen.getByLabelText(/Opening size/), "2.5");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(3));
    const payload = JSON.parse(String(fetchMock().mock.calls[2][1]?.body));
    expect(payload.preflop_opener_position).toBe("button");
    expect(payload.preflop_open_size).toBe(2.5);
  });

  it("adds an approved hand to ground truth and runs the parser benchmark", async () => {
    const pendingOverview = deferredResponse();
    const pendingInclusion = deferredResponse();
    const pendingBenchmark = deferredResponse();
    const benchmarkJob = { ...approvedJob(), benchmark_included: true };
    const benchmarkReport = {
      id: "benchmark-1",
      parser_provider: "ocr_cv",
      layout_profile: "fortuna",
      created_at: "2026-07-20T12:00:00Z",
      total_cases: 1,
      successful_cases: 1,
      failed_cases: 0,
      correct_fields: 9,
      evaluated_fields: 10,
      accuracy: 0.9,
      field_metrics: [{ field: "hero_cards", correct: 1, total: 1, accuracy: 1 }],
      cases: [
        {
          job_id: "job-123",
          original_filename: "table.png",
          status: "completed",
          correct_fields: 9,
          evaluated_fields: 10,
          accuracy: 0.9,
          warnings: [],
          error: null,
          comparisons: [
            {
              field: "pot_size",
              expected: 12.5,
              detected: 10,
              matched: false,
              confidence: 0.73,
            },
          ],
        },
      ],
    };
    const created = jobRecord();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()))
      .mockReturnValueOnce(pendingOverview.promise)
      .mockReturnValueOnce(pendingInclusion.promise)
      .mockReturnValueOnce(pendingBenchmark.promise)
      .mockResolvedValueOnce(jsonResponse({ included_cases: 1, latest_report: benchmarkReport }))
      .mockResolvedValueOnce(jsonResponse({ ...approvedJob(), benchmark_included: false }));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(screen.getByRole("button", { name: "Approve state" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Request recommendation" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    const groundTruthSwitch = within(dialog).getByRole("switch", { name: /Use current hand as ground truth/ });
    const exportDataset = within(dialog).getByRole("link", { name: "Export dataset" });
    const datasetInput = within(dialog).getByLabelText("Parser dataset ZIP");
    expect(groundTruthSwitch).toHaveAttribute("aria-checked", "false");
    expect(groundTruthSwitch).toBeDisabled();
    expect(datasetInput).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Run benchmark" })).toBeDisabled();
    expect(exportDataset).toHaveAttribute("aria-disabled", "true");
    expect(exportDataset).toHaveAttribute("href", "http://localhost:8000/api/benchmarks/export");

    pendingOverview.resolve(jsonResponse({ included_cases: 0, latest_report: null }));
    await waitFor(() => expect(groundTruthSwitch).toBeEnabled());
    expect(datasetInput).toBeEnabled();
    await user.click(groundTruthSwitch);
    expect(datasetInput).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Run benchmark" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Close parser benchmark" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeDisabled();
    pendingInclusion.resolve(jsonResponse(benchmarkJob));
    await waitFor(() => expect(groundTruthSwitch).toHaveAttribute("aria-checked", "true"));
    expect(datasetInput).toBeEnabled();
    expect(exportDataset).toHaveAttribute("aria-disabled", "false");
    expect(within(dialog).getByRole("button", { name: "Close parser benchmark" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
    const runBenchmark = within(dialog).getByRole("button", { name: "Run benchmark" });
    await waitFor(() => expect(runBenchmark).toBeEnabled());
    await user.click(runBenchmark);
    expect(groundTruthSwitch).toBeDisabled();
    expect(datasetInput).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Close parser benchmark" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeDisabled();
    pendingBenchmark.resolve(jsonResponse(benchmarkReport));

    expect(await within(dialog).findByLabelText("Benchmark summary")).toHaveTextContent("90%");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled());
    expect(within(dialog).getByText("hero cards")).toBeInTheDocument();
    expect(within(dialog).getByText("1 mismatch")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: "Reset to parser" }));
    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const reopenedDialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    const retainedGroundTruth = within(reopenedDialog).getByRole("switch", {
      name: /Use current hand as ground truth/,
    });
    expect(retainedGroundTruth).toHaveAttribute("aria-checked", "true");
    expect(retainedGroundTruth).toBeEnabled();
    await user.click(retainedGroundTruth);
    await waitFor(() => expect(retainedGroundTruth).toHaveAttribute("aria-checked", "false"));

    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/jobs",
      "http://localhost:8000/api/jobs",
      "http://localhost:8000/api/jobs/job-123/approve",
      "http://localhost:8000/api/benchmarks",
      "http://localhost:8000/api/jobs/job-123/benchmark",
      "http://localhost:8000/api/benchmarks/run",
      "http://localhost:8000/api/benchmarks",
      "http://localhost:8000/api/jobs/job-123/benchmark",
    ]);
  });

  it("imports a parser dataset and enables corpus actions", async () => {
    const pendingImport = deferredResponse();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ included_cases: 0, latest_report: null, recent_reports: [] }))
      .mockReturnValueOnce(pendingImport.promise)
      .mockResolvedValueOnce(processingQueueResponse(
        [],
        "dataset-import-snapshot",
      ));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    const importDataset = within(dialog).getByRole("button", { name: "Import dataset" });
    const exportDataset = within(dialog).getByRole("link", { name: "Export dataset" });
    await waitFor(() => expect(importDataset).toBeEnabled());
    expect(exportDataset).toHaveAttribute("aria-disabled", "true");

    const dataset = new File(["dataset-zip"], "parser-dataset.zip", { type: "application/zip" });
    await user.upload(within(dialog).getByLabelText("Parser dataset ZIP"), dataset);

    expect(importDataset).toBeDisabled();
    expect(within(dialog).getByLabelText("Parser dataset ZIP")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Close parser benchmark" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeDisabled();
    pendingImport.resolve(jsonResponse({
      imported_cases: 2,
      reused_cases: 0,
      included_cases: 2,
      job_ids: ["a".repeat(32), "b".repeat(32)],
    }));

    expect(await screen.findByText("Dataset ready: 2 hands")).toBeInTheDocument();
    expect(within(dialog).getByText("2").closest("span")).toHaveTextContent("2 ground-truth hands");
    expect(exportDataset).toHaveAttribute("aria-disabled", "false");
    expect(within(dialog).getByRole("button", { name: "Run benchmark" })).toBeEnabled();
    expect(importDataset).toBeEnabled();

    expect(fetchMock().mock.calls[1][0]).toBe("http://localhost:8000/api/benchmarks/import");
    expect(fetchMock().mock.calls[1][1]).toMatchObject({ method: "POST" });
    const form = fetchMock().mock.calls[1][1]?.body as FormData;
    expect(form.get("file")).toBe(dataset);
    await waitFor(() => expect(fetchMock()).toHaveBeenNthCalledWith(
      3,
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
  });

  it("removes a reused pristine dataset case from processing immediately", async () => {
    const benchmarkJobId = "3".repeat(32);
    const processingImport = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "reused-pristine-import.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: false,
      parser_result: null,
    };
    const nextState: DetectedState = {
      ...detectedState,
      hero_cards: [
        { rank: "Q", suit: "clubs" },
        { rank: "Q", suit: "hearts" },
      ],
      pot_size: 8,
    };
    const nextJob = jobRecord({
      id: "1".repeat(32),
      original_filename: "next-processing-hand.png",
      image_filename: `${"1".repeat(32)}.png`,
      parser_result: {
        ...jobRecord().parser_result!,
        state: nextState,
      },
    });
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([processingImport, nextJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "2");
    const pendingQueue = deferredResponse();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        included_cases: 0,
        latest_report: null,
        recent_reports: [],
      }))
      .mockResolvedValueOnce(jsonResponse({
        imported_cases: 0,
        reused_cases: 1,
        included_cases: 1,
        job_ids: [benchmarkJobId],
      }))
      .mockReturnValueOnce(pendingQueue.promise);
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    await waitFor(() => expect(
      within(dialog).getByRole("button", { name: "Import dataset" }),
    ).toBeEnabled());
    await user.upload(
      within(dialog).getByLabelText("Parser dataset ZIP"),
      new File(["dataset-zip"], "parser-dataset.zip", {
        type: "application/zip",
      }),
    );

    expect(await screen.findByText("Dataset ready: 1 hand")).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([nextJob]));
    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: reused-pristine-import.png",
    })).not.toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Open screenshot 1: next-processing-hand.png",
    })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.getByDisplayValue("Qc Qh")).toBeInTheDocument();
    expect(screen.getByDisplayValue("8")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Ah Kd")).not.toBeInTheDocument();

    pendingQueue.resolve(processingQueueResponse(
      [nextJob],
      "reused-pristine-import-snapshot",
    ));

    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true"));
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      "http://localhost:8000/api/benchmarks/import",
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("reconciles a reused pristine dataset case after a lost import response", async () => {
    const benchmarkJobId = "2".repeat(32);
    const processingImport = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "reimport-response-lost.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: false,
      parser_result: null,
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([processingImport]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        included_cases: 0,
        latest_report: null,
        recent_reports: [],
      }))
      .mockRejectedValueOnce(new TypeError("Connection lost after dataset import"))
      .mockResolvedValueOnce(processingQueueResponse(
        [],
        "lost-dataset-import-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    await waitFor(() => expect(
      within(dialog).getByRole("button", { name: "Import dataset" }),
    ).toBeEnabled());
    await user.upload(
      within(dialog).getByLabelText("Parser dataset ZIP"),
      new File(["dataset-zip"], "parser-dataset.zip", {
        type: "application/zip",
      }),
    );

    expect(await screen.findByText("Connection lost after dataset import")).toBeInTheDocument();
    await waitFor(() => expect(
      window.localStorage.getItem("poker-training-processing-v1"),
    ).toBe("[]"));
    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: reimport-response-lost.png",
    })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: reimport-response-lost.png",
    })).not.toBeInTheDocument();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      "http://localhost:8000/api/benchmarks/import",
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("preserves a confirmed dataset import during pending queue reconciliation", async () => {
    const cachedJob = {
      ...approvedJob(),
      id: "c".repeat(32),
      original_filename: "reused-dataset-hand.png",
    };
    const includedJob = {
      ...cachedJob,
      benchmark_included: true,
      updated_at: "2026-07-20T12:10:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([cachedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.sessionStorage.removeItem("poker-training-processing-synced");
    const pendingQueue = deferredResponse();
    const pendingImport = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingQueue.promise)
      .mockResolvedValueOnce(jsonResponse({
        included_cases: 0,
        latest_report: null,
        recent_reports: [],
      }))
      .mockReturnValueOnce(pendingImport.promise)
      .mockResolvedValueOnce(processingQueueResponse(
        [includedJob],
        "confirmed-import-snapshot",
      ));
    render(<App />);
    const user = userEvent.setup();

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    const dataset = new File(
      ["dataset-zip"],
      "parser-dataset.zip",
      { type: "application/zip" },
    );
    await user.upload(within(dialog).getByLabelText("Parser dataset ZIP"), dataset);
    await waitFor(() => expect(fetchMock()).toHaveBeenNthCalledWith(
      3,
      "http://localhost:8000/api/benchmarks/import",
      expect.objectContaining({ method: "POST" }),
    ));

    await act(async () => {
      pendingImport.resolve(jsonResponse({
        imported_cases: 0,
        reused_cases: 1,
        included_cases: 1,
        job_ids: [cachedJob.id],
      }));
      await pendingImport.promise;
      await Promise.resolve();
      await Promise.resolve();
      pendingQueue.resolve(jsonResponse({
        total: 1,
        jobs: [cachedJob],
        snapshot_version: "stale-processing-snapshot",
      }));
      await pendingQueue.promise;
    });

    await waitFor(() => expect(within(dialog).getByRole("switch", {
      name: /Use current hand as ground truth/,
    })).toHaveAttribute("aria-checked", "true"));
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))[0].benchmark_included).toBe(true);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
    expect(fetchMock()).toHaveBeenCalledTimes(4);
  });

  it("updates an imported hand held only by the history search projection", async () => {
    const archivedJob: JobRecord = {
      ...recommendedJob(),
      id: "archived-import-job",
      original_filename: "archived-import.png",
      benchmark_included: false,
      archived_at: "2026-07-10T00:02:00Z",
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [archivedJob],
        snapshot_version: "before-import",
      }))
      .mockResolvedValueOnce(jsonResponse({
        included_cases: 0,
        latest_report: null,
        recent_reports: [],
      }))
      .mockResolvedValueOnce(jsonResponse({
        imported_cases: 0,
        reused_cases: 1,
        included_cases: 1,
        job_ids: [archivedJob.id],
      }))
      .mockResolvedValueOnce(processingQueueResponse(
        [],
        "archived-dataset-import-snapshot",
      ))
      .mockResolvedValueOnce(jsonResponse({
        included_cases: 1,
        latest_report: null,
        recent_reports: [],
      }));
    render(<App />);
    const user = userEvent.setup();
    const historyPanel = screen.getByLabelText("Session history");

    await user.click(within(historyPanel).getByRole("button", {
      name: "Search saved history",
    }));
    await user.type(within(historyPanel).getByLabelText(
      "History search query",
    ), "flop");
    await user.click(within(historyPanel).getByRole("button", {
      name: "Run history search",
    }));
    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const importDialog = await screen.findByRole("dialog", {
      name: "Parser benchmark",
    });
    await waitFor(() => expect(
      within(importDialog).getByRole("button", { name: "Import dataset" }),
    ).toBeEnabled());
    await user.upload(
      within(importDialog).getByLabelText("Parser dataset ZIP"),
      new File(["dataset-zip"], "parser-dataset.zip", {
        type: "application/zip",
      }),
    );

    expect(await screen.findByText("Dataset ready: 1 hand")).toBeInTheDocument();
    await user.click(within(importDialog).getByRole("button", { name: "Done" }));
    await user.click(within(historyPanel).getByRole("button", {
      name: "Reopen history item 1",
    }));
    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const reopenedDialog = await screen.findByRole("dialog", {
      name: "Parser benchmark",
    });

    expect(await within(reopenedDialog).findByRole("switch", {
      name: /Use current hand as ground truth/,
    })).toHaveAttribute("aria-checked", "true");
    expect(fetchMock()).toHaveBeenCalledTimes(5);
  });

  it("shows benchmark mismatches and opens the stored hand for correction", async () => {
    const pendingReviewJob = deferredResponse();
    const benchmarkJobId = "b".repeat(32);
    const activeJob = {
      ...approvedJob(),
      id: "active-job",
      original_filename: "active.png",
      image_filename: "active-job.png",
      benchmark_included: true,
    };
    const reviewedState = canonicalState({ pot_size: 12.5 });
    const reviewedJob = {
      ...approvedJob(reviewedState),
      id: benchmarkJobId,
      original_filename: "mismatch.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: true,
      parser_result: null,
    };
    const benchmarkReport = {
      id: "benchmark-review",
      parser_provider: "ocr_cv",
      layout_profile: "fortuna",
      created_at: "2026-07-20T12:00:00Z",
      total_cases: 1,
      successful_cases: 1,
      failed_cases: 0,
      correct_fields: 9,
      evaluated_fields: 10,
      accuracy: 0.9,
      field_metrics: [{ field: "pot_size", correct: 0, total: 1, accuracy: 0 }],
      cases: [
        {
          job_id: benchmarkJobId,
          original_filename: "mismatch.png",
          status: "completed",
          correct_fields: 9,
          evaluated_fields: 10,
          accuracy: 0.9,
          warnings: [],
          error: null,
          comparisons: [
            {
              field: "pot_size",
              expected: 12.5,
              detected: 10,
              matched: false,
              confidence: 0.73,
            },
          ],
        },
      ],
    };
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{ id: activeJob.id, job: activeJob, savedAt: "2026-07-20T12:00:00Z" }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ included_cases: 1, latest_report: benchmarkReport }))
      .mockReturnValueOnce(pendingReviewJob.promise);
    render(<App />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reopen history item 1" }));
    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    const groundTruthSwitch = within(dialog).getByRole("switch", { name: /Use current hand as ground truth/ });
    await waitFor(() => expect(groundTruthSwitch).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "Toggle mismatch.png benchmark details" }));

    const details = within(dialog).getByText("Expected").closest(".benchmark-case-details");
    expect(details).not.toBeNull();
    expect(within(details as HTMLElement).getByText("12.5")).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText("10")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Review hand" }));
    expect(groundTruthSwitch).toBeDisabled();
    pendingReviewJob.resolve(jsonResponse(reviewedJob));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Parser benchmark" })).not.toBeInTheDocument());
    expect(screen.getByAltText("Uploaded poker table screenshot")).toHaveAttribute(
      "src",
      `http://localhost:8000/api/jobs/${benchmarkJobId}/image`,
    );
    expect(screen.getByLabelText(/Pot/)).toHaveValue("12.5");
    await waitFor(() => expect(
      window.localStorage.getItem("poker-training-processing-v1"),
    ).toBe("[]"));
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      `http://localhost:8000/api/jobs/${benchmarkJobId}`,
    ]);
  });

  it("restores a provider failure after recommending a pristine benchmark import", async () => {
    const benchmarkJobId = "c".repeat(32);
    const pristineImport = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "provider-failure.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: true,
      parser_result: null,
    };
    const failedImport = {
      ...pristineImport,
      status: "error" as const,
      error: "provider exploded",
      updated_at: "2026-07-10T00:01:00Z",
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(benchmarkOverviewForJob(
        benchmarkJobId,
        "provider-failure.png",
      )))
      .mockResolvedValueOnce(jsonResponse(pristineImport))
      .mockResolvedValueOnce(jsonResponse({ detail: "provider exploded" }, 502))
      .mockResolvedValueOnce(processingQueueResponse(
        [failedImport],
        "failed-import-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    await user.click(within(dialog).getByRole("button", {
      name: "Toggle provider-failure.png benchmark details",
    }));
    await user.click(within(dialog).getByRole("button", { name: "Review hand" }));
    await waitFor(() => expect(
      screen.queryByRole("dialog", { name: "Parser benchmark" }),
    ).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Request recommendation" }));

    expect(await screen.findAllByText("provider exploded")).not.toHaveLength(0);
    const failedQueueItem = await screen.findByRole("button", {
      name: "Open screenshot 1: provider-failure.png",
    });
    expect(within(failedQueueItem).getByText("error")).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([failedImport]));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    const restoredQueueItem = await screen.findByRole("button", {
      name: "Open screenshot 1: provider-failure.png",
    });
    expect(within(restoredQueueItem).getByText("provider exploded")).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeEnabled();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      `http://localhost:8000/api/jobs/${benchmarkJobId}`,
      `http://localhost:8000/api/jobs/${benchmarkJobId}/recommend`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("restores a lost standalone decision response for a pristine benchmark import", async () => {
    const benchmarkJobId = "7".repeat(32);
    const pristineImport = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "decision-response-lost.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: true,
      parser_result: null,
    };
    const persistedDecision = {
      ...pristineImport,
      training_decision: {
        action: "call" as const,
        sizing: null,
        certainty: "medium" as const,
        recorded_at: "2026-07-20T12:05:00Z",
      },
      updated_at: "2026-07-20T12:05:00Z",
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(benchmarkOverviewForJob(
        benchmarkJobId,
        "decision-response-lost.png",
      )))
      .mockResolvedValueOnce(jsonResponse(pristineImport))
      .mockRejectedValueOnce(new TypeError("Connection lost after saving answer"))
      .mockResolvedValueOnce(processingQueueResponse(
        [persistedDecision],
        "persisted-decision-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    await user.click(within(dialog).getByRole("button", {
      name: "Toggle decision-response-lost.png benchmark details",
    }));
    await user.click(within(dialog).getByRole("button", { name: "Review hand" }));
    await waitFor(() => expect(
      screen.queryByRole("dialog", { name: "Parser benchmark" }),
    ).not.toBeInTheDocument());
    const decisionPanel = await screen.findByLabelText("Your training decision");
    await user.click(within(decisionPanel).getByRole("button", { name: "call" }));
    await user.click(within(decisionPanel).getByRole("button", { name: "medium" }));

    await user.click(within(decisionPanel).getByRole("button", { name: "Lock answer" }));

    expect(await screen.findByText("Connection lost after saving answer")).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedDecision]));
    expect(await within(decisionPanel).findByText("Answer locked")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    const restoredQueueItem = await screen.findByRole("button", {
      name: "Open screenshot 1: decision-response-lost.png",
    });
    expect(within(restoredQueueItem).getByText("approved")).toBeInTheDocument();
    const restoredDecisionPanel = await screen.findByLabelText("Your training decision");
    expect(within(restoredDecisionPanel).getByText("Answer locked")).toBeInTheDocument();
    expect(within(restoredDecisionPanel).getByRole("button", {
      name: "medium",
    })).toHaveAttribute("aria-pressed", "true");
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      `http://localhost:8000/api/jobs/${benchmarkJobId}`,
      `http://localhost:8000/api/jobs/${benchmarkJobId}/decision`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it.each([
    { operation: "recommendation" as const },
    { operation: "decision" as const },
  ])("restores stable queue order after a successful benchmark $operation", async ({
    operation,
  }) => {
    const benchmarkJobId = operation === "recommendation"
      ? "a".repeat(32)
      : "b".repeat(32);
    const promotedFilename = `${operation}-promoted.png`;
    const olderJob = jobRecord({
      id: "0".repeat(32),
      original_filename: `${operation}-older.png`,
      image_filename: `${"0".repeat(32)}.png`,
      created_at: "2026-07-20T12:00:00Z",
      updated_at: "2026-07-20T12:00:00Z",
    });
    const pristineImport = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: promotedFilename,
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: true,
      parser_result: null,
      created_at: "2026-07-20T12:01:00Z",
      updated_at: "2026-07-20T12:01:00Z",
    };
    const newerJob = jobRecord({
      id: "f".repeat(32),
      original_filename: `${operation}-newer.png`,
      image_filename: `${"f".repeat(32)}.png`,
      created_at: "2026-07-20T12:02:00Z",
      updated_at: "2026-07-20T12:02:00Z",
    });
    const promotedJob: JobRecord = operation === "recommendation"
      ? {
          ...pristineImport,
          status: "recommended",
          recommendation,
          updated_at: "2026-07-20T12:03:00Z",
        }
      : {
          ...pristineImport,
          training_decision: {
            action: "call",
            sizing: null,
            certainty: "medium",
            recorded_at: "2026-07-20T12:03:00Z",
          },
          updated_at: "2026-07-20T12:03:00Z",
        };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([olderJob, newerJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "2");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(benchmarkOverviewForJob(
        benchmarkJobId,
        promotedFilename,
      )))
      .mockResolvedValueOnce(jsonResponse(pristineImport))
      .mockResolvedValueOnce(jsonResponse(promotedJob))
      .mockResolvedValueOnce(processingQueueResponse(
        [olderJob, promotedJob, newerJob],
        `${operation}-promoted-snapshot`,
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    await user.click(within(dialog).getByRole("button", {
      name: `Toggle ${promotedFilename} benchmark details`,
    }));
    await user.click(within(dialog).getByRole("button", { name: "Review hand" }));
    await waitFor(() => expect(
      screen.queryByRole("dialog", { name: "Parser benchmark" }),
    ).not.toBeInTheDocument());
    expect(screen.getByRole("button", {
      name: `Open screenshot 1: ${promotedFilename}`,
    })).toBeInTheDocument();

    if (operation === "recommendation") {
      await user.click(screen.getByRole("button", {
        name: "Request recommendation",
      }));
    } else {
      const decisionPanel = await screen.findByLabelText("Your training decision");
      await user.click(within(decisionPanel).getByRole("button", { name: "call" }));
      await user.click(within(decisionPanel).getByRole("button", { name: "medium" }));
      await user.click(within(decisionPanel).getByRole("button", { name: "Lock answer" }));
    }

    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([olderJob, promotedJob, newerJob]));
    expect(screen.getByRole("button", {
      name: `Open screenshot 1: ${operation}-older.png`,
    })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: `Open screenshot 2: ${promotedFilename}`,
    })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: `Open screenshot 3: ${operation}-newer.png`,
    })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    expect(screen.getByRole("button", {
      name: `Open screenshot 1: ${operation}-older.png`,
    })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: `Open screenshot 2: ${promotedFilename}`,
    })).toBeInTheDocument();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      `http://localhost:8000/api/jobs/${benchmarkJobId}`,
      `http://localhost:8000/api/jobs/${benchmarkJobId}/${operation === "recommendation" ? "recommend" : "decision"}`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("removes an import from processing after successful benchmark inclusion", async () => {
    const benchmarkJobId = "6".repeat(32);
    const processingImport = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "include-success.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: false,
      parser_result: null,
    };
    const pristineImport = {
      ...processingImport,
      benchmark_included: true,
      updated_at: "2026-07-20T12:10:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([processingImport]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        included_cases: 0,
        latest_report: null,
        recent_reports: [],
      }))
      .mockResolvedValueOnce(jsonResponse(pristineImport))
      .mockResolvedValueOnce(processingQueueResponse(
        [],
        "included-import-success-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    const groundTruthSwitch = within(dialog).getByRole("switch", {
      name: /Use current hand as ground truth/,
    });
    await waitFor(() => expect(groundTruthSwitch).toBeEnabled());
    await user.click(groundTruthSwitch);

    await waitFor(() => expect(
      window.localStorage.getItem("poker-training-processing-v1"),
    ).toBe("[]"));
    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: include-success.png",
    })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: include-success.png",
    })).not.toBeInTheDocument();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      `http://localhost:8000/api/jobs/${benchmarkJobId}/benchmark`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("removes an import from processing after successful re-approval", async () => {
    const benchmarkJobId = "4".repeat(32);
    const mutatedImport = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "approval-success.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: true,
      parser_result: null,
      training_decision: {
        action: "call" as const,
        sizing: null,
        certainty: "medium" as const,
        recorded_at: "2026-07-20T12:05:00Z",
      },
    };
    const approvedState = canonicalState({ pot_size: 20 });
    const pristineImport = {
      ...mutatedImport,
      approved_state: approvedState,
      training_decision: null,
      updated_at: "2026-07-20T12:10:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([mutatedImport]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(pristineImport))
      .mockResolvedValueOnce(processingQueueResponse(
        [],
        "reapproved-import-success-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    const potInput = await screen.findByDisplayValue("12.5");
    await user.clear(potInput);
    await user.type(potInput, "20");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    await waitFor(() => expect(
      window.localStorage.getItem("poker-training-processing-v1"),
    ).toBe("[]"));
    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: approval-success.png",
    })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: approval-success.png",
    })).not.toBeInTheDocument();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${benchmarkJobId}/approve`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it.each([
    { operation: "include" as const },
    { operation: "exclude" as const },
  ])("reconciles a lost parser-backed benchmark $operation response", async ({
    operation,
  }) => {
    const jobId = "8".repeat(32);
    const initiallyIncluded = operation === "exclude";
    const includedAfterWrite = !initiallyIncluded;
    const parserBackedJob = {
      ...approvedJob(),
      id: jobId,
      original_filename: `parser-backed-${operation}.png`,
      image_filename: `${jobId}.png`,
      benchmark_included: initiallyIncluded,
    };
    const persistedJob = {
      ...parserBackedJob,
      benchmark_included: includedAfterWrite,
      updated_at: "2026-07-20T12:10:00Z",
    };
    const emptyOverview = {
      included_cases: 0,
      latest_report: null,
      recent_reports: [],
    };
    const includedOverview = benchmarkOverviewForJob(
      jobId,
      parserBackedJob.original_filename,
    );
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([parserBackedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(
        initiallyIncluded ? includedOverview : emptyOverview,
      ))
      .mockRejectedValueOnce(new TypeError(
        `Connection lost after benchmark ${operation}`,
      ))
      .mockResolvedValueOnce(processingQueueResponse(
        [persistedJob],
        `parser-backed-${operation}-snapshot`,
      ))
      .mockResolvedValueOnce(jsonResponse(
        includedAfterWrite ? includedOverview : emptyOverview,
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    const groundTruthSwitch = within(dialog).getByRole("switch", {
      name: /Use current hand as ground truth/,
    });
    await waitFor(() => expect(groundTruthSwitch).toBeEnabled());
    expect(groundTruthSwitch).toHaveAttribute(
      "aria-checked",
      String(initiallyIncluded),
    );
    await user.click(groundTruthSwitch);

    expect(await screen.findByText(
      `Connection lost after benchmark ${operation}`,
    )).toBeInTheDocument();
    await waitFor(() => expect(groundTruthSwitch).toHaveAttribute(
      "aria-checked",
      String(includedAfterWrite),
    ));
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))[0].benchmark_included).toBe(includedAfterWrite);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const restoredDialog = await screen.findByRole("dialog", {
      name: "Parser benchmark",
    });
    expect(within(restoredDialog).getByRole("switch", {
      name: /Use current hand as ground truth/,
    })).toHaveAttribute("aria-checked", String(includedAfterWrite));
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      `http://localhost:8000/api/jobs/${jobId}/benchmark`,
      "http://localhost:8000/api/jobs",
      "http://localhost:8000/api/benchmarks",
    ]);
  });

  it("reconciles a lost benchmark inclusion response that removes an import from processing", async () => {
    const benchmarkJobId = "6".repeat(32);
    const processingImport = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "include-response-lost.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: false,
      parser_result: null,
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([processingImport]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        included_cases: 0,
        latest_report: null,
        recent_reports: [],
      }))
      .mockRejectedValueOnce(new TypeError("Connection lost after including hand"))
      .mockResolvedValueOnce(processingQueueResponse(
        [],
        "included-import-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    const groundTruthSwitch = within(dialog).getByRole("switch", {
      name: /Use current hand as ground truth/,
    });
    await waitFor(() => expect(groundTruthSwitch).toBeEnabled());
    await user.click(groundTruthSwitch);

    expect(await screen.findByText("Connection lost after including hand")).toBeInTheDocument();
    await waitFor(() => expect(
      window.localStorage.getItem("poker-training-processing-v1"),
    ).toBe("[]"));
    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: include-response-lost.png",
    })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: include-response-lost.png",
    })).not.toBeInTheDocument();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      `http://localhost:8000/api/jobs/${benchmarkJobId}/benchmark`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("reconciles a lost benchmark exclusion response that returns an import to processing", async () => {
    const benchmarkJobId = "5".repeat(32);
    const pristineImport = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "exclude-response-lost.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: true,
      parser_result: null,
    };
    const processingImport = {
      ...pristineImport,
      benchmark_included: false,
      updated_at: "2026-07-20T12:10:00Z",
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(benchmarkOverviewForJob(
        benchmarkJobId,
        "exclude-response-lost.png",
      )))
      .mockResolvedValueOnce(jsonResponse(pristineImport))
      .mockResolvedValueOnce(jsonResponse(benchmarkOverviewForJob(
        benchmarkJobId,
        "exclude-response-lost.png",
      )))
      .mockRejectedValueOnce(new TypeError("Connection lost after excluding hand"))
      .mockResolvedValueOnce(processingQueueResponse(
        [processingImport],
        "excluded-import-snapshot",
      ));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    await user.click(within(dialog).getByRole("button", {
      name: "Toggle exclude-response-lost.png benchmark details",
    }));
    await user.click(within(dialog).getByRole("button", { name: "Review hand" }));
    await waitFor(() => expect(
      screen.queryByRole("dialog", { name: "Parser benchmark" }),
    ).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const reopenedDialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    const groundTruthSwitch = within(reopenedDialog).getByRole("switch", {
      name: /Use current hand as ground truth/,
    });
    await waitFor(() => expect(groundTruthSwitch).toBeEnabled());
    await user.click(groundTruthSwitch);

    expect(await screen.findByText("Connection lost after excluding hand")).toBeInTheDocument();
    const restoredQueueItem = await screen.findByRole("button", {
      name: "Open screenshot 1: exclude-response-lost.png",
    });
    expect(within(restoredQueueItem).getByText("approved")).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([processingImport]));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      `http://localhost:8000/api/jobs/${benchmarkJobId}`,
      "http://localhost:8000/api/benchmarks",
      `http://localhost:8000/api/jobs/${benchmarkJobId}/benchmark`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("reconciles a lost re-approval response that makes a benchmark import pristine", async () => {
    const benchmarkJobId = "4".repeat(32);
    const mutatedImport = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "approval-response-lost.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: true,
      parser_result: null,
      training_decision: {
        action: "call" as const,
        sizing: null,
        certainty: "medium" as const,
        recorded_at: "2026-07-20T12:05:00Z",
      },
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([mutatedImport]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockRejectedValueOnce(new TypeError("Connection lost after approval"))
      .mockResolvedValueOnce(processingQueueResponse(
        [],
        "reapproved-import-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    const potInput = await screen.findByDisplayValue("12.5");
    await user.clear(potInput);
    await user.type(potInput, "20");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    expect(await screen.findByText("Connection lost after approval")).toBeInTheDocument();
    await waitFor(() => expect(
      window.localStorage.getItem("poker-training-processing-v1"),
    ).toBe("[]"));
    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: approval-response-lost.png",
    })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");

    firstRender.unmount();
    render(<App />);

    expect(screen.queryByRole("button", {
      name: "Open screenshot 1: approval-response-lost.png",
    })).not.toBeInTheDocument();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${benchmarkJobId}/approve`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("loads historical benchmark reports and compares accuracy", async () => {
    const earlierReport = {
      id: "benchmark-earlier",
      parser_provider: "ocr_cv",
      layout_profile: "fortuna",
      created_at: "2026-07-19T12:00:00Z",
      total_cases: 2,
      successful_cases: 2,
      failed_cases: 0,
      correct_fields: 14,
      evaluated_fields: 20,
      accuracy: 0.7,
      field_metrics: [
        { field: "hero_cards", correct: 1, total: 2, accuracy: 0.5 },
        { field: "pot_size", correct: 2, total: 2, accuracy: 1 },
      ],
      cases: [],
    };
    const latestReport = {
      ...earlierReport,
      id: "benchmark-latest",
      created_at: "2026-07-20T12:00:00Z",
      correct_fields: 18,
      accuracy: 0.9,
      field_metrics: [
        { field: "hero_cards", correct: 2, total: 2, accuracy: 1 },
        { field: "pot_size", correct: 1, total: 2, accuracy: 0.5 },
        { field: "board_cards", correct: 2, total: 2, accuracy: 1 },
      ],
    };
    const summaries = [latestReport, earlierReport].map(
      ({ id, parser_provider, layout_profile, created_at, total_cases, failed_cases, accuracy, field_metrics }) => ({
        id,
        parser_provider,
        layout_profile,
        created_at,
        total_cases,
        failed_cases,
        accuracy,
        field_metrics,
      }),
    );
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ included_cases: 2, latest_report: latestReport, recent_reports: summaries }))
      .mockResolvedValueOnce(jsonResponse(earlierReport));
    render(<App />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    expect(await within(dialog).findByLabelText("Benchmark summary")).toHaveTextContent("90%");
    expect(within(dialog).getByText("+20 pts vs previous")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("hero cards change +50 pts")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("pot size change -50 pts")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("board cards change New")).toBeInTheDocument();

    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Benchmark report" }), "benchmark-earlier");

    await waitFor(() => expect(within(dialog).getByLabelText("Benchmark summary")).toHaveTextContent("70%"));
    expect(within(dialog).getByText("No comparable earlier run")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/change/)).not.toBeInTheDocument();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      "http://localhost:8000/api/benchmarks/benchmark-earlier",
    ]);
  });

  it("prevents field edits while approval is pending", async () => {
    const pendingApproval = deferredResponse();
    const created = jobRecord();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockReturnValueOnce(pendingApproval.promise);
    render(<App />);

    const user = await uploadScreenshot();
    const heroCardsInput = await screen.findByLabelText(/Hero cards/);
    const potInput = screen.getByLabelText(/Pot/);
    const streetSelect = screen.getByLabelText(/Street/);
    const actionContextInput = screen.getByLabelText(/Action context/);

    await user.click(screen.getByRole("button", { name: "Approve state" }));

    await waitFor(() => expect(potInput).toBeDisabled());
    expect(heroCardsInput).toBeDisabled();
    expect(streetSelect).toBeDisabled();
    expect(actionContextInput).toBeDisabled();
    expect(screen.getByRole("button", { name: "Parser benchmark" })).toBeDisabled();

    await user.type(potInput, "18");
    expect(potInput).toHaveValue("12.5");

    pendingApproval.resolve(jsonResponse(approvedJob()));

    await waitFor(() => expect(potInput).toBeEnabled());
    expect(screen.getByRole("button", { name: "Parser benchmark" })).toBeEnabled();
    expect(potInput).toHaveValue("12.5");
    expect(screen.getByRole("button", { name: "Request recommendation" })).toBeEnabled();
  });
});
