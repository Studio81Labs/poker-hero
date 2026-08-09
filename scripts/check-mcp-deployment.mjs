import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RATE_LIMIT_WAIT_MS = 65_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MCP_TOKEN_PATTERN = /^phmcp_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/;

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function exactHttpsUrl(value, path, label, allowHttp) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  if (
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== path ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be an exact public HTTPS ${path} URL`);
  }
  return url;
}

function expectedEnvironment(value) {
  if (value !== "staging" && value !== "production") {
    throw new Error("Expected MCP environment must be staging or production");
  }
  return value;
}

function accessHeaders(accessClientId, accessClientSecret) {
  const hasClientId = Boolean(accessClientId);
  const hasClientSecret = Boolean(accessClientSecret);
  if (hasClientId !== hasClientSecret) {
    throw new Error(
      "Cloudflare Access client ID and secret must be configured together",
    );
  }
  if (!hasClientId) {
    return {};
  }
  return {
    "CF-Access-Client-Id": accessClientId,
    "CF-Access-Client-Secret": accessClientSecret,
  };
}

async function readBoundedBody(response, label) {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`${label} response exceeded 1 MiB`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function parseJson(body, label) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function parseMcpResponse(body, label) {
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line && line !== "[DONE]");
  if (dataLines.length === 0) {
    return parseJson(body, label);
  }
  for (const line of dataLines) {
    try {
      return JSON.parse(line);
    } catch {
      // Keep looking for the first complete MCP message.
    }
  }
  throw new Error(`${label} returned invalid MCP event data`);
}

async function fetchConfiguration(url, headers, timeoutMs) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "poker-hero-mcp-deployment-check/1.0",
        ...headers,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`MCP configuration timed out after ${timeoutMs} ms`);
    }
    throw new Error("MCP configuration request failed");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`MCP configuration returned HTTP ${response.status}`);
  }
  return parseJson(
    await readBoundedBody(response, "MCP configuration"),
    "MCP configuration",
  );
}

async function postMcp(url, token, payload, headers, timeoutMs, label) {
  let response;
  try {
    response = await fetch(url, {
      body: JSON.stringify(payload),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "poker-hero-mcp-deployment-check/1.0",
        ...headers,
      },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs} ms`);
    }
    throw new Error(`${label} request failed`);
  }
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    await response.body?.cancel();
    const error = new Error(`${label} returned HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfterMs = /^\d+$/.test(retryAfter ?? "")
      ? Number(retryAfter) * 1_000
      : null;
    throw error;
  }
  return parseMcpResponse(await readBoundedBody(response, label), label);
}

async function postEnvironmentStatus(mcpUrl, token, headers, timeoutMs, wait) {
  const request = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "get_environment_status",
      arguments: {},
    },
  };
  const label = "Authenticated MCP environment check";
  try {
    return await postMcp(mcpUrl, token, request, headers, timeoutMs, label);
  } catch (error) {
    if (
      error?.status !== 429 ||
      !Number.isSafeInteger(error.retryAfterMs) ||
      error.retryAfterMs <= 0 ||
      error.retryAfterMs > MAX_RATE_LIMIT_WAIT_MS
    ) {
      throw error;
    }
    await wait(error.retryAfterMs);
    return postMcp(mcpUrl, token, request, headers, timeoutMs, label);
  }
}

async function checkOnce(
  mcpUrl,
  configUrl,
  environment,
  token,
  headers,
  timeoutMs,
  wait,
) {
  const configuration = await fetchConfiguration(configUrl, headers, timeoutMs);
  if (
    configuration?.enabled !== true ||
    configuration?.endpoint !== mcpUrl.href ||
    configuration?.environment !== environment
  ) {
    throw new Error(
      "MCP configuration did not report the expected enabled endpoint and environment",
    );
  }

  const initialized = await postMcp(
    mcpUrl,
    token,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "poker-hero-deployment-check",
          version: "1.0",
        },
      },
    },
    headers,
    timeoutMs,
    "Authenticated MCP initialization",
  );
  if (
    initialized?.jsonrpc !== "2.0" ||
    initialized?.error ||
    !initialized?.result?.serverInfo?.name
  ) {
    throw new Error("Authenticated MCP initialization was not successful");
  }

  const status = await postEnvironmentStatus(
    mcpUrl,
    token,
    headers,
    timeoutMs,
    wait,
  );
  if (
    status?.error ||
    status?.result?.isError === true ||
    status?.result?.structuredContent?.environment !== environment
  ) {
    throw new Error(
      "Authenticated MCP environment check did not report the expected environment",
    );
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function checkMcpDeployment(rawUrl, environment, options = {}) {
  const allowHttp = options.allowHttp === true;
  const mcpUrl = exactHttpsUrl(rawUrl, "/mcp", "MCP smoke URL", allowHttp);
  const configUrl = exactHttpsUrl(
    options.configUrl,
    "/api/mcp/config",
    "MCP configuration URL",
    allowHttp,
  );
  const normalizedEnvironment = expectedEnvironment(environment);
  const token = options.token ?? "";
  if (!MCP_TOKEN_PATTERN.test(token)) {
    throw new Error("MCP smoke token is not a Poker Hero agent credential");
  }
  const headers = accessHeaders(
    options.accessClientId ?? "",
    options.accessClientSecret ?? "",
  );
  const attempts = positiveInteger(
    options.attempts ?? DEFAULT_ATTEMPTS,
    "Attempts",
  );
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "Timeout",
  );
  const retryDelayMs = Number(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("Retry delay must be a non-negative integer");
  }
  const wait = options.wait ?? delay;
  if (typeof wait !== "function") {
    throw new Error("Wait must be a function");
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await checkOnce(
        mcpUrl,
        configUrl,
        normalizedEnvironment,
        token,
        headers,
        timeoutMs,
        wait,
      );
      return {
        attempts: attempt,
        environment: normalizedEnvironment,
        url: mcpUrl.href,
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts && retryDelayMs > 0) {
        await delay(retryDelayMs);
      }
    }
  }
  throw new Error(
    `Authenticated MCP check failed after ${attempts} attempt(s): ${lastError.message}`,
  );
}

async function main() {
  const [url, environment] = process.argv.slice(2);
  if (!url || !environment) {
    throw new Error(
      "Usage: node scripts/check-mcp-deployment.mjs <mcp-url> <environment>",
    );
  }
  const result = await checkMcpDeployment(url, environment, {
    accessClientId: process.env.CLOUDFLARE_ACCESS_CLIENT_ID,
    accessClientSecret: process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET,
    configUrl: process.env.MCP_CONFIG_URL,
    token: process.env.MCP_SMOKE_TOKEN,
  });
  process.stdout.write(
    `Authenticated MCP healthy after ${result.attempts} attempt(s): ${result.url} (${result.environment})\n`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`Authenticated MCP unhealthy: ${error.message}\n`);
    process.exitCode = 1;
  });
}
