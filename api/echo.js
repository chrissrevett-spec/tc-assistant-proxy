export const config = { runtime: "nodejs" };

const ORIGIN = process.env.ALLOW_ORIGIN || "https://www.talkingcare.uk";
const METHODS = "POST, OPTIONS";
const HEADERS = "Content-Type, Accept";
const MAX_AGE = "86400";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", METHODS);
  res.setHeader("Access-Control-Allow-Headers", HEADERS);
  res.setHeader("Access-Control-Max-Age", MAX_AGE);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  }

  const mode = (req.query?.mode || "json").toString();
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const message = body.message || "hello";

  if (mode === "stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Allow-Methods": METHODS,
      "Access-Control-Allow-Headers": HEADERS,
    });
    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    };
    send("start", { ok:true });

    const parts = (`Echo stream: ${message} ✅`).split(" ");
    for (const p of parts) {
      send("response.output_text.delta", { delta: { type:"output_text_delta", text: p + " " }});
      // tiny delay
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 80));
    }

    send("done", "[DONE]");
    res.end();
    return;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).json({ ok:true, message });
}
