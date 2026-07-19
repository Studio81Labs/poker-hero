export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return proxyApiRequest(request, env.BACKEND_URL);
    }

    return env.ASSETS.fetch(request);
  },
};

async function proxyApiRequest(request, backendUrl) {
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

  const init = {
    method: request.method,
    headers,
    redirect: request.redirect,
    signal: request.signal,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  return fetch(new Request(targetUrl, init));
}
