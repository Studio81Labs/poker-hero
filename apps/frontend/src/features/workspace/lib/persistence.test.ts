import { describe, expect, it } from "vitest";

import * as cacheValidation from "./cacheValidation";
import * as historyPersistence from "./historyPersistence";
import * as mutationLeases from "./mutationLeases";
import * as persistence from "./persistence";
import * as processingQueuePersistence from "./processingQueuePersistence";
import * as reconciliation from "./reconciliation";

describe("workspace persistence compatibility barrel", () => {
  it("exports every runtime member from the focused persistence modules", () => {
    const expectedExports = new Set(
      Object.keys({
        ...cacheValidation,
        ...historyPersistence,
        ...mutationLeases,
        ...processingQueuePersistence,
        ...reconciliation,
      }),
    );

    expect(new Set(Object.keys(persistence))).toEqual(expectedExports);
  });
});
