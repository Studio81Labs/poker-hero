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
const MAX_BACKEND_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function proxyApiRequest(request, backendUrl, proxySharedSecret) {
  if (!backendUrl) {
    return new Response("BACKEND_URL is not configured", { status: 500 });
  }

  const incomingUrl = new URL(request.url);
  const backendBase = new URL(backendUrl);
  if (proxySharedSecret && backendBase.protocol !== "https:") {
    return new Response(
      "BACKEND_URL must use HTTPS when API_PROXY_SECRET is configured",
      { status: 500 },
    );
  }

  let targetUrl = new URL(backendBase);
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

  let method = request.method;
  let body =
    method !== "GET" && method !== "HEAD"
      ? await request.arrayBuffer()
      : undefined;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const init = {
      method,
      headers,
      // Inspect redirects so the private header never crosses backend origins.
      redirect: "manual",
      signal: request.signal,
    };

    if (body !== undefined) {
      init.body = body;
    }

    const response = await fetch(new Request(targetUrl, init));
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }

    if (redirectCount >= MAX_BACKEND_REDIRECTS) {
      await response.body?.cancel();
      return new Response("Backend redirect limit exceeded", { status: 502 });
    }

    let redirectUrl;
    try {
      redirectUrl = new URL(location, targetUrl);
    } catch {
      await response.body?.cancel();
      return new Response("Backend redirect target is invalid", { status: 502 });
    }

    if (
      redirectUrl.origin !== backendBase.origin ||
      redirectUrl.username ||
      redirectUrl.password ||
      (basePath &&
        redirectUrl.pathname !== basePath &&
        !redirectUrl.pathname.startsWith(`${basePath}/`))
    ) {
      await response.body?.cancel();
      return new Response("Backend redirect target is not allowed", {
        status: 502,
      });
    }

    await response.body?.cancel();
    if (
      (response.status === 303 && method !== "GET" && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
    }

    targetUrl = redirectUrl;
  }
}
