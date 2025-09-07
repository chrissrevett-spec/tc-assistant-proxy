export const config = { runtime: "nodejs22.x" };
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, x-vercel-protection-bypass",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    ...extra
  };
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return OPTIONS();
  // Fire-and-forget logger (no storage, just a health check)
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() }
  });
}
