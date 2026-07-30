import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveJobs,
  getHistory,
  getProcessingJobs,
  requestRecommendation,
  uploadScreenshot,
} from "./api";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("archiveJobs", () => {
  it("archives queues larger than the backend request limit in bounded batches", async () => {
    const jobIds = Array.from({ length: 205 }, (_, index) => `job-${index}`);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ total: 100, jobs: [] }))
      .mockResolvedValueOnce(jsonResponse({ total: 200, jobs: [] }))
      .mockResolvedValueOnce(jsonResponse({ total: 205, jobs: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const history = await archiveJobs(jobIds);

    expect(history.total).toBe(205);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)).job_ids,
    )).toEqual([
      jobIds.slice(0, 100),
      jobIds.slice(100, 200),
      jobIds.slice(200),
    ]);
  });
});

describe("getHistory", () => {
  it("requests an older page from the current loaded offset", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      total: 31,
      jobs: [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getHistory(24);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/history?offset=24",
      { credentials: "include" },
    );
  });

  it("encodes history search terms alongside the page offset", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      total: 2,
      jobs: [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getHistory(24, "turn bluff");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/history?offset=24&query=turn+bluff",
      { credentials: "include" },
    );
  });
});

describe("getProcessingJobs", () => {
  it("requests the next processing page from the current loaded offset", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      total: 125,
      jobs: [],
      snapshot_version: "queue-snapshot",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getProcessingJobs(100);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs?offset=100",
      { credentials: "include" },
    );
  });
});

describe("uploadScreenshot", () => {
  it("sends and retains the client request identity", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      id: "job-123",
      status: "parsed",
      original_filename: "table.png",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["image"], "table.png", { type: "image/png" });

    const job = await uploadScreenshot(file, "upload-request-123");

    const request = fetchMock.mock.calls[0][1];
    expect(request.body).toBeInstanceOf(FormData);
    expect((request.body as FormData).get("file")).toBe(file);
    expect((request.body as FormData).get("upload_request_id")).toBe(
      "upload-request-123",
    );
    expect(job.upload_request_id).toBe("upload-request-123");
  });
});

describe("requestRecommendation", () => {
  it("sends the client recommendation identity", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      id: "job-123",
      status: "recommended",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await requestRecommendation("job-123", "recommendation-request-123");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs/job-123/recommend",
      {
        method: "POST",
        headers: {
          "X-Recommendation-Request-ID": "recommendation-request-123",
        },
        signal: undefined,
        credentials: "include",
      },
    );
  });
});
