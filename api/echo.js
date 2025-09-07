export const config = { runtime: "nodejs" };

const PROD_ORIGIN = "https://www.talkingcare.uk";
const EXTRA_ORIGIN = process.env.CORS_DEBUG_ORIGIN || "";
function corsOrigin(req) {
  const o = req.headers.get("origin");
  if (o === PROD_ORIGIN || (EXTRA_ORIGIN && o === EXTRA_ORIGIN)) return o;
  return PROD_ORIGIN;
}
function baseCorsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-vercel-protection-bypass, Accept",
    "Access-Control-Max-Age": "86400"
  };
}
function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export default async function handler(req) {
  const origin = corsOrigin(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseCorsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405, headers: baseCorsHeaders(origin) });
  }

  let body = {};
  try { body = await req.json(); } catch {}

  const mode = new URL(req.url).searchParams.get("mode");

  if (mode === "stream") {
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();

    // simple demo SSE
    (async () => {
      await w.write(encoder.encode(`event: start\ndata: {"ok":true}\n\n`));
      const text = (body && body.message) ? String(body.message) : "Hello";
      const chunks = [`{"message":"${text.slice(0, 10)}`, `${text.slice(10)}"}`];
      for (const c of chunks) {
        await w.write(encoder.encode(`event: thread.message.delta\ndata: {"delta":{"content":[{"type":"output_text_delta","text":"${c}"}]}}\n\n`));
      }
      await w.write(encoder.encode(`event: done\ndata: [DONE]\n\n`));
      await w.close();
    })();

    return new Response(readable, {
      status: 200,
      headers: {
        ...baseCorsHeaders(origin),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      }
    });
  }

  return json({ ok: true, echo: body || null }, { headers: baseCorsHeaders(origin) });
}
