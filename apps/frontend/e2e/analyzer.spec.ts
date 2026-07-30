import { expect, test, type Page } from "@playwright/test";

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    + "AAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
  "base64",
);

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
}) => {
  await openUploadInput(page);

  await page.getByRole("button", { name: "Automation On" }).click();
  await expect(
    page.getByRole("button", { name: "Automation Off" }),
  ).toHaveAttribute("aria-pressed", "false");

  await page.getByLabel("Choose screenshots").setInputFiles({
    name: "manual-flow.png",
    mimeType: "image/png",
    buffer: VALID_PNG,
  });
  await page.getByRole("button", { name: "Upload and parse" }).click();

  const queueItem = page.getByRole("button", {
    name: /manual-flow\.png/,
  });
  await expect(queueItem).toContainText("parsed");
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
    name: "Reopen history item 1",
  });
  await expect(historyItem).toBeVisible();
  await historyItem.click();
  await expect(page.getByLabel("Pot")).toHaveValue("13");
});

test("continues an automated batch when one screenshot is invalid", async ({
  page,
}) => {
  await openUploadInput(page);
  await expect(
    page.getByRole("button", { name: "Automation On" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("Choose screenshots").setInputFiles([
    {
      name: "automated-valid.png",
      mimeType: "image/png",
      buffer: VALID_PNG,
    },
    {
      name: "automated-invalid.png",
      mimeType: "image/png",
      buffer: Buffer.from("not an image"),
    },
  ]);
  await page.getByRole("button", { name: "Upload and parse" }).click();

  await expect(
    page.getByRole("dialog", { name: "Processing queue" }),
  ).toBeHidden();

  const validItem = page.getByRole("button", {
    name: /automated-valid\.png/,
  });
  const invalidItem = page.getByRole("button", {
    name: /automated-invalid\.png/,
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
  await expect(
    page.getByRole("button", { name: "Clear reviewed" }),
  ).toBeDisabled();
});
