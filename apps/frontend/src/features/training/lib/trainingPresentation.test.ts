import { describe, expect, it } from "vitest";

import * as presentation from "./trainingPresentation";

describe("training presentation compatibility barrel", () => {
  it("keeps the established runtime export surface", () => {
    expect(Object.keys(presentation).sort()).toEqual(
      [
        "MAX_TRAINING_REVIEW_NOTE_LENGTH",
        "MIN_SUPPORTED_FREQUENCY",
        "SIZING_MATCH_TOLERANCE",
        "TRAINING_ACTION_OPTIONS",
        "TRAINING_ACTIONS",
        "TRAINING_CERTAINTIES",
        "TRAINING_CERTAINTY_FOCUS_ORDER",
        "TRAINING_CERTAINTY_OPTIONS",
        "TRAINING_POSITION_FOCUS_ORDER",
        "TRAINING_STREET_ORDER",
        "benchmarkFieldLabel",
        "decimalCoefficientAtScale",
        "decimalNumberParts",
        "parseTrainingSizing",
        "policyCandidateSizing",
        "recommendationAction",
        "recommendationEvLossBb",
        "recommendationPolicySupport",
        "sameTrainingPositionFilter",
        "suggestedActionDifferenceFocus",
        "suggestedCertaintyFocus",
        "suggestedPositionFocus",
        "suggestedTrainingFocus",
        "trainingCertaintyLabel",
        "trainingDecisionComparison",
        "trainingDecisionLabel",
        "trainingLineMatches",
        "trainingReviewQueueStatus",
        "trainingSizingMatches",
      ].sort(),
    );
  });
});
