import { QueryClient } from "@tanstack/react-query";

export const queryClientDefaults = {
  mutations: {
    retry: false,
  },
  queries: {
    gcTime: 30 * 60 * 1_000,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  },
} as const;

export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: queryClientDefaults });
}
