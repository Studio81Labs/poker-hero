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

function expectPixelClose(
  actual: number[],
  expected: readonly [number, number, number, number],
): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((channel, index) => {
    const tolerance = index === 3 ? 0 : 12;
    expect(Math.abs(actual[index] - channel)).toBeLessThanOrEqual(tolerance);
  });
}

async function samplePngPixels(
  page: Page,
  imageBytes: Buffer,
): Promise<{ background: number[]; table: number[] }> {
  return page.evaluate(async (pngBase64) => {
    const binary = window.atob(pngBase64);
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("Canvas is unavailable");
    }
    context.drawImage(bitmap, 0, 0);
    const pixelAt = (x: number, y: number) => Array.from(
      context.getImageData(x, y, 1, 1).data,
    );
    const samples = {
      background: pixelAt(20, 20),
      table: pixelAt(320, 100),
    };
    bitmap.close();
    return samples;
  }, imageBytes.toString("base64"));
}

async function captureAutomatedFrame(
  page: Page,
): Promise<{
  id: string;
  original_filename: string;
  queueItem: Locator;
}> {
  const uploadResponsePromise = page.waitForResponse(
    (response) => response.url() === `${BACKEND_URL}/api/jobs`
      && response.request().method() === "POST"
      && response.ok(),
  );
  await page.getByRole("button", { name: "Capture and parse" }).click();
  const uploadedJob = await uploadResponsePromise.then(
    (response) => response.json() as Promise<{
      id: string;
      original_filename: string;
    }>,
  );
  expect(uploadedJob.original_filename).toMatch(
    /^screen-capture-\d{4}-\d{2}-\d{2}T.*Z\.png$/,
  );
  const queueItem = page.getByRole("button", {
    name: filenamePattern(uploadedJob.original_filename),
  });
  await expect(queueItem).toContainText("recommended");
  return { ...uploadedJob, queueItem };
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

type CaptureSurface = "browser" | "monitor" | "window";
type CaptureOutcome = CaptureSurface | "cancel";

async function installCaptureStreams(
  page: Page,
  outcomes: readonly CaptureOutcome[] = ["window"],
): Promise<void> {
  await page.addInitScript((configuredOutcomes) => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async (requestedOptions: DisplayMediaStreamOptions) => {
        const fixtureWindow = window as typeof window & {
          __pokerHeroCaptureFixtures?: Array<{
            stream: MediaStream;
            surface: CaptureSurface;
          }>;
          __pokerHeroDisplayMediaCalls?: number;
          __pokerHeroDisplayMediaOptions?: DisplayMediaStreamOptions[];
        };
        const callIndex = fixtureWindow.__pokerHeroDisplayMediaCalls ?? 0;
        fixtureWindow.__pokerHeroDisplayMediaCalls = callIndex + 1;
        const displayMediaOptions =
          fixtureWindow.__pokerHeroDisplayMediaOptions ?? [];
        displayMediaOptions.push(requestedOptions);
        fixtureWindow.__pokerHeroDisplayMediaOptions = displayMediaOptions;
        const outcome = configuredOutcomes[
          Math.min(callIndex, configuredOutcomes.length - 1)
        ] ?? "window";
        if (outcome === "cancel") {
          throw new DOMException(
            "Screen sharing was cancelled",
            "NotAllowedError",
          );
        }
        const displaySurface = outcome;
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext("2d");
        if (context === null) {
          throw new Error("Canvas is unavailable");
        }

        let frame = 0;
        let tableColor = "#991b3f";
        const paintFrame = () => {
          context.fillStyle = "#1f2937";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = tableColor;
          context.beginPath();
          context.ellipse(320, 180, 250, 125, 0, 0, Math.PI * 2);
          context.fill();
          context.fillStyle = "#ffffff";
          context.font = "bold 28px sans-serif";
          context.fillText("Poker Hero capture fixture", 145, 188);
          context.fillStyle = frame % 2 === 0 ? "#22c55e" : "#16a34a";
          context.fillRect(510, 300, 90, 18);
          frame += 1;
        };
        paintFrame();

        const stream = canvas.captureStream(8);
        const track = stream.getVideoTracks()[0];
        const nativeGetSettings = track.getSettings.bind(track);
        track.getSettings = () => ({
          ...nativeGetSettings(),
          displaySurface,
        });
        const interval = window.setInterval(paintFrame, 125);
        const clearPaintInterval = () => window.clearInterval(interval);
        const nativeStop = track.stop.bind(track);
        track.stop = () => {
          clearPaintInterval();
          nativeStop();
        };
        track.addEventListener("ended", clearPaintInterval, {
          once: true,
        });

        const fixture = {
          canvas,
          setTableColor(color: string) {
            tableColor = color;
            paintFrame();
          },
          stream,
          surface: displaySurface,
        };
        const fixtures = fixtureWindow.__pokerHeroCaptureFixtures ?? [];
        fixtures.push(fixture);
        Object.assign(fixtureWindow, {
          __pokerHeroCaptureFixture: fixture,
          __pokerHeroCaptureFixtures: fixtures,
        });
        return stream;
      },
    });
  }, [...outcomes]);
}

