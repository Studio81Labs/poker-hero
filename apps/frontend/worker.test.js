import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "./worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API Worker proxy", () => {
  it("forwards a multipart screenshot as the file field", async () => {
    let forwardedRequest;
    const backendResponse = new Response(JSON.stringify({ status: "parsed" }), {
      headers: { "Content-Type": "application/json" },
      status: 201,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request) => {
        forwardedRequest = request;
        return backendResponse;
      }),
    );

    const boundary = "----poker-hero-test-boundary";
    const multipartBody = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="table.png"',
      "Content-Type: image/png",
      "",
      "png-bytes",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const request = new Request("https://poker.example/api/jobs?source=upload", {
      body: multipartBody,
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      method: "POST",
    });

    const response = await worker.fetch(request, {
      ASSETS: { fetch: vi.fn() },
      BACKEND_URL: "https://backend.example/api",
    });

    expect(response.status).toBe(201);
    expect(forwardedRequest.url).toBe("https://backend.example/api/jobs?source=upload");
    expect(forwardedRequest.headers.get("content-type")).toContain("multipart/form-data; boundary=");

    const forwardedBody = await forwardedRequest.text();
    expect(forwardedBody).toContain('name="file"; filename="table.png"');
    expect(forwardedBody).toContain("Content-Type: image/png");
    expect(forwardedBody).toContain("png-bytes");
    expect(forwardedBody).toContain(`--${boundary}--`);
  });
});
