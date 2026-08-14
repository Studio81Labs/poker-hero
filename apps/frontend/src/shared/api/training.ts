import type {
  JobRecord,
  RecommendationAction,
  TrainingCertainty,
  TrainingCertaintyFilter,
  TrainingPositionFilter,
  TrainingProgress,
  TrainingReviewCertaintyFilter,
  TrainingReviewDifference,
  TrainingReviewOrder,
  TrainingReviewStreet,
  TrainingSolverFilter,
  TrainingStreetFilter,
} from "../types";
import { apiUrl, readJson } from "./core";

export async function recordTrainingDecision(
  jobId: string,
  action: RecommendationAction,
  sizing: number | null,
  certainty: TrainingCertainty | null,
): Promise<JobRecord> {
  const response = await fetch(apiUrl(`/api/jobs/${jobId}/decision`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, sizing, certainty }),
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function completeTrainingReview(
  jobId: string,
  note: string | null,
): Promise<JobRecord> {
  const response = await fetch(apiUrl(`/api/jobs/${jobId}/training-review`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function reopenTrainingReview(jobId: string): Promise<JobRecord> {
  const response = await fetch(apiUrl(`/api/jobs/${jobId}/training-review`), {
    method: "DELETE",
    credentials: "include",
  });
  return readJson<JobRecord>(response);
}

export async function getTrainingProgress(
  reviewOrder: TrainingReviewOrder = "recent",
  reviewStreet: TrainingReviewStreet = "all",
  reviewDifference: TrainingReviewDifference | null = null,
  reviewCertainty: TrainingReviewCertaintyFilter = "all",
  lessonStreet: TrainingReviewStreet = "all",
  lessonQuery = "",
  lessonOrder: TrainingReviewOrder = "recent",
  solverFilter: TrainingSolverFilter | null = null,
  positionFilter: TrainingPositionFilter | null = null,
  streetFilter: TrainingStreetFilter | null = null,
  certaintyFilter: TrainingCertaintyFilter | null = null,
  reviewPositionFilter: TrainingPositionFilter | null = null,
): Promise<TrainingProgress> {
  const search = new URLSearchParams();
  if (reviewOrder !== "recent") {
    search.set("review_order", reviewOrder);
  }
  if (reviewStreet !== "all") {
    search.set("review_street", reviewStreet);
  }
  if (reviewCertainty !== "all") {
    search.set("review_certainty", reviewCertainty);
  }
  if (reviewDifference) {
    search.set("review_decision_action", reviewDifference.decision_action);
    search.set(
      "review_recommended_action",
      reviewDifference.recommended_action,
    );
  }
  if (reviewPositionFilter?.kind === "position") {
    search.set("review_position", reviewPositionFilter.position);
  } else if (reviewPositionFilter?.kind === "unpositioned") {
    search.set("review_unpositioned", "true");
  }
  if (lessonOrder !== "recent") {
    search.set("lesson_order", lessonOrder);
  }
  if (lessonStreet !== "all") {
    search.set("lesson_street", lessonStreet);
  }
  if (lessonQuery.trim()) {
    search.set("lesson_query", lessonQuery.trim());
  }
  if (solverFilter?.kind === "fallback") {
    search.set("solver_fallback_key", solverFilter.key);
  } else if (solverFilter?.kind === "route") {
    search.set("solver_route_key", solverFilter.key);
  } else if (solverFilter?.kind === "unattributed") {
    search.set("solver_unattributed", "true");
  }
  if (positionFilter?.kind === "position") {
    search.set("recent_position", positionFilter.position);
  } else if (positionFilter?.kind === "unpositioned") {
    search.set("recent_unpositioned", "true");
  }
  if (streetFilter) {
    search.set("recent_street", streetFilter.street);
  }
  if (certaintyFilter) {
    search.set("recent_certainty", certaintyFilter.certainty);
  }
  const query = search.size > 0 ? `?${search.toString()}` : "";
  const response = await fetch(apiUrl(`/api/training/progress${query}`), {
    credentials: "include",
  });
  return readJson<TrainingProgress>(response);
}

export function trainingLessonsExportUrl(
  lessonStreet: TrainingReviewStreet = "all",
  lessonQuery = "",
  lessonOrder: TrainingReviewOrder = "recent",
): string {
  const search = new URLSearchParams();
  if (lessonOrder !== "recent") {
    search.set("lesson_order", lessonOrder);
  }
  if (lessonStreet !== "all") {
    search.set("lesson_street", lessonStreet);
  }
  if (lessonQuery.trim()) {
    search.set("lesson_query", lessonQuery.trim());
  }
  const query = search.size > 0 ? `?${search.toString()}` : "";
  return apiUrl(`/api/training/lessons/export${query}`);
}
