const { corsHeaders, noContent, send } = require("./_cors");

function sseHead(res) {
  const headers = corsHeaders({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
  });
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.statusCode = 200;
  res.flushHeaders?.();
}
function sse(res, evt, data) {
  res.write(`event: ${evt}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") return noContent(res);

  if (req.method !== "POST") return send(res, 405, "Method Not Allowed");

  const url  = new URL(req.url, `http://${req.headers.host}`);
  const mode = url.searchParams.get("mode") || "sse";

  const body = await readBody(req).catch(() => ({}));
  const msg  = body && body.message ? String(body.message) : "Hello";

  if (mode === "echo") {
    // Non-stream JSON test
    return send(res, 200, { ok: true, echo: msg });
  }

  // SSE test
  sseHead(res);
  sse(res, "start", { ok: true });
  for (const chunk of JSON.stringify({ message: msg }).match(/.{1,12}/g) || []) {
    sse(res, "thread.message.delta", { delta: { content: [{ type: "output_text_delta", text: chunk }] } });
    await new Promise(r => setTimeout(r, 120));
  }
  sse(res, "done", "[DONE]");
  res.end();
};
