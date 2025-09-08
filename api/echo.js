// File: api/echo.js

// --- Minimal CORS config (project-level) ---
const ALLOWED_ORIGINS = new Set([
  "https://www.talkingcare.uk",
  // add preview/staging origins if you use them:
  // "https://tc-assistant-proxy.vercel.app",
  // /\.vercel\.app$/.test(origin)  -> handled by reflect mode below if you prefer
]);

// If you want to allow only your prod origin, leave REFLECT_ORIGIN = false.
// If you also want to allow any Vercel preview of *this* function, set true
// and ensure you understand the risk (it reflects any Origin header).
const REFLECT_ORIGIN = false;

function pickOrigin(req) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  return REFLECT_ORIGIN ? origin : "https://www.talkingcare.uk";
}

function setCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  // Preflight caching (1 day)
  res.setHeader("Access-Control-Max-Age", "86400");
}

function endPreflight(res) {
  // No body for preflight
  res.statusCode = 204;
  res.end();
}

export default async function handler(req, res) {
  const origin = pickOrigin(req);
  setCors(res, origin);

  // --- Handle preflight early ---
  if (req.method === "OPTIONS") {
    return endPreflight(res);
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

  try {
    // Parse JSON body (Next/Vercel Node functions parse automatically in some setups,
    // but we guard for raw-JSON just in case)
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { message = "" } = body;
    const mode = (req.query?.mode || "json").toString();

    if (!message && mode !== "stream") {
      res.status(400).json({ ok: false, error: "Missing 'message' in request body" });
      return;
    }

    if (mode === "stream") {
      // --- SSE STREAMING RESPONSE ---

      // SSE / proxy friendliness: disable buffering/compression where possible
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        // Some proxies (NGINX) respect this hint; Vercel ignores but harmless:
        "X-Accel-Buffering": "no",
        // CORS (mirrored for safety on streamed path too)
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
      });

      // In case the runtime supports it, push headers immediately
      if (typeof res.flushHeaders === "function") {
        try { res.flushHeaders(); } catch {}
      }

      // Helper to write an SSE event (event name + JSON data payload)
      const send = (event, data) => {
        res.write(`event: ${event}\n`);
        // Ensure each "data:" line is < 64KB (keep it tiny anyway)
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // Initial ping to open the stream
      send("start", { ok: true });

      // Keep-alive pings so proxies don’t cut the stream (every 15s)
      const keepAlive = setInterval(() => {
        // Comment lines are valid SSE and ignored by clients, but keep the TCP stream alive
        try { res.write(`: keep-alive ${Date.now()}\n\n`); } catch {}
      }, 15000);

      // Build the content to stream; fall back to a default sentence if message empty
      const textToStream = message
        ? `Echo stream: ${message}`
        : "Echo stream from server ✅";

      const chunks = textToStream.split(" ");

      // Send small deltas like the Assistants API style you’re emulating
      for (const word of chunks) {
        send("response.output_text.delta", { delta: { type: "output_text_delta", text: word + " " } });
        // Small delay to simulate token-by-token/word streaming
        // Tweak this (e.g., 40–80ms) if you want faster typing
        await new Promise(r => setTimeout(r, 120));
      }

      // Signal completion
      send("done", "[DONE]");

      clearInterval(keepAlive);
      res.end();
      return;
    }

    // --- JSON MODE (non-streaming echo) ---
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json({ ok: true, message });

  } catch (err) {
    console.error("Echo API Error:", err);
    // Never leak internals in production
    res
      .status(500)
      .setHeader("Content-Type", "application/json; charset=utf-8")
      .json({ ok: false, error: "Internal Server Error" });
  }
}
