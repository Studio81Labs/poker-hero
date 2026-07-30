export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return proxyApiRequest(request, env.BACKEND_URL, env.API_PROXY_SECRET);
    }

    return env.ASSETS.fetch(request);
  },
};

const PROXY_SHARED_SECRET_HEADER = "X-Poker-Proxy-Secret";

async function proxyApiRequest(request, backendUrl, proxySharedSecret) {
  if (!backendUrl) {
    return new Response("BACKEND_URL is not configured", { status: 500 });
  }

  const incomingUrl = new URL(request.url);
  const backendBase = new URL(backendUrl);
  const targetUrl = new URL(backendBase);
  const basePath = backendBase.pathname.replace(/\/+$/, "");
  let proxiedPath = incomingUrl.pathname;

  if (basePath.endsWith("/api") && proxiedPath.startsWith("/api/")) {
    proxiedPath = proxiedPath.slice("/api".length);
  }

  targetUrl.pathname = `${basePath}${proxiedPath}`;
  targetUrl.search = incomingUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete(PROXY_SHARED_SECRET_HEADER);
  if (proxySharedSecret) {
    headers.set(PROXY_SHARED_SECRET_HEADER, proxySharedSecret);
  }

  const init = {
    method: request.method,
    headers,
    // Do not let a backend redirect carry the private proxy header to another origin.
    redirect: "manual",
    signal: request.signal,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  return fetch(new Request(targetUrl, init));
}
