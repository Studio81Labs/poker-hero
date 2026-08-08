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
    opponents_at_current_bet: 1,
    opponent_wager: 10,
    opponent_commitment_total: 13,
    hero_wager: 1,
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
      {
        action: "raise",
        sizing: 7.5,
        ev: 2.4,
        frequency: 0.72,
        fold_equity: 0.09,
        per_opponent_fold_equity: 0.3,
      },
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
    upload_request_id: null,
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
    recommendation_request_id: null,
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

function nextDeferredResponse(
  deferred: ReturnType<typeof deferredResponse>,
): Promise<Response> {
  return deferred.promise.then((response) => response.clone());
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

  it("edits screenshot details from the processing queue", async () => {
    const cachedJob = jobRecord({
      id: "1".repeat(32),
      original_filename: "untitled-table.png",
    });
    const updatedJob = {
      ...cachedJob,
      title: "Turn bluff review",
      notes: "Check the smaller sizing.",
      tags: ["turn", "bluff"],
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([cachedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock().mockResolvedValueOnce(jsonResponse(updatedJob));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", {
      name: "Manage screenshot 1: untitled-table.png",
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.type(within(dialog).getByLabelText("Title"), "Turn bluff review");
    await user.type(within(dialog).getByLabelText("Tags"), "turn, bluff, TURN");
    await user.type(
      within(dialog).getByLabelText("Notes"),
      "Check the smaller sizing.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${cachedJob.id}/metadata`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          title: "Turn bluff review",
          notes: "Check the smaller sizing.",
          tags: ["turn", "bluff"],
        }),
      }),
    ));
    expect(await screen.findAllByText("Turn bluff review")).toHaveLength(2);
  });

  it("moves a metadata response archived by another client into history", async () => {
    const cachedJob = jobRecord({
      id: "4".repeat(32),
      original_filename: "cross-tab-table.png",
    });
    const archivedJob = {
      ...cachedJob,
      title: "Archived elsewhere",
      archived_at: "2026-07-10T00:02:00Z",
      updated_at: "2026-07-10T00:03:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([cachedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(archivedJob))
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [archivedJob],
        snapshot_version: "archived-metadata-snapshot",
      }));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", {
      name: "Manage screenshot 1: cross-tab-table.png",
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.type(within(dialog).getByLabelText("Title"), "Archived elsewhere");
    await user.click(within(dialog).getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(screen.queryByRole("button", {
      name: "Open screenshot 1: cross-tab-table.png",
    })).not.toBeInTheDocument());
    expect(await screen.findByRole("button", {
      name: "Manage history item 1: cross-tab-table.png",
    })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Screenshot details" })).not.toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/history",
      { credentials: "include" },
    );
  });

  it("permanently removes an unarchivable screenshot from the queue", async () => {
    const failedJob = jobRecord({
      id: "2".repeat(32),
      status: "error",
      original_filename: "wrong-table.png",
      parser_result: null,
      error: "Table cards are missing",
    });
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([failedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock().mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", {
      name: "Manage screenshot 1: wrong-table.png",
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.click(within(dialog).getByRole("button", { name: "Delete screenshot" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(screen.queryByRole("button", {
      name: "Open screenshot 1: wrong-table.png",
    })).not.toBeInTheDocument());
    expect(screen.getByText("No screenshots uploaded or captured yet")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${failedJob.id}`,
      { method: "DELETE", credentials: "include" },
    );
  });

  it("allows deleting a screenshot with an external recommendation pending", async () => {
    const pendingJob = approvedJob();
    pendingJob.id = "5".repeat(32);
    pendingJob.original_filename = "stuck-recommendation.png";
    pendingJob.recommendation_pending = true;
    pendingJob.recommendation_request_id = "external-request";
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([pendingJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(processingQueueResponse([pendingJob]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<App />);
    const user = userEvent.setup();

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    await user.click(screen.getByRole("button", {
      name: "Manage screenshot 1: stuck-recommendation.png",
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    const armDelete = within(dialog).getByRole("button", { name: "Delete screenshot" });
    expect(armDelete).toBeEnabled();
    await user.click(armDelete);
    const confirmDelete = within(dialog).getByRole("button", { name: "Delete permanently" });
    expect(confirmDelete).toBeEnabled();
    await user.click(confirmDelete);

    await waitFor(() => expect(screen.queryByRole("button", {
      name: "Open screenshot 1: stuck-recommendation.png",
    })).not.toBeInTheDocument());
    expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${pendingJob.id}`,
      { method: "DELETE", credentials: "include" },
    );
  });

  it("allows saving screenshot details with an external recommendation pending", async () => {
    const pendingJob = approvedJob();
    pendingJob.id = "6".repeat(32);
    pendingJob.original_filename = "pending-details.png";
    pendingJob.recommendation_pending = true;
    pendingJob.recommendation_request_id = "external-request";
    const updatedJob = {
      ...pendingJob,
      title: "Provider still running",
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([pendingJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(processingQueueResponse([pendingJob]))
      .mockResolvedValueOnce(jsonResponse(updatedJob));
    render(<App />);
    const user = userEvent.setup();

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    await user.click(screen.getByRole("button", {
      name: "Manage screenshot 1: pending-details.png",
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.type(within(dialog).getByLabelText("Title"), "Provider still running");
    const saveDetails = within(dialog).getByRole("button", { name: "Save details" });
    expect(saveDetails).toBeEnabled();
    await user.click(saveDetails);

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${pendingJob.id}/metadata`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          title: "Provider still running",
          notes: null,
          tags: [],
        }),
      }),
    ));
  });

  it.each([
    { projection: "queue", archivedAt: null },
    { projection: "history", archivedAt: "2026-07-10T00:02:00Z" },
  ])("removes a stale $projection screenshot after metadata returns 404", async ({
    archivedAt,
  }) => {
    const missingJob = approvedJob();
    missingJob.id = "5".repeat(32);
    missingJob.original_filename = "deleted-in-another-tab.png";
    missingJob.archived_at = archivedAt;
    if (archivedAt === null) {
      window.localStorage.setItem(
        "poker-training-processing-v1",
        JSON.stringify([missingJob]),
      );
      window.localStorage.setItem("poker-training-processing-total-v1", "1");
    } else {
      window.localStorage.setItem(
        "poker-training-history-v1",
        JSON.stringify([{
          id: missingJob.id,
          job: missingJob,
          savedAt: archivedAt,
        }]),
      );
      window.localStorage.setItem("poker-training-history-total-v1", "1");
    }
    fetchMock().mockImplementation((url, options) => {
      if (url === `http://localhost:8000/api/jobs/${missingJob.id}/metadata`) {
        return Promise.resolve(jsonResponse({ detail: "Job not found" }, 404));
      }
      if (url === "http://localhost:8000/api/jobs") {
        return Promise.resolve(processingQueueResponse([]));
      }
      if (url === "http://localhost:8000/api/history") {
        return Promise.resolve(jsonResponse({
          total: 0,
          jobs: [],
          snapshot_version: "history-after-remote-delete",
        }));
      }
      throw new Error(`Unexpected request: ${String(url)} ${String(options?.method)}`);
    });
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", {
      name: archivedAt === null
        ? "Manage screenshot 1: deleted-in-another-tab.png"
        : "Manage history item 1: deleted-in-another-tab.png",
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.type(within(dialog).getByLabelText("Title"), "Missing hand");
    await user.click(within(dialog).getByRole("button", { name: "Save details" }));

    expect(await screen.findByText(
      "Screenshot was already deleted elsewhere",
    )).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Screenshot details",
    })).not.toBeInTheDocument());
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/history",
      { credentials: "include" },
    ));
    expect(screen.getByText("No screenshots uploaded or captured yet")).toBeInTheDocument();
    expect(screen.getByText("Cleared reviewed hands will appear here.")).toBeInTheDocument();
  });

  it("keeps queue and history management reachable during a recommendation request", async () => {
    const queueJob = approvedJob();
    queueJob.id = "7".repeat(32);
    queueJob.original_filename = "active-recommendation.png";
    const archivedJob = recommendedJob();
    archivedJob.id = "8".repeat(32);
    archivedJob.original_filename = "saved-during-recommendation.png";
    archivedJob.archived_at = "2026-07-10T00:02:00Z";
    const completedJob = {
      ...recommendedJob(),
      id: queueJob.id,
      original_filename: queueJob.original_filename,
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([queueJob]),
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
    const pendingRecommendation = deferredResponse();
    fetchMock().mockReturnValueOnce(pendingRecommendation.promise);
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Request recommendation" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${queueJob.id}/recommend`,
      expect.objectContaining({ method: "POST" }),
    ));
    const manageQueue = screen.getByRole("button", {
      name: "Manage screenshot 1: active-recommendation.png",
    });
    const manageHistory = screen.getByRole("button", {
      name: "Manage history item 1: saved-during-recommendation.png",
    });
    expect(manageQueue).toBeEnabled();
    expect(manageHistory).toBeEnabled();

    await user.click(manageQueue);
    expect(screen.getByRole("dialog", { name: "Screenshot details" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(manageHistory);
    expect(screen.getByRole("dialog", { name: "Screenshot details" })).toBeInTheDocument();

    await act(async () => {
      pendingRecommendation.resolve(jsonResponse(completedJob));
      await pendingRecommendation.promise;
    });
  });

  it("saves metadata during a same-tab recommendation without losing it to a stale response", async () => {
    const queueJob = approvedJob();
    queueJob.id = "9".repeat(32);
    queueJob.original_filename = "edit-while-solving.png";
    queueJob.updated_at = "2026-07-10T00:01:00Z";
    const recommendationResponse = {
      ...recommendedJob(),
      id: queueJob.id,
      original_filename: queueJob.original_filename,
      title: null,
      notes: null,
      tags: [],
      updated_at: "2026-07-10T00:02:00Z",
    };
    const metadataResponse = {
      ...recommendationResponse,
      title: "Edited while solving",
      updated_at: "2026-07-10T00:03:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([queueJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    const pendingRecommendation = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingRecommendation.promise)
      .mockResolvedValueOnce(jsonResponse(metadataResponse));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Request recommendation" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", {
      name: "Manage screenshot 1: edit-while-solving.png",
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.type(within(dialog).getByLabelText("Title"), "Edited while solving");
    await user.click(within(dialog).getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${queueJob.id}/metadata`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          title: "Edited while solving",
          notes: null,
          tags: [],
        }),
      }),
    ));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).not.toBeNull();

    await act(async () => {
      pendingRecommendation.resolve(jsonResponse(recommendationResponse));
      await pendingRecommendation.promise;
    });

    const queueItem = screen.getByRole("button", {
      name: "Open screenshot 1: edit-while-solving.png",
    });
    expect(within(queueItem).getByText("Edited while solving")).toBeInTheDocument();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))[0].title).toBe("Edited while solving");
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
  });

  it("deletes a screenshot during a same-tab recommendation and cancels its response", async () => {
    const queueJob = approvedJob();
    queueJob.id = "a".repeat(32);
    queueJob.original_filename = "delete-while-solving.png";
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([queueJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    let recommendationAborted = false;
    fetchMock()
      .mockImplementationOnce((_url, options) => {
        const signal = options?.signal as AbortSignal | undefined;
        return new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) {
            recommendationAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => {
            recommendationAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      })
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Request recommendation" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", {
      name: "Manage screenshot 1: delete-while-solving.png",
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.click(within(dialog).getByRole("button", { name: "Delete screenshot" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(recommendationAborted).toBe(true));
    expect(screen.getByText("No screenshots uploaded or captured yet")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${queueJob.id}`,
      { method: "DELETE", credentials: "include" },
    );
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
    expect(screen.queryByText(
      "Finishing recovery from a previous action. Try again in a moment.",
    )).not.toBeInTheDocument();
  });

  it("preserves delete recovery until an unrelated recommendation finishes", async () => {
    const recommendationJob = approvedJob();
    recommendationJob.id = "b".repeat(32);
    recommendationJob.original_filename = "solver-still-running.png";
    const deletedJob = approvedJob();
    deletedJob.id = "d".repeat(32);
    deletedJob.original_filename = "delete-response-lost.png";
    const recommendedJobA = {
      ...recommendedJob(),
      id: recommendationJob.id,
      original_filename: recommendationJob.original_filename,
      updated_at: "2026-07-10T00:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([recommendationJob, deletedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "2");
    const pendingRecommendation = deferredResponse();
    fetchMock().mockImplementation((url, options) => {
      if (url === `http://localhost:8000/api/jobs/${recommendationJob.id}/recommend`) {
        return pendingRecommendation.promise;
      }
      if (
        url === `http://localhost:8000/api/jobs/${deletedJob.id}`
        && options?.method === "DELETE"
      ) {
        return Promise.reject(new TypeError("Connection lost after delete"));
      }
      if (url === "http://localhost:8000/api/jobs") {
        return Promise.resolve(processingQueueResponse(
          [recommendedJobA],
          "queue-after-lost-delete-response",
        ));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Request recommendation" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", {
      name: "Manage screenshot 2: delete-response-lost.png",
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.click(within(dialog).getByRole("button", { name: "Delete screenshot" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByText("Connection lost after delete")).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Open screenshot 2: delete-response-lost.png",
    })).toBeInTheDocument();

    await act(async () => {
      pendingRecommendation.resolve(jsonResponse(recommendedJobA));
      await pendingRecommendation.promise;
    });

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    await waitFor(() => expect(screen.queryByText(
      "delete-response-lost.png",
    )).not.toBeInTheDocument());
    expect(screen.getByLabelText("Recommendation")).toBeInTheDocument();
  });

  it("reconciles an ambiguous upload before allowing permanent deletion", async () => {
    const persistedJob = jobRecord({
      id: "c".repeat(32),
      original_filename: "lost-upload-delete.png",
    });
    const pendingQueue = deferredResponse();
    let uploadRequestId = "";
    let persistedDeleted = false;
    fetchMock().mockImplementation((url, options) => {
      if (
        url === "http://localhost:8000/api/jobs"
        && options?.method === "POST"
      ) {
        uploadRequestId = String(
          (options.body as FormData).get("upload_request_id"),
        );
        return Promise.reject(new TypeError("Connection lost after upload"));
      }
      if (url === "http://localhost:8000/api/jobs") {
        return persistedDeleted
          ? Promise.resolve(processingQueueResponse([]))
          : pendingQueue.promise;
      }
      if (
        url === `http://localhost:8000/api/jobs/${persistedJob.id}`
        && options?.method === "DELETE"
      ) {
        persistedDeleted = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "http://localhost:8000/api/history") {
        return Promise.resolve(jsonResponse({
          total: 0,
          jobs: [],
          snapshot_version: "history-after-recovered-upload-delete",
        }));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    render(<App />);
    const user = userEvent.setup();

    await disableAutomation(user);
    await switchToUploadMode(user);
    await user.upload(
      screen.getByLabelText("Choose screenshots"),
      new File(["upload"], persistedJob.original_filename, { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));

    await user.click(await screen.findByRole("button", {
      name: `Manage screenshot 1: ${persistedJob.original_filename}`,
    }));
    let dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    expect(within(dialog).getByText(
      "Checking whether this upload reached persistent storage before deletion.",
    )).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Delete screenshot",
    })).toBeDisabled();
    expect(fetchMock()).not.toHaveBeenCalledWith(
      expect.stringContaining(persistedJob.id),
      expect.objectContaining({ method: "DELETE" }),
    );

    await act(async () => {
      pendingQueue.resolve(processingQueueResponse(
        [{ ...persistedJob, upload_request_id: uploadRequestId }],
        "recovered-upload-before-delete",
      ));
      await pendingQueue.promise;
    });

    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Screenshot details",
    })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", {
      name: `Manage screenshot 1: ${persistedJob.original_filename}`,
    }));
    dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    expect(within(dialog).getByLabelText("Title")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete screenshot" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${persistedJob.id}`,
      { method: "DELETE", credentials: "include" },
    ));
    expect(screen.getByText("No screenshots uploaded or captured yet")).toBeInTheDocument();
  });

  it("reconciles history after deleting a queue record archived by another tab", async () => {
    const jobId = "d".repeat(32);
    const staleQueueJob = recommendedJob();
    staleQueueJob.id = jobId;
    staleQueueJob.original_filename = "archived-during-delete.png";
    const archivedVersion = {
      ...staleQueueJob,
      archived_at: "2026-07-10T00:03:00Z",
      updated_at: "2026-07-10T00:03:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([staleQueueJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{
        id: jobId,
        job: archivedVersion,
        savedAt: archivedVersion.archived_at,
      }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    fetchMock().mockImplementation((url, options) => {
      if (
        url === `http://localhost:8000/api/jobs/${jobId}`
        && options?.method === "DELETE"
      ) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "http://localhost:8000/api/history") {
        return Promise.resolve(jsonResponse({
          total: 0,
          jobs: [],
          snapshot_version: "history-after-concurrent-delete",
        }));
      }
      if (url === "http://localhost:8000/api/jobs") {
        return Promise.resolve(processingQueueResponse([]));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", {
      name: "Manage screenshot 1: archived-during-delete.png",
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.click(within(dialog).getByRole("button", { name: "Delete screenshot" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/history",
      { credentials: "include" },
    ));
    await waitFor(() => expect(window.localStorage.getItem(
      "poker-training-history-total-v1",
    )).toBe("0"));
    expect(screen.getByText("No screenshots uploaded or captured yet")).toBeInTheDocument();
    expect(screen.getByText("Cleared reviewed hands will appear here.")).toBeInTheDocument();
  });

  it("refreshes the benchmark count after deleting a stale labeled screenshot", async () => {
    const staleBenchmarkJob = approvedJob();
    staleBenchmarkJob.id = "e".repeat(32);
    staleBenchmarkJob.original_filename = "stale-benchmark-label.png";
    staleBenchmarkJob.benchmark_included = true;
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([staleBenchmarkJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    let benchmarkReads = 0;
    fetchMock().mockImplementation((url, options) => {
      if (url === "http://localhost:8000/api/benchmarks") {
        benchmarkReads += 1;
        return Promise.resolve(jsonResponse({
          included_cases: 2,
          latest_report: null,
          recent_reports: [],
        }));
      }
      if (
        url === `http://localhost:8000/api/jobs/${staleBenchmarkJob.id}`
        && options?.method === "DELETE"
      ) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "http://localhost:8000/api/jobs") {
        return Promise.resolve(processingQueueResponse([]));
      }
      if (url === "http://localhost:8000/api/history") {
        return Promise.resolve(jsonResponse({
          total: 0,
          jobs: [],
          snapshot_version: "history-after-benchmark-delete",
        }));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const benchmarkDialog = await screen.findByRole("dialog", {
      name: "Parser benchmark",
    });
    await waitFor(() => expect(benchmarkDialog).toHaveTextContent(
      "2 ground-truth hands",
    ));
    await user.click(screen.getByRole("button", {
      name: "Manage screenshot 1: stale-benchmark-label.png",
    }));
    const detailsDialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.click(within(detailsDialog).getByRole("button", {
      name: "Delete screenshot",
    }));
    await user.click(within(detailsDialog).getByRole("button", {
      name: "Delete permanently",
    }));

    await waitFor(() => expect(benchmarkReads).toBe(2));
    expect(benchmarkDialog).toHaveTextContent("2 ground-truth hands");
    expect(screen.getByText("No screenshots uploaded or captured yet")).toBeInTheDocument();
  });

  it("permanently removes a saved screenshot from history", async () => {
    const archivedJob = recommendedJob();
    archivedJob.id = "3".repeat(32);
    archivedJob.original_filename = "saved-table.png";
    archivedJob.archived_at = "2026-07-10T00:02:00Z";
    archivedJob.updated_at = "2026-07-10T00:02:00Z";
    window.localStorage.setItem(
      "poker-training-history-v1",
      JSON.stringify([{
        id: archivedJob.id,
        job: archivedJob,
        savedAt: archivedJob.archived_at,
      }]),
    );
    window.localStorage.setItem("poker-training-history-total-v1", "1");
    fetchMock().mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", {
      name: "Manage history item 1: saved-table.png",
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.click(within(dialog).getByRole("button", { name: "Delete screenshot" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(screen.queryByRole("button", {
      name: "Reopen history item 1",
    })).not.toBeInTheDocument());
    expect(screen.getByText("Cleared reviewed hands will appear here.")).toBeInTheDocument();
  });

  it("restores structured preflop history from the browser cache", async () => {
    const preflopState: DetectedState = {
      ...detectedState,
      board_cards: [],
      pot_size: 12,
      current_bet: 5.5,
      hero_stack: 97.5,
      effective_stack: 92,
      players_in_hand: 2,
      hero_position: "cutoff",
      preflop_opener_position: "cutoff",
      preflop_open_size: 2.5,
      preflop_action_history: [
        { actor: "cutoff", action: "raise", amount: 2.5 },
        { actor: "button", action: "raise", amount: 8 },
      ],
      street: "preflop",
      facing_action: "raise",
      action_context: "Hero faces a 3-bet",
    };
    const cachedJob = jobRecord({
      id: "b".repeat(32),
      original_filename: "cached-three-bet.png",
      parser_result: {
        ...jobRecord().parser_result!,
        state: preflopState,
      },
    });
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([cachedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");

    render(<App />);

    expect(await screen.findByLabelText("Preflop action 1 actor")).toHaveValue("cutoff");
    expect(screen.getByLabelText("Preflop action 2 actor")).toHaveValue("button");
    expect(screen.getByLabelText("Preflop action 2 amount")).toHaveValue("8");
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

  it("preserves a pristine benchmark workspace omitted from processing", async () => {
    const processingJob = jobRecord({
      id: "5".repeat(32),
      original_filename: "benchmark-processing-sibling.png",
    });
    const benchmarkJobId = "6".repeat(32);
    const pristineBenchmark = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "pristine-benchmark-workspace.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: true,
      parser_result: null,
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([processingJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(benchmarkOverviewForJob(
        benchmarkJobId,
        pristineBenchmark.original_filename,
      )))
      .mockResolvedValueOnce(jsonResponse(pristineBenchmark))
      .mockResolvedValueOnce(processingQueueResponse(
        [processingJob],
        "processing-with-omitted-pristine-workspace",
      ));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    await user.click(within(dialog).getByRole("button", {
      name: `Toggle ${pristineBenchmark.original_filename} benchmark details`,
    }));
    await user.click(within(dialog).getByRole("button", { name: "Review hand" }));
    await waitFor(() => expect(
      screen.queryByRole("dialog", { name: "Parser benchmark" }),
    ).not.toBeInTheDocument());

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
    expect(await screen.findByRole("button", {
      name: "Open screenshot 2: pristine-benchmark-workspace.png",
    })).toHaveClass("active");
    expect(screen.getByDisplayValue("Ah Kd")).toBeInTheDocument();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([processingJob]);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
  });

  it("does not duplicate a pristine benchmark workspace returned by processing", async () => {
    const processingJob = jobRecord({
      id: "7".repeat(32),
      original_filename: "benchmark-return-sibling.png",
    });
    const benchmarkJobId = "8".repeat(32);
    const pristineBenchmark = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "returning-benchmark-workspace.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: true,
      parser_result: null,
    };
    const promotedBenchmark: JobRecord = {
      ...pristineBenchmark,
      status: "recommended",
      recommendation,
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([processingJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(benchmarkOverviewForJob(
        benchmarkJobId,
        pristineBenchmark.original_filename,
      )))
      .mockResolvedValueOnce(jsonResponse(pristineBenchmark))
      .mockResolvedValueOnce(processingQueueResponse(
        [processingJob, promotedBenchmark],
        "processing-with-promoted-benchmark",
      ));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    await user.click(within(dialog).getByRole("button", {
      name: `Toggle ${pristineBenchmark.original_filename} benchmark details`,
    }));
    await user.click(within(dialog).getByRole("button", { name: "Review hand" }));
    await waitFor(() => expect(
      screen.queryByRole("dialog", { name: "Parser benchmark" }),
    ).not.toBeInTheDocument());

    window.dispatchEvent(new StorageEvent("storage", {
      key: "poker-training-processing-v1",
      oldValue: "[]",
      newValue: JSON.stringify([processingJob, promotedBenchmark]),
      storageArea: window.localStorage,
    }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
    expect(await screen.findAllByRole("button", {
      name: /Open screenshot \d+: returning-benchmark-workspace\.png/,
    })).toHaveLength(1);
    expect(screen.getByRole("button", {
      name: "Open screenshot 2: returning-benchmark-workspace.png",
    })).toHaveClass("active");
    expect(screen.getByLabelText("Recommendation")).toBeInTheDocument();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([processingJob, promotedBenchmark]);
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

  it.each([
    ["missing recommendation fields", {}],
    ["zero wager sizing", { ...recommendation, action: "raise", sizing: 0 }],
  ])("rejects cached recommendations with %s and restores the backend record", async (
    _label,
    malformedRecommendation,
  ) => {
    const persistedJob = {
      ...recommendedJob(),
      id: "d".repeat(32),
      original_filename: "restored-recommendation.png",
    };
    const malformedJob = {
      ...persistedJob,
      recommendation: malformedRecommendation,
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
      label: "zero-sized training decision",
      invalidFields: {
        training_decision: {
          action: "raise",
          sizing: 0,
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

  it("keeps processing unsynced when a reload races an ordinary write", async () => {
    const jobId = "4".repeat(32);
    const initialJob = jobRecord({
      id: jobId,
      original_filename: "reload-spanning-approval.png",
    });
    const persistedJob: JobRecord = {
      ...initialJob,
      status: "approved",
      approved_state: canonicalState(),
      updated_at: "2026-07-20T12:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([initialJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    const pendingMutation = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingMutation.promise)
      .mockResolvedValueOnce(processingQueueResponse(
        [initialJob],
        "pre-commit-processing-snapshot",
      ))
      .mockResolvedValueOnce(processingQueueResponse(
        [persistedJob],
        "post-commit-processing-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Approve state" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${jobId}/approve`,
      expect.objectContaining({ method: "POST" }),
    ));
    firstRender.unmount();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).not.toBeNull();
    render(<App />);
    await act(async () => {
      pendingMutation.resolve(jsonResponse(persistedJob));
      await pendingMutation.promise;
    });

    await waitFor(() => expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeEnabled());
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedJob]));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${jobId}/approve`,
      "http://localhost:8000/api/jobs",
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("does not settle an approval lease from an unrelated cross-tab revision", async () => {
    const jobId = "7".repeat(32);
    const initialJob = {
      ...approvedJob(),
      id: jobId,
      original_filename: "cross-tab-approval.png",
    };
    const interveningJob: JobRecord = {
      ...initialJob,
      approved_state: canonicalState({ pot_size: 20 }),
      training_decision: {
        action: "call",
        sizing: null,
        certainty: "medium",
        recorded_at: "2026-07-20T12:01:00Z",
      },
      updated_at: "2026-07-20T12:01:00Z",
    };
    const correctedState = canonicalState({ pot_size: 20 });
    const persistedApproval: JobRecord = {
      ...interveningJob,
      status: "approved",
      approved_state: correctedState,
      training_decision: null,
      updated_at: "2026-07-20T12:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([initialJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    const pendingApproval = deferredResponse();
    const pendingFinalQueue = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingApproval.promise)
      .mockResolvedValueOnce(processingQueueResponse(
        [interveningJob],
        "intervening-decision-snapshot",
      ))
      .mockReturnValueOnce(pendingFinalQueue.promise);
    const firstRender = render(<App />);
    const user = userEvent.setup();

    const potInput = await screen.findByDisplayValue("12.5");
    await user.clear(potInput);
    await user.type(potInput, "20");
    await user.click(screen.getByRole("button", { name: "Approve state" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${jobId}/approve`,
      expect.objectContaining({ method: "POST" }),
    ));
    firstRender.unmount();
    render(<App />);

    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([interveningJob]));
    expect(JSON.parse(String(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )))).toEqual(expect.objectContaining({
      kind: "job",
      jobId,
      expectedMutation: {
        kind: "approval",
        approvedStateKey: expect.any(String),
      },
    }));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBeNull();

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(3));
    await act(async () => {
      pendingApproval.resolve(jsonResponse(persistedApproval));
      await pendingApproval.promise;
      pendingFinalQueue.resolve(processingQueueResponse(
        [persistedApproval],
        "persisted-approval-snapshot",
      ));
      await pendingFinalQueue.promise;
    });

    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedApproval]));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
  });

  it("does not settle a benchmark lease from an unrelated cross-tab revision", async () => {
    const jobId = "8".repeat(32);
    const initialJob = {
      ...approvedJob(),
      id: jobId,
      original_filename: "cross-tab-benchmark.png",
    };
    const interveningJob: JobRecord = {
      ...initialJob,
      training_decision: {
        action: "call",
        sizing: null,
        certainty: "medium",
        recorded_at: "2026-07-20T12:01:00Z",
      },
      updated_at: "2026-07-20T12:01:00Z",
    };
    const persistedInclusion: JobRecord = {
      ...interveningJob,
      benchmark_included: true,
      updated_at: "2026-07-20T12:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([initialJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.sessionStorage.setItem(
      "poker-training-processing-mutation-v1",
      JSON.stringify({
        kind: "job",
        ownerId: "previous-page",
        jobId,
        baselineUpdatedAt: initialJob.updated_at,
        expectsRemoval: false,
        expectedRecommendationRequestId: null,
        expectedMutation: {
          kind: "benchmark-inclusion",
          included: true,
        },
        expiresAt: Date.now() + 30_000,
      }),
    );
    fetchMock()
      .mockResolvedValueOnce(processingQueueResponse(
        [interveningJob],
        "intervening-decision-snapshot",
      ))
      .mockResolvedValueOnce(processingQueueResponse(
        [persistedInclusion],
        "persisted-benchmark-snapshot",
      ));

    render(<App />);

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedInclusion]));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
  });

  it("retains a legacy ordinary mutation lease without specific evidence", async () => {
    const jobId = "e".repeat(32);
    const initialJob = jobRecord({
      id: jobId,
      original_filename: "legacy-reload-spanning-approval.png",
    });
    const persistedJob: JobRecord = {
      ...initialJob,
      status: "approved",
      approved_state: canonicalState(),
      updated_at: "2026-07-20T12:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([initialJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.sessionStorage.setItem(
      "poker-training-processing-mutation-v1",
      JSON.stringify({
        ownerId: "previous-page",
        jobId,
        baselineUpdatedAt: initialJob.updated_at,
        expiresAt: Date.now() + 30_000,
      }),
    );
    const pendingRetry = deferredResponse();
    fetchMock()
      .mockResolvedValueOnce(processingQueueResponse(
        [persistedJob],
        "legacy-lease-commit-snapshot",
      ))
      .mockReturnValue(pendingRetry.promise);

    render(<App />);

    await waitFor(() => expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeEnabled());
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedJob]);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).not.toBeNull();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBeNull();
    expect(fetchMock().mock.calls[0]?.[0]).toBe(
      "http://localhost:8000/api/jobs",
    );
  });

  it("restores and upgrades a legacy recommended upload lease", async () => {
    const uploadRequestId = "legacy-upload-request";
    const persistedJob = {
      ...recommendedJob(),
      id: "f".repeat(32),
      original_filename: "legacy-recommended-upload.png",
      upload_request_id: uploadRequestId,
      updated_at: "2026-07-20T12:02:00Z",
    };
    window.sessionStorage.setItem(
      "poker-training-processing-mutation-v1",
      JSON.stringify({
        kind: "projection",
        ownerId: "previous-page",
        baselineJobIds: [],
        expectedRemovalJobIds: [],
        expectedUploads: [{
          requestId: uploadRequestId,
          target: "recommended",
        }],
        expiresAt: Date.now() + 30_000,
      }),
    );
    fetchMock().mockResolvedValueOnce(processingQueueResponse(
      [persistedJob],
      "legacy-recommended-upload-snapshot",
    ));

    render(<App />);

    expect(await screen.findByRole("button", {
      name: "Open screenshot 1: legacy-recommended-upload.png",
    })).toBeInTheDocument();
    expect(screen.getByLabelText("Recommendation")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
  });

  it("does not replace a claimed recovery lease with a new mutation", async () => {
    const jobId = "9".repeat(32);
    const initialJob = jobRecord({
      id: jobId,
      original_filename: "pending-recovery.png",
    });
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([initialJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.sessionStorage.setItem(
      "poker-training-processing-mutation-v1",
      JSON.stringify({
        kind: "job",
        ownerId: "previous-page",
        jobId,
        baselineUpdatedAt: initialJob.updated_at,
        expiresAt: Date.now() + 30_000,
      }),
    );
    const pendingQueue = deferredResponse();
    fetchMock().mockReturnValueOnce(pendingQueue.promise);
    render(<App />);
    const user = userEvent.setup();

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
    const claimedLease = JSON.parse(String(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )));
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    expect(await screen.findByText(
      "Finishing recovery from a previous action. Try again in a moment.",
    )).toBeInTheDocument();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/jobs",
    ]);
    expect(JSON.parse(String(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )))).toEqual(claimedLease);

    await act(async () => {
      pendingQueue.resolve(processingQueueResponse(
        [initialJob],
        "unchanged-recovery-snapshot",
      ));
      await pendingQueue.promise;
    });
  });

  it("keeps history unsynced when a reload races an archived write", async () => {
    const jobId = "5".repeat(32);
    const archivedAt = "2026-07-20T12:00:00Z";
    const initialJob: JobRecord = {
      ...recommendedJob(),
      id: jobId,
      original_filename: "reload-spanning-review.png",
      archived_at: archivedAt,
      training_decision: {
        action: "call",
        sizing: null,
        certainty: "medium",
        recorded_at: "2026-07-20T12:01:00Z",
      },
    };
    const interveningJob: JobRecord = {
      ...initialJob,
      benchmark_included: true,
      updated_at: "2026-07-20T12:01:30Z",
    };
    const persistedJob: JobRecord = {
      ...interveningJob,
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
    const pendingMutation = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingMutation.promise)
      .mockResolvedValueOnce(processingQueueResponse(
        [interveningJob],
        "intervening-benchmark-snapshot",
      ))
      .mockResolvedValueOnce(jsonResponse(persistedJob));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", {
      name: "Reopen history item 1",
    }));
    await user.click(within(
      await screen.findByLabelText("Training decision comparison"),
    ).getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${jobId}/training-review`,
      expect.objectContaining({ method: "PUT" }),
    ));
    firstRender.unmount();
    render(<App />);

    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-history-v1"),
    ))[0].job).toEqual(persistedJob));
    expect(window.sessionStorage.getItem(
      "poker-training-history-mutation-v1",
    )).toBeNull();
    expect(window.sessionStorage.getItem(
      "poker-training-history-synced",
    )).toBe("true");
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${jobId}/training-review`,
      "http://localhost:8000/api/history",
      `http://localhost:8000/api/jobs/${jobId}`,
    ]);
  });

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
        [parsedJob],
        "stale-approval-snapshot",
      ))
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
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("releases an approval lease after another tab starts a recommendation", async () => {
    const parsedJob = jobRecord({
      id: "d".repeat(32),
      original_filename: "approval-conflict.png",
    });
    const competingAttempt: JobRecord = {
      ...parsedJob,
      recommendation_pending: true,
      recommendation_request_id: "other-tab-attempt",
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([parsedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        detail: "Recommendation is already running",
      }, 409))
      .mockResolvedValueOnce(processingQueueResponse(
        [competingAttempt],
        "approval-conflict-snapshot",
      ));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Approve state" }));

    expect(await screen.findByText(
      "Recommendation is already running",
    )).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([competingAttempt]));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
    expect(screen.getByRole("button", {
      name: "Approve state",
    })).toBeEnabled();
    expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeDisabled();
  });

  it("restores an upload that commits after a replacement page reads a stale queue", async () => {
    const created = jobRecord({
      id: "a".repeat(32),
      original_filename: "reload-spanning-upload.png",
    });
    window.localStorage.setItem("poker-training-processing-v1", "[]");
    window.localStorage.setItem("poker-training-processing-total-v1", "0");
    window.localStorage.setItem("poker-training-history-v1", "[]");
    window.localStorage.setItem("poker-training-history-total-v1", "0");
    window.sessionStorage.setItem("poker-training-processing-synced", "true");
    window.sessionStorage.setItem("poker-training-history-synced", "true");
    const pendingUpload = deferredResponse();
    let uploadRequestId = "";
    fetchMock()
      .mockImplementationOnce((_url, request) => {
        uploadRequestId = String(
          (request?.body as FormData).get("upload_request_id"),
        );
        return pendingUpload.promise;
      })
      .mockResolvedValueOnce(processingQueueResponse(
        [],
        "stale-upload-snapshot",
      ))
      .mockImplementationOnce(() => Promise.resolve(processingQueueResponse(
        [{ ...created, upload_request_id: uploadRequestId }],
        "committed-upload-snapshot",
      )));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await disableAutomation(user);
    await switchToUploadMode(user);
    await user.upload(
      screen.getByLabelText("Choose screenshots"),
      new File(["upload"], created.original_filename, { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
    expect(uploadRequestId).not.toBe("");
    firstRender.unmount();

    render(<App />);
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(2));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBeNull();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).not.toBeNull();

    await act(async () => {
      pendingUpload.resolve(jsonResponse(created, 201));
      await pendingUpload.promise;
    });

    expect(await screen.findByRole("button", {
      name: `Open screenshot 1: ${created.original_filename}`,
    })).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull());
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/jobs",
      "http://localhost:8000/api/jobs",
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("does not settle a reload-spanning upload from another job with the same filename", async () => {
    const filename = "duplicate-name.png";
    const created = jobRecord({
      id: "a".repeat(32),
      original_filename: filename,
    });
    const foreignJob = jobRecord({
      id: "b".repeat(32),
      original_filename: filename,
      upload_request_id: "foreign-upload-request",
    });
    window.localStorage.setItem("poker-training-processing-v1", "[]");
    window.localStorage.setItem("poker-training-processing-total-v1", "0");
    window.localStorage.setItem("poker-training-history-v1", "[]");
    window.localStorage.setItem("poker-training-history-total-v1", "0");
    window.sessionStorage.setItem("poker-training-processing-synced", "true");
    window.sessionStorage.setItem("poker-training-history-synced", "true");
    const pendingUpload = deferredResponse();
    let uploadRequestId = "";
    fetchMock()
      .mockImplementationOnce((_url, request) => {
        uploadRequestId = String(
          (request?.body as FormData).get("upload_request_id"),
        );
        return pendingUpload.promise;
      })
      .mockResolvedValueOnce(processingQueueResponse(
        [foreignJob],
        "foreign-upload-snapshot",
      ))
      .mockImplementationOnce(() => Promise.resolve(processingQueueResponse(
        [
          foreignJob,
          { ...created, upload_request_id: uploadRequestId },
        ],
        "committed-upload-snapshot",
      )));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await disableAutomation(user);
    await switchToUploadMode(user);
    await user.upload(
      screen.getByLabelText("Choose screenshots"),
      new File(["upload"], filename, { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
    firstRender.unmount();

    render(<App />);
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(2));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).not.toBeNull();

    await act(async () => {
      pendingUpload.resolve(jsonResponse(created, 201));
      await pendingUpload.promise;
    });

    await waitFor(() => expect(screen.getAllByRole("button", {
      name: /Open screenshot \d+: duplicate-name\.png/,
    })).toHaveLength(2));
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull());
  });

  it("persists every selected file before starting a batch upload", async () => {
    const pendingUpload = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingUpload.promise)
      .mockResolvedValue(jsonResponse({ detail: "Invalid screenshot" }, 422));
    render(<App />);
    const user = userEvent.setup();

    await switchToUploadMode(user);
    await user.upload(
      screen.getByLabelText("Choose screenshots"),
      [
        new File(["first"], "batch-first.png", { type: "image/png" }),
        new File(["second"], "batch-second.png", { type: "image/png" }),
      ],
    );
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));

    expect(JSON.parse(String(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    ))).expectedUploads).toEqual([
      {
        requestId: expect.any(String),
        target: "recommended",
        recommendationRequestId: expect.any(String),
      },
      {
        requestId: expect.any(String),
        target: "recommended",
        recommendationRequestId: expect.any(String),
      },
    ]);

    await act(async () => {
      pendingUpload.resolve(jsonResponse({ detail: "Invalid screenshot" }, 422));
      await pendingUpload.promise;
    });
    expect(await screen.findByText(
      "2 screenshots need attention. Check the highlighted queue items.",
    )).toBeInTheDocument();
  });

  it("does not let a replaced upload page reclaim its mutation lease", async () => {
    window.localStorage.setItem("poker-training-processing-v1", "[]");
    window.localStorage.setItem("poker-training-processing-total-v1", "0");
    window.localStorage.setItem("poker-training-history-v1", "[]");
    window.localStorage.setItem("poker-training-history-total-v1", "0");
    const pendingUpload = deferredResponse();
    fetchMock()
      .mockReturnValueOnce(pendingUpload.promise)
      .mockResolvedValue(processingQueueResponse(
        [],
        "failed-upload-stale-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await switchToUploadMode(user);
    await user.upload(
      screen.getByLabelText("Choose screenshots"),
      new File(["invalid"], "reload-spanning-failure.png", {
        type: "image/png",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
    const originalLease = JSON.parse(String(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )));
    firstRender.unmount();

    render(<App />);
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(2));
    const replacementLease = JSON.parse(String(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )));
    expect(replacementLease.ownerId).not.toBe(originalLease.ownerId);

    await act(async () => {
      pendingUpload.resolve(jsonResponse({ detail: "Invalid screenshot" }, 422));
      await pendingUpload.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const retainedLease = JSON.parse(String(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )));
    expect(retainedLease.ownerId).toBe(replacementLease.ownerId);
    expect(retainedLease.expectedUploads).toEqual([{
      requestId: expect.any(String),
      target: "recommended",
      recommendationRequestId: expect.any(String),
    }]);
  });

  it("restores a batch archive after stale processing and history reloads", async () => {
    const readyJob = {
      ...recommendedJob(),
      id: "b".repeat(32),
      original_filename: "reload-spanning-archive.png",
    };
    const archivedJob: JobRecord = {
      ...readyJob,
      archived_at: "2026-07-20T12:02:00Z",
      updated_at: "2026-07-20T12:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([readyJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.localStorage.setItem("poker-training-history-v1", "[]");
    window.localStorage.setItem("poker-training-history-total-v1", "0");
    window.sessionStorage.setItem("poker-training-processing-synced", "true");
    window.sessionStorage.setItem("poker-training-history-synced", "true");
    const pendingArchive = deferredResponse();
    let archiveCommitted = false;
    let processingReads = 0;
    let historyReads = 0;
    fetchMock().mockImplementation((url, init) => {
      if (url === "http://localhost:8000/api/history" && init?.method === "PUT") {
        return pendingArchive.promise;
      }
      if (url === "http://localhost:8000/api/jobs") {
        processingReads += 1;
        return Promise.resolve(processingQueueResponse(
          archiveCommitted ? [] : [readyJob],
          `archive-processing-${processingReads}`,
        ));
      }
      if (url === "http://localhost:8000/api/history") {
        historyReads += 1;
        return Promise.resolve(jsonResponse({
          total: archiveCommitted ? 1 : 0,
          jobs: archiveCommitted ? [archivedJob] : [],
          snapshot_version: `archive-history-${historyReads}`,
        }));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Clear reviewed" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/history",
      expect.objectContaining({ method: "PUT" }),
    ));
    firstRender.unmount();
    render(<App />);

    await waitFor(() => expect(processingReads).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(historyReads).toBeGreaterThanOrEqual(1));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).not.toBeNull();
    expect(window.sessionStorage.getItem(
      "poker-training-history-mutation-v1",
    )).not.toBeNull();

    archiveCommitted = true;
    await act(async () => {
      pendingArchive.resolve(jsonResponse({
        total: 1,
        jobs: [archivedJob],
        snapshot_version: "archive-commit-response",
      }));
      await pendingArchive.promise;
    });

    await waitFor(() => expect(historyReads).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(processingReads).toBeGreaterThanOrEqual(2));
    expect(await screen.findByRole("button", {
      name: "Reopen history item 1",
    })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", {
      name: `Open screenshot 1: ${readyJob.original_filename}`,
    })).not.toBeInTheDocument());
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
    expect(window.sessionStorage.getItem(
      "poker-training-history-mutation-v1",
    )).toBeNull();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true");
    expect(window.sessionStorage.getItem(
      "poker-training-history-synced",
    )).toBe("true");
  });

  it("confirms an omitted benchmark hand before settling archive recovery", async () => {
    const readyJob = {
      ...recommendedJob(),
      id: "c".repeat(32),
      original_filename: "queued-archive.png",
    };
    const benchmarkJobId = "d".repeat(32);
    const pristineBenchmark = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "omitted-benchmark.png",
      image_filename: `${benchmarkJobId}.png`,
      parser_result: null,
      benchmark_included: true,
    };
    const archivedReadyJob: JobRecord = {
      ...readyJob,
      archived_at: "2026-07-20T12:02:00Z",
      updated_at: "2026-07-20T12:02:00Z",
    };
    const archivedBenchmark: JobRecord = {
      ...pristineBenchmark,
      archived_at: "2026-07-20T12:02:00Z",
      updated_at: "2026-07-20T12:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([readyJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    const pendingArchive = deferredResponse();
    let archiveCommitted = false;
    let processingReads = 0;
    let benchmarkReads = 0;
    fetchMock().mockImplementation((url, init) => {
      if (url === "http://localhost:8000/api/benchmarks") {
        return Promise.resolve(jsonResponse(benchmarkOverviewForJob(
          benchmarkJobId,
          pristineBenchmark.original_filename,
        )));
      }
      if (url === `http://localhost:8000/api/jobs/${benchmarkJobId}`) {
        benchmarkReads += 1;
        return Promise.resolve(jsonResponse(
          archiveCommitted ? archivedBenchmark : pristineBenchmark,
        ));
      }
      if (url === "http://localhost:8000/api/history" && init?.method === "PUT") {
        return pendingArchive.promise;
      }
      if (url === "http://localhost:8000/api/jobs") {
        processingReads += 1;
        return Promise.resolve(processingQueueResponse(
          archiveCommitted ? [] : [readyJob],
          `omitted-archive-processing-${processingReads}`,
        ));
      }
      if (url === "http://localhost:8000/api/history") {
        return Promise.resolve(jsonResponse({
          total: archiveCommitted ? 2 : 0,
          jobs: archiveCommitted
            ? [archivedBenchmark, archivedReadyJob]
            : [],
          snapshot_version: archiveCommitted
            ? "omitted-archive-committed"
            : "omitted-archive-stale",
        }));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    await user.click(within(dialog).getByRole("button", {
      name: `Toggle ${pristineBenchmark.original_filename} benchmark details`,
    }));
    await user.click(within(dialog).getByRole("button", { name: "Review hand" }));
    await user.click(screen.getByRole("button", { name: "Clear reviewed" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/history",
      expect.objectContaining({ method: "PUT" }),
    ));
    firstRender.unmount();
    render(<App />);

    await waitFor(() => expect(processingReads).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(benchmarkReads).toBeGreaterThanOrEqual(2));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).not.toBeNull();
    expect(window.sessionStorage.getItem(
      "poker-training-history-mutation-v1",
    )).not.toBeNull();

    archiveCommitted = true;
    await act(async () => {
      pendingArchive.resolve(jsonResponse({
        total: 2,
        jobs: [archivedBenchmark, archivedReadyJob],
        snapshot_version: "omitted-archive-response",
      }));
      await pendingArchive.promise;
    });

    await waitFor(() => expect(processingReads).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(benchmarkReads).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull());
    expect(window.sessionStorage.getItem(
      "poker-training-history-mutation-v1",
    )).toBeNull();
    expect(await screen.findByRole("button", {
      name: "Reopen history item 1",
    })).toBeInTheDocument();
  });

  it("restores a persisted provider error after an ordinary recommendation failure", async () => {
    const recommendationRequestId = "11111111-1111-4111-8111-111111111111";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      recommendationRequestId,
    );
    const approved = {
      ...approvedJob(),
      id: "5".repeat(32),
      original_filename: "ordinary-provider-failure.png",
    };
    const failedJob: JobRecord = {
      ...approved,
      status: "error",
      error: "provider exploded",
      recommendation_request_id: recommendationRequestId,
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

  it("releases a recommendation lease after another tab wins the conflict", async () => {
    const recommendationRequestId = "44444444-4444-4444-8444-444444444444";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      recommendationRequestId,
    );
    const approved = {
      ...approvedJob(),
      id: "a".repeat(32),
      original_filename: "competing-recommendation.png",
    };
    const competingAttempt: JobRecord = {
      ...approved,
      recommendation_pending: true,
      recommendation_request_id: "other-tab-attempt",
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([approved]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        detail: "Recommendation is already running",
      }, 409))
      .mockResolvedValue(processingQueueResponse(
        [competingAttempt],
        "competing-recommendation-snapshot",
      ));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", {
      name: "Request recommendation",
    }));

    expect(await screen.findByText(
      "Recommendation is already running",
    )).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([competingAttempt]));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
    expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeDisabled();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBeNull();
    expect(fetchMock().mock.calls.slice(0, 2).map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${approved.id}/recommend`,
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("restores an ordinary recommendation after its successful response is lost", async () => {
    const recommendationRequestId = "22222222-2222-4222-8222-222222222222";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      recommendationRequestId,
    );
    const approved = {
      ...approvedJob(),
      id: "6".repeat(32),
      original_filename: "ordinary-recommendation-lost.png",
    };
    const persistedRecommendation: JobRecord = {
      ...approved,
      status: "recommended",
      recommendation,
      recommendation_request_id: recommendationRequestId,
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

  it("keeps a recommendation lease through an intermediate decision revision", async () => {
    const jobId = "8".repeat(32);
    const recommendationRequestId = "88888888-8888-4888-8888-888888888888";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      recommendationRequestId,
    );
    const approved = {
      ...approvedJob(),
      id: jobId,
      original_filename: "decision-before-recommendation.png",
    };
    const trainingDecision = {
      action: "call" as const,
      sizing: null,
      certainty: "medium" as const,
      recorded_at: "2026-07-20T12:01:00Z",
    };
    const decisionSaved: JobRecord = {
      ...approved,
      training_decision: trainingDecision,
      updated_at: "2026-07-20T12:01:00Z",
    };
    const recommendationSaved: JobRecord = {
      ...decisionSaved,
      status: "recommended",
      recommendation,
      recommendation_request_id: recommendationRequestId,
      updated_at: "2026-07-20T12:02:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([approved]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    const pendingRecommendation = deferredResponse();
    const pendingFinalQueue = deferredResponse();
    let processingReads = 0;
    fetchMock().mockImplementation((url, init) => {
      if (url === `http://localhost:8000/api/jobs/${jobId}/decision`) {
        return Promise.resolve(jsonResponse(decisionSaved));
      }
      if (url === `http://localhost:8000/api/jobs/${jobId}/recommend`) {
        expect(init?.headers).toEqual({
          "X-Recommendation-Request-ID": recommendationRequestId,
        });
        return pendingRecommendation.promise;
      }
      if (url === "http://localhost:8000/api/jobs") {
        processingReads += 1;
        return processingReads === 1
          ? Promise.resolve(processingQueueResponse(
              [decisionSaved],
              "intermediate-decision-revision",
            ))
          : pendingFinalQueue.promise;
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const firstRender = render(<App />);
    const user = userEvent.setup();
    const decisionPanel = await screen.findByLabelText("Your training decision");

    await user.click(within(decisionPanel).getByRole("button", { name: "call" }));
    await user.click(within(decisionPanel).getByRole("button", { name: "medium" }));
    await user.click(screen.getByRole("button", { name: "Request recommendation" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${jobId}/recommend`,
      expect.objectContaining({ method: "POST" }),
    ));
    firstRender.unmount();
    render(<App />);

    await waitFor(() => expect(processingReads).toBeGreaterThanOrEqual(2));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).not.toBeNull();
    expect(screen.queryByLabelText("Recommendation")).not.toBeInTheDocument();

    await act(async () => {
      pendingFinalQueue.resolve(processingQueueResponse(
        [recommendationSaved],
        "completed-recommendation-revision",
      ));
      pendingRecommendation.resolve(jsonResponse(recommendationSaved));
      await Promise.all([
        pendingFinalQueue.promise,
        pendingRecommendation.promise,
      ]);
    });

    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
  });

  it("does not arm or start a recommendation when its decision response is lost", async () => {
    const approved = {
      ...approvedJob(),
      id: "d".repeat(32),
      original_filename: "recommend-after-decision-lost.png",
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
        "decision-before-recommendation-snapshot",
      ));
    render(<App />);
    const user = userEvent.setup();
    const decisionPanel = await screen.findByLabelText("Your training decision");

    await user.click(within(decisionPanel).getByRole("button", { name: "call" }));
    await user.click(within(decisionPanel).getByRole("button", { name: "medium" }));
    await user.click(screen.getByRole("button", { name: "Request recommendation" }));

    expect(await screen.findByText("Connection lost after saving answer")).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedDecision]));
    expect(await within(screen.getByLabelText(
      "Your training decision",
    )).findByText("Answer locked")).toBeInTheDocument();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      `http://localhost:8000/api/jobs/${approved.id}/decision`,
      "http://localhost:8000/api/jobs",
    ]);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
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

  it("releases a training-decision lease after a deterministic conflict", async () => {
    const approved = {
      ...approvedJob(),
      id: "8".repeat(32),
      original_filename: "decision-conflict.png",
    };
    const competingRecommendation: JobRecord = {
      ...approved,
      status: "recommended",
      recommendation,
      recommendation_request_id: "other-tab-recommendation",
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([approved]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        detail: "Your decision must be recorded before revealing the recommendation",
      }, 409))
      .mockResolvedValueOnce(processingQueueResponse(
        [competingRecommendation],
        "decision-conflict-snapshot",
      ));
    render(<App />);
    const user = userEvent.setup();
    const decisionPanel = await screen.findByLabelText("Your training decision");

    await user.click(within(decisionPanel).getByRole("button", { name: "call" }));
    await user.click(within(decisionPanel).getByRole("button", { name: "medium" }));
    await user.click(within(decisionPanel).getByRole("button", {
      name: "Lock answer",
    }));

    expect(await screen.findByText(
      "Your decision must be recorded before revealing the recommendation",
    )).toBeInTheDocument();
    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
  });

  it.each([
    { scope: "processing" as const },
    { scope: "history" as const },
  ])("releases a $scope review lease after a deterministic conflict", async ({
    scope,
  }) => {
    const jobId = scope === "processing" ? "3".repeat(32) : "4".repeat(32);
    const archivedAt = scope === "history" ? "2026-07-20T12:00:00Z" : null;
    const reviewedCandidate: JobRecord = {
      ...recommendedJob(),
      id: jobId,
      original_filename: `${scope}-review-conflict.png`,
      archived_at: archivedAt,
      training_decision: {
        action: "call",
        sizing: null,
        certainty: "medium",
        recorded_at: "2026-07-20T12:01:00Z",
      },
    };
    const competingApproval: JobRecord = {
      ...reviewedCandidate,
      status: "approved",
      approved_state: canonicalState({ pot_size: 20 }),
      recommendation: null,
      recommendation_request_id: null,
      training_decision: null,
      updated_at: "2026-07-20T12:02:00Z",
    };
    if (scope === "processing") {
      window.localStorage.setItem(
        "poker-training-processing-v1",
        JSON.stringify([reviewedCandidate]),
      );
      window.localStorage.setItem("poker-training-processing-total-v1", "1");
    } else {
      window.localStorage.setItem("poker-training-processing-v1", "[]");
      window.localStorage.setItem("poker-training-processing-total-v1", "0");
      window.sessionStorage.setItem(
        "poker-training-processing-synced",
        "true",
      );
      window.localStorage.setItem(
        "poker-training-history-v1",
        JSON.stringify([{
          id: jobId,
          job: reviewedCandidate,
          savedAt: archivedAt,
        }]),
      );
      window.localStorage.setItem("poker-training-history-total-v1", "1");
    }
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        detail: "Approve the current state before completing review",
      }, 409))
      .mockResolvedValueOnce(
        scope === "processing"
          ? processingQueueResponse(
              [competingApproval],
              "review-conflict-snapshot",
            )
          : jsonResponse({
              total: 1,
              jobs: [competingApproval],
              snapshot_version: "archived-review-conflict-snapshot",
            }),
      );
    render(<App />);
    const user = userEvent.setup();

    if (scope === "history") {
      await user.click(screen.getByRole("button", {
        name: "Reopen history item 1",
      }));
    }
    const comparison = await screen.findByLabelText(
      "Training decision comparison",
    );
    await user.click(within(comparison).getByRole("button", {
      name: "Mark reviewed",
    }));

    expect(await screen.findByText(
      "Approve the current state before completing review",
    )).toBeInTheDocument();
    const cacheKey = scope === "processing"
      ? "poker-training-processing-v1"
      : "poker-training-history-v1";
    await waitFor(() => {
      const cached = JSON.parse(String(window.localStorage.getItem(cacheKey)));
      const cachedJob = scope === "processing" ? cached[0] : cached[0].job;
      expect(cachedJob).toEqual(competingApproval);
    });
    expect(window.sessionStorage.getItem(
      `poker-training-${scope}-mutation-v1`,
    )).toBeNull();
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
      const recommendationRequestId = "33333333-3333-4333-8333-333333333333";
      vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
        recommendationRequestId,
      );
      initialJob = approvedArchivedJob;
      persistedJob = {
        ...approvedArchivedJob,
        status: "recommended",
        recommendation,
        recommendation_request_id: recommendationRequestId,
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
      .mockResolvedValue(processingQueueResponse(
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
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs",
      expect.anything(),
    ));
    expect(potInput).toHaveValue("20");
    expect(screen.getByRole("button", { name: "Approve state" })).toBeEnabled();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([parsedJob]);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBeNull();
    expect(JSON.parse(String(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )))).toEqual(expect.objectContaining({
      kind: "job",
      jobId: parsedJob.id,
      baselineUpdatedAt: parsedJob.updated_at,
    }));
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
    let uploadRequestId = "";
    fetchMock().mockReturnValueOnce(pendingQueue.promise);
    if (responseLost) {
      fetchMock().mockImplementationOnce((_url, request) => {
        uploadRequestId = String(
          (request?.body as FormData).get("upload_request_id"),
        );
        return Promise.reject(new TypeError(localError));
      });
    } else {
      fetchMock().mockImplementationOnce((_url, request) => {
        uploadRequestId = String(
          (request?.body as FormData).get("upload_request_id"),
        );
        return Promise.resolve(jsonResponse({
          detail: localError,
        }, 502));
      });
    }
    fetchMock().mockImplementationOnce(() => Promise.resolve(jsonResponse({
      total: 1,
      jobs: [{ ...persistedJob, upload_request_id: uploadRequestId }],
      snapshot_version: "restored-upload",
    })));
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
    ))).toEqual([{ ...persistedJob, upload_request_id: uploadRequestId }]);
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
    let uploadRequestId = "";
    fetchMock()
      .mockImplementationOnce((_url, request) => {
        uploadRequestId = String(
          (request?.body as FormData).get("upload_request_id"),
        );
        return Promise.reject(new TypeError("Connection lost after upload"));
      })
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({
        total: 1,
        jobs: [{ ...persistedJob, upload_request_id: uploadRequestId }],
        snapshot_version: "post-mutation-snapshot",
      })));
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
    ))).toEqual([{ ...persistedJob, upload_request_id: uploadRequestId }]);
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

  it("keeps the information dialog open until a one-time MCP token is stored", async () => {
    const issuance = deferredResponse();
    fetchMock().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        return Promise.resolve(jsonResponse({
          status: "ok",
          environment: "staging",
          parser_provider: "ocr_cv",
          recommendation_provider: "local_solver",
          recommendation_engine: "postflop_solver",
        }));
      }
      if (url.endsWith("/api/mcp/config")) {
        return Promise.resolve(jsonResponse({
          enabled: true,
          environment: "staging",
          endpoint: "https://poker-staging.example/mcp",
          writes_enabled: true,
        }));
      }
      if (url.endsWith("/api/mcp/principals") && init?.method === "POST") {
        return issuance.promise;
      }
      if (url.endsWith("/api/mcp/principals")) {
        return Promise.resolve(jsonResponse({ principals: [] }));
      }
      return Promise.reject(new Error(
        `Unexpected request: ${url} ${init?.method ?? "GET"}`,
      ));
    });
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "About this app" }));
    const dialog = screen.getByRole("dialog", {
      name: "About Poker Training Analyzer",
    });
    await user.type(
      await within(dialog).findByLabelText("Agent access admin token"),
      "admin-secret",
    );
    await user.click(within(dialog).getByRole("button", {
      name: "Unlock credential management",
    }));
    await user.type(
      await within(dialog).findByLabelText("Credential name"),
      "Codex staging",
    );
    await user.click(within(dialog).getByRole("button", {
      name: "Create credential",
    }));

    expect(within(dialog).getByRole("button", {
      name: "Close app information",
    })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeDisabled();

    issuance.resolve(jsonResponse({
      principal: {
        id: "mcp_00000000000000000000000000000001",
        name: "Codex staging",
        environment: "staging",
        token_prefix: "abcdefghijkl",
        scopes: ["read"],
        status: "active",
        created_at: "2026-08-07T10:00:00Z",
        updated_at: "2026-08-07T10:00:00Z",
        expires_at: null,
        revoked_at: null,
        last_used_at: null,
      },
      token: "phmcp_one-time-token",
    }));

    expect(await within(dialog).findByText("phmcp_one-time-token")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", {
      name: "Close app information",
    })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "I stored it" }));

    expect(within(dialog).getByRole("button", {
      name: "Close app information",
    })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", {
      name: "About Poker Training Analyzer",
    })).not.toBeInTheDocument();
  });

  it("downloads and restores full application backups from the info dialog", async () => {
    const restoredJob = approvedJob();
    fetchMock().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        return Promise.resolve(jsonResponse({
          status: "ok",
          parser_provider: "ocr_cv",
          recommendation_provider: "local_solver",
          recommendation_engine: "postflop_solver",
        }));
      }
      if (url.endsWith("/api/backups/restore")) {
        return Promise.resolve(jsonResponse({
          imported_jobs: 1,
          reused_jobs: 0,
          imported_benchmark_reports: 1,
          reused_benchmark_reports: 0,
          total_jobs: 1,
          total_benchmark_reports: 1,
        }));
      }
      if (url.endsWith("/api/jobs")) {
        return Promise.resolve(processingQueueResponse([restoredJob]));
      }
      if (url.endsWith("/api/history")) {
        return Promise.resolve(jsonResponse({
          total: 0,
          jobs: [],
          snapshot_version: "restored-history",
        }));
      }
      return Promise.reject(new Error(
        `Unexpected request: ${url} ${init?.method ?? "GET"}`,
      ));
    });
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "About this app" }));
    const dialog = screen.getByRole("dialog", {
      name: "About Poker Training Analyzer",
    });
    expect(within(dialog).getByRole("link", {
      name: "Download application backup",
    })).toHaveAttribute(
      "href",
      "http://localhost:8000/api/backups/export",
    );

    const file = new File(["backup"], "poker-hero-backup.zip", {
      type: "application/zip",
    });
    await user.upload(
      within(dialog).getByLabelText("Application backup ZIP"),
      file,
    );

    expect(await screen.findByText(
      "Backup restored: 1 new hand, 1 benchmark report",
    )).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", {
      name: /Open screenshot 1: table\.png/,
    })).toBeInTheDocument());
    const restoreCall = fetchMock().mock.calls.find(
      ([input]) => String(input).endsWith("/api/backups/restore"),
    );
    expect(restoreCall).toBeDefined();
    expect(restoreCall?.[1]?.method).toBe("POST");
    expect(restoreCall?.[1]?.body).toBeInstanceOf(FormData);
    expect((restoreCall?.[1]?.body as FormData).get("file")).toBe(file);
    expect(fetchMock().mock.calls.some(
      ([input]) => String(input).endsWith("/api/history"),
    )).toBe(true);
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
    expect(within(screen.getByLabelText("Parser confidence summary")).getByText("/11")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "About this app" }));
    expect(screen.getAllByText("Demo engine")).toHaveLength(2);
  });

  it("reviews an opponent seat for heads-up postflop solver routing", async () => {
    const headsUpState: DetectedState = {
      ...detectedState,
      players_in_hand: 2,
      hero_position: "big_blind",
      opponent_position: null,
    };
    const created = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: headsUpState,
      },
    });
    const approvedState = canonicalState({
      ...headsUpState,
      opponent_position: "button",
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob(approvedState)));
    render(<App />);

    const user = await uploadScreenshot();
    const opponentPosition = await screen.findByLabelText(/Opponent position/);
    expect(within(screen.getByLabelText("Parser confidence summary")).getByText("/12")).toBeInTheDocument();
    await user.type(opponentPosition, "button");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    const payload = JSON.parse(String(fetchMock().mock.calls[2][1]?.body));
    expect(payload.hero_position).toBe("big_blind");
    expect(payload.opponent_position).toBe("button");
  });

  it("omits opponent-seat confidence when hero position already resolves postflop order", async () => {
    const headsUpState: DetectedState = {
      ...detectedState,
      players_in_hand: 2,
      hero_position: "IP",
      opponent_position: null,
    };
    const created = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: headsUpState,
      },
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]));
    render(<App />);

    await uploadScreenshot();

    expect(screen.queryByLabelText(/Opponent position/)).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Parser confidence summary")).getByText("/11")).toBeInTheDocument();
  });

  it("records the reviewed committed-opponent count for multiway wagers", async () => {
    const preflopState: DetectedState = {
      ...detectedState,
      board_cards: [],
      pot_size: 6.5,
      current_bet: 1.5,
      players_in_hand: 3,
      opponents_at_current_bet: null,
      opponent_wager: null,
      hero_position: "big_blind",
      street: "preflop",
      facing_action: "raise",
      action_context: "Cutoff opens to 2.5 BB and button calls",
    };
    const created = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: preflopState,
      },
    });
    const approvedState = canonicalState({
      ...preflopState,
      opponents_at_current_bet: 2,
      opponent_wager: 2.5,
      opponent_commitment_total: 5,
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob(approvedState)));
    render(<App />);

    const user = await uploadScreenshot();
    const committedInput = await screen.findByLabelText(/Opponents at wager/);
    await user.type(committedInput, "2");
    await user.type(screen.getByLabelText(/Opponent wager total/), "2.5");
    await user.type(screen.getByLabelText(/Opponent commitments total/), "5");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    const payload = JSON.parse(String(fetchMock().mock.calls[2][1]?.body));
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/jobs/job-123/approve");
    expect(payload.opponents_at_current_bet).toBe(2);
    expect(payload.opponent_wager).toBe(2.5);
    expect(payload.opponent_commitment_total).toBe(5);
  });

  it("clears multiway commitments when players in hand is corrected to heads-up", async () => {
    const preflopState: DetectedState = {
      ...detectedState,
      board_cards: [],
      pot_size: 6.5,
      current_bet: 1.5,
      players_in_hand: 3,
      opponents_at_current_bet: 2,
      opponent_wager: 2.5,
      opponent_commitment_total: 5,
      hero_position: "big_blind",
      street: "preflop",
      facing_action: "raise",
      action_context: "Cutoff opens to 2.5 BB and button calls",
    };
    const created = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: preflopState,
      },
    });
    const approvedState = canonicalState({
      ...preflopState,
      players_in_hand: 2,
      opponents_at_current_bet: null,
      opponent_commitment_total: null,
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob(approvedState)));
    render(<App />);

    const user = await uploadScreenshot();
    const playersInput = screen.getByLabelText(/Players in hand/);
    expect(screen.getByLabelText(/Opponent commitments total/)).toHaveValue("5");
    await user.clear(playersInput);
    await user.type(playersInput, "2");
    expect(screen.queryByLabelText(/Opponent commitments total/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    const payload = JSON.parse(String(fetchMock().mock.calls[2][1]?.body));
    expect(payload.players_in_hand).toBe(2);
    expect(payload.opponents_at_current_bet).toBeNull();
    expect(payload.opponent_commitment_total).toBeNull();
  });

  it("rejects commitments above the latest wager across active opponents", async () => {
    const preflopState: DetectedState = {
      ...detectedState,
      board_cards: [],
      pot_size: 10,
      current_bet: 1.5,
      players_in_hand: 3,
      opponents_at_current_bet: 1,
      opponent_wager: 2.5,
      opponent_commitment_total: 6,
      hero_position: "big_blind",
      street: "preflop",
      facing_action: "raise",
      action_context: "Cutoff opens to 2.5 BB",
    };
    const created = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: preflopState,
      },
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    expect(await screen.findByText(
      "Opponent commitments total cannot exceed the latest wager across active opponents",
    )).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it("validates commitment totals against current-street history only", async () => {
    const postflopState: DetectedState = {
      ...detectedState,
      pot_size: 30,
      current_bet: 15,
      players_in_hand: 3,
      opponents_at_current_bet: 1,
      opponent_wager: 15,
      opponent_commitment_total: null,
      preflop_action_history: [
        { actor: "button", action: "raise", amount: 25 },
      ],
      facing_action: "raise",
      postflop_action_history: [
        { actor: "oop", action: "bet", amount: 5 },
        { actor: "ip", action: "raise", amount: 15 },
      ],
    };
    const created = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: postflopState,
      },
    });
    const approvedState = canonicalState({
      ...postflopState,
      opponent_commitment_total: 20,
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob(approvedState)));
    render(<App />);

    const user = await uploadScreenshot();
    await user.type(screen.getByLabelText(/Opponent commitments total/), "20");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    const payload = JSON.parse(String(fetchMock().mock.calls[2][1]?.body));
    expect(payload.opponent_commitment_total).toBe(20);
  });

  it("validates commitments against a corrected wager instead of stale history", async () => {
    const preflopState: DetectedState = {
      ...detectedState,
      board_cards: [],
      pot_size: 30,
      current_bet: 5,
      players_in_hand: 3,
      opponents_at_current_bet: 1,
      opponent_wager: 10,
      opponent_commitment_total: 15,
      hero_position: "big_blind",
      street: "preflop",
      facing_action: "raise",
      preflop_action_history: [
        { actor: "button", action: "raise", amount: 20 },
      ],
      action_context: "Reviewed wager corrects stale parsed history",
    };
    const created = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: preflopState,
      },
    });
    const approvedState = canonicalState(preflopState);
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob(approvedState)));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    const payload = JSON.parse(String(fetchMock().mock.calls[2][1]?.body));
    expect(payload.opponent_wager).toBe(10);
    expect(payload.opponent_commitment_total).toBe(15);
  });

  it("preserves reviewed preflop commitments when there is no call amount", async () => {
    const preflopState: DetectedState = {
      ...detectedState,
      board_cards: [],
      pot_size: 2.5,
      current_bet: 0,
      players_in_hand: 2,
      opponent_commitment_total: 1.5,
      hero_position: "button",
      street: "preflop",
      facing_action: null,
      action_context: "Folded dead money remains in the pot",
    };
    const created = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: preflopState,
      },
    });
    const approvedState = canonicalState({
      ...preflopState,
      opponent_commitment_total: 1.25,
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob(approvedState)));
    render(<App />);

    const user = await uploadScreenshot();
    const commitmentInput = await screen.findByLabelText(/Opponent commitments total/);
    expect(commitmentInput).toHaveValue("1.5");
    await user.clear(commitmentInput);
    await user.type(commitmentInput, "1.25");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    const payload = JSON.parse(String(fetchMock().mock.calls[2][1]?.body));
    expect(payload.current_bet).toBe(0);
    expect(payload.opponent_commitment_total).toBe(1.25);
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
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();

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

  it("deletes an automated capture and cancels only its recommendation", async () => {
    stubDisplayMedia("window");
    stubCanvasCapture();
    const jobId = "c".repeat(32);
    const created = jobRecord({
      id: jobId,
      original_filename: "delete-capture.png",
    });
    const approved = {
      ...approvedJob(),
      id: jobId,
      original_filename: created.original_filename,
    };
    let recommendationAborted = false;
    fetchMock().mockImplementation((url, options) => {
      if (url === "http://localhost:8000/api/jobs") {
        if (options?.method === "POST") {
          return Promise.resolve(jsonResponse(created, 201));
        }
        return Promise.resolve(processingQueueResponse([]));
      }
      if (url === `http://localhost:8000/api/jobs/${jobId}/approve`) {
        return Promise.resolve(jsonResponse(approved));
      }
      if (url === `http://localhost:8000/api/jobs/${jobId}/recommend`) {
        const signal = options?.signal as AbortSignal | undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            recommendationAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }
      if (
        url === `http://localhost:8000/api/jobs/${jobId}`
        && options?.method === "DELETE"
      ) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Share window" }));
    expect(await screen.findByText("Window sharing active")).toBeInTheDocument();
    setSharedPreviewSize();
    await user.click(screen.getByRole("button", { name: "Capture and parse" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${jobId}/recommend`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    await user.click(screen.getByRole("button", {
      name: "Manage screenshot 1: delete-capture.png",
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.click(within(dialog).getByRole("button", { name: "Delete screenshot" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(recommendationAborted).toBe(true));
    expect(screen.getByText("No screenshots uploaded or captured yet")).toBeInTheDocument();
    expect(screen.queryByText(/Screen capture failed/)).not.toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull());
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

  it("deletes an automated recommendation and continues the upload queue", async () => {
    const firstJobId = "1".repeat(32);
    const secondJobId = "2".repeat(32);
    const firstCreated = jobRecord({
      id: firstJobId,
      original_filename: "delete-automated.png",
    });
    const firstApproved = {
      ...approvedJob(),
      id: firstJobId,
      original_filename: firstCreated.original_filename,
    };
    const secondCreated = jobRecord({
      id: secondJobId,
      original_filename: "continue-automated.png",
    });
    const secondApproved = {
      ...approvedJob(),
      id: secondJobId,
      original_filename: secondCreated.original_filename,
    };
    const secondRecommended = {
      ...recommendedJob(),
      id: secondJobId,
      original_filename: secondCreated.original_filename,
    };
    let uploadCount = 0;
    let firstRecommendationAborted = false;
    let secondRecommendationCompleted = false;

    fetchMock().mockImplementation((url, options) => {
      if (url === "http://localhost:8000/api/jobs") {
        if (options?.method === "POST") {
          uploadCount += 1;
          return Promise.resolve(jsonResponse(
            uploadCount === 1 ? firstCreated : secondCreated,
            201,
          ));
        }
        return Promise.resolve(processingQueueResponse(
          secondRecommendationCompleted ? [secondRecommended] : [],
        ));
      }
      if (url === `http://localhost:8000/api/jobs/${firstJobId}/approve`) {
        return Promise.resolve(jsonResponse(firstApproved));
      }
      if (url === `http://localhost:8000/api/jobs/${firstJobId}/recommend`) {
        const signal = options?.signal as AbortSignal | undefined;
        return new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) {
            firstRecommendationAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => {
            firstRecommendationAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }
      if (
        url === `http://localhost:8000/api/jobs/${firstJobId}`
        && options?.method === "DELETE"
      ) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === `http://localhost:8000/api/jobs/${secondJobId}/approve`) {
        return Promise.resolve(jsonResponse(secondApproved));
      }
      if (url === `http://localhost:8000/api/jobs/${secondJobId}/recommend`) {
        secondRecommendationCompleted = true;
        return Promise.resolve(jsonResponse(secondRecommended));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    render(<App />);
    const user = userEvent.setup();

    await switchToUploadMode(user);
    await user.upload(screen.getByLabelText("Choose screenshots"), [
      new File(["first"], firstCreated.original_filename, { type: "image/png" }),
      new File(["second"], secondCreated.original_filename, { type: "image/png" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${firstJobId}/recommend`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    await user.click(screen.getByRole("button", {
      name: "Manage screenshot 1: delete-automated.png",
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.click(within(dialog).getByRole("button", { name: "Delete screenshot" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(firstRecommendationAborted).toBe(true));
    const remainingItem = await screen.findByRole("button", {
      name: "Open screenshot 1: continue-automated.png",
    });
    expect(await within(remainingItem).findByText("recommended")).toBeInTheDocument();
    expect(screen.queryByText("delete-automated.png")).not.toBeInTheDocument();
    expect(secondRecommendationCompleted).toBe(true);
    expect(screen.queryByText(/Import aborted/)).not.toBeInTheDocument();
    expect(screen.queryByText(/need attention/)).not.toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull());
  });

  it("mutates an unrelated queue job during automated recommendation", async () => {
    const recommendationJobId = "7".repeat(32);
    const unrelatedJobId = "8".repeat(32);
    const unrelatedJob = approvedJob();
    unrelatedJob.id = unrelatedJobId;
    unrelatedJob.original_filename = "unrelated-queue.png";
    const updatedUnrelatedJob = {
      ...unrelatedJob,
      title: "Reviewed independently",
      updated_at: "2026-07-10T00:03:00Z",
    };
    const created = jobRecord({
      id: recommendationJobId,
      original_filename: "automated-solver.png",
    });
    const approved = {
      ...approvedJob(),
      id: recommendationJobId,
      original_filename: created.original_filename,
    };
    const recommended = {
      ...recommendedJob(),
      id: recommendationJobId,
      original_filename: created.original_filename,
    };
    const pendingRecommendation = deferredResponse();
    let unrelatedDeleted = false;
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([unrelatedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock().mockImplementation((url, options) => {
      if (url === "http://localhost:8000/api/jobs") {
        if (options?.method === "POST") {
          return Promise.resolve(jsonResponse(created, 201));
        }
        return Promise.resolve(processingQueueResponse([recommended]));
      }
      if (url === `http://localhost:8000/api/jobs/${recommendationJobId}/approve`) {
        return Promise.resolve(jsonResponse(approved));
      }
      if (url === `http://localhost:8000/api/jobs/${recommendationJobId}/recommend`) {
        return pendingRecommendation.promise;
      }
      if (url === `http://localhost:8000/api/jobs/${unrelatedJobId}/metadata`) {
        return Promise.resolve(jsonResponse(updatedUnrelatedJob));
      }
      if (
        url === `http://localhost:8000/api/jobs/${unrelatedJobId}`
        && options?.method === "DELETE"
      ) {
        unrelatedDeleted = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "http://localhost:8000/api/history") {
        return Promise.resolve(jsonResponse({
          total: 0,
          jobs: [],
          snapshot_version: "history-after-unrelated-delete",
        }));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    render(<App />);
    const user = userEvent.setup();

    await switchToUploadMode(user);
    await user.upload(
      screen.getByLabelText("Choose screenshots"),
      new File(["solver"], created.original_filename, { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${recommendationJobId}/recommend`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));

    await user.click(screen.getByRole("button", {
      name: /Manage screenshot \d+: unrelated-queue\.png/,
    }));
    const dialog = screen.getByRole("dialog", { name: "Screenshot details" });
    await user.type(within(dialog).getByLabelText("Title"), "Reviewed independently");
    await user.click(within(dialog).getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/jobs/${unrelatedJobId}/metadata`,
      expect.objectContaining({ method: "PUT" }),
    ));
    await user.click(within(dialog).getByRole("button", { name: "Delete screenshot" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(unrelatedDeleted).toBe(true));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).not.toBeNull();
    expect(screen.queryByText(
      "Finishing recovery from a previous action. Try again in a moment.",
    )).not.toBeInTheDocument();

    await act(async () => {
      pendingRecommendation.resolve(jsonResponse(recommended));
      await pendingRecommendation.promise;
    });
    expect(await screen.findByLabelText("Recommendation")).toBeInTheDocument();
    expect(screen.queryByText("unrelated-queue.png")).not.toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull());
  });

  it("restores the persisted provider error when upload automation fails", async () => {
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
    const failedJob: JobRecord = {
      ...approved,
      status: "error",
      error: "Solver unavailable",
      updated_at: "2026-07-10T00:02:00Z",
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(jsonResponse(approved))
      .mockResolvedValueOnce(jsonResponse({ detail: "Solver unavailable" }, 502))
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [failedJob],
        snapshot_version: "failed-processing-snapshot",
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
    expect(await within(attentionItem).findByText("error")).toBeInTheDocument();
    expect(within(attentionItem).getByText("Solver unavailable")).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([{
      ...failedJob,
      upload_request_id: expect.any(String),
    }]));

    firstRender.unmount();
    render(<App />);

    const restoredItem = await screen.findByRole("button", {
      name: "Open screenshot 1: recommendation-failed.png",
    });
    expect(within(restoredItem).getByText("error")).toBeInTheDocument();
    expect(within(restoredItem).getByText("Solver unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeEnabled();
    expect(screen.getByRole("button", {
      name: "Clear reviewed",
    })).toBeDisabled();
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
    ))).toEqual([{
      ...persistedRecommendation,
      upload_request_id: expect.any(String),
    }]);
  });

  it("settles upload recovery after a lost correctable recommendation response", async () => {
    const jobId = "4".repeat(32);
    const created = jobRecord({
      id: jobId,
      original_filename: "correctable-response-lost.png",
    });
    const approved = {
      ...approvedJob(),
      id: jobId,
      original_filename: created.original_filename,
      updated_at: "2026-07-10T00:01:00Z",
    };
    const pendingQueue = deferredResponse();
    const finalQueue = deferredResponse();
    let uploadRequestId = "";
    let recommendationRequestId = "";
    let processingReads = 0;
    fetchMock().mockImplementation((url, request) => {
      if (url === "http://localhost:8000/api/jobs") {
        if (request?.method === "POST") {
          uploadRequestId = String(
            (request.body as FormData).get("upload_request_id"),
          );
          return Promise.resolve(jsonResponse(created, 201));
        }
        processingReads += 1;
        return processingReads === 1
          ? pendingQueue.promise
          : nextDeferredResponse(finalQueue);
      }
      if (url === `http://localhost:8000/api/jobs/${jobId}/approve`) {
        return Promise.resolve(jsonResponse(approved));
      }
      if (url === `http://localhost:8000/api/jobs/${jobId}/recommend`) {
        recommendationRequestId = String(
          (request?.headers as Record<string, string>)["X-Recommendation-Request-ID"],
        );
        return Promise.reject(new TypeError(
          "Connection lost after correctable recommendation",
        ));
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    render(<App />);
    const user = userEvent.setup();

    await switchToUploadMode(user);
    await user.upload(
      screen.getByLabelText("Choose screenshots"),
      new File(["lost-response"], created.original_filename, {
        type: "image/png",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Upload and parse" }));

    expect(await screen.findByText(
      "Connection lost after correctable recommendation",
    )).toBeInTheDocument();
    const persistedLease = JSON.parse(String(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )));
    expect(uploadRequestId).not.toBe("");
    expect(recommendationRequestId).not.toBe("");
    expect(persistedLease.expectedUploads).toEqual([{
      requestId: uploadRequestId,
      target: "recommended",
      recommendationRequestId,
    }]);

    await user.click(screen.getByRole("button", { name: "Automation On" }));
    const pendingAttempt: JobRecord = {
      ...approved,
      upload_request_id: uploadRequestId,
      recommendation_request_id: recommendationRequestId,
      recommendation_pending: true,
      updated_at: "2026-07-10T00:02:00Z",
    };
    await act(async () => {
      pendingQueue.resolve(processingQueueResponse(
        [pendingAttempt],
        "pending-automation-attempt",
      ));
      await pendingQueue.promise;
    });

    const pendingItem = screen.getByRole("button", {
      name: "Open screenshot 1: correctable-response-lost.png",
    });
    expect(pendingItem).toHaveClass("attention");
    expect(within(pendingItem).getByText(
      "Connection lost after correctable recommendation",
    )).toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).not.toBeNull();
    await waitFor(() => expect(processingReads).toBeGreaterThanOrEqual(2));
    window.dispatchEvent(new StorageEvent("storage", {
      key: "poker-training-processing-v1",
    }));
    await waitFor(() => expect(processingReads).toBeGreaterThanOrEqual(3));

    const persistedAttempt: JobRecord = {
      ...approved,
      upload_request_id: uploadRequestId,
      recommendation_request_id: recommendationRequestId,
      recommendation_pending: false,
      updated_at: "2026-07-10T00:03:00Z",
    };
    await act(async () => {
      finalQueue.resolve(processingQueueResponse(
        [persistedAttempt],
        "correctable-automation-attempt",
      ));
      await finalQueue.promise;
    });

    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull());
    const recoveredItem = screen.getByRole("button", {
      name: "Open screenshot 1: correctable-response-lost.png",
    });
    expect(recoveredItem).not.toHaveClass("attention");
    expect(within(recoveredItem).queryByText(
      "Connection lost after correctable recommendation",
    )).not.toBeInTheDocument();
    expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([persistedAttempt]);
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

  it("releases archive leases after a deterministic conflict", async () => {
    const readyJob: JobRecord = {
      ...recommendedJob(),
      id: "6".repeat(32),
      original_filename: "archive-conflict.png",
    };
    const competingAttempt: JobRecord = {
      ...readyJob,
      status: "approved",
      recommendation: null,
      recommendation_pending: true,
      recommendation_request_id: "other-tab-recommendation",
      updated_at: "2026-07-10T00:01:00Z",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([readyJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    window.localStorage.setItem("poker-training-history-v1", "[]");
    window.localStorage.setItem("poker-training-history-total-v1", "0");
    window.sessionStorage.setItem("poker-training-processing-synced", "true");
    window.sessionStorage.setItem("poker-training-history-synced", "true");
    fetchMock().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "http://localhost:8000/api/history" && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({
          detail: (
            "Only successful approved or recommended jobs can be moved to history"
          ),
        }, 409));
      }
      if (url === "http://localhost:8000/api/history") {
        return Promise.resolve(jsonResponse({
          total: 0,
          jobs: [],
          snapshot_version: "archive-conflict-history",
        }));
      }
      if (url === "http://localhost:8000/api/jobs") {
        return Promise.resolve(processingQueueResponse(
          [competingAttempt],
          "archive-conflict-processing",
        ));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Clear reviewed" }));

    expect(await screen.findByText(
      "Only successful approved or recommended jobs can be moved to history",
    )).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([competingAttempt]));
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
    expect(window.sessionStorage.getItem(
      "poker-training-history-mutation-v1",
    )).toBeNull();
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
    expect(window.sessionStorage.getItem("poker-training-history-synced")).toBeNull();
    expect(window.sessionStorage.getItem("poker-training-processing-synced")).toBeNull();
    expect(JSON.parse(String(window.sessionStorage.getItem(
      "poker-training-history-mutation-v1",
    )))).toEqual(expect.objectContaining({
      kind: "archive",
      jobIds: readyJobs.map((job) => job.id),
    }));
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

  it("rejects a zero-sized wager before locking the training answer", async () => {
    const created = jobRecord();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(await screen.findByRole("button", { name: "Approve state" }));
    const decisionPanel = await screen.findByLabelText("Your training decision");
    await user.click(within(decisionPanel).getByRole("button", { name: "raise" }));
    await user.type(within(decisionPanel).getByLabelText("Decision sizing in BB"), "0");
    await user.click(within(decisionPanel).getByRole("button", { name: "Lock answer" }));

    expect(await screen.findByText("Enter a valid positive decision size")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      title: "keeps sizing at the match-tolerance boundary reviewable",
      decisionSizing: 7.51,
      expectedLabel: "Same action, different size",
      needsReview: true,
    },
    {
      title: "preserves high-precision sizing below the tolerance",
      decisionSizing: 7.5099999995,
      expectedLabel: "Matched solver",
      needsReview: false,
    },
  ])("$title", async ({ decisionSizing, expectedLabel, needsReview }) => {
    const trainingDecision = {
      action: "raise" as const,
      sizing: decisionSizing,
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
    await user.type(
      within(decisionPanel).getByLabelText("Decision sizing in BB"),
      String(decisionSizing),
    );
    await user.click(within(decisionPanel).getByRole("button", { name: "high" }));
    await user.click(within(decisionPanel).getByRole("button", { name: "Lock answer" }));
    await user.click(screen.getByRole("button", { name: "Request recommendation" }));

    const comparison = await screen.findByLabelText("Training decision comparison");
    expect(within(comparison).getByText(expectedLabel)).toBeInTheDocument();
    if (needsReview) {
      expect(within(comparison).getByRole("button", { name: "Mark reviewed" })).toBeInTheDocument();
    } else {
      expect(within(comparison).queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
    }
  });

  it.each([
    {
      title: "accepts an alternate line at the policy-support boundary",
      frequency: 0.05,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedEv: 0,
      expectedLabel: "Solver-supported mix",
      hasEvLoss: true,
      includeRecommendedCandidate: true,
      needsReview: false,
    },
    {
      title: "rejects an alternate line below the policy-support boundary",
      frequency: 0.049999,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedEv: 0,
      expectedLabel: "Different action",
      hasEvLoss: true,
      includeRecommendedCandidate: true,
      needsReview: true,
    },
    {
      title: "rejects policy support with malformed frequency but still grades EV",
      frequency: "20%",
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedEv: 0,
      expectedLabel: "Different action",
      hasEvLoss: true,
      includeRecommendedCandidate: true,
      needsReview: true,
    },
    {
      title: "rejects policy support above the frequency maximum but still grades EV",
      frequency: 1.000001,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedEv: 0,
      expectedLabel: "Different action",
      hasEvLoss: true,
      includeRecommendedCandidate: true,
      needsReview: true,
    },
    {
      title: "accepts policy support at the frequency maximum",
      frequency: 1,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedEv: 0,
      expectedLabel: "Solver-supported mix",
      hasEvLoss: true,
      includeRecommendedCandidate: true,
      needsReview: false,
    },
    {
      title: "rejects policy support without explicit frequency but still grades EV",
      frequency: 0.2,
      includeCandidateFrequency: false,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedEv: 0,
      expectedLabel: "Different action",
      hasEvLoss: true,
      includeRecommendedCandidate: true,
      needsReview: true,
    },
    {
      title: "rejects an alternate raise without valid sizing",
      frequency: 0.2,
      candidateSizing: null,
      candidateEv: 2.74,
      unrelatedEv: 0,
      expectedLabel: "Different action",
      hasEvLoss: false,
      includeRecommendedCandidate: true,
      needsReview: true,
    },
    {
      title: "rejects an alternate raise with zero sizing",
      frequency: 0.2,
      candidateSizing: 0,
      candidateEv: 2.74,
      unrelatedEv: 0,
      expectedLabel: "Different action",
      hasEvLoss: false,
      includeRecommendedCandidate: true,
      needsReview: true,
    },
    {
      title: "does not grade EV when candidates omit the recommended line",
      frequency: 0.2,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedEv: 0,
      expectedLabel: "Solver-supported mix",
      hasEvLoss: false,
      includeRecommendedCandidate: false,
      needsReview: false,
    },
    {
      title: "does not grade EV when the recommended line omits sizing",
      frequency: 0.2,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedEv: 0,
      expectedLabel: "Solver-supported mix",
      hasEvLoss: false,
      includeRecommendedCandidate: true,
      includeRecommendedSizing: false,
      needsReview: false,
    },
    {
      title: "does not grade EV when the recommended line has invalid sizing",
      frequency: 0.2,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedEv: 0,
      expectedLabel: "Solver-supported mix",
      hasEvLoss: false,
      includeRecommendedCandidate: true,
      recommendedCandidateSizing: 2.5,
      needsReview: false,
    },
    {
      title: "grades EV when the recommended line omits frequency",
      frequency: 0.2,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedEv: 0,
      expectedLabel: "Solver-supported mix",
      hasEvLoss: true,
      includeRecommendedCandidate: true,
      includeRecommendedFrequency: false,
      needsReview: false,
    },
    {
      title: "grades EV when the recommended line has malformed frequency",
      frequency: 0.2,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedEv: 0,
      expectedLabel: "Solver-supported mix",
      hasEvLoss: true,
      includeRecommendedCandidate: true,
      recommendedFrequency: "84%",
      needsReview: false,
    },
    {
      title: "keeps a supported alternate with nonnumeric EV ungraded",
      frequency: 0.2,
      candidateSizing: 8,
      candidateEv: "2.74",
      unrelatedEv: 0,
      expectedLabel: "Solver-supported mix",
      hasEvLoss: false,
      includeRecommendedCandidate: true,
      needsReview: false,
    },
    {
      title: "grades valid lines when an unrelated candidate has nonnumeric EV",
      frequency: 0.2,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedEv: "99",
      expectedLabel: "Solver-supported mix",
      hasEvLoss: true,
      includeRecommendedCandidate: true,
      needsReview: false,
    },
    {
      title: "leaves EV ungraded when the recommended line is nonnumeric",
      frequency: 0.2,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedEv: 0,
      recommendedEv: "2.75",
      expectedLabel: "Solver-supported mix",
      hasEvLoss: false,
      includeRecommendedCandidate: true,
      needsReview: false,
    },
    {
      title: "ignores high EV on an unrelated candidate with invalid sizing",
      frequency: 0.2,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedAction: "bet",
      unrelatedEv: 99,
      unrelatedSizing: -1,
      expectedLabel: "Solver-supported mix",
      hasEvLoss: true,
      includeRecommendedCandidate: true,
      needsReview: false,
    },
    {
      title: "ignores high EV on an unrelated candidate with invalid action",
      frequency: 0.2,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedAction: "jam",
      unrelatedEv: 99,
      unrelatedSizing: null,
      expectedLabel: "Solver-supported mix",
      hasEvLoss: true,
      includeRecommendedCandidate: true,
      needsReview: false,
    },
    {
      title: "grades EV candidates without valid frequency metadata",
      frequency: 0.2,
      candidateSizing: 8,
      candidateEv: 2.74,
      unrelatedAction: "bet",
      unrelatedEv: 3,
      unrelatedFrequency: "20%",
      unrelatedSizing: 6,
      expectedEvLoss: "0.26 BB EV loss",
      expectedLabel: "Solver-supported mix",
      hasEvLoss: true,
      includeRecommendedCandidate: true,
      needsReview: false,
    },
  ].map((testCase) => ({
    expectedEvLoss: testCase.hasEvLoss ? "0.01 BB EV loss" : null,
    includeCandidateFrequency: true,
    recommendedEv: 2.75,
    includeRecommendedSizing: true,
    includeRecommendedFrequency: true,
    recommendedFrequency: 0.84,
    recommendedCandidateSizing: null,
    unrelatedAction: "fold",
    unrelatedFrequency: 0.02,
    unrelatedSizing: null,
    ...testCase,
  })))("$title", async ({
    frequency,
    candidateSizing,
    candidateEv,
    expectedEvLoss,
    includeCandidateFrequency,
    unrelatedAction,
    unrelatedEv,
    unrelatedFrequency,
    unrelatedSizing,
    recommendedEv,
    expectedLabel,
    includeRecommendedCandidate,
    includeRecommendedSizing,
    includeRecommendedFrequency,
    recommendedFrequency,
    recommendedCandidateSizing,
    needsReview,
  }) => {
    const trainingDecision = {
      action: "raise" as const,
      sizing: 8,
      recorded_at: "2026-07-20T12:00:00Z",
    };
    const alternateCandidate = {
      action: "raise",
      ev: candidateEv,
      ...(includeCandidateFrequency ? { frequency } : {}),
      ...(candidateSizing === null ? {} : { sizing: candidateSizing }),
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
          ...(includeRecommendedCandidate
            ? [{
              action: "call",
              ev: recommendedEv,
              ...(includeRecommendedFrequency ? { frequency: recommendedFrequency } : {}),
              ...(includeRecommendedSizing ? { sizing: recommendedCandidateSizing } : {}),
            }]
            : []),
          alternateCandidate,
          {
            action: unrelatedAction,
            sizing: unrelatedSizing,
            ev: unrelatedEv,
            frequency: unrelatedFrequency,
          },
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
    expect(within(comparison).getByText(expectedLabel)).toBeInTheDocument();
    if (expectedEvLoss !== null) {
      expect(within(comparison).getByText(expectedEvLoss)).toBeInTheDocument();
    } else {
      expect(within(comparison).queryByText(/BB EV loss/)).not.toBeInTheDocument();
    }
    if (needsReview) {
      expect(within(comparison).getByRole("button", { name: "Mark reviewed" })).toBeInTheDocument();
    } else {
      expect(within(comparison).queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
    }
  });

  it.each([
    {
      title: "does not grade EV from only the recommended candidate line",
      candidates: [
        { action: "raise", sizing: 8, ev: 1.4, frequency: 1 },
      ],
      expectedEvLoss: null,
    },
    {
      title: "does not grade EV from duplicate recommended candidate lines",
      candidates: [
        { action: "raise", sizing: 8, ev: 1.4, frequency: 1 },
        { action: "raise", sizing: 8.001, ev: 1.3, frequency: 0 },
      ],
      expectedEvLoss: null,
    },
    {
      title: "does not grade EV from a large tolerance-equivalent candidate set",
      candidates: Array.from({ length: 1_000 }, (_, index) => ({
        action: "raise",
        sizing: 8 + index / 200_000,
        ev: 1.4,
        frequency: 1,
      })),
      expectedEvLoss: null,
    },
    {
      title: "grades EV from an alternate at the sizing-tolerance boundary",
      candidates: [
        { action: "raise", sizing: 8, ev: 1.4, frequency: 1 },
        { action: "raise", sizing: 8.01, ev: 1.3, frequency: 0 },
      ],
      expectedEvLoss: "0 BB EV loss",
    },
    {
      title: "grades tolerance-bridged lines when the bridge is first",
      candidates: [
        { action: "raise", sizing: 8.009, ev: 1.3, frequency: 0 },
        { action: "raise", sizing: 8, ev: 1.4, frequency: 1 },
        { action: "raise", sizing: 8.018, ev: 1.3, frequency: 0 },
      ],
      expectedEvLoss: "0 BB EV loss",
    },
    {
      title: "grades tolerance-bridged lines when the endpoints are first",
      candidates: [
        { action: "raise", sizing: 8, ev: 1.4, frequency: 1 },
        { action: "raise", sizing: 8.018, ev: 1.3, frequency: 0 },
        { action: "raise", sizing: 8.009, ev: 1.3, frequency: 0 },
      ],
      expectedEvLoss: "0 BB EV loss",
    },
  ])("$title", async ({ candidates, expectedEvLoss }) => {
    const trainingDecision = {
      action: "raise" as const,
      sizing: 8,
      recorded_at: "2026-07-20T12:00:00Z",
    };
    const singleLineRecommendation: RecommendationResult = {
      action: "raise",
      sizing: 8,
      confidence: 0.87,
      explanation: "Raise is the only modeled line.",
      raw: {
        provider: "local_solver",
        engine: "postflop_solver",
        candidates,
      },
    };
    const created = jobRecord();
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(processingQueueResponse([created]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()))
      .mockResolvedValueOnce(jsonResponse({
        ...approvedJob(),
        training_decision: trainingDecision,
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...recommendedJob(),
        training_decision: trainingDecision,
        recommendation: singleLineRecommendation,
      }));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(await screen.findByRole("button", { name: "Approve state" }));
    const decisionPanel = await screen.findByLabelText("Your training decision");
    await user.click(within(decisionPanel).getByRole("button", { name: "raise" }));
    await user.type(within(decisionPanel).getByLabelText("Decision sizing in BB"), "8");
    await user.click(screen.getByRole("button", { name: "Request recommendation" }));

    const comparison = await screen.findByLabelText("Training decision comparison");
    expect(within(comparison).getByText("Matched solver")).toBeInTheDocument();
    if (expectedEvLoss) {
      expect(within(comparison).getByText(expectedEvLoss)).toBeInTheDocument();
    } else {
      expect(within(comparison).queryByText(/BB EV loss/)).not.toBeInTheDocument();
    }
    expect(within(comparison).queryByRole("button", {
      name: "Mark reviewed",
    })).not.toBeInTheDocument();
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
    const reviewedJob = {
      ...recommendedJob(),
      id: "review-job",
      original_filename: "review.png",
      training_decision: trainingDecision,
      training_reviewed_at: reviewedAt,
    };
    const reopenedJob = {
      ...reviewedJob,
      training_reviewed_at: null,
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(reviewedProgress))
      .mockResolvedValueOnce(jsonResponse(reviewedJob))
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
    expect(fetchMock().mock.calls[1][0]).toBe("http://localhost:8000/api/jobs/review-job");
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/jobs/review-job/training-review");
    expect(fetchMock().mock.calls[2][1]).toMatchObject({ method: "DELETE" });
    expect(fetchMock().mock.calls[3][0]).toBe("http://localhost:8000/api/training/progress");
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
      .mockResolvedValueOnce(jsonResponse(persistedJob))
      .mockResolvedValueOnce(jsonResponse({
        total: 1,
        jobs: [cachedJob],
        snapshot_version: "newest-history-after-write",
      }));
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
      "http://localhost:8000/api/history",
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

  it("releases legacy archive leases after deterministic migration rejection", async () => {
    const jobId = "b".repeat(32);
    const legacyJob: JobRecord = {
      ...recommendedJob(),
      id: jobId,
      original_filename: "legacy-conflict.png",
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
    fetchMock().mockResolvedValueOnce(jsonResponse({
      detail: "Only successful approved or recommended jobs can be moved to history",
    }, 409));

    render(<App />);

    expect(await screen.findByText(
      "Could not migrate legacy history before restoring processing",
    )).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull());
    expect(window.sessionStorage.getItem(
      "poker-training-history-mutation-v1",
    )).toBeNull();
    expect(fetchMock()).toHaveBeenCalledTimes(1);
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
    expect(within(evidence).getByText("Field folds 9% · each 30%")).toBeInTheDocument();
    expect(within(evidence).getByText("At current wager")).toBeInTheDocument();
    expect(within(evidence).getByText(
      "1 opponent · 10 BB committed · 13 BB total · hero 1 BB",
    )).toBeInTheDocument();
    const chosen = within(evidence).getByText("Chosen").closest('[role="listitem"]');
    expect(chosen).toHaveTextContent("raise");
    expect(chosen).toHaveTextContent("7.5 BB");
    expect(within(evidence).getAllByRole("listitem")).toHaveLength(4);
    expect(within(evidence).queryByText("invalid")).not.toBeInTheDocument();
    expect(within(evidence).getByLabelText("Decision context")).toBeInTheDocument();
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
          range_source: "preflop_chart_single_raised_pot",
          range_context: {
            scenario: "single_raised_pot",
            opener_position: "button",
            caller_position: "big_blind",
            opening_size_bb: 2.5,
            stack_depth_policy: "standard",
            starting_effective_stack_bb: 100,
            stack_depth_source: "reconstructed",
            decision_street: "turn",
            completed_street_count: 1,
            opener_fraction: 0.45,
            caller_continue_fraction: 0.4,
            caller_reraise_fraction: 0.12,
          },
          range_conditioning: {
            status: "applied",
            mode: "flop_root_posterior",
            decision_street: "turn",
            completed_streets: ["flop"],
            modeled_history: ["OOP check", "IP check", "deal Qs"],
            downstream_tree: "single_bet_no_raises",
            active_hands: { oop: 131, ip: 236 },
            hero_line_reach: 0.39559,
            compressed_memory_mb: 175.2,
            exploitability: { bb: 2.8216, pot_ratio: 0.51301 },
          },
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
    expect(within(decisionContext).getByText("Preflop chart · single-raised pot")).toBeInTheDocument();
    expect(within(decisionContext).getByText("Standard · 100 BB starting")).toBeInTheDocument();
    expect(within(decisionContext).getByText("Turn · 1 completed street")).toBeInTheDocument();
    expect(within(decisionContext).getByText("Button opens 2.5 BB · Big blind calls")).toBeInTheDocument();
    expect(within(decisionContext).getByText("Open 45% · flat 12%-40%")).toBeInTheDocument();
    expect(within(decisionContext).getByText("Applied · Flop → Turn")).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "OOP check → IP check → deal Qs",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "Hero 39.6% · OOP 131 combos · IP 236 combos",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "Single bet no raises · 175.2 MB estimate · 2.822 BB exploitability",
    )).toBeInTheDocument();

    const modeledRanges = within(evidence).getByLabelText("Modeled ranges");
    expect(modeledRanges).not.toHaveAttribute("open");
    await user.click(within(modeledRanges).getByText("Modeled ranges"));
    expect(modeledRanges).toHaveAttribute("open");
    expect(within(modeledRanges).getByText(longOopRange)).toBeVisible();
    expect(within(modeledRanges).getByText("QQ-22,AQs-A2s,ATo+")).toBeVisible();
  });

  it("shows why later-street range conditioning was skipped", async () => {
    const postflopJob: JobRecord = {
      ...recommendedJob(),
      id: "postflop-conditioning-skipped-job",
      original_filename: "conditioning-skipped.png",
      image_filename: "conditioning-skipped.png",
      recommendation: {
        action: "check",
        sizing: null,
        confidence: 0.72,
        explanation: "The postflop solver recommends checking with the selected starting ranges.",
        raw: {
          provider: "local_solver",
          engine: "postflop_solver",
          range_conditioning: {
            status: "skipped",
            reason: "conditioning tree exceeds the configured memory limit",
            estimated_compressed_memory_mb: 812.4,
            max_memory_mb: 768,
          },
          candidates: [
            { action: "check", sizing: null, frequency: 1, ev: 0 },
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
    const decisionContext = within(evidence).getByLabelText("Decision context");
    expect(within(decisionContext).getByText(
      "Skipped · conditioning tree exceeds the configured memory limit",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "812.4 MB estimate · 768 MB limit",
    )).toBeInTheDocument();
  });

  it("shows contextual limped-pot range assumptions", async () => {
    const postflopJob: JobRecord = {
      ...recommendedJob(),
      id: "limped-postflop-job",
      original_filename: "limped-postflop.png",
      image_filename: "limped-postflop.png",
      recommendation: {
        action: "check",
        sizing: null,
        confidence: 0.8,
        explanation: "The postflop solver recommends checking.",
        raw: {
          provider: "local_solver",
          engine: "postflop_solver",
          hero_position: "oop",
          range_source: "preflop_chart_limped_pot",
          range_context: {
            scenario: "limped_pot",
            limper_position: "button",
            big_blind_position: "big_blind",
            limp_size_bb: 1,
            limper_range_model: "stack_adjusted_first_in_proxy",
            limp_response_policy: "heads_up_single_limper",
            stack_depth_policy: "standard",
            starting_effective_stack_bb: 100,
            stack_depth_source: "reconstructed",
            decision_street: "turn",
            completed_street_count: 1,
            limper_fraction: 0.45,
            big_blind_raise_fraction: 0.36,
          },
          ranges: {
            oop: "72o-32o",
            ip: "AA-77,AKs-AJs",
          },
          candidates: [
            { action: "check", sizing: null, frequency: 1, ev: 0 },
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
    const decisionContext = within(evidence).getByLabelText("Decision context");
    expect(within(decisionContext).getByText(
      "Preflop chart · limped pot",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText("Standard · 100 BB starting")).toBeInTheDocument();
    expect(within(decisionContext).getByText("Turn · 1 completed street")).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "Button limps 1 BB · Big blind checks",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "Limper uses stack-adjusted first-in proxy",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "Entry 45% · BB check 36%-100%",
    )).toBeInTheDocument();
  });

  it("shows contextual isolation-raised-pot range assumptions", async () => {
    const postflopJob: JobRecord = {
      ...recommendedJob(),
      id: "isolation-raised-postflop-job",
      original_filename: "isolation-raised-postflop.png",
      image_filename: "isolation-raised-postflop.png",
      recommendation: {
        action: "check",
        sizing: null,
        confidence: 0.8,
        explanation: "The postflop solver recommends checking.",
        raw: {
          provider: "local_solver",
          engine: "postflop_solver",
          hero_position: "oop",
          range_source: "preflop_chart_isolation_raised_pot",
          range_context: {
            scenario: "isolation_raised_pot",
            limper_position: "button",
            isolation_raiser_position: "big_blind",
            limp_size_bb: 1,
            isolation_raise_size_bb: 4,
            limp_response_policy: "heads_up_single_limper",
            isolation_response_policy: "heads_up_after_hero_limp",
            isolation_raise_size_policy: "standard",
            stack_depth_policy: "standard",
            starting_effective_stack_bb: 100,
            stack_depth_source: "reconstructed",
            isolation_raiser_fraction: 0.36,
            limper_continue_fraction: 0.19,
            limper_reraise_fraction: 0.06,
          },
          ranges: {
            oop: "AA-22,AKs-A2s",
            ip: "KJs-76s,AQo-ATo",
          },
          candidates: [
            { action: "check", sizing: null, frequency: 1, ev: 0 },
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
    const decisionContext = within(evidence).getByLabelText("Decision context");
    expect(within(decisionContext).getByText(
      "Preflop chart · isolation-raised pot",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "Standard · 100 BB starting",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "Button limps 1 BB · Big blind raises 4 BB · Button calls",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "BB isolate 36% · limper call 6%-19%",
    )).toBeInTheDocument();
  });

  it("shows contextual limp-reraised-pot range assumptions", async () => {
    const postflopJob: JobRecord = {
      ...recommendedJob(),
      id: "limp-reraised-postflop-job",
      original_filename: "limp-reraised-postflop.png",
      image_filename: "limp-reraised-postflop.png",
      recommendation: {
        action: "check",
        sizing: null,
        confidence: 0.8,
        explanation: "The postflop solver recommends checking.",
        raw: {
          provider: "local_solver",
          engine: "postflop_solver",
          hero_position: "ip",
          range_source: "preflop_chart_limp_reraised_pot",
          range_context: {
            scenario: "limp_reraised_pot",
            limper_position: "utg",
            isolation_raiser_position: "button",
            limp_reraiser_position: "utg",
            limp_size_bb: 1,
            isolation_raise_size_bb: 4,
            limp_reraise_size_bb: 12,
            limp_reraise_to_isolation_ratio: 3,
            isolation_response_policy: "heads_up_after_hero_limp",
            limp_reraise_response_policy: "heads_up_original_limper_reraise",
            isolation_raise_size_policy: "standard",
            limp_reraise_size_policy: "large",
            stack_depth_policy: "standard",
            starting_effective_stack_bb: 100,
            stack_depth_source: "reconstructed",
            limper_reraise_fraction: 0.045,
            isolation_raiser_continue_fraction: 0.045,
            isolation_raiser_four_bet_fraction: 0.0209,
          },
          ranges: {
            oop: "AA-QQ,AKs",
            ip: "JJ-TT,AQs",
          },
          candidates: [
            { action: "check", sizing: null, frequency: 1, ev: 0 },
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
    const decisionContext = within(evidence).getByLabelText("Decision context");
    expect(within(decisionContext).getByText(
      "Preflop chart · limp-reraised pot",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "Standard · 100 BB starting",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "UTG limps 1 BB · Button isolates 4 BB · UTG reraises 12 BB · Button calls",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "Limper reraise 4.5% · isolator call 2.1%-4.5%",
    )).toBeInTheDocument();
  });

  it("shows contextual three-bet pot range assumptions", async () => {
    const postflopJob: JobRecord = {
      ...recommendedJob(),
      id: "three-bet-postflop-job",
      original_filename: "three-bet-postflop.png",
      image_filename: "three-bet-postflop.png",
      recommendation: {
        action: "check",
        sizing: null,
        confidence: 0.8,
        explanation: "The postflop solver recommends checking.",
        raw: {
          provider: "local_solver",
          engine: "postflop_solver",
          hero_position: "ip",
          range_source: "preflop_chart_three_bet_pot",
          range_context: {
            scenario: "three_bet_pot",
            opener_position: "button",
            three_bettor_position: "big_blind",
            opening_size_bb: 2.5,
            three_bet_size_bb: 8,
            stack_depth_policy: "standard",
            starting_effective_stack_bb: 100,
            stack_depth_source: "standard_assumption",
            three_bettor_fraction: 0.12,
            opener_continue_fraction: 0.18,
            opener_four_bet_fraction: 0.065,
          },
          ranges: {
            oop: "AA-77,AKs-AJs",
            ip: "JJ-66,AQs-ATs",
          },
          candidates: [
            { action: "check", sizing: null, frequency: 1, ev: 0 },
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
    const decisionContext = within(evidence).getByLabelText("Decision context");
    expect(within(decisionContext).getByText("Preflop chart · 3-bet pot")).toBeInTheDocument();
    expect(within(decisionContext).getByText("Standard · 100 BB assumed")).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "Button opens 2.5 BB · Big blind 3-bets 8 BB · Button calls",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText("3-bet 12% · flat 6.5%-18%")).toBeInTheDocument();
  });

  it("shows contextual cold-call three-bet pot range assumptions", async () => {
    const postflopJob: JobRecord = {
      ...recommendedJob(),
      id: "cold-three-bet-postflop-job",
      original_filename: "cold-three-bet-postflop.png",
      image_filename: "cold-three-bet-postflop.png",
      recommendation: {
        action: "check",
        sizing: null,
        confidence: 0.8,
        explanation: "The postflop solver recommends checking.",
        raw: {
          provider: "local_solver",
          engine: "postflop_solver",
          hero_position: "ip",
          range_source: "preflop_chart_cold_three_bet_pot",
          range_context: {
            scenario: "cold_three_bet_pot",
            folded_opener_position: "utg",
            folded_opener_commitment_bb: 2.5,
            three_bettor_position: "cutoff",
            cold_caller_position: "button",
            opening_size_bb: 2.5,
            three_bet_size_bb: 8,
            stack_depth_policy: "standard",
            starting_effective_stack_bb: 100,
            stack_depth_source: "reconstructed",
            decision_street: "turn",
            completed_street_count: 1,
            three_bettor_fraction: 0.05,
            cold_caller_continue_fraction: 0.05,
            cold_caller_four_bet_fraction: 0.02,
          },
          ranges: {
            oop: "AA-77,AKs-AJs",
            ip: "JJ-66,AQs-ATs",
          },
          candidates: [
            { action: "check", sizing: null, frequency: 1, ev: 0 },
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
    const decisionContext = within(evidence).getByLabelText("Decision context");
    expect(within(decisionContext).getByText(
      "Preflop chart · cold-call 3-bet pot",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText("Standard · 100 BB starting")).toBeInTheDocument();
    expect(within(decisionContext).getByText("Turn · 1 completed street")).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "UTG opens 2.5 BB · Cutoff 3-bets 8 BB · Button cold-calls · UTG folds 2.5 BB dead",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "3-bet 5% · cold-call 2%-5%",
    )).toBeInTheDocument();
  });

  it("shows contextual squeeze pot range assumptions", async () => {
    const postflopJob: JobRecord = {
      ...recommendedJob(),
      id: "squeeze-postflop-job",
      original_filename: "squeeze-postflop.png",
      image_filename: "squeeze-postflop.png",
      recommendation: {
        action: "check",
        sizing: null,
        confidence: 0.8,
        explanation: "The postflop solver recommends checking.",
        raw: {
          provider: "local_solver",
          engine: "postflop_solver",
          hero_position: "ip",
          range_source: "preflop_chart_squeeze_pot",
          range_context: {
            scenario: "squeeze_pot",
            folded_opener_position: "utg",
            folded_opener_commitment_bb: 2.5,
            caller_position: "button",
            squeezer_position: "small_blind",
            opening_size_bb: 2.5,
            squeeze_size_bb: 10,
            stack_depth_policy: "standard",
            starting_effective_stack_bb: 100,
            stack_depth_source: "reconstructed",
            decision_street: "turn",
            completed_street_count: 1,
            squeezer_fraction: 0.045,
            caller_continue_fraction: 0.0405,
            caller_four_bet_fraction: 0.019,
          },
          ranges: {
            oop: "AA-77,AKs-AJs",
            ip: "JJ-66,AQs-ATs",
          },
          candidates: [
            { action: "check", sizing: null, frequency: 1, ev: 0 },
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
    const decisionContext = within(evidence).getByLabelText("Decision context");
    expect(within(decisionContext).getByText(
      "Preflop chart · squeeze pot",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText("Standard · 100 BB starting")).toBeInTheDocument();
    expect(within(decisionContext).getByText("Turn · 1 completed street")).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "UTG opens 2.5 BB · Button calls · Small blind squeezes 10 BB · Button calls · UTG folds 2.5 BB dead",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "Squeeze 4.5% · call 1.9%-4%",
    )).toBeInTheDocument();
  });

  it("shows contextual four-bet pot range assumptions", async () => {
    const postflopJob: JobRecord = {
      ...recommendedJob(),
      id: "four-bet-postflop-job",
      original_filename: "four-bet-postflop.png",
      image_filename: "four-bet-postflop.png",
      recommendation: {
        action: "check",
        sizing: null,
        confidence: 0.8,
        explanation: "The postflop solver recommends checking.",
        raw: {
          provider: "local_solver",
          engine: "postflop_solver",
          hero_position: "ip",
          range_source: "preflop_chart_four_bet_pot",
          range_context: {
            scenario: "four_bet_pot",
            opener_position: "button",
            three_bettor_position: "big_blind",
            opening_size_bb: 2.5,
            three_bet_size_bb: 8,
            four_bet_size_bb: 20,
            stack_depth_policy: "medium",
            starting_effective_stack_bb: 50,
            stack_depth_source: "reconstructed",
            opener_four_bet_fraction: 0.0747,
            three_bettor_continue_fraction: 0.0665,
            three_bettor_five_bet_fraction: 0.0437,
          },
          ranges: {
            oop: "JJ-77,AQs-AJs",
            ip: "AA-JJ,AKs",
          },
          candidates: [
            { action: "check", sizing: null, frequency: 1, ev: 0 },
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
    const decisionContext = within(evidence).getByLabelText("Decision context");
    expect(within(decisionContext).getByText("Preflop chart · 4-bet pot")).toBeInTheDocument();
    expect(within(decisionContext).getByText("Medium · 50 BB starting")).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "Button opens 2.5 BB · Big blind 3-bets 8 BB · Button 4-bets 20 BB · Big blind calls",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText("4-bet 7.5% · flat 4.4%-6.7%")).toBeInTheDocument();
  });

  it("shows contextual cold four-bet pot range assumptions", async () => {
    const postflopJob: JobRecord = {
      ...recommendedJob(),
      id: "cold-four-bet-postflop-job",
      original_filename: "cold-four-bet-postflop.png",
      image_filename: "cold-four-bet-postflop.png",
      recommendation: {
        action: "check",
        sizing: null,
        confidence: 0.8,
        explanation: "The postflop solver recommends checking.",
        raw: {
          provider: "local_solver",
          engine: "postflop_solver",
          hero_position: "ip",
          range_source: "preflop_chart_cold_four_bet_pot",
          range_context: {
            scenario: "cold_four_bet_pot",
            folded_opener_position: "utg",
            folded_opener_commitment_bb: 2.5,
            three_bettor_position: "cutoff",
            cold_four_bettor_position: "button",
            opening_size_bb: 2.5,
            three_bet_size_bb: 8,
            four_bet_size_bb: 20,
            stack_depth_policy: "standard",
            starting_effective_stack_bb: 100,
            stack_depth_source: "reconstructed",
            cold_four_bettor_four_bet_fraction: 0.02,
            three_bettor_continue_fraction: 0.027,
            three_bettor_five_bet_fraction: 0.016,
          },
          ranges: {
            oop: "QQ,JJ",
            ip: "AA,KK,QQ",
          },
          candidates: [
            { action: "check", sizing: null, frequency: 1, ev: 0 },
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
    const decisionContext = within(evidence).getByLabelText("Decision context");
    expect(within(decisionContext).getByText(
      "Preflop chart · cold 4-bet pot",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText("Standard · 100 BB starting")).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "UTG opens 2.5 BB · Cutoff 3-bets 8 BB · Button cold 4-bets 20 BB · UTG folds 2.5 BB dead · Cutoff calls",
    )).toBeInTheDocument();
    expect(within(decisionContext).getByText(
      "Cold 4-bet 2% · flat 1.6%-2.7%",
    )).toBeInTheDocument();
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
          range_conditioning: {
            status: "pending",
            hero_line_reach: 4,
            compressed_memory_mb: -10,
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

  it("shows heads-up limp response chart context", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "heads-up-limp-chart-job",
      original_filename: "heads-up-limp.png",
      image_filename: "heads-up-limp.png",
      recommendation: {
        action: "raise",
        sizing: 4,
        confidence: 0.82,
        explanation: "The preflop chart recommends an isolation raise to 4 BB.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0059,
          policy_fraction: 0.468,
          stack_depth_policy: "short",
          effective_stack: 20,
          limper_position: "button",
          limp_size: 1,
          limp_response_policy: "heads_up_single_limper",
          base_limp_raise_fraction: 0.36,
          limp_raise_fraction: 0.468,
          target_limp_raise_size: 4,
          maximum_limp_raise_total: 21,
          candidates: [
            { action: "check", sizing: null, frequency: 0 },
            { action: "raise", sizing: 4, frequency: 1 },
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
    expect(within(chartContext).getByText("Button")).toBeInTheDocument();
    expect(within(chartContext).getByText("Heads up single limper")).toBeInTheDocument();
    expect(within(chartContext).getByText("46.8% (base 36%)")).toBeInTheDocument();
    expect(within(chartContext).getByText("1 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("4 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("21 BB")).toBeInTheDocument();
  });

  it("shows two-limper big-blind chart context", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "two-limper-chart-job",
      original_filename: "two-limpers.png",
      image_filename: "two-limpers.png",
      recommendation: {
        action: "raise",
        sizing: 5.25,
        confidence: 0.8,
        explanation: "The preflop chart recommends isolating two limpers.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0059,
          policy_fraction: 0.16,
          stack_depth_policy: "standard",
          effective_stack: 100,
          limper_positions: ["utg", "button"],
          limper_count: 2,
          limp_size: 1,
          multi_limp_response_policy: "big_blind_two_limpers",
          base_multi_limp_raise_fraction: 0.16,
          multi_limp_raise_fraction: 0.16,
          target_multi_limp_raise_size: 5.25,
          maximum_multi_limp_raise_total: 101,
          candidates: [
            { action: "check", sizing: null, frequency: 0 },
            { action: "raise", sizing: 5.25, frequency: 1 },
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
    expect(within(chartContext).getByText("Standard · 100 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("Limpers")).toBeInTheDocument();
    expect(within(chartContext).getByText("UTG · Button")).toBeInTheDocument();
    expect(within(chartContext).getByText("Big blind two limpers")).toBeInTheDocument();
    expect(within(chartContext).getByText("16%")).toBeInTheDocument();
    expect(within(chartContext).getByText("1 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("5.25 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("101 BB")).toBeInTheDocument();
  });

  it("shows three-limper big-blind chart context", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "three-limper-chart-job",
      original_filename: "three-limpers.png",
      image_filename: "three-limpers.png",
      recommendation: {
        action: "raise",
        sizing: 6.75,
        confidence: 0.8,
        explanation: "The preflop chart recommends isolating three limpers.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0059,
          policy_fraction: 0.12,
          stack_depth_policy: "standard",
          effective_stack: 100,
          limper_positions: ["utg", "cutoff", "button"],
          limper_count: 3,
          limp_size: 1,
          multi_limp_response_policy: "big_blind_three_limpers",
          base_multi_limp_raise_fraction: 0.12,
          multi_limp_raise_fraction: 0.12,
          target_multi_limp_raise_size: 6.75,
          maximum_multi_limp_raise_total: 101,
          candidates: [
            { action: "check", sizing: null, frequency: 0 },
            { action: "raise", sizing: 6.75, frequency: 1 },
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
    expect(within(chartContext).getByText("Standard · 100 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("Limpers")).toBeInTheDocument();
    expect(within(chartContext).getByText("UTG · Cutoff · Button")).toBeInTheDocument();
    expect(within(chartContext).getByText("Big blind three limpers")).toBeInTheDocument();
    expect(within(chartContext).getByText("12%")).toBeInTheDocument();
    expect(within(chartContext).getByText("1 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("6.75 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("101 BB")).toBeInTheDocument();
  });

  it("shows four-limper big-blind chart context", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "four-limper-chart-job",
      original_filename: "four-limpers.png",
      image_filename: "four-limpers.png",
      recommendation: {
        action: "raise",
        sizing: 8.25,
        confidence: 0.8,
        explanation: "The preflop chart recommends isolating four limpers.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0059,
          policy_fraction: 0.075,
          stack_depth_policy: "standard",
          effective_stack: 100,
          limper_positions: ["utg", "hijack", "cutoff", "button"],
          limper_count: 4,
          limp_size: 1,
          multi_limp_response_policy: "big_blind_four_limpers",
          base_multi_limp_raise_fraction: 0.075,
          multi_limp_raise_fraction: 0.075,
          target_multi_limp_raise_size: 8.25,
          maximum_multi_limp_raise_total: 101,
          candidates: [
            { action: "check", sizing: null, frequency: 0 },
            { action: "raise", sizing: 8.25, frequency: 1 },
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
    expect(within(chartContext).getByText("Standard · 100 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("Limpers")).toBeInTheDocument();
    expect(
      within(chartContext).getByText("UTG · Hijack · Cutoff · Button"),
    ).toBeInTheDocument();
    expect(within(chartContext).getByText("Big blind four limpers")).toBeInTheDocument();
    expect(within(chartContext).getByText("7.5%")).toBeInTheDocument();
    expect(within(chartContext).getByText("1 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("8.25 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("101 BB")).toBeInTheDocument();
  });

  it("shows five-limper big-blind chart context", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "five-limper-chart-job",
      original_filename: "five-limpers.png",
      image_filename: "five-limpers.png",
      recommendation: {
        action: "raise",
        sizing: 9,
        confidence: 0.8,
        explanation: "The preflop chart recommends isolating five limpers.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0059,
          policy_fraction: 0.06,
          stack_depth_policy: "standard",
          effective_stack: 100,
          limper_positions: ["utg", "hijack", "cutoff", "button", "small_blind"],
          limper_count: 5,
          limp_size: 1,
          multi_limp_response_policy: "big_blind_five_limpers",
          base_multi_limp_raise_fraction: 0.06,
          multi_limp_raise_fraction: 0.06,
          target_multi_limp_raise_size: 9,
          maximum_multi_limp_raise_total: 101,
          candidates: [
            { action: "check", sizing: null, frequency: 0 },
            { action: "raise", sizing: 9, frequency: 1 },
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
    expect(within(chartContext).getByText("Standard · 100 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("Limpers")).toBeInTheDocument();
    expect(
      within(chartContext).getByText("UTG · Hijack · Cutoff · Button · Small blind"),
    ).toBeInTheDocument();
    expect(within(chartContext).getByText("Big blind five limpers")).toBeInTheDocument();
    expect(within(chartContext).getByText("6%")).toBeInTheDocument();
    expect(within(chartContext).getByText("1 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("9 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("101 BB")).toBeInTheDocument();
  });

  it("shows isolation-raise response chart context", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "isolation-response-chart-job",
      original_filename: "isolation-response.png",
      image_filename: "isolation-response.png",
      recommendation: {
        action: "call",
        sizing: null,
        confidence: 0.8,
        explanation: "The preflop chart recommends continuing after the isolation raise.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0473,
          policy_fraction: 0.14,
          stack_depth_policy: "standard",
          effective_stack: 90,
          limper_position: "utg",
          limp_size: 1,
          isolation_raiser_position: "button",
          isolation_raise_size: 4,
          isolation_raise_to_limp_ratio: 4,
          isolation_raise_size_policy: "standard",
          isolation_response_policy: "heads_up_after_hero_limp",
          continue_fraction: 0.14,
          reraise_fraction: 0.045,
          maximum_reraise_total: 94,
          candidates: [
            { action: "fold", sizing: null, frequency: 0 },
            { action: "call", sizing: null, frequency: 1 },
            { action: "raise", sizing: null, frequency: 0 },
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
    expect(within(chartContext).getByText("Hero limper")).toBeInTheDocument();
    expect(within(chartContext).getByText("UTG")).toBeInTheDocument();
    expect(within(chartContext).getByText("Button")).toBeInTheDocument();
    expect(within(chartContext).getByText("4 BB · 4x limp · Standard")).toBeInTheDocument();
    expect(within(chartContext).getByText("Heads up after hero limp")).toBeInTheDocument();
    expect(within(chartContext).getByText("Continue 14% · Reraise 4.5%")).toBeInTheDocument();
    expect(within(chartContext).getByText("94 BB")).toBeInTheDocument();
    expect(within(chartContext).queryByText("Opener")).not.toBeInTheDocument();
    expect(within(chartContext).queryByText("3-bettor")).not.toBeInTheDocument();
  });

  it("shows original-limper reraise chart context", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "limp-reraise-chart-job",
      original_filename: "limp-reraise.png",
      image_filename: "limp-reraise.png",
      recommendation: {
        action: "call",
        sizing: null,
        confidence: 0.8,
        explanation: "The preflop chart recommends continuing against the limp-reraise.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0355,
          policy_fraction: 0.045,
          stack_depth_policy: "standard",
          effective_stack: 88,
          limper_position: "utg",
          limp_size: 1,
          hero_isolation_raise_size: 4,
          limp_reraiser_position: "utg",
          limp_reraise_size: 12,
          limp_reraise_to_isolation_ratio: 3,
          limp_reraise_size_policy: "large",
          limp_reraise_response_policy: "heads_up_original_limper_reraise",
          continue_fraction: 0.045,
          four_bet_fraction: 0.0209,
          maximum_four_bet_total: 100,
          candidates: [
            { action: "fold", sizing: null, frequency: 0 },
            { action: "call", sizing: null, frequency: 1 },
            { action: "raise", sizing: null, frequency: 0 },
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
    expect(within(chartContext).getByText("Original limper")).toBeInTheDocument();
    expect(within(chartContext).getByText("Hero isolation")).toBeInTheDocument();
    expect(within(chartContext).getByText("Limp reraiser")).toBeInTheDocument();
    expect(within(chartContext).getAllByText("UTG")).toHaveLength(2);
    expect(within(chartContext).getByText("4 BB")).toBeInTheDocument();
    expect(within(chartContext).getByText("12 BB · 3x isolation · Large")).toBeInTheDocument();
    expect(within(chartContext).getByText("Heads up original limper reraise")).toBeInTheDocument();
    expect(within(chartContext).getByText("Continue 4.5% · Four-bet 2.1%")).toBeInTheDocument();
    expect(within(chartContext).getByText("100 BB")).toBeInTheDocument();
    expect(within(chartContext).queryByText("Opener")).not.toBeInTheDocument();
    expect(within(chartContext).queryByText("3-bettor")).not.toBeInTheDocument();
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

  it("shows structured multi-caller chart context", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "multi-caller-chart-job",
      original_filename: "multi-called-open.png",
      image_filename: "multi-called-open.png",
      recommendation: {
        action: "raise",
        sizing: 12.5,
        confidence: 0.78,
        explanation: "The preflop chart recommends a conservative squeeze.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0059,
          policy_fraction: 0.045,
          stack_depth_policy: "standard",
          effective_stack: 100,
          opener_position: "utg",
          opening_raise_size: 2.5,
          caller_positions: ["hijack", "cutoff"],
          caller_count: 2,
          caller_adjustment_policy: "double_caller_conservative",
          squeeze_open_multiple: 5,
          continue_fraction: 0.112,
          reraise_fraction: 0.0425,
          maximum_reraise_total: 100,
          candidates: [
            { action: "fold", sizing: null, frequency: 0 },
            { action: "call", sizing: null, frequency: 0 },
            { action: "raise", sizing: 12.5, frequency: 1 },
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
    expect(within(chartContext).getByText("UTG")).toBeInTheDocument();
    expect(within(chartContext).getByText("Hijack · Cutoff")).toBeInTheDocument();
    expect(within(chartContext).getByText("Double caller conservative · 5x squeeze")).toBeInTheDocument();
    expect(within(chartContext).getByText("Continue 11.2% · Reraise 4.3%")).toBeInTheDocument();
    expect(within(chartContext).getByText("100 BB")).toBeInTheDocument();
  });

  it("shows all three callers in a triple-caller chart context", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "triple-caller-chart-job",
      original_filename: "triple-called-open.png",
      image_filename: "triple-called-open.png",
      recommendation: {
        action: "raise",
        sizing: 15,
        confidence: 0.8,
        explanation: "The preflop chart recommends a conservative squeeze.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0059,
          policy_fraction: 0.04,
          stack_depth_policy: "standard",
          effective_stack: 100,
          opener_position: "utg",
          opening_raise_size: 2.5,
          caller_positions: ["hijack", "cutoff", "button"],
          caller_count: 3,
          caller_adjustment_policy: "triple_caller_conservative",
          squeeze_open_multiple: 6,
          continue_fraction: 0.084,
          reraise_fraction: 0.04,
          maximum_reraise_total: 100.5,
          candidates: [
            { action: "fold", sizing: null, frequency: 0 },
            { action: "call", sizing: null, frequency: 0 },
            { action: "raise", sizing: 15, frequency: 1 },
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
    expect(within(chartContext).getByText("Hijack · Cutoff · Button")).toBeInTheDocument();
    expect(within(chartContext).getByText("Triple caller conservative · 6x squeeze")).toBeInTheDocument();
    expect(within(chartContext).getByText("Continue 8.4% · Reraise 4%")).toBeInTheDocument();
    expect(within(chartContext).getByText("100.5 BB")).toBeInTheDocument();
  });

  it("shows all four callers in the terminal full-table chart context", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "four-caller-chart-job",
      original_filename: "four-called-open.png",
      image_filename: "four-called-open.png",
      recommendation: {
        action: "raise",
        sizing: 17.5,
        confidence: 0.8,
        explanation: "The preflop chart recommends a full-table squeeze.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0059,
          policy_fraction: 0.045,
          stack_depth_policy: "standard",
          effective_stack: 100,
          opener_position: "utg",
          opening_raise_size: 2.5,
          caller_positions: ["hijack", "cutoff", "button", "small_blind"],
          caller_count: 4,
          caller_adjustment_policy: "four_caller_conservative",
          squeeze_open_multiple: 7,
          continue_fraction: 0.12,
          reraise_fraction: 0.045,
          maximum_reraise_total: 101,
          candidates: [
            { action: "fold", sizing: null, frequency: 0 },
            { action: "call", sizing: null, frequency: 0 },
            { action: "raise", sizing: 17.5, frequency: 1 },
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
    expect(within(chartContext).getByText("Hijack · Cutoff · Button · Small blind")).toBeInTheDocument();
    expect(within(chartContext).getByText("Four caller conservative · 7x squeeze")).toBeInTheDocument();
    expect(within(chartContext).getByText("Continue 12% · Reraise 4.5%")).toBeInTheDocument();
    expect(within(chartContext).getByText("101 BB")).toBeInTheDocument();
  });

  it("shows structured three-bet chart context", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "three-bet-chart-job",
      original_filename: "three-bet.png",
      image_filename: "three-bet.png",
      recommendation: {
        action: "raise",
        sizing: 17.6,
        confidence: 0.78,
        explanation: "The preflop chart recommends a four-bet.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0059,
          policy_fraction: 0.045,
          stack_depth_policy: "standard",
          effective_stack: 92,
          opener_position: "cutoff",
          opening_raise_size: 2.5,
          three_bettor_position: "button",
          three_bet_size: 8,
          three_bet_to_open_ratio: 3.2,
          three_bet_size_policy: "standard",
          continue_fraction: 0.12,
          four_bet_fraction: 0.045,
          maximum_four_bet_total: 100,
          candidates: [
            { action: "fold", sizing: null, frequency: 0 },
            { action: "call", sizing: null, frequency: 0 },
            { action: "raise", sizing: 17.6, frequency: 1 },
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
    expect(within(chartContext).getByText("Button")).toBeInTheDocument();
    expect(within(chartContext).getByText("8 BB · 3.2x · Standard")).toBeInTheDocument();
    expect(within(chartContext).getByText("Continue 12% · Four-bet 4.5%")).toBeInTheDocument();
    expect(within(chartContext).getByText("100 BB")).toBeInTheDocument();
  });

  it("identifies conservative cold three-bet chart evidence", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "cold-three-bet-chart-job",
      original_filename: "cold-three-bet.png",
      image_filename: "cold-three-bet.png",
      recommendation: {
        action: "call",
        sizing: null,
        confidence: 0.75,
        explanation: "The preflop chart recommends a conservative cold call.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0355,
          policy_fraction: 0.06,
          stack_depth_policy: "standard",
          effective_stack: 92,
          opener_position: "utg",
          opening_raise_size: 2.5,
          three_bettor_position: "button",
          three_bet_size: 8,
          three_bet_to_open_ratio: 3.2,
          three_bet_size_policy: "standard",
          cold_three_bet_policy: "conservative_three_player",
          continue_fraction: 0.06,
          four_bet_fraction: 0.025,
          maximum_four_bet_total: 100,
          candidates: [
            { action: "fold", sizing: null, frequency: 0 },
            { action: "call", sizing: null, frequency: 1 },
            { action: "raise", sizing: null, frequency: 0 },
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
    expect(within(chartContext).getByText("UTG")).toBeInTheDocument();
    expect(within(chartContext).getByText("Button")).toBeInTheDocument();
    expect(within(chartContext).getByText("Conservative three player")).toBeInTheDocument();
    expect(within(chartContext).getByText("Continue 6% · Four-bet 2.5%")).toBeInTheDocument();
    expect(within(chartContext).getByText("100 BB")).toBeInTheDocument();
  });

  it("identifies a heads-up squeeze response after hero calls", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "squeeze-response-chart-job",
      original_filename: "squeeze-response.png",
      image_filename: "squeeze-response.png",
      recommendation: {
        action: "call",
        sizing: null,
        confidence: 0.75,
        explanation: "The preflop chart recommends a conservative call.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0355,
          policy_fraction: 0.0405,
          stack_depth_policy: "standard",
          effective_stack: 90,
          opener_position: "utg",
          opening_raise_size: 2.5,
          hero_prior_commitment: 2.5,
          three_bettor_position: "small_blind",
          three_bet_size: 10,
          three_bet_to_open_ratio: 4,
          three_bet_size_policy: "large",
          squeeze_response_policy: "conservative_heads_up_squeeze",
          continue_fraction: 0.0405,
          four_bet_fraction: 0.019,
          maximum_four_bet_total: 100,
          candidates: [
            { action: "fold", sizing: null, frequency: 0 },
            { action: "call", sizing: null, frequency: 1 },
            { action: "raise", sizing: null, frequency: 0 },
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
    expect(within(chartContext).getByText("UTG")).toBeInTheDocument();
    expect(within(chartContext).getByText("Small blind")).toBeInTheDocument();
    expect(within(chartContext).getAllByText("2.5 BB")).toHaveLength(2);
    expect(
      within(chartContext).getByText("Conservative heads up squeeze"),
    ).toBeInTheDocument();
    expect(within(chartContext).getByText("10 BB · 4x · Large")).toBeInTheDocument();
    expect(within(chartContext).getByText("Continue 4% · Four-bet 1.9%"))
      .toBeInTheDocument();
    expect(within(chartContext).getByText("100 BB")).toBeInTheDocument();
  });

  it("shows structured four-bet response evidence", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "four-bet-chart-job",
      original_filename: "four-bet.png",
      image_filename: "four-bet.png",
      recommendation: {
        action: "raise",
        sizing: 100,
        confidence: 0.78,
        explanation: "The preflop chart recommends a five-bet all-in.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0059,
          policy_fraction: 0.028,
          stack_depth_policy: "standard",
          effective_stack: 80,
          opener_position: "cutoff",
          opening_raise_size: 2.5,
          three_bettor_position: "button",
          three_bet_size: 8,
          three_bet_to_open_ratio: 3.2,
          four_bettor_position: "cutoff",
          four_bet_size: 20,
          four_bet_to_three_bet_ratio: 2.5,
          four_bet_size_policy: "standard",
          continue_fraction: 0.05,
          five_bet_fraction: 0.028,
          maximum_five_bet_total: 100,
          candidates: [
            { action: "fold", sizing: null, frequency: 0 },
            { action: "call", sizing: null, frequency: 0 },
            { action: "raise", sizing: 100, frequency: 1 },
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
    expect(within(chartContext).getAllByText("Cutoff")).toHaveLength(2);
    expect(within(chartContext).getByText("Button")).toBeInTheDocument();
    expect(within(chartContext).getByText("8 BB · 3.2x")).toBeInTheDocument();
    expect(within(chartContext).getByText("20 BB · 2.5x · Standard")).toBeInTheDocument();
    expect(within(chartContext).getByText("Continue 5% · Five-bet 2.8%")).toBeInTheDocument();
    expect(within(chartContext).getByText("100 BB")).toBeInTheDocument();
  });

  it("identifies conservative cold four-bet response evidence", async () => {
    const chartJob: JobRecord = {
      ...recommendedJob(),
      id: "cold-four-bet-chart-job",
      original_filename: "cold-four-bet.png",
      image_filename: "cold-four-bet.png",
      recommendation: {
        action: "call",
        sizing: null,
        confidence: 0.76,
        explanation: "The preflop chart recommends a conservative call.",
        raw: {
          provider: "local_solver",
          engine: "preflop_chart_v1",
          hand_top_fraction: 0.0178,
          policy_fraction: 0.027,
          stack_depth_policy: "standard",
          effective_stack: 80,
          opener_position: "utg",
          opening_raise_size: 2.5,
          three_bettor_position: "cutoff",
          three_bet_size: 8,
          three_bet_to_open_ratio: 3.2,
          four_bettor_position: "button",
          four_bet_size: 20,
          four_bet_to_three_bet_ratio: 2.5,
          four_bet_size_policy: "standard",
          cold_four_bet_policy: "conservative_heads_up_after_opener_folds",
          continue_fraction: 0.027,
          five_bet_fraction: 0.016,
          maximum_five_bet_total: 100,
          candidates: [
            { action: "fold", sizing: null, frequency: 0 },
            { action: "call", sizing: null, frequency: 1 },
            { action: "raise", sizing: null, frequency: 0 },
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
    expect(within(chartContext).getByText("UTG")).toBeInTheDocument();
    expect(within(chartContext).getByText("Cutoff")).toBeInTheDocument();
    expect(within(chartContext).getByText("Button")).toBeInTheDocument();
    expect(
      within(chartContext).getByText("Conservative heads up after opener folds"),
    ).toBeInTheDocument();
    expect(within(chartContext).getByText("Continue 2.7% · Five-bet 1.6%"))
      .toBeInTheDocument();
    expect(within(chartContext).getByText("100 BB")).toBeInTheDocument();
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

  it("submits structured preflop history and synchronizes opener context", async () => {
    const preflopState: DetectedState = {
      ...detectedState,
      board_cards: [],
      pot_size: 12,
      current_bet: 5.5,
      hero_stack: 97.5,
      effective_stack: 92,
      players_in_hand: 6,
      hero_position: "cutoff",
      street: "preflop",
      facing_action: "raise",
      action_context: "Hero faces a 3-bet",
    };
    const parsedJob = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: preflopState,
      },
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(parsedJob, 201))
      .mockResolvedValueOnce(processingQueueResponse([parsedJob]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(screen.getByRole("button", { name: "Add preflop action" }));
    await user.type(screen.getByLabelText("Preflop action 1 amount"), "2.5");
    await user.click(screen.getByRole("button", { name: "Add preflop action" }));
    await user.type(screen.getByLabelText("Preflop action 2 amount"), "8");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(3));
    const payload = JSON.parse(String(fetchMock().mock.calls[2][1]?.body));
    expect(payload.preflop_opener_position).toBe("cutoff");
    expect(payload.preflop_open_size).toBe(2.5);
    expect(payload.preflop_action_history).toEqual([
      { actor: "cutoff", action: "raise", amount: 2.5 },
      { actor: "button", action: "raise", amount: 8 },
    ]);
  });

  it("clears stale opener context for call-first structured history", async () => {
    const preflopState: DetectedState = {
      ...detectedState,
      board_cards: [],
      pot_size: 6.5,
      current_bet: 3,
      hero_stack: 99,
      effective_stack: 90,
      players_in_hand: 2,
      hero_position: "utg",
      preflop_opener_position: "cutoff",
      preflop_open_size: 2.5,
      preflop_action_history: [
        { actor: "utg", action: "call", amount: 1 },
        { actor: "button", action: "raise", amount: 4 },
      ],
      street: "preflop",
      facing_action: "raise",
      action_context: "Hero limped and faces an isolation raise",
    };
    const parsedJob = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: preflopState,
      },
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(parsedJob, 201))
      .mockResolvedValueOnce(processingQueueResponse([parsedJob]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(3));
    const payload = JSON.parse(String(fetchMock().mock.calls[2][1]?.body));
    expect(payload.preflop_opener_position).toBeNull();
    expect(payload.preflop_open_size).toBeNull();
    expect(payload.preflop_action_history).toEqual([
      { actor: "utg", action: "call", amount: 1 },
      { actor: "button", action: "raise", amount: 4 },
    ]);
  });

  it("loads structured preflop history into editable controls", async () => {
    const preflopState: DetectedState = {
      ...detectedState,
      board_cards: [],
      pot_size: 12,
      current_bet: 5.5,
      hero_stack: 97.5,
      effective_stack: 92,
      players_in_hand: 6,
      hero_position: "cutoff",
      preflop_opener_position: "cutoff",
      preflop_open_size: 2.5,
      preflop_action_history: [
        { actor: "cutoff", action: "raise", amount: 2.5 },
        { actor: "button", action: "raise", amount: 8 },
      ],
      street: "preflop",
      facing_action: "raise",
      action_context: "Hero faces a 3-bet",
    };
    const parsedJob = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: preflopState,
      },
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(parsedJob, 201))
      .mockResolvedValueOnce(processingQueueResponse([parsedJob]));
    render(<App />);

    await uploadScreenshot();

    expect(await screen.findByLabelText("Preflop action 1 actor")).toHaveValue("cutoff");
    expect(screen.getByLabelText("Preflop action 1 amount")).toHaveValue("2.5");
    expect(screen.getByLabelText("Preflop action 2 actor")).toHaveValue("button");
    expect(screen.getByLabelText("Preflop action 2 amount")).toHaveValue("8");
    expect(screen.queryByLabelText(/Opener position/)).not.toBeInTheDocument();
  });

  it("preserves hidden preflop history when approving a postflop state", async () => {
    const postflopState: DetectedState = {
      ...detectedState,
      opponent_stack: 90,
      preflop_opener_position: "cutoff",
      preflop_open_size: 2.5,
      preflop_action_history: [
        { actor: "cutoff", action: "raise", amount: 2.5 },
        { actor: "button", action: "raise", amount: 8 },
      ],
      facing_action: "raise",
      postflop_action_history: [
        { actor: "oop", action: "bet", amount: 2.5 },
        { actor: "ip", action: "raise", amount: 7.5 },
      ],
    };
    const parsedJob = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: postflopState,
      },
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(parsedJob, 201))
      .mockResolvedValueOnce(processingQueueResponse([parsedJob]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()));
    render(<App />);

    const user = await uploadScreenshot();
    expect(screen.queryByRole("button", { name: "Add preflop action" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/Street/), "turn");
    await user.selectOptions(screen.getByLabelText(/Facing action/), "bet");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(3));
    const payload = JSON.parse(String(fetchMock().mock.calls[2][1]?.body));
    expect(payload.preflop_opener_position).toBe("cutoff");
    expect(payload.preflop_open_size).toBe(2.5);
    expect(payload.preflop_action_history).toEqual([
      { actor: "cutoff", action: "raise", amount: 2.5 },
      { actor: "button", action: "raise", amount: 8 },
    ]);
  });

  it("submits structured postflop history for a raised decision", async () => {
    const raisedState: DetectedState = {
      ...detectedState,
      pot_size: 19,
      current_bet: 5,
      hero_stack: 98,
      effective_stack: 93,
      players_in_hand: 2,
      hero_position: "OOP",
      facing_action: "raise",
      action_context: "Hero bet 2 BB and faces a raise to 7 BB",
    };
    const parsedJob = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: raisedState,
      },
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(parsedJob, 201))
      .mockResolvedValueOnce(processingQueueResponse([parsedJob]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()));
    render(<App />);

    const user = await uploadScreenshot();
    await user.type(await screen.findByLabelText(/Opponent stack/), "93");
    await user.click(screen.getByRole("button", { name: "Add action" }));
    await user.selectOptions(screen.getByLabelText("Action 1 type"), "bet");
    await user.type(screen.getByLabelText("Action 1 amount"), "2");
    await user.click(screen.getByRole("button", { name: "Add action" }));
    await user.selectOptions(screen.getByLabelText("Action 2 type"), "raise");
    await user.type(screen.getByLabelText("Action 2 amount"), "7");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(3));
    const payload = JSON.parse(String(fetchMock().mock.calls[2][1]?.body));
    expect(payload.opponent_stack).toBe(93);
    expect(payload.postflop_action_history).toEqual([
      { actor: "oop", action: "bet", amount: 2 },
      { actor: "ip", action: "raise", amount: 7 },
    ]);
  });

  it("loads and submits completed street history for a turn decision", async () => {
    const turnState: DetectedState = {
      ...detectedState,
      board_cards: [
        ...detectedState.board_cards,
        { rank: "2", suit: "diamonds" },
      ],
      pot_size: 9.5,
      current_bet: 0,
      hero_stack: 95.5,
      opponent_stack: 95.5,
      effective_stack: 95.5,
      players_in_hand: 2,
      hero_position: "OOP",
      opponent_position: "IP",
      street: "turn",
      facing_action: null,
      completed_postflop_streets: [
        {
          street: "flop",
          actions: [
            { actor: "oop", action: "bet", amount: 2 },
            { actor: "ip", action: "call", amount: 2 },
          ],
        },
      ],
    };
    const parsedJob = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: turnState,
      },
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(parsedJob, 201))
      .mockResolvedValueOnce(processingQueueResponse([parsedJob]))
      .mockResolvedValueOnce(jsonResponse(approvedJob()));
    render(<App />);

    const user = await uploadScreenshot();
    expect(await screen.findByLabelText("Completed action 1 street")).toHaveValue("flop");
    expect(screen.getByLabelText("Completed action 1 actor")).toHaveValue("oop");
    expect(screen.getByLabelText("Completed action 1 type")).toHaveValue("bet");
    expect(screen.getByLabelText("Completed action 1 amount")).toHaveValue("2");
    expect(screen.getByLabelText("Completed action 2 actor")).toHaveValue("ip");
    expect(screen.getByLabelText("Completed action 2 type")).toHaveValue("call");
    expect(screen.getByLabelText(/Opponent stack/)).toHaveValue("95.5");

    await user.click(screen.getByRole("button", { name: "Approve state" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(3));
    const payload = JSON.parse(String(fetchMock().mock.calls[2][1]?.body));
    expect(payload.completed_postflop_streets).toEqual([
      {
        street: "flop",
        actions: [
          { actor: "oop", action: "bet", amount: 2 },
          { actor: "ip", action: "call", amount: 2 },
        ],
      },
    ]);
  });

  it("adds river history actions to a street with remaining capacity", async () => {
    const riverState: DetectedState = {
      ...detectedState,
      board_cards: [
        ...detectedState.board_cards,
        { rank: "2", suit: "diamonds" },
        { rank: "3", suit: "clubs" },
      ],
      street: "river",
      facing_action: null,
      completed_postflop_streets: [
        {
          street: "flop",
          actions: [
            { actor: "oop", action: "bet", amount: 1 },
            { actor: "ip", action: "raise", amount: 2 },
            { actor: "oop", action: "raise", amount: 3 },
            { actor: "ip", action: "raise", amount: 4 },
            { actor: "oop", action: "raise", amount: 5 },
            { actor: "ip", action: "raise", amount: 6 },
            { actor: "oop", action: "raise", amount: 7 },
            { actor: "ip", action: "call", amount: 7 },
          ],
        },
      ],
    };
    const parsedJob = jobRecord({
      parser_result: {
        ...jobRecord().parser_result!,
        state: riverState,
      },
    });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(parsedJob, 201))
      .mockResolvedValueOnce(processingQueueResponse([parsedJob]));
    render(<App />);

    const user = await uploadScreenshot();
    await user.click(screen.getByRole("button", { name: "Add action" }));

    const addedStreet = screen.getByLabelText("Completed action 9 street");
    expect(addedStreet).toHaveValue("turn");
    expect(within(addedStreet).getByRole("option", { name: "Flop" })).toBeDisabled();
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
    expect(fetchMock().mock.calls[1][1]).toMatchObject({
      method: "POST",
      headers: {
        "X-Benchmark-Import-Request-ID": expect.any(String),
      },
    });
    const form = fetchMock().mock.calls[1][1]?.body as FormData;
    expect(form.get("file")).toBe(dataset);
    await waitFor(() => expect(fetchMock()).toHaveBeenNthCalledWith(
      3,
      "http://localhost:8000/api/jobs",
      { credentials: "include" },
    ));
  });

  it("releases dataset import leases after a deterministic rejection", async () => {
    const benchmarkJobId = "6".repeat(32);
    const pristineImport = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "unrelated-benchmark-hand.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: true,
      parser_result: null,
    };
    const overview = benchmarkOverviewForJob(
      benchmarkJobId,
      pristineImport.original_filename,
    );
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse(pristineImport))
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({
        detail: "Dataset ZIP exceeds maximum size",
      }, 413))
      .mockResolvedValueOnce(processingQueueResponse(
        [],
        "rejected-dataset-import-snapshot",
      ));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const reviewDialog = await screen.findByRole("dialog", {
      name: "Parser benchmark",
    });
    await user.click(within(reviewDialog).getByRole("button", {
      name: "Toggle unrelated-benchmark-hand.png benchmark details",
    }));
    await user.click(within(reviewDialog).getByRole("button", {
      name: "Review hand",
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Parser benchmark",
    })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Parser benchmark",
    });
    await waitFor(() => expect(
      within(dialog).getByRole("button", { name: "Import dataset" }),
    ).toBeEnabled());
    await user.upload(
      within(dialog).getByLabelText("Parser dataset ZIP"),
      new File(["oversized-dataset"], "oversized.zip", {
        type: "application/zip",
      }),
    );

    expect(await screen.findByText(
      "Dataset ZIP exceeds maximum size",
    )).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull());
    expect(window.sessionStorage.getItem(
      "poker-training-history-mutation-v1",
    )).toBeNull();
    expect(within(dialog).getByRole("button", {
      name: "Import dataset",
    })).toBeEnabled();
    expect(screen.getByRole("button", {
      name: "Open screenshot 1: unrelated-benchmark-hand.png",
    })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(5));
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      `http://localhost:8000/api/jobs/${benchmarkJobId}`,
      "http://localhost:8000/api/benchmarks",
      "http://localhost:8000/api/benchmarks/import",
      "http://localhost:8000/api/jobs",
    ]);
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

  it("preserves unsaved corrections when importing the active dataset case", async () => {
    const benchmarkJobId = "4".repeat(32);
    const processingImport = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "dirty-reused-import.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: false,
      parser_result: null,
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([processingImport]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
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

    const heroCards = await screen.findByLabelText(/Hero cards/);
    await user.clear(heroCards);
    await user.type(heroCards, "7d Ah");
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
    expect(within(dialog).getByRole("switch", {
      name: /Use current hand as ground truth/,
    })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(JSON.parse(String(
      window.localStorage.getItem("poker-training-processing-v1"),
    ))).toEqual([]));
    expect(screen.getByRole("button", {
      name: "Open screenshot 1: dirty-reused-import.png",
    })).toHaveClass("active");
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(heroCards).toHaveValue("7d Ah");
    expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBeNull();

    pendingQueue.resolve(processingQueueResponse(
      [],
      "dirty-reused-import-snapshot",
    ));

    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-synced",
    )).toBe("true"));
    expect(screen.getByRole("button", {
      name: "Open screenshot 1: dirty-reused-import.png",
    })).toHaveClass("active");
    expect(heroCards).toHaveValue("7d Ah");
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
      .mockResolvedValueOnce(jsonResponse({
        request_id: "reused-import-recovery",
        archive_sha256: "a".repeat(64),
        status: "completed",
        result: {
          imported_cases: 0,
          reused_cases: 1,
          included_cases: 1,
          job_ids: [benchmarkJobId],
        },
        error: null,
        error_status: null,
      }))
      .mockResolvedValueOnce(processingQueueResponse(
        [],
        "lost-dataset-import-snapshot",
      ))
      .mockResolvedValueOnce(jsonResponse({
        total: 0,
        jobs: [],
        snapshot_version: "lost-dataset-history-snapshot",
      }));
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

    expect(await screen.findByText("Dataset recovered: 1 hand")).toBeInTheDocument();
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
      expect.stringMatching(
        /^http:\/\/localhost:8000\/api\/benchmarks\/imports\/.+/,
      ),
      "http://localhost:8000/api/history",
      "http://localhost:8000/api/jobs",
    ]);
  });

  it("recovers a new dataset-only case by request identity after reload", async () => {
    const importedJobId = "7".repeat(32);
    let recoveryAttempts = 0;
    fetchMock().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "http://localhost:8000/api/benchmarks") {
        return Promise.resolve(jsonResponse({
          included_cases: 0,
          latest_report: null,
          recent_reports: [],
        }));
      }
      if (
        url === "http://localhost:8000/api/benchmarks/import"
        && init?.method === "POST"
      ) {
        return Promise.reject(new TypeError("Connection lost after dataset import"));
      }
      if (url.startsWith("http://localhost:8000/api/benchmarks/imports/")) {
        recoveryAttempts += 1;
        const requestId = decodeURIComponent(url.split("/").pop() ?? "");
        return recoveryAttempts === 1
          ? Promise.resolve(jsonResponse({
              request_id: requestId,
              archive_sha256: "b".repeat(64),
              status: "pending",
              result: null,
              error: null,
              error_status: null,
            }))
          : Promise.resolve(jsonResponse({
              request_id: requestId,
              archive_sha256: "b".repeat(64),
              status: "completed",
              result: {
                imported_cases: 1,
                reused_cases: 0,
                included_cases: 1,
                job_ids: [importedJobId],
              },
              error: null,
              error_status: null,
            }));
      }
      if (url === "http://localhost:8000/api/jobs") {
        return Promise.resolve(processingQueueResponse(
          [],
          "new-dataset-import-processing-snapshot",
        ));
      }
      if (url === "http://localhost:8000/api/history") {
        return Promise.resolve(jsonResponse({
          total: 0,
          jobs: [],
          snapshot_version: "new-dataset-import-history-snapshot",
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
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

    await waitFor(() => expect(recoveryAttempts).toBe(1));
    const importRequest = fetchMock().mock.calls.find(
      ([url]) => String(url) === "http://localhost:8000/api/benchmarks/import",
    );
    const importRequestId = (
      importRequest?.[1]?.headers as Record<string, string>
    )["X-Benchmark-Import-Request-ID"];
    expect(importRequestId).toEqual(expect.any(String));
    expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/benchmarks/imports/${importRequestId}`,
      { credentials: "include" },
    );
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toContain(importRequestId);
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toContain("\"benchmarkImportReceiptObserved\":true");
    expect(window.sessionStorage.getItem(
      "poker-training-history-mutation-v1",
    )).toContain(importRequestId);

    firstRender.unmount();
    for (const leaseKey of [
      "poker-training-processing-mutation-v1",
      "poker-training-history-mutation-v1",
    ]) {
      const lease = JSON.parse(String(window.sessionStorage.getItem(leaseKey)));
      window.sessionStorage.setItem(
        leaseKey,
        JSON.stringify({ ...lease, expiresAt: Date.now() - 1 }),
      );
    }
    render(<App />);

    expect(await screen.findByText("Dataset recovered: 1 hand")).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull());
    expect(window.sessionStorage.getItem(
      "poker-training-history-mutation-v1",
    )).toBeNull();
    expect(recoveryAttempts).toBe(2);
  });

  it("blocks benchmark runs while a recovered dataset import is pending", async () => {
    const importRequestId = "pending-import-before-benchmark";
    const pendingImportLease = {
      kind: "projection",
      ownerId: "previous-page",
      baselineJobIds: [],
      expectedRemovalJobIds: [],
      benchmarkImportRequestId: importRequestId,
      benchmarkImportReceiptObserved: true,
      expectedUploads: [],
      expiresAt: Date.now() + 30_000,
    };
    window.sessionStorage.setItem(
      "poker-training-processing-mutation-v1",
      JSON.stringify(pendingImportLease),
    );
    window.sessionStorage.setItem(
      "poker-training-history-mutation-v1",
      JSON.stringify(pendingImportLease),
    );
    const pendingReceipt = deferredResponse();
    fetchMock().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url
        === `http://localhost:8000/api/benchmarks/imports/${importRequestId}`
      ) {
        return pendingReceipt.promise;
      }
      if (url === "http://localhost:8000/api/benchmarks") {
        return Promise.resolve(jsonResponse({
          included_cases: 1,
          latest_report: null,
          recent_reports: [],
        }));
      }
      if (url === "http://localhost:8000/api/jobs") {
        return Promise.resolve(processingQueueResponse(
          [],
          "completed-import-processing-snapshot",
        ));
      }
      if (url === "http://localhost:8000/api/history") {
        return Promise.resolve(jsonResponse({
          total: 0,
          jobs: [],
          snapshot_version: "completed-import-history-snapshot",
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    const runButton = within(dialog).getByRole("button", {
      name: "Run benchmark",
    });
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(
      `http://localhost:8000/api/benchmarks/imports/${importRequestId}`,
      { credentials: "include" },
    ));
    expect(runButton).toBeDisabled();
    await user.click(runButton);
    expect(fetchMock().mock.calls.some(
      ([url]) => String(url) === "http://localhost:8000/api/benchmarks/run",
    )).toBe(false);

    pendingReceipt.resolve(jsonResponse({
      request_id: importRequestId,
      archive_sha256: "c".repeat(64),
      status: "completed",
      result: {
        imported_cases: 1,
        reused_cases: 0,
        included_cases: 1,
        job_ids: [],
      },
      error: null,
      error_status: null,
    }));

    await waitFor(() => expect(runButton).toBeEnabled());
    expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull();
    expect(window.sessionStorage.getItem(
      "poker-training-history-mutation-v1",
    )).toBeNull();
  });

  it("honors Retry-After while recovering a benchmark import", async () => {
    vi.useFakeTimers();
    const importRequestId = "rate-limited-import-recovery";
    const pendingImportLease = {
      kind: "projection",
      ownerId: "previous-page",
      baselineJobIds: [],
      expectedRemovalJobIds: [],
      benchmarkImportRequestId: importRequestId,
      benchmarkImportReceiptObserved: true,
      expectedUploads: [],
      expiresAt: Date.now() + 120_000,
    };
    window.sessionStorage.setItem(
      "poker-training-processing-mutation-v1",
      JSON.stringify(pendingImportLease),
    );
    window.sessionStorage.setItem(
      "poker-training-history-mutation-v1",
      JSON.stringify(pendingImportLease),
    );
    let recoveryAttempts = 0;
    fetchMock().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url
        === `http://localhost:8000/api/benchmarks/imports/${importRequestId}`
      ) {
        recoveryAttempts += 1;
        return Promise.resolve(new Response(
          JSON.stringify({ detail: "Rate limit exceeded for data transfers" }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "60",
            },
          },
        ));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const view = render(<App />);

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(recoveryAttempts).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_999);
      });
      expect(recoveryAttempts).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2);
      });
      expect(recoveryAttempts).toBe(2);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("expires unobserved dataset import leases after recovery request failures", async () => {
    const importRequestId = "expired-unobserved-import";
    const expiredLease = {
      kind: "projection",
      ownerId: "previous-page",
      baselineJobIds: [],
      expectedRemovalJobIds: [],
      benchmarkImportRequestId: importRequestId,
      benchmarkImportReceiptObserved: false,
      expectedUploads: [],
      expiresAt: Date.now() - 1,
    };
    window.localStorage.setItem("poker-training-processing-v1", "[]");
    window.localStorage.setItem("poker-training-processing-total-v1", "0");
    window.localStorage.setItem("poker-training-history-v1", "[]");
    window.localStorage.setItem("poker-training-history-total-v1", "0");
    window.sessionStorage.setItem(
      "poker-training-processing-mutation-v1",
      JSON.stringify(expiredLease),
    );
    window.sessionStorage.setItem(
      "poker-training-history-mutation-v1",
      JSON.stringify(expiredLease),
    );
    let receiptAttempts = 0;
    fetchMock().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://localhost:8000/api/benchmarks/imports/")) {
        receiptAttempts += 1;
        return Promise.reject(new TypeError("Receipt endpoint unavailable"));
      }
      if (url === "http://localhost:8000/api/jobs") {
        return Promise.resolve(processingQueueResponse(
          [],
          "expired-import-processing-snapshot",
        ));
      }
      if (url === "http://localhost:8000/api/history") {
        return Promise.resolve(jsonResponse({
          total: 0,
          jobs: [],
          snapshot_version: "expired-import-history-snapshot",
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);

    await waitFor(() => expect(receiptAttempts).toBeGreaterThan(0));
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull());
    expect(window.sessionStorage.getItem(
      "poker-training-history-mutation-v1",
    )).toBeNull();
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
      field_metrics: [
        { field: "pot_size", correct: 0, total: 1, accuracy: 0 },
        { field: "postflop_action_history", correct: 0, total: 1, accuracy: 0 },
      ],
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
            {
              field: "postflop_action_history",
              expected: [
                { actor: "oop", action: "bet", amount: 2 },
                { actor: "ip", action: "raise", amount: 7 },
              ],
              detected: [
                { actor: "oop", action: "bet", amount: 2 },
                { actor: "ip", action: "raise", amount: 6 },
              ],
              matched: false,
              confidence: null,
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

    const details = within(dialog).getAllByText("Expected")[0].closest(
      ".benchmark-case-details",
    );
    expect(details).not.toBeNull();
    expect(within(details as HTMLElement).getByText("12.5")).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText("10")).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText(
      "OOP bet 2 BB; IP raise to 7 BB",
    )).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText(
      "OOP bet 2 BB; IP raise to 6 BB",
    )).toBeInTheDocument();

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
    const recommendationRequestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      recommendationRequestId,
    );
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
      recommendation_request_id: recommendationRequestId,
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

  it("keeps a correctable benchmark recommendation in processing across reloads", async () => {
    const benchmarkJobId = "e".repeat(32);
    const recommendationRequestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      recommendationRequestId,
    );
    const pristineImport = {
      ...approvedJob(),
      id: benchmarkJobId,
      original_filename: "correctable-recommendation.png",
      image_filename: `${benchmarkJobId}.png`,
      benchmark_included: true,
      parser_result: null,
    };
    const revalidatedImport = {
      ...pristineImport,
      recommendation_request_id: recommendationRequestId,
      updated_at: "2026-07-10T00:01:00Z",
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(benchmarkOverviewForJob(
        benchmarkJobId,
        "correctable-recommendation.png",
      )))
      .mockResolvedValueOnce(jsonResponse(pristineImport))
      .mockResolvedValueOnce(jsonResponse({
        detail: { missing_fields: ["effective_stack"] },
      }, 422))
      .mockResolvedValueOnce(processingQueueResponse(
        [revalidatedImport],
        "correctable-import-snapshot",
      ));
    const firstRender = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    await user.click(within(dialog).getByRole("button", {
      name: "Toggle correctable-recommendation.png benchmark details",
    }));
    await user.click(within(dialog).getByRole("button", { name: "Review hand" }));
    await waitFor(() => expect(
      screen.queryByRole("dialog", { name: "Parser benchmark" }),
    ).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Request recommendation" }));

    expect(await screen.findAllByText(/effective_stack/)).not.toHaveLength(0);
    expect(await screen.findByRole("button", {
      name: "Open screenshot 1: correctable-recommendation.png",
    })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Request recommendation",
    })).toBeEnabled();
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull());

    firstRender.unmount();
    render(<App />);

    expect(await screen.findByRole("button", {
      name: "Open screenshot 1: correctable-recommendation.png",
    })).toBeInTheDocument();
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

  it("releases a benchmark lease after deterministic inclusion rejection", async () => {
    const parsedJob = {
      ...approvedJob(),
      id: "5".repeat(32),
      original_filename: "benchmark-conflict.png",
    };
    window.localStorage.setItem(
      "poker-training-processing-v1",
      JSON.stringify([parsedJob]),
    );
    window.localStorage.setItem("poker-training-processing-total-v1", "1");
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({
        included_cases: 250,
        latest_report: null,
        recent_reports: [],
      }))
      .mockResolvedValueOnce(jsonResponse({
        detail: "Parser datasets support at most 250 cases",
      }, 409))
      .mockResolvedValueOnce(processingQueueResponse(
        [parsedJob],
        "benchmark-inclusion-conflict-snapshot",
      ));
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Parser benchmark" }));
    const dialog = await screen.findByRole("dialog", { name: "Parser benchmark" });
    const groundTruthSwitch = within(dialog).getByRole("switch", {
      name: /Use current hand as ground truth/,
    });
    await waitFor(() => expect(groundTruthSwitch).toBeEnabled());
    await user.click(groundTruthSwitch);

    expect(await screen.findByText(
      "Parser datasets support at most 250 cases",
    )).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem(
      "poker-training-processing-mutation-v1",
    )).toBeNull());
    expect(groundTruthSwitch).toHaveAttribute("aria-checked", "false");
    expect(groundTruthSwitch).toBeEnabled();
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      `http://localhost:8000/api/jobs/${parsedJob.id}/benchmark`,
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
    const persistedInclusion: JobRecord = {
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
      .mockRejectedValueOnce(new TypeError("Connection lost after including hand"))
      .mockResolvedValueOnce(processingQueueResponse(
        [],
        "included-import-snapshot",
      ))
      .mockResolvedValueOnce(jsonResponse(persistedInclusion));
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
      `http://localhost:8000/api/jobs/${benchmarkJobId}`,
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
    const persistedApproval: JobRecord = {
      ...mutatedImport,
      approved_state: canonicalState({ pot_size: 20 }),
      training_decision: null,
      updated_at: "2026-07-20T12:10:00Z",
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
      ))
      .mockResolvedValueOnce(jsonResponse(persistedApproval));
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
      `http://localhost:8000/api/jobs/${benchmarkJobId}`,
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
