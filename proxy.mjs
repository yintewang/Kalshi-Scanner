// Netlify serverless function — proxies requests to the Kalshi trading API
// with RSA-PSS signature authentication (Kalshi API v2 requirement).
//
// The client POSTs a JSON body with:
//   { "path": "/portfolio/balance", "keyId": "...", "privateKey": "..." }
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
    // Parse the JSON body from the client
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "Invalid JSON body" });
    }

    const { path: kalshiPath, keyId, privateKey } = body;

    if (!kalshiPath) {
      return jsonResponse(400, { error: "Missing 'path' in request body" });
    }
    if (!keyId || !privateKey) {
      return jsonResponse(401, { error: "Missing 'keyId' or 'privateKey' in request body" });
    }

    // Normalize the PEM key — ensure proper line breaks
    let pem = privateKey.trim();
    // If newlines got stripped, try to reconstruct
    if (pem.includes("-----") && !pem.includes("\n")) {
      pem = pem
        .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/, "-----BEGIN $1PRIVATE KEY-----\n")
        .replace(/-----END (RSA )?PRIVATE KEY-----/, "\n-----END $1PRIVATE KEY-----")
        .replace(/(.{64})(?!-)/g, "$1\n");
    }

    // Determine the HTTP method for the Kalshi call
    const method = body.method === "POST" ? "POST" : "GET";

    // Build signature: timestamp_ms + METHOD + path (without query params)
    const timestampMs = Date.now().toString();
    const fullPath = "/trade-api/v2" + kalshiPath;
    const pathWithoutQuery = fullPath.split("?")[0];
    const message = timestampMs + method + pathWithoutQuery;

    // RSA-PSS sign
    let signature;
    try {
      const sign = crypto.createSign("RSA-SHA256");
      sign.update(message);
      sign.end();
      signature = sign.sign(
        {
          key: pem,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        },
        "base64"
      );
    } catch (signErr) {
      return jsonResponse(401, {
        error: "RSA signing failed — check that your private key is valid.",
        detail: signErr.message,
        hint: "Make sure you pasted the full key including -----BEGIN and -----END lines.",
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
      ...(method === "POST" && body.payload && { body: JSON.stringify(body.payload) }),
    });

    const data = await kalshiRes.text();

    // If Kalshi returns an error, include debug info
    if (!kalshiRes.ok) {
      return new Response(
        JSON.stringify({
          error: "Kalshi API returned " + kalshiRes.status,
          kalshiResponse: tryParseJSON(data),
          debug: {
            signedMessage: timestampMs + " + " + method + " + " + pathWithoutQuery,
            keyIdUsed: keyId.substring(0, 8) + "…",
            pemStartsWith: pem.substring(0, 40) + "…",
          },
        }),
        {
          status: kalshiRes.status,
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        }
      );
    }

    return new Response(data, {
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  } catch (err) {
    return jsonResponse(502, { error: "Proxy error: " + err.message });
  }
};

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return str; }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
