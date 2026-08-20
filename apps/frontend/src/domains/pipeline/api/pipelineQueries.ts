import { queryOptions, useQuery } from "@tanstack/react-query";

import { getPipelineCapabilities } from "./pipelineApi";

export const pipelineQueryKeys = {
  all: ["pipeline"] as const,
  capabilities: () => [...pipelineQueryKeys.all, "capabilities"] as const,
};

export function pipelineCapabilitiesQueryOptions() {
  return queryOptions({
    queryFn: ({ signal }) => getPipelineCapabilities(signal),
    queryKey: pipelineQueryKeys.capabilities(),
  });
}

export function usePipelineCapabilitiesQuery(enabled: boolean) {
  return useQuery({ ...pipelineCapabilitiesQueryOptions(), enabled });
}
