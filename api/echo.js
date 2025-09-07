// File: api/echo.js

export default async function handler(req, res) {
  // Allow only POST requests
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const { message } = req.body || {};
    const mode = req.query.mode || "json";

    if (!message) {
      return res.status(400).json({ ok: false, error: "Missing message in request body" });
    }

    // --- STREAMING MODE ---
    if (mode === "stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "https://www.talkingcare.uk",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });

      // Initial start event
      res.write(`event: start\n`);
      res.write(`data: ${JSON.stringify({ ok: true })}\n\n`);

      // Stream message word by word
      const words = `Echo stream from server ✅`.split(" ");
      for (const word of words) {
        res.write(`event: response.output_text.delta\n`);
        res.write(`data: ${JSON.stringify({ delta: { type: "output_text_delta", text: word + " " } })}\n\n`);
        await new Promise(r => setTimeout(r, 200));
      }

      // Final event
      res.write(`event: done\n`);
      res.write(`data: [DONE]\n\n`);

      return res.end();
    }

    // --- JSON MODE (default) ---
    res.setHeader("Access-Control-Allow-Origin", "https://www.talkingcare.uk");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json");

    return res.status(200).json({
      ok: true,
      message,
    });

  } catch (err) {
    console.error("Echo API Error:", err);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
