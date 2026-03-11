// Netlify serverless function — proxies requests to the Kalshi trading API
// with RSA-PSS signature authentication (Kalshi API v2 requirement).
//
// The client sends:
//   ?path=/portfolio/balance   — the Kalshi API path
//   Header: X-Kalshi-Key-Id    — your Kalshi Key ID
//   Header: X-Kalshi-Private-Key — your RSA private key (PEM, base64-url-encoded)
//
// This function signs each request server-side using Node's built-in crypto.

import crypto from "crypto";

const KALSHI_BASE = "https://trading-api.kalshi.com/trade-api/v2";

export default async (request) => {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    const url = new URL(request.url);
    const kalshiPath = url.searchParams.get("path");
    if (!kalshiPath) {
      return jsonResponse(400, { error: "Missing ?path= parameter" });
    }

    const keyId = request.headers.get("X-Kalshi-Key-Id") || "";
    const encodedPem = request.headers.get("X-Kalshi-Private-Key") || "";

    if (!keyId || !encodedPem) {
      return jsonResponse(401, {
        error: "Missing X-Kalshi-Key-Id or X-Kalshi-Private-Key headers",
      });
    }

    // Decode the PEM (client base64-url-encodes it to safely pass in a header)
    let privateKeyPem;
    try {
      privateKeyPem = decodeURIComponent(encodedPem);
    } catch {
      privateKeyPem = encodedPem;
    }

    // Build signature: timestamp_ms + METHOD + path (without query params)
    const method = request.method === "POST" ? "POST" : "GET";
    const timestampMs = Date.now().toString();
    const pathWithoutQuery = ("/trade-api/v2" + kalshiPath).split("?")[0];
    const message = timestampMs + method + pathWithoutQuery;

    // RSA-PSS sign
    let signature;
    try {
      const sign = crypto.createSign("RSA-SHA256");
      sign.update(message);
      sign.end();
      signature = sign.sign(
        {
          key: privateKeyPem,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        },
        "base64"
      );
    } catch (signErr) {
      return jsonResponse(401, {
        error: "RSA signing failed. Check that your private key is valid PEM format.",
        detail: signErr.message,
      });
    }

    // Call Kalshi
    const kalshiUrl = KALSHI_BASE + kalshiPath;
    const kalshiRes = await fetch(kalshiUrl, {
      method,
      headers: {
        "KALSHI-ACCESS-KEY": keyId,
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestampMs,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      ...(method === "POST" && { body: await request.text() }),
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
    "Access-Control-Allow-Headers":
      "Content-Type, X-Kalshi-Key-Id, X-Kalshi-Private-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