test("captures repeated shared-window frames into persisted history", async ({
  page,
}) => {
  await installCaptureStreams(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Poker Training Analyzer" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Automation On" }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Share window" }).click();
  await expect(page.getByText("Window sharing active")).toBeVisible();
  const preview = page.getByLabel("Shared screen preview");
  await expect(preview).toHaveClass(/active/);
  await expect.poll(
    () => preview.evaluate((element: HTMLVideoElement) => ({
      height: element.videoHeight,
      width: element.videoWidth,
    })),
  ).toEqual({ height: 360, width: 640 });

  const firstCapture = await captureAutomatedFrame(page);
  await expect(
    page.getByRole("region", { name: "Recommendation" }),
  ).toBeVisible();
  await expect(preview).not.toHaveClass(/active/);
  await expect(
    page.getByAltText("Uploaded poker table screenshot"),
  ).toBeVisible();

  const imageResponse = await page.request.get(
    `${BACKEND_URL}/api/jobs/${firstCapture.id}/image`,
  );
  expect(imageResponse.ok()).toBe(true);
  expect(imageResponse.headers()["content-type"]).toContain("image/png");
  const imageBytes = await imageResponse.body();
  expect(imageBytes.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(imageBytes.readUInt32BE(16)).toBe(640);
  expect(imageBytes.readUInt32BE(20)).toBe(360);
  const sampledPixels = await samplePngPixels(page, imageBytes);
  expectPixelClose(sampledPixels.background, [31, 41, 55, 255]);
  expectPixelClose(sampledPixels.table, [153, 27, 63, 255]);

  const persistedResponse = await page.request.get(
    `${BACKEND_URL}/api/jobs/${firstCapture.id}`,
  );
  expect(persistedResponse.ok()).toBe(true);
  const persistedJob = await persistedResponse.json() as {
    approved_state: unknown;
    archived_at: string | null;
    recommendation: { raw: Record<string, string> } | null;
    status: string;
    upload_request_id: string | null;
  };
  expect(persistedJob).toMatchObject({
    approved_state: expect.any(Object),
    archived_at: null,
    recommendation: {
      raw: {
        engine: "e2e_provider_stub",
        provider: "external_solver",
      },
    },
    status: "recommended",
    upload_request_id: expect.any(String),
  });

  await page.getByRole("button", { name: "View live window" }).click();
  await expect(preview).toHaveClass(/active/);
  await page.evaluate(() => {
    const fixture = (
      window as typeof window & {
        __pokerHeroCaptureFixture: {
          setTableColor: (color: string) => void;
        };
      }
    ).__pokerHeroCaptureFixture;
    fixture.setTableColor("#0e7490");
  });
  await expect.poll(
    () => preview.evaluate((video: HTMLVideoElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (context === null) {
        return false;
      }
      context.drawImage(video, 0, 0);
      const [red, green, blue, alpha] = context.getImageData(
        320,
        100,
        1,
        1,
      ).data;
      return Math.abs(red - 14) <= 12
        && Math.abs(green - 116) <= 12
        && Math.abs(blue - 144) <= 12
        && alpha === 255;
    }),
  ).toBe(true);

  const secondCapture = await captureAutomatedFrame(page);
  expect(secondCapture.original_filename).not.toBe(
    firstCapture.original_filename,
  );
  await expect(firstCapture.queueItem).toContainText("recommended");
  await expect(secondCapture.queueItem).toContainText("recommended");
  const secondImageResponse = await page.request.get(
    `${BACKEND_URL}/api/jobs/${secondCapture.id}/image`,
  );
  expect(secondImageResponse.ok()).toBe(true);
  const secondImageBytes = await secondImageResponse.body();
  const secondSampledPixels = await samplePngPixels(page, secondImageBytes);
  expectPixelClose(secondSampledPixels.background, [31, 41, 55, 255]);
  expectPixelClose(secondSampledPixels.table, [14, 116, 144, 255]);
  expect(secondImageBytes).not.toEqual(imageBytes);

  const displayMediaCalls = await page.evaluate(() => (
    window as typeof window & {
      __pokerHeroDisplayMediaCalls?: number;
    }
  ).__pokerHeroDisplayMediaCalls);
  expect(displayMediaCalls).toBe(1);

  await page.getByRole("button", { name: "Clear reviewed" }).click();
  await expect(firstCapture.queueItem).toBeHidden();
  await expect(secondCapture.queueItem).toBeHidden();
  await expect(
    page.getByRole("button", { name: /Reopen history item/ }).first(),
  ).toBeVisible();

  const archivedResponses = await Promise.all([
    page.request.get(`${BACKEND_URL}/api/jobs/${firstCapture.id}`),
    page.request.get(`${BACKEND_URL}/api/jobs/${secondCapture.id}`),
  ]);
  for (const archivedResponse of archivedResponses) {
    expect(archivedResponse.ok()).toBe(true);
    const archivedJob = await archivedResponse.json() as {
      archived_at: string | null;
    };
    expect(archivedJob.archived_at).not.toBeNull();
  }

  await page.getByRole("button", { name: "Stop sharing" }).click();
  await expect(
    page.getByRole("button", { name: "Share window" }),
  ).toBeEnabled();
  await expect.poll(
    () => page.evaluate(() => {
      const fixture = (
        window as typeof window & {
          __pokerHeroCaptureFixture: { stream: MediaStream };
        }
      ).__pokerHeroCaptureFixture;
      return fixture.stream.getVideoTracks()[0]?.readyState;
    }),
  ).toBe("ended");
});

test("rejects a mismatched share source and recovers with a tab", async ({
  page,
}) => {
  await installCaptureStreams(page, ["browser", "browser"]);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Poker Training Analyzer" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Share window" }).click();
  await expect(
    page.getByText(
      "Tab was selected. Choose a window in the browser share picker, or switch the source type before sharing.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Capture and parse" }),
  ).toBeDisabled();
  await expect(
    page.getByText("No screenshots uploaded or captured yet"),
  ).toBeVisible();
  await expect.poll(
    () => page.evaluate(() => {
      const fixtures = (
        window as typeof window & {
          __pokerHeroCaptureFixtures: Array<{ stream: MediaStream }>;
        }
      ).__pokerHeroCaptureFixtures;
      return fixtures[0]?.stream.getVideoTracks()[0]?.readyState;
    }),
  ).toBe("ended");

  await page
    .getByRole("group", { name: "Share source type" })
    .getByRole("button", { name: "Tab" })
    .click();
  await page.getByRole("button", { name: "Share tab" }).click();
  await expect(page.getByText("Tab sharing active")).toBeVisible();
  const preview = page.getByLabel("Shared screen preview");
  await expect(preview).toHaveClass(/active/);
  await expect.poll(
    () => preview.evaluate((element: HTMLVideoElement) => ({
      height: element.videoHeight,
      width: element.videoWidth,
    })),
  ).toEqual({ height: 360, width: 640 });
  await expect(
    page.getByText(
      "Tab was selected. Choose a window in the browser share picker, or switch the source type before sharing.",
    ),
  ).toBeHidden();

  const capture = await captureAutomatedFrame(page);
  await expect(
    page.getByRole("region", { name: "Recommendation" }),
  ).toBeVisible();
  const activeShareState = await page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      __pokerHeroCaptureFixtures: Array<{
        stream: MediaStream;
        surface: CaptureSurface;
      }>;
      __pokerHeroDisplayMediaCalls?: number;
      __pokerHeroDisplayMediaOptions?: DisplayMediaStreamOptions[];
    };
    return {
      calls: fixtureWindow.__pokerHeroDisplayMediaCalls,
      requestedSurfaces: (
        fixtureWindow.__pokerHeroDisplayMediaOptions ?? []
      ).map((options) => {
        const video = options.video;
        return typeof video === "object" && video !== null
          ? video.displaySurface
          : null;
      }),
      streams: fixtureWindow.__pokerHeroCaptureFixtures.map((fixture) => ({
        readyState: fixture.stream.getVideoTracks()[0]?.readyState,
        surface: fixture.surface,
      })),
    };
  });
  expect(activeShareState).toEqual({
    calls: 2,
    requestedSurfaces: ["window", "browser"],
    streams: [
      { readyState: "ended", surface: "browser" },
      { readyState: "live", surface: "browser" },
    ],
  });

  await page.getByRole("button", { name: "Clear reviewed" }).click();
  await expect(capture.queueItem).toBeHidden();
  const archivedResponse = await page.request.get(
    `${BACKEND_URL}/api/jobs/${capture.id}`,
  );
  expect(archivedResponse.ok()).toBe(true);
  const archivedJob = await archivedResponse.json() as {
    archived_at: string | null;
  };
  expect(archivedJob.archived_at).not.toBeNull();

  await page.getByRole("button", { name: "Stop sharing" }).click();
  await expect.poll(
    () => page.evaluate(() => {
      const fixtures = (
        window as typeof window & {
          __pokerHeroCaptureFixtures: Array<{ stream: MediaStream }>;
        }
      ).__pokerHeroCaptureFixtures;
      return fixtures.map(
        (fixture) => fixture.stream.getVideoTracks()[0]?.readyState,
      );
    }),
  ).toEqual(["ended", "ended"]);
});

