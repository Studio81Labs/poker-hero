import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "../../../app/providers/AppProviders";
import { jsonResponse, resetApiMocks } from "../../../test/api";
import { usePipelineSelection } from "./usePipelineSelection";

afterEach(resetApiMocks);

function wrapper({ children }: { children: ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}

const capabilities = {
  defaults: {
    parser_layout_profile: "fortuna_nations",
    parser_provider: "ocr_cv",
    recommendation_engine: "postflop_solver",
    recommendation_provider: "local_solver",
  },
  parser_layout_compatibility: { ocr_cv: ["fortuna_nations"] },
  parser_layout_profiles: [
    {
      available: true,
      id: "fortuna_nations",
      label: "Fortuna Nations",
      unavailable_reason: null,
    },
  ],
  parser_providers: [
    {
      available: true,
      id: "ocr_cv",
      label: "OCR CV",
      unavailable_reason: null,
    },
  ],
  recommendation_engines: [
    {
      available: true,
      id: "postflop_solver",
      label: "Postflop solver",
      unavailable_reason: null,
    },
  ],
  recommendation_providers: [
    {
      available: true,
      id: "local_solver",
      label: "Local solver",
      unavailable_reason: null,
    },
  ],
};

describe("usePipelineSelection", () => {
  it("loads capabilities through Query and keeps only the editable selection locally", async () => {
    const onError = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(capabilities));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => usePipelineSelection({ onError }), {
      wrapper,
    });

    act(() => result.current.openDialog());

    await waitFor(() =>
      expect(result.current.selection).toEqual(capabilities.defaults),
    );
    expect(result.current.capabilities).toEqual(capabilities);
    expect(onError).not.toHaveBeenCalled();

    act(() => result.current.updateSelection("recommendation_engine", null));
    expect(result.current.selection?.recommendation_engine).toBeNull();

    await result.current.loadCapabilities();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
