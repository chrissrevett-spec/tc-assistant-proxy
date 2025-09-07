// /api/echo.js
// Pure SSE test endpoint: proves streaming works end-to-end.
// Usage:
//   GET /api/echo?mode=tick          -> 10 ticks then [DONE]
//   POST /api/echo?mode=echo         -> streams back what you POSTed

const ALLOW_ORIGIN = "https://www.talkingcare.uk";

function setSSEHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Connection", "keep-alive");
}

function setCORSHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body) {
      // Vercel may have parsed it for us already
      resolve(typeof req.body === "string" ? req.body : JSON.stringify(req.body));
      return;
    }
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data || ""));
  });
}

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const mode = (url.searchParams.get("mode") || "").toLowerCase();

  // Preflight
  if (req.method === "OPTIONS") {
    setCORSHeaders(res);
    res.status(204).end();
    return;
  }

  // Streaming test: GET /api/echo?mode=tick
  if (req.method === "GET" && mode === "tick") {
    setSSEHeaders(res);
    // send 10 ticks then [DONE]
    let n = 0;
    const iv = setInterval(() => {
      n += 1;
      res.write(`event: tick\n`);
      res.write(`data: ${JSON.stringify({ n, ts: Date.now() })}\n\n`);
      if (n >= 10) {
        clearInterval(iv);
        res.write(`data: [DONE]\n\n`);
        res.end();
      }
    }, 1000);
    req.on("close", () => clearInterval(iv));
    return;
  }

  // Streaming test: POST /api/echo?mode=echo   (streams your text back)
  if (req.method === "POST" && mode === "echo") {
    setSSEHeaders(res);
    const raw = await readBody(req);
    res.write(`event: start\n`);
    res.write(`data: ${JSON.stringify({ ok: true })}\n\n`);

    // stream the raw body back a few chars at a time
    const text = raw || "(empty)";
    let i = 0;
    const chunk = () => {
      if (i >= text.length) {
        res.write(`event: done\n`);
        res.write(`data: [DONE]\n\n`);
        return res.end();
      }
      const piece = text.slice(i, i + 12);
      i += 12;
      res.write(`event: thread.message.delta\n`);
      res.write(`data: ${JSON.stringify({ delta: { content: [{ type: "output_text_delta", text: piece }] } })}\n\n`);
      setTimeout(chunk, 80);
    };
    chunk();
    return;
  }

  // Fallback
  setCORSHeaders(res);
  res.status(400).json({ ok: false, message: "Use GET ?mode=tick or POST ?mode=echo" });
}
