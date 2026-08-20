import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, resetApiMocks } from "../../test/api";
import { requestJson } from "./transport";

afterEach(resetApiMocks);

describe("requestJson", () => {
  it("keeps credential and abort behavior for domain adapters", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestJson<{ status: string }>("/api/health", {
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: "ok" });

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:8000/api/health", {
      credentials: "include",
      signal: controller.signal,
    });
  });

  it("preserves the shared human-readable API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ missing_fields: ["opponent_wager"] }), {
          headers: { "Content-Type": "application/json" },
          status: 422,
        }),
      ),
    );

    await expect(requestJson("/api/health")).rejects.toEqual(
      expect.objectContaining({
        message:
          "Complete the required table details before requesting a recommendation: Opponent wager total. Edit the listed fields, then approve the state again.",
        status: 422,
      }),
    );
  });
});