test("recovers after the browser share picker is cancelled", async ({
  page,
}) => {
  await installCaptureStreams(page, ["cancel", "window"]);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Poker Training Analyzer" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Share window" }).click();
  await expect(page.getByText("Screen sharing was cancelled")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Capture and parse" }),
  ).toBeDisabled();
  await expect(
    page.getByText("No screenshots uploaded or captured yet"),
  ).toBeVisible();
  const cancelledState = await page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      __pokerHeroCaptureFixtures?: Array<{ stream: MediaStream }>;
      __pokerHeroDisplayMediaCalls?: number;
      __pokerHeroDisplayMediaOptions?: DisplayMediaStreamOptions[];
    };
    return {
      calls: fixtureWindow.__pokerHeroDisplayMediaCalls,
      fixtures: fixtureWindow.__pokerHeroCaptureFixtures?.length ?? 0,
      requestedSurfaces: (
        fixtureWindow.__pokerHeroDisplayMediaOptions ?? []
      ).map((options) => {
        const video = options.video;
        return typeof video === "object" && video !== null
          ? video.displaySurface
          : null;
      }),
    };
  });
  expect(cancelledState).toEqual({
    calls: 1,
    fixtures: 0,
    requestedSurfaces: ["window"],
  });

  await page.getByRole("button", { name: "Share window" }).click();
  await expect(page.getByText("Window sharing active")).toBeVisible();
  await expect(page.getByText("Screen sharing was cancelled")).toBeHidden();
  const preview = page.getByLabel("Shared screen preview");
  await expect(preview).toHaveClass(/active/);
  await expect.poll(
    () => preview.evaluate((element: HTMLVideoElement) => ({
      height: element.videoHeight,
      width: element.videoWidth,
    })),
  ).toEqual({ height: 360, width: 640 });

  const capture = await captureAutomatedFrame(page);
  await expect(
    page.getByRole("region", { name: "Recommendation" }),
  ).toBeVisible();
  const recoveredState = await page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      __pokerHeroCaptureFixtures: Array<{
        stream: MediaStream;
        surface: CaptureSurface;
      }>;
      __pokerHeroDisplayMediaCalls?: number;
      __pokerHeroDisplayMediaOptions?: DisplayMediaStreamOptions[];
    };
    return {
      calls: fixtureWindow.__pokerHeroDisplayMediaCalls,
      requestedSurfaces: (
        fixtureWindow.__pokerHeroDisplayMediaOptions ?? []
      ).map((options) => {
        const video = options.video;
        return typeof video === "object" && video !== null
          ? video.displaySurface
          : null;
      }),
      streams: fixtureWindow.__pokerHeroCaptureFixtures.map((fixture) => ({
        readyState: fixture.stream.getVideoTracks()[0]?.readyState,
        surface: fixture.surface,
      })),
    };
  });
  expect(recoveredState).toEqual({
    calls: 2,
    requestedSurfaces: ["window", "window"],
    streams: [{ readyState: "live", surface: "window" }],
  });

  await page.getByRole("button", { name: "Clear reviewed" }).click();
  await expect(capture.queueItem).toBeHidden();
  const archivedResponse = await page.request.get(
    `${BACKEND_URL}/api/jobs/${capture.id}`,
  );
  expect(archivedResponse.ok()).toBe(true);
  const archivedJob = await archivedResponse.json() as {
    archived_at: string | null;
  };
  expect(archivedJob.archived_at).not.toBeNull();

  await page.getByRole("button", { name: "Stop sharing" }).click();
  await expect.poll(
    () => page.evaluate(() => {
      const fixtures = (
        window as typeof window & {
          __pokerHeroCaptureFixtures: Array<{ stream: MediaStream }>;
        }
      ).__pokerHeroCaptureFixtures;
      return fixtures.map(
        (fixture) => fixture.stream.getVideoTracks()[0]?.readyState,
      );
    }),
  ).toEqual(["ended"]);
});

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

