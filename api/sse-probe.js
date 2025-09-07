// api/sse-probe.js — simple SSE counter to test end-to-end streaming

module.exports = async function (req, res) {
  // CORS
  const ORIGIN = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vercel-protection-bypass");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");

  // SSE headers (no compression, no buffering)
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Content-Encoding": "identity",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders?.();

  // Keep-alive ping
  const keepAlive = setInterval(() => {
    try { res.write(": ping\n\n"); } catch {}
  }, 15000);

  let n = 0;
  const t = setInterval(() => {
    n += 1;
    try {
      res.write(`event: tick\ndata: ${JSON.stringify({ n, ts: Date.now() })}\n\n`);
      if (n >= 10) {
        res.write("data: [DONE]\n\n");
        clearInterval(t); clearInterval(keepAlive);
        res.end();
      }
    } catch {
      clearInterval(t); clearInterval(keepAlive);
      try { res.end(); } catch {}
    }
  }, 1000);
};
