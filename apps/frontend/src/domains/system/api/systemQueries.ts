import { queryOptions, useQuery } from "@tanstack/react-query";

import { getSystemInfo } from "./systemApi";

export const systemQueryKeys = {
  all: ["system"] as const,
  information: () => [...systemQueryKeys.all, "information"] as const,
};

export function systemInfoQueryOptions() {
  return queryOptions({
    queryFn: ({ signal }) => getSystemInfo(signal),
    queryKey: systemQueryKeys.information(),
  });
}

export function useSystemInfoQuery(enabled: boolean) {
  return useQuery({ ...systemInfoQueryOptions(), enabled });
}