test("continues an automated batch after a recommendation provider failure", async ({
  page,
}, testInfo) => {
  await openUploadInput(page);
  const failedFilename = attemptFilename("automated-provider-failure", testInfo);
  const successfulFilename = attemptFilename("automated-provider-success", testInfo);
  await expect(
    page.getByRole("button", { name: "Automation On" }),
  ).toHaveAttribute("aria-pressed", "true");

  const armFailureResponse = await page.request.post(
    `${PROVIDER_URL}/control/fail-next-recommendation`,
  );
  expect(armFailureResponse.ok()).toBe(true);

  await page.getByLabel("Choose screenshots").setInputFiles([
    {
      name: failedFilename,
      mimeType: "image/png",
      buffer: VALID_PNG,
    },
    {
      name: successfulFilename,
      mimeType: "image/png",
      buffer: VALID_PNG,
    },
  ]);
  await page.getByRole("button", { name: "Upload and parse" }).click();

  await expect(
    page.getByRole("dialog", { name: "Processing queue" }),
  ).toBeHidden();
  const failedItem = page.getByRole("button", {
    name: filenamePattern(failedFilename),
  });
  const successfulItem = page.getByRole("button", {
    name: filenamePattern(successfulFilename),
  });
  await expect(failedItem).toContainText("error");
  await expect(failedItem).toContainText(
    "external_solver request failed with status 503",
  );
  await expect(successfulItem).toContainText("recommended");
  await expect(
    page.getByText(
      "1 screenshot need attention. Check the highlighted queue items.",
    ),
  ).toBeVisible();
  await expect.poll(
    () => page.evaluate(
      () => sessionStorage.getItem("poker-training-processing-mutation-v1"),
    ),
  ).toBeNull();

  const processingJobsResponse = await page.request.get(
    `${BACKEND_URL}/api/jobs`,
  );
  expect(processingJobsResponse.ok()).toBe(true);
  const processingJobs = await processingJobsResponse.json() as {
    jobs: Array<{
      approved_state: unknown;
      error: string | null;
      original_filename: string;
      recommendation: { raw: Record<string, string> } | null;
      recommendation_request_id: string | null;
      status: string;
    }>;
  };
  const failedJob = processingJobs.jobs.find(
    (candidate) => candidate.original_filename === failedFilename,
  );
  const successfulJob = processingJobs.jobs.find(
    (candidate) => candidate.original_filename === successfulFilename,
  );
  expect(failedJob).toMatchObject({
    approved_state: expect.any(Object),
    error: "external_solver request failed with status 503",
    recommendation: null,
    recommendation_request_id: expect.any(String),
    status: "error",
  });
  expect(successfulJob).toMatchObject({
    error: null,
    recommendation: {
      raw: {
        engine: "e2e_provider_stub",
        provider: "external_solver",
      },
    },
    recommendation_request_id: expect.any(String),
    status: "recommended",
  });

  await successfulItem.click();
  await expect(
    page.getByRole("region", { name: "Recommendation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear reviewed" }).click();
  await expect(successfulItem).toBeHidden();
  await expect(failedItem).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Request recommendation" }),
  ).toBeEnabled();
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
    `${PROVIDER_URL}/control/fail-next-recommendation`,
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

test("reconciles a recommendation that completes after page reload", async ({
  page,
}, testInfo) => {
  await openUploadInput(page);
  const filename = attemptFilename("recommendation-reload", testInfo);

  await page.getByRole("button", { name: "Automation On" }).click();
  const uploadedJob = await uploadValidScreenshot(page, filename);
  await page.getByRole("button", { name: "Approve state" }).click();

  const armBlockResponse = await page.request.post(
    `${PROVIDER_URL}/control/block-next-recommendation`,
  );
  expect(armBlockResponse.ok()).toBe(true);

  let recommendationReleased = false;
  try {
    await page.getByRole("button", { name: "Request recommendation" }).click();
    await expect.poll(async () => {
      const response = await page.request.get(
        `${PROVIDER_URL}/control/recommendation-state`,
      );
      if (!response.ok()) {
        return false;
      }
      const state = await response.json() as { started: boolean };
      return state.started;
    }).toBe(true);
    await expect.poll(async () => {
      const response = await page.request.get(
        `${BACKEND_URL}/api/jobs/${uploadedJob.id}`,
      );
      if (!response.ok()) {
        return false;
      }
      const job = await response.json() as {
        recommendation_pending: boolean;
      };
      return job.recommendation_pending;
    }).toBe(true);
    const pendingLease = await page.evaluate(() => JSON.parse(
      sessionStorage.getItem("poker-training-processing-mutation-v1") ?? "null",
    ) as {
      expectedRecommendationRequestId: string;
      jobId: string;
      kind: string;
    } | null);
    if (pendingLease === null) {
      throw new Error("Recommendation mutation lease was not persisted");
    }
    expect(pendingLease).toMatchObject({
      expectedRecommendationRequestId: expect.any(String),
      jobId: uploadedJob.id,
      kind: "job",
    });

    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Poker Training Analyzer" }),
    ).toBeVisible();
    const reloadedQueueItem = page.getByRole("button", {
      name: filenamePattern(filename),
    });
    await expect(reloadedQueueItem).toContainText("Recommendation running");
    await reloadedQueueItem.click();
    await expect(
      page.getByRole("region", { name: "Recommendation" }),
    ).toBeHidden();

    const releaseResponse = await page.request.post(
      `${PROVIDER_URL}/control/release-recommendation`,
    );
    expect(releaseResponse.ok()).toBe(true);
    recommendationReleased = true;

    await expect(
      page.getByRole("region", { name: "Recommendation" }),
    ).toBeVisible();
    await expect(reloadedQueueItem).toContainText("recommended");
    await expect.poll(
      () => page.evaluate(
        () => sessionStorage.getItem("poker-training-processing-mutation-v1"),
      ),
    ).toBeNull();

    const completedJobResponse = await page.request.get(
      `${BACKEND_URL}/api/jobs/${uploadedJob.id}`,
    );
    expect(completedJobResponse.ok()).toBe(true);
    const completedJob = await completedJobResponse.json() as {
      error: string | null;
      recommendation: { raw: Record<string, string> } | null;
      recommendation_pending: boolean;
      recommendation_request_id: string | null;
      status: string;
    };
    expect(completedJob).toMatchObject({
      error: null,
      recommendation: {
        raw: {
          engine: "e2e_provider_stub",
          provider: "external_solver",
        },
      },
      recommendation_pending: false,
      recommendation_request_id: pendingLease.expectedRecommendationRequestId,
      status: "recommended",
    });
  } finally {
    if (!recommendationReleased) {
      await page.request.post(
        `${PROVIDER_URL}/control/release-recommendation`,
      );
    }
  }
});

test("persists a parser failure and recovers by re-uploading the screenshot", async ({
  page,
}, testInfo) => {
  await openUploadInput(page);
  const filename = attemptFilename("parser-retry", testInfo);
  await expect(
    page.getByRole("button", { name: "Automation On" }),
  ).toHaveAttribute("aria-pressed", "true");

  const armFailureResponse = await page.request.post(
    `${PROVIDER_URL}/control/fail-next-parser`,
  );
  expect(armFailureResponse.ok()).toBe(true);

  await page.getByLabel("Choose screenshots").setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: VALID_PNG,
  });
  const failedUploadResponsePromise = page.waitForResponse(
    (response) => response.url() === `${BACKEND_URL}/api/jobs`
      && response.request().method() === "POST"
      && response.status() === 502,
  );
  await page.getByRole("button", { name: "Upload and parse" }).click();
  const failedUploadResponse = await failedUploadResponsePromise;
  expect(await failedUploadResponse.json()).toEqual({
    detail: "Vision parser request failed with status 503",
  });

  const matchingQueueItems = page.getByRole("button", {
    name: filenamePattern(filename),
  });
  await expect(matchingQueueItems).toHaveCount(1);
  await expect(matchingQueueItems).toContainText("error");
  await expect(matchingQueueItems).toContainText(
    "Vision parser request failed with status 503",
  );
  await expect.poll(
    () => page.evaluate(
      () => sessionStorage.getItem("poker-training-processing-mutation-v1"),
    ),
  ).toBeNull();

  const failedJobsResponse = await page.request.get(`${BACKEND_URL}/api/jobs`);
  expect(failedJobsResponse.ok()).toBe(true);
  const failedJobs = await failedJobsResponse.json() as {
    jobs: Array<{
      error: string | null;
      id: string;
      original_filename: string;
      parser_provider: string;
      parser_result: unknown;
      status: string;
      upload_request_id: string | null;
    }>;
  };
  const failedJob = failedJobs.jobs.find(
    (candidate) => candidate.original_filename === filename,
  );
  expect(failedJob).toMatchObject({
    error: "Vision parser request failed with status 503",
    parser_provider: "llm_vision",
    parser_result: null,
    status: "error",
  });
  expect(failedJob?.upload_request_id).not.toBeNull();
  const cachedFailedJobs = await page.evaluate(() => JSON.parse(
    localStorage.getItem("poker-training-processing-v1") ?? "[]",
  ) as Array<{
    id: string;
    original_filename: string;
    parser_provider: string;
    status: string;
  }>);
  const cachedFailedJob = cachedFailedJobs.find(
    (candidate) => candidate.original_filename === filename,
  );
  expect(cachedFailedJob).toMatchObject({
    id: failedJob?.id,
    parser_provider: "llm_vision",
    status: "error",
  });

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Poker Training Analyzer" }),
  ).toBeVisible();
  await expect(matchingQueueItems).toHaveCount(1);
  await expect(matchingQueueItems).toContainText(
    "Vision parser request failed with status 503",
  );
  await page
    .getByRole("group", { name: "Input mode" })
    .getByRole("button", { name: "Upload" })
    .click();

  await page.getByLabel("Choose screenshots").setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: VALID_PNG,
  });
  await page.getByRole("button", { name: "Upload and parse" }).click();

  await expect(matchingQueueItems).toHaveCount(2);
  const failedQueueItem = matchingQueueItems.filter({ hasText: "error" });
  const recoveredQueueItem = matchingQueueItems.filter({
    hasText: "recommended",
  });
  await expect(failedQueueItem).toContainText(
    "Vision parser request failed with status 503",
  );
  await expect(recoveredQueueItem).toContainText("recommended");
  await expect(
    page.getByRole("region", { name: "Recommendation" }),
  ).toBeVisible();

  const recoveredJobsResponse = await page.request.get(
    `${BACKEND_URL}/api/jobs`,
  );
  expect(recoveredJobsResponse.ok()).toBe(true);
  const recoveredJobs = await recoveredJobsResponse.json() as {
    jobs: Array<{
      original_filename: string;
      parser_result: { raw: Record<string, string> } | null;
      recommendation: { raw: Record<string, string> } | null;
      status: string;
    }>;
  };
  const matchingPersistedJobs = recoveredJobs.jobs.filter(
    (candidate) => candidate.original_filename === filename,
  );
  expect(matchingPersistedJobs).toHaveLength(2);
  expect(matchingPersistedJobs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      parser_result: null,
      status: "error",
    }),
    expect.objectContaining({
      parser_result: expect.objectContaining({
        raw: expect.objectContaining({
          engine: "e2e_provider_stub",
          provider: "llm_vision",
        }),
      }),
      recommendation: expect.objectContaining({
        raw: expect.objectContaining({ engine: "e2e_provider_stub" }),
      }),
      status: "recommended",
    }),
  ]));

  await page.getByRole("button", { name: "Clear reviewed" }).click();
  await expect(matchingQueueItems).toHaveCount(1);
  await expect(matchingQueueItems).toContainText("error");
});
