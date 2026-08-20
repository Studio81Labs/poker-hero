import { describe, expect, it } from "vitest";

import { createQueryClient, queryClientDefaults } from "./queryClient";

describe("createQueryClient", () => {
  it("preserves the app's explicit, request-driven read behavior", () => {
    const client = createQueryClient();
    const options = client.getDefaultOptions();

    expect(options).toEqual(queryClientDefaults);
    expect(options.queries?.retry).toBe(false);
    expect(options.queries?.refetchOnWindowFocus).toBe(false);
    expect(options.queries?.staleTime).toBe(Number.POSITIVE_INFINITY);
  });
});
