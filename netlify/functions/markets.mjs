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
    // Valid status values: unopened, open, paused, closed, settled
    let allMarkets = [];
    let cursor = "";
    const maxPages = 5;

    for (let page = 0; page < maxPages; page++) {
      let marketsUrl = KALSHI_BASE + "/markets?limit=1000&status=open";
      if (cursor) marketsUrl += "&cursor=" + encodeURIComponent(cursor);

      const marketsRes = await fetch(marketsUrl, {
        headers: { "Accept": "application/json" },
      });

      if (!marketsRes.ok) {
        if (page === 0) {
          return jsonResponse(marketsRes.status, {
            error: "Kalshi markets API returned " + marketsRes.status,
          });
        }
        break;
      }

      const marketsData = await marketsRes.json();
      const pageMarkets = marketsData.markets || [];
      allMarkets = allMarkets.concat(pageMarkets);
      cursor = marketsData.cursor || "";
      if (!cursor || pageMarkets.length === 0) break;
    }

    let markets = allMarkets;

    // Debug: capture raw count and sample
    const rawCount = allMarkets.length;
    const rawSample = allMarkets.slice(0, 5).map(m => ({
      ticker: m.ticker,
      status: m.status,
      yes_bid_dollars: m.yes_bid_dollars,
      yes_ask_dollars: m.yes_ask_dollars,
      last_price_dollars: m.last_price_dollars,
      volume_fp: m.volume_fp,
      title: (m.title || "").substring(0, 80),
    }));

    // Helper to parse dollar strings to cents (integer)
    function dollarsToCents(val) {
      if (!val) return 0;
      return Math.round(parseFloat(val) * 100);
    }
    function dollarsToFloat(val) {
      if (!val) return 0;
      return parseFloat(val);
    }

    // Filter for open markets with some trading activity
    markets = markets.filter(m => {
      const yesBid = dollarsToCents(m.yes_bid_dollars);
      const yesAsk = dollarsToCents(m.yes_ask_dollars);
      const lastPrice = dollarsToCents(m.last_price_dollars);
      const vol = dollarsToFloat(m.volume_fp);
      const hasPrice = yesBid > 0 || yesAsk > 0 || lastPrice > 0;
      return hasPrice;
    });

    // Sort by volume descending
    markets.sort((a, b) => dollarsToFloat(b.volume_fp) - dollarsToFloat(a.volume_fp));

    // Apply minimum volume filter
    if (minVolume > 0) {
      markets = markets.filter(m => dollarsToFloat(m.volume_fp) >= minVolume);
    }

    const withPriceCount = markets.length;
    const filteredSample = markets.slice(0, 3).map(m => ({
      ticker: m.ticker,
      yes_bid_dollars: m.yes_bid_dollars,
      yes_ask_dollars: m.yes_ask_dollars,
      last_price_dollars: m.last_price_dollars,
      volume_fp: m.volume_fp,
      title: (m.title || "").substring(0, 80),
    }));

    // Filter for active markets with some trading activity
    markets = markets.filter(m => {
      const isActive = m.status === "active" || m.status === "open";
      const hasPrice = (m.yes_bid > 0 || m.yes_ask > 0 || m.last_price > 0);
      return isActive && hasPrice;
    });

    // Sort by volume descending so we get the most active markets first
    markets.sort((a, b) => (b.volume || 0) - (a.volume || 0));

    // Apply minimum volume filter after sorting
    if (minVolume > 0) {
      markets = markets.filter(m => (m.volume || 0) >= minVolume);
    }

    // Categorize markets based on title/ticker keywords
    const categorized = markets.map(m => {
      const title = (m.title || "").toLowerCase();
      const ticker = (m.ticker || "").toLowerCase();
      const seriesTicker = (m.event_ticker || m.ticker || "").toUpperCase();

      let cat = "other";
      if (matchesCategory(title, ticker, "crypto")) cat = "crypto";
      else if (matchesCategory(title, ticker, "economics")) cat = "economics";
      else if (matchesCategory(title, ticker, "politics")) cat = "politics";

      // Compute mid price in cents — use whatever pricing data is available
      const bid = dollarsToCents(m.yes_bid_dollars);
      const ask = dollarsToCents(m.yes_ask_dollars);
      const last = dollarsToCents(m.last_price_dollars);
      let midPrice;
      if (bid > 0 && ask > 0) midPrice = Math.round((bid + ask) / 2);
      else if (last > 0) midPrice = last;
      else if (ask > 0) midPrice = ask;
      else if (bid > 0) midPrice = bid;
      else midPrice = 50;

      return {
        ticker: m.ticker,
        eventTicker: m.event_ticker,
        seriesTicker: seriesTicker,
        title: m.title,
        subtitle: m.subtitle || "",
        category: cat,
        marketPrice: midPrice,
        yesBid: bid,
        yesAsk: ask,
        noBid: dollarsToCents(m.no_bid_dollars),
        noAsk: dollarsToCents(m.no_ask_dollars),
        lastPrice: last,
        volume: Math.round(dollarsToFloat(m.volume_fp)),
        volume24h: Math.round(dollarsToFloat(m.volume_24h_fp)),
        openInterest: Math.round(dollarsToFloat(m.open_interest_fp)),
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
      // If the last trade price differs significantly from the bid-ask mid, that's a signal
      if (fairValue === null && m.lastPrice > 0) {
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
      totalFetched: rawCount,
      totalWithPrice: withPriceCount,
      totalReturned: enriched.length,
      debug: { rawSample, filteredSample },
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
