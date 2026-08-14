import { useState } from "react";

import { getPipelineCapabilities } from "./api";
import { reconcilePipelineSelection } from "./app/pipelineSelection";
import { messageFromError } from "./app/workflow";
import type { PipelineCapabilities, PipelineSelection } from "./types";

interface UsePipelineSelectionOptions {
  onError: (message: string | null) => void;
}

export function usePipelineSelection({ onError }: UsePipelineSelectionOptions) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<PipelineCapabilities | null>(
    null,
  );
  const [selection, setSelection] = useState<PipelineSelection | null>(null);
  const [loading, setLoading] = useState(false);

  function loadCapabilities() {
    if (capabilities || loading) return;
    setLoading(true);
    void getPipelineCapabilities()
      .then((nextCapabilities) => {
        setCapabilities(nextCapabilities);
        setSelection((current) =>
          reconcilePipelineSelection(
            nextCapabilities,
            current ?? nextCapabilities.defaults,
          ),
        );
      })
      .catch((error) =>
        onError(messageFromError(error, "Could not read analysis plugins")),
      )
      .finally(() => setLoading(false));
  }

  function openDialog() {
    setDialogOpen(true);
    loadCapabilities();
  }

  function updateSelection<K extends keyof PipelineSelection>(
    key: K,
    value: PipelineSelection[K],
  ) {
    setSelection((current) =>
      current ? { ...current, [key]: value } : current,
    );
  }

  function updateParserProvider(value: string) {
    setSelection((current) =>
      current && capabilities
        ? reconcilePipelineSelection(capabilities, {
            ...current,
            parser_provider: value,
          })
        : current,
    );
  }

  function updateRecommendationProvider(value: string) {
    setSelection((current) => {
      if (!current) return current;
      if (value !== "local_solver") {
        return {
          ...current,
          recommendation_provider: value,
          recommendation_engine: null,
        };
      }
      const selectedEngineAvailable =
        capabilities?.recommendation_engines.some(
          (option) =>
            option.available && option.id === current.recommendation_engine,
        ) ?? false;
      return {
        ...current,
        recommendation_provider: value,
        recommendation_engine: selectedEngineAvailable
          ? current.recommendation_engine
          : (capabilities?.recommendation_engines.find(
              (option) => option.available,
            )?.id ?? null),
      };
    });
  }

  return {
    capabilities,
    dialogOpen,
    loadCapabilities,
    loading,
    openDialog,
    selection,
    setCapabilities,
    setDialogOpen,
    setLoading,
    setSelection,
    updateParserProvider,
    updateRecommendationProvider,
    updateSelection,
  };
}
