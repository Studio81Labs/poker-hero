import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
    training_reviewed_at: null,
    training_review_note: null,
    benchmark_included: false,
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

  it("uploads a screenshot, populates parser state, and enables approval", async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse(jobRecord(), 201));
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

    expect(fetchMock().mock.calls[1][0]).toBe("http://localhost:8000/api/jobs/imported-job/approve");
    const payload = JSON.parse(String(fetchMock().mock.calls[1][1]?.body));
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
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord({ id: "job-1", original_filename: "first.png" }), 201))
      .mockResolvedValueOnce(
        jsonResponse(
          jobRecord({
            id: "job-2",
            original_filename: "second.png",
            parser_result: {
              state: secondState,
              confidences: { hero_cards: 0.91, street: 0.9 },
              warnings: [],
              raw: {},
            },
          }),
          201,
        ),
    );
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
    expect(fetchMock()).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "Open screenshot 2: second.png" }));

    expect(screen.getByDisplayValue("7d Ah")).toBeInTheDocument();
    expect(screen.getByDisplayValue("3.5")).toBeInTheDocument();
    expect(screen.getByLabelText(/Street/)).toHaveValue("preflop");
  });

  it("continues a batch upload when one screenshot fails", async () => {
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord({ id: "job-1", original_filename: "first.png" }), 201))
      .mockResolvedValueOnce(jsonResponse({ detail: "Second image is unreadable" }, 400))
      .mockResolvedValueOnce(jsonResponse(jobRecord({ id: "job-3", original_filename: "third.png" }), 201));
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

    expect(await screen.findByRole("button", { name: "Open screenshot 3: third.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open screenshot 1: first.png" })).toBeInTheDocument();
    const failedItem = screen.getByRole("button", { name: "Open screenshot 2: second.png" });
    expect(within(failedItem).getByText("error")).toBeInTheDocument();
    expect(within(failedItem).getByText("Second image is unreadable")).toBeInTheDocument();
    expect(await screen.findByText("1 screenshot need attention. Check the highlighted queue items.")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(3);
  });

  it("shows processing progress and aborts unprocessed screenshots", async () => {
    fetchMock().mockImplementation((_url, options) => {
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
    expect(fetchMock()).toHaveBeenCalledTimes(1);
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
    fetchMock().mockResolvedValueOnce(jsonResponse(jobRecord({ original_filename: "screen-capture.png" }), 201));
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
    expect(fetchMock()).toHaveBeenCalledTimes(1);
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
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord({ original_filename: "screen-capture.png" }), 201))
      .mockResolvedValueOnce(jsonResponse({ ...approvedJob(), original_filename: "screen-capture.png" }))
      .mockResolvedValueOnce(jsonResponse({ ...recommendedJob(), original_filename: "screen-capture.png" }));
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
    expect(fetchMock()).toHaveBeenCalledTimes(3);
    expect(fetchMock().mock.calls[0][0]).toBe("http://localhost:8000/api/jobs");
    expect(fetchMock().mock.calls[1][0]).toBe("http://localhost:8000/api/jobs/job-123/approve");
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/jobs/job-123/recommend");
    expect(JSON.parse(String(fetchMock().mock.calls[1][1]?.body)).user_approved).toBe(true);
  });

  it("runs upload, approval, and recommendation through automation", async () => {
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord({ original_filename: "uploaded.png" }), 201))
      .mockResolvedValueOnce(jsonResponse({ ...approvedJob(), original_filename: "uploaded.png" }))
      .mockResolvedValueOnce(jsonResponse({ ...recommendedJob(), original_filename: "uploaded.png" }));
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
    expect(fetchMock()).toHaveBeenCalledTimes(3);
    expect(fetchMock().mock.calls[0][0]).toBe("http://localhost:8000/api/jobs");
    expect(fetchMock().mock.calls[1][0]).toBe("http://localhost:8000/api/jobs/job-123/approve");
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/jobs/job-123/recommend");
  });

  it("stops automation before approval when parser warnings are not allowed", async () => {
    stubDisplayMedia("window");
    stubCanvasCapture();
    fetchMock().mockResolvedValueOnce(
      jsonResponse(
        jobRecord({
          parser_result: {
            state: detectedState,
            confidences: { hero_cards: 0.71, street: 0.9 },
            warnings: ["Hero cards need manual review"],
            raw: {},
          },
        }),
        201,
      ),
    );
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Share window" }));
    expect(await screen.findByText("Window sharing active")).toBeInTheDocument();
    setSharedPreviewSize();

    await user.click(screen.getByRole("button", { name: "Capture and parse" }));

    expect(await screen.findByText("Automation stopped: parser warnings need manual review")).toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(1);
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
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord(), 201))
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
    expect(fetchMock()).toHaveBeenCalledTimes(3);

    await user.click(screen.getByRole("button", { name: "Approve state" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Request recommendation" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Request recommendation" }));
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(5));

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
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord(), 201))
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
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/jobs/job-123/decision");
    expect(fetchMock().mock.calls[2][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ action: "raise", sizing: 7.5, certainty: "high" }),
    });

    await user.click(screen.getByRole("button", { name: "Request recommendation" }));

    const comparison = await screen.findByLabelText("Training decision comparison");
    expect(within(comparison).getByText("Raise 7.5 BB")).toBeInTheDocument();
    expect(within(comparison).getByText("High certainty")).toBeInTheDocument();
    expect(within(comparison).getByText("Matched solver")).toBeInTheDocument();
    expect(within(comparison).queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument();
    expect(fetchMock()).toHaveBeenCalledTimes(4);
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
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord(), 201))
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
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord(), 201))
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
    expect(fetchMock().mock.calls[4][0]).toBe("http://localhost:8000/api/jobs/job-123/training-review");
    expect(fetchMock().mock.calls[4][1]).toMatchObject({
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
    expect(fetchMock().mock.calls[5][0]).toBe("http://localhost:8000/api/jobs/job-123/training-review");
    expect(fetchMock().mock.calls[5][1]).toMatchObject({
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
    expect(fetchMock().mock.calls[6][0]).toBe("http://localhost:8000/api/jobs/job-123/training-review");
    expect(fetchMock().mock.calls[6][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ note: null }),
    });

    await user.click(within(comparison).getByRole("button", { name: "Reopen review" }));

    expect(await within(comparison).findByRole("button", { name: "Mark reviewed" })).toBeInTheDocument();
    expect(within(comparison).queryByText("Reviewed")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Training review note")).toHaveValue("");
    expect(await screen.findByText("Training review reopened")).toBeInTheDocument();
    expect(fetchMock().mock.calls[7][0]).toBe("http://localhost:8000/api/jobs/job-123/training-review");
    expect(fetchMock().mock.calls[7][1]).toMatchObject({ method: "DELETE" });
  });

  it("records a selected answer automatically when recommendation is requested", async () => {
    const trainingDecision = {
      action: "call" as const,
      sizing: null,
      certainty: "medium" as const,
      recorded_at: "2026-07-20T12:00:00Z",
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord(), 201))
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
    expect(fetchMock().mock.calls[2][0]).toBe("http://localhost:8000/api/jobs/job-123/decision");
    expect(fetchMock().mock.calls[2][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ action: "call", sizing: null, certainty: "medium" }),
    });
    expect(fetchMock().mock.calls[3][0]).toBe("http://localhost:8000/api/jobs/job-123/recommend");
  });

  it("clears an unlocked training answer when the approved state is edited", async () => {
    const editedState = canonicalState({ pot_size: 18 });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord(), 201))
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
    expect(fetchMock()).toHaveBeenCalledTimes(4);
    expect(fetchMock().mock.calls[3][0]).toBe("http://localhost:8000/api/jobs/job-123/recommend");
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

    await user.click(within(dialog).getByRole("button", {
      name: "Review Fold to Call differences",
    }));

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
    await user.click(within(differences).getByRole("button", {
      name: "Review Fold to Call differences",
    }));
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
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord({ original_filename: "valid.png" }), 201))
      .mockResolvedValueOnce(jsonResponse({ detail: "Upload must contain supported image data" }, 400));
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
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord(), 201))
      .mockResolvedValueOnce(jsonResponse(approvedJob(correctedState)));
    render(<App />);

    const user = await uploadScreenshot();
    const currentBetInput = await screen.findByLabelText(/Current bet/);
    await user.clear(currentBetInput);
    await user.type(currentBetInput, "3.5");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(2));
    const approveOptions = fetchMock().mock.calls[1][1];
    const payload = JSON.parse(String(approveOptions?.body));

    expect(fetchMock().mock.calls[1][0]).toBe("http://localhost:8000/api/jobs/job-123/approve");
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
      .mockResolvedValueOnce(jsonResponse(approvedJob(approvedState)));
    render(<App />);

    const user = await uploadScreenshot();
    await user.selectOptions(await screen.findByLabelText(/Opener position/), "button");
    await user.type(screen.getByLabelText(/Opening size/), "2.5");
    await user.click(screen.getByRole("button", { name: "Approve state" }));

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(2));
    const payload = JSON.parse(String(fetchMock().mock.calls[1][1]?.body));
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
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord(), 201))
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
      name: /Use current hand as ground truth.*Previous approved state remains included/,
    });
    expect(retainedGroundTruth).toBeEnabled();
    await user.click(retainedGroundTruth);
    await waitFor(() => expect(retainedGroundTruth).toHaveAttribute("aria-checked", "false"));

    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
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
      .mockReturnValueOnce(pendingImport.promise);
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
  });

  it("shows benchmark mismatches and opens the stored hand for correction", async () => {
    const pendingReviewJob = deferredResponse();
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
      id: "benchmark-job",
      original_filename: "mismatch.png",
      image_filename: "benchmark-job.png",
      benchmark_included: true,
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
          job_id: "benchmark-job",
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
      "http://localhost:8000/api/jobs/benchmark-job/image",
    );
    expect(screen.getByLabelText(/Pot/)).toHaveValue("12.5");
    expect(fetchMock().mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8000/api/benchmarks",
      "http://localhost:8000/api/jobs/benchmark-job",
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
    fetchMock().mockResolvedValueOnce(jsonResponse(jobRecord(), 201)).mockReturnValueOnce(pendingApproval.promise);
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
