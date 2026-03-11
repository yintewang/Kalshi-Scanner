// Netlify serverless function — proxies requests to the Kalshi trading API.
// Runs server-side so there are no CORS restrictions.

const KALSHI_BASE = "https://trading-api.kalshi.com/trade-api/v2";

export default async (request) => {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  try {
    const url = new URL(request.url);
    // The client sends the Kalshi path as a query param: ?path=/portfolio/balance
    const kalshiPath = url.searchParams.get("path");
    if (!kalshiPath) {
      return jsonResponse(400, { error: "Missing ?path= parameter" });
    }

    // Forward the Authorization header from the client
    const authHeader = request.headers.get("Authorization") || "";

    // Build the real Kalshi URL
    const kalshiUrl = KALSHI_BASE + kalshiPath;

    const kalshiRes = await fetch(kalshiUrl, {
      method: request.method === "POST" ? "POST" : "GET",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      // Forward body for POST requests
      ...(request.method === "POST" && { body: await request.text() }),
    });

    const data = await kalshiRes.text();

    return new Response(data, {
      status: kalshiRes.status,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    return jsonResponse(502, { error: "Proxy error: " + err.message });
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
