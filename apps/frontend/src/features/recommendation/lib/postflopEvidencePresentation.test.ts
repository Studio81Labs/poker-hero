import { describe, expect, it } from "vitest";

import type { RecommendationEvidenceDetail } from "./recommendationEvidenceTypes";
import {
  appendPostflopEvidence,
  POSTFLOP_RANGE_SOURCE_LABELS,
} from "./postflopEvidencePresentation";

describe("postflop evidence compatibility barrel", () => {
  it("keeps the established exports and composed evidence behavior", () => {
    const details: RecommendationEvidenceDetail[] = [];
    const ranges: RecommendationEvidenceDetail[] = [];

    appendPostflopEvidence(
      {
        hero_position: "oop",
        range_source: "preflop_chart_three_bet_pot",
        ranges: { oop: "AA" },
      },
      "postflop_solver",
      details,
      ranges,
    );

    expect(POSTFLOP_RANGE_SOURCE_LABELS).toHaveProperty(
      "preflop_chart_three_bet_pot",
    );
    expect(details).toEqual([
      { label: "Position", value: "OOP" },
      { label: "Range source", value: "Preflop chart · 3-bet pot" },
    ]);
    expect(ranges).toEqual([{ label: "OOP", value: "AA" }]);
  });

  it("ignores evidence from other engines", () => {
    const details: RecommendationEvidenceDetail[] = [];
    appendPostflopEvidence({ hero_position: "ip" }, "local_ev", details, []);
    expect(details).toEqual([]);
  });
});
