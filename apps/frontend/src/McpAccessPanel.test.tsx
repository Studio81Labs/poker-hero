import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMcpPrincipal,
  getMcpAccessConfig,
  listMcpPrincipals,
  revokeMcpPrincipal,
  rotateMcpPrincipal,
} from "./api";
import { McpAccessPanel } from "./McpAccessPanel";
import type { McpPrincipal } from "./types";

vi.mock("./api", () => ({
  createMcpPrincipal: vi.fn(),
  getMcpAccessConfig: vi.fn(),
  listMcpPrincipals: vi.fn(),
  revokeMcpPrincipal: vi.fn(),
  rotateMcpPrincipal: vi.fn(),
}));

const principal: McpPrincipal = {
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
};

describe("McpAccessPanel", () => {
  beforeEach(() => {
    vi.mocked(getMcpAccessConfig).mockResolvedValue({
      enabled: true,
      environment: "staging",
      endpoint: "https://poker-staging.example/mcp",
      writes_enabled: true,
    });
    vi.mocked(listMcpPrincipals).mockResolvedValue([principal]);
    vi.mocked(createMcpPrincipal).mockResolvedValue({
      principal,
      token: "phmcp_first-token",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("blocks token-producing actions until the one-time token is dismissed", async () => {
    const user = userEvent.setup();
    render(<McpAccessPanel />);

    await user.type(
      await screen.findByLabelText("Credential name"),
      "Codex staging",
    );
    await user.click(screen.getByRole("button", { name: "Create credential" }));

    await waitFor(() =>
      expect(screen.getByText("phmcp_first-token")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Create credential" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rotate" })).toBeDisabled();
    expect(rotateMcpPrincipal).not.toHaveBeenCalled();
    expect(revokeMcpPrincipal).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "I stored it" }));

    expect(
      screen.getByRole("button", { name: "Create credential" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Rotate" })).toBeEnabled();
  });
});
