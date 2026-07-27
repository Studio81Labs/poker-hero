import { afterEach, describe, expect, it, vi } from "vitest";

import { archiveJobs } from "./api";

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
