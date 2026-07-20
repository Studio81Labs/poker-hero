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
    recommendation: null,
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
    expect(screen.getByText(/postflop engine solves heads-up game trees/i)).toBeInTheDocument();
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
    expect(groundTruthSwitch).toHaveAttribute("aria-checked", "false");
    expect(groundTruthSwitch).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Run benchmark" })).toBeDisabled();

    pendingOverview.resolve(jsonResponse({ included_cases: 0, latest_report: null }));
    await waitFor(() => expect(groundTruthSwitch).toBeEnabled());
    await user.click(groundTruthSwitch);
    expect(within(dialog).getByRole("button", { name: "Run benchmark" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Close parser benchmark" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeDisabled();
    pendingInclusion.resolve(jsonResponse(benchmarkJob));
    await waitFor(() => expect(groundTruthSwitch).toHaveAttribute("aria-checked", "true"));
    expect(within(dialog).getByRole("button", { name: "Close parser benchmark" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
    const runBenchmark = within(dialog).getByRole("button", { name: "Run benchmark" });
    await waitFor(() => expect(runBenchmark).toBeEnabled());
    await user.click(runBenchmark);
    expect(groundTruthSwitch).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Close parser benchmark" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeDisabled();
    pendingBenchmark.resolve(jsonResponse(benchmarkReport));

    expect(await within(dialog).findByLabelText("Latest benchmark summary")).toHaveTextContent("90%");
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
