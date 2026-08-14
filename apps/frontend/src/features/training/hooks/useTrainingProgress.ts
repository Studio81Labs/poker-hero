import { useState } from "react";

import { getJob, getTrainingProgress } from "../../../shared/api/client";
import {
  sameTrainingPositionFilter,
  type TrainingProgressView,
} from "../lib/trainingPresentation";
import { messageFromError } from "../../workspace/lib/workflow";
import type {
  JobRecord,
  Street,
  TrainingCertaintyFilter,
  TrainingPositionFilter,
  TrainingProgress,
  TrainingReviewCertainty,
  TrainingReviewCertaintyFilter,
  TrainingReviewDifference,
  TrainingReviewOrder,
  TrainingReviewStreet,
  TrainingSolverFilter,
  TrainingStreetFilter,
} from "../../../shared/types";

interface UseTrainingProgressOptions {
  onError: (message: string | null) => void;
  onOpenJob: (job: JobRecord) => void;
}

export function useTrainingProgress({
  onError,
  onOpenJob,
}: UseTrainingProgressOptions) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [progress, setProgress] = useState<TrainingProgress | null>(null);
  const [view, setView] = useState<TrainingProgressView>("recent");
  const [reviewOrder, setReviewOrder] = useState<TrainingReviewOrder>("recent");
  const [reviewStreet, setReviewStreet] = useState<TrainingReviewStreet>("all");
  const [reviewCertainty, setReviewCertainty] =
    useState<TrainingReviewCertaintyFilter>("all");
  const [reviewDifference, setReviewDifference] =
    useState<TrainingReviewDifference | null>(null);
  const [reviewPosition, setReviewPosition] =
    useState<TrainingPositionFilter | null>(null);
  const [solverFilter, setSolverFilter] = useState<TrainingSolverFilter | null>(
    null,
  );
  const [positionFilter, setPositionFilter] =
    useState<TrainingPositionFilter | null>(null);
  const [streetFilter, setStreetFilter] = useState<TrainingStreetFilter | null>(
    null,
  );
  const [certaintyFilter, setCertaintyFilter] =
    useState<TrainingCertaintyFilter | null>(null);
  const [lessonOrder, setLessonOrder] = useState<TrainingReviewOrder>("recent");
  const [lessonStreet, setLessonStreet] = useState<TrainingReviewStreet>("all");
  const [lessonSearch, setLessonSearch] = useState("");
  const [lessonQuery, setLessonQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);
  const [reviewQueueJobId, setReviewQueueJobId] = useState<string | null>(null);

  function openDialog() {
    setReviewQueueJobId(null);
    setDialogOpen(true);
    setProgress(null);
    setView("recent");
    setReviewOrder("recent");
    setReviewStreet("all");
    setReviewCertainty("all");
    setReviewDifference(null);
    setReviewPosition(null);
    setSolverFilter(null);
    setPositionFilter(null);
    setStreetFilter(null);
    setCertaintyFilter(null);
    setLessonOrder("recent");
    setLessonStreet("all");
    setLessonSearch("");
    setLessonQuery("");
    setLoading(true);
    onError(null);
    void getTrainingProgress()
      .then(setProgress)
      .catch((error) =>
        onError(messageFromError(error, "Could not load training progress")),
      )
      .finally(() => setLoading(false));
  }

  async function updateReviewQueue(
    nextOrder: TrainingReviewOrder,
    nextStreet: TrainingReviewStreet,
    nextDifference: TrainingReviewDifference | null = reviewDifference,
    nextCertainty: TrainingReviewCertaintyFilter = reviewCertainty,
    nextPosition: TrainingPositionFilter | null = reviewPosition,
  ) {
    if (
      (nextOrder === reviewOrder &&
        nextStreet === reviewStreet &&
        nextCertainty === reviewCertainty &&
        sameTrainingPositionFilter(nextPosition, reviewPosition) &&
        nextDifference?.decision_action === reviewDifference?.decision_action &&
        nextDifference?.recommended_action ===
          reviewDifference?.recommended_action &&
        solverFilter === null &&
        positionFilter === null &&
        streetFilter === null &&
        certaintyFilter === null) ||
      loading
    ) {
      return;
    }
    const previous = {
      reviewOrder,
      reviewStreet,
      reviewCertainty,
      reviewDifference,
      reviewPosition,
      solverFilter,
      positionFilter,
      streetFilter,
      certaintyFilter,
    };
    setReviewOrder(nextOrder);
    setReviewStreet(nextStreet);
    setReviewCertainty(nextCertainty);
    setReviewDifference(nextDifference);
    setReviewPosition(nextPosition);
    setSolverFilter(null);
    setPositionFilter(null);
    setStreetFilter(null);
    setCertaintyFilter(null);
    setLoading(true);
    onError(null);
    try {
      setProgress(
        await getTrainingProgress(
          nextOrder,
          nextStreet,
          nextDifference,
          nextCertainty,
          lessonStreet,
          lessonQuery,
          lessonOrder,
          null,
          null,
          null,
          null,
          nextPosition,
        ),
      );
    } catch (error) {
      setReviewOrder(previous.reviewOrder);
      setReviewStreet(previous.reviewStreet);
      setReviewCertainty(previous.reviewCertainty);
      setReviewDifference(previous.reviewDifference);
      setReviewPosition(previous.reviewPosition);
      setSolverFilter(previous.solverFilter);
      setPositionFilter(previous.positionFilter);
      setStreetFilter(previous.streetFilter);
      setCertaintyFilter(previous.certaintyFilter);
      onError(messageFromError(error, "Could not filter training reviews"));
    } finally {
      setLoading(false);
    }
  }

  async function updateLessonFilters(
    nextStreet: TrainingReviewStreet,
    nextSearch: string = lessonSearch,
    nextOrder: TrainingReviewOrder = lessonOrder,
  ) {
    const nextQuery = nextSearch.trim();
    if (
      (nextOrder === lessonOrder &&
        nextStreet === lessonStreet &&
        nextQuery === lessonQuery) ||
      loading
    ) {
      return;
    }
    const previousOrder = lessonOrder;
    const previousStreet = lessonStreet;
    setLessonOrder(nextOrder);
    setLessonStreet(nextStreet);
    setLoading(true);
    onError(null);
    try {
      setProgress(
        await getTrainingProgress(
          reviewOrder,
          reviewStreet,
          reviewDifference,
          reviewCertainty,
          nextStreet,
          nextQuery,
          nextOrder,
          solverFilter,
          positionFilter,
          streetFilter,
          certaintyFilter,
          reviewPosition,
        ),
      );
      setLessonQuery(nextQuery);
    } catch (error) {
      setLessonOrder(previousOrder);
      setLessonStreet(previousStreet);
      onError(messageFromError(error, "Could not filter saved lessons"));
    } finally {
      setLoading(false);
    }
  }

  async function focusReviewStreet(street: Street) {
    setView("review");
    await updateReviewQueue(reviewOrder, street, null, "all", null);
  }

  async function focusReviewCertainty(certainty: TrainingReviewCertainty) {
    setView("review");
    await updateReviewQueue(reviewOrder, "all", null, certainty, null);
  }

  async function focusActionDifference(difference: TrainingReviewDifference) {
    setView("review");
    await updateReviewQueue(reviewOrder, "all", difference, "all", null);
  }

  async function focusReviewPosition(position: TrainingPositionFilter) {
    setView("review");
    await updateReviewQueue(reviewOrder, "all", null, "all", position);
  }

  async function updateSolverFilter(filter: TrainingSolverFilter | null) {
    setView("recent");
    if (
      (filter?.kind === solverFilter?.kind &&
        (filter?.kind === "unattributed" ||
          (solverFilter?.kind !== "unattributed" &&
            filter?.key === solverFilter?.key))) ||
      loading
    ) {
      return;
    }
    const previous = {
      solverFilter,
      positionFilter,
      streetFilter,
      certaintyFilter,
    };
    setSolverFilter(filter);
    setPositionFilter(null);
    setStreetFilter(null);
    setCertaintyFilter(null);
    setLoading(true);
    onError(null);
    try {
      setProgress(
        await getTrainingProgress(
          reviewOrder,
          reviewStreet,
          reviewDifference,
          reviewCertainty,
          lessonStreet,
          lessonQuery,
          lessonOrder,
          filter,
          null,
          null,
          null,
          reviewPosition,
        ),
      );
    } catch (error) {
      setSolverFilter(previous.solverFilter);
      setPositionFilter(previous.positionFilter);
      setStreetFilter(previous.streetFilter);
      setCertaintyFilter(previous.certaintyFilter);
      onError(messageFromError(error, "Could not load solver hands"));
    } finally {
      setLoading(false);
    }
  }

  async function updatePositionFilter(filter: TrainingPositionFilter | null) {
    setView("recent");
    if (
      (filter?.kind === positionFilter?.kind &&
        (filter?.kind === "unpositioned" ||
          (positionFilter?.kind === "position" &&
            filter?.position === positionFilter.position))) ||
      loading
    ) {
      return;
    }
    const previous = {
      solverFilter,
      positionFilter,
      streetFilter,
      certaintyFilter,
    };
    setSolverFilter(null);
    setPositionFilter(filter);
    setStreetFilter(null);
    setCertaintyFilter(null);
    setLoading(true);
    onError(null);
    try {
      setProgress(
        await getTrainingProgress(
          reviewOrder,
          reviewStreet,
          reviewDifference,
          reviewCertainty,
          lessonStreet,
          lessonQuery,
          lessonOrder,
          null,
          filter,
          null,
          null,
          reviewPosition,
        ),
      );
    } catch (error) {
      setSolverFilter(previous.solverFilter);
      setPositionFilter(previous.positionFilter);
      setStreetFilter(previous.streetFilter);
      setCertaintyFilter(previous.certaintyFilter);
      onError(messageFromError(error, "Could not load position hands"));
    } finally {
      setLoading(false);
    }
  }

  async function updateStreetFilter(filter: TrainingStreetFilter | null) {
    setView("recent");
    if (filter?.street === streetFilter?.street || loading) return;
    const previous = {
      solverFilter,
      positionFilter,
      streetFilter,
      certaintyFilter,
    };
    setSolverFilter(null);
    setPositionFilter(null);
    setStreetFilter(filter);
    setCertaintyFilter(null);
    setLoading(true);
    onError(null);
    try {
      setProgress(
        await getTrainingProgress(
          reviewOrder,
          reviewStreet,
          reviewDifference,
          reviewCertainty,
          lessonStreet,
          lessonQuery,
          lessonOrder,
          null,
          null,
          filter,
          null,
          reviewPosition,
        ),
      );
    } catch (error) {
      setSolverFilter(previous.solverFilter);
      setPositionFilter(previous.positionFilter);
      setStreetFilter(previous.streetFilter);
      setCertaintyFilter(previous.certaintyFilter);
      onError(messageFromError(error, "Could not load street hands"));
    } finally {
      setLoading(false);
    }
  }

  async function updateCertaintyFilter(filter: TrainingCertaintyFilter | null) {
    setView("recent");
    if (filter?.certainty === certaintyFilter?.certainty || loading) return;
    const previous = {
      solverFilter,
      positionFilter,
      streetFilter,
      certaintyFilter,
    };
    setSolverFilter(null);
    setPositionFilter(null);
    setStreetFilter(null);
    setCertaintyFilter(filter);
    setLoading(true);
    onError(null);
    try {
      setProgress(
        await getTrainingProgress(
          reviewOrder,
          reviewStreet,
          reviewDifference,
          reviewCertainty,
          lessonStreet,
          lessonQuery,
          lessonOrder,
          null,
          null,
          null,
          filter,
          reviewPosition,
        ),
      );
    } catch (error) {
      setSolverFilter(previous.solverFilter);
      setPositionFilter(previous.positionFilter);
      setStreetFilter(previous.streetFilter);
      setCertaintyFilter(previous.certaintyFilter);
      onError(messageFromError(error, "Could not load certainty hands"));
    } finally {
      setLoading(false);
    }
  }

  function selectView(nextView: TrainingProgressView) {
    if (nextView === "recent") {
      if (solverFilter) void updateSolverFilter(null);
      else if (positionFilter) void updatePositionFilter(null);
      else if (streetFilter) void updateStreetFilter(null);
      else if (certaintyFilter) void updateCertaintyFilter(null);
      else setView("recent");
      return;
    }
    if (nextView === "review") {
      setView("review");
      if (solverFilter || positionFilter || streetFilter || certaintyFilter) {
        void updateReviewQueue(reviewOrder, reviewStreet);
      }
      return;
    }
    setView("lessons");
  }

  async function reviewHand(jobId: string, continueReviewQueue = false) {
    setReviewJobId(jobId);
    onError(null);
    try {
      const job = await getJob(jobId);
      onOpenJob(job);
      setReviewQueueJobId(
        continueReviewQueue &&
          progress?.review_queue.some((hand) => hand.job_id === job.id)
          ? job.id
          : null,
      );
      setDialogOpen(false);
    } catch (error) {
      onError(messageFromError(error, "Could not open training hand"));
    } finally {
      setReviewJobId(null);
    }
  }

  return {
    certaintyFilter,
    dialogOpen,
    focusActionDifference,
    focusReviewCertainty,
    focusReviewPosition,
    focusReviewStreet,
    lessonOrder,
    lessonQuery,
    lessonSearch,
    lessonStreet,
    loading,
    openDialog,
    positionFilter,
    progress,
    reviewCertainty,
    reviewDifference,
    reviewHand,
    reviewJobId,
    reviewOrder,
    reviewPosition,
    reviewQueueJobId,
    reviewStreet,
    selectView,
    setDialogOpen,
    setLessonSearch,
    setProgress,
    setReviewJobId,
    setReviewQueueJobId,
    setView,
    solverFilter,
    streetFilter,
    updateCertaintyFilter,
    updateLessonFilters,
    updatePositionFilter,
    updateReviewQueue,
    updateSolverFilter,
    updateStreetFilter,
    view,
  };
}
