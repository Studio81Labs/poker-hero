import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppRoutes } from "./routes";

vi.mock("../pages/analyzer/AnalyzerPage", () => ({
  default: () => <div>Analyzer workspace</div>,
}));

afterEach(cleanup);

describe("AppRoutes", () => {
  it("renders the analyzer at the root route", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(screen.getByText("Analyzer workspace")).toBeInTheDocument();
  });

  it("returns unknown paths to the analyzer", async () => {
    render(
      <MemoryRouter initialEntries={["/future-account-page"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Analyzer workspace")).toBeInTheDocument();
  });
});
