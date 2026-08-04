import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { checkDeployment } from "./check-deployment.mjs";

async function withServer(handler, exercise) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      response.writeHead(500).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  try {
    await exercise(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("checks the frontend, health route, and protected proxy", async () => {
  const requestedPaths = [];
  await withServer((request, response) => {
    requestedPaths.push(request.url);
    assert.equal(request.headers["cf-access-client-id"], "client-id");
    assert.equal(request.headers["cf-access-client-secret"], "client-secret");
    if (request.url === "/") {
      response.writeHead(302, { Location: "/app" }).end();
      return;
    }
    if (request.url === "/app") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<title>Poker Training Analyzer</title>");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      request.url === "/api/health"
        ? JSON.stringify({ status: "ok" })
        : JSON.stringify({ jobs: [], total: 0 }),
    );
  }, async (baseUrl) => {
    const result = await checkDeployment(baseUrl, {
      accessClientId: "client-id",
      accessClientSecret: "client-secret",
      allowHttp: true,
      attempts: 1,
      timeoutMs: 1_000,
    });
    assert.equal(result.attempts, 1);
    assert.equal(result.url, baseUrl);
  });
  assert.deepEqual(requestedPaths, [
    "/",
    "/app",
    "/api/health",
    "/api/jobs?limit=1",
  ]);
});

test("retries transient failures and reports only the failed check", async () => {
  let healthRequests = 0;
  await withServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200).end("Poker Training Analyzer");
      return;
    }
    if (request.url === "/api/health") {
      healthRequests += 1;
      response.writeHead(503).end("provider details must stay private");
      return;
    }
    response.writeHead(200).end(JSON.stringify({ jobs: [] }));
  }, async (baseUrl) => {
    await assert.rejects(
      checkDeployment(baseUrl, {
        allowHttp: true,
        attempts: 2,
        retryDelayMs: 0,
        timeoutMs: 1_000,
      }),
      /failed after 2 attempt\(s\): API health returned HTTP 503/,
    );
  });
  assert.equal(healthRequests, 2);
});

test("requires both Cloudflare Access service-token values", async () => {
  await assert.rejects(
    checkDeployment("https://poker.example.com", {
      accessClientId: "client-id",
      attempts: 1,
    }),
    /client ID and secret must be configured together/,
  );
});

test("does not forward Access credentials across redirects", async () => {
  let redirectedRequests = 0;
  await withServer((request, response) => {
    redirectedRequests += 1;
    response.writeHead(200).end("Poker Training Analyzer");
  }, async (redirectTarget) => {
    await withServer((_request, response) => {
      response.writeHead(302, { Location: redirectTarget }).end();
    }, async (baseUrl) => {
      await assert.rejects(
        checkDeployment(baseUrl, {
          accessClientId: "client-id",
          accessClientSecret: "client-secret",
          allowHttp: true,
          attempts: 1,
          timeoutMs: 1_000,
        }),
        /Frontend redirected outside the deployment origin/,
      );
    });
  });
  assert.equal(redirectedRequests, 0);
});

test("rejects oversized deployment responses", async () => {
  await withServer((_request, response) => {
    response.writeHead(200).end("x".repeat((1024 * 1024) + 1));
  }, async (baseUrl) => {
    await assert.rejects(
      checkDeployment(baseUrl, {
        allowHttp: true,
        attempts: 1,
        timeoutMs: 1_000,
      }),
      /Frontend response exceeded 1 MiB/,
    );
  });
});

test("rejects insecure production targets", async () => {
  await assert.rejects(
    checkDeployment("http://poker.example.com", { attempts: 1 }),
    /must use HTTPS/,
  );
});
