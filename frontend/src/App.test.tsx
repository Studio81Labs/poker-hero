import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  effective_stack: 96,
  players_in_hand: 3,
  hero_position: "button",
  street: "flop",
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
        effective_stack: 0.88,
        players_in_hand: 0.86,
        hero_position: 0.84,
        street: 1,
      },
      warnings: [],
      raw: { provider: "mock" },
    },
    approved_state: null,
    recommendation: null,
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

async function uploadScreenshot(name = "table.png") {
  const user = userEvent.setup();
  const input = screen.getByLabelText("Choose screenshot");
  const file = new File(["not-real-image-bytes"], name, { type: "image/png" });

  await user.upload(input, file);
  await user.click(screen.getByRole("button", { name: "Upload and parse" }));

  return user;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("renders the upload control panel", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Poker Training Analyzer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload and parse" })).toBeDisabled();
  });

  it("uploads a screenshot, populates parser state, and enables approval", async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse(jobRecord(), 201));
    render(<App />);

    await uploadScreenshot();

    expect(await screen.findByDisplayValue("Ah Kd")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Qs Jc 2h")).toBeInTheDocument();
    expect(screen.getByDisplayValue("12.5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve state" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Request recommendation" })).toBeDisabled();
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
    expect(screen.getByRole("button", { name: "Request recommendation" })).toBeDisabled();
  });

  it("displays backend upload errors and clears the prior job", async () => {
    fetchMock()
      .mockResolvedValueOnce(jsonResponse(jobRecord(), 201))
      .mockResolvedValueOnce(jsonResponse({ detail: "Upload must contain supported image data" }, 400));
    render(<App />);

    await uploadScreenshot("valid.png");
    expect(await screen.findByDisplayValue("Ah Kd")).toBeInTheDocument();
    expect(screen.getByAltText("Uploaded poker table screenshot")).toBeInTheDocument();

    await uploadScreenshot("broken.png");

    expect(await screen.findByRole("alert")).toHaveTextContent("Upload must contain supported image data");
    expect(screen.getByText("No screenshot uploaded")).toBeInTheDocument();
    expect(screen.getByText("Waiting for upload")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Ah Kd")).not.toBeInTheDocument();
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
    expect(payload.user_approved).toBe(true);
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

    await user.type(potInput, "18");
    expect(potInput).toHaveValue("12.5");

    pendingApproval.resolve(jsonResponse(approvedJob()));

    await waitFor(() => expect(potInput).toBeEnabled());
    expect(potInput).toHaveValue("12.5");
    expect(screen.getByRole("button", { name: "Request recommendation" })).toBeEnabled();
  });
});
