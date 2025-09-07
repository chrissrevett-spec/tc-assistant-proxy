// /api/log.js
export const config = { runtime: "edge" };

function corsHeaders(origin) {
  const allow = origin && origin.includes("talkingcare.uk") ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-vercel-protection-bypass, Accept",
    "Access-Control-Max-Age": "86400",
  };
}

export default async function handler(req) {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST")    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders(origin) });

  // swallow the body; return 204
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
