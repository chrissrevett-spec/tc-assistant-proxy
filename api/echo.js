// File: api/echo.js

const ALLOWED_ORIGINS = new Set([
  "https://www.talkingcare.uk",
]);

function pickOrigin(req) {
  const origin = req.headers?.origin || "";
  return ALLOWED_ORIGINS.has(origin) ? origin : "https://www.talkingcare.uk";
}

function setCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function endPreflight(res) {
  res.statusCode = 204;
  res.end();
}

export default async function handler(req, res) {
  const origin = pickOrigin(req);
  setCors(res, origin);

  if (req.method === "OPTIONS") {
    return endPreflight(res);
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { message } = body || {};
    const mode = (req.query?.mode || "json").toString();

    if (mode === "stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
      });

      const send = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      send("start", { ok: true });

      const text = message ? `Echo stream: ${message}` : "Echo stream from server ✅";
      const parts = text.split(" ");
      for (const p of parts) {
        send("response.output_text.delta", { delta: { type: "output_text_delta", text: p + " " } });
        // eslint-disable-next-line no-await-in-loop
        await new Promise(r => setTimeout(r, 120));
      }

      send("done", "[DONE]");
      return res.end();
    }

    if (!message) {
      return res.status(400).json({ ok: false, error: "Missing 'message' in request body" });
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({ ok: true, message });
  } catch (err) {
    console.error("Echo API Error:", err);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
