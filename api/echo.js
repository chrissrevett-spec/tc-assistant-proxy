// File: api/echo.js

const ORIGIN = "https://www.talkingcare.uk";

/** Set CORS headers on every response */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    setCors(res);
    return res.status(204).end();
  }

  // Only POST beyond this point
  if (req.method !== "POST") {
    setCors(res);
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    setCors(res);

    const mode = (req.query.mode || "json").toString();
    // Body may be empty in stream tests; make it optional
    let message = "";
    try { message = (req.body?.message ?? "").toString(); } catch {}

    if (mode === "stream") {
      // --- SSE STREAM ---
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        // Important: no Content-Length for SSE; do not gzip
      });

      // helper writers
      const send = (event, dataObj) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
      };

      // start event
      send("start", { ok: true });

      const words = (message?.trim()
        ? `Echoing: ${message}`
        : "Echo stream from server ✅").split(" ");

      for (const w of words) {
        send("response.output_text.delta", {
          delta: { type: "output_text_delta", text: w + " " },
        });
        // small delay to simulate typing
        // eslint-disable-next-line no-await-in-loop
        await new Promise(r => setTimeout(r, 180));
      }

      // light keep-alive (one ping, helps some proxies)
      res.write(`: ping\n\n`);

      send("done", "[DONE]");
      return res.end();
    }

    // --- JSON MODE ---
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      message: message || "Hello from echo (default)",
    });

  } catch (err) {
    // Ensure CORS on error too (avoids “looks like CORS” masking real error)
    setCors(res);
    console.error("Echo API Error:", err);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
