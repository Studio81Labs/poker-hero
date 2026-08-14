import { describe, expect, it } from "vitest";

import * as client from "./client";

describe("shared API client", () => {
  it("preserves the public compatibility surface", () => {
    expect(Object.keys(client).sort()).toEqual(
      [
        "ApiResponseError",
        "applicationBackupUrl",
        "approveState",
        "archiveJobs",
        "benchmarkDatasetUrl",
        "completeTrainingReview",
        "createMcpPrincipal",
        "deleteJob",
        "getBenchmarkDatasetImport",
        "getBenchmarkOverview",
        "getBenchmarkReport",
        "getHistory",
        "getJob",
        "getMcpAccessConfig",
        "getPipelineCapabilities",
        "getProcessingJobs",
        "getSystemInfo",
        "getTrainingProgress",
        "humanReadableMessage",
        "imageUrl",
        "importBenchmarkDataset",
        "listMcpPrincipals",
        "recordTrainingDecision",
        "reopenTrainingReview",
        "requestRecommendation",
        "restoreApplicationBackup",
        "revokeMcpPrincipal",
        "rotateMcpPrincipal",
        "runParserBenchmark",
        "setBenchmarkInclusion",
        "trainingLessonsExportUrl",
        "updateJobMetadata",
        "uploadScreenshot",
      ].sort(),
    );
  });
});
