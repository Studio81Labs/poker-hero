import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "../../../app/providers/AppProviders";
import { jsonResponse, resetApiMocks } from "../../../test/api";
import { useSystemInfoDialog } from "./useSystemInfoDialog";

afterEach(resetApiMocks);

function wrapper({ children }: { children: ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}

describe("useSystemInfoDialog", () => {
  it("loads system information through the Query cache when the dialog opens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        environment: "local",
        parser_provider: "ocr_cv",
        recommendation_engine: "postflop_solver",
        recommendation_provider: "local_solver",
        status: "ok",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSystemInfoDialog(), { wrapper });

    act(() => result.current.openDialog());

    await waitFor(() =>
      expect(result.current.systemInfo?.parser_provider).toBe("ocr_cv"),
    );
    expect(result.current.loading).toBe(false);

    act(() => result.current.closeDialog());
    act(() => result.current.openDialog());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
