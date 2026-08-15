import { describe, expect, it } from "vitest";

import type { RecommendationEvidenceDetail } from "./recommendationEvidenceTypes";
import { appendPreflopEvidence } from "./preflopEvidencePresentation";

describe("preflop evidence compatibility barrel", () => {
  it("composes focused evidence in the established presentation order", () => {
    const details: RecommendationEvidenceDetail[] = [];

    appendPreflopEvidence(
      {
        stack_depth_policy: "standard",
        effective_stack: 100,
        limper_position: "button",
        opener_position: "utg",
        continue_fraction: 0.3,
      },
      details,
    );

    expect(details.map(({ label }) => label)).toEqual([
      "Stack depth",
      "Limper",
      "Opener",
      "Response range",
    ]);
  });
});
