import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiResponseError,
  applicationBackupUrl,
  archiveJobs,
  deleteJob,
  getBenchmarkDatasetImport,
  getHistory,
  getPipelineCapabilities,
  humanReadableMessage,
  listMcpPrincipals,
  getProcessingJobs,
  requestRecommendation,
  restoreApplicationBackup,
  updateJobMetadata,
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

describe("humanReadableMessage", () => {
  it("turns missing recommendation fields into table language", () => {
    expect(humanReadableMessage({
      detail: {
        missing_fields: ["opponent_wager", "opponents_at_current_bet"],
      },
    }, "Recommendation failed")).toBe(
      "Complete the required table details before requesting a recommendation: Opponent wager total and opponents at the current wager. Edit the listed fields, then approve the state again.",
    );
  });

  it("turns FastAPI validation arrays into readable field messages", () => {
    expect(humanReadableMessage([{
      type: "missing",
      loc: ["body", "file"],
      msg: "Field required",
      input: null,
    }], "Upload failed")).toBe("File is required");
  });

  it("decodes structured JSON strings instead of displaying raw payloads", () => {
    expect(humanReadableMessage(
      '{"missing_fields":["effective_stack"]}',
      "Recommendation failed",
    )).toBe(
      "Complete the required table details before requesting a recommendation: Effective stack. Edit the listed fields, then approve the state again.",
    );
  });

  it.each([
    "[low light] board cards unclear",
    "{solver unavailable until ranges load",
  ])("preserves bracket-prefixed plain diagnostics: %s", (message) => {
    expect(humanReadableMessage(message, "Request failed")).toBe(message);
  });
});

describe("API error messages", () => {
  it("uses the human-readable message for structured recommendation errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(
      JSON.stringify({ detail: { missing_fields: ["opponent_wager"] } }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    )));

    await expect(requestRecommendation("job-1", "request-1")).rejects.toThrow(
      "Complete the required table details before requesting a recommendation: Opponent wager total. Edit the listed fields, then approve the state again.",
    );
  });

  it("uses the HTTP fallback instead of displaying an HTML error page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(
      "<!doctype html><html><body><h1>Bad gateway</h1></body></html>",
      {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    )));

    await expect(requestRecommendation("job-1", "request-1")).rejects.toThrow(
      "Bad Gateway",
    );
  });

  it("preserves concise plain-text API errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(
      "Solver is warming up",
      {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    )));

    await expect(requestRecommendation("job-1", "request-1")).rejects.toThrow(
      "Solver is warming up",
    );
  });

  it("uses the HTTP fallback for oversized plain-text errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(
      "x".repeat(513),
      {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    )));

    await expect(requestRecommendation("job-1", "request-1")).rejects.toThrow(
      "Service Unavailable",
    );
  });
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

describe("screenshot management", () => {
  it("updates title, notes and tags on a screenshot", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ id: "job/123" }));
    vi.stubGlobal("fetch", fetchMock);
    const metadata = {
      title: "Turn bluff",
      notes: "Review the sizing.",
      tags: ["turn", "bluff"],
    };

    await updateJobMetadata("job/123", metadata);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs/job%2F123/metadata",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
        credentials: "include",
      },
    );
  });

  it("permanently deletes a screenshot without reading a 204 body", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteJob("job/123")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/jobs/job%2F123",
      { method: "DELETE", credentials: "include" },
    );
  });
});

describe("application backups", () => {
  it("uses the same-origin API URL for backup downloads", () => {
    expect(applicationBackupUrl()).toBe(
      "http://localhost:8000/api/backups/export",
    );
  });

  it("uploads a selected ZIP to the restore endpoint", async () => {
    const result = {
      imported_jobs: 2,
      reused_jobs: 1,
      imported_benchmark_reports: 1,
      reused_benchmark_reports: 0,
      total_jobs: 3,
      total_benchmark_reports: 1,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["backup"], "poker-hero-backup.zip", {
      type: "application/zip",
    });

    await expect(restoreApplicationBackup(file)).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/backups/restore",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
    const request = fetchMock.mock.calls[0][1];
    expect(request.body).toBeInstanceOf(FormData);
    expect((request.body as FormData).get("file")).toBe(file);
  });
});

describe("MCP administration", () => {
  it("always sends the operator bearer to the same-origin Worker", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      principals: [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await listMcpPrincipals("admin-secret");

    expect(fetchMock).toHaveBeenCalledWith("/api/mcp/principals", {
      headers: { Authorization: "Bearer admin-secret" },
      credentials: "include",
    });
  });
});

describe("benchmark import recovery", () => {
  it("preserves Retry-After metadata from rate-limit responses", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(
      JSON.stringify({ detail: "Rate limit exceeded for data transfers" }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "7",
        },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const recovery = getBenchmarkDatasetImport("import-request-123");

    await expect(recovery).rejects.toEqual(expect.objectContaining({
      name: "ApiResponseError",
      status: 429,
      retryAfterSeconds: 7,
    } satisfies Partial<ApiResponseError>));
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

  it("sends a selected analysis pipeline with the screenshot", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      id: "job-123",
      status: "parsed",
      original_filename: "table.png",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["image"], "table.png", { type: "image/png" });

    await uploadScreenshot(file, "upload-request-123", undefined, {
      parser_provider: "ocr_cv",
      parser_layout_profile: "fortuna_nations",
      recommendation_provider: "local_solver",
      recommendation_engine: "postflop_solver",
    });

    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("parser_provider")).toBe("ocr_cv");
    expect(form.get("parser_layout_profile")).toBe("fortuna_nations");
    expect(form.get("recommendation_provider")).toBe("local_solver");
    expect(form.get("recommendation_engine")).toBe("postflop_solver");
  });
});

describe("getPipelineCapabilities", () => {
  it("reads the plugins advertised by the backend", async () => {
    const payload = {
      defaults: {
        parser_provider: "ocr_cv",
        parser_layout_profile: "fortuna_nations",
        recommendation_provider: "local_solver",
        recommendation_engine: "postflop_solver",
      },
      parser_providers: [],
      parser_layout_profiles: [],
      parser_layout_compatibility: {},
      recommendation_providers: [],
      recommendation_engines: [],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(payload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPipelineCapabilities()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/pipeline",
      { credentials: "include" },
    );
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
