// File: api/assistant.js

// --- Simple per-route CORS config ---
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function endPreflight(res) {
  res.statusCode = 204; // no body
  res.end();
}

export default async function handler(req, res) {
  const origin = pickOrigin(req);
  setCors(res, origin);

  // Preflight first
  if (req.method === "OPTIONS") {
    return endPreflight(res);
  }

  // (Optional) lightweight health check on GET
  if (req.method === "GET") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({ ok: true, route: "assistant", mode: "health" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    // Parse body safely whether a string or object
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { userMessage = "", threadId = null } = body;
    const streamParam = (req.query?.stream || "off").toString(); // "on"/"off"
    const isStream = streamParam !== "off";

    // ---- DEMO RESPONSE (replace with real OpenAI call when ready) ----
    // Non-stream = simple JSON
    if (!isStream) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(200).json({
        ok: true,
        text: userMessage ? `Hello! You said: ${userMessage}` : "Hello! How can I assist you today?",
        thread_id: threadId,
        citations: [],
        usage: null,
      });
    }

    // Streamed SSE response
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",

      // mirror CORS on streaming too
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
    });

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    };

    // start event
    send("start", { ok: true });

    // keep-alive (every 15s); harmless on Vercel
    const keepAlive = setInterval(() => {
      try { res.write(`: keep-alive ${Date.now()}\n\n`); } catch {}
    }, 15000);

    const text = userMessage || "Streaming hello from server ✅";
    for (const ch of text) {
      send("thread.message.delta", { delta: { content: [{ type: "output_text_delta", text: ch }] } });
      // small delay to simulate token streaming
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 25));
    }

    send("thread.message.completed", { content: [{ type: "text", text: { value: text, annotations: [] } }] });
    send("thread.run.completed", { usage: null });
    send("done", "[DONE]");

    clearInterval(keepAlive);
    res.end();
  } catch (err) {
    console.error("Assistant API Error:", err);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
