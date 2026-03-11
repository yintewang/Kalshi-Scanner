// Netlify serverless function — sends email alerts via Resend API.
// RESEND_API_KEY and ALERT_EMAIL are Netlify environment variables.
//
// Accepts two formats:
//   Test:  { "subject": "...", "message": "..." }
//   Alert: { "subject": "...", "edges": [ { title, marketPrice, fairValue, edge, action, kelly, contracts, url, category } ] }

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    const apiKey = process.env.RESEND_API_KEY;
    const alertEmail = process.env.ALERT_EMAIL;
    if (!apiKey || !alertEmail) {
      return jsonResponse(500, {
        error: "Missing RESEND_API_KEY or ALERT_EMAIL environment variable.",
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "Invalid JSON body" });
    }

    const { subject } = body;
    if (!subject) {
      return jsonResponse(400, { error: "Missing 'subject'" });
    }

    // Build HTML — either from structured edges or a plain message
    let html;
    if (body.edges && body.edges.length) {
      html = buildEdgeEmail(body.edges);
    } else if (body.message) {
      html = buildSimpleEmail(body.message);
    } else {
      return jsonResponse(400, { error: "Missing 'edges' or 'message'" });
    }

    // Send via Resend
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Kalshi Edge Scanner <onboarding@resend.dev>",
        to: [alertEmail],
        subject,
        html,
      }),
    });

    const data = await resendRes.json();

    if (!resendRes.ok) {
      return jsonResponse(resendRes.status, {
        error: "Resend error: " + (data.message || JSON.stringify(data)),
      });
    }

    return jsonResponse(200, { success: true, id: data.id });
  } catch (err) {
    return jsonResponse(502, { error: "Email proxy error: " + err.message });
  }
};

// ── Rich edge alert email ──
function buildEdgeEmail(edges) {
  const catEmoji = { economics: "📊", politics: "🏛️", crypto: "₿" };

  const edgeCards = edges.map((e) => `
    <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:18px 20px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
        <span style="font-size:13px;">${catEmoji[e.category] || "📈"}</span>
        <span style="font-size:11px;font-weight:600;color:rgba(240,238,255,0.5);text-transform:uppercase;letter-spacing:0.5px;">${e.category || "Market"}</span>
      </div>
      <div style="font-size:16px;font-weight:700;color:#f0eeff;margin-bottom:10px;">${esc(e.title)}</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
        <tr>
          <td style="padding:5px 0;font-size:12px;color:rgba(240,238,255,0.5);">Market Price</td>
          <td style="padding:5px 0;font-size:14px;font-weight:600;color:#818cf8;text-align:right;">${e.marketPrice}¢</td>
        </tr>
        <tr>
          <td style="padding:5px 0;font-size:12px;color:rgba(240,238,255,0.5);">Fair Value</td>
          <td style="padding:5px 0;font-size:14px;font-weight:600;color:#00e87a;text-align:right;">${e.fairValue}¢</td>
        </tr>
        <tr>
          <td style="padding:5px 0;font-size:12px;color:rgba(240,238,255,0.5);">Edge</td>
          <td style="padding:5px 0;font-size:14px;font-weight:700;color:#00e87a;text-align:right;">+${e.edge}%</td>
        </tr>
      </table>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
        <span style="display:inline-block;padding:4px 12px;border-radius:50px;font-size:12px;font-weight:700;background:rgba(0,232,122,0.12);color:#00e87a;border:1px solid rgba(0,232,122,0.25);">${esc(e.action)}</span>
        <span style="display:inline-block;padding:4px 12px;border-radius:50px;font-size:12px;font-weight:600;background:rgba(255,255,255,0.06);color:rgba(240,238,255,0.6);border:1px solid rgba(255,255,255,0.08);">Kelly ${esc(e.kelly)} · ${e.contracts} contracts</span>
      </div>
      <a href="${esc(e.url)}" style="display:inline-block;padding:6px 16px;border-radius:8px;background:rgba(99,102,241,0.15);color:#818cf8;font-size:12px;font-weight:600;text-decoration:none;border:1px solid rgba(99,102,241,0.25);">View on Kalshi ↗</a>
    </div>
  `).join("");

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
      <div style="background:linear-gradient(135deg,#0d0b14,#181228);border-radius:16px;padding:28px 24px;color:#f0eeff;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <div style="width:36px;height:36px;background:linear-gradient(135deg,#00e87a,#00b359);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;">⚡</div>
          <span style="font-size:18px;font-weight:700;">Kalshi <span style="color:#00e87a;">Edge</span></span>
        </div>
        <p style="font-size:13px;color:rgba(240,238,255,0.4);margin:0 0 20px 0;">${edges.length} new edge${edges.length > 1 ? "s" : ""} found by your scanner</p>
        ${edgeCards}
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:rgba(240,238,255,0.25);">
          Kalshi Edge Scanner · For research and education only · Not financial advice
        </div>
      </div>
    </div>`;
}

// ── Simple text email (for test) ──
function buildSimpleEmail(message) {
  const lines = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").split("\n");
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
      <div style="background:linear-gradient(135deg,#0d0b14,#181228);border-radius:16px;padding:28px 24px;color:#f0eeff;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
          <div style="width:36px;height:36px;background:linear-gradient(135deg,#00e87a,#00b359);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;">⚡</div>
          <span style="font-size:18px;font-weight:700;">Kalshi <span style="color:#00e87a;">Edge</span></span>
        </div>
        <div style="font-size:14px;line-height:1.8;color:rgba(240,238,255,0.75);">
          ${lines.map((l) => l.trim() ? "<p style='margin:0 0 8px 0;'>" + l + "</p>" : "<br>").join("")}
        </div>
        <div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:rgba(240,238,255,0.25);">
          Kalshi Edge Scanner · For research and education only · Not financial advice
        </div>
      </div>
    </div>`;
}

function esc(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
