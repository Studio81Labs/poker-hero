import { apiUrl, readJson } from "./core";

export interface JsonRequestOptions extends RequestInit {
  signal?: AbortSignal;
}

/**
 * Shared JSON transport for new domain API adapters. Existing API modules keep
 * their current request code until their migration wave so their facade stays
 * behaviorally stable.
 */
export async function requestJson<T>(
  path: string,
  options: JsonRequestOptions = {},
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...options,
    credentials: options.credentials ?? "include",
  });
  return readJson<T>(response);
}
