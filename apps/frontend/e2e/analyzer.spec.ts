import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    + "AAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
  "base64",
);
const BACKEND_URL = "http://127.0.0.1:8010";
const PROVIDER_URL = "http://127.0.0.1:8011";

function attemptFilename(base: string, testInfo: TestInfo): string {
  return [
    base,
    `w${testInfo.workerIndex}`,
    `p${testInfo.repeatEachIndex}`,
    `r${testInfo.retry}.png`,
  ].join("-");
}

function filenamePattern(filename: string): RegExp {
  return new RegExp(
    filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
  );
}

async function uploadValidScreenshot(
  page: Page,
  filename: string,
): Promise<{ id: string; queueItem: Locator }> {
  await page.getByLabel("Choose screenshots").setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: VALID_PNG,
  });
  const uploadResponsePromise = page.waitForResponse(
    (response) => response.url() === `${BACKEND_URL}/api/jobs`
      && response.request().method() === "POST"
      && response.ok(),
  );
  await page.getByRole("button", { name: "Upload and parse" }).click();
  const uploadedJob = await uploadResponsePromise.then(
    (response) => response.json() as Promise<{ id: string }>,
  );
  const queueItem = page.getByRole("button", {
    name: filenamePattern(filename),
  });
  await expect(queueItem).toContainText("parsed");
  return { id: uploadedJob.id, queueItem };
}

async function openUploadInput(page: Page): Promise<void> {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Poker Training Analyzer" }),
  ).toBeVisible();
  await page
    .getByRole("group", { name: "Input mode" })
    .getByRole("button", { name: "Upload" })
    .click();
}

test("reviews one screenshot from upload through persisted history", async ({
  page,
}, testInfo) => {
  await openUploadInput(page);
  const filename = attemptFilename("manual-flow", testInfo);

  await page.getByRole("button", { name: "Automation On" }).click();
  await expect(
    page.getByRole("button", { name: "Automation Off" }),
  ).toHaveAttribute("aria-pressed", "false");

  const uploadedJob = await uploadValidScreenshot(page, filename);
  const queueItem = uploadedJob.queueItem;
  await expect(page.getByLabel("Hero cards")).toHaveValue("Ah Kd");
  await expect(page.getByLabel("Board cards")).toHaveValue("Qs Jc 2h");

  await page.getByLabel("Pot").fill("13");
  await page.getByRole("button", { name: "Approve state" }).click();
  await expect(
    page.getByRole("region", { name: "Your training decision" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Request recommendation" }).click();
  await expect(
    page.getByRole("region", { name: "Recommendation" }),
  ).toBeVisible();
  await expect(queueItem).toContainText("recommended");

  await page.getByRole("button", { name: "Clear reviewed" }).click();
  await expect(queueItem).toBeHidden();

  const historyItem = page.getByRole("button", {
    name: /Reopen history item/,
  }).first();
  await expect(historyItem).toBeVisible();
  await historyItem.click();
  await expect(page.getByLabel("Pot")).toHaveValue("13");

  const persistedResponse = await page.request.get(
    `${BACKEND_URL}/api/jobs/${uploadedJob.id}`,
  );
  expect(persistedResponse.ok()).toBe(true);
  const persistedJob = await persistedResponse.json() as {
    approved_state: { pot_size: number };
    archived_at: string | null;
  };
  expect(persistedJob.approved_state.pot_size).toBe(13);
  expect(persistedJob.archived_at).not.toBeNull();
});

test("continues an automated batch when one screenshot is invalid", async ({
  page,
}, testInfo) => {
  await openUploadInput(page);
  const validFilename = attemptFilename("automated-valid", testInfo);
  const invalidFilename = attemptFilename("automated-invalid", testInfo);
  await expect(
    page.getByRole("button", { name: "Automation On" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("Choose screenshots").setInputFiles([
    {
      name: validFilename,
      mimeType: "image/png",
      buffer: VALID_PNG,
    },
    {
      name: invalidFilename,
      mimeType: "image/png",
      buffer: Buffer.from("not an image"),
    },
  ]);
  await page.getByRole("button", { name: "Upload and parse" }).click();

  await expect(
    page.getByRole("dialog", { name: "Processing queue" }),
  ).toBeHidden();

  const validItem = page.getByRole("button", {
    name: filenamePattern(validFilename),
  });
  const invalidItem = page.getByRole("button", {
    name: filenamePattern(invalidFilename),
  });
  await expect(validItem).toContainText("recommended");
  await expect(invalidItem).toContainText(
    "Upload must contain supported image data",
  );
  await expect(invalidItem).toContainText("error");
  await expect(
    page.getByText(
      "1 screenshot need attention. Check the highlighted queue items.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Recommendation" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Clear reviewed" }).click();
  await expect(validItem).toBeHidden();
  await expect(invalidItem).toBeVisible();
});

test("recovers from a failed recommendation and retries it", async ({
  page,
}, testInfo) => {
  await openUploadInput(page);
  const filename = attemptFilename("provider-retry", testInfo);

  await page.getByRole("button", { name: "Automation On" }).click();
  const uploadedJob = await uploadValidScreenshot(page, filename);
  await page.getByRole("button", { name: "Approve state" }).click();
  await expect(
    page.getByRole("region", { name: "Your training decision" }),
  ).toBeVisible();

  const armFailureResponse = await page.request.post(
    `${PROVIDER_URL}/control/fail-next`,
  );
  expect(armFailureResponse.ok()).toBe(true);

  await page.getByRole("button", { name: "Request recommendation" }).click();
  await expect(
    page.getByText("external_solver request failed with status 503").first(),
  ).toBeVisible();
  await expect(uploadedJob.queueItem).toContainText("error");
  await expect.poll(
    () => page.evaluate(
      () => sessionStorage.getItem("poker-training-processing-mutation-v1"),
    ),
  ).toBeNull();
  const failedJobResponse = await page.request.get(
    `${BACKEND_URL}/api/jobs/${uploadedJob.id}`,
  );
  expect(failedJobResponse.ok()).toBe(true);
  const failedJob = await failedJobResponse.json() as {
    error: string | null;
    recommendation_pending: boolean;
    recommendation_request_id: string | null;
    status: string;
  };
  expect(failedJob).toMatchObject({
    error: "external_solver request failed with status 503",
    recommendation_pending: false,
    status: "error",
  });
  expect(failedJob.recommendation_request_id).not.toBeNull();

  await page.getByRole("button", { name: "Request recommendation" }).click();
  await expect(
    page.getByRole("region", { name: "Recommendation" }),
  ).toBeVisible();
  await expect(uploadedJob.queueItem).toContainText("recommended");
  const recommendedJobResponse = await page.request.get(
    `${BACKEND_URL}/api/jobs/${uploadedJob.id}`,
  );
  expect(recommendedJobResponse.ok()).toBe(true);
  const recommendedJob = await recommendedJobResponse.json() as {
    error: string | null;
    recommendation: { raw: { engine: string } } | null;
    status: string;
  };
  expect(recommendedJob).toMatchObject({
    error: null,
    recommendation: {
      raw: { engine: "e2e_provider_stub" },
    },
    status: "recommended",
  });
});
