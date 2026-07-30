import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "./worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API Worker proxy", () => {
  it("replaces an incoming proxy credential with the Worker secret", async () => {
    let forwardedRequest;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request) => {
        forwardedRequest = request;
        return new Response(null, { status: 200 });
      }),
    );

    const response = await worker.fetch(
      new Request("https://poker.example/api/jobs", {
        headers: { "X-Poker-Proxy-Secret": "spoofed-browser-value" },
      }),
      {
        ASSETS: { fetch: vi.fn() },
        API_PROXY_SECRET: "trusted-worker-value",
        BACKEND_URL: "https://backend.example",
      },
    );

    expect(response.status).toBe(200);
    expect(forwardedRequest.headers.get("X-Poker-Proxy-Secret")).toBe(
      "trusted-worker-value",
    );
    expect(forwardedRequest.redirect).toBe("manual");
  });

  it("strips browser-supplied proxy credentials when no Worker secret is configured", async () => {
    let forwardedRequest;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request) => {
        forwardedRequest = request;
        return new Response(null, { status: 200 });
      }),
    );

    await worker.fetch(
      new Request("https://poker.example/api/jobs", {
        headers: { "X-Poker-Proxy-Secret": "spoofed-browser-value" },
      }),
      {
        ASSETS: { fetch: vi.fn() },
        BACKEND_URL: "https://backend.example",
      },
    );

    expect(forwardedRequest.headers.has("X-Poker-Proxy-Secret")).toBe(false);
  });

  it("requires an HTTPS backend before attaching the Worker secret", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://poker.example/api/jobs"),
      {
        ASSETS: { fetch: vi.fn() },
        API_PROXY_SECRET: "trusted-worker-value",
        BACKEND_URL: "http://backend.example",
      },
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("must use HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows same-origin backend redirects without exposing them to the browser", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { Location: "https://backend.example/api/jobs" },
          status: 307,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobs: [] }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://poker.example/api/jobs/"),
      {
        ASSETS: { fetch: vi.fn() },
        API_PROXY_SECRET: "trusted-worker-value",
        BACKEND_URL: "https://backend.example",
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const redirectedRequest = fetchMock.mock.calls[1][0];
    expect(redirectedRequest.url).toBe("https://backend.example/api/jobs");
    expect(redirectedRequest.headers.get("X-Poker-Proxy-Secret")).toBe(
      "trusted-worker-value",
    );
  });

  it("blocks cross-origin backend redirects", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        headers: { Location: "https://other.example/collect" },
        status: 302,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://poker.example/api/jobs"),
      {
        ASSETS: { fetch: vi.fn() },
        API_PROXY_SECRET: "trusted-worker-value",
        BACKEND_URL: "https://backend.example",
      },
    );

    expect(response.status).toBe(502);
    expect(response.headers.has("location")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks redirects outside a configured backend base path", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        headers: { Location: "/admin" },
        status: 307,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://poker.example/api/jobs"),
      {
        ASSETS: { fetch: vi.fn() },
        API_PROXY_SECRET: "trusted-worker-value",
        BACKEND_URL: "https://backend.example/api",
      },
    );

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("applies fetch method rewriting to followed 303 redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { Location: "/api/jobs/result" },
          status: 303,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://poker.example/api/jobs", {
        body: "upload",
        headers: { "Content-Type": "text/plain" },
        method: "POST",
      }),
      {
        ASSETS: { fetch: vi.fn() },
        API_PROXY_SECRET: "trusted-worker-value",
        BACKEND_URL: "https://backend.example",
      },
    );

    expect(response.status).toBe(204);
    const redirectedRequest = fetchMock.mock.calls[1][0];
    expect(redirectedRequest.method).toBe("GET");
    expect(redirectedRequest.headers.has("content-type")).toBe(false);
    await expect(redirectedRequest.text()).resolves.toBe("");
  });

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
