export interface Env {
  CACHE_TTL?: string; // Cache time-to-live in seconds
  ROOT_REDIRECT_URL?: string; // URL to redirect root path to
  FETCH_TIMEOUT_MS?: string; // Yahoo Finance API fetch timeout in milliseconds
}

async function getYahooQuote(
  symbol: string,
  fetchTimeoutMs: number,
): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
    signal: AbortSignal.timeout(fetchTimeoutMs),
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Yahoo Finance API error: ${response.status}`);
  }

  const data = (await response.json()) as any;
  const result = data?.chart?.result?.[0];
  const price = result?.meta?.regularMarketPrice;

  return price ?? null;
}

async function tryRewriteExchangeSymbol(
  symbol: string,
  url: URL,
  fetchTimeoutMs: number,
): Promise<Response | null> {
  let candidate: string | null = null;

  if (symbol.includes(":")) {
    const [prefix, base] = symbol.split(":");
    if (prefix.toUpperCase() === "BIT" && base) candidate = `${base}.MI`;
    else return null;
  } else if (symbol.toUpperCase().endsWith(".FR")) {
    candidate = `${symbol.slice(0, -3)}.PA`;
  }

  if (!candidate) return null;

  if ((await getYahooQuote(candidate, fetchTimeoutMs)) !== null) {
    return Response.redirect(
      `${url.origin}/api/quotes/${encodeURIComponent(candidate)}`,
      301,
    );
  }
  return null;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // --- 複数銘柄対応: /api/quotes?tickers=1655.T,9984.T ---
    if (url.pathname === "/api/quotes" && url.searchParams.has("tickers")) {
      const fetchTimeoutMs = parseInt(env.FETCH_TIMEOUT_MS || "5000", 10);
      const tickers = url.searchParams.get("tickers")!.split(",");

      const results = await Promise.all(
        tickers.map(async (symbol) => {
          try {
            const price = await getYahooQuote(symbol, fetchTimeoutMs);
            return `${symbol},${price}`;
          } catch (e) {
            return `${symbol},ERROR`;
          }
        })
      );

      return new Response(results.join("\n"), {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // --- 単一銘柄対応（既存のロジック） ---
    const match = url.pathname.match(/^\/api\/quotes\/([^/]+)$/);
    if (match && request.method === "GET") {
      const symbol = match[1];
      const fetchTimeoutMs = parseInt(env.FETCH_TIMEOUT_MS || "5000", 10);

      const rewriteRedirect = await tryRewriteExchangeSymbol(
        symbol,
        url,
        fetchTimeoutMs,
      );
      if (rewriteRedirect) return rewriteRedirect;

      const cacheTTL = parseInt(env.CACHE_TTL || "300", 10);

      const cacheKey = new Request(`${url.origin}${url.pathname}`, request);
      const cache = caches.default;

      let response = await cache.match(cacheKey);
      if (response) {
        return response;
      }

      try {
        const price = await getYahooQuote(symbol, fetchTimeoutMs);

        if (price === null) {
          return new Response("Price not available", {
            status: 404,
            headers: { "Content-Type": "text/plain" },
          });
        }

        response = new Response(price.toString(), {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
            "Cache-Control": `public, max-age=${cacheTTL}`,
          },
        });

        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (error) {
        return new Response(
          `Error fetching quote: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
          {
            status: 500,
            headers: { "Content-Type": "text/plain" },
          },
        );
      }
    }

    if (
      url.pathname === "/" &&
      request.method === "GET" &&
      env.ROOT_REDIRECT_URL &&
      isValidUrl(env.ROOT_REDIRECT_URL)
    ) {
      return Response.redirect(env.ROOT_REDIRECT_URL, 301);
    }

    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  },
};

function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
