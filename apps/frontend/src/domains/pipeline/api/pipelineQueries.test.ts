import { describe, expect, it } from "vitest";

import {
  pipelineCapabilitiesQueryOptions,
  pipelineQueryKeys,
} from "./pipelineQueries";

describe("pipeline query definitions", () => {
  it("uses a stable, domain-owned key", () => {
    expect(pipelineQueryKeys.capabilities()).toEqual([
      "pipeline",
      "capabilities",
    ]);
    expect(pipelineCapabilitiesQueryOptions().queryKey).toEqual(
      pipelineQueryKeys.capabilities(),
    );
  });
});
