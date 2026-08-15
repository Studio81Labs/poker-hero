import type { Street } from "../../../shared/types/poker";
import type { RecommendationAction } from "../../../shared/types/recommendations";
import type {
  TrainingCertainty,
  TrainingPositionFilter,
  TrainingReviewCertainty,
  TrainingReviewDifference,
} from "../../../shared/types/training";

export type TrainingActionOption = "" | RecommendationAction;

export type TrainingCertaintyOption = "" | TrainingCertainty;

export type TrainingProgressView = "recent" | "review" | "lessons";

export type TrainingFocus = { street: Street; reason: string };

export type TrainingCertaintyFocus = {
  certainty: TrainingReviewCertainty;
  label: string;
  reason: string;
};

export type TrainingPositionFocus = {
  filter: TrainingPositionFilter;
  label: string;
  reason: string;
};

export type TrainingActionDifferenceFocus = {
  difference: TrainingReviewDifference;
  label: string;
  reason: string;
};
