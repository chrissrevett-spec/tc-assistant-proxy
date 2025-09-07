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

  // Fire-and-forget logging (keep simple)
  try { await req.json(); } catch {}

  return json({ ok: true }, { headers: baseCorsHeaders(origin) });
}
