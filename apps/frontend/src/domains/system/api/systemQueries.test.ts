import { describe, expect, it } from "vitest";

import { systemInfoQueryOptions, systemQueryKeys } from "./systemQueries";

describe("system query definitions", () => {
  it("uses a stable, domain-owned key", () => {
    expect(systemQueryKeys.information()).toEqual(["system", "information"]);
    expect(systemInfoQueryOptions().queryKey).toEqual(
      systemQueryKeys.information(),
    );
  });
});
