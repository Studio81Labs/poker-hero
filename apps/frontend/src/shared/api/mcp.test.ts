import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, resetApiMocks } from "../../test/api";
import { listMcpPrincipals } from "./mcp";

afterEach(resetApiMocks);

describe("MCP administration", () => {
  it("always sends the operator bearer to the same-origin Worker", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ principals: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listMcpPrincipals("admin-secret");

    expect(fetchMock).toHaveBeenCalledWith("/api/mcp/principals", {
      headers: { Authorization: "Bearer admin-secret" },
      credentials: "include",
    });
  });
});
