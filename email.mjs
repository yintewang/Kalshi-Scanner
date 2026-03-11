// Netlify serverless function — sends email alerts via Resend API.
// The RESEND_API_KEY is stored as a Netlify environment variable.
//
// The client POSTs: { "to": "user@example.com", "subject": "...", "message": "..." }

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return jsonResponse(500, {
        error: "RESEND_API_KEY environment variable not set on the server.",
      });
    }

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

    const { subject, message } = body;

    if (!subject || !message) {
      return jsonResponse(400, { error: "Missing 'subject' or 'message'" });
    }

    // Send via Resend API
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Kalshi Edge Scanner <onboarding@resend.dev>",
        to: [alertEmail],
        subject: subject,
        html: formatEmailHtml(subject, message),
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

function formatEmailHtml(subject, message) {
  const lines = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").split("\n");
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
      <div style="background:linear-gradient(135deg,#0d0b14,#181228);border-radius:16px;padding:28px 24px;color:#f0eeff;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
          <div style="width:36px;height:36px;background:linear-gradient(135deg,#00e87a,#00b359);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;">⚡</div>
          <span style="font-size:18px;font-weight:700;">Kalshi <span style="color:#00e87a;">Edge</span></span>
        </div>
        <div style="font-size:14px;line-height:1.8;color:rgba(240,238,255,0.75);">
          ${lines.map(l => l.trim() ? "<p style='margin:0 0 8px 0;'>" + l + "</p>" : "<br>").join("")}
        </div>
        <div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.08);font-size:11px;color:rgba(240,238,255,0.3);">
          Sent by Kalshi Edge Scanner · For research and education only
        </div>
      </div>
    </div>`;
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
