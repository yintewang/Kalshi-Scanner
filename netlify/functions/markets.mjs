// Netlify serverless function — fetches live Kalshi market data.
// The markets endpoint is PUBLIC (no auth required).
// Also fetches crypto spot prices for basic fair value estimates.

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    let body = {};
    try { body = await request.json(); } catch {}

    const category = body.category || "all";
    const minVolume = body.minVolume || 500;

    // Fetch open markets from Kalshi (public, no auth)
    const marketsUrl = KALSHI_BASE + "/markets?status=open&limit=200";
    const marketsRes = await fetch(marketsUrl, {
      headers: { "Accept": "application/json" },
    });

    if (!marketsRes.ok) {
      return jsonResponse(marketsRes.status, {
        error: "Kalshi markets API returned " + marketsRes.status,
      });
    }

    const marketsData = await marketsRes.json();
    let markets = marketsData.markets || [];

    // Filter for markets with volume and valid pricing
    markets = markets.filter(m =>
      m.status === "open" &&
      (m.volume || 0) >= minVolume &&
      m.yes_bid > 0 &&
      m.yes_ask > 0
    );

    // Categorize markets based on title/ticker keywords
    const categorized = markets.map(m => {
      const title = (m.title || "").toLowerCase();
      const ticker = (m.ticker || "").toLowerCase();
      const seriesTicker = (m.event_ticker || m.ticker || "").toUpperCase();

      let cat = "other";
      if (matchesCategory(title, ticker, "crypto")) cat = "crypto";
      else if (matchesCategory(title, ticker, "economics")) cat = "economics";
      else if (matchesCategory(title, ticker, "politics")) cat = "politics";

      // Compute mid price (midpoint of bid/ask)
      const midPrice = Math.round((m.yes_bid + m.yes_ask) / 2);

      return {
        ticker: m.ticker,
        eventTicker: m.event_ticker,
        seriesTicker: seriesTicker,
        title: m.title,
        subtitle: m.subtitle || "",
        category: cat,
        marketPrice: midPrice,
        yesBid: m.yes_bid,
        yesAsk: m.yes_ask,
        noBid: m.no_bid,
        noAsk: m.no_ask,
        lastPrice: m.last_price,
        volume: m.volume || 0,
        volume24h: m.volume_24h || 0,
        openInterest: m.open_interest || 0,
        expiry: m.close_time || m.expiration_time || null,
        kalshiUrl: "https://kalshi.com/markets/" + (m.ticker || "").toLowerCase(),
      };
    });

    // Filter by category if specified
    let filtered = categorized;
    if (category !== "all") {
      filtered = categorized.filter(m => m.category === category);
    }

    // Sort by volume descending
    filtered.sort((a, b) => b.volume - a.volume);

    // Cap at 50 markets
    filtered = filtered.slice(0, 50);

    // Fetch crypto spot prices for fair value on crypto markets
    let cryptoPrices = {};
    const hasCrypto = filtered.some(m => m.category === "crypto");
    if (hasCrypto) {
      try {
        const cgRes = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd",
          { headers: { "Accept": "application/json" } }
        );
        if (cgRes.ok) {
          cryptoPrices = await cgRes.json();
        }
      } catch {}
    }

    // Compute basic fair value estimates
    const enriched = filtered.map(m => {
      let fairValue = null;
      let fairSource = null;

      if (m.category === "crypto") {
        const fv = estimateCryptoFairValue(m, cryptoPrices);
        if (fv !== null) {
          fairValue = fv;
          fairSource = "spot-price";
        }
      }

      // If no model-based fair value, use a spread-based heuristic:
      // Markets with wide bid-ask spreads are more likely mispriced.
      // We use the last trade price as a proxy for "where smart money thinks it is"
      if (fairValue === null && m.lastPrice > 0) {
        // If last price differs significantly from mid, that's a signal
        const mid = m.marketPrice;
        const last = m.lastPrice;
        if (Math.abs(last - mid) >= 3) {
          fairValue = last;
          fairSource = "last-trade";
        }
      }

      const edge = fairValue !== null ? fairValue - m.marketPrice : null;

      return {
        ...m,
        fairValue,
        fairSource,
        edge,
      };
    });

    return jsonResponse(200, {
      markets: enriched,
      cryptoPrices,
      totalFetched: markets.length,
      totalReturned: enriched.length,
    });
  } catch (err) {
    return jsonResponse(502, { error: "Markets fetch error: " + err.message });
  }
};

// ── Category matching ──
function matchesCategory(title, ticker, category) {
  const keywords = {
    crypto: ["bitcoin", "btc", "ethereum", "eth", "solana", "sol", "crypto", "dogecoin", "doge", "xrp", "ripple"],
    economics: ["fed", "fomc", "cpi", "inflation", "gdp", "unemployment", "jobs", "nonfarm", "payroll", "interest rate", "treasury", "recession", "rate cut", "rate hike", "consumer price", "pce", "initial claims"],
    politics: ["president", "congress", "senate", "house", "election", "trump", "biden", "democrat", "republican", "governor", "executive order", "approval rating", "supreme court", "legislation", "bill pass", "veto", "impeach"],
  };
  const kws = keywords[category] || [];
  return kws.some(kw => title.includes(kw) || ticker.includes(kw));
}

// ── Crypto fair value from spot price ──
function estimateCryptoFairValue(market, cryptoPrices) {
  const title = (market.title || "").toLowerCase();

  // Try to extract threshold and asset from title
  // e.g., "Bitcoin above $90,000 on March 31?"
  let asset = null;
  let threshold = null;
  let isAbove = title.includes("above") || title.includes("higher") || title.includes("over");
  let isBelow = title.includes("below") || title.includes("under") || title.includes("lower");

  if (title.includes("bitcoin") || title.includes("btc")) asset = "bitcoin";
  else if (title.includes("ethereum") || title.includes("eth")) asset = "ethereum";
  else if (title.includes("solana") || title.includes("sol")) asset = "solana";

  // Extract dollar amount from title
  const priceMatch = title.match(/\$([0-9,]+)/);
  if (priceMatch) {
    threshold = parseFloat(priceMatch[1].replace(/,/g, ""));
  }

  if (!asset || !threshold || !cryptoPrices[asset]) return null;

  const spotPrice = cryptoPrices[asset].usd;
  if (!spotPrice) return null;

  // Simple distance-based probability estimate
  // The closer spot is to the threshold, the closer to 50%
  // The further above, the higher the YES probability (for "above" markets)
  const pctDiff = (spotPrice - threshold) / threshold;

  let probability;
  if (isAbove) {
    // Spot is above threshold → higher YES probability
    // Use a sigmoid-like curve based on % distance
    probability = sigmoid(pctDiff * 10); // scale factor for sensitivity
  } else if (isBelow) {
    probability = sigmoid(-pctDiff * 10);
  } else {
    return null; // can't determine direction
  }

  return Math.round(Math.max(3, Math.min(97, probability * 100)));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
